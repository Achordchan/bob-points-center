// 年会模块本地集成测试：连接本机开发库，覆盖 DDL、抽签、预留名额、奖池预算、并发幂等发币。
// 仅允许本地开发数据库：需设置 BOB_INTERNAL_TEST_DB=1 与 BOB_GALA_TEST_DATABASE_CONFIRM=<库名>，
// 且数据库必须带 bob.environment=development GUC 标记。跑完自动清理测试数据。
import 'dotenv/config';
import { Client } from 'pg';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  listGalaEvents,
  listGalaRounds,
  updateGalaEvent,
  updateGalaPool,
  cancelGalaReservedSlot,
  listGalaParticipants,
  removeGalaParticipant,
  serializeGrantResult,
  serializeDrawResult,
  GALA_DRAW_HEADROOM,
  GALA_MAX_RESERVED_SLOTS,
  GALA_PAYOUT_LOCK,
  bumpGalaRestoreGeneration,
  GALA_SEGMENTS,
} from '../src/services/galaService.js';
import { purgeUserBusinessData } from '../src/services/userDataPurgeService.js';

const PREFIX = `TEST_GALA_${Date.now()}`;
const USERS = 30;
const uid = (i) => `${PREFIX}_${String(i).padStart(3, '0')}`;
// 抽签公开准入要求可抽人数比抽签人数多 GALA_DRAW_HEADROOM 人。小名单场景在关注的人之后补这批“陪跑”参与者；
// 配合 FIRST（总是取第一个候选人），抽中的仍是名单里最先加入的那几个人，断言保持确定。
const fillerIds = Array.from({ length: GALA_DRAW_HEADROOM }, (_, i) => `${PREFIX}_f${i + 1}`);
const FIRST = () => 0;
const addFiller = (db, eventId) => addGalaParticipants(db, { eventId, userids: fillerIds });

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

// 按字面前缀清理（starts_with），不用 LIKE：前缀里的下划线在 LIKE 中是单字符通配符，会误删别的数据。
async function cleanup(db) {
  await db.run('DELETE FROM gala_events WHERE starts_with(title, ?)', [PREFIX]);
  await db.run('DELETE FROM admin_user_roles WHERE starts_with(userid, ?)', [`${PREFIX}_`]);
  await db.run('DELETE FROM ledger WHERE starts_with(userid, ?)', [`${PREFIX}_`]);
  await db.run('DELETE FROM audit_logs WHERE starts_with(actor_id, ?)', [`${PREFIX}_`]).catch(() => null);
  await db.run('DELETE FROM accounts WHERE starts_with(userid, ?)', [`${PREFIX}_`]);
  await db.run('DELETE FROM users WHERE starts_with(userid, ?)', [`${PREFIX}_`]);
}

// 发币需带上操作者看到的轮次凭据；测试里默认取当前代数（等同于刚刷新过轮次列表）。
async function grantRound(db, roundId, token) {
  const t = token ?? `${(await db.get('SELECT generation FROM gala_restore_state WHERE id = 1')).generation}.${Number(roundId)}`;
  return grantGalaRound(db, { roundId, grantToken: t });
}

async function balanceOf(db, userid) {
  const row = await db.get('SELECT balance FROM accounts WHERE userid = ?', [userid]);
  return Number(row?.balance || 0);
}

// 预留名额必须指定预留奖池：测试里没写奖池的名额自动挂到该活动的一个测试预留奖池上。
const testReservedPools = new Map();
async function addSlot(db, args) {
  if (args.poolId != null) return createGalaReservedSlot(db, args);
  let pid = testReservedPools.get(args.eventId);
  if (!pid) {
    pid = (await createGalaPool(db, { eventId: args.eventId, name: '测试预留池', budget: 100000, reserved: true })).id;
    testReservedPools.set(args.eventId, pid);
  }
  return createGalaReservedSlot(db, { ...args, poolId: pid });
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
    for (const f of fillerIds) {
      // eslint-disable-next-line no-await-in-loop
      await db.run('INSERT INTO users(userid, name) VALUES(?, ?)', [f, f]);
      // eslint-disable-next-line no-await-in-loop
      await db.run('INSERT INTO accounts(userid, balance) VALUES(?, 0)', [f]);
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
      eventId: event.id, segment: 'lottery', roundNo: 2, userid: kid, poolId: reservedPool.id, note: 'test',
    });
    await assert.rejects(
      addSlot(db, { eventId: event.id, segment: 'lottery', roundNo: 2, userid: uid(1) }),
      (e) => e.code === 'slot_already_exists',
    );

    // 第 1 轮：5 人 × 20
    const r1 = await drawGalaRound(db, {
      eventId: event.id, segment: 'lottery', drawCount: 5, prizeType: 'coin', poolId: pool.id, amountEach: 20,
    });
    assert.equal(r1.winners.length, 5);
    assert.ok(r1.winners.every((w) => w.userid !== kid), '第 1 轮不应出现预留对象');
    // 第 2 轮：抽 5 人，预留对象占其中 1 个名额（普通 4 人 + 预留 1 人）
    const r2 = await drawGalaRound(db, {
      eventId: event.id, segment: 'lottery', drawCount: 5, prizeType: 'coin', poolId: pool.id, amountEach: 20,
    });
    assert.equal(r2.winners.length, 5, '预留名额占本轮名额，总人数等于请求人数');
    assert.equal(r2.winners.filter((w) => Number(w.is_reserved) === 0).length, 4);
    const kidRow = r2.winners.find((w) => w.userid === kid);
    assert.ok(kidRow && Number(kidRow.is_reserved) === 1 && Number(kidRow.amount) === 20, '预留奖励与本轮单价一致');
    assert.equal(Number(kidRow.pool_id), reservedPool.id);
    const r1Ids = new Set(r1.winners.map((w) => w.userid));
    assert.ok(r2.winners.every((w) => !r1Ids.has(w.userid)), '同环节已中奖者不应重复中奖');
    console.log('✓ 抽签排除已中奖者，预留名额占本轮一个名额');

    // 非超管视图不暴露预留标记
    const publicRounds = await listGalaRounds(db, { eventId: event.id, includeReserved: false });
    assert.ok(publicRounds.every((r) => r.winners.every((w) => w.is_reserved === undefined && w.pool_id === undefined)));
    const publicDetail = await getGalaEventDetail(db, { eventId: event.id, includeReserved: false });
    assert.ok(publicDetail.pools.every((p) => p.is_reserved === 0));
    // 员工奖池对非超管只公开已分配额（单价 × 抽签人数），两轮各 5 × 20，与第 2 轮含预留无关
    const pubPool = publicDetail.pools.find((p) => p.id === pool.id);
    assert.equal(pubPool.allocated, 200);
    assert.equal(pubPool.remaining, 400);
    assert.ok(!('spent' in pubPool) && !('pools_spent' in publicDetail.budget_summary), '非超管看不到实际支出');

    // 并发发币：同一轮点 8 次，只发一次
    const results = await Promise.all(Array.from({ length: 8 }, () => grantRound(db, r2.round.id)));
    const grantedTotal = results.reduce((s, r) => s + r.granted.length, 0);
    assert.equal(grantedTotal, 5, `应只发 5 笔，实际 ${grantedTotal}`);
    assert.equal(await balanceOf(db, kid), 20);
    const ledgerRows = await db.get('SELECT COUNT(*) AS n FROM ledger WHERE starts_with(ref_id, ?) AND starts_with(userid, ?)', ['GALA_W', `${PREFIX}_`]);
    assert.equal(Number(ledgerRows.n), 5);
    const poolAfter = await db.get('SELECT spent FROM gala_pools WHERE id = ?', [pool.id]);
    assert.equal(Number(poolAfter.spent), 80);
    const reservedAfter = await db.get('SELECT spent FROM gala_pools WHERE id = ?', [reservedPool.id]);
    assert.equal(Number(reservedAfter.spent), 20);
    // 一条流水只能支付一笔奖励：数据库层面 ledger_id 唯一
    {
      const two = await db.all('SELECT id, ledger_id FROM gala_round_winners WHERE round_id = ? AND ledger_id IS NOT NULL ORDER BY id LIMIT 2', [r2.round.id]);
      await assert.rejects(
        db.run('UPDATE gala_round_winners SET ledger_id = ? WHERE id = ?', [two[0].ledger_id, two[1].id]),
        (e) => e.code === '23505',
      );
    }
    console.log('✓ 并发发币幂等，员工奖池与预留奖池分别扣减');

    // 预算不足：已分配 200，剩余 400，一轮 25 × 20 = 500 被拒
    await assert.rejects(
      drawGalaRound(db, { eventId: event.id, segment: 'giveaway', drawCount: 25, prizeType: 'coin', poolId: pool.id, amountEach: 20 }),
      (e) => e.code === 'pool_budget_insufficient' && e.remaining === 400 && e.required === 500,
    );
    // 20 × 20 = 400 正好分配完，之后任何发币轮都被拒
    const g1 = await drawGalaRound(db, { eventId: event.id, segment: 'giveaway', drawCount: 20, prizeType: 'coin', poolId: pool.id, amountEach: 20 });
    await assert.rejects(
      drawGalaRound(db, { eventId: event.id, segment: 'game', drawCount: 1, prizeType: 'coin', poolId: pool.id, amountEach: 20 }),
      (e) => e.code === 'pool_budget_insufficient',
    );
    await assert.rejects(
      updateGalaPool(db, { poolId: pool.id, budget: 599 }),
      (e) => e.code === 'budget_below_allocated' && e.allocated === 600 && !('spent' in e),
    );
    // 预算校验在发币时兜底：模拟实际支出被别处占用（如残缺数据）只剩 120，超出部分失败且不入账
    await db.exec(`UPDATE gala_pools SET spent = budget - 120 WHERE id = ${Number(pool.id)}`);
    const gr1 = await grantRound(db, g1.round.id);
    assert.equal(gr1.granted.length, 6);
    assert.equal(gr1.failed.length, 14);
    assert.ok(gr1.failed.every((f) => f.error === 'pool_budget_exceeded'));
    const poolFinal = await db.get('SELECT spent, budget FROM gala_pools WHERE id = ?', [pool.id]);
    assert.equal(Number(poolFinal.spent), 600);
    console.log('✓ 员工奖池按已分配额准入，发币时仍按实际支出兜底');

    // 并发：奖池更新与抽签同时进行不应死锁（40P01）
    {
      const ev = await createGalaEvent(db, { title: `${PREFIX} 并发`, totalBudget: 0 });
      const p2 = await createGalaPool(db, { eventId: ev.id, name: '并发池', budget: 100000 });
      await addGalaParticipants(db, { eventId: ev.id, userids: Array.from({ length: 10 }, (_, i) => uid(i + 1)) });
      await addFiller(db, ev.id);
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
          addSlot(db, { eventId: ev.id, segment: 'lottery', roundNo: round, userid: uid(USERS - round) }),
        ]);
        assert.equal(d.status, 'fulfilled', String(d.reason?.code || d.reason));
        if (r.status === 'rejected') assert.ok(['round_already_drawn', 'reserved_slot_limit'].includes(r.reason?.code), String(r.reason?.code));
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
      await addFiller(db, ev.id);
      const d = await drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: 1, prizeType: 'coin', poolId: p3.id, amountEach: 50, randomInt: FIRST });
      assert.equal(d.winners[0].userid, target);
      const before = await balanceOf(db, target);
      await db.transaction((tx) => purgeUserBusinessData(tx, [target]));
      const g = await grantRound(db, d.round.id);
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
        await addGalaParticipants(db, { eventId: evR.id, userids: [target, uid(1), uid(3)] });
        // eslint-disable-next-line no-await-in-loop
        await addFiller(db, evR.id);
        // eslint-disable-next-line no-await-in-loop
        const [dr, pr] = await Promise.allSettled([
          drawGalaRound(db, { eventId: evR.id, segment: 'lottery', drawCount: 2, prizeType: 'coin', poolId: pR.id, amountEach: 7 }),
          db.transaction((tx) => purgeUserBusinessData(tx, [target])),
        ]);
        assert.equal(dr.status, 'fulfilled', String(dr.reason?.code || dr.reason));
        assert.equal(pr.status, 'fulfilled', String(pr.reason?.code || pr.reason));
        // eslint-disable-next-line no-await-in-loop
        await grantRound(db, dr.value.round.id);
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
      await addFiller(db, evA.id);
      const d = await drawGalaRound(db, { eventId: evA.id, segment: 'lottery', drawCount: 2, prizeType: 'coin', poolId: pA.id, amountEach: 9, randomInt: FIRST });
      const [w1, w2] = d.winners.map((w) => w.userid);
      await db.exec(`UPDATE gala_round_winners SET pool_id = NULL WHERE round_id = ${Number(d.round.id)} AND userid = '${w1}'`);
      await db.exec(`UPDATE gala_round_winners SET pool_id = ${Number(pB.id)} WHERE round_id = ${Number(d.round.id)} AND userid = '${w2}'`);
      const b1 = await balanceOf(db, w1);
      const b2 = await balanceOf(db, w2);
      const g = await grantRound(db, d.round.id);
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
      await createGalaReservedSlot(db, { eventId: evC.id, segment: 'lottery', roundNo: 1, userid: uid(5), poolId: rC.id });
      await addFiller(db, evC.id);
      const dC = await drawGalaRound(db, { eventId: evC.id, segment: 'lottery', drawCount: 2, prizeType: 'coin', poolId: pC.id, amountEach: 9, randomInt: FIRST });
      await db.exec(`UPDATE gala_round_winners SET pool_id = ${Number(pC.id)} WHERE round_id = ${Number(dC.round.id)} AND is_reserved = 1`);
      const gC = await grantRound(db, dC.round.id);
      assert.deepEqual(gC.granted.map((x) => x.userid), [uid(2)]);
      assert.deepEqual(gC.failed, [{ userid: uid(5), error: 'winner_pool_missing', is_reserved: 1 }]);
      const spentC = await db.get('SELECT spent FROM gala_pools WHERE id = ?', [pC.id]);
      assert.equal(Number(spentC.spent), 9, '员工奖池只应扣普通中奖的 9');
      assert.deepEqual(
        serializeGrantResult(gC, { includeReserved: false }),
        { round_id: Number(dC.round.id), failed_count: 1, failed_reasons: { winner_pool_missing: 1 }, pending: 1 },
        '预留奖励失败与普通失败一样计入汇总（原因码相同，看不出出处）',
      );
      const reasonRow = await db.get('SELECT reason FROM ledger WHERE ref_id = ?', [`GALA_W${dC.winners.find((w) => w.userid === uid(2)).id}`]);
      assert.ok(reasonRow.reason.startsWith(`年会奖励·${GALA_SEGMENTS.lottery}`), reasonRow.reason);
      console.log('✓ 发币兜底：预留奖励不会扣到员工奖池');

      // 员工奖池耗尽：普通回执只有数量与原因汇总，不列失败者
      const evD = await createGalaEvent(db, { title: `${PREFIX} 回执`, totalBudget: 0 });
      const pD = await createGalaPool(db, { eventId: evD.id, name: '小池', budget: 15 });
      const rD = await createGalaPool(db, { eventId: evD.id, name: '预留池', budget: 100, reserved: true });
      await addGalaParticipants(db, { eventId: evD.id, userids: [uid(6), uid(7), uid(8)] });
      await createGalaReservedSlot(db, { eventId: evD.id, segment: 'lottery', roundNo: 1, userid: uid(9), poolId: rD.id });
      await addFiller(db, evD.id);
      const dD = await drawGalaRound(db, { eventId: evD.id, segment: 'lottery', drawCount: 3, prizeType: 'coin', poolId: pD.id, amountEach: 5, randomInt: FIRST });
      await db.exec(`UPDATE gala_pools SET spent = budget WHERE id = ${Number(pD.id)}`);
      const gD = await grantRound(db, dD.round.id);
      const pubD = serializeGrantResult(gD, { includeReserved: false });
      assert.deepEqual(pubD, { round_id: Number(dD.round.id), failed_count: 2, failed_reasons: { pool_budget_exceeded: 2 }, pending: 2 });
      assert.ok(!JSON.stringify(pubD).includes(PREFIX), '普通回执不含任何 userid');
      const pubRounds = await listGalaRounds(db, { eventId: evD.id, includeReserved: false });
      assert.equal(pubRounds[0].status, 'drawn');
      console.log('✓ 普通发放回执只给汇总，不列逐人名单');

      // 轮次分页：before_id 取更早的轮次
      const page1 = await listGalaRounds(db, { eventId: event.id, includeReserved: true, limit: 2 });
      assert.equal(page1.length, 2);
      const page2 = await listGalaRounds(db, { eventId: event.id, includeReserved: true, limit: 2, beforeId: page1[1].id });
      assert.ok(page2.length > 0 && page2.every((r) => r.id < page1[1].id));
      console.log('✓ 轮次列表可以用 before_id 翻到更早的轮次');
    }

    // 取消预留名额与抽签并发：被预留的人要么拿到预留名额，要么回到普通抽签，不能两头落空
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const evX = await createGalaEvent(db, { title: `${PREFIX} 取消并发${i}`, totalBudget: 0 });
      // eslint-disable-next-line no-await-in-loop
      await addGalaParticipants(db, { eventId: evX.id, userids: [uid(1), uid(2), uid(3), uid(4)] });
      // eslint-disable-next-line no-await-in-loop
      const slot = await addSlot(db, { eventId: evX.id, segment: 'lottery', roundNo: 1, userid: uid(4) });
      // eslint-disable-next-line no-await-in-loop
      await addFiller(db, evX.id);
      // eslint-disable-next-line no-await-in-loop
      const [dx, cx] = await Promise.allSettled([
        drawGalaRound(db, { eventId: evX.id, segment: 'lottery', drawCount: 4, randomInt: FIRST }),
        cancelGalaReservedSlot(db, { slotId: slot.id }),
      ]);
      assert.equal(dx.status, 'fulfilled', String(dx.reason?.code || dx.reason));
      if (cx.status === 'rejected') assert.equal(cx.reason?.code, 'slot_not_pending');
      const ids = dx.value.winners.map((w) => w.userid).sort();
      assert.deepEqual(ids, [uid(1), uid(2), uid(3), uid(4)].sort(), '被预留的人不应在并发取消时两头落空');
    }
    console.log('✓ 取消预留名额与抽签串行，不会漏掉被预留的人');

    // 预留对象是真实参与者：名单增删、计数与普通人一致；被移出名单后名额自动作废；重置后不再出现在名单
    {
      const evR = await createGalaEvent(db, { title: `${PREFIX} 名单`, totalBudget: 0 });
      await addGalaParticipants(db, { eventId: evR.id, userids: [uid(1), uid(2), uid(3)] });
      await addSlot(db, { eventId: evR.id, segment: 'lottery', roundNo: 1, userid: uid(10) });
      await addSlot(db, { eventId: evR.id, segment: 'lottery', roundNo: 2, userid: uid(11) });
      const pub = await listGalaParticipants(db, { eventId: evR.id });
      assert.deepEqual(pub.map((x) => x.userid).sort(), [uid(1), uid(2), uid(3), uid(10), uid(11)].sort());
      assert.ok(pub.every((x) => !('is_reserved' in x)));
      const sup = await listGalaParticipants(db, { eventId: evR.id, includeReserved: true });
      assert.deepEqual(sup.filter((x) => x.is_reserved === 1).map((x) => x.userid).sort(), [uid(10), uid(11)].sort());
      const detail = await getGalaEventDetail(db, { eventId: evR.id });
      assert.equal(detail.participant_count, 5);

      const rm = await removeGalaParticipant(db, { eventId: evR.id, userid: uid(10) });
      assert.equal(rm.removed, 1, '移除预留对象与移除普通人结果一致');
      assert.ok(!(await listGalaParticipants(db, { eventId: evR.id })).some((x) => x.userid === uid(10)));
      await addFiller(db, evR.id);
      const d1 = await drawGalaRound(db, { eventId: evR.id, segment: 'lottery', drawCount: 2 });
      assert.ok(d1.winners.every((w) => w.userid !== uid(10)), '已移出名单的预留对象不会中奖');
      assert.equal(d1.winners.length, 2);
      const s10 = await db.get('SELECT status FROM gala_reserved_slots WHERE event_id = ? AND userid = ?', [evR.id, uid(10)]);
      assert.equal(s10.status, 'cancelled');

      const d2 = await drawGalaRound(db, { eventId: evR.id, segment: 'lottery', drawCount: 1, excludePreviousWinners: false });
      assert.deepEqual(d2.winners.map((w) => w.userid), [uid(11)]);
      await db.transaction((tx) => purgeUserBusinessData(tx, [uid(11)]));
      const afterReset = await listGalaParticipants(db, { eventId: evR.id, includeReserved: true });
      assert.ok(!afterReset.some((x) => x.userid === uid(11)), '重置后不再出现在名单里');
      assert.equal((await getGalaEventDetail(db, { eventId: evR.id })).participant_count, afterReset.length);

      for (const limit of [1.5, true, [3], '1e2', 0]) {
        // eslint-disable-next-line no-await-in-loop
        await assert.rejects(listGalaRounds(db, { eventId: evR.id, limit }), (e) => e.code === 'invalid_limit', String(limit));
      }
      console.log('✓ 预留对象是真实参与者：增删一致、移出即作废、重置后消失');
    }

    // 单人发币轮：中奖的是普通人还是预留对象，非超管看到的发放状态完全一样；预留奖励发放失败也一样
    {
      const evS = await createGalaEvent(db, { title: `${PREFIX} 单人`, totalBudget: 0 });
      const pS = await createGalaPool(db, { eventId: evS.id, name: '员工池', budget: 100 });
      const rS = await createGalaPool(db, { eventId: evS.id, name: '预留池', budget: 10, reserved: true });
      await addGalaParticipants(db, { eventId: evS.id, userids: [uid(12), uid(13)] });
      await db.exec(`UPDATE users SET name = '改名后' WHERE userid = '${uid(14)}'`);
      await createGalaReservedSlot(db, { eventId: evS.id, segment: 'lottery', roundNo: 2, userid: uid(14), poolId: rS.id });
      await createGalaReservedSlot(db, { eventId: evS.id, segment: 'giveaway', roundNo: 1, userid: uid(15), poolId: rS.id });
      await addFiller(db, evS.id);
      const snap14 = (await listGalaParticipants(db, { eventId: evS.id })).find((x) => x.userid === uid(14));
      await db.exec(`UPDATE users SET name = '又改名' WHERE userid = '${uid(14)}'`);

      const normal = await drawGalaRound(db, { eventId: evS.id, segment: 'lottery', drawCount: 1, prizeType: 'coin', poolId: pS.id, amountEach: 5 });
      const reservedWin = await drawGalaRound(db, { eventId: evS.id, segment: 'lottery', drawCount: 1, prizeType: 'coin', poolId: pS.id, amountEach: 5 });
      assert.equal(reservedWin.winners[0].userid, uid(14));
      assert.equal(reservedWin.winners[0].name_snapshot, snap14.name, '预留中奖人用名单快照里的名字');
      const reservedFail = await drawGalaRound(db, { eventId: evS.id, segment: 'giveaway', drawCount: 1, prizeType: 'coin', poolId: pS.id, amountEach: 5 });
      assert.equal(reservedFail.winners[0].userid, uid(15));
      for (const d of [normal, reservedWin]) {
        // eslint-disable-next-line no-await-in-loop
        const g = await grantRound(db, d.round.id);
        assert.deepEqual(
          serializeGrantResult(g, { includeReserved: false }),
          { round_id: Number(d.round.id), failed_count: 0, failed_reasons: {}, pending: 0 },
        );
      }
      await db.exec(`UPDATE gala_pools SET spent = budget WHERE id = ${Number(rS.id)}`);
      // 预留奖励发放失败：公开回执与普通中奖人因奖池不足失败时完全一样（同样计入失败和待发），整轮保持 drawn
      const gFail = await grantRound(db, reservedFail.round.id);
      assert.deepEqual(
        serializeGrantResult(gFail, { includeReserved: false }),
        { round_id: Number(reservedFail.round.id), failed_count: 1, failed_reasons: { pool_budget_exceeded: 1 }, pending: 1 },
      );
      const pubS = await listGalaRounds(db, { eventId: evS.id });
      const supS = await listGalaRounds(db, { eventId: evS.id, includeReserved: true });
      const order = [normal, reservedWin, reservedFail].map((d) => Number(d.round.id));
      const statusOf = (rounds) => order.map((rid) => rounds.find((r) => r.id === rid).status);
      assert.deepEqual(statusOf(pubS), ['granted', 'granted', 'drawn']);
      assert.deepEqual(statusOf(supS), statusOf(pubS), '超管与非超管看到同一个整轮状态');

      const pubPoolS = (await getGalaEventDetail(db, { eventId: evS.id })).pools.find((p) => p.id === pS.id);
      assert.deepEqual([pubPoolS.allocated, pubPoolS.remaining, 'spent' in pubPoolS], [15, 85, false], '三轮都按 1 × 5 计入已分配额');
      console.log('✓ 单人轮次：预留奖励成败与普通奖励同样呈现，公开账面与预留无关');
    }

    // 公开抽签人数上限：只由名单人数和本环节已中奖人数决定，有没有预留、预留几个，准入结果都一样
    {
      const n = GALA_DRAW_HEADROOM + 4;
      const outcomes = [];
      for (const reserveCount of [0, 1, GALA_MAX_RESERVED_SLOTS]) {
        // eslint-disable-next-line no-await-in-loop
        const ev = await createGalaEvent(db, { title: `${PREFIX} 上限${reserveCount}`, totalBudget: 0 });
        // eslint-disable-next-line no-await-in-loop
        await addGalaParticipants(db, { eventId: ev.id, userids: Array.from({ length: n }, (_, i) => uid(i + 1)) });
        for (let k = 0; k < reserveCount; k += 1) {
          // eslint-disable-next-line no-await-in-loop
          await addSlot(db, { eventId: ev.id, segment: 'game', roundNo: 5 + k, userid: uid(k + 1) });
        }
        // eslint-disable-next-line no-await-in-loop
        const over = await drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: n - GALA_DRAW_HEADROOM + 1 })
          .then(() => 'ok', (e) => `${e.code}:${e.max_draw_count}`);
        // eslint-disable-next-line no-await-in-loop
        const exact = await drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: n - GALA_DRAW_HEADROOM })
          .then((d) => d.winners.length, (e) => e.code);
        outcomes.push([over, exact]);
      }
      const expected = [`not_enough_participants:${n - GALA_DRAW_HEADROOM}`, n - GALA_DRAW_HEADROOM];
      assert.deepEqual(outcomes, [expected, expected, expected], '准入结果不随预留变化');
      console.log('✓ 抽签人数上限是公开规则，与预留无关，且不会抽走除预留对象外的所有人');
    }

    // 移出名单与抽签串行：名单恰好满足“抽签人数 + 余量”时并发移出第一个人，
    // 要么移出在前（抽签按新名单拒绝），要么抽签在前（第一个人照常被抽中，FIRST 总是先取他）
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ev = await createGalaEvent(db, { title: `${PREFIX} 移出并发${i}`, totalBudget: 0 });
      // eslint-disable-next-line no-await-in-loop
      await addGalaParticipants(db, { eventId: ev.id, userids: Array.from({ length: GALA_DRAW_HEADROOM + 2 }, (_, k) => uid(k + 1)) });
      // 批量导入的插入顺序不一定等于传入顺序，按名单 id 取真正排第一的人
      // eslint-disable-next-line no-await-in-loop
      const first = (await db.get('SELECT userid FROM gala_participants WHERE event_id = ? ORDER BY id LIMIT 1', [ev.id])).userid;
      // eslint-disable-next-line no-await-in-loop
      const [dr, rm] = await Promise.allSettled([
        drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: 2, randomInt: FIRST }),
        removeGalaParticipant(db, { eventId: ev.id, userid: first }),
      ]);
      assert.equal(rm.status, 'fulfilled');
      if (dr.status === 'fulfilled') {
        assert.ok(dr.value.winners.some((w) => w.userid === first), '抽签成功说明它在移出之前执行，应抽中第一个人');
      } else {
        assert.equal(dr.reason?.code, 'not_enough_participants', String(dr.reason?.code || dr.reason));
      }
    }
    console.log('✓ 移出名单与抽签串行，准入检查与实际候选人一致');

    // 批量导入名单与创建预留名额同时加入同一个人：两者都先锁活动行，不会死锁
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ev = await createGalaEvent(db, { title: `${PREFIX} 导入并发${i}`, totalBudget: 0 });
      // eslint-disable-next-line no-await-in-loop
      const [ad, sl] = await Promise.allSettled([
        addGalaParticipants(db, { eventId: ev.id, userids: [uid(7), uid(8), uid(9)] }),
        addSlot(db, { eventId: ev.id, segment: 'lottery', roundNo: 1, userid: uid(8) }),
      ]);
      assert.equal(ad.status, 'fulfilled', String(ad.reason?.code || ad.reason));
      assert.equal(sl.status, 'fulfilled', String(sl.reason?.code || sl.reason));
      // eslint-disable-next-line no-await-in-loop
      const n = await db.get('SELECT COUNT(*) AS n FROM gala_participants WHERE event_id = ?', [ev.id]);
      assert.equal(Number(n.n), 3);
    }
    console.log('✓ 导入名单与创建预留名额并发不死锁');

    // 发放绑定开始时读到的轮次：轮次被替换（模拟全量恢复重建了同 ID 的轮次）后发放停止，不写新数据
    {
      const ev = await createGalaEvent(db, { title: `${PREFIX} 轮次替换`, totalBudget: 0 });
      const p = await createGalaPool(db, { eventId: ev.id, name: '池', budget: 1000 });
      await addGalaParticipants(db, { eventId: ev.id, userids: Array.from({ length: 20 }, (_, k) => uid(k + 1)) });
      const d = await drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: 10, prizeType: 'coin', poolId: p.id, amountEach: 1 });
      const [g, swap] = await Promise.allSettled([
        grantRound(db, d.round.id),
        (async () => {
          await new Promise((r) => setTimeout(r, 5));
          await db.run('UPDATE gala_rounds SET created_at = created_at + 1 WHERE id = ?', [d.round.id]);
        })(),
      ]);
      assert.equal(swap.status, 'fulfilled');
      if (g.status === 'rejected') assert.equal(g.reason?.code, 'round_changed');
      const errs = await db.get('SELECT COUNT(*) AS n FROM gala_round_winners WHERE round_id = ? AND award_error IS NOT NULL', [d.round.id]);
      assert.equal(Number(errs.n), 0, '轮次被替换后不应把错误写到中奖记录上');
      const after = await grantRound(db, d.round.id);
      const paid = await db.get('SELECT COUNT(*) AS n FROM gala_round_winners WHERE round_id = ? AND awarded_at IS NOT NULL', [d.round.id]);
      assert.equal(Number(paid.n), 10, '对替换后的轮次重新发放，剩余的照常到账');
      assert.ok(after.failed.length === 0);
      console.log(`✓ 发放绑定轮次身份，被替换时停止（本次${g.status === 'rejected' ? '中途停止' : '在替换前完成'}）`);
    }

    // 发放绑定恢复代数：发放途中发生全量恢复（推进代数，持恢复排他锁），即使轮次数据看起来没变也整次停止
    {
      const ev = await createGalaEvent(db, { title: `${PREFIX} 恢复代数`, totalBudget: 0 });
      const p = await createGalaPool(db, { eventId: ev.id, name: '池', budget: 1000 });
      await addGalaParticipants(db, { eventId: ev.id, userids: Array.from({ length: 20 }, (_, k) => uid(k + 1)) });
      const d = await drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: 10, prizeType: 'coin', poolId: p.id, amountEach: 1 });
      const [g, restore] = await Promise.allSettled([
        grantRound(db, d.round.id, serializeDrawResult(d).grant_token),
        (async () => {
          await new Promise((r) => setTimeout(r, 5));
          // 与全量恢复相同的加锁顺序：恢复排他锁 → 推进代数 → 锁流水表和中奖记录表
          await db.transaction(async (tx) => {
            await tx.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [GALA_PAYOUT_LOCK]);
            await bumpGalaRestoreGeneration(tx);
            await tx.exec('LOCK TABLE ledger, gala_round_winners IN SHARE ROW EXCLUSIVE MODE');
          });
        })(),
      ]);
      assert.equal(restore.status, 'fulfilled', String(restore.reason));
      if (g.status === 'rejected') assert.equal(g.reason?.code, 'round_changed', String(g.reason));
      const errs = await db.get('SELECT COUNT(*) AS n FROM gala_round_winners WHERE round_id = ? AND award_error IS NOT NULL', [d.round.id]);
      assert.equal(Number(errs.n), 0);
      const r1 = await db.get('SELECT status FROM gala_rounds WHERE id = ?', [d.round.id]);
      if (g.status === 'rejected') assert.equal(r1.status, 'drawn', '中途停止的发放不应标记整轮完成');
      await grantRound(db, d.round.id);
      const paid = await db.get('SELECT COUNT(*) AS n FROM gala_round_winners WHERE round_id = ? AND awarded_at IS NOT NULL', [d.round.id]);
      assert.equal(Number(paid.n), 10);
      const pool = await db.get('SELECT spent FROM gala_pools WHERE id = ?', [p.id]);
      assert.equal(Number(pool.spent), 10);
      console.log(`✓ 发放绑定恢复代数，与恢复加锁顺序一致不死锁（本次${g.status === 'rejected' ? '中途停止' : '在恢复前完成'}）`);
    }

    // 发放凭据：恢复前页面拿到的凭据在恢复后作废（即使请求在恢复持锁时排队、恢复后才开始），不会付给恢复后同 ID 的轮次
    {
      const ev = await createGalaEvent(db, { title: `${PREFIX} 发放凭据`, totalBudget: 0 });
      const p = await createGalaPool(db, { eventId: ev.id, name: '池', budget: 100 });
      await addGalaParticipants(db, { eventId: ev.id, userids: Array.from({ length: 12 }, (_, k) => uid(k + 1)) });
      const d = await drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: 2, prizeType: 'coin', poolId: p.id, amountEach: 3 });
      const listed = (await listGalaRounds(db, { eventId: ev.id })).find((r) => r.id === Number(d.round.id));
      assert.equal(listed.grant_token, serializeDrawResult(d).grant_token, '列表与抽签结果给出同一凭据');
      await assert.rejects(grantGalaRound(db, { roundId: d.round.id }), (e) => e.code === 'invalid_grant_token');
      await assert.rejects(grantGalaRound(db, { roundId: d.round.id, grantToken: listed.grant_token.replace(/\.\d+$/, '.999999') }), (e) => e.code === 'invalid_grant_token');
      await assert.rejects(grantGalaRound(db, { roundId: d.round.id, grantToken: 12 }), (e) => e.code === 'invalid_grant_token');
      // 恢复先拿到排他锁，发放请求排队；恢复提交（代数 +1）后请求才开始
      let release;
      const holding = new Promise((r) => { release = r; });
      const restore = db.transaction(async (tx) => {
        await tx.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [GALA_PAYOUT_LOCK]);
        await bumpGalaRestoreGeneration(tx);
        await holding;
      });
      await new Promise((r) => setTimeout(r, 30));
      const queued = grantGalaRound(db, { roundId: d.round.id, grantToken: listed.grant_token });
      await new Promise((r) => setTimeout(r, 30));
      release();
      await restore;
      await assert.rejects(queued, (e) => e.code === 'round_changed');
      const paid = await db.get('SELECT COUNT(*) AS n FROM gala_round_winners WHERE round_id = ? AND awarded_at IS NOT NULL', [d.round.id]);
      assert.equal(Number(paid.n), 0, '旧凭据不发任何一笔');
      const fresh = (await listGalaRounds(db, { eventId: ev.id })).find((r) => r.id === Number(d.round.id));
      assert.notEqual(fresh.grant_token, listed.grant_token);
      const ok = await grantGalaRound(db, { roundId: d.round.id, grantToken: fresh.grant_token });
      assert.equal(ok.granted.length, 2);
      console.log('✓ 发放凭据绑定操作者看到的轮次，恢复后旧凭据作废');
    }

    // 预留名额遵守本环节排除规则、每场活动有上限；单人发币轮的员工预算准入与预留无关
    {
      const ev = await createGalaEvent(db, { title: `${PREFIX} 预留规则`, totalBudget: 0 });
      const empty = await createGalaPool(db, { eventId: ev.id, name: '空池', budget: 0 });
      const rp = await createGalaPool(db, { eventId: ev.id, name: '预留池', budget: 100, reserved: true });
      // 分两次导入，保证 uid(1) 在名单里排第一（FIRST 依赖名单顺序）
      await addGalaParticipants(db, { eventId: ev.id, userids: [uid(1)] });
      await addGalaParticipants(db, { eventId: ev.id, userids: [uid(2)] });
      await addFiller(db, ev.id);
      await createGalaReservedSlot(db, { eventId: ev.id, segment: 'giveaway', roundNo: 1, userid: uid(3), poolId: rp.id });
      // 员工奖池为 0：本轮唯一名额是预留，但准入仍按 1 × 5 检查员工奖池，和没有预留时一样被拒
      await assert.rejects(
        drawGalaRound(db, { eventId: ev.id, segment: 'giveaway', drawCount: 1, prizeType: 'coin', poolId: empty.id, amountEach: 5 }),
        (e) => e.code === 'pool_budget_insufficient' && e.remaining === 0 && e.required === 5,
      );
      const w = await drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: 1, randomInt: FIRST });
      assert.equal(w.winners[0].userid, uid(1));
      await assert.rejects(
        addSlot(db, { eventId: ev.id, segment: 'lottery', roundNo: 3, userid: uid(1) }),
        (e) => e.code === 'already_won_in_segment',
      );
      await assert.rejects(
        addSlot(db, { eventId: ev.id, segment: 'giveaway', roundNo: 4, userid: uid(3) }),
        (e) => e.code === 'already_won_in_segment',
        '同一人在同一环节只能有一个未取消的名额',
      );
      // 绕过创建校验（如旧数据）塞进一个与已中奖者冲突的名额：抽签时按排除规则作废，名额照常由普通人填满
      await db.run(
        `INSERT INTO gala_reserved_slots(event_id, segment, round_no, userid, amount) VALUES(?, 'lottery', 2, ?, 0)`,
        [ev.id, uid(1)],
      );
      const w2 = await drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: 1, randomInt: FIRST });
      assert.equal(w2.winners.length, 1);
      assert.notEqual(w2.winners[0].userid, uid(1), '开启排除时已中奖者不会经预留名额再次中奖');
      const voided = await db.get(`SELECT status FROM gala_reserved_slots WHERE event_id = ? AND segment = 'lottery' AND round_no = 2`, [ev.id]);
      assert.equal(voided.status, 'cancelled');
      // 轮次号不连续（如恢复的数据有第 1、2、5 轮）：不大于最大已抽轮次的名额永远用不到，直接拒绝
      await db.run(`INSERT INTO gala_rounds(event_id, segment, round_no, draw_count) VALUES(?, 'lottery', 5, 1)`, [ev.id]);
      await assert.rejects(
        addSlot(db, { eventId: ev.id, segment: 'lottery', roundNo: 3, userid: uid(6) }),
        (e) => e.code === 'round_already_drawn',
      );
      await addSlot(db, { eventId: ev.id, segment: 'game', roundNo: 1, userid: uid(4) });
      await addSlot(db, { eventId: ev.id, segment: 'quiz', roundNo: 1, userid: uid(5) });
      await assert.rejects(
        addSlot(db, { eventId: ev.id, segment: 'song', roundNo: 1, userid: uid(6) }),
        (e) => e.code === 'reserved_slot_limit',
      );
      console.log('✓ 预留名额遵守排除规则、有数量上限；员工预算准入不随预留变化');
    }

    // 预留奖励与本轮一致：无币轮不发币；预留奖池付不起本轮单价时名额作废、按普通抽签进行；名额必须指定预留奖池
    {
      const ev = await createGalaEvent(db, { title: `${PREFIX} 奖励一致`, totalBudget: 0 });
      const ep = await createGalaPool(db, { eventId: ev.id, name: '员工池', budget: 1000 });
      const rp = await createGalaPool(db, { eventId: ev.id, name: '预留池', budget: 7, reserved: true });
      await addGalaParticipants(db, { eventId: ev.id, userids: [uid(1), uid(2), uid(3)] });
      await addFiller(db, ev.id);
      await assert.rejects(
        createGalaReservedSlot(db, { eventId: ev.id, segment: 'lottery', roundNo: 1, userid: uid(1) }),
        (e) => e.code === 'reserved_pool_required',
      );
      await createGalaReservedSlot(db, { eventId: ev.id, segment: 'lottery', roundNo: 1, userid: uid(1), poolId: rp.id });
      await createGalaReservedSlot(db, { eventId: ev.id, segment: 'giveaway', roundNo: 1, userid: uid(2), poolId: rp.id });
      const none = await drawGalaRound(db, { eventId: ev.id, segment: 'lottery', drawCount: 2 });
      const kidNone = none.winners.find((w) => w.userid === uid(1));
      assert.ok(kidNone && Number(kidNone.amount) === 0 && kidNone.pool_id == null, '无币轮预留对象同样没有奖励');
      // 本轮单价 8，预留池只有 7：名额作废，本轮是普通抽签
      // FIRST 按名单顺序抽：uid(2) 的名额作废后不再被排除，和普通参与者一样能被抽中
      const big = await drawGalaRound(db, {
        eventId: ev.id, segment: 'giveaway', drawCount: 2, prizeType: 'coin', poolId: ep.id, amountEach: 8, randomInt: FIRST,
      });
      assert.ok(big.winners.every((w) => Number(w.is_reserved) === 0 && Number(w.amount) === 8));
      assert.ok(big.winners.some((w) => w.userid === uid(2)), '作废名额的人重新进入普通候选');
      const slot2 = await db.get('SELECT status, note FROM gala_reserved_slots WHERE event_id = ? AND segment = ?', [ev.id, 'giveaway']);
      assert.equal(slot2.status, 'cancelled');
      assert.ok(String(slot2.note).includes('预留奖池余额不足'));
      // 预留奖池不能把预算压到已支出 + 待发预留奖励以下
      const rp2 = await createGalaPool(db, { eventId: ev.id, name: '预留池2', budget: 50, reserved: true });
      await createGalaReservedSlot(db, { eventId: ev.id, segment: 'game', roundNo: 1, userid: uid(3), poolId: rp2.id });
      await drawGalaRound(db, { eventId: ev.id, segment: 'game', drawCount: 1, prizeType: 'coin', poolId: ep.id, amountEach: 30 });
      await assert.rejects(
        updateGalaPool(db, { poolId: rp2.id, budget: 29, allowReserved: true }),
        (e) => e.code === 'budget_below_spent' && e.spent === 30,
      );
      await updateGalaPool(db, { poolId: rp2.id, budget: 30, allowReserved: true });
      console.log('✓ 预留奖励与本轮普通奖励一致；预留奖池不足时名额作废；预留预算不低于待发');
    }

    // 参数严格校验：布尔、数组、超出 INTEGER 的值不会被隐式转换
    {
      await assert.rejects(grantGalaRound(db, { roundId: true }), (e) => e.code === 'invalid_round_id');
      await assert.rejects(grantGalaRound(db, { roundId: [1] }), (e) => e.code === 'invalid_round_id');
      await assert.rejects(drawGalaRound(db, { eventId: event.id, segment: 'lottery', drawCount: true }), (e) => e.code === 'invalid_draw_count');
      await assert.rejects(
        addSlot(db, { eventId: event.id, segment: 'lottery', roundNo: 2147483648, userid: kid }),
        (e) => e.code === 'invalid_round_no',
      );
      await assert.rejects(
        addGalaParticipants(db, { eventId: event.id, userids: [uid(1)], tableNo: true }),
        (e) => e.code === 'invalid_table_no',
      );
      // userid 原样比较：前缀相同的另一个 userid 不会被误删，超长的直接拒绝
      {
        const longId = `${uid(1)}${'x'.repeat(200)}`;
        await db.run('INSERT INTO users(userid, name) VALUES(?, ?) ON CONFLICT DO NOTHING', [longId, 'long']);
        const evU = await createGalaEvent(db, { title: `${PREFIX} 长ID` });
        await addGalaParticipants(db, { eventId: evU.id, userids: [uid(1), longId] });
        await removeGalaParticipant(db, { eventId: evU.id, userid: longId });
        const left = (await listGalaParticipants(db, { eventId: evU.id })).map((p) => p.userid);
        assert.deepEqual(left, [uid(1)], '只删掉完全匹配的那个人');
        await assert.rejects(removeGalaParticipant(db, { eventId: evU.id, userid: 'y'.repeat(600) }), (e) => e.code === 'invalid_userid');
        await db.run('DELETE FROM users WHERE userid = ?', [longId]);
      }
      console.log('✓ ID 与整数参数只接受数字或十进制字符串');
      // 活动列表按 id 倒序分页
      const e1 = await createGalaEvent(db, { title: `${PREFIX} 分页1` });
      const e2 = await createGalaEvent(db, { title: `${PREFIX} 分页2` });
      const page1 = await listGalaEvents(db, { limit: 1 });
      assert.equal(page1.length, 1);
      assert.equal(page1[0].id, e2.id);
      const page2 = await listGalaEvents(db, { limit: 1, beforeId: e2.id });
      assert.equal(page2[0].id, e1.id);
      await assert.rejects(listGalaEvents(db, { beforeId: 'x' }), (e) => e.code === 'invalid_before_id');
      await assert.rejects(listGalaEvents(db, { limit: 0 }), (e) => e.code === 'invalid_limit');
      console.log('✓ 活动列表可按游标翻页');
    }


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
      // 活动范围内的写接口必须带回读到的数据版本
      const gv = (await call(operatorId, 'GET', `/gala/events/detail?id=${hid}`)).body.data.gala_version;
      assert.match(String(gv), /^\d+$/);
      assert.equal((await call(operatorId, 'GET', '/gala/events')).body.data.find((e) => e.id === hid).gala_version, gv);
      r = await call(superId, 'POST', '/gala/pools/create', { event_id: hid, name: '无版本', budget: 1 });
      assert.deepEqual([r.status, r.body?.error], [400, 'invalid_gala_version']);
      r = await call(superId, 'POST', '/gala/pools/create', { gala_version: `${Number(gv) + 1}`, event_id: hid, name: '旧版本', budget: 1 });
      assert.deepEqual([r.status, r.body?.error], [409, 'gala_data_changed'], '版本与当前数据不符时拒绝写入');
      r = await call(operatorId, 'POST', '/gala/reserved/pools/create', { gala_version: gv, event_id: hid, name: 'x', budget: 10 });
      assert.equal(r.status, 403, '运营管理员不能创建预留奖池');
      r = await call(operatorId, 'GET', `/gala/reserved?event_id=${hid}`);
      assert.equal(r.status, 403, '运营管理员看不到预留名额');
      r = await call(superId, 'POST', '/gala/reserved/pools/create', { gala_version: gv, event_id: hid, name: '预留', budget: 50 });
      assert.equal(r.status, 200);
      const rp = r.body.data.id;
      r = await call(superId, 'POST', '/gala/reserved/create', { gala_version: gv,
        event_id: hid, segment: 'lottery', round_no: 1, userid: kid, pool_id: rp,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      r = await call(operatorId, 'POST', '/gala/participants/add', { gala_version: gv, event_id: hid, userids: [uid(3), uid(4), uid(5)] });
      assert.equal(r.status, 200);
      await addFiller(db, hid);
      // 活动列表经 HTTP 路由（含分页参数）
      r = await call(operatorId, 'GET', '/gala/events');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data[0].id, hid);
      r = await call(operatorId, 'GET', `/gala/events?limit=1&before_id=${hid}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.data.length === 1 && r.body.data[0].id < hid);
      r = await call(operatorId, 'GET', '/gala/events?limit=abc');
      assert.deepEqual([r.status, r.body?.error], [400, 'invalid_limit']);
      // 显式传了无效的奖品类型（空串、false、0）不会被当成无币轮
      for (const bad of ['', false, 0]) {
        // eslint-disable-next-line no-await-in-loop
        r = await call(operatorId, 'POST', '/gala/rounds/draw', { gala_version: gv, event_id: hid, segment: 'lottery', draw_count: 1, prize_type: bad });
        assert.deepEqual([r.status, r.body?.error], [400, 'invalid_prize_type'], JSON.stringify(bad));
      }
      r = await call(superId, 'POST', '/gala/pools/create', { gala_version: gv, event_id: hid, name: '员工池', budget: 1000 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const hPool = r.body.data.id;
      r = await call(operatorId, 'POST', '/gala/rounds/draw', { gala_version: gv,
        event_id: hid, segment: 'lottery', draw_count: 2, prize_type: 'coin', pool_id: hPool, amount_each: 50,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.winners.length, 2, '预留对象占本轮名额：抽 2 人出 2 人');
      assert.equal(r.body.data.draw_count, 2);
      assert.ok(r.body.data.winners.some((w) => w.userid === kid));
      const listed = await call(operatorId, 'GET', `/gala/participants?event_id=${hid}`);
      const listedIds = new Set(listed.body.data.map((x) => x.userid));
      assert.ok(r.body.data.winners.every((w) => listedIds.has(w.userid)), '每个中奖人都在参与名单上');
      assert.ok(listed.body.data.every((x) => !('is_reserved' in x)), '运营管理员的参与名单不含预留标记');
      const hd = await call(operatorId, 'GET', `/gala/events/detail?id=${hid}`);
      assert.equal(hd.body.data.participant_count, listed.body.data.length);
      assert.ok(!('eligible_count' in r.body.data), '非超管看不到排除预留后的候选人数');
      const PAYOUT_KEYS = ['is_reserved', 'pool_id', 'amount', 'awarded', 'awarded_at', 'award_error'];
      const noPayout = (w) => PAYOUT_KEYS.every((k) => !(k in w));
      assert.ok(r.body.data.winners.every(noPayout), '运营管理员的抽签返回不含逐人发放信息');
      r = await call(operatorId, 'GET', `/gala/events/detail?id=${hid}`);
      assert.deepEqual(r.body.data.pools.map((p) => p.id), [hPool], '运营管理员只看到员工奖池，看不到预留奖池');
      r = await call(superId, 'GET', `/gala/rounds?event_id=${hid}`);
      assert.equal(r.body.data[0].winners.filter((w) => w.is_reserved === 1).length, 1);
      const hRound = r.body.data[0].id;
      r = await call(operatorId, 'POST', '/gala/rounds/grant', { round_id: true });
      assert.deepEqual([r.status, r.body?.error], [400, 'invalid_round_id'], '布尔 round_id 不会被当成 1');
      r = await call(operatorId, 'POST', '/gala/rounds/grant', { round_id: hRound });
      assert.deepEqual([r.status, r.body?.error], [400, 'invalid_grant_token'], '发币必须带轮次凭据');
      const hToken = (await call(operatorId, 'GET', `/gala/rounds?event_id=${hid}`)).body.data[0].grant_token;
      r = await call(operatorId, 'POST', '/gala/rounds/grant', { round_id: hRound, grant_token: hToken });
      assert.equal(r.status, 200);
      assert.deepEqual(
        r.body.data,
        { round_id: hRound, failed_count: 0, failed_reasons: {}, pending: 0 },
        '非超管的发放回执只有汇总，不列逐人名单、不含余额',
      );
      assert.equal(await balanceOf(db, kid), 20 + 50, '预留奖励照常发放，金额与本轮单价一致');
      r = await call(operatorId, 'GET', `/gala/rounds?event_id=${hid}`);
      assert.ok(r.body.data[0].winners.every(noPayout), '运营管理员的轮次列表不含逐人发放信息');
      assert.equal(r.body.data[0].draw_count, 2);
      assert.equal(r.body.data[0].status, 'granted', '全部奖励到账后整轮为 granted');
      r = await call(superId, 'GET', `/gala/rounds?event_id=${hid}`);
      assert.equal(r.body.data[0].status, 'granted');
      assert.equal(r.body.data[0].winners.find((w) => w.is_reserved === 1).awarded, 1);
      assert.ok(!JSON.stringify(r.body).includes('balance'), '轮次接口不返回余额');
      // 流水查询端：年会发放流水只给超管；非超管看不到任何人的，审计推断也不会带出
      const isGalaW = (row) => String(row.ref_id || '').startsWith('GALA_W');
      r = await call(operatorId, 'GET', `/users/${encodeURIComponent(kid)}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.ledger.filter(isGalaW).length, 0, '非超管的用户流水里没有预留发放');
      r = await call(superId, 'GET', `/users/${encodeURIComponent(kid)}`);
      assert.equal(r.body.data.ledger.filter(isGalaW).length, 2, '超管能看到两笔预留发放');
      // 取流水仍在的普通中奖人（前面的测试重置过部分用户，他们的发放流水已被合法清除）
      const ordinaryWinner = (await db.get(
        `SELECT w.userid FROM gala_round_winners w JOIN ledger l ON l.id = w.ledger_id
          WHERE w.round_id = ? AND w.is_reserved = 0 ORDER BY w.id LIMIT 1`,
        [r2.round.id],
      )).userid;
      // 只藏预留那一笔会让预留对象成为“唯一没有发放流水的中奖人”，所以非超管对所有中奖人都看不到年会发放流水
      r = await call(operatorId, 'GET', `/users/${encodeURIComponent(ordinaryWinner)}`);
      assert.equal(r.body.data.ledger.filter(isGalaW).length, 0, '非超管看普通中奖人同样没有年会发放流水');
      r = await call(superId, 'GET', `/users/${encodeURIComponent(ordinaryWinner)}`);
      assert.ok(r.body.data.ledger.some(isGalaW), '超管能看到普通中奖人的发放流水');
      // 判定要求 ref_id、原因、入账方向都符合：ref_id 恰好像 GALA_W… 的普通流水照常可见
      const fake = await db.get(
        'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?) RETURNING id',
        [ordinaryWinner, 1, '年会奖励·外部', 'GALA_W999999999'],
      );
      r = await call(operatorId, 'GET', `/users/${encodeURIComponent(ordinaryWinner)}`);
      assert.equal(r.body.data.ledger.filter(isGalaW).length, 1, '没有中奖记录引用的流水不被当作年会发放隐藏');
      await db.run('DELETE FROM ledger WHERE id = ?', [fake.id]);
      console.log('✓ HTTP：预留接口仅超管可用，非超管返回中不暴露预留信息');
    } finally {
      server.close();
    }

    await realRestoreChecks(cfg);
    console.log('ALL GALA INTEGRATION CHECKS PASSED');
  } finally {
    await cleanup(db);
    await db.close();
  }
}

// 真实全量恢复路径：在一次性数据库里走导入路由（全表锁、锁超时重试、序列重置、导入后核对、恢复点），
// 不碰共享开发库的数据。没有建库权限时跳过并说明。
async function realRestoreChecks(cfg) {
  const tmpName = `${cfg.db.database}_gala_rt_${process.pid}`;
  const admin = new Client({ host: cfg.db.host, port: cfg.db.port, database: cfg.db.database, user: cfg.db.user, password: cfg.db.password });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${tmpName}"`);
  } catch (err) {
    await admin.end();
    console.log(`- 跳过真实全量恢复检查：无法创建一次性数据库（${err?.code || err?.message}）`);
    return;
  }
  const backupDir = mkdtempSync(path.join(os.tmpdir(), 'gala-rt-'));
  const prevBackupDir = process.env.BOB_BACKUP_DIR;
  process.env.BOB_BACKUP_DIR = backupDir;
  let tdb = null;
  let server = null;
  try {
    tdb = await initDb({ db: { ...cfg.db, kind: 'postgres', database: tmpName } });
    const superId = 'rt_super';
    const tcfg = { ...cfg, adminUserids: [superId] };
    const users = Array.from({ length: 12 }, (_, i) => `rt_u${i + 1}`);
    for (const u of users) {
      // eslint-disable-next-line no-await-in-loop
      await tdb.run('INSERT INTO users(userid, name) VALUES(?, ?)', [u, u]);
      // eslint-disable-next-line no-await-in-loop
      await tdb.run('INSERT INTO accounts(userid, balance) VALUES(?, 0)', [u]);
    }
    const ev = await createGalaEvent(tdb, { title: 'RT', totalBudget: 0 });
    const pool = await createGalaPool(tdb, { eventId: ev.id, name: '池', budget: 100 });
    await addGalaParticipants(tdb, { eventId: ev.id, userids: users });
    const r1 = await drawGalaRound(tdb, { eventId: ev.id, segment: 'lottery', drawCount: 2, prizeType: 'coin', poolId: pool.id, amountEach: 5 });

    const app = createApp({ db: tdb, cfg: tcfg });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookie = `bob_admin_session=${createSessionToken(adminSessionSigningSecret(tcfg), { userid: superId, name: superId })}`;
    const call = async (method, p, body) => {
      const res = await fetch(`${base}/admin${p}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const generation = async () => String((await tdb.get('SELECT generation FROM gala_restore_state WHERE id = 1')).generation);
    const ledgerSeq = async () => tdb.get('SELECT last_value, is_called FROM ledger_id_seq');

    let r = await call('GET', '/backup/export?mode=full');
    assert.equal(r.status, 200);
    const b0 = r.body; // r1 待发
    // 覆盖前最后一笔已提交的奖励：r1 发放到账
    let rounds = (await call('GET', `/gala/rounds?event_id=${ev.id}`)).body.data;
    const oldToken = rounds.find((x) => x.id === Number(r1.round.id)).grant_token;
    r = await call('POST', '/gala/rounds/grant', { round_id: Number(r1.round.id), grant_token: oldToken });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const paidIds = (await tdb.all('SELECT id, ledger_id FROM gala_round_winners WHERE round_id = ? AND awarded_at IS NOT NULL', [r1.round.id]));
    assert.equal(paidIds.length, 2);
    const oldVersion = (await call('GET', `/gala/events/detail?id=${ev.id}`)).body.data.gala_version;
    const genBefore = await generation();

    // 1) 成功的覆盖恢复：恢复点里有恢复前刚到账的奖励；恢复后旧凭据、旧版本作废
    r = await call('POST', '/backup/import', { backup: b0, mode: 'overwrite' });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.equal(await generation(), String(Number(genBefore) + 1));
    const rp = JSON.parse(readFileSync(path.join(backupDir, r.body.recoveryPoint.filename), 'utf8'));
    const rpWinners = rp.data.gala_round_winners.filter((w) => Number(w.round_id) === Number(r1.round.id));
    assert.ok(rpWinners.every((w) => w.awarded_at != null && w.ledger_id != null), '恢复点包含覆盖前最后一笔已到账的奖励');
    assert.ok(paidIds.every((w) => rp.data.ledger.some((l) => Number(l.id) === Number(w.ledger_id))), '恢复点包含对应流水');
    r = await call('POST', '/gala/rounds/grant', { round_id: Number(r1.round.id), grant_token: oldToken });
    assert.deepEqual([r.status, r.body?.error], [409, 'round_changed'], '恢复前的发放凭据在恢复后作废');
    r = await call('POST', '/gala/pools/create', { gala_version: oldVersion, event_id: ev.id, name: '旧页面', budget: 1 });
    assert.deepEqual([r.status, r.body?.error], [409, 'gala_data_changed'], '恢复前的数据版本在恢复后作废');
    const paidAfter = await tdb.get('SELECT COUNT(*) AS n FROM gala_round_winners WHERE round_id = ? AND awarded_at IS NOT NULL', [r1.round.id]);
    assert.equal(Number(paidAfter.n), 0, '旧凭据没有发出任何一笔');

    // 2) 导入后置核对失败（合并库里已有付给待发中奖记录的流水）：数据、代数、下一笔流水 ID 都不变
    const pend = await tdb.get('SELECT id, userid, amount FROM gala_round_winners WHERE round_id = ? AND awarded_at IS NULL ORDER BY id LIMIT 1', [r1.round.id]);
    const now = Math.floor(Date.now() / 1000);
    const bad = structuredClone(b0);
    for (const k of Object.keys(bad.data)) {
      if (!['ledger', 'gala_events', 'gala_pools', 'gala_participants', 'gala_rounds', 'gala_round_winners', 'gala_reserved_slots'].includes(k)) delete bad.data[k];
    }
    bad.data.ledger = [{ id: 7900000000000001, userid: pend.userid, delta: Number(pend.amount), reason: '年会奖励·抽奖·第1轮', ref_id: `GALA_W${pend.id}`, created_at: now + 10 }];
    bad.data.gala_events = [{ ...b0.data.gala_events[0], id: 990001, title: 'RT 合并' }];
    bad.data.gala_pools = [{ ...b0.data.gala_pools[0], id: 990001, event_id: 990001, budget: 10, spent: 10 }];
    bad.data.gala_participants = [];
    bad.data.gala_rounds = [{ ...b0.data.gala_rounds[0], id: 990001, event_id: 990001, pool_id: 990001, amount_each: 10, draw_count: 1, status: 'granted', granted_at: now }];
    bad.data.gala_round_winners = [{ ...b0.data.gala_round_winners[0], id: 990001, round_id: 990001, event_id: 990001, userid: users[0], pool_id: 990001, amount: 10, is_reserved: 0, awarded_at: now, ledger_id: 8000000000000000, award_error: null }];
    bad.data.gala_reserved_slots = [];
    const snapshot = async () => ({
      generation: await generation(),
      seq: await ledgerSeq(),
      ledger: await tdb.all('SELECT id, userid, delta, ref_id FROM ledger ORDER BY id'),
      winners: await tdb.all('SELECT id, awarded_at, ledger_id FROM gala_round_winners ORDER BY id'),
      events: await tdb.all('SELECT id FROM gala_events ORDER BY id'),
    });
    const before = await snapshot();
    r = await call('POST', '/backup/import', { backup: bad, mode: 'merge' });
    assert.notEqual(r.status, 200);
    assert.ok(JSON.stringify(r.body).includes('已有它的发放流水'), JSON.stringify(r.body).slice(0, 300));
    assert.deepEqual(await snapshot(), before, '被拒绝的导入不改变数据、恢复代数和流水序号');
    console.log('✓ 真实全量恢复：恢复点含最后一笔已到账奖励，旧凭据/旧版本作废，后置核对失败时一切不变');
  } finally {
    if (server) server.close();
    if (tdb) await tdb.close();
    if (prevBackupDir === undefined) delete process.env.BOB_BACKUP_DIR;
    else process.env.BOB_BACKUP_DIR = prevBackupDir;
    rmSync(backupDir, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS "${tmpName}" WITH (FORCE)`).catch(() => null);
    await admin.end();
  }
}

main()
  .then(() => process.exit(0)) // createApp 会拉起后台定时任务，显式退出
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
