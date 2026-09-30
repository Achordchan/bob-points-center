import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEventUserIds,
  getCstNow,
  handleContactUserEvent,
  isWeeklySyncDue,
  persistDingtalkUserDetail,
} from '../../src/services/dingtalkUserSyncService.js';
import { clearUserProfileCache } from '../../src/services/dingtalkService.js';

const cfg = { dingtalk: { appKey: 'sync-test-key', appSecret: 'sync-test-secret' } };

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

function makeDb({ existing = null } = {}) {
  const log = { run: [], exec: [], order: [] };
  const tx = {
    async run(sql, params) { log.run.push({ sql, params }); },
    async exec(sql, params) { log.exec.push({ sql, params }); if (/INSERT INTO user_dingtalk_profiles/.test(sql)) log.order.push('upsert'); },
  };
  return {
    log,
    async get(sql) {
      assert.match(sql, /user_dingtalk_profiles/);
      return existing;
    },
    async run(sql, params) { log.run.push({ sql, params }); if (/SET active = 0/.test(sql)) log.order.push('leave'); },
    async exec(sql, params) { log.exec.push({ sql, params }); },
    async transaction(fn) { return fn(tx); },
  };
}

function upsertOf(db) {
  return db.log.exec.find((c) => /INSERT INTO user_dingtalk_profiles/.test(c.sql));
}

test('通讯录事件里的 userId 兼容大小写与数组/字符串', () => {
  assert.deepEqual(extractEventUserIds({ UserId: ['a', 'b', 'a'] }), ['a', 'b']);
  assert.deepEqual(extractEventUserIds(JSON.stringify({ userId: 'c' })), ['c']);
  assert.deepEqual(extractEventUserIds({ userIds: ['d'] }), ['d']);
  assert.deepEqual(extractEventUserIds('not json'), []);
  assert.deepEqual(extractEventUserIds({ other: 1 }), []);
});

test('每周一 3:30–4:00 才触发全量同步，失败最多重试一次', () => {
  const monday = '2026-10-05';
  assert.equal(getCstNow(new Date('2026-10-05T03:35:00+08:00').getTime()).weekday, 1);
  assert.equal(isWeeklySyncDue({ date: monday, weekday: 1, minutes: 3 * 60 + 35 }), true);
  assert.equal(isWeeklySyncDue({ date: monday, weekday: 1, minutes: 3 * 60 + 10 }), false);
  assert.equal(isWeeklySyncDue({ date: monday, weekday: 1, minutes: 4 * 60 }), false);
  assert.equal(isWeeklySyncDue({ date: '2026-10-06', weekday: 2, minutes: 3 * 60 + 35 }), false);
  assert.equal(isWeeklySyncDue({ date: monday, weekday: 1, minutes: 3 * 60 + 35 }, new Map([[monday, 1]])), true);
  assert.equal(isWeeklySyncDue({ date: monday, weekday: 1, minutes: 3 * 60 + 35 }, new Map([[monday, 2]])), false);
});

test('入职/调动事件：拉取该员工详情并写入本地资料，部门名称按需补查', async () => {
  clearUserProfileCache();
  const db = makeDb();
  await withFetchStub(
    (url) => {
      if (url.includes('/gettoken')) return { errcode: 0, access_token: 't', expires_in: 7200 };
      if (url.includes('/user/get')) {
        return { errcode: 0, result: { name: '王五', active: true, dept_id_list: [1, 88], title: '工程师' } };
      }
      if (url.includes('/department/get')) return { errcode: 0, result: { name: '工程部' } };
      throw new Error(`unexpected ${url}`);
    },
    async (calls) => {
      const out = await handleContactUserEvent(db, cfg, { topic: 'user_add_org', data: JSON.stringify({ UserId: ['w5'] }) });
      assert.equal(out.count, 1);
      const upsert = upsertOf(db);
      assert.ok(upsert, '应写入 user_dingtalk_profiles');
      assert.equal(upsert.params[0], 'w5');
      assert.equal(upsert.params[2], '王五');
      assert.equal(upsert.params[12], JSON.stringify(['1', '88']));
      assert.equal(upsert.params[13], JSON.stringify(['根部门', '工程部']));
      // 部门 1 不查询，只补查部门 88
      assert.equal(calls.filter((c) => c.url.includes('/department/get')).length, 1);
    },
  );
});

test('离职事件只标记停用，不删除用户与账户', async () => {
  const db = makeDb();
  await withFetchStub(
    () => { throw new Error('不应调用钉钉接口'); },
    async (calls) => {
      await handleContactUserEvent(db, cfg, { topic: 'user_leave_org', data: { UserId: ['gone'] } });
      assert.equal(calls.length, 0);
      assert.equal(db.log.run.length, 1);
      assert.match(db.log.run[0].sql, /UPDATE user_dingtalk_profiles SET active = 0/);
      assert.deepEqual(db.log.run[0].params, ['gone']);
    },
  );
});

test('单个员工同步失败不影响同批其他员工', async () => {
  clearUserProfileCache();
  const db = makeDb();
  await withFetchStub(
    (url, body) => {
      if (url.includes('/gettoken')) return { errcode: 0, access_token: 't', expires_in: 7200 };
      if (body?.userid === 'bad') return { errcode: 60121, errmsg: 'not found' };
      return { errcode: 0, result: { name: '赵六', active: true, dept_id_list: [1] } };
    },
    async () => {
      const out = await handleContactUserEvent(db, cfg, { topic: 'user_modify_org', data: { UserId: ['bad', 'ok'] } });
      assert.equal(out.count, 2);
      assert.equal(upsertOf(db)?.params[0], 'ok');
    },
  );
});

test('未激活且本地无资料的员工不创建账户', async () => {
  const db = makeDb();
  const out = await persistDingtalkUserDetail(db, cfg, { userid: 'x1', name: '未激活', active: false, dept_id_list: [1] });
  assert.equal(out.skipped, true);
  assert.equal(upsertOf(db), undefined);
});

test('部门未变化时沿用本地部门名称，不再请求钉钉', async () => {
  const db = makeDb({ existing: { dept_ids: JSON.stringify(['1', '88']), dept_names: JSON.stringify(['根部门', '工程部']), updated_at: 1 } });
  await withFetchStub(
    () => { throw new Error('不应调用钉钉接口'); },
    async (calls) => {
      await persistDingtalkUserDetail(db, cfg, { userid: 'k1', name: '孙七', active: true, dept_id_list: [1, 88] });
      assert.equal(calls.length, 0);
      assert.equal(upsertOf(db).params[13], JSON.stringify(['根部门', '工程部']));
    },
  );
});

test('onlyIfStale：24 小时内已更新的资料不重复写库', async () => {
  const fresh = { dept_ids: '[]', dept_names: '[]', updated_at: Math.floor(Date.now() / 1000) };
  const db = makeDb({ existing: fresh });
  const out = await persistDingtalkUserDetail(db, cfg, { userid: 'k2', name: '周八', active: true, dept_id_list: [1] }, { onlyIfStale: true });
  assert.equal(out.reason, 'fresh');
  assert.equal(upsertOf(db), undefined);

  const staleDb = makeDb({ existing: { ...fresh, updated_at: Math.floor(Date.now() / 1000) - 3 * 86400 } });
  await withFetchStub(
    () => ({ errcode: 0, result: { name: '工程部' } }),
    async () => {
      await persistDingtalkUserDetail(staleDb, cfg, { userid: 'k2', name: '周八', active: true, dept_id_list: [1] }, { onlyIfStale: true });
      assert.ok(upsertOf(staleDb));
    },
  );
});

test('同一员工的事件串行处理：慢的资料修改不会覆盖随后到达的离职', async () => {
  clearUserProfileCache();
  const db = makeDb();
  await withFetchStub(
    async (url) => {
      if (url.includes('/gettoken')) return { errcode: 0, access_token: 't', expires_in: 7200 };
      if (url.includes('/user/get')) return { errcode: 0, result: { name: '钱九', active: true, dept_id_list: [1, 99] } };
      if (url.includes('/department/get')) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { errcode: 0, result: { name: '运营部' } };
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      await Promise.all([
        handleContactUserEvent(db, cfg, { topic: 'user_modify_org', data: { UserId: ['race1'] } }),
        handleContactUserEvent(db, cfg, { topic: 'user_leave_org', data: { UserId: ['race1'] } }),
      ]);
      assert.deepEqual(db.log.order, ['upsert', 'leave']);
    },
  );
});
