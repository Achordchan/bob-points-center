import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDingtalkOAuthStateCookie,
  buildClearDingtalkOAuthStateCookie,
} from '../../src/services/dingtalkOAuthState.js';
import { cookieOptions } from '../../src/utils/sessionCrypto.js';

test('HTTPS 下 OAuth nonce Cookie 带 Secure', () => {
  const cfg = { cookieSecure: true };
  const set = buildDingtalkOAuthStateCookie('bob_web_oauth_state', 'nonce123', 600, cookieOptions(cfg));
  const clear = buildClearDingtalkOAuthStateCookie('bob_web_oauth_state', cookieOptions(cfg));
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Secure/);
  assert.match(clear, /Secure/);
});

test('非 Secure 环境 OAuth Cookie 不带 Secure', () => {
  const set = buildDingtalkOAuthStateCookie('bob_admin_oauth_state', 'n', 600, cookieOptions({ cookieSecure: false }));
  assert.doesNotMatch(set, /Secure/);
});
