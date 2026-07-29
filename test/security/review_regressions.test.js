import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const devSessionPath = fileURLToPath(new URL('../../scripts/dev-session.js', import.meta.url));
const devSessionSource = readFileSync(devSessionPath, 'utf8');
const composePath = fileURLToPath(new URL('../../docker-compose.yml', import.meta.url));
const composeSource = readFileSync(composePath, 'utf8');
const mallRoutesPath = fileURLToPath(new URL('../../src/routes/mall.js', import.meta.url));
const mallRoutesSource = readFileSync(mallRoutesPath, 'utf8');

test('开发会话在初始化前以只读方式验证数据库身份', () => {
  const preflightIndex = devSessionSource.indexOf("await preflight.query('BEGIN READ ONLY')");
  const initIndex = devSessionSource.indexOf('await initDb(cfg)');

  assert.ok(preflightIndex >= 0);
  assert.ok(initIndex > preflightIndex);
  assert.match(devSessionSource, /configuredDatabase !== expectedDatabase/);
  assert.match(devSessionSource, /current_database\(\).*current_setting\('bob\.environment', true\)/s);
  assert.match(devSessionSource, /identity\.environment[\s\S]*?development/);
  assert.match(composeSource, /bob\.environment=development/);
});

test('我的挂单查询返回 seller_note 供编辑表单回填', () => {
  const mineRoute = mallRoutesSource.match(
    /router\.get\('\/market\/mine'[\s\S]*?const listingRows = await db\.all\([\s\S]*?return res\.json\(/,
  )?.[0] || '';

  assert.match(mineRoute, /l\.price, l\.seller_note, l\.status/);
  assert.match(mallRoutesSource, /seller_note: row\?\.seller_note \? String\(row\.seller_note\) : ''/);
});
