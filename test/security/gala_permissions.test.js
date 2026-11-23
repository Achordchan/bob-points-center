import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPathPermission } from '../../src/services/adminPermissionService.js';
import { GALA_MAX_RESERVED_SLOTS, pickRandom, serializeGrantResult } from '../../src/services/galaService.js';
import { completeFinishedCoinRounds, findGalaFundingErrors } from '../../src/routes/admin/backupRoutes.js';

// 与导入流程相同：先补齐“奖励已全部到账”的发币轮，再做资金校验。
function importCheck(data) {
  completeFinishedCoinRounds(data);
  return findGalaFundingErrors(data);
}

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
    gala_pools: [{ id: 1, event_id: 10, is_reserved: 0, budget: 500, spent: 50 }, { id: 2, event_id: 10, is_reserved: 1, budget: 50 }, { id: 3, event_id: 20, is_reserved: 0, budget: 100 }],
    gala_participants: [{ id: 1, event_id: 10, userid: 'p1' }, { id: 2, event_id: 10, userid: 'k1' }, { id: 3, event_id: 10, userid: 'k3' }],
    gala_rounds: [{ id: 5, event_id: 10, segment: 'lottery', round_no: 1, draw_count: 10, pool_id: 1, prize_type: 'coin', amount_each: 50 }, { id: 6, event_id: 10, segment: 'game', round_no: 1, draw_count: 1, pool_id: null, prize_type: 'none', amount_each: 0 }],
    gala_round_winners: [
      { id: 1, round_id: 5, event_id: 10, userid: 'w1', amount: 50, pool_id: 1, awarded_at: null },
      { id: 2, round_id: 6, event_id: 10, userid: 'w2', amount: 0, pool_id: null, awarded_at: null },
      { id: 3, round_id: 5, event_id: 10, userid: 'u3', amount: 50, pool_id: 1, awarded_at: 1700000000, ledger_id: 900 },
      { id: 7, round_id: 5, event_id: 10, userid: 'k7', amount: 50, pool_id: 2, is_reserved: 1, awarded_at: null },
    ],
    gala_reserved_slots: [
      { id: 1, event_id: 10, segment: 'lottery', round_no: 9, userid: 'k1', amount: 20, pool_id: 2, status: 'pending' },
      { id: 2, event_id: 10, segment: 'lottery', round_no: 1, userid: 'k7', amount: 50, pool_id: 2, status: 'used', used_round_id: 5 },
    ],
    ledger: [{ id: 900, userid: 'u3', delta: 50, ref_id: 'GALA_W3', reason: '年会奖励·测试' }, { id: 901, userid: 'u9', delta: 5, ref_id: 'ADMIN_X' }],
    accounts: [{ userid: 'u3', balance: 50 }],
  };
  assert.deepEqual(findGalaFundingErrors(base), []);
  const bad = structuredClone(base);
  bad.gala_round_winners.push({ id: 4, round_id: 5, event_id: 10, userid: 'w4', amount: 50, pool_id: null, awarded_at: null });
  bad.gala_round_winners.push({ id: 5, round_id: 5, event_id: 10, userid: 'w5', amount: 50, pool_id: 3, awarded_at: null });
  bad.gala_round_winners.push({ id: 6, round_id: 99, event_id: 10, userid: 'w6', amount: 0, pool_id: null, awarded_at: null });
  bad.gala_round_winners.push({ id: 8, round_id: 5, event_id: 10, userid: 'w8', amount: 30, pool_id: 1, is_reserved: 1, awarded_at: null });
  bad.gala_round_winners.push({ id: 9, round_id: 5, event_id: 10, userid: 'w9', amount: 30, pool_id: 2, is_reserved: 0, awarded_at: null });
  bad.gala_reserved_slots.push({ id: 3, event_id: 10, segment: 'lottery', round_no: 9, userid: 'k3', amount: 20, pool_id: 1, status: 'pending' });
  const errors = findGalaFundingErrors(bad);
  // #5 挂到别的活动的奖池上，那个奖池也因此“欠账”超过已分配额
  const tags = ['gala_rounds#5', 'gala_pools#3', 'gala_round_winners#4', 'gala_round_winners#5', 'gala_round_winners#6', 'gala_round_winners#8', 'gala_round_winners#9', 'gala_reserved_slots#3'];
  for (const tag of tags) assert.ok(errors.some((e) => e.startsWith(tag)), tag);
  assert.ok(errors.every((e) => tags.some((tag) => e.startsWith(tag))), errors.join('\n'));
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
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10 }],
    gala_round_winners: [{ id: 11, round_id: 1, event_id: 1, userid: 'a', amount: 10, pool_id: 1, awarded_at: null }],
    gala_reserved_slots: [],
    ledger: [{ id: 1, userid: 'a', ref_id: 'GALA_W11', delta: 10, reason: '年会奖励·测试' }, { id: 2, ref_id: 'GALA_W12', delta: 10, reason: '年会奖励·测试' }],
  };
  const errors = findGalaFundingErrors(snap);
  // 只有 GALA_W11 指向备份里一条未发放的中奖记录（恢复后会重复发放）；GALA_W12 没有对应中奖记录，按普通流水处理
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.ok(errors[0].startsWith('ledger#1'));
  // 升级前外部发币写入的历史同名流水：收款人不同、金额不同或早于抽签，都不可能是这笔奖励，不算重复发放
  const hist = (patch) => {
    const h = structuredClone(snap);
    h.ledger = [{ id: 1, ref_id: 'GALA_W11', userid: 'a', delta: 10, reason: '年会奖励·历史', created_at: 500 }];
    Object.assign(h.gala_round_winners[0], { userid: 'a', created_at: 100 });
    Object.assign(h.ledger[0], patch);
    return findGalaFundingErrors(h);
  };
  assert.equal(hist({}).length, 1, '收款人、金额一致且晚于抽签：仍按重复发放拒绝');
  assert.deepEqual(hist({ userid: 'b' }), []);
  assert.deepEqual(hist({ delta: 11 }), []);
  assert.deepEqual(hist({ created_at: 99 }), []);
  // 没有年会表的旧备份里，形似年会发放的入账（早期第三方接口可写入）按普通流水处理，备份照常可恢复
  const legacy = { ledger: [{ id: 1, ref_id: 'GALA_W11', delta: 10, reason: '年会奖励·测试' }] };
  assert.deepEqual(findGalaFundingErrors(legacy), []);
  assert.deepEqual(findGalaFundingErrors({ ledger: [{ id: 1, ref_id: 'ADMIN_1' }] }), []);
  // ref_id 恰好是名叫 GALA_W… 的用户（转账对方），原因不是年会奖励：不算年会发放，旧备份照常可恢复
  assert.deepEqual(findGalaFundingErrors({
    ledger: [{ id: 1, ref_id: 'GALA_W11', delta: 5, reason: 'transfer_in' }, { id: 2, ref_id: 'GALA_W11', delta: -5, reason: 'transfer_out' }],
  }), []);
});

test('年会备份逐笔核对：流水收款人/金额/ledger_id、重复流水、奖池支出与轮次配置', () => {
  const ok = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 20 }, { id: 2, event_id: 1, is_reserved: 0, budget: 100, spent: 0 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 2, pool_id: 1, prize_type: 'coin', amount_each: 10 }],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'a', amount: 10, pool_id: 1, awarded_at: 1, ledger_id: 101 },
      { id: 2, round_id: 1, event_id: 1, userid: 'b', amount: 10, pool_id: 1, awarded_at: 1, ledger_id: 102 },
    ],
    gala_reserved_slots: [],
    ledger: [
      { id: 101, userid: 'a', delta: 10, ref_id: 'GALA_W1', reason: '年会奖励·测试' },
      { id: 102, userid: 'b', delta: 10, ref_id: 'GALA_W2', reason: '年会奖励·测试' },
    ],
    accounts: [{ userid: 'a', balance: 10 }, { userid: 'b', balance: 10 }],
  });
  assert.deepEqual(importCheck(ok()), []);

  const wrongPayee = ok();
  wrongPayee.ledger[1].userid = 'a';
  assert.ok(importCheck(wrongPayee).some((e) => e.includes('收款人或金额')));

  // 出处以中奖记录的 ledger_id 为准：已发放并引用 101 的中奖记录，另一条形似的流水只是普通入账，不会再发一次
  const dupLedger = ok();
  dupLedger.ledger.push({ id: 103, userid: 'a', delta: 10, ref_id: 'GALA_W1', reason: '年会奖励·测试' });
  assert.deepEqual(importCheck(dupLedger), []);

  const wrongLink = ok();
  wrongLink.gala_round_winners[0].ledger_id = 102;
  assert.ok(importCheck(wrongLink).some((e) => e.includes('ledger_id')));

  const underSpent = ok();
  underSpent.gala_pools[0].spent = 0;
  assert.ok(importCheck(underSpent).some((e) => e.startsWith('gala_pools#1') && e.includes('支出')));

  const offRound = ok();
  offRound.gala_round_winners.push({ id: 3, round_id: 1, event_id: 1, userid: 'c', amount: 100, pool_id: 2, awarded_at: null });
  assert.ok(importCheck(offRound).some((e) => e.startsWith('gala_round_winners#3') && e.includes('轮次')));
});

test('年会备份：金额精度、预留标记取值、已发放凭据与错过轮次的待用名额', () => {
  const ok = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 10 }, { id: 2, event_id: 1, is_reserved: 1, budget: 50, spent: 0 }],
    gala_participants: [{ id: 1, event_id: 1, userid: 'k' }],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10 }],
    gala_round_winners: [{ id: 1, round_id: 1, event_id: 1, userid: 'a', amount: 10, pool_id: 1, awarded_at: 1, ledger_id: 55 }],
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 2, userid: 'k', pool_id: 2, amount: 5, status: 'pending' }],
    ledger: [],
  });
  assert.deepEqual(importCheck(ok()), []);

  const big = ok();
  big.gala_pools[0].budget = '9007199254740993';
  assert.ok(importCheck(big).some((e) => e.includes('安全范围')));

  const flag = ok();
  flag.gala_round_winners[0].is_reserved = 2;
  assert.ok(importCheck(flag).some((e) => e.includes('is_reserved=2')));

  const noReceipt = ok();
  noReceipt.gala_round_winners[0].ledger_id = null;
  assert.ok(importCheck(noReceipt).some((e) => e.includes('没有 ledger_id')));

  const missed = ok();
  missed.gala_reserved_slots[0].round_no = 1;
  assert.ok(importCheck(missed).some((e) => e.includes('已经抽过')));
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
    gala_pools: [{ id: 9, event_id: 1, is_reserved: 1, budget: 10, spent: 0 }], gala_participants: [{ id: 1, event_id: 1, userid: 'k' }], gala_rounds: [], gala_round_winners: [],
    gala_reserved_slots: [
      { id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k', amount: 0, pool_id: 9, status: 'pending' },
      { id: 2, event_id: 1, segment: 'lotery', round_no: 1, userid: 'k', amount: 0, pool_id: 9, status: 'pending' },
      { id: 3, event_id: 1, segment: 'danmaku', round_no: 1, userid: 'k', amount: 0, pool_id: 9, status: 'pending' },
      { id: 4, event_id: 1, segment: 'lotery', round_no: 1, amount: 0, status: 'cancelled' },
    ],
  };
  const errors = findGalaFundingErrors(snap);
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#2')));
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#3')));
});

test('年会备份：预留中奖记录必须对应已使用的预留名额', () => {
  const ok = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 1, budget: 100, spent: 0 }, { id: 3, event_id: 1, is_reserved: 0, budget: 8, spent: 0 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, prize_type: 'coin', pool_id: 3, amount_each: 8 }],
    gala_round_winners: [{ id: 1, round_id: 1, event_id: 1, userid: 'k', amount: 8, pool_id: 1, is_reserved: 1, awarded_at: null }],
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k', amount: 8, pool_id: 1, status: 'used', used_round_id: 1 }],
  });
  assert.deepEqual(findGalaFundingErrors(ok()), []);
  for (const mutate of [
    (x) => { x.gala_reserved_slots = []; },
    (x) => { x.gala_round_winners[0].userid = 'someone'; },
    (x) => { x.gala_round_winners[0].amount = 80; },
    (x) => { x.gala_reserved_slots[0].status = 'cancelled'; },
    // 名额预定的是第 2 轮，却挂在第 1 轮上
    (x) => { x.gala_reserved_slots[0].round_no = 2; },
    (x) => { x.gala_reserved_slots[0].segment = 'game'; },
  ]) {
    const snap = ok();
    mutate(snap);
    assert.ok(findGalaFundingErrors(snap).some((e) => e.includes('找不到对应的已使用预留名额')), JSON.stringify(snap.gala_round_winners));
  }
});

test('年会备份：每轮中奖人数不超过抽签人数、已分配额不超预算、预留名额不超上限', () => {
  const ok = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 20, spent: 0 }, { id: 2, event_id: 1, is_reserved: 1, budget: 50, spent: 0 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 2, pool_id: 1, prize_type: 'coin', amount_each: 10 }],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'a', amount: 10, pool_id: 1, awarded_at: null },
      { id: 2, round_id: 1, event_id: 1, userid: 'b', amount: 10, pool_id: 1, awarded_at: null },
    ],
    gala_reserved_slots: [],
    ledger: [],
  });
  assert.deepEqual(findGalaFundingErrors(ok()), []);

  const extra = ok();
  extra.gala_round_winners.push({ id: 3, round_id: 1, event_id: 1, userid: 'c', amount: 10, pool_id: 1, awarded_at: null });
  assert.ok(findGalaFundingErrors(extra).some((e) => e.startsWith('gala_rounds#1') && e.includes('超过抽签人数')));

  // 用户重置后少于抽签人数是正常的
  const fewer = ok();
  fewer.gala_round_winners.pop();
  assert.deepEqual(findGalaFundingErrors(fewer), []);

  const over = ok();
  over.gala_rounds[0].draw_count = 3;
  assert.ok(findGalaFundingErrors(over).some((e) => e.startsWith('gala_pools#1') && e.includes('已分配额')));

  const many = ok();
  for (let i = 1; i <= GALA_MAX_RESERVED_SLOTS + 1; i += 1) {
    many.gala_reserved_slots.push({ id: i, event_id: 1, segment: 'game', round_no: i, userid: `k${i}`, amount: 0, status: 'pending' });
  }
  assert.ok(findGalaFundingErrors(many).some((e) => e.startsWith('gala_events#1') && e.includes('预留名额')));
  for (const bad of [-1, 0, 101, 1.5, true, '2x']) {
    const snap = ok();
    snap.gala_rounds[0].draw_count = bad;
    assert.ok(findGalaFundingErrors(snap).some((e) => e.includes('draw_count')), String(bad));
  }
  const badNo = ok();
  badNo.gala_rounds[0].round_no = 2147483648;
  assert.ok(findGalaFundingErrors(badNo).some((e) => e.includes('round_no')));

  // 有付款凭据却没有 awarded_at：恢复后会被再付一次
  const reopened = ok();
  reopened.gala_round_winners[0].ledger_id = 77;
  assert.ok(findGalaFundingErrors(reopened).some((e) => e.startsWith('gala_round_winners#1') && e.includes('重复发放')));

  // 员工奖池：实际支出 + 待发普通奖励不能超过已分配额（预算 100、支出 80、没有轮次）
  const phantom = ok();
  phantom.gala_pools[0].budget = 100;
  phantom.gala_pools[0].spent = 80;
  phantom.gala_rounds = [];
  phantom.gala_round_winners = [];
  assert.ok(findGalaFundingErrors(phantom).some((e) => e.startsWith('gala_pools#1') && e.includes('已分配额')));

  // 员工奖池余额不够付待发奖励
  const short = ok();
  short.gala_pools[0].spent = 15;
  assert.ok(findGalaFundingErrors(short).some((e) => e.startsWith('gala_pools#1') && e.includes('待发奖励')));

  // 已使用的名额必须关联轮次
  const dangling = ok();
  dangling.gala_reserved_slots.push({ id: 9, event_id: 1, segment: 'game', round_no: 1, userid: 'k', amount: 0, status: 'used', used_round_id: null });
  assert.ok(findGalaFundingErrors(dangling).some((e) => e.startsWith('gala_reserved_slots#9') && e.includes('没有关联轮次')));

  // 奖品配置与在线抽签一致
  const noneWithPool = ok();
  noneWithPool.gala_rounds[0].prize_type = 'none';
  noneWithPool.gala_round_winners = [];
  assert.ok(findGalaFundingErrors(noneWithPool).some((e) => e.startsWith('gala_rounds#1') && e.includes('无币轮')));
  const coinZero = ok();
  coinZero.gala_rounds[0].amount_each = 0;
  assert.ok(findGalaFundingErrors(coinZero).some((e) => e.startsWith('gala_rounds#1') && e.includes('单价')));

  // 同一轮两个已使用名额
  const twoUsed = ok();
  twoUsed.gala_pools.push({ id: 2, event_id: 1, is_reserved: 1, budget: 50, spent: 0 });
  twoUsed.gala_reserved_slots.push(
    { id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k1', amount: 0, status: 'used', used_round_id: 1 },
    { id: 2, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k2', amount: 0, status: 'used', used_round_id: 1 },
  );
  assert.ok(findGalaFundingErrors(twoUsed).some((e) => e.startsWith('gala_reserved_slots#2') && e.includes('每轮最多 1 个')));

  // 完成状态与待发记录矛盾
  const allDone = ok();
  allDone.gala_rounds[0].status = 'granted';
  allDone.gala_rounds[0].granted_at = 1;
  assert.ok(findGalaFundingErrors(allDone).some((e) => e.startsWith('gala_rounds#1') && e.includes('整轮发放完成')));
  // status 与 granted_at 必须同时成立或同时为空
  const noTime = ok();
  noTime.gala_rounds[0].status = 'granted';
  noTime.gala_rounds[0].granted_at = null;
  assert.ok(findGalaFundingErrors(noTime).some((e) => e.startsWith('gala_rounds#1') && e.includes('不一致')));
  const timeOnDrawn = ok();
  timeOnDrawn.gala_rounds[0].granted_at = 1;
  assert.ok(findGalaFundingErrors(timeOnDrawn).some((e) => e.startsWith('gala_rounds#1') && e.includes('不一致')));
});

test('年会备份：只剩预留奖励待发时整轮仍是 drawn，不能标记完成', () => {
  const snap = {
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 20, spent: 10 }, { id: 2, event_id: 1, is_reserved: 1, budget: 50, spent: 0 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 2, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' }],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'a', amount: 10, pool_id: 1, awarded_at: 1, ledger_id: 9 },
      { id: 2, round_id: 1, event_id: 1, userid: 'k', amount: 10, pool_id: 2, is_reserved: 1, awarded_at: null },
    ],
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k', amount: 10, pool_id: 2, status: 'used', used_round_id: 1 }],
    ledger: [],
  };
  assert.deepEqual(findGalaFundingErrors(snap), []);
  const marked = structuredClone(snap);
  marked.gala_rounds[0].status = 'granted';
  marked.gala_rounds[0].granted_at = 5;
  assert.ok(findGalaFundingErrors(marked).some((e) => e.startsWith('gala_rounds#1') && e.includes('整轮发放完成')));
});

test('年会备份：已发放的正数奖励和已使用名额同样必须挂在奖池上', () => {
  const ok = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 2, event_id: 1, is_reserved: 1, budget: 50, spent: 8 }, { id: 3, event_id: 1, is_reserved: 0, budget: 8, spent: 0 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, prize_type: 'coin', pool_id: 3, amount_each: 8, status: 'granted', granted_at: 1 }],
    gala_round_winners: [{ id: 1, round_id: 1, event_id: 1, userid: 'k', amount: 8, pool_id: 2, is_reserved: 1, awarded_at: 1, ledger_id: 9 }],
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k', amount: 8, pool_id: 2, status: 'used', used_round_id: 1 }],
    ledger: [{ id: 9, userid: 'k', delta: 8, ref_id: 'GALA_W1', reason: '年会奖励·测试' }],
    accounts: [{ userid: 'k', balance: 8 }],
  });
  assert.deepEqual(importCheck(ok()), []);
  // 已发放的预留奖励和对应名额都去掉奖池：这笔钱不在任何预算里
  const paid = ok();
  paid.gala_round_winners[0].pool_id = null;
  paid.gala_reserved_slots[0].pool_id = null;
  const errors = importCheck(paid);
  assert.ok(errors.some((e) => e.startsWith('gala_round_winners#1') && e.includes('缺少同一活动的预留奖池')), errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('缺少同一活动的预留奖池')), errors.join('\n'));
  // 已取消的名额不再要求奖池
  const cancelled = ok();
  cancelled.gala_round_winners = [];
  cancelled.gala_pools[0].spent = 0;
  cancelled.ledger = [];
  cancelled.gala_rounds[0].status = 'drawn';
  cancelled.gala_rounds[0].granted_at = null;
  cancelled.gala_reserved_slots[0] = { id: 1, event_id: 1, segment: 'lottery', round_no: 2, userid: 'k', amount: 8, pool_id: null, status: 'cancelled' };
  // 待用名额必须指定预留奖池
  const noPool = structuredClone(cancelled);
  noPool.gala_reserved_slots[0].status = 'pending';
  noPool.gala_reserved_slots[0].amount = 0;
  assert.ok(importCheck(noPool).some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('缺少同一活动的预留奖池')));
  assert.deepEqual(importCheck(cancelled), []);
});

test('年会备份：已使用名额缺少预留中奖记录时，本轮必须空出一个位置', () => {
  const snap = (winners) => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 10, spent: 0 }, { id: 2, event_id: 1, is_reserved: 1, budget: 50, spent: 0 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' }],
    gala_round_winners: winners,
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k', amount: 10, pool_id: 2, status: 'used', used_round_id: 1 }],
    ledger: [],
  });
  // 预留记录被用户重置删掉、位置空着：合法
  assert.deepEqual(importCheck(snap([])), []);
  // 中奖记录不在时仍按关联轮次核对名额金额（本轮单价 10）
  const wrongAmount = snap([]);
  wrongAmount.gala_reserved_slots[0].amount = 8;
  assert.ok(importCheck(wrongAmount).some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('奖励不一致')));
  // 单人轮：名额已使用，唯一的位置却是另一个普通中奖人
  const errors = importCheck(snap([{ id: 1, round_id: 1, event_id: 1, userid: 'u', amount: 10, pool_id: 1, awarded_at: null }]));
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('名额已被占满')), errors.join('\n'));
});

test('年会备份：预留中奖记录的金额与本轮普通奖励一致', () => {
  const ok = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 20, spent: 0 }, { id: 2, event_id: 1, is_reserved: 1, budget: 50, spent: 0 }],
    gala_participants: [],
    gala_rounds: [
      { id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 2, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
      { id: 2, event_id: 1, segment: 'game', round_no: 1, draw_count: 1, pool_id: null, prize_type: 'none', amount_each: 0, status: 'drawn' },
    ],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'a', amount: 10, pool_id: 1, awarded_at: null },
      { id: 2, round_id: 1, event_id: 1, userid: 'k', amount: 10, pool_id: 2, is_reserved: 1, awarded_at: null },
      { id: 3, round_id: 2, event_id: 1, userid: 'k', amount: 0, pool_id: null, is_reserved: 1, awarded_at: null },
    ],
    gala_reserved_slots: [
      { id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k', amount: 10, pool_id: 2, status: 'used', used_round_id: 1 },
      { id: 2, event_id: 1, segment: 'game', round_no: 1, userid: 'k', amount: 0, pool_id: null, status: 'used', used_round_id: 2 },
    ],
    ledger: [],
  });
  assert.deepEqual(findGalaFundingErrors(ok()), []);
  // 发币轮里预留奖励比别人多
  const more = ok();
  more.gala_round_winners[1].amount = 30;
  more.gala_reserved_slots[0].amount = 30;
  assert.ok(findGalaFundingErrors(more).some((e) => e.startsWith('gala_round_winners#2') && e.includes('本轮奖励不一致')));
  // 无币轮里预留对象却有币
  const paidInNone = ok();
  paidInNone.gala_round_winners[2].amount = 5;
  paidInNone.gala_round_winners[2].pool_id = 2;
  paidInNone.gala_reserved_slots[1].amount = 5;
  paidInNone.gala_reserved_slots[1].pool_id = 2;
  assert.ok(findGalaFundingErrors(paidInNone).some((e) => e.startsWith('gala_round_winners#3') && e.includes('本轮奖励不一致')));
});

test('年会备份：两条中奖记录不能共用同一付款凭据', () => {
  const snap = {
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 20, spent: 20 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 2, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'granted', granted_at: 1 }],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'a', amount: 10, pool_id: 1, awarded_at: 1, ledger_id: 77 },
      { id: 2, round_id: 1, event_id: 1, userid: 'b', amount: 10, pool_id: 1, awarded_at: 1, ledger_id: 78 },
    ],
    gala_reserved_slots: [],
    ledger: [],
  };
  assert.deepEqual(findGalaFundingErrors(snap), []);
  snap.gala_round_winners[1].ledger_id = 77;
  assert.ok(findGalaFundingErrors(snap).some((e) => e.startsWith('gala_round_winners#2') && e.includes('共用付款凭据')));
});

test('外部发币只拒绝与年会发放格式完全相同的引用号（GALA_W<正整数>）', async () => {
  const { assertExternalRefIdAllowed, RESERVED_REF_ID_ERROR } = await import('../../src/services/bobOpsService.js');
  for (const ref of ['GALA_W1', 'GALA_W990001']) {
    assert.throws(() => assertExternalRefIdAllowed(ref), (e) => e.message === RESERVED_REF_ID_ERROR, ref);
  }
  for (const ref of [undefined, null, 'ORDER_1', 'GALA1', 'GALA_WEEKLY_2026', 'gala_w99', ' GALA_W1', 'GALA_W0', 'GALA_W01', 'GALA_W1a']) assert.doesNotThrow(() => assertExternalRefIdAllowed(ref));
});

test('年会备份：已使用名额的持有人不能以普通中奖记录出现在本轮', () => {
  const snap = {
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 20, spent: 0 }, { id: 2, event_id: 1, is_reserved: 1, budget: 50, spent: 0 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 2, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' }],
    // 两人轮只剩一条记录：持有人 k 被记成了普通中奖人
    gala_round_winners: [{ id: 1, round_id: 1, event_id: 1, userid: 'k', amount: 10, pool_id: 1, awarded_at: null }],
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k', amount: 10, pool_id: 2, status: 'used', used_round_id: 1 }],
    ledger: [],
  };
  const errors = findGalaFundingErrors(snap);
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('普通中奖记录')), errors.join('\n'));
});

test('年会发放回执：非超管回执把预留奖励失败与普通失败一样计入，不暴露出处', () => {
  const result = {
    round_id: 7,
    granted: [{ userid: 'a', amount: 10, is_reserved: 0 }],
    failed: [{ userid: 'k', error: 'pool_budget_exceeded', is_reserved: 1 }],
    pending: 1,
  };
  assert.deepEqual(serializeGrantResult(result), {
    round_id: 7, failed_count: 1, failed_reasons: { pool_budget_exceeded: 1 }, pending: 1,
  });
  const sup = serializeGrantResult(result, { includeReserved: true });
  assert.equal(sup.failed[0].is_reserved, 1);
});

test('年会备份：待用名额与在线创建一样，同一活动同一环节一人只能有一个未取消名额、且未在该环节中过奖', () => {
  const base = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 0 }, { id: 2, event_id: 1, is_reserved: 1, budget: 100, spent: 0 }],
    gala_participants: [{ id: 1, event_id: 1, userid: 'k' }],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, prize_type: 'none', amount_each: 0, status: 'drawn' }],
    gala_round_winners: [{ id: 1, round_id: 1, event_id: 1, userid: 'a', amount: 0 }],
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 2, userid: 'k', pool_id: 2, status: 'pending' }],
    ledger: [],
  });
  assert.deepEqual(findGalaFundingErrors(base()), []);
  const twice = base();
  twice.gala_reserved_slots.push({ id: 2, event_id: 1, segment: 'lottery', round_no: 3, userid: 'k', pool_id: 2, status: 'pending' });
  const e1 = findGalaFundingErrors(twice);
  assert.ok(e1.some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('别的未取消名额')), e1.join('\n'));
  assert.ok(e1.some((e) => e.startsWith('gala_reserved_slots#2') && e.includes('别的未取消名额')), e1.join('\n'));
  // 另一个环节、或已取消的名额不冲突
  const otherSeg = base();
  otherSeg.gala_reserved_slots.push({ id: 2, event_id: 1, segment: 'giveaway', round_no: 1, userid: 'k', pool_id: 2, status: 'pending' });
  assert.deepEqual(findGalaFundingErrors(otherSeg), []);
  const cancelled = base();
  cancelled.gala_reserved_slots.push({ id: 2, event_id: 1, segment: 'lottery', round_no: 3, userid: 'k', status: 'cancelled' });
  assert.deepEqual(findGalaFundingErrors(cancelled), []);
  // 已在该环节中过奖
  const won = base();
  won.gala_reserved_slots[0].userid = 'a';
  assert.ok(findGalaFundingErrors(won).some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('中过奖')));
});

test('年会备份：同一人同一环节两个已使用名额同样拒绝', () => {
  const snap = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 0 }, { id: 2, event_id: 1, is_reserved: 1, budget: 100, spent: 0 }],
    gala_participants: [],
    gala_rounds: [
      { id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
      { id: 2, event_id: 1, segment: 'lottery', round_no: 2, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
    ],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'k', amount: 10, pool_id: 2, is_reserved: 1, awarded_at: null },
      { id: 2, round_id: 2, event_id: 1, userid: 'k', amount: 10, pool_id: 2, is_reserved: 1, awarded_at: null },
    ],
    gala_reserved_slots: [
      { id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k', amount: 10, pool_id: 2, status: 'used', used_round_id: 1 },
      { id: 2, event_id: 1, segment: 'lottery', round_no: 2, userid: 'k', amount: 10, pool_id: 2, status: 'used', used_round_id: 2 },
    ],
    ledger: [],
  });
  const errors = findGalaFundingErrors(snap());
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#2') && e.includes('别的未取消名额')), errors.join('\n'));
  // 只有一个已使用名额时通过
  const one = snap();
  one.gala_reserved_slots[1].status = 'cancelled';
  one.gala_reserved_slots[1].used_round_id = null;
  one.gala_round_winners[1] = { id: 2, round_id: 2, event_id: 1, userid: 'u', amount: 10, pool_id: 1, is_reserved: 0, awarded_at: null };
  assert.deepEqual(findGalaFundingErrors(one), []);
});

test('年会备份：轮次必须在可抽签的环节；在线能分配出的 ID 都能恢复', () => {
  const snap = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 0 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' }],
    gala_round_winners: [{ id: 1, round_id: 1, event_id: 1, userid: 'u', amount: 10, pool_id: 1, awarded_at: null }],
    gala_reserved_slots: [],
    ledger: [],
  });
  assert.deepEqual(findGalaFundingErrors(snap()), []);
  const danmaku = snap();
  danmaku.gala_rounds[0].segment = 'danmaku';
  assert.ok(findGalaFundingErrors(danmaku).some((e) => e.startsWith('gala_rounds#1') && e.includes('不可抽签')));
  // 年会表序列的上限就是最大安全整数：在线分配出的最后一个 ID 也必须能恢复（恢复后只是不能再新建）
  const maxId = snap();
  maxId.gala_events[0].id = Number.MAX_SAFE_INTEGER;
  maxId.gala_pools[0].event_id = Number.MAX_SAFE_INTEGER;
  maxId.gala_rounds[0].event_id = Number.MAX_SAFE_INTEGER;
  maxId.gala_round_winners[0].event_id = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(findGalaFundingErrors(maxId), []);
  const unsafe = snap();
  unsafe.gala_events[0].id = Number.MAX_SAFE_INTEGER + 2;
  assert.ok(findGalaFundingErrors(unsafe).some((e) => e.includes('不是安全范围内的正整数')));
  const nearMax = snap();
  nearMax.gala_round_winners[0].id = Number.MAX_SAFE_INTEGER - 1;
  assert.deepEqual(findGalaFundingErrors(nearMax), []);
});

test('年会备份：保留的流水 id（即使流水已被删除）只要是安全整数就能恢复', () => {
  const snap = (ledgerId) => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 10 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'granted', granted_at: 100 }],
    gala_round_winners: [{ id: 1, round_id: 1, event_id: 1, userid: 'u', amount: 10, pool_id: 1, awarded_at: 100, ledger_id: ledgerId }],
    gala_reserved_slots: [],
    ledger: [],
  });
  assert.deepEqual(findGalaFundingErrors(snap(Number.MAX_SAFE_INTEGER - 1)), []);
  assert.deepEqual(findGalaFundingErrors(snap(Number.MAX_SAFE_INTEGER)), []);
  const errors = findGalaFundingErrors(snap(Number.MAX_SAFE_INTEGER + 2));
  assert.ok(errors.some((e) => e.startsWith('gala_round_winners#1') && e.includes('ledger_id')), errors.join('\n'));
});

test('年会备份：开启排除已中奖者的一轮，中奖人不能在同一环节更早的轮次中过奖', () => {
  const snap = (exclude) => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 0 }],
    gala_participants: [],
    gala_rounds: [
      { id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
      { id: 2, event_id: 1, segment: 'lottery', round_no: 2, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn', exclude_previous_winners: exclude },
    ],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'u', amount: 10, pool_id: 1, awarded_at: null },
      { id: 2, round_id: 2, event_id: 1, userid: 'u', amount: 10, pool_id: 1, awarded_at: null },
    ],
    gala_reserved_slots: [],
    ledger: [],
  });
  const errors = findGalaFundingErrors(snap(1));
  assert.ok(errors.some((e) => e.startsWith('gala_round_winners#2') && e.includes('排除本环节已中奖者')), errors.join('\n'));
  // 直接校验时缺省视为开启（导入前会先由 prepareGalaRoundFlags 处理：旧格式推断补齐，当前格式缺失则拒绝）
  const legacy = snap(1);
  delete legacy.gala_rounds[1].exclude_previous_winners;
  assert.ok(findGalaFundingErrors(legacy).some((e) => e.startsWith('gala_round_winners#2')));
  // 该轮关闭了排除规则：允许重复中奖
  assert.deepEqual(findGalaFundingErrors(snap(0)), []);
  // 不同环节不算
  const otherSeg = snap(1);
  otherSeg.gala_rounds[1].segment = 'giveaway';
  otherSeg.gala_rounds[1].round_no = 1;
  assert.deepEqual(findGalaFundingErrors(otherSeg), []);
});

test('年会备份：已用名额的持有人在同一环节不能再有普通中奖记录（与排除开关无关）', () => {
  const snap = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 0 }, { id: 2, event_id: 1, is_reserved: 1, budget: 100, spent: 0 }],
    gala_participants: [],
    gala_rounds: [
      { id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
      { id: 2, event_id: 1, segment: 'lottery', round_no: 2, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn', exclude_previous_winners: 0 },
    ],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'k', amount: 10, pool_id: 2, is_reserved: 1, awarded_at: null },
      { id: 2, round_id: 2, event_id: 1, userid: 'k', amount: 10, pool_id: 1, is_reserved: 0, awarded_at: null },
    ],
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k', amount: 10, pool_id: 2, status: 'used', used_round_id: 1 }],
    ledger: [],
  });
  const errors = findGalaFundingErrors(snap());
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('普通中奖记录')), errors.join('\n'));
  const ok = snap();
  ok.gala_round_winners[1].userid = 'u';
  assert.deepEqual(findGalaFundingErrors(ok), []);
});

test('年会备份：同一活动员工、预留奖池的预算合计各不超过安全整数的一半', () => {
  const snap = (budgets) => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: budgets.map((b, i) => ({ id: i + 1, event_id: 1, is_reserved: 0, budget: b, spent: 0 })),
    gala_participants: [],
    gala_rounds: [],
    gala_round_winners: [],
    gala_reserved_slots: [],
    ledger: [],
  });
  const half = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  assert.deepEqual(findGalaFundingErrors(snap([half - 2, 2])), []);
  assert.ok(findGalaFundingErrors(snap([half, 1])).some((e) => e.includes('奖池预算合计')));
  assert.ok(findGalaFundingErrors(snap([Number.MAX_SAFE_INTEGER, 2])).some((e) => e.includes('奖池预算合计')));
});

test('含年会数据的全量备份格式：缺整组年会表不能当成旧备份', async () => {
  const { requiresGalaTables, GALA_BACKUP_FORMAT } = await import('../../src/routes/admin/backupRoutes.js');
  assert.equal(requiresGalaTables({ version: 2, galaFormat: GALA_BACKUP_FORMAT }), true);
  assert.equal(requiresGalaTables({ version: 2, tables: { users: 1, gala_events: 0 } }), true);
  assert.equal(requiresGalaTables({ version: 2, tables: { users: 1, ledger: 3 } }), false);
  assert.equal(requiresGalaTables({ version: 1 }), false);
});

test('旧格式备份缺少排除开关：按中奖记录推断（与升级迁移同一口径），推断值写回行里；当前格式缺失则拒绝', async () => {
  const { prepareGalaRoundFlags } = await import('../../src/routes/admin/backupRoutes.js');
  const snap = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 0 }],
    gala_participants: [],
    gala_rounds: [
      { id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
      { id: 2, event_id: 1, segment: 'lottery', round_no: 2, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
      { id: 3, event_id: 1, segment: 'lottery', round_no: 3, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
      { id: 4, event_id: 1, segment: 'giveaway', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
    ],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'u', amount: 10, pool_id: 1, awarded_at: null },
      { id: 2, round_id: 2, event_id: 1, userid: 'u', amount: 10, pool_id: 1, awarded_at: null },
      { id: 3, round_id: 3, event_id: 1, userid: 'v', amount: 10, pool_id: 1, awarded_at: null },
      { id: 4, round_id: 4, event_id: 1, userid: 'u', amount: 10, pool_id: 1, awarded_at: null },
    ],
    gala_reserved_slots: [],
    ledger: [],
  });
  const legacy = snap();
  assert.deepEqual(prepareGalaRoundFlags(legacy, { version: 2 }), []);
  // 第 2 轮有人在第 1 轮中过奖：当时关闭了排除；其余轮次（含另一环节）推断为开启
  assert.deepEqual(legacy.gala_rounds.map((r) => r.exclude_previous_winners), [1, 0, 1, 1]);
  assert.deepEqual(findGalaFundingErrors(legacy), []);
  // 备份里已有的值不覆盖
  const explicit = snap();
  for (const r of explicit.gala_rounds) r.exclude_previous_winners = 1;
  assert.deepEqual(prepareGalaRoundFlags(explicit, { version: 2 }), []);
  assert.ok(findGalaFundingErrors(explicit).some((e) => e.startsWith('gala_round_winners#2')));
  // 当前格式：缺失不推断，直接拒绝（损坏的备份不能借推断放过重复中奖）。
  // 用带齐全部列的样本，只删掉第 2 轮（有重复中奖、旧格式会被推断为 0）的这一列。
  const { GALA_BACKUP_TABLES } = await import('../../src/routes/admin/backupRoutes.js');
  const current = snap();
  for (const t of GALA_BACKUP_TABLES) {
    for (const row of current[t.name] || []) {
      for (const c of t.columns) if (!Object.hasOwn(row, c)) row[c] = c === 'exclude_previous_winners' ? 1 : null;
    }
  }
  assert.deepEqual(prepareGalaRoundFlags(structuredClone(current), { version: 2, galaFormat: 1 }), []);
  delete current.gala_rounds[1].exclude_previous_winners;
  const errs = prepareGalaRoundFlags(current, { version: 2, galaFormat: 1 });
  assert.equal(errs.length, 2, errs.join('\n'));
  assert.ok(errs.every((e) => e.startsWith('gala_rounds#2') && e.includes('exclude_previous_winners')), errs.join('\n'));
  assert.equal(current.gala_rounds[1].exclude_previous_winners, undefined, '当前格式不推断');
  // 取值非法
  const badVal = snap();
  for (const r of badVal.gala_rounds) r.exclude_previous_winners = 1;
  badVal.gala_rounds[0].exclude_previous_winners = 2;
  assert.ok(prepareGalaRoundFlags(badVal, { version: 2 }).some((e) => e.startsWith('gala_rounds#1')));
  // 轮次号缺失或非数字：不会卡死，跳过推断，由引用校验拒绝
  const badNo = snap();
  badNo.gala_rounds[1].round_no = 'x';
  delete badNo.gala_rounds[2].round_no;
  assert.deepEqual(prepareGalaRoundFlags(badNo, { version: 2 }), []);
  assert.equal(badNo.gala_rounds[1].exclude_previous_winners, undefined);
  assert.ok(findGalaFundingErrors(badNo).some((e) => e.startsWith('gala_rounds#2') && e.includes('round_no')));
});

test('年会备份：活动的环节开关必须是认识的环节键组成的 JSON 数组', () => {
  const snap = (segments) => ({
    gala_events: [{ id: 1, total_budget: 0, enabled_segments: segments }],
    gala_pools: [],
    gala_participants: [],
    gala_rounds: [],
    gala_round_winners: [],
    gala_reserved_slots: [],
    ledger: [],
  });
  assert.deepEqual(findGalaFundingErrors(snap(undefined)), []);
  assert.deepEqual(findGalaFundingErrors(snap('["lottery","checkin"]')), []);
  assert.deepEqual(findGalaFundingErrors(snap('[]')), []);
  for (const bad of ['not json', '{"a":1}', '["lottery","nope"]', '[1]', ['lottery']]) {
    assert.ok(findGalaFundingErrors(snap(bad)).some((e) => e.includes('enabled_segments')), String(bad));
  }
});

test('年会备份：已用名额兑现后，持有人在同一活动任何环节都不能再有普通中奖记录', () => {
  const snap = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 0 }, { id: 2, event_id: 1, is_reserved: 1, budget: 100, spent: 0 }],
    gala_participants: [],
    gala_rounds: [
      { id: 1, event_id: 1, segment: 'giveaway', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
      { id: 2, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
      { id: 3, event_id: 1, segment: 'giveaway', round_no: 2, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' },
    ],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'k', amount: 10, pool_id: 1, is_reserved: 0, awarded_at: null },
      { id: 2, round_id: 2, event_id: 1, userid: 'k', amount: 10, pool_id: 2, is_reserved: 1, awarded_at: null },
      { id: 3, round_id: 3, event_id: 1, userid: 'k', amount: 10, pool_id: 1, is_reserved: 0, awarded_at: null },
    ],
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k', amount: 10, pool_id: 2, status: 'used', used_round_id: 2 }],
    ledger: [],
  });
  const errors = findGalaFundingErrors(snap());
  assert.ok(errors.some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('兑现之后')), errors.join('\n'));
  // 兑现之前在别的环节中过普通奖是允许的（创建名额只检查本环节）
  const ok = snap();
  ok.gala_round_winners[2].userid = 'u';
  assert.deepEqual(findGalaFundingErrors(ok), []);
});

test('年会备份格式号：只接受本版本认识的格式', async () => {
  const { isUnsupportedGalaFormat, GALA_BACKUP_FORMAT } = await import('../../src/routes/admin/backupRoutes.js');
  assert.equal(isUnsupportedGalaFormat({ version: 2 }), false);
  assert.equal(isUnsupportedGalaFormat({ version: 2, galaFormat: GALA_BACKUP_FORMAT }), false);
  assert.equal(isUnsupportedGalaFormat({ version: 2, galaFormat: GALA_BACKUP_FORMAT + 1 }), true);
  assert.equal(isUnsupportedGalaFormat({ version: 2, galaFormat: '1' }), true);
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../src/routes/admin/backupRoutes.js', import.meta.url), 'utf8'));
  // 在任何写库（获取连接/开事务）之前拒绝
  const reject = src.indexOf('isUnsupportedGalaFormat(backup._meta)');
  assert.ok(reject > 0 && reject < src.indexOf('const backupData = backup.data;'));
});

test('抽签：单价 × 人数超出安全整数时直接拒绝，不返回被舍入的金额', async () => {
  const { drawGalaRound } = await import('../../src/services/galaService.js');
  await assert.rejects(
    drawGalaRound(null, { eventId: 1, segment: 'lottery', drawCount: 3, prizeType: 'coin', poolId: 1, amountEach: Number.MAX_SAFE_INTEGER, expectedRoundNo: 1 }),
    (e) => e.code === 'draw_total_too_large' && e.status === 400,
  );
});

test('当前格式备份：年会行缺任何一列都拒绝（不套默认值），旧格式照常补默认值', async () => {
  const { prepareGalaRoundFlags } = await import('../../src/routes/admin/backupRoutes.js');
  const full = {
    gala_events: [{
      id: 1, title: 'x', event_date: null, status: 'draft', total_budget: 100, enabled_segments: '["lottery"]',
      created_by: null, created_name: null, created_at: 1, updated_at: 1,
    }],
    gala_pools: [], gala_participants: [], gala_rounds: [], gala_round_winners: [], gala_reserved_slots: [],
  };
  assert.deepEqual(prepareGalaRoundFlags(structuredClone(full), { version: 2, galaFormat: 1 }), []);
  for (const col of ['total_budget', 'enabled_segments']) {
    const b = structuredClone(full);
    delete b.gala_events[0][col];
    const errs = prepareGalaRoundFlags(b, { version: 2, galaFormat: 1 });
    assert.ok(errs.some((e) => e.startsWith('gala_events#1') && e.includes(col)), errs.join('\n'));
    assert.deepEqual(prepareGalaRoundFlags(b, { version: 2 }), []);
  }
});

test('当前格式覆盖导入：年会表行数必须与导出记录一致', async () => {
  const { findGalaRowCountErrors, GALA_BACKUP_TABLES } = await import('../../src/routes/admin/backupRoutes.js');
  const data = Object.fromEntries(GALA_BACKUP_TABLES.map((t) => [t.name, []]));
  data.gala_events = [{ id: 1 }];
  data.gala_participants = [{ id: 1 }, { id: 2 }];
  data.ledger = [{ id: 1 }];
  data.accounts = [];
  const tables = Object.fromEntries([...GALA_BACKUP_TABLES.map((t) => t.name), 'ledger', 'accounts'].map((n) => [n, data[n].length]));
  assert.deepEqual(findGalaRowCountErrors(data, { galaFormat: 1, tables }), []);
  // 名单被截成空数组
  const cut = { ...data, gala_participants: [] };
  assert.ok(findGalaRowCountErrors(cut, { galaFormat: 1, tables }).some((e) => e.startsWith('gala_participants')));
  // 缺少行数记录
  const { gala_rounds: _omit, ...partial } = tables;
  assert.ok(findGalaRowCountErrors(data, { galaFormat: 1, tables: partial }).some((e) => e.startsWith('gala_rounds')));
  // 列出的其他表（如账户）被截短同样拒绝
  const withAcc = { ...data, accounts: [{ userid: 'a' }, { userid: 'b' }] };
  const accTables = { ...tables, accounts: 2 };
  assert.deepEqual(findGalaRowCountErrors(withAcc, { galaFormat: 1, tables: accTables }), []);
  assert.ok(findGalaRowCountErrors({ ...withAcc, accounts: [{ userid: 'a' }] }, { galaFormat: 1, tables: accTables }).some((e) => e.startsWith('accounts')));
  // 覆盖导入要求的表必须有行数记录
  assert.ok(findGalaRowCountErrors(data, { galaFormat: 1, tables }, { required: ['users'] }).some((e) => e.startsWith('users')));
  // 合并（默认要求）同样要求账户有行数记录：账户被截掉或整张缺失时无法确认余额
  const { accounts: _noAcc, ...noAccTables } = tables;
  assert.ok(findGalaRowCountErrors(data, { galaFormat: 1, tables: noAccTables }).some((e) => e.startsWith('accounts')));
  // 流水被截短同样拒绝
  assert.ok(findGalaRowCountErrors({ ...data, ledger: [] }, { galaFormat: 1, tables }).some((e) => e.startsWith('ledger')));
  // 旧格式（没有 galaFormat）同样核对它实际记下的行数：被截短的中奖记录、名单不能通过
  assert.ok(findGalaRowCountErrors(cut, { tables }).some((e) => e.startsWith('gala_participants')));
  const cutWinners = { ...data, gala_round_winners: [] };
  const legacyTables = { ...tables, gala_round_winners: 3 };
  assert.ok(findGalaRowCountErrors(cutWinners, { tables: legacyTables }).some((e) => e.startsWith('gala_round_winners')));
  assert.deepEqual(findGalaRowCountErrors(data, { tables }), []);
  // 旧格式不要求新字段：没记行数的表不报错，更早没有 tables 的旧备份不检查
  assert.deepEqual(findGalaRowCountErrors(data, { tables: { gala_events: 1 } }), []);
  assert.deepEqual(findGalaRowCountErrors(cut, {}), []);
});

test('年会备份：有 ledger_id 关联的付款不按时钟先后否定', () => {
  const snap = (ledgerAt) => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 10 }],
    gala_participants: [],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'granted', granted_at: 2000 }],
    gala_round_winners: [{ id: 1, round_id: 1, event_id: 1, userid: 'u', amount: 10, pool_id: 1, awarded_at: 2000, ledger_id: 5, created_at: 1000 }],
    gala_reserved_slots: [],
    ledger: [{ id: 5, userid: 'u', delta: 10, reason: '年会奖励·抽奖·第1轮', ref_id: 'GALA_W1', created_at: ledgerAt }],
    accounts: [{ userid: 'u', balance: 10 }],
  });
  assert.deepEqual(findGalaFundingErrors(snap(1500)), []);
  // 数据库时钟回拨、或恢复到时钟稍慢的新主库后立即发币：流水时间早于中奖记录，但凭据、引用号、收款人、金额都吻合
  assert.deepEqual(findGalaFundingErrors(snap(500)), []);
  // 关联的流水收款人或金额不符仍拒绝
  const wrong = snap(1500);
  wrong.ledger[0].delta = 11;
  assert.ok(findGalaFundingErrors(wrong).some((e) => e.startsWith('ledger#5')));
  // 用户重置后流水已删、凭据仍保留：合法
  const purged = snap(1500);
  purged.ledger = [];
  assert.deepEqual(findGalaFundingErrors(purged), []);
});

test('名单导入与抽签：参数类型不对时拒绝，不猜意图', async () => {
  const { addGalaParticipants, drawGalaRound } = await import('../../src/services/galaService.js');
  await assert.rejects(addGalaParticipants(null, { eventId: 1, userids: 'u1', allActiveDingtalk: true }), (e) => e.code === 'invalid_userids');
  await assert.rejects(addGalaParticipants(null, { eventId: 1, userids: ['u1'], allActiveDingtalk: true }), (e) => e.code === 'ambiguous_participant_source');
  for (const v of ['false', 0, 1, null]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      drawGalaRound(null, { eventId: 1, segment: 'lottery', drawCount: 1, excludePreviousWinners: v, expectedRoundNo: 1 }),
      (e) => e.code === 'invalid_exclude_previous_winners' && e.status === 400,
      String(v),
    );
  }
});

test('发币轮奖励已全部到账却仍是 drawn：校验拒绝，导入前补成完成；无币轮不动', () => {
  const snap = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 10 }],
    gala_participants: [],
    gala_rounds: [
      { id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn', created_at: 100 },
      { id: 2, event_id: 1, segment: 'game', round_no: 1, draw_count: 1, prize_type: 'none', amount_each: 0, status: 'drawn', created_at: 100 },
    ],
    gala_round_winners: [
      { id: 1, round_id: 1, event_id: 1, userid: 'u', amount: 10, pool_id: 1, awarded_at: 300, ledger_id: 9, created_at: 100 },
      { id: 2, round_id: 2, event_id: 1, userid: 'v', amount: 0, pool_id: null, awarded_at: null, created_at: 100 },
    ],
    gala_reserved_slots: [],
    ledger: [],
  });
  assert.ok(findGalaFundingErrors(snap()).some((e) => e.startsWith('gala_rounds#1') && e.includes('未标记整轮发放完成')));
  const fixed = snap();
  assert.equal(completeFinishedCoinRounds(fixed), 1);
  assert.deepEqual([fixed.gala_rounds[0].status, fixed.gala_rounds[0].granted_at], ['granted', 300]);
  assert.deepEqual([fixed.gala_rounds[1].status, fixed.gala_rounds[1].granted_at], ['drawn', undefined]);
  assert.deepEqual(findGalaFundingErrors(fixed), []);
  // 还有待发的不补
  const partial = snap();
  partial.gala_round_winners[0].awarded_at = null;
  assert.equal(completeFinishedCoinRounds(partial), 0);
});

test('抽签位置抽样：与对整份名单洗牌逐位相同，且不重复、不越界', async () => {
  const { samplePositions } = await import('../../src/services/galaService.js');
  let seed = 7;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (const [n, k] of [[1, 1], [5, 5], [50, 7], [1000, 30], [3, 10], [0, 2]]) {
    const seq = Array.from({ length: Math.min(k, n) }, rng);
    let i1 = 0;
    let i2 = 0;
    const a = samplePositions(n, k, (m) => seq[i1++] % m);
    const b = pickRandom(Array.from({ length: n }, (_, i) => i), k, (m) => seq[i2++] % m);
    assert.deepEqual(a, b, `${n}/${k}`);
    assert.equal(new Set(a).size, a.length);
    assert.ok(a.every((x) => x >= 0 && x < n));
  }
});

test('名单导入：任何一项无效都拒绝整批，不静默丢弃', async () => {
  const { addGalaParticipants } = await import('../../src/services/galaService.js');
  for (const bad of [['u1', ''], ['u1', null], ['u1', { id: 1 }], ['u1', ['u2']], ['  ']]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(addGalaParticipants(null, { eventId: 1, userids: bad }), (e) => e.code === 'invalid_userid' && Number.isInteger(e.index), JSON.stringify(bad));
  }
});

test('年会备份：待用名额的持有人必须在同一活动的名单里，已使用、已取消的名额不受限', () => {
  const snap = () => ({
    gala_events: [{ id: 1, total_budget: 0 }, { id: 2, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 1, budget: 100, spent: 0 }],
    gala_participants: [{ id: 1, event_id: 1, userid: 'k' }, { id: 2, event_id: 2, userid: 'm' }],
    gala_rounds: [],
    gala_round_winners: [],
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, userid: 'k', pool_id: 1, status: 'pending' }],
    ledger: [],
  });
  assert.deepEqual(findGalaFundingErrors(snap()), []);
  const out = snap();
  out.gala_participants = out.gala_participants.filter((p) => p.userid !== 'k');
  assert.ok(findGalaFundingErrors(out).some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('参与名单')));
  // 在别的活动的名单里不算
  const other = snap();
  other.gala_reserved_slots[0].userid = 'm';
  assert.ok(findGalaFundingErrors(other).some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('参与名单')));
  const cancelled = snap();
  cancelled.gala_participants = [];
  cancelled.gala_reserved_slots[0].status = 'cancelled';
  assert.deepEqual(findGalaFundingErrors(cancelled), []);
});

test('名单导入：第一项无效值的位置，包括清洗时抛错的超长、非安全整数', async () => {
  const { addGalaParticipants } = await import('../../src/services/galaService.js');
  const cases = [
    [['ok', 'x'.repeat(5000)], 1],
    [['', 'x'.repeat(5000)], 0],
    [['ok', 9007199254740993], 1],
    [['ok', 'ok2', null], 2],
    // 写库时无法原样往返的标识：孤立代理码元（会变成 U+FFFD）、NUL（无法作为参数传入）
    [['ok', 'ab\uD83D'], 1],
    [['ok', 'ok2', 'a\u0000b'], 2],
    [['\uDE00x', 'ok'], 0],
    // 首尾空白不去掉后继续，而是拒绝：" u1" 去掉空白后可能正是另一个人
    [[' u1', 'ok'], 0],
    [['ok', 'u2\u3000'], 1],
    [['ok', 'ok2', '\tu3'], 2],
    // 长度按字符（码点）计：513 个补充平面字符超长
    [['ok', '😀'.repeat(513)], 1],
  ];
  for (const [list, index] of cases) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(addGalaParticipants(null, { eventId: 1, userids: list }), (e) => e.code === 'invalid_userid' && e.index === index, String(index));
  }
});

test('导入：已发放且付款流水在备份里的奖励，备份必须带收款人账户', async () => {
  const { findGalaFundingErrors } = await import('../../src/routes/admin/backupRoutes.js');
  const base = {
    gala_events: [{ id: 1, total_budget: 10, enabled_segments: '["lottery"]' }],
    gala_pools: [{ id: 1, event_id: 1, budget: 10, spent: 10, is_reserved: 0 }],
    gala_participants: [{ id: 1, event_id: 1, userid: 'u1' }],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, prize_type: 'coin', pool_id: 1, amount_each: 10, draw_count: 1, status: 'granted', granted_at: 200, created_at: 100 }],
    gala_round_winners: [{ id: 1, round_id: 1, event_id: 1, userid: 'u1', pool_id: 1, amount: 10, is_reserved: 0, awarded_at: 200, ledger_id: 5, created_at: 100 }],
    gala_reserved_slots: [],
    ledger: [{ id: 5, userid: 'u1', delta: 10, reason: '年会奖励·抽奖·第1轮', ref_id: 'GALA_W1', created_at: 150 }],
  };
  const noAccount = findGalaFundingErrors(structuredClone(base));
  assert.ok(noAccount.some((e) => e.includes('缺少收款人 u1 的账户')), JSON.stringify(noAccount));
  assert.ok(findGalaFundingErrors({ ...structuredClone(base), accounts: [{ userid: 'u2', balance: 0 }] }).some((e) => e.includes('u1')));
  assert.deepEqual(findGalaFundingErrors({ ...structuredClone(base), accounts: [{ userid: 'u1', balance: 10 }] }), []);
  // 付款流水不在备份里（用户重置后流水已删）时不要求账户
  const purged = { ...structuredClone(base), ledger: [] };
  assert.ok(!findGalaFundingErrors(purged).some((e) => e.includes('账户')));
});

test('移出名单：缺少或无效的 userid 返回 invalid_userid，不当成“已不在名单”', async () => {
  const { removeGalaParticipant } = await import('../../src/services/galaService.js');
  for (const userid of [undefined, null, '', {}, [], ' u1', 'u1 ']) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(removeGalaParticipant(null, { eventId: 1, userid }), (e) => e.code === 'invalid_userid', JSON.stringify(userid));
  }
});

test('年会备份：恢复的名单、待发中奖记录、待用名额的 userid 必须能按在线规则原样操作', async () => {
  const { findGalaFundingErrors } = await import('../../src/routes/admin/backupRoutes.js');
  const snap = () => ({
    gala_events: [{ id: 1, total_budget: 0 }],
    gala_pools: [{ id: 1, event_id: 1, is_reserved: 0, budget: 100, spent: 0 }, { id: 2, event_id: 1, is_reserved: 1, budget: 100, spent: 0 }],
    gala_participants: [{ id: 1, event_id: 1, userid: 'u1' }, { id: 2, event_id: 1, userid: 'k1' }],
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10, status: 'drawn' }],
    gala_round_winners: [{ id: 1, round_id: 1, event_id: 1, userid: 'u1', amount: 10, pool_id: 1, awarded_at: null }],
    gala_reserved_slots: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 2, userid: 'k1', pool_id: 2, status: 'pending' }],
    ledger: [],
  });
  assert.deepEqual(findGalaFundingErrors(snap()), []);
  const cases = [
    ['gala_participants', (b) => { b.gala_participants[0].userid = ' u1'; }],
    ['gala_participants', (b) => { b.gala_participants[0].userid = 'x'.repeat(513); }],
    ['gala_round_winners', (b) => { b.gala_round_winners[0].userid = 'u1 '; }],
    ['gala_reserved_slots', (b) => { b.gala_reserved_slots[0].userid = '\tk1'; }],
  ];
  for (const [table, mutate] of cases) {
    const b = snap();
    mutate(b);
    const errors = findGalaFundingErrors(b);
    assert.ok(errors.some((e) => e.startsWith(`${table}#1`) && e.includes('userid')), `${table}: ${errors.join('; ')}`);
  }
  // 已发放的记录、已取消的名额不再按 ID 操作，不检查
  const done = snap();
  Object.assign(done.gala_reserved_slots[0], { userid: ' k1', status: 'cancelled' });
  assert.ok(!findGalaFundingErrors(done).some((e) => e.includes('userid')));
});

test('发放：意外异常的原文不进回执和 award_error，对外统一为 award_failed', async () => {
  const { grantGalaRound, serializeGrantResult } = await import('../../src/services/galaService.js');
  const V = '11111111-2222-4333-8444-555555555555';
  const round = { id: 7, event_id: 1, segment: 'lottery', round_no: 1, created_at: 100, prize_type: 'coin', title: null };
  const winner = { id: 70, round_id: 7, userid: 'u1', amount: 5, is_reserved: 0 };
  const writes = [];
  const tx = {
    get: async (sql) => {
      if (sql.includes('version_token')) return { version_token: V };
      if (sql.includes('COUNT(*)')) return { n: 1 };
      if (sql.includes('FROM gala_rounds')) return round;
      return {};
    },
    all: async () => [winner],
    run: async (sql, params) => { writes.push(params); return { changes: 1 }; },
  };
  let n = 0;
  const db = {
    transaction: async (fn) => {
      n += 1;
      if (n === 2) throw new Error('connection to server at 10.0.0.5 failed: secret detail');
      return fn(tx);
    },
  };
  const origError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await grantGalaRound(db, { roundId: 7, grantToken: `${V}.7` });
  } finally {
    console.error = origError;
  }
  assert.deepEqual(result.failed.map((f) => f.error), ['award_failed']);
  assert.ok(writes.some((p) => Array.isArray(p) && p[0] === 'award_failed'), '写入 award_error 的也是固定代码');
  const pub = JSON.stringify(serializeGrantResult(result));
  assert.ok(!pub.includes('secret') && !pub.includes('10.0.0.5'), pub);
  assert.ok(pub.includes('award_failed'));
});

test('移出名单：按名单记录 id 或 userid 二选一', async () => {
  const { removeGalaParticipant } = await import('../../src/services/galaService.js');
  await assert.rejects(removeGalaParticipant(null, { eventId: 1, userid: 'u1', participantId: 3 }), (e) => e.code === 'ambiguous_participant_target');
  for (const participantId of ['x', 0, -1, 1.5, {}]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(removeGalaParticipant(null, { eventId: 1, participantId }), (e) => e.code === 'invalid_participant_id', JSON.stringify(participantId));
  }
});
