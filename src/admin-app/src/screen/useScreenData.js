import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_SCREEN_STATE,
  createSingleFlight,
  fetchAllParticipantNames,
  fetchAllRoundsVersioned,
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
// 读取失败后的重试：指数退避（2 秒起，封顶 30 秒），一直重试到成功，不设次数上限。
// SSE 连着时没有别的机会重拉：接口临时故障恢复后，大屏要能自己补上，而不是停在空榜单或等待动画里。
const RETRY_INITIAL_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 30_000;
const EMPTY_ROUNDS = Object.freeze({ list: [], dataVersion: null });

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
  const [roundsData, setRoundsData] = useState(EMPTY_ROUNDS);
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
    // 已加载轮次的 ID 与它们所属的数据版本；最近一次读到的大屏状态里的数据版本。
    // 全量恢复可能复用轮次 ID：只有两个版本相同，ID 命中才算真正拿到了这一轮。
    const knownRoundIds = new Set();
    let roundsDataVersion = null;
    let latestDataVersion = null;
    let lastRoundsReconcileKey = null;
    let roundsSignature = null;
    let roundsSignatureVersion = null;
    let lastStateVersion = null;
    // SSE 是否连着：连着时轮次、活动靠 gala_changed 事件刷新；断开（或浏览器不支持、连接数满）时靠状态轮询带着刷新。
    let sseOpen = false;
    let backfillRoundId = null;
    let backfillTimer = null;
    let backfillToken = 0;
    const retryStops = [];

    // 包一层单飞 + 失败退避重试：load 抛错即视为失败，保留上一次成功数据，按退避再拉一次。
    const createRefresh = (load) => {
      let timer = null;
      let delay = RETRY_INITIAL_DELAY_MS;
      const run = createSingleFlight(async () => {
        if (disposed) return;
        let ok = false;
        try {
          await load();
          ok = true;
        } catch {
          // 失败时保留上一次成功数据，下面按退避重试
        }
        if (disposed) return;
        if (ok) {
          delay = RETRY_INITIAL_DELAY_MS;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          return;
        }
        if (timer !== null) return;
        const wait = delay;
        delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
        timer = setTimeout(() => {
          timer = null;
          void run();
        }, wait);
      });
      retryStops.push(() => {
        run.cancelPending();
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      });
      return run;
    };

    const isRoundLoaded = (roundId) => (
      knownRoundIds.has(roundId) && roundsDataVersion === latestDataVersion
    );

    const refreshEvent = createRefresh(async () => {
      const next = await fetchEventDetail(eventId);
      if (!disposed) setEvent(next);
    });

    const refreshParticipants = createRefresh(async () => {
      const next = await fetchAllParticipantNames(eventId);
      if (!disposed) setNames(next);
    });

    // 先声明，refreshRounds 发现版本与大屏状态不一致时要顺手刷新状态。
    let refreshState = () => Promise.resolve();

    const refreshRounds = createRefresh(async () => {
      const next = await fetchAllRoundsVersioned(eventId);
      if (disposed) return;
      knownRoundIds.clear();
      for (const item of next.rounds) {
        if (item && item.id) knownRoundIds.add(item.id);
      }
      roundsDataVersion = next.dataVersion;
      // 内容与版本都没变时保留原来的数组：定时刷新不触发视图重算，也不会打断榜单滚动等动画。
      const signature = JSON.stringify(next.rounds);
      if (signature !== roundsSignature || next.dataVersion !== roundsSignatureVersion) {
        roundsSignature = signature;
        roundsSignatureVersion = next.dataVersion;
        setRoundsData({ list: next.rounds, dataVersion: next.dataVersion });
      }
      // 轮次与状态版本不一致：再读一次状态，让两边对上；空列表没有版本，不算不一致。
      // 同一对版本只追一次：持续不一致时不会在两个请求之间来回打转，之后由状态轮询（每次都会补拉轮次）收敛。
      if (next.dataVersion !== null && next.dataVersion !== latestDataVersion) {
        const key = `${next.dataVersion}|${latestDataVersion}`;
        if (key !== lastRoundsReconcileKey) {
          lastRoundsReconcileKey = key;
          void refreshState();
        }
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

    // 读取成功但列表里仍没有揭晓的这一轮（如抽签刚提交、列表还没跟上）：按退避继续补拉，直到拿到或离开这一轮。
    const runRoundBackfill = async (token, delay) => {
      if (disposed || token !== backfillToken) return;
      await refreshRounds();
      if (disposed || token !== backfillToken) return;
      if (isRoundLoaded(backfillRoundId)) {
        stopRoundBackfill();
        return;
      }
      backfillTimer = setTimeout(() => {
        backfillTimer = null;
        void runRoundBackfill(token, Math.min(delay * 2, RETRY_MAX_DELAY_MS));
      }, delay);
    };

    // 同一轮已在补拉（请求中或等待退避）时不重复启动；换了一轮则从头开始。
    const startRoundBackfill = (roundId) => {
      if (disposed || backfillRoundId === roundId) return;
      stopRoundBackfill();
      backfillRoundId = roundId;
      void runRoundBackfill(backfillToken, RETRY_INITIAL_DELAY_MS);
    };

    refreshState = createRefresh(async () => {
      const next = await fetchScreenState(eventId);
      if (disposed) return;
      const prevVersion = latestDataVersion;
      const prevStateVersion = lastStateVersion;
      latestDataVersion = next.data_version;
      lastStateVersion = next.version;
      setState(next);
      const dataChanged = prevVersion !== null && next.data_version !== null && next.data_version !== prevVersion;
      // 已缓存的轮次与状态不是同一份数据（如首次加载时轮次读到恢复前、状态读到恢复后）。
      const roundsStale = roundsDataVersion !== null && next.data_version !== null && roundsDataVersion !== next.data_version;
      // 首次加载时 refreshAll 已在拉轮次和活动，下面两种补拉从第二次读取状态起才需要。
      const initial = prevStateVersion === null;
      // 切到中奖榜（状态有变化）时拉一次最新轮次，免得显示旧榜单。
      const enteredWinners = !initial && next.mode === 'winners' && next.version !== prevStateVersion;
      const polling = !initial && !sseOpen;
      if (dataChanged) {
        // 做过全量恢复：已缓存的活动、名单都可能属于旧数据，全部重拉；进行中的补拉作废。
        stopRoundBackfill();
        void refreshParticipants();
      }
      // 没有实时推送（SSE 断开、浏览器不支持或连接数满）时，轮次和活动只能靠这里的轮询跟上。
      if (dataChanged || roundsStale || enteredWinners || polling) void refreshRounds();
      if (dataChanged || polling) void refreshEvent();
      if (next.mode === 'reveal' && next.round_id && !isRoundLoaded(next.round_id)) {
        startRoundBackfill(next.round_id);
      } else {
        stopRoundBackfill();
      }
    });

    const refreshSegments = createRefresh(async () => {
      const next = await fetchSegmentLabels();
      if (!disposed) setSegmentLabels(next);
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
        sseOpen = true;
        retryDelay = INITIAL_RECONNECT_DELAY_MS;
        if (needsReconnectRefresh) {
          needsReconnectRefresh = false;
          void refreshAll();
        } else {
          // 首次连上也对一次账：首屏数据拉完到订阅生效之间发生的抽签、切换，事件已经错过了。
          // 名单变化不走实时事件（有自己的定时刷新），这里不重拉。
          void refreshRounds();
          void refreshEvent();
          void refreshState();
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
        sseOpen = false;
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

    // 名单增减没有实时事件：定时刷新名单时一并刷新活动详情（参与人数等），免得待机页人数一直停在旧值。
    const participantsTimer = setInterval(() => {
      if (disposed) return;
      void refreshParticipants();
      void refreshEvent();
    }, PARTICIPANTS_REFRESH_INTERVAL_MS);

    return () => {
      disposed = true;
      for (const stop of retryStops) stop();
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

  // 轮次与大屏状态属于同一份数据才交给视图：恢复后旧轮次不会冒充同 ID 的新轮次显示出来。
  const rounds = useMemo(() => {
    const stateVersion = state?.data_version ?? null;
    if (roundsData.dataVersion !== null && stateVersion !== null && roundsData.dataVersion !== stateVersion) {
      return EMPTY_ROUNDS.list;
    }
    return roundsData.list;
  }, [roundsData, state]);

  return { eventId, event, names, rounds, segmentLabels, state, ready };
}
