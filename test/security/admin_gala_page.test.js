import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canAccessNav, navPermissionMap } from '../../src/admin-app/src/permissions.js';
import { galaErrorText } from '../../src/admin-app/src/pages/gala/errors.js';

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
