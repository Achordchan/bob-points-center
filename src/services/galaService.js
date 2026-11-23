// 年会（gala）业务：活动、奖池、参与名单、服务端抽签、幂等发币、预留名额。
//
// 不变式：
// - 抽签只在服务端发生（crypto.randomInt），结果先落库再展示，大屏刷新不会改变结果。
// - 发币以 gala_round_winners.awarded_at 为幂等闸门：同一中奖记录无论点多少次“发币”，只写一次账本。
// - 每笔发币在同一事务里条件扣减奖池 spent（spent + amount <= budget），超预算整笔回滚。
// - 预留名额占本轮一个名额（抽 N 人时普通抽 N-1 人），奖励只能来自预留奖池，不占员工预算；
//   被预留的人不参与本活动的正常抽签。预留信息只对超级管理员返回，非超管视图里不出现任何能认出
//   预留对象的逐人信息（金额、发放状态、失败名单、排除后的候选人数）。
//   员工奖池对非超管只公开“已分配额”（每轮 单价 × 抽签人数，与是否含预留无关），不公开实际支出；
//   抽签准入只看公开量（名单人数、已中奖人数、已分配额），返回结果不随是否有预留而变化。
//   已知边界：预留对象在其预留轮次之前不会在普通抽签中中奖，这是“预留”本身的统计特征，无法消除；
//   每场活动预留名额有上限，抽签后至少留出 GALA_DRAW_HEADROOM 名未中签候选人，
//   保证任何一次抽签都不会“恰好抽走除预留对象外的所有人”。
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
export const GALA_MAX_DRAW_COUNT = MAX_DRAW_COUNT;
const PG_INT_MAX = 2147483647;
// 每场活动最多保留的预留名额（待用 + 已用）。
export const GALA_MAX_RESERVED_SLOTS = 3;
// 公开的抽签人数上限：本轮可抽人数（名单 − 本环节已中奖者）至少要比抽签人数多出这么多人。
// 取预留上限的两倍：被排除的预留对象最多 GALA_MAX_RESERVED_SLOTS 人，普通抽签一定能填满，
// 且落选者里至少还有同样多的普通参与者，落选名单不会恰好等于预留对象。
export const GALA_DRAW_HEADROOM = GALA_MAX_RESERVED_SLOTS * 2;
const MAX_TITLE_LENGTH = 80;

export class GalaError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

// 只接受数字或纯十进制数字串；布尔值、数组、空串、科学计数法等一律视为非法，不做隐式转换。
function toStrictInt(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function toPositiveId(value, max = Number.MAX_SAFE_INTEGER) {
  const n = toStrictInt(value);
  return n !== null && n > 0 && n <= max ? n : null;
}

function toNonNegativeInt(value) {
  const n = toStrictInt(value);
  return n !== null && n >= 0 ? n : null;
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

// 年会的写事务一律先拿恢复互斥的共享锁（见 enterGalaWrite），再碰任何表：全量恢复先拿排他锁，
// 两边加锁顺序一致，并发时只会排队，不会死锁，也不会在恢复删到一半的数据上做校验。
async function inTx(db, fn) {
  const run = async (tx) => {
    await enterGalaWrite(tx);
    return await fn(tx);
  };
  if (db?.__txScoped === true) return await run(db);
  return await db.transaction(run);
}

// 全量恢复与年会写入的互斥：会写中奖记录或流水的年会事务（抽签、发放、记录发放失败、收尾）一开始就拿
// 这把共享锁，恢复在锁任何表之前拿它的排他锁。两边都先拿同一把锁、再碰表和行，就不会互相等待成死锁。
export const GALA_PAYOUT_LOCK = 'bob.gala.payout';
// 恢复代数：全量恢复每次在排他锁内 nextval 一次（序列不进备份）。一次发放开始时记下代数，
// 之后每个发放事务在共享锁内重读，代数变了说明期间发生过恢复，整次发放作废。
export const GALA_RESTORE_GENERATION_SEQ = 'gala_restore_generation_seq';

async function enterGalaWrite(tx, generation) {
  await tx.get('SELECT pg_advisory_xact_lock_shared(hashtext(?)) AS locked', [GALA_PAYOUT_LOCK]);
  if (generation === undefined) return null;
  const row = await tx.get(
    `SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS generation FROM ${GALA_RESTORE_GENERATION_SEQ}`,
  );
  const current = String(row?.generation ?? 0);
  if (generation !== null && current !== String(generation)) throw new GalaError('round_changed', 409);
  return current;
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

// 员工奖池对外的“已分配额”= 各轮 单价 × 抽签人数。预留名额占一个名额但从预留奖池出钱，
// 实际支出因此会比已分配额少一份；只公开已分配额，账面就与是否有预留无关。实际支出只给超管。
function serializePool(row, { allocated = 0, includeReserved = false } = {}) {
  const budget = Number(row.budget || 0);
  const spent = Number(row.spent || 0);
  const base = {
    id: Number(row.id),
    event_id: Number(row.event_id),
    name: row.name,
    sponsor: row.sponsor || '',
    budget,
  };
  if (Number(row.is_reserved) === 1) return { ...base, spent, remaining: budget - spent, is_reserved: 1 };
  const out = { ...base, allocated, remaining: budget - allocated, is_reserved: 0 };
  if (includeReserved) out.spent = spent;
  return out;
}

async function allocatedByPool(db, poolIds) {
  const ids = poolIds.map(Number).filter((n) => n > 0);
  const map = new Map();
  if (ids.length === 0) return map;
  const rows = await db.all(
    `SELECT pool_id, COALESCE(SUM(amount_each * draw_count), 0) AS n
       FROM gala_rounds WHERE pool_id = ANY(?::bigint[]) GROUP BY pool_id`,
    [ids],
  );
  for (const r of rows) map.set(Number(r.pool_id), Number(r.n || 0));
  return map;
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

// 非超管看到的轮次状态只由普通中奖记录决定，完全不读整轮状态（整轮状态包含预留名额的发放结果）。
// 没有普通待发奖励的轮次（不发币、或只有预留名额带奖励）没有“发放”这一步，固定显示 drawn。
function publicRoundStatus(row) {
  // 只看 public_granted_at：执行发放后普通奖励已全部发完（或本轮没有普通奖励）即写入，
  // 与预留名额是否发放成功无关。单人轮次里无论中奖的是普通人还是预留对象，公开状态都一样。
  return row.public_granted_at
    ? { status: 'granted', granted_at: Number(row.public_granted_at) }
    : { status: 'drawn', granted_at: null };
}

function serializeRound(row, winners, { includeReserved }) {
  const sorted = (winners || []).slice().sort((a, b) => Number(a.display_order) - Number(b.display_order));
  const state = includeReserved
    ? { status: row.status, granted_at: row.granted_at ? Number(row.granted_at) : null }
    : publicRoundStatus(row);
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
    draw_count: Number(row.draw_count),
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

export async function listGalaEvents(db, { limit = 100, beforeId = null } = {}) {
  // 按 id 倒序分页：传上一页最后一个活动的 id 作为 before_id 即可取更早的活动。
  const hasBefore = beforeId !== null && beforeId !== undefined && beforeId !== '';
  const before = hasBefore ? toPositiveId(beforeId) : null;
  if (hasBefore && !before) throw new GalaError('invalid_before_id');
  const rawLimit = limit === null || limit === undefined || limit === '' ? 100 : toPositiveId(limit);
  if (!rawLimit) throw new GalaError('invalid_limit');
  const pageSize = Math.min(rawLimit, 100);
  const rows = before
    ? await db.all('SELECT * FROM gala_events WHERE id < ? ORDER BY id DESC LIMIT ?', [before, pageSize])
    : await db.all('SELECT * FROM gala_events ORDER BY id DESC LIMIT ?', [pageSize]);
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
  const allocated = await allocatedByPool(db, pools.filter((p) => Number(p.is_reserved) === 0).map((p) => p.id));
  const visiblePools = pools.map((p) => serializePool(p, { allocated: allocated.get(Number(p.id)) || 0, includeReserved }));
  const publicPools = visiblePools.filter((p) => p.is_reserved === 0);
  const budgetSummary = {
    total_budget: Number(event.total_budget || 0),
    pools_budget: publicPools.reduce((s, p) => s + p.budget, 0),
    pools_allocated: publicPools.reduce((s, p) => s + p.allocated, 0),
  };
  if (includeReserved) budgetSummary.pools_spent = publicPools.reduce((s, p) => s + p.spent, 0);
  return {
    ...serializeEvent(event),
    pools: visiblePools,
    budget_summary: budgetSummary,
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
    return serializePool(row, { includeReserved: reserved });
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
    const reservedPool = Number(pool.is_reserved) === 1;
    const allocated = reservedPool ? 0 : ((await allocatedByPool(tx, [id])).get(id) || 0);
    if (reservedPool) {
      if (nextBudget < Number(pool.spent)) throw new GalaError('budget_below_spent', 409, { spent: Number(pool.spent) });
    } else {
      // 员工奖池按已分配额校验（实际支出不会超过已分配额）；报错也只给公开的已分配额。
      const floor = Math.max(allocated, Number(pool.spent));
      if (nextBudget < floor) throw new GalaError('budget_below_allocated', 409, { allocated: floor });
    }
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
    return serializePool(row, { allocated, includeReserved: allowReserved });
  });
}

// ---------------------------------------------------------------- 参与名单

export async function addGalaParticipants(db, { eventId, userids = [], allActiveDingtalk = false, tableNo = null }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const table = tableNo === null || tableNo === undefined || tableNo === '' ? null : toPositiveId(tableNo, PG_INT_MAX);
  if (tableNo !== null && tableNo !== undefined && tableNo !== '' && table === null) throw new GalaError('invalid_table_no');
  const list = allActiveDingtalk
    ? []
    : [...new Set((Array.isArray(userids) ? userids : []).map((x) => cleanText(x, 128)).filter(Boolean))];
  if (!allActiveDingtalk && list.length === 0) throw new GalaError('userids_required');
  if (list.length > 2000) throw new GalaError('too_many_userids');
  // 先锁活动行再写名单，与抽签、创建预留名额、移出名单的加锁顺序一致：
  // 否则导入先插入名单行、再为外键等活动行，而预留事务已锁活动行又在 ON CONFLICT 处等导入提交，互相等待死锁。
  return await inTx(db, async (tx) => {
    const event = await tx.get('SELECT id FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    if (!event) throw new GalaError('event_not_found', 404);
    return allActiveDingtalk ? await addAllActive(tx, id, table) : await addListed(tx, id, list, table);
  });
}

async function addAllActive(db, id, table) {
  const result = await db.run(
    `INSERT INTO gala_participants(event_id, userid, name_snapshot, table_no, source)
     SELECT ?, u.userid, COALESCE(NULLIF(p.name, ''), u.name), CAST(? AS INTEGER), 'admin'
       FROM users u
       JOIN user_dingtalk_profiles p ON p.userid = u.userid
      WHERE p.active = 1 AND u.source = 'dingtalk'
     ON CONFLICT (event_id, userid) DO NOTHING`,
    [id, table],
  );
  return { added: result.changes, missing: [] };
}

async function addListed(db, id, list, table) {
  // 一条 INSERT … SELECT 原子写入整批名单：并发抽签只能看到导入前或导入后的完整名单，不会抽到半份名单。
  const found = await db.all('SELECT userid FROM users WHERE userid = ANY(?::text[])', [list]);
  const foundSet = new Set(found.map((r) => r.userid));
  const result = await db.run(
    `INSERT INTO gala_participants(event_id, userid, name_snapshot, table_no, source)
     SELECT ?, u.userid, COALESCE(NULLIF(u.name, ''), u.userid), CAST(? AS INTEGER), 'admin'
       FROM users u
      WHERE u.userid = ANY(?::text[])
     ON CONFLICT (event_id, userid) DO NOTHING`,
    [id, table, list],
  );
  return { added: result.changes, missing: list.filter((u) => !foundSet.has(u)) };
}

export async function removeGalaParticipant(db, { eventId, userid }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  // 与抽签串行：抽签持有活动行锁期间，名单不会在“公开人数检查”和“候选人查询”之间变化。
  return await inTx(db, async (tx) => {
    await tx.get('SELECT id FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    const r = await tx.run('DELETE FROM gala_participants WHERE event_id = ? AND userid = ?', [id, cleanText(userid, 128)]);
    return { removed: r.changes };
  });
}

export async function listGalaParticipants(db, { eventId, includeReserved = false }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const rows = await db.all(
    `SELECT p.userid, p.name_snapshot, p.table_no, p.source, p.joined_at,
            EXISTS (SELECT 1 FROM gala_reserved_slots s
                     WHERE s.event_id = p.event_id AND s.userid = p.userid AND s.status <> 'cancelled') AS reserved
       FROM gala_participants p WHERE p.event_id = ? ORDER BY p.id`,
    [id],
  );
  return rows.map((r) => {
    const out = {
      userid: r.userid,
      name: r.name_snapshot || r.userid,
      table_no: r.table_no === null ? null : Number(r.table_no),
      source: r.source,
      joined_at: Number(r.joined_at),
    };
    if (includeReserved) out.is_reserved = r.reserved === true || Number(r.reserved) === 1 ? 1 : 0;
    return out;
  });
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
  const count = toPositiveId(drawCount, MAX_DRAW_COUNT);
  if (!count) throw new GalaError('invalid_draw_count');
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

    // 公开准入：只用名单人数和本环节已中奖人数（所有管理员都看得到）判断，与是否有预留无关。
    const publicRow = await tx.get(
      `SELECT COUNT(*) AS n FROM gala_participants p
        WHERE p.event_id = ?
          ${excludePreviousWinners ? `AND NOT EXISTS (
            SELECT 1 FROM gala_round_winners w JOIN gala_rounds gr ON gr.id = w.round_id
             WHERE w.event_id = p.event_id AND w.userid = p.userid AND gr.segment = ?)` : ''}`,
      excludePreviousWinners ? [id, seg] : [id],
    );
    const publicEligible = Number(publicRow?.n || 0);
    if (count > publicEligible - GALA_DRAW_HEADROOM) {
      throw new GalaError('not_enough_participants', 409, { max_draw_count: Math.max(0, publicEligible - GALA_DRAW_HEADROOM) });
    }
    if (pool) {
      const allocated = (await allocatedByPool(tx, [pool.id])).get(Number(pool.id)) || 0;
      const remaining = Number(pool.budget) - allocated;
      // 按请求的抽签人数整轮计入员工奖池，与本轮是否含预留名额无关。
      if (remaining < amount * count) {
        throw new GalaError('pool_budget_insufficient', 409, { remaining, required: amount * count });
      }
    }

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
    // 预留名额占本轮一个名额：抽 N 人时普通抽 N-1 人，再加上预留对象，总数仍是 N。
    // 这样操作者和大屏看到的人数与请求一致，看不出本轮有预留。奖励仍从预留奖池出，不占员工预算。
    const pendingSlot = await tx.get(
      `SELECT s.*, u.name AS user_name, p.name_snapshot AS participant_name, (p.userid IS NOT NULL) AS enrolled
         FROM gala_reserved_slots s
         JOIN users u ON u.userid = s.userid
         LEFT JOIN gala_participants p ON p.event_id = s.event_id AND p.userid = s.userid
        WHERE s.event_id = ? AND s.segment = ? AND s.round_no = ? AND s.status = 'pending'
        FOR UPDATE OF s`,
      [id, seg, roundNo],
    );
    // 预留对象已被移出名单（例如被普通管理员删掉）时不再生效：否则会出现一个不在名单上的中奖人，
    // 直接暴露身份。该名额作废，超管在预留列表里能看到。
    let slot = pendingSlot;
    let voidNote = null;
    if (pendingSlot && !pendingSlot.enrolled) voidNote = '（抽签时已不在参与名单，自动作废）';
    // 预留对象同样遵守“本环节已中奖者不再参与”：否则同一人会在开启排除时再中一次，
    // 也会因此和普通参与者区分开。
    if (pendingSlot && !voidNote && excludePreviousWinners) {
      const won = await tx.get(
        `SELECT 1 AS x FROM gala_round_winners w JOIN gala_rounds gr ON gr.id = w.round_id
          WHERE w.event_id = ? AND w.userid = ? AND gr.segment = ? LIMIT 1`,
        [id, pendingSlot.userid, seg],
      );
      if (won) voidNote = '（本环节已中过奖，按排除规则自动作废）';
    }
    if (voidNote) {
      await tx.run(
        `UPDATE gala_reserved_slots SET status = 'cancelled', note = COALESCE(note, '') || ?, updated_at = unixepoch() WHERE id = ?`,
        [voidNote, pendingSlot.id],
      );
      slot = null;
    }
    const picked = pickRandom(eligibleRows, slot ? count - 1 : count, randomInt);

    // 公开准入已留出 GALA_DRAW_HEADROOM 的余量（不少于预留上限），这里理论上不会触发；
    // 作为兜底仍拒绝，且不带任何人数信息。
    if (picked.length < (slot ? count - 1 : count)) throw new GalaError('not_enough_participants', 409);

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
        // 与普通中奖人一样取名单快照里的名字，避免只有预留对象显示得和名单不一样。
        name: slot.participant_name || slot.userid,
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

export async function listGalaRounds(db, { eventId, includeReserved = false, limit = 200, beforeId = null }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  // 按 id 倒序分页：传上一页最后一轮的 id 作为 before_id 即可取更早的轮次。
  const before = beforeId === null || beforeId === undefined || beforeId === '' ? null : toPositiveId(beforeId);
  if (beforeId !== null && beforeId !== undefined && beforeId !== '' && !before) throw new GalaError('invalid_before_id');
  const rawLimit = limit === null || limit === undefined || limit === '' ? 200 : toPositiveId(limit);
  if (!rawLimit) throw new GalaError('invalid_limit');
  const pageSize = Math.min(rawLimit, 200);
  const rounds = before
    ? await db.all('SELECT * FROM gala_rounds WHERE event_id = ? AND id < ? ORDER BY id DESC LIMIT ?', [id, before, pageSize])
    : await db.all('SELECT * FROM gala_rounds WHERE event_id = ? ORDER BY id DESC LIMIT ?', [id, pageSize]);
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
  const out = serializeRound(result.round, result.winners, { includeReserved });
  // 候选人数已排除被预留的人，和参与名单人数一比就知道有人被预留，只给超管。
  if (includeReserved) out.eligible_count = result.eligibleCount;
  return out;
}

// ---------------------------------------------------------------- 发币

function sameRound(a, b) {
  return a && b && Number(a.id) === Number(b.id) && Number(a.event_id) === Number(b.event_id)
    && a.segment === b.segment && Number(a.round_no) === Number(b.round_no) && Number(a.created_at) === Number(b.created_at);
}

async function awardWinner(db, { winnerId, round, reason, generation }) {
  return await db.transaction(async (tx) => {
    // 先拿恢复互斥的共享锁并核对恢复代数：发放开始后若有过全量恢复，中奖记录 ID 可能已指向恢复后的另一条记录，
    // 整次发放作废。之后再领取中奖记录、共享锁住本轮并核对轮次身份（兜底）。
    await enterGalaWrite(tx, generation);
    const claimed = await tx.get(
      `UPDATE gala_round_winners SET awarded_at = unixepoch(), award_error = NULL
        WHERE id = ? AND round_id = ? AND awarded_at IS NULL AND amount > 0
        RETURNING id, event_id, userid, name_snapshot, pool_id, amount, is_reserved`,
      [winnerId, round.id],
    );
    const current = await tx.get('SELECT * FROM gala_rounds WHERE id = ? FOR SHARE', [round.id]);
    if (!sameRound(current, round)) throw new GalaError('round_changed', 409);
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
  // 代数、轮次和待发名单在同一个持共享锁的事务里读，保证三者来自同一份数据（不会读到恢复一半）。
  const start = await db.transaction(async (tx) => {
    const generation = await enterGalaWrite(tx, null);
    const round = await tx.get('SELECT * FROM gala_rounds WHERE id = ?', [id]);
    if (!round) return { generation, round: null, winners: [] };
    const winners = await tx.all(
      'SELECT * FROM gala_round_winners WHERE round_id = ? AND awarded_at IS NULL AND amount > 0 ORDER BY display_order',
      [id],
    );
    return { generation, round, winners };
  });
  const { generation, round, winners } = start;
  if (!round) throw new GalaError('round_not_found', 404);
  const label = GALA_SEGMENTS[round.segment] || round.segment;
  // 流水原因固定带环节名称，方便按环节对账；自定义标题附在后面。
  const reason = `年会奖励·${label}${round.title ? `（${round.title}）` : ''}·第${round.round_no}轮`;
  const granted = [];
  const failed = [];
  for (const w of winners) {
    const reserved = Number(w.is_reserved) === 1 ? 1 : 0;
    try {
      const r = await awardWinner(db, { winnerId: w.id, round, reason, generation });
      if (!r.skipped) granted.push({ userid: r.userid, amount: r.amount, is_reserved: reserved });
    } catch (err) {
      // 本轮已被恢复替换：整次发放作废，不把错误写到新数据的中奖记录上。
      if (err?.code === 'round_changed') throw err;
      const code = String(err?.code || err?.message || err);
      failed.push({ userid: w.userid, error: code, is_reserved: reserved });
      // 记录失败原因同样在共享锁内核对恢复代数和轮次身份，恢复后的记录不会被写上旧数据的失败原因。
      await db.transaction(async (tx) => {
        await enterGalaWrite(tx, generation);
        const current = await tx.get('SELECT * FROM gala_rounds WHERE id = ? FOR SHARE', [id]);
        if (!sameRound(current, round)) throw new GalaError('round_changed', 409);
        await tx.run('UPDATE gala_round_winners SET award_error = ? WHERE id = ? AND round_id = ? AND awarded_at IS NULL', [code, w.id, id]);
      });
    }
  }
  // 收尾：待发数量与两个完成标记在同一事务、同一恢复代数下读写，不会拿恢复前的计数去标记恢复后的轮次。
  const pending = await db.transaction(async (tx) => {
    await enterGalaWrite(tx, generation);
    const current = await tx.get('SELECT * FROM gala_rounds WHERE id = ? FOR UPDATE', [id]);
    if (!sameRound(current, round)) throw new GalaError('round_changed', 409);
    const counts = await tx.get(
      `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE is_reserved = 0) AS public_n
         FROM gala_round_winners WHERE round_id = ? AND awarded_at IS NULL AND amount > 0`,
      [id],
    );
    if (Number(counts?.public_n || 0) === 0) {
      await tx.run('UPDATE gala_rounds SET public_granted_at = COALESCE(public_granted_at, unixepoch()) WHERE id = ?', [id]);
    }
    if (Number(counts?.n || 0) === 0) {
      await tx.run(`UPDATE gala_rounds SET status = 'granted', granted_at = unixepoch() WHERE id = ? AND status = 'drawn'`, [id]);
    }
    return counts;
  });
  return {
    round_id: id,
    granted,
    failed,
    pending: Number(pending?.n || 0),
    pendingPublic: Number(pending?.public_n || 0),
  };
}

// 发放结果对外只给发放回执，不含账户余额（余额属于用户资料，需要单独的查看权限）。
// 非超管只看到普通中奖记录的汇总，不列出成功或失败名单：
// 任何逐人名单与中奖名单一对比，都能认出没出现在里面的预留对象。
export function serializeGrantResult(result, { includeReserved = false } = {}) {
  if (includeReserved) {
    return {
      round_id: result.round_id,
      granted: result.granted.map((g) => ({ userid: g.userid, amount: g.amount, is_reserved: g.is_reserved })),
      failed: result.failed.map((f) => ({ userid: f.userid, error: f.error, is_reserved: f.is_reserved })),
      pending: result.pending,
    };
  }
  // 失败者也不逐人列出：员工奖池耗尽时普通中奖人全部失败，而预留对象不在失败名单里，
  // 一对照中奖名单就能认出来。普通回执只给失败数量、按原因汇总和待发数量。
  const reasons = {};
  let failedCount = 0;
  for (const f of result.failed) {
    if (f.is_reserved === 1) continue;
    failedCount += 1;
    reasons[f.error] = (reasons[f.error] || 0) + 1;
  }
  return {
    round_id: result.round_id,
    failed_count: failedCount,
    failed_reasons: reasons,
    pending: result.pendingPublic,
  };
}

// ---------------------------------------------------------------- 预留名额（仅超级管理员）

export async function createGalaReservedSlot(db, { eventId, segment, roundNo, userid, poolId, amount, note, actor = {} }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const seg = requireSegment(segment);
  if (!GALA_DRAW_SEGMENTS.has(seg)) throw new GalaError('segment_not_drawable');
  const no = toPositiveId(roundNo, PG_INT_MAX);
  if (!no) throw new GalaError('invalid_round_no');
  const uid = cleanText(userid, 128);
  const user = uid ? await db.get('SELECT userid FROM users WHERE userid = ?', [uid]) : null;
  if (!user) throw new GalaError('user_not_found', 404);
  const value = toNonNegativeInt(amount ?? 0);
  if (value === null) throw new GalaError('invalid_amount');
  const pid = value > 0 ? toPositiveId(poolId) : null;
  if (value > 0 && !pid) throw new GalaError('reserved_pool_required');
  // 锁活动行与抽签串行：避免抽签进行中插入的预留名额在该轮结束后才提交，变成永远用不到的悬挂名额。
  return await inTx(db, async (tx) => {
    const event = await tx.get('SELECT id FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    if (!event) throw new GalaError('event_not_found', 404);
    // 奖池在同一事务里、锁住活动之后再核对（并共享锁住，直到名额写入）：事务外读到的奖池可能已被恢复替换成
    // 别的活动或员工奖池，名额写进去要到发放时才失败。
    if (pid) {
      const pool = await tx.get('SELECT id FROM gala_pools WHERE id = ? AND event_id = ? AND is_reserved = 1 FOR SHARE', [pid, id]);
      if (!pool) throw new GalaError('reserved_pool_required');
    }
    // 抽签总是从该环节已抽的最大轮次 + 1 开始，轮次号不大于最大已抽轮次的名额永远用不到
    // （例如恢复的数据里有第 1、3 轮，第 2 轮的名额不会被消费，却会一直把这个人排除在普通抽签之外）。
    const drawn = await tx.get(
      'SELECT COALESCE(MAX(round_no), 0) AS n FROM gala_rounds WHERE event_id = ? AND segment = ?',
      [id, seg],
    );
    if (no <= Number(drawn?.n || 0)) throw new GalaError('round_already_drawn', 409);
    const existing = await tx.get(
      `SELECT 1 AS x FROM gala_reserved_slots WHERE event_id = ? AND segment = ? AND round_no = ? AND status = 'pending'`,
      [id, seg, no],
    );
    if (existing) throw new GalaError('slot_already_exists', 409);
    const total = await tx.get(
      `SELECT COUNT(*) AS n FROM gala_reserved_slots WHERE event_id = ? AND status <> 'cancelled'`,
      [id],
    );
    if (Number(total?.n || 0) >= GALA_MAX_RESERVED_SLOTS) throw new GalaError('reserved_slot_limit', 409);
    // 已在本环节中过奖、或在本环节已有未取消的名额：默认排除规则下这个名额到时会作废，直接拒绝。
    const conflict = await tx.get(
      `SELECT 1 AS x WHERE EXISTS (
          SELECT 1 FROM gala_round_winners w JOIN gala_rounds gr ON gr.id = w.round_id
           WHERE w.event_id = ? AND w.userid = ? AND gr.segment = ?)
        OR EXISTS (
          SELECT 1 FROM gala_reserved_slots s
           WHERE s.event_id = ? AND s.userid = ? AND s.segment = ? AND s.status <> 'cancelled')`,
      [id, uid, seg, id, uid, seg],
    );
    if (conflict) throw new GalaError('already_won_in_segment', 409);
    const row = await tx.get(
      `INSERT INTO gala_reserved_slots(event_id, segment, round_no, userid, pool_id, amount, note, created_by)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [id, seg, no, uid, pid, value, cleanText(note, 200) || null, actor.userid || null],
    );
    // 预留对象作为普通参与者真实写入名单：中奖时一定在名单上，名单的增删、计数对所有人都一致，
    // 看不出谁是预留对象。普通抽签照样排除有未取消名额的人。
    await tx.run(
      `INSERT INTO gala_participants(event_id, userid, name_snapshot, source)
       SELECT ?, u.userid, COALESCE(NULLIF(u.name, ''), u.userid), 'admin' FROM users u WHERE u.userid = ?
       ON CONFLICT (event_id, userid) DO NOTHING`,
      [id, uid],
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

