// 年会大屏展示状态（进程内 Map）。
// 注意：这是纯展示状态，不是业务数据，进程重启后回到待机（idle），按单实例部署设计。
// 每条状态记下写入时的数据版本（gala_version）：全量恢复会换版本并可能复用同一批活动/轮次 ID，
// 版本变了的旧状态不再展示，读取时回到待机。
// 滚动状态还记下开始滚动时本活动已有的最大轮次 ID：只有之后新抽出的轮次才自动揭晓，
// 重试一次早已抽完的旧轮次（抽签接口幂等重放）不会打断正在进行的滚动。
import { GalaError, GALA_DRAW_SEGMENTS, enterGalaVersionedWrite } from './galaService.js';

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

function toPublic(state) {
  return {
    event_id: state.event_id,
    mode: state.mode,
    segment: state.segment,
    round_id: state.round_id,
    version: state.version,
    updated_at: state.updated_at,
  };
}

function idleState(eventId) {
  return {
    event_id: eventId,
    mode: 'idle',
    segment: null,
    round_id: null,
    version: 0,
    updated_at: null,
  };
}

async function inTx(db, fn) {
  if (db?.__txScoped === true) return await fn(db);
  return await db.transaction(fn);
}

// currentDataVersion：调用方读到的当前数据版本。给了且和状态写入时的版本不同，说明期间做过全量恢复，
// 旧状态（尤其是揭晓的轮次 ID）可能指向另一份数据：作废并回到待机，version 继续自增，让订阅端刷新。
export function getGalaScreenState(eventId, { currentDataVersion } = {}) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id', 400);
  const existing = screenStates.get(id);
  if (!existing) return idleState(id);
  if (typeof currentDataVersion === 'string' && existing.data_version !== currentDataVersion) {
    const next = {
      ...idleState(id),
      version: existing.version + 1,
      updated_at: Date.now(),
      data_version: currentDataVersion,
      reveal_after_round_id: 0,
    };
    screenStates.set(id, next);
    return toPublic(next);
  }
  return toPublic(existing);
}

// expectedVersion：控制卡片读到数据时的 gala_version，必传。在恢复互斥的共享锁内核对，
// 恢复后旧页面选中的轮次 ID 可能已是另一轮，不能拿它切换大屏。
export async function setGalaScreenState(db, { eventId, mode, segment, roundId, expectedVersion } = {}) {
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

  const checked = await inTx(db, async (tx) => {
    const dataVersion = await enterGalaVersionedWrite(tx, expectedVersion);

    const event = await tx.get('SELECT id FROM gala_events WHERE id = ?', [id]);
    if (!event) throw new GalaError('event_not_found', 404);

    if (normalizedMode === 'reveal') {
      const round = await tx.get('SELECT id FROM gala_rounds WHERE id = ? AND event_id = ?', [nextRoundId, id]);
      if (!round || (round.event_id !== undefined && Number(round.event_id) !== id)) {
        throw new GalaError('round_not_found', 404);
      }
    }

    let revealAfterRoundId = 0;
    if (normalizedMode === 'rolling') {
      const last = await tx.get('SELECT COALESCE(MAX(id), 0) AS max_id FROM gala_rounds WHERE event_id = ?', [id]);
      revealAfterRoundId = Number(last?.max_id || 0);
    }
    return { dataVersion, revealAfterRoundId };
  });

  // 校验通过、事务结束后才改内存状态：校验失败或事务出错时大屏保持原样。
  // 万一提交后、写入前恰好做完一次全量恢复，记下的旧版本会在下一次读取时被识别并作废。
  const prev = screenStates.get(id);
  const next = {
    event_id: id,
    mode: normalizedMode,
    segment: nextSegment,
    round_id: nextRoundId,
    version: (prev?.version || 0) + 1,
    updated_at: Date.now(),
    data_version: checked.dataVersion,
    reveal_after_round_id: checked.revealAfterRoundId,
  };
  screenStates.set(id, next);
  return toPublic(next);
}

// 抽签成功后调用：大屏正在滚动，且这一轮是开始滚动之后才抽出的（同一份数据、同一环节），才切到揭晓。
// 早于滚动开始的轮次（重试已抽完的旧轮次）不动大屏；滚动期间真正抽出、但第一次没来得及揭晓的轮次，
// 重试时仍能补上揭晓。
export function revealRoundIfRolling(eventId, roundId, { segment, dataVersion } = {}) {
  const id = toPositiveId(eventId);
  const rid = toPositiveId(roundId);
  if (!id || !rid) return null;

  const current = screenStates.get(id);
  if (!current || current.mode !== 'rolling') return null;
  if (rid <= (current.reveal_after_round_id || 0)) return null;
  if (current.segment && segment !== current.segment) return null;
  if (current.data_version !== dataVersion) return null;

  const next = {
    event_id: id,
    mode: 'reveal',
    segment: null,
    round_id: rid,
    version: current.version + 1,
    updated_at: Date.now(),
    data_version: current.data_version,
    reveal_after_round_id: 0,
  };
  screenStates.set(id, next);
  return toPublic(next);
}
