import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPathPermission } from '../../src/services/adminPermissionService.js';
import { pickRandom } from '../../src/services/galaService.js';
import { findGalaFundingErrors } from '../../src/routes/admin/backupRoutes.js';

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

test('年会六张表纳入全量备份，且必须整组导入', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/routes/admin/backupRoutes.js', import.meta.url), 'utf8');
  const fullTablesBlock = source.match(/const FULL_TABLES = \[[\s\S]*?\n  \];/)?.[0] || '';
  for (const name of ['gala_events', 'gala_pools', 'gala_participants', 'gala_rounds', 'gala_round_winners', 'gala_reserved_slots']) {
    assert.match(fullTablesBlock, new RegExp(`'${name}'`));
  }
  assert.match(source, /for \(const table of GALA_BACKUP_TABLES\) optionalFullTables\.add\(table\.name\)/);
  assert.match(source, /年会数据必须整组导入/);
  assert.match(source, /合并导入存在年会数据 ID 冲突/);
});

test('年会备份资金关系校验：未发放奖励必须挂在同一活动的奖池上', () => {
  const base = {
    gala_pools: [{ id: 1, event_id: 10, is_reserved: 0 }, { id: 2, event_id: 10, is_reserved: 1 }, { id: 3, event_id: 20, is_reserved: 0 }],
    gala_rounds: [{ id: 5, event_id: 10 }],
    gala_round_winners: [
      { id: 1, round_id: 5, event_id: 10, amount: 50, pool_id: 1, awarded_at: null },
      { id: 2, round_id: 5, event_id: 10, amount: 0, pool_id: null, awarded_at: null },
      { id: 3, round_id: 5, event_id: 10, amount: 50, pool_id: null, awarded_at: 1700000000 },
      { id: 7, round_id: 5, event_id: 10, amount: 30, pool_id: 2, is_reserved: 1, awarded_at: null },
    ],
    gala_reserved_slots: [
      { id: 1, event_id: 10, amount: 20, pool_id: 2, status: 'pending' },
      { id: 2, event_id: 10, amount: 20, pool_id: null, status: 'used' },
    ],
  };
  assert.deepEqual(findGalaFundingErrors(base), []);
  const bad = structuredClone(base);
  bad.gala_round_winners.push({ id: 4, round_id: 5, event_id: 10, amount: 50, pool_id: null, awarded_at: null });
  bad.gala_round_winners.push({ id: 5, round_id: 5, event_id: 10, amount: 50, pool_id: 3, awarded_at: null });
  bad.gala_round_winners.push({ id: 6, round_id: 99, event_id: 10, amount: 0, pool_id: null, awarded_at: null });
  bad.gala_round_winners.push({ id: 8, round_id: 5, event_id: 10, amount: 30, pool_id: 1, is_reserved: 1, awarded_at: null });
  bad.gala_round_winners.push({ id: 9, round_id: 5, event_id: 10, amount: 30, pool_id: 2, is_reserved: 0, awarded_at: null });
  bad.gala_reserved_slots.push({ id: 3, event_id: 10, amount: 20, pool_id: 1, status: 'pending' });
  const errors = findGalaFundingErrors(bad);
  assert.equal(errors.length, 6, errors.join('\n'));
  for (const tag of ['gala_round_winners#4', 'gala_round_winners#5', 'gala_round_winners#6', 'gala_round_winners#8', 'gala_round_winners#9', 'gala_reserved_slots#3']) {
    assert.ok(errors.some((e) => e.startsWith(tag)), tag);
  }
});
