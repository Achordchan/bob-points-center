const HEARTBEAT_INTERVAL_MS = 25000;
// 上限在用到时才读环境变量：本模块在 loadConfig() 调 dotenv 之前就被导入，
// 模块顶层读取会拿不到 .env 里的值。
function positiveIntEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function maxTotalClients() {
  return positiveIntEnv('SSE_MAX_TOTAL', 500);
}
function maxClientsPerIp() {
  return positiveIntEnv('SSE_MAX_PER_IP', 20);
}
let nextClientId = 1;
const realtimeClients = new Map();

function buildEventChunk(event, payload) {
  const body = JSON.stringify(payload || {});
  return `event: ${event}\ndata: ${body}\n\n`;
}

function clientIpFromReq(req) {
  // 与全局限流一致：信任代理时用 Express req.ip，不取 XFF 左侧伪造值。
  const trust = Boolean(req?.app?.locals?.cfg?.trustProxy) || Boolean(req?.app?.get?.('trust proxy'));
  if (trust && req?.ip) return String(req.ip);
  return String(req?.socket?.remoteAddress || 'unknown');
}

function countByIp(ip) {
  let n = 0;
  for (const c of realtimeClients.values()) {
    if (c.ip === ip) n += 1;
  }
  return n;
}

function removeClient(clientId) {
  const client = realtimeClients.get(clientId);
  if (!client) return;
  realtimeClients.delete(clientId);
  if (client.heartbeat) {
    clearInterval(client.heartbeat);
  }
}

function writeEvent(client, event, payload) {
  client.res.write(buildEventChunk(event, payload));
}

function writeChunk(client, chunk) {
  client.res.write(chunk);
}

export function getMallRealtimeStats() {
  return {
    total: realtimeClients.size,
    maxTotal: maxTotalClients(),
    maxPerIp: maxClientsPerIp(),
  };
}

export function registerMallRealtimeClient({ req, res, scope = 'mall', userid = '' } = {}) {
  const ip = clientIpFromReq(req);
  if (realtimeClients.size >= maxTotalClients()) {
    res.status(503).json({ error: 'sse_capacity', message: '实时连接已满，请稍后重试' });
    return false;
  }
  if (countByIp(ip) >= maxClientsPerIp()) {
    res.status(429).json({ error: 'sse_rate_limited', message: '同一 IP 实时连接过多' });
    return false;
  }

  const clientId = nextClientId += 1;
  const normalizedScope = scope === 'screen' ? 'screen' : 'mall';
  const normalizedUserid = userid ? String(userid) : '';

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  res.write('retry: 5000\n\n');

  const client = {
    id: clientId,
    req,
    res,
    ip,
    scope: normalizedScope,
    userid: normalizedUserid,
    heartbeat: null,
  };
  realtimeClients.set(clientId, client);

  writeEvent(client, 'snapshot', {
    scope: normalizedScope,
    userid: normalizedUserid || undefined,
    server_time: Math.floor(Date.now() / 1000),
  });

  client.heartbeat = setInterval(() => {
    try {
      writeEvent(client, 'ping', { server_time: Math.floor(Date.now() / 1000) });
    } catch {
      removeClient(clientId);
    }
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = () => removeClient(clientId);
  req.on('close', cleanup);
  req.on('end', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);
  return true;
}

export function publishMallRealtimeEvent(event, payload = {}) {
  if (!event) return;

  const scopes = Array.isArray(payload?.scopes) && payload.scopes.length
    ? new Set(payload.scopes.map((x) => String(x)))
    : null;
  const targetUserids = Array.isArray(payload?.userids)
    ? payload.userids.map((x) => String(x || '')).filter(Boolean)
    : (payload?.userid ? [String(payload.userid)] : []);
  const targetSet = targetUserids.length ? new Set(targetUserids) : null;
  const body = { ...payload };
  delete body.scopes;
  delete body.userids;
  // 广播时只序列化一次：竞拍快照随每次出价推给所有在线手机。
  const chunk = buildEventChunk(event, body);

  for (const client of realtimeClients.values()) {
    if (scopes && !scopes.has(client.scope)) continue;
    if (targetSet && client.scope === 'mall' && !targetSet.has(client.userid)) continue;
    if (targetSet && client.scope !== 'mall') continue;
    try {
      writeChunk(client, chunk);
    } catch {
      removeClient(client.id);
    }
  }
}
