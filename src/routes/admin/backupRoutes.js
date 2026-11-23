// Auto-split from admin.js — backupRoutes.js
import { requireAdminSession } from '../../middleware/requireAdminSession.js';
import {
  ADMIN_PERMISSION_CATALOG,
  adminAccessMiddleware,
  getAdminAccess,
  hasAdminPermission,
  isSuperAdminSession,
  lockAdminAccountProtection,
  normalizePermissions,
  serializeRole,
} from '../../services/adminPermissionService.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAdminSessionPayload,
  publishMallRealtimeFullRefresh,
  runInTransaction,
  toOptionalInt,
  toPositiveInt,
} from './shared.js';
import { computeAnnouncementContentHash } from '../../services/announcementAccessService.js';
import {
  GALA_DRAW_SEGMENTS, GALA_MAX_DRAW_COUNT, GALA_MAX_POOLS_TOTAL, GALA_MAX_RESERVED_SLOTS, GALA_PAYOUT_LOCK, GALA_SEGMENTS, bumpGalaRestoreGeneration,
  isOperableGalaUserid,
} from '../../services/galaService.js';
import { GALA_PAYOUT_REASON_PREFIX, galaPayoutWinnerId } from '../../services/ledgerService.js';

// 年会表按外键依赖排列（父表在前）。导入时按此顺序插入，overwrite 按逆序清空。
export const GALA_BACKUP_TABLES = [
  { name: 'gala_events', columns: ['id', 'title', 'event_date', 'status', 'total_budget', 'enabled_segments', 'created_by', 'created_name', 'created_at', 'updated_at'], defaults: { status: 'draft', total_budget: 0, enabled_segments: JSON.stringify(Object.keys(GALA_SEGMENTS)) } },
  { name: 'gala_pools', columns: ['id', 'event_id', 'name', 'sponsor', 'budget', 'spent', 'is_reserved', 'created_at', 'updated_at'], defaults: { spent: 0, is_reserved: 0 } },
  { name: 'gala_participants', columns: ['id', 'event_id', 'userid', 'name_snapshot', 'table_no', 'source', 'joined_at'], defaults: { source: 'admin' } },
  { name: 'gala_rounds', columns: ['id', 'event_id', 'segment', 'round_no', 'title', 'prize_type', 'pool_id', 'amount_each', 'draw_count', 'exclude_previous_winners', 'status', 'created_by', 'created_name', 'created_at', 'granted_at'], defaults: { prize_type: 'none', amount_each: 0, exclude_previous_winners: 1, status: 'drawn' } },
  { name: 'gala_round_winners', columns: ['id', 'round_id', 'event_id', 'userid', 'name_snapshot', 'display_order', 'pool_id', 'amount', 'is_reserved', 'awarded_at', 'ledger_id', 'award_error', 'created_at'], defaults: { display_order: 0, amount: 0, is_reserved: 0 } },
  { name: 'gala_reserved_slots', columns: ['id', 'event_id', 'segment', 'round_no', 'userid', 'pool_id', 'amount', 'note', 'status', 'used_round_id', 'created_by', 'created_at', 'updated_at'], defaults: { amount: 0, status: 'pending' } },
];

// 含年会数据的全量备份格式号，写在 _meta.galaFormat。
export const GALA_BACKUP_FORMAT = 1;
// 备份带了本版本不认识的年会格式号（更新版本导出）：返回 true 时导入必须在写库前拒绝。
export function isUnsupportedGalaFormat(meta) {
  return meta?.galaFormat != null && meta.galaFormat !== GALA_BACKUP_FORMAT;
}
// 备份元数据表明它是含年会数据的格式：带 galaFormat，或导出时的表清单里列了年会表。
export function requiresGalaTables(meta) {
  if (meta?.galaFormat != null) return true;
  const listed = meta?.tables && typeof meta.tables === 'object' ? Object.keys(meta.tables) : [];
  return GALA_BACKUP_TABLES.some((t) => listed.includes(t.name));
}

// 全量导出在 _meta.tables 里记了每张表的行数（早于年会格式号的旧版导出也有），返回错误描述列表：
// - _meta.tables 列出的每张表，数组长度都必须与记录一致（被截短的账户、流水、名单等都会被发现）。
//   旧格式同样核对它实际记下的行数：不强制它提供新字段，但被截短的中奖记录不能让待发的轮次被补成已完成；
// - 当前格式（_meta.galaFormat）还要求 required 里的表必须有行数记录（默认六张年会表、流水和账户；覆盖导入传入全部全量表）。
// 流水被截短时，资金校验会把缺失的流水当成用户重置后已删除的合法状态；账户被截短时，覆盖会清掉已到账的余额，
// 而中奖记录仍是已发放，重试发币也不会补回。导出前已重置的用户不受影响：那时记录的行数本来就不含已删数据。
// 更早、没有行数记录的旧备份不检查。
export function findGalaRowCountErrors(backupData, meta, { required = [...GALA_BACKUP_TABLES.map((t) => t.name), 'ledger', 'accounts'] } = {}) {
  const current = meta?.galaFormat != null;
  const listed = meta?.tables && typeof meta.tables === 'object' && !Array.isArray(meta.tables) ? meta.tables : {};
  const errors = [];
  if (current) {
    for (const name of required) {
      if (!Object.hasOwn(listed, name)) errors.push(`${name} 缺少导出时的行数记录`);
    }
  }
  for (const [name, expected] of Object.entries(listed)) {
    const actual = Array.isArray(backupData?.[name]) ? backupData[name].length : 0;
    if (!Number.isSafeInteger(expected) || expected < 0) {
      errors.push(`${name} 的导出行数记录无效`);
    } else if (actual !== expected) {
      errors.push(`${name} 有 ${actual} 行，导出时为 ${expected} 行`);
    }
  }
  return errors;
}

// 发币轮的正数奖励已全部到账、却仍是 drawn：旧版本在最后一笔到账后、发放收尾前退出就会留下这种数据。
// 导入时补成 granted（完成时间取最后一笔到账时间，没有则取轮次创建时间），与在线“最后一笔到账即完成”一致。
// 无币轮不动。原地改写行对象，返回补齐的轮次数。
export function completeFinishedCoinRounds(backupData) {
  const rounds = Array.isArray(backupData?.gala_rounds) ? backupData.gala_rounds : [];
  const winners = Array.isArray(backupData?.gala_round_winners) ? backupData.gala_round_winners : [];
  const pending = new Set();
  const lastPaid = new Map();
  for (const w of winners) {
    const key = Number(w?.round_id);
    if (w?.awarded_at == null) {
      if (Number(w?.amount) > 0) pending.add(key);
    } else if (Number.isFinite(Number(w.awarded_at))) {
      lastPaid.set(key, Math.max(lastPaid.get(key) || 0, Number(w.awarded_at)));
    }
  }
  let changed = 0;
  for (const r of rounds) {
    if (!r || typeof r !== 'object' || r.prize_type !== 'coin' || (r.status ?? 'drawn') !== 'drawn' || r.granted_at != null) continue;
    if (pending.has(Number(r.id))) continue;
    r.status = 'granted';
    r.granted_at = lastPaid.get(Number(r.id)) ?? (r.created_at ?? Math.floor(Date.now() / 1000));
    changed += 1;
  }
  return changed;
}

// 写库前整理年会行，返回错误描述列表。当前格式的备份必须带全部列（见下方）；
// 轮次的 exclude_previous_winners 晚于年会表引入，按格式分别处理：
// - 当前格式（_meta.galaFormat）导出时一定带这一列：缺失或取值不是 0/1 都是损坏的备份，拒绝，不推断。
//   否则缺失的值会被推断成 0，跨轮重复中奖校验反而放过本该拒绝的数据。
// - 旧格式备份：缺失时与升级迁移同一口径推断。某轮有人在同一活动同一环节更早的轮次里已中过奖，
//   说明那一轮当时关闭了排除开关，记为 0；否则记为 1。推断值原地写回行对象，后续校验与写库用同一个值。
//   轮次号无效的行不参与推断（随后的引用校验会拒绝）；按轮次号分组，同号的异常数据互不视为“更早”。
export function prepareGalaRoundFlags(backupData, meta) {
  const errors = [];
  // 当前格式的导出（SELECT *）每行都带全部列。缺列说明备份被改过：导入会给缺的列套默认值，
  // 例如有限额、关闭了部分环节的活动恢复成不限预算、全部环节开启，所以写库前拒绝，只对旧格式补默认值。
  if (meta?.galaFormat != null) {
    for (const t of GALA_BACKUP_TABLES) {
      const rows = Array.isArray(backupData?.[t.name]) ? backupData[t.name] : [];
      for (const row of rows) {
        const missing = row && typeof row === 'object' ? t.columns.filter((c) => !Object.hasOwn(row, c)) : t.columns;
        if (missing.length) errors.push(`${t.name}#${row?.id} 缺少列 ${missing.join(', ')}（当前格式的备份必须带全部列）`);
        if (errors.length >= 20) return errors;
      }
    }
  }
  const rounds = (Array.isArray(backupData?.gala_rounds) ? backupData.gala_rounds : [])
    .filter((r) => r && typeof r === 'object');
  for (const r of rounds) {
    const v = r.exclude_previous_winners;
    if (v != null && ![0, 1, '0', '1'].includes(v)) {
      errors.push(`gala_rounds#${r.id} 的 exclude_previous_winners=${v} 只能是 0 或 1`);
    } else if (v == null && meta?.galaFormat != null) {
      errors.push(`gala_rounds#${r.id} 缺少 exclude_previous_winners（当前格式的备份必须带这一列）`);
    }
  }
  if (errors.length || meta?.galaFormat != null) return errors;
  if (!rounds.some((r) => r.exclude_previous_winners == null)) return errors;
  const winnersByRound = new Map();
  for (const w of Array.isArray(backupData?.gala_round_winners) ? backupData.gala_round_winners : []) {
    const key = Number(w?.round_id);
    if (!winnersByRound.has(key)) winnersByRound.set(key, []);
    winnersByRound.get(key).push(String(w?.userid));
  }
  // 活动+环节 → 轮次号 → 该号下的轮次
  const bySegment = new Map();
  for (const r of rounds) {
    const no = Number(r.round_no);
    if (!Number.isSafeInteger(no) || no < 1) continue;
    const key = `${Number(r.event_id)}:${r.segment}`;
    if (!bySegment.has(key)) bySegment.set(key, new Map());
    const byNo = bySegment.get(key);
    if (!byNo.has(no)) byNo.set(no, []);
    byNo.get(no).push(r);
  }
  for (const byNo of bySegment.values()) {
    const earlier = new Set();
    for (const no of [...byNo.keys()].sort((a, b) => a - b)) {
      const batch = byNo.get(no);
      for (const r of batch) {
        if (r.exclude_previous_winners != null) continue;
        const ws = winnersByRound.get(Number(r.id)) || [];
        r.exclude_previous_winners = ws.some((u) => earlier.has(u)) ? 0 : 1;
      }
      for (const r of batch) for (const u of winnersByRound.get(Number(r.id)) || []) earlier.add(u);
    }
  }
  return errors;
}

// 校验备份中年会数据的引用与资金关系，返回错误描述列表（为空表示通过）。
// 只看备份内部：年会表只随覆盖导入（会先清空年会表；合并导入跳过年会表），所以每条子记录引用的
// 活动/轮次/奖池都必须在同一份备份里，不能落到目标库里已有的无关记录上。
// 没有 ledger_id 关联时，一条形似 GALA_W<id> 的流水能否是这条（未发放）中奖记录的付款：收款人、金额一致即视为可能。
// 升级前外部发币允许任意引用号，历史流水可能恰好同名；收款人或金额不同的，按历史同名流水处理。
// 不按时间先后排除：数据库时钟回拨、或恢复到时钟稍慢的主库后发币，真实付款也可能“早于”中奖记录，
// 宁可拒绝也不重复发放。与导入后整库上的 paidPending 查询保持同一判定。
// 有 ledger_id 关联的已发放记录不用它判断（见下方逐笔核对）。
function couldPayWinner(row, w) {
  return String(row?.userid) === String(w?.userid) && Number(row?.delta) === Number(w?.amount);
}

// 覆盖前生成的恢复点能否通过导入时的年会校验：在年会表、流水、账户的副本上跑同一套整理与校验
// （prepareGalaRoundFlags → completeFinishedCoinRounds → findGalaFundingErrors），不改动快照本身。
export function findRecoveryPointGalaErrors(snapshotData) {
  const names = [...GALA_BACKUP_TABLES.map((t) => t.name), 'ledger', 'accounts'];
  const copy = structuredClone(Object.fromEntries(names.map((n) => [n, Array.isArray(snapshotData?.[n]) ? snapshotData[n] : []])));
  const flagErrors = prepareGalaRoundFlags(copy, { galaFormat: GALA_BACKUP_FORMAT });
  if (flagErrors.length) return flagErrors;
  completeFinishedCoinRounds(copy);
  return findGalaFundingErrors(copy);
}

export function findGalaFundingErrors(backupData) {
  const errors = [];
  const asList = (v) => (Array.isArray(v) ? v : []);
  const hasGala = GALA_BACKUP_TABLES.some((t) => backupData?.[t.name] != null);
  const winnersList = asList(backupData?.gala_round_winners);
  const winners = new Map(winnersList.map((w) => [Number(w?.id), w]));

  // 发放流水是 awarded_at 幂等闸门的旁证，必须与中奖记录逐笔对上：
  // - 流水里有 GALA_W<id>，对应中奖记录必须存在且已标记发放，否则恢复后会再发一次；
  // - 收款人、金额必须一致，中奖记录的 ledger_id 若有值必须指向这条流水，否则真正的中奖人没拿到币、
  //   闸门却已关闭，无法补发；
  // - 同一条中奖记录只能有一条发放流水。
  // 年会发放的出处以中奖记录的 ledger_id 为准（一条流水最多被一条中奖记录引用）：
  // - 中奖记录引用的流水，收款人、金额必须与中奖记录一致，ref_id 必须正是它自己（见下方核对）；
  // - 形如 GALA_W<id>、原因为“年会奖励·”的入账，若对应中奖记录在备份里却未发放，像是给未发放记录的付款，
  //   恢复后会再发一次，拒绝；
  // - 其余形似的流水（没有年会表的旧备份、对应中奖记录不存在、或中奖记录引用的是另一条流水）按普通流水处理，
  //   不会因为引用号碰巧相同而让旧备份无法恢复。
  if (!hasGala) return errors;
  const ledgerRows = asList(backupData?.ledger);
  // 只索引中奖记录 ledger_id 实际引用到的流水；没有中奖记录时整段流水核对都不需要。
  const referencedLedgerIds = new Set();
  for (const w of winnersList) if (w?.ledger_id != null) referencedLedgerIds.add(Number(w.ledger_id));
  const ledgerById = new Map();
  if (winnersList.length > 0) {
    for (const r of ledgerRows) {
      if (referencedLedgerIds.has(Number(r?.id))) ledgerById.set(Number(r.id), r);
    }
  }
  for (const row of (winnersList.length > 0 ? ledgerRows : [])) {
    const wid = galaPayoutWinnerId(row);
    if (wid == null) continue;
    const w = winners.get(wid);
    if (!w) continue;
    if (w.ledger_id != null && Number(w.ledger_id) === Number(row.id)) {
      // 中奖记录的 ledger_id 是发放事务里写下的关联，引用号、收款人、金额也对得上，就是这笔付款。
      // 不再按时间先后否定：数据库时钟回拨、或恢复到时钟稍慢的新主库后立即发币，都会产生“早于中奖记录”的真实付款。
      if (String(row.userid) !== String(w.userid) || Number(row.delta) !== Number(w.amount)) {
        errors.push(`ledger#${row?.id} 的收款人或金额与中奖记录 ${row.ref_id} 不一致`);
      }
    } else if (w.awarded_at == null && couldPayWinner(row, w)) {
      errors.push(`ledger#${row?.id} 像是 ${row.ref_id} 的发放流水，但对应中奖记录未标记发放，恢复后会重复发放`);
    }
  }
  // 零金额中奖（无币轮）从不发放：awarded_at、ledger_id 都必须为空。带着发放时间或付款凭据的零金额记录
  // 会把一条流水（或已删除的流水号）错认作这条记录的付款，挡住真实付款的核对或补发。
  for (const w of winnersList) {
    if (Number(w?.amount) === 0 && (w?.awarded_at != null || w?.ledger_id != null)) {
      errors.push(`gala_round_winners#${w?.id} 是零金额中奖记录，却带有发放时间或付款凭据（awarded_at/ledger_id 必须为空）`);
    }
  }
  // 一条流水只能支付一笔奖励：即使流水已被用户重置删除，两条中奖记录也不能共用同一个付款凭据。
  const winnerByLedger = new Map();
  for (const w of winnersList) {
    if (w?.ledger_id == null) continue;
    const key = Number(w.ledger_id);
    if (winnerByLedger.has(key)) {
      errors.push(`gala_round_winners#${w.id} 与 #${winnerByLedger.get(key)} 共用付款凭据 ledger_id ${w.ledger_id}`);
    } else {
      winnerByLedger.set(key, w.id);
    }
  }
  for (const w of winnersList) {
    if (w?.ledger_id == null) continue;
    const linked = ledgerById.get(Number(w.ledger_id));
    if (linked && galaPayoutWinnerId(linked) !== Number(w.id)) {
      errors.push(`gala_round_winners#${w.id} 的 ledger_id ${w.ledger_id} 指向的不是它自己的发放流水`);
    }
  }
  // 已发放、付款流水也在备份里的奖励，收款人的账户必须同在这份备份里：导入按备份覆盖账户余额，
  // 同一次导出的余额本就含这笔奖励。缺了账户时（例如被删减过的备份），
  // 目标库的余额不会因为导入这条流水而增加，awarded_at 却已挡住补发，等于流水显示已付、钱没到账。
  // 无法确认余额是否含这笔奖励，就拒绝导入，而不是盲目补加。
  const accountUsers = new Set(asList(backupData?.accounts).map((a) => String(a?.userid)));
  for (const w of winnersList) {
    if (w?.awarded_at == null || w?.ledger_id == null || !(Number(w.amount) > 0)) continue;
    if (!ledgerById.has(Number(w.ledger_id))) continue;
    if (!accountUsers.has(String(w.userid))) {
      errors.push(`gala_round_winners#${w.id} 已发放且付款流水在备份里，但备份缺少收款人 ${w.userid} 的账户，无法确认余额已含这笔奖励`);
    }
  }

  // 恢复出的名单、待发中奖记录、待用名额之后都要按同一个 userid 操作（移出名单、发放、兑现名额），
  // 必须符合在线入口的标识规则（见 isOperableGalaUserid：不去首尾空白、不超长等）。不裁剪修复，直接拒绝并报告位置。
  const checkUserid = (table, row) => {
    if (!isOperableGalaUserid(row?.userid)) errors.push(`${table}#${row?.id} 的 userid 无法按名单接口原样操作（首尾空白、超长或为空）`);
  };
  for (const p of asList(backupData?.gala_participants)) checkUserid('gala_participants', p);
  for (const w of winnersList) if (w?.awarded_at == null) checkUserid('gala_round_winners', w);
  for (const slot of asList(backupData?.gala_reserved_slots)) if ((slot?.status ?? 'pending') === 'pending') checkUserid('gala_reserved_slots', slot);

  // 金额类字段先做与在线写入相同的安全整数校验：后续校验和发币都用 Number，
  // 超出安全整数范围的值会被悄悄改写，导致数据库里存的和实际扣减、入账的不是同一个数。
  const safeInt = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) >= 0;
  const MONEY_FIELDS = {
    gala_events: ['total_budget'],
    gala_pools: ['budget', 'spent'],
    gala_rounds: ['amount_each'],
    gala_round_winners: ['amount'],
    gala_reserved_slots: ['amount'],
  };
  for (const [table, fields] of Object.entries(MONEY_FIELDS)) {
    for (const row of asList(backupData?.[table])) {
      for (const f of fields) {
        if (row?.[f] == null) continue;
        if (!safeInt(row[f])) errors.push(`${table}#${row?.id} 的 ${f}=${row[f]} 不是安全范围内的非负整数`);
      }
    }
  }
  // 标识符同样必须是安全整数：校验里用 Number 做键，超出安全范围的不同 ID 会被当成同一个，
  // 而数据库会按原值插入，导致校验通过的引用关系和实际写入的不是一回事。服务端返回 ID 时也按 Number 序列化。
  const ID_FIELDS = ['id', 'event_id', 'pool_id', 'round_id', 'used_round_id', 'ledger_id'];
  for (const t of GALA_BACKUP_TABLES) {
    for (const row of asList(backupData?.[t.name])) {
      for (const f of ID_FIELDS) {
        if (row?.[f] == null) continue;
        if (!safeInt(row[f]) || Number(row[f]) <= 0) errors.push(`${t.name}#${row?.id} 的 ${f}=${row[f]} 不是安全范围内的正整数`);
      }
      // 能否恢复只看已有记录：在线能分配出的 ID（年会表序列的上限就是最大安全整数）都必须能恢复，
      // 否则在线新建了一条合法记录后，下一份备份和自动恢复点都无法恢复。序列还能否分配新号是另一回事：
      // 恢复后序列停在上限，新建会失败，但已有数据照常可用。保留的 ledger_id 同理，在线发放只写安全整数的凭据。
    }
  }
  // 抽签人数与轮次号按在线抽签的范围校验：已分配额 = 单价 × 抽签人数，负数或超大值会让账面倒扣或溢出；
  // 轮次号写入 INTEGER 列。
  const intIn = (v, min, max) => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))
    && Number.isSafeInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
  for (const r of asList(backupData?.gala_rounds)) {
    if (!intIn(r?.draw_count, 1, GALA_MAX_DRAW_COUNT)) errors.push(`gala_rounds#${r?.id} 的 draw_count=${r?.draw_count} 不在 1~${GALA_MAX_DRAW_COUNT} 之间`);
    if (!intIn(r?.round_no, 1, 2147483647)) errors.push(`gala_rounds#${r?.id} 的 round_no=${r?.round_no} 不是有效轮次号`);
  }
  // 环节开关原样写入 TEXT 列，读取时解析失败会被当成“全部停用”：必须是认识的环节键组成的 JSON 数组。
  for (const e of asList(backupData?.gala_events)) {
    if (e?.enabled_segments == null) continue;
    let list = null;
    try {
      list = typeof e.enabled_segments === 'string' ? JSON.parse(e.enabled_segments) : null;
    } catch {
      list = null;
    }
    if (!Array.isArray(list) || list.some((k) => typeof k !== 'string' || !Object.hasOwn(GALA_SEGMENTS, k))) {
      errors.push(`gala_events#${e?.id} 的 enabled_segments 不是有效的环节列表`);
    }
  }
  for (const table of ['gala_pools', 'gala_round_winners']) {
    for (const row of asList(backupData?.[table])) {
      if (row?.is_reserved != null && ![0, 1, '0', '1'].includes(row.is_reserved)) {
        errors.push(`${table}#${row?.id} 的 is_reserved=${row.is_reserved} 只能是 0 或 1`);
      }
    }
  }
  if (errors.length) return errors;

  const events = new Map(asList(backupData?.gala_events).map((e) => [Number(e?.id), e]));
  const pools = new Map(asList(backupData?.gala_pools).map((p) => [Number(p?.id), p]));
  const rounds = new Map(asList(backupData?.gala_rounds).map((r) => [Number(r?.id), r]));
  const hasEvent = (id) => events.has(Number(id));
  const poolOk = (poolId, eventId, reserved) => {
    const pool = pools.get(Number(poolId));
    if (!pool || Number(pool.event_id) !== Number(eventId)) return false;
    return reserved == null || (Number(pool.is_reserved) === 1) === reserved;
  };

  for (const table of ['gala_pools', 'gala_participants', 'gala_rounds', 'gala_round_winners', 'gala_reserved_slots']) {
    for (const row of asList(backupData?.[table])) {
      if (!hasEvent(row?.event_id)) errors.push(`${table}#${row?.id} 引用的活动 ${row?.event_id} 不在备份中`);
    }
  }
  for (const r of rounds.values()) {
    // 轮次只能由在线抽签产生，环节必须是可抽签的环节：否则发币时会给一个在线永远抽不出来的轮次付款。
    if (!GALA_DRAW_SEGMENTS.has(String(r?.segment))) {
      errors.push(`gala_rounds#${r?.id} 的环节 ${r?.segment} 不可抽签`);
    }
    // 与在线抽签一致：无币轮没有奖池、单价为 0；发币轮必须挂同一活动的员工奖池且单价为正。
    // 否则无币轮也会被计入已分配额，永久占用员工预算。
    const prize = r?.prize_type ?? 'none';
    if (prize === 'none') {
      if (r?.pool_id != null || Number(r?.amount_each || 0) !== 0) {
        errors.push(`gala_rounds#${r?.id} 是无币轮，却带奖池或单价`);
      }
    } else if (prize === 'coin') {
      if (r?.pool_id == null || !poolOk(r.pool_id, r.event_id, false)) {
        errors.push(`gala_rounds#${r?.id} 引用的奖池 ${r?.pool_id} 不是同一活动的员工奖池`);
      } else if (!(Number(r?.amount_each) > 0)) {
        errors.push(`gala_rounds#${r?.id} 是发币轮，单价必须大于 0`);
      }
    } else {
      errors.push(`gala_rounds#${r?.id} 的奖品类型 ${prize} 无效`);
    }
  }

  // 活动总预算：与 createGalaPool/updateGalaPool 相同，总预算大于 0 时员工奖池预算之和不能超出。
  const employeeBudget = new Map();
  for (const p of pools.values()) {
    if (Number(p?.is_reserved) === 1) continue;
    const key = Number(p?.event_id);
    employeeBudget.set(key, (employeeBudget.get(key) || 0) + Number(p?.budget || 0));
  }
  for (const [eventId, total] of employeeBudget) {
    const cap = Number(events.get(eventId)?.total_budget || 0);
    if (cap > 0 && total > cap) errors.push(`gala_events#${eventId} 员工奖池预算合计 ${total} 超过活动总预算 ${cap}`);
  }
  // 与在线创建/修改奖池相同（GALA_MAX_POOLS_TOTAL）：同一活动员工奖池、预留奖池的预算合计各不超过安全整数的一半。
  // 活动详情按 Number 汇总两类奖池的预算、已分配额和支出（支出不超过预算、已分配额不超过员工奖池预算），
  // 这样所有汇总都仍是安全整数。用 BigInt 精确求和。
  const budgetSum = new Map();
  for (const p of pools.values()) {
    if (!safeInt(p?.budget)) continue;
    const key = `${Number(p?.event_id)}:${Number(p?.is_reserved) === 1 ? 1 : 0}`;
    budgetSum.set(key, (budgetSum.get(key) || 0n) + BigInt(String(p.budget)));
  }
  for (const [key, total] of budgetSum) {
    if (total > BigInt(GALA_MAX_POOLS_TOTAL)) {
      const [eventId, reserved] = key.split(':');
      errors.push(`gala_events#${eventId} 的${reserved === '1' ? '预留' : '员工'}奖池预算合计 ${total} 超过上限 ${GALA_MAX_POOLS_TOTAL}`);
    }
  }
  // 员工奖池的已分配额（各轮 单价 × 抽签人数）不能超过预算：在线抽签按这个口径准入，
  // 也是非超管看到的账面，恢复出超额的数据会让公开账面为负。
  const allocated = new Map();
  for (const r of rounds.values()) {
    if (r?.pool_id == null) continue;
    const key = Number(r.pool_id);
    allocated.set(key, (allocated.get(key) || 0) + Number(r?.amount_each || 0) * Number(r?.draw_count || 0));
  }
  for (const [poolId, total] of allocated) {
    const pool = pools.get(poolId);
    if (pool && Number(pool?.is_reserved) !== 1 && total > Number(pool?.budget || 0)) {
      errors.push(`gala_pools#${poolId} 的已分配额 ${total} 超过预算 ${Number(pool?.budget || 0)}`);
    }
  }
  // 每轮中奖人数不能超过抽签人数：用户重置会删掉未发放的记录，所以少于可以，多于不行。
  const winnersPerRound = new Map();
  for (const w of winnersList) {
    const key = Number(w?.round_id);
    winnersPerRound.set(key, (winnersPerRound.get(key) || 0) + 1);
  }
  for (const [roundId, n] of winnersPerRound) {
    const round = rounds.get(roundId);
    if (round && n > Number(round?.draw_count || 0)) {
      errors.push(`gala_rounds#${roundId} 有 ${n} 条中奖记录，超过抽签人数 ${Number(round?.draw_count || 0)}`);
    }
  }
  // 每轮最多一个预留中奖人、一个已使用名额（在线抽签每轮只消费一个名额）。
  const reservedPerRound = new Map();
  for (const w of winnersList) {
    if (Number(w?.is_reserved) !== 1) continue;
    const key = Number(w?.round_id);
    reservedPerRound.set(key, (reservedPerRound.get(key) || 0) + 1);
  }
  for (const [roundId, n] of reservedPerRound) {
    if (n > 1) errors.push(`gala_rounds#${roundId} 有 ${n} 条预留中奖记录，每轮最多 1 条`);
  }
  const slotKeys = new Map();
  for (const sl of asList(backupData?.gala_reserved_slots)) {
    if (sl?.status !== 'used') continue;
    const key = `${Number(sl?.event_id)}:${sl?.segment}:${Number(sl?.round_no)}`;
    if (slotKeys.has(key)) errors.push(`gala_reserved_slots#${sl?.id} 与 #${slotKeys.get(key)} 是同一轮的已使用名额，每轮最多 1 个`);
    else slotKeys.set(key, sl?.id);
  }
  // 与在线创建相同：每场活动未取消的预留名额不超过上限。
  const slotsPerEvent = new Map();
  for (const sl of asList(backupData?.gala_reserved_slots)) {
    if ((sl?.status ?? 'pending') === 'cancelled') continue;
    const key = Number(sl?.event_id);
    slotsPerEvent.set(key, (slotsPerEvent.get(key) || 0) + 1);
  }
  for (const [eventId, n] of slotsPerEvent) {
    if (n > GALA_MAX_RESERVED_SLOTS) errors.push(`gala_events#${eventId} 有 ${n} 个未取消的预留名额，超过上限 ${GALA_MAX_RESERVED_SLOTS}`);
  }

  // 已使用名额按“轮次:用户”建索引、预留中奖记录同样建索引，两个方向的对应校验都是线性的。
  const usedSlotsByRoundUser = new Map();
  for (const sl of asList(backupData?.gala_reserved_slots)) {
    if (sl?.status !== 'used') continue;
    const key = `${Number(sl?.used_round_id)}:${String(sl?.userid)}`;
    if (!usedSlotsByRoundUser.has(key)) usedSlotsByRoundUser.set(key, []);
    usedSlotsByRoundUser.get(key).push(sl);
  }
  const reservedWinnerKeys = new Set(winnersList
    .filter((w) => Number(w?.is_reserved) === 1)
    .map((w) => `${Number(w?.round_id)}:${String(w?.userid)}`));
  const anyWinnerKeys = new Set(winnersList.map((w) => `${Number(w?.round_id)}:${String(w?.userid)}`));
  // 已发奖励必须已计入奖池支出，否则恢复后奖池还能再发一遍。
  const awardedByPool = new Map();
  for (const w of winnersList) {
    if (w?.awarded_at == null || w?.pool_id == null) continue;
    const key = Number(w.pool_id);
    awardedByPool.set(key, (awardedByPool.get(key) || 0) + Number(w.amount || 0));
  }
  for (const [poolId, total] of awardedByPool) {
    const pool = pools.get(poolId);
    if (pool && Number(pool.spent || 0) < total) {
      errors.push(`gala_pools#${poolId} 的支出 ${Number(pool.spent || 0)} 小于已发奖励合计 ${total}`);
    }
  }
  // 轮次的完成状态必须与待发记录一致，且 status 与 granted_at 必须同时成立或同时为空：
  // 有任何待发记录却是 granted，会显示整轮完成；granted 却没有完成时间、或 drawn 却带完成时间，状态自相矛盾。
  const pendingCount = new Map();
  for (const w of winnersList) {
    if (w?.awarded_at != null || !(Number(w?.amount) > 0)) continue;
    const key = Number(w?.round_id);
    pendingCount.set(key, (pendingCount.get(key) || 0) + 1);
  }
  for (const r of rounds.values()) {
    const status = r?.status ?? 'drawn';
    if (!['drawn', 'granted'].includes(status)) {
      errors.push(`gala_rounds#${r?.id} 的状态 ${status} 无效`);
      continue;
    }
    const hasGrantedAt = r?.granted_at != null;
    if ((status === 'granted') !== hasGrantedAt) {
      errors.push(`gala_rounds#${r?.id} 的状态 ${status} 与发放完成时间${hasGrantedAt ? '（已填写）' : '（为空）'}不一致`);
      continue;
    }
    const pending = pendingCount.get(Number(r?.id)) || 0;
    if (status === 'granted' && pending > 0) {
      errors.push(`gala_rounds#${r?.id} 已标记整轮发放完成，但还有 ${pending} 条奖励待发`);
    } else if (status === 'drawn' && r?.prize_type === 'coin' && pending === 0) {
      // 反方向：发币轮已没有待发奖励却仍是 drawn，恢复后会一直显示未发完。导入时先由 completeFinishedCoinRounds 补齐。
      errors.push(`gala_rounds#${r?.id} 是发币轮且奖励已全部到账，却未标记整轮发放完成`);
    }
  }
  // 员工奖池：实际支出 + 待发普通奖励不能超过已分配额（在线时普通奖励都出自已分配的名额，这一关系恒成立）。
  // 否则恢复后按“预算 − 已分配额”准入的抽签会承诺超过实际余额的奖励。已分配额 ≤ 预算另有校验。
  // 员工奖池的余额必须够付已有的待发普通奖励，否则恢复后这些奖励必定发放失败。
  const pendingByPool = new Map();
  for (const w of winnersList) {
    if (w?.awarded_at != null || Number(w?.is_reserved) === 1 || w?.pool_id == null || !(Number(w?.amount) > 0)) continue;
    const key = Number(w.pool_id);
    pendingByPool.set(key, (pendingByPool.get(key) || 0) + Number(w.amount));
  }
  for (const [poolId, total] of pendingByPool) {
    const pool = pools.get(poolId);
    if (pool && Number(pool?.is_reserved) !== 1 && Number(pool.spent || 0) + total > Number(pool.budget || 0)) {
      errors.push(`gala_pools#${poolId} 的支出 ${Number(pool.spent || 0)} 加待发奖励 ${total} 超过预算 ${Number(pool.budget || 0)}`);
    }
  }
  // 预留奖池：已支出加待发的预留奖励不能超过预算（与在线改预算的下限一致），否则恢复后这些奖励必定发放失败。
  const pendingReservedByPool = new Map();
  for (const w of winnersList) {
    if (w?.awarded_at != null || Number(w?.is_reserved) !== 1 || w?.pool_id == null || !(Number(w?.amount) > 0)) continue;
    const key = Number(w.pool_id);
    pendingReservedByPool.set(key, (pendingReservedByPool.get(key) || 0) + Number(w.amount));
  }
  for (const [poolId, total] of pendingReservedByPool) {
    const pool = pools.get(poolId);
    if (pool && Number(pool?.is_reserved) === 1 && Number(pool.spent || 0) + total > Number(pool.budget || 0)) {
      errors.push(`gala_pools#${poolId} 的支出 ${Number(pool.spent || 0)} 加待发预留奖励 ${total} 超过预算 ${Number(pool.budget || 0)}`);
    }
  }
  for (const p of pools.values()) {
    if (Number(p?.is_reserved) === 1) continue;
    const key = Number(p?.id);
    const owed = Number(p?.spent || 0) + (pendingByPool.get(key) || 0);
    if (owed > (allocated.get(key) || 0)) {
      errors.push(`gala_pools#${key} 的支出加待发奖励 ${owed} 超过已分配额 ${allocated.get(key) || 0}`);
    }
  }

  for (const w of winnersList) {
    const round = rounds.get(Number(w?.round_id));
    if (!round || Number(round.event_id) !== Number(w?.event_id)) {
      errors.push(`gala_round_winners#${w?.id} 的轮次不存在或不属于同一活动`);
      continue;
    }
    const reserved = Number(w?.is_reserved) === 1;
    // 预留中奖记录必须对应一条已使用的预留名额（同轮次、同一人、同奖池、同金额），
    // 否则残缺备份可以凭空恢复出一笔预留奖励，发给错误的人或错误的金额。
    if (reserved) {
      const match = (usedSlotsByRoundUser.get(`${Number(w.round_id)}:${String(w.userid)}`) || []).some((sl) => Number(sl.used_round_id) === Number(w.round_id)
        && String(sl.segment) === String(round.segment)
        && Number(sl.round_no) === Number(round.round_no)
        && String(sl.userid) === String(w.userid)
        && (sl.pool_id == null ? null : Number(sl.pool_id)) === (w.pool_id == null ? null : Number(w.pool_id))
        && Number(sl.amount || 0) === Number(w.amount || 0));
      if (!match) errors.push(`gala_round_winners#${w?.id} 是预留中奖记录，但找不到对应的已使用预留名额`);
    }
    // 已发放的正数奖励必须带 ledger_id 作为付款凭据。用户重置会删除流水但保留 ledger_id，
    // 所以只要求 ledger_id 存在，不要求对应流水仍在备份里；完全没有凭据的“已发放”会让这笔奖励永远补发不了。
    if (w?.awarded_at != null && Number(w?.amount) > 0 && w?.ledger_id == null) {
      errors.push(`gala_round_winners#${w?.id} 标记已发放但没有 ledger_id，无法证明已付款`);
    }
    // 反过来：带付款凭据却没有 awarded_at，恢复后会被当成待发奖励再付一次（对应流水可能已被用户重置删除）。
    if (w?.awarded_at == null && w?.ledger_id != null) {
      errors.push(`gala_round_winners#${w?.id} 有付款凭据 ledger_id ${w.ledger_id} 却未标记发放，恢复后会重复发放`);
    }
    // 预留记录的金额与本轮普通奖励一致（发币轮为单价、无币轮为 0），奖池是预留奖池（金额为 0 时不挂奖池）：
    // 金额不同会让预留对象的余额变化与其他中奖人不同。
    if (reserved) {
      const expectAmount = round.prize_type === 'coin' ? Number(round.amount_each || 0) : 0;
      if (Number(w?.amount || 0) !== expectAmount || (expectAmount === 0 && w?.pool_id != null)) {
        errors.push(`gala_round_winners#${w?.id} 是预留中奖记录，金额或奖池与轮次 ${round.id} 的本轮奖励不一致`);
        continue;
      }
    }
    // 普通中奖记录的奖池与金额必须和所属轮次的配置一致。
    if (!reserved) {
      const coin = round.prize_type === 'coin';
      const expectPool = coin ? Number(round.pool_id) : null;
      const expectAmount = coin ? Number(round.amount_each || 0) : 0;
      const gotPool = w?.pool_id == null ? null : Number(w.pool_id);
      if (gotPool !== expectPool || Number(w?.amount || 0) !== expectAmount) {
        errors.push(`gala_round_winners#${w?.id} 的奖池或金额与轮次 ${round.id} 的配置不一致`);
        continue;
      }
    }
    if (w?.pool_id != null && !poolOk(w.pool_id, w.event_id, reserved)) {
      errors.push(`gala_round_winners#${w?.id} 引用的奖池 ${w.pool_id} 不是同一活动的${reserved ? '预留' : '员工'}奖池`);
    } else if (Number(w?.amount) > 0 && w?.pool_id == null) {
      // 已发和待发的正数奖励都必须有出处：已发的没有奖池，就是一笔不在任何预算里的支出，
      // 恢复后奖池账面会少算这笔钱（预留奖池可以借此超发）。
      errors.push(`gala_round_winners#${w?.id} 的奖励 ${w?.amount} 缺少同一活动的${reserved ? '预留' : '员工'}奖池`);
    }
  }
  // 待用名额的轮次号必须大于该活动该环节已抽的最大轮次，否则恢复后永远用不到，
  // 却会把对应的人一直排除在普通抽签之外（与在线创建时的 round_already_drawn 一致）。
  const maxDrawn = new Map();
  for (const r of rounds.values()) {
    const key = `${Number(r?.event_id)}:${r?.segment}`;
    maxDrawn.set(key, Math.max(maxDrawn.get(key) || 0, Number(r?.round_no || 0)));
  }
  // 与在线创建相同：同一活动同一环节，一个人只能有一个未取消的名额，且不能已在该环节中过奖。
  // 否则关闭“排除已中奖者”时两个名额都会兑现，或名额到时因已中奖而作废。
  const segmentWinners = new Set();
  const segmentNormalWinners = new Set();
  for (const w of winnersList) {
    const r = rounds.get(Number(w?.round_id));
    if (!r) continue;
    const key = `${Number(r.event_id)}:${r.segment}:${String(w?.userid)}`;
    segmentWinners.add(key);
    if (Number(w?.is_reserved) !== 1) segmentNormalWinners.add(key);
  }
  // 轮次自身的排除规则：开启“排除本环节已中奖者”的一轮，中奖人不能在同一活动同一环节更早的轮次里中过奖。
  // 否则同一人会在恢复后两轮都拿到奖励，而在线抽签不可能产生这样的数据。
  const roundsBySegment = new Map();
  for (const r of rounds.values()) {
    const key = `${Number(r?.event_id)}:${r?.segment}`;
    if (!roundsBySegment.has(key)) roundsBySegment.set(key, []);
    roundsBySegment.get(key).push(r);
  }
  const winnersByRound = new Map();
  for (const w of winnersList) {
    const key = Number(w?.round_id);
    if (!winnersByRound.has(key)) winnersByRound.set(key, []);
    winnersByRound.get(key).push(w);
  }
  for (const list of roundsBySegment.values()) {
    list.sort((a, b) => Number(a?.round_no) - Number(b?.round_no));
    const earlier = new Set();
    for (const r of list) {
      const ws = winnersByRound.get(Number(r?.id)) || [];
      if (Number(r?.exclude_previous_winners ?? 1) === 1) {
        for (const w of ws) {
          if (earlier.has(String(w?.userid))) {
            errors.push(`gala_round_winners#${w?.id} 在第 ${r?.round_no} 轮再次中奖，但该轮开启了排除本环节已中奖者`);
          }
        }
      }
      for (const w of ws) earlier.add(String(w?.userid));
    }
  }
  // 在线抽签对持有该活动任一未取消名额的人，在所有环节都排除出普通候选（名额用掉后依然是未取消状态）。
  // 所以已用名额兑现之后（中奖记录 id 更大的轮次），持有人在该活动任何环节都不可能再有普通中奖记录。
  const normalWinsByEventUser = new Map();
  for (const w of winnersList) {
    if (Number(w?.is_reserved) === 1) continue;
    const r = rounds.get(Number(w?.round_id));
    if (!r) continue;
    const key = `${Number(r.event_id)}:${String(w?.userid)}`;
    if (!normalWinsByEventUser.has(key)) normalWinsByEventUser.set(key, []);
    normalWinsByEventUser.get(key).push(Number(r.id));
  }
  // 待用名额的持有人必须在同一活动的名单里：在线创建要求先入名单，移出名单时名额同时作废。
  // 不在名单里的待用名额恢复后，只要在预定轮次前重新导入此人就会兑现。已使用、已取消的名额是历史记录，不受此限。
  const enrolled = new Set(asList(backupData?.gala_participants).map((p) => `${Number(p?.event_id)}:${String(p?.userid)}`));
  for (const slot of asList(backupData?.gala_reserved_slots)) {
    if ((slot?.status ?? 'pending') !== 'pending') continue;
    if (!enrolled.has(`${Number(slot?.event_id)}:${String(slot?.userid)}`)) {
      errors.push(`gala_reserved_slots#${slot?.id} 待用名额的持有人不在同一活动的参与名单里`);
    }
  }
  const liveSlotsByUser = new Map();
  for (const slot of asList(backupData?.gala_reserved_slots)) {
    if ((slot?.status ?? 'pending') === 'cancelled') continue;
    const key = `${Number(slot?.event_id)}:${slot?.segment}:${String(slot?.userid)}`;
    liveSlotsByUser.set(key, (liveSlotsByUser.get(key) || 0) + 1);
  }
  for (const slot of asList(backupData?.gala_reserved_slots)) {
    const status = slot?.status ?? 'pending';
    if (status === 'cancelled') continue;
    const key = `${Number(slot?.event_id)}:${slot?.segment}:${String(slot?.userid)}`;
    // 唯一性覆盖所有未取消的名额（含已使用）：两个已使用名额意味着同一人在同一环节拿了两次预留奖励。
    if ((liveSlotsByUser.get(key) || 0) > 1) {
      errors.push(`gala_reserved_slots#${slot?.id} 的持有人在同一活动同一环节还有别的未取消名额`);
    } else if (status === 'used' && segmentNormalWinners.has(key)) {
      // 在线抽签始终把持有未取消名额的人排除在普通候选之外（与排除开关无关），创建名额时也要求本环节没中过奖：
      // 已用名额的持有人在本环节只能有那一条预留中奖记录。
      errors.push(`gala_reserved_slots#${slot?.id} 已使用名额的持有人在同一活动同一环节还有普通中奖记录`);
    } else if (status === 'pending' && segmentWinners.has(key)) {
      errors.push(`gala_reserved_slots#${slot?.id} 待用名额的持有人已在同一活动同一环节中过奖`);
    } else if (status === 'used' && slot?.used_round_id != null
      && (normalWinsByEventUser.get(`${Number(slot?.event_id)}:${String(slot?.userid)}`) || [])
        .some((roundId) => roundId > Number(slot.used_round_id))) {
      errors.push(`gala_reserved_slots#${slot?.id} 已使用名额的持有人在名额兑现之后又在同一活动的普通抽签中中奖`);
    }
  }
  for (const slot of asList(backupData?.gala_reserved_slots)) {
    const pending = (slot?.status ?? 'pending') === 'pending';
    // 与在线创建相同：待用名额必须落在可抽签的环节、轮次号为正整数，否则永远用不到，
    // 却会把对应的人一直排除在普通抽签之外。
    if (pending && (!GALA_DRAW_SEGMENTS.has(String(slot?.segment)) || !Number.isSafeInteger(Number(slot?.round_no)) || Number(slot?.round_no) < 1)) {
      errors.push(`gala_reserved_slots#${slot?.id} 待用名额的环节 ${slot?.segment} 或轮次 ${slot?.round_no} 无效`);
    } else if (pending
      && Number(slot?.round_no) <= (maxDrawn.get(`${Number(slot?.event_id)}:${slot?.segment}`) || 0)) {
      errors.push(`gala_reserved_slots#${slot?.id} 待用名额的第 ${slot?.round_no} 轮已经抽过`);
    }
    if (slot?.pool_id != null && !poolOk(slot.pool_id, slot.event_id, true)) {
      errors.push(`gala_reserved_slots#${slot?.id} 引用的奖池 ${slot.pool_id} 不是同一活动的预留奖池`);
    } else if (pending && slot?.pool_id == null) {
      // 待用名额中奖时按本轮单价从预留奖池付款，必须指定预留奖池。
      errors.push(`gala_reserved_slots#${slot?.id} 待用名额缺少同一活动的预留奖池`);
    } else if (slot?.status === 'used' && Number(slot?.amount) > 0 && slot?.pool_id == null) {
      errors.push(`gala_reserved_slots#${slot?.id} 的名额奖励 ${slot?.amount} 缺少同一活动的预留奖池`);
    }
    if (slot?.status === 'used' && slot?.used_round_id == null) {
      errors.push(`gala_reserved_slots#${slot?.id} 已使用却没有关联轮次`);
    }
    if (slot?.used_round_id != null) {
      const used = rounds.get(Number(slot.used_round_id));
      if (!used || Number(used.event_id) !== Number(slot.event_id)) {
        errors.push(`gala_reserved_slots#${slot?.id} 引用的轮次 ${slot.used_round_id} 不在备份的同一活动中`);
      } else if (String(used.segment) !== String(slot?.segment) || Number(used.round_no) !== Number(slot?.round_no)) {
        errors.push(`gala_reserved_slots#${slot?.id} 预定的是 ${slot?.segment} 第 ${slot?.round_no} 轮，却记在轮次 ${used.id}（${used.segment} 第 ${used.round_no} 轮）上`);
      } else if (slot?.status === 'used'
        && Number(slot?.amount || 0) !== (String(used.prize_type) === 'coin' ? Number(used.amount_each || 0) : 0)) {
        // 已使用名额记下的奖励必须等于关联轮次的奖励（发币轮为单价、无币轮为 0），与中奖记录是否还在无关：
        // 用户重置后中奖记录可以合法消失，名额金额仍是超管看到的历史奖励。
        errors.push(`gala_reserved_slots#${slot?.id} 已使用名额的奖励 ${Number(slot?.amount || 0)} 与轮次 ${used.id} 的奖励不一致`);
      } else if (slot?.status === 'used') {
        // 已使用的名额占本轮一个位置。对应的预留中奖记录只会因用户重置被删掉，那时本轮一定空出一个位置；
        // 记录不在、位置却被别人占满，说明这一位被换成了普通中奖人，恢复后会从员工奖池发给错误的人。
        // 名额持有人在本轮以普通中奖记录出现，同样是被改了标记：恢复后会从员工奖池给预留对象发币。
        const key = `${Number(used.id)}:${String(slot?.userid)}`;
        const hasWinner = reservedWinnerKeys.has(key);
        if (!hasWinner && anyWinnerKeys.has(key)) {
          errors.push(`gala_reserved_slots#${slot?.id} 已使用，但持有人在轮次 ${used.id} 里是普通中奖记录`);
        } else if (!hasWinner && (winnersPerRound.get(Number(used.id)) || 0) >= Number(used.draw_count || 0)) {
          errors.push(`gala_reserved_slots#${slot?.id} 已使用，但轮次 ${used.id} 里没有它的中奖记录且名额已被占满`);
        }
      }
    }
  }
  return errors;
}

export function registerAdminBackupRoutes(router) {

  // 设置类表：结构配置，适合日常导出恢复
  const SETTINGS_TABLES = [
    'system_settings',
    'mall_products',
    'charity_projects',
    'mall_opening_schedule',
    'content_faq',
    'content_announcements',
    'content_announcement_revisions',
    'system_versions',
    'admin_roles',
  ];

  const SETTINGS_RECOVERY_TABLES = [
    ...SETTINGS_TABLES,
    'content_announcement_acknowledgements',
  ];

  // 全量表：包含用户数据（顺序决定导入顺序，users 必须最先）
  const FULL_TABLES = [
    'users',
    'accounts',
    'external_accounts',
    'bob_tokens',
    'ledger',
    'redeems',
    'mall_order_listings',
    'redeem_cdks',
    'mall_products',
    'charity_projects',
    'charity_contributions',
    'attendance_reward_records',
    'mall_opening_schedule',
    'red_packet_activity',
    'red_packet_items',
    'auction_activities',
    'auction_bids',
    'gala_events',
    'gala_pools',
    'gala_participants',
    'gala_rounds',
    'gala_round_winners',
    'gala_reserved_slots',
    'content_faq',
    'content_announcements',
    'content_announcement_revisions',
    'content_announcement_acknowledgements',
    'system_versions',
    'user_feedback',
    'user_feedback_messages',
    'audit_logs',
    'admin_roles',
    'admin_user_roles',
    'system_settings',
  ];

  // 全量恢复拿不到表锁时整体重试（见导入处说明）。只有加锁这一步抛出的 restoreLockBusy 会重试，
  // 它发生在恢复写入任何数据之前，重试不会重复执行副作用。
  async function runWithRestoreLockRetry(db, fn, { attempts = 60 } = {}) {
    for (let i = 1; ; i += 1) {
      try {
        return await runInTransaction(db, fn);
      } catch (err) {
        if (!err?.restoreLockBusy || i >= attempts) throw err;
        await new Promise((resolve) => { setTimeout(resolve, Math.min(50 * i, 500)); });
      }
    }
  }

  async function dumpTable(db, tableName) {
    try {
      const rows = await db.all(`SELECT * FROM ${tableName}`, []);
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      throw new Error(`导出表 ${tableName} 失败: ${String(err?.message || err)}`);
    }
  }

  function backupStorageDir() {
    // 优先 BOB_BACKUP_DIR；默认使用项目父目录 bob-admin-backups，避免被部署 rsync --delete 清掉。
    if (process.env.BOB_BACKUP_DIR) return String(process.env.BOB_BACKUP_DIR);
    return path.join(path.dirname(fileURLToPath(new URL('../../../', import.meta.url))), 'bob-admin-backups');
  }

  function safeBackupFilename(filename) {
    const name = path.basename(String(filename || '').trim());
    // 兼容旧：YYYYMMDD_HHMM；新：YYYYMMDD_HHMMSS_随机后缀，避免同一分钟互相覆盖
    if (!/^bob_backup_(settings|full)_\d{8}_\d{4,6}(?:_[a-zA-Z0-9]+)?\.json$/.test(name)) {
      throw new Error('备份文件名不合法');
    }
    return name;
  }

  function buildBackupFilename(mode) {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');
    const rand = Math.random().toString(36).slice(2, 8);
    return `bob_backup_${mode}_${stamp}_${rand}.json`;
  }

  function isFullBackupFilename(filename) {
    return /^bob_backup_full_/.test(String(filename || ''));
  }

  function backupFilePath(filename) {
    return path.join(backupStorageDir(), safeBackupFilename(filename));
  }

  function writeBackupFile(filename, payload) {
    const dir = backupStorageDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // 部分文件系统/属主下 chmod 可能失败，不阻断写入
    }
    const filePath = backupFilePath(filename);
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // ignore
    }
    const stat = statSync(filePath);
    return { filePath, size: stat.size };
  }

  async function appendBackupHistory(db, req, input) {
    const payload = (await getAdminSessionPayload(req)) || {};
    await db.run(
      `INSERT INTO admin_backup_history(action, mode, filename, status, actor_id, actor_name, details, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      [
        input.action,
        input.mode,
        input.filename || '',
        input.status || '完成',
        payload?.userid ? String(payload.userid) : '',
        payload?.name ? String(payload.name) : '',
        input.details ? JSON.stringify(input.details) : null,
      ],
    );
  }

  router.get('/backup/history', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limit = Math.min(100, Math.max(1, toPositiveInt(req.query?.limit, 30)));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT id, action, mode, filename, status, actor_id, actor_name, details, created_at AS at
         FROM admin_backup_history
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [limit],
      );
      return res.json({ ok: true, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  function redactBackupSecrets(tableName, rows, { keepSecrets = false } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    // 自动恢复点必须保留密钥，否则回滚后钉钉 OAuth/通知/Stream 会中断。
    // 普通导出仍脱敏。
    if (keepSecrets) return list.map((row) => ({ ...row }));
    if (tableName === 'bob_tokens') {
      return list.map((row) => ({
        ...row,
        token: null,
      }));
    }
    if (tableName === 'system_settings') {
      return list.map((row) => {
        const key = String(row?.key || '');
        if (key !== 'dingtalk_connection_settings') return row;
        try {
          const parsed = JSON.parse(String(row.value || '{}'));
          if (parsed && typeof parsed === 'object') {
            if (parsed.appSecret) parsed.appSecret = '';
            if (parsed.app_secret) parsed.app_secret = '';
            return { ...row, value: JSON.stringify(parsed) };
          }
        } catch {
          // keep original if not json
        }
        return row;
      });
    }
    return list;
  }

  async function mergeSystemSettingValue(tx, key, value) {
    const k = String(key || '');
    if (k !== 'dingtalk_connection_settings') return value ?? null;
    let incoming = {};
    try {
      incoming = JSON.parse(String(value || '{}')) || {};
    } catch {
      return value ?? null;
    }
    if (!incoming || typeof incoming !== 'object') return value ?? null;
    const secretIn = String(incoming.appSecret || incoming.app_secret || '').trim();
    if (secretIn) return JSON.stringify(incoming);
    const existing = await tx.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', [k]);
    let current = {};
    try {
      current = JSON.parse(String(existing?.value || '{}')) || {};
    } catch {
      current = {};
    }
    if (current && typeof current === 'object') {
      if (current.appSecret) incoming.appSecret = current.appSecret;
      if (current.app_secret) incoming.app_secret = current.app_secret;
    }
    return JSON.stringify(incoming);
  }

  async function dumpTablesConsistently(db, tables, { keepSecrets = false } = {}) {
    return runInTransaction(db, async (tx) => {
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', []);
      const data = {};
      for (const tableName of tables) {
        // eslint-disable-next-line no-await-in-loop
        data[tableName] = redactBackupSecrets(tableName, await dumpTable(tx, tableName), { keepSecrets });
      }
      return data;
    });
  }

  // GET /admin/backup/export?mode=settings|full
  router.get('/backup/export', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const mode = req.query?.mode === 'full' ? 'full' : 'settings';
    const tables = mode === 'full' ? FULL_TABLES : SETTINGS_TABLES;
    try {
      // 全量备份仅超级管理员；设置备份保持 integrations:export 权限控制。
      if (mode === 'full' && !isSuperAdminSession(req.app?.locals?.cfg, req.adminSession || {})) {
        return res.status(403).json({ error: '全量备份仅超级管理员可导出' });
      }
      res.setHeader('Cache-Control', 'no-store');
      const data = await dumpTablesConsistently(db, tables);
      const now = new Date();
      const filename = buildBackupFilename(mode);
      const payload = {
        _meta: {
          version: 2,
          mode,
          filename,
          exportedAt: now.toISOString(),
          // 含年会数据的全量格式：导入时要求六张年会表齐全（见 requiresGalaTables）。
          ...(mode === 'full' ? { galaFormat: GALA_BACKUP_FORMAT } : {}),
          tables: Object.fromEntries(tables.map((t) => [t, data[t]?.length ?? 0])),
          secretsRedacted: true,
        },
        data,
      };
      const stored = writeBackupFile(filename, payload);
      await appendBackupHistory(db, req, {
        action: '导出',
        mode,
        filename,
        status: '完成',
        details: { ...payload._meta, size: stored.size, downloadable: true },
      });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.json(payload);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/backup/history/:id/download', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toPositiveInt(req.params?.id, 0);
    if (!id) return res.status(400).json({ error: '缺少备份记录 ID' });
    try {
      const row = await db.get(
        `SELECT id, action, filename, mode, details
         FROM admin_backup_history
         WHERE id = ?
         LIMIT 1`,
        [id],
      );
      if (!row || row.action !== '导出' || !row.filename) {
        return res.status(404).json({ error: '未找到可下载的备份文件' });
      }
      const filename = safeBackupFilename(row.filename);
      const modeHint = String(row.mode || '').trim().toLowerCase();
      const isFull = modeHint === 'full' || isFullBackupFilename(filename);
      let isRecoveryPoint = false;
      let secretsNotRedacted = false;
      try {
        const details = row.details ? JSON.parse(String(row.details)) : null;
        isRecoveryPoint = details?.purpose === 'pre_import_recovery_point';
        secretsNotRedacted = details?.secretsRedacted === false;
      } catch {
        isRecoveryPoint = false;
        secretsNotRedacted = false;
      }
      // 全量备份 / 导入前恢复点（含明文 AppSecret）仅超级管理员可下载。
      // 设置模式的普通导出仍可由 integrations:export 下载（已脱敏）。
      const needsSuper = isFull || isRecoveryPoint || secretsNotRedacted;
      if (needsSuper && !isSuperAdminSession(req.app?.locals?.cfg, req.adminSession || {})) {
        return res.status(403).json({
          error: isFull
            ? '全量备份仅超级管理员可下载'
            : '含密钥的恢复点仅超级管理员可下载',
        });
      }
      const filePath = backupFilePath(filename);
      if (!existsSync(filePath)) {
        return res.status(404).json({ error: '服务器上的备份文件不存在，请重新导出' });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.download(filePath, filename);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // POST /admin/backup/import
  // body: { backup: <备份 JSON 对象>, mode: 'merge'|'overwrite' }
  // 安全约束：预校验 schema、覆盖前自动快照、全量在单事务内执行；任意失败回滚，禁止吞错后返回成功。
  router.post('/backup/import', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const backup = req.body?.backup;
    const mode = req.body?.mode === 'overwrite' ? 'overwrite' : 'merge';
    const requestedFilename = String(req.body?.filename || backup?._meta?.filename || '').trim();

    const failHistory = async (status, details) => {
      try {
        await appendBackupHistory(db, req, {
          action: '导入',
          mode,
          filename: requestedFilename,
          status,
          details,
        });
      } catch {
        // 历史记录失败不影响主错误返回
      }
    };

    if (!backup || typeof backup !== 'object' || !backup.data || typeof backup.data !== 'object') {
      return res.status(400).json({ error: '无效的备份文件格式' });
    }
    const backupVersion = Number(backup._meta?.version);
    if (![1, 2].includes(backupVersion)) {
      return res.status(400).json({ error: `不支持的备份版本: ${backup._meta?.version}` });
    }

    // 年会数据格式号：本版本只认识 GALA_BACKUP_FORMAT。更新版本导出的备份可能带本版本不知道的年会字段或规则，
    // 按旧规则补默认值写入会恢复出错误的数据，写库前拒绝。
    if (isUnsupportedGalaFormat(backup._meta)) {
      await failHistory('失败', { reason: 'unsupported_gala_format', galaFormat: backup._meta.galaFormat });
      return res.status(400).json({
        error: `不支持的年会备份格式: ${backup._meta.galaFormat}`,
        reason: 'unsupported_gala_format',
      });
    }

    const backupMode = backup._meta?.mode === 'full' ? 'full' : 'settings';
    const isSettingsRecoveryPoint = backupMode === 'settings'
      && backup._meta?.purpose === 'pre_import_recovery_point';
    if (isSettingsRecoveryPoint && backupVersion !== 2) {
      return res.status(400).json({ error: '设置自动恢复点必须使用备份版本 2' });
    }
    if (isSettingsRecoveryPoint && mode !== 'overwrite') {
      return res.status(400).json({ error: '设置自动恢复点仅允许覆盖导入' });
    }
    const backupData = backup.data;
    const v1ExcludedTables = new Set([
      'content_announcement_revisions',
      'content_announcement_acknowledgements',
    ]);
    const modeTables = backupMode === 'full'
      ? FULL_TABLES
      : isSettingsRecoveryPoint
        ? SETTINGS_RECOVERY_TABLES
        : SETTINGS_TABLES;
    const versionTables = backupVersion === 1
      ? modeTables.filter((name) => !v1ExcludedTables.has(name))
      : modeTables;
    const allowedTables = new Set(versionTables);
    const unknownTables = Object.keys(backupData).filter((name) => !allowedTables.has(name));
    if (unknownTables.length > 0) {
      await failHistory('失败', { reason: 'unknown_tables', unknownTables, backupMode });
      return res.status(400).json({
        error: `备份包含未知表，已拒绝导入: ${unknownTables.join(', ')}`,
        unknownTables,
      });
    }

    // overwrite 必须包含该模式下的完整表集合；缺失表不得被当成空数组后 DELETE。
    // 例外：拍卖表与外部账号表晚于备份版本号引入，早于该功能的旧全量备份（v1 或对应功能之前的 v2）
    // 都不含这些表，不能因此拒绝旧备份恢复；仍需校验快照内的关联数据完整性。
    const optionalFullTables = new Set(['auction_activities', 'auction_bids', 'external_accounts']);
    // 年会表同理：早于年会功能的全量备份不含这些表；含其一则下面要求六张齐全。
    for (const table of GALA_BACKUP_TABLES) optionalFullTables.add(table.name);
    const expectedTables = versionTables.filter((name) => !optionalFullTables.has(name));
    if (mode === 'overwrite') {
      const missingTables = expectedTables.filter((name) => backupData[name] == null);
      if (missingTables.length > 0) {
        await failHistory('失败', { reason: 'missing_tables_for_overwrite', missingTables, backupMode });
        return res.status(400).json({
          error: `覆盖导入要求备份包含全部 ${expectedTables.length} 张表，缺失: ${missingTables.join(', ')}`,
          missingTables,
          backupMode,
        });
      }
    }

    // 年会表晚于拍卖引入：早于年会功能的旧备份可以一张都没有；只要含其中任意一张，就必须六张齐全，
    // 否则会恢复出有中奖记录却无奖池/活动、或有发放流水却无幂等记录的残缺账目。
    // 新版全量格式（_meta.galaFormat，或 _meta.tables 里列了年会表）确知包含年会数据：整组缺失同样拒绝，
    // 不能当成旧备份去覆盖清空在线的中奖记录和付款凭据。
    // 合并导入不导入年会表（年会数据只随全量覆盖恢复，见下方导入处），备份里的年会数据不需要校验。
    if (backupMode === 'full' && mode === 'overwrite') {
      const present = GALA_BACKUP_TABLES.filter((t) => backupData[t.name] != null).map((t) => t.name);
      if ((present.length > 0 || requiresGalaTables(backup?._meta)) && present.length < GALA_BACKUP_TABLES.length) {
        const missingTables = GALA_BACKUP_TABLES.map((t) => t.name).filter((n) => !present.includes(n));
        await failHistory('失败', { reason: 'incomplete_gala_tables', missingTables, backupMode });
        return res.status(400).json({ error: `年会数据必须整组导入，缺失: ${missingTables.join(', ')}`, missingTables, backupMode });
      }
      // 当前格式的覆盖导入：各表行数必须与导出时记在 _meta.tables 里的一致（见 findGalaRowCountErrors）。
      // 被截短的数组（例如名单变成 []、中奖记录变成 []）在没有其他引用时校验发现不了：覆盖会恢复出残缺的活动，
      // 随后的完成状态补齐还会把原本待发的发币轮当成已发完。当前格式只有整库导出，没有按活动的部分备份。
      {
        const countErrors = findGalaRowCountErrors(backupData, backup?._meta, {
          required: [...new Set([...FULL_TABLES, ...GALA_BACKUP_TABLES.map((t) => t.name)])],
        });
        if (countErrors.length) {
          await failHistory('失败', { reason: 'gala_row_count_mismatch', errors: countErrors, backupMode });
          return res.status(400).json({
            error: `年会数据行数与导出记录不一致，已拒绝导入：${countErrors.slice(0, 5).join('；')}`,
            errors: countErrors,
            backupMode,
          });
        }
      }
      // 轮次的排除开关：当前格式必须带齐，旧格式按中奖记录推断并写回（见 prepareGalaRoundFlags）。
      {
        const flagErrors = prepareGalaRoundFlags(backupData, backup?._meta);
        if (flagErrors.length) {
          await failHistory('失败', { reason: 'invalid_gala_round_flags', errors: flagErrors.slice(0, 20), backupMode });
          return res.status(400).json({
            error: `年会轮次数据不完整，已拒绝导入：${flagErrors.slice(0, 5).join('；')}`,
            errors: flagErrors.slice(0, 20),
            backupMode,
          });
        }
      }
      // 奖励已全部到账却仍是 drawn 的发币轮补成完成（见 completeFinishedCoinRounds）。
      completeFinishedCoinRounds(backupData);
      // 引用与资金关系校验（见 findGalaFundingErrors）：子记录必须引用备份内同一活动的父记录，
      // 未发放的正数奖励必须挂在类型一致的奖池上，员工奖池不超活动总预算，发放流水与幂等闸门一致。
      {
        const galaFundingErrors = findGalaFundingErrors(backupData);
        if (galaFundingErrors.length) {
          await failHistory('失败', { reason: 'invalid_gala_funding', errors: galaFundingErrors.slice(0, 20), backupMode });
          return res.status(400).json({
            error: `年会数据引用或资金关系不完整，已拒绝导入：${galaFundingErrors.slice(0, 5).join('；')}`,
            errors: galaFundingErrors.slice(0, 20),
            backupMode,
          });
        }
      }
    }

    // 拍卖两张表必须成对出现：旧备份可以两张都没有（按空处理），
    // 但只含活动、缺出价（或反之）的残缺备份会恢复出带 current_bid_id/冻结价却无出价记录的活动，
    // 造成有扣款无可退出价、拍卖无法结算，故拒绝“只缺其一”的备份。
    if (backupMode === 'full') {
      const hasAuctionActivities = backupData.auction_activities != null;
      const hasAuctionBids = backupData.auction_bids != null;
      if (hasAuctionActivities !== hasAuctionBids) {
        const missingTable = hasAuctionActivities ? 'auction_bids' : 'auction_activities';
        await failHistory('失败', { reason: 'incomplete_auction_pair', missingTable, backupMode });
        return res.status(400).json({
          error: `拍卖数据必须成对导入，缺失: ${missingTable}`,
          missingTable,
          backupMode,
        });
      }
    }

    const parseRolePermissions = (value) => {
      if (Array.isArray(value)) return normalizePermissions(value);
      try {
        return normalizePermissions(JSON.parse(String(value || '[]')));
      } catch (err) {
        throw new Error(`角色权限 JSON 无效: ${String(err?.message || err)}`);
      }
    };

    const nowTs = () => Math.floor(Date.now() / 1000);

    const requireArray = (tableName) => {
      if (backupData[tableName] == null) return null;
      if (!Array.isArray(backupData[tableName])) {
        throw new Error(`备份表 ${tableName} 必须是数组`);
      }
      return backupData[tableName];
    };

    // 把序列推进到表内最大 ID 之后。setval 不随事务回滚：全量恢复在推进之后仍可能被后面的核对拒绝，
    // 那时在线库的序号已被推到备份里的 ID（可能接近安全整数上限）。全量恢复改用 ALTER SEQUENCE … RESTART，
    // 它随事务回滚；全量恢复已用 EXCLUSIVE 锁住所有表，序列上的锁不会挡到别人。设置类导入不锁表，保持原样。
    const bumpSerial = async (tx, tableName) => {
      if (backupMode === 'full') {
        await tx.exec(
          // 已用到序列上限（年会表、流水为最大安全整数）的表照常恢复，序列停在“已用尽”：之后新建报序列耗尽，
          // 不会再分出重复的 ID。RESTART 之后同一事务里的 nextval 随事务回滚，恢复失败时在线序列不变。
          `DO $$
           DECLARE
             seq regclass := pg_get_serial_sequence('${tableName}', 'id')::regclass;
             mx BIGINT := (SELECT seqmax FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence('${tableName}', 'id')::regclass);
             target NUMERIC := COALESCE((SELECT MAX(id) FROM ${tableName}), 1) + 1;
           BEGIN
             IF target > mx THEN
               EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s', seq, mx);
               PERFORM nextval(seq);
             ELSE
               EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s', seq, target);
             END IF;
           END $$`,
          [],
        );
        return;
      }
      await tx.exec(
        `SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), COALESCE((SELECT MAX(id) FROM ${tableName}), 1), true)`,
        [],
      );
    };

    const execOrThrow = async (tx, sql, params, context) => {
      try {
        await tx.exec(sql, params);
      } catch (err) {
        const msg = String(err?.message || err);
        throw new Error(`${context}: ${msg}`);
      }
    };

    // 预校验：不改库，只验证结构与关键键，避免覆盖删除后才发现备份不可恢复。
    const preflightErrors = [];
    const pushPreflight = (table, index, message) => {
      preflightErrors.push({ table, index, message });
    };

    try {
      for (const tableName of Object.keys(backupData)) {
        requireArray(tableName);
      }

      const systemSettings = requireArray('system_settings') || [];
      systemSettings.forEach((row, index) => {
        if (!row || typeof row !== 'object' || !row.key) pushPreflight('system_settings', index, '缺少 key');
      });

      const adminRoles = requireArray('admin_roles') || [];
      adminRoles.forEach((row, index) => {
        if (!row?.code || !row?.name) pushPreflight('admin_roles', index, '缺少 code/name');
        try {
          parseRolePermissions(row?.permissions);
        } catch (err) {
          pushPreflight('admin_roles', index, String(err.message || err));
        }
      });

      const mallProducts = requireArray('mall_products') || [];
      mallProducts.forEach((row, index) => {
        if (!row?.product_id) pushPreflight('mall_products', index, '缺少 product_id');
      });

      const charityProjects = requireArray('charity_projects') || [];
      charityProjects.forEach((row, index) => {
        if (!row?.project_id) pushPreflight('charity_projects', index, '缺少 project_id');
      });

      // 拍卖恢复一致性：结算按 bid id 查获胜者但不约束 activity_id，
      // 故快照里 current_bid_id 必须指向本活动、状态 held 的出价，且 bidder/金额一致；
      // 出价的 activity_id 也不得悬挂。拒绝损坏/被篡改的快照，避免恢复后错判获胜者。
      const auctionActivities = requireArray('auction_activities') || [];
      const auctionBids = requireArray('auction_bids') || [];
      const auctionBidById = new Map(auctionBids.map((b) => [Number(b?.id), b]));
      const auctionActivityById = new Map(auctionActivities.map((a) => [Number(a?.id), a]));
      const auctionActivityIds = new Set(auctionActivities.map((a) => Number(a?.id)).filter(Number.isSafeInteger));
      auctionActivities.forEach((row, index) => {
        if (!row?.id) {
          pushPreflight('auction_activities', index, '缺少 id');
          return;
        }
        if (row.current_bid_id === undefined || row.current_bid_id === null) return;
        const bid = auctionBidById.get(Number(row.current_bid_id));
        if (!bid) {
          pushPreflight('auction_activities', index, `current_bid_id ${row.current_bid_id} 无对应出价`);
          return;
        }
        if (Number(bid.activity_id) !== Number(row.id)) {
          pushPreflight('auction_activities', index, `current_bid_id ${row.current_bid_id} 属于其他活动`);
        }
        if (String(bid.state) !== 'held') {
          pushPreflight('auction_activities', index, `current_bid_id ${row.current_bid_id} 出价状态非 held`);
        }
        if (row.current_bid_userid != null && String(bid.userid) !== String(row.current_bid_userid)) {
          pushPreflight('auction_activities', index, 'current_bid_userid 与出价不一致');
        }
        if (row.current_price != null && Number(bid.amount) !== Number(row.current_price)) {
          pushPreflight('auction_activities', index, 'current_price 与出价金额不一致');
        }
      });
      auctionBids.forEach((row, index) => {
        if (!row?.id) {
          pushPreflight('auction_bids', index, '缺少 id');
          return;
        }
        if (!auctionActivityIds.has(Number(row?.activity_id))) {
          pushPreflight('auction_bids', index, `activity_id ${row?.activity_id} 无对应活动`);
        }
        // 反向不变式：每条 held 出价必须正被其所属活动的 current_bid_id 引用。
        // 否则恢复后出现「有扣款却无活动指针」的在押出价：结算判定无获胜者、取消不退款，
        // 且后续任何出价都会撞 idx_auction_bids_held_once（每场至多一条 held）。
        if (String(row?.state) === 'held') {
          const activity = auctionActivityById.get(Number(row?.activity_id));
          if (activity && Number(activity.current_bid_id) !== Number(row?.id)) {
            pushPreflight('auction_bids', index, `held 出价 ${row?.id} 未被所属活动 current_bid_id 引用`);
          }
        }
      });

      const mallOpening = requireArray('mall_opening_schedule') || [];
      if (mallOpening.length > 0 && (!mallOpening[0] || typeof mallOpening[0] !== 'object')) {
        pushPreflight('mall_opening_schedule', 0, '行数据无效');
      }

      for (const tableName of ['content_faq', 'content_announcements', 'system_versions']) {
        const rows = requireArray(tableName) || [];
        rows.forEach((row, index) => {
          if (!row?.id) pushPreflight(tableName, index, '缺少 id');
        });
      }

      const announcements = requireArray('content_announcements') || [];
      announcements.forEach((row, index) => {
        if (row?.edit_version === undefined || row?.edit_version === null) return;
        const editVersion = Number(row.edit_version);
        if (!Number.isSafeInteger(editVersion) || editVersion <= 0) {
          pushPreflight('content_announcements', index, 'edit_version 必须为正整数');
        }
      });
      const announcementIds = new Set(announcements.map((row) => Number(row?.id)).filter(Number.isSafeInteger));
      const announcementRevisionHashes = new Map();
      const seenAnnouncementRevisionKeys = new Set();
      const revisions = requireArray('content_announcement_revisions') || [];
      revisions.forEach((row, index) => {
        const announcementId = Number(row?.announcement_id);
        const revision = Number(row?.revision);
        const contentHash = String(row?.content_hash || '').toLowerCase();
        const expectedHash = computeAnnouncementContentHash({
          title: row?.title,
          content: row?.content,
          requiresAcknowledgement: Number(row?.requires_acknowledgement || 0) === 1,
        });
        if (!Number.isSafeInteger(announcementId) || announcementId <= 0) {
          pushPreflight('content_announcement_revisions', index, 'announcement_id 无效');
        }
        if (!Number.isSafeInteger(revision) || revision <= 0) {
          pushPreflight('content_announcement_revisions', index, 'revision 无效');
        }
        if (!/^[a-f0-9]{64}$/i.test(contentHash)) {
          pushPreflight('content_announcement_revisions', index, 'content_hash 必须为 64 位十六进制');
        } else if (contentHash !== expectedHash) {
          pushPreflight('content_announcement_revisions', index, 'content_hash 与修订正文不匹配');
        }
        if (!announcementIds.has(announcementId)) {
          pushPreflight('content_announcement_revisions', index, '找不到关联公告');
        }
        if (Number.isSafeInteger(announcementId) && announcementId > 0
          && Number.isSafeInteger(revision) && revision > 0) {
          const revisionKey = `${announcementId}:${revision}`;
          if (seenAnnouncementRevisionKeys.has(revisionKey)) {
            pushPreflight('content_announcement_revisions', index, 'announcement_id/revision 重复');
          } else {
            seenAnnouncementRevisionKeys.add(revisionKey);
            announcementRevisionHashes.set(revisionKey, {
              hash: expectedHash,
              requiresAcknowledgement: Number(row?.requires_acknowledgement || 0) === 1,
            });
          }
        }
      });

      if (backupVersion === 2) {
        announcements.forEach((row, index) => {
          const announcementId = Number(row?.id);
          const revision = Number(row?.revision);
          const contentHash = String(row?.content_hash || '').toLowerCase();
          const requiresAcknowledgement = Number(row?.requires_acknowledgement || 0) === 1;
          const expectedHash = computeAnnouncementContentHash({
            title: row?.title,
            content: row?.content,
            requiresAcknowledgement,
          });
          if (!Number.isSafeInteger(revision) || revision <= 0) {
            pushPreflight('content_announcements', index, 'revision 无效');
          }
          if (!/^[a-f0-9]{64}$/i.test(contentHash)) {
            pushPreflight('content_announcements', index, 'content_hash 必须为 64 位十六进制');
          } else if (contentHash !== expectedHash) {
            pushPreflight('content_announcements', index, 'content_hash 与当前正文不匹配');
          }
          if (requiresAcknowledgement && Number(row?.show_fullscreen || 0) !== 1) {
            pushPreflight('content_announcements', index, '要求确认的公告必须全屏展示');
          }
          if (announcementRevisionHashes.get(`${announcementId}:${revision}`)?.hash !== expectedHash) {
            pushPreflight('content_announcements', index, '找不到与当前公告一致的修订快照');
          }
        });
      }

      if (backupMode === 'full' || isSettingsRecoveryPoint) {
        const users = backupMode === 'full' ? (requireArray('users') || []) : [];
        const currentUsers = isSettingsRecoveryPoint
          ? await db.all('SELECT userid FROM users', [])
          : users;
        const userIds = new Set(currentUsers.map((row) => String(row?.userid || '')).filter(Boolean));
        if (backupMode === 'full') {
          users.forEach((row, index) => {
            if (!row?.userid) pushPreflight('users', index, '缺少 userid');
          });
        }
        const acknowledgements = requireArray('content_announcement_acknowledgements') || [];
        acknowledgements.forEach((row, index) => {
          const announcementId = Number(row?.announcement_id);
          const revision = Number(row?.revision);
          const action = String(row?.action || '');
          if (!row?.userid) pushPreflight('content_announcement_acknowledgements', index, '缺少 userid');
          if (row?.userid && !userIds.has(String(row.userid))) {
            pushPreflight('content_announcement_acknowledgements', index, '找不到关联用户');
          }
          if (!Number.isSafeInteger(announcementId) || announcementId <= 0) {
            pushPreflight('content_announcement_acknowledgements', index, 'announcement_id 无效');
          }
          if (!Number.isSafeInteger(revision) || revision <= 0) {
            pushPreflight('content_announcement_acknowledgements', index, 'revision 无效');
          }
          if (!/^[a-f0-9]{64}$/i.test(String(row?.content_hash || ''))) {
            pushPreflight('content_announcement_acknowledgements', index, 'content_hash 必须为 64 位十六进制');
          }
          if (!['acknowledged', 'dismissed'].includes(action)) {
            pushPreflight('content_announcement_acknowledgements', index, 'action 无效');
          }
          const revisionSnapshot = announcementRevisionHashes.get(`${announcementId}:${revision}`);
          if (!revisionSnapshot) {
            pushPreflight('content_announcement_acknowledgements', index, '找不到关联公告修订');
          } else if (revisionSnapshot.hash !== String(row?.content_hash || '').toLowerCase()) {
            pushPreflight('content_announcement_acknowledgements', index, 'content_hash 与关联修订不匹配');
          } else if (revisionSnapshot.requiresAcknowledgement && action !== 'acknowledged') {
            pushPreflight('content_announcement_acknowledgements', index, '强制确认公告不允许 dismissed');
          }
        });

        // 外部账号必须带凭据且能对上本批 users：缺凭据恢复后无法登录，手机号唯一还会挡住重新注册。
        if (backupMode === 'full') {
          const externalAccounts = requireArray('external_accounts') || [];
          const usersById = new Map(users.map((row) => [String(row?.userid || ''), row]));
          const externalByUserid = new Map(externalAccounts.map((row) => [String(row?.userid || ''), row]));
          users.forEach((row, index) => {
            if (row?.source === 'external' && !externalByUserid.has(String(row.userid))) {
              pushPreflight('users', index, '外部用户缺少关联密码凭据');
            }
          });
          externalAccounts.forEach((row, index) => {
            if (!row?.userid || !row?.phone) pushPreflight('external_accounts', index, '缺少 userid/phone');
            if (!row?.password_hash || !row?.password_salt) {
              pushPreflight('external_accounts', index, '缺少密码凭据');
            }
            const user = usersById.get(String(row?.userid || ''));
            if (!user) {
              pushPreflight('external_accounts', index, '找不到关联用户');
            } else if (user.source !== 'external' || String(user.phone || '') !== String(row.phone || '')) {
              pushPreflight('external_accounts', index, '关联用户来源或手机号不一致');
            }
          });
        }
      }

      if (backupMode === 'full') {
        const accounts = requireArray('accounts') || [];
        accounts.forEach((row, index) => {
          if (!row?.userid) pushPreflight('accounts', index, '缺少 userid');
        });

        const bobTokens = requireArray('bob_tokens') || [];
        bobTokens.forEach((row, index) => {
          if (!row?.token_hash) pushPreflight('bob_tokens', index, '缺少 token_hash');
        });

        const ledger = requireArray('ledger') || [];
        ledger.forEach((row, index) => {
          if (!row?.id || !row?.userid) {
            pushPreflight('ledger', index, '缺少 id/userid');
          } else if (!/^[1-9][0-9]{0,15}$/.test(String(row.id)) || !Number.isSafeInteger(Number(row.id))) {
            // 流水序列的上限是最大安全整数（在线分配不出更大的 id）。显式 INSERT 不受序列上限约束，
            // 越界的 id 一旦写入，恢复后序列只能停在“已用尽”，之后所有新流水都会失败；写库前拒绝。
            pushPreflight('ledger', index, `id=${row.id} 不是 1 到最大安全整数之间的整数`);
          }
        });

        const redeems = requireArray('redeems') || [];
        redeems.forEach((row, index) => {
          if (!row?.exchange_id) pushPreflight('redeems', index, '缺少 exchange_id');
        });

        const listings = requireArray('mall_order_listings') || [];
        listings.forEach((row, index) => {
          if (!row?.listing_id || !row?.exchange_id || !row?.seller_userid) {
            pushPreflight('mall_order_listings', index, '缺少 listing_id/exchange_id/seller_userid');
          }
        });

        const cdks = requireArray('redeem_cdks') || [];
        cdks.forEach((row, index) => {
          if (!row?.cdk_code) pushPreflight('redeem_cdks', index, '缺少 cdk_code');
        });

        const contributions = requireArray('charity_contributions') || [];
        contributions.forEach((row, index) => {
          if (!row?.id || !row?.project_id || !row?.userid) {
            pushPreflight('charity_contributions', index, '缺少 id/project_id/userid');
          }
        });

        const attendance = requireArray('attendance_reward_records') || [];
        attendance.forEach((row, index) => {
          if (!row?.userid || !row?.work_date || !row?.check_time_ms) {
            pushPreflight('attendance_reward_records', index, '缺少 userid/work_date/check_time_ms');
          }
        });

        const feedback = requireArray('user_feedback') || [];
        feedback.forEach((row, index) => {
          if (!row?.id || !row?.userid || row?.content == null) {
            pushPreflight('user_feedback', index, '缺少 id/userid/content');
          }
        });

        const feedbackMessages = requireArray('user_feedback_messages') || [];
        feedbackMessages.forEach((row, index) => {
          if (!row?.id || !row?.feedback_id || !row?.content) {
            pushPreflight('user_feedback_messages', index, '缺少 id/feedback_id/content');
          }
        });

        const auditLogs = requireArray('audit_logs') || [];
        auditLogs.forEach((row, index) => {
          if (!row?.id || !row?.event_type) pushPreflight('audit_logs', index, '缺少 id/event_type');
        });

        const adminUserRoles = requireArray('admin_user_roles') || [];
        adminUserRoles.forEach((row, index) => {
          if (!row?.userid || (!row?.role_id && !row?.role_code)) {
            pushPreflight('admin_user_roles', index, '缺少 userid/role_id(role_code)');
          }
        });

        const activities = requireArray('red_packet_activity') || [];
        activities.forEach((row, index) => {
          if (!row?.id) pushPreflight('red_packet_activity', index, '缺少 id');
        });

        const items = requireArray('red_packet_items') || [];
        items.forEach((row, index) => {
          if (!row?.activity_id || row?.amount == null) {
            pushPreflight('red_packet_items', index, '缺少 activity_id/amount');
          }
        });
      }
    } catch (err) {
      await failHistory('失败', { reason: 'preflight_exception', message: String(err?.message || err), backupMode });
      return res.status(400).json({ error: String(err?.message || err) });
    }

    if (preflightErrors.length > 0) {
      const sample = preflightErrors.slice(0, 20);
      await failHistory('失败', {
        reason: 'preflight_failed',
        backupMode,
        errorCount: preflightErrors.length,
        errors: sample,
      });
      return res.status(400).json({
        error: `备份预校验失败，共 ${preflightErrors.length} 处错误，未修改数据库`,
        errorCount: preflightErrors.length,
        errors: sample,
      });
    }

    // 覆盖导入前自动生成恢复点，防止中途失败后无回滚文件。
    // 全量恢复的恢复点在导入事务内、锁住所有表之后生成：与覆盖写入处在同一个禁止并发写入的区间，
    // 快照之后不会再有发币等写入提交而既被覆盖、又不在恢复点里（锁重试也不会拉大这个窗口）。
    // 设置类导入不锁表，仍在事务前生成。
    let recoveryPoint = null;
    let recoveryHistory = null;
    const saveRecoveryPoint = (tablesToSnapshot, snapshotData) => {
      const stampDate = new Date();
      const recoveryFilename = buildBackupFilename(backupMode);
      const recoveryPayload = {
        _meta: {
          version: 2,
          mode: backupMode,
          filename: recoveryFilename,
          exportedAt: stampDate.toISOString(),
          purpose: 'pre_import_recovery_point',
          ...(backupMode === 'full' ? { galaFormat: GALA_BACKUP_FORMAT } : {}),
          importMode: mode,
          sourceFilename: requestedFilename || null,
          secretsRedacted: false,
          tables: Object.fromEntries(tablesToSnapshot.map((t) => [t, snapshotData[t]?.length ?? 0])),
        },
        data: snapshotData,
      };
      const stored = writeBackupFile(recoveryFilename, recoveryPayload);
      recoveryPoint = {
        filename: recoveryFilename,
        size: stored.size,
        mode: backupMode,
        tables: recoveryPayload._meta.tables,
      };
      recoveryHistory = {
        action: '导出',
        mode: backupMode,
        filename: recoveryFilename,
        status: '完成',
        details: {
          ...recoveryPayload._meta,
          size: stored.size,
          downloadable: true,
          purpose: 'pre_import_recovery_point',
          secretsRedacted: false,
          sensitive: true,
        },
      };
    };
    const flushRecoveryHistory = async () => {
      if (!recoveryHistory) return;
      const entry = recoveryHistory;
      recoveryHistory = null;
      await appendBackupHistory(db, req, entry);
    };
    const recoveryPointFailed = async (err) => {
      await failHistory('失败', {
        reason: 'recovery_point_failed',
        message: String(err?.message || err),
        backupMode,
        mode,
      });
      return res.status(500).json({
        error: `导入前自动快照失败，已中止导入: ${String(err?.message || err)}`,
      });
    };
    if (backupMode !== 'full') {
      try {
        const snapshotData = await dumpTablesConsistently(db, SETTINGS_RECOVERY_TABLES, { keepSecrets: true });
        saveRecoveryPoint(SETTINGS_RECOVERY_TABLES, snapshotData);
        await flushRecoveryHistory();
      } catch (err) {
        return await recoveryPointFailed(err);
      }
    }

    const importedRoleIdMap = new Map();

    try {
      const report = await runWithRestoreLockRetry(db, async (tx) => {
        // 全量恢复的每一把前置锁（账号保护锁、年会写入锁、全部表锁）都设等待上限，超时整体回滚后重试：
        // 例如抽签持有年会共享锁、正等在活动行上时，恢复不会无限等待，也就不会一直占着账号保护锁，
        // 让外部账号注册等无关操作跟着卡住。
        const busy = async (step) => {
          try {
            return await step();
          } catch (err) {
            if (err?.code === '55P03') throw Object.assign(new Error('restore_tables_busy'), { restoreLockBusy: true, cause: err });
            throw err;
          }
        };
        if (backupMode === 'full') await tx.exec("SET LOCAL lock_timeout = '500ms'");
        await busy(() => lockAdminAccountProtection(tx));
        // 全量恢复与所有写入互斥，且恢复自己永远不会在持有表锁时等待别人，因而不可能参与死锁：
        // 1. 先拿年会写入锁的排他模式（年会事务在碰任何表之前拿它的共享模式），此时恢复还没持有任何表锁；
        // 2. 推进恢复代数（事务内计数，恢复失败或重试回滚时不变），进行中的年会发放据此发现期间发生过恢复而整次作废；
        // 3. 一次性以 EXCLUSIVE 模式锁住全量恢复要写的所有表（只放行普通读），每一步等锁都不超过 500ms
        //    （短于数据库的死锁检测间隔）。拿不到说明有入账、清理等事务正持有行锁：整个恢复事务回滚、稍后重试，
        //    让对方先完成，而不是持着一部分表去等它。拿到之后再没有别的事务能在这些表上持有或申请行锁，
        //    恢复后续的删除、写入都不会等待；恢复期间也不会有新流水分配 ID，推进流水序列时不会回拨。
        if (backupMode === 'full') {
          await busy(() => tx.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [GALA_PAYOUT_LOCK]));
          await busy(() => bumpGalaRestoreGeneration(tx));
          await busy(() => tx.exec(`LOCK TABLE ${FULL_TABLES.join(', ')} IN EXCLUSIVE MODE`));
          await tx.exec('SET LOCAL lock_timeout = DEFAULT');
          // 表已全部锁住：此刻的数据就是覆盖前最后的已提交状态，在这里生成恢复点。
          let snapshotData;
          try {
            snapshotData = {};
            for (const tableName of FULL_TABLES) {
              // eslint-disable-next-line no-await-in-loop
              snapshotData[tableName] = redactBackupSecrets(tableName, await dumpTable(tx, tableName), { keepSecrets: true });
            }
          } catch (err) {
            throw Object.assign(new Error(String(err?.message || err)), { recoveryPointFailed: true, cause: err });
          }
          // 覆盖会清空在线数据，之后唯一的退路就是这个恢复点：它必须能通过同样的年会校验重新导入。
          // 在线库里若有旧版本留下的异常年会数据（例如首尾带空白的 userid、带付款凭据的零金额记录），
          // 恢复点导不回来，覆盖后就无法撤销，所以先拒绝覆盖并列出要先处理的记录。
          if (mode === 'overwrite') {
            const recoveryErrors = findRecoveryPointGalaErrors(snapshotData);
            if (recoveryErrors.length) {
              throw Object.assign(new Error('recovery_point_not_importable'), { recoveryPointInvalid: true, errors: recoveryErrors });
            }
          }
          try {
            saveRecoveryPoint(FULL_TABLES, snapshotData);
          } catch (err) {
            throw Object.assign(new Error(String(err?.message || err)), { recoveryPointFailed: true, cause: err });
          }
        }
        const report = {};
        let failedTable = null;
        let failedIndex = null;

        const markAndThrow = (table, index, err) => {
          failedTable = table;
          failedIndex = index;
          const msg = String(err?.message || err);
          throw new Error(`导入失败 @${table}${index == null ? '' : `[${index}]`}: ${msg}`);
        };

        // system_settings：始终 upsert，不清除；钉钉 AppSecret 若备份为空则保留库内现有值
        {
          const rows = requireArray('system_settings') || [];
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.key) continue;
            try {
              // eslint-disable-next-line no-await-in-loop
              const mergedValue = await mergeSystemSettingValue(tx, row.key, row.value ?? null);
              // eslint-disable-next-line no-await-in-loop
              await execOrThrow(
                tx,
                'INSERT INTO system_settings(key, value, updated_at) VALUES($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
                [row.key, mergedValue, row.updated_at ?? nowTs()],
                `system_settings[${i}]`,
              );
              count++;
            } catch (err) {
              markAndThrow('system_settings', i, err);
            }
          }
          report.system_settings = count;
        }

        // admin_roles
        {
          const rows = requireArray('admin_roles') || [];
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.code || !row?.name) continue;
            const code = String(row.code).trim();
            const name = String(row.name).trim();
            const permissions = parseRolePermissions(row.permissions);
            const now = nowTs();
            try {
              // eslint-disable-next-line no-await-in-loop
              const existing = await tx.get('SELECT id FROM admin_roles WHERE code = ? LIMIT 1', [code]);
              if (existing?.id) {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `UPDATE admin_roles
                   SET name = $1, permissions = $2, is_builtin = $3, is_enabled = $4, updated_at = $5
                   WHERE code = $6`,
                  [name, JSON.stringify(permissions), row.is_builtin ?? 0, row.is_enabled ?? 1, row.updated_at ?? now, code],
                  `admin_roles[${i}] update`,
                );
                importedRoleIdMap.set(Number(row.id), Number(existing.id));
              } else {
                const backupId = toOptionalInt(row.id);
                let insertedWithBackupId = false;
                if (backupId) {
                  // eslint-disable-next-line no-await-in-loop
                  const occupied = await tx.get('SELECT id FROM admin_roles WHERE id = ? LIMIT 1', [backupId]);
                  if (!occupied?.id) {
                    // eslint-disable-next-line no-await-in-loop
                    await execOrThrow(
                      tx,
                      `INSERT INTO admin_roles(id, code, name, permissions, is_builtin, is_enabled, created_at, updated_at)
                       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
                      [
                        backupId,
                        code,
                        name,
                        JSON.stringify(permissions),
                        row.is_builtin ?? 0,
                        row.is_enabled ?? 1,
                        row.created_at ?? now,
                        row.updated_at ?? now,
                      ],
                      `admin_roles[${i}] insert-id`,
                    );
                    insertedWithBackupId = true;
                  }
                }
                if (!insertedWithBackupId) {
                  // eslint-disable-next-line no-await-in-loop
                  await execOrThrow(
                    tx,
                    `INSERT INTO admin_roles(code, name, permissions, is_builtin, is_enabled, created_at, updated_at)
                     VALUES($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT(code) DO UPDATE SET
                       name=excluded.name, permissions=excluded.permissions, is_builtin=excluded.is_builtin,
                       is_enabled=excluded.is_enabled, updated_at=excluded.updated_at`,
                    [
                      code,
                      name,
                      JSON.stringify(permissions),
                      row.is_builtin ?? 0,
                      row.is_enabled ?? 1,
                      row.created_at ?? now,
                      row.updated_at ?? now,
                    ],
                    `admin_roles[${i}] upsert`,
                  );
                }
                // eslint-disable-next-line no-await-in-loop
                const saved = await tx.get('SELECT id FROM admin_roles WHERE code = ? LIMIT 1', [code]);
                if (saved?.id) importedRoleIdMap.set(Number(row.id), Number(saved.id));
              }
              count++;
            } catch (err) {
              markAndThrow('admin_roles', i, err);
            }
          }
          try {
            await bumpSerial(tx, 'admin_roles');
          } catch (err) {
            markAndThrow('admin_roles', null, err);
          }
          report.admin_roles = count;
        }

        // mall_products
        {
          const rowsRaw = requireArray('mall_products');
          const rows = rowsRaw || [];
          if (mode === 'overwrite' && rowsRaw !== null) {
            await execOrThrow(tx, 'DELETE FROM mall_products', [], 'mall_products overwrite delete');
          }
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.product_id) continue;
            try {
              // eslint-disable-next-line no-await-in-loop
              await execOrThrow(
                tx,
                `INSERT INTO mall_products(product_id, product_name, bob_amount, stock, limit_per_user, limit_round, cdk_enabled, status, sort, image_url, remark, created_at, updated_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                 ON CONFLICT(product_id) DO UPDATE SET
                   product_name=excluded.product_name, bob_amount=excluded.bob_amount, stock=excluded.stock,
                   limit_per_user=excluded.limit_per_user, limit_round=excluded.limit_round, cdk_enabled=excluded.cdk_enabled, status=excluded.status, sort=excluded.sort,
                   image_url=excluded.image_url, remark=excluded.remark, updated_at=excluded.updated_at`,
                [
                  row.product_id,
                  row.product_name,
                  row.bob_amount,
                  row.stock ?? null,
                  row.limit_per_user ?? 0,
                  row.limit_round ?? 1,
                  row.cdk_enabled ?? 0,
                  row.status ?? 'on',
                  row.sort ?? null,
                  row.image_url ?? null,
                  row.remark ?? null,
                  row.created_at ?? nowTs(),
                  row.updated_at ?? nowTs(),
                ],
                `mall_products[${i}]`,
              );
              count++;
            } catch (err) {
              markAndThrow('mall_products', i, err);
            }
          }
          report.mall_products = count;
        }

        // charity_projects
        {
          const rowsRaw = requireArray('charity_projects');
          const rows = rowsRaw || [];
          if (mode === 'overwrite' && rowsRaw !== null) {
            await execOrThrow(tx, 'DELETE FROM charity_contributions', [], 'charity_contributions overwrite delete');
            await execOrThrow(tx, 'DELETE FROM charity_projects', [], 'charity_projects overwrite delete');
          }
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.project_id) continue;
            try {
              // eslint-disable-next-line no-await-in-loop
              await execOrThrow(
                tx,
                `INSERT INTO charity_projects(project_id, project_name, cover_image_url, summary, rules_text, target_bob_amount, tier_options_json, status, execution_status, execution_note, sort, created_at, updated_at, executed_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                 ON CONFLICT(project_id) DO UPDATE SET
                   project_name=excluded.project_name, cover_image_url=excluded.cover_image_url, summary=excluded.summary,
                   rules_text=excluded.rules_text, target_bob_amount=excluded.target_bob_amount, tier_options_json=excluded.tier_options_json,
                   status=excluded.status, execution_status=excluded.execution_status, execution_note=excluded.execution_note,
                   sort=excluded.sort, updated_at=excluded.updated_at, executed_at=excluded.executed_at`,
                [
                  row.project_id,
                  row.project_name ?? row.project_id,
                  row.cover_image_url ?? null,
                  row.summary ?? '',
                  row.rules_text ?? '',
                  row.target_bob_amount ?? 0,
                  row.tier_options_json ?? '[10,20,50,100]',
                  row.status ?? 'active',
                  row.execution_status ?? 'pending',
                  row.execution_note ?? null,
                  row.sort ?? null,
                  row.created_at ?? nowTs(),
                  row.updated_at ?? nowTs(),
                  row.executed_at ?? null,
                ],
                `charity_projects[${i}]`,
              );
              count++;
            } catch (err) {
              markAndThrow('charity_projects', i, err);
            }
          }
          report.charity_projects = count;
        }

        // mall_opening_schedule
        {
          const rows = requireArray('mall_opening_schedule') || [];
          if (rows.length > 0) {
            const row = rows[0];
            try {
              await execOrThrow(
                tx,
                `INSERT INTO mall_opening_schedule(id, is_open, auto_enabled, next_open_at, interval_minutes, open_duration_minutes, remind_before_seconds, close_remind_seconds, remind_for_open_at, open_notify_for_open_at, close_remind_for_close_at, close_notify_for_close_at, updated_at)
                 VALUES(1,$1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL,$8)
                 ON CONFLICT(id) DO UPDATE SET
                   is_open=excluded.is_open, auto_enabled=excluded.auto_enabled, next_open_at=excluded.next_open_at,
                   interval_minutes=excluded.interval_minutes, open_duration_minutes=excluded.open_duration_minutes,
                   remind_before_seconds=excluded.remind_before_seconds, close_remind_seconds=excluded.close_remind_seconds,
                   remind_for_open_at=NULL, open_notify_for_open_at=NULL, close_remind_for_close_at=NULL, close_notify_for_close_at=NULL,
                   updated_at=excluded.updated_at`,
                [
                  row.is_open ?? 1,
                  row.auto_enabled ?? 0,
                  row.next_open_at ?? null,
                  row.interval_minutes ?? null,
                  row.open_duration_minutes ?? null,
                  row.remind_before_seconds ?? null,
                  row.close_remind_seconds ?? null,
                  row.updated_at ?? nowTs(),
                ],
                'mall_opening_schedule[0]',
              );
              report.mall_opening_schedule = 1;
            } catch (err) {
              markAndThrow('mall_opening_schedule', 0, err);
            }
          }
        }

        // content_faq / content_announcements / system_versions
        const contentTables = [
          {
            name: 'content_faq',
            sql: 'INSERT INTO content_faq(id, question, answer, sort, is_enabled, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
            params: (row) => [
              row.id,
              row.question ?? '',
              row.answer ?? '',
              row.sort ?? 0,
              row.is_enabled ?? 1,
              row.created_at ?? nowTs(),
              row.updated_at ?? nowTs(),
            ],
          },
          {
            name: 'content_announcements',
            sql: `INSERT INTO content_announcements(
                    id, title, content, level, sort, is_enabled, publish_at,
                    show_fullscreen, requires_acknowledgement, revision, content_hash, edit_version,
                    created_at, updated_at
                  )
                  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                  ON CONFLICT(id) DO NOTHING`,
            overwriteSql: `INSERT INTO content_announcements(
                    id, title, content, level, sort, is_enabled, publish_at,
                    show_fullscreen, requires_acknowledgement, revision, content_hash, edit_version,
                    created_at, updated_at
                  )
                  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                  ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title, content=excluded.content, level=excluded.level,
                    sort=excluded.sort, is_enabled=excluded.is_enabled, publish_at=excluded.publish_at,
                    show_fullscreen=excluded.show_fullscreen,
                    requires_acknowledgement=excluded.requires_acknowledgement,
                    revision=excluded.revision, content_hash=excluded.content_hash,
                    edit_version=excluded.edit_version,
                    created_at=excluded.created_at, updated_at=excluded.updated_at`,
            params: (row) => {
              const requiresAcknowledgement = backupVersion === 2
                && Number(row.requires_acknowledgement || 0) === 1;
              const showFullscreen = requiresAcknowledgement
                || (backupVersion === 2 && Number(row.show_fullscreen || 0) === 1);
              const revision = backupVersion === 2 ? Number(row.revision) : 1;
              const contentHash = backupVersion === 2
                ? String(row.content_hash).toLowerCase()
                : computeAnnouncementContentHash({
                    title: row.title,
                    content: row.content,
                    requiresAcknowledgement: false,
                  });
              return [
                row.id,
                row.title ?? '',
                row.content ?? '',
                row.level ?? 'info',
                row.sort ?? 0,
                row.is_enabled ?? 1,
                row.publish_at ?? null,
                showFullscreen ? 1 : 0,
                requiresAcknowledgement ? 1 : 0,
                revision,
                contentHash,
                row.edit_version === undefined || row.edit_version === null ? 1 : Number(row.edit_version),
                row.created_at ?? nowTs(),
                row.updated_at ?? nowTs(),
              ];
            },
          },
          {
            name: 'system_versions',
            sql: 'INSERT INTO system_versions(id, version_name, release_notes, is_enabled, publish_at, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
            params: (row) => [
              row.id,
              row.version_name ?? '',
              row.release_notes ?? null,
              row.is_enabled ?? 1,
              row.publish_at ?? null,
              row.created_at ?? nowTs(),
              row.updated_at ?? nowTs(),
            ],
          },
        ];

        for (const table of contentTables) {
          const rowsRaw = requireArray(table.name);
          const rows = rowsRaw || [];
          if (mode === 'overwrite' && rowsRaw !== null) {
            if (table.name === 'content_announcements') {
              const ids = rows.map((row) => Number(row?.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
              if (ids.length > 0) {
                const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
                await execOrThrow(
                  tx,
                  `DELETE FROM content_announcements WHERE id NOT IN (${placeholders})`,
                  ids,
                  'content_announcements overwrite delete missing',
                );
              } else {
                await execOrThrow(tx, 'DELETE FROM content_announcements', [], 'content_announcements overwrite delete all');
              }
            } else {
              await execOrThrow(tx, `DELETE FROM ${table.name}`, [], `${table.name} overwrite delete`);
            }
          }
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.id) continue;
            try {
              const sql = mode === 'overwrite' && table.overwriteSql ? table.overwriteSql : table.sql;
              // eslint-disable-next-line no-await-in-loop
              await execOrThrow(tx, sql, table.params(row), `${table.name}[${i}]`);
              count++;
            } catch (err) {
              markAndThrow(table.name, i, err);
            }
          }
          if (mode === 'overwrite' && count > 0) {
            try {
              await bumpSerial(tx, table.name);
            } catch (err) {
              markAndThrow(table.name, null, err);
            }
          }
          report[table.name] = count;
        }

        // content_announcement_revisions：v1 备份按普通公告补齐 v1 快照
        {
          const rows = backupVersion === 1
            ? (requireArray('content_announcements') || []).map((row) => ({
                announcement_id: row.id,
                revision: 1,
                title: row.title ?? '',
                content: row.content ?? '',
                requires_acknowledgement: 0,
                content_hash: computeAnnouncementContentHash({
                  title: row.title,
                  content: row.content,
                  requiresAcknowledgement: false,
                }),
                created_by: null,
                created_name: null,
                created_at: row.created_at ?? nowTs(),
              }))
            : (requireArray('content_announcement_revisions') || []);
          if (mode === 'overwrite' && requireArray('content_announcements') !== null) {
            const announcementIds = (requireArray('content_announcements') || [])
              .map((row) => Number(row?.id))
              .filter((id) => Number.isSafeInteger(id) && id > 0);
            if (announcementIds.length > 0) {
              const placeholders = announcementIds.map((_, index) => `$${index + 1}`).join(',');
              await execOrThrow(
                tx,
                `DELETE FROM content_announcement_revisions WHERE announcement_id IN (${placeholders})`,
                announcementIds,
                'content_announcement_revisions overwrite delete restored announcements',
              );
            }
          }
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.announcement_id || !row?.revision) continue;
            try {
              // eslint-disable-next-line no-await-in-loop
              await execOrThrow(
                tx,
                `INSERT INTO content_announcement_revisions(
                   announcement_id, revision, title, content, requires_acknowledgement,
                   content_hash, created_by, created_name, created_at
                 )
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT(announcement_id, revision) DO NOTHING`,
                [
                  row.announcement_id,
                  row.revision,
                  row.title ?? '',
                  row.content ?? '',
                  row.requires_acknowledgement ?? 0,
                  String(row.content_hash || '').toLowerCase(),
                  row.created_by ?? null,
                  row.created_name ?? null,
                  row.created_at ?? nowTs(),
                ],
                `content_announcement_revisions[${i}]`,
              );
              count++;
            } catch (err) {
              markAndThrow('content_announcement_revisions', i, err);
            }
          }
          if (mode === 'overwrite' && requireArray('content_announcements') !== null) {
            const announcementIds = (requireArray('content_announcements') || [])
              .map((row) => Number(row?.id))
              .filter((id) => Number.isSafeInteger(id) && id > 0);
            if (announcementIds.length > 0) {
              const placeholders = announcementIds.map((_, index) => `$${index + 1}`).join(',');
              await execOrThrow(
                tx,
                `DELETE FROM content_announcement_acknowledgements ack
                  WHERE ack.announcement_id IN (${placeholders})
                    AND NOT EXISTS (
                      SELECT 1
                        FROM content_announcement_revisions revision
                       WHERE revision.announcement_id = ack.announcement_id
                         AND revision.revision = ack.revision
                         AND revision.content_hash = ack.content_hash
                    )`,
                announcementIds,
                'content_announcement_acknowledgements overwrite delete incompatible',
              );
            }
          }
          report.content_announcement_revisions = count;
        }

        if (backupMode === 'full') {
          // users overwrite cascade
          // 仅当备份包含 users 数组时才清空用户链路，避免 settings/full 混用导致误删。
          {
            const rows = Array.isArray(backupData.users) ? backupData.users : null;
            if (rows && mode === 'overwrite') {
              const deleteOrder = [
                ...[...GALA_BACKUP_TABLES].reverse().map((t) => t.name),
                'admin_user_roles',
                'auction_bids',
                'auction_activities',
                'audit_logs',
                'attendance_reward_records',
                'ledger',
                'mall_order_listings',
                'redeem_cdks',
                'redeems',
                'charity_contributions',
                'user_feedback_messages',
                'user_feedback',
                'content_announcement_acknowledgements',
                'bob_tokens',
                'external_accounts',
                'accounts',
                'users',
              ];
              for (const tableName of deleteOrder) {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(tx, `DELETE FROM ${tableName}`, [], `${tableName} overwrite delete`);
              }
            }
            let count = 0;
            const userRows = rows || [];
            for (let i = 0; i < userRows.length; i++) {
              const row = userRows[i];
              if (!row?.userid) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO users(userid, name, is_admin, source, phone, created_at)
                   VALUES($1,$2,$3,$4,$5,$6)
                   ON CONFLICT(userid) DO UPDATE SET
                     name=excluded.name, is_admin=excluded.is_admin,
                     source=excluded.source, phone=excluded.phone`,
                  [
                    row.userid,
                    row.name ?? null,
                    row.is_admin ?? 0,
                    // 旧备份没有 source/phone 列时按钉钉员工恢复；外部用户保留来源与手机号。
                    String(row.source || '') === 'external' ? 'external' : 'dingtalk',
                    row.phone ? String(row.phone) : null,
                    row.created_at ?? nowTs(),
                  ],
                  `users[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('users', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'users');
            } catch (err) {
              markAndThrow('users', null, err);
            }
            if (rows) report.users = count;
          }
        }

        if (backupMode === 'full' || isSettingsRecoveryPoint) {
          // content_announcement_acknowledgements
          {
            const rows = requireArray('content_announcement_acknowledgements') || [];
            if (isSettingsRecoveryPoint) {
              await execOrThrow(
                tx,
                'DELETE FROM content_announcement_acknowledgements',
                [],
                'content_announcement_acknowledgements recovery delete',
              );
            }
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid || !row?.announcement_id || !row?.revision) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                const revisionSnapshot = await tx.get(
                  `SELECT content_hash, requires_acknowledgement
                   FROM content_announcement_revisions
                   WHERE announcement_id = ? AND revision = ?
                   LIMIT 1`,
                  [row.announcement_id, row.revision],
                );
                const contentHash = String(row.content_hash || '').toLowerCase();
                if (!revisionSnapshot || String(revisionSnapshot.content_hash || '').toLowerCase() !== contentHash) {
                  throw new Error('数据库中的公告修订与确认记录不匹配');
                }
                if (Number(revisionSnapshot.requires_acknowledgement || 0) === 1 && row.action !== 'acknowledged') {
                  throw new Error('强制确认公告不允许 dismissed');
                }
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO content_announcement_acknowledgements(
                     userid, announcement_id, revision, content_hash, action, created_at
                   )
                   VALUES($1,$2,$3,$4,$5,$6)
                   ON CONFLICT(userid, announcement_id, revision) DO UPDATE SET
                     content_hash=excluded.content_hash,
                     action=excluded.action,
                     created_at=excluded.created_at`,
                  [
                    row.userid,
                    row.announcement_id,
                    row.revision,
                    contentHash,
                    row.action,
                    row.created_at ?? nowTs(),
                  ],
                  `content_announcement_acknowledgements[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('content_announcement_acknowledgements', i, err);
              }
            }
            report.content_announcement_acknowledgements = count;
          }
        }

        if (backupMode === 'full') {
          // admin_user_roles
          {
            const rows = requireArray('admin_user_roles') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid || (!row?.role_id && !row?.role_code)) continue;
              try {
                let roleId = importedRoleIdMap.get(Number(row.role_id)) || toOptionalInt(row.role_id);
                // eslint-disable-next-line no-await-in-loop
                let role = roleId ? await tx.get('SELECT id FROM admin_roles WHERE id = ? LIMIT 1', [roleId]) : null;
                if (!role?.id && row.role_code) {
                  // eslint-disable-next-line no-await-in-loop
                  const byCode = await tx.get('SELECT id FROM admin_roles WHERE code = ? LIMIT 1', [String(row.role_code)]);
                  roleId = byCode?.id || null;
                  role = byCode;
                }
                if (!roleId) {
                  throw new Error(`无法映射 role_id=${row.role_id} role_code=${row.role_code || ''}`);
                }
                // eslint-disable-next-line no-await-in-loop
                const user = await tx.get('SELECT userid FROM users WHERE userid = ? LIMIT 1', [row.userid]);
                if (!user?.userid) {
                  throw new Error(`用户不存在: ${row.userid}`);
                }
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO admin_user_roles(userid, role_id, assigned_by, assigned_name, assigned_at)
                   VALUES($1,$2,$3,$4,$5)
                   ON CONFLICT(userid) DO UPDATE SET
                     role_id=excluded.role_id, assigned_by=excluded.assigned_by,
                     assigned_name=excluded.assigned_name, assigned_at=excluded.assigned_at`,
                  [
                    row.userid,
                    roleId,
                    row.assigned_by ?? null,
                    row.assigned_name ?? null,
                    row.assigned_at ?? nowTs(),
                  ],
                  `admin_user_roles[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('admin_user_roles', i, err);
              }
            }
            report.admin_user_roles = count;
          }

          // accounts
          {
            const rows = requireArray('accounts') || [];
            // 合并按备份覆盖账户余额。目标库里已经到账的年会奖励不一定在这份备份里（合并不导入年会表），
            // 备份的余额也就可能不含它：覆盖后中奖记录和流水仍显示已付、余额却少了这笔，awarded_at 又挡住补发。
            // 无法确认两份余额能否合并，凡是覆盖到目标库已有年会到账的账户都拒绝。此时备份里的年会数据还没写入，
            // 查到的都是目标库原有的记录；表已在事务开头锁住。
            if (mode !== 'overwrite' && rows.length) {
              const uids = [...new Set(rows.map((r) => (r?.userid == null ? '' : String(r.userid))).filter(Boolean))];
              // 付款流水仍在（或没有凭据、无法判断）的奖励：备份余额无法确认含这笔奖励，一律拒绝。
              // 付款流水已被重置删除的奖励：这只能证明目标库发生过重置，不能证明备份余额来自重置之后
              // （重置前的余额快照会把奖励加回来，库里却没有这笔入账）。无法核对，只放行不改变当前余额的合并。
              // 流水此时还没导入，查到的都是目标库原有的。
              const paidRows = uids.length ? await tx.all(
                `SELECT w.userid,
                        BOOL_OR(w.ledger_id IS NULL OR EXISTS (SELECT 1 FROM ledger l WHERE l.id = w.ledger_id)) AS live,
                        MAX(a.balance) AS balance
                   FROM gala_round_winners w LEFT JOIN accounts a ON a.userid = w.userid
                  WHERE w.awarded_at IS NOT NULL AND w.amount > 0 AND w.userid = ANY(?::text[])
                  GROUP BY w.userid ORDER BY w.userid`,
                [uids],
              ) : [];
              const incoming = new Map(rows.filter((r) => r?.userid != null).map((r) => [String(r.userid), r]));
              const blocked = paidRows.filter((p) => {
                if (p.live === true || p.live === 't') return true;
                const next = incoming.get(String(p.userid));
                return Number(next?.balance ?? 0) !== Number(p.balance ?? 0);
              }).slice(0, 20);
              if (blocked.length) {
                throw new Error(`合并导入会覆盖已有年会奖励到账的账户余额（${blocked.map((r) => r.userid).join(', ')}），无法确认备份余额包含这些奖励，已拒绝导入`);
              }
            }
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  'INSERT INTO accounts(userid, balance, updated_at) VALUES($1,$2,$3) ON CONFLICT(userid) DO UPDATE SET balance=excluded.balance, updated_at=excluded.updated_at',
                  [row.userid, row.balance ?? 0, row.updated_at ?? nowTs()],
                  `accounts[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('accounts', i, err);
              }
            }
            report.accounts = count;
          }

          // external_accounts（对外活动账号凭据）
          // 必须与 users 同批恢复：只恢复 users 会留下「有余额但无法登录、且手机号唯一挡住重新注册」的账号。
          // 旧备份没有外部用户时可省略该数组；覆盖导入仍按 users 的快照恢复。
          {
            const rows = requireArray('external_accounts') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid || !row?.phone || !row?.password_hash || !row?.password_salt) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO external_accounts(
                     userid, phone, name, password_hash, password_salt, status, batch_id,
                     failed_count, locked_until, last_login_at, created_at, updated_at
                   ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                   ON CONFLICT(userid) DO UPDATE SET
                     phone=excluded.phone, name=excluded.name,
                     password_hash=excluded.password_hash, password_salt=excluded.password_salt,
                     status=excluded.status, batch_id=excluded.batch_id,
                     failed_count=excluded.failed_count, locked_until=excluded.locked_until,
                     last_login_at=excluded.last_login_at, updated_at=excluded.updated_at`,
                  [
                    row.userid,
                    String(row.phone),
                    row.name ?? '',
                    String(row.password_hash),
                    String(row.password_salt),
                    row.status ?? 'active',
                    row.batch_id ?? '',
                    Number.isFinite(Number(row.failed_count)) ? Number(row.failed_count) : 0,
                    row.locked_until ?? null,
                    row.last_login_at ?? null,
                    row.created_at ?? nowTs(),
                    row.updated_at ?? nowTs(),
                  ],
                  `external_accounts[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('external_accounts', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'external_accounts');
            } catch (err) {
              markAndThrow('external_accounts', null, err);
            }
            report.external_accounts = count;
          }

          // bob_tokens
          {
            const rows = requireArray('bob_tokens') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.token_hash) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO bob_tokens(id, token, token_hash, created_at, revoked_at)
                   VALUES($1,$2,$3,$4,$5) ON CONFLICT(token_hash) DO NOTHING`,
                  [
                    row.id ?? null,
                    row.token ?? null,
                    row.token_hash,
                    row.created_at ?? nowTs(),
                    row.revoked_at ?? null,
                  ],
                  `bob_tokens[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('bob_tokens', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'bob_tokens');
            } catch (err) {
              markAndThrow('bob_tokens', null, err);
            }
            report.bob_tokens = count;
          }

          // ledger
          {
            const rows = requireArray('ledger') || [];
            // 合并不能把目标库已有中奖记录的付款凭据重新挂回流水：用户重置删了流水、清零了余额但保留 ledger_id，
            // 备份若带回那条原流水（而余额不随之恢复），会出现流水显示入账、余额却没有的账目。
            // 此时备份里的年会数据还没写入，查到的都是目标库原有的中奖记录；凭据当前指向不存在的流水才算重新挂回。
            if (mode !== 'overwrite' && rows.length) {
              const ids = [...new Set(rows.map((r) => Number(r?.id)).filter((n) => Number.isSafeInteger(n) && n > 0))];
              const relinked = ids.length ? await tx.all(
                `SELECT w.id, w.ledger_id FROM gala_round_winners w
                  WHERE w.ledger_id = ANY(?::bigint[])
                    AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.id = w.ledger_id)
                  ORDER BY w.id LIMIT 20`,
                [ids],
              ) : [];
              if (relinked.length) {
                throw new Error(`合并导入会把已重置用户的年会付款流水重新挂回中奖记录（${relinked.map((r) => `#${r.id}→ledger#${r.ledger_id}`).join(', ')}），余额无法随之核对，已拒绝导入`);
              }
            }
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid || !row?.id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  'INSERT INTO ledger(id, userid, delta, reason, ref_id, created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
                  [row.id, row.userid, row.delta, row.reason ?? '', row.ref_id ?? null, row.created_at ?? nowTs()],
                  `ledger[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('ledger', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'ledger');
            } catch (err) {
              markAndThrow('ledger', null, err);
            }
            report.ledger = count;
          }

          // redeems
          {
            const rows = requireArray('redeems') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.exchange_id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO redeems(id, exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at, fulfilled_by, fulfilled_name, hidden, limit_round, created_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(exchange_id) DO NOTHING`,
                  [
                    row.id ?? null,
                    row.exchange_id,
                    row.userid,
                    row.product_id,
                    row.product_name ?? null,
                    row.bob_amount,
                    row.fulfilled_at ?? null,
                    row.fulfilled_by ?? null,
                    row.fulfilled_name ?? null,
                    row.hidden ?? 0,
                    row.limit_round ?? 1,
                    row.created_at ?? nowTs(),
                  ],
                  `redeems[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('redeems', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'redeems');
            } catch (err) {
              markAndThrow('redeems', null, err);
            }
            report.redeems = count;
          }

          // mall_order_listings
          {
            const rows = requireArray('mall_order_listings') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.listing_id || !row?.exchange_id || !row?.seller_userid) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO mall_order_listings(id, listing_id, exchange_id, seller_userid, seller_name_snapshot, buyer_userid, buyer_name_snapshot, price, seller_note, status, created_at, updated_at, sold_at, cancelled_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                   ON CONFLICT(listing_id) DO NOTHING`,
                  [
                    row.id ?? null,
                    row.listing_id,
                    row.exchange_id,
                    row.seller_userid,
                    row.seller_name_snapshot ?? null,
                    row.buyer_userid ?? null,
                    row.buyer_name_snapshot ?? null,
                    row.price ?? 0,
                    row.seller_note ?? null,
                    row.status ?? 'active',
                    row.created_at ?? nowTs(),
                    row.updated_at ?? nowTs(),
                    row.sold_at ?? null,
                    row.cancelled_at ?? null,
                  ],
                  `mall_order_listings[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('mall_order_listings', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'mall_order_listings');
            } catch (err) {
              markAndThrow('mall_order_listings', null, err);
            }
            report.mall_order_listings = count;
          }

          // redeem_cdks
          {
            const rows = requireArray('redeem_cdks') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.cdk_code) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO redeem_cdks(id, batch_id, cdk_code, product_id, product_name, product_bob_amount, status, created_by, created_name, created_at, redeemed_by, redeemed_name, redeemed_at, redeem_exchange_id)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(cdk_code) DO NOTHING`,
                  [
                    row.id ?? null,
                    row.batch_id ?? '',
                    row.cdk_code,
                    row.product_id ?? '',
                    row.product_name ?? '',
                    row.product_bob_amount ?? 0,
                    row.status ?? 'unused',
                    row.created_by ?? null,
                    row.created_name ?? null,
                    row.created_at ?? nowTs(),
                    row.redeemed_by ?? null,
                    row.redeemed_name ?? null,
                    row.redeemed_at ?? null,
                    row.redeem_exchange_id ?? null,
                  ],
                  `redeem_cdks[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('redeem_cdks', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'redeem_cdks');
            } catch (err) {
              markAndThrow('redeem_cdks', null, err);
            }
            report.redeem_cdks = count;
          }

          // charity_contributions
          {
            const rows = requireArray('charity_contributions') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id || !row?.project_id || !row?.userid) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO charity_contributions(id, project_id, userid, user_name_snapshot, bob_amount, created_at)
                   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.project_id,
                    row.userid,
                    row.user_name_snapshot ?? null,
                    row.bob_amount ?? 0,
                    row.created_at ?? nowTs(),
                  ],
                  `charity_contributions[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('charity_contributions', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'charity_contributions');
            } catch (err) {
              markAndThrow('charity_contributions', null, err);
            }
            report.charity_contributions = count;
          }

          // attendance_reward_records
          {
            const rows = requireArray('attendance_reward_records') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid || !row?.work_date || !row?.check_time_ms) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO attendance_reward_records(id, userid, user_name_snapshot, work_date, check_time_ms, check_time_text, check_type, source_type, time_result, event_source, status, skip_reason, reward_amount, reward_reason, notify_status, error_message, created_at, updated_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                   ON CONFLICT(userid, work_date, check_time_ms) DO NOTHING`,
                  [
                    row.id ?? null,
                    row.userid,
                    row.user_name_snapshot ?? null,
                    row.work_date,
                    row.check_time_ms,
                    row.check_time_text ?? null,
                    row.check_type ?? null,
                    row.source_type ?? null,
                    row.time_result ?? null,
                    row.event_source ?? 'stream',
                    row.status ?? 'pending',
                    row.skip_reason ?? null,
                    row.reward_amount ?? null,
                    row.reward_reason ?? null,
                    row.notify_status ?? null,
                    row.error_message ?? null,
                    row.created_at ?? nowTs(),
                    row.updated_at ?? nowTs(),
                  ],
                  `attendance_reward_records[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('attendance_reward_records', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'attendance_reward_records');
            } catch (err) {
              markAndThrow('attendance_reward_records', null, err);
            }
            report.attendance_reward_records = count;
          }

          // user_feedback
          {
            const rowsRaw = requireArray('user_feedback');
            const rows = rowsRaw || [];
            if (mode === 'overwrite' && rowsRaw !== null) {
              // users 段已清空时这里是 no-op；若备份未含 users，仍需确保反馈表可完整覆盖。
              await execOrThrow(tx, 'DELETE FROM user_feedback_messages', [], 'user_feedback_messages overwrite delete');
              await execOrThrow(tx, 'DELETE FROM user_feedback', [], 'user_feedback overwrite delete');
            }
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id || !row?.userid) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO user_feedback(id, userid, name, category, content, contact, status, reply, handled_by, handled_name, handled_at, created_at, updated_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.userid,
                    row.name ?? null,
                    row.category ?? 'suggestion',
                    row.content,
                    row.contact ?? null,
                    row.status ?? 'pending',
                    row.reply ?? null,
                    row.handled_by ?? null,
                    row.handled_name ?? null,
                    row.handled_at ?? null,
                    row.created_at ?? nowTs(),
                    row.updated_at ?? nowTs(),
                  ],
                  `user_feedback[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('user_feedback', i, err);
              }
            }
            if (mode === 'overwrite' && count > 0) {
              try {
                await bumpSerial(tx, 'user_feedback');
              } catch (err) {
                markAndThrow('user_feedback', null, err);
              }
            }
            report.user_feedback = count;
          }

          // user_feedback_messages
          {
            const rows = requireArray('user_feedback_messages') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id || !row?.feedback_id || !row?.content) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO user_feedback_messages(id, feedback_id, sender_type, sender_id, sender_name, content, created_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.feedback_id,
                    row.sender_type ?? 'user',
                    row.sender_id ?? null,
                    row.sender_name ?? null,
                    row.content,
                    row.created_at ?? nowTs(),
                  ],
                  `user_feedback_messages[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('user_feedback_messages', i, err);
              }
            }
            if (mode === 'overwrite' && count > 0) {
              try {
                await bumpSerial(tx, 'user_feedback_messages');
              } catch (err) {
                markAndThrow('user_feedback_messages', null, err);
              }
            }
            report.user_feedback_messages = count;
          }

          // audit_logs
          {
            const rows = requireArray('audit_logs') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id || !row?.event_type) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO audit_logs(id, event_type, actor_type, actor_id, actor_name, ip, method, path, status_code, message, payload, created_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.event_type,
                    row.actor_type ?? null,
                    row.actor_id ?? null,
                    row.actor_name ?? null,
                    row.ip ?? null,
                    row.method ?? null,
                    row.path ?? null,
                    row.status_code ?? null,
                    row.message ?? null,
                    row.payload ?? null,
                    row.created_at ?? nowTs(),
                  ],
                  `audit_logs[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('audit_logs', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'audit_logs');
            } catch (err) {
              markAndThrow('audit_logs', null, err);
            }
            report.audit_logs = count;
          }

          // red packet
          {
            const activityRowsRaw = requireArray('red_packet_activity');
            const itemRowsRaw = requireArray('red_packet_items');
            if (mode === 'overwrite' && (activityRowsRaw !== null || itemRowsRaw !== null)) {
              await execOrThrow(tx, 'DELETE FROM red_packet_items', [], 'red_packet_items overwrite delete');
              await execOrThrow(tx, 'DELETE FROM red_packet_activity', [], 'red_packet_activity overwrite delete');
            }
          }
          {
            const rows = requireArray('red_packet_activity') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO red_packet_activity(id, total_amount, total_count, countdown_seconds, duration_minutes, start_at, end_at, status, sponsor, created_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.total_amount,
                    row.total_count,
                    row.countdown_seconds,
                    row.duration_minutes,
                    row.start_at,
                    row.end_at,
                    row.status ?? 'ended',
                    row.sponsor ?? null,
                    row.created_at ?? nowTs(),
                  ],
                  `red_packet_activity[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('red_packet_activity', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'red_packet_activity');
            } catch (err) {
              markAndThrow('red_packet_activity', null, err);
            }
            report.red_packet_activity = count;
          }
          {
            const rows = requireArray('red_packet_items') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.activity_id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO red_packet_items(id, activity_id, amount, claimed_by, claimed_at)
                   VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
                  [row.id, row.activity_id, row.amount, row.claimed_by ?? null, row.claimed_at ?? null],
                  `red_packet_items[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('red_packet_items', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'red_packet_items');
            } catch (err) {
              markAndThrow('red_packet_items', null, err);
            }
            report.red_packet_items = count;
          }

          // auction（活动为父、出价为子；auction_bids FK→auction_activities）
          // merge 模式下拍卖资金无法安全对账，任何 ID 冲突都直接拒绝、回滚整个导入：
          // - 活动 ID 冲突：父行会被 ON CONFLICT DO NOTHING 跳过，其出价却挂到目标库不相关活动上；
          // - 出价 ID 冲突：出价被 DO NOTHING 跳过，而新活动仍保留指向该出价的 current_bid_id，
          //   结算按 id 查出价时不约束 activity_id，可能把目标库不相关的出价当成获胜者。
          if (mode !== 'overwrite') {
            const activityRows = requireArray('auction_activities') || [];
            const activityIds = [...new Set(activityRows.map((r) => Number(r?.id)).filter((n) => Number.isFinite(n) && n > 0))];
            if (activityIds.length) {
              const rows = await tx.all(
                `SELECT id FROM auction_activities WHERE id IN (${activityIds.map(() => '?').join(',')})`,
                activityIds,
              );
              if (rows.length) {
                throw new Error(`合并导入存在拍卖活动 ID 冲突（${rows.map((r) => r.id).join(', ')}）：为避免出价挂到不相关活动，已拒绝导入`);
              }
            }
            const bidRows = requireArray('auction_bids') || [];
            const bidIds = [...new Set(bidRows.map((r) => Number(r?.id)).filter((n) => Number.isFinite(n) && n > 0))];
            if (bidIds.length) {
              const rows = await tx.all(
                `SELECT id FROM auction_bids WHERE id IN (${bidIds.map(() => '?').join(',')})`,
                bidIds,
              );
              if (rows.length) {
                throw new Error(`合并导入存在拍卖出价 ID 冲突（${rows.map((r) => r.id).join(', ')}）：为避免结算命中不相关出价，已拒绝导入`);
              }
            }
          }
          {
            const activityRowsRaw = requireArray('auction_activities');
            const bidRowsRaw = requireArray('auction_bids');
            if (mode === 'overwrite' && (activityRowsRaw !== null || bidRowsRaw !== null)) {
              await execOrThrow(tx, 'DELETE FROM auction_bids', [], 'auction_bids overwrite delete');
              await execOrThrow(tx, 'DELETE FROM auction_activities', [], 'auction_activities overwrite delete');
            }
          }
          {
            const rows = requireArray('auction_activities') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO auction_activities(id, title, description, image_url, start_price, min_increment, start_at, end_at, anti_snipe_seconds, status, current_price, current_bid_userid, current_bid_id, bid_count, winner_userid, winner_name, final_price, settled_at, cancelled_at, cancel_reason, created_by, created_name, created_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.title,
                    row.description ?? null,
                    row.image_url ?? null,
                    row.start_price,
                    row.min_increment,
                    row.start_at,
                    row.end_at,
                    row.anti_snipe_seconds ?? 0,
                    row.status ?? 'scheduled',
                    row.current_price ?? null,
                    row.current_bid_userid ?? null,
                    row.current_bid_id ?? null,
                    row.bid_count ?? 0,
                    row.winner_userid ?? null,
                    row.winner_name ?? null,
                    row.final_price ?? null,
                    row.settled_at ?? null,
                    row.cancelled_at ?? null,
                    row.cancel_reason ?? null,
                    row.created_by ?? null,
                    row.created_name ?? null,
                    row.created_at ?? nowTs(),
                  ],
                  `auction_activities[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('auction_activities', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'auction_activities');
            } catch (err) {
              markAndThrow('auction_activities', null, err);
            }
            report.auction_activities = count;
          }
          {
            const rows = requireArray('auction_bids') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO auction_bids(id, activity_id, userid, user_name_snapshot, amount, state, created_at, settled_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.activity_id,
                    row.userid,
                    row.user_name_snapshot ?? null,
                    row.amount,
                    row.state ?? 'held',
                    row.created_at ?? nowTs(),
                    row.settled_at ?? null,
                  ],
                  `auction_bids[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('auction_bids', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'auction_bids');
            } catch (err) {
              markAndThrow('auction_bids', null, err);
            }
            report.auction_bids = count;
          }

          // 年会（父表在前）。只随全量覆盖恢复：合并导入不导入年会表，目标库的年会数据保持原样。
          // 中奖记录的 awarded_at 是发币幂等闸门、ledger_id 是付款凭据，跨库合并无法确认它们和目标库的流水、余额对得上。
          {
            const hasGala = GALA_BACKUP_TABLES.some((t) => requireArray(t.name) !== null);
            if (hasGala && mode !== 'overwrite') report.gala_skipped = GALA_BACKUP_TABLES.map((t) => t.name);
            if (hasGala && mode === 'overwrite') {
              for (const table of [...GALA_BACKUP_TABLES].reverse()) {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(tx, `DELETE FROM ${table.name}`, [], `${table.name} overwrite delete`);
              }
            }
            for (const table of (mode === 'overwrite' ? GALA_BACKUP_TABLES : [])) {
              const rows = requireArray(table.name) || [];
              let count = 0;
              const placeholders = table.columns.map((_, i) => `$${i + 1}`).join(',');
              for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (!(Number(row?.id) > 0)) {
                  // 缺主键的行不能静默跳过：覆盖导入已清表，跳过就等于悄悄丢掉一条奖励或名单。
                  markAndThrow(table.name, i, new Error('缺少有效主键 id'));
                }
                try {
                  // eslint-disable-next-line no-await-in-loop
                  await execOrThrow(
                    tx,
                    // 不吞冲突：预检之后并发写入的同 ID 记录、或备份内部的重复 ID 都必须让整个导入回滚，
                    // 否则子表会挂到目标库中不相关的活动/奖池/轮次上。
                    `INSERT INTO ${table.name}(${table.columns.join(', ')}) VALUES(${placeholders})`,
                    table.columns.map((col) => (row[col] === undefined ? (table.defaults?.[col] ?? null) : row[col])),
                    `${table.name}[${i}]`,
                  );
                  count++;
                } catch (err) {
                  markAndThrow(table.name, i, err);
                }
              }
              // 覆盖已清空年会表：即使这张表备份里没有行，也要把序列重置回起点，否则旧库里接近上限的序列
              // 会让恢复后的第一次新建（例如抽签写中奖记录）因序列耗尽失败。
              try {
                // eslint-disable-next-line no-await-in-loop
                await bumpSerial(tx, table.name);
              } catch (err) {
                markAndThrow(table.name, null, err);
              }
              report[table.name] = count;
            }
            // 中奖记录保留的 ledger_id（用户重置后流水已删、引用仍在）不能在目标库里指向别人的流水。
            // 导入后对整张表核对，而不只是本次导入的中奖记录：备份里一条无关流水也可能恰好占用目标库
            // 已有中奖记录空出来的 ledger_id。指向的流水若存在，ref_id、收款人、金额必须正是这条中奖记录的（不按时间先后判断）。
            const mismatched = await tx.all(
              `SELECT w.id, w.ledger_id FROM gala_round_winners w JOIN ledger l ON l.id = w.ledger_id
                WHERE l.ref_id IS DISTINCT FROM ('GALA_W' || w.id::text)
                   OR l.userid IS DISTINCT FROM w.userid
                   OR l.delta IS DISTINCT FROM w.amount
                   OR NOT starts_with(COALESCE(l.reason, ''), '${GALA_PAYOUT_REASON_PREFIX}')
                ORDER BY w.id LIMIT 20`,
              [],
            );
            if (mismatched.length) {
              throw new Error(`年会中奖记录的 ledger_id 指向了不属于它的流水（${mismatched.map((r) => `#${r.id}→${r.ledger_id}`).join(', ')}），已拒绝导入`);
            }
            // 合并后的整库再核对一次“待发中奖记录已有形似发放流水”：两者可能分别来自目标库和备份，
            // 单看备份文件发现不了，留下来会让之后的发放再付一次。
            const paidPending = await tx.all(
              `SELECT w.id, l.id AS ledger_row FROM gala_round_winners w
                 JOIN ledger l ON l.ref_id = ('GALA_W' || w.id::text)
                WHERE w.awarded_at IS NULL AND l.delta > 0
                  AND starts_with(COALESCE(l.reason, ''), '${GALA_PAYOUT_REASON_PREFIX}')
                  -- 与备份预检 couldPayWinner 同一判定：收款人、金额不同的历史同名流水不算付款；不按时间排除（时钟可能回拨）
                  AND l.userid = w.userid AND l.delta = w.amount
                ORDER BY w.id LIMIT 20`,
              [],
            );
            if (paidPending.length) {
              throw new Error(`年会中奖记录尚未发放，库里却已有它的发放流水（${paidPending.map((r) => `#${r.id}←ledger#${r.ledger_row}`).join(', ')}），已拒绝导入`);
            }
            // 用户重置删掉的流水 id 仍被中奖记录引用：把流水序列推进到这些 id 之后（只升不降），
            // 免得之后新发的流水恰好复用这个 id，变成“指向别人流水”的引用。
            // 放在所有可能拒绝导入的核对之后，并用 ALTER SEQUENCE … RESTART（随事务回滚；setval 不回滚）：
            // 导入被拒绝时在线库的流水序号保持不变。表已在事务开头锁住，期间不会有并发分配。
            const keptLedger = await tx.get('SELECT COALESCE(MAX(ledger_id), 0) AS m FROM gala_round_winners', []);
            if (Number(keptLedger?.m || 0) > 0) await execOrThrow(
              tx,
              `DO $$
               DECLARE
                 seq regclass := pg_get_serial_sequence('ledger', 'id')::regclass;
                 mx BIGINT := (SELECT seqmax FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence('ledger', 'id')::regclass);
                 target NUMERIC;
               BEGIN
                 SELECT GREATEST(
                          COALESCE(pg_sequence_last_value(seq), 0),
                          COALESCE((SELECT MAX(id) FROM ledger), 0),
                          COALESCE((SELECT MAX(ledger_id) FROM gala_round_winners), 0)
                        ) + 1
                   INTO target;
                 -- 与在线一致：保留的凭据用到序列上限（最大安全整数）时照常恢复，序列停在“已用尽”，
                 -- 之后新流水报序列耗尽，而不是复用这个仍被引用的 id。同一事务里的 nextval 随事务回滚。
                 IF target > mx THEN
                   EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s', seq, mx);
                   PERFORM nextval(seq);
                   RETURN;
                 END IF;
                 EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s', seq, target);
               END $$`,
              [],
              'ledger sequence bump',
            );
          }
        }

        // 防御：事务内若有未统计表也算成功报告
        report._failedTable = failedTable;
        report._failedIndex = failedIndex;
        return report;
      });

      // 清理内部字段
      delete report._failedTable;
      delete report._failedIndex;

      // 走到这里导入事务已经提交，数据库已恢复。之后的登记只是记录：失败也不能报告“导入失败”，
      // 否则调用方可能再执行一次覆盖导入。登记失败单独告警，并照常返回成功结果和恢复点文件名。
      let historyWarning = null;
      try {
        await flushRecoveryHistory();
        await appendBackupHistory(db, req, {
          action: '导入',
          mode,
          filename: requestedFilename,
          status: '完成',
          details: {
            backupMode,
            report,
            recoveryPoint,
          },
        });
      } catch (histErr) {
        historyWarning = `导入已完成，但写入备份历史失败：${String(histErr?.message || histErr)}`;
        console.error('[backup] import committed but history append failed', histErr);
      }
      publishMallRealtimeFullRefresh('backup_import');
      return res.json({
        ok: true,
        mode,
        backupMode,
        report,
        recoveryPoint,
        ...(historyWarning ? { historyWarning } : {}),
      });
    } catch (err) {
      if (err?.recoveryPointFailed) return await recoveryPointFailed(err.cause || err);
      if (err?.recoveryPointInvalid) {
        const errors = err.errors.slice(0, 20);
        await failHistory('失败', { reason: 'recovery_point_not_importable', errors, backupMode, mode });
        return res.status(409).json({
          error: `在线库的年会数据有异常，覆盖前生成的恢复点无法重新导入，已中止覆盖（在线数据未改动）：${errors.slice(0, 5).join('；')}`,
          errors,
          backupMode,
        });
      }
      // 恢复点已在事务内写好（之后的导入步骤失败）：照常登记，便于下载还原；登记失败不掩盖原始错误。
      await flushRecoveryHistory().catch((histErr) => console.error('[backup] recovery point history append failed', histErr));
      const message = String(err?.message || err);
      // 从错误消息解析失败表/行
      let failedTable = null;
      let failedIndex = null;
      const m = message.match(/@([a-z_]+)(?:\[(\d+)\])?/i);
      if (m) {
        failedTable = m[1];
        failedIndex = m[2] == null ? null : Number(m[2]);
      }
      await failHistory('失败', {
        reason: 'import_transaction_failed',
        message,
        backupMode,
        mode,
        failedTable,
        failedIndex,
        recoveryPoint,
      });
      return res.status(500).json({
        ok: false,
        error: message,
        mode,
        backupMode,
        failedTable,
        failedIndex,
        recoveryPoint,
      });
    }
  });


}
