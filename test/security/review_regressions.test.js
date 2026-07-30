import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiSpec } from '../../src/docs/swagger.js';

const devSessionPath = fileURLToPath(new URL('../../scripts/dev-session.js', import.meta.url));
const devSessionSource = readFileSync(devSessionPath, 'utf8');
const composePath = fileURLToPath(new URL('../../docker-compose.yml', import.meta.url));
const composeSource = readFileSync(composePath, 'utf8');
const mallRoutesPath = fileURLToPath(new URL('../../src/routes/mall.js', import.meta.url));
const mallRoutesSource = readFileSync(mallRoutesPath, 'utf8');
const mallAssetPath = fileURLToPath(new URL('../../src/pages/assets/mall.js', import.meta.url));
const mallAssetSource = readFileSync(mallAssetPath, 'utf8');
const syncScriptPath = fileURLToPath(new URL('../../scripts/sync-prod-to-local.sh', import.meta.url));
const syncScriptSource = readFileSync(syncScriptPath, 'utf8');

test('开发会话在初始化前以只读方式验证数据库身份', () => {
  const preflightIndex = devSessionSource.indexOf("await preflight.query('BEGIN READ ONLY')");
  const initIndex = devSessionSource.indexOf('await initDb(cfg)');

  assert.ok(preflightIndex >= 0);
  assert.ok(initIndex > preflightIndex);
  assert.match(devSessionSource, /configuredDatabase !== expectedDatabase/);
  assert.match(devSessionSource, /current_database\(\).*current_setting\('bob\.environment', true\)/s);
  assert.match(devSessionSource, /identity\.environment[\s\S]*?development/);
  assert.match(composeSource, /bob\.environment=development/);
  assert.match(devSessionSource, /cfg\.nodeEnv !== 'development'/);
  assert.match(devSessionSource, /devSessionSalt !== sessionSalt/);
  assert.match(devSessionSource, /adminSecret === webSecret/);
  assert.match(devSessionSource, /refreshSessionGlobalVersion\(db, cfg, \{[\s\S]*?force: true,[\s\S]*?throwOnError: true/);
});

test('生产同步在破坏操作前证明目标身份并使用单个恢复事务', () => {
  const dropIndex = syncScriptSource.indexOf("printf '%s\\n' 'DROP SCHEMA public CASCADE;'");
  const beginIndex = syncScriptSource.indexOf("printf '%s\\n' 'BEGIN;'");
  const restoreIndex = syncScriptSource.indexOf('pg_restore --no-owner --no-privileges --file=-');
  const commitIndex = syncScriptSource.indexOf("printf '%s\\n' 'COMMIT;'");
  const psqlIndex = syncScriptSource.indexOf('psql -U "${LOCAL_USER}" -d "${LOCAL_DB}" -v ON_ERROR_STOP=1');
  assert.ok(beginIndex >= 0 && dropIndex > beginIndex);
  assert.ok(restoreIndex > dropIndex && commitIndex > restoreIndex && psqlIndex > commitIndex);
  assert.doesNotMatch(syncScriptSource, /GRANT ALL ON SCHEMA public TO public/i);
  assert.doesNotMatch(syncScriptSource, /pg_restore[^\n]*--single-transaction/);
  for (const guard of [
    'DOCKER_HOST 指向非本地 Unix socket',
    'docker compose ps -q postgres',
    'com.docker.compose.service',
    'bob.environment',
    "current_setting('bob.environment', true)",
  ]) {
    const guardIndex = syncScriptSource.indexOf(guard);
    assert.ok(guardIndex >= 0, `缺少安全校验：${guard}`);
    assert.ok(guardIndex < dropIndex, `${guard} 必须在 DROP SCHEMA 前执行`);
  }
});

test('商城开放事件复用完整刷新并按需加载商品', () => {
  const openingHandler = mallAssetSource.match(
    /if \(eventName === 'opening_changed'\) \{[\s\S]*?return;/,
  )?.[0] || '';
  assert.match(openingHandler, /scheduleRealtimeTask\('opening',[\s\S]*?refreshOpeningOnce\(\)/);
  assert.doesNotMatch(openingHandler, /await loadMallOpening\(\)/);
  assert.match(mallAssetSource, /openingRefreshPromise: null/);
  assert.match(mallAssetSource, /openingRefreshPending: false/);
});

test('商城开放刷新在 in-flight 事件后补跑一次', async () => {
  const functionSource = mallAssetSource.match(
    /function refreshOpeningOnce\(\) \{[\s\S]*?\n  \}/,
  )?.[0] || '';
  assert.ok(functionSource);

  const pendingResolvers = [];
  let calls = 0;
  const state = {
    openingRefreshPromise: null,
    openingRefreshPending: false,
    opening: null,
    products: [],
  };
  const loadMallOpening = () => {
    calls++;
    return new Promise((resolve) => pendingResolvers.push(resolve));
  };
  const refreshOpeningOnce = new Function(
    'state',
    'loadMallOpening',
    'isMallOpen',
    'loadProducts',
    'renderProductsWithFilterAndOrder',
    `${functionSource}; return refreshOpeningOnce;`,
  )(state, loadMallOpening, () => false, async () => [], () => {});

  const first = refreshOpeningOnce();
  await Promise.resolve();
  assert.equal(calls, 1);
  const second = refreshOpeningOnce();
  assert.equal(second, first);
  assert.equal(calls, 1);

  pendingResolvers.shift()();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  pendingResolvers.shift()();
  await first;
  assert.equal(state.openingRefreshPromise, null);
  assert.equal(state.openingRefreshPending, false);
});

test('商城开放刷新在失败期间收到事件时继续补跑', async () => {
  const functionSource = mallAssetSource.match(
    /function refreshOpeningOnce\(\) \{[\s\S]*?\n  \}/,
  )?.[0] || '';
  assert.ok(functionSource);

  const pendingRequests = [];
  let calls = 0;
  const state = {
    openingRefreshPromise: null,
    openingRefreshPending: false,
    opening: null,
    products: [],
  };
  const loadMallOpening = () => {
    calls++;
    return new Promise((resolve, reject) => pendingRequests.push({ resolve, reject }));
  };
  const refreshOpeningOnce = new Function(
    'state',
    'loadMallOpening',
    'isMallOpen',
    'loadProducts',
    'renderProductsWithFilterAndOrder',
    `${functionSource}; return refreshOpeningOnce;`,
  )(state, loadMallOpening, () => false, async () => [], () => {});

  const first = refreshOpeningOnce();
  await Promise.resolve();
  const second = refreshOpeningOnce();
  assert.equal(second, first);
  pendingRequests.shift().reject(new Error('首轮失败'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);

  pendingRequests.shift().resolve();
  await first;
  assert.equal(state.openingRefreshPromise, null);
  assert.equal(state.openingRefreshPending, false);

  const terminal = refreshOpeningOnce();
  await Promise.resolve();
  pendingRequests.shift().reject(new Error('最终失败'));
  await assert.rejects(terminal, /最终失败/);
  assert.equal(state.openingRefreshPromise, null);
  assert.equal(state.openingRefreshPending, false);
});

test('生成后的 OpenAPI 描述备份导出和公告编辑版本', () => {
  const spec = buildOpenApiSpec({ baseUrl: 'http://127.0.0.1:8000' });
  const exportSchema = spec.components.schemas.AdminBackupExportResponse;
  assert.deepEqual(exportSchema.required, ['_meta', 'data']);
  assert.equal(exportSchema.additionalProperties, false);
  assert.equal(exportSchema.properties.ok, undefined);
  assert.equal(exportSchema.properties.file, undefined);
  assert.equal(exportSchema.properties.path, undefined);
  assert.equal(exportSchema.properties.meta, undefined);
  assert.ok(spec.paths['/admin/backup/export'].get.responses['403']);

  const listOperation = spec.paths['/admin/content/announcements'].get;
  assert.equal(
    listOperation.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/AdminAnnouncementListResponse',
  );
  assert.equal(spec.components.schemas.AdminAnnouncementItem.properties.edit_version.minimum, 1);
  assert.equal(spec.components.schemas.AnnouncementItem.properties.edit_version, undefined);

  const saveOperation = spec.paths['/admin/content/announcements/save'].post;
  assert.equal(saveOperation.requestBody.content['application/json'].schema.properties.edit_version.minimum, 1);
  assert.equal(spec.components.schemas.AdminAnnouncementSaveResponse.properties.edit_version.minimum, 1);
  assert.equal(spec.components.schemas.AnnouncementConflictResponse.properties.current.properties.edit_version.minimum, 1);
});

test('我的挂单查询返回 seller_note 供编辑表单回填', () => {
  const mineRoute = mallRoutesSource.match(
    /router\.get\('\/market\/mine'[\s\S]*?const listingRows = await db\.all\([\s\S]*?return res\.json\(/,
  )?.[0] || '';

  assert.match(mineRoute, /l\.price, l\.seller_note, l\.status/);
  assert.match(mallRoutesSource, /seller_note: row\?\.seller_note \? String\(row\.seller_note\) : ''/);
});
