// 年会模块本地集成测试：连接本机开发库，覆盖 DDL、抽签、预留名额、奖池预算、并发幂等发币。
// 仅允许本地开发数据库：需设置 BOB_INTERNAL_TEST_DB=1 与 BOB_GALA_TEST_DATABASE_CONFIRM=<库名>，
// 且数据库必须带 bob.environment=development GUC 标记。跑完自动清理测试数据。
import 'dotenv/config';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { initDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createSessionToken } from '../src/services/adminSession.js';
import { adminSessionSigningSecret } from '../src/utils/sessionCrypto.js';
import {
  addGalaParticipants,
  createGalaEvent,
  createGalaPool,
  createGalaReservedSlot,
  drawGalaRound,
  getGalaEventDetail,
  grantGalaRound,
  listGalaRounds,
  updateGalaEvent,
} from '../src/services/galaService.js';

const PREFIX = `TEST_GALA_${Date.now()}`;
const USERS = 30;
const uid = (i) => `${PREFIX}_${String(i).padStart(3, '0')}`;

function assertSafeTarget(cfg) {
  if (process.env.BOB_INTERNAL_TEST_DB !== '1') {
    throw new Error('拒绝执行：请先设置 BOB_INTERNAL_TEST_DB=1，确认这是内部集成测试。');
  }
  const host = String(cfg?.db?.host || '').toLowerCase();
  if (!/(127\.0\.0\.1|localhost)/.test(host)) {
    throw new Error(`拒绝执行：集成测试只允许本机测试库，当前 host=${cfg?.db?.host || '-'}`);
  }
  const dbName = String(cfg?.db?.database || '').toLowerCase();
  if (process.env.BOB_GALA_TEST_DATABASE_CONFIRM !== dbName) {
    throw new Error(`拒绝执行：请设置 BOB_GALA_TEST_DATABASE_CONFIRM=${dbName}，二次确认写入目标数据库。`);
  }
}

async function cleanup(db) {
  await db.run('DELETE FROM gala_events WHERE title LIKE ?', [`${PREFIX}%`]);
  await db.run('DELETE FROM admin_user_roles WHERE userid LIKE ?', [`${PREFIX}_%`]);
  await db.run('DELETE FROM ledger WHERE userid LIKE ?', [`${PREFIX}_%`]);
  await db.run('DELETE FROM audit_logs WHERE actor_id LIKE ?', [`${PREFIX}_%`]).catch(() => null);
  await db.run('DELETE FROM accounts WHERE userid LIKE ?', [`${PREFIX}_%`]);
  await db.run('DELETE FROM users WHERE userid LIKE ?', [`${PREFIX}_%`]);
}

async function balanceOf(db, userid) {
  const row = await db.get('SELECT balance FROM accounts WHERE userid = ?', [userid]);
  return Number(row?.balance || 0);
}

async function main() {
  const cfg = loadConfig();
  assertSafeTarget(cfg);
  const db = await initDb();
  try {
    const env = await db.get("SELECT current_setting('bob.environment', true) AS env");
    assert.equal(String(env?.env || '').toLowerCase(), 'development', '目标库缺少 bob.environment=development 标记');
    await initDb(); // DDL 幂等重跑
    console.log('✓ DDL 幂等');

    for (let i = 1; i <= USERS + 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await db.run('INSERT INTO users(userid, name) VALUES(?, ?)', [uid(i), `年会测试${i}`]);
      // eslint-disable-next-line no-await-in-loop
      await db.run('INSERT INTO accounts(userid, balance) VALUES(?, 0)', [uid(i)]);
    }
    const kid = uid(USERS + 1); // 预留名额对象，不在员工名单里

    const event = await createGalaEvent(db, { title: `${PREFIX} 年会`, totalBudget: 1000 });
    const pool = await createGalaPool(db, { eventId: event.id, name: '老板奖池', budget: 600 });
    await assert.rejects(
      createGalaPool(db, { eventId: event.id, name: '超预算', budget: 500 }),
      (e) => e.code === 'pools_exceed_total_budget',
    );
    const reservedPool = await createGalaPool(db, { eventId: event.id, name: '预留', budget: 300, reserved: true });
    console.log('✓ 奖池总预算校验，预留奖池不计入总预算');

    const add = await addGalaParticipants(db, {
      eventId: event.id,
      userids: [...Array.from({ length: USERS }, (_, i) => uid(i + 1)), 'NOT_EXIST_USER'],
    });
    assert.equal(add.added, USERS);
    assert.deepEqual(add.missing, ['NOT_EXIST_USER']);
    // 把孩子也误加进名单：预留对象不应进入正常抽签池
    await addGalaParticipants(db, { eventId: event.id, userids: [kid] });

    await createGalaReservedSlot(db, {
      eventId: event.id, segment: 'lottery', roundNo: 2, userid: kid, poolId: reservedPool.id, amount: 88, note: 'test',
    });
    await assert.rejects(
      createGalaReservedSlot(db, { eventId: event.id, segment: 'lottery', roundNo: 2, userid: uid(1) }),
      (e) => e.code === 'slot_already_exists',
    );

    // 第 1 轮：5 人 × 20
    const r1 = await drawGalaRound(db, {
      eventId: event.id, segment: 'lottery', drawCount: 5, prizeType: 'coin', poolId: pool.id, amountEach: 20,
    });
    assert.equal(r1.winners.length, 5);
    assert.ok(r1.winners.every((w) => w.userid !== kid), '第 1 轮不应出现预留对象');
    // 第 2 轮：5 人 + 预留 1 人
    const r2 = await drawGalaRound(db, {
      eventId: event.id, segment: 'lottery', drawCount: 5, prizeType: 'coin', poolId: pool.id, amountEach: 20,
    });
    assert.equal(r2.winners.length, 6);
    const kidRow = r2.winners.find((w) => w.userid === kid);
    assert.ok(kidRow && Number(kidRow.is_reserved) === 1 && Number(kidRow.amount) === 88);
    assert.equal(Number(kidRow.pool_id), reservedPool.id);
    const r1Ids = new Set(r1.winners.map((w) => w.userid));
    assert.ok(r2.winners.every((w) => !r1Ids.has(w.userid)), '同环节已中奖者不应重复中奖');
    console.log('✓ 抽签排除已中奖者，预留名额为额外名额');

    // 非超管视图不暴露预留标记
    const publicRounds = await listGalaRounds(db, { eventId: event.id, includeReserved: false });
    assert.ok(publicRounds.every((r) => r.winners.every((w) => w.is_reserved === undefined && w.pool_id === undefined)));
    const publicDetail = await getGalaEventDetail(db, { eventId: event.id, includeReserved: false });
    assert.ok(publicDetail.pools.every((p) => p.is_reserved === 0));

    // 并发发币：同一轮点 8 次，只发一次
    const results = await Promise.all(Array.from({ length: 8 }, () => grantGalaRound(db, { roundId: r2.round.id })));
    const grantedTotal = results.reduce((s, r) => s + r.granted.length, 0);
    assert.equal(grantedTotal, 6, `应只发 6 笔，实际 ${grantedTotal}`);
    assert.equal(await balanceOf(db, kid), 88);
    const ledgerRows = await db.get('SELECT COUNT(*) AS n FROM ledger WHERE ref_id LIKE ? AND userid LIKE ?', ['GALA_W%', `${PREFIX}_%`]);
    assert.equal(Number(ledgerRows.n), 6);
    const poolAfter = await db.get('SELECT spent FROM gala_pools WHERE id = ?', [pool.id]);
    assert.equal(Number(poolAfter.spent), 100);
    const reservedAfter = await db.get('SELECT spent FROM gala_pools WHERE id = ?', [reservedPool.id]);
    assert.equal(Number(reservedAfter.spent), 88);
    console.log('✓ 并发发币幂等，员工奖池与预留奖池分别扣减');

    // 预算不足：剩余 500，一轮 30 × 20 = 600 被拒
    await assert.rejects(
      drawGalaRound(db, { eventId: event.id, segment: 'giveaway', drawCount: 30, prizeType: 'coin', poolId: pool.id, amountEach: 20 }),
      (e) => e.code === 'pool_budget_insufficient',
    );
    // 预算校验在发币时兜底：抽两轮各 20 × 20 = 400，第二轮发币时超出部分失败且不入账
    const g1 = await drawGalaRound(db, { eventId: event.id, segment: 'giveaway', drawCount: 20, prizeType: 'coin', poolId: pool.id, amountEach: 20 });
    const g2 = await drawGalaRound(db, { eventId: event.id, segment: 'game', drawCount: 20, prizeType: 'coin', poolId: pool.id, amountEach: 20 });
    const gr1 = await grantGalaRound(db, { roundId: g1.round.id });
    assert.equal(gr1.granted.length, 20);
    const gr2 = await grantGalaRound(db, { roundId: g2.round.id });
    assert.equal(gr2.granted.length, 5);
    assert.equal(gr2.failed.length, 15);
    assert.ok(gr2.failed.every((f) => f.error === 'pool_budget_exceeded'));
    const poolFinal = await db.get('SELECT spent, budget FROM gala_pools WHERE id = ?', [pool.id]);
    assert.equal(Number(poolFinal.spent), 600);
    console.log('✓ 奖池花完后拒绝发币，失败记录可见');

    // 环节停用后不能抽签
    await updateGalaEvent(db, { eventId: event.id, enabledSegments: ['lottery', 'giveaway'] });
    await assert.rejects(
      drawGalaRound(db, { eventId: event.id, segment: 'game', drawCount: 1 }),
      (e) => e.code === 'segment_disabled',
    );
    await assert.rejects(
      drawGalaRound(db, { eventId: event.id, segment: 'danmaku', drawCount: 1 }),
      (e) => e.code === 'segment_not_drawable',
    );
    console.log('✓ 环节启停生效');

    await updateGalaEvent(db, { eventId: event.id, status: 'ended' });
    await assert.rejects(
      drawGalaRound(db, { eventId: event.id, segment: 'lottery', drawCount: 1 }),
      (e) => e.code === 'event_ended',
    );
    console.log('✓ 活动结束后不能再抽签');
    // HTTP：权限与预留信息可见性
    const superId = `${PREFIX}_super`;
    cfg.adminUserids = [...(cfg.adminUserids || []), superId];
    const operatorId = uid(2);
    await db.exec(
      "INSERT INTO admin_user_roles(userid, role_id, assigned_at) SELECT ?, id, unixepoch() FROM admin_roles WHERE code = 'operator'",
      [operatorId],
    );
    const app = createApp({ db, cfg });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookieOf = (userid) => `bob_admin_session=${createSessionToken(adminSessionSigningSecret(cfg), { userid, name: userid })}`;
    const call = async (who, method, path, body) => {
      const res = await fetch(`${base}/admin${path}`, {
        method,
        headers: { cookie: cookieOf(who), 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    try {
      let r = await call(superId, 'POST', '/gala/events/create', { title: `${PREFIX} HTTP`, total_budget: 0 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const hid = r.body.data.id;
      r = await call(operatorId, 'POST', '/gala/reserved/pools/create', { event_id: hid, name: 'x', budget: 10 });
      assert.equal(r.status, 403, '运营管理员不能创建预留奖池');
      r = await call(operatorId, 'GET', `/gala/reserved?event_id=${hid}`);
      assert.equal(r.status, 403, '运营管理员看不到预留名额');
      r = await call(superId, 'POST', '/gala/reserved/pools/create', { event_id: hid, name: '预留', budget: 50 });
      assert.equal(r.status, 200);
      const rp = r.body.data.id;
      r = await call(superId, 'POST', '/gala/reserved/create', {
        event_id: hid, segment: 'lottery', round_no: 1, userid: kid, pool_id: rp, amount: 50,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      r = await call(operatorId, 'POST', '/gala/participants/add', { event_id: hid, userids: [uid(3), uid(4), uid(5)] });
      assert.equal(r.status, 200);
      r = await call(operatorId, 'POST', '/gala/rounds/draw', { event_id: hid, segment: 'lottery', draw_count: 2 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.winners.length, 3);
      assert.ok(r.body.data.winners.every((w) => !('is_reserved' in w)), '运营管理员的返回不含预留标记');
      r = await call(operatorId, 'GET', `/gala/events/detail?id=${hid}`);
      assert.equal(r.body.data.pools.length, 0, '运营管理员看不到预留奖池');
      r = await call(superId, 'GET', `/gala/rounds?event_id=${hid}`);
      assert.equal(r.body.data[0].winners.filter((w) => w.is_reserved === 1).length, 1);
      r = await call(operatorId, 'POST', '/gala/rounds/grant', { round_id: r.body.data[0].id });
      assert.equal(r.status, 200);
      assert.equal(r.body.data.granted.length, 1, '只有预留名额带奖励');
      console.log('✓ HTTP：预留接口仅超管可用，非超管返回中不暴露预留信息');
    } finally {
      server.close();
    }

    console.log('ALL GALA INTEGRATION CHECKS PASSED');
  } finally {
    await cleanup(db);
    await db.close();
  }
}

main()
  .then(() => process.exit(0)) // createApp 会拉起后台定时任务，显式退出
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
