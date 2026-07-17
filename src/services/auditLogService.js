import { resolveClientIp, trustProxyFromReq } from '../utils/clientIp.js';

function toSafeText(value, maxLen = 2000) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!maxLen || text.length <= maxLen) return text;
  return text.slice(0, maxLen);
}

/**
 * 审计保留天数：
 * - 未配置或 <=0：不自动删除（默认，避免历史证据丢失）
 * - >0：仅在显式调用 purgeExpiredAuditLogs 时按天数清理
 * 写日志请求链中不再静默 DELETE。
 */
function configuredRetentionDays() {
  const raw = process.env.AUDIT_LOG_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

const AUDIT_LOG_CLEANUP_INTERVAL_SECONDS = 60 * 60;

let lastAuditLogCleanupAt = 0;
let auditLogCleanupPromise = null;

async function cleanupExpiredAuditLogs(db, nowTs, { force = false } = {}) {
  if (!db) return { skipped: true, reason: 'no_db' };
  const days = configuredRetentionDays();
  if (days <= 0) return { skipped: true, reason: 'retention_disabled', days: 0 };

  const currentTs = Number.isFinite(Number(nowTs)) ? Number(nowTs) : Math.floor(Date.now() / 1000);
  if (!force) {
    if (auditLogCleanupPromise) return auditLogCleanupPromise;
    if (lastAuditLogCleanupAt > 0 && currentTs - lastAuditLogCleanupAt < AUDIT_LOG_CLEANUP_INTERVAL_SECONDS) {
      return { skipped: true, reason: 'throttled', days };
    }
  }

  lastAuditLogCleanupAt = currentTs;
  const retentionSeconds = days * 24 * 60 * 60;
  auditLogCleanupPromise = (async () => {
    try {
      const result = await db.run(
        'DELETE FROM audit_logs WHERE created_at < ?',
        [currentTs - retentionSeconds],
      );
      return {
        ok: true,
        days,
        deleted: Number(result?.changes || 0),
        cutoff: currentTs - retentionSeconds,
      };
    } finally {
      auditLogCleanupPromise = null;
    }
  })();

  return auditLogCleanupPromise;
}

/** 显式清理入口；默认保留策略关闭时为 no-op。 */
export async function purgeExpiredAuditLogs(db, nowTs, options = {}) {
  return cleanupExpiredAuditLogs(db, nowTs, options);
}

export function getAuditLogRetentionDays() {
  return configuredRetentionDays();
}

export function getClientIp(req) {
  return resolveClientIp(req, { trustProxy: trustProxyFromReq(req) });
}

export async function appendAuditLog(
  db,
  {
    eventType,
    actorType = 'system',
    actorId = '',
    actorName = '',
    ip = '',
    method = '',
    path = '',
    statusCode = null,
    message = '',
    payload = null,
  } = {},
) {
  if (!db) return;
  const payloadText = payload === null || payload === undefined ? '' : JSON.stringify(payload);
  await db.run(
    `INSERT INTO audit_logs(
      event_type, actor_type, actor_id, actor_name, ip, method, path, status_code, message, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toSafeText(eventType || 'event', 120),
      toSafeText(actorType || 'system', 60),
      toSafeText(actorId, 120),
      toSafeText(actorName, 120),
      toSafeText(ip, 120),
      toSafeText(method, 20).toUpperCase(),
      toSafeText(path, 255),
      Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
      toSafeText(message, 2000),
      toSafeText(payloadText, 4000),
    ],
  );
  // 不在写路径上自动删除审计记录。
}

export async function safeAppendAuditLog(db, input) {
  try {
    await appendAuditLog(db, input);
  } catch {
    // 审计失败不阻断业务
  }
}
