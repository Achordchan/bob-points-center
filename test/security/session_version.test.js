import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, verifySessionToken, buildSessionCookie } from '../../src/services/adminSession.js';
import {
  adminSessionSigningSecret,
  withSessionVersion,
  isSessionVersionValid,
  cookieOptions,
} from '../../src/utils/sessionCrypto.js';

test('会话版本与 Secure Cookie', () => {
  const cfg = { adminSessionSecret: 'secret', cookieSecure: true, sessionGlobalVersion: 2, sessionSalt: '' };
  const secret = adminSessionSigningSecret(cfg);
  const token = createSessionToken(secret, withSessionVersion({ userid: 'u1' }, cfg), 3600);
  const payload = verifySessionToken(secret, token);
  assert.equal(payload.sv, 2);
  assert.equal(isSessionVersionValid(payload, cfg), true);
  assert.equal(isSessionVersionValid({ userid: 'u1', exp: 9999999999 }, cfg), false);
  assert.match(buildSessionCookie(token, cookieOptions(cfg)), /Secure/);
});
