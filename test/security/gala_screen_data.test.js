import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PARTICIPANTS_PAGE_SIZE,
  ROUNDS_PAGE_SIZE,
  createSingleFlight,
  fetchAllParticipantNames,
  fetchAllRounds,
  fetchAllRoundsVersioned,
  fetchEventDetail,
  fetchScreenState,
  fetchSegmentLabels,
  parseEventId,
  pickEvent,
  pickRound,
  pickSegmentLabels,
  pickState,
  pickWinnerName,
  shouldHandleGalaChanged,
  shouldHandleScreenEvent,
} from '../../src/admin-app/src/screen/data.js';

test('parseEventId 仅接受正整数，非法或缺失返回 null', () => {
  assert.equal(parseEventId('?event_id=1'), 1);
  assert.equal(parseEventId('?foo=bar&event_id=42&baz=1'), 42);
  for (const bad of ['', '?', '?id=1', '?event_id=', '?event_id=0', '?event_id=-3', '?event_id=1.5', '?event_id=abc', '?event_id=12x']) {
    assert.equal(parseEventId(bad), null, bad);
  }
});

test('pickRound 白名单过滤所有多余字段，winners 仅保留姓名字符串且保持原顺序', () => {
  const rawRound = {
    id: 18,
    event_id: 7,
    segment: 'lottery',
    segment_label: '抽奖',
    round_no: 2,
    title: '一等奖',
    prize_type: 'coin',
    pool_id: 99,
    amount_each: 500,
    draw_count: 3,
    exclude_previous_winners: true,
    status: 'granted',
    created_by: 'admin1',
    created_name: '超管',
    created_at: 1700000000,
    granted_at: 1700000100,
    grant_token: 'tok.18',
    eligible_count: 120,
    is_reserved: 1,
    replayed: false,
    winners: [
      {
        id: 101,
        userid: 'u_001',
        name: '张三',
        display_order: 1,
        amount: 500,
        awarded: 1,
        awarded_at: 1700000100,
        award_cancelled: 0,
        award_error: '',
        is_reserved: 1,
        pool_id: 888,
      },
      {
        id: 102,
        userid: 'u_002',
        name: '李四',
        display_order: 2,
        amount: 500,
        is_reserved: 0,
        pool_id: 99,
      },
      {
        id: 103,
        userid: 'u_003',
        name: '王五',
        display_order: 3,
        amount: 500,
        is_reserved: 0,
        pool_id: 99,
      },
    ],
  };

  const picked = pickRound(rawRound);
  assert.deepEqual(Object.keys(picked).sort(), [
    'amount_each',
    'id',
    'prize_type',
    'round_no',
    'segment',
    'segment_label',
    'title',
    'winners',
  ]);
  assert.deepEqual(picked, {
    id: 18,
    segment: 'lottery',
    segment_label: '抽奖',
    round_no: 2,
    title: '一等奖',
    prize_type: 'coin',
    amount_each: 500,
    winners: ['张三', '李四', '王五'],
  });
  for (const w of picked.winners) {
    assert.equal(typeof w, 'string');
  }
  assert.equal('is_reserved' in picked, false);
  assert.equal('pool_id' in picked, false);
  assert.equal('amount' in picked, false);
  assert.equal('grant_token' in picked, false);
  assert.equal('eligible_count' in picked, false);

  assert.equal(pickRound(null), null);
  assert.equal(pickRound({ id: 0 }), null);
});

test('pickWinnerName 仅取 name，不回退到 userid，丢弃敏感字段', () => {
  assert.equal(pickWinnerName({ name: '赵六', userid: 'u_6', is_reserved: 1, pool_id: 2, amount: 100 }), '赵六');
  assert.equal(pickWinnerName({ userid: 'u_only' }), '');
  assert.equal(pickWinnerName(null), '');
});

test('pickState 丢弃多余字段并校验 mode', () => {
  const picked = pickState({
    event_id: 7,
    mode: 'reveal',
    segment: null,
    round_id: 18,
    version: 5,
    updated_at: 1700000200,
    is_reserved: 1,
    extra: 'drop_me',
  });
  assert.deepEqual(Object.keys(picked).sort(), ['data_version', 'mode', 'round_id', 'segment', 'version']);
  assert.deepEqual(picked, {
    mode: 'reveal',
    segment: null,
    round_id: 18,
    version: 5,
    data_version: null,
  });
  const V = '33333333-3333-4333-8333-333333333333';
  assert.equal(pickState({ mode: 'idle', data_version: V }).data_version, V);
  assert.equal(pickState({ mode: 'idle', data_version: 'not-a-version' }).data_version, null);

  const fallback = pickState({ mode: 'invalid_mode', segment: 'lottery', round_id: -1, version: -5 });
  assert.deepEqual(fallback, {
    mode: 'idle',
    segment: 'lottery',
    round_id: null,
    version: 0,
    data_version: null,
  });
  assert.equal(pickState(null), null);
});

test('pickEvent 与 pickSegmentLabels 严格按白名单取值', () => {
  const pickedEvent = pickEvent({
    id: 7,
    title: '2026 年度盛典',
    event_date: '2026-12-31',
    status: 'live',
    total_budget: 100000,
    participant_count: 256,
    round_count: 5,
    pools: [{ id: 1, is_reserved: 1 }],
    budget_summary: { pools_spent: 1000 },
    reserved_slots_used: 2,
    reserved_slots_limit: 3,
    gala_version: 'uuid-1',
  });
  assert.deepEqual(Object.keys(pickedEvent).sort(), ['event_date', 'participant_count', 'title']);
  assert.deepEqual(pickedEvent, {
    title: '2026 年度盛典',
    event_date: '2026-12-31',
    participant_count: 256,
  });

  const labels = pickSegmentLabels([
    { key: 'lottery', label: '抽奖', drawable: true, extra: 1 },
    { key: 'giveaway', label: 'BOB币大放送', drawable: true },
    { key: '__proto__', label: 'bad' },
  ]);
  assert.deepEqual(labels, { lottery: '抽奖', giveaway: 'BOB币大放送' });
});

test('SSE 事件归属判定：gala_screen 仅匹配当前活动，gala_changed 兼容无 event_id 的发币事件', () => {
  assert.equal(shouldHandleScreenEvent({ event_id: 7, version: 2 }, 7), true);
  assert.equal(shouldHandleScreenEvent({ event_id: 8, version: 2 }, 7), false);
  assert.equal(shouldHandleScreenEvent({ version: 2 }, 7), false);

  assert.equal(shouldHandleGalaChanged({ event_id: 7, round_id: 1, reason: 'round_drawn' }, 7), true);
  assert.equal(shouldHandleGalaChanged({ event_id: 8, round_id: 1, reason: 'round_drawn' }, 7), false);
  assert.equal(shouldHandleGalaChanged({ round_id: 1, reason: 'round_granted' }, 7), true);
  assert.equal(shouldHandleGalaChanged(null, 7), false);
});

test('fetch 分页拉取使用 same-origin + no-store，轮次按 id 升序且无敏感字段残留', async () => {
  const calls = [];
  const mockFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith('/admin/gala/participants?')) {
      const u = new URL(url, 'http://localhost');
      const afterId = Number(u.searchParams.get('after_id') || 0);
      if (afterId === 0) {
        const page1 = Array.from({ length: PARTICIPANTS_PAGE_SIZE }, (_, idx) => ({
          id: idx + 1,
          userid: `u_${idx + 1}`,
          name: `员工${idx + 1}`,
          is_reserved: idx === 0 ? 1 : 0,
        }));
        return { ok: true, status: 200, async json() { return { ok: true, data: page1 }; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            data: [{ id: PARTICIPANTS_PAGE_SIZE + 1, userid: 'u_last', name: '压轴员工', is_reserved: 0 }],
          };
        },
      };
    }
    if (url.startsWith('/admin/gala/rounds?')) {
      const u = new URL(url, 'http://localhost');
      const beforeId = u.searchParams.get('before_id');
      if (!beforeId) {
        const page1 = Array.from({ length: ROUNDS_PAGE_SIZE }, (_, idx) => {
          const id = 300 - idx;
          return {
            id,
            segment: 'lottery',
            segment_label: '抽奖',
            round_no: id,
            title: `第${id}轮`,
            prize_type: 'coin',
            amount_each: 100,
            pool_id: 5,
            winners: [{ userid: `u_${id}`, name: `中奖者${id}`, is_reserved: 1, pool_id: 9, amount: 100 }],
          };
        });
        return { ok: true, status: 200, async json() { return { ok: true, data: page1 }; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            data: [
              {
                id: 50,
                segment: 'giveaway',
                segment_label: 'BOB币大放送',
                round_no: 1,
                title: '开场轮',
                prize_type: 'none',
                amount_each: 0,
                winners: [{ userid: 'u_50', name: '首轮幸运儿', is_reserved: 1 }],
              },
            ],
          };
        },
      };
    }
    if (url.startsWith('/admin/gala/events/detail?')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, data: { title: '年会', event_date: '2026-12-31', participant_count: 501, reserved_slots_used: 1 } };
        },
      };
    }
    if (url.startsWith('/admin/gala/screen/state?')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, data: { event_id: 7, mode: 'rolling', segment: 'lottery', round_id: null, version: 3, updated_at: 1 } };
        },
      };
    }
    if (url === '/admin/gala/segments') {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, data: [{ key: 'lottery', label: '抽奖', drawable: true }] };
        },
      };
    }
    return { ok: false, status: 404, async json() { return { ok: false }; } };
  };

  const names = await fetchAllParticipantNames(7, mockFetch);
  assert.equal(names.length, PARTICIPANTS_PAGE_SIZE + 1);
  assert.equal(names[0], '员工1');
  assert.equal(names[names.length - 1], '压轴员工');

  const rounds = await fetchAllRounds(7, mockFetch);
  assert.equal(rounds.length, ROUNDS_PAGE_SIZE + 1);
  assert.equal(rounds[0].id, 50);
  assert.equal(rounds[rounds.length - 1].id, 300);
  assert.deepEqual(rounds[0].winners, ['首轮幸运儿']);
  assert.equal('pool_id' in rounds[0], false);

  const event = await fetchEventDetail(7, mockFetch);
  assert.deepEqual(event, { title: '年会', event_date: '2026-12-31', participant_count: 501 });

  const state = await fetchScreenState(7, mockFetch);
  assert.deepEqual(state, { mode: 'rolling', segment: 'lottery', round_id: null, version: 3, data_version: null });

  const labels = await fetchSegmentLabels(mockFetch);
  assert.deepEqual(labels, { lottery: '抽奖' });

  for (const c of calls) {
    assert.equal(c.opts.credentials, 'same-origin');
    assert.equal(c.opts.cache, 'no-store');
  }
});

test('fetchAllRoundsVersioned 给出轮次所属数据版本，翻页途中版本变化则整批作废', async () => {
  const VA = '44444444-4444-4444-8444-444444444444';
  const VB = '55555555-5555-4555-8555-555555555555';
  const makeFetch = (secondPageVersion) => async (url) => {
    const u = new URL(url, 'http://localhost');
    const page = u.searchParams.get('before_id')
      ? [{ id: 1, segment: 'lottery', round_no: 1, gala_version: secondPageVersion, winners: [] }]
      : Array.from({ length: ROUNDS_PAGE_SIZE }, (_, idx) => ({
        id: 500 - idx, segment: 'lottery', round_no: 500 - idx, gala_version: VA, winners: [],
      }));
    return { ok: true, status: 200, async json() { return { ok: true, data: page }; } };
  };

  const ok = await fetchAllRoundsVersioned(7, makeFetch(VA));
  assert.equal(ok.dataVersion, VA);
  assert.equal(ok.rounds.length, ROUNDS_PAGE_SIZE + 1);
  assert.equal('gala_version' in ok.rounds[0], false, '轮次本身仍按白名单取字段');

  await assert.rejects(() => fetchAllRoundsVersioned(7, makeFetch(VB)), /rounds_version_changed/);

  const empty = await fetchAllRoundsVersioned(7, async () => ({ ok: true, status: 200, async json() { return { ok: true, data: [] }; } }));
  assert.deepEqual(empty, { rounds: [], dataVersion: null });
});

test('createSingleFlight 阻止并发并在在途请求结束后合并补拉一次', async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const resolvers = [];

  const run = createSingleFlight(() => {
    runs += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise((resolve) => {
      resolvers.push(() => {
        active -= 1;
        resolve(runs);
      });
    });
  });

  const p1 = run();
  run();
  run();
  assert.equal(runs, 1);
  assert.equal(maxActive, 1);

  resolvers.shift()();
  await p1;
  await new Promise((r) => setImmediate(r));

  assert.equal(runs, 2);
  assert.equal(maxActive, 1);
  resolvers.shift()();
});

test('src/admin-app/src/screen/ 目录下代码与注释不含敏感词且不引入 admin api.js', () => {
  const screenDir = fileURLToPath(new URL('../../src/admin-app/src/screen', import.meta.url));
  const entries = fs.readdirSync(screenDir);
  assert.ok(entries.includes('data.js'));
  assert.ok(entries.includes('useScreenData.js'));
  assert.ok(entries.includes('main.jsx'));

  for (const name of entries) {
    const full = path.join(screenDir, name);
    if (!fs.statSync(full).isFile()) continue;
    const text = fs.readFileSync(full, 'utf8');
    assert.doesNotMatch(text, /reserved/i, `${name} 不得出现英文 reserved`);
    assert.doesNotMatch(text, /预留/, `${name} 不得出现中文 预留`);
    assert.doesNotMatch(text, /from\s+['"][^'"]*api\.js['"]|from\s+['"]\.\.\/api['"]/, `${name} 不得引用管理端 api.js`);
  }
});

test('揭晓名字卡：超长名字最小字号单行放不下时折行且放得进卡片，常规名字仍单行', async () => {
  const { computeCardNameFit, estimateVisualUnits, NAME_LINE_HEIGHT, WRAP_MIN_FONT_PX } = await import('../../src/admin-app/src/screen/nameFit.js');
  const layouts = [
    { cols: 8, cardW: Math.floor((1760 - 7 * 16) / 8), cardH: 74, fontSize: 30, tier: 'dense', padX: 24, padY: 12 },
    { cols: 8, cardW: Math.floor((1760 - 7 * 20) / 8), cardH: 110, fontSize: 34, tier: 'compact', padX: 24, padY: 12 },
    { cols: 6, cardW: Math.floor((1760 - 5 * 24) / 6), cardH: 132, fontSize: 42, tier: 'normal', padX: 32, padY: 24 },
    { cols: 5, cardW: 328, cardH: 168, fontSize: 54, tier: 'medium', padX: 32, padY: 24 },
    { cols: 1, cardW: 900, cardH: 300, fontSize: 160, tier: 'hero', padX: 100, padY: 52 },
  ];
  const longNames = ['Christopher Alexander Montgomery-Williams', 'Maximilian Bartholomew Featherstonehaugh-Smythe', 'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ'];
  for (const layout of layouts) {
    for (const name of ['张三', '欧阳娜娜', 'Maria Garcia']) {
      const fit = computeCardNameFit(name, layout);
      assert.equal(fit.lines, 1, `${layout.tier} ${name}`);
      assert.ok(fit.fontSize * estimateVisualUnits(name) <= layout.cardW - layout.padX, `${layout.tier} ${name} 单行放得下`);
    }
    for (const name of longNames) {
      const fit = computeCardNameFit(name, layout);
      const lineWidth = (layout.cardW - layout.padX) * fit.lines;
      assert.ok(fit.fontSize >= WRAP_MIN_FONT_PX);
      assert.ok(fit.fontSize * estimateVisualUnits(name) <= lineWidth, `${layout.tier} ${name} 宽度放得下`);
      assert.ok(fit.lines * fit.fontSize * NAME_LINE_HEIGHT <= layout.cardH - layout.padY, `${layout.tier} ${name} 高度放得下`);
    }
  }
  assert.equal(computeCardNameFit('Christopher Alexander Montgomery-Williams', layouts[0]).lines > 1, true, '密集网格里的超长名字必须折行');
});
