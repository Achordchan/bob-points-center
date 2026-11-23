// 年会模块本地集成测试：连接本机开发库，覆盖 DDL、抽签、预留名额、奖池预算、并发幂等发币。
// 仅允许本地开发数据库：需设置 BOB_INTERNAL_TEST_DB=1 与 BOB_GALA_TEST_DATABASE_CONFIRM=<库名>，
// 且数据库必须带 bob.environment=development GUC 标记。跑完自动清理测试数据。
import 'dotenv/config';
import { Client } from 'pg';
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
  updateGalaPool,
  cancelGalaReservedSlot,
} from '../src/services/galaService.js';
import { purgeUserBusinessData } from '../src/services/userDataPurgeService.js';

const PREFIX = `TEST_GALA_${Date.now()}`;
const USERS = 30;
const uid = (i) => `${PREFIX}_${String(i).padStart(3, '0')}`;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function assertSafeTarget(cfg) {
  if (process.env.BOB_INTERNAL_TEST_DB !== '1') {
    throw new Error('拒绝执行：请先设置 BOB_INTERNAL_TEST_DB=1，确认这是内部集成测试。');
  }
  const host = String(cfg?.db?.host || '').trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`拒绝执行：集成测试只允许本机测试库，当前 host=${cfg?.db?.host || '-'}`);
  }
  const dbName = String(cfg?.db?.database || '').toLowerCase();
  if (process.env.BOB_GALA_TEST_DATABASE_CONFIRM !== dbName) {
    throw new Error(`拒绝执行：请设置 BOB_GALA_TEST_DATABASE_CONFIRM=${dbName}，二次确认写入目标数据库。`);
  }
}

// 在任何写入（含 initDb 的 DDL）之前，用只读事务的独立连接确认目标库带有开发标记。
async function assertDevelopmentMarker(cfg) {
  const client = new Client({
    host: cfg.db.host,
    port: cfg.db.port,
    database: cfg.db.database,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query("SELECT current_setting('bob.environment', true) AS env");
    await client.query('ROLLBACK');
    if (String(rows[0]?.env || '').toLowerCase() !== 'development') {
      throw new Error('拒绝执行：目标库缺少 bob.environment=development 标记');
    }
  } finally {
    await client.end();
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
  await assertDevelopmentMarker(cfg);
  // 只有确认是本机开发库之后才初始化（会执行 DDL），清理也只在这之后才可能运行。
  const db = await initDb();
  try {
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

    // 并发：奖池更新与抽签同时进行不应死锁（40P01）
    {
      const ev = await createGalaEvent(db, { title: `${PREFIX} 并发`, totalBudget: 0 });
      const p2 = await createGalaPool(db, { eventId: ev.id, name: '并发池', budget: 100000 });
      await addGalaParticipants(db, { eventId: ev.id, userids: Array.from({ length: 10 }, (_, i) => uid(i + 1)) });
      const jobs = [];
      for (let i = 0; i < 12; i += 1) {
        jobs.push(drawGalaRound(db, {
          eventId: ev.id, segment: 'giveaway', drawCount: 1, prizeType: 'coin', poolId: p2.id, amountEach: 1,
          excludePreviousWinners: false,
        }));
        jobs.push(updateGalaPool(db, { poolId: p2.id, budget: 100000 + i }));
      }
      const settled = await Promise.allSettled(jobs);
      const failures = settled.filter((x) => x.status === 'rejected').map((x) => String(x.reason?.code || x.reason?.message));
      assert.deepEqual(failures, [], `并发抽签与改奖池不应失败：${failures.join(', ')}`);

      // 预留名额与抽签并发：要么在抽签前提交并被本轮使用，要么因该轮已抽而拒绝，不能留下悬挂名额
      for (let round = 1; round <= 6; round += 1) {
        // eslint-disable-next-line no-await-in-loop
        const [d, r] = await Promise.allSettled([
          drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: 1 }),
          createGalaReservedSlot(db, { eventId: ev.id, segment: 'lottery', roundNo: round, userid: uid(USERS - round) }),
        ]);
        assert.equal(d.status, 'fulfilled', String(d.reason?.code || d.reason));
        if (r.status === 'rejected') assert.equal(r.reason?.code, 'round_already_drawn');
      }
      const dangling = await db.get(
        `SELECT COUNT(*) AS n FROM gala_reserved_slots s
          WHERE s.event_id = ? AND s.status = 'pending'
            AND EXISTS (SELECT 1 FROM gala_rounds r WHERE r.event_id = s.event_id AND r.segment = s.segment AND r.round_no = s.round_no)`,
        [ev.id],
      );
      assert.equal(Number(dangling.n), 0, '不应存在对应轮次已抽完却仍待用的预留名额');
      console.log('✓ 并发：改奖池与抽签不死锁，预留名额不会悬挂');
    }

    // 用户重置：未发放的中奖记录被清理，之后发币不会再入账
    {
      const ev = await createGalaEvent(db, { title: `${PREFIX} 重置`, totalBudget: 0 });
      const p3 = await createGalaPool(db, { eventId: ev.id, name: '重置池', budget: 1000 });
      const target = uid(USERS);
      await addGalaParticipants(db, { eventId: ev.id, userids: [target] });
      const d = await drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: 1, prizeType: 'coin', poolId: p3.id, amountEach: 50 });
      assert.equal(d.winners[0].userid, target);
      const before = await balanceOf(db, target);
      await db.transaction((tx) => purgeUserBusinessData(tx, [target]));
      const g = await grantGalaRound(db, { roundId: d.round.id });
      assert.equal(g.granted.length, 0, '重置后不应再发放旧奖励');
      assert.equal(await balanceOf(db, target), 0);
      assert.ok(before >= 0);
      const left = await db.get('SELECT COUNT(*) AS n FROM gala_participants WHERE event_id = ? AND userid = ?', [ev.id, target]);
      assert.equal(Number(left.n), 0);
      console.log('✓ 用户重置会清理未发放的年会奖励与参与记录');

      // 抽签与重置并发：无论谁先拿到锁，重置后的账户都不能再拿到这一轮的奖励
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const evR = await createGalaEvent(db, { title: `${PREFIX} 重置并发${i}`, totalBudget: 0 });
        // eslint-disable-next-line no-await-in-loop
        const pR = await createGalaPool(db, { eventId: evR.id, name: '并发重置池', budget: 1000 });
        // eslint-disable-next-line no-await-in-loop
        await addGalaParticipants(db, { eventId: evR.id, userids: [target, uid(1)] });
        // eslint-disable-next-line no-await-in-loop
        const [dr, pr] = await Promise.allSettled([
          drawGalaRound(db, { eventId: evR.id, segment: 'lottery', drawCount: 2, prizeType: 'coin', poolId: pR.id, amountEach: 7 }),
          db.transaction((tx) => purgeUserBusinessData(tx, [target])),
        ]);
        assert.equal(dr.status, 'fulfilled', String(dr.reason?.code || dr.reason));
        assert.equal(pr.status, 'fulfilled', String(pr.reason?.code || pr.reason));
        // eslint-disable-next-line no-await-in-loop
        await grantGalaRound(db, { roundId: dr.value.round.id });
        // eslint-disable-next-line no-await-in-loop
        const leftover = await db.get(
          'SELECT COUNT(*) AS n FROM gala_round_winners WHERE round_id = ? AND userid = ?',
          [dr.value.round.id, target],
        );
        assert.equal(Number(leftover.n), 0, '重置后不应残留该用户的中奖记录');
        // eslint-disable-next-line no-await-in-loop
        assert.equal(await balanceOf(db, target), 0, '抽签与重置并发后不应给已重置账户发币');
      }
      console.log('✓ 抽签与用户重置并发：已重置账户不会拿到奖励');
    }

    // 兜底：缺少奖池或奖池不属于同一活动的正数奖励不能发放
    {
      const evA = await createGalaEvent(db, { title: `${PREFIX} 无池`, totalBudget: 0 });
      const evB = await createGalaEvent(db, { title: `${PREFIX} 他池`, totalBudget: 0 });
      const pB = await createGalaPool(db, { eventId: evB.id, name: '他池', budget: 1000 });
      const pA = await createGalaPool(db, { eventId: evA.id, name: '本池', budget: 1000 });
      await addGalaParticipants(db, { eventId: evA.id, userids: [uid(2), uid(3)] });
      const d = await drawGalaRound(db, { eventId: evA.id, segment: 'lottery', drawCount: 2, prizeType: 'coin', poolId: pA.id, amountEach: 9 });
      const [w1, w2] = d.winners.map((w) => w.userid);
      await db.exec(`UPDATE gala_round_winners SET pool_id = NULL WHERE round_id = ${Number(d.round.id)} AND userid = '${w1}'`);
      await db.exec(`UPDATE gala_round_winners SET pool_id = ${Number(pB.id)} WHERE round_id = ${Number(d.round.id)} AND userid = '${w2}'`);
      const b1 = await balanceOf(db, w1);
      const b2 = await balanceOf(db, w2);
      const g = await grantGalaRound(db, { roundId: d.round.id });
      assert.equal(g.granted.length, 0);
      assert.deepEqual(g.failed.map((f) => f.error).sort(), ['winner_pool_missing', 'winner_pool_missing']);
      assert.equal(await balanceOf(db, w1), b1);
      assert.equal(await balanceOf(db, w2), b2);
      const spentB = await db.get('SELECT spent FROM gala_pools WHERE id = ?', [pB.id]);
      assert.equal(Number(spentB.spent), 0);
      console.log('✓ 发币兜底：无奖池或跨活动奖池的奖励不会发放');

      // 预留奖励只能扣预留奖池，不能记到员工奖池上
      const evC = await createGalaEvent(db, { title: `${PREFIX} 预留错池`, totalBudget: 0 });
      const pC = await createGalaPool(db, { eventId: evC.id, name: '员工池', budget: 1000 });
      const rC = await createGalaPool(db, { eventId: evC.id, name: '预留池', budget: 1000, reserved: true });
      await addGalaParticipants(db, { eventId: evC.id, userids: [uid(2)] });
      await createGalaReservedSlot(db, { eventId: evC.id, segment: 'lottery', roundNo: 1, userid: uid(5), poolId: rC.id, amount: 5 });
      const dC = await drawGalaRound(db, { eventId: evC.id, segment: 'lottery', drawCount: 1, prizeType: 'coin', poolId: pC.id, amountEach: 9 });
      await db.exec(`UPDATE gala_round_winners SET pool_id = ${Number(pC.id)} WHERE round_id = ${Number(dC.round.id)} AND is_reserved = 1`);
      const gC = await grantGalaRound(db, { roundId: dC.round.id });
      assert.deepEqual(gC.granted.map((x) => x.userid), [uid(2)]);
      assert.deepEqual(gC.failed, [{ userid: uid(5), error: 'winner_pool_missing', is_reserved: 1 }]);
      const spentC = await db.get('SELECT spent FROM gala_pools WHERE id = ?', [pC.id]);
      assert.equal(Number(spentC.spent), 9, '员工奖池只应扣普通中奖的 9');
      console.log('✓ 发币兜底：预留奖励不会扣到员工奖池');
    }

    // 取消预留名额与抽签并发：被预留的人要么拿到预留名额，要么回到普通抽签，不能两头落空
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const evX = await createGalaEvent(db, { title: `${PREFIX} 取消并发${i}`, totalBudget: 0 });
      // eslint-disable-next-line no-await-in-loop
      await addGalaParticipants(db, { eventId: evX.id, userids: [uid(1), uid(2), uid(3), uid(4)] });
      // eslint-disable-next-line no-await-in-loop
      const slot = await createGalaReservedSlot(db, { eventId: evX.id, segment: 'lottery', roundNo: 1, userid: uid(4) });
      // eslint-disable-next-line no-await-in-loop
      const [dx, cx] = await Promise.allSettled([
        drawGalaRound(db, { eventId: evX.id, segment: 'lottery', drawCount: 4 }),
        cancelGalaReservedSlot(db, { slotId: slot.id }),
      ]);
      assert.equal(dx.status, 'fulfilled', String(dx.reason?.code || dx.reason));
      if (cx.status === 'rejected') assert.equal(cx.reason?.code, 'slot_not_pending');
      const ids = dx.value.winners.map((w) => w.userid).sort();
      assert.deepEqual(ids, [uid(1), uid(2), uid(3), uid(4)].sort(), '被预留的人不应在并发取消时两头落空');
    }
    console.log('✓ 取消预留名额与抽签串行，不会漏掉被预留的人');

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
      assert.equal(r.body.data.draw_count, 3, '非超管看到的抽取人数等于名单人数');
      const PAYOUT_KEYS = ['is_reserved', 'pool_id', 'amount', 'awarded', 'awarded_at', 'award_error'];
      const noPayout = (w) => PAYOUT_KEYS.every((k) => !(k in w));
      assert.ok(r.body.data.winners.every(noPayout), '运营管理员的抽签返回不含逐人发放信息');
      r = await call(operatorId, 'GET', `/gala/events/detail?id=${hid}`);
      assert.equal(r.body.data.pools.length, 0, '运营管理员看不到预留奖池');
      r = await call(superId, 'GET', `/gala/rounds?event_id=${hid}`);
      assert.equal(r.body.data[0].winners.filter((w) => w.is_reserved === 1).length, 1);
      const hRound = r.body.data[0].id;
      r = await call(operatorId, 'POST', '/gala/rounds/grant', { round_id: hRound });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data, { round_id: hRound, failed: [], pending: 0 }, '非超管的发放回执不列成功名单、不含余额');
      assert.equal(await balanceOf(db, kid), 88 + 50, '预留奖励照常发放');
      r = await call(operatorId, 'GET', `/gala/rounds?event_id=${hid}`);
      assert.ok(r.body.data[0].winners.every(noPayout), '运营管理员的轮次列表不含逐人发放信息');
      assert.equal(r.body.data[0].draw_count, 3);
      r = await call(superId, 'GET', `/gala/rounds?event_id=${hid}`);
      assert.equal(r.body.data[0].winners.find((w) => w.is_reserved === 1).awarded, 1);
      assert.ok(!JSON.stringify(r.body).includes('balance'), '轮次接口不返回余额');
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
