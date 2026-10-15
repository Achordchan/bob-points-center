import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

/** 最小化假库：按 SQL 片段分派，覆盖服务层的读写分支。 */
function createFakeDb({ account = null, dingtalkUser = null, userByPhone = null } = {}) {
  const state = {
    account: account ? { failed_count: 0, locked_until: null, status: 'active', ...account } : null,
    dingtalkUser,
    userByPhone,
    inserts: [],
    updates: [],
    queries: [],
  };

  const db = {
    state,
    async get(sql, params = []) {
      state.queries.push({ sql, params });
      if (sql.includes('FROM user_dingtalk_profiles')) return dingtalkUser;
      if (sql.includes('FROM external_accounts')) return state.account;
      if (sql.includes('FROM users WHERE phone')) return userByPhone;
      return null;
    },
    async run(sql, params = []) {
      state.updates.push({ sql, params });
      if (sql.includes('UPDATE external_accounts')) {
        if (sql.includes('failed_count = 0')) {
          state.account.failed_count = 0;
          state.account.locked_until = null;
        } else {
          state.account.failed_count = params[0];
          state.account.locked_until = params[1];
        }
      }
      if (sql.startsWith('INSERT INTO')) state.inserts.push({ sql, params });
      return { changes: 1, lastID: 1 };
    },
    async all() {
      return [];
    },
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

test('注册写入 users/accounts/external_accounts 三张表，落库不含明文密码', async () => {
  const db = createFakeDb();
  const account = await registerExternalAccount(db, {
    name: ' 王五 ',
    phone: '+8613800000001',
    password: '123',
    batchId: '活动A',
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
