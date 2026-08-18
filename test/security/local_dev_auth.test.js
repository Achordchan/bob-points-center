import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLoopbackSocketAddress,
  shouldEnableLocalDevAuth,
  TEST_ACCOUNTS,
} from '../../src/routes/devAuth.js';

function validConfig() {
  return {
    nodeEnv: 'development',
    localDevAuthEnabled: true,
    devSessionDatabase: 'bob',
    serverBaseUrl: 'http://127.0.0.1:8000',
    adminSessionSecret: 'a'.repeat(32),
    webSessionSecret: 'b'.repeat(32),
    db: { host: '127.0.0.1', database: 'bob' },
  };
}

test('本地免登录仅在完整开发边界内启用', () => {
  assert.equal(shouldEnableLocalDevAuth(validConfig()), true);

  for (const mutate of [
    (cfg) => { cfg.nodeEnv = 'production'; },
    (cfg) => { cfg.localDevAuthEnabled = false; },
    (cfg) => { cfg.db.host = '10.0.0.8'; },
    (cfg) => { cfg.devSessionDatabase = 'other'; },
    (cfg) => { cfg.serverBaseUrl = 'https://bob.example.com'; },
    (cfg) => { cfg.adminSessionSecret = 'short'; },
    (cfg) => { cfg.webSessionSecret = cfg.adminSessionSecret; },
  ]) {
    const cfg = validConfig();
    mutate(cfg);
    assert.equal(shouldEnableLocalDevAuth(cfg), false);
  }
});

test('本地免登录拒绝非回环网络请求', () => {
  assert.equal(isLoopbackSocketAddress('127.0.0.1'), true);
  assert.equal(isLoopbackSocketAddress('::1'), true);
  assert.equal(isLoopbackSocketAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackSocketAddress('192.168.1.10'), false);
});

test('本地免登录只提供两个普通账号和一个管理员账号', () => {
  assert.deepEqual(Object.keys(TEST_ACCOUNTS), ['user-1', 'user-2', 'admin']);
  assert.equal(TEST_ACCOUNTS['user-1'].isAdmin, false);
  assert.equal(TEST_ACCOUNTS['user-2'].isAdmin, false);
  assert.equal(TEST_ACCOUNTS.admin.isAdmin, true);
  assert.equal(TEST_ACCOUNTS['user-1'].initialBalance, 1000);
  assert.equal(TEST_ACCOUNTS['user-2'].initialBalance, 1000);
});
