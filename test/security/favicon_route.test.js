import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('员工端和管理端声明站点图标且资源存在', () => {
  const root = process.cwd();
  const htmlFiles = [
    'src/pages/mall.html',
    'src/pages/mall_screen.html',
    'src/pages/admin_login.html',
    'src/pages/admin.html',
    'src/admin-app/index.html',
  ];
  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(html, /<link rel="icon" type="image\/png" href="\/assets\/favicon\.png" \/>/);
  }
  assert.ok(fs.statSync(path.join(root, 'src/pages/assets/favicon.png')).size > 0);
});
