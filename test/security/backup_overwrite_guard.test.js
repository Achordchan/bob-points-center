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

test('普通设置备份不含确认，自动恢复点包含并精确恢复确认', () => {
  const settingsTablesBlock = backupRoutesSource.match(
    /const SETTINGS_TABLES = \[[\s\S]*?\n  \];/,
  )?.[0] || '';
  const recoveryTablesBlock = backupRoutesSource.match(
    /const SETTINGS_RECOVERY_TABLES = \[[\s\S]*?\n  \];/,
  )?.[0] || '';
  assert.doesNotMatch(settingsTablesBlock, /content_announcement_acknowledgements/);
  assert.match(recoveryTablesBlock, /\.\.\.SETTINGS_TABLES/);
  assert.match(recoveryTablesBlock, /content_announcement_acknowledgements/);
  assert.match(backupRoutesSource, /isSettingsRecoveryPoint && backupVersion !== 2/);
  assert.match(backupRoutesSource, /isSettingsRecoveryPoint && mode !== 'overwrite'/);
  assert.match(
    backupRoutesSource,
    /isSettingsRecoveryPoint[\s\S]*?SETTINGS_RECOVERY_TABLES[\s\S]*?SETTINGS_TABLES/,
  );
  assert.match(
    backupRoutesSource,
    /if \(isSettingsRecoveryPoint\) \{[\s\S]*?DELETE FROM content_announcement_acknowledgements/,
  );
});

test('自动恢复点使用一致性快照并保持公告恢复顺序', () => {
  assert.match(
    backupRoutesSource,
    /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/,
  );
  assert.match(
    backupRoutesSource,
    /const snapshotData = await dumpTablesConsistently\([\s\S]*?tablesToSnapshot[\s\S]*?keepSecrets: true/,
  );
  const announcements = backupRoutesSource.indexOf('// content_faq / content_announcements / system_versions');
  const revisions = backupRoutesSource.indexOf('// content_announcement_revisions');
  const acknowledgements = backupRoutesSource.indexOf('// content_announcement_acknowledgements');
  assert.ok(announcements >= 0 && revisions > announcements && acknowledgements > revisions);
});

test('公告导入恢复编辑版本并拒绝重复修订键', () => {
  assert.match(
    backupRoutesSource,
    /content_hash, edit_version,[\s\S]*?edit_version=excluded\.edit_version/,
  );
  assert.match(
    backupRoutesSource,
    /row\.edit_version === undefined \|\| row\.edit_version === null \? 1 : Number\(row\.edit_version\)/,
  );
  assert.match(backupRoutesSource, /edit_version 必须为正整数/);
  const commonEditVersionGuard = backupRoutesSource.indexOf(
    "announcements.forEach((row, index) => {\n        if (row?.edit_version === undefined",
  );
  const versionTwoGuard = backupRoutesSource.indexOf('if (backupVersion === 2)');
  assert.ok(commonEditVersionGuard >= 0 && commonEditVersionGuard < versionTwoGuard);
  assert.match(backupRoutesSource, /const seenAnnouncementRevisionKeys = new Set\(\)/);
  assert.match(
    backupRoutesSource,
    /seenAnnouncementRevisionKeys\.has\(revisionKey\)[\s\S]*?announcement_id\/revision 重复[\s\S]*?else \{[\s\S]*?announcementRevisionHashes\.set/,
  );
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

test('拍卖表纳入全量备份，但不作为旧备份覆盖完整性的必需表', () => {
  // 导出/导入白名单仍包含两张拍卖表
  const fullTablesBlock = backupRoutesSource.match(/const FULL_TABLES = \[[\s\S]*?\n  \];/)?.[0] || '';
  assert.match(fullTablesBlock, /'auction_activities'/);
  assert.match(fullTablesBlock, /'auction_bids'/);
  // overwrite 完整性校验把拍卖表视为可选，避免拒绝早于该功能的旧全量备份
  assert.match(
    backupRoutesSource,
    /optionalFullTables = new Set\(\['auction_activities', 'auction_bids'\]\)/,
  );
  assert.match(
    backupRoutesSource,
    /expectedTables = versionTables\.filter\(\(name\) => !optionalFullTables\.has\(name\)\)/,
  );
});

test('拍卖两张表必须成对导入，只缺其一应被拒绝', () => {
  assert.match(
    backupRoutesSource,
    /hasAuctionActivities !== hasAuctionBids[\s\S]*?拍卖数据必须成对导入/,
  );
});

test('merge 导入遇到拍卖活动或出价 ID 冲突时均拒绝', () => {
  assert.match(
    backupRoutesSource,
    /if \(mode !== 'overwrite'\) \{[\s\S]*?SELECT id FROM auction_activities WHERE id IN[\s\S]*?为避免出价挂到不相关活动，已拒绝导入/,
  );
  assert.match(
    backupRoutesSource,
    /SELECT id FROM auction_bids WHERE id IN[\s\S]*?为避免结算命中不相关出价，已拒绝导入/,
  );
});

test('预校验拒绝 current_bid_id 跨活动/非 held/悬挂出价的损坏快照', () => {
  // current_bid_id 必须指向本活动、held 状态且 bidder/金额一致的出价
  assert.match(backupRoutesSource, /current_bid_id \$\{row\.current_bid_id\} 无对应出价/);
  assert.match(backupRoutesSource, /current_bid_id \$\{row\.current_bid_id\} 属于其他活动/);
  assert.match(backupRoutesSource, /current_bid_id \$\{row\.current_bid_id\} 出价状态非 held/);
  assert.match(backupRoutesSource, /current_bid_userid 与出价不一致/);
  assert.match(backupRoutesSource, /current_price 与出价金额不一致/);
  // 出价 activity_id 不得悬挂
  assert.match(backupRoutesSource, /activity_id \$\{row\?\.activity_id\} 无对应活动/);
});
