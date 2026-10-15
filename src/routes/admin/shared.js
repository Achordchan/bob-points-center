import { Router } from 'express';
import dns from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDingtalkOAuthAuthorizeUrl,
  buildJsapiConfig,
  getAccessToken,
  getDingtalkOrganizationProfile,
  getV1AccessToken,
  getUserIdByAuthCode,
  getUserIdByOAuthCode,
  getUserProfile,
  hasDingtalkGroupOpenConversationId,
  listSubDepartments,
  notableListRecords,
  queryDingtalkOpenGroupBaseInfo,
  queryDingtalkGroupRobot,
} from '../../services/dingtalkService.js';
export {
  firstPresent,
  isActiveFlag,
  listDingtalkDepartmentsTree,
  normalizeDingtalkDate,
  normalizeDingtalkUserProfile,
  toJsonText,
} from '../../services/dingtalkUserSyncService.js';
import {
  buildClearDingtalkOAuthStateCookie,
  buildDingtalkOAuthStateCookie,
  createDingtalkOAuthState,
  verifyDingtalkOAuthState,
} from '../../services/dingtalkOAuthState.js';
import {
  buildClearSessionCookie,
  buildClearLegacyAdminPathCookie,
  buildSessionCookie,
  createSessionToken,
  parseCookies,
  verifySessionToken,
} from '../../services/adminSession.js';
import { ensureAccount, listLedgerRecords } from '../../services/ledgerService.js';
import { deleteRedeemCdks, generateRedeemCdks, listCdkEnabledProducts, listRedeemCdks } from '../../services/cdkService.js';
import { deleteUsersCompletely, purgeUserBusinessData } from '../../services/userDataPurgeService.js';
import { adminSessionSigningSecret, cookieOptions, withSessionVersion, isSessionVersionValidLive } from '../../utils/sessionCrypto.js';
import {
  listAdminCharityContributions,
  listAdminCharityProjects,
  saveCharityProject,
} from '../../services/charityService.js';
import { normalizeMallProductInput } from '../../services/mallService.js';
import { adminDeductBatchWithNotify, grantBatchWithNotify, redeemConfirmWithNotify } from '../../services/bobOpsService.js';
import { toBool } from '../../services/notifyOpsService.js';
import { sendRobotPrivateText } from '../../services/robotNotifyService.js';
import {
  buildEffectiveGroupCardSettings,
  mergeGroupCardChannelIntoCfg,
  notifyGroupInteractiveCardBySettings,
  sendGroupInteractiveCard,
} from '../../services/groupCardNotifyService.js';
import { getClientIp, purgeExpiredAuditLogs, safeAppendAuditLog } from '../../services/auditLogService.js';
import { getAttendanceRewardDailySummary, getAttendanceRewardDayDetail, reconcileAttendanceRewards } from '../../services/attendanceRewardService.js';
import { publishMallRealtimeEvent } from '../../services/mallRealtimeService.js';
import { invalidateMallProductsCache } from '../../services/mallProductsCache.js';
import {
  applyDingtalkConnectionSettings,
  getAttendanceRewardSettings,
  getDingtalkConnectionSettings,
  getGroupCardSettings,
  getNotifySettings,
  getSiteVisibilitySettings,
  saveAttendanceRewardSettings,
  saveDingtalkConnectionSettings,
  saveSiteVisibilitySettings,
  toPublicDingtalkConnectionSettings,
  saveGroupCardSettings,
  saveNotifySettings,
} from '../../services/systemSettings.js';
import { getUserName, sendOrQueueNotify } from '../../services/notifyOpsService.js';
import { requireAdminSession } from '../../middleware/requireAdminSession.js';
import {
  ADMIN_PERMISSION_CATALOG,
  adminAccessMiddleware,
  getAdminAccess,
  hasAdminPermission,
  isSuperAdminSession,
  normalizePermissions,
  serializeRole,
} from '../../services/adminPermissionService.js';
import { verifyEncoded, QRSignError } from '../../utils/qr.js';
import { sanitizeRichHtml } from '../../utils/sanitizeHtml.js';
import {
  getImageOptimizationOverview,
  optimizeUploadedImage,
  runImageOptimizationBatch,
  saveImageOptimizationSettings,
} from '../../services/imageOptimizationService.js';
import {
  saveIgnoredResourcePaths,
  scanResources,
} from '../../services/resourceAuditService.js';

export function getPackageMeta() {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8');
    const pkg = JSON.parse(raw);
    return { name: pkg?.name || 'bob', version: pkg?.version || '0.0.0' };
  } catch {
    return { name: 'bob', version: '0.0.0' };
  }
}

export function withTimeout(promise, ms, timeoutMessage) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    }),
  ]);
}

export function hasDingtalkApiCredential(cfg) {
  return Boolean(String(cfg?.dingtalk?.appKey || '').trim() && String(cfg?.dingtalk?.appSecret || '').trim());
}

export const ADMIN_OAUTH_COOKIE = 'bob_admin_oauth_state';

export function getAdminOAuthSecret(cfg) {
  return `${adminSessionSigningSecret(cfg)}:dingtalk-oauth`;
}

export function normalizeAdminReturnTo(value) {
  const target = value ? String(value).trim() : '';
  if (!target.startsWith('/') || target.startsWith('//')) return '/admin/home';
  if (target.startsWith('/admin/') || target === '/docs' || target.startsWith('/docs/')) return target;
  return '/admin/home';
}

export function getAdminOAuthCallbackUrl(cfg) {
  const baseUrl = cfg?.serverBaseUrl ? String(cfg.serverBaseUrl).trim() : '';
  if (!baseUrl) throw new Error('SERVER_BASE_URL missing');
  return new URL('/admin/oauth/callback', baseUrl).toString();
}

export function buildAdminLoginErrorUrl(error, returnTo) {
  const params = new URLSearchParams({
    oauth_error: String(error || 'failed'),
    redirect: normalizeAdminReturnTo(returnTo),
  });
  return `/admin/login?${params.toString()}`;
}

export function isDingtalkPermissionMissing(err) {
  const text = String(err?.message || err || '');
  return text.includes('AccessTokenPermissionDenied') || text.includes('AntDing.Read.Send') || text.includes('应用尚未开通所需的权限');
}

export function buildDingtalkAdvisoryWarning(key, label, err, fallbackMessage) {
  const errorText = String(err?.message || err || '').trim();
  return {
    key,
    label,
    ok: true,
    status: 'warn',
    statusText: '未校验',
    message: isDingtalkPermissionMissing(err)
      ? fallbackMessage
      : `钉钉接口未能完成提前校验，不代表群消息不能发送；请以模板测试发送结果为准。钉钉返回：${errorText || '未知错误'}`,
  };
}

export async function resolveHostIp(host) {
  const target = host ? String(host).trim() : '';
  if (!target || target === 'localhost') return '';
  try {
    const result = await dns.lookup(target, { family: 4 });
    return result?.address || '';
  } catch {
    return '';
  }
}

export async function getServerInfo(req, cfg) {
  const packageMeta = getPackageMeta();
  const interfaces = os.networkInterfaces();
  const ips = Object.values(interfaces)
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address)
    .filter(Boolean);
  const host = req.hostname || '';
  const cpus = os.cpus() || [];
  return {
    service: 'BOB 币发行管理',
    version: packageMeta.version,
    environment: process.env.NODE_ENV || 'production',
    author: 'Achord',
    authorEmail: 'achordchan@gmail.com',
    authorPhone: '13160235855',
    authorRegion: '中国',
    host,
    hostname: os.hostname(),
    ip: process.env.SERVER_PUBLIC_IP || process.env.BAOTA_HOST || await resolveHostIp(host) || ips[0] || '',
    localIps: ips,
    node: process.version,
    runtime: `Node.js ${process.version} / Express`,
    frontend: 'React + Vite + Ant Design',
    database: cfg?.db?.kind === 'postgres' ? 'PostgreSQL' : String(cfg?.db?.kind || '-'),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpu: cpus[0]?.model || '',
    cpuCores: cpus.length,
    memoryTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    memoryFreeMb: Math.round(os.freemem() / 1024 / 1024),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

export async function resolveDingtalkOrganizationName(cfg, settings) {
  const profile = await getDingtalkOrganizationProfile(cfg);
  const organizationName = String(profile?.name || '').trim();
  if (!organizationName) return settings;
  if (organizationName === String(settings?.organizationName || '').trim()) return settings;
  return { ...settings, organizationName };
}

export async function isAdmin(db, cfg, userid) {
  const allow = cfg?.adminUserids || [];
  const uid = String(userid || '').trim();
  if (!uid) return false;
  if (allow.includes(uid)) return true;
  const row = await db.get(
    `SELECT u.is_admin, r.is_enabled
     FROM users u
     LEFT JOIN admin_user_roles ur ON ur.userid = u.userid
     LEFT JOIN admin_roles r ON r.id = ur.role_id
     WHERE u.userid = ?
     LIMIT 1`,
    [uid],
  );
  return Number(row?.is_admin) === 1 || Number(row?.is_enabled) === 1;
}

export function isFixedAdmin(cfg, userid) {
  const allow = cfg?.adminUserids || [];
  const uid = String(userid || '').trim();
  if (!uid) return false;
  return allow.includes(uid);
}

export function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

export function toOptionalInt(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return toInt(text);
}

export function parseAuditPayload(payload) {
  if (!payload) return null;
  if (typeof payload === 'object') return payload;
  try {
    return JSON.parse(String(payload));
  } catch {
    return null;
  }
}

export function classifyAdminAudit(row = {}) {
  const eventType = String(row.event_type || '');
  const path = String(row.path || '');
  const method = String(row.method || '').toUpperCase();
  if (eventType === 'attendance_reward') return { event_group: 'attendance', event_label: '打卡奖励' };
  if (eventType === 'attendance_skip') return { event_group: 'attendance', event_label: '打卡规则跳过' };
  if (eventType === 'admin_login_success') return { event_group: 'login', event_label: '后台登录' };
  if (eventType === 'admin_logout') return { event_group: 'login', event_label: '退出登录' };
  if (eventType === 'admin_login_failed') return { event_group: 'login', event_label: '登录失败' };
  if (path.includes('/ledger/grant-batch')) return { event_group: 'grant', event_label: '后台发币' };
  if (path.includes('/redeem/deduct-batch')) return { event_group: 'deduct', event_label: '后台减币' };
  if (path.includes('/redeem/confirm')) return { event_group: 'redeem', event_label: '订单核销' };
  if (path.includes('/backup/export')) return { event_group: 'backup', event_label: '导出备份' };
  if (path.includes('/backup/import')) return { event_group: 'backup', event_label: '导入备份' };
  if (path.includes('/users/assign-role') || path.includes('/roles/')) return { event_group: 'role', event_label: '角色权限变更' };
  if (path.includes('/users/delete')) return { event_group: 'danger', event_label: '删除用户' };
  if (path.includes('/external-login/purge')) return { event_group: 'danger', event_label: '清理外部账号' };
  if (path.includes('/users/external/reset-password')) return { event_group: 'write', event_label: '重置外部账号密码' };
  if (path.includes('/users/external/set-status')) return { event_group: 'write', event_label: '启停外部账号' };
  if (path.includes('/data/reset') || path.includes('/history/clear')) return { event_group: 'danger', event_label: '危险操作' };
  if (method === 'POST') return { event_group: 'write', event_label: '后台操作' };
  return { event_group: 'read', event_label: '查看' };
}

export function displayActorName(row = {}) {
  const fromUser = String(row.actor_user_name || '').trim();
  const fromAudit = String(row.actor_name || '').trim();
  const actorId = String(row.actor_id || '').trim();
  if (fromUser) return fromUser;
  if (fromAudit && fromAudit !== '管理员') return fromAudit;
  return fromAudit || actorId || '-';
}

export async function namesByUserids(db, userids = []) {
  const ids = [...new Set((Array.isArray(userids) ? userids : []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.all(`SELECT userid, COALESCE(name, '') AS name FROM users WHERE userid IN (${placeholders})`, ids);
  return new Map((rows || []).map((row) => [String(row.userid), String(row.name || '')]));
}

export function summarizeTargets(userids = [], nameMap = new Map(), max = 3) {
  const ids = [...new Set((Array.isArray(userids) ? userids : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const names = ids.slice(0, max).map((id) => {
    const name = nameMap.get(id);
    return name ? `${name}（${id}）` : id;
  });
  if (ids.length > max) names.push(`等 ${ids.length} 人`);
  return { ids, text: names.join('、') || '-' };
}

export async function inferLedgerOperation(db, row, direction) {
  const createdAt = Number(row?.created_at || 0);
  if (!createdAt) return { userids: [], amount: null, reason: '' };
  const positive = direction === 'grant';
  const rows = await db.all(
    `SELECT l.userid, l.delta, l.reason, COALESCE(u.name, '') AS name
     FROM ledger l
     LEFT JOIN users u ON u.userid = l.userid
     WHERE l.created_at BETWEEN ? AND ?
       AND ${positive ? 'l.delta > 0' : "l.delta < 0 AND l.reason = 'admin_deduct'"}
     ORDER BY l.id ASC
     LIMIT 50`,
    [createdAt - 5, createdAt + 2],
  );
  const userids = (rows || []).map((item) => String(item.userid));
  const amount = rows?.length ? Math.abs(Number(rows[0].delta || 0)) : null;
  const reason = rows?.find((item) => item.reason)?.reason || '';
  return { userids, amount, reason, inferred: rows?.length > 0 };
}

export async function buildOperationMeta(db, row = {}) {
  const payload = parseAuditPayload(row.payload) || {};
  const classified = classifyAdminAudit(row);
  let targetUserids = Array.isArray(payload.userids) ? payload.userids.map(String) : [];
  let amount = payload.amount || payload.bobAmount || payload.actualBobAmount || null;
  let reason = payload.reason || payload.product_name || payload.productName || '';
  let inferred = false;

  if ((classified.event_group === 'grant' || classified.event_group === 'deduct') && (!targetUserids.length || !amount)) {
    const inferredLedger = await inferLedgerOperation(db, row, classified.event_group);
    if (!targetUserids.length) targetUserids = inferredLedger.userids;
    if (!amount) amount = inferredLedger.amount;
    if (!reason) reason = inferredLedger.reason;
    inferred = inferredLedger.inferred === true;
  }
  if (classified.event_group === 'redeem' && payload.userid) targetUserids = [String(payload.userid)];
  if (classified.event_group === 'role' && payload.userid) targetUserids = [String(payload.userid)];

  const nameMap = await namesByUserids(db, targetUserids);
  const targets = summarizeTargets(targetUserids, nameMap);
  const amountNum = Number(amount || 0);
  const total = amountNum > 0 && targets.ids.length ? amountNum * targets.ids.length : amountNum || null;
  const summaryParts = [];
  if (targets.ids.length) summaryParts.push(`对象：${targets.text}`);
  if (amountNum > 0) summaryParts.push(`单人：${amountNum} BOB币`);
  if (total && total !== amountNum) summaryParts.push(`合计：${total} BOB币`);
  if (reason) summaryParts.push(`原因：${reason}`);

  return {
    ...classified,
    actor_display_name: displayActorName(row),
    payload,
    operation_summary: summaryParts.join('；') || row.message || '-',
    target_userids: targets.ids,
    target_text: targets.text,
    amount: amountNum || null,
    amount_total: total,
    reason: reason || '',
    inferred: inferred ? 1 : 0,
  };
}

export async function serializeOperationRows(db, rows = []) {
  const out = [];
  for (const row of rows || []) {
    // eslint-disable-next-line no-await-in-loop
    const meta = await buildOperationMeta(db, row);
    out.push({ ...row, ...meta });
  }
  return out;
}

export function serializeAuditRow(row = {}) {
  const classified = classifyAdminAudit(row);
  return { ...row, ...classified, actor_display_name: displayActorName(row), payload: parseAuditPayload(row.payload) || row.payload };
}

export async function enrichRedeemConfirmAuditRows(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const payloadByRow = new Map();
  const exchangeIds = [];
  for (const row of list) {
    const payload = parseAuditPayload(row?.payload);
    if (!payload) continue;
    payloadByRow.set(row, payload);
    const exchangeId = payload.exchangeId || payload.exchange_id;
    const cleanExchangeId = exchangeId === null || exchangeId === undefined ? '' : String(exchangeId).trim();
    if (cleanExchangeId.startsWith('CDK_')) exchangeIds.push(cleanExchangeId);
  }
  const uniqueExchangeIds = Array.from(new Set(exchangeIds));
  if (!uniqueExchangeIds.length) return list;

  const placeholders = uniqueExchangeIds.map(() => '?').join(',');
  const cdkRows = await db.all(
    `SELECT redeem_exchange_id, product_bob_amount
       FROM redeem_cdks
      WHERE redeem_exchange_id IN (${placeholders})`,
    uniqueExchangeIds,
  );
  const amountByExchangeId = new Map((cdkRows || []).map((row) => [
    String(row.redeem_exchange_id || ''),
    Number(row.product_bob_amount),
  ]));

  for (const row of list) {
    const payload = payloadByRow.get(row);
    if (!payload) continue;
    const exchangeId = payload.exchangeId || payload.exchange_id;
    const amount = amountByExchangeId.get(String(exchangeId || ''));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    row.payload = JSON.stringify({
      ...payload,
      cdkProductBobAmount: amount,
      displayBobAmount: amount,
    });
  }
  return list;
}

export async function runInTransaction(db, fn) {
  if (typeof db?.transaction === 'function') {
    return await db.transaction(fn);
  }
  await db.exec('BEGIN');
  try {
    const result = await fn(db);
    await db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

export function normalizeFeedbackStatus(value) {
  const v = value ? String(value).trim() : '';
  if (v === 'pending' || v === 'processing' || v === 'resolved' || v === 'rejected') return v;
  return 'pending';
}

export function normalizeFeedbackCategory(value) {
  const v = value ? String(value).trim() : '';
  if (v === 'bug' || v === 'question' || v === 'rule' || v === 'other') return v;
  return 'suggestion';
}

export function normalizeAnnouncementLevel(value) {
  const v = value ? String(value).trim() : '';
  if (v === 'info' || v === 'success' || v === 'warning' || v === 'danger') return v;
  return 'info';
}

export async function attachFeedbackMessages(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = list.map((row) => Number(row?.id || 0)).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return list;
  const placeholders = ids.map(() => '?').join(',');
  const messages = await db.all(
    `SELECT id, feedback_id, sender_type, sender_id, sender_name, content, created_at
     FROM user_feedback_messages
     WHERE feedback_id IN (${placeholders})
     ORDER BY feedback_id ASC, created_at ASC, id ASC`,
    ids,
  );
  const grouped = new Map();
  (messages || []).forEach((item) => {
    const key = Number(item.feedback_id || 0);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  });
  return list.map((row) => ({ ...row, messages: grouped.get(Number(row.id || 0)) || [] }));
}

export function isTruthyFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function pickInt(min, max) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function buildRedPacketAmounts(totalAmount, totalCount) {
  if (!Number.isFinite(totalAmount) || !Number.isFinite(totalCount)) {
    throw new Error('invalid amount');
  }
  if (totalAmount < totalCount) {
    throw new Error('total_amount must be >= total_count');
  }
  const avg = totalAmount / totalCount;
  const maxPer = Math.max(1, Math.floor(avg * 2));
  const amounts = [];
  let remainingAmount = totalAmount;
  let remainingCount = totalCount;
  for (let i = 0; i < totalCount; i += 1) {
    const maxAllowed = Math.min(maxPer, remainingAmount - (remainingCount - 1));
    const minAllowed = Math.max(1, remainingAmount - maxPer * (remainingCount - 1));
    if (minAllowed > maxAllowed) {
      throw new Error('amount distribution failed');
    }
    const picked = pickInt(minAllowed, maxAllowed);
    amounts.push(picked);
    remainingAmount -= picked;
    remainingCount -= 1;
  }
  return amounts;
}

export function formatTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  const d = new Date(n * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

export function normalizeGroupCardButtons(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const text = it.text === null || it.text === undefined ? '' : String(it.text).trim();
    const event = it.event && typeof it.event === 'object' ? it.event : null;
    const url = it.url === null || it.url === undefined ? '' : String(it.url).trim();
    const color = it.color === null || it.color === undefined ? '' : String(it.color).trim();
    const status = it.status === null || it.status === undefined ? '' : String(it.status).trim();

    if (!text) continue;

    if (event) {
      out.push({
        text,
        color: color || 'blue',
        status: status || 'normal',
        event,
      });
      continue;
    }

    if (url) {
      out.push({
        text,
        color: color || 'blue',
        status: status || 'normal',
        event: {
          type: 'openLink',
          params: { url },
        },
      });
    }
  }
  return out;
}

export async function ensureMallOpeningRow(db) {
  const row = await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
  if (row) return row;
  await db.run('INSERT INTO mall_opening_schedule(id, is_open, auto_enabled) VALUES(1, 1, 0)');
  return await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
}

export function buildMallOpenCard(ts, closeAt = null) {
  const openText = ts ? formatTs(ts) : '-';
  const closeText = closeAt ? formatTs(closeAt) : '';
  const closeLine = closeText ? `\n- 关闭时间：${closeText}` : '';
  return {
    title: '【BOB币中心】商城已开启',
    markdown: `## 商城已开启\n\n- 开启时间：${openText}${closeLine}\n\n现在可以下单啦！`,
    outTrackId: `mall_open_now_${ts || Date.now()}`,
  };
}

export function buildMallCloseCard(ts) {
  const closeText = ts ? formatTs(ts) : '-';
  return {
    title: '【BOB币中心】商城已关闭',
    markdown: `## 商城已关闭\n\n- 关闭时间：${closeText}\n\n本轮下单已结束。`,
    outTrackId: `mall_close_now_${ts || Date.now()}`,
  };
}

export function buildGroupCardTestVars(scheduleRow) {
  const now = Math.floor(Date.now() / 1000);
  const configuredOpenAt = toOptionalInt(scheduleRow?.next_open_at);
  const lastOpenAt = toOptionalInt(scheduleRow?.open_notify_for_open_at);
  const openDurationMinutes = toOptionalInt(scheduleRow?.open_duration_minutes);
  const openAt = configuredOpenAt || lastOpenAt || now;
  const closeAt = openDurationMinutes ? openAt + openDurationMinutes * 60 : now + 1800;
  return {
    open_time: formatTs(openAt) || '-',
    close_time: formatTs(closeAt) || '-',
    product_name: '测试商品',
    stock: '仅剩 1 件',
    amount: '10 BOB 币',
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function buildNotifyContent({ title, content }) {
  const t = title === null || title === undefined ? '' : String(title).trim();
  const c = content === null || content === undefined ? '' : String(content).trim();
  return [t, c].filter((x) => x).join('\n');
}

export function renderTemplateVars(template, vars) {
  const src = template === null || template === undefined ? '' : String(template);
  const map = vars && typeof vars === 'object' ? vars : {};
  return src.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key) => {
    const v = map[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

export async function sendRobotPrivateTextWithRetry(cfg, { userid, content }) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await sendRobotPrivateText(cfg, { userid, content });
      return { ok: true };
    } catch (err) {
      const status = Number(err?.status);
      const retryable = status === 429 || (Number.isFinite(status) && status >= 500);
      if (!retryable || attempt >= maxAttempts) {
        return { ok: false, error: String(err?.message || err) };
      }
      const backoffMs = 300 * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
  }
  return { ok: false, error: 'send failed' };
}

export function normalizeNotableProductRecordFields(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};

  const productIdRaw = f['商品id'];
  const productId = productIdRaw === null || productIdRaw === undefined ? '' : String(productIdRaw).trim();

  const productNameRaw = f['商品名称'];
  const productName = productNameRaw === null || productNameRaw === undefined ? '' : String(productNameRaw).trim();

  const amount = toOptionalInt(f['BOB币价格']);

  const statusRaw = f['是否上架'];
  const status = statusRaw && typeof statusRaw === 'object' ? String(statusRaw?.name || '').trim() : String(statusRaw || '').trim();

  const stock = toOptionalInt(f['库存']);
  const sort = toOptionalInt(f['排序']);

  const remarkRaw = f['备注'];
  const remark = remarkRaw === null || remarkRaw === undefined ? '' : String(remarkRaw).trim();

  const imgRaw = f['产品主图'];
  const imgArr = Array.isArray(imgRaw) ? imgRaw : [];
  const imageUrl = imgArr[0]?.url ? String(imgArr[0].url) : '';

  const updatedAtMs = toOptionalInt(f['时间']);

  return {
    product_id: productId,
    product_name: productName,
    bob_amount: amount,
    stock,
    status,
    sort,
    remark,
    image_url: imageUrl,
    updated_at_ms: updatedAtMs,
  };
}

export async function resolveAdminDisplayName(db, cfg, payload = {}) {
  const userid = payload?.userid ? String(payload.userid).trim() : '';
  if (db && userid) {
    const row = await db.get('SELECT name FROM users WHERE userid = ? LIMIT 1', [userid]);
    const name = row?.name ? String(row.name).trim() : '';
    if (name) return name;
  }
  const configuredName = cfg?.adminFallbackName ? String(cfg.adminFallbackName).trim() : '';
  if (configuredName) return configuredName;
  const payloadName = payload?.name ? String(payload.name).trim() : '';
  if (payloadName && payloadName !== '管理员') return payloadName;
  const username = payload?.username ? String(payload.username).trim() : '';
  return username || payloadName || '管理员';
}


export function normalizeUserSearchKeyword(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function compactUserSearchKeyword(value) {
  return normalizeUserSearchKeyword(value).toLowerCase().replace(/[\s_\-@.]+/g, '');
}

export async function getAdminSessionPayload(req) {
  const cfg = req.app?.locals?.cfg;
  const db = req.app?.locals?.db;
  const cookies = parseCookies(req.header('cookie'));
  const token = cookies.bob_admin_session;
  const secret = adminSessionSigningSecret(cfg);
  const payload = verifySessionToken(secret, token);
  if (!payload) return null;
  if (!(await isSessionVersionValidLive(payload, db, cfg))) return null;
  return payload;
}

export function publishMoreChanged(section) {
  publishMallRealtimeEvent('more_changed', { section });
}

export function publishAnnouncementAccessChanged(payload = {}) {
  publishMallRealtimeEvent('announcement_access_changed', payload);
}

export function publishMallRealtimeResetForUser(userid, reason) {
  const uid = userid ? String(userid) : '';
  if (!uid) return;
  publishMallRealtimeEvent('balance_changed', { userid: uid, reason });
  publishMallRealtimeEvent('order_updated', { userid: uid, reason });
  publishMallRealtimeEvent('charity_changed', { userid: uid, reason });
}

export function publishMallRealtimeFullRefresh(reason) {
  invalidateMallProductsCache();
  publishMallRealtimeEvent('balance_changed', { reason });
  publishMallRealtimeEvent('order_updated', { reason });
  publishMallRealtimeEvent('products_changed', { reason });
  publishMallRealtimeEvent('charity_changed', { reason });
  publishMallRealtimeEvent('opening_changed', { reason });
  publishMallRealtimeEvent('red_packet_changed', { reason });
  publishMallRealtimeEvent('more_changed', { section: 'all', reason });
  publishMallRealtimeEvent('screen_changed', { scopes: ['screen'], reason });
}

export function publishMallProductsChanged(payload = {}) {
  invalidateMallProductsCache();
  publishMallRealtimeEvent('products_changed', payload);
}

export async function collectAllDeptIds(cfg) {
  const seen = new Set();
  const queue = [1];
  const out = [];
  while (queue.length) {
    const deptId = queue.shift();
    if (seen.has(deptId)) continue;
    seen.add(deptId);
    out.push(deptId);
    const subs = await listSubDepartments(cfg, { deptId });
    for (const d of subs) {
      const subId = Number(d?.dept_id);
      if (!Number.isFinite(subId)) continue;
      if (seen.has(subId)) continue;
      queue.push(subId);
    }
  }
  return out;
}

export function expandDepartmentIdsFromTree(rows = [], departmentIds = []) {
  const selected = new Set((Array.isArray(departmentIds) ? departmentIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean));
  if (!selected.size) return [];
  const childrenByParent = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.dept_id || '').trim();
    const parentId = String(row?.parent_id || '').trim();
    if (!id || !parentId) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(id);
  }
  const out = new Set(selected);
  const queue = [...selected];
  while (queue.length) {
    const parentId = queue.shift();
    const children = childrenByParent.get(parentId) || [];
    for (const childId of children) {
      if (out.has(childId)) continue;
      out.add(childId);
      queue.push(childId);
    }
  }
  return [...out];
}
