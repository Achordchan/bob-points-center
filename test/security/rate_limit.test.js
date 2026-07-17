import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../../src/middleware/rateLimit.js';

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
