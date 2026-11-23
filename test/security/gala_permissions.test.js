import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPathPermission } from '../../src/services/adminPermissionService.js';
import { pickRandom } from '../../src/services/galaService.js';

test('年会预留名额与预留奖池只允许超级管理员', () => {
  for (const [m, p] of [
    ['GET', '/gala/reserved'],
    ['POST', '/gala/reserved/create'],
    ['POST', '/gala/reserved/cancel'],
    ['POST', '/gala/reserved/pools/create'],
    ['POST', '/GALA/Reserved/create'],
  ]) {
    assert.equal(matchPathPermission(m, p), 'super', `${m} ${p}`);
  }
});

test('年会抽签与发币需要现场操作权限，配置需要编辑权限', () => {
  assert.equal(matchPathPermission('POST', '/gala/rounds/draw'), 'gala:operate');
  assert.equal(matchPathPermission('POST', '/gala/rounds/grant'), 'gala:operate');
  assert.equal(matchPathPermission('POST', '/gala/pools/create'), 'gala:edit');
  assert.equal(matchPathPermission('POST', '/gala/events/update'), 'gala:edit');
  assert.equal(matchPathPermission('GET', '/gala/rounds'), 'gala:view');
  assert.equal(matchPathPermission('GET', '/gala/events/detail'), 'gala:view');
});

test('pickRandom 不重复、数量受限、不修改原数组', () => {
  const src = [1, 2, 3, 4, 5, 6, 7, 8];
  const copy = [...src];
  for (let i = 0; i < 200; i += 1) {
    const out = pickRandom(src, 5);
    assert.equal(out.length, 5);
    assert.equal(new Set(out).size, 5);
    assert.ok(out.every((x) => src.includes(x)));
  }
  assert.deepEqual(src, copy);
  assert.equal(pickRandom(src, 20).length, 8);
  assert.equal(pickRandom([], 3).length, 0);
});

test('pickRandom 近似均匀', () => {
  const hits = new Map();
  const n = 20000;
  for (let i = 0; i < n; i += 1) {
    const [x] = pickRandom(['a', 'b', 'c', 'd'], 1);
    hits.set(x, (hits.get(x) || 0) + 1);
  }
  for (const key of ['a', 'b', 'c', 'd']) {
    const share = hits.get(key) / n;
    assert.ok(share > 0.22 && share < 0.28, `${key} 占比 ${share}`);
  }
});
