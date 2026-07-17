#!/usr/bin/env node
/**
 * 检查 Express 路由是否在 OpenAPI paths 中有对应文档。
 * 退出码：有缺失或文档残留（extra）时返回 1（用于 CI 拦截）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerJSDoc from 'swagger-jsdoc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routesDir = path.join(root, 'src', 'routes');
const openapiGlob = path.join(root, 'src', 'routes', 'openapi', '*.openapi.js');

// 只匹配 router.METHOD / app.METHOD，避免误扫 db.get(...)
const ROUTE_RE = /\b(?:router|app)\s*\.\s*(get|post|put|delete|patch|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

const ROUTER_MOUNT = [
  ['health.js', '/health'],
  ['ledger.js', '/ledger'],
  ['exchange.js', '/exchange'],
  ['redeem.js', '/redeem'],
  ['web.js', '/web'],
  ['mall.js', '/mall'],
  ['admin.js', '/admin'],
  ['bobToken.js', '/bob-token'],
  ['users.js', '/users'],
  ['qrImage.js', '/qr'],
  ['docs.js', ''],
];

function normalizePath(p) {
  let out = String(p || '');
  if (!out.startsWith('/')) out = `/${out}`;
  out = out.replace(/\/+/g, '/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  out = out.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return out || '/';
}

function joinMount(mount, routePath) {
  if (!mount) return normalizePath(routePath);
  if (routePath === '/' || routePath === '') return normalizePath(mount);
  return normalizePath(`${mount}${routePath.startsWith('/') ? routePath : `/${routePath}`}`);
}

function collectExpressRoutes() {
  const found = new Map();
  for (const [file, mount] of ROUTER_MOUNT) {
    const full = path.join(routesDir, file);
    const filesToScan = [];
    if (file === 'admin.js') {
      // admin 已拆到 src/routes/admin/*，需一并扫描
      const adminDir = path.join(routesDir, 'admin');
      if (fs.existsSync(adminDir)) {
        for (const name of fs.readdirSync(adminDir)) {
          if (name.endsWith('.js')) filesToScan.push(path.join(adminDir, name));
        }
      }
      if (fs.existsSync(full)) filesToScan.push(full);
    } else if (fs.existsSync(full)) {
      filesToScan.push(full);
    }
    for (const scanFile of filesToScan) {
      const text = fs.readFileSync(scanFile, 'utf8');
      let m;
      const re = new RegExp(ROUTE_RE.source, ROUTE_RE.flags);
      while ((m = re.exec(text))) {
        const method = m[1].toUpperCase();
        const p = joinMount(mount, m[2]);
        const key = `${method} ${p}`;
        if (!found.has(key)) found.set(key, path.relative(routesDir, scanFile));
      }
    }
  }
  return found;
}

function collectOpenApiPaths() {
  const spec = swaggerJSDoc({
    definition: {
      openapi: '3.0.3',
      info: { title: 'bob coverage', version: '0.0.0' },
    },
    apis: [openapiGlob],
  });
  const out = new Set();
  const paths = spec?.paths || {};
  for (const [p, item] of Object.entries(paths)) {
    const np = normalizePath(p);
    for (const method of Object.keys(item || {})) {
      if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method)) {
        out.add(`${method.toUpperCase()} ${np}`);
      }
    }
  }
  return out;
}

function main() {
  const expressRoutes = collectExpressRoutes();
  const openapi = collectOpenApiPaths();
  const missing = [];
  for (const key of [...expressRoutes.keys()].sort()) {
    if (!openapi.has(key)) missing.push({ key, file: expressRoutes.get(key) });
  }
  const extra = [];
  for (const key of [...openapi].sort()) {
    if (!expressRoutes.has(key)) extra.push(key);
  }

  console.log(JSON.stringify({
    express_route_count: expressRoutes.size,
    openapi_operation_count: openapi.size,
    missing_count: missing.length,
    extra_count: extra.length,
    missing,
    extra,
  }, null, 2));

  if (missing.length || extra.length) process.exitCode = 1;
}

main();
