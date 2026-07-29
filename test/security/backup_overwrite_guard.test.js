import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const backupRoutesPath = fileURLToPath(new URL('../../src/routes/admin/backupRoutes.js', import.meta.url));
const backupRoutesSource = readFileSync(backupRoutesPath, 'utf8');

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

test('设置覆盖按公告 ID 原位恢复，避免级联清空有效确认', () => {
  assert.match(
    backupRoutesSource,
    /DELETE FROM content_announcements WHERE id NOT IN \(\$\{placeholders\}\)/,
  );
  assert.match(
    backupRoutesSource,
    /overwriteSql:[\s\S]*?ON CONFLICT\(id\) DO UPDATE SET[\s\S]*?revision=excluded\.revision, content_hash=excluded\.content_hash/,
  );
  assert.doesNotMatch(
    backupRoutesSource,
    /table\.name === 'content_announcements'[\s\S]{0,400}DELETE FROM content_announcements`, \[\]/,
  );
});

test('设置覆盖仅清理与恢复后修订不匹配的确认', () => {
  assert.match(
    backupRoutesSource,
    /DELETE FROM content_announcement_acknowledgements ack[\s\S]*?NOT EXISTS[\s\S]*?revision\.revision = ack\.revision[\s\S]*?revision\.content_hash = ack\.content_hash/,
  );
  assert.doesNotMatch(
    backupRoutesSource,
    /content_announcement_acknowledgements overwrite delete all/,
  );
});
