import 'dotenv/config';
import express from 'express';
import { loadConfig } from '../src/config.js';
import { initDb } from '../src/db/index.js';
import { mallRouter } from '../src/routes/mall.js';
import { createWebSessionToken } from '../src/services/webSession.js';

const CONCURRENCY = Number(process.env.BOB_RP_TEST_USERS || 200);
const TOTAL_COUNT = Number(process.env.BOB_RP_TEST_COUNT || 200);
const PREFIX = `TEST_RP_HTTP_${Date.now()}`;

function assertSafeTarget(cfg) {
  if (process.env.BOB_INTERNAL_TEST_DB !== '1') throw new Error('拒绝执行：请先设置 BOB_INTERNAL_TEST_DB=1。');
  const host = String(cfg?.db?.host || '').toLowerCase();
  const dbName = String(cfg?.db?.database || '').toLowerCase();
  if (!/(127\.0\.0\.1|localhost)/.test(host) && process.env.BOB_ALLOW_REMOTE_TEST_DB !== '1') {
    throw new Error(`拒绝执行：HTTP 并发测试默认只允许本机测试库，当前 host=${cfg?.db?.host || '-'}`);
  }
  if (!/(test|dev|local|sandbox)/.test(dbName)) throw new Error(`拒绝执行：当前数据库 ${cfg?.db?.database || '-'} 不是测试库。`);
  const confirmDb = String(process.env.BOB_RP_TEST_DATABASE_CONFIRM || '').trim().toLowerCase();
  if (confirmDb !== dbName) throw new Error(`拒绝执行：请设置 BOB_RP_TEST_DATABASE_CONFIRM=${dbName}。`);
  const target = `${cfg?.db?.host || ''}:${cfg?.db?.port || ''}/${cfg?.db?.database || ''}`.toLowerCase();
  const confirmTarget = String(process.env.BOB_RP_TEST_TARGET_CONFIRM || '').trim().toLowerCase();
  if (confirmTarget !== target) throw new Error(`拒绝执行：请设置 BOB_RP_TEST_TARGET_CONFIRM=${target}。`);
  if (CONCURRENCY < 200) throw new Error('并发用户数不能低于 200。');
}

async function createFixture(db) {
  return await db.transaction(async (tx) => {
    const previousNotify = await tx.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', ['notify_settings']);
    await tx.exec(
      `INSERT INTO system_settings(key, value, updated_at)
       VALUES('notify_settings', ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = unixepoch()`,
      [JSON.stringify({ enabled: false, templates: {} })],
    );
    const activity = await tx.run(
      `INSERT INTO red_packet_activity(total_amount, total_count, countdown_seconds, duration_minutes, start_at, end_at, status, sponsor, created_at)
       VALUES(?, ?, 0, 10, unixepoch() - 10, unixepoch() + 600, 'active', ?, unixepoch())`,
      [TOTAL_COUNT, TOTAL_COUNT, `${PREFIX}_SPONSOR`],
    );
    const activityId = Number(activity.lastID);
    const users = [];
    for (let i = 1; i <= TOTAL_COUNT; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tx.run('INSERT INTO red_packet_items(activity_id, amount) VALUES(?, 1)', [activityId]);
    }
    for (let i = 1; i <= CONCURRENCY; i += 1) {
      const userid = `${PREFIX}_${String(i).padStart(4, '0')}`;
      const name = `红包 HTTP 测试${i}`;
      users.push({ userid, name });
      // eslint-disable-next-line no-await-in-loop
      await tx.run('INSERT INTO users(userid, name, is_admin) VALUES(?, ?, 0) ON CONFLICT(userid) DO UPDATE SET name = EXCLUDED.name', [userid, name]);
      // eslint-disable-next-line no-await-in-loop
      await tx.run('INSERT INTO accounts(userid, balance) VALUES(?, 0) ON CONFLICT(userid) DO UPDATE SET balance = 0, updated_at = unixepoch()', [userid]);
    }
    return { activityId, users, previousNotifyValue: previousNotify?.value ?? null, previousNotifyExisted: Boolean(previousNotify) };
  });
}

function makeCookie(cfg, user) {
  const secret = `${cfg?.webSessionSecret || ''}:${cfg?.sessionSalt || ''}`;
  const token = createWebSessionToken(secret, { userid: user.userid, name: user.name }, 3600);
  return `bob_web_session=${token}`;
}

function createTestServer(db, cfg) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.locals.db = db;
  app.locals.cfg = cfg;
  app.use('/mall', mallRouter());
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ app, server, port: server.address().port }));
  });
}

async function claimHttp(baseUrl, cfg, user) {
  try {
    const res = await fetch(`${baseUrl}/mall/red-packet/claim?await_notify=0`, {
      method: 'POST',
      headers: { cookie: makeCookie(cfg, user), 'content-type': 'application/json' },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) return { ok: false, userid: user.userid, status: res.status, error: data?.error || `HTTP ${res.status}` };
    return { ok: true, userid: user.userid, amount: data.amount, balance: data.balance, activity_id: data.activity_id };
  } catch (err) {
    return { ok: false, userid: user.userid, error: String(err?.message || err) };
  }
}

async function inspectResult(db, activityId, userids) {
  const claimed = await db.get('SELECT COUNT(1) AS c, COALESCE(SUM(amount), 0) AS amount FROM red_packet_items WHERE activity_id = ? AND claimed_by IS NOT NULL', [activityId]);
  const duplicatedUsers = await db.all(
    `SELECT claimed_by, COUNT(1) AS c FROM red_packet_items WHERE activity_id = ? AND claimed_by IS NOT NULL GROUP BY claimed_by HAVING COUNT(1) > 1`,
    [activityId],
  );
  const refPrefix = `RED_PACKET_${activityId}_`;
  const duplicatedLedger = await db.all(
    `SELECT ref_id, COUNT(1) AS c FROM ledger WHERE LEFT(ref_id, LENGTH(?)) = ? GROUP BY ref_id HAVING COUNT(1) > 1`,
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

async function cleanup(db, activityId, users, previousNotify) {
  const userids = users.map((u) => u.userid);
  const refPrefix = `RED_PACKET_${activityId}_`;
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM ledger WHERE LEFT(ref_id, LENGTH(?)) = ?', [refPrefix, refPrefix]);
    await tx.run('DELETE FROM red_packet_activity WHERE id = ?', [activityId]);
    await tx.run('DELETE FROM users WHERE userid = ANY(?)', [userids]);
    if (previousNotify?.existed) {
      await tx.exec(
        `INSERT INTO system_settings(key, value, updated_at)
         VALUES('notify_settings', ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = unixepoch()`,
        [previousNotify.value],
      );
    } else {
      await tx.run('DELETE FROM system_settings WHERE key = ?', ['notify_settings']);
    }
  });
}

const cfg = loadConfig();
assertSafeTarget(cfg);
cfg.webSessionSecret = 'internal_http_red_packet_test_secret';
cfg.dingtalk = { ...(cfg.dingtalk || {}), appKey: '', appSecret: '', robotNotifyEnabled: false };
const db = await initDb(cfg);
let fixture = null;
let server = null;
try {
  fixture = await createFixture(db);
  const started = await createTestServer(db, cfg);
  server = started.server;
  const baseUrl = `http://127.0.0.1:${started.port}`;
  const settled = await Promise.allSettled(fixture.users.map((user) => claimHttp(baseUrl, cfg, user)));
  const results = settled.map((item) => item.status === 'fulfilled' ? item.value : { ok: false, error: String(item.reason?.message || item.reason) });
  const success = results.filter((row) => row.ok);
  const failed = results.filter((row) => !row.ok);
  const inspect = await inspectResult(db, fixture.activityId, fixture.users.map((u) => u.userid));
  const pass =
    success.length === Math.min(CONCURRENCY, TOTAL_COUNT) &&
    failed.length === 0 &&
    inspect.claimed_count === success.length &&
    inspect.claimed_amount === inspect.account_balance_sum &&
    inspect.duplicated_users.length === 0 &&
    inspect.duplicated_ledger_refs.length === 0;
  console.log(JSON.stringify({
    ok: pass,
    safe: {
      sends_dingtalk_message: false,
      notify_settings_disabled: true,
      route_under_test: '/mall/red-packet/claim',
      writes_test_rows: true,
      cleanup: 'finally_exact_ids_and_settings_restore',
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
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fixture?.activityId) {
    await cleanup(db, fixture.activityId, fixture.users, {
      existed: fixture.previousNotifyExisted,
      value: fixture.previousNotifyValue,
    });
  }
  await db.close();
}
