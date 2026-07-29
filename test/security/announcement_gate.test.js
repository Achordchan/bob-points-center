import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireAnnouncementAccess } from '../../src/middleware/requireAnnouncementAccess.js';

test('公告确认请求按 JSON 发送完整修订参数', () => {
  const mallScriptPath = fileURLToPath(new URL('../../src/pages/assets/mall.js', import.meta.url));
  const source = readFileSync(mallScriptPath, 'utf8');
  assert.match(
    source,
    /announcements\/\$\{encodeURIComponent\(current\.id\)\}\/acknowledge[\s\S]*headers:\s*\{\s*'Content-Type':\s*'application\/json'\s*\}[\s\S]*body:\s*JSON\.stringify\(\{[\s\S]*revision:\s*current\.revision[\s\S]*content_hash:\s*current\.content_hash[\s\S]*action/,
  );
});

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('存在未确认强制公告时返回 403', async () => {
  const middleware = requireAnnouncementAccess();
  const req = {
    webSession: { userid: 'u1' },
    app: { locals: { db: { async get() { return { id: 1 }; } } } },
  };
  const res = createResponse();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'announcement_ack_required');
  assert.equal(nextCalled, false);
});

test('没有强制公告时继续请求', async () => {
  const middleware = requireAnnouncementAccess();
  const req = {
    webSession: { userid: 'u1' },
    app: { locals: { db: { async get() { return null; } } } },
  };
  const res = createResponse();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('门禁查询失败时 fail-closed 503', async () => {
  const middleware = requireAnnouncementAccess();
  const req = {
    webSession: { userid: 'u1' },
    app: { locals: { db: { async get() { throw new Error('db down'); } } } },
  };
  const res = createResponse();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'announcement_access_unavailable');
  assert.equal(nextCalled, false);
});
