import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { initDb } from '../src/db/index.js';
import { getAccessToken } from '../src/services/dingtalkService.js';
import { evaluateAttendanceRewardRecord } from '../src/services/attendanceRewardService.js';
import { getAttendanceRewardSettings } from '../src/services/systemSettings.js';

function parseArgs(argv) {
  const out = { date: '', userid: '', batchSize: 20, fixtureOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (arg === '--date') out.date = String(argv[i + 1] || ''), i += 1;
    else if (arg === '--userid') out.userid = String(argv[i + 1] || ''), i += 1;
    else if (arg === '--batch-size') out.batchSize = Math.max(1, Number(argv[i + 1] || 20) || 20), i += 1;
    else if (arg === '--fixture-only') out.fixtureOnly = true;
  }
  return out;
}

function getDateRange(dateText) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))
    ? String(dateText)
    : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return { date, from: `${date} 00:00:00`, to: `${date} 23:59:59` };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function toJson(value, fallback) {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function cstMs(date, hhmm) {
  return new Date(`${date}T${hhmm}:00+08:00`).getTime();
}

function fixtureRecords(date) {
  return [
    { label: '上班打卡命中', profile: { name: '测试用户A', deptIds: ['100'] }, record: { userId: 'TEST_A', checkTime: cstMs(date, '08:25'), checkType: 'OnDuty', timeResult: 'Normal' } },
    { label: '宽限内命中', profile: { name: '测试用户B', deptIds: ['100'] }, record: { userId: 'TEST_B', checkTime: cstMs(date, '08:35'), checkType: 'OnDuty', timeResult: 'Normal' } },
    { label: '迟到跳过', profile: { name: '测试用户C', deptIds: ['100'] }, record: { userId: 'TEST_C', checkTime: cstMs(date, '09:10'), checkType: 'OnDuty', timeResult: 'Late' } },
    { label: '下班打卡跳过', profile: { name: '测试用户D', deptIds: ['100'] }, record: { userId: 'TEST_D', checkTime: cstMs(date, '18:00'), checkType: 'OffDuty', timeResult: 'Normal' } },
    { label: '非适用部门跳过', profile: { name: '测试用户E', deptIds: ['999'] }, record: { userId: 'TEST_E', checkTime: cstMs(date, '08:20'), checkType: 'OnDuty', timeResult: 'Normal' } },
  ];
}

async function fetchAttendanceRecords(cfg, { from, to, userids, batchSize }) {
  const token = await getAccessToken(cfg);
  const rows = [];
  for (const batch of chunk(userids, batchSize)) {
    const resp = await fetch(`https://oapi.dingtalk.com/attendance/list?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workDateFrom: from, workDateTo: to, userIdList: batch, offset: 0, limit: 50 }),
    });
    const data = await resp.json();
    if (!resp.ok || Number(data?.errcode || 0) !== 0) throw new Error(`attendance_api_failed: ${JSON.stringify(data)}`);
    rows.push(...(Array.isArray(data?.recordresult) ? data.recordresult : []));
  }
  return rows;
}

function printResult(payload) {
  console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
}

const args = parseArgs(process.argv);
const range = getDateRange(args.date);

if (args.fixtureOnly) {
  const baseSettings = {
    enabled: true,
    workStartTime: '08:30',
    lateGraceMinutes: 10,
    maxPerDay: 1,
    onlyCheckin: true,
    departmentMode: 'selected',
    departmentIds: ['100'],
    departmentExpandedIds: ['100', '101'],
    reason: '内部测试',
  };
  const buildCases = (testMode) => fixtureRecords(range.date).map((item) => {
    const settings = { ...baseSettings, testMode };
    const result = evaluateAttendanceRewardRecord(settings, item.record, item.profile);
    return { label: item.label, test_mode: testMode, userid: item.record.userId, status: result.status, reason: result.reason, would_reward: result.wouldReward };
  });
  printResult({
    safe: { sends_dingtalk_message: false, grants_bob: false, writes_database: false },
    mode: 'fixture',
    date: range.date,
    cases: [...buildCases(false), ...buildCases(true)],
  });
  process.exit(0);
}

if (process.env.BOB_ATTENDANCE_READONLY_LIVE !== '1') {
  throw new Error('拒绝执行：实时钉钉只读检查会初始化数据库连接。请设置 BOB_ATTENDANCE_READONLY_LIVE=1 后再执行，推荐优先使用 --fixture-only。');
}

const cfg = loadConfig();
const db = await initDb(cfg);
try {
  const settings = await getAttendanceRewardSettings(db);
  const users = args.userid
    ? await db.all('SELECT u.userid, COALESCE(u.name, p.name, \'\') AS name, p.dept_ids FROM users u LEFT JOIN user_dingtalk_profiles p ON p.userid = u.userid WHERE u.userid = ? LIMIT 1', [args.userid])
    : await db.all('SELECT u.userid, COALESCE(u.name, p.name, \'\') AS name, p.dept_ids FROM users u LEFT JOIN user_dingtalk_profiles p ON p.userid = u.userid ORDER BY u.userid ASC');
  const profileMap = new Map(users.map((row) => [String(row.userid), {
    name: String(row.name || ''),
    deptIds: (toJson(row.dept_ids, []) || []).map((id) => String(id)),
  }]));
  const records = await fetchAttendanceRecords(cfg, {
    from: range.from,
    to: range.to,
    userids: users.map((row) => String(row.userid)),
    batchSize: args.batchSize,
  });
  const evaluated = records.map((record) => {
    const userid = String(record?.userId || '');
    const profile = profileMap.get(userid) || { name: '', deptIds: [] };
    const result = evaluateAttendanceRewardRecord(settings, record, profile);
    return {
      userid,
      name: profile.name,
      deptIds: profile.deptIds,
      status: result.status,
      reason: result.reason,
      would_reward: result.wouldReward,
      check_time_text: result.normalized?.check_time_text || '',
      check_type: result.normalized?.check_type || '',
      time_result: result.normalized?.time_result || '',
    };
  });
  printResult({
    safe: { sends_dingtalk_message: false, grants_bob: false, writes_database: 'db_schema_init_possible' },
    mode: 'dingtalk-readonly',
    date: range.date,
    settings: {
      enabled: settings.enabled,
      testMode: settings.testMode,
      workStartTime: settings.workStartTime,
      lateGraceMinutes: settings.lateGraceMinutes,
      onlyCheckin: settings.onlyCheckin,
      departmentMode: settings.departmentMode,
      departmentIds: settings.departmentIds,
      departmentExpandedIds: settings.departmentExpandedIds,
    },
    users: users.length,
    attendance_records: records.length,
    would_reward_count: evaluated.filter((row) => row.would_reward).length,
    skipped_count: evaluated.filter((row) => !row.would_reward).length,
    rows: evaluated,
  });
} finally {
  await db.close();
}
