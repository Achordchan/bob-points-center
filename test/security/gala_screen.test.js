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

function createMockDb({ events = [], rounds = [] } = {}) {
  const eventSet = new Set(events.map(Number));
  const roundList = rounds.map((r) => ({ id: Number(r.id), event_id: Number(r.event_id) }));
  return {
    async get(sql, params = []) {
      if (sql.includes('FROM gala_events')) {
        const eventId = Number(params[0]);
        return eventSet.has(eventId) ? { id: eventId } : null;
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
    () => setGalaScreenState(db, { eventId: 91002, mode: 'unknown' }),
    (err) => err instanceof GalaError && err.code === 'invalid_screen_mode' && err.status === 400,
  );

  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 91002, mode: 'rolling', segment: 'danmaku' }),
    (err) => err instanceof GalaError && err.code === 'invalid_segment' && err.status === 400,
  );

  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 91002, mode: 'rolling', segment: 'nonexistent' }),
    (err) => err instanceof GalaError && err.code === 'invalid_segment' && err.status === 400,
  );

  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 91002, mode: 'reveal' }),
    (err) => err instanceof GalaError && err.code === 'invalid_round_id' && err.status === 400,
  );

  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 91002, mode: 'reveal', roundId: 202 }),
    (err) => err instanceof GalaError && err.code === 'round_not_found' && err.status === 404,
  );

  await assert.rejects(
    () => setGalaScreenState(db, { eventId: 99999, mode: 'idle' }),
    (err) => err instanceof GalaError && err.code === 'event_not_found' && err.status === 404,
  );

  assert.equal(getGalaScreenState(91002).version, 0);
});

test('setGalaScreenState 成功切换状态并自增 version', async () => {
  const db = createMockDb({
    events: [91004],
    rounds: [{ id: 301, event_id: 91004 }],
  });

  const s1 = await setGalaScreenState(db, { eventId: 91004, mode: 'rolling', segment: 'lottery' });
  assert.equal(s1.event_id, 91004);
  assert.equal(s1.mode, 'rolling');
  assert.equal(s1.segment, 'lottery');
  assert.equal(s1.round_id, null);
  assert.equal(s1.version, 1);
  assert.equal(typeof s1.updated_at, 'number');

  const s2 = await setGalaScreenState(db, { eventId: 91004, mode: 'reveal', roundId: 301, segment: 'lottery' });
  assert.equal(s2.mode, 'reveal');
  assert.equal(s2.segment, null);
  assert.equal(s2.round_id, 301);
  assert.equal(s2.version, 2);

  const s3 = await setGalaScreenState(db, { eventId: 91004, mode: 'winners', roundId: 301 });
  assert.equal(s3.mode, 'winners');
  assert.equal(s3.segment, null);
  assert.equal(s3.round_id, null);
  assert.equal(s3.version, 3);

  const s4 = await setGalaScreenState(db, { eventId: 91004, mode: 'rolling' });
  assert.equal(s4.mode, 'rolling');
  assert.equal(s4.segment, null);
  assert.equal(s4.round_id, null);
  assert.equal(s4.version, 4);

  assert.deepEqual(getGalaScreenState(91004), s4);
});

test('revealRoundIfRolling：idle 时返回 null 不变，rolling 切到 reveal 且 version+1，重复同一轮不自增', async () => {
  // 1. 默认 idle（未写入 Map）时返回 null 且状态不变
  assert.equal(revealRoundIfRolling(91005, 401), null);
  assert.equal(getGalaScreenState(91005).mode, 'idle');
  assert.equal(getGalaScreenState(91005).version, 0);

  // 2. 显式设为 idle 时同样返回 null 且 version 不变
  const db = createMockDb({ events: [91006] });
  await setGalaScreenState(db, { eventId: 91006, mode: 'idle' });
  assert.equal(revealRoundIfRolling(91006, 402), null);
  assert.equal(getGalaScreenState(91006).mode, 'idle');
  assert.equal(getGalaScreenState(91006).version, 1);

  // 3. rolling 时切换到 reveal 且 version+1，重复同一轮返回 null 不再自增
  await setGalaScreenState(db, { eventId: 91006, mode: 'rolling', segment: 'giveaway' });
  assert.equal(getGalaScreenState(91006).version, 2);

  const revealed = revealRoundIfRolling(91006, 402);
  assert.ok(revealed);
  assert.equal(revealed.event_id, 91006);
  assert.equal(revealed.mode, 'reveal');
  assert.equal(revealed.segment, null);
  assert.equal(revealed.round_id, 402);
  assert.equal(revealed.version, 3);
  assert.equal(typeof revealed.updated_at, 'number');

  assert.equal(revealRoundIfRolling(91006, 402), null);
  assert.equal(getGalaScreenState(91006).version, 3);
  assert.equal(getGalaScreenState(91006).round_id, 402);
});

test('isPublicAdminPath：仅 GET /gala/screen 放行给路由自校验，POST 与 /gala/screen/state 不公开', () => {
  assert.equal(isPublicAdminPath('GET', '/gala/screen'), true);
  assert.equal(isPublicAdminPath('get', '/gala/screen'), true);
  assert.equal(isPublicAdminPath('POST', '/gala/screen'), false);
  assert.equal(isPublicAdminPath('post', '/gala/screen'), false);
  assert.equal(isPublicAdminPath('GET', '/gala/screen/state'), false);
  assert.equal(isPublicAdminPath('POST', '/gala/screen/state'), false);
});

test('GET /gala/screen 路由处理器自校验 gala:view 并在未登录/无权限时跳转 /admin/login', () => {
  const routesPath = fileURLToPath(new URL('../../src/routes/admin/galaRoutes.js', import.meta.url));
  const src = fs.readFileSync(routesPath, 'utf8');
  const start = src.indexOf("router.get('/gala/screen'");
  assert.ok(start >= 0, '缺少 GET /gala/screen 路由');
  const end = src.indexOf("router.get('/gala/segments'", start);
  const handlerSrc = end > start ? src.slice(start, end) : src.slice(start);

  assert.match(handlerSrc, /getAdminSessionPayload/);
  assert.match(handlerSrc, /getAdminAccess/);
  assert.match(handlerSrc, /hasAdminPermission\([^)]*['"]gala:view['"]/);
  assert.match(handlerSrc, /\/admin\/login\?redirect=/);
  assert.match(handlerSrc, /Cache-Control.*no-store/);
  assert.match(handlerSrc, /503/);
  assert.match(handlerSrc, /大屏页面未构建/);
});
