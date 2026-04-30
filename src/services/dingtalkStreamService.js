import WebSocket from 'ws';
import { getV1AccessToken } from './dingtalkService.js';

const GATEWAY_ENDPOINT = 'https://api.dingtalk.com/v1.0/gateway/connections/open';

const RECONNECT_INITIAL_MS = 2000;
const RECONNECT_MAX_MS = 64000;
const STABLE_CONNECTION_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function tryParseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJsonString(value, fallback = '{}') {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function normalizeReason(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  return String(value);
}

function sendProtocolMessage(ws, { messageId, data }) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(toJsonString({
    code: 200,
    headers: {
      messageId,
      contentType: 'application/json',
    },
    message: 'OK',
    data: toJsonString(data),
  }));
}

async function openConnection(cfg) {
  const appKey = cfg?.dingtalk?.appKey;
  const appSecret = cfg?.dingtalk?.appSecret;
  if (!appKey || !appSecret) {
    throw new Error('DINGTALK_APP_KEY or DINGTALK_APP_SECRET missing');
  }

  const token = await getV1AccessToken(cfg);
  const resp = await fetch(GATEWAY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify({
      clientId: appKey,
      clientSecret: appSecret,
      subscriptions: [
        { type: 'EVENT', topic: '*' },
      ],
      ua: 'bob-server/1.0',
    }),
  });

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`dingtalk stream gateway invalid json: ${text}`);
  }
  if (!resp.ok) {
    throw new Error(`dingtalk stream gateway http ${resp.status}: ${text}`);
  }

  const endpoint = data?.endpoint;
  const ticket = data?.ticket;
  if (!endpoint || !ticket) {
    throw new Error(`dingtalk stream gateway missing endpoint/ticket: ${text}`);
  }
  return { endpoint, ticket };
}

function connectWebSocket({ endpoint, ticket, handlers, onDisconnect }) {
  const url = `${endpoint}?ticket=${encodeURIComponent(ticket)}`;
  console.log('[DingtalkStream] connecting…');

  const ws = new WebSocket(url);
  let openedAt = 0;
  let lastSystemTopic = '';
  let lastDisconnectReason = '';

  ws.addEventListener('open', () => {
    openedAt = Date.now();
    console.log('[DingtalkStream] connected');
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data || ''));
    } catch {
      return;
    }

    const type = msg?.type;
    const headers = msg?.headers || {};
    const messageId = headers?.messageId || headers?.message_id || '';
    const topic = headers?.topic || '';
    const eventType = headers?.eventType || topic;

    if (type === 'SYSTEM') {
      lastSystemTopic = topic;
      const systemData = tryParseJson(msg?.data, {});

      if (topic === 'ping') {
        sendProtocolMessage(ws, {
          messageId,
          data: { opaque: systemData?.opaque || '' },
        });
        return;
      }

      if (topic === 'disconnect') {
        lastDisconnectReason = String(systemData?.reason || '');
        console.warn(`[DingtalkStream] server requested disconnect${lastDisconnectReason ? ` reason=${JSON.stringify(lastDisconnectReason)}` : ''}`);
        return;
      }
    }

    if (type === 'EVENT' || type === 'CALLBACK') {
      sendProtocolMessage(ws, {
        messageId,
        data: type === 'CALLBACK'
          ? { response: null }
          : { status: 'SUCCESS', message: 'success' },
      });

      const handler = handlers?.[eventType] || handlers?.[topic] || handlers?.['*'];
      if (typeof handler === 'function') {
        Promise.resolve()
          .then(() => handler({ topic: eventType, headers, data: msg?.data, raw: msg }))
          .catch((err) => console.error('[DingtalkStream] handler error:', err));
      }
    }
  });

  ws.addEventListener('error', (ev) => {
    console.error('[DingtalkStream] websocket error:', ev?.message || ev);
  });

  ws.addEventListener('close', (ev) => {
    const uptimeMs = openedAt > 0 ? Date.now() - openedAt : 0;
    const closeReason = normalizeReason(ev?.reason);
    const reasonParts = [];
    if (closeReason) reasonParts.push(`reason=${JSON.stringify(closeReason)}`);
    if (lastDisconnectReason) reasonParts.push(`serverReason=${JSON.stringify(lastDisconnectReason)}`);
    if (lastSystemTopic) reasonParts.push(`lastSystemTopic=${JSON.stringify(lastSystemTopic)}`);
    reasonParts.push(`uptimeMs=${uptimeMs}`);
    console.warn(`[DingtalkStream] disconnected (code=${ev.code}${reasonParts.length ? ` ${reasonParts.join(' ')}` : ''})`);
    if (typeof onDisconnect === 'function') {
      onDisconnect({ code: ev.code, reason: closeReason, serverReason: lastDisconnectReason, lastSystemTopic, uptimeMs });
    }
  });

  return ws;
}

export function startDingtalkStream(cfg, handlers = {}) {
  let stopped = false;
  let ws = null;
  let reconnectDelay = RECONNECT_INITIAL_MS;

  async function connect() {
    while (!stopped) {
      let session = { uptimeMs: 0 };
      try {
        const { endpoint, ticket } = await openConnection(cfg);

        await new Promise((resolve) => {
          ws = connectWebSocket({
            endpoint,
            ticket,
            handlers,
            onDisconnect: (meta) => {
              session = meta || { uptimeMs: 0 };
              resolve();
            },
          });
        });
      } catch (err) {
        console.error('[DingtalkStream] connection failed:', err?.message || err);
      }

      if (!stopped) {
        const stable = Number(session?.uptimeMs || 0) >= STABLE_CONNECTION_MS;
        console.log(`[DingtalkStream] reconnecting in ${reconnectDelay / 1000}s…`);
        await sleep(reconnectDelay);
        reconnectDelay = stable
          ? RECONNECT_INITIAL_MS
          : Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      }
    }
  }

  connect();

  return {
    stop() {
      stopped = true;
      try { ws?.close(); } catch {}
    },
  };
}
