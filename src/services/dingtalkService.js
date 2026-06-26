import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Util = require('@alicloud/tea-util');
const dingtalkim_1_0 = require('@alicloud/dingtalk/im_1_0');
const OpenApi = require('@alicloud/openapi-client');

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


function firstText(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function createImClient() {
  const config = new OpenApi.Config({});
  config.protocol = 'https';
  config.regionId = 'central';
  return new dingtalkim_1_0.default(config);
}

export function isStandardDingtalkGroupOpenConversationId(value) {
  return /^cid[A-Za-z0-9+/=_-]{8,}$/.test(String(value || '').trim());
}

export async function queryDingtalkOpenGroupBaseInfo(cfg, openConversationId) {
  const id = String(openConversationId || '').trim();
  if (!isStandardDingtalkGroupOpenConversationId(id)) {
    throw new Error('钉钉群会话 ID 格式不正确');
  }
  const token = await getV1AccessToken(cfg);
  const client = createImClient();
  const headers = new dingtalkim_1_0.QueryOpenGroupBaseInfoHeaders({});
  headers.xAcsDingtalkAccessToken = token;
  const req = new dingtalkim_1_0.QueryOpenGroupBaseInfoRequest({
    openConversationId: id,
  });
  const resp = await client.queryOpenGroupBaseInfoWithOptions(req, headers, new Util.RuntimeOptions({}));
  const result = resp?.body?.result && typeof resp.body.result === 'object' ? resp.body.result : null;
  if (!result?.openConversationId) {
    throw new Error('选择的不是可用钉钉群聊，请重新选择群聊');
  }
  return result;
}

export async function getRootDepartmentProfile(cfg, { language = 'zh_CN' } = {}) {
  const token = await getAccessToken(cfg);
  const url = `https://oapi.dingtalk.com/topapi/v2/department/get?access_token=${encodeURIComponent(token)}`;
  const data = await httpJson('POST', url, {
    dept_id: 1,
    language: String(language || 'zh_CN'),
  });

  assertDingtalkOk(data, 'department.get');

  return data?.result && typeof data.result === 'object' ? data.result : {};
}

async function getOrganizationAuthInfo(cfg) {
  const token = await getV1AccessToken(cfg);
  const corpId = cfg?.dingtalk?.corpId ? String(cfg.dingtalk.corpId).trim() : '';
  const suffix = corpId ? `?targetCorpId=${encodeURIComponent(corpId)}` : '';
  const data = await httpJsonWithHeaders('GET', `https://api.dingtalk.com/v1.0/contact/organizations/authInfos${suffix}`, {
    headers: { 'x-acs-dingtalk-access-token': token },
  });
  return data && typeof data === 'object' ? data : {};
}

export async function getDingtalkOrganizationProfile(cfg) {
  try {
    const rootDept = await getRootDepartmentProfile(cfg);
    const rootName = firstText(rootDept.name, rootDept.dept_name);
    if (rootName) {
      return { name: rootName, source: 'root_department' };
    }
  } catch (err) {
    // 部门权限是当前系统的基础权限；失败后再尝试新版企业信息接口。
  }

  const authInfo = await getOrganizationAuthInfo(cfg);
  const result = authInfo?.result && typeof authInfo.result === 'object' ? authInfo.result : {};
  const name = firstText(
    authInfo.organizationName,
    authInfo.corpName,
    authInfo.orgName,
    authInfo.name,
    result.organizationName,
    result.corpName,
    result.orgName,
    result.name,
  );

  if (!name) {
    throw new Error('dingtalk organization name missing');
  }

  return { name, source: 'organization_auth_info' };
}

function getDingtalkCacheKey(cfg) {
  const appKey = cfg?.dingtalk?.appKey ? String(cfg.dingtalk.appKey) : '';
  const appSecret = cfg?.dingtalk?.appSecret ? String(cfg.dingtalk.appSecret) : '';
  return `${appKey}:${appSecret}`;
}

function getCacheValue(cache, key = '') {
  if (!cache) return null;
  if (key && cache.key !== key) return null;
  if (Date.now() >= cache.expiresAt) return null;
  return cache.value;
}

function setCache(cacheType, value, expiresInSeconds, key = '') {
  const expiresAt = Date.now() + Math.max(0, Number(expiresInSeconds || 0) - 60) * 1000;
  const entry = { value, expiresAt, key };
  if (cacheType === 'access_token') {
    accessTokenCache = entry;
  } else if (cacheType === 'jsapi_ticket') {
    jsapiTicketCache = entry;
  } else if (cacheType === 'v1_access_token') {
    v1AccessTokenCache = entry;
  }
}

export async function getAccessToken(cfg) {
  const cacheKey = getDingtalkCacheKey(cfg);
  const cached = getCacheValue(accessTokenCache, cacheKey);
  if (cached) return cached;

  const appKey = cfg?.dingtalk?.appKey;
  const appSecret = cfg?.dingtalk?.appSecret;
  if (!appKey || !appSecret) {
    throw new Error('DINGTALK_APP_KEY or DINGTALK_APP_SECRET missing');
  }

  const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const data = await httpJson('GET', url);

  assertDingtalkOk(data, 'gettoken');

  setCache('access_token', data.access_token, data.expires_in, cacheKey);
  return data.access_token;
}

export async function getV1AccessToken(cfg) {
  const cacheKey = getDingtalkCacheKey(cfg);
  const cached = getCacheValue(v1AccessTokenCache, cacheKey);
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

  setCache('v1_access_token', token, expireIn, cacheKey);
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
  const cacheKey = getDingtalkCacheKey(cfg);
  const cached = getCacheValue(jsapiTicketCache, cacheKey);
  if (cached) return cached;

  const token = await getAccessToken(cfg);
  const url = `https://oapi.dingtalk.com/get_jsapi_ticket?access_token=${encodeURIComponent(token)}`;
  const data = await httpJson('GET', url);

  assertDingtalkOk(data, 'get_jsapi_ticket');

  setCache('jsapi_ticket', data.ticket, data.expires_in, cacheKey);
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

  const result = data?.result || {};
  const name = result?.name;
  const avatar = result?.avatar;
  const deptIds = Array.isArray(result?.dept_id_list)
    ? result.dept_id_list.map((id) => String(id)).filter(Boolean)
    : [];
  return {
    userid: String(userid),
    name: name ? String(name) : '',
    avatar: avatar ? String(avatar) : '',
    title: result?.title ? String(result.title) : '',
    deptIds,
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
