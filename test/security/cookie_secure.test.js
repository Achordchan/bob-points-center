import test from 'node:test';
import assert from 'node:assert/strict';

test('HTTPS SERVER_BASE_URL 时 Cookie Secure 默认开启', async () => {
  const prev = { ...process.env };
  process.env.NODE_ENV = '';
  process.env.COOKIE_SECURE = '';
  // 断言的是由 HTTPS SERVER_BASE_URL 推导出的默认值，显式取值优先级更高，
  // 必须一并清空，否则开发者本地 .env 中的 TRUST_PROXY 会让断言失败。
  process.env.TRUST_PROXY = '';
  process.env.SERVER_BASE_URL = 'https://bob.example.com';
  process.env.ADMIN_USERIDS = 'u1';
  try {
    const { loadConfig } = await import('../../src/config.js');
    const cfg = loadConfig();
    assert.equal(cfg.cookieSecure, true);
    assert.equal(cfg.trustProxy, true);
  } finally {
    for (const k of ['NODE_ENV', 'COOKIE_SECURE', 'TRUST_PROXY', 'SERVER_BASE_URL', 'ADMIN_USERIDS', 'ADMIN_FALLBACK_USERID']) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});
