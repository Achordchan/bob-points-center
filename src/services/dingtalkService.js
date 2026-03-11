import crypto from 'node:crypto';

let accessTokenCache = null;
let jsapiTicketCache = null;
let v1AccessTokenCache = null;

async function httpJson(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  if (typeof fetch !== 'function') {
    throw new Error('fetch not available, please use Node.js 18+');
  }

  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`dingtalk invalid json: ${text}`);
  }
  if (!resp.ok) {
    throw new Error(`dingtalk http ${resp.status}: ${text}`);
  }
  return data;
}

async function httpJsonWithHeaders(method, url, { headers = {}, body } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  if (typeof fetch !== 'function') {
    throw new Error('fetch not available, please use Node.js 18+');
  }

  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`dingtalk invalid json: ${text}`);
  }
  if (!resp.ok) {
    throw new Error(`dingtalk http ${resp.status}: ${text}`);
  }
  return data;
}

function assertDingtalkOk(data, context) {
  if (!data) {
    throw new Error(`dingtalk ${context} failed: empty response`);
  }
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`dingtalk ${context} failed: ${data.errmsg || data.errcode}`);
  }
}

function getCacheValue(cache) {
  if (!cache) return null;
  if (Date.now() >= cache.expiresAt) return null;
  return cache.value;
}

function setCache(cacheType, value, expiresInSeconds) {
  const expiresAt = Date.now() + Math.max(0, Number(expiresInSeconds || 0) - 60) * 1000;
  const entry = { value, expiresAt };
  if (cacheType === 'access_token') {
    accessTokenCache = entry;
  } else if (cacheType === 'jsapi_ticket') {
    jsapiTicketCache = entry;
  } else if (cacheType === 'v1_access_token') {
    v1AccessTokenCache = entry;
  }
}

export async function getAccessToken(cfg) {
  const cached = getCacheValue(accessTokenCache);
  if (cached) return cached;

  const appKey = cfg?.dingtalk?.appKey;
  const appSecret = cfg?.dingtalk?.appSecret;
  if (!appKey || !appSecret) {
    throw new Error('DINGTALK_APP_KEY or DINGTALK_APP_SECRET missing');
  }

  const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const data = await httpJson('GET', url);

  assertDingtalkOk(data, 'gettoken');

  setCache('access_token', data.access_token, data.expires_in);
  return data.access_token;
}

export async function getV1AccessToken(cfg) {
  const cached = getCacheValue(v1AccessTokenCache);
  if (cached) return cached;

  const appKey = cfg?.dingtalk?.appKey;
  const appSecret = cfg?.dingtalk?.appSecret;
  if (!appKey || !appSecret) {
    throw new Error('DINGTALK_APP_KEY or DINGTALK_APP_SECRET missing');
  }

  const url = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
  const data = await httpJson('POST', url, { appKey, appSecret });

  const token = data?.accessToken ? String(data.accessToken) : '';
  const expireIn = Number(data?.expireIn) || 0;
  if (!token) {
    throw new Error('dingtalk v1 accessToken missing');
  }

  setCache('v1_access_token', token, expireIn);
  return token;
}

export async function notableListRecords(cfg, {
  baseId,
  sheetIdOrName,
  operatorId,
  maxResults = 100,
  nextToken,
  filter,
} = {}) {
  const base = String(baseId || '').trim();
  const sheet = String(sheetIdOrName || '').trim();
  const op = String(operatorId || '').trim();
  if (!base) throw new Error('missing baseId');
  if (!sheet) throw new Error('missing sheetIdOrName');
  if (!op) throw new Error('missing operatorId');

  const token = await getV1AccessToken(cfg);
  const url =
    'https://api.dingtalk.com/v1.0/notable/bases/' +
    encodeURIComponent(base) +
    '/sheets/' +
    encodeURIComponent(sheet) +
    '/records/list?operatorId=' +
    encodeURIComponent(op);

  const body = {
    maxResults: Math.max(1, Math.min(100, Number(maxResults) || 100)),
    nextToken: nextToken ? String(nextToken) : undefined,
    filter: filter && typeof filter === 'object' ? filter : undefined,
  };

  if (body.nextToken === undefined) delete body.nextToken;
  if (body.filter === undefined) delete body.filter;

  const data = await httpJsonWithHeaders('POST', url, {
    headers: { 'x-acs-dingtalk-access-token': token },
    body,
  });

  return data;
}

export async function getJsapiTicket(cfg) {
  const cached = getCacheValue(jsapiTicketCache);
  if (cached) return cached;

  const token = await getAccessToken(cfg);
  const url = `https://oapi.dingtalk.com/get_jsapi_ticket?access_token=${encodeURIComponent(token)}`;
  const data = await httpJson('GET', url);

  assertDingtalkOk(data, 'get_jsapi_ticket');

  setCache('jsapi_ticket', data.ticket, data.expires_in);
  return data.ticket;
}

function sha1Hex(raw) {
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex');
}

function nonceStr() {
  return crypto.randomBytes(16).toString('hex');
}

export async function buildJsapiConfig(cfg, targetUrl) {
  const corpId = cfg?.dingtalk?.corpId;
  const agentId = cfg?.dingtalk?.agentId;
  if (!corpId) {
    throw new Error('DINGTALK_CORP_ID missing');
  }
  if (!agentId) {
    throw new Error('DINGTALK_AGENT_ID missing');
  }
  if (!targetUrl) {
    throw new Error('missing url');
  }

  const ticket = await getJsapiTicket(cfg);
  const timeStamp = Math.floor(Date.now() / 1000);
  const ns = nonceStr();
  const plain = `jsapi_ticket=${ticket}&noncestr=${ns}&timestamp=${timeStamp}&url=${targetUrl}`;
  const signature = sha1Hex(plain);

  return {
    corpId,
    agentId,
    timeStamp,
    nonceStr: ns,
    signature,
  };
}

export async function getUserIdByAuthCode(cfg, code) {
  if (!code) {
    throw new Error('missing code');
  }
  const token = await getAccessToken(cfg);
  const url = `https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(token)}`;
  const data = await httpJson('POST', url, { code: String(code) });

  assertDingtalkOk(data, 'user.getuserinfo');

  const userid = data?.result?.userid;
  if (!userid) {
    throw new Error('dingtalk userid missing');
  }
  return String(userid);
}

export async function getUserProfile(cfg, userid) {
  if (!userid) {
    throw new Error('missing userid');
  }

  const token = await getAccessToken(cfg);
  const url = `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(token)}`;
  const data = await httpJson('POST', url, { userid: String(userid) });

  assertDingtalkOk(data, 'user.get');

  const name = data?.result?.name;
  const avatar = data?.result?.avatar;
  return {
    userid: String(userid),
    name: name ? String(name) : '',
    avatar: avatar ? String(avatar) : '',
  };
}

export async function listSubDepartments(cfg, { deptId = 1, language = 'zh_CN' } = {}) {
  const token = await getAccessToken(cfg);
  const url = `https://oapi.dingtalk.com/topapi/v2/department/listsub?access_token=${encodeURIComponent(token)}`;
  const data = await httpJson('POST', url, {
    dept_id: Number(deptId),
    language: String(language || 'zh_CN'),
  });

  assertDingtalkOk(data, 'department.listsub');

  const result = data?.result;
  return Array.isArray(result) ? result : [];
}

export async function listUsersByDept(cfg, {
  deptId = 1,
  cursor = 0,
  size = 100,
  containAccessLimit = false,
  orderField = 'modify_desc',
  language = 'zh_CN',
} = {}) {
  const token = await getAccessToken(cfg);
  const url = `https://oapi.dingtalk.com/topapi/v2/user/list?access_token=${encodeURIComponent(token)}`;
  const data = await httpJson('POST', url, {
    dept_id: Number(deptId),
    cursor: Number(cursor) || 0,
    size: Math.max(1, Math.min(100, Number(size) || 100)),
    contain_access_limit: Boolean(containAccessLimit),
    order_field: String(orderField || 'modify_desc'),
    language: String(language || 'zh_CN'),
  });

  assertDingtalkOk(data, 'user.list');

  const hasMoreRaw = data?.result?.has_more;
  const hasMore = hasMoreRaw === true || hasMoreRaw === 1 || hasMoreRaw === 'true' || hasMoreRaw === '1';
  const nextCursor = Number(data?.result?.next_cursor) || 0;
  const listRaw = data?.result?.list;
  const list = Array.isArray(listRaw) ? listRaw : [];

  return { list, hasMore, nextCursor };
}
