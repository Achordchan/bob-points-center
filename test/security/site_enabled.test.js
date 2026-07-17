import test from 'node:test';
import assert from 'node:assert/strict';
import { requireSiteEnabled } from '../../src/middleware/requireSiteEnabled.js';

test('站点关闭时业务接口 403', async () => {
  const mw = requireSiteEnabled();
  const req = {
    app: {
      locals: {
        db: {
          async get() {
            return { value: JSON.stringify({ enabled: false, message: '维护中' }) };
          },
        },
      },
    },
  };
  let status = 0;
  let body = null;
  const res = {
    status(c) { status = c; return this; },
    json(b) { body = b; return this; },
  };
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(status, 403);
  assert.equal(body.error, 'site_disabled');
  assert.equal(nextCalled, false);
});

test('站点状态查询失败时 fail-closed 503', async () => {
  const mw = requireSiteEnabled();
  const req = {
    app: {
      locals: {
        db: {
          async get() {
            throw new Error('db down');
          },
        },
      },
    },
  };
  let status = 0;
  let body = null;
  const res = {
    status(c) { status = c; return this; },
    json(b) { body = b; return this; },
  };
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(status, 503);
  assert.equal(body.error, 'site_status_unavailable');
  assert.equal(nextCalled, false);
});
