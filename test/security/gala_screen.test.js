import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPublicAdminPath, matchPathPermission } from '../../src/services/adminPermissionService.js';
import { GalaError } from '../../src/services/galaService.js';
import {
  getGalaScreenState,
  revealRoundIfRolling,
  setGalaScreenState,
} from '../../src/services/galaScreenService.js';

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';

// 模拟数据库：支持事务、恢复互斥锁、数据版本（gala_restore_state）与“本活动最大轮次 ID”查询。
function createMockDb({ events = [], rounds = [], version = V1 } = {}) {
  const eventSet = new Set(events.map(Number));
  const roundList = rounds.map((r) => ({ id: Number(r.id), event_id: Number(r.event_id) }));
  const db = {
    version,
    roundList,
    async transaction(fn) {
      return await fn(db);
    },
    async get(sql, params = []) {
      if (sql.includes('pg_advisory_xact_lock_shared')) return { locked: true };
      if (sql.includes('FROM gala_restore_state')) return { version_token: db.version };
      if (sql.includes('FROM gala_events')) {
        const eventId = Number(params[0]);
        return eventSet.has(eventId) ? { id: eventId } : null;
      }
      if (sql.includes('MAX(id)') && sql.includes('FROM gala_rounds')) {
        const eventId = Number(params[0]);
        const ids = roundList.filter((r) => r.event_id === eventId).map((r) => r.id);
        return { max_id: ids.length ? Math.max(...ids) : 0 };
      }
      if (sql.includes('FROM gala_rounds')) {
        const roundId = Number(params[0]);
        const eventId = Number(params[1]);
        const hit = roundList.find((r) => r.id === roundId && r.event_id === eventId);
        return hit ? { id: hit.id, event_id: hit.event_id } : null;
      }
      return null;
    },
  };
  return db;
}

test('年会大屏状态接口权限映射（含大小写变体）', () => {
  assert.equal(matchPathPermission('POST', '/gala/screen/state'), 'gala:operate');
  assert.equal(matchPathPermission('POST', '/GALA/Screen/State'), 'gala:operate');
  assert.equal(matchPathPermission('post', '/Gala/SCREEN/state'), 'gala:operate');
  assert.equal(matchPathPermission('GET', '/gala/screen/state'), 'gala:view');
  assert.equal(matchPathPermission('GET', '/GALA/Screen/State'), 'gala:view');
  assert.equal(matchPathPermission('get', '/gala/SCREEN/STATE'), 'gala:view');
});

test('getGalaScreenState 未设置时默认返回 idle，非法 eventId 抛错', () => {
  const state = getGalaScreenState(91001);
  assert.deepEqual(state, {
    event_id: 91001,
    mode: 'idle',
    segment: null,
    round_id: null,
    version: 0,
    updated_at: null,
  });
  assert.deepEqual(getGalaScreenState('91001'), state);

  for (const bad of [undefined, null, '', 0, -1, 1.5, 'abc', true]) {
    assert.throws(
      () => getGalaScreenState(bad),
      (err) => err instanceof GalaError && err.code === 'invalid_event_id' && err.status === 400,
      String(bad),
    );
  }
});

test('setGalaScreenState 参数校验：非法 mode、rolling 非法 segment、reveal 缺 round_id、活动或轮次不存在', async () => {
  const db = createMockDb({
    events: [91002, 91003],
    rounds: [
      { id: 101, event_id: 91002 },
      { id: 202, event_id: 91003 },
    ],
  });

  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 91002, mode: 'unknown', expectedVersion: V1 }),
    (err) => err instanceof GalaError && err.code === 'invalid_screen_mode' && err.status === 400,
  );

  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 91002, mode: 'rolling', segment: 'danmaku', expectedVersion: V1 }),
    (err) => err instanceof GalaError && err.code === 'invalid_segment' && err.status === 400,
  );

  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 91002, mode: 'rolling', segment: 'nonexistent', expectedVersion: V1 }),
    (err) => err instanceof GalaError && err.code === 'invalid_segment' && err.status === 400,
  );

  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 91002, mode: 'reveal', expectedVersion: V1 }),
    (err) => err instanceof GalaError && err.code === 'invalid_round_id' && err.status === 400,
  );

  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 91002, mode: 'reveal', roundId: 202, expectedVersion: V1 }),
    (err) => err instanceof GalaError && err.code === 'round_not_found' && err.status === 404,
  );

  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 99999, mode: 'idle', expectedVersion: V1 }),
    (err) => err instanceof GalaError && err.code === 'event_not_found' && err.status === 404,
  );

  assert.equal(getGalaScreenState(91002).version, 0);
});

test('setGalaScreenState 成功切换状态并自增 version', async () => {
  const db = createMockDb({
    events: [91004],
    rounds: [{ id: 301, event_id: 91004 }],
  });

  const s1 = await setGalaScreenState(db, { eventId: 91004, mode: 'rolling', segment: 'lottery', expectedVersion: V1 });
  assert.equal(s1.event_id, 91004);
  assert.equal(s1.mode, 'rolling');
  assert.equal(s1.segment, 'lottery');
  assert.equal(s1.round_id, null);
  assert.equal(s1.version, 1);
  assert.equal(typeof s1.updated_at, 'number');

  const s2 = await setGalaScreenState(db, { eventId: 91004, mode: 'reveal', roundId: 301, segment: 'lottery', expectedVersion: V1 });
  assert.equal(s2.mode, 'reveal');
  assert.equal(s2.segment, null);
  assert.equal(s2.round_id, 301);
  assert.equal(s2.version, 2);

  const s3 = await setGalaScreenState(db, { eventId: 91004, mode: 'winners', roundId: 301, expectedVersion: V1 });
  assert.equal(s3.mode, 'winners');
  assert.equal(s3.segment, null);
  assert.equal(s3.round_id, null);
  assert.equal(s3.version, 3);

  const s4 = await setGalaScreenState(db, { eventId: 91004, mode: 'rolling', expectedVersion: V1 });
  assert.equal(s4.mode, 'rolling');
  assert.equal(s4.segment, null);
  assert.equal(s4.round_id, null);
  assert.equal(s4.version, 4);

  assert.deepEqual(getGalaScreenState(91004), s4);
});

test('revealRoundIfRolling：idle 时返回 null 不变，rolling 切到 reveal 且 version+1，重复同一轮不自增', async () => {
  // 1. 默认 idle（未写入 Map）时返回 null 且状态不变
  assert.equal(revealRoundIfRolling(91005, 401, { segment: 'lottery', dataVersion: V1 }), null);
  assert.equal(getGalaScreenState(91005).mode, 'idle');
  assert.equal(getGalaScreenState(91005).version, 0);

  // 2. 显式设为 idle 时同样返回 null 且 version 不变
  const db = createMockDb({ events: [91006] });
  await setGalaScreenState(db, { eventId: 91006, mode: 'idle', expectedVersion: V1 });
  assert.equal(revealRoundIfRolling(91006, 402, { segment: 'giveaway', dataVersion: V1 }), null);
  assert.equal(getGalaScreenState(91006).mode, 'idle');
  assert.equal(getGalaScreenState(91006).version, 1);

  // 3. rolling 时切换到 reveal 且 version+1，重复同一轮返回 null 不再自增
  await setGalaScreenState(db, { eventId: 91006, mode: 'rolling', segment: 'giveaway', expectedVersion: V1 });
  assert.equal(getGalaScreenState(91006).version, 2);

  const revealed = revealRoundIfRolling(91006, 402, { segment: 'giveaway', dataVersion: V1 });
  assert.ok(revealed);
  assert.equal(revealed.event_id, 91006);
  assert.equal(revealed.mode, 'reveal');
  assert.equal(revealed.segment, null);
  assert.equal(revealed.round_id, 402);
  assert.equal(revealed.version, 3);
  assert.equal(typeof revealed.updated_at, 'number');

  assert.equal(revealRoundIfRolling(91006, 402, { segment: 'giveaway', dataVersion: V1 }), null);
  assert.equal(getGalaScreenState(91006).version, 3);
  assert.equal(getGalaScreenState(91006).round_id, 402);
});

test('revealRoundIfRolling：重试滚动开始前已抽完的旧轮次不打断滚动，滚动后新抽的轮次照常揭晓（含补发）', async () => {
  const db = createMockDb({
    events: [91007],
    rounds: [
      { id: 501, event_id: 91007 },
      { id: 502, event_id: 91007 },
    ],
  });
  await setGalaScreenState(db, { eventId: 91007, mode: 'rolling', segment: 'lottery', expectedVersion: V1 });
  const rollingVersion = getGalaScreenState(91007).version;

  // 旧轮次（ID 不大于开始滚动时的最大轮次）重放：不动大屏
  assert.equal(revealRoundIfRolling(91007, 501, { segment: 'lottery', dataVersion: V1 }), null);
  assert.equal(revealRoundIfRolling(91007, 502, { segment: 'lottery', dataVersion: V1 }), null);
  assert.equal(getGalaScreenState(91007).mode, 'rolling');
  assert.equal(getGalaScreenState(91007).version, rollingVersion);

  // 其他环节、其他数据版本的新轮次：也不动大屏
  assert.equal(revealRoundIfRolling(91007, 503, { segment: 'giveaway', dataVersion: V1 }), null);
  assert.equal(revealRoundIfRolling(91007, 503, { segment: 'lottery', dataVersion: V2 }), null);
  assert.equal(revealRoundIfRolling(91007, 503, { segment: 'lottery' }), null);
  assert.equal(getGalaScreenState(91007).mode, 'rolling');

  // 滚动开始后新抽出的轮次（第一次没来得及揭晓、重试补发也一样）：揭晓
  const revealed = revealRoundIfRolling(91007, 503, { segment: 'lottery', dataVersion: V1 });
  assert.equal(revealed?.mode, 'reveal');
  assert.equal(revealed.round_id, 503);
  assert.equal(revealed.version, rollingVersion + 1);
  assert.equal(Object.hasOwn(revealed, 'data_version'), false, '内部字段不对外返回');

  // 揭晓后再开始滚动：刚揭晓过的 503 被重试也不会再打断
  db.roundList.push({ id: 503, event_id: 91007 });
  await setGalaScreenState(db, { eventId: 91007, mode: 'rolling', expectedVersion: V1 });
  assert.equal(revealRoundIfRolling(91007, 503, { segment: 'lottery', dataVersion: V1 }), null);
  assert.equal(getGalaScreenState(91007).mode, 'rolling');
  // 未指定环节时，任意环节的新轮次都揭晓
  assert.equal(revealRoundIfRolling(91007, 504, { segment: 'giveaway', dataVersion: V1 })?.round_id, 504);
});

test('setGalaScreenState 必须带回当前数据版本：缺失、格式错误或恢复后旧版本一律拒绝，大屏不变', async () => {
  const db = createMockDb({ events: [91008], rounds: [{ id: 601, event_id: 91008 }] });
  await setGalaScreenState(db, { eventId: 91008, mode: 'winners', expectedVersion: V1 });
  const before = getGalaScreenState(91008);

  for (const bad of [undefined, null, '', 'not-a-uuid', 123]) {
    await assert.rejects(
      () => setGalaScreenState(db, { eventId: 91008, mode: 'reveal', roundId: 601, expectedVersion: bad }),
      (err) => err instanceof GalaError && err.code === 'invalid_gala_version',
      String(bad),
    );
  }

  db.version = V2; // 模拟全量恢复：同一个轮次 ID 已是另一份数据
  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 91008, mode: 'reveal', roundId: 601, expectedVersion: V1 }),
    (err) => err instanceof GalaError && err.code === 'gala_data_changed' && err.status === 409,
  );
  assert.deepEqual(getGalaScreenState(91008), before);

  const ok = await setGalaScreenState(db, { eventId: 91008, mode: 'reveal', roundId: 601, expectedVersion: V2 });
  assert.equal(ok.mode, 'reveal');
});

test('getGalaScreenState：数据版本变化后旧状态作废回到待机，version 自增且只作废一次', async () => {
  const db = createMockDb({ events: [91009], rounds: [{ id: 701, event_id: 91009 }] });
  const set = await setGalaScreenState(db, { eventId: 91009, mode: 'reveal', roundId: 701, expectedVersion: V1 });

  assert.deepEqual(getGalaScreenState(91009, { currentDataVersion: V1 }), set);

  const reset = getGalaScreenState(91009, { currentDataVersion: V2 });
  assert.equal(reset.mode, 'idle');
  assert.equal(reset.round_id, null);
  assert.equal(reset.version, set.version + 1);
  assert.deepEqual(Object.keys(reset).sort(), ['event_id', 'mode', 'round_id', 'segment', 'updated_at', 'version']);

  assert.deepEqual(getGalaScreenState(91009, { currentDataVersion: V2 }), reset);

  // 恢复前开始的滚动，恢复后抽出的轮次不会揭晓
  await setGalaScreenState(db, { eventId: 91009, mode: 'rolling', expectedVersion: V1 });
  db.version = V2;
  assert.equal(revealRoundIfRolling(91009, 702, { segment: 'lottery', dataVersion: V2 }), null);
  assert.equal(getGalaScreenState(91009).mode, 'rolling');
});

test('isPublicAdminPath：仅 GET /gala/screen 放行给路由自校验，POST 与 /gala/screen/state 不公开', () => {
  assert.equal(isPublicAdminPath('GET', '/gala/screen'), true);
  assert.equal(isPublicAdminPath('get', '/gala/screen'), true);
  assert.equal(isPublicAdminPath('POST', '/gala/screen'), false);
  assert.equal(isPublicAdminPath('post', '/gala/screen'), false);
  assert.equal(isPublicAdminPath('GET', '/gala/screen/state'), false);
  assert.equal(isPublicAdminPath('POST', '/gala/screen/state'), false);
});

test('GET /gala/screen 路由处理器自校验 gala:view：未登录带 redirect 跳登录，无权限直接跳 /admin/login 避免死循环', () => {
  const routesPath = fileURLToPath(new URL('../../src/routes/admin/galaRoutes.js', import.meta.url));
  const src = fs.readFileSync(routesPath, 'utf8');
  const start = src.indexOf("router.get('/gala/screen'");
  assert.ok(start >= 0, '缺少 GET /gala/screen 路由');
  const end = src.indexOf("router.get('/gala/segments'", start);
  const handlerSrc = end > start ? src.slice(start, end) : src.slice(start);

  assert.match(handlerSrc, /getAdminSessionPayload/);
  assert.match(handlerSrc, /getAdminAccess/);
  assert.match(handlerSrc, /hasAdminPermission\([^)]*['"]gala:view['"]/);
  assert.match(handlerSrc, /Cache-Control.*no-store/);
  assert.match(handlerSrc, /503/);
  assert.match(handlerSrc, /大屏页面未构建/);

  const unauthBranch = handlerSrc.match(/if\s*\(\s*!payload\s*\)\s*\{([\s\S]*?)\}/);
  assert.ok(unauthBranch, '缺少未登录跳转分支');
  assert.match(unauthBranch[1], /res\.redirect\(\s*302\s*,\s*`\/admin\/login\?redirect=/);

  const noPermBranch = handlerSrc.match(/if\s*\(\s*!access\?\.ok\s*\|\|\s*!hasAdminPermission\([^)]*['"]gala:view['"]\s*\)\s*\)\s*\{([\s\S]*?)\}/);
  assert.ok(noPermBranch, '缺少无权限跳转分支');
  assert.match(noPermBranch[1], /res\.redirect\(\s*302\s*,\s*['"]\/admin\/login['"]\s*\)/);
  assert.doesNotMatch(noPermBranch[1], /redirect=/, '无权限分支跳转地址不得包含 redirect=，避免已登录用户死循环');
});
