import test from 'node:test';
import assert from 'node:assert/strict';
import {
  syncAllDingtalkUsers,
  extractEventUserIds,
  getCstNow,
  beginUserSnapshot,
  handleContactUserEvent,
  isWeeklySyncDue,
  persistDingtalkUserDetail,
} from '../../src/services/dingtalkUserSyncService.js';
import { clearUserProfileCache, getUserProfile, invalidateUserProfileCache } from '../../src/services/dingtalkService.js';

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

function makeDb({ existing = null, activeProfiles = [] } = {}) {
  const log = { run: [], exec: [], order: [] };
  const tx = {
    async run(sql, params) { log.run.push({ sql, params }); },
    async exec(sql, params) { log.exec.push({ sql, params }); if (/INSERT INTO user_dingtalk_profiles/.test(sql)) log.order.push(`upsert:${params[0]}`); },
  };
  return {
    log,
    async get(sql) {
      assert.match(sql, /user_dingtalk_profiles/);
      return existing;
    },
    async all() { return activeProfiles.map((userid) => ({ userid })); },
    async run(sql, params) { log.run.push({ sql, params }); if (/SET active = 0/.test(sql)) log.order.push(`leave:${params[0]}`); },
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

test('慢的资料修改不会覆盖随后到达的离职（先到的修改被后到的离职取代）', async () => {
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
      // 修改在取部门名称期间离职事件到达：修改的快照已过期不再写库，最终只有停用
      assert.deepEqual(db.log.order, ['leave:race1']);
    },
  );
});

test('全量同步采集期间被事件更新过的员工，同步快照不会覆盖（如离职后恢复在职）', async () => {
  clearUserProfileCache();
  const db = makeDb();
  const upsertedIds = [];
  const origExec = db.log.exec;
  await withFetchStub(
    async (url) => {
      if (url.includes('/gettoken')) return { errcode: 0, access_token: 't', expires_in: 7200 };
      if (url.includes('/department/listsub')) return { errcode: 0, result: [] };
      if (url.includes('/user/list')) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          errcode: 0,
          result: {
            has_more: false,
            list: [
              { userid: 'fs1', name: '甲', active: true, dept_id_list: [1] },
              { userid: 'fs2', name: '乙', active: true, dept_id_list: [1] },
            ],
          },
        };
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      const sync = syncAllDingtalkUsers(db, cfg);
      await new Promise((resolve) => setTimeout(resolve, 30));
      // 全量同步已开始采集，此时 fs1 离职事件先到达并写库
      await handleContactUserEvent(db, cfg, { topic: 'user_leave_org', data: { UserId: ['fs1'] } });
      const result = await sync;
      for (const call of origExec) {
        if (/INSERT INTO user_dingtalk_profiles/.test(call.sql)) upsertedIds.push(call.params[0]);
      }
      assert.deepEqual(upsertedIds, ['fs2']);
      assert.equal(result.upserted, 1);
      assert.equal(db.log.run.filter((c) => /SET active = 0/.test(c.sql)).length, 1);
    },
  );
});

test('缓存失效后，进行中的旧请求不会再把变更前的资料写回缓存', async () => {
  clearUserProfileCache();
  const profileCfg = { dingtalk: { appKey: 'inflight-key', appSecret: 'inflight-secret' } };
  let userGetCalls = 0;
  await withFetchStub(
    async (url) => {
      if (url.includes('/gettoken')) return { errcode: 0, access_token: 't', expires_in: 7200 };
      userGetCalls += 1;
      const isFirst = userGetCalls === 1;
      if (isFirst) await new Promise((resolve) => setTimeout(resolve, 150));
      return { errcode: 0, result: { name: isFirst ? '旧名' : '新名', dept_id_list: [1] } };
    },
    async () => {
      const first = getUserProfile(profileCfg, 'inv1');
      await new Promise((resolve) => setTimeout(resolve, 30));
      invalidateUserProfileCache('inv1');
      assert.equal((await first).name, '旧名');
      // 旧请求返回后不得留在缓存里：下一次读取必须重新请求并拿到新资料
      assert.equal((await getUserProfile(profileCfg, 'inv1')).name, '新名');
      assert.equal(userGetCalls, 2);
    },
  );
  clearUserProfileCache();
});

test('重叠的全量同步：后开始的同步先结束，也不会让先开始的旧快照恢复已离职员工', async () => {
  clearUserProfileCache();
  const db = makeDb();
  let listCalls = 0;
  await withFetchStub(
    async (url) => {
      if (url.includes('/gettoken')) return { errcode: 0, access_token: 't', expires_in: 7200 };
      if (url.includes('/department/listsub')) return { errcode: 0, result: [] };
      if (url.includes('/user/list')) {
        listCalls += 1;
        if (listCalls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { errcode: 0, result: { has_more: false, list: [{ userid: 'ov1', name: '丙', active: true, dept_id_list: [1] }] } };
        }
        // 第二次同步开始时该员工已离职，钉钉列表里不再包含
        return { errcode: 0, result: { has_more: false, list: [] } };
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      const syncA = syncAllDingtalkUsers(db, cfg);
      await new Promise((resolve) => setTimeout(resolve, 60));
      await handleContactUserEvent(db, cfg, { topic: 'user_leave_org', data: { UserId: ['ov1'] } });
      const syncB = syncAllDingtalkUsers(db, cfg);
      await syncB;
      await syncA;
      assert.equal(db.log.order.filter((x) => x === 'upsert:ov1').length, 0);
      assert.deepEqual(db.log.order, ['leave:ov1']);
    },
  );
});

test('首次写入前到达的离职：更早取到的在职资料不会再插入本地库', async () => {
  clearUserProfileCache();
  const db = makeDb();
  const tbCfg = { dingtalk: { appKey: 'tomb-key', appSecret: 'tomb-secret' } };
  let userGetCalls = 0;
  await withFetchStub(
    async (url) => {
      if (url.includes('/gettoken')) return { errcode: 0, access_token: 't', expires_in: 7200 };
      userGetCalls += 1;
      if (userGetCalls === 1) await new Promise((resolve) => setTimeout(resolve, 150));
      return { errcode: 0, result: { userid: 'tb1', name: '丁', active: true, dept_id_list: [1] } };
    },
    async () => {
      // 模拟新人首次登录：先记版本再取资料，取数进行中离职事件到达（此时库里还没有该员工的资料行）
      const snapshotVersion = beginUserSnapshot();
      const lookup = getUserProfile(tbCfg, 'tb1');
      await new Promise((resolve) => setTimeout(resolve, 40));
      await handleContactUserEvent(db, tbCfg, { topic: 'user_leave_org', data: { UserId: ['tb1'] } });
      const profile = await lookup;
      const out = await persistDingtalkUserDetail(db, tbCfg, profile.raw, { onlyIfStale: true, snapshotVersion });
      assert.equal(out.reason, 'superseded');
      assert.equal(upsertOf(db), undefined);
      // 离职同时作废了缓存和进行中的请求，之后重新读取会重新请求钉钉
      await getUserProfile(tbCfg, 'tb1');
      assert.equal(userGetCalls, 2);
    },
  );
  clearUserProfileCache();
});

test('批量离职事件按到达顺序入队：后到的重新入职不会被同批里慢的员工拖到前面', async () => {
  clearUserProfileCache();
  const db = makeDb();
  await withFetchStub(
    async (url, body) => {
      if (url.includes('/gettoken')) return { errcode: 0, access_token: 't', expires_in: 7200 };
      if (url.includes('/user/get')) {
        if (body.userid === 'ba') await new Promise((resolve) => setTimeout(resolve, 200));
        return { errcode: 0, result: { userid: body.userid, name: body.userid, active: true, dept_id_list: [1] } };
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      // ba 有一个进行中的慢修改，占住它的队列
      const busy = handleContactUserEvent(db, cfg, { topic: 'user_modify_org', data: { UserId: ['ba'] } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      // 离职批次 [ba, bb]：ba 排在慢修改之后，bb 应立即入队处理；随后 bb 重新入职
      const leaving = handleContactUserEvent(db, cfg, { topic: 'user_leave_org', data: { UserId: ['ba', 'bb'] } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const rejoin = handleContactUserEvent(db, cfg, { topic: 'user_add_org', data: { UserId: ['bb'] } });
      await Promise.all([busy, leaving, rejoin]);
      const bbOrder = db.log.order.filter((x) => x.endsWith(':bb'));
      assert.deepEqual(bbOrder, ['leave:bb', 'upsert:bb']);
    },
  );
});

test('全量同步：采集期间登录刷新写入了更新的资料，旧快照不会覆盖它', async () => {
  clearUserProfileCache();
  const db = makeDb();
  await withFetchStub(
    async (url) => {
      if (url.includes('/gettoken')) return { errcode: 0, access_token: 't', expires_in: 7200 };
      if (url.includes('/department/listsub')) return { errcode: 0, result: [] };
      if (url.includes('/department/get')) return { errcode: 0, result: { name: '新部门' } };
      if (url.includes('/user/list')) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { errcode: 0, result: { has_more: false, list: [{ userid: 'ls1', name: '戊', active: true, dept_id_list: [1] }] } };
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      const sync = syncAllDingtalkUsers(db, cfg);
      await new Promise((resolve) => setTimeout(resolve, 40));
      // 同步采集期间，该员工登录刷新，写入了调动后的新部门（对应的通讯录事件被漏掉了）
      const snapshotVersion = beginUserSnapshot();
      await persistDingtalkUserDetail(db, cfg, { userid: 'ls1', name: '戊', active: true, dept_id_list: [1, 7] }, { snapshotVersion });
      const result = await sync;
      assert.deepEqual(db.log.order, ['upsert:ls1']);
      assert.equal(result.upserted, 0);
    },
  );
});

test('全量同步兜底：把钉钉列表里已不存在的员工标记停用；列表为空时不处理', async () => {
  clearUserProfileCache();
  const db = makeDb({ activeProfiles: ['gone1', 'stay1'] });
  await withFetchStub(
    async (url) => {
      if (url.includes('/gettoken')) return { errcode: 0, access_token: 't', expires_in: 7200 };
      if (url.includes('/department/listsub')) return { errcode: 0, result: [] };
      if (url.includes('/user/list')) {
        return { errcode: 0, result: { has_more: false, list: [{ userid: 'stay1', name: '己', active: true, dept_id_list: [1] }] } };
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      const result = await syncAllDingtalkUsers(db, cfg);
      assert.equal(result.deactivated, 1);
      assert.deepEqual(db.log.order.filter((x) => x.startsWith('leave:')), ['leave:gone1']);
    },
  );

  const emptyDb = makeDb({ activeProfiles: ['gone1'] });
  await withFetchStub(
    async (url) => {
      if (url.includes('/gettoken')) return { errcode: 0, access_token: 't', expires_in: 7200 };
      if (url.includes('/department/listsub')) return { errcode: 0, result: [] };
      return { errcode: 0, result: { has_more: false, list: [] } };
    },
    async () => {
      const result = await syncAllDingtalkUsers(emptyDb, cfg);
      assert.equal(result.deactivated, 0);
      assert.equal(emptyDb.log.run.length, 0);
    },
  );
});
