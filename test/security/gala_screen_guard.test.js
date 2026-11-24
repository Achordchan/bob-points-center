import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPublicAdminPath, matchPathPermission } from '../../src/services/adminPermissionService.js';
import { pickRound } from '../../src/admin-app/src/screen/data.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const screenDir = path.join(rootDir, 'src/admin-app/src/screen');

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), 'utf8');
}

function walkFiles(dir, exts, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, exts, out);
    } else if (ent.isFile() && exts.has(path.extname(ent.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out.sort();
}

// 去除 JS/JSX 注释（保留字符串字面量与模板字符串内容）
function stripJsComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        out += c;
        if (c === '\\' && i + 1 < n) {
          i += 1;
          out += source[i];
        } else if (c === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function extractRouteBlock(source, routeAnchor) {
  const start = source.indexOf(routeAnchor);
  assert.ok(start >= 0, `未找到路由定义：${routeAnchor}`);
  const nextRouteOffset = source.slice(start + routeAnchor.length).search(/\n\s*router\.(?:get|post|put|patch|delete)\(/);
  return nextRouteOffset >= 0
    ? source.slice(start, start + routeAnchor.length + nextRouteOffset)
    : source.slice(start);
}

test('1. 大屏源码与 screen.html 不含预留敏感词、交互控件标签或禁止的依赖导入', () => {
  const screenFiles = walkFiles(screenDir, new Set(['.js', '.jsx', '.css']));
  const screenHtmlPath = path.join(rootDir, 'src/admin-app/screen.html');
  assert.ok(screenFiles.length > 0, 'src/admin-app/src/screen/ 目录下未找到源码文件');
  assert.ok(fs.existsSync(screenHtmlPath), '缺少 src/admin-app/screen.html');

  const targets = [...screenFiles, screenHtmlPath];
  const forbiddenWords = [
    { label: 'reserved', pattern: /reserved/i },
    { label: 'is_reserved', pattern: /is_reserved/i },
    { label: '预留', pattern: /预留/ },
    { label: '名额', pattern: /名额/ },
  ];
  const forbiddenControls = [
    { label: '<button', pattern: /<button/i },
    { label: '<a ', pattern: /<a /i },
    { label: '<a>', pattern: /<a>/i },
    { label: '<input', pattern: /<input/i },
    { label: '<select', pattern: /<select/i },
    { label: '<textarea', pattern: /<textarea/i },
    { label: 'role="button"', pattern: /role="button"/i },
  ];
  const forbiddenImports = [
    {
      label: 'antd',
      pattern: /\b(?:import\s+(?:[^'"]+\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)['"]antd(?:\/[^'"]*)?['"]/i,
    },
    {
      label: 'three',
      pattern: /\b(?:import\s+(?:[^'"]+\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)['"]three(?:\/[^'"]*)?['"]/i,
    },
    {
      label: '../api.js 或 ../../api.js',
      pattern: /\b(?:import\s+(?:[^'"]+\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)['"]\.\.\/(?:\.\.\/)?api(?:\.js)?['"]/i,
    },
  ];

  for (const filePath of targets) {
    const rel = path.relative(rootDir, filePath);
    const content = fs.readFileSync(filePath, 'utf8');

    for (const rule of forbiddenWords) {
      assert.doesNotMatch(content, rule.pattern, `${rel} 不得包含敏感词 ${rule.label}`);
    }
    for (const rule of forbiddenControls) {
      assert.doesNotMatch(content, rule.pattern, `${rel} 不得包含交互控件 ${rule.label}`);
    }
    for (const rule of forbiddenImports) {
      assert.doesNotMatch(content, rule.pattern, `${rel} 不得导入 ${rule.label}`);
    }
  }
});

test('2. 大屏视图组件只消费数据层，不直接发起 fetch 或引用 /admin/', () => {
  const viewFiles = [
    'ScreenApp.jsx',
    'IdleView.jsx',
    'RollingView.jsx',
    'RevealView.jsx',
    'WinnersView.jsx',
    'NameSphere.jsx',
  ];

  for (const name of viewFiles) {
    const rel = `src/admin-app/src/screen/${name}`;
    const content = readRepoFile(rel);
    assert.doesNotMatch(content, /\bfetch\s*\(/, `${rel} 不得直接调用 fetch(`);
    assert.equal(content.includes('/admin/'), false, `${rel} 不得出现 /admin/`);
  }
});

test('3. 数据层采用白名单：data.js 无黑名单 delete 写法，pickRound 仅保留白名单键且 winners 为字符串数组', () => {
  const dataSource = readRepoFile('src/admin-app/src/screen/data.js');
  assert.equal(dataSource.includes('delete '), false, 'data.js 不得使用 delete 黑名单删除写法');
  assert.doesNotMatch(dataSource, /\bdelete\s+/, 'data.js 不得出现 delete 运算符');

  const rawRound = {
    id: 42,
    event_id: 7,
    segment: 'lottery',
    segment_label: '抽奖',
    round_no: 3,
    title: '特等奖',
    prize_type: 'coin',
    amount_each: 888,
    pool_id: 99,
    is_reserved: 1,
    userid: 'u_admin',
    amount: 1776,
    awarded: 1,
    grant_token: 'secret-token',
    eligible_count: 200,
    winners: [
      {
        id: 1,
        name: '张三',
        userid: 'u_001',
        is_reserved: 1,
        pool_id: 99,
        amount: 888,
        awarded: 1,
      },
      {
        id: 2,
        name: '李四',
        userid: 'u_002',
        is_reserved: 0,
        pool_id: 12,
        amount: 888,
        awarded: 0,
      },
    ],
  };

  const picked = pickRound(rawRound);
  assert.ok(picked && typeof picked === 'object');
  assert.deepEqual(
    Object.keys(picked).sort(),
    ['amount_each', 'id', 'prize_type', 'round_no', 'segment', 'segment_label', 'title', 'winners'],
  );
  assert.deepEqual(picked, {
    id: 42,
    segment: 'lottery',
    segment_label: '抽奖',
    round_no: 3,
    title: '特等奖',
    prize_type: 'coin',
    amount_each: 888,
    winners: ['张三', '李四'],
  });
  assert.equal(picked.winners.length, 2);
  for (const winner of picked.winners) {
    assert.equal(typeof winner, 'string');
  }
});

test('4. 大屏没有可见操作入口：jsx 无 onClick，键盘处理仅限全屏且源码含 requestFullscreen', () => {
  const jsxFiles = walkFiles(screenDir, new Set(['.jsx']));
  const allScriptFiles = walkFiles(screenDir, new Set(['.js', '.jsx']));
  assert.ok(jsxFiles.length > 0, 'src/admin-app/src/screen/ 目录下未找到 jsx 文件');

  for (const filePath of jsxFiles) {
    const rel = path.relative(rootDir, filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(content, /\bonClick\b/i, `${rel} 不得出现 onClick`);
  }

  let foundFullscreen = false;
  for (const filePath of allScriptFiles) {
    const rel = path.relative(rootDir, filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes('requestFullscreen')) {
      foundFullscreen = true;
    }
    if (/\b(?:keydown|keyup|keypress|onKeyDown|onKeyUp|onKeyPress)\b/.test(content)) {
      assert.match(content, /requestFullscreen/, `${rel} 的键盘处理必须仅用于全屏（缺少 requestFullscreen）`);
      assert.doesNotMatch(content, /\b(?:keyup|keypress|onKeyDown|onKeyUp|onKeyPress)\b/, `${rel} 不应绑定多余键盘事件`);
    }
  }
  assert.equal(foundFullscreen, true, '大屏源码中应包含 requestFullscreen 全屏处理');

  const screenAppSource = readRepoFile('src/admin-app/src/screen/ScreenApp.jsx');
  assert.match(screenAppSource, /requestFullscreen/);
  assert.match(screenAppSource, /addEventListener\(\s*['"]dblclick['"]/);
  assert.match(screenAppSource, /addEventListener\(\s*['"]keydown['"]/);
});

test('5. 权限与入口：matchPathPermission 与 isPublicAdminPath 映射准确', () => {
  assert.equal(matchPathPermission('POST', '/gala/screen/state'), 'gala:operate');
  assert.equal(matchPathPermission('GET', '/gala/screen/state'), 'gala:view');
  assert.equal(matchPathPermission('POST', '/GALA/Screen/State'), 'gala:operate');
  assert.equal(matchPathPermission('POST', '/gala/rounds/draw'), 'gala:operate');
  assert.equal(matchPathPermission('GET', '/gala/reserved'), 'super');

  assert.equal(isPublicAdminPath('GET', '/gala/screen'), true);
  assert.equal(isPublicAdminPath('GET', '/gala/screen/state'), false);
  assert.equal(isPublicAdminPath('GET', '/gala/rounds'), false);
});

test('6. 后台控制卡片权限、打开大屏链接、RoundsTab 渲染及无 is_reserved 代码', () => {
  const cardSource = readRepoFile('src/admin-app/src/pages/gala/ScreenControlCard.jsx');
  const roundsTabSource = readRepoFile('src/admin-app/src/pages/gala/RoundsTab.jsx');

  assert.equal(
    cardSource.includes("hasPermission(me, 'gala:operate')"),
    true,
    "ScreenControlCard.jsx 必须包含 hasPermission(me, 'gala:operate')",
  );
  assert.equal(
    cardSource.includes('/admin/gala/screen?event_id='),
    true,
    "ScreenControlCard.jsx 打开大屏必须使用 '/admin/gala/screen?event_id='",
  );
  assert.equal(
    roundsTabSource.includes('<ScreenControlCard'),
    true,
    'RoundsTab.jsx 必须渲染 <ScreenControlCard',
  );

  const cardCodeWithoutComments = stripJsComments(cardSource);
  assert.doesNotMatch(
    cardCodeWithoutComments,
    /is_reserved/i,
    'ScreenControlCard.jsx 代码（去掉注释后）不得出现 is_reserved',
  );
});

test('7. galaRoutes.js 抽签处理器在 try/catch 内调用 revealRoundIfRolling，状态接口推送 gala_screen 且带 scopes: [screen]', () => {
  const routesSource = readRepoFile('src/routes/admin/galaRoutes.js');

  const drawHandler = extractRouteBlock(routesSource, "router.post('/gala/rounds/draw'");
  const tryMatch = drawHandler.match(/try\s*\{[\s\S]*?\}\s*catch\b/);
  assert.ok(tryMatch, '抽签处理器中未找到 try/catch 块');
  const tryIdx = drawHandler.indexOf('try {');
  const revealIdx = drawHandler.indexOf('revealRoundIfRolling');
  const catchIdx = drawHandler.indexOf('catch', revealIdx);
  assert.ok(tryIdx >= 0, '抽签处理器缺少 try {');
  assert.ok(revealIdx > tryIdx, 'revealRoundIfRolling 必须出现在 try { 之后');
  assert.ok(catchIdx > revealIdx, 'revealRoundIfRolling 必须出现在 catch 之前');
  assert.match(
    drawHandler,
    /try\s*\{[\s\S]*?revealRoundIfRolling\s*\([\s\S]*?\}\s*catch\b/,
    'revealRoundIfRolling 必须被 try/catch 包住',
  );

  const screenStateHandler = extractRouteBlock(routesSource, "router.post('/gala/screen/state'");
  assert.match(
    screenStateHandler,
    /publishMallRealtimeEvent\s*\(\s*['"]gala_screen['"]\s*,\s*\{[\s\S]*?scopes\s*:\s*\[\s*['"]screen['"]\s*\][\s\S]*?\}\s*\)/,
    "POST /gala/screen/state 处理器必须发布 'gala_screen' 且带 scopes: ['screen']",
  );
});

test('8. 大屏控制带回数据版本：卡片提交 gala_version、版本错误交给页面刷新，状态接口按数据版本校验与作废', () => {
  const cardCode = stripJsComments(readRepoFile('src/admin-app/src/pages/gala/ScreenControlCard.jsx'));
  assert.match(cardCode, /gala_version\s*:/, '控制卡片提交必须带 gala_version');
  assert.match(cardCode, /onError\s*\(\s*err\s*\)/, '控制卡片出错必须交给页面的 onError 处理（版本变化时整页刷新）');

  const roundsTabCode = stripJsComments(readRepoFile('src/admin-app/src/pages/gala/RoundsTab.jsx'));
  const cardUse = roundsTabCode.slice(roundsTabCode.indexOf('<ScreenControlCard'));
  const cardTag = cardUse.slice(0, cardUse.indexOf('/>'));
  assert.match(cardTag, /galaVersion=\{galaVersion\}/, 'RoundsTab 必须把 galaVersion 传给控制卡片');
  assert.match(cardTag, /onError=\{handleError\}/, 'RoundsTab 必须把 handleError 传给控制卡片');

  const routesSource = readRepoFile('src/routes/admin/galaRoutes.js');
  const postHandler = extractRouteBlock(routesSource, "router.post('/gala/screen/state'");
  assert.match(postHandler, /expectedVersion\s*:\s*b\.gala_version/, 'POST /gala/screen/state 必须把 gala_version 交给服务层核对');
  const getHandler = extractRouteBlock(routesSource, "router.get('/gala/screen/state'");
  assert.match(getHandler, /currentDataVersion\s*:\s*await\s+readGalaDataVersion\(/, 'GET /gala/screen/state 必须按当前数据版本作废旧状态');
  const drawHandler = extractRouteBlock(routesSource, "router.post('/gala/rounds/draw'");
  assert.match(drawHandler, /revealRoundIfRolling\([^)]*dataVersion/, '抽签后自动揭晓必须带上数据版本');
});

test('9. 大屏读取失败与补拉揭晓轮次没有永久次数上限：指数退避（封顶）持续重试，卸载时清理定时器', () => {
  const hookCode = stripJsComments(readRepoFile('src/admin-app/src/screen/useScreenData.js'));
  assert.doesNotMatch(hookCode, /MAX_ROUND_BACKFILL_ATTEMPTS|roundBackfillAttempts/, '不得保留会永久耗尽的补拉次数上限');
  assert.match(hookCode, /RETRY_MAX_DELAY_MS/, '重试退避必须有封顶');
  assert.match(hookCode, /Math\.min\(\s*delay\s*\*\s*2\s*,\s*RETRY_MAX_DELAY_MS\s*\)/, '重试必须指数退避');
  for (const name of ['refreshEvent', 'refreshParticipants', 'refreshRounds', 'refreshSegments']) {
    assert.match(hookCode, new RegExp(`const ${name} = createRefresh\\(`), `${name} 失败后必须按退避重试`);
  }
  assert.match(hookCode, /refreshState = createRefresh\(/, '状态读取失败后必须按退避重试');
  const cleanup = hookCode.slice(hookCode.lastIndexOf('disposed = true'));
  assert.match(cleanup, /stopRoundBackfill\(\)/, '卸载时必须停止补拉循环');
  assert.match(cleanup, /for \(const stop of retryStops\) stop\(\)/, '卸载时必须清理重试定时器');
});

test('10. 大屏只在轮次与状态属于同一份数据时认定轮次已加载，数据版本变化时重拉缓存', () => {
  const hookCode = stripJsComments(readRepoFile('src/admin-app/src/screen/useScreenData.js'));
  assert.match(hookCode, /fetchAllRoundsVersioned\(/);
  assert.match(hookCode, /knownRoundIds\.has\(roundId\)\s*&&\s*roundsDataVersion === latestDataVersion/);
  assert.match(hookCode, /next\.data_version !== prevVersion[\s\S]*?refreshRounds\(\)/);
});

test('11. 大屏首次加载版本不一致会重拉轮次；SSE 不可用时状态轮询带着刷新轮次与活动，切到中奖榜也会拉最新轮次', () => {
  const hookCode = stripJsComments(readRepoFile('src/admin-app/src/screen/useScreenData.js'));
  const stateHandler = hookCode.slice(hookCode.indexOf('refreshState = createRefresh('), hookCode.indexOf('const refreshSegments'));
  assert.match(stateHandler, /roundsStale\s*=\s*roundsDataVersion !== null[\s\S]*?roundsDataVersion !== next\.data_version/);
  assert.match(stateHandler, /polling\s*=\s*!initial && !sseOpen/);
  assert.match(stateHandler, /enteredWinners\s*=\s*!initial && next\.mode === 'winners'/);
  assert.match(stateHandler, /if \(dataChanged \|\| roundsStale \|\| enteredWinners \|\| polling\) void refreshRounds\(\)/);
  assert.match(stateHandler, /if \(dataChanged \|\| polling\) void refreshEvent\(\)/);
  assert.match(hookCode, /sseOpen = true;/, 'SSE 连上时必须记下');
  assert.match(hookCode, /sseOpen = false;/, 'SSE 出错时必须记下');
  assert.match(hookCode, /lastRoundsReconcileKey/, '轮次触发的状态对账必须防止来回打转');
});
