import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_SCREEN_STATE,
  createSingleFlight,
  fetchAllParticipantNames,
  fetchAllRounds,
  fetchEventDetail,
  fetchScreenState,
  fetchSegmentLabels,
  parseEventId,
  shouldHandleGalaChanged,
  shouldHandleScreenEvent,
} from './data.js';

const SSE_URL = '/mall/events?scope=screen';
const STATE_POLL_INTERVAL_MS = 30_000;
const PARTICIPANTS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
// 揭晓的轮次不在已加载列表里时补拉轮次：失败后按指数退避一直重试（封顶 30 秒），直到拿到或大屏离开这一轮。
// 不设次数上限：接口临时故障恢复后，大屏要能自己补上，而不是停在等待动画里。
const ROUND_BACKFILL_INITIAL_DELAY_MS = 2_000;
const ROUND_BACKFILL_MAX_DELAY_MS = 30_000;

function parseSseJson(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function useScreenData() {
  const eventId = useMemo(
    () => parseEventId(typeof window !== 'undefined' ? window.location.search : ''),
    [],
  );

  const [event, setEvent] = useState(null);
  const [names, setNames] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [segmentLabels, setSegmentLabels] = useState({});
  const [state, setState] = useState(() => ({ ...DEFAULT_SCREEN_STATE }));
  const [ready, setReady] = useState(() => !eventId);

  useEffect(() => {
    if (!eventId) {
      setReady(true);
      return undefined;
    }

    let disposed = false;
    let currentEs = null;
    let reconnectTimer = null;
    let retryDelay = INITIAL_RECONNECT_DELAY_MS;
    let needsReconnectRefresh = false;
    const knownRoundIds = new Set();
    let backfillRoundId = null;
    let backfillTimer = null;
    let backfillToken = 0;

    const refreshEvent = createSingleFlight(async () => {
      if (disposed) return;
      try {
        const next = await fetchEventDetail(eventId);
        if (!disposed) setEvent(next);
      } catch {
        // 失败时保留上一次成功数据
      }
    });

    const refreshParticipants = createSingleFlight(async () => {
      if (disposed) return;
      try {
        const next = await fetchAllParticipantNames(eventId);
        if (!disposed) setNames(next);
      } catch {
        // 失败时保留上一次成功数据
      }
    });

    const refreshRounds = createSingleFlight(async () => {
      if (disposed) return;
      try {
        const next = await fetchAllRounds(eventId);
        if (!disposed) {
          knownRoundIds.clear();
          for (const item of next) {
            if (item && item.id) {
              knownRoundIds.add(item.id);
            }
          }
          setRounds(next);
        }
      } catch {
        // 失败时保留上一次成功数据
      }
    });

    // 每次停止或换轮都换一个令牌：旧循环醒来发现令牌不对就退出，同一时刻只有一个补拉循环。
    const stopRoundBackfill = () => {
      backfillToken += 1;
      backfillRoundId = null;
      if (backfillTimer !== null) {
        clearTimeout(backfillTimer);
        backfillTimer = null;
      }
    };

    const runRoundBackfill = async (token, delay) => {
      if (disposed || token !== backfillToken) return;
      await refreshRounds();
      if (disposed || token !== backfillToken) return;
      if (knownRoundIds.has(backfillRoundId)) {
        stopRoundBackfill();
        return;
      }
      backfillTimer = setTimeout(() => {
        backfillTimer = null;
        void runRoundBackfill(token, Math.min(delay * 2, ROUND_BACKFILL_MAX_DELAY_MS));
      }, delay);
    };

    // 同一轮已在补拉（请求中或等待退避）时不重复启动；换了一轮则从头开始。
    const startRoundBackfill = (roundId) => {
      if (disposed || backfillRoundId === roundId) return;
      stopRoundBackfill();
      backfillRoundId = roundId;
      void runRoundBackfill(backfillToken, ROUND_BACKFILL_INITIAL_DELAY_MS);
    };

    const refreshState = createSingleFlight(async () => {
      if (disposed) return;
      try {
        const next = await fetchScreenState(eventId);
        if (disposed) return;
        setState(next);
        if (next.mode === 'reveal' && next.round_id && !knownRoundIds.has(next.round_id)) {
          startRoundBackfill(next.round_id);
        } else {
          stopRoundBackfill();
        }
      } catch {
        // 失败时保留上一次成功数据
      }
    });

    const refreshSegments = createSingleFlight(async () => {
      if (disposed) return;
      try {
        const next = await fetchSegmentLabels();
        if (!disposed) setSegmentLabels(next);
      } catch {
        // 失败时保留上一次成功数据
      }
    });

    const refreshAll = () => Promise.all([
      refreshEvent(),
      refreshParticipants(),
      refreshRounds(),
      refreshState(),
      refreshSegments(),
    ]);

    const closeSse = () => {
      if (!currentEs) return;
      const es = currentEs;
      currentEs = null;
      try {
        es.close();
      } catch {
        // 忽略关闭异常
      }
    };

    const connectSse = () => {
      if (disposed || typeof EventSource !== 'function') return;
      const es = new EventSource(SSE_URL);
      currentEs = es;

      es.addEventListener('open', () => {
        if (disposed || currentEs !== es) return;
        retryDelay = INITIAL_RECONNECT_DELAY_MS;
        if (needsReconnectRefresh) {
          needsReconnectRefresh = false;
          void refreshAll();
        }
      });

      es.addEventListener('gala_screen', (evt) => {
        if (disposed || currentEs !== es) return;
        const payload = parseSseJson(evt?.data);
        if (shouldHandleScreenEvent(payload, eventId)) {
          void refreshState();
        }
      });

      es.addEventListener('gala_changed', (evt) => {
        if (disposed || currentEs !== es) return;
        const payload = parseSseJson(evt?.data);
        if (shouldHandleGalaChanged(payload, eventId)) {
          void refreshRounds();
          void refreshEvent();
        }
      });

      es.onerror = () => {
        if (disposed || currentEs !== es) return;
        closeSse();
        needsReconnectRefresh = true;
        const delay = retryDelay;
        retryDelay = Math.min(retryDelay * 2, MAX_RECONNECT_DELAY_MS);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectSse();
        }, delay);
      };
    };

    void refreshAll().finally(() => {
      if (!disposed) setReady(true);
    });

    connectSse();

    const statePollTimer = setInterval(() => {
      if (!disposed) void refreshState();
    }, STATE_POLL_INTERVAL_MS);

    const participantsTimer = setInterval(() => {
      if (!disposed) void refreshParticipants();
    }, PARTICIPANTS_REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      refreshEvent.cancelPending();
      refreshParticipants.cancelPending();
      refreshRounds.cancelPending();
      refreshState.cancelPending();
      refreshSegments.cancelPending();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopRoundBackfill();
      clearInterval(statePollTimer);
      clearInterval(participantsTimer);
      closeSse();
    };
  }, [eventId]);

  return { eventId, event, names, rounds, segmentLabels, state, ready };
}
