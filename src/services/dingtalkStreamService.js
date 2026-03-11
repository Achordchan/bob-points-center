import WebSocket from 'ws';
import { getV1AccessToken } from './dingtalkService.js';

const GATEWAY_ENDPOINT = 'https://api.dingtalk.com/v1.0/gateway/connections/open';

// 指数退避重连：初始 2s，上限 64s
const RECONNECT_INITIAL_MS = 2000;
const RECONNECT_MAX_MS = 64000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
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
  // eslint-disable-next-line no-console
  console.log('[DingtalkStream] connecting…');

  const ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    // eslint-disable-next-line no-console
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
    // 钉钉 EVENT 类消息的真实事件类型在 headers.eventType 里
    const eventType = headers?.eventType || topic;

    // 系统 PING — 回 PONG
    if (type === 'SYSTEM' && topic === 'ping') {
      ws.send(JSON.stringify({
        code: 200,
        headers: { messageId, topic: 'pong' },
        message: 'OK',
        data: msg?.data,
      }));
      return;
    }

    // 事件/回调 — 先 ACK，再异步处理
    if (type === 'EVENT' || type === 'CALLBACK') {
      ws.send(JSON.stringify({
        code: 200,
        headers: { messageId, topic },
        message: 'OK',
        data: '{}',
      }));

      // 优先按 eventType 匹配，再按 topic，最后 fallback 到通配符 '*'
      const handler = handlers?.[eventType] || handlers?.[topic] || handlers?.['*'];
      if (typeof handler === 'function') {
        Promise.resolve()
          .then(() => handler({ topic: eventType, headers, data: msg?.data, raw: msg }))
          // eslint-disable-next-line no-console
          .catch((err) => console.error('[DingtalkStream] handler error:', err));
      }
    }
  });

  ws.addEventListener('error', (ev) => {
    // eslint-disable-next-line no-console
    console.error('[DingtalkStream] websocket error:', ev?.message || ev);
  });

  ws.addEventListener('close', (ev) => {
    // eslint-disable-next-line no-console
    console.warn(`[DingtalkStream] disconnected (code=${ev.code})`);
    if (typeof onDisconnect === 'function') onDisconnect();
  });

  return ws;
}

/**
 * 启动钉钉 Stream 长连接，自动重连。
 *
 * handlers 格式：
 *   { 'attendance_checkin': async ({ topic, headers, data }) => { ... } }
 *   或 { '*': async ({ topic, headers, data }) => { ... } }
 *
 * 返回 { stop() } 可手动关闭。
 */
export function startDingtalkStream(cfg, handlers = {}) {
  let stopped = false;
  let ws = null;
  let reconnectDelay = RECONNECT_INITIAL_MS;

  async function connect() {
    while (!stopped) {
      try {
        const { endpoint, ticket } = await openConnection(cfg);
        reconnectDelay = RECONNECT_INITIAL_MS;

        await new Promise((resolve) => {
          ws = connectWebSocket({
            endpoint,
            ticket,
            handlers,
            onDisconnect: resolve,
          });
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[DingtalkStream] connection failed:', err?.message || err);
      }

      if (!stopped) {
        // eslint-disable-next-line no-console
        console.log(`[DingtalkStream] reconnecting in ${reconnectDelay / 1000}s…`);
        await sleep(reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      }
    }
  }

  connect();

  return {
    stop() {
      stopped = true;
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
