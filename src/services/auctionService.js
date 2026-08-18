import { ensureAccount } from './ledgerService.js';
import { sendOrQueueNotify } from './notifyOpsService.js';

// 限时竞拍：资金模型为「出价即冻结」。
// 出价时立即从余额扣除并写流水（auction_bid）；被他人超出时原额退回（auction_outbid_refund）；
// 结算时获胜者的冻结转为成交扣款（auction_settle_refund + auction_win_pay，净额为零）；
// 管理员取消时退回在押出价（auction_cancel_refund）。
// 任意时刻每场竞拍至多一条 state='held' 的出价，由部分唯一索引 idx_auction_bids_held_once 兜底。

export const AUCTION_BID_STATES = ['held', 'refunded', 'won'];

// 结算通知：由完成结算的一方（调度器或读请求兜底）调用；结算的条件更新
// 保证同一场竞拍只会有一个触发方，不会重复通知。
export function notifyAuctionWinners({ db, cfg, winners }) {
  for (const winner of winners || []) {
    if (!winner?.userid) continue;
    sendOrQueueNotify({
      db,
      cfg,
      userid: winner.userid,
      title: `【BOB币中心】竞拍成交 ${winner.name || winner.userid}`,
      lines: [
        `商品：${winner.title || `竞拍 #${winner.activity_id}`}`,
        `成交价：${String(winner.amount)} BOB 币`,
        '奖品领取：请到「订单」页出示核销二维码，由工作人员扫码核销。',
      ],
      event: 'auction',
      variables: {
        name: winner.name || winner.userid,
        userid: winner.userid,
        amount: String(winner.amount),
        activity_id: String(winner.activity_id),
        title: winner.title || '',
      },
    }).catch(() => null);
  }
}

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

// JS 安全整数上限：超出后既无法精确表示，也接近 Postgres BIGINT 边界，
// 统一在入口拒绝，避免落到数据库层报 500。
const MAX_AUCTION_AMOUNT = Number.MAX_SAFE_INTEGER;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function runInTx(db, fn) {
  if (db?.__txScoped === true) return fn(db);
  if (typeof db?.transaction === 'function') return db.transaction(fn);
  return fn(db);
}

function buildBidRef(activityId, bidId) {
  return `AUCTION_${Number(activityId)}_${Number(bidId)}`;
}

export function buildAuctionExchangeId(activityId) {
  return `AUCTION_${Number(activityId)}`;
}

export function computeNextBidFloor(activity = {}) {
  const hasBid = Boolean(activity.current_bid_id);
  const base = hasBid
    ? Number(activity.current_price ?? 0)
    : Number(activity.start_price ?? 0);
  return Math.max(0, base) + Math.max(1, Number(activity.min_increment ?? 1));
}

// 防狙击（软关闭）：结束前 anti_snipe_seconds 秒内的新出价，将结束时间顺延为 出价时间 + anti_snipe_seconds。
export function computeAntiSnipeEndAt(activity = {}, nowSec = nowSeconds()) {
  const antiSnipe = Number(activity.anti_snipe_seconds || 0);
  const endAt = Number(activity.end_at || 0);
  if (!(antiSnipe > 0) || !endAt) return { endAt, extended: false };
  if (endAt - nowSec > antiSnipe) return { endAt, extended: false };
  const nextEndAt = Math.max(endAt, nowSec + antiSnipe);
  return { endAt: nextEndAt, extended: nextEndAt > endAt };
}

// 纯计算：给定活动与当前时间，得到对外展示的有效状态。
export function resolveAuctionDisplayStatus(activity = {}, nowSec = nowSeconds()) {
  const status = String(activity.status || 'scheduled');
  if (status === 'cancelled' || status === 'settled') return status;
  const startAt = Number(activity.start_at || 0);
  const endAt = Number(activity.end_at || 0);
  if (nowSec < startAt) return 'scheduled';
  if (nowSec < endAt) return 'active';
  return 'settling';
}

export function serializeAuctionRow(row = {}, { now = nowSeconds(), withFloor = true, includeBidderUserid = true } = {}) {
  const hasCurrentBid = Boolean(row.current_bid_id);
  const out = {
    id: Number(row.id),
    title: String(row.title || ''),
    description: row.description === null || row.description === undefined ? '' : String(row.description),
    image_url: row.image_url === null || row.image_url === undefined ? '' : String(row.image_url),
    start_price: Number(row.start_price ?? 0),
    min_increment: Number(row.min_increment ?? 1),
    start_at: Number(row.start_at || 0),
    end_at: Number(row.end_at || 0),
    anti_snipe_seconds: Number(row.anti_snipe_seconds || 0),
    status: String(row.status || 'scheduled'),
    current_price: row.current_price === null || row.current_price === undefined ? null : Number(row.current_price),
    current_bidder_name: row.current_bidder_name ? String(row.current_bidder_name) : '',
    bid_count: Number(row.bid_count || 0),
    winner_name: row.winner_name ? String(row.winner_name) : '',
    final_price: row.final_price === null || row.final_price === undefined ? null : Number(row.final_price),
    settled_at: row.settled_at === null || row.settled_at === undefined ? null : Number(row.settled_at),
    cancelled_at: row.cancelled_at === null || row.cancelled_at === undefined ? null : Number(row.cancelled_at),
    cancel_reason: row.cancel_reason ? String(row.cancel_reason) : '',
    created_by: row.created_by ? String(row.created_by) : '',
    created_name: row.created_name ? String(row.created_name) : '',
    created_at: Number(row.created_at || 0),
  };
  // userid 仅管理端可见；员工端只下发展示名，收敛个人信息暴露面。
  if (includeBidderUserid) {
    out.current_bid_userid = row.current_bid_userid ? String(row.current_bid_userid) : '';
    out.winner_userid = row.winner_userid ? String(row.winner_userid) : '';
  }
  out.effective_status = resolveAuctionDisplayStatus(out, now);
  out.seconds_to_start = Math.max(0, out.start_at - now);
  out.seconds_remaining = out.effective_status === 'active' ? Math.max(0, out.end_at - now) : 0;
  // 注意：floor 必须基于原始行计算（依赖 current_bid_id 判断是否已有出价），
  // 序列化对象本身不携带该内部字段。
  if (withFloor) out.next_bid_floor = computeNextBidFloor(row);
  return out;
}

export function normalizeAuctionCreateInput(input = {}, { now = nowSeconds() } = {}) {
  const errors = [];
  const title = String(input?.title ?? '').trim();
  if (!title) errors.push('missing title');
  if (title.length > 80) errors.push('title too long');

  const description = String(input?.description ?? '').trim();
  if (description.length > 2000) errors.push('description too long');

  const imageUrl = String(input?.image_url ?? '').trim();
  if (imageUrl.length > 500) errors.push('image_url too long');

  const startPrice = toInt(input?.start_price);
  if (startPrice === null || startPrice < 1) errors.push('start_price must be positive integer');
  else if (startPrice > MAX_AUCTION_AMOUNT) errors.push('start_price too large');

  const minIncrement = toInt(input?.min_increment);
  if (minIncrement === null || minIncrement < 1) errors.push('min_increment must be positive integer');
  else if (minIncrement > MAX_AUCTION_AMOUNT) errors.push('min_increment too large');

  const startAt = toInt(input?.start_at);
  if (startAt === null || startAt <= 0) errors.push('invalid start_at');
  else if (startAt < now - 60) errors.push('start_at is in the past');

  const endAt = toInt(input?.end_at);
  if (endAt === null || endAt <= 0) errors.push('invalid end_at');
  else if (endAt < now + 60) errors.push('end_at must be at least 60 seconds in the future');
  else if (startAt !== null && startAt > 0 && endAt - startAt < 60) errors.push('auction duration must be at least 60 seconds');

  const antiSnipeRaw = input?.anti_snipe_seconds;
  let antiSnipe = 0;
  if (antiSnipeRaw !== null && antiSnipeRaw !== undefined && String(antiSnipeRaw).trim() !== '') {
    antiSnipe = toInt(antiSnipeRaw);
    if (antiSnipe === null || antiSnipe < 0 || antiSnipe > 600) {
      errors.push('anti_snipe_seconds must be between 0 and 600');
    }
  }

  if (errors.length) {
    const err = new Error(errors[0]);
    err.code = 'invalid_auction_input';
    err.errors = errors;
    throw err;
  }

  return {
    title,
    description: description || null,
    image_url: imageUrl || null,
    start_price: startPrice,
    min_increment: minIncrement,
    start_at: startAt,
    end_at: endAt,
    anti_snipe_seconds: antiSnipe,
  };
}

export async function createAuction(db, { input, createdBy = '', createdName = '', now = nowSeconds() } = {}) {
  const payload = normalizeAuctionCreateInput(input, { now });
  const insert = await db.run(
    `INSERT INTO auction_activities(title, description, image_url, start_price, min_increment,
       start_at, end_at, anti_snipe_seconds, status, created_by, created_name)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
    [payload.title, payload.description, payload.image_url, payload.start_price, payload.min_increment,
      payload.start_at, payload.end_at, payload.anti_snipe_seconds,
      createdBy || null, createdName || null],
  );
  const id = Number(insert?.lastID);
  if (!id) throw new Error('create auction failed');
  const row = await db.get('SELECT * FROM auction_activities WHERE id = ?', [id]);
  return serializeAuctionRow(row, { now });
}

async function refundHeldBidInTx(tx, bid, { reason, now }) {
  const marked = await tx.run(
    "UPDATE auction_bids SET state = 'refunded', settled_at = ? WHERE id = ? AND state = 'held'",
    [now, Number(bid.id)],
  );
  if (!marked?.changes) throw new Error('auction state inconsistent');
  const amount = Number(bid.amount);
  await tx.run(
    'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
    [String(bid.userid), amount, reason, buildBidRef(bid.activity_id, bid.id)],
  );
  await tx.run(
    'UPDATE accounts SET balance = balance + ?, updated_at = unixepoch() WHERE userid = ?',
    [amount, String(bid.userid)],
  );
  return { userid: String(bid.userid), amount };
}

// 用户重置/删除时清理其在押（held）出价。
// 调用方（purgeUserBusinessData）会在同一事务内清空该用户的 accounts 余额与 ledger 流水，
// 故此处不再退款入账（否则会被随后清零/删除，且删除用户时还会违反 ledger→users 外键）；
// 只把在押出价置为 refunded，并回退其所属竞拍的“当前最高价”指针，
// 避免后续结算/被超出退回时再次触碰已清理的用户（重复入账或结算卡死）。
// state 复用既有的 'refunded'（AUCTION_BID_STATES），不新增状态。
export async function purgeUserAuctionBids(tx, userids, { now = nowSeconds() } = {}) {
  const ids = (Array.isArray(userids) ? userids : [userids])
    .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
    .filter(Boolean);
  if (!ids.length) return { held_voided: 0, activities_reverted: 0 };
  const placeholders = ids.map(() => '?').join(',');

  const heldBids = await tx.all(
    `SELECT id, activity_id FROM auction_bids WHERE userid IN (${placeholders}) AND state = 'held'`,
    ids,
  );
  let activitiesReverted = 0;
  for (const bid of heldBids) {
    // 仅回退未结算/未取消、且当前最高价正指向该出价的竞拍：
    // 顶价出价被清理后应恢复到“无人出价”，下一次出价重新从起拍价起算。
    // eslint-disable-next-line no-await-in-loop
    const reverted = await tx.run(
      `UPDATE auction_activities
          SET current_price = NULL, current_bid_userid = NULL, current_bid_id = NULL
        WHERE id = ? AND current_bid_id = ? AND status NOT IN ('settled', 'cancelled')`,
      [Number(bid.activity_id), Number(bid.id)],
    );
    if (reverted?.changes) activitiesReverted += 1;
  }
  const voided = await tx.run(
    `UPDATE auction_bids SET state = 'refunded', settled_at = ?
      WHERE userid IN (${placeholders}) AND state = 'held'`,
    [now, ...ids],
  );
  return { held_voided: Number(voided?.changes || 0), activities_reverted: activitiesReverted };
}

export async function placeAuctionBid(db, {
  activityId,
  userid,
  name = '',
  amount,
  now = nowSeconds(),
} = {}) {
  const uid = userid ? String(userid).trim() : '';
  if (!uid) throw new Error('unauthorized');
  const id = toInt(activityId);
  if (id === null || id <= 0) throw new Error('invalid activity_id');
  const amt = toInt(amount);
  if (amt === null || amt <= 0 || amt > MAX_AUCTION_AMOUNT) throw new Error('invalid amount');

  return await runInTx(db, async (tx) => {
    const activity = await tx.get('SELECT * FROM auction_activities WHERE id = ? FOR UPDATE', [id]);
    if (!activity) throw new Error('auction not found');
    if (activity.status === 'cancelled') throw new Error('auction_cancelled');
    if (activity.status === 'settled') throw new Error('auction ended');
    const startAt = Number(activity.start_at || 0);
    const endAt = Number(activity.end_at || 0);
    if (now < startAt) throw new Error('not_started');
    if (now >= endAt) throw new Error('auction ended');

    const floor = computeNextBidFloor(activity);
    if (amt < floor) throw new Error('bid_too_low');
    if (activity.current_bid_userid && String(activity.current_bid_userid) === uid) {
      throw new Error('already_highest_bidder');
    }

    await ensureAccount(tx, { userid: uid, name });

    const prevBidId = activity.current_bid_id ? Number(activity.current_bid_id) : null;
    const prevBid = prevBidId
      ? await tx.get('SELECT * FROM auction_bids WHERE id = ?', [prevBidId])
      : null;
    if (prevBidId && (!prevBid || prevBid.state !== 'held' || Number(prevBid.activity_id) !== id)) {
      throw new Error('auction state inconsistent');
    }

    // 账户行按 userid 字典序加锁（与转账一致），避免与并发转账/其他出价交叉死锁。
    const lockIds = [...new Set([uid, prevBid ? String(prevBid.userid) : ''].filter(Boolean))]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const lockId of lockIds) {
      await tx.get('SELECT balance FROM accounts WHERE userid = ? FOR UPDATE', [lockId]);
    }

    // 1) 退回上一条在押出价（先退押再押新价，保持「至多一条 held」不变式）
    let refunded = null;
    if (prevBid) {
      refunded = await refundHeldBidInTx(tx, prevBid, { reason: 'auction_outbid_refund', now });
    }

    // 2) 冻结新出价：条件更新防超扣
    const updated = await tx.get(
      `UPDATE accounts
          SET balance = balance - ?, updated_at = unixepoch()
        WHERE userid = ?
          AND balance >= ?
        RETURNING balance`,
      [amt, uid, amt],
    );
    if (!updated) throw new Error('insufficient balance');
    const insert = await tx.run(
      `INSERT INTO auction_bids(activity_id, userid, user_name_snapshot, amount, state, created_at)
       VALUES(?, ?, ?, ?, 'held', ?)`,
      [id, uid, String(name || '').trim() || null, amt, now],
    );
    const bidId = Number(insert?.lastID);
    if (!bidId) throw new Error('create bid failed');
    await tx.run(
      'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
      [uid, -amt, 'auction_bid', buildBidRef(id, bidId)],
    );

    // 3) 更新活动当前价与结束时间（防狙击顺延）
    const { endAt: nextEndAt } = computeAntiSnipeEndAt(activity, now);
    await tx.run(
      `UPDATE auction_activities
          SET current_price = ?, current_bid_userid = ?, current_bid_id = ?,
              bid_count = bid_count + 1, status = 'active', end_at = ?
        WHERE id = ?`,
      [amt, uid, bidId, nextEndAt, id],
    );

    return {
      activity_id: id,
      bid_id: bidId,
      amount: amt,
      balance: Number(updated.balance ?? 0),
      end_at: Number(nextEndAt),
      refunded_to: refunded ? refunded.userid : null,
    };
  });
}

// 结算：时间到后首个读取者触发。获胜者冻结已扣，结算只做状态落定与
// 「释放冻结 + 成交扣款」的一对流水（净额为零），不改变任何余额。
export async function settleAuctionIfDue(db, { activityId, now = nowSeconds() } = {}) {
  const id = toInt(activityId);
  if (id === null || id <= 0) throw new Error('invalid activity_id');

  return await runInTx(db, async (tx) => {
    const activity = await tx.get('SELECT * FROM auction_activities WHERE id = ? FOR UPDATE', [id]);
    if (!activity) throw new Error('auction not found');
    if (activity.status === 'settled' || activity.status === 'cancelled') {
      return { activity, just_settled: false };
    }
    if (now < Number(activity.end_at || 0)) {
      return { activity, just_settled: false };
    }

    const winnerBidId = activity.current_bid_id ? Number(activity.current_bid_id) : null;
    let winnerBid = null;
    if (winnerBidId) {
      winnerBid = await tx.get("SELECT * FROM auction_bids WHERE id = ? AND state = 'held'", [winnerBidId]);
      if (!winnerBid) throw new Error('auction state inconsistent');
    }

    const winnerUserid = winnerBid ? String(winnerBid.userid) : null;
    const winnerName = winnerBid ? String(winnerBid.user_name_snapshot || winnerBid.userid || '') : null;
    const finalPrice = winnerBid ? Number(winnerBid.amount) : null;
    const claimed = await tx.run(
      `UPDATE auction_activities
          SET status = 'settled', winner_userid = ?, winner_name = ?, final_price = ?, settled_at = ?
        WHERE id = ? AND status IN ('scheduled', 'active')`,
      [winnerUserid, winnerName, finalPrice, now, id],
    );
    if (!claimed?.changes) {
      const fresh = await tx.get('SELECT * FROM auction_activities WHERE id = ?', [id]);
      return { activity: fresh, just_settled: false };
    }

    if (winnerBid) {
      const marked = await tx.run(
        "UPDATE auction_bids SET state = 'won', settled_at = ? WHERE id = ? AND state = 'held'",
        [now, Number(winnerBid.id)],
      );
      if (!marked?.changes) throw new Error('auction state inconsistent');
      const ref = buildBidRef(id, winnerBid.id);
      await tx.run(
        'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
        [winnerUserid, finalPrice, 'auction_settle_refund', ref],
      );
      await tx.run(
        'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
        [winnerUserid, -finalPrice, 'auction_win_pay', ref],
      );
      // 为获胜者生成领取凭证：复用 redeems 订单 + 核销二维码链路。
      // 货款已在出价时冻结、结算时转为成交扣款，此订单不产生任何资金变动；
      // exchange_id 全局唯一，配合结算条件更新天然幂等。
      try {
        await tx.run(
          `INSERT INTO redeems(exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at, limit_round)
           VALUES(?, ?, ?, ?, ?, NULL, 1)`,
          [buildAuctionExchangeId(id), winnerUserid, `AUCTION_${id}`, String(activity.title || `竞拍 #${id}`), finalPrice],
        );
      } catch (err) {
        if (String(err?.code || '') !== '23505') throw err;
        // 单号被占用属于脏数据（结算条件更新保证同场只会走到这里一次）。
        // 抛错回滚整个结算：活动保持 active、出价保持冻结，等待人工介入，
        // 绝不让"已扣款但没有领取凭证"的半结算状态落库。
        throw new Error('auction state inconsistent');
      }
    }

    const fresh = await tx.get('SELECT * FROM auction_activities WHERE id = ?', [id]);
    return {
      activity: fresh,
      just_settled: true,
      winner: winnerBid
        ? {
          userid: winnerUserid,
          name: winnerName,
          amount: finalPrice,
          bid_id: Number(winnerBid.id),
          redeem_exchange_id: buildAuctionExchangeId(id),
        }
        : null,
    };
  });
}

// 惰性状态推进：scheduled -> active（无资金变动），到点则结算。
// 返回 { row, settledWinner }，settledWinner 仅在本次调用完成结算且有获胜者时非空。
async function refreshAuctionRowState(db, row, { now }) {
  const status = String(row.status || 'scheduled');
  if (status === 'settled' || status === 'cancelled') return { row, settledWinner: null };
  if (now >= Number(row.end_at || 0)) {
    const settled = await settleAuctionIfDue(db, { activityId: row.id, now });
    return { row: settled.activity, settledWinner: settled.just_settled ? settled.winner : null };
  }
  if (status === 'scheduled' && now >= Number(row.start_at || 0)) {
    await db.run(
      "UPDATE auction_activities SET status = 'active' WHERE id = ? AND status = 'scheduled'",
      [Number(row.id)],
    );
    const fresh = await db.get('SELECT * FROM auction_activities WHERE id = ?', [Number(row.id)]);
    return { row: fresh, settledWinner: null };
  }
  return { row, settledWinner: null };
}

const AUCTION_LIST_SELECT = `
  SELECT a.*, COALESCE(NULLIF(u.name, ''), a.current_bid_userid, '') AS current_bidder_name
    FROM auction_activities a
    LEFT JOIN users u ON u.userid = a.current_bid_userid`;

export async function listAuctionActivitiesForMall(db, { now = nowSeconds(), limit = 20 } = {}) {
  const cap = Math.min(50, Math.max(1, toInt(limit) || 20));
  const rows = await db.all(
    `${AUCTION_LIST_SELECT}
      WHERE a.status <> 'cancelled'
        AND (a.status <> 'settled' OR a.settled_at >= ?)
      ORDER BY CASE WHEN a.status = 'active' THEN 0 WHEN a.status = 'scheduled' THEN 1 ELSE 2 END,
               a.start_at ASC, a.id DESC
      LIMIT ?`,
    [now - 48 * 3600, cap],
  );
  const out = [];
  const settledWinners = [];
  for (const row of rows || []) {
    // eslint-disable-next-line no-await-in-loop
    const refreshed = await refreshAuctionRowState(db, row, { now });
    if (refreshed.row !== row) {
      // eslint-disable-next-line no-await-in-loop
      const fresh = await db.get(`${AUCTION_LIST_SELECT} WHERE a.id = ?`, [Number(row.id)]);
      out.push(serializeAuctionRow(fresh || refreshed.row, { now, includeBidderUserid: false }));
    } else {
      out.push(serializeAuctionRow(row, { now, includeBidderUserid: false }));
    }
    if (refreshed.settledWinner) settledWinners.push({ activity_id: Number(row.id), ...refreshed.settledWinner });
  }
  return { list: out, settledWinners };
}

export async function getAuctionDetailForMall(db, { activityId, now = nowSeconds() } = {}) {
  const id = toInt(activityId);
  if (id === null || id <= 0) throw new Error('invalid activity_id');
  const row = await db.get(`${AUCTION_LIST_SELECT} WHERE a.id = ?`, [id]);
  if (!row) throw new Error('auction not found');
  const refreshed = await refreshAuctionRowState(db, row, { now });
  const finalRow = refreshed.row !== row
    ? await db.get(`${AUCTION_LIST_SELECT} WHERE a.id = ?`, [id])
    : row;
  const bids = await db.all(
    `SELECT b.id, b.userid, b.user_name_snapshot, b.amount, b.state, b.created_at,
            COALESCE(NULLIF(u.name, ''), b.user_name_snapshot, b.userid, '') AS display_name
       FROM auction_bids b
       LEFT JOIN users u ON u.userid = b.userid
      WHERE b.activity_id = ?
      ORDER BY b.id DESC
      LIMIT 30`,
    [id],
  );
  const serialized = serializeAuctionRow(finalRow, { now, includeBidderUserid: false });
  serialized.bids = (bids || []).map((bid) => ({
    id: Number(bid.id),
    display_name: String(bid.display_name || ''),
    amount: Number(bid.amount),
    state: String(bid.state || ''),
    created_at: Number(bid.created_at || 0),
  }));
  return {
    activity: serialized,
    settledWinner: refreshed.settledWinner
      ? { activity_id: id, ...refreshed.settledWinner }
      : null,
  };
}

export async function getMyAuctionBidForActivity(db, { activityId, userid }) {
  const uid = userid ? String(userid) : '';
  if (!uid) return null;
  const row = await db.get(
    'SELECT id, amount, state, created_at FROM auction_bids WHERE activity_id = ? AND userid = ? ORDER BY id DESC LIMIT 1',
    [toInt(activityId), uid],
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    amount: Number(row.amount),
    state: String(row.state || ''),
    created_at: Number(row.created_at || 0),
  };
}

export async function listMyAuctionBids(db, { userid, limit = 50, now = nowSeconds() } = {}) {
  const uid = userid ? String(userid) : '';
  if (!uid) throw new Error('unauthorized');
  const cap = Math.min(100, Math.max(1, toInt(limit) || 50));
  const rows = await db.all(
    `SELECT b.id, b.activity_id, b.amount, b.state, b.created_at,
            a.title, a.status AS activity_status, a.image_url, a.start_at, a.end_at,
            a.winner_userid, a.winner_name, a.final_price, a.settled_at
       FROM auction_bids b
       JOIN auction_activities a ON a.id = b.activity_id
      WHERE b.userid = ?
      ORDER BY b.id DESC
      LIMIT ?`,
    [uid, cap],
  );
  const heldRow = await db.get(
    "SELECT COALESCE(SUM(amount), 0) AS held_total, COUNT(1) AS held_count FROM auction_bids WHERE userid = ? AND state = 'held'",
    [uid],
  );
  return {
    bids: (rows || []).map((row) => ({
      id: Number(row.id),
      activity_id: Number(row.activity_id),
      title: String(row.title || ''),
      image_url: row.image_url ? String(row.image_url) : '',
      amount: Number(row.amount),
      state: String(row.state || ''),
      created_at: Number(row.created_at || 0),
      // 推导展示状态：DB status 可能滞后（结算调度 5s 窗口），到期未结算显示 settling
      activity_status: resolveAuctionDisplayStatus({
        status: row.activity_status,
        start_at: row.start_at,
        end_at: row.end_at,
      }, now),
      end_at: Number(row.end_at || 0),
      winner_name: row.winner_name ? String(row.winner_name) : '',
      final_price: row.final_price === null || row.final_price === undefined ? null : Number(row.final_price),
      settled_at: row.settled_at === null || row.settled_at === undefined ? null : Number(row.settled_at),
    })),
    held_total: Number(heldRow?.held_total ?? 0),
    held_count: Number(heldRow?.held_count ?? 0),
  };
}

export async function listAuctionActivitiesForAdmin(db, { now = nowSeconds(), status = '', limit = 50 } = {}) {
  const cap = Math.min(200, Math.max(1, toInt(limit) || 50));
  const statusFilter = String(status || '').trim();
  const allowed = ['scheduled', 'active', 'settled', 'cancelled'];
  const params = [];
  let where = '';
  if (statusFilter && allowed.includes(statusFilter)) {
    where = 'WHERE a.status = ?';
    params.push(statusFilter);
  }
  const rows = await db.all(
    `${AUCTION_LIST_SELECT} ${where} ORDER BY a.id DESC LIMIT ?`,
    [...params, cap],
  );
  const out = [];
  const settledWinners = [];
  for (const row of rows || []) {
    // eslint-disable-next-line no-await-in-loop
    const refreshed = await refreshAuctionRowState(db, row, { now });
    if (refreshed.row !== row) {
      // eslint-disable-next-line no-await-in-loop
      const fresh = await db.get(`${AUCTION_LIST_SELECT} WHERE a.id = ?`, [Number(row.id)]);
      out.push(serializeAuctionRow(fresh || refreshed.row, { now }));
    } else {
      out.push(serializeAuctionRow(row, { now }));
    }
    if (refreshed.settledWinner) settledWinners.push({ activity_id: Number(row.id), ...refreshed.settledWinner });
  }
  return { list: out, settledWinners };
}

export async function getAuctionDetailForAdmin(db, { activityId, now = nowSeconds() } = {}) {
  const id = toInt(activityId);
  if (id === null || id <= 0) throw new Error('invalid activity_id');
  const row = await db.get(`${AUCTION_LIST_SELECT} WHERE a.id = ?`, [id]);
  if (!row) throw new Error('auction not found');
  const refreshed = await refreshAuctionRowState(db, row, { now });
  const finalRow = refreshed.row !== row
    ? await db.get(`${AUCTION_LIST_SELECT} WHERE a.id = ?`, [id])
    : row;
  const bids = await db.all(
    `SELECT b.id, b.userid, b.user_name_snapshot, b.amount, b.state, b.created_at, b.settled_at,
            COALESCE(NULLIF(u.name, ''), b.user_name_snapshot, b.userid, '') AS display_name
       FROM auction_bids b
       LEFT JOIN users u ON u.userid = b.userid
      WHERE b.activity_id = ?
      ORDER BY b.id DESC
      LIMIT 200`,
    [id],
  );
  const serialized = serializeAuctionRow(finalRow, { now });
  serialized.bids = (bids || []).map((bid) => ({
    id: Number(bid.id),
    userid: String(bid.userid || ''),
    display_name: String(bid.display_name || ''),
    amount: Number(bid.amount),
    state: String(bid.state || ''),
    created_at: Number(bid.created_at || 0),
    settled_at: bid.settled_at === null || bid.settled_at === undefined ? null : Number(bid.settled_at),
  }));
  return {
    activity: serialized,
    settledWinner: refreshed.settledWinner
      ? { activity_id: id, ...refreshed.settledWinner }
      : null,
  };
}

export async function cancelAuction(db, { activityId, reason = '', now = nowSeconds() } = {}) {
  const id = toInt(activityId);
  if (id === null || id <= 0) throw new Error('invalid activity_id');
  const cleanReason = String(reason || '').trim().slice(0, 200);

  return await runInTx(db, async (tx) => {
    const activity = await tx.get('SELECT * FROM auction_activities WHERE id = ? FOR UPDATE', [id]);
    if (!activity) throw new Error('auction not found');
    if (activity.status === 'cancelled') throw new Error('auction_already_cancelled');
    if (activity.status === 'settled') throw new Error('auction_already_settled');
    // 已过 end_at 的竞拍视同已结束：最高出价人已锁定胜利，不允许通过取消剥夺。
    if (now >= Number(activity.end_at || 0)) throw new Error('auction_already_settled');

    const heldBidId = activity.current_bid_id ? Number(activity.current_bid_id) : null;
    let refunded = null;
    if (heldBidId) {
      const heldBid = await tx.get("SELECT * FROM auction_bids WHERE id = ? AND state = 'held'", [heldBidId]);
      if (!heldBid) throw new Error('auction state inconsistent');
      refunded = await refundHeldBidInTx(tx, heldBid, { reason: 'auction_cancel_refund', now });
    }

    const claimed = await tx.run(
      `UPDATE auction_activities
          SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
        WHERE id = ? AND status IN ('scheduled', 'active')`,
      [now, cleanReason || null, id],
    );
    if (!claimed?.changes) throw new Error('auction state inconsistent');

    const fresh = await tx.get('SELECT * FROM auction_activities WHERE id = ?', [id]);
    return { activity: serializeAuctionRow(fresh, { now }), refunded };
  });
}
