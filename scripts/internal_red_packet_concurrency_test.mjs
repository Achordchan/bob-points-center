import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { initDb } from '../src/db/index.js';
import { claimActiveRedPacket } from '../src/services/redPacketService.js';

const CONCURRENCY = Number(process.env.BOB_RP_TEST_USERS || 200);
const TOTAL_COUNT = Number(process.env.BOB_RP_TEST_COUNT || 200);
const PREFIX = `TEST_RP_${Date.now()}`;

function assertSafeTarget(cfg) {
  if (process.env.BOB_INTERNAL_TEST_DB !== '1') {
    throw new Error('拒绝执行：请先设置 BOB_INTERNAL_TEST_DB=1，确认这是内部并发测试。');
  }
  const host = String(cfg?.db?.host || '').toLowerCase();
  if (!/(127\.0\.0\.1|localhost)/.test(host) && process.env.BOB_ALLOW_REMOTE_TEST_DB !== '1') {
    throw new Error(`拒绝执行：并发测试默认只允许本机测试库，当前 host=${cfg?.db?.host || '-'}`);
  }
  const dbName = String(cfg?.db?.database || '').toLowerCase();
  if (!/(test|dev|local|sandbox)/.test(dbName)) {
    throw new Error(`拒绝执行：当前数据库 ${cfg?.db?.database || '-'} 不是测试库。请使用 test/dev/local/sandbox 数据库执行。`);
  }
  const confirmDb = String(process.env.BOB_RP_TEST_DATABASE_CONFIRM || '').trim().toLowerCase();
  if (confirmDb !== dbName) {
    throw new Error(`拒绝执行：请设置 BOB_RP_TEST_DATABASE_CONFIRM=${dbName}，二次确认写入目标数据库。`);
  }
  const target = `${cfg?.db?.host || ''}:${cfg?.db?.port || ''}/${cfg?.db?.database || ''}`.toLowerCase();
  const confirmTarget = String(process.env.BOB_RP_TEST_TARGET_CONFIRM || '').trim().toLowerCase();
  if (confirmTarget !== target) {
    throw new Error(`拒绝执行：请设置 BOB_RP_TEST_TARGET_CONFIRM=${target}，二次确认测试库地址。`);
  }
  if (CONCURRENCY < 200) throw new Error('并发用户数不能低于 200。');
}

async function createFixture(db) {
  return await db.transaction(async (tx) => {
    const activity = await tx.run(
      `INSERT INTO red_packet_activity(total_amount, total_count, countdown_seconds, duration_minutes, start_at, end_at, status, sponsor, created_at)
       VALUES(?, ?, 0, 10, unixepoch() - 10, unixepoch() + 600, 'active', ?, unixepoch())`,
      [TOTAL_COUNT, TOTAL_COUNT, `${PREFIX}_SPONSOR`],
    );
    const activityId = Number(activity.lastID);
    const userids = [];
    for (let i = 1; i <= TOTAL_COUNT; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tx.run('INSERT INTO red_packet_items(activity_id, amount) VALUES(?, 1)', [activityId]);
    }
    for (let i = 1; i <= CONCURRENCY; i += 1) {
      const userid = `${PREFIX}_${String(i).padStart(4, '0')}`;
      userids.push(userid);
      // eslint-disable-next-line no-await-in-loop
      await tx.run('INSERT INTO users(userid, name, is_admin) VALUES(?, ?, 0) ON CONFLICT(userid) DO UPDATE SET name = EXCLUDED.name', [userid, `红包并发测试${i}`]);
      // eslint-disable-next-line no-await-in-loop
      await tx.run('INSERT INTO accounts(userid, balance) VALUES(?, 0) ON CONFLICT(userid) DO UPDATE SET balance = 0, updated_at = unixepoch()', [userid]);
    }
    return { activityId, userids };
  });
}

async function claimOnce(db, userid) {
  try {
    const result = await claimActiveRedPacket(db, {
      userid,
      name: userid,
      ledgerReason: '红包并发测试',
      refPrefix: 'RED_PACKET_TEST',
    });
    return { ok: true, userid, item_id: result.item_id, amount: result.amount, balance: result.balance, activity_id: result.activity_id };
  } catch (err) {
    const pgCode = String(err?.code || '');
    const msg = pgCode === '23505' ? 'already_claimed' : String(err?.message || err);
    return { ok: false, userid, error: msg };
  }
}

async function inspectResult(db, activityId, userids) {
  const claimed = await db.get('SELECT COUNT(1) AS c, COALESCE(SUM(amount), 0) AS amount FROM red_packet_items WHERE activity_id = ? AND claimed_by IS NOT NULL', [activityId]);
  const duplicatedUsers = await db.all(
    `SELECT claimed_by, COUNT(1) AS c FROM red_packet_items WHERE activity_id = ? AND claimed_by IS NOT NULL GROUP BY claimed_by HAVING COUNT(1) > 1`,
    [activityId],
  );
  const refPrefix = `RED_PACKET_TEST_${activityId}_`;
  const duplicatedLedger = await db.all(
    `SELECT ref_id, COUNT(1) AS c
       FROM ledger
      WHERE LEFT(ref_id, LENGTH(?)) = ?
      GROUP BY ref_id
     HAVING COUNT(1) > 1`,
    [refPrefix, refPrefix],
  );
  const accountSum = await db.get('SELECT COALESCE(SUM(balance), 0) AS balance FROM accounts WHERE userid = ANY(?)', [userids]);
  return {
    claimed_count: Number(claimed?.c || 0),
    claimed_amount: Number(claimed?.amount || 0),
    account_balance_sum: Number(accountSum?.balance || 0),
    duplicated_users: duplicatedUsers,
    duplicated_ledger_refs: duplicatedLedger,
  };
}

async function cleanup(db, activityId, userids) {
  const refPrefix = `RED_PACKET_TEST_${activityId}_`;
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM ledger WHERE LEFT(ref_id, LENGTH(?)) = ?', [refPrefix, refPrefix]);
    await tx.run('DELETE FROM red_packet_activity WHERE id = ?', [activityId]);
    await tx.run('DELETE FROM users WHERE userid = ANY(?)', [userids]);
  });
}

const cfg = loadConfig();
assertSafeTarget(cfg);
const db = await initDb(cfg);
let fixture = null;
try {
  fixture = await createFixture(db);
  const settled = await Promise.allSettled(fixture.userids.map((userid) => claimOnce(db, userid)));
  const results = settled.map((item) => item.status === 'fulfilled' ? item.value : { ok: false, error: String(item.reason?.message || item.reason) });
  const success = results.filter((row) => row.ok);
  const failed = results.filter((row) => !row.ok);
  const inspect = await inspectResult(db, fixture.activityId, fixture.userids);
  const pass =
    success.length === Math.min(CONCURRENCY, TOTAL_COUNT) &&
    inspect.claimed_count === success.length &&
    inspect.claimed_amount === inspect.account_balance_sum &&
    inspect.duplicated_users.length === 0 &&
    inspect.duplicated_ledger_refs.length === 0;

  console.log(JSON.stringify({
    ok: pass,
    safe: {
      sends_dingtalk_message: false,
      route_shared_service_called: true,
      writes_test_rows: true,
      cleanup: 'finally_exact_ids',
    },
    prefix: PREFIX,
    activity_id: fixture.activityId,
    concurrency: CONCURRENCY,
    total_count: TOTAL_COUNT,
    success_count: success.length,
    failed_count: failed.length,
    failed_summary: failed.reduce((acc, row) => { acc[row.error] = (acc[row.error] || 0) + 1; return acc; }, {}),
    inspect,
  }, null, 2));
  if (!pass) process.exitCode = 1;
} finally {
  if (fixture?.activityId) await cleanup(db, fixture.activityId, fixture.userids);
  await db.close();
}
