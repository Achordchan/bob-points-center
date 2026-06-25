import { getAttendanceRewardSettings } from './systemSettings.js';
import { ensureAccount, getBalance, grantBob } from './ledgerService.js';
import { getUserName, sendOrQueueNotify } from './notifyOpsService.js';
import { safeAppendAuditLog } from './auditLogService.js';
import { getAccessToken, getUserProfile } from './dingtalkService.js';

const RECONCILE_BATCH_SIZE = 20;
const CUTOFF_MIN = 8 * 60 + 30; // 08:30 前算有效

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

function normalizeAttendanceRecord(record, fallbackUserName = '') {
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

function isOnDutyEligible(normalized, settings) {
  if (!normalized.userid) return { ok: false, skipReason: 'missing_userid' };
  if (!normalized.check_time_ms) return { ok: false, skipReason: 'missing_check_time' };
  if (String(normalized.time_result || '').trim().toLowerCase() === 'notsigned') {
    return { ok: false, skipReason: 'not_signed' };
  }
  const startMin = CUTOFF_MIN;
  const grace = Number(settings.lateGraceMinutes) || 0;
  const cutoff = startMin + grace;

  if (normalized.check_type === 'off_duty') {
    return settings.onlyCheckin ? { ok: false, skipReason: 'skipped_off_duty' } : { ok: true, skipReason: '' };
  }

  if (Number(normalized.check_total_min) > cutoff) {
    return { ok: false, skipReason: 'skipped_late' };
  }
  if (normalized.check_type !== 'on_duty') return { ok: false, skipReason: 'not_on_duty' };
  return { ok: true, skipReason: '' };
}

export function isAttendanceDepartmentAllowed(userProfile, settings) {
  const mode = String(settings?.departmentMode || 'all');
  if (mode !== 'selected') return { ok: true, skipReason: '' };
  const allow = new Set((Array.isArray(settings?.departmentIds) ? settings.departmentIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  if (allow.size === 0) return { ok: false, skipReason: 'department_not_allowed' };
  const userDeptIds = Array.isArray(userProfile?.deptIds) ? userProfile.deptIds.map((id) => String(id || '').trim()) : [];
  const matched = userDeptIds.some((id) => allow.has(id));
  return matched ? { ok: true, skipReason: '' } : { ok: false, skipReason: 'department_not_allowed' };
}

function humanizeSkipMessage(skipReason, normalized) {
  const timeSuffix = normalized.check_time_text ? `（${normalized.check_time_text}）` : '';
  if (skipReason === 'skipped_off_duty') return `下班打卡，按设置忽略奖励${timeSuffix}`;
  if (skipReason === 'not_signed') return `未打卡，跳过奖励${timeSuffix}`;
  if (skipReason === 'skipped_late') return `打卡晚于 08:30（含宽限），跳过奖励${timeSuffix}`;
  if (skipReason === 'max_per_day') return `今日已奖励 1 次，跳过${timeSuffix}`;
  if (skipReason === 'department_not_allowed') return `不在打卡奖励适用部门内，跳过奖励${timeSuffix}`;
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

async function resolveAttendanceUserProfile(db, cfg, userid) {
  const localName = await getUserName(db, userid);
  const fallback = { name: localName || '', deptIds: [] };

  if (!cfg?.dingtalk?.appKey || !cfg?.dingtalk?.appSecret) {
    return fallback;
  }

  try {
    const profile = await getUserProfile(cfg, userid);
    const profileName = profile?.name ? String(profile.name).trim() : '';
    if (profileName && profileName !== userid) {
      await ensureAccount(db, { userid, name: profileName });
    }
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
  const profile = await resolveAttendanceUserProfile(db, cfg, userid);
  return profile.name || '';
}

async function handleAttendanceRecord(db, cfg, settings, record, { eventSource = 'stream', notifyOnReward = false } = {}) {
  const userid = record?.userId ? String(record.userId).trim() : '';
  if (!userid) return { ok: false, skipped: true, reason: 'missing_userid' };
  const userProfile = await resolveAttendanceUserProfile(db, cfg, userid);
  const displayName = userProfile.name || '';
  const normalized = normalizeAttendanceRecord(record, displayName || userid);
  if (!normalized.user_name_snapshot) normalized.user_name_snapshot = displayName || userid;

  const result = await db.transaction(async (tx) => {
    const existing = await ensureAttendanceRewardRow(tx, normalized, { eventSource });
    if (existing && String(existing.status || '') !== 'pending') {
      return {
        ok: true,
        reused: true,
        status: String(existing.status || ''),
        recordId: existing.id,
        notify_status: existing.notify_status,
        rewardReason: existing.reward_reason,
        amount: existing.reward_amount,
      };
    }

    const deptEligibility = isAttendanceDepartmentAllowed(userProfile, settings);
    if (!deptEligibility.ok) {
      await finalizeAttendanceRecord(tx, existing.id, {
        status: 'skipped',
        skip_reason: deptEligibility.skipReason,
        event_source: eventSource,
      });
      const message = humanizeSkipMessage(deptEligibility.skipReason, normalized);
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
          allowedDepartmentIds: settings.departmentIds,
          eventSource,
        },
      });
      return { ok: true, skipped: true, reason: deptEligibility.skipReason };
    }

    const isTestMode = settings.testMode === true;
    if (!isTestMode) {
      const eligibility = isOnDutyEligible(normalized, settings);
      if (!eligibility.ok) {
        await finalizeAttendanceRecord(tx, existing.id, {
          status: 'skipped',
          skip_reason: eligibility.skipReason,
          event_source: eventSource,
        });
        const message = humanizeSkipMessage(eligibility.skipReason, normalized);
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
          message: humanizeSkipMessage('max_per_day', normalized),
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

    const amount = randomInt(
      Math.max(1, Number(settings.rewardMin) || 1),
      Math.max(Number(settings.rewardMin) || 1, Number(settings.rewardMax) || 1),
    );
    const rewardReason = renderReason(settings.reason, { name: normalized.user_name_snapshot || userid, userid });

    try {
      const grant = await grantBob(tx, { userid, amount, reason: rewardReason });
      await finalizeAttendanceRecord(tx, existing.id, {
        status: 'rewarded',
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
  for (const record of records) {
    // eslint-disable-next-line no-await-in-loop
    await handleAttendanceRecord(db, cfg, settings, record, { eventSource: 'stream', notifyOnReward: false });
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

export async function reconcileAttendanceRewards(db, cfg, { date, userids, notifyOnReward = true } = {}) {
  const settings = await getAttendanceRewardSettings(db);
  if (!settings?.enabled) return { ok: true, skipped: true, reason: 'disabled' };

  const range = getDateRange(date);
  const nowCst = getCurrentCstInfo();
  if (range.date === nowCst.date && nowCst.minutes >= 9 * 60) {
    notifyOnReward = false; // 9 点后补发不推送，只记账
  }
  await seedAttendanceRewardRecordsFromAudit(db, { date: range.date });
  const users = Array.isArray(userids) && userids.length > 0
    ? userids.map((x) => String(x || '').trim()).filter(Boolean)
    : (await db.all('SELECT userid FROM users ORDER BY userid ASC')).map((row) => String(row?.userid || '')).filter(Boolean);

  const attendanceRows = await fetchAttendanceRecords(cfg, { from: range.from, to: range.to, userids: users });
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

export function startAttendanceRewardReconcileScheduler({ db, cfg } = {}) {
  let inFlight = false;
  async function runOnce() {
    if (inFlight) return;
    const now = getCurrentCstInfo();
    const inMorningWindow = now.minutes >= 8 * 60 && now.minutes < 9 * 60;
    const inMiddayWindow = now.minutes >= 11 * 60 && now.minutes < 11 * 60 + 15;
    const inEveningWindow = now.minutes >= 18 * 60 && now.minutes < 18 * 60 + 15;
    if (!inMorningWindow && !inMiddayWindow && !inEveningWindow) return;

    inFlight = true;
    try {
      await reconcileAttendanceRewards(db, cfg, { notifyOnReward: inMorningWindow });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AttendanceReward] reconcile failed:', err?.message || err);
    } finally {
      inFlight = false;
    }
  }
  setTimeout(runOnce, 15000);
  setInterval(runOnce, 2 * 60 * 1000);
}
