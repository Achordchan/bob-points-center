function toSafeText(value, maxLen = 2000) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!maxLen || text.length <= maxLen) return text;
  return text.slice(0, maxLen);
}

const AUDIT_LOG_RETENTION_DAYS = 30;
const AUDIT_LOG_RETENTION_SECONDS = AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60;
const AUDIT_LOG_CLEANUP_INTERVAL_SECONDS = 60 * 60;

let lastAuditLogCleanupAt = 0;
let auditLogCleanupPromise = null;

async function cleanupExpiredAuditLogs(db, nowTs) {
  if (!db) return;
  const currentTs = Number.isFinite(Number(nowTs)) ? Number(nowTs) : Math.floor(Date.now() / 1000);
  if (auditLogCleanupPromise) return auditLogCleanupPromise;
  if (lastAuditLogCleanupAt > 0 && currentTs - lastAuditLogCleanupAt < AUDIT_LOG_CLEANUP_INTERVAL_SECONDS) return;

  lastAuditLogCleanupAt = currentTs;
  auditLogCleanupPromise = (async () => {
    try {
      await db.run(
        'DELETE FROM audit_logs WHERE created_at < ?',
        [currentTs - AUDIT_LOG_RETENTION_SECONDS],
      );
    } finally {
      auditLogCleanupPromise = null;
    }
  })();

  return auditLogCleanupPromise;
}

export async function purgeExpiredAuditLogs(db, nowTs) {
  await cleanupExpiredAuditLogs(db, nowTs);
}

export function getClientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  const fromHeader = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = fromHeader ? String(fromHeader).split(',')[0].trim() : '';
  if (first) return first;
  return String(req?.socket?.remoteAddress || '');
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
  const nowTs = Math.floor(Date.now() / 1000);
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
  await purgeExpiredAuditLogs(db, nowTs);
}

export async function safeAppendAuditLog(db, record) {
  try {
    await appendAuditLog(db, record);
  } catch {
    // ignore log write errors
  }
}

