import test from 'node:test';
import assert from 'node:assert/strict';

function needsSuperForDownload({ modeHint, filename, details }) {
  const isFull = modeHint === 'full' || /^bob_backup_full_/.test(String(filename || ''));
  const isRecoveryPoint = details?.purpose === 'pre_import_recovery_point';
  const secretsNotRedacted = details?.secretsRedacted === false;
  return isFull || isRecoveryPoint || secretsNotRedacted;
}

test('设置恢复点下载需要超管', () => {
  assert.equal(
    needsSuperForDownload({
      modeHint: 'settings',
      filename: 'bob_backup_settings_20260717_120000_ab12.json',
      details: { purpose: 'pre_import_recovery_point', secretsRedacted: false },
    }),
    true,
  );
});

test('脱敏设置导出不需要超管（仅 export 权限）', () => {
  assert.equal(
    needsSuperForDownload({
      modeHint: 'settings',
      filename: 'bob_backup_settings_20260717_120000_ab12.json',
      details: { secretsRedacted: true },
    }),
    false,
  );
});

test('全量备份需要超管', () => {
  assert.equal(
    needsSuperForDownload({
      modeHint: 'full',
      filename: 'bob_backup_full_20260717_120000_ab12.json',
      details: { secretsRedacted: true },
    }),
    true,
  );
});
