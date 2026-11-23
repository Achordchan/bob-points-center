// 年会（gala）业务：活动、奖池、参与名单、服务端抽签、幂等发币、预留名额。
//
// 不变式：
// - 抽签只在服务端发生（crypto.randomInt），结果先落库再展示，大屏刷新不会改变结果。
// - 发币以 gala_round_winners.awarded_at 为幂等闸门：同一中奖记录无论点多少次“发币”，只写一次账本。
// - 每笔发币在同一事务里条件扣减奖池 spent（spent + amount <= budget），超预算整笔回滚。
// - 预留名额占本轮一个名额（抽 N 人时普通抽 N-1 人），奖励与本轮普通中奖人相同（发币轮按单价、无币轮不发币），
//   钱只从预留奖池出，不占员工预算；金额一致，余额变化也一致，看余额认不出预留对象；
//   被预留的人不参与本活动的正常抽签。预留信息只对超级管理员返回，非超管视图里不出现任何能认出
//   预留对象的逐人信息（奖池、发放状态、失败名单、排除后的候选人数、年会发放流水）。
//   员工奖池对非超管只公开“已分配额”（每轮 单价 × 抽签人数，与是否含预留无关），不公开实际支出；
//   抽签准入只看公开量（名单人数、已中奖人数、已分配额），返回结果不随是否有预留而变化。
//   已知边界：预留对象在其预留轮次之前不会在普通抽签中中奖，这是“预留”本身的统计特征，无法消除；
//   每场活动预留名额有上限，抽签后至少留出 GALA_DRAW_HEADROOM 名未中签候选人，
//   保证任何一次抽签都不会“恰好抽走除预留对象外的所有人”。
import crypto from 'node:crypto';
import { GALA_PAYOUT_REASON_PREFIX, grantBob } from './ledgerService.js';

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
// 年会表 ID 的上限：接口按 JS 安全整数解析 ID，序列的 MAXVALUE 也设为它（见 galaSchema），
// 到上限时插入直接失败，而不是生成一个接口无法引用的记录。
export const GALA_MAX_ROW_ID = Number.MAX_SAFE_INTEGER;
// 同一活动员工奖池、预留奖池各自的预算合计上限（各占安全整数的一半）：活动详情把两类奖池的预算、已分配额、
// 支出加在一起汇总，两类各不超过一半，合计就仍是安全整数。分开限制，员工奖池的报错不会透露预留奖池的存在。
export const GALA_MAX_POOLS_TOTAL = Math.floor(Number.MAX_SAFE_INTEGER / 2);

async function assertPoolsTotalSafe(tx, { eventId, reserved, excludePoolId = 0, nextBudget }) {
  const row = await tx.get(
    `SELECT (COALESCE(SUM(budget), 0)::numeric + ?::numeric) > ?::numeric AS over
       FROM gala_pools WHERE event_id = ? AND is_reserved = ? AND id <> ?`,
    [nextBudget, GALA_MAX_POOLS_TOTAL, eventId, reserved ? 1 : 0, excludePoolId],
  );
  if (row?.over === true || row?.over === 't') throw new GalaError('pools_total_too_large', 409);
}
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

// 按完整 Unicode 字符截断：按 UTF-16 码元截断可能留下半个代理对，写库时被替换成 U+FFFD，
// 与内存里的值不再相等（例如抽签重试比较标题时）。
// 文本先规范成数据库能原样存回的形式，再比较和截断：孤立的 UTF-16 代理码元（例如客户端按码元截断 emoji 留下的半个）
// 写入 PostgreSQL 会变成 U+FFFD，NUL 字符则无法写入。不先规范，重试抽签时库里的标题与请求对不上，会被当成另一轮。
function cleanText(value, max = MAX_TITLE_LENGTH) {
  if (value === null || value === undefined) return '';
  const text = String(value).toWellFormed().replace(/\u0000/g, '').trim();
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join('');
}

// userid 原样比较，不改写：不去首尾空白、不截断、不替换字符。改写后的值可能正是另一个人的 ID
// （例如存量库里同时有 "u1" 和 " u1"），操作会落到别人身上。不能原样使用的一律拒绝。
// 长度按 Unicode 字符（码点）计，与数据库 char_length 一致：全员导入在库里按同一规则筛选。
const MAX_USERID_LENGTH = 512;
// 备份恢复用：值能否被 cleanUserid 原样接受（恢复的名单、待发记录、待用名额都必须之后能按同一个 ID 操作）。
export function isOperableGalaUserid(value) {
  try {
    return typeof value === 'string' && cleanUserid(value) === value && value !== '';
  } catch {
    return false;
  }
}

function cleanUserid(value) {
  if (value === null || value === undefined || (typeof value !== 'string' && typeof value !== 'number')) return '';
  // 数字形式的 userid 只接受安全整数：超出范围的 JSON 数字在解析时已被舍入，可能恰好等于别人的 ID。
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new GalaError('invalid_userid');
  const uid = String(value);
  if (uid === '') return '';
  // 首尾带空白（JS trim 去掉的任何空白）：不去掉后继续，而是拒绝。
  if (uid !== uid.trim()) throw new GalaError('invalid_userid');
  // 孤立的 UTF-16 代理码元写库时会变成 U+FFFD，可能等于另一个人的 ID；NUL 无法作为 PostgreSQL 参数传入（会变成 500）。
  if (!uid.isWellFormed() || uid.includes('\u0000')) throw new GalaError('invalid_userid');
  if (uid.length > MAX_USERID_LENGTH * 2 || Array.from(uid).length > MAX_USERID_LENGTH) throw new GalaError('invalid_userid');
  return uid;
}

function requireSegment(segment) {
  const key = cleanText(segment, 32);
  if (!Object.hasOwn(GALA_SEGMENTS, key)) throw new GalaError('invalid_segment');
  return key;
}

// 年会的写事务一律先拿恢复互斥的共享锁（见 enterGalaWrite），再碰任何表：全量恢复先拿排他锁，
// 两边加锁顺序一致，并发时只会排队，不会死锁，也不会在恢复删到一半的数据上做校验。
// expectedVersion：页面读到数据时的恢复代数（gala_version）。给了就在拿到共享锁后核对，
// 期间发生过全量恢复（同一个活动/奖池 ID 可能已是另一份数据）则 409 gala_data_changed，不写入。
async function inTx(db, fn, expectedVersion) {
  const run = async (tx) => {
    if (expectedVersion === undefined) await enterGalaWrite(tx);
    else await enterGalaWrite(tx, parseGalaVersion(expectedVersion), 'gala_data_changed');
    return await fn(tx);
  };
  if (db?.__txScoped === true) return await run(db);
  return await db.transaction(run);
}

// 多条语句拼成一个结果的读取放进同一个可重复读快照：中途提交的覆盖恢复可能复用同一批 ID，
// 分开读会把恢复后的中奖记录挂到恢复前的轮次（或奖池、计数）上。
// 调用方已在自己的事务里（隔离级别未知，可能是默认的 READ COMMITTED，每条语句各看一个快照）：
// 先拿恢复互斥的共享锁再读。全量恢复要拿它的排他锁才动表，持锁期间恢复无法提交，多条读取看到的是同一份数据。
async function inSnapshot(db, fn) {
  if (db?.__txScoped === true) {
    await db.get('SELECT pg_advisory_xact_lock_shared(hashtext(?)) AS locked', [GALA_PAYOUT_LOCK]);
    return await fn(db);
  }
  return await db.transaction(async (tx) => {
    await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return await fn(tx);
  });
}

// 全量恢复与年会写入的互斥：会写中奖记录或流水的年会事务（抽签、发放、记录发放失败、收尾）一开始就拿
// 这把共享锁，恢复在锁任何表之前拿它的排他锁。两边都先拿同一把锁、再碰表和行，就不会互相等待成死锁。
export const GALA_PAYOUT_LOCK = 'bob.gala.payout';
// 用户重置与抽签、导入名单、创建预留名额的互斥：这些写入在锁活动行之前拿它的共享锁，
// 用户重置拿排他锁。
// 不按活动行加锁，是因为重置开始后才创建的活动不在它的行锁范围内；一把全局锁同时覆盖已有和新建的活动。
export const GALA_RESET_LOCK = 'bob.gala.reset';
// 恢复代数：gala_restore_state 单行。generation 计数（运维排查用），version_token 是数据版本：
// 建库时随机生成，每次成功的全量恢复在排他锁内、自己的事务里换一个新的随机值（不进备份；恢复失败回滚则不变）。
// 用随机值而不是计数：换到另一个库再恢复时，计数可能恰好和旧页面持有的相同，随机值不会。
// 一次发放开始时记下版本，之后每个发放事务在共享锁内重读，版本变了说明期间成功恢复过，整次发放作废。
export async function bumpGalaRestoreGeneration(tx) {
  await tx.run(
    `INSERT INTO gala_restore_state(id, generation, version_token) VALUES (1, 1, gen_random_uuid()::text)
     ON CONFLICT (id) DO UPDATE SET generation = gala_restore_state.generation + 1, version_token = gen_random_uuid()::text`,
    [],
  );
}

const VERSION_RE_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VERSION_RE = new RegExp(`^${VERSION_RE_SRC}$`);
const GRANT_TOKEN_RE = new RegExp(`^(${VERSION_RE_SRC})\\.([1-9][0-9]{0,15})$`);

// 发放凭据：数据版本 + 轮次 ID（“版本.轮次ID”）。版本不进备份、每次成功的全量恢复都换新随机值，
// 所以覆盖恢复复用同一个轮次 ID 后，恢复前页面拿到的凭据必然失效：发放只付给操作者看到的那一轮。
function grantTokenOf(version, roundId) {
  return `${version}.${Number(roundId)}`;
}

function parseGrantToken(token, roundId) {
  const m = GRANT_TOKEN_RE.exec(typeof token === 'string' ? token : '');
  if (!m || Number(m[2]) !== Number(roundId)) throw new GalaError('invalid_grant_token');
  return m[1];
}

// 数据版本（见 bumpGalaRestoreGeneration）。读接口随数据返回，写接口原样带回。
export function parseGalaVersion(value) {
  if (typeof value !== 'string' || !VERSION_RE.test(value)) throw new GalaError('invalid_gala_version');
  return value;
}

async function readGalaVersion(tx) {
  const row = await tx.get('SELECT version_token FROM gala_restore_state WHERE id = 1');
  return String(row?.version_token ?? '');
}

async function enterGalaWrite(tx, generation, changedCode = 'round_changed') {
  await tx.get('SELECT pg_advisory_xact_lock_shared(hashtext(?)) AS locked', [GALA_PAYOUT_LOCK]);
  if (generation === undefined) return null;
  const current = await readGalaVersion(tx);
  if (generation !== null && current !== String(generation)) throw new GalaError(changedCode, 409);
  return current;
}

/** 均匀随机抽取 count 个（部分 Fisher-Yates），使用 CSPRNG。 */
// 从 [0, n) 里均匀抽 count 个不重复的位置（稀疏 Fisher–Yates，只记录被交换过的位置）。
// 与 pickRandom 对 [0..n) 的结果逐位相同，但不分配长度为 n 的数组。
export function samplePositions(n, count, randomInt = crypto.randomInt) {
  const total = Math.max(0, Math.floor(Number(n) || 0));
  const take = Math.min(Math.max(0, count), total);
  const swapped = new Map();
  const out = [];
  for (let i = 0; i < take; i += 1) {
    const j = i + randomInt(total - i);
    const vi = swapped.has(i) ? swapped.get(i) : i;
    const vj = swapped.has(j) ? swapped.get(j) : j;
    swapped.set(j, vi);
    out.push(vj);
  }
  return out;
}

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

function serializeRound(row, winners, { includeReserved, generation = null }) {
  const sorted = (winners || []).slice().sort((a, b) => Number(a.display_order) - Number(b.display_order));
  // 预留对象的奖励与本轮普通中奖人相同（同单价、同样的失败原因），整轮状态不再能区分谁是预留对象，
  // 所以超管与非超管看到同一个完成状态：全部正数奖励发完才是 granted，任何一笔待发都保持 drawn。
  const state = { status: row.status, granted_at: row.granted_at ? Number(row.granted_at) : null };
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
    exclude_previous_winners: Number(row.exclude_previous_winners ?? 1) === 1,
    status: state.status,
    created_by: row.created_by || '',
    created_name: row.created_name || '',
    created_at: Number(row.created_at),
    granted_at: state.granted_at,
    // 发币时原样带回（见 grantTokenOf）；与轮次同一快照读出，恢复后失效。
    grant_token: generation === null ? null : grantTokenOf(generation, row.id),
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
  // 与其他年会写入一样在持恢复互斥共享锁的事务里插入：全量恢复进行中会等它结束，不会混进恢复结果或被随后清掉。
  return await inTx(db, async (tx) => {
    const row = await tx.get(
      `INSERT INTO gala_events(title, event_date, total_budget, enabled_segments, created_by, created_name)
       VALUES(?, ?, ?, ?, ?, ?) RETURNING *`,
      [cleanTitle, cleanText(eventDate, 32) || null, budget, JSON.stringify(segments), actor.userid || null, actor.name || null],
    );
    // 同一事务、仍持恢复互斥共享锁时读数据版本：客户端紧接着配置奖池等写入就绑定在这场刚建的活动上，
    // 中间若发生覆盖恢复（ID 可能被复用），后续写入会得到 gala_data_changed。
    return { ...serializeEvent(row), gala_version: await readGalaVersion(tx) };
  });
}

export async function updateGalaEvent(db, { eventId, title, eventDate, totalBudget, status, enabledSegments, expectedVersion }) {
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
  }, expectedVersion);
}

export async function listGalaEvents(db, { limit = 100, beforeId = null } = {}) {
  // 按 id 倒序分页：传上一页最后一个活动的 id 作为 before_id 即可取更早的活动。
  const hasBefore = beforeId !== null && beforeId !== undefined && beforeId !== '';
  const before = hasBefore ? toPositiveId(beforeId) : null;
  if (hasBefore && !before) throw new GalaError('invalid_before_id');
  const rawLimit = limit === null || limit === undefined || limit === '' ? 100 : toPositiveId(limit);
  if (!rawLimit) throw new GalaError('invalid_limit');
  const pageSize = Math.min(rawLimit, 100);
  // 活动与数据版本在同一个快照里读：写接口带回 gala_version，恢复后旧页面的写入会被拒绝。
  return await inSnapshot(db, async (snap) => {
    const rows = before
      ? await snap.all('SELECT * FROM gala_events WHERE id < ? ORDER BY id DESC LIMIT ?', [before, pageSize])
      : await snap.all('SELECT * FROM gala_events ORDER BY id DESC LIMIT ?', [pageSize]);
    const version = await readGalaVersion(snap);
    return rows.map((r) => ({ ...serializeEvent(r), gala_version: version }));
  });
}

export async function getGalaEventDetail(db, { eventId, includeReserved = false }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  return await inSnapshot(db, async (snap) => readGalaEventDetail(snap, { id, includeReserved }));
}

async function readGalaEventDetail(db, { id, includeReserved }) {
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
    // 本活动所有写接口（改活动、奖池、名单、抽签、预留）都要原样带回，见 inTx。
    gala_version: await readGalaVersion(db),
  };
}

// ---------------------------------------------------------------- 奖池

export async function createGalaPool(db, { eventId, name, sponsor, budget, reserved = false, expectedVersion }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const cleanName = cleanText(name, 40);
  if (!cleanName) throw new GalaError('pool_name_required');
  const amount = toNonNegativeInt(budget);
  if (amount === null) throw new GalaError('invalid_budget');
  return await inTx(db, async (tx) => {
    const event = await tx.get('SELECT * FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    if (!event) throw new GalaError('event_not_found', 404);
    await assertPoolsTotalSafe(tx, { eventId: id, reserved, nextBudget: amount });
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
  }, expectedVersion);
}

// reserved：调用入口要求的奖池类型（员工入口 false、预留入口 true），必须与奖池实际类型一致，
// 否则按找不到处理：在预留入口误传员工奖池 ID 不会改到员工预算，反之也不会暴露预留奖池。
export async function updateGalaPool(db, { poolId, name, sponsor, budget, reserved = false, expectedVersion }) {
  const id = toPositiveId(poolId);
  if (!id) throw new GalaError('invalid_pool_id');
  return await inTx(db, async (tx) => {
    // 加锁顺序与抽签一致：先活动、后奖池。抽签持有活动锁后插入轮次会对奖池加 KEY SHARE，
    // 若这里先锁奖池再等活动，两者会互相等待而死锁。
    const ref = await tx.get('SELECT event_id FROM gala_pools WHERE id = ?', [id]);
    if (!ref) throw new GalaError('pool_not_found', 404);
    const event = await tx.get('SELECT * FROM gala_events WHERE id = ? FOR UPDATE', [ref.event_id]);
    const pool = await tx.get('SELECT * FROM gala_pools WHERE id = ? FOR UPDATE', [id]);
    if (!pool || (Number(pool.is_reserved) === 1) !== (reserved === true)) throw new GalaError('pool_not_found', 404);
    const nextBudget = budget === undefined ? Number(pool.budget) : toNonNegativeInt(budget);
    if (nextBudget === null) throw new GalaError('invalid_budget');
    const reservedPool = Number(pool.is_reserved) === 1;
    const allocated = reservedPool ? 0 : ((await allocatedByPool(tx, [id])).get(id) || 0);
    if (reservedPool) {
      // 预留奖池的下限是已支出加上已抽中、尚未发放的预留奖励：抽签时已确认付得起，不能事后把预算压到付不出。
      // 待发额在锁住奖池之后单独查询，进行中的发放要么已提交（计入 spent）、要么仍待发（计入待发），不会重复计算。
      const pendingRow = await tx.get(
        'SELECT COALESCE(SUM(amount), 0) AS n FROM gala_round_winners WHERE pool_id = ? AND awarded_at IS NULL',
        [id],
      );
      const committed = Number(pool.spent) + Number(pendingRow?.n || 0);
      // spent 只报实际支出（与奖池详情一致），最低可设预算（实际支出 + 待发）另放在 min_budget。
      if (nextBudget < committed) throw new GalaError('budget_below_spent', 409, { spent: Number(pool.spent), min_budget: committed });
    } else {
      // 员工奖池按已分配额校验（实际支出不会超过已分配额）；报错也只给公开的已分配额。
      const floor = Math.max(allocated, Number(pool.spent));
      if (nextBudget < floor) throw new GalaError('budget_below_allocated', 409, { allocated: floor });
    }
    await assertPoolsTotalSafe(tx, { eventId: pool.event_id, reserved: reservedPool, excludePoolId: id, nextBudget });
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
    return serializePool(row, { allocated, includeReserved: reserved === true });
  }, expectedVersion);
}

// ---------------------------------------------------------------- 参与名单

export async function addGalaParticipants(db, { eventId, userids = [], allActiveDingtalk = false, tableNo = null, expectedVersion }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const table = tableNo === null || tableNo === undefined || tableNo === '' ? null : toPositiveId(tableNo, PG_INT_MAX);
  if (tableNo !== null && tableNo !== undefined && tableNo !== '' && table === null) throw new GalaError('invalid_table_no');
  // 两种导入方式二选一：同时给了名单和“全部在册员工”时不猜意图（静默按全员导入会改变整场候选名单），直接拒绝。
  // 显式给出的 userids 必须是数组（缺省或 null 视为没给），且全员导入时必须为空：
  // 字符串等错误类型不能被当成“没给名单”而落到全员导入上。
  if (userids !== undefined && userids !== null && !Array.isArray(userids)) throw new GalaError('invalid_userids');
  if (allActiveDingtalk && Array.isArray(userids) && userids.length > 0) throw new GalaError('ambiguous_participant_source');
  // 名单里任何一项无效（空值、空串、对象、数组等）都拒绝整批：静默丢弃会写入部分名单，回执里也看不出输入有误。
  // 按输入顺序逐项检查，清洗为空和清洗时抛错（超长、非安全整数）都报告当前位置，保证返回的是第一项无效值。
  const cleaned = [];
  if (!allActiveDingtalk) {
    (Array.isArray(userids) ? userids : []).forEach((x, index) => {
      let uid = '';
      try {
        uid = cleanUserid(x);
      } catch {
        uid = '';
      }
      if (!uid) throw new GalaError('invalid_userid', 400, { index });
      cleaned.push(uid);
    });
  }
  const list = [...new Set(cleaned)];
  if (!allActiveDingtalk && list.length === 0) throw new GalaError('userids_required');
  if (list.length > 2000) throw new GalaError('too_many_userids');
  // 先锁活动行再写名单，与抽签、创建预留名额、移出名单的加锁顺序一致：
  // 否则导入先插入名单行、再为外键等活动行，而预留事务已锁活动行又在 ON CONFLICT 处等导入提交，互相等待死锁。
  return await inTx(db, async (tx) => {
    // 与用户重置串行（见 GALA_RESET_LOCK）：重置删了钉钉档案和名单还没提交时，导入不能读到旧的在册档案，
    // 等重置提交后再把人插回名单。
    await tx.get('SELECT pg_advisory_xact_lock_shared(hashtext(?)) AS locked', [GALA_RESET_LOCK]);
    const event = await tx.get('SELECT id FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    if (!event) throw new GalaError('event_not_found', 404);
    return allActiveDingtalk ? await addAllActive(tx, id, table) : await addListed(tx, id, list, table);
  }, expectedVersion);
}

// JS String.prototype.trim 去掉的全部空白（WhiteSpace + LineTerminator），用于在数据库里套用与 cleanUserid 相同的规则。
const JS_TRIM_CHARS = '\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const UNTRIMMED_USERID_RE = `^[${JS_TRIM_CHARS}]|[${JS_TRIM_CHARS}]$`;
// 在册档案里能原样按 cleanUserid 规则操作的 userid：非空、不超长（同按字符计）、首尾无空白（数据库里的文本不会含 NUL 或孤立代理）。
const OPERABLE_USERID_SQL = `char_length(u.userid) BETWEEN 1 AND ${MAX_USERID_LENGTH} AND u.userid !~ ?`;

async function addAllActive(db, id, table) {
  // 全员导入与按名单导入、移出名单用同一套标识规则：不能原样操作的存量 ID（首尾空白、超长）不导入，
  // 否则导入后无法按名单返回的 ID 移出，带首尾空白的还可能匹配到另一个人。跳过的人在回执里报告。
  const result = await db.run(
    `INSERT INTO gala_participants(event_id, userid, name_snapshot, table_no, source)
     SELECT ?, u.userid, COALESCE(NULLIF(p.name, ''), u.name), CAST(? AS INTEGER), 'admin'
       FROM users u
       JOIN user_dingtalk_profiles p ON p.userid = u.userid
      WHERE p.active = 1 AND u.source = 'dingtalk' AND ${OPERABLE_USERID_SQL}
     ON CONFLICT (event_id, userid) DO NOTHING`,
    [id, table, UNTRIMMED_USERID_RE],
  );
  const skipped = await db.all(
    `SELECT u.userid FROM users u JOIN user_dingtalk_profiles p ON p.userid = u.userid
      WHERE p.active = 1 AND u.source = 'dingtalk' AND NOT (${OPERABLE_USERID_SQL})
      ORDER BY u.userid LIMIT 100`,
    [UNTRIMMED_USERID_RE],
  );
  return { added: result.changes, missing: [], skipped_invalid: skipped.map((r) => r.userid) };
}

async function addListed(db, id, list, table) {
  // 一条语句完成“确认用户存在 + 写入名单”：回执里的缺失名单与实际写入用的是同一个用户集合；
  // 整批原子写入，并发抽签只能看到导入前或导入后的完整名单。FOR KEY SHARE 锁住用到的用户行，
  // 并发删除的用户不会被选中后又在外键检查时报错。
  const row = await db.get(
    `WITH found AS (
       SELECT u.userid, COALESCE(NULLIF(u.name, ''), u.userid) AS name
         FROM users u
        WHERE u.userid = ANY(?::text[])
        FOR KEY SHARE
     ), ins AS (
       INSERT INTO gala_participants(event_id, userid, name_snapshot, table_no, source)
       SELECT ?, f.userid, f.name, CAST(? AS INTEGER), 'admin' FROM found f
       ON CONFLICT (event_id, userid) DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT COUNT(*) FROM ins) AS added, ARRAY(SELECT userid FROM found) AS found`,
    [list, id, table],
  );
  const foundSet = new Set(Array.isArray(row?.found) ? row.found : []);
  return { added: Number(row?.added || 0), missing: list.filter((u) => !foundSet.has(u)) };
}

export async function removeGalaParticipant(db, { eventId, userid, participantId, expectedVersion }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  // 两种定位方式二选一：按 userid，或按名单记录 id（participant_id，名单列表每条都带）。
  // 按记录 id 移出是给存量异常标识（早期全员导入带进来的首尾空白、超长 ID）的清理路径：
  // 这些 ID 不能按 userid 原样操作，又不能裁剪后去匹配（会落到另一个人身上），只能精确删掉那一行。
  const hasRow = participantId !== undefined && participantId !== null && participantId !== '';
  const hasUser = userid !== undefined && userid !== null && userid !== '';
  if (hasRow && hasUser) throw new GalaError('ambiguous_participant_target');
  let rowId = null;
  let uid = '';
  if (hasRow) {
    rowId = toPositiveId(participantId);
    if (!rowId) throw new GalaError('invalid_participant_id');
  } else {
    // 缺少或无效的标识直接拒绝：不能和“指定的人已不在名单中”（removed: 0）混为一谈。
    uid = cleanUserid(userid);
    if (!uid) throw new GalaError('invalid_userid');
  }
  // 与抽签串行：抽签持有活动行锁期间，名单不会在“公开人数检查”和“候选人查询”之间变化。
  return await inTx(db, async (tx) => {
    await tx.get('SELECT id FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    const deleted = rowId
      ? await tx.all('DELETE FROM gala_participants WHERE event_id = ? AND id = ? RETURNING userid', [id, rowId])
      : await tx.all('DELETE FROM gala_participants WHERE event_id = ? AND userid = ? RETURNING userid', [id, uid]);
    // 移出即作废：同一事务里取消此人在本活动的待用名额。否则之后重新导入（如“导入全部在册员工”）
    // 让此人回到名单，旧名额又会在预定轮次兑现。返回值不提名额（非超管也能移出名单），不暴露预留信息。
    // 名额按删掉那一行的原值匹配，不经过任何清洗。
    if (deleted.length > 0) {
      await tx.run(
        `UPDATE gala_reserved_slots SET status = 'cancelled', note = COALESCE(note, '') || '（对象已移出名单，自动作废）', updated_at = unixepoch()
          WHERE event_id = ? AND userid = ? AND status = 'pending'`,
        [id, deleted[0].userid],
      );
    }
    return { removed: deleted.length };
  }, expectedVersion);
}

// 按名单记录 id 升序分页：传上一页最后一条的 id 作为 after_id 取下一页，返回条数少于 limit 即已到末页。
// 全员导入不受显式名单上限约束，名单可能很大，不一次读出整份。
const MAX_PARTICIPANT_PAGE = 500;
export async function listGalaParticipants(db, { eventId, includeReserved = false, afterId = null, limit = MAX_PARTICIPANT_PAGE }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const hasAfter = afterId !== null && afterId !== undefined && afterId !== '';
  const after = hasAfter ? toPositiveId(afterId) : 0;
  if (hasAfter && !after) throw new GalaError('invalid_after_id');
  const rawLimit = limit === null || limit === undefined || limit === '' ? MAX_PARTICIPANT_PAGE : toPositiveId(limit);
  if (!rawLimit) throw new GalaError('invalid_limit');
  const pageSize = Math.min(rawLimit, MAX_PARTICIPANT_PAGE);
  // 每页的名单与数据版本在同一个快照里读：移出名单要带回这个版本。
  const { rows, version } = await inSnapshot(db, async (snap) => ({
    rows: await snap.all(
      // 预留状态只给超管，普通视图不做这次逐人子查询。走 (event_id, id) 索引。
      `SELECT p.id, p.userid, p.name_snapshot, p.table_no, p.source, p.joined_at${includeReserved ? `,
              EXISTS (SELECT 1 FROM gala_reserved_slots s
                       WHERE s.event_id = p.event_id AND s.userid = p.userid AND s.status <> 'cancelled') AS reserved` : ''}
         FROM gala_participants p WHERE p.event_id = ? AND p.id > ? ORDER BY p.id LIMIT ?`,
      [id, after, pageSize],
    ),
    version: await readGalaVersion(snap),
  }));
  return rows.map((r) => {
    const out = {
      id: Number(r.id),
      userid: r.userid,
      name: r.name_snapshot || r.userid,
      table_no: r.table_no === null ? null : Number(r.table_no),
      source: r.source,
      joined_at: Number(r.joined_at),
      gala_version: version,
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
  expectedVersion,
  expectedRoundNo,
}) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const seg = requireSegment(segment);
  if (!GALA_DRAW_SEGMENTS.has(seg)) throw new GalaError('segment_not_drawable');
  const count = toPositiveId(drawCount, MAX_DRAW_COUNT);
  if (!count) throw new GalaError('invalid_draw_count');
  // 排除开关只接受布尔值：字符串 "false"、数字 0 等不猜意图，免得按与预期不同的候选名单落库。
  if (typeof excludePreviousWinners !== 'boolean') throw new GalaError('invalid_exclude_previous_winners');
  if (!['none', 'coin'].includes(prizeType)) throw new GalaError('invalid_prize_type');
  const amount = prizeType === 'coin' ? toNonNegativeInt(amountEach) : 0;
  if (prizeType === 'coin' && (!amount || amount <= 0)) throw new GalaError('invalid_amount_each');
  // 整轮金额（单价 × 人数）必须是安全整数，否则预算比较和返回的 required 都会被舍入。
  if (!Number.isSafeInteger(amount * count)) throw new GalaError('draw_total_too_large');
  // expectedRoundNo：这次请求要抽的轮次号（本环节最新一轮 + 1）。管理端接口必传，让重试幂等：
  // 抽签已提交但响应丢了时，用同样参数重试会拿回已抽出的那一轮，而不是再抽一轮、再占一份预算。
  const wantRoundNo = expectedRoundNo === undefined ? null : toPositiveId(expectedRoundNo);
  if (expectedRoundNo !== undefined && !wantRoundNo) throw new GalaError('invalid_round_no');

  return await inTx(db, async (tx) => {
    // 先拿重置互斥的共享锁（见 GALA_RESET_LOCK）：进行中的用户重置提交后才读参与者，
    // 抽签先拿到则重置等它提交，再删掉它写入的未发放中奖记录。抽签之间共享锁不冲突。
    await tx.get('SELECT pg_advisory_xact_lock_shared(hashtext(?)) AS locked', [GALA_RESET_LOCK]);
    // 锁活动行：同一活动的抽签串行，轮次号与“已中奖排除”不会被并发抽签打乱。
    const event = await tx.get('SELECT * FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    if (!event) throw new GalaError('event_not_found', 404);
    const requestedPoolId = prizeType === 'coin' ? toPositiveId(poolId) : null;
    if (prizeType === 'coin' && !requestedPoolId) throw new GalaError('pool_required');

    const last = await tx.get(
      'SELECT COALESCE(MAX(round_no), 0) AS n FROM gala_rounds WHERE event_id = ? AND segment = ?',
      [id, seg],
    );
    const roundNo = Number(last?.n || 0) + 1;
    // 轮次号是 INTEGER：本环节已用到上限时不再给出下一轮号（重试已有轮次仍可识别），直接返回业务错误。
    const exhausted = roundNo > PG_INT_MAX;
    // 先识别重试，再检查能不能新抽：抽签提交后活动被结束、环节被停用，重试仍应拿回已落库的那一轮。
    if (wantRoundNo !== null && wantRoundNo !== roundNo) {
      const done = wantRoundNo < roundNo
        ? await tx.get('SELECT * FROM gala_rounds WHERE event_id = ? AND segment = ? AND round_no = ?', [id, seg, wantRoundNo])
        : null;
      // 同一轮次号已用完全相同的参数（含是否排除已中奖者）抽过：视为重试，原样返回那一轮（不重新抽、不再占预算）。
      if (done
        && Number(done.draw_count) === count
        && done.prize_type === prizeType
        && Number(done.amount_each) === amount
        && (done.pool_id == null ? null : Number(done.pool_id)) === requestedPoolId
        && Number(done.exclude_previous_winners ?? 1) === (excludePreviousWinners ? 1 : 0)
        && (done.title ?? null) === (cleanText(title) || null)) {
        const winners = await tx.all('SELECT * FROM gala_round_winners WHERE round_id = ? ORDER BY display_order, id', [done.id]);
        const generation = await readGalaVersion(tx);
        return { round: done, winners, eligibleCount: null, generation, replayed: true };
      }
      if (exhausted) throw new GalaError('round_no_exhausted', 409);
      // 轮次号对不上（别人已抽了这一轮、参数不同，或页面数据过旧）：不抽，让操作者刷新后确认。
      throw new GalaError('round_no_changed', 409, { next_round_no: roundNo });
    }
    if (exhausted) throw new GalaError('round_no_exhausted', 409);

    if (event.status === 'ended') throw new GalaError('event_ended', 409);
    if (!parseEnabledSegments(event.enabled_segments).includes(seg)) throw new GalaError('segment_disabled', 409);
    let pool = null;
    if (prizeType === 'coin') {
      pool = await tx.get('SELECT * FROM gala_pools WHERE id = ? AND event_id = ? AND is_reserved = 0', [requestedPoolId, id]);
      if (!pool) throw new GalaError('pool_not_found', 404);
    }

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
    // 预留对象拿到的奖励与本轮普通中奖人完全一致（发币轮按单价、无币轮不发币），只是钱从预留奖池出：
    // 金额一样，余额变化也就一样，看余额认不出谁是预留对象。预留奖池付不起本轮单价时名额作废、
    // 本轮按普通抽签进行，而不是让预留对象中奖却到不了账（同样会因余额没变而暴露）。
    let reservedPoolId = null;
    if (pendingSlot && !voidNote && amount > 0) {
      // 先锁住奖池，再用单独的语句读待发额：同一语句里的子查询用的是加锁前的快照，
      // 若锁等到了一笔进行中的发放，这笔奖励会同时出现在 spent 和待发额里被算两次。
      const rp = pendingSlot.pool_id == null ? null : await tx.get(
        'SELECT id, budget, spent FROM gala_pools WHERE id = ? AND event_id = ? AND is_reserved = 1 FOR SHARE',
        [pendingSlot.pool_id, id],
      );
      const rpPending = rp ? await tx.get(
        'SELECT COALESCE(SUM(amount), 0) AS n FROM gala_round_winners WHERE pool_id = ? AND awarded_at IS NULL',
        [rp.id],
      ) : null;
      if (!rp || Number(rp.budget) - Number(rp.spent) - Number(rpPending?.n || 0) < amount) {
        voidNote = '（预留奖池余额不足以支付本轮单价，自动作废）';
      } else {
        reservedPoolId = Number(rp.id);
      }
    }
    if (voidNote) {
      await tx.run(
        `UPDATE gala_reserved_slots SET status = 'cancelled', note = COALESCE(note, '') || ?, updated_at = unixepoch() WHERE id = ?`,
        [voidNote, pendingSlot.id],
      );
      slot = null;
    }
    // 普通候选人在预留名额处理完之后再查：刚作废的名额对应的人此时不再被排除，和其他人一样参与本轮抽签。
    // 只把命中的候选人传回来：先在库里数合格人数，在 [0, n) 里抽不重复的位置，再按稳定顺序（p.id）取这些位置的行。
    // 大名单（导入全部在册员工）时不必每轮把所有人的 userid、姓名排序后传回，也不复制整份名单。
    const eligibleFilter = `
         FROM gala_participants p
        WHERE p.event_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM gala_reserved_slots r
             WHERE r.event_id = p.event_id AND r.userid = p.userid AND r.status <> 'cancelled')
          ${excludePreviousWinners ? `AND NOT EXISTS (
            SELECT 1 FROM gala_round_winners w JOIN gala_rounds gr ON gr.id = w.round_id
             WHERE w.event_id = p.event_id AND w.userid = p.userid AND gr.segment = ?)` : ''}`;
    const eligibleParams = excludePreviousWinners ? [id, seg] : [id];
    const eligibleCount = Number((await tx.get(`SELECT COUNT(*) AS n ${eligibleFilter}`, eligibleParams))?.n || 0);
    const positions = samplePositions(eligibleCount, slot ? count - 1 : count, randomInt);
    const hitRows = positions.length === 0 ? [] : await tx.all(
      `SELECT userid, name_snapshot, rn FROM (
         SELECT p.userid, p.name_snapshot, row_number() OVER (ORDER BY p.id) - 1 AS rn ${eligibleFilter}
       ) x WHERE rn = ANY(?::bigint[])`,
      [...eligibleParams, positions],
    );
    const byPos = new Map(hitRows.map((row) => [Number(row.rn), row]));
    const picked = positions.map((pos) => byPos.get(pos)).filter(Boolean);

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
        poolId: reservedPoolId,
        amount,
        reserved: 1,
      });
    }
    // 展示顺序整体随机，预留名额不会固定出现在末位。
    const order = pickRandom(winners.map((_, i) => i), winners.length, randomInt);

    const round = await tx.get(
      `INSERT INTO gala_rounds(event_id, segment, round_no, title, prize_type, pool_id, amount_each, draw_count, exclude_previous_winners, created_by, created_name)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [id, seg, roundNo, cleanText(title) || null, prizeType, pool ? pool.id : null, amount, count,
        excludePreviousWinners ? 1 : 0, actor.userid || null, actor.name || null],
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
        // 已使用的名额记下实际发放的奖池与金额（与预留中奖记录一致），备份校验据此逐笔对应。
        `UPDATE gala_reserved_slots SET status = 'used', used_round_id = ?, pool_id = ?, amount = ?, updated_at = unixepoch() WHERE id = ?`,
        [round.id, reservedPoolId, amount, slot.id],
      );
    }
    // 仍持有恢复互斥的共享锁，读到的代数就是这一轮所在数据的代数。
    const generation = await readGalaVersion(tx);
    return { round, winners: inserted, eligibleCount, generation };
  }, expectedVersion);
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
  return await inSnapshot(db, async (snap) => readGalaRounds(snap, { id, before, pageSize, includeReserved }));
}

async function readGalaRounds(db, { id, before, pageSize, includeReserved }) {
  const rounds = before
    ? await db.all('SELECT * FROM gala_rounds WHERE event_id = ? AND id < ? ORDER BY id DESC LIMIT ?', [id, before, pageSize])
    : await db.all('SELECT * FROM gala_rounds WHERE event_id = ? ORDER BY id DESC LIMIT ?', [id, pageSize]);
  if (rounds.length === 0) return [];
  // 与轮次在同一个快照里读：恢复前的轮次只会配上恢复前的代数。
  const generation = await readGalaVersion(db);
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
  return rounds.map((r) => serializeRound(r, byRound.get(Number(r.id)), { includeReserved, generation }));
}

export function serializeDrawResult(result, { includeReserved = false } = {}) {
  const out = serializeRound(result.round, result.winners, { includeReserved, generation: result.generation ?? null });
  // 候选人数已排除被预留的人，和参与名单人数一比就知道有人被预留，只给超管。重试返回的旧轮次没有这个数。
  if (includeReserved && !result.replayed) out.eligible_count = result.eligibleCount;
  if (result.replayed) out.replayed = true;
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
    // 整次发放作废。之后先共享锁住本轮并核对轮次身份（兜底），再领取中奖记录。
    // 加锁顺序统一为「轮次 → 中奖记录」：失败回写、发放收尾、用户重置都按这个顺序，互相只会排队、不会死锁。
    await enterGalaWrite(tx, generation);
    // 排他锁住本轮：最后一笔到账时要在同一事务里把整轮标记完成（见下方），同一轮的到账因此逐笔串行。
    const current = await tx.get('SELECT * FROM gala_rounds WHERE id = ? FOR UPDATE', [round.id]);
    if (!sameRound(current, round)) throw new GalaError('round_changed', 409);
    const claimed = await tx.get(
      `UPDATE gala_round_winners SET awarded_at = unixepoch(), award_error = NULL
        WHERE id = ? AND round_id = ? AND awarded_at IS NULL AND amount > 0
        RETURNING id, event_id, userid, name_snapshot, pool_id, amount, is_reserved`,
      [winnerId, round.id],
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
    // 这是本轮最后一笔待发的正数奖励时，与到账同一事务标记整轮完成（与发放收尾、用户重置同一口径）。
    // 否则进程在到账提交后、收尾之前退出，余额和流水都已更新，轮次却一直显示未发完，导出的备份也带着这个状态。
    await tx.run(
      `UPDATE gala_rounds r SET status = 'granted', granted_at = unixepoch()
        WHERE r.id = ? AND r.status = 'drawn'
          AND NOT EXISTS (SELECT 1 FROM gala_round_winners w WHERE w.round_id = r.id AND w.awarded_at IS NULL AND w.amount > 0)`,
      [round.id],
    );
    return { skipped: false, userid: claimed.userid, amount, balance: granted.balance };
  });
}

// 仅供集成测试模拟“到账提交后、收尾之前进程退出”的中断点。
export const awardGalaWinnerForTest = awardWinner;

// onAwarded：每笔发放事务提交后立即回调（用于余额变更通知）。整次发放中途因恢复停止时，
// 已经到账的人也已经收到通知；重试会跳过已发记录，不会再补发通知。回调出错不影响发放。
export async function grantGalaRound(db, { roundId, grantToken, onAwarded }) {
  const id = toPositiveId(roundId);
  if (!id) throw new GalaError('invalid_round_id');
  // 发放只认操作者看到的那一轮：凭据里的代数必须等于当前代数。请求若在恢复持锁期间排队，
  // 恢复提交后代数已变，这里直接 round_changed，不会把恢复后同 ID 的另一轮当成起点。
  const expected = parseGrantToken(grantToken, id);
  // 代数、轮次和待发名单在同一个持共享锁的事务里读，保证三者来自同一份数据（不会读到恢复一半）。
  const start = await db.transaction(async (tx) => {
    const generation = await enterGalaWrite(tx, expected);
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
  // 无币轮没有可发的奖励：拒绝，不把它标成“已发币”、也不广播发放完成。
  if (round.prize_type !== 'coin') throw new GalaError('round_not_coin', 409);
  const label = GALA_SEGMENTS[round.segment] || round.segment;
  // 流水原因固定带环节名称，方便按环节对账；自定义标题附在后面。
  const reason = `${GALA_PAYOUT_REASON_PREFIX}${label}${round.title ? `（${round.title}）` : ''}·第${round.round_no}轮`;
  const granted = [];
  const failed = [];
  for (const w of winners) {
    const reserved = Number(w.is_reserved) === 1 ? 1 : 0;
    try {
      const r = await awardWinner(db, { winnerId: w.id, round, reason, generation });
      if (!r.skipped) {
        granted.push({ userid: r.userid, amount: r.amount, is_reserved: reserved });
        try {
          // 回调可能是异步的：不等待（通知不拖慢发放），但必须接住它的拒绝，
          // 否则一次通知失败会成为未处理的 Promise 拒绝，可能在部分奖励已提交后终止进程。
          const pending = onAwarded?.({ userid: r.userid, amount: r.amount });
          if (pending && typeof pending.then === 'function') pending.then(undefined, () => {});
        } catch {
          // 通知失败不影响已提交的发放
        }
      }
    } catch (err) {
      // 本轮已被恢复替换：整次发放作废，不把错误写到新数据的中奖记录上。
      if (err?.code === 'round_changed') throw err;
      // 回执和 award_error 只放业务错误码；意外异常（数据库连接等）的原文只记在服务端，对外统一为 award_failed。
      let code = 'award_failed';
      if (err instanceof GalaError) {
        code = err.code;
      } else {
        // eslint-disable-next-line no-console
        console.error('[gala] unexpected award error', { round_id: id, winner_id: w.id }, err);
      }
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
      'SELECT COUNT(*) AS n FROM gala_round_winners WHERE round_id = ? AND awarded_at IS NULL AND amount > 0',
      [id],
    );
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
  // 失败者不逐人列出，只给失败数量、按原因汇总和待发数量。预留对象的失败与普通中奖人一样计入：
  // 两者金额相同、失败原因同一套，汇总里看不出出处；若把预留失败剔除，整轮“已无失败”而某位中奖人
  // 余额没变，反而暴露他是预留对象。
  const reasons = {};
  let failedCount = 0;
  for (const f of result.failed) {
    failedCount += 1;
    reasons[f.error] = (reasons[f.error] || 0) + 1;
  }
  return {
    round_id: result.round_id,
    failed_count: failedCount,
    failed_reasons: reasons,
    pending: result.pending,
  };
}

// ---------------------------------------------------------------- 预留名额（仅超级管理员）

export async function createGalaReservedSlot(db, { eventId, segment, roundNo, userid, poolId, note, actor = {}, expectedVersion }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const seg = requireSegment(segment);
  if (!GALA_DRAW_SEGMENTS.has(seg)) throw new GalaError('segment_not_drawable');
  const no = toPositiveId(roundNo, PG_INT_MAX);
  if (!no) throw new GalaError('invalid_round_no');
  const uid = cleanUserid(userid);
  if (!uid) throw new GalaError('user_not_found', 404);
  // 名额不单独设金额：中奖时按本轮单价发放（无币轮不发币），从这里指定的预留奖池扣，所以奖池必填。
  const pid = toPositiveId(poolId);
  if (!pid) throw new GalaError('reserved_pool_required');
  // 锁活动行与抽签串行：避免抽签进行中插入的预留名额在该轮结束后才提交，变成永远用不到的悬挂名额。
  return await inTx(db, async (tx) => {
    // 与用户重置串行（见 GALA_RESET_LOCK）：名额若夹在重置“删名单”和“取消名额”之间提交，
    // 结果会与任何先后顺序都不符。
    await tx.get('SELECT pg_advisory_xact_lock_shared(hashtext(?)) AS locked', [GALA_RESET_LOCK]);
    const event = await tx.get('SELECT id FROM gala_events WHERE id = ? FOR UPDATE', [id]);
    if (!event) throw new GalaError('event_not_found', 404);
    // 用户在同一事务里、取得恢复锁和活动锁之后再确认，并 FOR KEY SHARE 锁住直到名额写入：
    // 事务外读到的用户可能随后被删除或被全量恢复移除，那样插入会撞外键返回 500。
    const user = await tx.get('SELECT userid FROM users WHERE userid = ? FOR KEY SHARE', [uid]);
    if (!user) throw new GalaError('user_not_found', 404);
    // 预留对象必须先按普通流程进入名单（例如随整批导入一起加入）：创建名额本身不改动公开名单，
    // 否则名单里单独多出一个人、带着入场时间，普通管理员一眼就能对上预留对象。
    // 活动行已锁，移出名单（同样先锁活动行）不会在核对之后、名额写入之前插进来。
    const enrolled = await tx.get('SELECT 1 AS x FROM gala_participants WHERE event_id = ? AND userid = ?', [id, uid]);
    if (!enrolled) throw new GalaError('participant_required', 409);
    // 奖池在同一事务里、锁住活动之后再核对（并共享锁住，直到名额写入）：事务外读到的奖池可能已被恢复替换成
    // 别的活动或员工奖池，名额写进去要到发放时才失败。
    const pool = await tx.get('SELECT id FROM gala_pools WHERE id = ? AND event_id = ? AND is_reserved = 1 FOR SHARE', [pid, id]);
    if (!pool) throw new GalaError('reserved_pool_required');
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
      [id, seg, no, uid, pid, 0, cleanText(note, 200) || null, actor.userid || null],
    );
    return serializeSlot(row);
  }, expectedVersion);
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

// 按 id 倒序分页（含已取消的历史记录）：传上一页最后一条的 id 作为 before_id 取更早的记录。
const MAX_RESERVED_PAGE = 100;
export async function listGalaReservedSlots(db, { eventId, beforeId = null, limit = MAX_RESERVED_PAGE }) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id');
  const hasBefore = beforeId !== null && beforeId !== undefined && beforeId !== '';
  const before = hasBefore ? toPositiveId(beforeId) : null;
  if (hasBefore && !before) throw new GalaError('invalid_before_id');
  const rawLimit = limit === null || limit === undefined || limit === '' ? MAX_RESERVED_PAGE : toPositiveId(limit);
  if (!rawLimit) throw new GalaError('invalid_limit');
  const pageSize = Math.min(rawLimit, MAX_RESERVED_PAGE);
  // 名额与数据版本在同一个快照里读：取消名额要带回这个版本，恢复前的名额 ID 不会配上恢复后的版本。
  return await inSnapshot(db, async (snap) => {
    const rows = await snap.all(
      `SELECT s.*, u.name AS user_name FROM gala_reserved_slots s JOIN users u ON u.userid = s.userid
        WHERE s.event_id = ?${before ? ' AND s.id < ?' : ''} ORDER BY s.id DESC LIMIT ?`,
      before ? [id, before, pageSize] : [id, pageSize],
    );
    const version = await readGalaVersion(snap);
    return rows.map((r) => ({ ...serializeSlot(r), gala_version: version }));
  });
}

export async function cancelGalaReservedSlot(db, { slotId, expectedVersion }) {
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
  }, expectedVersion);
}

