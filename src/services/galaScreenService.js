// 年会大屏展示状态（进程内 Map）。
// 注意：这是纯展示状态，不是业务数据，进程重启后回到待机（idle），按单实例部署设计。
import { GalaError, GALA_DRAW_SEGMENTS } from './galaService.js';

export const GALA_SCREEN_MODES = new Set(['idle', 'rolling', 'reveal', 'winners']);

const screenStates = new Map();

function toStrictInt(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function toPositiveId(value, max = Number.MAX_SAFE_INTEGER) {
  const n = toStrictInt(value);
  return n !== null && n > 0 && n <= max ? n : null;
}

export function getGalaScreenState(eventId) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id', 400);
  const existing = screenStates.get(id);
  if (!existing) {
    return {
      event_id: id,
      mode: 'idle',
      segment: null,
      round_id: null,
      version: 0,
      updated_at: null,
    };
  }
  return { ...existing };
}

export async function setGalaScreenState(db, { eventId, mode, segment, roundId } = {}) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id', 400);

  const normalizedMode = typeof mode === 'string' ? mode.trim() : '';
  if (!GALA_SCREEN_MODES.has(normalizedMode)) {
    throw new GalaError('invalid_screen_mode', 400);
  }

  let nextSegment = null;
  if (normalizedMode === 'rolling' && segment !== undefined && segment !== null && segment !== '') {
    if (typeof segment !== 'string') throw new GalaError('invalid_segment', 400);
    const seg = segment.trim();
    if (!GALA_DRAW_SEGMENTS.has(seg)) throw new GalaError('invalid_segment', 400);
    nextSegment = seg;
  }

  let nextRoundId = null;
  if (normalizedMode === 'reveal') {
    const rid = toPositiveId(roundId);
    if (!rid) throw new GalaError('invalid_round_id', 400);
    nextRoundId = rid;
  }

  const event = await db.get('SELECT id FROM gala_events WHERE id = ?', [id]);
  if (!event) throw new GalaError('event_not_found', 404);

  if (normalizedMode === 'reveal') {
    const round = await db.get('SELECT id FROM gala_rounds WHERE id = ? AND event_id = ?', [nextRoundId, id]);
    if (!round || (round.event_id !== undefined && Number(round.event_id) !== id)) {
      throw new GalaError('round_not_found', 404);
    }
  }

  const prev = screenStates.get(id);
  const next = {
    event_id: id,
    mode: normalizedMode,
    segment: nextSegment,
    round_id: nextRoundId,
    version: (prev?.version || 0) + 1,
    updated_at: Date.now(),
  };
  screenStates.set(id, next);
  return { ...next };
}

export function revealRoundIfRolling(eventId, roundId) {
  const id = toPositiveId(eventId);
  const rid = toPositiveId(roundId);
  if (!id || !rid) return null;

  const current = screenStates.get(id);
  if (!current || current.mode !== 'rolling') return null;

  const next = {
    event_id: id,
    mode: 'reveal',
    segment: null,
    round_id: rid,
    version: current.version + 1,
    updated_at: Date.now(),
  };
  screenStates.set(id, next);
  return { ...next };
}
