const HEARTBEAT_INTERVAL_MS = 25000;
let nextClientId = 1;
const realtimeClients = new Map();

function buildEventChunk(event, payload) {
  const body = JSON.stringify(payload || {});
  return `event: ${event}\ndata: ${body}\n\n`;
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

export function registerMallRealtimeClient({ req, res, scope = 'mall', userid = '' } = {}) {
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

  for (const client of realtimeClients.values()) {
    if (scopes && !scopes.has(client.scope)) continue;
    if (targetSet && client.scope === 'mall' && !targetSet.has(client.userid)) continue;
    if (targetSet && client.scope !== 'mall') continue;
    try {
      writeEvent(client, event, body);
    } catch {
      removeClient(client.id);
    }
  }
}
