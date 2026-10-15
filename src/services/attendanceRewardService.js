import { getAttendanceRewardSettings } from './systemSettings.js';
import { ensureAccount, getBalance, grantBob } from './ledgerService.js';
import { getUserName, sendOrQueueNotify } from './notifyOpsService.js';
import { safeAppendAuditLog } from './auditLogService.js';
import { getAccessToken, getUserProfile, listSubDepartments } from './dingtalkService.js';
import { beginUserSnapshot, isUserSnapshotSuperseded, persistDingtalkUserDetail } from './dingtalkUserSyncService.js';

const RECONCILE_BATCH_SIZE = 20;
const DEFAULT_WORK_START_MIN = 8 * 60 + 30; // 默认 08:30 前算有效
const DEPARTMENT_EXPANSION_CACHE_MS = 5 * 60 * 1000;
const departmentExpansionCache = new Map();

// 通讯录部门变更事件到达时调用，下次判定重新展开部门树。
export function clearAttendanceDepartmentCache() {
  departmentExpansionCache.clear();
}

function randomInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function renderReason(template, vars) {
  return String(template || '打卡奖励').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
    const value = vars?.[key];
    return value === null || value === undefined ? '' : String(value);
  });
}

async function sendAttendanceNotify(db, cfg, { userid, amount, rewardReason, balance }) {
  const displayName = await resolveAttendanceDisplayName(db, cfg, userid);
  const currentBalance = balance === null || balance === undefined
    ? await getBalance(db, { userid, name: displayName || '' })
    : balance;
  return await sendOrQueueNotify({
    db,
    cfg,
    userid,
    title: displayName ? `【BOB币中心】恭喜你！${displayName}` : '【BOB币中心】恭喜你！',
    lines: [
      `类型：收入`,
      `原因：${rewardReason || '-'}`,
      `金额：${String(amount)} BOB 币`,
      `当前余额：${String(currentBalance)} BOB 币`,
    ].filter(Boolean),
    awaitNotify: true,
    event: 'grant',
    variables: {
      name: displayName || userid,
      userid,
      reason: rewardReason || '-',
      amount: String(amount),
      balance: String(currentBalance),
    },
  });
}

function formatCstTime(checkTimeMs, withSeconds = false) {
  const ts = Number(checkTimeMs);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return withSeconds ? `${y}-${m}-${day} ${hh}:${mm}:${ss}` : `${y}-${m}-${day} ${hh}:${mm}`;
}

function getCstParts(checkTimeMs) {
  const ts = Number(checkTimeMs);
  if (!Number.isFinite(ts) || ts <= 0) {
    return {
      checkHourCST: null,
      checkMinuteCST: null,
      checkTotalMin: null,
      workDate: '',
    };
  }
  const d = new Date(ts + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const checkHourCST = d.getUTCHours();
  const checkMinuteCST = d.getUTCMinutes();
  return {
    checkHourCST,
    checkMinuteCST,
    checkTotalMin: checkHourCST * 60 + checkMinuteCST,
    workDate: `${y}-${m}-${day}`,
  };
}

function normalizeCheckType(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/[_\s-]+/g, '').toLowerCase();
  if (['onduty', 'checkin', 'startwork', '上班', '上班打卡'].includes(normalized)) return 'on_duty';
  if (['offduty', 'checkout', 'endwork', '下班', '下班打卡'].includes(normalized)) return 'off_duty';
  return '';
}

function resolveCheckType(record, checkTotalMin) {
  const candidates = [
    record?.checkType,
    record?.type,
    record?.attendanceType,
    record?.dutyType,
    record?.checkTypeName,
    record?.attendanceTypeName,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeCheckType(candidate);
    if (normalized) return { checkType: normalized, source: 'field', raw: String(candidate) };
  }
  if (Number.isFinite(checkTotalMin)) {
    if (checkTotalMin >= 12 * 60) return { checkType: 'off_duty', source: 'time_inferred', raw: '' };
    return { checkType: 'on_duty', source: 'time_inferred', raw: '' };
  }
  return { checkType: 'unknown', source: 'unknown', raw: '' };
}

export function normalizeAttendanceRecord(record, fallbackUserName = '') {
  const userid = record?.userId ? String(record.userId).trim() : '';
  const checkTimeMs = Number(record?.checkTime || record?.userCheckTime) || 0;
  const checkTimeText = formatCstTime(checkTimeMs);
  const { checkHourCST, checkMinuteCST, checkTotalMin, workDate } = getCstParts(checkTimeMs);
  const checkTypeMeta = resolveCheckType(record, checkTotalMin);
  return {
    userid,
    user_name_snapshot: String(fallbackUserName || '').trim(),
    check_time_ms: checkTimeMs,
    check_time_text: checkTimeText,
    work_date: workDate,
    check_hour_cst: checkHourCST,
    check_minute_cst: checkMinuteCST,
    check_total_min: checkTotalMin,
    check_type: checkTypeMeta.checkType,
    check_type_source: checkTypeMeta.source,
    check_type_raw: checkTypeMeta.raw,
    source_type: record?.sourceType ? String(record.sourceType) : '',
    time_result: record?.timeResult ? String(record.timeResult) : '',
  };
}

function parseTimeToMinutes(text) {
  const m = typeof text === 'string' ? text.trim().match(/^(\d{1,2}):(\d{2})$/) : null;
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

function getWorkStartMinutes(settings) {
  const parsed = parseTimeToMinutes(settings?.workStartTime);
  return parsed === null ? DEFAULT_WORK_START_MIN : parsed;
}

export function isOnDutyEligible(normalized, settings) {
  if (!normalized.userid) return { ok: false, skipReason: 'missing_userid' };
  if (!normalized.check_time_ms) return { ok: false, skipReason: 'missing_check_time' };
  if (String(normalized.time_result || '').trim().toLowerCase() === 'notsigned') {
    return { ok: false, skipReason: 'not_signed' };
  }
  const startMin = getWorkStartMinutes(settings);
  const grace = Number(settings.lateGraceMinutes) || 0;
  const cutoff = startMin + grace;

  if (normalized.check_type === 'off_duty') {
    return settings.onlyCheckin ? { ok: false, skipReason: 'skipped_off_duty' } : { ok: true, skipReason: '' };
  }

  if (Number(normalized.check_total_min) > cutoff) {
    return { ok: false, skipReason: 'skipped_late', cutoffMin: cutoff };
  }
  if (normalized.check_type !== 'on_duty') return { ok: false, skipReason: 'not_on_duty' };
  return { ok: true, skipReason: '' };
}

export function isAttendanceDepartmentAllowed(userProfile, settings) {
  const mode = String(settings?.departmentMode || 'all');
  if (mode !== 'selected') return { ok: true, skipReason: '' };
  const expandedIds = Array.isArray(settings?.departmentExpandedIds) && settings.departmentExpandedIds.length
    ? settings.departmentExpandedIds
    : settings?.departmentIds;
  const allow = new Set((Array.isArray(expandedIds) ? expandedIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  if (allow.size === 0) return { ok: false, skipReason: 'department_not_allowed' };
  const userDeptIds = Array.isArray(userProfile?.deptIds) ? userProfile.deptIds.map((id) => String(id || '').trim()) : [];
  const matched = userDeptIds.some((id) => allow.has(id));
  return matched ? { ok: true, skipReason: '' } : { ok: false, skipReason: 'department_not_allowed' };
}

export function isAttendanceRewardDateActive(settings, workDate) {
  const startDate = String(settings?.startDate || '').trim();
  const date = String(workDate || '').trim();
  if (!startDate) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date >= startDate;
}

export function evaluateAttendanceRewardRecord(settings = {}, record = {}, userProfile = {}) {
  const userid = record?.userId ? String(record.userId).trim() : '';
  const normalized = normalizeAttendanceRecord(record, userProfile?.name || userid);
  if (!isAttendanceRewardDateActive(settings, normalized.work_date)) {
    return { ok: true, wouldReward: false, status: 'skipped', reason: 'before_start_date', normalized };
  }
  const deptEligibility = isAttendanceDepartmentAllowed(userProfile, settings);
  if (!deptEligibility.ok) {
    return { ok: true, wouldReward: false, status: 'skipped', reason: deptEligibility.skipReason, normalized };
  }
  const eligibility = isOnDutyEligible(normalized, settings);
  if (!eligibility.ok) {
    return { ok: true, wouldReward: false, status: 'skipped', reason: eligibility.skipReason, normalized };
  }
  if (settings?.testMode === true) {
    return { ok: true, wouldReward: true, status: 'would_reward', reason: 'test_mode', normalized };
  }
  return { ok: true, wouldReward: true, status: 'would_reward', reason: '', normalized };
}

async function collectDepartmentAndChildren(cfg, departmentIds = []) {
  const roots = [...new Set((Array.isArray(departmentIds) ? departmentIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (!roots.length) return [];
  const cacheKey = `${cfg?.dingtalk?.corpId || ''}:${cfg?.dingtalk?.appKey || ''}:${roots.sort().join(',')}`;
  const cached = departmentExpansionCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < DEPARTMENT_EXPANSION_CACHE_MS) return cached.ids;

  const out = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const parent = queue.shift();
    const subs = await listSubDepartments(cfg, { deptId: Number(parent) });
    for (const dept of Array.isArray(subs) ? subs : []) {
      const id = String(dept?.dept_id || '').trim();
      if (!id || out.has(id)) continue;
      out.add(id);
      queue.push(id);
    }
  }
  const ids = [...out];
  departmentExpansionCache.set(cacheKey, { at: now, ids });
  return ids;
}

async function expandAttendanceDepartmentSettings(cfg, settings) {
  if (String(settings?.departmentMode || 'all') !== 'selected') return settings;
  if (Array.isArray(settings?.departmentExpandedIds) && settings.departmentExpandedIds.length) return settings;
  if (!cfg?.dingtalk?.appKey || !cfg?.dingtalk?.appSecret) return settings;
  try {
    const departmentExpandedIds = await collectDepartmentAndChildren(cfg, settings.departmentIds || []);
    return { ...settings, departmentExpandedIds };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[AttendanceReward] expand departments failed:', err?.message || err);
    return settings;
  }
}

function humanizeSkipMessage(skipReason, normalized, settings = {}) {
  const timeSuffix = normalized.check_time_text ? `（${normalized.check_time_text}）` : '';
  if (skipReason === 'skipped_off_duty') return `下班打卡已按规则忽略${timeSuffix}`;
  if (skipReason === 'not_signed') return `未打卡，跳过奖励${timeSuffix}`;
  if (skipReason === 'skipped_late') return `打卡晚于 ${settings.workStartTime || '08:30'}（含宽限），跳过奖励${timeSuffix}`;
  if (skipReason === 'max_per_day') return `今日已奖励 1 次，跳过${timeSuffix}`;
  if (skipReason === 'department_not_allowed') return `未命中奖励部门${timeSuffix}`;
  if (skipReason === 'before_start_date') return `打卡日期早于生效日期 ${settings.startDate || '-'}，跳过奖励${timeSuffix}`;
  if (skipReason === 'missing_check_time') return '缺少打卡时间，跳过奖励';
  return `未满足奖励条件，跳过${timeSuffix}`;
}

async function getExistingRecordForUpdate(tx, normalized) {
  return await tx.get(
    `SELECT * FROM attendance_reward_records
      WHERE userid = ? AND work_date = ? AND check_time_ms = ?
      LIMIT 1
      FOR UPDATE`,
    [normalized.userid, normalized.work_date, normalized.check_time_ms],
  );
}

async function ensureAttendanceRewardRow(tx, normalized, { eventSource }) {
  await tx.run(
    `INSERT INTO attendance_reward_records(
      userid, user_name_snapshot, work_date, check_time_ms, check_time_text,
      check_type, source_type, time_result, event_source, status, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', unixepoch(), unixepoch())
    ON CONFLICT(userid, work_date, check_time_ms) DO NOTHING`,
    [
      normalized.userid,
      normalized.user_name_snapshot || null,
      normalized.work_date,
      normalized.check_time_ms,
      normalized.check_time_text || null,
      normalized.check_type || null,
      normalized.source_type || null,
      normalized.time_result || null,
      eventSource,
    ],
  );
  return await getExistingRecordForUpdate(tx, normalized);
}

async function countRewardedToday(tx, normalized) {
  const row = await tx.get(
    `SELECT COUNT(*) AS cnt
       FROM attendance_reward_records
      WHERE userid = ? AND work_date = ? AND status = 'rewarded'`,
    [normalized.userid, normalized.work_date],
  );
  return Number(row?.cnt || 0);
}

async function lockAttendanceRewardSlot(tx, normalized) {
  // PostgreSQL 事务级 advisory lock：同一用户同一天串行发币，避免 maxPerDay 竞态。
  await tx.exec(
    `SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))`,
    [String(normalized.userid || ''), String(normalized.work_date || '')],
  );
}

async function finalizeAttendanceRecord(tx, recordId, fields) {
  const keys = Object.keys(fields || {});
  if (!keys.length) return;
  const sets = keys.map((key) => `${key} = ?`).join(', ');
  const values = keys.map((key) => fields[key]);
  await tx.run(`UPDATE attendance_reward_records SET ${sets}, updated_at = unixepoch() WHERE id = ?`, [...values, recordId]);
}

async function writeAttendanceAudit(db, { eventType, userid, actorName, message, payload }) {
  await safeAppendAuditLog(db, {
    eventType,
    actorType: 'system',
    actorId: userid,
    actorName: actorName || '',
    message,
    payload,
  });
}

// 姓名可用本地已知值；“指定部门奖励”所需的部门一律向钉钉实时取（user/get 不计量，
// 请求已限速并带 10 分钟缓存，通讯录事件会作废缓存），不使用本地缓存的部门做资格判定。
// 取不到时部门为空（失败即拒绝，稍后重判）。
export async function resolveAttendanceUserProfile(db, cfg, userid, { needDepartments = true } = {}) {
  const localName = await getUserName(db, userid);
  const fallback = { name: localName || '', deptIds: [] };

  if (!needDepartments && localName) return fallback;

  if (!cfg?.dingtalk?.appKey || !cfg?.dingtalk?.appSecret) {
    return fallback;
  }

  try {
    const snapshotVersion = beginUserSnapshot();
    const profile = await getUserProfile(cfg, userid);
    const profileName = profile?.name ? String(profile.name).trim() : '';
    let written = false;
    let persistSuperseded = false;
    // 只有本次调用自己发起的请求取得的资料才写回：缓存命中/合并的请求，取数时间早于本次的版本号。
    if (profile?.raw && profile.freshFetch) {
      // 姓名与部门在同一个按员工串行、带版本检查的写入里落库，供后台展示使用。
      // 不在这里单独改 users.name：进行中的旧请求返回时可能把刚被事件更新的新名字覆盖回去。
      try {
        const out = await persistDingtalkUserDetail(db, cfg, profile.raw, { snapshotVersion });
        written = Boolean(out?.ok && !out.skipped);
        persistSuperseded = out?.reason === 'superseded';
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[AttendanceReward] persist user profile failed for ' + userid + ':', err?.message || err);
      }
    }
    // 没有成功写入时仅保证账户存在（不改名），发奖流程依赖它。
    if (!written) await ensureAccount(db, { userid, name: '', createUser: true });
    // 取数期间有通讯录事件到达：这份资料可能已过期，不用于资格判定，稍后重判。
    // 对每个调用者独立判断（包括缓存命中、合并到他人请求的调用者），与是否写库无关。
    if (profile?.invalidated || persistSuperseded || isUserSnapshotSuperseded(userid, snapshotVersion)) return { name: profileName || localName || '', deptIds: [] };
    return {
      name: profileName || localName || '',
      deptIds: Array.isArray(profile?.deptIds) ? profile.deptIds.map((id) => String(id)).filter(Boolean) : [],
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[AttendanceReward] resolve user profile failed for ' + userid + ':', err?.message || err);
  }

  return fallback;
}

async function resolveAttendanceDisplayName(db, cfg, userid) {
  const profile = await resolveAttendanceUserProfile(db, cfg, userid, { needDepartments: false });
  return profile.name || '';
}

async function handleAttendanceRecord(db, cfg, settings, record, { eventSource = 'stream', notifyOnReward = false } = {}) {
  if (settings?.testMode === true) notifyOnReward = false;
  const userid = record?.userId ? String(record.userId).trim() : '';
  if (!userid) return { ok: false, skipped: true, reason: 'missing_userid' };
  const preliminary = normalizeAttendanceRecord(record, userid);
  if (!isAttendanceRewardDateActive(settings, preliminary.work_date)) {
    return { ok: true, skipped: true, reason: 'before_start_date' };
  }

  // 已有终态记录时直接复用，不再为它查询用户信息或部门（补偿任务每轮都会重放当天全部打卡记录）。
  if (preliminary.check_time_ms > 0) {
    const prior = await db.get(
      `SELECT id, status, skip_reason, notify_status, reward_reason, reward_amount
         FROM attendance_reward_records
        WHERE userid = ? AND work_date = ? AND check_time_ms = ?
        LIMIT 1`,
      [preliminary.userid, preliminary.work_date, preliminary.check_time_ms],
    );
    const priorStatus = String(prior?.status || '');
    if (prior && priorStatus && priorStatus !== 'pending') {
      const needsReevaluate =
        (priorStatus === 'skipped' && String(prior.skip_reason || '') === 'department_not_allowed') ||
        priorStatus === 'test_passed'; // 试运行结果不是终态：关闭测试模式后需按正式规则重新判定
      const needsNotifyRetry = notifyOnReward && priorStatus === 'rewarded' && String(prior.notify_status || '') !== 'sent';
      if (!needsReevaluate && !needsNotifyRetry) {
        return {
          ok: true,
          reused: true,
          status: priorStatus,
          recordId: prior.id,
          notify_status: prior.notify_status,
          rewardReason: prior.reward_reason,
          amount: prior.reward_amount,
        };
      }
    }
  }

  const userProfile = await resolveAttendanceUserProfile(db, cfg, userid, {
    needDepartments: String(settings?.departmentMode || 'all') === 'selected',
  });
  const displayName = userProfile.name || '';
  const normalized = normalizeAttendanceRecord(record, displayName || userid);
  if (!normalized.user_name_snapshot) normalized.user_name_snapshot = displayName || userid;
  const departmentAwareSettings = await expandAttendanceDepartmentSettings(cfg, settings);

  const result = await db.transaction(async (tx) => {
    const existing = await ensureAttendanceRewardRow(tx, normalized, { eventSource });
    if (existing && String(existing.status || '') !== 'pending') {
      const existingStatus = String(existing.status || '');
      const existingSkipReason = String(existing.skip_reason || '');
      const shouldReevaluate =
        (existingStatus === 'skipped' && existingSkipReason === 'department_not_allowed') ||
        existingStatus === 'test_passed'; // 试运行结果不是终态：关闭测试模式后需按正式规则重新判定
      if (!shouldReevaluate) {
        return {
          ok: true,
          reused: true,
          status: existingStatus,
          recordId: existing.id,
          notify_status: existing.notify_status,
          rewardReason: existing.reward_reason,
          amount: existing.reward_amount,
        };
      }
    }

    const deptEligibility = isAttendanceDepartmentAllowed(userProfile, departmentAwareSettings);
    if (!deptEligibility.ok) {
      await finalizeAttendanceRecord(tx, existing.id, {
        status: 'skipped',
        skip_reason: deptEligibility.skipReason,
        event_source: eventSource,
      });
      const message = humanizeSkipMessage(deptEligibility.skipReason, normalized, settings);
      await writeAttendanceAudit(tx, {
        eventType: 'attendance_skip',
        userid,
        actorName: normalized.user_name_snapshot,
        message,
        payload: {
          reason: deptEligibility.skipReason,
          userid,
          name: normalized.user_name_snapshot,
          checkTimeMs: normalized.check_time_ms,
          checkTimeText: normalized.check_time_text,
          userDeptIds: userProfile.deptIds,
          selectedDepartmentIds: settings.departmentIds,
          allowedDepartmentIds: departmentAwareSettings.departmentExpandedIds || settings.departmentIds,
          eventSource,
        },
      });
      return { ok: true, skipped: true, reason: deptEligibility.skipReason };
    }

    const eligibility = isOnDutyEligible(normalized, settings);
    if (!eligibility.ok) {
      await finalizeAttendanceRecord(tx, existing.id, {
        status: 'skipped',
        skip_reason: eligibility.skipReason,
        event_source: eventSource,
      });
      const message = humanizeSkipMessage(eligibility.skipReason, normalized, settings);
      await writeAttendanceAudit(tx, {
        eventType: 'attendance_skip',
        userid,
        actorName: normalized.user_name_snapshot,
        message,
        payload: {
          reason: eligibility.skipReason,
          userid,
          name: normalized.user_name_snapshot,
          checkTimeMs: normalized.check_time_ms,
          checkTimeText: normalized.check_time_text,
          checkHourCST: normalized.check_hour_cst,
          checkMinuteCST: normalized.check_minute_cst,
          checkType: normalized.check_type,
          checkTypeSource: normalized.check_type_source,
          checkTypeRaw: normalized.check_type_raw,
          sourceType: normalized.source_type,
          eventSource,
        },
      });
      return { ok: true, skipped: true, reason: eligibility.skipReason };
    }

    const isTestMode = settings.testMode === true;
    if (!isTestMode) {
      await lockAttendanceRewardSlot(tx, normalized);
      const todayCount = await countRewardedToday(tx, normalized);
      if (todayCount >= Number(settings.maxPerDay || 1)) {
        await finalizeAttendanceRecord(tx, existing.id, {
          status: 'skipped',
          skip_reason: 'max_per_day',
          event_source: eventSource,
        });
        await writeAttendanceAudit(tx, {
          eventType: 'attendance_skip',
          userid,
          actorName: normalized.user_name_snapshot,
          message: humanizeSkipMessage('max_per_day', normalized, settings),
          payload: {
            reason: 'max_per_day',
            userid,
            name: normalized.user_name_snapshot,
            checkTimeMs: normalized.check_time_ms,
            checkTimeText: normalized.check_time_text,
            todayCount,
            maxPerDay: settings.maxPerDay,
            sourceType: normalized.source_type,
            eventSource,
          },
        });
        return { ok: true, skipped: true, reason: 'max_per_day' };
      }
    }

    if (isTestMode) {
      await finalizeAttendanceRecord(tx, existing.id, {
        status: 'test_passed',
        skip_reason: 'test_mode',
        notify_status: 'not_sent',
        error_message: null,
        event_source: eventSource,
      });
      await writeAttendanceAudit(tx, {
        eventType: 'attendance_test_passed',
        userid,
        actorName: normalized.user_name_snapshot,
        message: `打卡奖励测试通过，未发放 BOB 币，未发送通知${normalized.check_time_text ? `（${normalized.check_time_text}）` : ''}`,
        payload: {
          userid,
          name: normalized.user_name_snapshot,
          checkTimeMs: normalized.check_time_ms,
          checkTimeText: normalized.check_time_text,
          sourceType: normalized.source_type,
          eventSource,
        },
      });
      return { ok: true, skipped: true, dryRun: true, reason: 'test_mode', recordId: existing.id };
    }

    const amount = randomInt(
      Math.max(1, Number(settings.rewardMin) || 1),
      Math.max(Number(settings.rewardMin) || 1, Number(settings.rewardMax) || 1),
    );
    const rewardReason = renderReason(settings.reason, { name: normalized.user_name_snapshot || userid, userid });

    try {
      const grant = await grantBob(tx, { userid, amount, reason: rewardReason });
      await finalizeAttendanceRecord(tx, existing.id, {
        status: 'rewarded',
        skip_reason: null,
        reward_amount: amount,
        reward_reason: rewardReason,
        notify_status: notifyOnReward ? 'pending' : 'queued',
        error_message: null,
        event_source: eventSource,
      });
      await writeAttendanceAudit(tx, {
        eventType: 'attendance_reward',
        userid,
        actorName: normalized.user_name_snapshot,
        message: `打卡奖励 ${amount} BOB 币（${rewardReason}）${normalized.check_time_text ? `（${normalized.check_time_text}）` : ''}`,
        payload: {
          userid,
          name: normalized.user_name_snapshot,
          amount,
          reason: rewardReason,
          checkTimeMs: normalized.check_time_ms,
          checkTimeText: normalized.check_time_text,
          sourceType: normalized.source_type,
          eventSource,
        },
      });
      return { ok: true, rewarded: true, amount, recordId: existing.id, rewardReason, balance: grant?.balance };
    } catch (err) {
      await finalizeAttendanceRecord(tx, existing.id, {
        status: 'error',
        error_message: String(err?.message || err),
        event_source: eventSource,
      });
      return { ok: false, error: String(err?.message || err) };
    }
  });

  // 事务外发送通知，避免回滚后通知已发
  if (result?.ok && result.rewarded && notifyOnReward) {
    try {
      const notify = await sendAttendanceNotify(db, cfg, {
        userid,
        amount: result.amount,
        rewardReason: result.rewardReason,
        balance: result.balance,
      });
      await db.run(
        'UPDATE attendance_reward_records SET notify_status = ?, error_message = NULL, updated_at = unixepoch() WHERE id = ?',
        [notify?.ok ? 'sent' : 'failed', result.recordId],
      );
    } catch (err) {
      await db.run(
        'UPDATE attendance_reward_records SET notify_status = ?, error_message = ?, updated_at = unixepoch() WHERE id = ?',
        ['failed', String(err?.message || err), result.recordId],
      );
    }
  }

  if (
    result?.ok &&
    result.reused &&
    notifyOnReward &&
    result.status === 'rewarded' &&
    result.notify_status !== 'sent'
  ) {
    try {
      const notify = await sendAttendanceNotify(db, cfg, {
        userid,
        amount: result.amount,
        rewardReason: result.rewardReason,
        balance: result.balance,
      });
      await db.run(
        'UPDATE attendance_reward_records SET notify_status = ?, error_message = NULL, updated_at = unixepoch() WHERE id = ?',
        [notify?.ok ? 'sent' : 'failed', result.recordId],
      );
    } catch (err) {
      await db.run(
        'UPDATE attendance_reward_records SET notify_status = ?, error_message = ?, updated_at = unixepoch() WHERE id = ?',
        ['failed', String(err?.message || err), result.recordId],
      );
    }
  }

  return result;
}

export async function handleCheckinEvent(db, cfg, { data } = {}) {
  const settings = await getAttendanceRewardSettings(db);
  if (!settings?.enabled) return;
  let parsed = data;
  if (typeof data === 'string') {
    try { parsed = JSON.parse(data); } catch { parsed = {}; }
  }
  if (!parsed || typeof parsed !== 'object') return;
  const records = Array.isArray(parsed?.dataList) && parsed.dataList.length > 0 ? parsed.dataList : [parsed];
  const notifyOnReward = shouldNotifyAttendanceReward();
  for (const record of records) {
    // eslint-disable-next-line no-await-in-loop
    await handleAttendanceRecord(db, cfg, settings, record, { eventSource: 'stream', notifyOnReward });
  }
}

async function fetchAttendanceRecords(cfg, { from, to, userids, batchSize = RECONCILE_BATCH_SIZE } = {}) {
  const token = await getAccessToken(cfg);
  const ids = Array.isArray(userids) ? userids.filter(Boolean) : [];
  const result = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const resp = await fetch(`https://oapi.dingtalk.com/attendance/list?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workDateFrom: from,
        workDateTo: to,
        userIdList: batch,
        offset: 0,
        limit: 50,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || Number(data?.errcode || 0) !== 0) {
      throw new Error(`attendance_api_failed: ${JSON.stringify(data)}`);
    }
    result.push(...(Array.isArray(data?.recordresult) ? data.recordresult : []));
  }
  return result;
}

function getDateRange(dateText) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))
    ? String(dateText)
    : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return {
    date,
    from: `${date} 00:00:00`,
    to: `${date} 23:59:59`,
    fromTs: Math.floor(new Date(`${date}T00:00:00+08:00`).getTime() / 1000),
    toTs: Math.floor(new Date(`${date}T23:59:59+08:00`).getTime() / 1000),
  };
}

function getCurrentCstInfo() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return {
    date: now.toISOString().slice(0, 10),
    minutes: now.getUTCHours() * 60 + now.getUTCMinutes(),
  };
}

export function shouldNotifyAttendanceReward(now = getCurrentCstInfo()) {
  const minutes = Number(now?.minutes);
  return Number.isFinite(minutes) && minutes >= 8 * 60 && minutes < 9 * 60;
}

// skipRewardedUsers：定时任务使用，当天已领满奖励的人不再查询钉钉考勤（attendance/list 按次计量，配额有限）。
export async function reconcileAttendanceRewards(db, cfg, { date, userids, notifyOnReward = false, skipRewardedUsers = false } = {}) {
  const settings = await getAttendanceRewardSettings(db);
  if (!settings?.enabled) return { ok: true, skipped: true, reason: 'disabled' };
  if (settings.testMode === true) notifyOnReward = false;

  const range = getDateRange(date);
  if (!isAttendanceRewardDateActive(settings, range.date)) {
    return { ok: true, skipped: true, reason: 'before_start_date', date: range.date };
  }
  const nowCst = getCurrentCstInfo();
  if (range.date === nowCst.date && nowCst.minutes >= 9 * 60) {
    notifyOnReward = false; // 9 点后补发不推送，只记账
  }
  await seedAttendanceRewardRecordsFromAudit(db, { date: range.date });
  let users = Array.isArray(userids) && userids.length > 0
    ? userids.map((x) => String(x || '').trim()).filter(Boolean)
    // 外部活动账号没有钉钉考勤，不能进入按次计量的 attendance/list 查询。
    : (await db.all("SELECT userid FROM users WHERE COALESCE(source, 'dingtalk') <> 'external' ORDER BY userid ASC")).map((row) => String(row?.userid || '')).filter(Boolean);

  const totalUsers = users.length;
  if (skipRewardedUsers && settings.testMode !== true) {
    // 推送窗口内，只要有任何一条已发放的奖励通知还没发成功，就保留该用户（不受当前 maxPerDay 影响），
    // 由 handleAttendanceRecord 走通知补发。
    const doneRows = await db.all(
      `SELECT userid FROM attendance_reward_records
        WHERE work_date = ? AND status = 'rewarded'
        GROUP BY userid
        HAVING COUNT(*) >= ?
           AND (? = 0 OR SUM(CASE WHEN notify_status = 'sent' THEN 0 ELSE 1 END) = 0)`,
      [range.date, Math.max(1, Number(settings.maxPerDay) || 1), notifyOnReward ? 1 : 0],
    );
    const done = new Set((doneRows || []).map((row) => String(row?.userid || '')));
    users = users.filter((id) => !done.has(id));
  }
  if (users.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[AttendanceReward] reconcile date=${range.date} users=0/${totalUsers} attendanceListCalls=0 scheduled=${skipRewardedUsers}（全员已领奖，跳过）`);
    const summary = await getAttendanceRewardDailySummary(db, { days: 7, date: range.date });
    return { ok: true, date: range.date, count: 0, results: [], summary };
  }

  const attendanceRows = await fetchAttendanceRecords(cfg, { from: range.from, to: range.to, userids: users });
  // attendance/list 按次计量：记录每轮实际请求次数，便于和钉钉后台调用统计核对。
  // eslint-disable-next-line no-console
  console.log(
    `[AttendanceReward] reconcile date=${range.date} users=${users.length}/${totalUsers} `
    + `attendanceListCalls=${Math.ceil(users.length / RECONCILE_BATCH_SIZE)} records=${attendanceRows.length} `
    + `scheduled=${skipRewardedUsers}`,
  );
  const results = [];
  for (const record of attendanceRows) {
    // eslint-disable-next-line no-await-in-loop
    const result = await handleAttendanceRecord(db, cfg, settings, record, { eventSource: 'reconcile', notifyOnReward });
    results.push({
      userid: String(record?.userId || ''),
      check_time_ms: Number(record?.userCheckTime || record?.checkTime || 0),
      result,
    });
  }

  const summary = await getAttendanceRewardDailySummary(db, { days: 7, date: range.date });
  return { ok: true, date: range.date, count: attendanceRows.length, results, summary };
}

async function seedAttendanceRewardRecordsFromAudit(db, { date } = {}) {
  const range = getDateRange(date);
  const auditRows = await db.all(
    `SELECT actor_id, actor_name, event_type, message, payload
       FROM audit_logs
      WHERE event_type IN ('attendance_reward', 'attendance_skip')
        AND created_at >= ? AND created_at <= ?
      ORDER BY created_at ASC`,
    [range.fromTs, range.toTs],
  );

  for (const row of auditRows) {
    let payload = null;
    try { payload = row?.payload ? JSON.parse(String(row.payload)) : null; } catch { payload = null; }
    const userid = String(row?.actor_id || payload?.userid || '').trim();
    const checkTimeMs = Number(payload?.checkTimeMs || 0);
    if (!userid || !Number.isFinite(checkTimeMs) || checkTimeMs <= 0) continue;

    const normalized = {
      userid,
      user_name_snapshot: String(row?.actor_name || payload?.name || userid),
      work_date: range.date,
      check_time_ms: checkTimeMs,
      check_time_text: payload?.checkTimeText ? String(payload.checkTimeText) : formatCstTime(checkTimeMs),
      check_type: payload?.checkType ? String(payload.checkType) : '',
      source_type: payload?.sourceType ? String(payload.sourceType) : '',
      time_result: payload?.timeResult ? String(payload.timeResult) : '',
    };

    await db.run(
      `INSERT INTO attendance_reward_records(
        userid, user_name_snapshot, work_date, check_time_ms, check_time_text,
        check_type, source_type, time_result, event_source, status,
        skip_reason, reward_amount, reward_reason, notify_status, error_message, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      ON CONFLICT(userid, work_date, check_time_ms) DO NOTHING`,
      [
        normalized.userid,
        normalized.user_name_snapshot,
        normalized.work_date,
        normalized.check_time_ms,
        normalized.check_time_text,
        normalized.check_type || null,
        normalized.source_type || null,
        normalized.time_result || null,
        payload?.eventSource ? String(payload.eventSource) : 'audit_seed',
        String(row?.event_type || '') === 'attendance_reward' ? 'rewarded' : 'skipped',
        payload?.reason ? String(payload.reason) : null,
        String(row?.event_type || '') === 'attendance_reward' ? Number(payload?.amount || 0) : null,
        payload?.reason ? String(payload.reason) : null,
        'historical',
        null,
      ],
    );
  }
}

export async function getAttendanceRewardDailySummary(db, { days = 7, date = '' } = {}) {
  const limit = Math.min(31, Math.max(1, Number(days) || 7));
  const params = [];
  let where = '';
  if (date) {
    where = 'WHERE work_date = ?';
    params.push(String(date));
  }
  const rows = await db.all(
    `SELECT work_date,
        COUNT(*) AS total_records,
        SUM(CASE WHEN status = 'rewarded' THEN 1 ELSE 0 END) AS rewarded_count,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN event_source = 'reconcile' AND status = 'rewarded' THEN 1 ELSE 0 END) AS auto_compensated_count,
        COALESCE(SUM(CASE WHEN status = 'rewarded' THEN reward_amount ELSE 0 END), 0) AS total_reward_amount,
        MAX(updated_at) AS updated_at
      FROM attendance_reward_records
      ${where}
      GROUP BY work_date
      ORDER BY work_date DESC
      LIMIT ?`,
    [...params, limit],
  );
  return (rows || []).map((row) => ({
    work_date: String(row?.work_date || ''),
    total_records: Number(row?.total_records || 0),
    rewarded_count: Number(row?.rewarded_count || 0),
    skipped_count: Number(row?.skipped_count || 0),
    error_count: Number(row?.error_count || 0),
    anomaly_count: Number(row?.error_count || 0),
    auto_compensated_count: Number(row?.auto_compensated_count || 0),
    total_reward_amount: Number(row?.total_reward_amount || 0),
    updated_at: Number(row?.updated_at || 0),
    has_anomaly: Number(row?.error_count || 0) > 0,
  }));
}

export async function getAttendanceRewardDayDetail(db, { date } = {}) {
  const range = getDateRange(date);
  const rows = await db.all(
    `SELECT userid, user_name_snapshot, work_date, check_time_ms, check_time_text, check_type,
        source_type, time_result, event_source, status, skip_reason, reward_amount,
        reward_reason, notify_status, error_message, updated_at
      FROM attendance_reward_records
      WHERE work_date = ?
      ORDER BY check_time_ms ASC, userid ASC`,
    [range.date],
  );
  return {
    work_date: range.date,
    rows: (rows || []).map((row) => ({
      userid: String(row?.userid || ''),
      user_name_snapshot: row?.user_name_snapshot ? String(row.user_name_snapshot) : String(row?.userid || ''),
      check_time_ms: Number(row?.check_time_ms || 0),
      check_time_text: row?.check_time_text ? String(row.check_time_text) : formatCstTime(row?.check_time_ms, true),
      check_type: row?.check_type ? String(row.check_type) : '',
      source_type: row?.source_type ? String(row.source_type) : '',
      time_result: row?.time_result ? String(row.time_result) : '',
      event_source: row?.event_source ? String(row.event_source) : '',
      status: row?.status ? String(row.status) : '',
      skip_reason: row?.skip_reason ? String(row.skip_reason) : '',
      reward_amount: Number(row?.reward_amount || 0),
      reward_reason: row?.reward_reason ? String(row.reward_reason) : '',
      notify_status: row?.notify_status ? String(row.notify_status) : '',
      error_message: row?.error_message ? String(row.error_message) : '',
      updated_at: Number(row?.updated_at || 0),
    })),
  };
}

// 补偿只是 Stream 实时事件的兜底，按固定时间点各跑一次（attendance/list 按次计量）。
// notify=true 的时间点仍在 8–9 点推送窗口内。
export const ATTENDANCE_RECONCILE_SLOTS = [
  { key: 'morning-1', minutes: 8 * 60 + 20, notify: true },
  { key: 'morning-2', minutes: 8 * 60 + 50, notify: true },
  { key: 'midday', minutes: 11 * 60 + 5, notify: false },
  { key: 'evening', minutes: 18 * 60 + 5, notify: false },
];
const RECONCILE_SLOT_GRACE_MIN = 10;
const RECONCILE_SLOT_MAX_ATTEMPTS = 2;

export function getDueReconcileSlot(now, attempts = new Map()) {
  const minutes = Number(now?.minutes);
  if (!Number.isFinite(minutes)) return null;
  for (const slot of ATTENDANCE_RECONCILE_SLOTS) {
    if (minutes < slot.minutes || minutes >= slot.minutes + RECONCILE_SLOT_GRACE_MIN) continue;
    if ((attempts.get(`${now.date}:${slot.key}`) || 0) >= RECONCILE_SLOT_MAX_ATTEMPTS) continue;
    return slot;
  }
  return null;
}

export function startAttendanceRewardReconcileScheduler({ db, cfg } = {}) {
  let inFlight = false;
  const attempts = new Map();
  async function runOnce() {
    if (inFlight) return;
    const now = getCurrentCstInfo();
    const slot = getDueReconcileSlot(now, attempts);
    if (!slot) return;

    inFlight = true;
    const attemptKey = `${now.date}:${slot.key}`;
    attempts.set(attemptKey, (attempts.get(attemptKey) || 0) + 1);
    try {
      await reconcileAttendanceRewards(db, cfg, { notifyOnReward: slot.notify, skipRewardedUsers: true });
      attempts.set(attemptKey, RECONCILE_SLOT_MAX_ATTEMPTS);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AttendanceReward] reconcile failed:', err?.message || err);
    } finally {
      inFlight = false;
      for (const key of attempts.keys()) {
        if (!key.startsWith(`${now.date}:`)) attempts.delete(key);
      }
    }
  }
  setTimeout(runOnce, 15000);
  setInterval(runOnce, 60 * 1000);
}
