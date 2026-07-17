import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientIp } from '../../src/utils/clientIp.js';

test('不信任代理时忽略 X-Forwarded-For 与 req.ip', () => {
  const req = {
    ip: '1.2.3.4',
    headers: { 'x-forwarded-for': '1.2.3.4' },
    socket: { remoteAddress: '10.0.0.8' },
  };
  assert.equal(resolveClientIp(req, { trustProxy: false }), '10.0.0.8');
});

test('信任代理时使用 Express 已校验的 req.ip（非 XFF 左侧）', () => {
  const req = {
    // Express trust proxy=1 后，伪造左侧不会进入 req.ip
    ip: '203.0.113.9',
    headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
    socket: { remoteAddress: '10.0.0.8' },
  };
  assert.equal(resolveClientIp(req, { trustProxy: true }), '203.0.113.9');
});

test('信任代理但无 req.ip 时回退 socket，不读 XFF 左侧', () => {
  const req = {
    headers: { 'x-forwarded-for': '1.2.3.4' },
    socket: { remoteAddress: '10.0.0.8' },
  };
  assert.equal(resolveClientIp(req, { trustProxy: true }), '10.0.0.8');
});
