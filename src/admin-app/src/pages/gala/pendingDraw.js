export const PENDING_DRAW_KEY_PREFIX = 'gala:pendingDraw:';

const NON_DEFINITIVE_CLIENT_STATUSES = new Set([401, 403, 408, 429]);

export function getPendingDrawKey(eventId) {
  return `${PENDING_DRAW_KEY_PREFIX}${eventId}`;
}

export function isDefinitiveDrawRejection(err) {
  if (!err || typeof err !== 'object') return false;
  if (typeof err.status !== 'number' || !Number.isFinite(err.status)) return false;
  if (err.status < 400 || err.status >= 500) return false;
  if (NON_DEFINITIVE_CLIENT_STATUSES.has(err.status)) return false;
  const code = typeof err.code === 'string' ? err.code.trim() : '';
  return code.length > 0;
}

export function isAmbiguousDrawError(err) {
  return !isDefinitiveDrawRejection(err);
}

export function isAuthDrawError(err) {
  return Boolean(err && typeof err === 'object' && (err.status === 401 || err.status === 403));
}

function isValidPendingDraw(record, eventId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (Number(payload.event_id) !== Number(eventId)) return false;
  if (typeof payload.segment !== 'string' || !payload.segment) return false;
  const roundNo = Number(payload.round_no);
  if (!Number.isSafeInteger(roundNo) || roundNo < 1) return false;
  return true;
}

export function loadPendingDraw(eventId) {
  if (!eventId) return null;
  try {
    const raw = globalThis.sessionStorage.getItem(getPendingDrawKey(eventId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidPendingDraw(parsed, eventId) ? parsed : null;
  } catch {
    return null;
  }
}

export function savePendingDraw(eventId, pending) {
  if (!eventId || !pending) return;
  try {
    globalThis.sessionStorage.setItem(getPendingDrawKey(eventId), JSON.stringify(pending));
  } catch {
    // sessionStorage 不可用时忽略，回退到仅使用组件 state
  }
}

export function clearPendingDraw(eventId) {
  if (!eventId) return;
  try {
    globalThis.sessionStorage.removeItem(getPendingDrawKey(eventId));
  } catch {
    // sessionStorage 不可用时忽略
  }
}
