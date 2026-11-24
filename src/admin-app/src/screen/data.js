// 年会大屏数据层：纯白名单字段提取、分页拉取与单飞防并发封装。
// 本模块不依赖 React 或浏览器专属全局对象，可直接被 Node 测试导入。

const SCREEN_MODES = new Set(['idle', 'rolling', 'reveal', 'winners']);
const FORBIDDEN_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// 数据版本（gala_version）：全量恢复时换新的随机 UUID。大屏用它判断缓存的轮次是否属于当前这份数据。
const DATA_VERSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function pickDataVersion(value) {
  return typeof value === 'string' && DATA_VERSION_RE.test(value) ? value : null;
}

// 分页拉取时核对每条记录的数据版本：全部一致才返回这个版本，出现不一致就抛错（翻页途中做过全量恢复）。
function createPageVersionCheck(errorCode) {
  let seen = false;
  let version = null;
  return {
    check(raw) {
      const v = pickDataVersion(raw);
      if (!seen) {
        seen = true;
        version = v;
      } else if (v !== version) {
        throw new Error(errorCode);
      }
    },
    value: () => version,
  };
}

export const PARTICIPANTS_PAGE_SIZE = 500;
export const ROUNDS_PAGE_SIZE = 200;

export const DEFAULT_SCREEN_STATE = Object.freeze({
  mode: 'idle',
  segment: null,
  round_id: null,
  version: 0,
  data_version: null,
});

function toPositiveInt(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

export function parseEventId(search) {
  if (typeof search !== 'string' || !search) return null;
  const params = new URLSearchParams(search);
  return toPositiveInt(params.get('event_id'));
}

export function pickEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = Number(raw.participant_count);
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    event_date: typeof raw.event_date === 'string' ? raw.event_date : '',
    participant_count: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
  };
}

export function pickWinnerName(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof raw.name === 'string') {
    return raw.name;
  }
  return '';
}

export function pickParticipantName(raw) {
  return pickWinnerName(raw);
}

export function pickRound(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = toPositiveInt(raw.id);
  if (!id) return null;
  const roundNo = Number(raw.round_no);
  const amountEach = Number(raw.amount_each);
  const winners = Array.isArray(raw.winners)
    ? raw.winners.map((item) => pickWinnerName(item)).filter((name) => name.length > 0)
    : [];
  return {
    id,
    segment: typeof raw.segment === 'string' ? raw.segment : '',
    segment_label: typeof raw.segment_label === 'string' ? raw.segment_label : '',
    round_no: Number.isFinite(roundNo) && roundNo >= 0 ? Math.floor(roundNo) : 0,
    title: typeof raw.title === 'string' ? raw.title : '',
    prize_type: typeof raw.prize_type === 'string' ? raw.prize_type : 'none',
    amount_each: Number.isFinite(amountEach) && amountEach >= 0 ? amountEach : 0,
    winners,
  };
}

export function pickState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = typeof raw.mode === 'string' && SCREEN_MODES.has(raw.mode) ? raw.mode : 'idle';
  const segment = typeof raw.segment === 'string' && raw.segment.trim() ? raw.segment.trim() : null;
  const roundId = toPositiveInt(raw.round_id);
  const version = Number(raw.version);
  return {
    mode,
    segment,
    round_id: roundId,
    version: Number.isSafeInteger(version) && version >= 0 ? version : 0,
    data_version: pickDataVersion(raw.data_version),
  };
}

export function pickSegmentLabels(rawList) {
  const labels = {};
  if (!Array.isArray(rawList)) return labels;
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    const label = typeof item.label === 'string' ? item.label : '';
    if (!key || !label || FORBIDDEN_MAP_KEYS.has(key)) continue;
    labels[key] = label;
  }
  return labels;
}

export function shouldHandleScreenEvent(payload, eventId) {
  const targetId = toPositiveInt(eventId);
  if (!targetId || !payload || typeof payload !== 'object') return false;
  return toPositiveInt(payload.event_id) === targetId;
}

export function shouldHandleGalaChanged(payload, eventId) {
  const targetId = toPositiveInt(eventId);
  if (!targetId || !payload || typeof payload !== 'object') return false;
  if (payload.event_id === undefined || payload.event_id === null || payload.event_id === '') {
    return true;
  }
  return toPositiveInt(payload.event_id) === targetId;
}

// 单飞控制：同一时刻仅允许一个同类请求在途；期间若再次触发，合并为一次后续补拉，避免事件风暴并发请求。
export function createSingleFlight(fn) {
  let inFlight = null;
  let pending = false;

  function run() {
    if (inFlight) {
      pending = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        return await fn();
      } finally {
        inFlight = null;
        if (pending) {
          pending = false;
          void run().catch(() => {});
        }
      }
    })();
    return inFlight;
  }

  run.cancelPending = () => {
    pending = false;
  };

  return run;
}

export async function fetchScreenJson(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable');
  }
  const res = await fetchImpl(url, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!res || !res.ok) {
    const err = new Error(`http_${res ? res.status : 0}`);
    err.status = res ? res.status : 0;
    throw err;
  }
  const body = await res.json();
  if (!body || body.ok !== true || !Object.hasOwn(body, 'data')) {
    throw new Error('invalid_payload');
  }
  return body.data;
}

export async function fetchEventDetailVersioned(eventId, fetchImpl = globalThis.fetch) {
  const id = toPositiveInt(eventId);
  if (!id) throw new Error('invalid_event_id');
  const data = await fetchScreenJson(`/admin/gala/events/detail?id=${encodeURIComponent(id)}`, fetchImpl);
  const picked = pickEvent(data);
  if (!picked) throw new Error('invalid_event_data');
  return { event: picked, dataVersion: pickDataVersion(data?.gala_version) };
}

export async function fetchEventDetail(eventId, fetchImpl = globalThis.fetch) {
  return (await fetchEventDetailVersioned(eventId, fetchImpl)).event;
}

// 拉全部参与人名字，并给出所属数据版本（每页与名单同一快照读出）。
// 各页版本不一致说明翻页途中做过全量恢复，拼出来的名单混了两份数据：整批作废，交给调用方重试。
export async function fetchAllParticipantNamesVersioned(eventId, fetchImpl = globalThis.fetch) {
  const id = toPositiveInt(eventId);
  if (!id) throw new Error('invalid_event_id');
  const names = [];
  const versions = createPageVersionCheck('participants_version_changed');
  let afterId = 0;
  while (true) {
    const qs = afterId > 0
      ? `event_id=${encodeURIComponent(id)}&limit=${PARTICIPANTS_PAGE_SIZE}&after_id=${encodeURIComponent(afterId)}`
      : `event_id=${encodeURIComponent(id)}&limit=${PARTICIPANTS_PAGE_SIZE}`;
    const page = await fetchScreenJson(`/admin/gala/participants?${qs}`, fetchImpl);
    if (!Array.isArray(page)) throw new Error('invalid_participants_data');
    if (page.length === 0) break;
    for (const item of page) {
      versions.check(item?.gala_version);
      const name = pickParticipantName(item);
      if (name) names.push(name);
    }
    if (page.length < PARTICIPANTS_PAGE_SIZE) break;
    const lastId = toPositiveInt(page[page.length - 1]?.id);
    if (!lastId || lastId <= afterId) break;
    afterId = lastId;
  }
  return { names, dataVersion: versions.value() };
}

export async function fetchAllParticipantNames(eventId, fetchImpl = globalThis.fetch) {
  return (await fetchAllParticipantNamesVersioned(eventId, fetchImpl)).names;
}

// 拉全部轮次，并给出这批轮次所属的数据版本（每页与轮次同一快照读出）。
// 各页版本不一致说明翻页途中做过全量恢复，拼出来的列表混了两份数据：整批作废，交给调用方重试。
export async function fetchAllRoundsVersioned(eventId, fetchImpl = globalThis.fetch) {
  const id = toPositiveInt(eventId);
  if (!id) throw new Error('invalid_event_id');
  const byId = new Map();
  const versions = createPageVersionCheck('rounds_version_changed');
  let beforeId = null;
  while (true) {
    const qs = beforeId !== null
      ? `event_id=${encodeURIComponent(id)}&limit=${ROUNDS_PAGE_SIZE}&before_id=${encodeURIComponent(beforeId)}`
      : `event_id=${encodeURIComponent(id)}&limit=${ROUNDS_PAGE_SIZE}`;
    const page = await fetchScreenJson(`/admin/gala/rounds?${qs}`, fetchImpl);
    if (!Array.isArray(page)) throw new Error('invalid_rounds_data');
    if (page.length === 0) break;
    for (const item of page) {
      const picked = pickRound(item);
      if (!picked) continue;
      versions.check(item?.gala_version);
      byId.set(picked.id, picked);
    }
    if (page.length < ROUNDS_PAGE_SIZE) break;
    const lastId = toPositiveInt(page[page.length - 1]?.id);
    if (!lastId || (beforeId !== null && lastId >= beforeId)) break;
    beforeId = lastId;
  }
  return { rounds: Array.from(byId.values()).sort((a, b) => a.id - b.id), dataVersion: versions.value() };
}

export async function fetchAllRounds(eventId, fetchImpl = globalThis.fetch) {
  return (await fetchAllRoundsVersioned(eventId, fetchImpl)).rounds;
}

export async function fetchScreenState(eventId, fetchImpl = globalThis.fetch) {
  const id = toPositiveInt(eventId);
  if (!id) throw new Error('invalid_event_id');
  const data = await fetchScreenJson(`/admin/gala/screen/state?event_id=${encodeURIComponent(id)}`, fetchImpl);
  const picked = pickState(data);
  if (!picked) throw new Error('invalid_state_data');
  return picked;
}

export async function fetchSegmentLabels(fetchImpl = globalThis.fetch) {
  const data = await fetchScreenJson('/admin/gala/segments', fetchImpl);
  if (!Array.isArray(data)) throw new Error('invalid_segments_data');
  return pickSegmentLabels(data);
}
