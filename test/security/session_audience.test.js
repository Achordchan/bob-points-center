import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, verifySessionToken } from '../../src/services/adminSession.js';
import { createWebSessionToken, verifyWebSessionToken } from '../../src/services/webSession.js';
import {
  adminSessionSigningSecret,
  webSessionSigningSecret,
  withSessionVersion,
} from '../../src/utils/sessionCrypto.js';

test('Admin/Web Token 必须带 aud 并互相拒绝', () => {
  const cfg = {
    adminSessionSecret: 'admin-secret',
    webSessionSecret: 'web-secret',
    sessionSalt: '',
    sessionGlobalVersion: 1,
  };
  const adminSecret = adminSessionSigningSecret(cfg);
  const webSecret = webSessionSigningSecret(cfg);

  const adminToken = createSessionToken(adminSecret, withSessionVersion({ userid: 'a1', name: 'Admin' }, cfg), 3600);
  const webToken = createWebSessionToken(webSecret, withSessionVersion({ userid: 'w1', name: 'User' }, cfg), 3600);

  const adminPayload = verifySessionToken(adminSecret, adminToken);
  const webPayload = verifyWebSessionToken(webSecret, webToken);
  assert.equal(adminPayload.aud, 'admin');
  assert.equal(webPayload.aud, 'web');

  // 即使密钥相同，aud 也会阻断跨域
  const shared = 'same-secret';
  const sharedAdmin = createSessionToken(shared, withSessionVersion({ userid: 'x' }, cfg), 3600);
  const sharedWeb = createWebSessionToken(shared, withSessionVersion({ userid: 'x' }, cfg), 3600);
  assert.equal(verifySessionToken(shared, sharedWeb), null);
  assert.equal(verifyWebSessionToken(shared, sharedAdmin), null);

  // 密钥不同时更不会互通
  assert.equal(verifySessionToken(adminSecret, webToken), null);
  assert.equal(verifyWebSessionToken(webSecret, adminToken), null);
});

test('生产环境要求独立 Web/Admin 会话密钥', async () => {
  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    ADMIN_USERIDS: process.env.ADMIN_USERIDS,
    ADMIN_FALLBACK_USERID: process.env.ADMIN_FALLBACK_USERID,
    ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
    WEB_SESSION_SECRET: process.env.WEB_SESSION_SECRET,
  };
  process.env.NODE_ENV = 'production';
  process.env.ADMIN_USERIDS = 'u1';
  process.env.ADMIN_FALLBACK_USERID = '';
  process.env.ADMIN_SESSION_SECRET = 'admin-only';
  process.env.WEB_SESSION_SECRET = '';
  try {
    const { loadConfig } = await import('../../src/config.js');
    assert.throws(() => loadConfig(), /WEB_SESSION_SECRET/);
    process.env.WEB_SESSION_SECRET = 'admin-only';
    assert.throws(() => loadConfig(), /必须与 ADMIN_SESSION_SECRET 不同/);
    process.env.WEB_SESSION_SECRET = 'web-only';
    const cfg = loadConfig();
    assert.equal(cfg.adminSessionSecret, 'admin-only');
    assert.equal(cfg.webSessionSecret, 'web-only');
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
