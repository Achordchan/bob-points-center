#!/usr/bin/env node
/**
 * 轻量仓库检查：无额外 ESLint 依赖。
 * - 禁止提交 .bak 残留
 * - 禁止生产依赖使用 latest
 * - 关键核心模块可被 node 解析（语法）
 * - 覆盖路由/中间件/服务核心文件（不仅 11 个）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'admin-app-dist') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(path.join(root, 'src')).concat(walk(path.join(root, 'scripts')));
for (const f of files) {
  if (/\.bak(-\d+)?$/.test(f) || f.includes('.bak-')) {
    errors.push(`残留备份文件: ${path.relative(root, f)}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const [name, ver] of Object.entries(pkg.dependencies || {})) {
  if (String(ver).includes('latest')) {
    errors.push(`生产依赖未锁定版本: ${name}@${ver}`);
  }
}

const syntaxTargets = [
  'src/index.js',
  'src/app.js',
  'src/config.js',
  'src/docs/swagger.js',
  'src/routes/admin.js',
  'src/routes/admin/index.js',
  'src/routes/admin/shared.js',
  'src/routes/admin/contentRoutes.js',
  'src/routes/admin/settingsRoutes.js',
  'src/routes/admin/backupRoutes.js',
  'src/routes/ledger.js',
  'src/routes/redeem.js',
  'src/routes/mall.js',
  'src/routes/web.js',
  'src/routes/docs.js',
  'src/services/ledgerService.js',
  'src/services/redeemService.js',
  'src/services/bobTokenService.js',
  'src/services/adminSession.js',
  'src/services/auditLogService.js',
  'src/services/userDataPurgeService.js',
  'src/services/bobOpsService.js',
  'src/middleware/rateLimit.js',
  'src/middleware/requireBobToken.js',
  'src/middleware/requireSiteEnabled.js',
  'src/middleware/requireAdminSession.js',
  'src/middleware/requireWebSession.js',
  'src/utils/clientIp.js',
  'src/utils/sessionCrypto.js',
  'src/utils/sanitizeHtml.js',
  'scripts/check-openapi-coverage.mjs',
  'scripts/check-js-syntax.mjs',
];
for (const rel of syntaxTargets) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    errors.push(`缺少文件: ${rel}`);
    continue;
  }
  const r = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
  if (r.status !== 0) {
    errors.push(`语法错误 ${rel}: ${(r.stderr || r.stdout || '').trim()}`);
  }
}


// 构建产物不应进入 git 索引（.gitignore 已忽略；需 untrack 历史跟踪）
{
  const r = spawnSync('git', ['ls-files', 'src/pages/admin-app-dist'], { encoding: 'utf8', cwd: root });
  const tracked = String(r.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tracked.length) {
    errors.push(`构建产物仍在 git 索引 (${tracked.length} 个文件)。请执行: bash scripts/untrack-build-artifacts.sh`);
  }
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checked_files: syntaxTargets.length }, null, 2));
