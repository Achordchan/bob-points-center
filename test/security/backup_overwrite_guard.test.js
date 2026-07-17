import test from 'node:test';
import assert from 'node:assert/strict';

// 与 backupRoutes 一致的完整性规则（纯函数，避免加载 sharp/admin 全图）
function missingTablesForOverwrite(backupMode, backupDataKeys, fullTables, settingsTables) {
  const expected = backupMode === 'full' ? fullTables : settingsTables;
  return expected.filter((name) => !backupDataKeys.includes(name));
}

test('overwrite 缺少任意表应被拒绝', () => {
  const FULL = ['users', 'accounts', 'mall_products', 'system_settings'];
  const SETTINGS = ['system_settings', 'mall_products'];
  const missing = missingTablesForOverwrite('full', ['users', 'accounts'], FULL, SETTINGS);
  assert.deepEqual(missing, ['mall_products', 'system_settings']);
});

test('备份文件名允许秒级与随机后缀', () => {
  const re = /^bob_backup_(settings|full)_\d{8}_\d{4,6}(?:_[a-zA-Z0-9]+)?\.json$/;
  assert.match('bob_backup_full_20260717_1530.json', re);
  assert.match('bob_backup_settings_20260717_153045_ab12cd.json', re);
  assert.equal(re.test('evil.json'), false);
});
