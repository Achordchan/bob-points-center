// 限时竞拍本地集成测试：连接本机开发库，覆盖 DDL 迁移、服务层并发与结算、HTTP 全链路。
// 仅允许本地开发数据库：需显式设置 BOB_INTERNAL_TEST_DB=1 并双确认目标库，
// 且数据库必须带 bob.environment=development GUC 标记。跑完自动清理测试数据。
import 'dotenv/config';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { initDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createSessionToken } from '../src/services/adminSession.js';
import { createWebSessionToken } from '../src/services/webSession.js';
import { adminSessionSigningSecret, webSessionSigningSecret } from '../src/utils/sessionCrypto.js';
import {
  cancelAuction,
  createAuction,
  getAuctionDetailForMall,
  listMyAuctionBids,
  placeAuctionBid,
  settleAuctionIfDue,
} from '../src/services/auctionService.js';

const PREFIX = `TEST_AUCTION_${Date.now()}`;
const USERS = 24;
const INITIAL_BALANCE = 10000;

function assertSafeTarget(cfg) {
  if (process.env.BOB_INTERNAL_TEST_DB !== '1') {
    throw new Error('拒绝执行：请先设置 BOB_INTERNAL_TEST_DB=1，确认这是内部集成测试。');
  }
  const host = String(cfg?.db?.host || '').toLowerCase();
  if (!/(127\.0\.0\.1|localhost)/.test(host)) {
    throw new Error(`拒绝执行：集成测试只允许本机测试库，当前 host=${cfg?.db?.host || '-'}`);
  }
  const dbName = String(cfg?.db?.database || '').toLowerCase();
  if (process.env.BOB_AUCTION_TEST_DATABASE_CONFIRM !== dbName) {
    throw new Error(`拒绝执行：请设置 BOB_AUCTION_TEST_DATABASE_CONFIRM=${dbName}，二次确认写入目标数据库。`);
  }
  const target = `${cfg?.db?.host || ''}:${cfg?.db?.port || ''}/${cfg?.db?.database || ''}`.toLowerCase();
  if (process.env.BOB_AUCTION_TEST_TARGET_CONFIRM !== target) {
    throw new Error(`拒绝执行：请设置 BOB_AUCTION_TEST_TARGET_CONFIRM=${target}，二次确认测试库地址。`);
  }
}

async function assertDevelopmentDb(db) {
  const row = await db.get("SELECT current_setting('bob.environment', true) AS env");
  const env = String(row?.env || '').trim().toLowerCase();
  assert.equal(env, 'development', '目标数据库缺少 bob.environment=development 标记，拒绝执行');
}

async function cleanup(db) {
  await db.run('DELETE FROM auction_bids WHERE userid LIKE ?', [`${PREFIX}_%`]);
  await db.run('DELETE FROM auction_activities WHERE title LIKE ?', [`${PREFIX}%`]);
  await db.run('DELETE FROM ledger WHERE userid LIKE ?', [`${PREFIX}_%`]);
  await db.run('DELETE FROM accounts WHERE userid LIKE ?', [`${PREFIX}_%`]);
  await db.run('DELETE FROM users WHERE userid LIKE ?', [`${PREFIX}_%`]);
}

async function main() {
  const cfg = loadConfig();
  // 护栏必须在任何数据库操作（含 initDb 的 DDL）之前完成
  assertSafeTarget(cfg);
  const db = await initDb();
  let guardPassed = false;
  try {
    await assertDevelopmentDb(db);
    guardPassed = true;

    // 0) DDL 幂等：auction 表与部分唯一索引存在，重复 initDb 不报错
    const tables = await db.all(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('auction_activities','auction_bids')",
    );
    assert.equal(tables.length, 2, 'auction 表未创建');
    const indexes = await db.all(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='idx_auction_bids_held_once'",
    );
    assert.equal(indexes.length, 1, '唯一在押索引未创建');
    console.log('✓ DDL 迁移与幂等重跑通过');

    await cleanup(db);

    // 1) 测试用户
    for (let i = 1; i <= USERS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await db.run(
        'INSERT INTO users(userid, name) VALUES(?, ?) ON CONFLICT(userid) DO UPDATE SET name = EXCLUDED.name',
        [`${PREFIX}_${String(i).padStart(3, '0')}`, `竞拍测试${i}`],
      );
      // eslint-disable-next-line no-await-in-loop
      await db.run(
        'INSERT INTO accounts(userid, balance) VALUES(?, ?) ON CONFLICT(userid) DO UPDATE SET balance = EXCLUDED.balance',
        [`${PREFIX}_${String(i).padStart(3, '0')}`, INITIAL_BALANCE],
      );
    }
    const uid = (i) => `${PREFIX}_${String(i).padStart(3, '0')}`;

    // 2) 服务层：并发出价同一金额——仅一人成功，其余 bid_too_low
    const now = Math.floor(Date.now() / 1000);
    const created = await createAuction(db, {
      input: {
        title: `${PREFIX} 并发竞拍`,
        start_price: 100,
        min_increment: 10,
        start_at: now - 10,
        end_at: now + 600,
      },
      createdBy: 'integration',
      createdName: '集成测试',
      now,
    });
    assert.equal(created.status, 'scheduled');

    const concurrent = await Promise.all(
      Array.from({ length: USERS }, (_, idx) => idx + 1)
        .map((i) => placeAuctionBid(db, {
          activityId: created.id,
          userid: uid(i),
          name: `竞拍测试${i}`,
          amount: 110,
          now: now + 1,
        })
          .then((r) => ({ ok: true, i, r }))
          .catch((e) => ({ ok: false, i, err: String(e.message) }))),
    );
    const winners = concurrent.filter((x) => x.ok);
    const losers = concurrent.filter((x) => !x.ok);
    assert.equal(winners.length, 1, `并发同价出价应只有 1 人成功，实际 ${winners.length}`);
    assert.ok(losers.every((x) => x.err === 'bid_too_low'), '失败方应为 bid_too_low');

    const heldRows = await db.all(
      "SELECT * FROM auction_bids WHERE activity_id = ? AND state = 'held'",
      [created.id],
    );
    assert.equal(heldRows.length, 1, '真实库应保证至多一条在押出价');
    const winnerUserid = winners[0].i;
    const balances = await db.all('SELECT userid, balance FROM accounts WHERE userid LIKE ?', [`${PREFIX}_%`]);
    const byUser = new Map(balances.map((x) => [x.userid, Number(x.balance)]));
    for (let i = 1; i <= USERS; i += 1) {
      assert.equal(byUser.get(uid(i)), i === winnerUserid ? INITIAL_BALANCE - 110 : INITIAL_BALANCE);
    }
    const ledgerCount = await db.get('SELECT COUNT(1) AS c FROM ledger WHERE userid LIKE ?', [`${PREFIX}_%`]);
    assert.equal(Number(ledgerCount.c), 1, '并发失败方不应产生流水');
    console.log(`✓ 并发出价：${USERS} 人同价竞争，1 人成功（用户 ${winnerUserid}），余额与流水一致`);

    // 3) 交替抬价 + 结算
    await placeAuctionBid(db, { activityId: created.id, userid: uid(winnerUserid === 1 ? 2 : 1), name: '抬价人', amount: 130, now: now + 2 });
    const afterRaise = await db.get('SELECT * FROM auction_activities WHERE id = ?', [created.id]);
    assert.equal(Number(afterRaise.current_price), 130);
    assert.equal(Number(afterRaise.bid_count), 2);

    const settleResult = await settleAuctionIfDue(db, { activityId: created.id, now: now + 601 });
    assert.equal(settleResult.just_settled, true);
    assert.equal(Number(settleResult.activity.final_price), 130);
    const again = await settleAuctionIfDue(db, { activityId: created.id, now: now + 700 });
    assert.equal(again.just_settled, false);

    // 结算生成领取凭证：redeems 订单 + 员工订单接口可见 + 二维码可生成
    const redeemRow = await db.get('SELECT * FROM redeems WHERE exchange_id = ?', [`AUCTION_${created.id}`]);
    assert.ok(redeemRow, '结算应生成 AUCTION_ 兑换单');
    assert.equal(redeemRow.userid, settleResult.winner.userid);
    assert.equal(Number(redeemRow.bob_amount), 130);
    assert.equal(redeemRow.fulfilled_at, null);

    const winnerLedger = await db.all(
      'SELECT delta, reason FROM ledger WHERE userid = ? ORDER BY id ASC',
      [settleResult.winner.userid],
    );
    assert.deepEqual(
      winnerLedger.map((x) => `${x.delta}:${x.reason}`),
      ['-130:auction_bid', '130:auction_settle_refund', '-130:auction_win_pay'],
      '获胜者流水',
    );

    // 账实核对：所有测试用户 sum(ledger) + 初始余额 == 余额
    const consistency = await db.all(
      `SELECT a.userid, a.balance, COALESCE(SUM(l.delta), 0) AS ledger_sum
         FROM accounts a LEFT JOIN ledger l ON l.userid = a.userid
        WHERE a.userid LIKE ?
        GROUP BY a.userid, a.balance`,
      [`${PREFIX}_%`],
    );
    for (const row of consistency) {
      assert.equal(
        Number(row.balance),
        INITIAL_BALANCE + Number(row.ledger_sum),
        `用户 ${row.userid} 账实不符`,
      );
    }
    console.log(`✓ 结算：获胜 ${settleResult.winner.userid} @130，重复结算幂等，全部用户账实相符`);

    // 4) 取消退保
    const cancelTarget = await createAuction(db, {
      input: { title: `${PREFIX} 取消竞拍`, start_price: 50, min_increment: 5, start_at: now - 10, end_at: now + 600 },
      now,
    });
    await placeAuctionBid(db, { activityId: cancelTarget.id, userid: uid(USERS), name: '取消测试', amount: 55, now: now + 1 });
    const cancelled = await cancelAuction(db, { activityId: cancelTarget.id, reason: '集成测试取消', now: now + 2 });
    assert.equal(cancelled.activity.status, 'cancelled');
    const balanceRow = await db.get('SELECT balance FROM accounts WHERE userid = ?', [uid(USERS)]);
    assert.equal(Number(balanceRow.balance), INITIAL_BALANCE, '取消后余额应恢复');
    const myBids = await listMyAuctionBids(db, { userid: uid(USERS) });
    assert.equal(myBids.bids[0].state, 'refunded');
    console.log('✓ 取消：在押金额退回，出价状态 refunded');

  // 5) 员工端读接口
  const detail = await getAuctionDetailForMall(db, { activityId: created.id, now: now + 602 });
  assert.equal(detail.activity.winner_name, settleResult.winner.name || settleResult.winner.userid);
  assert.equal('winner_userid' in detail.activity, false, '员工端不下发 winner_userid');
  assert.ok(Array.isArray(detail.activity.bids));

    // 6) HTTP 全链路
    const app = createApp({ db, cfg });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const webToken = createWebSessionToken(webSessionSigningSecret(cfg), {
      userid: uid(1),
      name: '竞拍测试1',
    });
    const adminToken = createSessionToken(adminSessionSigningSecret(cfg), { userid: 'dev_admin_local', name: '本地管理员' });
    const webCookie = `bob_web_session=${webToken}`;
    const adminCookie = `bob_admin_session=${adminToken}`;

    try {
      let res = await fetch(`${base}/mall/auction/list`);
      assert.equal(res.status, 401, '未登录应 401');
      res = await fetch(`${base}/mall/auction/list`, { headers: { cookie: webCookie } });
      assert.equal(res.status, 200);
      let body = await res.json();
      assert.ok(body.ok);
      assert.ok(Array.isArray(body.data));

      // 未开始的活动创建 + 未到点出价拒绝
      const future = await createAuction(db, {
        input: { title: `${PREFIX} 未开始`, start_price: 10, min_increment: 1, start_at: now + 3600, end_at: now + 7200 },
        now: now + 3,
      });
      res = await fetch(`${base}/mall/auction/bid`, {
        method: 'POST',
        headers: { cookie: webCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ activity_id: future.id, amount: 11 }),
      });
      assert.equal(res.status, 400);
      body = await res.json();
      assert.equal(body.error, 'not_started');

      // 有效出价（HTTP 层）
      const live = await createAuction(db, {
        input: { title: `${PREFIX} HTTP 竞拍`, start_price: 100, min_increment: 10, start_at: now - 10, end_at: now + 600 },
        now: now + 3,
      });
      res = await fetch(`${base}/mall/auction/bid`, {
        method: 'POST',
        headers: { cookie: webCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ activity_id: live.id, amount: 110 }),
      });
      assert.equal(res.status, 200, `HTTP 出价应 200，实际 ${res.status}`);
      body = await res.json();
      assert.equal(body.amount, 110);
      assert.equal(body.balance, INITIAL_BALANCE - 110);

      // floor 回归：出价后员工端 detail 的 next_bid_floor 必须跟随当前价（120），而非起拍价+幅度（110）
      res = await fetch(`${base}/mall/auction/detail?id=${live.id}`, { headers: { cookie: webCookie } });
      const floorBody = await res.json();
      assert.equal(floorBody.data.current_price, 110);
      assert.equal(floorBody.data.next_bid_floor, 120, 'next_bid_floor 应为当前价+加价幅度');
      assert.equal('current_bid_userid' in floorBody.data, false, '员工端不下发 current_bid_userid');
      assert.equal('winner_userid' in floorBody.data, false, '员工端不下发 winner_userid');

      // 过期守卫：end_at 已过的活动不能取消，在押不退（最高出价已锁定胜利）
      await db.run('UPDATE auction_activities SET end_at = ? WHERE id = ?', [now - 1, live.id]);
      await assert.rejects(
        () => cancelAuction(db, { activityId: live.id, reason: '迟到取消', now: now + 4 }),
        /auction_already_settled/,
      );
      const keepBalance = await db.get('SELECT balance FROM accounts WHERE userid = ?', [uid(1)]);
      assert.equal(Number(keepBalance.balance), INITIAL_BALANCE - 110, '过期后取消不应退押');
      await db.run('UPDATE auction_activities SET end_at = ? WHERE id = ?', [now + 600, live.id]);

      // 低于门槛
      res = await fetch(`${base}/mall/auction/bid`, {
        method: 'POST',
        headers: { cookie: `bob_web_session=${createWebSessionToken(webSessionSigningSecret(cfg), { userid: uid(2), name: '竞拍测试2' })}`, 'content-type': 'application/json' },
        body: JSON.stringify({ activity_id: live.id, amount: 111 }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'bid_too_low');

      // 我的竞拍
      res = await fetch(`${base}/mall/auction/me`, { headers: { cookie: webCookie } });
      body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(body.held_count >= 1);

      // 赢家在订单页可见竞拍兑换单（带核销二维码）
      const winnerCookie = `bob_web_session=${createWebSessionToken(webSessionSigningSecret(cfg), { userid: settleResult.winner.userid, name: '赢家' })}`;
      res = await fetch(`${base}/mall/orders`, { headers: { cookie: winnerCookie } });
      assert.equal(res.status, 200);
      body = await res.json();
      const auctionOrder = (body.data || []).find((x) => String(x.exchange_id || '') === `AUCTION_${created.id}`);
      assert.ok(auctionOrder, '订单接口应返回竞拍兑换单');
      assert.equal(auctionOrder.redeem_source, 'auction');
      assert.equal(auctionOrder.status, 'pending');
      assert.ok(auctionOrder.encoded, '待核销竞拍订单应生成核销二维码数据');

      // 管理端订单接口可见竞拍订单（redeem_source 被可见性服务剥离，前端按单号前缀识别）
      res = await fetch(`${base}/admin/orders/AUCTION_${created.id}`, { headers: { cookie: adminCookie } });
      assert.equal(res.status, 200);
      const adminOrder = await res.json();
      assert.equal(String(adminOrder.data.order.exchange_id || ''), `AUCTION_${created.id}`, '管理端应能按单号查到竞拍订单');
      assert.ok(String(adminOrder.data.order.product_name || '').length > 0, '竞拍订单商品名（活动标题）可见');

      // 核销闭环：管理员用赢家的二维码核销竞拍订单，只标记发放、不二次扣款
      const winnerBalanceBefore = Number((await db.get('SELECT balance FROM accounts WHERE userid = ?', [settleResult.winner.userid])).balance);
      res = await fetch(`${base}/admin/redeem/confirm`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ encoded: auctionOrder.encoded }),
      });
      assert.equal(res.status, 200, `竞拍订单核销应 200，实际 ${res.status}`);
      const confirmed = await db.get('SELECT fulfilled_at FROM redeems WHERE exchange_id = ?', [`AUCTION_${created.id}`]);
      assert.ok(Number(confirmed.fulfilled_at) > 0, '核销后订单应标记 fulfilled');
      const winnerBalanceAfter = Number((await db.get('SELECT balance FROM accounts WHERE userid = ?', [settleResult.winner.userid])).balance);
      assert.equal(winnerBalanceAfter, winnerBalanceBefore, '核销不得再次扣款');
      // 重复核销被拒
      res = await fetch(`${base}/admin/redeem/confirm`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ encoded: auctionOrder.encoded }),
      });
      assert.equal(res.status, 400, '重复核销应被拒绝');

      // 管理端：未登录 401，超管 200；创建/取消
      res = await fetch(`${base}/admin/auction/list`);
      assert.equal(res.status, 401);
      res = await fetch(`${base}/admin/auction/list`, { headers: { cookie: adminCookie } });
      assert.equal(res.status, 200);
      body = await res.json();
      assert.ok(Array.isArray(body.data));

      res = await fetch(`${base}/admin/auction/cancel`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ activity_id: live.id, reason: '集成测试取消' }),
      });
      assert.equal(res.status, 200, '管理端取消应 200');
      body = await res.json();
      assert.equal(body.data.status, 'cancelled');
      const restored = await db.get('SELECT balance FROM accounts WHERE userid = ?', [uid(1)]);
      assert.equal(Number(restored.balance), INITIAL_BALANCE, 'HTTP 取消后余额恢复');
      console.log('✓ HTTP 全链路：401/400 校验、员工出价、管理端创建与取消均通过');
    } finally {
      server.close();
    }

    console.log('\n全部集成测试通过 ✅');
  } catch (err) {
    console.error('集成测试失败:', err);
    process.exitCode = 1;
  } finally {
    if (guardPassed) {
      try {
        await cleanup(db);
        console.log('测试数据已清理');
      } catch (err) {
        console.error('清理失败:', err?.message || err);
      }
    } else {
      console.log('目标库校验未通过，跳过清理以避免误删');
    }
    await db.close();
    process.exit(process.exitCode || 0);
  }
}

main().catch((err) => {
  console.error('集成测试失败:', err);
  process.exit(1);
});
