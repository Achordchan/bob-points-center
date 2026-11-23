// 年会（gala）业务：活动、奖池、参与名单、服务端抽签、幂等发币、预留名额。
//
// 不变式：
// - 抽签只在服务端发生（crypto.randomInt），结果先落库再展示，大屏刷新不会改变结果。
// - 发币以 gala_round_winners.awarded_at 为幂等闸门：同一中奖记录无论点多少次“发币”，只写一次账本。
// - 每笔发币在同一事务里条件扣减奖池 spent（spent + amount <= budget），超预算整笔回滚。
// - 预留名额是本轮正常名额之外的额外名额，奖励只能来自预留奖池；被预留的人不参与本活动的正常抽签，
//   因此不会占用员工的中奖名额。预留信息只对超级管理员返回。
import crypto from 'node:crypto';
import { grantBob } from './ledgerService.js';

// 年会环节目录。每场活动可在后台启停（enabled_segments），停用的环节不能抽签，大屏与手机端也不展示。
export const GALA_SEGMENTS = {
  checkin: '扫码签到',
  lottery: '抽奖',
  giveaway: 'BOB币大放送',
  game: '游戏抽取',
  punishment: '惩罚抽取',
  quiz: '趣味问答',
  song: '点歌挑战',
  wheel: '幸运转盘',
  redpacket: '红包雨',
  danmaku: '弹幕上墙',
  skyline: '扫码盖楼',
  vote: '节目投票打赏',
  auction: '年会竞拍',
  custom: '其他环节',
};

// 会产生“轮次 + 中奖人”的环节；其余环节有各自的玩法表，不走 drawGalaRound。
export const GALA_DRAW_SEGMENTS = new Set(['lottery', 'giveaway', 'game', 'quiz', 'song', 'wheel', 'skyline', 'custom']);

function parseEnabledSegments(raw) {
  try {
    const list = JSON.parse(String(raw || '[]'));
    return Array.isArray(list) ? list.filter((k) => Object.hasOwn(GALA_SEGMENTS, k)) : [];
  } catch {
    return [];
  }
}

function normalizeEnabledSegments(input) {
  if (!Array.isArray(input)) throw new GalaError('invalid_enabled_segments');
  const list = [...new Set(input.map((k) => String(k || '').trim()))];
  if (list.some((k) => !Object.hasOwn(GALA_SEGMENTS, k))) throw new GalaError('invalid_enabled_segments');
  return list;
}

const EVENT_STATUSES = new Set(['draft', 'live', 'ended']);
const MAX_DRAW_COUNT = 100;
const MAX_TITLE_LENGTH = 80;

export class GalaError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

function toPositiveId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toNonNegativeInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function cleanText(value, max = MAX_TITLE_LENGTH) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

function requireSegment(segment) {
  const key = cleanText(segment, 32);
  if (!Object.hasOwn(GALA_SEGMENTS, key)) throw new GalaError('invalid_segment');
  return key;
}

async function inTx(db, fn) {
  if (db?.__txScoped === true) return await fn(db);
  return await db.transaction(fn);
}

/** 均匀随机抽取 count 个（部分 Fisher-Yates），使用 CSPRNG。 */
export function pickRandom(list, count, randomInt = crypto.randomInt) {
  const arr = [...list];
  const take = Math.min(Math.max(0, count), arr.length);
  for (let i = 0; i < take; i += 1) {
    const j = i + randomInt(arr.length - i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, take);
}

function serializeEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: row.title,
    event_date: row.event_date || '',
    status: row.status,
    total_budget: Number(row.total_budget || 0),
    enabled_segments: parseEnabledSegments(row.enabled_segments),
    created_by: row.created_by || '',
    created_name: row.created_name || '',
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function serializePool(row) {
  const budget = Number(row.budget || 0);
  const spent = Number(row.spent || 0);
  return {
    id: Number(row.id),
    event_id: Number(row.event_id),
    name: row.name,
    sponsor: row.sponsor || '',
    budget,
    spent,
    remaining: budget - spent,
    is_reserved: Number(row.is_reserved) === 1 ? 1 : 0,
  };
}

// 非超管视图不带任何逐人的发放信息（金额、是否已发、失败原因、奖池）。预留名额的金额、奖池、
// 发放结果都可能与同轮其他人不同，只要逐人展示就能被认出来；员工侧只需要知道谁中了。
function serializeWinner(row, { includeReserved }) {
  const out = {
    id: Number(row.id),
    userid: row.userid,
    name: row.name_snapshot || row.userid,
    display_order: Number(row.display_order || 0),
  };
  if (includeReserved) {
    out.amount = Number(row.amount || 0);
    out.awarded = row.awarded_at ? 1 : 0;
    out.awarded_at = row.awarded_at ? Number(row.awarded_at) : null;
    out.award_error = row.award_error || '';
    out.is_reserved = Number(row.is_reserved) === 1 ? 1 : 0;
    out.pool_id = row.pool_id ? Number(row.pool_id) : null;
  }
  return out;
}

// 非超管看到的轮次状态只由普通中奖记录决定，预留名额发放成功与否不影响它。
function publicRoundStatus(row, winners) {
  const visible = (winners || []).filter((w) => Number(w.is_reserved) !== 1 && Number(w.amount) > 0);
  if (visible.length === 0) {
    return { status: row.status, granted_at: row.granted_at ? Number(row.granted_at) : null };
  }
  const pending = visible.filter((w) => !w.awarded_at);
  if (pending.length > 0) return { status: 'drawn', granted_at: null };
  const grantedAt = Math.max(...visible.map((w) => Number(w.awarded_at)));
  return { status: 'granted', granted_at: grantedAt };
}

function serializeRound(row, winners, { includeReserved }) {
  const sorted = (winners || []).slice().sort((a, b) => Number(a.display_order) - Number(b.display_order));
  const state = includeReserved
    ? { status: row.status, granted_at: row.granted_at ? Number(row.granted_at) : null }
    : publicRoundStatus(row, sorted);
  return {
    id: Number(row.id),
    event_id: Number(row.event_id),
    segment: row.segment,
    segment_label: GALA_SEGMENTS[row.segment] || row.segment,
    round_no: Number(row.round_no),
    title: row.title || '',
    prize_type: row.prize_type,
    pool_id: row.pool_id ? Number(row.pool_id) : null,
    amount_each: Number(row.amount_each || 0),
    // 非超管看到的抽取人数就是名单人数，避免“请求 N 人、出来 N+1 人”暴露本轮有预留名额。
    draw_count: includeReserved ? Number(row.draw_count) : sorted.length,
    status: state.status,
    created_by: row.created_by || '',
    created_name: row.created_name || '',
    created_at: Number(row.created_at),
    granted_at: state.granted_at,
    winners: sorted.map((w) => serializeWinner(w, { includeReserved })),
  };
}

// ---------------------------------------------------------------- 活动

export async function createGalaEvent(db, { title, eventDate, totalBudget, enabledSegments, actor = {} }) {
  const cleanTitle = cleanText(title);
  if (!cleanTitle) throw new GalaError('title_required');
  const budget = totalBudget === undefined || totalBudget === null || totalBudget === '' ? 0 : toNonNegativeInt(totalBudget);
  if (budget === null) throw new GalaError('invalid_total_budget');
  const segments = enabledSegments === undefined ? Object.keys(GALA_SEGMENTS) : normalizeEnabledSegments(enabledSegments);
  const row = await db.get(
    `INSERT INTO gala_events(title, event_date, total_budget, enabled_segments, created_by, created_name)
     VALUES(?, ?, ?, ?, ?, ?) RETURNING *`,
    [cleanTitle, cleanText(eventDate, 32) || null, budget, JSON.stringify(segments), actor.userid || null, actor.name || null],
  );
  return serializeEvent(row);
}

export async function updateGalaEvent(db, { eventId, title, eventDate, totalBudget, status, enabledSegments }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  return await inTx(db, async (tx) => {
    const current = await tx.get('SELECT * FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    if (!current) throw new GalaError('event_not_found', 404);
    const next = {
      title: title === undefined ? current.title : cleanText(title),
      event_date: eventDate === undefined ? current.event_date : (cleanText(eventDate, 32) || null),
      total_budget: totalBudget === undefined ? Number(current.total_budget) : toNonNegativeInt(totalBudget),
      status: status === undefined ? current.status : cleanText(status, 16),
      enabled_segments: enabledSegments === undefined
        ? parseEnabledSegments(current.enabled_segments)
        : normalizeEnabledSegments(enabledSegments),
    };
    if (!next.title) throw new GalaError('title_required');
    if (next.total_budget === null) throw new GalaError('invalid_total_budget');
    if (!EVENT_STATUSES.has(next.status)) throw new GalaError('invalid_status');
    if (next.total_budget > 0) {
      const sum = await tx.get(
        'SELECT COALESCE(SUM(budget), 0) AS total FROM gala_pools WHERE event_id = ? AND is_reserved = 0',
        [id],
      );
      if (Number(sum?.total || 0) > next.total_budget) {
        throw new GalaError('pools_exceed_total_budget', 409, { pools_total: Number(sum.total) });
      }
    }
    const row = await tx.get(
      `UPDATE gala_events SET title = ?, event_date = ?, total_budget = ?, status = ?, enabled_segments = ?,
              updated_at = unixepoch()
       WHERE id = ? RETURNING *`,
      [next.title, next.event_date, next.total_budget, next.status, JSON.stringify(next.enabled_segments), id],
    );
    return serializeEvent(row);
  });
}

export async function listGalaEvents(db) {
  const rows = await db.all('SELECT * FROM gala_events ORDER BY id DESC LIMIT 100');
  return rows.map(serializeEvent);
}

export async function getGalaEventDetail(db, { eventId, includeReserved = false }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const event = await db.get('SELECT * FROM gala_events WHERE id = ?', [id]);
  if (!event) throw new GalaError('event_not_found', 404);
  const pools = await db.all(
    `SELECT * FROM gala_pools WHERE event_id = ? ${includeReserved ? '' : 'AND is_reserved = 0'} ORDER BY id`,
    [id],
  );
  const counts = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM gala_participants WHERE event_id = ?) AS participants,
       (SELECT COUNT(*) FROM gala_rounds WHERE event_id = ?) AS rounds`,
    [id, id],
  );
  const visiblePools = pools.map(serializePool);
  const publicPools = visiblePools.filter((p) => p.is_reserved === 0);
  return {
    ...serializeEvent(event),
    pools: visiblePools,
    budget_summary: {
      total_budget: Number(event.total_budget || 0),
      pools_budget: publicPools.reduce((s, p) => s + p.budget, 0),
      pools_spent: publicPools.reduce((s, p) => s + p.spent, 0),
    },
    participant_count: Number(counts?.participants || 0),
    round_count: Number(counts?.rounds || 0),
  };
}

// ---------------------------------------------------------------- 奖池

export async function createGalaPool(db, { eventId, name, sponsor, budget, reserved = false }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const cleanName = cleanText(name, 40);
  if (!cleanName) throw new GalaError('pool_name_required');
  const amount = toNonNegativeInt(budget);
  if (amount === null) throw new GalaError('invalid_budget');
  return await inTx(db, async (tx) => {
    const event = await tx.get('SELECT * FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    if (!event) throw new GalaError('event_not_found', 404);
    if (!reserved && Number(event.total_budget) > 0) {
      const sum = await tx.get(
        'SELECT COALESCE(SUM(budget), 0) AS total FROM gala_pools WHERE event_id = ? AND is_reserved = 0',
        [id],
      );
      if (Number(sum?.total || 0) + amount > Number(event.total_budget)) {
        throw new GalaError('pools_exceed_total_budget', 409);
      }
    }
    const row = await tx.get(
      `INSERT INTO gala_pools(event_id, name, sponsor, budget, is_reserved)
       VALUES(?, ?, ?, ?, ?) RETURNING *`,
      [id, cleanName, cleanText(sponsor, 40) || null, amount, reserved ? 1 : 0],
    );
    return serializePool(row);
  });
}

export async function updateGalaPool(db, { poolId, name, sponsor, budget, allowReserved = false }) {
  const id = toPositiveId(poolId);
  if (!id) throw new GalaError('invalid_pool_id');
  return await inTx(db, async (tx) => {
    // 加锁顺序与抽签一致：先活动、后奖池。抽签持有活动锁后插入轮次会对奖池加 KEY SHARE，
    // 若这里先锁奖池再等活动，两者会互相等待而死锁。
    const ref = await tx.get('SELECT event_id FROM gala_pools WHERE id = ?', [id]);
    if (!ref) throw new GalaError('pool_not_found', 404);
    const event = await tx.get('SELECT * FROM gala_events WHERE id = ? FOR UPDATE', [ref.event_id]);
    const pool = await tx.get('SELECT * FROM gala_pools WHERE id = ? FOR UPDATE', [id]);
    if (!pool || (Number(pool.is_reserved) === 1 && !allowReserved)) throw new GalaError('pool_not_found', 404);
    const nextBudget = budget === undefined ? Number(pool.budget) : toNonNegativeInt(budget);
    if (nextBudget === null) throw new GalaError('invalid_budget');
    if (nextBudget < Number(pool.spent)) throw new GalaError('budget_below_spent', 409, { spent: Number(pool.spent) });
    if (Number(pool.is_reserved) === 0 && Number(event?.total_budget) > 0) {
      const sum = await tx.get(
        'SELECT COALESCE(SUM(budget), 0) AS total FROM gala_pools WHERE event_id = ? AND is_reserved = 0 AND id <> ?',
        [pool.event_id, id],
      );
      if (Number(sum?.total || 0) + nextBudget > Number(event.total_budget)) {
        throw new GalaError('pools_exceed_total_budget', 409);
      }
    }
    const nextName = name === undefined ? pool.name : cleanText(name, 40);
    if (!nextName) throw new GalaError('pool_name_required');
    const row = await tx.get(
      `UPDATE gala_pools SET name = ?, sponsor = ?, budget = ?, updated_at = unixepoch() WHERE id = ? RETURNING *`,
      [nextName, sponsor === undefined ? pool.sponsor : (cleanText(sponsor, 40) || null), nextBudget, id],
    );
    return serializePool(row);
  });
}

// ---------------------------------------------------------------- 参与名单

export async function addGalaParticipants(db, { eventId, userids = [], allActiveDingtalk = false, tableNo = null }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const event = await db.get('SELECT id FROM gala_events WHERE id = ?', [id]);
  if (!event) throw new GalaError('event_not_found', 404);
  const table = tableNo === null || tableNo === undefined || tableNo === '' ? null : toPositiveId(tableNo);
  if (allActiveDingtalk) {
    const result = await db.run(
      `INSERT INTO gala_participants(event_id, userid, name_snapshot, source)
       SELECT ?, u.userid, COALESCE(NULLIF(p.name, ''), u.name), 'admin'
         FROM users u
         JOIN user_dingtalk_profiles p ON p.userid = u.userid
        WHERE p.active = 1 AND u.source = 'dingtalk'
       ON CONFLICT (event_id, userid) DO NOTHING`,
      [id],
    );
    return { added: result.changes, missing: [] };
  }
  const list = [...new Set((Array.isArray(userids) ? userids : []).map((x) => cleanText(x, 128)).filter(Boolean))];
  if (list.length === 0) throw new GalaError('userids_required');
  if (list.length > 2000) throw new GalaError('too_many_userids');
  const found = await db.all('SELECT userid, name FROM users WHERE userid = ANY(?::text[])', [list]);
  const foundSet = new Set(found.map((r) => r.userid));
  let added = 0;
  for (const user of found) {
    const r = await db.run(
      `INSERT INTO gala_participants(event_id, userid, name_snapshot, table_no, source)
       VALUES(?, ?, ?, ?, 'admin')
       ON CONFLICT (event_id, userid) DO NOTHING`,
      [id, user.userid, user.name || user.userid, table],
    );
    added += r.changes;
  }
  return { added, missing: list.filter((u) => !foundSet.has(u)) };
}

export async function removeGalaParticipant(db, { eventId, userid }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const r = await db.run('DELETE FROM gala_participants WHERE event_id = ? AND userid = ?', [id, cleanText(userid, 128)]);
  return { removed: r.changes };
}

export async function listGalaParticipants(db, { eventId }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const rows = await db.all(
    `SELECT userid, name_snapshot, table_no, source, joined_at
       FROM gala_participants WHERE event_id = ? ORDER BY id`,
    [id],
  );
  return rows.map((r) => ({
    userid: r.userid,
    name: r.name_snapshot || r.userid,
    table_no: r.table_no === null ? null : Number(r.table_no),
    source: r.source,
    joined_at: Number(r.joined_at),
  }));
}

// ---------------------------------------------------------------- 抽签

export async function drawGalaRound(db, {
  eventId,
  segment,
  title,
  drawCount,
  prizeType = 'none',
  poolId = null,
  amountEach = 0,
  excludePreviousWinners = true,
  actor = {},
  randomInt = crypto.randomInt,
}) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const seg = requireSegment(segment);
  if (!GALA_DRAW_SEGMENTS.has(seg)) throw new GalaError('segment_not_drawable');
  const count = Number(drawCount);
  if (!Number.isInteger(count) || count < 1 || count > MAX_DRAW_COUNT) throw new GalaError('invalid_draw_count');
  if (!['none', 'coin'].includes(prizeType)) throw new GalaError('invalid_prize_type');
  const amount = prizeType === 'coin' ? toNonNegativeInt(amountEach) : 0;
  if (prizeType === 'coin' && (!amount || amount <= 0)) throw new GalaError('invalid_amount_each');

  return await inTx(db, async (tx) => {
    // 锁活动行：同一活动的抽签串行，轮次号与“已中奖排除”不会被并发抽签打乱。
    const event = await tx.get('SELECT * FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    if (!event) throw new GalaError('event_not_found', 404);
    if (event.status === 'ended') throw new GalaError('event_ended', 409);
    if (!parseEnabledSegments(event.enabled_segments).includes(seg)) throw new GalaError('segment_disabled', 409);

    let pool = null;
    if (prizeType === 'coin') {
      const pid = toPositiveId(poolId);
      if (!pid) throw new GalaError('pool_required');
      pool = await tx.get('SELECT * FROM gala_pools WHERE id = ? AND event_id = ? AND is_reserved = 0', [pid, id]);
      if (!pool) throw new GalaError('pool_not_found', 404);
    }

    const last = await tx.get(
      'SELECT COALESCE(MAX(round_no), 0) AS n FROM gala_rounds WHERE event_id = ? AND segment = ?',
      [id, seg],
    );
    const roundNo = Number(last?.n || 0) + 1;

    const eligibleRows = await tx.all(
      `SELECT p.userid, p.name_snapshot
         FROM gala_participants p
        WHERE p.event_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM gala_reserved_slots r
             WHERE r.event_id = p.event_id AND r.userid = p.userid AND r.status <> 'cancelled')
          ${excludePreviousWinners ? `AND NOT EXISTS (
            SELECT 1 FROM gala_round_winners w JOIN gala_rounds gr ON gr.id = w.round_id
             WHERE w.event_id = p.event_id AND w.userid = p.userid AND gr.segment = ?)` : ''}
        ORDER BY p.id`,
      excludePreviousWinners ? [id, seg] : [id],
    );
    const picked = pickRandom(eligibleRows, count, randomInt);

    const slot = await tx.get(
      `SELECT s.*, u.name AS user_name FROM gala_reserved_slots s JOIN users u ON u.userid = s.userid
        WHERE s.event_id = ? AND s.segment = ? AND s.round_no = ? AND s.status = 'pending'
        FOR UPDATE OF s`,
      [id, seg, roundNo],
    );

    if (picked.length === 0 && !slot) throw new GalaError('no_eligible_participants', 409);

    if (pool) {
      const remaining = Number(pool.budget) - Number(pool.spent);
      if (remaining < amount * picked.length) {
        throw new GalaError('pool_budget_insufficient', 409, { remaining, required: amount * picked.length });
      }
    }

    const winners = picked.map((p) => ({
      userid: p.userid,
      name: p.name_snapshot || p.userid,
      poolId: pool ? Number(pool.id) : null,
      amount,
      reserved: 0,
    }));
    if (slot) {
      winners.push({
        userid: slot.userid,
        name: slot.user_name || slot.userid,
        poolId: slot.pool_id ? Number(slot.pool_id) : null,
        amount: Number(slot.amount || 0),
        reserved: 1,
      });
    }
    // 展示顺序整体随机，预留名额不会固定出现在末位。
    const order = pickRandom(winners.map((_, i) => i), winners.length, randomInt);

    const round = await tx.get(
      `INSERT INTO gala_rounds(event_id, segment, round_no, title, prize_type, pool_id, amount_each, draw_count, created_by, created_name)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [id, seg, roundNo, cleanText(title) || null, prizeType, pool ? pool.id : null, amount, count,
        actor.userid || null, actor.name || null],
    );
    const inserted = [];
    for (let pos = 0; pos < order.length; pos += 1) {
      const w = winners[order[pos]];
      const row = await tx.get(
        `INSERT INTO gala_round_winners(round_id, event_id, userid, name_snapshot, display_order, pool_id, amount, is_reserved)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        [round.id, id, w.userid, w.name, pos + 1, w.poolId, w.amount, w.reserved],
      );
      inserted.push(row);
    }
    if (slot) {
      await tx.run(
        `UPDATE gala_reserved_slots SET status = 'used', used_round_id = ?, updated_at = unixepoch() WHERE id = ?`,
        [round.id, slot.id],
      );
    }
    return { round, winners: inserted, eligibleCount: eligibleRows.length };
  });
}

export async function listGalaRounds(db, { eventId, includeReserved = false, limit = 200 }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const rounds = await db.all('SELECT * FROM gala_rounds WHERE event_id = ? ORDER BY id DESC LIMIT ?', [id, limit]);
  if (rounds.length === 0) return [];
  const winners = await db.all(
    'SELECT * FROM gala_round_winners WHERE round_id = ANY(?::bigint[]) ORDER BY id',
    [rounds.map((r) => Number(r.id))],
  );
  const byRound = new Map();
  for (const w of winners) {
    const key = Number(w.round_id);
    if (!byRound.has(key)) byRound.set(key, []);
    byRound.get(key).push(w);
  }
  return rounds.map((r) => serializeRound(r, byRound.get(Number(r.id)), { includeReserved }));
}

export function serializeDrawResult(result, { includeReserved = false } = {}) {
  return {
    ...serializeRound(result.round, result.winners, { includeReserved }),
    eligible_count: result.eligibleCount,
  };
}

// ---------------------------------------------------------------- 发币

async function awardWinner(db, { winnerId, reason }) {
  return await db.transaction(async (tx) => {
    const claimed = await tx.get(
      `UPDATE gala_round_winners SET awarded_at = unixepoch(), award_error = NULL
        WHERE id = ? AND awarded_at IS NULL AND amount > 0
        RETURNING id, event_id, userid, name_snapshot, pool_id, amount, is_reserved`,
      [winnerId],
    );
    if (!claimed) return { skipped: true };
    const amount = Number(claimed.amount);
    // 每一笔正数奖励都必须从同一活动、且类型一致的奖池扣减：普通中奖扣员工奖池，预留名额扣预留奖池。
    // 抽签与预留名额只会产生这种记录，这里再兜底一次，防止残缺或被篡改的备份导入后在预算之外发币，
    // 或把预留奖励记到员工奖池上。
    if (!claimed.pool_id) throw new GalaError('winner_pool_missing', 409);
    const reservedFlag = Number(claimed.is_reserved) === 1 ? 1 : 0;
    const pool = await tx.get(
      `UPDATE gala_pools SET spent = spent + ?, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND is_reserved = ? AND spent + ? <= budget
        RETURNING id`,
      [amount, claimed.pool_id, claimed.event_id, reservedFlag, amount],
    );
    if (!pool) {
      const exists = await tx.get(
        'SELECT 1 AS x FROM gala_pools WHERE id = ? AND event_id = ? AND is_reserved = ?',
        [claimed.pool_id, claimed.event_id, reservedFlag],
      );
      throw new GalaError(exists ? 'pool_budget_exceeded' : 'winner_pool_missing', 409);
    }
    const granted = await grantBob(tx, {
      userid: claimed.userid,
      name: claimed.name_snapshot,
      amount,
      reason,
      refId: `GALA_W${claimed.id}`,
    });
    await tx.run('UPDATE gala_round_winners SET ledger_id = ? WHERE id = ?', [granted.ledgerId, claimed.id]);
    return { skipped: false, userid: claimed.userid, amount, balance: granted.balance };
  });
}

export async function grantGalaRound(db, { roundId }) {
  const id = toPositiveId(roundId);
  if (!id) throw new GalaError('invalid_round_id');
  const round = await db.get('SELECT * FROM gala_rounds WHERE id = ?', [id]);
  if (!round) throw new GalaError('round_not_found', 404);
  const winners = await db.all(
    'SELECT * FROM gala_round_winners WHERE round_id = ? AND awarded_at IS NULL AND amount > 0 ORDER BY display_order',
    [id],
  );
  const label = GALA_SEGMENTS[round.segment] || round.segment;
  const reason = `年会奖励·${round.title || label}·第${round.round_no}轮`;
  const granted = [];
  const failed = [];
  for (const w of winners) {
    const reserved = Number(w.is_reserved) === 1 ? 1 : 0;
    try {
      const r = await awardWinner(db, { winnerId: w.id, reason });
      if (!r.skipped) granted.push({ userid: r.userid, amount: r.amount, is_reserved: reserved });
    } catch (err) {
      const code = String(err?.code || err?.message || err);
      failed.push({ userid: w.userid, error: code, is_reserved: reserved });
      await db.run('UPDATE gala_round_winners SET award_error = ? WHERE id = ? AND awarded_at IS NULL', [code, w.id]);
    }
  }
  const pending = await db.get(
    `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE is_reserved = 0) AS public_n
       FROM gala_round_winners WHERE round_id = ? AND awarded_at IS NULL AND amount > 0`,
    [id],
  );
  if (Number(pending?.n || 0) === 0 && round.status !== 'granted') {
    await db.run(`UPDATE gala_rounds SET status = 'granted', granted_at = unixepoch() WHERE id = ? AND status = 'drawn'`, [id]);
  }
  return {
    round_id: id,
    granted,
    failed,
    pending: Number(pending?.n || 0),
    pendingPublic: Number(pending?.public_n || 0),
  };
}

// 发放结果对外只给发放回执，不含账户余额（余额属于用户资料，需要单独的查看权限）。
// 非超管只看到普通中奖人的失败明细和待发数量，不列出成功名单：
// 成功名单与中奖名单一对比，就能认出没出现在任何一边的预留对象。
export function serializeGrantResult(result, { includeReserved = false } = {}) {
  if (includeReserved) {
    return {
      round_id: result.round_id,
      granted: result.granted.map((g) => ({ userid: g.userid, amount: g.amount, is_reserved: g.is_reserved })),
      failed: result.failed.map((f) => ({ userid: f.userid, error: f.error, is_reserved: f.is_reserved })),
      pending: result.pending,
    };
  }
  return {
    round_id: result.round_id,
    failed: result.failed.filter((f) => f.is_reserved !== 1).map((f) => ({ userid: f.userid, error: f.error })),
    pending: result.pendingPublic,
  };
}

// ---------------------------------------------------------------- 预留名额（仅超级管理员）

export async function createGalaReservedSlot(db, { eventId, segment, roundNo, userid, poolId, amount, note, actor = {} }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const seg = requireSegment(segment);
  if (!GALA_DRAW_SEGMENTS.has(seg)) throw new GalaError('segment_not_drawable');
  const no = toPositiveId(roundNo);
  if (!no) throw new GalaError('invalid_round_no');
  const uid = cleanText(userid, 128);
  const user = uid ? await db.get('SELECT userid FROM users WHERE userid = ?', [uid]) : null;
  if (!user) throw new GalaError('user_not_found', 404);
  const value = toNonNegativeInt(amount ?? 0);
  if (value === null) throw new GalaError('invalid_amount');
  let pid = null;
  if (value > 0) {
    pid = toPositiveId(poolId);
    const pool = pid ? await db.get('SELECT id FROM gala_pools WHERE id = ? AND event_id = ? AND is_reserved = 1', [pid, id]) : null;
    if (!pool) throw new GalaError('reserved_pool_required');
  }
  // 锁活动行与抽签串行：避免抽签进行中插入的预留名额在该轮结束后才提交，变成永远用不到的悬挂名额。
  return await inTx(db, async (tx) => {
    const event = await tx.get('SELECT id FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    if (!event) throw new GalaError('event_not_found', 404);
    const drawn = await tx.get(
      'SELECT 1 AS x FROM gala_rounds WHERE event_id = ? AND segment = ? AND round_no = ?',
      [id, seg, no],
    );
    if (drawn) throw new GalaError('round_already_drawn', 409);
    const existing = await tx.get(
      `SELECT 1 AS x FROM gala_reserved_slots WHERE event_id = ? AND segment = ? AND round_no = ? AND status = 'pending'`,
      [id, seg, no],
    );
    if (existing) throw new GalaError('slot_already_exists', 409);
    const row = await tx.get(
      `INSERT INTO gala_reserved_slots(event_id, segment, round_no, userid, pool_id, amount, note, created_by)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [id, seg, no, uid, pid, value, cleanText(note, 200) || null, actor.userid || null],
    );
    return serializeSlot(row);
  });
}

function serializeSlot(row) {
  return {
    id: Number(row.id),
    event_id: Number(row.event_id),
    segment: row.segment,
    round_no: Number(row.round_no),
    userid: row.userid,
    name: row.user_name || row.userid,
    pool_id: row.pool_id ? Number(row.pool_id) : null,
    amount: Number(row.amount || 0),
    note: row.note || '',
    status: row.status,
    used_round_id: row.used_round_id ? Number(row.used_round_id) : null,
    created_by: row.created_by || '',
    created_at: Number(row.created_at),
  };
}

export async function listGalaReservedSlots(db, { eventId }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const rows = await db.all(
    `SELECT s.*, u.name AS user_name FROM gala_reserved_slots s JOIN users u ON u.userid = s.userid
      WHERE s.event_id = ? ORDER BY s.id DESC`,
    [id],
  );
  return rows.map(serializeSlot);
}

export async function cancelGalaReservedSlot(db, { slotId }) {
  const id = toPositiveId(slotId);
  if (!id) throw new GalaError('invalid_slot_id');
  // 与创建预留名额、抽签相同：先锁活动行再改名额，避免抽签读完候选人后名额才被取消，
  // 导致该用户既被排除在普通抽签之外、又拿不到预留名额。
  return await inTx(db, async (tx) => {
    const ref = await tx.get('SELECT event_id FROM gala_reserved_slots WHERE id = ?', [id]);
    if (!ref) throw new GalaError('slot_not_pending', 409);
    await tx.get('SELECT id FROM gala_events WHERE id = ? FOR UPDATE', [ref.event_id]);
    const row = await tx.get(
      `UPDATE gala_reserved_slots SET status = 'cancelled', updated_at = unixepoch()
        WHERE id = ? AND status = 'pending' RETURNING *`,
      [id],
    );
    if (!row) throw new GalaError('slot_not_pending', 409);
    return serializeSlot(row);
  });
}

