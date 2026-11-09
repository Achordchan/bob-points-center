import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { adminRouter } from '../../src/routes/admin/index.js';

// 转发核销链接 /admin/home?encoded=... 未登录时必须带着原链接跳登录页，登录后才能回到核销页。
test('未登录访问 /admin/home 保留原链接作为 redirect', async (t) => {
  const app = express();
  app.locals.db = {
    async get() { return null; },
    async all() { return []; },
    async run() { return { changes: 0 }; },
    async exec() {},
  };
  app.locals.cfg = { adminSessionSecret: 'test-admin-secret-0123456789abcdef', webSessionSecret: 'test-web-secret-0123456789abcdef' };
  app.use('/admin', adminRouter());
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const locationOf = async (path) => {
    const response = await fetch(base + path, { redirect: 'manual' });
    await response.text();
    assert.equal(response.status, 302, path);
    return response.headers.get('location');
  };

  assert.equal(await locationOf('/admin/home'), '/admin/login');

  const shared = '/admin/home?encoded=abc_DEF-1&encoded=xyz';
  const location = await locationOf(shared);
  const url = new URL(location, base);
  assert.equal(url.pathname, '/admin/login');
  assert.equal(url.searchParams.get('redirect'), shared);
});
