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

test('年会备份资金关系校验：未发放奖励必须挂在同一活动、类型一致的奖池上', () => {
  const base = {
    gala_events: [{ id: 10, total_budget: 0 }, { id: 20, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 10, is_reserved: 0, budget: 100, spent: 50 }, { id: 2, event_id: 10, is_reserved: 1, budget: 50 }, { id: 3, event_id: 20, is_reserved: 0, budget: 10 }],
    gala_participants: [{ id: 1, event_id: 10 }],
    gala_rounds: [{ id: 5, event_id: 10, pool_id: 1, prize_type: 'coin', amount_each: 50 }, { id: 6, event_id: 10, pool_id: null, prize_type: 'none', amount_each: 0 }],
    gala_round_winners: [
      { id: 1, round_id: 5, event_id: 10, amount: 50, pool_id: 1, awarded_at: null },
      { id: 2, round_id: 6, event_id: 10, amount: 0, pool_id: null, awarded_at: null },
      { id: 3, round_id: 5, event_id: 10, userid: 'u3', amount: 50, pool_id: 1, awarded_at: 1700000000, ledger_id: 900 },
      { id: 7, round_id: 5, event_id: 10, amount: 30, pool_id: 2, is_reserved: 1, awarded_at: null },
    ],
    gala_reserved_slots: [
      { id: 1, event_id: 10, amount: 20, pool_id: 2, status: 'pending' },
      { id: 2, event_id: 10, amount: 20, pool_id: 2, status: 'used', used_round_id: 5 },
    ],
    ledger: [{ id: 900, userid: 'u3', delta: 50, ref_id: 'GALA_W3' }, { id: 901, userid: 'u9', delta: 5, ref_id: 'ADMIN_X' }],
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
  const tags = ['gala_round_winners#4', 'gala_round_winners#5', 'gala_round_winners#6', 'gala_round_winners#8', 'gala_round_winners#9', 'gala_reserved_slots#3'];
  assert.equal(errors.length, tags.length, errors.join('\n'));
  for (const tag of tags) assert.ok(errors.some((e) => e.startsWith(tag)), tag);
});

test('年会备份引用校验：子记录引用的活动必须在备份中', () => {
  const snap = {
    gala_events: [],
    gala_pools: [{ id: 77, event_id: 3, is_reserved: 0, budget: 10 }],
    gala_participants: [],
    gala_rounds: [],
    gala_round_winners: [],
    gala_reserved_slots: [{ id: 5, event_id: 3, amount: 0, status: 'used', used_round_id: 42 }],
  };
  const errors = findGalaFundingErrors(snap);
  assert.ok(errors.some((e) => e.startsWith('gala_pools#77')), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#5') && e.includes('活动')), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#5') && e.includes('轮次')), errors.join('\n'));
});

test('年会备份预算校验：员工奖池合计不能超过活动总预算，预留奖池不计入', () => {
  const snap = {
    gala_events: [{ id: 1, total_budget: 100 }, { id: 2, total_budget: 0 }],
    gala_pools: [
      { id: 1, event_id: 1, is_reserved: 0, budget: 80 },
      { id: 2, event_id: 1, is_reserved: 0, budget: 80 },
      { id: 3, event_id: 1, is_reserved: 1, budget: 999 },
      { id: 4, event_id: 2, is_reserved: 0, budget: 5000 },
    ],
    gala_participants: [], gala_rounds: [], gala_round_winners: [], gala_reserved_slots: [],
  };
  const errors = findGalaFundingErrors(snap);
  assert.deepEqual(errors.length, 1, errors.join('\n'));
  assert.ok(errors[0].startsWith('gala_events#1'));
  snap.gala_pools[1].budget = 20;
  assert.deepEqual(findGalaFundingErrors(snap), []);
});

test('年会备份流水校验：已有发放流水的中奖记录必须已标记发放', () => {
  const snap = {
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, pool_id: 1, prize_type: 'coin', amount_each: 10 }],
    gala_round_winners: [{ id: 11, round_id: 1, event_id: 1, amount: 10, pool_id: 1, awarded_at: null }],
    gala_reserved_slots: [],
    ledger: [{ id: 1, ref_id: 'GALA_W11' }, { id: 2, ref_id: 'GALA_W12' }],
  };
  const errors = findGalaFundingErrors(snap);
  assert.equal(errors.length, 2, errors.join('\n'));
  // 没有任何年会表、流水里却有年会发放：不是真正的旧备份
  const legacy = { ledger: [{ id: 1, ref_id: 'GALA_W11' }] };
  assert.equal(findGalaFundingErrors(legacy).length, 1);
  assert.deepEqual(findGalaFundingErrors({ ledger: [{ id: 1, ref_id: 'ADMIN_1' }] }), []);
});

test('年会备份逐笔核对：流水收款人/金额/ledger_id、重复流水、奖池支出与轮次配置', () => {
  const ok = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 20 }, { id: 2, event_id: 1, is_reserved: 0, budget: 100, spent: 0 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, pool_id: 1, prize_type: 'coin', amount_each: 10 }],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'a', amount: 10, pool_id: 1, awarded_at: 1, ledger_id: 101 },
      { id: 2, round_id: 1, event_id: 1, userid: 'b', amount: 10, pool_id: 1, awarded_at: 1, ledger_id: 102 },
    ],
    gala_reserved_slots: [],
    ledger: [
      { id: 101, userid: 'a', delta: 10, ref_id: 'GALA_W1' },
      { id: 102, userid: 'b', delta: 10, ref_id: 'GALA_W2' },
    ],
  });
  assert.deepEqual(findGalaFundingErrors(ok()), []);

  const wrongPayee = ok();
  wrongPayee.ledger[1].userid = 'a';
  assert.ok(findGalaFundingErrors(wrongPayee).some((e) => e.includes('收款人或金额')));

  const dupLedger = ok();
  dupLedger.ledger.push({ id: 103, userid: 'a', delta: 10, ref_id: 'GALA_W1' });
  assert.ok(findGalaFundingErrors(dupLedger).some((e) => e.includes('重复指向')));

  const wrongLink = ok();
  wrongLink.gala_round_winners[0].ledger_id = 102;
  assert.ok(findGalaFundingErrors(wrongLink).some((e) => e.includes('ledger_id')));

  const underSpent = ok();
  underSpent.gala_pools[0].spent = 0;
  assert.ok(findGalaFundingErrors(underSpent).some((e) => e.startsWith('gala_pools#1') && e.includes('支出')));

  const offRound = ok();
  offRound.gala_round_winners.push({ id: 3, round_id: 1, event_id: 1, userid: 'c', amount: 100, pool_id: 2, awarded_at: null });
  assert.ok(findGalaFundingErrors(offRound).some((e) => e.startsWith('gala_round_winners#3') && e.includes('轮次')));
});

test('年会备份：金额精度、预留标记取值、已发放凭据与错过轮次的待用名额', () => {
  const ok = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 10 }, { id: 2, event_id: 1, is_reserved: 1, budget: 50, spent: 0 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, pool_id: 1, prize_type: 'coin', amount_each: 10 }],
    gala_round_winners: [{ id: 1, round_id: 1, event_id: 1, userid: 'a', amount: 10, pool_id: 1, awarded_at: 1, ledger_id: 55 }],
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 2, userid: 'k', pool_id: 2, amount: 5, status: 'pending' }],
    ledger: [],
  });
  assert.deepEqual(findGalaFundingErrors(ok()), []);

  const big = ok();
  big.gala_pools[0].budget = '9007199254740993';
  assert.ok(findGalaFundingErrors(big).some((e) => e.includes('安全范围')));

  const flag = ok();
  flag.gala_round_winners[0].is_reserved = 2;
  assert.ok(findGalaFundingErrors(flag).some((e) => e.includes('is_reserved=2')));

  const noReceipt = ok();
  noReceipt.gala_round_winners[0].ledger_id = null;
  assert.ok(findGalaFundingErrors(noReceipt).some((e) => e.includes('没有 ledger_id')));

  const missed = ok();
  missed.gala_reserved_slots[0].round_no = 1;
  assert.ok(findGalaFundingErrors(missed).some((e) => e.includes('已经抽过')));
});

test('年会备份：标识符必须是安全范围内的正整数', () => {
  const snap = {
    gala_events: [{ id: '9007199254740993', total_budget: 0 }, { id: '9007199254740992', total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: '9007199254740993', is_reserved: 0, budget: 1, spent: 0 }],
    gala_participants: [], gala_rounds: [], gala_round_winners: [], gala_reserved_slots: [],
  };
  const errors = findGalaFundingErrors(snap);
  assert.ok(errors.some((e) => e.startsWith('gala_events#9007199254740993') && e.includes('id=')), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('gala_pools#1') && e.includes('event_id=')), errors.join('\n'));
});

test('年会备份：待用名额必须落在可抽签环节', () => {
  const snap = {
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [], gala_participants: [], gala_rounds: [], gala_round_winners: [],
    gala_reserved_slots: [
      { id: 1, event_id: 1, segment: 'lottery', round_no: 1, amount: 0, status: 'pending' },
      { id: 2, event_id: 1, segment: 'lotery', round_no: 1, amount: 0, status: 'pending' },
      { id: 3, event_id: 1, segment: 'danmaku', round_no: 1, amount: 0, status: 'pending' },
      { id: 4, event_id: 1, segment: 'lotery', round_no: 1, amount: 0, status: 'cancelled' },
    ],
  };
  const errors = findGalaFundingErrors(snap);
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#2')));
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#3')));
});
