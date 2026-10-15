import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { createWebSessionToken, verifyWebSessionToken } from '../../src/services/webSession.js';
import { webRouter } from '../../src/routes/web.js';
import { mallRouter } from '../../src/routes/mall.js';
import { ledgerRouter } from '../../src/routes/ledger.js';
import { redeemRouter } from '../../src/routes/redeem.js';
import { ensureAccount, getBalance, grantBob } from '../../src/services/ledgerService.js';
import { grantWithNotify, grantBatchWithNotify } from '../../src/services/bobOpsService.js';
import { registerAdminSettingsRoutes } from '../../src/routes/admin/settingsRoutes.js';

import {
  authenticateExternalAccount,
  ExternalAuthError,
  generateExternalUserid,
  hashPassword,
  isExternalUserid,
  isValidPassword,
  isValidRealName,
  LOCK_DURATION_SECONDS,
  MAX_FAILED_ATTEMPTS,
  normalizePhone,
  normalizeRealName,
  registerExternalAccount,
  verifyPasswordHash,
} from '../../src/services/externalAccountService.js';

const webRoutesSource = readFileSync(
  fileURLToPath(new URL('../../src/routes/web.js', import.meta.url)),
  'utf8',
);
const mallRoutesSource = readFileSync(
  fileURLToPath(new URL('../../src/routes/mall.js', import.meta.url)),
  'utf8',
);
const mallAssetSource = readFileSync(
  fileURLToPath(new URL('../../src/pages/assets/mall.js', import.meta.url)),
  'utf8',
);
const appSource = readFileSync(
  fileURLToPath(new URL('../../src/app.js', import.meta.url)),
  'utf8',
);
const loginAssetSource = readFileSync(
  fileURLToPath(new URL('../../src/pages/assets/login.js', import.meta.url)),
  'utf8',
);
const backupRoutesSource = readFileSync(
  fileURLToPath(new URL('../../src/routes/admin/backupRoutes.js', import.meta.url)),
  'utf8',
);
const userSyncSource = readFileSync(
  fileURLToPath(new URL('../../src/services/dingtalkUserSyncService.js', import.meta.url)),
  'utf8',
);

/** 最小化假库：按 SQL 片段分派，覆盖服务层的读写分支。 */
function createFakeDb({ account = null, dingtalkUser = null, userByPhone = null } = {}) {
  const state = {
    account: account ? { failed_count: 0, locked_until: null, status: 'active', ...account } : null,
    dingtalkUser,
    userByPhone,
    users: new Map(account ? [[account.userid, { source: 'external' }]] : []),
    sessionVersion: 0,
    externalLoginSettings: { enabled: true, batch_id: '活动A' },
    inserts: [],
    updates: [],
    queries: [],
    failureUpdates: [],
  };

  const db = {
    state,
    async get(sql, params = []) {
      state.queries.push({ sql, params });
      // 原子失败计数（UPDATE ... RETURNING）：模拟数据库按行自增，
      // 用于验证并发错误尝试不会丢计数。
      if (sql.includes('UPDATE external_accounts')) {
        state.failureUpdates.push(params);
        const threshold = Number(params[0]);
        const lockUntil = Number(params[2]);
        const next = Number(state.account.failed_count || 0) + 1;
        if (next >= threshold) {
          state.account.failed_count = 0;
          state.account.locked_until = lockUntil;
        } else {
          state.account.failed_count = next;
        }
        return { locked_until: state.account.locked_until };
      }
      if (sql.includes('FROM system_settings')) {
        if (params[0] === 'session_global_version') return { value: String(state.sessionVersion) };
        if (params[0] === 'external_login_settings' && state.externalLoginSettings) {
          return { value: JSON.stringify(state.externalLoginSettings) };
        }
        return null;
      }
      if (sql.includes('FROM users u') && sql.includes('LEFT JOIN external_accounts')) {
        const user = state.users.get(params[0]);
        if (!user) return null;
        return { ...user, external_status: state.account?.userid === params[0] ? state.account.status : null };
      }
      if (sql.includes('FROM user_dingtalk_profiles')) return dingtalkUser;
      if (sql.includes('FROM external_accounts')) return state.account;
      if (sql.includes('FROM users WHERE phone')) return userByPhone;
      if (sql.includes('SELECT userid FROM users')) return state.users.has(params[0]) ? { userid: params[0] } : null;
      return null;
    },
    async run(sql, params = []) {
      state.updates.push({ sql, params });
      if (sql.includes('UPDATE external_accounts') && sql.includes('failed_count = 0')) {
        state.account.failed_count = 0;
        state.account.locked_until = null;
      }
      if (sql.startsWith('INSERT INTO')) state.inserts.push({ sql, params });
      if (sql.startsWith('INSERT INTO users')) state.users.set(params[0], { source: params[2] });
      if (sql.startsWith('INSERT INTO external_accounts')) {
        state.account = {
          userid: params[0], phone: params[1], name: params[2],
          password_hash: params[3], password_salt: params[4], batch_id: params[5],
          status: 'active', failed_count: 0, locked_until: null,
        };
      }
      return { changes: 1, lastID: 1 };
    },
    async all() {
      return [];
    },
    async exec(sql, params = []) { state.queries.push({ sql, params }); },
    async transaction(fn) {
      return await fn(db);
    },
  };
  return db;
}

async function createAccountRow(overrides = {}) {
  const credentials = await hashPassword('123456');
  return {
    userid: 'ext_abc123',
    phone: '13800000000',
    name: '张三',
    password_hash: credentials.hash,
    password_salt: credentials.salt,
    status: 'active',
    failed_count: 0,
    locked_until: null,
    ...overrides,
  };
}

function assertAuthError(err, code) {
  assert.ok(err instanceof ExternalAuthError, `期望 ExternalAuthError，实际 ${err}`);
  assert.equal(err.code, code);
}

test('手机号归一化：容忍 +86、空格、连字符，拒绝非法号码', () => {
  assert.equal(normalizePhone('13800000000'), '13800000000');
  assert.equal(normalizePhone(' 138 0000 0000 '), '13800000000');
  assert.equal(normalizePhone('+8613800000000'), '13800000000');
  assert.equal(normalizePhone('138-0000-0000'), '13800000000');

  for (const bad of ['', null, undefined, '1380000000', '12800000000', 'abc', '138000000000']) {
    assert.equal(normalizePhone(bad), '', `应拒绝：${String(bad)}`);
  }
});

test('姓名归一化与校验：中文与少数民族姓名合法，非法输入拒绝', () => {
  assert.equal(normalizeRealName('  张 三 '), '张 三');
  assert.equal(normalizeRealName('买买提·艾力'), '买买提·艾力');
  assert.equal(isValidRealName('张三'), true);
  assert.equal(isValidRealName('买买提·艾力'), true);
  assert.equal(isValidRealName('欧阳娜娜'), true);
  assert.equal(isValidRealName('Tom Lee'), true);

  assert.equal(isValidRealName('张'), false);
  assert.equal(isValidRealName('123'), false);
  assert.equal(isValidRealName('张三123'), false);
  assert.equal(isValidRealName('张'.repeat(21)), false);
});

test('密码允许弱口令但有长度边界', () => {
  assert.equal(isValidPassword('123'), true);
  assert.equal(isValidPassword('1'), false);
  assert.equal(isValidPassword('12'), false);
  assert.equal(isValidPassword('x'.repeat(64)), true);
  assert.equal(isValidPassword('x'.repeat(65)), false);
  assert.equal(isValidPassword(''), false);
});

test('密码使用 scrypt 加盐哈希，校验失败与篡改均返回 false', async () => {
  const credentials = await hashPassword('123');
  assert.match(credentials.hash, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.ok(!credentials.hash.includes('123'));

  const other = await hashPassword('123');
  assert.notEqual(other.salt, credentials.salt);
  assert.notEqual(other.hash, credentials.hash);

  assert.equal(await verifyPasswordHash('123', credentials), true);
  assert.equal(await verifyPasswordHash('124', credentials), false);
  assert.equal(await verifyPasswordHash('123', { hash: credentials.hash, salt: 'AAAA' }), false);
  assert.equal(await verifyPasswordHash('123', { hash: 'plain$1$2$3$abc', salt: credentials.salt }), false);
  assert.equal(await verifyPasswordHash('123', {}), false);
});

test('外部 userid 使用 ext_ 前缀且不重复', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) ids.add(generateExternalUserid());
  assert.equal(ids.size, 50);
  for (const id of ids) {
    assert.ok(isExternalUserid(id), id);
    assert.match(id, /^ext_[0-9a-f]{16}$/);
  }
  assert.equal(isExternalUserid('manager1234'), false);
});

test('注册命中钉钉在册员工时拒绝建号并提示改用钉钉登录', async () => {
  const db = createFakeDb({ dingtalkUser: { userid: 'manager1234', name: '李四' } });
  await assert.rejects(
    () => registerExternalAccount(db, { name: '李四', phone: '13800000000', password: '123' }),
    (err) => {
      assertAuthError(err, 'phone_is_dingtalk_user');
      return true;
    },
  );
  assert.equal(db.state.inserts.length, 0);
});

test('注册锁内复核开关与批次，关闭期间未提交的注册不会留号', async () => {
  for (const enabled of [false, true]) {
    const db = createFakeDb();
    let reachedTransaction;
    const reached = new Promise((resolve) => { reachedTransaction = resolve; });
    let release;
    const proceed = new Promise((resolve) => { release = resolve; });
    const originalExec = db.exec;
    db.exec = async (sql, params) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        reachedTransaction();
        await proceed;
      }
      return originalExec(sql, params);
    };
    const pending = registerExternalAccount(db, { name: '并发注册', phone: '13800000009', password: '123' });
    const result = pending.then((account) => ({ account }), (error) => ({ error }));
    await reached;
    db.state.externalLoginSettings = { enabled, batch_id: '新批次' };
    release();
    const outcome = await result;
    if (enabled) {
      assert.equal(outcome.account.batch_id, '新批次', '不能使用哈希前的旧批次');
    } else {
      assertAuthError(outcome.error, 'register_disabled');
      assert.equal(db.state.inserts.length, 0, '锁内关闭后不得写入账号');
    }
  }
});

test('注册写入 users/accounts/external_accounts 三张表，落库不含明文密码', async () => {
  const db = createFakeDb();
  const account = await registerExternalAccount(db, {
    name: ' 王五 ',
    phone: '+8613800000001',
    password: '123',
  });

  assert.ok(isExternalUserid(account.userid));
  assert.equal(account.name, '王五');
  assert.equal(account.phone, '13800000001');
  assert.equal(account.batch_id, '活动A');

  const tables = db.state.inserts.map((x) => x.sql.replace(/\s+/g, ' '));
  assert.equal(tables.length, 3);
  assert.ok(tables[0].includes('INSERT INTO users'));
  assert.ok(tables[1].includes('INSERT INTO accounts'));
  assert.ok(tables[2].includes('INSERT INTO external_accounts'));

  const usersParams = db.state.inserts[0].params;
  assert.equal(usersParams[0], account.userid);
  assert.equal(usersParams[1], '王五');
  assert.equal(usersParams[2], 'external');
  assert.equal(usersParams[3], '13800000001');

  const credentials = db.state.inserts[2].params;
  const hash = String(credentials[3]);
  const salt = String(credentials[4]);
  assert.match(hash, /^scrypt\$/);
  assert.ok(!hash.includes('123') || hash.split('$')[4] !== '123');
  assert.equal(await verifyPasswordHash('123', { hash, salt }), true);
});

test('注册拒绝重复手机号与非法参数', async () => {
  const existed = await createAccountRow();
  await assert.rejects(
    () => registerExternalAccount(createFakeDb({ account: existed }), {
      name: '张三', phone: '13800000000', password: '123',
    }),
    (err) => { assertAuthError(err, 'phone_registered'); return true; },
  );

  const db = createFakeDb();
  await assert.rejects(
    () => registerExternalAccount(db, { name: '张三', phone: '12345', password: '123' }),
    (err) => { assertAuthError(err, 'invalid_phone'); return true; },
  );
  await assert.rejects(
    () => registerExternalAccount(db, { name: '123', phone: '13800000000', password: '123' }),
    (err) => { assertAuthError(err, 'invalid_name'); return true; },
  );
  await assert.rejects(
    () => registerExternalAccount(db, { name: '张三', phone: '13800000000', password: '12' }),
    (err) => { assertAuthError(err, 'weak_password'); return true; },
  );
  assert.equal(db.state.inserts.length, 0);
});

test('登录成功清零失败计数并返回账号身份', async () => {
  const account = await createAccountRow({ failed_count: 3 });
  const db = createFakeDb({ account });
  const result = await authenticateExternalAccount(db, { phone: '13800000000', password: '123456' });
  assert.equal(result.userid, 'ext_abc123');
  assert.equal(result.name, '张三');
  assert.equal(db.state.account.failed_count, 0);
  assert.equal(db.state.account.locked_until, null);
});

test('连续密码错误触发锁定，锁定期内正确密码同样被拒', async () => {
  const account = await createAccountRow();
  const db = createFakeDb({ account });

  for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i += 1) {
    await assert.rejects(
      () => authenticateExternalAccount(db, { phone: '13800000000', password: 'wrong' }),
      (err) => { assertAuthError(err, 'invalid_credentials'); return true; },
    );
  }
  assert.equal(db.state.account.failed_count, MAX_FAILED_ATTEMPTS - 1);

  await assert.rejects(
    () => authenticateExternalAccount(db, { phone: '13800000000', password: 'wrong' }),
    (err) => {
      assertAuthError(err, 'account_locked');
      assert.equal(err.retry_after, LOCK_DURATION_SECONDS);
      return true;
    },
  );
  assert.ok(Number(db.state.account.locked_until) > 0);

  await assert.rejects(
    () => authenticateExternalAccount(db, { phone: '13800000000', password: '123456' }),
    (err) => { assertAuthError(err, 'account_locked'); return true; },
  );
});

test('并发错误密码同样会触发锁定（失败计数不丢更新）', async () => {
  const account = await createAccountRow();
  const db = createFakeDb({ account });

  const results = await Promise.all(Array.from({ length: 8 }, () => (
    authenticateExternalAccount(db, { phone: '13800000000', password: 'wrong' })
      .then(() => 'ok')
      .catch((err) => err.code)
  )));

  // 串行化 + 原子自增后结果确定：前 4 次是凭据错误，第 5 次触发锁定，其余都被锁定拦下。
  assert.equal(results.filter((code) => code === 'invalid_credentials').length, MAX_FAILED_ATTEMPTS - 1);
  assert.equal(results.filter((code) => code === 'account_locked').length, 8 - (MAX_FAILED_ATTEMPTS - 1));
  assert.ok(Number(db.state.account.locked_until) > 0, '并发尝试后账号应处于锁定状态');

  // 锁定期内即使密码正确也不放行
  await assert.rejects(
    () => authenticateExternalAccount(db, { phone: '13800000000', password: '123456' }),
    (err) => { assertAuthError(err, 'account_locked'); return true; },
  );
});

test('未注册手机号若属于钉钉员工则引导钉钉登录，否则统一提示凭据错误', async () => {
  await assert.rejects(
    () => authenticateExternalAccount(createFakeDb({ dingtalkUser: { userid: 'boss001' } }), {
      phone: '13800000000', password: '123',
    }),
    (err) => { assertAuthError(err, 'phone_is_dingtalk_user'); return true; },
  );

  await assert.rejects(
    () => authenticateExternalAccount(createFakeDb(), { phone: '13800000000', password: '123' }),
    (err) => { assertAuthError(err, 'invalid_credentials'); return true; },
  );
});

test('停用账号拒绝登录', async () => {
  const account = await createAccountRow({ status: 'disabled' });
  await assert.rejects(
    () => authenticateExternalAccount(createFakeDb({ account }), { phone: '13800000000', password: '123456' }),
    (err) => { assertAuthError(err, 'account_disabled'); return true; },
  );
});

test('外部旧 Cookie 在停用或清理后被所有会话入口拒绝，且不重建用户', async (t) => {
  const db = createFakeDb({ account: { userid: 'ext_session', status: 'active' } });
  const cfg = { webSessionSecret: 'external-session-test', sessionGlobalVersion: 0 };
  const app = express();
  app.locals.db = db;
  app.locals.cfg = cfg;
  app.use('/web', webRouter());
  app.use('/mall', mallRouter());
  app.use('/ledger', ledgerRouter());
  app.use('/redeem', redeemRouter());
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  // 与已签发的旧 Cookie 相同，不加新的来源/撤销字段。
  const cookie = `bob_web_session=${createWebSessionToken(cfg.webSessionSecret, { userid: 'ext_session', sv: 0 }, 604800)}`;
  const request = async (path, value = cookie) => {
    const response = await fetch(base + path, { headers: { Cookie: value } });
    await response.text();
    return response.status;
  };
  assert.equal(await request('/web/me'), 200);
  db.state.account.status = 'disabled';
  assert.equal(await request('/web/me'), 401);
  db.state.account.status = 'active';
  db.state.users.set('ext_session', { source: 'unknown' });
  assert.equal(await request('/web/me'), 401);
  db.state.users.delete('ext_session');
  assert.equal(await request('/web/me'), 401);
  db.state.users.set('ext_session', { source: 'external' });
  assert.equal(await request('/web/me'), 200);
  db.state.account = null;
  for (const path of ['/web/me', '/mall/me', '/ledger/balance', '/ledger/records', '/redeem']) {
    assert.equal(await request(path), 401, `${path} 不得接受清理前的 Cookie`);
  }
  assert.equal(db.state.inserts.length, 0, '不得通过 ensureAccount 重建 users/accounts');
  for (const userid of ['employee', 'ext_sales', 'ext_0123456789abcdef']) {
    db.state.users.set(userid, { source: 'dingtalk' });
    const employeeCookie = `bob_web_session=${createWebSessionToken(cfg.webSessionSecret, { userid, sv: 0 }, 604800)}`;
    assert.equal(await request('/web/me', employeeCookie), 200, `不影响已有钉钉员工 ${userid}`);
  }
  // 外部账号即使不是 ext_ 前缀，也必须检查凭据状态。
  db.state.users.set('legacy_external', { source: 'external' });
  const legacyCookie = `bob_web_session=${createWebSessionToken(cfg.webSessionSecret, { userid: 'legacy_external', sv: 0 }, 604800)}`;
  assert.equal(await request('/web/me', legacyCookie), 401);
  const get = db.get;
  db.get = async (sql, params) => {
    if (sql.includes('LEFT JOIN external_accounts')) throw new Error('account lookup unavailable');
    return get(sql, params);
  };
  assert.equal(await request('/web/me'), 500, '账号状态读取失败时不得放行');
});

test('业务 ensureAccount 不创建用户，只有可信初始化允许创建', async () => {
  const writes = [];
  let existingUser = false;
  const db = {
    async get(sql) {
      if (sql.includes('FROM users') && existingUser) return { userid: 'existing_employee' };
      if (sql.includes('SELECT balance')) return { balance: 0 };
      return null;
    },
    async run(sql, params) { writes.push({ sql, params }); return { changes: 1 }; },
  };
  await assert.rejects(() => ensureAccount(db, { userid: 'deleted_external' }), /unauthorized/);
  await assert.rejects(() => grantBob(db, { userid: 'deleted_external', amount: 1 }), /unauthorized/);
  assert.deepEqual(writes, [], '业务请求不得重建用户或账户');
  existingUser = true;
  assert.equal(await getBalance(db, { userid: 'existing_employee' }), 0);
  assert.ok(writes.some(({ sql }) => /INTO accounts[\s\S]*SELECT userid, 0 FROM users/.test(sql)));
  assert.equal(writes.some(({ sql }) => sql.includes('INTO users')), false, '已有用户只补账户');
  await ensureAccount(db, { userid: 'ext_employee', createUser: true });
  assert.ok(writes.some(({ sql }) => sql.includes('INTO users')));
  assert.ok(writes.some(({ sql }) => sql.includes('INTO accounts')));
});

test('可信单笔/批量发币可初始化新钉钉员工，但不重建已清理外部账号', async (t) => {
  const users = new Map();
  const balances = new Map();
  const writes = [];
  let purgeOnLookup = false;
  const db = {
    async get(sql, params) {
      const uid = params[0];
      if (sql.includes('FROM system_settings')) return { value: JSON.stringify({ enabled: false }) };
      if (sql.includes('SELECT userid FROM users')) return users.has(uid) ? { userid: uid } : null;
      if (sql.includes('FROM users')) {
        const user = users.get(uid);
        if (purgeOnLookup && user?.source === 'external') {
          users.delete(uid);
          balances.delete(uid);
          purgeOnLookup = false;
        }
        return user;
      }
      if (sql.includes('SELECT userid FROM accounts')) return balances.has(uid) ? { userid: uid } : null;
      if (sql.includes('SELECT balance FROM accounts')) return { balance: balances.get(uid) || 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async run(sql, params) {
      writes.push({ sql, params });
      if (sql.includes('INTO users') && !users.has(params[0])) users.set(params[0], { source: 'dingtalk' });
      if (sql.includes('UPDATE users SET name')) users.get(params[1]).name = params[0];
      if (sql.includes('INTO accounts') && !balances.has(params[0])) balances.set(params[0], 0);
      if (sql.includes('SET balance = balance +')) balances.set(params[1], balances.get(params[1]) + params[0]);
      return { changes: 1, lastID: writes.length };
    },
    async transaction(fn) { return fn(db); },
  };
  const lookedUp = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    let data;
    if (String(url).includes('/gettoken')) data = { errcode: 0, access_token: 'test-token', expires_in: 7200 };
    else {
      const { userid } = JSON.parse(options.body);
      lookedUp.push(userid);
      data = userid === 'purged_external'
        ? { errcode: 60121, errmsg: 'user not found' }
        : { errcode: 0, result: { userid, name: '新员工' } };
    }
    return { ok: true, async text() { return JSON.stringify(data); } };
  };
  t.after(() => { globalThis.fetch = fetch; });
  const cfg = { dingtalk: { appKey: 'first-grant-test', appSecret: 'first-grant-test-secret' } };
  const first = await grantWithNotify(db, cfg, { userid: 'first_employee', amount: 10 });
  assert.equal(first.balance, 10);
  assert.equal(users.get('first_employee').source, 'dingtalk');
  const batch = await grantBatchWithNotify(db, cfg, { userids: ['second_employee', 'ext_sales'], amount: 5 });
  assert.equal(batch.ok, true);
  assert.equal(balances.get('second_employee'), 5);
  assert.equal(balances.get('ext_sales'), 5, 'ext_ 前缀不妨碍经钉钉确认的员工建号');
  await grantWithNotify(db, cfg, { userid: 'first_employee', amount: 2 });
  assert.deepEqual(lookedUp, ['first_employee', 'second_employee', 'ext_sales'], '已有账号不重复调用钉钉');
  users.set('active_external', { source: 'external' });
  balances.set('active_external', 0);
  assert.equal((await grantWithNotify(db, cfg, { userid: 'active_external', amount: 3 })).balance, 3);
  const before = writes.length;
  await assert.rejects(() => grantWithNotify(db, cfg, { userid: 'purged_external', amount: 1 }), /user not found/);
  assert.equal(writes.length, before, '钉钉不认识的已清理外部账号不得写入');
  purgeOnLookup = true;
  await assert.rejects(() => grantWithNotify(db, cfg, { userid: 'active_external', amount: 1 }), /unauthorized/);
  assert.equal(users.has('active_external'), false, '外部账号校验后发生清理也不能触发建号');
});

test('已通过认证的账本请求与清理交错时，返回 401 且不复活用户', async (t) => {
  const db = createFakeDb({ account: { userid: 'race_external', status: 'active' } });
  let notifyValidated;
  const validated = new Promise((resolve) => { notifyValidated = resolve; });
  let continueRequest;
  const resume = new Promise((resolve) => { continueRequest = resolve; });
  const get = db.get;
  db.get = async (sql, params) => {
    const row = await get(sql, params);
    if (sql.includes('LEFT JOIN external_accounts')) {
      notifyValidated();
      await resume;
    }
    return row;
  };
  const cfg = { webSessionSecret: 'purge-race-test', sessionGlobalVersion: 0 };
  const app = express();
  app.locals.db = db;
  app.locals.cfg = cfg;
  app.use('/ledger', ledgerRouter());
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => {
    continueRequest();
    return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });
  const cookie = `bob_web_session=${createWebSessionToken(cfg.webSessionSecret, { userid: 'race_external', sv: 0 }, 3600)}`;
  const pending = fetch(`http://127.0.0.1:${server.address().port}/ledger/balance`, { headers: { Cookie: cookie } });
  await validated;
  db.state.users.clear();
  db.state.account = null;
  continueRequest();
  const response = await pending;
  await response.text();
  assert.equal(response.status, 401);
  assert.equal(db.state.users.size, 0);
  assert.equal(db.state.inserts.length, 0);
  await assert.rejects(() => getBalance(db, { userid: 'race_external' }), /unauthorized/);
});

test('可信 Token 首次查余额可建钉钉账户，匿名/坏 Token/旧 Cookie 不可建号', async (t) => {
  const db = createFakeDb();
  const balances = new Map();
  const token = 'trusted-balance-token';
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const get = db.get;
  db.get = async (sql, params) => {
    if (sql.includes('FROM bob_tokens')) return params[0] === tokenHash ? { id: 1 } : null;
    if (sql.includes('SELECT source FROM users')) return db.state.users.get(params[0]);
    if (sql.includes('SELECT balance FROM accounts')) return { balance: balances.get(params[0]) || 0 };
    return get(sql, params);
  };
  db.all = async (sql) => {
    assert.match(sql, /FROM ledger l/);
    return [];
  };
  const run = db.run;
  db.run = async (sql, params) => {
    const result = await run(sql, params);
    if (sql.includes('INTO users')) db.state.users.set(params[0], { source: 'dingtalk' });
    if (sql.includes('INTO accounts') && db.state.users.has(params[0])) balances.set(params[0], 0);
    return result;
  };
  const cfg = { webSessionSecret: 'trusted-balance-web', sessionGlobalVersion: 0, dingtalk: { appKey: 'balance-test', appSecret: 'test' } };
  const app = express();
  app.locals.db = db;
  app.locals.cfg = cfg;
  app.use('/ledger', ledgerRouter());
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const nativeFetch = globalThis.fetch;
  const lookedUp = [];
  globalThis.fetch = async (url, options) => {
    let data;
    if (String(url).includes('/gettoken')) data = { errcode: 0, access_token: 'test-token', expires_in: 7200 };
    else {
      const { userid } = JSON.parse(options.body);
      lookedUp.push(userid);
      data = userid === 'purged_external'
        ? { errcode: 60121, errmsg: 'user not found' }
        : { errcode: 0, result: { userid, name: '首次查余额员工' } };
    }
    return { ok: true, async text() { return JSON.stringify(data); } };
  };
  t.after(async () => {
    globalThis.fetch = nativeFetch;
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });
  const request = async (userid, headers = {}, path = 'balance') => {
    const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/ledger/${path}?userid=${userid}`, { headers });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('new_employee')).status, 401);
  assert.equal((await request('new_employee', { 'X-BOB-Token': 'bad' })).status, 401);
  const stale = `bob_web_session=${createWebSessionToken(cfg.webSessionSecret, { userid: 'purged_external', sv: 0 }, 3600)}`;
  assert.equal((await request('new_employee', { Cookie: stale })).status, 401);
  assert.equal(lookedUp.length, 0, '未通过 Token 认证不能触发身份核验');
  const result = await request('ext_sales', { 'X-BOB-Token': token });
  assert.equal(result.status, 200);
  assert.equal(Number(result.body.balance), 0);
  assert.ok(balances.has('ext_sales'));
  assert.equal((await request('ext_sales', { 'X-BOB-Token': token })).status, 200);
  assert.deepEqual(lookedUp, ['ext_sales'], '重复余额查询不再核验已有身份');
  const records = await request('first_records_employee', { 'X-BOB-Token': token }, 'records');
  assert.equal(records.status, 200);
  assert.deepEqual(records.body.data, []);
  assert.ok(balances.has('first_records_employee'), '同一可信查询链的流水首查也保留初始化行为');
  assert.equal((await request('purged_external', { 'X-BOB-Token': token })).status, 500);
  assert.equal(db.state.users.has('purged_external'), false);
});

test('注册与登录签发前强制刷新会话版本，新 Cookie 可立即使用且刷新失败不签发', async (t) => {
  const db = createFakeDb();
  db.state.externalLoginSettings = { enabled: true, batch_id: 'session-version-test' };
  db.state.sessionVersion = 7;
  const cfg = { webSessionSecret: 'session-version-test', sessionGlobalVersion: 0 };
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.locals.cfg = cfg;
  app.use('/web', webRouter());
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { name: '会话测试', phone: '13800000001', password: '123', consent: true };
  for (const [path, version] of [['/web/ext/register', 7], ['/web/ext/login', 8]]) {
    db.state.sessionVersion = version;
    assert.notEqual(cfg.sessionGlobalVersion, version, '模拟实例内版本落后于数据库');
    const response = await fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await response.text();
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const payload = verifyWebSessionToken(cfg.webSessionSecret, cookie.slice('bob_web_session='.length));
    assert.equal(payload.sv, version, '必须跳过刷新节流，签入最新版本');
    const me = await fetch(base + '/web/me', { headers: { Cookie: cookie } });
    await me.text();
    assert.equal(me.status, 200, '刚签发的 Cookie 必须能立即认证');
  }
  const get = db.get;
  db.get = async (sql, params) => {
    if (params?.[0] === 'session_global_version') throw new Error('session version unavailable');
    return get(sql, params);
  };
  const failed = await fetch(base + '/web/ext/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await failed.text();
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get('set-cookie'), null, '读取版本失败不能签发过期版本 Cookie');
});

test('注册接口要求显式同意告知且默认关闭（fail-closed）', () => {
  assert.match(webRoutesSource, /consent !== true/);
  assert.match(webRoutesSource, /settings\.enabled !== true/);
  assert.match(webRoutesSource, /'register_disabled'/);
  // 登录不依赖注册开关：活动结束关闭注册后仍可登录兑换
  assert.match(webRoutesSource, /router\.post\('\/ext\/login'[\s\S]*?authenticateExternalAccount/);
});

test('外部用户不出现在转账搜索与富豪榜', () => {
  const usersQuery = mallRoutesSource.match(/router\.get\('\/users'[\s\S]*?LIMIT \?`,/);
  assert.ok(usersQuery, '未找到 /mall/users 查询');
  assert.match(usersQuery[0], /COALESCE\(u\.source, 'dingtalk'\) <> 'external'/);

  const boardQuery = mallRoutesSource.match(/router\.get\('\/rich-board'[\s\S]*?LIMIT \?`,/);
  assert.ok(boardQuery, '未找到 /mall/rich-board 查询');
  assert.match(boardQuery[0], /COALESCE\(u\.source, 'dingtalk'\) <> 'external'/);
});

test('商城在浏览器内打开时跳转活动登录页而非直接钉钉授权', () => {
  assert.match(mallAssetSource, /window\.location\.replace\(`\/login\?\$\{params\.toString\(\)\}`\)/);
  assert.equal(mallAssetSource.includes("window.location.replace(`/web/oauth/start?${params.toString()}`)"), false);
});

test('外部限流挂在路由上，不依赖精确路径匹配', () => {
  // Express 默认大小写不敏感且容忍尾斜杠：用 req.path === '/web/ext/login' 判断会被
  // /web/ext/login/ 与 /WEB/ext/login 绕过，因此限流必须是路由级中间件。
  assert.match(webRoutesSource, /createRateLimiter\(\{[\s\S]*?ext_register[\s\S]*?ext_login/);
  assert.match(webRoutesSource, /router\.post\('\/ext\/register', extRegisterLimiter, requireSiteEnabled\(\)/);
  assert.match(webRoutesSource, /router\.post\('\/ext\/login', extLoginLimiter, requireSiteEnabled\(\)/);
  assert.equal(appSource.includes("p === '/web/ext/login'"), false);
  assert.equal(appSource.includes("p === '/web/ext/register'"), false);
});

test('登录页跳转按解析后的 origin 校验，避免开放重定向', () => {
  const helper = loginAssetSource.match(/function normalizeRedirect\(value\) \{[\s\S]*?\n  \}/);
  assert.ok(helper, '未找到 normalizeRedirect');
  const normalize = runInNewContext(`(${helper[0]})`, {
    URL,
    DEFAULT_REDIRECT: '/mall',
    window: { location: { origin: 'https://bob.test' } },
  });
  for (const unsafe of ['/\\evil.example', '/\\\\evil.example', '//evil.example', 'https://evil.example', 'https://bob.test//evil.example', '/mall/..//evil.example', 'javascript:alert(1)']) {
    assert.equal(normalize(unsafe), '/mall', `应拒绝：${unsafe}`);
  }
  assert.equal(normalize('/mall?tab=auction#bids'), '/mall?tab=auction#bids');
  assert.equal(normalize('https://bob.test/mall?tab=orders'), '/mall?tab=orders');
  assert.equal(normalize(''), '/mall');
});

test('登录和注册表单原生回退仅使用 POST，不把密码写入 URL', () => {
  const html = readFileSync(fileURLToPath(new URL('../../src/pages/login.html', import.meta.url)), 'utf8');
  for (const [id, action] of [['formLogin', '/web/ext/login'], ['formRegister', '/web/ext/register']]) {
    const form = html.match(new RegExp(`<form\\b[^>]*id="${id}"[^>]*>`));
    assert.ok(form, `未找到 ${id}`);
    assert.match(form[0], /method="post"/i);
    assert.ok(form[0].includes(`action="${action}"`));
  }
});

test('外部批次清理排除启用角色管理员，且保留显式管理员与超管保护', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/routes/admin/settingsRoutes.js', import.meta.url)), 'utf8');
  const purge = source.slice(source.indexOf("router.post('/settings/external-login/purge'"));
  assert.match(purge, /COALESCE\(u\.is_admin, 0\) = 0/);
  assert.match(purge, /NOT EXISTS \([\s\S]*?FROM admin_user_roles ur[\s\S]*?JOIN admin_roles r[\s\S]*?ur\.userid = a\.userid AND r\.is_enabled = 1/);
  assert.match(purge, /deleteUsersCompletely\(tx, userids, \{ protectUserids \}\)/);
});

test('批次清理在事务锁后选目标，授权先提交的管理员不进入任何删除', async () => {
  let purgeHandler;
  const router = {
    get() {},
    post(path, ...handlers) { if (path === '/settings/external-login/purge') purgeHandler = handlers.at(-1); },
  };
  registerAdminSettingsRoutes(router);
  let lockRequested;
  const waiting = new Promise((resolve) => { lockRequested = resolve; });
  let release;
  const grantCommitted = new Promise((resolve) => { release = resolve; });
  let protectedAdmin = false;
  const operations = [];
  const db = {
    async all() { assert.fail('禁止在事务外读取清理名单'); },
    async transaction(fn) {
      operations.push('begin');
      const result = await fn({
        async exec(sql) {
          assert.match(sql, /pg_advisory_xact_lock/);
          operations.push('lock_wait');
          lockRequested();
          await grantCommitted;
          operations.push('locked');
        },
        async all(sql) {
          assert.match(sql, /NOT EXISTS[\s\S]*admin_user_roles/);
          operations.push('select');
          return protectedAdmin ? [] : [{ userid: 'external_now_admin' }];
        },
        async run() { assert.fail('受保护管理员不应进入业务清理'); },
      });
      operations.push('commit');
      return result;
    },
  };
  const response = {
    statusCode: 200,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const pending = purgeHandler({
    body: { batch_id: 'race', confirm: 'DELETE' },
    app: { locals: { db, cfg: { adminUserids: [] } } },
  }, response);
  await waiting;
  protectedAdmin = true;
  release();
  await pending;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.deleted, 0);
  assert.deepEqual(operations, ['begin', 'lock_wait', 'locked', 'select', 'commit']);
  const adminSource = readFileSync(fileURLToPath(new URL('../../src/routes/admin/index.js', import.meta.url)), 'utf8');
  for (const route of ['/users/set-admin', '/users/assign-role', '/roles/disable']) {
    const block = adminSource.slice(adminSource.indexOf(`router.post('${route}'`)).split('\n  router.')[0];
    assert.match(block, /runInTransaction\(db, async \(tx\) => \{\s*await lockAdminAccountProtection\(tx\)/);
  }
  assert.match(backupRoutesSource, /const report = await runInTransaction\(db, async \(tx\) => \{\s*await lockAdminAccountProtection\(tx\)/);
  const settingsSource = readFileSync(fileURLToPath(new URL('../../src/routes/admin/settingsRoutes.js', import.meta.url)), 'utf8');
  const saveSettings = settingsSource.slice(settingsSource.indexOf("router.post('/settings/external-login',")).split('\n  router.')[0];
  assert.match(saveSettings, /runInTransaction\(db, async \(tx\) => \{\s*await lockAdminAccountProtection\(tx\)/);
});

test('登录页手机号去除支持的前缀与分隔符，但不截坏非法号码', () => {
  const helper = loginAssetSource.match(/function normalizePhoneInput\(value\) \{[\s\S]*?\n  \}/);
  assert.ok(helper, '未找到 normalizePhoneInput');
  const normalize = runInNewContext(`(${helper[0]})`);
  for (const phone of ['13800000000', '+8613800000000', '8613800000000', '138 0000 0000', '+86 (138) 0000-0000']) {
    assert.equal(normalize(phone), '13800000000', `不应截坏：${phone}`);
  }
  assert.equal(normalize('138000000001'), '138000000001');
  assert.equal(normalize('138abc00000000'), '138abc00000000');
  // 输入框 maxlength 要为格式化输入留出余量，否则粘贴在归一化之前就被截断
  const loginHtml = readFileSync(fileURLToPath(new URL('../../src/pages/login.html', import.meta.url)), 'utf8');
  const phoneInputs = loginHtml.match(/type="tel"[^>]*maxlength="(\d+)"/g) || [];
  assert.equal(phoneInputs.length, 2);
  for (const input of phoneInputs) assert.match(input, /maxlength="20"/);
});

test('登录页完整脚本保留逐字符输入，失焦和未失焦提交均归一化', async () => {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', checked: true, listeners: new Map(),
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
        addEventListener(type, fn) { this.listeners.set(type, fn); },
      });
    }
    return elements.get(id);
  };
  const requests = [];
  let bootstrap;
  runInNewContext(loginAssetSource, {
    URL, URLSearchParams,
    document: {
      readyState: 'loading',
      getElementById: getElement,
      addEventListener(_type, fn) { bootstrap = fn; },
    },
    window: { location: { origin: 'https://bob.test', search: '' } },
    async fetch(path, options) {
      if (path === '/web/me') return { status: 401 };
      if (path === '/web/ext/status') {
        return { status: 200, async json() { return { register_enabled: true }; } };
      }
      requests.push({ path, body: JSON.parse(options.body) });
      return { status: 400, async json() { return { error: 'invalid_credentials' }; } };
    },
  });
  await bootstrap();
  for (const [phoneId, formId, endpoint] of [
    ['loginPhone', 'formLogin', '/web/ext/login'],
    ['regPhone', 'formRegister', '/web/ext/register'],
  ]) {
    const phone = getElement(phoneId);
    for (const text of ['+8613800000000', '8613800000000', '+86 (138) 0000-0000']) {
      phone.value = '';
      for (let index = 0; index < text.length; index += 1) {
        phone.value += text[index];
        phone.listeners.get('input')?.();
        assert.equal(phone.value, text.slice(0, index + 1), '输入中不应改写或截断号码');
      }
      phone.listeners.get('blur')();
      assert.equal(phone.value, '13800000000');
      // 回车/自动填充提交不一定先触发 blur，提交处理器也必须归一化。
      phone.value = text;
      await getElement(formId).listeners.get('submit')({ preventDefault() {} });
      assert.equal(requests.at(-1).path, endpoint);
      assert.equal(requests.at(-1).body.phone, '13800000000');
    }
  }
  assert.equal(requests.length, 6);
});

test('全量备份与恢复包含外部账号凭据', () => {
  const fullTables = backupRoutesSource.match(/const FULL_TABLES = \[[\s\S]*?\];/);
  assert.ok(fullTables, '未找到 FULL_TABLES');
  assert.match(fullTables[0], /'external_accounts'/);
  // users 恢复必须带上 source/phone，否则恢复出来的外部账号会被当成钉钉员工
  const usersRestore = backupRoutesSource.match(/INSERT INTO users\(userid, name, is_admin, source, phone, created_at\)/);
  assert.ok(usersRestore, 'users 恢复缺少 source/phone');
  assert.match(backupRoutesSource, /INSERT INTO external_accounts\(/);
  // 覆盖导入要先删 external_accounts 再删 users（外键）
  const deleteOrder = backupRoutesSource.match(/const deleteOrder = \[[\s\S]*?\];/);
  assert.ok(deleteOrder, '未找到 deleteOrder');
  const order = deleteOrder[0].match(/'external_accounts'|'users'/g) || [];
  assert.deepEqual(order.slice(-2), ["'external_accounts'", "'users'"]);
  // 旧备份没有该表，不能因此拒绝恢复
  assert.match(backupRoutesSource, /optionalFullTables = new Set\(\[[^\]]*'external_accounts'/);
});

test('备份预校验拒绝缺凭据或身份不匹配的外部用户，兼容历史员工备份', () => {
  const guard = backupRoutesSource.match(/if \(backupMode === 'full'\) \{\n          const externalAccounts = requireArray\('external_accounts'\)[\s\S]*?\n        \}/);
  assert.ok(guard, '未找到外部账号预校验');
  const user = { userid: 'ext_roundtrip', source: 'external', phone: '13800000000' };
  const credentials = { ...user, password_hash: 'hash', password_salt: 'salt' };
  const validate = (users, externalAccounts) => {
    const errors = [];
    runInNewContext(guard[0], {
      backupMode: 'full',
      users,
      requireArray: () => externalAccounts,
      pushPreflight: (table, index, message) => errors.push({ table, index, message }),
    });
    return errors;
  };
  assert.deepEqual(validate([user], [credentials]), []);
  assert.deepEqual(validate([{ userid: 'employee' }], null), []);
  for (const rows of [null, []]) {
    assert.match(validate([user], rows)[0].message, /外部用户缺少关联密码凭据/);
  }
  assert.ok(validate([user], [{ ...credentials, password_hash: '' }]).some((err) => /缺少密码凭据/.test(err.message)));
  assert.ok(validate([user], [{ ...credentials, phone: '13900000000' }]).some((err) => /来源或手机号不一致/.test(err.message)));
  assert.ok(validate([{ ...user, source: 'dingtalk' }], [credentials]).some((err) => /来源或手机号不一致/.test(err.message)));
});

test('离职核对排除外部账号，避免无谓钉钉调用与假离职档案', () => {
  const query = userSyncSource.match(/async function deactivateConfirmedDepartures[\s\S]*?const all = /);
  assert.ok(query, '未找到离职核对查询');
  assert.match(query[0], /COALESCE\(u\.source, 'dingtalk'\) <> 'external'/);
});
