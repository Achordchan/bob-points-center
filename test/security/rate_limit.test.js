import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, webSessionOrIpKey } from '../../src/middleware/rateLimit.js';
import { createWebSessionToken } from '../../src/services/webSession.js';

test('限流超过阈值返回 429', () => {
  const lim = createRateLimiter({ windowMs: 60_000, max: 2, keyFn: () => 'k' });
  let status = 200;
  const res = {
    status(c) { status = c; return this; },
    json() { return this; },
    setHeader() {},
  };
  const next = () => {};
  lim({}, res, next);
  lim({}, res, next);
  lim({}, res, next);
  assert.equal(status, 429);
});

function fakeReq({ cookie, ip = '10.0.0.1', secret = 'rate-limit-secret' } = {}) {
  return {
    ip,
    socket: { remoteAddress: ip },
    headers: {},
    app: { locals: { cfg: { webSessionSecret: secret } } },
    header(name) { return String(name).toLowerCase() === 'cookie' ? cookie : undefined; },
  };
}

const sessionCookie = (userid, secret = 'rate-limit-secret') =>
  `bob_web_session=${createWebSessionToken(secret, { userid, sv: 0 }, 3600)}`;

test('已登录用户按账号限流：同一出口 IP 的不同用户互不影响', () => {
  const a = webSessionOrIpKey(fakeReq({ cookie: sessionCookie('ext_a') }), 'transfer');
  const b = webSessionOrIpKey(fakeReq({ cookie: sessionCookie('ext_b') }), 'transfer');
  assert.notEqual(a, b, '同 IP 的两个用户应落在不同桶');
  assert.equal(a, webSessionOrIpKey(fakeReq({ cookie: sessionCookie('ext_a'), ip: '10.9.9.9' }), 'transfer'), '换网络同一用户仍是同一桶');

  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, keyFn: (req) => webSessionOrIpKey(req, 'transfer') });
  const run = (cookie) => {
    let status = 200;
    limiter(fakeReq({ cookie }), { status(c) { status = c; return this; }, json() { return this; }, setHeader() {} }, () => {});
    return status;
  };
  assert.equal(run(sessionCookie('ext_a')), 200);
  assert.equal(run(sessionCookie('ext_a')), 200);
  assert.equal(run(sessionCookie('ext_a')), 429, '同一用户超限被拒');
  assert.equal(run(sessionCookie('ext_b')), 200, '同 IP 的另一用户不受影响');
});

test('未登录、伪造或过期的会话退回按 IP 限流，换 Cookie 无法绕过', () => {
  const ipKey = webSessionOrIpKey(fakeReq(), 'bid');
  assert.match(ipKey, /bid$/);
  assert.ok(!ipKey.startsWith('user:'));
  assert.equal(webSessionOrIpKey(fakeReq({ cookie: 'bob_web_session=garbage' }), 'bid'), ipKey);
  assert.equal(webSessionOrIpKey(fakeReq({ cookie: sessionCookie('ext_a', 'another-secret') }), 'bid'), ipKey, '密钥不符的伪造会话落在 IP 桶');
  // 令牌有效期至少 60 秒，用推进时钟模拟过期。
  const shortLived = `bob_web_session=${createWebSessionToken('rate-limit-secret', { userid: 'ext_a', sv: 0 }, 60)}`;
  const realNow = Date.now;
  Date.now = () => realNow() + 120_000;
  try {
    assert.equal(webSessionOrIpKey(fakeReq({ cookie: shortLived }), 'bid'), ipKey, '过期会话落在 IP 桶');
  } finally {
    Date.now = realNow;
  }
  assert.equal(webSessionOrIpKey({ ...fakeReq(), app: undefined }, 'bid'), ipKey, '缺少配置时不抛错，退回 IP');
});
