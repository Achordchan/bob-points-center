import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAttendanceRewardRecord, isAttendanceRewardDateActive, reconcileAttendanceRewards } from '../../src/services/attendanceRewardService.js';
import { normalizeAttendanceRewardSettings } from '../../src/services/systemSettings.js';

function cstTimestamp(date, time) {
  return new Date(`${date}T${time}+08:00`).getTime();
}

test('打卡奖励生效日期规范化并拒绝无效日期', () => {
  assert.equal(normalizeAttendanceRewardSettings({ startDate: '2026-08-04' }).startDate, '2026-08-04');
  assert.equal(normalizeAttendanceRewardSettings({ startDate: '2026/08/04' }).startDate, '');
  assert.equal(normalizeAttendanceRewardSettings({ startDate: '2026-02-30' }).startDate, '');
});

test('生效日期之前不奖励，生效日期当天开始奖励', () => {
  const settings = normalizeAttendanceRewardSettings({
    enabled: true,
    startDate: '2026-08-04',
    workStartTime: '08:30',
    onlyCheckin: true,
  });
  const userProfile = { name: '测试员工', deptIds: [] };
  const before = evaluateAttendanceRewardRecord(settings, {
    userId: 'u1',
    userCheckTime: cstTimestamp('2026-08-03', '08:20:00'),
    checkType: 'OnDuty',
    timeResult: 'Normal',
  }, userProfile);
  const active = evaluateAttendanceRewardRecord(settings, {
    userId: 'u1',
    userCheckTime: cstTimestamp('2026-08-04', '08:20:00'),
    checkType: 'OnDuty',
    timeResult: 'Normal',
  }, userProfile);
  assert.equal(before.wouldReward, false);
  assert.equal(before.reason, 'before_start_date');
  assert.equal(active.wouldReward, true);
  assert.equal(active.reason, '');
  assert.equal(isAttendanceRewardDateActive(settings, '2026-08-03'), false);
  assert.equal(isAttendanceRewardDateActive(settings, '2026-08-04'), true);
});

test('未配置生效日期时保持原有行为', () => {
  assert.equal(isAttendanceRewardDateActive({}, '2026-08-03'), true);
});

test('对账日期早于生效日期时不读取用户或调用考勤接口', async () => {
  let queryCount = 0;
  const db = {
    async get(sql) {
      assert.match(sql, /system_settings/);
      return { value: JSON.stringify({ enabled: true, startDate: '2026-08-04' }) };
    },
    async all() {
      queryCount += 1;
      throw new Error('生效前不应查询用户或考勤记录');
    },
  };
  const result = await reconcileAttendanceRewards(db, {}, { date: '2026-08-03', notifyOnReward: true });
  assert.deepEqual(result, { ok: true, skipped: true, reason: 'before_start_date', date: '2026-08-03' });
  assert.equal(queryCount, 0);
});
