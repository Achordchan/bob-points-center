import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, verifySessionToken, buildSessionCookie } from '../../src/services/adminSession.js';
import {
  adminSessionSigningSecret,
  withSessionVersion,
  isSessionVersionValid,
  cookieOptions,
  refreshSessionGlobalVersion,
} from '../../src/utils/sessionCrypto.js';

test('会话版本与 Secure Cookie', () => {
  const cfg = { adminSessionSecret: 'secret', cookieSecure: true, sessionGlobalVersion: 2, sessionSalt: '' };
  const secret = adminSessionSigningSecret(cfg);
  const token = createSessionToken(secret, withSessionVersion({ userid: 'u1' }, cfg), 3600);
  const payload = verifySessionToken(secret, token);
  assert.equal(payload.aud, 'admin');
  assert.equal(payload.sv, 2);
  assert.equal(isSessionVersionValid(payload, cfg), true);
  assert.equal(isSessionVersionValid({ userid: 'u1', exp: 9999999999 }, cfg), false);
  assert.match(buildSessionCookie(token, cookieOptions(cfg)), /Secure/);
});

test('共享刷新失败时各调用方保留自己的严格错误策略，与发起顺序无关', async () => {
  for (const strictFirst of [false, true]) {
    const cfg = { sessionGlobalVersion: 2 };
    let rejectRead;
    let reads = 0;
    const db = {
      get() {
        reads += 1;
        return new Promise((_resolve, reject) => { rejectRead = reject; });
      },
    };
    const error = new Error('session version database unavailable');
    const first = refreshSessionGlobalVersion(db, cfg, strictFirst ? { force: true, throwOnError: true } : {});
    const second = refreshSessionGlobalVersion(db, cfg, { force: true, throwOnError: !strictFirst });
    const results = Promise.allSettled([first, second]);
    assert.equal(reads, 1, '并发调用仍只共享一次数据库查询');
    rejectRead(error);
    const settled = await results;
    const strict = settled[strictFirst ? 0 : 1];
    const ordinary = settled[strictFirst ? 1 : 0];
    assert.equal(strict.status, 'rejected');
    assert.equal(strict.reason, error);
    assert.deepEqual(ordinary, { status: 'fulfilled', value: 2 });
  }
  const recoveredCfg = { sessionGlobalVersion: 2 };
  assert.equal(await refreshSessionGlobalVersion({ async get() { return { value: '9' }; } }, recoveredCfg, { force: true, throwOnError: true }), 9);
  assert.equal(recoveredCfg.sessionGlobalVersion, 9, '失败后可重新读取新版本，不保留失败 promise');
});
