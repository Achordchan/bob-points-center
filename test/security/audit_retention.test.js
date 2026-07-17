import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuditLogRetentionDays, purgeExpiredAuditLogs } from '../../src/services/auditLogService.js';

test('默认不自动清理审计（保留天数 0）', () => {
  const prev = process.env.AUDIT_LOG_RETENTION_DAYS;
  delete process.env.AUDIT_LOG_RETENTION_DAYS;
  try {
    assert.equal(getAuditLogRetentionDays(), 0);
  } finally {
    if (prev === undefined) delete process.env.AUDIT_LOG_RETENTION_DAYS;
    else process.env.AUDIT_LOG_RETENTION_DAYS = prev;
  }
});

test('未配置保留天数时 purge 为 no-op', async () => {
  const prev = process.env.AUDIT_LOG_RETENTION_DAYS;
  delete process.env.AUDIT_LOG_RETENTION_DAYS;
  let deleted = false;
  const db = {
    async run() {
      deleted = true;
      return { changes: 1 };
    },
  };
  try {
    const r = await purgeExpiredAuditLogs(db);
    assert.equal(r.skipped, true);
    assert.equal(deleted, false);
  } finally {
    if (prev === undefined) delete process.env.AUDIT_LOG_RETENTION_DAYS;
    else process.env.AUDIT_LOG_RETENTION_DAYS = prev;
  }
});
