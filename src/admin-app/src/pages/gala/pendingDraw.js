export const PENDING_DRAW_KEY_PREFIX = 'gala:pendingDraw:';

export function getPendingDrawKey(eventId) {
  return `${PENDING_DRAW_KEY_PREFIX}${eventId}`;
}

export function isAmbiguousDrawError(err) {
  if (!err || typeof err !== 'object') return true;
  if (typeof err.status !== 'number' || !Number.isFinite(err.status)) return true;
  if (err.status >= 500) return true;
  const code = typeof err.code === 'string' ? err.code.trim() : '';
  if (!code) return true;
  return false;
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
