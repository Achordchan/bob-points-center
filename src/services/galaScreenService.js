// 年会大屏展示状态（进程内 Map）。
// 注意：这是纯展示状态，不是业务数据，进程重启后回到待机（idle），按单实例部署设计。
// 每条状态记下写入时的数据版本（gala_version）：全量恢复会换版本并可能复用同一批活动/轮次 ID，
// 版本变了的旧状态不再展示，读取时回到待机。
// 滚动状态还记下开始滚动时本活动已有的最大轮次 ID：只有之后新抽出的轮次才自动揭晓，
// 重试一次早已抽完的旧轮次（抽签接口幂等重放）不会打断正在进行的滚动。
import { GalaError, GALA_DRAW_SEGMENTS, enterGalaVersionedWrite, readGalaDataVersion } from './galaService.js';

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
    data_version: typeof state.data_version === 'string' ? state.data_version : null,
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
    data_version: null,
  };
}

// 每个活动最近抽完的轮次（进程内，只留最近几条）。开始滚动与抽签完成可能交错：抽签在“读最大轮次 ID”之后、
// “写入滚动状态”之前提交并调用揭晓钩子时，钩子看到的还是旧状态，什么也不做。写入滚动状态时据此补上，
// 免得大屏一直停在滚动。
const RECENT_DRAWS_PER_EVENT = 20;
const recentDraws = new Map();

function noteDrawCompleted(eventId, roundId, segment, dataVersion) {
  const list = recentDraws.get(eventId) || [];
  if (!list.some((d) => d.round_id === roundId && d.data_version === dataVersion)) {
    list.push({ round_id: roundId, segment: typeof segment === 'string' ? segment : null, data_version: dataVersion });
    if (list.length > RECENT_DRAWS_PER_EVENT) list.splice(0, list.length - RECENT_DRAWS_PER_EVENT);
    recentDraws.set(eventId, list);
  }
}

// 滚动状态是否应揭晓这一轮：滚动开始后新抽出（ID 大于基线）、环节一致（滚动指定了环节时）、同一份数据。
function shouldRevealDraw(rolling, roundId, segment, dataVersion) {
  if (roundId <= (rolling.reveal_after_round_id || 0)) return false;
  if (rolling.segment && segment !== rolling.segment) return false;
  return typeof dataVersion === 'string' && rolling.data_version === dataVersion;
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
  if (!existing) {
    return typeof currentDataVersion === 'string'
      ? { ...idleState(id), data_version: currentDataVersion }
      : idleState(id);
  }
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

// 状态接口用：读当前数据版本，据此作废恢复前的旧状态。
// 读版本是异步的：读的同时可能有控制卡片按新版本写入了状态（或抽签揭晓）。只有读版本前后状态没被换过，
// 才拿这次读到的版本去作废；换过就直接返回新状态——它写入时已在锁内核对过版本，不能被一次可能过时的读取覆盖。
export async function readGalaScreenState(db, eventId) {
  const id = toPositiveId(eventId);
  if (!id) throw new GalaError('invalid_event_id', 400);
  const observed = screenStates.get(id);
  const currentDataVersion = await readGalaDataVersion(db);
  const latest = screenStates.get(id);
  if (latest !== observed) return toPublic(latest);
  return getGalaScreenState(id, { currentDataVersion });
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
  if (normalizedMode === 'rolling') {
    // 读基线到这里之间已完成的抽签（钩子当时看到的不是滚动状态）：直接揭晓其中最新的一轮。
    // 这段代码到写入状态之间没有 await，之后完成的抽签一定会看到滚动状态，由钩子揭晓。
    const missed = (recentDraws.get(id) || [])
      .filter((d) => shouldRevealDraw(next, d.round_id, d.segment, d.data_version))
      .reduce((best, d) => (!best || d.round_id > best.round_id ? d : best), null);
    if (missed) {
      next.mode = 'reveal';
      next.segment = null;
      next.round_id = missed.round_id;
      next.reveal_after_round_id = 0;
    }
  }
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

  if (typeof dataVersion === 'string') noteDrawCompleted(id, rid, segment, dataVersion);

  const current = screenStates.get(id);
  if (!current || current.mode !== 'rolling') return null;
  if (!shouldRevealDraw(current, rid, segment, dataVersion)) return null;

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
