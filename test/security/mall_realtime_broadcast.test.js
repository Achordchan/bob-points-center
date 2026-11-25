import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMallRealtimeStats,
  publishMallRealtimeEvent,
  registerMallRealtimeClient,
} from '../../src/services/mallRealtimeService.js';

function makeClient({ ip, scope = 'mall', userid = '' }) {
  const closers = [];
  const chunks = [];
  const req = {
    ip,
    socket: { remoteAddress: ip },
    app: { locals: { cfg: {} }, get: () => false },
    on: (evt, fn) => { if (evt === 'close') closers.push(fn); },
  };
  const res = {
    statusCode: 0,
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    flushHeaders() {},
    json() { return this; },
    write(chunk) { chunks.push(String(chunk)); return true; },
    on: () => {},
  };
  const ok = registerMallRealtimeClient({ req, res, scope, userid });
  return { ok, chunks, close: () => closers.forEach((fn) => fn()) };
}

function eventsNamed(chunks, name) {
  return chunks
    .filter((c) => c.startsWith(`event: ${name}\n`))
    .map((c) => JSON.parse(c.slice(c.indexOf('data: ') + 6)));
}

test('广播推送：所有手机收到同一份竞拍快照，定向推送只到本人', (t) => {
  const alice = makeClient({ ip: '10.0.0.1', userid: 'alice' });
  const bob = makeClient({ ip: '10.0.0.2', userid: 'bob' });
  const screen = makeClient({ ip: '10.0.0.3', scope: 'screen' });
  t.after(() => [alice, bob, screen].forEach((c) => c.close()));
  assert.ok(alice.ok && bob.ok && screen.ok);
  assert.equal(getMallRealtimeStats().total >= 3, true);

  const snapshot = { activity: { id: 7, current_price: 130, bid_count: 2 }, bid: { id: 9, amount: 130 } };
  publishMallRealtimeEvent('auction_changed', { activity_id: 7, reason: 'bid', ...snapshot });
  for (const c of [alice, bob, screen]) {
    const got = eventsNamed(c.chunks, 'auction_changed');
    assert.equal(got.length, 1);
    assert.deepEqual(got[0], { activity_id: 7, reason: 'bid', ...snapshot });
  }

  publishMallRealtimeEvent('balance_changed', { userid: 'alice', reason: 'auction_outbid_refund' });
  assert.equal(eventsNamed(alice.chunks, 'balance_changed').length, 1);
  assert.deepEqual(eventsNamed(alice.chunks, 'balance_changed')[0], { userid: 'alice', reason: 'auction_outbid_refund' });
  assert.equal(eventsNamed(bob.chunks, 'balance_changed').length, 0);
  assert.equal(eventsNamed(screen.chunks, 'balance_changed').length, 0);

  publishMallRealtimeEvent('screen_changed', { scopes: ['screen'], reason: 'red_packet' });
  assert.equal(eventsNamed(screen.chunks, 'screen_changed').length, 1);
  assert.deepEqual(eventsNamed(screen.chunks, 'screen_changed')[0], { reason: 'red_packet' });
  assert.equal(eventsNamed(alice.chunks, 'screen_changed').length, 0);
});

test('实时连接上限在运行时读取环境变量（.env 晚于模块导入加载也能生效）', (t) => {
  const prev = process.env.SSE_MAX_PER_IP;
  t.after(() => {
    if (prev === undefined) delete process.env.SSE_MAX_PER_IP;
    else process.env.SSE_MAX_PER_IP = prev;
  });

  process.env.SSE_MAX_PER_IP = '2';
  const a = makeClient({ ip: '10.9.9.9', userid: 'u1' });
  const b = makeClient({ ip: '10.9.9.9', userid: 'u2' });
  const c = makeClient({ ip: '10.9.9.9', userid: 'u3' });
  t.after(() => [a, b, c].forEach((x) => x.close()));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(c.ok, false, '超过上限的第 3 条被拒');

  process.env.SSE_MAX_PER_IP = '3';
  const d = makeClient({ ip: '10.9.9.9', userid: 'u4' });
  t.after(() => d.close());
  assert.equal(d.ok, true, '调高后无需重新导入模块即生效');
  assert.equal(getMallRealtimeStats().maxPerIp, 3);

  process.env.SSE_MAX_PER_IP = 'abc';
  assert.equal(getMallRealtimeStats().maxPerIp, 20, '非法值回落默认');
});
