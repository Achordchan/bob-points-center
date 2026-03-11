import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { initDb } from '../src/db/index.js';
import { getAccessToken } from '../src/services/dingtalkService.js';

function parseArgs(argv) {
  const out = { date: '', userid: '', batchSize: 20 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (arg === '--date') out.date = String(argv[i + 1] || ''), i += 1;
    else if (arg === '--userid') out.userid = String(argv[i + 1] || ''), i += 1;
    else if (arg === '--batch-size') out.batchSize = Math.max(1, Number(argv[i + 1] || 20) || 20), i += 1;
  }
  return out;
}

function getDateRange(dateText) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateText)
    ? dateText
    : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return {
    date,
    from: `${date} 00:00:00`,
    to: `${date} 23:59:59`,
    fromTs: Math.floor(new Date(`${date}T00:00:00+08:00`).getTime() / 1000),
    toTs: Math.floor(new Date(`${date}T23:59:59+08:00`).getTime() / 1000),
  };
}

function chunk(arr, size) {
  const rows = [];
  for (let i = 0; i < arr.length; i += size) rows.push(arr.slice(i, i + size));
  return rows;
}

function formatCst(ms) {
  const ts = Number(ms || 0);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

function normalizeAttendanceRecord(raw) {
  const userCheckTime = Number(raw?.userCheckTime || raw?.checkTime || 0);
  const local = new Date(userCheckTime + 8 * 3600 * 1000);
  return {
    userid: String(raw?.userId || ''),
    checkType: String(raw?.checkType || ''),
    sourceType: String(raw?.sourceType || ''),
    timeResult: String(raw?.timeResult || ''),
    userCheckTime,
    timeText: formatCst(userCheckTime),
    totalMinutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

function isEligibleRecord(record) {
  if (!record.userid || !Number.isFinite(record.userCheckTime) || record.userCheckTime <= 0) return false;
  if (record.checkType !== 'OnDuty') return false;
  return record.totalMinutes <= (8 * 60 + 30);
}

async function fetchAttendanceRecords(cfg, { from, to, userids, batchSize }) {
  const token = await getAccessToken(cfg);
  const rows = [];
  for (const batch of chunk(userids, batchSize)) {
    const resp = await fetch(`https://oapi.dingtalk.com/attendance/list?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    rows.push(...(Array.isArray(data?.recordresult) ? data.recordresult.map(normalizeAttendanceRecord) : []));
  }
  return rows;
}

const args = parseArgs(process.argv);
const range = getDateRange(args.date);
const cfg = loadConfig();
const db = await initDb(cfg);
try {
  const userRows = args.userid
    ? await db.all('SELECT userid, COALESCE(name,\'\') AS name FROM users WHERE userid = ? LIMIT 1', [args.userid])
    : await db.all('SELECT userid, COALESCE(name,\'\') AS name FROM users ORDER BY userid ASC');
  const users = userRows.map((row) => ({ userid: String(row.userid), name: String(row.name || '') }));
  const nameMap = new Map(users.map((row) => [row.userid, row.name]));

  const attendanceRows = await fetchAttendanceRecords(cfg, {
    from: range.from,
    to: range.to,
    userids: users.map((row) => row.userid),
    batchSize: args.batchSize,
  });

  const auditRows = await db.all(
    `SELECT actor_id, actor_name, event_type, message, payload, created_at
       FROM audit_logs
      WHERE event_type IN ('attendance_reward', 'attendance_skip')
        AND created_at >= ? AND created_at <= ?`,
    [range.fromTs, range.toTs],
  );

  const auditByRecord = new Map();
  for (const row of auditRows) {
    let payload = null;
    try { payload = row?.payload ? JSON.parse(String(row.payload)) : null; } catch { payload = null; }
    const userid = String(row?.actor_id || payload?.userid || '');
    const checkTimeMs = Number(payload?.checkTimeMs || 0);
    if (!userid || !Number.isFinite(checkTimeMs) || checkTimeMs <= 0) continue;
    auditByRecord.set(`${userid}:${checkTimeMs}`, {
      event_type: String(row?.event_type || ''),
      message: String(row?.message || ''),
      created_at: Number(row?.created_at || 0),
    });
  }

  const eligible = attendanceRows.filter(isEligibleRecord);
  const missing = eligible
    .filter((row) => !auditByRecord.has(`${row.userid}:${row.userCheckTime}`))
    .map((row) => ({
      userid: row.userid,
      name: nameMap.get(row.userid) || '',
      time: row.timeText,
      checkType: row.checkType,
      sourceType: row.sourceType,
      timeResult: row.timeResult,
    }));

  console.log(JSON.stringify({
    date: range.date,
    attendance_records: attendanceRows.length,
    eligible_records: eligible.length,
    audit_records: auditRows.length,
    missing_count: missing.length,
    missing,
  }, null, 2));
} finally {
  await db.close();
}
