import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  cancelAuction,
  computeAntiSnipeEndAt,
  computeNextBidFloor,
  createAuction,
  getAuctionDetailForMall,
  listMyAuctionBids,
  normalizeAuctionCreateInput,
  placeAuctionBid,
  purgeUserAuctionBids,
  resolveAuctionDisplayStatus,
  settleAuctionIfDue,
} from '../../src/services/auctionService.js';
import { matchPathPermission } from '../../src/services/adminPermissionService.js';

// ── 纯逻辑 ────────────────────────────────────────────────────

test('竞拍创建入参校验', () => {
  const now = 1700000000;
  const ok = normalizeAuctionCreateInput({
    title: '礼盒',
    start_price: 100,
    min_increment: 10,
    start_at: now + 60,
    end_at: now + 3600,
  }, { now });
  assert.equal(ok.title, '礼盒');
  assert.equal(ok.anti_snipe_seconds, 0);

  assert.throws(() => normalizeAuctionCreateInput({ title: '', start_price: 1, min_increment: 1, start_at: now + 60, end_at: now + 600 }, { now }), /missing title/);
  assert.throws(() => normalizeAuctionCreateInput({ title: 'x', start_price: 0, min_increment: 1, start_at: now + 60, end_at: now + 600 }, { now }), /start_price/);
  assert.throws(() => normalizeAuctionCreateInput({ title: 'x', start_price: 1, min_increment: 0, start_at: now + 60, end_at: now + 600 }, { now }), /min_increment/);
  assert.throws(() => normalizeAuctionCreateInput({ title: 'x', start_price: 1, min_increment: 1, start_at: now + 60, end_at: now + 60 }, { now }), /duration/);
  assert.throws(() => normalizeAuctionCreateInput({ title: 'x', start_price: 1, min_increment: 1, start_at: now + 60, end_at: now + 10 }, { now }), /end_at/);
  assert.throws(() => normalizeAuctionCreateInput({ title: 'x', start_price: 1, min_increment: 1, start_at: now - 3600, end_at: now + 600 }, { now }), /past/);
  assert.throws(() => normalizeAuctionCreateInput({ title: 'x', start_price: 1, min_increment: 1, start_at: now + 60, end_at: now + 600, anti_snipe_seconds: 601 }, { now }), /anti_snipe/);
});

test('金额超出 JS 安全整数上限在入口被拒（避免溢出 Postgres BIGINT）', async () => {
  const now = 1700000000;
  const huge = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => normalizeAuctionCreateInput({ title: 'x', start_price: huge, min_increment: 1, start_at: now + 60, end_at: now + 600 }, { now }), /start_price too large/);
  assert.throws(() => normalizeAuctionCreateInput({ title: 'x', start_price: 1, min_increment: huge, start_at: now + 60, end_at: now + 600 }, { now }), /min_increment too large/);

  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', Number.MAX_SAFE_INTEGER);
  const id = await seedActiveAuction(db);
  await assert.rejects(
    () => placeAuctionBid(db, { activityId: id, userid: 'alice', amount: huge, now: ACTIVE_NOW }),
    /invalid amount/,
  );
  assert.equal(ledgerFor(db, 'alice').length, 0, '超限出价不应产生流水');
});

test('最低出价计算：首次出价为起拍价+加价幅度', () => {
  assert.equal(computeNextBidFloor({ start_price: 100, min_increment: 10 }), 110);
  assert.equal(computeNextBidFloor({ start_price: 100, min_increment: 10, current_price: 150, current_bid_id: 7 }), 160);
});

test('防狙击顺延计算', () => {
  const activity = { end_at: 1000, anti_snipe_seconds: 60 };
  assert.deepEqual(computeAntiSnipeEndAt(activity, 930), { endAt: 1000, extended: false });
  assert.deepEqual(computeAntiSnipeEndAt(activity, 950), { endAt: 1010, extended: true });
  assert.deepEqual(computeAntiSnipeEndAt(activity, 1000), { endAt: 1060, extended: true });
  // 关闭时不顺延
  assert.deepEqual(computeAntiSnipeEndAt({ end_at: 1000, anti_snipe_seconds: 0 }, 999), { endAt: 1000, extended: false });
});

test('展示状态判定', () => {
  assert.equal(resolveAuctionDisplayStatus({ status: 'scheduled', start_at: 100, end_at: 200 }, 50), 'scheduled');
  assert.equal(resolveAuctionDisplayStatus({ status: 'scheduled', start_at: 100, end_at: 200 }, 150), 'active');
  assert.equal(resolveAuctionDisplayStatus({ status: 'active', start_at: 100, end_at: 200 }, 250), 'settling');
  assert.equal(resolveAuctionDisplayStatus({ status: 'settled', start_at: 100, end_at: 200 }, 50), 'settled');
  assert.equal(resolveAuctionDisplayStatus({ status: 'cancelled' }, 50), 'cancelled');
});

test('竞拍管理路径权限映射', () => {
  assert.equal(matchPathPermission('GET', '/auction/list'), 'activities:view');
  assert.equal(matchPathPermission('POST', '/auction/create'), 'activities:edit');
  assert.equal(matchPathPermission('POST', '/auction/cancel'), 'activities:edit');
});

// ── 内存模拟数据库 ────────────────────────────────────────────
// 覆盖 auctionService 使用到的 SQL 子集，并强制执行
// idx_auction_bids_held_once（每场竞拍至多一条 held 出价）不变式。

class FakeAuctionDb {
  constructor() {
    this.users = new Map();
    this.accounts = new Map();
    this.ledger = [];
    this.activities = new Map();
    this.bids = new Map();
    this.redeems = new Map();
    this.seq = { activity: 0, bid: 0, ledger: 0 };
  }

  clone() {
    const next = new FakeAuctionDb();
    // 注意深拷贝 Map 的值：账户/用户对象在事务中会被就地修改，浅拷贝会让快照失效
    next.users = new Map([...this.users].map(([k, v]) => [k, { ...v }]));
    next.accounts = new Map([...this.accounts].map(([k, v]) => [k, { ...v }]));
    next.ledger = this.ledger.map((x) => ({ ...x }));
    next.activities = new Map([...this.activities].map(([k, v]) => [k, { ...v }]));
    next.bids = new Map([...this.bids].map(([k, v]) => [k, { ...v }]));
    next.redeems = new Map([...this.redeems].map(([k, v]) => [k, { ...v }]));
    next.seq = { ...this.seq };
    return next;
  }

  restore(other) {
    this.users = other.users;
    this.accounts = other.accounts;
    this.ledger = other.ledger;
    this.activities = other.activities;
    this.bids = other.bids;
    this.redeems = other.redeems;
    this.seq = other.seq;
  }

  assertHeldInvariant() {
    const heldByActivity = new Map();
    for (const bid of this.bids.values()) {
      if (bid.state !== 'held') continue;
      const key = String(bid.activity_id);
      if (heldByActivity.has(key)) {
        const err = new Error('duplicate held bid');
        err.code = '23505';
        throw err;
      }
      heldByActivity.set(key, bid.id);
    }
  }

  async transaction(fn) {
    const snapshot = this.clone();
    try {
      const result = await fn(this);
      this.assertHeldInvariant();
      return result;
    } catch (err) {
      this.restore(snapshot);
      throw err;
    }
  }

  async get(sql, params = []) {
    const s = String(sql);
    if (s.includes('FROM auction_activities a')) {
      return this.listActivitiesSql(s, params)[0] || undefined;
    }
    if (/FROM\s+audit_logs/.test(s)) return undefined;
    if (s.startsWith('SELECT * FROM auction_activities WHERE id = ?')) {
      return this.activities.get(Number(params[0]));
    }
    if (s.startsWith('SELECT * FROM auction_bids WHERE id = ?')) {
      const row = this.bids.get(Number(params[0]));
      if (row && s.includes("AND state = 'held'") && row.state !== 'held') return undefined;
      return row;
    }
    if (s.startsWith('SELECT balance FROM accounts WHERE userid = ?')) {
      return this.accounts.get(String(params[0]));
    }
    if (/UPDATE accounts[\s\S]*RETURNING balance/.test(s) && s.includes('balance - ?')) {
      const amount = Number(params[0]);
      const uid = String(params[1]);
      const account = this.accounts.get(uid);
      if (!account || Number(account.balance) < amount) return undefined;
      account.balance = Number(account.balance) - amount;
      return { balance: account.balance };
    }
    if (s.includes('FROM auction_bids b') && s.includes('LEFT JOIN users u')) {
      return this.listBidsSql(s, params)[0] || undefined;
    }
    if (s.startsWith('SELECT id, amount, state, created_at FROM auction_bids')) {
      const rows = [...this.bids.values()]
        .filter((b) => b.activity_id === Number(params[0]) && b.userid === String(params[1]))
        .sort((a, b) => b.id - a.id);
      return rows[0];
    }
    if (s.includes('FROM system_settings')) {
      return undefined; // 无通知配置 → 走默认设置
    }
    if (s.includes('COALESCE(SUM(amount), 0)')) {
      const rows = [...this.bids.values()].filter((b) => b.userid === String(params[0]) && b.state === 'held');
      return { held_total: rows.reduce((sum, b) => sum + Number(b.amount), 0), held_count: rows.length };
    }
    throw new Error('FakeAuctionDb.get 未实现的 SQL: ' + s.slice(0, 90));
  }

  async all(sql, params = []) {
    const s = String(sql);
    if (s.includes('FROM auction_activities a')) return this.listActivitiesSql(s, params);
    if (s.includes('FROM auction_bids b') && s.includes('LEFT JOIN users u')) return this.listBidsSql(s, params);
    if (s.includes('FROM auction_bids b') && s.includes('JOIN auction_activities a')) {
      // listMyAuctionBids：按真实 SQL 的列清单映射，活动字段不得覆盖出价字段
      const uid = String(params[0]);
      return [...this.bids.values()]
        .filter((b) => b.userid === uid)
        .sort((a, b) => b.id - a.id)
        .map((b) => {
          const a = this.activities.get(b.activity_id) || {};
          return {
            id: b.id,
            activity_id: b.activity_id,
            amount: b.amount,
            state: b.state,
            created_at: b.created_at,
            title: a.title,
            activity_status: a.status,
            image_url: a.image_url,
            end_at: a.end_at,
            winner_name: a.winner_name,
            final_price: a.final_price,
            settled_at: a.settled_at,
          };
        });
    }
    if (s.startsWith('SELECT id, title FROM auction_activities')) {
      // auctionSettleScheduler 的到期扫描
      const dueAt = Number(params[0]);
      return [...this.activities.values()]
        .filter((a) => ['scheduled', 'active'].includes(a.status) && Number(a.end_at || 0) <= dueAt)
        .sort((a, b) => a.end_at - b.end_at)
        .map((a) => ({ id: a.id, title: a.title }));
    }
    if (s.startsWith('SELECT id, activity_id FROM auction_bids') && s.includes('WHERE userid IN')) {
      // purgeUserAuctionBids：按 userid 批量取在押出价
      const ids = new Set(params.map(String));
      return [...this.bids.values()]
        .filter((b) => b.state === 'held' && ids.has(String(b.userid)))
        .map((b) => ({ id: b.id, activity_id: b.activity_id }));
    }
    throw new Error('FakeAuctionDb.all 未实现的 SQL: ' + s.slice(0, 90));
  }

  listActivitiesSql(sql, params) {
    let rows = [...this.activities.values()].map((a) => ({
      ...a,
      current_bidder_name: a.current_bid_userid ? (this.users.get(a.current_bid_userid)?.name || a.current_bid_userid) : '',
    }));
    const s = String(sql);
    if (s.includes('WHERE a.id = ?')) {
      rows = rows.filter((a) => a.id === Number(params[0]));
    } else if (s.includes("a.status <> 'cancelled'")) {
      const settledAfter = Number(params[0]);
      rows = rows.filter((a) => a.status !== 'cancelled' && (a.status !== 'settled' || Number(a.settled_at || 0) >= settledAfter));
      const weight = { active: 0, scheduled: 1 };
      rows.sort((a, b) => (weight[a.status] ?? 2) - (weight[b.status] ?? 2) || a.start_at - b.start_at || b.id - a.id);
    } else if (s.includes('WHERE a.status = ?')) {
      rows = rows.filter((a) => a.status === params[0]);
    } else {
      rows.sort((a, b) => b.id - a.id);
    }
    return rows;
  }

  listBidsSql(sql, params) {
    const s = String(sql);
    let rows = [...this.bids.values()];
    if (s.includes('WHERE b.activity_id = ?')) {
      rows = rows.filter((b) => b.activity_id === Number(params[0]));
    }
    rows = rows
      .sort((a, b) => b.id - a.id)
      .map((b) => ({
        ...b,
        display_name: this.users.get(b.userid)?.name || b.user_name_snapshot || b.userid,
      }));
    const limitMatch = s.match(/LIMIT (\d+)/);
    if (limitMatch) rows = rows.slice(0, Number(limitMatch[1]));
    return rows;
  }

  async run(sql, params = []) {
    const s = String(sql);
    if (/INSERT OR IGNORE INTO users/.test(s)) {
      const uid = String(params[0]);
      if (!this.users.has(uid)) this.users.set(uid, { userid: uid, name: null });
      return { changes: 1, lastID: 1 };
    }
    if (s.startsWith('UPDATE users SET name = ?')) {
      const uid = String(params[1]);
      if (this.users.has(uid)) this.users.get(uid).name = String(params[0]);
      return { changes: 1, lastID: null };
    }
    if (/INSERT OR IGNORE INTO accounts/.test(s)) {
      const uid = String(params[0]);
      if (!this.accounts.has(uid)) this.accounts.set(uid, { userid: uid, balance: 0 });
      return { changes: 1, lastID: 1 };
    }
    if (s.startsWith('INSERT INTO auction_activities')) {
      const id = ++this.seq.activity;
      this.activities.set(id, {
        id,
        title: params[0],
        description: params[1],
        image_url: params[2],
        start_price: Number(params[3]),
        min_increment: Number(params[4]),
        start_at: Number(params[5]),
        end_at: Number(params[6]),
        anti_snipe_seconds: Number(params[7]),
        status: 'scheduled',
        current_price: null,
        current_bid_userid: null,
        current_bid_id: null,
        bid_count: 0,
        winner_userid: null,
        winner_name: null,
        final_price: null,
        settled_at: null,
        cancelled_at: null,
        cancel_reason: null,
        created_by: params[8] ?? null,
        created_name: params[9] ?? null,
        created_at: 1700000000,
      });
      return { changes: 1, lastID: id };
    }
    if (s.startsWith('INSERT INTO auction_bids')) {
      const id = ++this.seq.bid;
      this.bids.set(id, {
        id,
        activity_id: Number(params[0]),
        userid: String(params[1]),
        user_name_snapshot: params[2] ?? null,
        amount: Number(params[3]),
        state: 'held',
        created_at: Number(params[5]),
        settled_at: null,
      });
      this.assertHeldInvariant();
      return { changes: 1, lastID: id };
    }
    if (s.startsWith('INSERT INTO redeems')) {
      const exchangeId = String(params[0]);
      if (this.redeems.has(exchangeId)) {
        const err = new Error('duplicate redeem exchange_id');
        err.code = '23505';
        throw err;
      }
      this.redeems.set(exchangeId, {
        exchange_id: exchangeId,
        userid: String(params[1]),
        product_id: String(params[2]),
        product_name: params[3] ?? null,
        bob_amount: Number(params[4]),
        fulfilled_at: null,
        limit_round: Number(params[6] ?? 1),
      });
      return { changes: 1, lastID: this.redeems.size };
    }
    if (s.startsWith('INSERT INTO ledger')) {
      const id = ++this.seq.ledger;
      this.ledger.push({
        id,
        userid: String(params[0]),
        delta: Number(params[1]),
        reason: String(params[2]),
        ref_id: params[3] ?? null,
      });
      return { changes: 1, lastID: id };
    }
    if (s.startsWith("UPDATE auction_bids SET state = 'refunded'") && s.includes('WHERE userid IN')) {
      // purgeUserAuctionBids：批量把目标用户的在押出价置为失效（不退款入账）
      const now = Number(params[0]);
      const ids = new Set(params.slice(1).map(String));
      let changes = 0;
      for (const bid of this.bids.values()) {
        if (bid.state === 'held' && ids.has(String(bid.userid))) {
          bid.state = 'refunded';
          bid.settled_at = now;
          changes += 1;
        }
      }
      return { changes, lastID: null };
    }
    if (s.includes('SET current_price = NULL')) {
      // purgeUserAuctionBids：回退竞拍当前最高价指针
      const activity = this.activities.get(Number(params[0]));
      if (!activity || activity.current_bid_id !== Number(params[1]) || ['settled', 'cancelled'].includes(activity.status)) {
        return { changes: 0, lastID: null };
      }
      activity.current_price = null;
      activity.current_bid_userid = null;
      activity.current_bid_id = null;
      return { changes: 1, lastID: activity.id };
    }
    if (s.startsWith("UPDATE auction_bids SET state = 'refunded'") || s.startsWith("UPDATE auction_bids SET state = 'won'")) {
      const state = s.includes("'refunded'") ? 'refunded' : 'won';
      const bid = this.bids.get(Number(params[1]));
      if (!bid || bid.state !== 'held') return { changes: 0, lastID: null };
      bid.state = state;
      bid.settled_at = Number(params[0]);
      this.assertHeldInvariant();
      return { changes: 1, lastID: bid.id };
    }
    if (s.startsWith('UPDATE accounts SET balance = balance + ?')) {
      const account = this.accounts.get(String(params[1]));
      if (!account) return { changes: 0, lastID: null };
      account.balance = Number(account.balance) + Number(params[0]);
      return { changes: 1, lastID: null };
    }
    if (s.includes('SET current_price = ?')) {
      const activity = this.activities.get(Number(params[4]));
      assert.ok(activity, 'update activity exists');
      activity.current_price = Number(params[0]);
      activity.current_bid_userid = String(params[1]);
      activity.current_bid_id = Number(params[2]);
      activity.bid_count = Number(activity.bid_count || 0) + 1;
      activity.status = 'active';
      activity.end_at = Number(params[3]);
      return { changes: 1, lastID: activity.id };
    }
    if (s.includes("SET status = 'settled'")) {
      const activity = this.activities.get(Number(params[4]));
      if (!activity || !['scheduled', 'active'].includes(activity.status)) {
        return { changes: 0, lastID: null };
      }
      activity.status = 'settled';
      activity.winner_userid = params[0];
      activity.winner_name = params[1];
      activity.final_price = params[2] === null ? null : Number(params[2]);
      activity.settled_at = Number(params[3]);
      return { changes: 1, lastID: activity.id };
    }
    if (s.includes("SET status = 'active'")) {
      const activity = this.activities.get(Number(params[0]));
      if (!activity || activity.status !== 'scheduled') return { changes: 0, lastID: null };
      activity.status = 'active';
      return { changes: 1, lastID: activity.id };
    }
    if (s.includes("SET status = 'cancelled'")) {
      const activity = this.activities.get(Number(params[2]));
      if (!activity || !['scheduled', 'active'].includes(activity.status)) {
        return { changes: 0, lastID: null };
      }
      activity.status = 'cancelled';
      activity.cancelled_at = Number(params[0]);
      activity.cancel_reason = params[1] ?? null;
      return { changes: 1, lastID: activity.id };
    }
    throw new Error('FakeAuctionDb.run 未实现的 SQL: ' + s.slice(0, 90));
  }
}

function makeDb() {
  const db = new FakeAuctionDb();
  return db;
}

async function seedUser(db, userid, name, balance) {
  await db.run('INSERT OR IGNORE INTO users(userid, name) VALUES(?, ?)', [userid, null]);
  await db.run('INSERT OR IGNORE INTO accounts(userid, balance) VALUES(?, 0)', [userid]);
  const account = db.accounts.get(userid);
  account.balance = balance;
}

async function seedActiveAuction(db, { id = 1, startPrice = 100, increment = 10, startAt = 1700000000, endAt = 1700003600, antiSnipe = 0 } = {}) {
  db.seq.activity = Math.max(db.seq.activity, id - 1);
  const insert = await db.run(
    `INSERT INTO auction_activities(title, description, image_url, start_price, min_increment,
       start_at, end_at, anti_snipe_seconds, status, created_by, created_name)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
    ['测试竞拍', null, null, startPrice, increment, startAt, endAt, antiSnipe, 'admin', '管理员'],
  );
  assert.equal(insert.lastID, id);
  db.activities.get(id).status = 'active';
  return id;
}

const ACTIVE_NOW = 1700001000; // 落在 seedActiveAuction 的活动窗口内

function ledgerFor(db, userid) {
  return db.ledger.filter((x) => x.userid === userid);
}

function balanceOf(db, userid) {
  return Number(db.accounts.get(userid)?.balance ?? 0);
}

// ── 出价与资金一致性 ──────────────────────────────────────────

test('出价冻结余额；被超出后原额退回', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  await seedUser(db, 'bob', 'Bob', 500);
  const id = await seedActiveAuction(db);

  const first = await placeAuctionBid(db, { activityId: id, userid: 'alice', name: 'Alice', amount: 110, now: ACTIVE_NOW });
  assert.equal(first.amount, 110);
  assert.equal(balanceOf(db, 'alice'), 390);
  assert.deepEqual(ledgerFor(db, 'alice').map((x) => [x.delta, x.reason]), [[-110, 'auction_bid']]);

  const second = await placeAuctionBid(db, { activityId: id, userid: 'bob', name: 'Bob', amount: 120, now: ACTIVE_NOW });
  assert.equal(second.refunded_to, 'alice');
  assert.equal(balanceOf(db, 'alice'), 500);
  assert.equal(balanceOf(db, 'bob'), 380);
  assert.deepEqual(ledgerFor(db, 'alice').map((x) => [x.delta, x.reason]), [[-110, 'auction_bid'], [110, 'auction_outbid_refund']]);
  assert.deepEqual(ledgerFor(db, 'bob').map((x) => [x.delta, x.reason]), [[-120, 'auction_bid']]);

  const activity = db.activities.get(id);
  assert.equal(activity.current_price, 120);
  assert.equal(activity.current_bid_userid, 'bob');
  assert.equal(activity.bid_count, 2);

  // 流水与余额一致
  for (const uid of ['alice', 'bob']) {
    const sum = ledgerFor(db, uid).reduce((acc, x) => acc + x.delta, 0);
    assert.equal(sum + 500, balanceOf(db, uid));
  }
});

test('余额不足时出价被拒且无任何副作用', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  await seedUser(db, 'bob', 'Bob', 90);
  const id = await seedActiveAuction(db);

  await placeAuctionBid(db, { activityId: id, userid: 'alice', name: 'Alice', amount: 110, now: ACTIVE_NOW });
  await assert.rejects(
    () => placeAuctionBid(db, { activityId: id, userid: 'bob', name: 'Bob', amount: 120, now: ACTIVE_NOW }),
    /insufficient balance/,
  );
  assert.equal(balanceOf(db, 'bob'), 90);
  assert.equal(ledgerFor(db, 'bob').length, 0);
  assert.equal(db.activities.get(id).current_bid_userid, 'alice');
  assert.equal(balanceOf(db, 'alice'), 390, 'alice 冻结保持不变');
});

test('低于门槛 / 自我加价 / 未开始 / 已结束 拒绝', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 5000);
  const id = await seedActiveAuction(db);

  await assert.rejects(() => placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 100, now: ACTIVE_NOW }), /bid_too_low/);
  await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: ACTIVE_NOW });
  await assert.rejects(() => placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 500, now: ACTIVE_NOW }), /already_highest_bidder/);
  await assert.rejects(() => placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: 1700000000 - 1 }), /not_started/);
  await assert.rejects(() => placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: 1700003600 }), /auction ended/);
  await assert.rejects(() => placeAuctionBid(db, { activityId: 999, userid: 'alice', amount: 110, now: ACTIVE_NOW }), /auction not found/);
});

test('防狙击：结束前最后时刻出价顺延结束时间', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  await seedUser(db, 'bob', 'Bob', 500);
  const id = await seedActiveAuction(db, { antiSnipe: 60 });

  const first = await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: 1700003500 });
  // 距结束 100s > 60s，不顺延
  assert.equal(db.activities.get(id).end_at, 1700003600);

  const second = await placeAuctionBid(db, { activityId: id, userid: 'bob', amount: 120, now: 1700003550 });
  // 距结束 50s <= 60s，顺延到 now+60
  assert.equal(second.end_at, 1700003610);
  assert.equal(db.activities.get(id).end_at, 1700003610);

  // 顺延后原结束时刻出价应被接受
  const third = await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 130, now: 1700003600 });
  assert.equal(third.end_at, 1700003660);
});

test('并发违反唯一在押索引时抛出 23505（模拟竞态兜底）', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  await seedUser(db, 'bob', 'Bob', 500);
  const id = await seedActiveAuction(db);
  await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: ACTIVE_NOW });

  // 人为插入第二条 held 出价，模拟绕过服务层的脏写
  db.bids.set(999, { id: 999, activity_id: id, userid: 'ghost', amount: 999, state: 'held', created_at: ACTIVE_NOW, settled_at: null });
  await assert.rejects(
    () => placeAuctionBid(db, { activityId: id, userid: 'bob', amount: 120, now: ACTIVE_NOW }),
    (err) => err.code === '23505',
  );
  // 整个事务回滚：bob 未被扣款，ghost 脏数据仍在（由 DB 约束在真实库中阻止）
  assert.equal(balanceOf(db, 'bob'), 500);
});

// ── 结算 ──────────────────────────────────────────────────────

test('结算：获胜者冻结转为成交扣款，账实相符', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  await seedUser(db, 'bob', 'Bob', 500);
  const id = await seedActiveAuction(db);

  await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: ACTIVE_NOW });
  await placeAuctionBid(db, { activityId: id, userid: 'bob', amount: 130, now: ACTIVE_NOW });

  const result = await settleAuctionIfDue(db, { activityId: id, now: 1700003600 });
  assert.equal(result.just_settled, true);
  assert.equal(result.winner.userid, 'bob');
  assert.equal(result.winner.amount, 130);

  const activity = db.activities.get(id);
  assert.equal(activity.status, 'settled');
  assert.equal(activity.winner_userid, 'bob');
  assert.equal(activity.final_price, 130);

  const bobLedger = ledgerFor(db, 'bob');
  assert.deepEqual(bobLedger.map((x) => [x.delta, x.reason]), [
    [-130, 'auction_bid'],
    [130, 'auction_settle_refund'],
    [-130, 'auction_win_pay'],
  ]);
  // bob 支出 130，alice 退回后回到原值
  assert.equal(balanceOf(db, 'bob'), 370);
  assert.equal(balanceOf(db, 'alice'), 500);
  const sumDelta = (uid) => ledgerFor(db, uid).reduce((acc, x) => acc + x.delta, 0);
  assert.equal(sumDelta('bob'), -130);
  assert.equal(sumDelta('alice'), 0);
});

test('结算幂等：重复结算与并发竞争不会重复入账', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  const id = await seedActiveAuction(db);
  await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: ACTIVE_NOW });

  const first = await settleAuctionIfDue(db, { activityId: id, now: 1700003600 });
  assert.equal(first.just_settled, true);
  const again = await settleAuctionIfDue(db, { activityId: id, now: 1700004000 });
  assert.equal(again.just_settled, false);
  const again2 = await settleAuctionIfDue(db, { activityId: id, now: 1700005000 });
  assert.equal(again2.just_settled, false);

  // 只有一对结算流水
  const rows = ledgerFor(db, 'alice').filter((x) => x.reason === 'auction_win_pay');
  assert.equal(rows.length, 1);
  assert.equal(balanceOf(db, 'alice'), 390);
});

test('无人出价流拍结算', async () => {
  const db = makeDb();
  const id = await seedActiveAuction(db);
  const result = await settleAuctionIfDue(db, { activityId: id, now: 1700003600 });
  assert.equal(result.just_settled, true);
  assert.equal(result.winner, null);
  assert.equal(db.activities.get(id).winner_userid, null);
  assert.equal(db.activities.get(id).status, 'settled');
});

test('结束前结算为空操作', async () => {
  const db = makeDb();
  const id = await seedActiveAuction(db);
  const result = await settleAuctionIfDue(db, { activityId: id, now: ACTIVE_NOW });
  assert.equal(result.just_settled, false);
  assert.equal(db.activities.get(id).status, 'active');
});

// ── 取消 ──────────────────────────────────────────────────────

test('取消进行中的竞拍会退回在押金额且不可重复取消', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  const id = await seedActiveAuction(db);
  await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: ACTIVE_NOW });

  const result = await cancelAuction(db, { activityId: id, reason: '库存出错', now: ACTIVE_NOW + 10 });
  assert.equal(result.refunded.userid, 'alice');
  assert.equal(result.refunded.amount, 110);
  assert.equal(balanceOf(db, 'alice'), 500);
  assert.deepEqual(ledgerFor(db, 'alice').map((x) => [x.delta, x.reason]), [
    [-110, 'auction_bid'],
    [110, 'auction_cancel_refund'],
  ]);
  assert.equal(db.activities.get(id).status, 'cancelled');
  assert.equal(db.bids.get(1).state, 'refunded');

  await assert.rejects(() => cancelAuction(db, { activityId: id, now: ACTIVE_NOW }), /auction_already_cancelled/);
});

test('已结算的竞拍不能取消', async () => {
  const db = makeDb();
  const id = await seedActiveAuction(db);
  await settleAuctionIfDue(db, { activityId: id, now: 1700003600 });
  await assert.rejects(() => cancelAuction(db, { activityId: id, now: 1700003601 }), /auction_already_settled/);
});

// ── 读接口与创建 ──────────────────────────────────────────────

test('创建活动默认 scheduled；读取时惰性推进与结算', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  const created = await createAuction(db, {
    input: { title: '新品', start_price: 50, min_increment: 5, start_at: 1700000100, end_at: 1700000200 },
    createdBy: 'admin',
    createdName: '管理员',
    now: 1700000000,
  });
  assert.equal(created.status, 'scheduled');

  // 未到开始时间
  const before = await getAuctionDetailForMall(db, { activityId: created.id, now: 1700000050 });
  assert.equal(before.activity.effective_status, 'scheduled');

  // 到点后进入 active
  const during = await getAuctionDetailForMall(db, { activityId: created.id, now: 1700000150 });
  assert.equal(during.activity.status, 'active');
  assert.equal(during.activity.effective_status, 'active');

  // 结束后首次读取触发结算
  await placeAuctionBid(db, { activityId: created.id, userid: 'alice', amount: 55, now: 1700000150 });
  const after = await getAuctionDetailForMall(db, { activityId: created.id, now: 1700000250 });
  assert.equal(after.activity.status, 'settled');
  assert.equal(after.activity.winner_name, 'alice');
  assert.equal(after.settledWinner?.userid, 'alice');
  assert.equal(balanceOf(db, 'alice'), 445);

  // 我的竞拍记录
  const mine = await listMyAuctionBids(db, { userid: 'alice' });
  assert.equal(mine.bids.length, 1);
  assert.equal(mine.bids[0].state, 'won');
  assert.equal(mine.bids[0].amount, 55, '出价金额来自 bid 而非被活动字段覆盖');
  assert.equal(mine.bids[0].title, '新品', '活动标题正确关联');
  assert.equal(mine.bids[0].final_price, 55);
  assert.equal(mine.held_total, 0);
});

test('活动窗口外/取消的活动不出现在员工列表', async () => {
  const db = makeDb();
  const now = 1700000000;
  await createAuction(db, { input: { title: 'A', start_price: 10, min_increment: 1, start_at: now + 100, end_at: now + 600 }, now });
  await createAuction(db, { input: { title: 'B', start_price: 10, min_increment: 1, start_at: now + 100, end_at: now + 600 }, now });
  await createAuction(db, { input: { title: 'C', start_price: 10, min_increment: 1, start_at: now + 100, end_at: now + 600 }, now });

  await cancelAuction(db, { activityId: 3, now });
  const { list } = await import('../../src/services/auctionService.js').then((m) => m.listAuctionActivitiesForMall(db, { now }));
  assert.equal(list.length, 2);
  assert.ok(!list.some((x) => x.id === 3));
});

// ── 回归：序列化与字段收敛 ────────────────────────────────────

test('员工读接口的 next_bid_floor 跟随当前价（而非恒为起拍价+幅度）', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  const id = await seedActiveAuction(db, { startPrice: 100, increment: 10 });

  const before = await getAuctionDetailForMall(db, { activityId: id, now: ACTIVE_NOW });
  assert.equal(before.activity.next_bid_floor, 110, '无出价时 floor = 起拍价+幅度');

  await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: ACTIVE_NOW });
  const after = await getAuctionDetailForMall(db, { activityId: id, now: ACTIVE_NOW });
  assert.equal(after.activity.current_price, 110);
  assert.equal(after.activity.next_bid_floor, 120, '有出价后 floor = 当前价+幅度');
});

test('员工端响应不携带出价人/得主 userid，管理端保留', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  const id = await seedActiveAuction(db);
  await placeAuctionBid(db, { activityId: id, userid: 'alice', name: 'Alice', amount: 110, now: ACTIVE_NOW });
  await settleAuctionIfDue(db, { activityId: id, now: 1700003600 });

  const mallDetail = await getAuctionDetailForMall(db, { activityId: id, now: 1700003601 });
  assert.equal('current_bid_userid' in mallDetail.activity, false);
  assert.equal('winner_userid' in mallDetail.activity, false);
  assert.ok(mallDetail.activity.bids.every((bid) => !('userid' in bid)));
  assert.equal(mallDetail.activity.winner_name, 'Alice');

  const { getAuctionDetailForAdmin } = await import('../../src/services/auctionService.js');
  const adminDetail = await getAuctionDetailForAdmin(db, { activityId: id, now: 1700003601 });
  assert.equal(adminDetail.activity.current_bid_userid, 'alice');
  assert.equal(adminDetail.activity.winner_userid, 'alice');
  assert.equal(adminDetail.activity.bids[0].userid, 'alice');
});

test('到期未结算的竞拍不能被取消（胜利已锁定）', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  const id = await seedActiveAuction(db);
  await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: ACTIVE_NOW });

  await assert.rejects(
    () => cancelAuction(db, { activityId: id, reason: '晚到', now: 1700003600 }),
    /auction_already_settled/,
  );
  assert.equal(db.activities.get(id).status, 'active', '活动保持未取消');
  assert.equal(balanceOf(db, 'alice'), 390, '在押未被退回');
  assert.equal(db.bids.get(1).state, 'held');

  // 结算后正常出价、正常取消窗口均已关闭
  const settled = await settleAuctionIfDue(db, { activityId: id, now: 1700003601 });
  assert.equal(settled.just_settled, true);
});

// ── 定时结算调度器 ────────────────────────────────────────────

test('调度器扫描到期活动并结算，未到期与已结算的不受影响', async () => {
  const { startAuctionSettleScheduler } = await import('../../src/services/auctionSettleScheduler.js');
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  const dueId = await seedActiveAuction(db, { id: 1 }); // end_at = 1700003600
  await placeAuctionBid(db, { activityId: dueId, userid: 'alice', amount: 110, now: ACTIVE_NOW });
  const futureId = await seedActiveAuction(db, { id: 2, endAt: Math.floor(Date.now() / 1000) + 3600 });

  const warnings = [];
  let stopped = null;
  // 构造时立即 tick 一次；真实时钟晚于 1700003600，dueId 应被结算
  stopped = startAuctionSettleScheduler({
    db,
    cfg: {},
    intervalMs: 3600000,
    logger: { warn: (msg) => warnings.push(String(msg)) },
  });
  try {
    // 等首次 tick（构造内同步调用）完成
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(db.activities.get(dueId).status, 'settled');
    assert.equal(db.activities.get(dueId).winner_userid, 'alice');
    assert.equal(db.activities.get(futureId).status, 'active', '未到期活动不受影响');
    assert.deepEqual(warnings, []);
  } finally {
    stopped();
  }
});

// ── 结算生成领取凭证（redeems 订单） ──────────────────────────

test('结算后为获胜者生成 AUCTION_ 兑换单，流拍不生成', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  const id = await seedActiveAuction(db);
  await placeAuctionBid(db, { activityId: id, userid: 'alice', name: 'Alice', amount: 110, now: ACTIVE_NOW });

  const result = await settleAuctionIfDue(db, { activityId: id, now: 1700003600 });
  assert.equal(result.winner.redeem_exchange_id, 'AUCTION_1');
  const order = db.redeems.get('AUCTION_1');
  assert.ok(order, '兑换单已生成');
  assert.equal(order.userid, 'alice');
  assert.equal(order.product_id, 'AUCTION_1');
  assert.equal(order.product_name, '测试竞拍');
  assert.equal(order.bob_amount, 110);
  assert.equal(order.fulfilled_at, null, '初始未核销');
  // 重复结算不重复建单
  await settleAuctionIfDue(db, { activityId: id, now: 1700004000 });
  assert.equal(db.redeems.size, 1);

  // 流拍不生成订单
  const emptyId = await seedActiveAuction(db, { id: 2 });
  await settleAuctionIfDue(db, { activityId: emptyId, now: 1700003600 });
  assert.ok(!db.redeems.has('AUCTION_2'));
});

test('兑换单冲突时结算整体回滚，不会留下半结算状态', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  const id = await seedActiveAuction(db);
  await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: ACTIVE_NOW });
  // 人为预占同号兑换单，模拟异常脏数据
  db.redeems.set('AUCTION_1', { exchange_id: 'AUCTION_1', userid: 'ghost', product_id: 'AUCTION_1', product_name: 'x', bob_amount: 1, fulfilled_at: null, limit_round: 1 });

  await assert.rejects(
    () => settleAuctionIfDue(db, { activityId: id, now: 1700003600 }),
    /auction state inconsistent/,
  );
  const activity = db.activities.get(id);
  assert.equal(activity.status, 'active', '结算已整体回滚');
  assert.equal(activity.winner_userid, null);
  assert.equal(db.bids.get(1).state, 'held', '获胜标记已回滚');
  const wonLedger = db.ledger.filter((x) => x.reason === 'auction_win_pay');
  assert.equal(wonLedger.length, 0, '成交流水已回滚');
});

// ── 用户重置/删除与拍卖出价的对账（P1 回归） ──────────────────

test('重置/删除有在押出价的用户：作废出价并回退竞拍最高价，结算不再重复入账/卡死', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  const id = await seedActiveAuction(db);
  await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: ACTIVE_NOW });

  const activityBefore = db.activities.get(id);
  assert.equal(activityBefore.current_bid_id, 1, '出价后当前最高价指向该出价');
  assert.equal(db.bids.get(1).state, 'held');

  // 模拟 purgeUserBusinessData 内的拍卖清理（同一事务内调用）
  const result = await purgeUserAuctionBids(db, ['alice'], { now: ACTIVE_NOW + 10 });
  assert.equal(result.held_voided, 1, '在押出价被作废');
  assert.equal(result.activities_reverted, 1, '竞拍最高价指针被回退');

  const bid = db.bids.get(1);
  assert.equal(bid.state, 'refunded', '出价不再是 held');
  const activity = db.activities.get(id);
  assert.equal(activity.current_bid_id, null);
  assert.equal(activity.current_price, null);
  assert.equal(activity.current_bid_userid, null);

  // 到点结算：无获胜者、不抛 auction state inconsistent、不给已清用户补发结算流水
  const settled = await settleAuctionIfDue(db, { activityId: id, now: 1700003600 });
  assert.equal(settled.just_settled, true);
  assert.equal(settled.winner, null, '被清理用户不再是获胜者');
  assert.equal(db.activities.get(id).winner_userid, null);
  const aliceSettleLedger = db.ledger.filter((x) => x.userid === 'alice' && x.reason.startsWith('auction_settle'));
  assert.equal(aliceSettleLedger.length, 0, '不向已清理用户重复入账');
});

test('purgeUserAuctionBids 不触碰已结算竞拍的历史出价', async () => {
  const db = makeDb();
  await seedUser(db, 'alice', 'Alice', 500);
  const id = await seedActiveAuction(db);
  await placeAuctionBid(db, { activityId: id, userid: 'alice', amount: 110, now: ACTIVE_NOW });
  await settleAuctionIfDue(db, { activityId: id, now: 1700003600 });
  assert.equal(db.bids.get(1).state, 'won', '结算后为 won');

  const result = await purgeUserAuctionBids(db, ['alice'], { now: 1700003700 });
  assert.equal(result.held_voided, 0, '没有在押出价可作废');
  assert.equal(result.activities_reverted, 0);
  assert.equal(db.bids.get(1).state, 'won', '已成交出价保持不变');
});

// ── 清理与并发出价的加锁顺序（P1 回归） ──────────────────────

test('用户清理在扫描在押出价前先锁定账户，与出价加锁顺序一致', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/services/userDataPurgeService.js', import.meta.url)),
    'utf8',
  );
  // purgeUserBusinessData 必须先对目标账户 SELECT ... FOR UPDATE，再进行后续清理
  const lockIdx = src.indexOf('SELECT userid FROM accounts WHERE userid IN');
  assert.ok(lockIdx >= 0, '清理前应锁定账户');
  assert.match(src.slice(lockIdx, lockIdx + 120), /FOR UPDATE/);
  // 锁定必须早于拍卖出价清理
  const purgeAuctionIdx = src.indexOf('purgeUserAuctionBids(tx, targets)');
  assert.ok(purgeAuctionIdx > lockIdx, '账户锁定应早于拍卖出价清理');
  // placeAuctionBid 同样先锁 accounts FOR UPDATE，保证加锁顺序一致、避免死锁
  const auctionSrc = readFileSync(
    fileURLToPath(new URL('../../src/services/auctionService.js', import.meta.url)),
    'utf8',
  );
  assert.match(auctionSrc, /SELECT balance FROM accounts WHERE userid = \? FOR UPDATE/);
});
