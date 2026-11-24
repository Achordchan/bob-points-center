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
const MAX_ROUND_BACKFILL_ATTEMPTS = 3;

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
    const roundBackfillAttempts = new Map();

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
              roundBackfillAttempts.delete(item.id);
            }
          }
          setRounds(next);
        }
      } catch {
        // 失败时保留上一次成功数据
      }
    });

    const refreshState = createSingleFlight(async () => {
      if (disposed) return;
      try {
        const next = await fetchScreenState(eventId);
        if (disposed) return;
        setState(next);
        if (next.mode === 'reveal' && next.round_id && !knownRoundIds.has(next.round_id)) {
          const attempts = roundBackfillAttempts.get(next.round_id) || 0;
          if (attempts < MAX_ROUND_BACKFILL_ATTEMPTS) {
            roundBackfillAttempts.set(next.round_id, attempts + 1);
            void refreshRounds();
          }
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
      clearInterval(statePollTimer);
      clearInterval(participantsTimer);
      closeSse();
    };
  }, [eventId]);

  return { eventId, event, names, rounds, segmentLabels, state, ready };
}
