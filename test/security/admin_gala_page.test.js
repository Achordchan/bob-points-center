import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canAccessNav, navPermissionMap } from '../../src/admin-app/src/permissions.js';
import { galaErrorText } from '../../src/admin-app/src/pages/gala/errors.js';
import {
  clearPendingDrawIfMatch,
  createAttemptId,
  getPendingDrawKey,
  isAmbiguousDrawError,
  isDefinitiveDrawRejection,
  isSameAttempt,
  loadPendingDraw,
  PENDING_DRAW_KEY_PREFIX,
  readPendingDraw,
  savePendingDraw,
} from '../../src/admin-app/src/pages/gala/pendingDraw.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readRepoFile = (relPath) => readFileSync(path.join(rootDir, relPath), 'utf8');

const appShellSource = readRepoFile('src/admin-app/src/components/AppShell.jsx');
const appSource = readRepoFile('src/admin-app/src/App.jsx');
const eventDetailSource = readRepoFile('src/admin-app/src/pages/gala/EventDetail.jsx');
const galaErrorsSource = readRepoFile('src/admin-app/src/pages/gala/errors.js');
const galaServiceSource = readRepoFile('src/services/galaService.js');

test('后台权限映射包含年会管理导航权限 gala -> gala:view', () => {
  assert.equal(navPermissionMap.gala, 'gala:view');
  assert.equal(canAccessNav({ permissions: ['gala:view'] }, 'gala'), true);
  assert.equal(canAccessNav({ permissions: ['dashboard:view'] }, 'gala'), false);
  assert.equal(canAccessNav({ isSuperAdmin: true, permissions: [] }, 'gala'), true);
});

test('AppShell 侧边栏包含 key 为 gala、标签为“年会管理”的菜单项', () => {
  const navItemsBlock = appShellSource.match(/export const navItems = \[[\s\S]*?\];/)?.[0] || '';
  assert.ok(navItemsBlock, 'AppShell.jsx 缺少 navItems 定义');
  assert.match(navItemsBlock, /\{\s*key:\s*'gala'[^}]*label:\s*'年会管理'\s*\}/);
});

test('App.jsx 懒加载 ./pages/Gala.jsx 且无权限回退列表包含 gala', () => {
  const pagesBlock = appSource.match(/const pages = \{[\s\S]*?\};/)?.[0] || '';
  assert.ok(pagesBlock, 'App.jsx 缺少 pages 路由表');
  assert.match(pagesBlock, /gala:\s*lazy\(\(\)\s*=>\s*import\('\.\/pages\/Gala\.jsx'\)\)/);

  const fallbackMatch = appSource.match(/const fallback = \[([^\]]+)\]/);
  assert.ok(fallbackMatch, 'App.jsx 缺少 fallback 导航列表');
  assert.match(fallbackMatch[1], /'gala'/);
});

test('EventDetail 的预留名额 Tab 受 isSuperAdmin 控制且其他 gala 文件不引用预留接口', () => {
  assert.match(eventDetailSource, /const ReservedTab = lazy\(\(\)\s*=>\s*import\('\.\/ReservedTab\.jsx'\)\)/);
  assert.match(eventDetailSource, /const isSuperAdmin = me\?\.isSuperAdmin === true;/);

  const baseTabItemsBlock = eventDetailSource.match(/const tabItems = \[[\s\S]*?\];/)?.[0] || '';
  assert.ok(baseTabItemsBlock, 'EventDetail.jsx 缺少 tabItems 定义');
  assert.doesNotMatch(baseTabItemsBlock, /'reserved'|预留名额/);

  assert.match(
    eventDetailSource,
    /if\s*\(isSuperAdmin\)\s*\{[\s\S]*?key:\s*'reserved'[\s\S]*?label:\s*'预留名额'[\s\S]*?<ReservedTab[\s\S]*?\}/,
  );

  const galaDir = path.join(rootDir, 'src/admin-app/src/pages/gala');
  const entries = readdirSync(galaDir, { withFileTypes: true }).filter((ent) => ent.isFile());
  assert.ok(entries.length > 2, 'src/admin-app/src/pages/gala/ 目录文件异常');

  const allowedFiles = new Set(['ReservedTab.jsx', 'EventDetail.jsx']);
  for (const ent of entries) {
    if (allowedFiles.has(ent.name)) continue;
    const content = readFileSync(path.join(galaDir, ent.name), 'utf8');
    assert.doesNotMatch(
      content,
      /\/admin\/gala\/reserved/,
      `${ent.name} 不应包含 /admin/gala/reserved`,
    );
  }
});

test('gala/errors.js 覆盖 galaService.js 中全部 GalaError 错误码', () => {
  const codes = new Set();

  for (const match of galaServiceSource.matchAll(/new GalaError\(\s*'([a-z0-9_]+)'/g)) {
    codes.add(match[1]);
  }
  assert.match(galaServiceSource, /'pool_budget_exceeded'/);
  codes.add('pool_budget_exceeded');

  assert.match(galaServiceSource, /'gala_data_changed'/);
  codes.add('gala_data_changed');

  assert.ok(codes.size > 0, '未能从 galaService.js 提取到任何 GalaError 错误码');

  for (const code of codes) {
    assert.match(
      galaErrorsSource,
      new RegExp(`\\b${code}\\b`),
      `errors.js 缺少错误码映射：${code}`,
    );
    const text = galaErrorText({ code });
    assert.ok(
      text && !text.includes(`错误码：${code}`),
      `galaErrorText(${code}) 不应落回默认兜底文案，实际返回：${text}`,
    );
  }
});

test('EventDetail 环节列表加载失败可提示并在刷新时恢复加载', () => {
  assert.match(eventDetailSource, /环节列表加载失败/);
  const refreshHandlerBlock =
    eventDetailSource.match(/const handleRefresh = \(\) => \{[\s\S]*?\n  \};/)?.[0] || '';
  assert.ok(refreshHandlerBlock, 'EventDetail.jsx 缺少 handleRefresh 刷新逻辑');
  assert.match(refreshHandlerBlock, /\breload\(/);
  assert.match(refreshHandlerBlock, /\bloadSegments\(/);
  assert.match(eventDetailSource, /onClick=\{handleRefresh\}[\s\S]*?>\s*刷新\s*<\/Button>/);
});

test('gala 目录包含待确认抽签的保存、重试、清除逻辑并使用 sessionStorage 与 gala:pendingDraw: 键前缀', () => {
  const galaDir = path.join(rootDir, 'src/admin-app/src/pages/gala');
  const entries = readdirSync(galaDir, { withFileTypes: true }).filter((ent) => ent.isFile());
  const combinedSource = entries
    .map((ent) => readFileSync(path.join(galaDir, ent.name), 'utf8'))
    .join('\n');

  assert.match(combinedSource, /\bsessionStorage\b/, 'gala 目录应使用 sessionStorage 持久化待确认抽签');
  assert.match(combinedSource, /gala:pendingDraw:/, 'gala 目录应使用 gala:pendingDraw: 键前缀');
  assert.match(combinedSource, /\bsavePendingDraw\b/, 'gala 目录缺少待确认抽签保存逻辑');
  assert.match(combinedSource, /\breadPendingDraw\b/, 'gala 目录缺少待确认抽签读取逻辑');
  assert.match(combinedSource, /\bclearPendingDrawIfMatch\b/, 'gala 目录缺少待确认抽签清除逻辑');
  assert.match(combinedSource, /\bisAmbiguousDrawError\b/, 'gala 目录缺少结果不明错误判定逻辑');
  assert.match(combinedSource, /按原参数重试/, 'RoundsTab 缺少按原参数重试按钮');
  assert.match(combinedSource, /放弃这次尝试/, 'RoundsTab 缺少放弃这次尝试按钮');

  const roundsTabSource = readRepoFile('src/admin-app/src/pages/gala/RoundsTab.jsx');
  const drawModalSource = readRepoFile('src/admin-app/src/pages/gala/DrawModal.jsx');
  assert.match(drawModalSource, /isAmbiguousDrawError\(err\)/);
  assert.match(roundsTabSource, /api\('\/admin\/gala\/rounds\/draw',[\s\S]*?body:\s*targetPending\.payload/);
  assert.match(roundsTabSource, /savePendingDraw\(/);
  assert.match(roundsTabSource, /clearPendingDrawIfMatch\(/);

  // 行为校验：错误分类与 sessionStorage 存取删
  assert.equal(PENDING_DRAW_KEY_PREFIX, 'gala:pendingDraw:');
  assert.equal(getPendingDrawKey(42), 'gala:pendingDraw:42');
  assert.equal(isAmbiguousDrawError(new TypeError('Failed to fetch')), true);
  assert.equal(isAmbiguousDrawError({ status: 502, code: '' }), true);
  assert.equal(isAmbiguousDrawError({ status: 500, code: 'internal_error' }), true);
  assert.equal(isAmbiguousDrawError({ status: 400, code: '' }), true);
  assert.equal(isAmbiguousDrawError({ status: 409, code: 'round_no_changed' }), false);
  assert.equal(isAmbiguousDrawError({ status: 400, code: 'not_enough_participants' }), false);
  assert.equal(isAmbiguousDrawError({ status: 409, code: 'gala_data_changed' }), false);

  const store = new Map();
  const prevStorage = globalThis.sessionStorage;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
  });
  try {
    const sample = {
      attempt_id: 'attempt-sample-1',
      payload: {
        event_id: 42,
        segment: 'lucky',
        title: '一等奖',
        draw_count: 2,
        prize_type: 'coin',
        pool_id: 7,
        amount_each: 100,
        exclude_previous_winners: true,
        round_no: 3,
        gala_version: 'v1',
      },
      segment_label: '幸运抽奖',
    };
    savePendingDraw(42, sample);
    assert.ok(store.has('gala:pendingDraw:42'));
    assert.deepEqual(loadPendingDraw(42), sample);
    assert.deepEqual(readPendingDraw(42), sample);
    assert.equal(loadPendingDraw(99), null);
    assert.equal(clearPendingDrawIfMatch(42, 'other-attempt'), false);
    assert.deepEqual(readPendingDraw(42), sample);
    assert.equal(clearPendingDrawIfMatch(42, 'attempt-sample-1'), true);
    assert.equal(readPendingDraw(42), null);
  } finally {
    if (prevStorage === undefined) {
      delete globalThis.sessionStorage;
    } else {
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: prevStorage,
      });
    }
  }
});

test('待确认抽签错误分类排除 401/403，发请求前持久化，且 round_no_changed 版本变化时关闭旧表单', () => {
  const pendingDrawSource = readRepoFile('src/admin-app/src/pages/gala/pendingDraw.js');
  const drawModalSource = readRepoFile('src/admin-app/src/pages/gala/DrawModal.jsx');
  const roundsTabSource = readRepoFile('src/admin-app/src/pages/gala/RoundsTab.jsx');

  // pendingDraw.js 导出 isDefinitiveDrawRejection，且源码排除 401、403
  assert.equal(typeof isDefinitiveDrawRejection, 'function');
  assert.match(pendingDrawSource, /export\s+function\s+isDefinitiveDrawRejection\b/);
  assert.match(
    pendingDrawSource,
    /NON_DEFINITIVE_CLIENT_STATUSES\s*=\s*new Set\(\[[^\]]*\b401\b[^\]]*\b403\b[^\]]*\]\)/,
  );
  assert.match(pendingDrawSource, /NON_DEFINITIVE_CLIENT_STATUSES\.has\(err\.status\)/);
  assert.equal(isDefinitiveDrawRejection({ status: 401, code: 'unauthorized' }), false);
  assert.equal(isDefinitiveDrawRejection({ status: 403, code: 'forbidden' }), false);
  assert.equal(isDefinitiveDrawRejection({ status: 409, code: 'round_no_changed' }), true);

  // DrawModal.jsx 在调用 /admin/gala/rounds/draw 之前先保存待确认抽签
  const beforeDrawIdx = drawModalSource.indexOf('onBeforeDraw?.(');
  const drawApiIdx = drawModalSource.indexOf("api('/admin/gala/rounds/draw'");
  assert.ok(beforeDrawIdx !== -1, 'DrawModal.jsx 缺少 onBeforeDraw 调用');
  assert.ok(drawApiIdx !== -1, "DrawModal.jsx 缺少 api('/admin/gala/rounds/draw') 调用");
  assert.ok(beforeDrawIdx < drawApiIdx, 'DrawModal.jsx 应在发起抽签请求前保存待确认抽签');

  // DrawModal.jsx 的 round_no_changed 分支比较版本并在不同时关闭弹窗
  const roundNoChangedBlock =
    drawModalSource.match(/if\s*\(err\?\.code === 'round_no_changed'\)\s*\{[\s\S]*?\n          \}/)?.[0] || '';
  assert.ok(roundNoChangedBlock, 'DrawModal.jsx 缺少 round_no_changed 处理分支');
  assert.match(roundNoChangedBlock, /await\s+onRefreshAll\(\)/);
  assert.match(roundNoChangedBlock, /gala_version/);
  assert.match(
    roundNoChangedBlock,
    /if\s*\(!latestDetail\s*\|\|\s*latestVersion\s*!==\s*version\)\s*\{[\s\S]*?onCancel\(\)[\s\S]*?数据已变化，请重新发起抽签[\s\S]*?return;/,
  );

  // RoundsTab.jsx 的 refreshAll 不再调用 setDrawModal 修改 version
  const refreshAllBlock =
    roundsTabSource.match(/const refreshAll = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/)?.[0] || '';
  assert.ok(refreshAllBlock, 'RoundsTab.jsx 缺少 refreshAll 定义');
  assert.doesNotMatch(refreshAllBlock, /\bsetDrawModal\b/, 'RoundsTab.refreshAll 不应调用 setDrawModal 修改 version');
  assert.match(refreshAllBlock, /return\s+latestDetail\b/, 'RoundsTab.refreshAll 应返回 latestDetail');
});

test('待确认抽签按 attempt_id 匹配清除，且 attempt_id 不进入后端 payload', () => {
  const pendingDrawSource = readRepoFile('src/admin-app/src/pages/gala/pendingDraw.js');
  const drawModalSource = readRepoFile('src/admin-app/src/pages/gala/DrawModal.jsx');

  // pendingDraw.js 有 createAttemptId 且使用 randomUUID
  assert.equal(typeof createAttemptId, 'function');
  const createAttemptBlock =
    pendingDrawSource.match(/export\s+function\s+createAttemptId\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(createAttemptBlock, 'pendingDraw.js 缺少 createAttemptId 实现');
  assert.match(createAttemptBlock, /randomUUID/, 'createAttemptId 应优先使用 randomUUID');
  const id1 = createAttemptId();
  const id2 = createAttemptId();
  assert.equal(typeof id1, 'string');
  assert.ok(id1.trim().length > 0);
  assert.notEqual(id1, id2);

  // clearPendingDrawIfMatch 里比较 attempt_id
  const clearIfMatchBlock =
    pendingDrawSource.match(/export\s+function\s+clearPendingDrawIfMatch\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(clearIfMatchBlock, 'pendingDraw.js 缺少 clearPendingDrawIfMatch 实现');
  assert.match(
    clearIfMatchBlock,
    /attempt_id\s*!==\s*attemptId|attempt_id\s*===\s*attemptId/,
    'clearPendingDrawIfMatch 应比较 attempt_id',
  );

  // DrawModal.jsx 生成 attempt_id 后再调用 onBeforeDraw
  const createAttemptIdx = drawModalSource.indexOf('createAttemptId(');
  const beforeDrawIdx = drawModalSource.indexOf('onBeforeDraw?.(');
  assert.ok(createAttemptIdx !== -1, 'DrawModal.jsx 缺少 createAttemptId() 调用');
  assert.ok(beforeDrawIdx !== -1, 'DrawModal.jsx 缺少 onBeforeDraw 调用');
  assert.ok(createAttemptIdx < beforeDrawIdx, 'DrawModal.jsx 应在调用 onBeforeDraw 前生成 attempt_id');

  // 发给后端的 payload 对象里不包含 attempt_id
  const payloadBlock = drawModalSource.match(/const\s+payload\s*=\s*\{[\s\S]*?\};/)?.[0] || '';
  assert.ok(payloadBlock, 'DrawModal.jsx 缺少 payload 对象定义');
  assert.doesNotMatch(payloadBlock, /\battempt_id\b/, '发给后端的 payload 不应包含 attempt_id');
  assert.doesNotMatch(drawModalSource, /payload\.attempt_id\s*=/, '不应向 payload 写入 attempt_id');

  // 行为校验：isSameAttempt 与缺少 attempt_id 的记录校验
  assert.equal(isSameAttempt({ attempt_id: 'a1' }, 'a1'), true);
  assert.equal(isSameAttempt({ attempt_id: 'a1' }, 'a2'), false);
  assert.equal(isSameAttempt({ attempt_id: '' }, ''), false);
  assert.equal(isSameAttempt(null, 'a1'), false);

  const store = new Map();
  const prevStorage = globalThis.sessionStorage;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
  });
  try {
    const basePayload = {
      event_id: 7,
      segment: 'lucky',
      round_no: 1,
    };
    // 缺少 attempt_id 视为无效
    store.set('gala:pendingDraw:7', JSON.stringify({ payload: basePayload, segment_label: '幸运抽奖' }));
    assert.equal(readPendingDraw(7), null);
    assert.equal(savePendingDraw(7, { payload: basePayload, segment_label: '幸运抽奖' }), false);

    // 迟到的旧 attempt 不会清除新 attempt
    const newer = { attempt_id: 'attempt-new', payload: { ...basePayload, round_no: 2 }, segment_label: '幸运抽奖' };
    assert.equal(savePendingDraw(7, newer), true);
    assert.equal(clearPendingDrawIfMatch(7, 'attempt-old'), false);
    assert.deepEqual(readPendingDraw(7), newer);
    assert.equal(clearPendingDrawIfMatch(7, 'attempt-new'), true);
    assert.equal(readPendingDraw(7), null);
  } finally {
    if (prevStorage === undefined) {
      delete globalThis.sessionStorage;
    } else {
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: prevStorage,
      });
    }
  }
});
