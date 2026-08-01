import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldStartDingtalkStream } from '../../src/app.js';
import { normalizeDnsResultOrder } from '../../src/utils/network.js';

test('外部接口默认优先 IPv4，可显式恢复系统 DNS 顺序', () => {
  assert.equal(normalizeDnsResultOrder(), 'ipv4first');
  assert.equal(normalizeDnsResultOrder('ipv4first'), 'ipv4first');
  assert.equal(normalizeDnsResultOrder('verbatim'), 'verbatim');
  assert.equal(normalizeDnsResultOrder('invalid'), 'ipv4first');
});

test('钉钉 Stream 可独立禁用，不影响保留 OAuth 凭据', () => {
  const enabled = { dingtalk: { appKey: 'key', appSecret: 'secret', streamEnabled: true } };
  const disabled = { dingtalk: { appKey: 'key', appSecret: 'secret', streamEnabled: false } };
  assert.equal(shouldStartDingtalkStream(enabled), true);
  assert.equal(shouldStartDingtalkStream(disabled), false);
  assert.equal(shouldStartDingtalkStream({ dingtalk: { appKey: 'key', appSecret: '' } }), false);
});
