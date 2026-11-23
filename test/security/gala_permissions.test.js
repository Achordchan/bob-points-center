import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPathPermission } from '../../src/services/adminPermissionService.js';
import { GALA_MAX_RESERVED_SLOTS, pickRandom, serializeGrantResult } from '../../src/services/galaService.js';
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
    gala_pools: [{ id: 1, event_id: 10, is_reserved: 0, budget: 500, spent: 50 }, { id: 2, event_id: 10, is_reserved: 1, budget: 50 }, { id: 3, event_id: 20, is_reserved: 0, budget: 100 }],
    gala_participants: [{ id: 1, event_id: 10 }],
    gala_rounds: [{ id: 5, event_id: 10, segment: 'lottery', round_no: 1, draw_count: 10, pool_id: 1, prize_type: 'coin', amount_each: 50 }, { id: 6, event_id: 10, segment: 'game', round_no: 1, draw_count: 1, pool_id: null, prize_type: 'none', amount_each: 0 }],
    gala_round_winners: [
      { id: 1, round_id: 5, event_id: 10, amount: 50, pool_id: 1, awarded_at: null },
      { id: 2, round_id: 6, event_id: 10, amount: 0, pool_id: null, awarded_at: null },
      { id: 3, round_id: 5, event_id: 10, userid: 'u3', amount: 50, pool_id: 1, awarded_at: 1700000000, ledger_id: 900 },
      { id: 7, round_id: 5, event_id: 10, userid: 'k7', amount: 50, pool_id: 2, is_reserved: 1, awarded_at: null },
    ],
    gala_reserved_slots: [
      { id: 1, event_id: 10, segment: 'lottery', round_no: 9, userid: 'k1', amount: 20, pool_id: 2, status: 'pending' },
      { id: 2, event_id: 10, segment: 'lottery', round_no: 1, userid: 'k7', amount: 50, pool_id: 2, status: 'used', used_round_id: 5 },
    ],
    ledger: [{ id: 900, userid: 'u3', delta: 50, ref_id: 'GALA_W3', reason: '年会奖励·测试' }, { id: 901, userid: 'u9', delta: 5, ref_id: 'ADMIN_X' }],
  };
  assert.deepEqual(findGalaFundingErrors(base), []);
  const bad = structuredClone(base);
  bad.gala_round_winners.push({ id: 4, round_id: 5, event_id: 10, amount: 50, pool_id: null, awarded_at: null });
  bad.gala_round_winners.push({ id: 5, round_id: 5, event_id: 10, amount: 50, pool_id: 3, awarded_at: null });
  bad.gala_round_winners.push({ id: 6, round_id: 99, event_id: 10, amount: 0, pool_id: null, awarded_at: null });
  bad.gala_round_winners.push({ id: 8, round_id: 5, event_id: 10, amount: 30, pool_id: 1, is_reserved: 1, awarded_at: null });
  bad.gala_round_winners.push({ id: 9, round_id: 5, event_id: 10, amount: 30, pool_id: 2, is_reserved: 0, awarded_at: null });
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
    gala_round_winners: [{ id: 11, round_id: 1, event_id: 1, amount: 10, pool_id: 1, awarded_at: null }],
    gala_reserved_slots: [],
    ledger: [{ id: 1, ref_id: 'GALA_W11', delta: 10, reason: '年会奖励·测试' }, { id: 2, ref_id: 'GALA_W12', delta: 10, reason: '年会奖励·测试' }],
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
  });
  assert.deepEqual(findGalaFundingErrors(ok()), []);

  const wrongPayee = ok();
  wrongPayee.ledger[1].userid = 'a';
  assert.ok(findGalaFundingErrors(wrongPayee).some((e) => e.includes('收款人或金额')));

  // 出处以中奖记录的 ledger_id 为准：已发放并引用 101 的中奖记录，另一条形似的流水只是普通入账，不会再发一次
  const dupLedger = ok();
  dupLedger.ledger.push({ id: 103, userid: 'a', delta: 10, ref_id: 'GALA_W1', reason: '年会奖励·测试' });
  assert.deepEqual(findGalaFundingErrors(dupLedger), []);

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
    gala_rounds: [{ id: 1, event_id: 1, segment: 'lottery', round_no: 1, draw_count: 1, pool_id: 1, prize_type: 'coin', amount_each: 10 }],
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
    gala_pools: [{ id: 9, event_id: 1, is_reserved: 1, budget: 10, spent: 0 }], gala_participants: [], gala_rounds: [], gala_round_winners: [],
    gala_reserved_slots: [
      { id: 1, event_id: 1, segment: 'lottery', round_no: 1, amount: 0, pool_id: 9, status: 'pending' },
      { id: 2, event_id: 1, segment: 'lotery', round_no: 1, amount: 0, pool_id: 9, status: 'pending' },
      { id: 3, event_id: 1, segment: 'danmaku', round_no: 1, amount: 0, pool_id: 9, status: 'pending' },
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
  });
  assert.deepEqual(findGalaFundingErrors(ok()), []);
  // 已发放的预留奖励和对应名额都去掉奖池：这笔钱不在任何预算里
  const paid = ok();
  paid.gala_round_winners[0].pool_id = null;
  paid.gala_reserved_slots[0].pool_id = null;
  const errors = findGalaFundingErrors(paid);
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
  assert.ok(findGalaFundingErrors(noPool).some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('缺少同一活动的预留奖池')));
  assert.deepEqual(findGalaFundingErrors(cancelled), []);
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
  assert.deepEqual(findGalaFundingErrors(snap([])), []);
  // 中奖记录不在时仍按关联轮次核对名额金额（本轮单价 10）
  const wrongAmount = snap([]);
  wrongAmount.gala_reserved_slots[0].amount = 8;
  assert.ok(findGalaFundingErrors(wrongAmount).some((e) => e.startsWith('gala_reserved_slots#1') && e.includes('奖励不一致')));
  // 单人轮：名额已使用，唯一的位置却是另一个普通中奖人
  const errors = findGalaFundingErrors(snap([{ id: 1, round_id: 1, event_id: 1, userid: 'u', amount: 10, pool_id: 1, awarded_at: null }]));
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
    gala_participants: [],
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

test('年会备份：轮次必须在可抽签的环节，ID 必须给新记录留出安全范围', () => {
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
  const maxId = snap();
  maxId.gala_events[0].id = Number.MAX_SAFE_INTEGER;
  assert.ok(findGalaFundingErrors(maxId).some((e) => e.includes('id 已到上限')));
  const nearMax = snap();
  nearMax.gala_round_winners[0].id = Number.MAX_SAFE_INTEGER - 1;
  assert.deepEqual(findGalaFundingErrors(nearMax), []);
});

test('年会备份：保留的流水 id（即使流水已被删除）也要给新流水留出安全范围', () => {
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
  const errors = findGalaFundingErrors(snap(Number.MAX_SAFE_INTEGER));
  assert.ok(errors.some((e) => e.startsWith('gala_round_winners#1') && e.includes('ledger_id 已到上限')), errors.join('\n'));
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
  // 缺省视为开启
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
