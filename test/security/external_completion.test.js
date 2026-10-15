import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { adminRouter } from '../../src/routes/admin/index.js';
import { registerAdminSettingsRoutes } from '../../src/routes/admin/settingsRoutes.js';
import { matchPathPermission } from '../../src/services/adminPermissionService.js';
import { webRouter } from '../../src/routes/web.js';
import { mallRouter } from '../../src/routes/mall.js';
import { ledgerRouter } from '../../src/routes/ledger.js';
import { createWebSessionToken } from '../../src/services/webSession.js';
import { transferBob } from '../../src/services/ledgerService.js';
import { EXTERNAL_NOTIFY_SKIPPED, sendOrQueueNotify } from '../../src/services/notifyOpsService.js';
import {
  authenticateExternalAccount,
  ExternalAuthError,
  getExternalUserids,
  hashPassword,
  isExternalUser,
  resetExternalAccountPassword,
  setExternalAccountStatus,
} from '../../src/services/externalAccountService.js';

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** 从 Router 里取出最终业务 handler（跳过鉴权中间件）。 */
function findHandler(router, method, path) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `未找到路由 ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1).handle;
}

/** 按 SQL 片段分派的假库：users 来源表 + 转账需要的最小账户表。 */
function createLedgerDb(users, balances = {}) {
  const state = { users: new Map(Object.entries(users)), balances: { ...balances }, ledger: [] };
  const db = {
    state,
    __txScoped: true,
    async get(sql, params = []) {
      if (sql.includes('SELECT userid FROM users')) return state.users.has(params[0]) ? { userid: params[0] } : null;
      if (sql.includes('SELECT balance FROM accounts')) return { balance: state.balances[params[0]] ?? 0 };
      return null;
    },
    async all(sql, params = []) {
      if (sql.includes('FROM users WHERE userid IN')) {
        return params.filter((id) => state.users.has(id)).map((id) => ({ userid: id, source: state.users.get(id) }));
      }
      return [];
    },
    async run(sql, params = []) {
      if (sql.startsWith('INSERT INTO ledger')) state.ledger.push(params);
      if (sql.includes('SET balance = balance - ?')) state.balances[params[1]] = (state.balances[params[1]] ?? 0) - params[0];
      if (sql.includes('SET balance = balance + ?')) state.balances[params[1]] = (state.balances[params[1]] ?? 0) + params[0];
      return { changes: 1 };
    },
    async exec() {},
    async transaction(fn) { return await fn(db); },
  };
  return db;
}

test('转账：外部账号与钉钉员工之间双向拒绝，同来源之间放行', async () => {
  const users = { emp_a: 'dingtalk', emp_b: 'dingtalk', ext_a: 'external', ext_b: 'external' };
  const balances = { emp_a: 100, emp_b: 100, ext_a: 100, ext_b: 100 };

  for (const [from, to] of [['emp_a', 'ext_a'], ['ext_a', 'emp_a']]) {
    const db = createLedgerDb(users, balances);
    await assert.rejects(
      () => transferBob(db, { fromUserid: from, toUserid: to, amount: 10, refId: 'T1' }),
      /transfer_not_allowed_between_sources/,
    );
    assert.equal(db.state.ledger.length, 0, '被拒绝的转账不得写流水');
    assert.equal(db.state.balances[from], 100, '被拒绝的转账不得动余额');
  }

  for (const [from, to] of [['ext_a', 'ext_b'], ['emp_a', 'emp_b']]) {
    const db = createLedgerDb(users, balances);
    const result = await transferBob(db, { fromUserid: from, toUserid: to, amount: 30, refId: 'T2' });
    assert.equal(result.fromBalance, 70);
    assert.equal(result.toBalance, 130);
  }
});

test('转账接口把跨来源拒绝映射为 403', async (t) => {
  const users = { emp_a: 'dingtalk', ext_a: 'external' };
  const db = createLedgerDb(users, { emp_a: 100, ext_a: 100 });
  const rawGet = db.get;
  db.get = async (sql, params = []) => {
    if (sql.includes('FROM system_settings')) return null;
    if (sql.includes('FROM users u') && sql.includes('LEFT JOIN external_accounts')) {
      const source = users[params[0]];
      return source ? { source, external_status: source === 'external' ? 'active' : null } : null;
    }
    return rawGet(sql, params);
  };
  const cfg = { webSessionSecret: 'transfer-source-test', sessionGlobalVersion: 0 };
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.locals.cfg = cfg;
  app.use('/ledger', ledgerRouter());
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const cookie = `bob_web_session=${createWebSessionToken(cfg.webSessionSecret, { userid: 'ext_a', sv: 0 }, 3600)}`;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/ledger/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ to_userid: 'emp_a', amount: 5 }),
  });
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error, 'transfer_not_allowed_between_sources');
});

test('来源判断以 users.source 为准，批量版只返回外部账号', async () => {
  const db = {
    async get(sql, params) {
      assert.match(sql, /SELECT source FROM users/);
      return { ext_x: { source: 'external' }, ext_looks_like: { source: 'dingtalk' } }[params[0]] || null;
    },
    async all(sql, params) {
      assert.match(sql, /source = \?/);
      return params[1].filter((id) => id === 'ext_x').map((userid) => ({ userid }));
    },
  };
  assert.equal(await isExternalUser(db, 'ext_x'), true);
  assert.equal(await isExternalUser(db, 'ext_looks_like'), false, 'ext_ 前缀的钉钉员工不是外部账号');
  assert.equal(await isExternalUser(db, 'missing'), false);
  assert.equal(await isExternalUser(db, ''), false);
  assert.deepEqual([...await getExternalUserids(db, ['ext_x', 'ext_looks_like', 'ext_x'])], ['ext_x']);
  assert.equal((await getExternalUserids(db, [])).size, 0);
});

test('私聊通知对外部账号直接跳过，不读通知配置也不入队', async () => {
  const queries = [];
  const db = {
    async get(sql, params) {
      queries.push(sql);
      if (sql.includes('SELECT source FROM users')) return { source: params[0] === 'ext_x' ? 'external' : 'dingtalk' };
      if (sql.includes('FROM system_settings')) return { value: JSON.stringify({ enabled: false }) };
      return null;
    },
  };
  const result = await sendOrQueueNotify({ db, cfg: {}, userid: 'ext_x', title: 't', lines: ['l'], awaitNotify: true, event: 'transfer_in' });
  assert.deepEqual(result, { ok: false, skipped: true, error: EXTERNAL_NOTIFY_SKIPPED });
  assert.equal(queries.some((sql) => sql.includes('system_settings')), false, '外部账号不应继续走通知流程');

  // 钉钉员工不受影响：继续走原有流程（此处通知总开关关闭，返回 notify_disabled）。
  const employee = await sendOrQueueNotify({ db, cfg: {}, userid: 'emp', title: 't', lines: ['l'], awaitNotify: true });
  assert.equal(employee.error, 'notify_disabled');
});

function createCredentialDb(initial) {
  const state = { account: { ...initial } };
  return {
    state,
    async run(sql, params) {
      if (sql.includes('SET password_hash')) {
        if (params[2] !== state.account.userid) return { changes: 0 };
        Object.assign(state.account, { password_hash: params[0], password_salt: params[1], failed_count: 0, locked_until: null });
        return { changes: 1 };
      }
      if (sql.includes('SET status = ?')) {
        if (params[1] !== state.account.userid) return { changes: 0 };
        Object.assign(state.account, { status: params[0], failed_count: 0, locked_until: null });
        return { changes: 1 };
      }
      if (sql.includes('last_login_at')) return { changes: 1 };
      return { changes: 0 };
    },
    async get(sql) {
      if (sql.includes('FROM external_accounts')) return state.account;
      return null;
    },
  };
}

test('后台重置密码：新密码可登录、旧密码失效，并清掉失败锁定', async () => {
  const old = await hashPassword('old-pass');
  const db = createCredentialDb({
    userid: 'ext_reset', phone: '13800000011', name: '重置', status: 'active',
    password_hash: old.hash, password_salt: old.salt,
    failed_count: 3, locked_until: Math.floor(Date.now() / 1000) + 600,
  });
  await assert.rejects(
    () => authenticateExternalAccount(db, { phone: '13800000011', password: 'old-pass' }),
    (err) => err.code === 'account_locked',
  );

  await resetExternalAccountPassword(db, { userid: 'ext_reset', password: 'new-pass' });
  assert.equal(db.state.account.failed_count, 0);
  assert.equal(db.state.account.locked_until, null);
  assert.equal((await authenticateExternalAccount(db, { phone: '13800000011', password: 'new-pass' })).userid, 'ext_reset');
  await assert.rejects(
    () => authenticateExternalAccount(db, { phone: '13800000011', password: 'old-pass' }),
    (err) => err.code === 'invalid_credentials',
  );
  assert.ok(!db.state.account.password_hash.includes('new-pass'), '不得明文落库');
});

test('后台重置密码与启停：拒绝弱密码、非法状态与非外部账号', async () => {
  const db = createCredentialDb({ userid: 'ext_a', status: 'active' });
  await assert.rejects(() => resetExternalAccountPassword(db, { userid: 'ext_a', password: '12' }), (err) => err.code === 'weak_password');
  await assert.rejects(() => resetExternalAccountPassword(db, { userid: 'dingtalk_user', password: '123' }), (err) => err.code === 'not_external_account');
  await assert.rejects(() => resetExternalAccountPassword(db, { userid: '', password: '123' }), (err) => err.code === 'not_external_account');
  await assert.rejects(() => setExternalAccountStatus(db, { userid: 'ext_a', status: 'banned' }), (err) => err.code === 'invalid_status');
  await assert.rejects(() => setExternalAccountStatus(db, { userid: 'dingtalk_user', status: 'disabled' }), (err) => err.code === 'not_external_account');

  await setExternalAccountStatus(db, { userid: 'ext_a', status: 'disabled' });
  assert.equal(db.state.account.status, 'disabled');
  await setExternalAccountStatus(db, { userid: 'ext_a', status: 'active' });
  assert.equal(db.state.account.status, 'active');
});

test('禁用的外部账号无法登录', async () => {
  const credentials = await hashPassword('123');
  const db = createCredentialDb({
    userid: 'ext_off', phone: '13800000012', name: '停用', status: 'active',
    password_hash: credentials.hash, password_salt: credentials.salt, failed_count: 0, locked_until: null,
  });
  await setExternalAccountStatus(db, { userid: 'ext_off', status: 'disabled' });
  await assert.rejects(
    () => authenticateExternalAccount(db, { phone: '13800000012', password: '123' }),
    (err) => err instanceof ExternalAuthError && err.code === 'account_disabled',
  );
});

test('后台重置密码/启停路由：审计只记目标账号不含密码，错误码映射正确', async () => {
  const handlers = {};
  registerAdminSettingsRoutes({
    get() {},
    post(path, ...rest) { handlers[path] = rest.at(-1); },
  });
  const credentials = await hashPassword('x');
  const db = createCredentialDb({ userid: 'ext_route', status: 'active', password_hash: credentials.hash, password_salt: credentials.salt });
  const call = async (path, body) => {
    const req = { body, app: { locals: { db } } };
    const res = createResponse();
    await handlers[path](req, res);
    return { req, res };
  };

  const ok = await call('/users/external/reset-password', { userid: 'ext_route', password: 'secret-pass' });
  assert.equal(ok.res.statusCode, 200);
  assert.deepEqual(ok.req.auditLogPayload, { userid: 'ext_route' });
  assert.equal(JSON.stringify(ok.req.auditLogPayload).includes('secret-pass'), false);

  assert.equal((await call('/users/external/reset-password', { userid: 'ext_route', password: '1' })).res.statusCode, 400);
  assert.equal((await call('/users/external/reset-password', { userid: 'someone_else', password: '123' })).res.statusCode, 404);
  assert.equal((await call('/users/external/set-status', { userid: 'ext_route', status: 'nope' })).res.statusCode, 400);
  assert.equal((await call('/users/external/set-status', { userid: 'someone_else', status: 'disabled' })).res.statusCode, 404);
  const disabled = await call('/users/external/set-status', { userid: 'ext_route', status: 'disabled' });
  assert.equal(disabled.res.statusCode, 200);
  assert.equal(disabled.res.body.data.status, 'disabled');
});

test('后台批量发消息：外部账号被跳过且不算失败，不请求钉钉', async () => {
  const handler = findHandler(adminRouter(), 'post', '/users/notify');
  const db = {
    async all(sql, params) {
      assert.match(sql, /source = \?/);
      return params[1].filter((id) => id.startsWith('ext_')).map((userid) => ({ userid }));
    },
  };
  const res = createResponse();
  await handler({
    body: { userids: ['ext_one', 'ext_two'], title: '通知', content: '内容' },
    app: { locals: { db, cfg: {} } },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.count, 2);
  assert.equal(res.body.skipped_count, 2);
  assert.equal(res.body.failed_count, 0);
  assert.equal(res.body.success_count, 0);
  assert.ok(res.body.results.every((r) => r.skipped === true && r.error === EXTERNAL_NOTIFY_SKIPPED));
});

test('外部账号不能被设为管理员或分配后台角色，但允许撤销', async () => {
  const router = adminRouter();
  const setAdmin = findHandler(router, 'post', '/users/set-admin');
  const assignRole = findHandler(router, 'post', '/users/assign-role');
  const cfg = { adminUserids: [] };

  const externalDb = { async get() { return { source: 'external' }; } };
  const grant = createResponse();
  await setAdmin({ body: { userid: 'ext_x', isAdmin: true }, app: { locals: { db: externalDb, cfg } } }, grant);
  assert.equal(grant.statusCode, 400);
  assert.match(grant.body.error, /外部活动账号/);

  const roleCalls = [];
  const txDb = {
    async transaction(fn) {
      return await fn({
        async exec() {},
        async get(sql) {
          if (sql.includes('FROM users')) return { userid: 'ext_x', source: 'external' };
          return { id: 1, is_enabled: 1 };
        },
        async run(sql, params) { roleCalls.push({ sql, params }); return { changes: 1 }; },
      });
    },
  };
  const assign = createResponse();
  await assignRole({ body: { userid: 'ext_x', roleId: 1 }, adminSession: { userid: 'boss' }, app: { locals: { db: txDb, cfg } } }, assign);
  assert.match(String(assign.body.error), /外部活动账号不能分配后台角色/);
  assert.equal(roleCalls.length, 0, '被拒绝时不得写入任何角色');

  // 取消角色（roleId 为空）仍然允许，用于清理历史上误挂的角色。
  const revoke = createResponse();
  await assignRole({ body: { userid: 'ext_x', roleId: null }, adminSession: { userid: 'boss' }, app: { locals: { db: txDb, cfg } } }, revoke);
  assert.equal(revoke.body?.ok, true);
  assert.ok(roleCalls.some((c) => c.sql.includes('DELETE FROM admin_user_roles')));
});

test('后台用户详情返回来源、手机号与外部账号信息', async () => {
  const handler = findHandler(adminRouter(), 'get', '/users/:userid');
  const seen = [];
  const db = {
    async get(sql) {
      seen.push(sql);
      if (sql.includes('SELECT userid FROM users')) return { userid: 'ext_d' };
      if (sql.includes('FROM users u')) {
        return { userid: 'ext_d', name: '外部', is_admin: 0, balance: 5, source: 'external', phone: '13800000013' };
      }
      if (sql.includes('FROM external_accounts')) return { batch_id: '活动A', status: 'disabled', last_login_at: 1700000000 };
      return null;
    },
    async all() { return []; },
    async run() { return { changes: 0 }; },
  };
  const res = createResponse();
  await handler({ params: { userid: 'ext_d' }, app: { locals: { db, cfg: { adminUserids: [] } } } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.user.source, 'external');
  assert.equal(res.body.data.user.phone, '13800000013');
  assert.deepEqual(res.body.data.user.external, { batch_id: '活动A', status: 'disabled', last_login_at: 1700000000 });
  assert.equal(res.body.data.dingtalk, null);

  const employeeDb = {
    async get(sql) {
      if (sql.includes('SELECT userid FROM users')) return { userid: 'emp' };
      if (sql.includes('FROM users u')) return { userid: 'emp', name: '员工', is_admin: 0, balance: 0, source: 'dingtalk', phone: '' };
      assert.equal(sql.includes('FROM external_accounts'), false, '钉钉员工不查外部账号表');
      return null;
    },
    async all() { return []; },
    async run() { return { changes: 0 }; },
  };
  const employee = createResponse();
  await handler({ params: { userid: 'emp' }, app: { locals: { db: employeeDb, cfg: { adminUserids: [] } } } }, employee);
  assert.equal(employee.body.data.user.external, null);
});

async function startApp(t, { users, session, onAll }) {
  const cfg = { webSessionSecret: 'external-completion-test', sessionGlobalVersion: 0 };
  const db = {
    async get(sql, params = []) {
      if (sql.includes('FROM system_settings')) return null;
      if (sql.includes('FROM users u') && sql.includes('LEFT JOIN external_accounts')) {
        const source = users[params[0]];
        return source ? { source, external_status: source === 'external' ? 'active' : null } : null;
      }
      if (sql.includes('SELECT source FROM users')) {
        const source = users[params[0]];
        return source ? { source } : null;
      }
      return null;
    },
    async all(sql, params = []) {
      onAll?.(sql, params);
      return [];
    },
  };
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.locals.cfg = cfg;
  app.use('/web', webRouter());
  app.use('/mall', mallRouter());
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const cookie = `bob_web_session=${createWebSessionToken(cfg.webSessionSecret, { userid: session, sv: 0 }, 3600)}`;
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async (path) => {
      const response = await fetch(base + path, { headers: { Cookie: cookie } });
      return { status: response.status, body: await response.json() };
    },
    post: async (path) => {
      const response = await fetch(base + path, { method: 'POST', headers: { Cookie: cookie } });
      return { status: response.status, body: await response.json(), setCookie: response.headers.get('set-cookie') };
    },
  };
}

test('/web/me 返回会话来源，POST /web/logout 清除会话 Cookie', async (t) => {
  const users = { ext_me: 'external', emp_me: 'dingtalk' };
  const external = await startApp(t, { users, session: 'ext_me' });
  assert.equal((await external.get('/web/me')).body.source, 'external');
  const employee = await startApp(t, { users, session: 'emp_me' });
  assert.equal((await employee.get('/web/me')).body.source, 'dingtalk');

  const logout = await external.post('/web/logout');
  assert.equal(logout.status, 200);
  assert.match(logout.setCookie, /bob_web_session=;/);
  assert.match(logout.setCookie, /Max-Age=0/);
});

test('转账搜索按会话来源对称隔离：外部只搜外部，员工只搜员工', async (t) => {
  const users = { ext_s: 'external', emp_s: 'dingtalk' };
  for (const [session, expectedExternal] of [['ext_s', true], ['emp_s', false]]) {
    let params;
    const app = await startApp(t, {
      users,
      session,
      onAll: (sql, p) => { if (sql.includes('FROM users u')) params = p; },
    });
    const response = await app.get('/mall/users?keyword=张');
    assert.equal(response.status, 200);
    assert.equal(params[2], expectedExternal, `${session} 的来源过滤参数`);
  }
});

test('外部用户的富豪榜为空，且不查询员工资产', async (t) => {
  const users = { ext_r: 'external', emp_r: 'dingtalk' };
  let boardQueried = false;
  const external = await startApp(t, { users, session: 'ext_r', onAll: (sql) => { if (sql.includes('FROM accounts a')) boardQueried = true; } });
  const empty = await external.get('/mall/rich-board');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data, []);
  assert.equal(boardQueried, false);

  const employee = await startApp(t, { users, session: 'emp_r', onAll: (sql) => { if (sql.includes('FROM accounts a')) boardQueried = true; } });
  await employee.get('/mall/rich-board');
  assert.equal(boardQueried, true, '员工仍可看到富豪榜');
});

test('后台用户列表关键字同时匹配手机号', async () => {
  const handler = findHandler(adminRouter(), 'get', '/users');
  const queries = [];
  const db = {
    async get(sql, params) { queries.push({ sql, params }); return { c: 0 }; },
    async all(sql, params) { queries.push({ sql, params }); return []; },
  };
  const res = createResponse();
  await handler({ query: { keyword: '1380000', page: '1', pageSize: '20' }, app: { locals: { db } } }, res);
  assert.equal(res.statusCode, 200);
  const count = queries.find((q) => q.sql.includes('COUNT(1)'));
  assert.match(count.sql, /COALESCE\(u\.phone, ''\) LIKE \?/);
  assert.ok(count.params.filter((p) => p === '%1380000%').length >= 3, '手机号参与 LIKE 匹配');
});

test('外部账号运维接口权限精确匹配，不误伤以 external 开头的 userid 详情', () => {
  for (const path of ['/users/external/reset-password', '/users/external/set-status', '/users/external/reset-password/']) {
    assert.equal(matchPathPermission('POST', path), 'users:edit', path);
  }
  // 详情 GET 仍只需查看权限，哪怕 userid 以 external 开头。
  for (const path of ['/users/external_partner', '/users/external', '/users/external/']) {
    assert.equal(matchPathPermission('GET', path), 'users:view', path);
  }
});
