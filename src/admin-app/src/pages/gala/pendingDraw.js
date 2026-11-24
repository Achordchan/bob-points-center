export const PENDING_DRAW_KEY_PREFIX = 'gala:pendingDraw:';

const NON_DEFINITIVE_CLIENT_STATUSES = new Set([401, 403, 408, 429]);

export function getPendingDrawKey(eventId) {
  return `${PENDING_DRAW_KEY_PREFIX}${eventId}`;
}

export function createAttemptId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid.trim().length > 0) {
      return uuid;
    }
  } catch {
    // 忽略异常，回退到时间戳 + 随机数
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isValidAttemptId(attemptId) {
  return typeof attemptId === 'string' && attemptId.trim().length > 0;
}

export function isSameAttempt(pending, attemptId) {
  if (!pending || typeof pending !== 'object') return false;
  if (!isValidAttemptId(attemptId)) return false;
  return pending.attempt_id === attemptId;
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
  if (!isValidAttemptId(record.attempt_id)) return false;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (Number(payload.event_id) !== Number(eventId)) return false;
  if (typeof payload.segment !== 'string' || !payload.segment) return false;
  const roundNo = Number(payload.round_no);
  if (!Number.isSafeInteger(roundNo) || roundNo < 1) return false;
  return true;
}

export function readPendingDraw(eventId) {
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

export const loadPendingDraw = readPendingDraw;

export function savePendingDraw(eventId, pending) {
  if (!eventId || !isValidPendingDraw(pending, eventId)) return false;
  try {
    const record = {
      attempt_id: pending.attempt_id,
      payload: pending.payload,
      segment_label: pending.segment_label,
    };
    globalThis.sessionStorage.setItem(getPendingDrawKey(eventId), JSON.stringify(record));
    return true;
  } catch {
    // sessionStorage 不可用时忽略，回退到仅使用组件 state
    return false;
  }
}

export function clearPendingDrawIfMatch(eventId, attemptId) {
  if (!eventId || !isValidAttemptId(attemptId)) return false;
  try {
    const key = getPendingDrawKey(eventId);
    const raw = globalThis.sessionStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.attempt_id !== attemptId) {
      return false;
    }
    globalThis.sessionStorage.removeItem(key);
    return true;
  } catch {
    // sessionStorage 不可用或数据损坏时忽略
    return false;
  }
}
