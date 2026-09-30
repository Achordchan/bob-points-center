import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDueReconcileSlot,
  handleCheckinEvent,
  reconcileAttendanceRewards,
} from '../../src/services/attendanceRewardService.js';
import { clearUserProfileCache, getUserProfile } from '../../src/services/dingtalkService.js';

function cstTimestamp(date, time) {
  return new Date(`${date}T${time}+08:00`).getTime();
}

function withFetchStub(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url: String(url), body });
    const result = await handler(String(url), body);
    return { ok: true, status: 200, text: async () => JSON.stringify(result), json: async () => result };
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => { globalThis.fetch = original; });
}

test('补偿任务只在固定时间点各跑一次，失败最多重试一次', () => {
  const attempts = new Map();
  assert.equal(getDueReconcileSlot({ date: '2026-09-30', minutes: 8 * 60 }, attempts), null);
  assert.equal(getDueReconcileSlot({ date: '2026-09-30', minutes: 8 * 60 + 20 }, attempts)?.key, 'morning-1');
  assert.equal(getDueReconcileSlot({ date: '2026-09-30', minutes: 8 * 60 + 35 }, attempts), null);
  assert.equal(getDueReconcileSlot({ date: '2026-09-30', minutes: 8 * 60 + 50 }, attempts)?.notify, true);
  assert.equal(getDueReconcileSlot({ date: '2026-09-30', minutes: 11 * 60 + 5 }, attempts)?.notify, false);

  attempts.set('2026-09-30:evening', 1);
  assert.equal(getDueReconcileSlot({ date: '2026-09-30', minutes: 18 * 60 + 6 }, attempts)?.key, 'evening');
  attempts.set('2026-09-30:evening', 2);
  assert.equal(getDueReconcileSlot({ date: '2026-09-30', minutes: 18 * 60 + 6 }, attempts), null);
  assert.equal(getDueReconcileSlot({ date: '2026-10-01', minutes: 18 * 60 + 6 }, attempts)?.key, 'evening');
});

function makeReconcileDb(userids, rewardedUserids) {
  return {
    async get(sql) {
      assert.match(sql, /system_settings/);
      return { value: JSON.stringify({ enabled: true, maxPerDay: 1 }) };
    },
    async all(sql) {
      if (/FROM audit_logs/.test(sql)) return [];
      if (/FROM users/.test(sql)) return userids.map((userid) => ({ userid }));
      if (/GROUP BY userid/.test(sql)) return rewardedUserids.map((userid) => ({ userid }));
      if (/FROM attendance_reward_records/.test(sql)) return [];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const quotaCfg = { dingtalk: { appKey: 'quota-test-key', appSecret: 'quota-test-secret' } };

test('定时补偿跳过当天已领满奖励的人，减少 attendance/list 调用', async () => {
  const userids = Array.from({ length: 45 }, (_v, i) => `u${i + 1}`);
  const rewarded = userids.slice(0, 30);
  await withFetchStub(
    (url) => (url.includes('/gettoken') ? { errcode: 0, access_token: 't', expires_in: 7200 } : { errcode: 0, recordresult: [] }),
    async (calls) => {
      await reconcileAttendanceRewards(makeReconcileDb(userids, rewarded), quotaCfg, {
        date: '2026-09-30',
        skipRewardedUsers: true,
      });
      const listCalls = calls.filter((c) => c.url.includes('/attendance/list'));
      assert.equal(listCalls.length, 1);
      assert.deepEqual(listCalls[0].body.userIdList, userids.slice(30));
    },
  );
});

test('全员已领奖时定时补偿不调用钉钉考勤接口', async () => {
  const userids = ['u1', 'u2', 'u3'];
  await withFetchStub(
    () => { throw new Error('不应调用钉钉接口'); },
    async (calls) => {
      const result = await reconcileAttendanceRewards(makeReconcileDb(userids, userids), quotaCfg, {
        date: '2026-09-30',
        skipRewardedUsers: true,
      });
      assert.equal(result.ok, true);
      assert.equal(result.count, 0);
      assert.equal(calls.length, 0);
    },
  );
});

test('手动补偿（未开启 skipRewardedUsers）仍查询全部用户', async () => {
  const userids = Array.from({ length: 45 }, (_v, i) => `u${i + 1}`);
  await withFetchStub(
    (url) => (url.includes('/gettoken') ? { errcode: 0, access_token: 't', expires_in: 7200 } : { errcode: 0, recordresult: [] }),
    async (calls) => {
      await reconcileAttendanceRewards(makeReconcileDb(userids, userids.slice(0, 30)), quotaCfg, { date: '2026-09-30' });
      assert.equal(calls.filter((c) => c.url.includes('/attendance/list')).length, 3);
    },
  );
});

function makeCheckinDb({ prior = null, profile = null } = {}) {
  return {
    async get(sql) {
      if (/system_settings/.test(sql)) return { value: JSON.stringify({ enabled: true }) };
      if (/FROM attendance_reward_records/.test(sql)) return prior;
      if (/FROM users/.test(sql)) return { name: '张三' };
      if (/FROM user_dingtalk_profiles/.test(sql)) return profile;
      throw new Error(`unexpected query: ${sql}`);
    },
    async transaction() {
      throw new Error('STOP_BEFORE_WRITE');
    },
  };
}

const checkinRecord = { userId: 'u1', userCheckTime: cstTimestamp('2026-09-30', '08:10:00'), checkType: 'OnDuty', timeResult: 'Normal' };

test('已有终态记录的打卡不再查询钉钉用户信息', async () => {
  const db = makeCheckinDb({ prior: { id: 1, status: 'rewarded', notify_status: 'sent', reward_reason: 'r', reward_amount: 3 } });
  await withFetchStub(
    () => { throw new Error('不应调用钉钉接口'); },
    async (calls) => {
      await handleCheckinEvent(db, quotaCfg, { data: JSON.stringify(checkinRecord) });
      assert.equal(calls.length, 0);
    },
  );
});

test('本地已同步且未过期的用户资料优先，不调用钉钉 user/get', async () => {
  const db = makeCheckinDb({ profile: { name: '张三', dept_ids: JSON.stringify([1, 2]), updated_at: Math.floor(Date.now() / 1000) } });
  await withFetchStub(
    () => { throw new Error('不应调用钉钉接口'); },
    async (calls) => {
      await assert.rejects(handleCheckinEvent(db, quotaCfg, { data: JSON.stringify(checkinRecord) }), /STOP_BEFORE_WRITE/);
      assert.equal(calls.length, 0);
    },
  );
});

test('本地无资料时才调用 user/get，且短时间内同一员工只查一次', async () => {
  clearUserProfileCache();
  const cfg = { dingtalk: { appKey: 'profile-cache-key', appSecret: 'profile-cache-secret' } };
  await withFetchStub(
    (url) => (url.includes('/gettoken')
      ? { errcode: 0, access_token: 't', expires_in: 7200 }
      : { errcode: 0, result: { name: '李四', dept_id_list: [7] } }),
    async (calls) => {
      const [a, b] = await Promise.all([getUserProfile(cfg, 'u9'), getUserProfile(cfg, 'u9')]);
      const c = await getUserProfile(cfg, 'u9');
      assert.equal(a.name, '李四');
      assert.deepEqual(b.deptIds, ['7']);
      assert.equal(c.name, '李四');
      assert.equal(calls.filter((call) => call.url.includes('/user/get')).length, 1);
    },
  );
  clearUserProfileCache();
});

test('推送窗口内的定时补偿保留通知未发送成功的人，用于通知补发', async () => {
  // 使用过去的日期：当天 9 点后 reconcile 会强制关闭推送，避免测试依赖真实时钟
  const seen = [];
  const db = {
    async get() { return { value: JSON.stringify({ enabled: true, maxPerDay: 1 }) }; },
    async all(sql, params) {
      if (/FROM audit_logs/.test(sql)) return [];
      if (/FROM users/.test(sql)) return [{ userid: 'u1' }, { userid: 'u2' }];
      if (/GROUP BY userid/.test(sql)) {
        seen.push({ sql, params });
        // 仅 u1 已领奖且通知已发送；u2 已领奖但通知未发送，在查询条件里不应被算作“已完成”
        return params[1] === 1 ? [{ userid: 'u1' }] : [{ userid: 'u1' }, { userid: 'u2' }];
      }
      return [];
    },
  };
  await withFetchStub(
    (url) => (url.includes('/gettoken') ? { errcode: 0, access_token: 't', expires_in: 7200 } : { errcode: 0, recordresult: [] }),
    async (calls) => {
      await reconcileAttendanceRewards(db, quotaCfg, { date: '2026-09-01', skipRewardedUsers: true, notifyOnReward: true });
      assert.match(seen[0].sql, /notify_status = 'sent'/);
      assert.equal(seen[0].params[1], 1);
      assert.deepEqual(calls.find((c) => c.url.includes('/attendance/list')).body.userIdList, ['u2']);

      calls.length = 0;
      await reconcileAttendanceRewards(db, quotaCfg, { date: '2026-09-01', skipRewardedUsers: true, notifyOnReward: false });
      assert.equal(seen[1].params[1], 0);
      assert.equal(calls.filter((c) => c.url.includes('/attendance/list')).length, 0);
    },
  );
});

test('测试模式的试运行记录在关闭测试模式后重新判定，不被当作终态复用', async () => {
  clearUserProfileCache();
  const db = makeCheckinDb({
    prior: { id: 7, status: 'test_passed', notify_status: 'not_sent', reward_reason: '', reward_amount: 0 },
    profile: { name: '张三', dept_ids: '[]', updated_at: Math.floor(Date.now() / 1000) },
  });
  await withFetchStub(
    () => { throw new Error('本地资料有效，不应调用钉钉接口'); },
    async () => {
      await assert.rejects(
        handleCheckinEvent(db, quotaCfg, { data: JSON.stringify(checkinRecord) }),
        /STOP_BEFORE_WRITE/,
      );
    },
  );
});
