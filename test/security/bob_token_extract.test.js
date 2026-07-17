import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBobToken } from '../../src/middleware/requireBobToken.js';

test('优先 Header，忽略 query 中的 bob_token', () => {
  const req = {
    header(name) {
      if (String(name).toLowerCase() === 'x-bob-token') return 'from-header';
      return '';
    },
    headers: { 'x-bob-token': 'from-header' },
    query: { bob_token: 'from-query' },
    body: { bob_token: 'from-body' },
  };
  assert.equal(extractBobToken(req, { allowBody: true }), 'from-header');
  assert.equal(extractBobToken(req, { allowBody: false }), 'from-header');
});

test('无 Header 时 GET 不读 body/query', () => {
  const req = {
    header() { return ''; },
    headers: {},
    query: { bob_token: 'from-query' },
    body: { bob_token: 'from-body' },
  };
  assert.equal(extractBobToken(req, { allowBody: false }), '');
});

test('无 Header 时 POST 可读 body', () => {
  const req = {
    header() { return ''; },
    headers: {},
    query: { bob_token: 'from-query' },
    body: { bob_token: 'from-body' },
  };
  assert.equal(extractBobToken(req, { allowBody: true }), 'from-body');
});
