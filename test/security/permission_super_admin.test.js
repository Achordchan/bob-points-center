import test from 'node:test';
import assert from 'node:assert/strict';

// dotenv.config() 默认不覆盖已存在的环境变量；
// 因此测试要把键设为空串，而不是 delete（delete 会被 .env 重新灌回）。
test('生产环境未配置超管名单应启动失败', async () => {
  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    ADMIN_USERIDS: process.env.ADMIN_USERIDS,
    ADMIN_FALLBACK_USERID: process.env.ADMIN_FALLBACK_USERID,
  };
  process.env.NODE_ENV = 'production';
  process.env.ADMIN_USERIDS = '';
  process.env.ADMIN_FALLBACK_USERID = '';
  try {
    const { loadConfig } = await import('../../src/config.js');
    assert.throws(() => loadConfig(), /ADMIN_USERIDS/);
  } finally {
    if (prev.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.NODE_ENV;
    if (prev.ADMIN_USERIDS === undefined) delete process.env.ADMIN_USERIDS;
    else process.env.ADMIN_USERIDS = prev.ADMIN_USERIDS;
    if (prev.ADMIN_FALLBACK_USERID === undefined) delete process.env.ADMIN_FALLBACK_USERID;
    else process.env.ADMIN_FALLBACK_USERID = prev.ADMIN_FALLBACK_USERID;
  }
});
