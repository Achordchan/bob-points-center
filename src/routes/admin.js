import { Router } from 'express';
import dns from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildJsapiConfig,
  getAccessToken,
  getDingtalkOrganizationProfile,
  getUserIdByAuthCode,
  getUserProfile,
  listSubDepartments,
  listUsersByDept,
  notableListRecords,
} from '../services/dingtalkService.js';
import {
  buildClearSessionCookie,
  buildClearLegacyAdminPathCookie,
  buildSessionCookie,
  createSessionToken,
  parseCookies,
  verifySessionToken,
} from '../services/adminSession.js';
import { ensureAccount } from '../services/ledgerService.js';
import { deleteRedeemCdks, generateRedeemCdks, listCdkEnabledProducts, listRedeemCdks } from '../services/cdkService.js';
import {
  listAdminCharityContributions,
  listAdminCharityProjects,
  saveCharityProject,
} from '../services/charityService.js';
import { normalizeMallProductInput } from '../services/mallService.js';
import { adminDeductBatchWithNotify, grantBatchWithNotify, redeemConfirmWithNotify } from '../services/bobOpsService.js';
import { toBool } from '../services/notifyOpsService.js';
import { sendRobotPrivateText } from '../services/robotNotifyService.js';
import {
  buildEffectiveGroupCardSettings,
  mergeGroupCardChannelIntoCfg,
  notifyGroupInteractiveCardBySettings,
  sendGroupInteractiveCard,
} from '../services/groupCardNotifyService.js';
import { getClientIp, purgeExpiredAuditLogs, safeAppendAuditLog } from '../services/auditLogService.js';
import { getAttendanceRewardDailySummary, getAttendanceRewardDayDetail, reconcileAttendanceRewards } from '../services/attendanceRewardService.js';
import { publishMallRealtimeEvent } from '../services/mallRealtimeService.js';
import { invalidateMallProductsCache } from '../services/mallProductsCache.js';
import {
  applyDingtalkConnectionSettings,
  getAttendanceRewardSettings,
  getDingtalkConnectionSettings,
  getGroupCardSettings,
  getNotifySettings,
  saveAttendanceRewardSettings,
  saveDingtalkConnectionSettings,
  toPublicDingtalkConnectionSettings,
  saveGroupCardSettings,
  saveNotifySettings,
} from '../services/systemSettings.js';
import { getUserName, sendOrQueueNotify } from '../services/notifyOpsService.js';
import { requireAdminSession } from '../middleware/requireAdminSession.js';
import {
  ADMIN_PERMISSION_CATALOG,
  adminAccessMiddleware,
  getAdminAccess,
  hasAdminPermission,
  isSuperAdminSession,
  normalizePermissions,
  serializeRole,
} from '../services/adminPermissionService.js';
import { verifyEncoded, QRSignError } from '../utils/qr.js';
import {
  getImageOptimizationOverview,
  optimizeUploadedImage,
  runImageOptimizationBatch,
  saveImageOptimizationSettings,
} from '../services/imageOptimizationService.js';

function getPackageMeta() {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8');
    const pkg = JSON.parse(raw);
    return { name: pkg?.name || 'bob', version: pkg?.version || '0.0.0' };
  } catch {
    return { name: 'bob', version: '0.0.0' };
  }
}

async function resolveHostIp(host) {
  const target = host ? String(host).trim() : '';
  if (!target || target === 'localhost') return '';
  try {
    const result = await dns.lookup(target, { family: 4 });
    return result?.address || '';
  } catch {
    return '';
  }
}

async function getServerInfo(req, cfg) {
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

async function resolveDingtalkOrganizationName(cfg, settings) {
  const profile = await getDingtalkOrganizationProfile(cfg);
  const organizationName = String(profile?.name || '').trim();
  if (!organizationName) return settings;
  if (organizationName === String(settings?.organizationName || '').trim()) return settings;
  return { ...settings, organizationName };
}

async function isAdmin(db, cfg, userid) {
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

function isFixedAdmin(cfg, userid) {
  const allow = cfg?.adminUserids || [];
  const uid = String(userid || '').trim();
  if (!uid) return false;
  return allow.includes(uid);
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function toOptionalInt(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return toInt(text);
}

function parseAuditPayload(payload) {
  if (!payload) return null;
  if (typeof payload === 'object') return payload;
  try {
    return JSON.parse(String(payload));
  } catch {
    return null;
  }
}

function classifyAdminAudit(row = {}) {
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
  if (path.includes('/data/reset') || path.includes('/history/clear')) return { event_group: 'danger', event_label: '危险操作' };
  if (method === 'POST') return { event_group: 'write', event_label: '后台操作' };
  return { event_group: 'read', event_label: '查看' };
}

function displayActorName(row = {}) {
  const fromUser = String(row.actor_user_name || '').trim();
  const fromAudit = String(row.actor_name || '').trim();
  const actorId = String(row.actor_id || '').trim();
  if (fromUser) return fromUser;
  if (fromAudit && fromAudit !== '管理员') return fromAudit;
  return fromAudit || actorId || '-';
}

async function namesByUserids(db, userids = []) {
  const ids = [...new Set((Array.isArray(userids) ? userids : []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.all(`SELECT userid, COALESCE(name, '') AS name FROM users WHERE userid IN (${placeholders})`, ids);
  return new Map((rows || []).map((row) => [String(row.userid), String(row.name || '')]));
}

function summarizeTargets(userids = [], nameMap = new Map(), max = 3) {
  const ids = [...new Set((Array.isArray(userids) ? userids : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const names = ids.slice(0, max).map((id) => {
    const name = nameMap.get(id);
    return name ? `${name}（${id}）` : id;
  });
  if (ids.length > max) names.push(`等 ${ids.length} 人`);
  return { ids, text: names.join('、') || '-' };
}

async function inferLedgerOperation(db, row, direction) {
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

async function buildOperationMeta(db, row = {}) {
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

async function serializeOperationRows(db, rows = []) {
  const out = [];
  for (const row of rows || []) {
    // eslint-disable-next-line no-await-in-loop
    const meta = await buildOperationMeta(db, row);
    out.push({ ...row, ...meta });
  }
  return out;
}

function serializeAuditRow(row = {}) {
  const classified = classifyAdminAudit(row);
  return { ...row, ...classified, actor_display_name: displayActorName(row), payload: parseAuditPayload(row.payload) || row.payload };
}

async function enrichRedeemConfirmAuditRows(db, rows) {
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

async function runInTransaction(db, fn) {
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

function normalizeFeedbackStatus(value) {
  const v = value ? String(value).trim() : '';
  if (v === 'pending' || v === 'processing' || v === 'resolved' || v === 'rejected') return v;
  return 'pending';
}

function normalizeFeedbackCategory(value) {
  const v = value ? String(value).trim() : '';
  if (v === 'bug' || v === 'question' || v === 'rule' || v === 'other') return v;
  return 'suggestion';
}

function normalizeAnnouncementLevel(value) {
  const v = value ? String(value).trim() : '';
  if (v === 'info' || v === 'success' || v === 'warning' || v === 'danger') return v;
  return 'info';
}

async function attachFeedbackMessages(db, rows) {
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

function isTruthyFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function pickInt(min, max) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildRedPacketAmounts(totalAmount, totalCount) {
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

function formatTs(ts) {
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

function normalizeGroupCardButtons(raw) {
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

async function ensureMallOpeningRow(db) {
  const row = await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
  if (row) return row;
  await db.run('INSERT INTO mall_opening_schedule(id, is_open, auto_enabled) VALUES(1, 1, 0)');
  return await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
}

function buildMallOpenCard(ts) {
  const openText = ts ? formatTs(ts) : '-';
  return {
    title: '【BOB币中心】商城已开启',
    markdown: `## 商城已开启\n\n- 开启时间：${openText}\n\n现在可以下单啦！`,
    outTrackId: `mall_open_now_${ts || Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function buildNotifyContent({ title, content }) {
  const t = title === null || title === undefined ? '' : String(title).trim();
  const c = content === null || content === undefined ? '' : String(content).trim();
  return [t, c].filter((x) => x).join('\n');
}

function renderTemplateVars(template, vars) {
  const src = template === null || template === undefined ? '' : String(template);
  const map = vars && typeof vars === 'object' ? vars : {};
  return src.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key) => {
    const v = map[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

async function sendRobotPrivateTextWithRetry(cfg, { userid, content }) {
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

function normalizeNotableProductRecordFields(fields) {
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

function isActiveFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function toJsonText(value) {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeDingtalkDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 100000000000 ? Math.floor(n / 1000) : Math.floor(n);
}

function normalizeDingtalkUserProfile(raw = {}, deptNameMap = new Map()) {
  const deptIds = Array.isArray(raw.dept_id_list) ? raw.dept_id_list.map((id) => String(id)).filter(Boolean) : [];
  const deptNames = deptIds.map((id) => deptNameMap.get(id) || '').filter(Boolean);
  return {
    userid: firstPresent(raw.userid),
    unionid: firstPresent(raw.unionid),
    name: firstPresent(raw.name),
    avatar: firstPresent(raw.avatar),
    mobile: firstPresent(raw.mobile),
    telephone: firstPresent(raw.telephone),
    email: firstPresent(raw.email),
    org_email: firstPresent(raw.org_email),
    title: firstPresent(raw.title),
    job_number: firstPresent(raw.job_number, raw.jobNumber),
    work_place: firstPresent(raw.work_place, raw.workPlace),
    remark: firstPresent(raw.remark),
    dept_ids: deptIds,
    dept_names: deptNames,
    extension: raw.extension || null,
    hired_date: normalizeDingtalkDate(raw.hired_date),
    active: isActiveFlag(raw.active) ? 1 : 0,
    is_admin: isActiveFlag(raw.admin) ? 1 : 0,
    is_boss: isActiveFlag(raw.boss) ? 1 : 0,
    leader_in_dept: raw.leader_in_dept || null,
    exclusive_account: isActiveFlag(raw.exclusive_account) ? 1 : 0,
    raw,
  };
}

async function resolveAdminDisplayName(db, cfg, payload = {}) {
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


function normalizeUserSearchKeyword(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function compactUserSearchKeyword(value) {
  return normalizeUserSearchKeyword(value).toLowerCase().replace(/[\s_\-@.]+/g, '');
}

function getAdminSessionPayload(req) {
  const cfg = req.app?.locals?.cfg;
  const cookies = parseCookies(req.header('cookie'));
  const token = cookies.bob_admin_session;
  const secret = `${cfg?.adminSessionSecret || ''}:${cfg?.sessionSalt || ''}`;
  return verifySessionToken(secret, token);
}

function publishMoreChanged(section) {
  publishMallRealtimeEvent('more_changed', { section });
}

function publishMallRealtimeResetForUser(userid, reason) {
  const uid = userid ? String(userid) : '';
  if (!uid) return;
  publishMallRealtimeEvent('balance_changed', { userid: uid, reason });
  publishMallRealtimeEvent('order_updated', { userid: uid, reason });
  publishMallRealtimeEvent('charity_changed', { userid: uid, reason });
}

function publishMallRealtimeFullRefresh(reason) {
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

function publishMallProductsChanged(payload = {}) {
  invalidateMallProductsCache();
  publishMallRealtimeEvent('products_changed', payload);
}

async function collectAllDeptIds(cfg) {
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

async function listDingtalkDepartmentsTree(cfg) {
  const seen = new Set();
  const queue = [{ deptId: 1, depth: 0 }];
  const out = [];
  while (queue.length) {
    const item = queue.shift();
    const deptId = Number(item.deptId);
    if (!Number.isFinite(deptId) || seen.has(deptId)) continue;
    seen.add(deptId);
    const subs = await listSubDepartments(cfg, { deptId });
    for (const dept of subs) {
      const id = Number(dept?.dept_id);
      if (!Number.isFinite(id)) continue;
      out.push({
        dept_id: String(id),
        name: dept?.name ? String(dept.name) : String(id),
        parent_id: String(deptId),
        depth: Number(item.depth || 0),
      });
      queue.push({ deptId: id, depth: Number(item.depth || 0) + 1 });
    }
  }
  return out;
}

function expandDepartmentIdsFromTree(rows = [], departmentIds = []) {
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

export function adminRouter() {
  const router = Router();
  const pagesRoot = fileURLToPath(new URL('../pages/', import.meta.url));
  const adminAppIndex = fileURLToPath(new URL('../pages/admin-app-dist/index.html', import.meta.url));

  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, '/admin/login');
  });

  router.use(adminAccessMiddleware());

  router.post('/notify/group-card', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const title = req.body?.title === null || req.body?.title === undefined ? '' : String(req.body.title).trim();
    const markdown = req.body?.markdown === null || req.body?.markdown === undefined ? '' : String(req.body.markdown).trim();
    const outTrackId = req.body?.outTrackId === null || req.body?.outTrackId === undefined ? '' : String(req.body.outTrackId).trim();
    const imageUrl = req.body?.imageUrl === null || req.body?.imageUrl === undefined ? '' : String(req.body.imageUrl).trim();
    const buttons = normalizeGroupCardButtons(req.body?.buttons);

    if (!title && !markdown) {
      return res.status(400).json({ error: 'missing title or content' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const groupCardSettings = await getGroupCardSettings(db);
      if (groupCardSettings?.enabled === false) {
        return res.status(400).json({ error: 'group_card_disabled' });
      }
      const tpl = groupCardSettings?.templates?.manual || { title: '{{title}}', content: '{{content}}' };
      if (tpl?.enabled === false) {
        return res.status(400).json({ error: 'group_card_manual_disabled' });
      }
      const vars = { title, content: markdown };
      const titleFinal = renderTemplateVars(tpl?.title, vars) || title || 'BOB币中心';
      const markdownFinal = renderTemplateVars(tpl?.content, vars) || markdown || title;
      // Use explicitly submitted buttons first, then template buttons, then form buttons array
      const tplButtons = Array.isArray(tpl?.buttons) ? tpl.buttons : [];
      const finalButtons = buttons.length ? buttons : tplButtons;
      const runtimeCfg = mergeGroupCardChannelIntoCfg(cfg, groupCardSettings);
      const result = await sendGroupInteractiveCard(runtimeCfg, {
        title: titleFinal,
        markdown: markdownFinal,
        outTrackId: outTrackId || undefined,
        buttons: finalButtons.length ? finalButtons : undefined,
        imageUrl: imageUrl || undefined,
      });
      return res.json({ ok: true, result });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/red-packet/status', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const now = Math.floor(Date.now() / 1000);
      const activity = await db.get('SELECT * FROM red_packet_activity ORDER BY id DESC LIMIT 1');
      if (!activity) {
        return res.json({ ok: true, data: null, server_time: now });
      }
      let nextStatus = activity.status;
      if (now >= Number(activity.end_at)) {
        nextStatus = 'ended';
      } else if (now >= Number(activity.start_at) && activity.status === 'scheduled') {
        nextStatus = 'active';
      }
      let current = activity;
      if (nextStatus !== activity.status) {
        await db.run('UPDATE red_packet_activity SET status = ? WHERE id = ?', [nextStatus, activity.id]);
        current = await db.get('SELECT * FROM red_packet_activity WHERE id = ?', [activity.id]);
      }
      const counts = await db.get(
        'SELECT COUNT(1) as total, SUM(CASE WHEN claimed_by IS NOT NULL THEN 1 ELSE 0 END) as claimed FROM red_packet_items WHERE activity_id = ?',
        [current.id],
      );
      const claimed = Number(counts?.claimed ?? 0);
      return res.json({
        ok: true,
        data: current,
        claimed_count: claimed,
        server_time: now,
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/red-packet/start', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const totalAmount = toInt(req.body?.total_amount);
    const totalCount = toInt(req.body?.total_count);
    const countdownSeconds = toInt(req.body?.countdown_seconds);
    const durationMinutes = toInt(req.body?.duration_minutes);
    const sponsorRaw = req.body?.sponsor;
    const sponsor = sponsorRaw === null || sponsorRaw === undefined ? '' : String(sponsorRaw).trim();

    if (totalAmount === null || totalAmount <= 0) {
      return res.status(400).json({ error: 'total_amount must be positive integer' });
    }
    if (totalCount === null || totalCount <= 0) {
      return res.status(400).json({ error: 'total_count must be positive integer' });
    }
    if (totalAmount < totalCount) {
      return res.status(400).json({ error: 'total_amount must be >= total_count' });
    }
    if (countdownSeconds === null || countdownSeconds < 0) {
      return res.status(400).json({ error: 'countdown_seconds must be >= 0' });
    }
    if (durationMinutes === null || durationMinutes < 1) {
      return res.status(400).json({ error: 'duration_minutes must be >= 1' });
    }

    let amounts;
    try {
      amounts = buildRedPacketAmounts(totalAmount, totalCount);
    } catch (err) {
      return res.status(400).json({ error: String(err?.message || err) });
    }

    const now = Math.floor(Date.now() / 1000);
    const startAt = now + countdownSeconds;
    const endAt = startAt + durationMinutes * 60;

    try {
      res.setHeader('Cache-Control', 'no-store');
      const activityId = await runInTransaction(db, async (tx) => {
        await tx.run("UPDATE red_packet_activity SET status = 'ended' WHERE status != 'ended'");
        const insert = await tx.run(
          'INSERT INTO red_packet_activity(total_amount, total_count, countdown_seconds, duration_minutes, start_at, end_at, status, sponsor) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
          [totalAmount, totalCount, countdownSeconds, durationMinutes, startAt, endAt, 'scheduled', sponsor || null],
        );
        const nextActivityId = insert?.lastID;
        if (!nextActivityId) {
          throw new Error('create activity failed');
        }
        for (const amount of amounts) {
          await tx.run('INSERT INTO red_packet_items(activity_id, amount) VALUES(?, ?)', [nextActivityId, amount]);
        }
        return nextActivityId;
      });

      const activity = await db.get('SELECT * FROM red_packet_activity WHERE id = ?', [activityId]);
      publishMallRealtimeEvent('red_packet_changed', { activity_id: Number(activityId) });
      publishMallRealtimeEvent('screen_changed', { scopes: ['screen'], activity_id: Number(activityId) });
      return res.json({ ok: true, data: activity, server_time: now });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/red-packet/history', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limitRaw = toOptionalInt(req.query?.limit);
    const limit = Math.min(100, Math.max(1, limitRaw || 30));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const activities = await db.all(
        'SELECT * FROM red_packet_activity ORDER BY id DESC LIMIT ?',
        [limit],
      );
      const data = [];
      for (const activity of activities || []) {
        const counts = await db.get(
          'SELECT COUNT(1) as total, SUM(CASE WHEN claimed_by IS NOT NULL THEN 1 ELSE 0 END) as claimed FROM red_packet_items WHERE activity_id = ?',
          [activity.id],
        );
        const total = Number(counts?.total ?? activity.total_count ?? 0);
        const claimed = Number(counts?.claimed ?? 0);
        const remaining = Math.max(0, total - claimed);
        const claimedItems = await db.all(
          `SELECT r.claimed_by as userid, r.amount, r.claimed_at, u.name
           FROM red_packet_items r
           LEFT JOIN users u ON u.userid = r.claimed_by
           WHERE r.activity_id = ? AND r.claimed_by IS NOT NULL
           ORDER BY r.claimed_at ASC, r.id ASC`,
          [activity.id],
        );
        data.push({
          ...activity,
          claimed_count: claimed,
          remaining_count: remaining,
          claimed_items: claimedItems || [],
        });
      }
      return res.json({ ok: true, data, server_time: Math.floor(Date.now() / 1000) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/red-packet/history/clear', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      await runInTransaction(db, async (tx) => {
        await tx.run('DELETE FROM red_packet_items');
        await tx.run('DELETE FROM red_packet_activity');
      });
      publishMallRealtimeEvent('red_packet_changed', { reason: 'clear' });
      publishMallRealtimeEvent('screen_changed', { scopes: ['screen'], reason: 'clear' });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/red-packet/history/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const activityId = toInt(req.body?.activity_id);
    if (activityId === null || activityId <= 0) {
      return res.status(400).json({ error: 'invalid activity_id' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const r = await runInTransaction(db, async (tx) => {
        const result = await tx.run('DELETE FROM red_packet_activity WHERE id = ?', [activityId]);
        if (!result?.changes) {
          throw new Error('activity not found');
        }
        return result;
      });
      publishMallRealtimeEvent('red_packet_changed', { activity_id: activityId, reason: 'delete' });
      publishMallRealtimeEvent('screen_changed', { scopes: ['screen'], activity_id: activityId, reason: 'delete' });
      return res.json({ ok: true, deleted: r?.changes ?? 0, activity_id: activityId });
    } catch (err) {
      const msg = String(err?.message || err);
      const status = msg === 'activity not found' ? 404 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  router.get('/mall/opening', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await ensureMallOpeningRow(db);
      return res.json({ ok: true, data: row || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/opening', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const autoEnabled = toBool(req.body?.auto_enabled) ? 1 : 0;
    const nextOpenAt = toOptionalInt(req.body?.next_open_at);
    const intervalMinutes = toOptionalInt(req.body?.interval_minutes);
    const openDurationMinutes = toOptionalInt(req.body?.open_duration_minutes);
    const remindSeconds = toOptionalInt(req.body?.remind_before_seconds);
    const closeRemindSeconds = toOptionalInt(req.body?.close_remind_seconds);

    if (autoEnabled && !nextOpenAt) {
      return res.status(400).json({ error: 'missing next_open_at' });
    }
    if (intervalMinutes !== null && intervalMinutes < 1) {
      return res.status(400).json({ error: 'interval_minutes must be >= 1' });
    }
    if (openDurationMinutes !== null && openDurationMinutes < 1) {
      return res.status(400).json({ error: 'open_duration_minutes must be >= 1' });
    }
    if (remindSeconds !== null && remindSeconds < 0) {
      return res.status(400).json({ error: 'remind_before_seconds must be >= 0' });
    }
    if (closeRemindSeconds !== null && closeRemindSeconds < 0) {
      return res.status(400).json({ error: 'close_remind_seconds must be >= 0' });
    }
    if (closeRemindSeconds !== null && closeRemindSeconds > 0 && openDurationMinutes === null) {
      return res.status(400).json({ error: 'close_remind_seconds requires open_duration_minutes' });
    }
    if (autoEnabled && openDurationMinutes === null) {
      return res.status(400).json({ error: 'missing open_duration_minutes' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await ensureMallOpeningRow(db);
      const updates = {
        auto_enabled: autoEnabled,
        next_open_at: nextOpenAt,
        interval_minutes: intervalMinutes,
        open_duration_minutes: openDurationMinutes,
        remind_before_seconds: remindSeconds,
        close_remind_seconds: closeRemindSeconds,
      };

      if (!autoEnabled) {
        updates.next_open_at = null;
        updates.interval_minutes = null;
        updates.remind_for_open_at = null;
        updates.open_notify_for_open_at = null;
        updates.close_remind_for_close_at = null;
      }

      if (row?.next_open_at !== nextOpenAt) {
        updates.remind_for_open_at = null;
        updates.open_notify_for_open_at = null;
      }
      if (row?.open_duration_minutes !== openDurationMinutes) {
        updates.close_remind_for_close_at = null;
      }

      if (autoEnabled && Number(row?.is_open) === 1 && !row?.open_notify_for_open_at) {
        updates.open_notify_for_open_at = Math.floor(Date.now() / 1000);
        updates.close_remind_for_close_at = null;
      }

      const fields = Object.entries(updates).filter(([, v]) => v !== undefined);
      const sets = fields.map(([k]) => `${k} = ?`).join(', ');
      const values = fields.map(([, v]) => v);
      await db.run(`UPDATE mall_opening_schedule SET ${sets}, updated_at = unixepoch() WHERE id = 1`, values);

      const next = await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
      publishMallRealtimeEvent('opening_changed', {
        reason: 'admin_update',
        is_open: Number(next?.is_open ?? 0),
        next_open_at: next?.next_open_at ?? null,
      });
      return res.json({ ok: true, data: next || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/opening/open-now', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      await ensureMallOpeningRow(db);
      const now = Math.floor(Date.now() / 1000);
      await db.run(
        'UPDATE mall_opening_schedule SET is_open = 1, open_notify_for_open_at = ?, updated_at = unixepoch() WHERE id = 1',
        [now],
      );

      const cfg = req.app?.locals?.cfg;
      await notifyGroupInteractiveCardBySettings(db, cfg, {
        ...buildMallOpenCard(now),
        event: 'mall_open',
        vars: { open_time: formatTs(now) || '-' },
      });
      const row = await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
      publishMallRealtimeEvent('opening_changed', {
        reason: 'open_now',
        is_open: Number(row?.is_open ?? 0),
        next_open_at: row?.next_open_at ?? null,
      });
      return res.json({ ok: true, data: row || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/opening/close-now', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      await ensureMallOpeningRow(db);
      await db.run('UPDATE mall_opening_schedule SET is_open = 0, updated_at = unixepoch() WHERE id = 1');
      const row = await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
      publishMallRealtimeEvent('opening_changed', {
        reason: 'close_now',
        is_open: Number(row?.is_open ?? 0),
        next_open_at: row?.next_open_at ?? null,
      });
      return res.json({ ok: true, data: row || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/users/notify', requireAdminSession(), async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const ids = Array.isArray(req.body?.userids) ? req.body.userids : [];
    const userids = ids
      .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
      .filter((x) => x);

    if (userids.length === 0) {
      return res.status(400).json({ error: 'missing userids' });
    }

    const content = buildNotifyContent({ title: req.body?.title, content: req.body?.content });
    if (!content) {
      return res.status(400).json({ error: 'missing content' });
    }

    const max = 500;
    if (userids.length > max) {
      return res.status(400).json({ error: `too many users (max ${max})` });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const results = [];
      for (let i = 0; i < userids.length; i += 1) {
        const userid = userids[i];
        const r = await sendRobotPrivateTextWithRetry(cfg, { userid, content });
        results.push(r.ok ? { ok: true, userid } : { ok: false, userid, error: r.error });
        if (userids.length > 1) {
          await sleep(120);
        }
      }
      const ok = results.every((x) => x.ok);
      return res.json({ ok, count: results.length, results });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/mall/self/products', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        "SELECT product_id, product_name, bob_amount, stock, limit_per_user, limit_round, cdk_enabled, status, sort, image_url, remark, created_at, updated_at FROM mall_products ORDER BY (sort IS NULL), sort ASC, product_id COLLATE NOCASE",
      );
      return res.json({ ok: true, count: (rows || []).length, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/self/products', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    let input;
    try {
      input = normalizeMallProductInput(req.body || {});
    } catch (err) {
      return res.status(400).json({ error: String(err?.message || err) });
    }

    const publishToGroup = toBool(req.body?.publish_to_group);

    try {
      res.setHeader('Cache-Control', 'no-store');
      const exists = await db.get('SELECT id FROM mall_products WHERE product_id = ? LIMIT 1', [input.product_id]);
      const isCreate = !exists?.id;
      if (exists?.id) {
        await db.run(
          'UPDATE mall_products SET product_name = ?, bob_amount = ?, stock = ?, limit_per_user = ?, cdk_enabled = ?, status = ?, sort = ?, image_url = ?, remark = ?, updated_at = unixepoch() WHERE product_id = ?',
          [
            input.product_name,
            input.bob_amount,
            input.stock,
            input.limit_per_user,
            input.cdk_enabled,
            input.status,
            input.sort,
            input.image_url || null,
            input.remark || null,
            input.product_id,
          ],
        );
      } else {
        await db.run(
          'INSERT INTO mall_products(product_id, product_name, bob_amount, stock, limit_per_user, cdk_enabled, status, sort, image_url, remark) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            input.product_id,
            input.product_name,
            input.bob_amount,
            input.stock,
            input.limit_per_user,
            input.cdk_enabled,
            input.status,
            input.sort,
            input.image_url || null,
            input.remark || null,
          ],
        );
      }

      const row = await db.get(
        'SELECT product_id, product_name, bob_amount, stock, limit_per_user, limit_round, cdk_enabled, status, sort, image_url, remark, created_at, updated_at FROM mall_products WHERE product_id = ? LIMIT 1',
        [input.product_id],
      );

      if (publishToGroup && row) {
        const name = row?.product_name ? String(row.product_name) : String(row?.product_id || input.product_id);
        const amount = Number(row?.bob_amount);
        const amountText = Number.isFinite(amount) ? `${amount} BOB 币` : '-';
        const stockRaw = row?.stock;
        const stockText = stockRaw === null || stockRaw === undefined ? '无限' : String(stockRaw);
        const imageUrl = row?.image_url ? String(row.image_url) : '';
        const actionText = isCreate ? '新品上架' : '商品更新';
        await notifyGroupInteractiveCardBySettings(db, req.app?.locals?.cfg, {
          event: 'new_product',
          title: `【BOB币中心】${actionText}：${name}`,
          markdown: `## ${actionText}\n\n- 商品：${name}\n- 价格：${amountText}\n- 库存：${stockText}\n\n欢迎在商城下单。`,
          outTrackId: `new_product_${String(row?.product_id || input.product_id)}_${Date.now()}`,
          imageUrl,
          vars: {
            product_name: name,
            amount: amountText,
            stock: stockText,
          },
        });
      }
      publishMallProductsChanged({
        product_id: String(input.product_id),
        reason: isCreate ? 'create' : 'update',
      });
      return res.json({ ok: true, data: row });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/self/products/limit-round', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const productId = req.body?.product_id ? String(req.body.product_id).trim() : '';
    if (!productId) {
      return res.status(400).json({ error: 'missing product_id' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await db.get(
        `UPDATE mall_products
            SET limit_round = GREATEST(COALESCE(limit_round, 1), 1) + 1,
                updated_at = unixepoch()
          WHERE product_id = ?
            AND COALESCE(limit_per_user, 0) > 0
          RETURNING product_id, product_name, bob_amount, stock, limit_per_user, limit_round,
                    cdk_enabled, status, sort, image_url, remark, created_at, updated_at`,
        [productId],
      );
      if (!row) {
        const exists = await db.get('SELECT product_id, limit_per_user FROM mall_products WHERE product_id = ? LIMIT 1', [productId]);
        if (!exists) {
          return res.status(404).json({ error: 'product not found' });
        }
        return res.status(400).json({ error: '该商品未启用限购' });
      }
      publishMallProductsChanged({ product_id: productId, reason: 'limit_round' });
      return res.json({ ok: true, data: row });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/self/products/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const productId = req.body?.product_id ? String(req.body.product_id).trim() : '';
    if (!productId) {
      return res.status(400).json({ error: 'missing product_id' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const r = await db.run('DELETE FROM mall_products WHERE product_id = ?', [productId]);
      if (!r?.changes) {
        return res.status(404).json({ error: 'product not found' });
      }
      publishMallProductsChanged({ product_id: productId, reason: 'delete' });
      return res.json({ ok: true, deleted: productId });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/charity/projects', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await listAdminCharityProjects(db);
      return res.json({ ok: true, count: rows.length, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/charity/projects/save', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await saveCharityProject(db, req.body || {});
      publishMallRealtimeEvent('charity_changed', {
        project_id: String(row?.project_id || req.body?.project_id || ''),
        reason: 'save',
      });
      return res.json({ ok: true, data: row });
    } catch (err) {
      const message = String(err?.message || err);
      const status = [
        'missing project_id',
        'missing project_name',
        'missing summary',
        'missing rules_text',
        'invalid tier_options',
        'invalid sort',
        'target_bob_amount must be positive integer',
      ].includes(message) ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.get('/charity/contributions', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const projectId = req.query?.project_id ? String(req.query.project_id).trim() : '';
    const limit = Math.min(500, Math.max(1, toPositiveInt(req.query?.limit, 200)));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await listAdminCharityContributions(db, { projectId, limit });
      return res.json({ ok: true, project_id: projectId, limit, summary: result.summary, data: result.rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/cdks/products', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await listCdkEnabledProducts(db);
      return res.json({ ok: true, count: rows.length, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/cdks', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const includeDeleted = req.query.includeDeleted === '1' || req.query.includeDeleted === 'true';
      const rows = await listRedeemCdks(db, { includeDeleted, limit: req.query.limit });
      return res.json({ ok: true, count: rows.length, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/cdks/generate', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const admin = req.adminSession || {};
    try {
      const result = await generateRedeemCdks(db, {
        productId: req.body?.product_id,
        quantity: req.body?.quantity,
        createdBy: admin?.userid ? String(admin.userid) : '',
        createdName: admin?.name ? String(admin.name) : '',
      });
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      const status = [
        'missing product_id',
        'quantity must be between 1 and 500',
        'cdk product not found',
        'failed to generate unique cdk',
      ].includes(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.post('/cdks/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      const result = await deleteRedeemCdks(db, { ids: req.body?.ids });
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      const status = ['invalid ids', 'cdk not found', 'redeemed cdk cannot be deleted'].includes(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.get('/mall/aitable/products', requireAdminSession(), async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const baseId = cfg?.mallAiTable?.baseId ? String(cfg.mallAiTable.baseId).trim() : '';
    const sheetIdOrName = cfg?.mallAiTable?.sheetIdOrName ? String(cfg.mallAiTable.sheetIdOrName).trim() : '';
    const operatorId = cfg?.mallAiTable?.operatorId ? String(cfg.mallAiTable.operatorId).trim() : '';

    if (!baseId || !sheetIdOrName || !operatorId) {
      return res.status(400).json({ error: 'missing mall ai table config' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');

      const rawRecords = [];
      let nextToken;
      let guard = 0;
      while (true) {
        guard += 1;
        if (guard > 50) {
          throw new Error('too many pages');
        }

        const page = await notableListRecords(cfg, {
          baseId,
          sheetIdOrName,
          operatorId,
          maxResults: 100,
          nextToken,
        });

        const rows = Array.isArray(page?.records) ? page.records : [];
        for (const r of rows) {
          rawRecords.push(r);
        }

        const hasMore = page?.hasMore === true;
        const nt = page?.nextToken ? String(page.nextToken) : '';
        if (!hasMore || !nt) {
          break;
        }
        nextToken = nt;
      }

      const data = rawRecords
        .map((r) => {
          const recordId = r?.id ? String(r.id) : '';
          const fields = normalizeNotableProductRecordFields(r?.fields);
          return { record_id: recordId, ...fields };
        })
        .sort((a, b) => {
          const sa = Number.isFinite(a?.sort) ? Number(a.sort) : Number.POSITIVE_INFINITY;
          const sb = Number.isFinite(b?.sort) ? Number(b.sort) : Number.POSITIVE_INFINITY;
          if (sa !== sb) return sa - sb;
          const pa = a?.product_id ? String(a.product_id) : '';
          const pb = b?.product_id ? String(b.product_id) : '';
          return pa.localeCompare(pb, 'zh');
        });

      return res.json({ ok: true, count: data.length, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/login', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').sendFile('admin_login.html', { root: pagesRoot });
  });

  router.get('/home', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', buildClearLegacyAdminPathCookie());
    let payload;
    try {
      payload = getAdminSessionPayload(req);
    } catch (err) {
      return res.status(500).type('text').send(String(err?.message || err));
    }
    if (!payload) {
      return res.redirect(302, '/admin/login');
    }
    if (existsSync(adminAppIndex)) {
      return res.type('html').sendFile(adminAppIndex);
    }
    return res.type('html').sendFile('admin.html', { root: pagesRoot });
  });

  router.get('/legacy', requireAdminSession(), (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').sendFile('admin.html', { root: pagesRoot });
  });

  router.get('/me', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const cookies = parseCookies(req.header('cookie'));
    const token = cookies.bob_admin_session;
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Set-Cookie', buildClearLegacyAdminPathCookie());
      const secret = `${cfg?.adminSessionSecret || ''}:${cfg?.sessionSalt || ''}`;
      const payload = verifySessionToken(secret, token);
      if (!payload) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      const db = req.app?.locals?.db;
      const name = await resolveAdminDisplayName(db, cfg, payload);
      const access = await getAdminAccess(db, cfg, { ...payload, name });
      return res.json({
        ok: true,
        name,
        userid: payload.userid || '',
        mode: payload.mode || '',
        isSuperAdmin: access.isSuperAdmin === true,
        role: access.role,
        permissions: access.permissions || [],
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/system/info', requireAdminSession(), async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, data: await getServerInfo(req, cfg) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/dashboard/summary', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const [usersRow, balanceRow, pendingRow, fulfilledRow, productRow, cdkRow, charityRow] = await Promise.all([
        db.get('SELECT COUNT(1) AS c FROM users'),
        db.get('SELECT COALESCE(SUM(balance), 0) AS c FROM accounts'),
        db.get("SELECT COUNT(1) AS c FROM redeems WHERE fulfilled_at IS NULL AND COALESCE(product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')"),
        db.get("SELECT COUNT(1) AS c FROM redeems WHERE fulfilled_at IS NOT NULL AND COALESCE(hidden, 0) = 0 AND COALESCE(product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')"),
        db.get("SELECT COUNT(1) AS c FROM mall_products WHERE status = 'on'"),
        db.get("SELECT COUNT(1) AS c FROM redeem_cdks WHERE status = 'unused'"),
        db.get('SELECT COALESCE(SUM(bob_amount), 0) AS c FROM charity_contributions'),
      ]);
      const settings = await getDingtalkConnectionSettings(db, cfg);
      return res.json({
        ok: true,
        data: {
          users: Number(usersRow?.c || 0),
          balanceTotal: Number(balanceRow?.c || 0),
          pendingOrders: Number(pendingRow?.c || 0),
          fulfilledOrders: Number(fulfilledRow?.c || 0),
          activeProducts: Number(productRow?.c || 0),
          unusedCdks: Number(cdkRow?.c || 0),
          charityTotal: Number(charityRow?.c || 0),
          dingtalk: toPublicDingtalkConnectionSettings(settings),
        },
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/users/:userid', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const userid = req.params?.userid ? String(req.params.userid).trim() : '';
    if (!userid) return res.status(400).json({ error: 'missing userid' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const user = await db.get(
        `SELECT u.userid, u.name, u.is_admin, u.created_at, COALESCE(a.balance, 0) AS balance, a.updated_at,
                r.id AS role_id, r.name AS role_name, r.permissions AS role_permissions, r.is_enabled AS role_enabled
         FROM users u
         LEFT JOIN accounts a ON a.userid = u.userid
         LEFT JOIN admin_user_roles ur ON ur.userid = u.userid
         LEFT JOIN admin_roles r ON r.id = ur.role_id
         WHERE u.userid = ?
         LIMIT 1`,
        [userid],
      );
      if (!user) return res.status(404).json({ error: 'user not found' });
      const ledger = await db.all(
        'SELECT id, userid, delta, reason, ref_id, created_at FROM ledger WHERE userid = ? ORDER BY created_at DESC, id DESC LIMIT 120',
        [userid],
      );
      const redeems = await db.all(
        `SELECT r.exchange_id, r.userid, r.product_id, r.product_name, r.bob_amount, r.fulfilled_at, r.created_at,
                CASE WHEN c.id IS NULL THEN 'purchase' ELSE 'cdk' END AS redeem_source,
                c.product_bob_amount AS cdk_product_bob_amount
         FROM redeems r
         LEFT JOIN redeem_cdks c ON c.redeem_exchange_id = r.exchange_id
         WHERE r.userid = ?
           AND COALESCE(r.product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')
         ORDER BY r.created_at DESC
         LIMIT 80`,
        [userid],
      );
      const contributions = await db.all(
        `SELECT c.id, c.project_id, p.project_name, c.user_name_snapshot, c.bob_amount, c.created_at
         FROM charity_contributions c
         LEFT JOIN charity_projects p ON p.project_id = c.project_id
         WHERE c.userid = ?
         ORDER BY c.created_at DESC
         LIMIT 80`,
        [userid],
      );
      const dingtalkProfile = await db.get(
        `SELECT userid, unionid, name, avatar, mobile, telephone, email, org_email, title, job_number, work_place, remark,
                dept_ids, dept_names, extension, hired_date, active, is_admin, is_boss, leader_in_dept, exclusive_account, raw, updated_at
         FROM user_dingtalk_profiles
         WHERE userid = ?
         LIMIT 1`,
        [userid],
      );
      const operations = await db.all(
        `SELECT id, event_type, actor_type, actor_id, actor_name, ip, method, path, status_code, message, payload, created_at
         FROM audit_logs
         WHERE actor_id = ?
           AND actor_type = 'admin'
           AND event_type NOT IN ('attendance_reward', 'attendance_skip')
           AND (
             COALESCE(method, '') <> 'GET'
             OR event_type IN ('admin_login_success', 'admin_logout', 'admin_login_failed')
           )
         ORDER BY id DESC
         LIMIT 20`,
        [userid],
      );
      const fixedAdmin = isFixedAdmin(cfg, userid);
      const role = fixedAdmin
        ? { id: null, code: 'super_admin', name: '超级管理员', permissions: [] }
        : (user.role_id ? { id: user.role_id, name: user.role_name, permissions: normalizePermissions(parseAuditPayload(user.role_permissions) || []) } : null);
      return res.json({
        ok: true,
        data: {
          user: { ...user, is_admin: fixedAdmin || Number(user.is_admin) === 1 || role ? 1 : 0, is_fixed_admin: fixedAdmin ? 1 : 0, role },
          account: { balance: Number(user.balance || 0), updated_at: user.updated_at },
          ledger,
          redeems,
          contributions,
          dingtalk: dingtalkProfile ? {
            ...dingtalkProfile,
            dept_ids: parseAuditPayload(dingtalkProfile.dept_ids) || [],
            dept_names: parseAuditPayload(dingtalkProfile.dept_names) || [],
            extension: parseAuditPayload(dingtalkProfile.extension) || null,
            leader_in_dept: parseAuditPayload(dingtalkProfile.leader_in_dept) || null,
            raw: parseAuditPayload(dingtalkProfile.raw) || null,
          } : null,
          operations: (operations || []).map(serializeAuditRow),
        },
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/orders/:exchangeId', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const exchangeId = req.params?.exchangeId ? String(req.params.exchangeId).trim() : '';
    if (!exchangeId) return res.status(400).json({ error: 'missing exchange_id' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const order = await db.get(
        `SELECT r.exchange_id, r.userid, COALESCE(u.name, '') AS name, r.product_id, r.product_name,
                r.bob_amount, r.fulfilled_at, r.created_at,
                COALESCE(r.fulfilled_by, audit.actor_id, '') AS fulfilled_by,
                COALESCE(r.fulfilled_name, audit.actor_name, '') AS fulfilled_name,
                CASE WHEN c.id IS NULL THEN 'purchase' ELSE 'cdk' END AS redeem_source,
                c.product_bob_amount AS cdk_product_bob_amount,
                c.cdk_code, c.batch_id
         FROM redeems r
         LEFT JOIN users u ON u.userid = r.userid
         LEFT JOIN redeem_cdks c ON c.redeem_exchange_id = r.exchange_id
         LEFT JOIN LATERAL (
           SELECT a.actor_id, a.actor_name
             FROM audit_logs a
            WHERE r.fulfilled_at IS NOT NULL
              AND a.path LIKE '/admin/redeem/confirm%'
              AND COALESCE(a.status_code, 0) BETWEEN 200 AND 299
              AND a.payload LIKE '%' || r.exchange_id || '%'
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT 1
         ) audit ON TRUE
         WHERE r.exchange_id = ?
           AND COALESCE(r.product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')
         LIMIT 1`,
        [exchangeId],
      );
      if (!order) return res.status(404).json({ error: 'order not found' });
      const ledger = await db.all(
        'SELECT id, userid, delta, reason, ref_id, created_at FROM ledger WHERE ref_id = ? ORDER BY created_at DESC, id DESC LIMIT 20',
        [exchangeId],
      );
      return res.json({ ok: true, data: { order, ledger } });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/redeem/deduct-batch', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const ids = Array.isArray(req.body?.userids) ? req.body.userids : [];
    const userids = ids
      .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
      .filter((x) => x);

    const amount = toInt(req.body?.amount);
    const productName = req.body?.product_name ? String(req.body.product_name).trim() : '';

    if (userids.length === 0) {
      return res.status(400).json({ error: 'missing userids' });
    }
    if (amount === null || amount <= 0) {
      return res.status(400).json({ error: 'bob_amount must be positive integer' });
    }
    if (!productName) {
      return res.status(400).json({ error: 'missing product_name' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      req.auditLogPayload = { userids, amount, product_name: productName };

      const baseExchangeId = `ADMIN_DEDUCT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await adminDeductBatchWithNotify(db, cfg, {
        userids,
        baseExchangeId,
        productName,
        bobAmount: amount,
        reason: 'admin_deduct',
        awaitNotify: false,
      });
      for (const row of (result?.results || [])) {
        if (row?.ok && row?.userid) {
          publishMallRealtimeEvent('balance_changed', {
            userid: String(row.userid),
            reason: 'admin_deduct_batch',
          });
        }
      }
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/redeem/history', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limitRaw = req.query.limit;
    const limit = Math.min(200, Math.max(1, toPositiveInt(limitRaw, 80)));
    const cursorRaw = req.query.cursor ? String(req.query.cursor) : '';
    try {
      res.setHeader('Cache-Control', 'no-store');

      let whereCursorSql = '';
      const params = [];
      if (cursorRaw) {
        const idx = cursorRaw.indexOf('|');
        if (idx > 0) {
          const at = toInt(cursorRaw.slice(0, idx));
          const ex = cursorRaw.slice(idx + 1);
          if (at !== null && at > 0 && ex) {
            whereCursorSql = ' AND (r.fulfilled_at < ? OR (r.fulfilled_at = ? AND r.exchange_id < ?))';
            params.push(at, at, String(ex));
          }
        }
      }

      const rows = await db.all(
        `SELECT r.exchange_id, r.userid, COALESCE(u.name, '') AS name, r.product_id, r.product_name,
                r.bob_amount, r.fulfilled_at, r.created_at,
                COALESCE(r.fulfilled_by, audit.actor_id, '') AS fulfilled_by,
                COALESCE(r.fulfilled_name, audit.actor_name, '') AS fulfilled_name,
                CASE WHEN c.id IS NULL THEN 'purchase' ELSE 'cdk' END AS redeem_source,
                c.product_bob_amount AS cdk_product_bob_amount
         FROM redeems r
         LEFT JOIN users u ON u.userid = r.userid
         LEFT JOIN redeem_cdks c ON c.redeem_exchange_id = r.exchange_id
         LEFT JOIN LATERAL (
           SELECT a.actor_id, a.actor_name
             FROM audit_logs a
            WHERE a.path LIKE '/admin/redeem/confirm%'
              AND COALESCE(a.status_code, 0) BETWEEN 200 AND 299
              AND a.payload LIKE '%' || r.exchange_id || '%'
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT 1
         ) audit ON TRUE
         WHERE r.fulfilled_at IS NOT NULL
           AND COALESCE(r.hidden, 0) = 0
           AND COALESCE(r.product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')${whereCursorSql}
         ORDER BY r.fulfilled_at DESC, r.exchange_id DESC
         LIMIT ?`,
        [...params, limit],
      );

      const data = rows || [];
      const last = data.length ? data[data.length - 1] : null;
      const nextCursor = last && last.fulfilled_at ? `${Number(last.fulfilled_at)}|${String(last.exchange_id || '')}` : '';
      const hasMore = data.length >= limit && Boolean(nextCursor);

      return res.json({ ok: true, limit, cursor: cursorRaw, nextCursor, hasMore, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/redeem/pending', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limitRaw = req.query.limit;
    const limit = Math.min(200, Math.max(1, toPositiveInt(limitRaw, 80)));
    const cursorRaw = req.query.cursor ? String(req.query.cursor) : '';

    try {
      res.setHeader('Cache-Control', 'no-store');

      let whereCursorSql = '';
      const params = [];
      if (cursorRaw) {
        const idx = cursorRaw.indexOf('|');
        if (idx > 0) {
          const at = toInt(cursorRaw.slice(0, idx));
          const ex = cursorRaw.slice(idx + 1);
          if (at !== null && at > 0 && ex) {
            whereCursorSql = ' AND (r.created_at < ? OR (r.created_at = ? AND r.exchange_id < ?))';
            params.push(at, at, String(ex));
          }
        }
      }

      const rows = await db.all(
        `SELECT r.exchange_id, r.userid, COALESCE(u.name, '') AS name, r.product_id, r.product_name,
                r.bob_amount, r.fulfilled_at, r.created_at,
                CASE WHEN c.id IS NULL THEN 'purchase' ELSE 'cdk' END AS redeem_source,
                c.product_bob_amount AS cdk_product_bob_amount
         FROM redeems r
         LEFT JOIN users u ON u.userid = r.userid
         LEFT JOIN redeem_cdks c ON c.redeem_exchange_id = r.exchange_id
         WHERE r.fulfilled_at IS NULL
           AND COALESCE(r.product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')${whereCursorSql}
         ORDER BY r.created_at DESC, r.exchange_id DESC
         LIMIT ?`,
        [...params, limit],
      );

      const data = rows || [];
      const last = data.length ? data[data.length - 1] : null;
      const nextCursor = last && last.created_at ? `${Number(last.created_at)}|${String(last.exchange_id || '')}` : '';
      const hasMore = data.length >= limit && Boolean(nextCursor);

      return res.json({ ok: true, limit, cursor: cursorRaw, nextCursor, hasMore, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/redeem/history/clear', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const confirm = req.body?.confirm ? String(req.body.confirm).trim() : '';
    if (confirm !== 'CLEAR_REDEEM_HISTORY') {
      return res.status(400).json({ error: '确认口令不正确，已取消' });
    }

    try {
      const r = await runInTransaction(db, async (tx) => (
        await tx.run("UPDATE redeems SET hidden = 1 WHERE fulfilled_at IS NOT NULL AND COALESCE(hidden, 0) = 0 AND COALESCE(product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')")
      ));
      return res.json({ ok: true, cleared: r?.changes ?? 0 });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/users/set-admin', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const userid = req.body?.userid ? String(req.body.userid).trim() : '';
    const flag = req.body?.isAdmin;
    const isAdminFlag = flag === true || flag === 1 || flag === '1' || flag === 'true';

    if (!userid) {
      return res.status(400).json({ error: 'missing userid' });
    }

    if (isFixedAdmin(cfg, userid)) {
      return res.status(400).json({ error: 'cannot modify fixed admin' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const r = await db.run('UPDATE users SET is_admin = ? WHERE userid = ?', [isAdminFlag ? 1 : 0, userid]);
      if (!r?.changes) {
        return res.status(400).json({ error: 'user not found' });
      }
      if (isAdminFlag) {
        const role = await db.get("SELECT id FROM admin_roles WHERE code = 'admin' LIMIT 1");
        if (role?.id) {
          await db.exec(
            `INSERT INTO admin_user_roles(userid, role_id, assigned_by, assigned_name, assigned_at)
             VALUES(?, ?, ?, ?, unixepoch())
             ON CONFLICT(userid) DO UPDATE SET role_id = EXCLUDED.role_id, assigned_by = EXCLUDED.assigned_by, assigned_name = EXCLUDED.assigned_name, assigned_at = EXCLUDED.assigned_at`,
            [userid, role.id, req.adminSession?.userid || '', req.adminSession?.name || ''],
          );
        }
      } else {
        await db.run('DELETE FROM admin_user_roles WHERE userid = ?', [userid]);
      }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/permissions/catalog', requireAdminSession(), async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, data: ADMIN_PERMISSION_CATALOG });
  });

  router.get('/roles', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT r.*, COUNT(ur.userid) AS user_count
         FROM admin_roles r
         LEFT JOIN admin_user_roles ur ON ur.role_id = r.id
         GROUP BY r.id
         ORDER BY r.is_builtin DESC, r.id ASC`,
      );
      return res.json({ ok: true, data: (rows || []).map(serializeRole) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/roles/save', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    const name = req.body?.name ? String(req.body.name).trim() : '';
    const permissions = normalizePermissions(req.body?.permissions || []);
    if (!name) return res.status(400).json({ error: 'missing role name' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      let roleId = id;
      if (roleId) {
        const r = await db.run(
          'UPDATE admin_roles SET name = ?, permissions = ?, updated_at = unixepoch() WHERE id = ?',
          [name, JSON.stringify(permissions), roleId],
        );
        if (!r?.changes) return res.status(404).json({ error: '角色不存在' });
      } else {
        const code = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const r = await db.run(
          'INSERT INTO admin_roles(code, name, permissions, is_builtin, is_enabled, created_at, updated_at) VALUES(?, ?, ?, 0, 1, unixepoch(), unixepoch())',
          [code, name, JSON.stringify(permissions)],
        );
        roleId = r.lastID;
      }
      return res.json({ ok: true, id: roleId });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/roles/disable', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toInt(req.body?.id);
    if (!id) return res.status(400).json({ error: 'missing id' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const role = await db.get('SELECT id, is_builtin FROM admin_roles WHERE id = ? LIMIT 1', [id]);
      if (!role) return res.status(404).json({ error: '角色不存在' });
      if (Number(role.is_builtin) === 1) return res.status(400).json({ error: '系统内置角色不能停用' });
      const count = await db.get('SELECT COUNT(1) AS c FROM admin_user_roles WHERE role_id = ?', [id]);
      if (Number(count?.c || 0) > 0) return res.status(400).json({ error: '该角色已有用户使用，请先调整用户角色' });
      const r = await db.run('UPDATE admin_roles SET is_enabled = 0, updated_at = unixepoch() WHERE id = ?', [id]);
      if (!r?.changes) return res.status(404).json({ error: '角色不存在' });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/users/assign-role', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const userid = req.body?.userid ? String(req.body.userid).trim() : '';
    const roleId = toOptionalInt(req.body?.roleId);
    if (!userid) return res.status(400).json({ error: 'missing userid' });
    if (isFixedAdmin(cfg, userid)) return res.status(400).json({ error: '超级管理员不能修改角色' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      req.auditLogPayload = { userid, roleId };
      if (roleId) {
        const role = await db.get('SELECT id, is_enabled FROM admin_roles WHERE id = ?', [roleId]);
        if (!role || Number(role.is_enabled) !== 1) return res.status(400).json({ error: '角色不存在或已停用' });
        await db.exec(
          `INSERT INTO admin_user_roles(userid, role_id, assigned_by, assigned_name, assigned_at)
           VALUES(?, ?, ?, ?, unixepoch())
           ON CONFLICT(userid) DO UPDATE SET role_id = EXCLUDED.role_id, assigned_by = EXCLUDED.assigned_by, assigned_name = EXCLUDED.assigned_name, assigned_at = EXCLUDED.assigned_at`,
          [userid, roleId, req.adminSession?.userid || '', req.adminSession?.name || ''],
        );
        await db.run('UPDATE users SET is_admin = 1 WHERE userid = ?', [userid]);
      } else {
        await db.run('DELETE FROM admin_user_roles WHERE userid = ?', [userid]);
        await db.run('UPDATE users SET is_admin = 0 WHERE userid = ?', [userid]);
      }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/logs', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const days = Math.min(365, Math.max(1, toPositiveInt(req.query?.days, 30)));
    const limitRaw = toPositiveInt(req.query?.limit, null);
    const hasLimit = Number.isFinite(limitRaw) && limitRaw > 0;
    const limit = hasLimit ? Math.min(10000, limitRaw) : null;
    const minCreatedAt = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    try {
      res.setHeader('Cache-Control', 'no-store');
      await purgeExpiredAuditLogs(db);
      const sql = `SELECT id, event_type, actor_type, actor_id, actor_name, ip, method, path, status_code, message, payload, created_at
         FROM audit_logs
         WHERE created_at >= ?
         ORDER BY id DESC${hasLimit ? '\n         LIMIT ?' : ''}`;
      const rows = await db.all(sql, hasLimit ? [minCreatedAt, limit] : [minCreatedAt]);
      await enrichRedeemConfirmAuditRows(db, rows);
      return res.json({ ok: true, days, limit, data: (rows || []).map(serializeAuditRow) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/my/operations', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const days = Math.min(90, Math.max(1, toPositiveInt(req.query?.days, 30)));
    const limit = Math.min(500, Math.max(1, toPositiveInt(req.query?.limit, 120)));
    const eventGroup = String(req.query?.event_group || '').trim();
    const dateFrom = toOptionalInt(req.query?.date_from);
    const dateTo = toOptionalInt(req.query?.date_to);
    const minCreatedAt = dateFrom || Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const maxCreatedAt = dateTo || null;
    const currentActorId = String(req.adminSession?.userid || '').trim();
    const isSuperAdmin = req.adminAccess?.isSuperAdmin === true;
    const selectedActorId = isSuperAdmin ? String(req.query?.actor_id || '').trim() : currentActorId;
    if (!selectedActorId && !isSuperAdmin) return res.json({ ok: true, data: [], actors: [] });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const relevantSql = `(path LIKE '%/ledger/grant-batch%' OR path LIKE '%/redeem/deduct-batch%' OR path LIKE '%/redeem/confirm%' OR path LIKE '%/backup/export%' OR path LIKE '%/backup/import%' OR path LIKE '%/users/delete%' OR path LIKE '%/data/reset%' OR path LIKE '%/history/clear%' OR path LIKE '%/users/assign-role%' OR path LIKE '%/roles/%')`;
      const where = ['a.created_at >= ?', relevantSql];
      const params = [minCreatedAt];
      if (maxCreatedAt) {
        where.push('a.created_at <= ?');
        params.push(maxCreatedAt);
      }
      if (selectedActorId) {
        where.push('a.actor_id = ?');
        params.push(selectedActorId);
      }
      if (eventGroup) {
        const groupSql = {
          grant: "a.path LIKE '%/ledger/grant-batch%'",
          deduct: "a.path LIKE '%/redeem/deduct-batch%'",
          redeem: "a.path LIKE '%/redeem/confirm%'",
          backup: "(a.path LIKE '%/backup/export%' OR a.path LIKE '%/backup/import%')",
          role: "(a.path LIKE '%/roles/%' OR a.path LIKE '%/users/assign-role%')",
          danger: "(a.path LIKE '%/users/delete%' OR a.path LIKE '%/data/reset%' OR a.path LIKE '%/history/clear%')",
        }[eventGroup];
        if (groupSql) where.push(groupSql);
      }
      const rows = await db.all(
        `SELECT a.id, a.event_type, a.actor_type, a.actor_id, a.actor_name, COALESCE(u.name, '') AS actor_user_name,
                a.ip, a.method, a.path, a.status_code, a.message, a.payload, a.created_at
         FROM audit_logs a
         LEFT JOIN users u ON u.userid = a.actor_id
         WHERE ${where.join(' AND ')}
         ORDER BY a.id DESC
         LIMIT ?`,
        [...params, limit],
      );
      const actorRows = isSuperAdmin ? await db.all(
        `SELECT a.actor_id, COALESCE(NULLIF(MAX(u.name), ''), NULLIF(MAX(a.actor_name), ''), a.actor_id) AS actor_name
         FROM audit_logs a
         LEFT JOIN users u ON u.userid = a.actor_id
         WHERE a.created_at >= ? AND a.actor_type = 'admin' AND COALESCE(a.actor_id, '') <> '' AND ${relevantSql}
         GROUP BY a.actor_id
         ORDER BY actor_name ASC`,
        [minCreatedAt],
      ) : [];
      await enrichRedeemConfirmAuditRows(db, rows);
      return res.json({
        ok: true,
        days,
        limit,
        scope: isSuperAdmin ? 'all' : 'mine',
        actors: (actorRows || []).map((row) => ({ userid: row.actor_id, name: row.actor_name || row.actor_id })),
        data: await serializeOperationRows(db, rows || []),
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/content/faq', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limit = Math.min(300, Math.max(1, toPositiveInt(req.query?.limit, 120)));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT id, question, answer, sort, is_enabled, created_at, updated_at
         FROM content_faq
         ORDER BY sort ASC, id DESC
         LIMIT ?`,
        [limit],
      );
      return res.json({ ok: true, count: (rows || []).length, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/faq/save', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    const question = req.body?.question ? String(req.body.question).trim() : '';
    const answer = req.body?.answer ? String(req.body.answer).trim() : '';
    const sort = toOptionalInt(req.body?.sort) ?? 0;
    const isEnabled = isTruthyFlag(req.body?.is_enabled) ? 1 : 0;
    if (!question) return res.status(400).json({ error: 'missing question' });
    if (!answer) return res.status(400).json({ error: 'missing answer' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (id) {
        const r = await db.run(
          `UPDATE content_faq
           SET question = ?, answer = ?, sort = ?, is_enabled = ?, updated_at = unixepoch()
           WHERE id = ?`,
          [question, answer, sort, isEnabled, id],
        );
        if (!r?.changes) return res.status(400).json({ error: 'faq not found' });
        publishMoreChanged('faq');
        return res.json({ ok: true, id });
      }
      const r = await db.run(
        `INSERT INTO content_faq(question, answer, sort, is_enabled, created_at, updated_at)
         VALUES(?, ?, ?, ?, unixepoch(), unixepoch())`,
        [question, answer, sort, isEnabled],
      );
      publishMoreChanged('faq');
      return res.json({ ok: true, id: Number(r?.lastID || 0) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/faq/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    if (!id) return res.status(400).json({ error: 'missing id' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const r = await db.run('DELETE FROM content_faq WHERE id = ?', [id]);
      if (!r?.changes) return res.status(400).json({ error: 'faq not found' });
      publishMoreChanged('faq');
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/content/announcements', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limit = Math.min(200, Math.max(1, toPositiveInt(req.query?.limit, 80)));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT id, title, content, level, sort, is_enabled, publish_at, created_at, updated_at
         FROM content_announcements
         ORDER BY COALESCE(publish_at, created_at) DESC, sort ASC, id DESC
         LIMIT ?`,
        [limit],
      );
      return res.json({ ok: true, count: (rows || []).length, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/announcements/save', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    const title = req.body?.title ? String(req.body.title).trim() : '';
    const content = req.body?.content ? String(req.body.content).trim() : '';
    const level = normalizeAnnouncementLevel(req.body?.level);
    const sort = toOptionalInt(req.body?.sort) ?? 0;
    const isEnabled = isTruthyFlag(req.body?.is_enabled) ? 1 : 0;
    const publishAt = toOptionalInt(req.body?.publish_at);
    if (!title) return res.status(400).json({ error: 'missing title' });
    if (!content) return res.status(400).json({ error: 'missing content' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (id) {
        const r = await db.run(
          `UPDATE content_announcements
           SET title = ?, content = ?, level = ?, sort = ?, is_enabled = ?, publish_at = ?, updated_at = unixepoch()
           WHERE id = ?`,
          [title, content, level, sort, isEnabled, publishAt, id],
        );
        if (!r?.changes) return res.status(400).json({ error: 'announcement not found' });
        publishMoreChanged('announcements');
        return res.json({ ok: true, id });
      }
      const r = await db.run(
        `INSERT INTO content_announcements(title, content, level, sort, is_enabled, publish_at, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
        [title, content, level, sort, isEnabled, publishAt],
      );
      publishMoreChanged('announcements');
      return res.json({ ok: true, id: Number(r?.lastID || 0) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/announcements/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    if (!id) return res.status(400).json({ error: 'missing id' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const r = await db.run('DELETE FROM content_announcements WHERE id = ?', [id]);
      if (!r?.changes) return res.status(400).json({ error: 'announcement not found' });
      publishMoreChanged('announcements');
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/content/feedback', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limit = Math.min(300, Math.max(1, toPositiveInt(req.query?.limit, 120)));
    const status = req.query?.status ? String(req.query.status).trim() : '';
    const keyword = req.query?.keyword ? String(req.query.keyword).trim() : '';
    try {
      res.setHeader('Cache-Control', 'no-store');
      const where = [];
      const params = [];
      if (status) {
        where.push('f.status = ?');
        params.push(normalizeFeedbackStatus(status));
      }
      if (keyword) {
        const kw = `%${keyword}%`;
        where.push('(f.userid LIKE ? OR COALESCE(f.name, \'\') LIKE ? OR f.content LIKE ?)');
        params.push(kw, kw, kw);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = await db.all(
        `SELECT f.id, f.userid, COALESCE(f.name, '') AS name, f.category, f.content, f.contact,
                f.status, f.reply, f.handled_by, f.handled_name, f.handled_at, f.created_at, f.updated_at
         FROM user_feedback f
         ${whereSql}
         ORDER BY f.id DESC
         LIMIT ?`,
        [...params, limit],
      );
      const data = await attachFeedbackMessages(db, rows || []);
      return res.json({ ok: true, count: data.length, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/feedback/handle', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    const status = normalizeFeedbackStatus(req.body?.status);
    const reply = req.body?.reply ? String(req.body.reply).trim() : '';
    if (!id) return res.status(400).json({ error: 'missing id' });
    const payload = getAdminSessionPayload(req) || {};
    const actorId = payload?.userid ? String(payload.userid) : '';
    const actorName = payload?.name ? String(payload.name) : '';
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await db.get('SELECT id FROM user_feedback WHERE id = ?', [id]);
      if (!row) return res.status(400).json({ error: 'feedback not found' });
      await runInTransaction(db, async (tx) => {
        if (reply) {
          await tx.run(
            `INSERT INTO user_feedback_messages(feedback_id, sender_type, sender_id, sender_name, content, created_at)
             VALUES(?, 'admin', ?, ?, ?, unixepoch())`,
            [id, actorId, actorName, reply],
          );
        }
        await tx.run(
          `UPDATE user_feedback
           SET status = ?, reply = CASE WHEN ? <> '' THEN ? ELSE reply END, handled_by = ?, handled_name = ?, handled_at = unixepoch(), updated_at = unixepoch()
           WHERE id = ?`,
          [status, reply, reply, actorId, actorName, id],
        );
      });
      publishMoreChanged('feedback');
      return res.json({ ok: true, id });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/content/version', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT id, version_name, release_notes, is_enabled, publish_at, created_at, updated_at
         FROM system_versions
         ORDER BY COALESCE(publish_at, created_at) DESC, id DESC
         LIMIT 50`,
      );
      return res.json({ ok: true, count: (rows || []).length, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/version/save', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    const versionName = req.body?.version_name ? String(req.body.version_name).trim() : '';
    const releaseNotes = req.body?.release_notes ? String(req.body.release_notes).trim() : '';
    const isEnabled = isTruthyFlag(req.body?.is_enabled) ? 1 : 0;
    const publishAt = toOptionalInt(req.body?.publish_at);
    if (!versionName) return res.status(400).json({ error: 'missing version_name' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (id) {
        const r = await db.run(
          `UPDATE system_versions
           SET version_name = ?, release_notes = ?, is_enabled = ?, publish_at = ?, updated_at = unixepoch()
           WHERE id = ?`,
          [versionName, releaseNotes, isEnabled, publishAt, id],
        );
        if (!r?.changes) return res.status(400).json({ error: 'version not found' });
        publishMoreChanged('version');
        return res.json({ ok: true, id });
      }
      const r = await db.run(
        `INSERT INTO system_versions(version_name, release_notes, is_enabled, publish_at, created_at, updated_at)
         VALUES(?, ?, ?, ?, unixepoch(), unixepoch())`,
        [versionName, releaseNotes, isEnabled, publishAt],
      );
      publishMoreChanged('version');
      return res.json({ ok: true, id: Number(r?.lastID || 0) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/login', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const body = req.body || {};

    const username = body.username ? String(body.username) : '';
    const password = body.password ? String(body.password) : '';

    if (!username || !password) {
      safeAppendAuditLog(req.app?.locals?.db, {
        eventType: 'admin_login_failed',
        actorType: 'admin',
        actorId: username,
        ip: getClientIp(req),
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: 400,
        message: '管理员登录失败：缺少用户名或密码',
      });
      return res.status(400).json({ error: 'missing username or password' });
    }

    if (username !== cfg?.adminFallbackUsername || password !== cfg?.adminFallbackPassword) {
      safeAppendAuditLog(req.app?.locals?.db, {
        eventType: 'admin_login_failed',
        actorType: 'admin',
        actorId: username,
        ip: getClientIp(req),
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: 401,
        message: '管理员登录失败：账号或密码错误',
      });
      return res.status(401).json({ error: 'unauthorized' });
    }

    const userid = cfg?.adminFallbackUserid || '';
    const db = req.app?.locals?.db;
    const name = await resolveAdminDisplayName(db, cfg, { userid, username });
    const secret = `${cfg?.adminSessionSecret || ''}:${cfg?.sessionSalt || ''}`;
    const token = createSessionToken(secret, { userid, name, username, mode: 'password' }, 8 * 3600);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', [buildClearLegacyAdminPathCookie(), buildSessionCookie(token)]);
    safeAppendAuditLog(req.app?.locals?.db, {
      eventType: 'admin_login_success',
      actorType: 'admin',
      actorId: userid,
      actorName: name,
      ip: getClientIp(req),
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode: 200,
      message: '管理员登录成功',
    });
    return res.json({ ok: true, name });
  });

  router.post('/logout', (req, res) => {
    const payload = getAdminSessionPayload(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', [buildClearLegacyAdminPathCookie(), buildClearSessionCookie()]);
    safeAppendAuditLog(req.app?.locals?.db, {
      eventType: 'admin_logout',
      actorType: 'admin',
      actorId: payload?.userid || '',
      actorName: payload?.name || '',
      ip: getClientIp(req),
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode: 200,
      message: '管理员退出登录',
    });
    return res.json({ ok: true });
  });

  router.get('/config', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const url = req.query.url ? String(req.query.url) : '';
    if (!url) {
      return res.status(400).json({ error: 'missing url' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await buildJsapiConfig(cfg, url);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/auth', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const code = req.query.code ? String(req.query.code) : '';
    if (!code) {
      return res.status(400).json({ error: 'missing code' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const db = req.app.locals.db;
      const userid = await getUserIdByAuthCode(cfg, code);

      const cached = await db.get('SELECT name FROM users WHERE userid = ?', [userid]);
      const cachedName = cached?.name ? String(cached.name) : '';
      const profile = cachedName ? { userid, name: cachedName } : await getUserProfile(cfg, userid);

      await ensureAccount(db, { userid: profile.userid, name: profile.name });

      if (!(await isAdmin(db, cfg, profile.userid))) {
        return res.status(403).json({ error: 'forbidden', userid: profile.userid, name: profile.name });
      }

      const secret = `${cfg?.adminSessionSecret || ''}:${cfg?.sessionSalt || ''}`;
      const token = createSessionToken(secret, { userid: profile.userid, name: profile.name, mode: 'dingtalk' }, 8 * 3600);
      res.setHeader('Set-Cookie', [buildClearLegacyAdminPathCookie(), buildSessionCookie(token)]);
      return res.json({ ok: true, name: profile.name });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/users/sync', requireAdminSession(), async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const db = req.app?.locals?.db;

    try {
      res.setHeader('Cache-Control', 'no-store');

      const departments = await listDingtalkDepartmentsTree(cfg);
      const deptNameMap = new Map(departments.map((dept) => [String(dept.dept_id), String(dept.name || dept.dept_id)]));
      deptNameMap.set('1', '根部门');
      const deptIds = ['1', ...departments.map((dept) => String(dept.dept_id))];
      const users = new Map();

      let fetched = 0;
      let activeCount = 0;

      for (const deptId of deptIds) {
        let cursor = 0;
        for (;;) {
          const page = await listUsersByDept(cfg, { deptId, cursor, size: 100 });
          cursor = page.nextCursor;

          for (const u of page.list) {
            fetched += 1;
            const userid = u?.userid ? String(u.userid) : '';
            if (!userid) continue;
            if (!isActiveFlag(u?.active)) continue;
            activeCount += 1;

            const profile = normalizeDingtalkUserProfile(u, deptNameMap);
            const existing = users.get(userid);
            if (!existing) {
              users.set(userid, profile);
            } else {
              const deptSet = new Set([...(existing.dept_ids || []), ...(profile.dept_ids || [])]);
              const dept_ids = [...deptSet];
              users.set(userid, {
                ...existing,
                ...Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== '' && value !== null && value !== undefined)),
                dept_ids,
                dept_names: dept_ids.map((id) => deptNameMap.get(id) || '').filter(Boolean),
              });
            }
          }

          if (!page.hasMore) break;
        }
      }

      await runInTransaction(db, async (tx) => {
        for (const u of users.values()) {
          await ensureAccount(tx, { userid: u.userid, name: u.name });
          await tx.exec(
            `INSERT INTO user_dingtalk_profiles(
              userid, unionid, name, avatar, mobile, telephone, email, org_email, title, job_number, work_place, remark,
              dept_ids, dept_names, extension, hired_date, active, is_admin, is_boss, leader_in_dept, exclusive_account, raw, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
            ON CONFLICT(userid) DO UPDATE SET
              unionid = EXCLUDED.unionid,
              name = EXCLUDED.name,
              avatar = EXCLUDED.avatar,
              mobile = EXCLUDED.mobile,
              telephone = EXCLUDED.telephone,
              email = EXCLUDED.email,
              org_email = EXCLUDED.org_email,
              title = EXCLUDED.title,
              job_number = EXCLUDED.job_number,
              work_place = EXCLUDED.work_place,
              remark = EXCLUDED.remark,
              dept_ids = EXCLUDED.dept_ids,
              dept_names = EXCLUDED.dept_names,
              extension = EXCLUDED.extension,
              hired_date = EXCLUDED.hired_date,
              active = EXCLUDED.active,
              is_admin = EXCLUDED.is_admin,
              is_boss = EXCLUDED.is_boss,
              leader_in_dept = EXCLUDED.leader_in_dept,
              exclusive_account = EXCLUDED.exclusive_account,
              raw = EXCLUDED.raw,
              updated_at = EXCLUDED.updated_at`,
            [
              u.userid, u.unionid, u.name, u.avatar, u.mobile, u.telephone, u.email, u.org_email, u.title, u.job_number, u.work_place, u.remark,
              toJsonText(u.dept_ids), toJsonText(u.dept_names), toJsonText(u.extension), u.hired_date, u.active, u.is_admin, u.is_boss,
              toJsonText(u.leader_in_dept), u.exclusive_account, toJsonText(u.raw),
            ],
          );
        }
      });
      if (users.size > 0) {
        publishMallRealtimeEvent('balance_changed', { reason: 'users_sync' });
        publishMallRealtimeEvent('charity_changed', { reason: 'users_sync' });
      }

      return res.json({
        ok: true,
        deptCount: deptIds.length,
        fetched,
        active: activeCount,
        upserted: users.size,
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/users', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const keyword = normalizeUserSearchKeyword(req.query.keyword);
    const page = toPositiveInt(req.query.page, 1);
    const pageSize = Math.min(100, toPositiveInt(req.query.pageSize, 30));
    const offset = (page - 1) * pageSize;

    try {
      res.setHeader('Cache-Control', 'no-store');

      const where = [];
      const params = [];
      if (keyword) {
        const tokens = keyword.toLowerCase().split(/\s+/g).filter(Boolean).slice(0, 6);
        for (const token of tokens) {
          const kw = `%${token}%`;
          const compactToken = compactUserSearchKeyword(token);
          const group = [
            "LOWER(COALESCE(u.userid, '')) LIKE ?",
            "LOWER(COALESCE(u.name, '')) LIKE ?",
          ];
          params.push(kw, kw);
          if (compactToken) {
            group.push("REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(u.userid, '') || COALESCE(u.name, '')), ' ', ''), '-', ''), '_', ''), '.', '') LIKE ?");
            params.push(`%${compactToken}%`);
          }
          where.push(`(${group.join(' OR ')})`);
        }
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const totalRow = await db.get(`SELECT COUNT(1) AS c FROM users u ${whereSql}`, params);
      const total = Number(totalRow?.c) || 0;

      const rows = await db.all(
        `SELECT u.userid, u.name, u.is_admin, u.created_at, COALESCE(a.balance, 0) AS balance, a.updated_at,
                r.id AS role_id, r.name AS role_name, r.is_enabled AS role_enabled
         FROM users u
         LEFT JOIN accounts a ON a.userid = u.userid
         LEFT JOIN admin_user_roles ur ON ur.userid = u.userid
         LEFT JOIN admin_roles r ON r.id = ur.role_id
         ${whereSql}
         ORDER BY (u.name IS NULL), u.name COLLATE NOCASE, u.userid COLLATE NOCASE
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset],
      );

      const data = (rows || []).map((u) => {
        const userid = u?.userid ? String(u.userid) : '';
        const fixedAdmin = isFixedAdmin(cfg, userid);
        const isAdminFlag = fixedAdmin || Number(u?.is_admin) === 1;
        return {
          ...u,
          is_admin: isAdminFlag || u.role_id ? 1 : 0,
          is_fixed_admin: fixedAdmin ? 1 : 0,
          role: fixedAdmin ? { id: null, name: '超级管理员' } : (u.role_id ? { id: u.role_id, name: u.role_name, is_enabled: u.role_enabled } : null),
        };
      });

      return res.json({
        ok: true,
        page,
        pageSize,
        total,
        data,
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/data/reset-user', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const userid = req.body?.userid ? String(req.body.userid).trim() : '';
    if (!userid) {
      return res.status(400).json({ error: 'missing userid' });
    }

    try {
      await runInTransaction(db, async (tx) => {
        await tx.run('DELETE FROM ledger WHERE userid = ?', [userid]);
        await tx.run('DELETE FROM redeems WHERE userid = ?', [userid]);
        await tx.run('DELETE FROM charity_contributions WHERE userid = ?', [userid]);
        await tx.run('UPDATE accounts SET balance = 0, updated_at = unixepoch() WHERE userid = ?', [userid]);
      });
      publishMallRealtimeResetForUser(userid, 'reset_user');
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/data/reset-all', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const confirm = req.body?.confirm ? String(req.body.confirm).trim() : '';
    if (confirm !== 'RESET_ALL') {
      return res.status(400).json({ error: '确认口令不正确，已取消' });
    }

    try {
      await runInTransaction(db, async (tx) => {
        await tx.run('DELETE FROM ledger');
        await tx.run('DELETE FROM redeems');
        await tx.run('DELETE FROM charity_contributions');
        await tx.run('UPDATE accounts SET balance = 0, updated_at = unixepoch()');
      });
      publishMallRealtimeFullRefresh('reset_all');
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/users/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const ids = Array.isArray(req.body?.userids) ? req.body.userids : [];
    const userids = ids
      .map((x) => (x === null || x === undefined ? '' : String(x)))
      .filter((x) => x.length > 0);

    if (userids.length === 0) {
      return res.status(400).json({ error: 'missing userids' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const placeholders = userids.map(() => '?').join(',');
      const result = await db.run(`DELETE FROM users WHERE userid IN (${placeholders})`, userids);
      if (Number(result?.changes || 0) > 0) {
        publishMallRealtimeEvent('balance_changed', { reason: 'users_delete' });
        publishMallRealtimeEvent('charity_changed', { reason: 'users_delete' });
      }
      return res.json({ ok: true, deleted: result?.changes ?? 0 });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/notify', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await getNotifySettings(db);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/notify', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await saveNotifySettings(db, req.body || {});
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/notify/test', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    let userid = req.body?.userid ? String(req.body.userid).trim() : '';
    const nameKeyword = req.body?.name ? String(req.body.name).trim() : '';
    const event = req.body?.event ? String(req.body.event).trim() : '';
    if (!event) {
      return res.status(400).json({ error: 'missing event' });
    }
    try {
      if (!userid && nameKeyword) {
        const kw = `%${nameKeyword}%`;
        const row = await db.get(
          `SELECT userid
           FROM users
           WHERE LOWER(COALESCE(name, '')) LIKE LOWER(?) OR LOWER(userid) LIKE LOWER(?)
           ORDER BY (name IS NULL), name COLLATE NOCASE, userid COLLATE NOCASE
           LIMIT 1`,
          [kw, kw],
        );
        userid = row?.userid ? String(row.userid) : '';
      }
      if (!userid) {
        return res.status(400).json({ error: 'missing userid' });
      }
      const name = await getUserName(db, userid);
      const variables = {
        name: name || userid,
        userid,
        reason: '测试原因',
        product_name: '测试商品',
        project_id: 'TEST_CHARITY_001',
        project_name: '测试公益项目',
        amount: '10',
        balance: '100',
        exchange_id: 'TEST_EXCHANGE_001',
        from_name: '测试转出人',
        to_name: '测试收款人',
        activity_id: 'TEST_ACTIVITY_001',
        transfer_id: 'TEST_TRANSFER_001',
      };
      const notify = await sendOrQueueNotify({
        db,
        cfg,
        userid,
        title: '【BOB币中心】测试通知',
        lines: ['这是一条测试通知'],
        awaitNotify: true,
        event,
        variables,
      });
      return res.json({ ok: true, notify });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/group-card', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const raw = await getGroupCardSettings(db);
      const data = buildEffectiveGroupCardSettings(cfg, raw);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/group-card', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const saved = await saveGroupCardSettings(db, req.body || {});
      const data = buildEffectiveGroupCardSettings(cfg, saved);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/group-card/test', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const event = req.body?.event ? String(req.body.event).trim() : 'manual';
    const vars = {
      open_time: formatTs(Math.floor(Date.now() / 1000)) || '-',
      close_time: formatTs(Math.floor(Date.now() / 1000) + 1800) || '-',
      product_name: '测试商品',
      stock: '仅剩 1 件',
      amount: '10 BOB 币',
    };
    try {
      const settings = await getGroupCardSettings(db);
      if (settings?.enabled === false) {
        return res.status(400).json({ error: 'group_card_disabled' });
      }
      const tpl = settings?.templates?.[event] || settings?.templates?.manual;
      if (tpl?.enabled === false) {
        return res.status(400).json({ error: 'group_card_template_disabled' });
      }
      await notifyGroupInteractiveCardBySettings(db, cfg, {
        event,
        title: '【BOB币中心】测试群卡标题',
        markdown: '这是一条测试群卡内容',
        outTrackId: `group_test_${event}_${Date.now()}`,
        vars,
      });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });


  router.get('/settings/image-optimization', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await getImageOptimizationOverview(db);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/image-optimization', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await saveImageOptimizationSettings(db, req.body || {});
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/image-optimization/upload', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await optimizeUploadedImage(db, req.body || {});
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(400).json({ error: String(err?.message || err) });
    }
  });

  router.post('/image-optimization/batch', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await runImageOptimizationBatch(db, { mode: req.body?.mode || 'pending' });
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/dingtalk/status', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const settings = await getDingtalkConnectionSettings(db, cfg);
      applyDingtalkConnectionSettings(cfg, settings);
      let connected = false;
      let error = '';
      try {
        await getAccessToken(cfg);
        connected = true;
      } catch (err) {
        error = String(err?.message || err);
      }
      return res.json({ ok: true, connected, error, data: { organizationName: settings.organizationName || '', corpId: settings.corpId ? `${String(settings.corpId).slice(0, 4)}****` : '' } });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/dingtalk', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      let settings = await getDingtalkConnectionSettings(db, cfg);
      applyDingtalkConnectionSettings(cfg, settings);
      let connected = false;
      let error = '';
      try {
        await getAccessToken(cfg);
        connected = true;
        try {
          settings = await resolveDingtalkOrganizationName(cfg, settings);
          applyDingtalkConnectionSettings(cfg, settings);
        } catch (err) {
          error = String(err?.message || err);
        }
      } catch (err) {
        error = String(err?.message || err);
      }
      return res.json({ ok: true, connected, error, data: toPublicDingtalkConnectionSettings(settings) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/dingtalk', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const input = { ...(req.body || {}) };
      delete input.organizationName;
      let settings = await saveDingtalkConnectionSettings(db, input, cfg);
      applyDingtalkConnectionSettings(cfg, settings);
      try {
        settings = await resolveDingtalkOrganizationName(cfg, settings);
        if (settings.organizationName) {
          settings = await saveDingtalkConnectionSettings(db, settings, cfg);
        }
        applyDingtalkConnectionSettings(cfg, settings);
      } catch (err) {
        // 连接配置仍可保存；组织名称会在权限恢复或下次校验成功后自动补齐。
      }
      return res.json({ ok: true, data: toPublicDingtalkConnectionSettings(settings) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/dingtalk/departments', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const settings = await getDingtalkConnectionSettings(db, cfg);
      applyDingtalkConnectionSettings(cfg, settings);
      await getAccessToken(cfg);
      const data = await listDingtalkDepartmentsTree(cfg);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/attendance-reward', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await getAttendanceRewardSettings(db);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/attendance-reward', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const input = { ...(req.body || {}) };
      if (String(input.departmentMode || '') === 'selected' && Array.isArray(input.departmentIds) && input.departmentIds.length) {
        try {
          const departments = await listDingtalkDepartmentsTree(cfg);
          input.departmentExpandedIds = expandDepartmentIdsFromTree(departments, input.departmentIds);
        } catch {
          input.departmentExpandedIds = input.departmentIds;
        }
      } else {
        input.departmentExpandedIds = [];
      }
      const data = await saveAttendanceRewardSettings(db, input);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/attendance-reward/status', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const days = Math.min(14, Math.max(1, toPositiveInt(req.query?.days, 7)));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await getAttendanceRewardDailySummary(db, { days });
      return res.json({ ok: true, days, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/attendance-reward/detail', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const date = req.query?.date ? String(req.query.date).trim() : '';
    if (!date) return res.status(400).json({ error: 'missing date' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await getAttendanceRewardDayDetail(db, { date });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/attendance-reward/reconcile', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const date = req.body?.date ? String(req.body.date).trim() : '';
    const notify = req.body?.notify === undefined ? false : toBool(req.body.notify);
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await reconcileAttendanceRewards(db, cfg, { date, notifyOnReward: notify });
      return res.json({ ok: true, data: result });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/ledger/grant-batch', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const ids = Array.isArray(req.body?.userids) ? req.body.userids : [];
    const userids = ids
      .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
      .filter((x) => x);

    const amount = toInt(req.body?.amount);
    const reason = req.body?.reason ? String(req.body.reason) : undefined;
    const refId = req.body?.refId ? String(req.body.refId) : undefined;

    if (userids.length === 0) {
      return res.status(400).json({ error: 'missing userids' });
    }
    if (amount === null || amount <= 0) {
      return res.status(400).json({ error: 'amount must be positive integer' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      req.auditLogPayload = { userids, amount, reason: reason || '后台发币' };
      const result = await grantBatchWithNotify(db, cfg, { userids, amount, reason, refId, awaitNotify: false });
      for (const row of (result?.results || [])) {
        if (row?.ok && row?.userid) {
          publishMallRealtimeEvent('balance_changed', { userid: String(row.userid), reason: 'admin_grant_batch' });
        }
      }
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/redeem/confirm', requireAdminSession(), async (req, res) => {
    const secret = req.app?.locals?.cfg?.qrSignSecret;
    const cfg = req.app?.locals?.cfg;
    const encoded = req.body?.encoded;

    if (!encoded) {
      return res.status(400).json({ error: 'missing encoded' });
    }

    let payload;
    try {
      payload = verifyEncoded(encoded, secret);
    } catch (err) {
      const message = String(err?.message || err);
      if (err instanceof QRSignError) {
        return res.status(400).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }

    try {
      const db = req.app.locals.db;
      const cdkRow = await db.get(
        'SELECT product_bob_amount FROM redeem_cdks WHERE redeem_exchange_id = ? LIMIT 1',
        [String(payload.exchange_id || '')],
      );
      const displayBobAmount = Number(cdkRow?.product_bob_amount);
      req.auditLogPayload = {
        action: 'redeem_confirm',
        exchangeId: payload.exchange_id,
        productId: payload.product_id,
        productName: payload.product_name,
        bobAmount: Number.isFinite(displayBobAmount) && displayBobAmount > 0 ? displayBobAmount : payload.bob_amount,
        actualBobAmount: payload.bob_amount,
        userid: payload.userid,
        fulfilledBy: req.adminSession?.userid || '',
        fulfilledName: req.adminSession?.name || '',
      };
      const admin = req.adminSession || {};
      const result = await redeemConfirmWithNotify(db, cfg, {
        exchangeId: payload.exchange_id,
        userid: payload.userid,
        productId: payload.product_id,
        productName: payload.product_name,
        bobAmount: payload.bob_amount,
        reason: 'redeem',
        awaitNotify: false,
        fulfilledBy: admin?.userid ? String(admin.userid) : '',
        fulfilledName: admin?.name ? String(admin.name) : '',
      });
      publishMallRealtimeEvent('order_updated', {
        userid: String(payload.userid || ''),
        exchange_id: String(payload.exchange_id || ''),
        status: 'fulfilled',
        source: 'admin_redeem_confirm',
      });
      publishMallRealtimeEvent('balance_changed', {
        userid: String(payload.userid || ''),
        reason: 'admin_redeem_confirm',
      });

      return res.json({ ok: true, userid: result.userid, balance: result.balance, exchange_id: result.exchange_id });
    } catch (err) {
      const message = String(err?.message || err);
      const status = [
        'missing exchange_id',
        'missing userid',
        'missing product_id',
        'bob_amount must be positive integer',
        'insufficient balance',
        'exchange already redeemed',
        'payload mismatch',
      ].includes(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  // ── 备份管理 ──────────────────────────────────────────────────────────────

  // 设置类表：结构配置，适合日常导出恢复
  const SETTINGS_TABLES = [
    'system_settings',
    'mall_products',
    'charity_projects',
    'mall_opening_schedule',
    'content_faq',
    'content_announcements',
    'system_versions',
    'admin_roles',
  ];

  // 全量表：包含用户数据（顺序决定导入顺序，users 必须最先）
  const FULL_TABLES = [
    'users',
    'accounts',
    'bob_tokens',
    'ledger',
    'redeems',
    'redeem_cdks',
    'mall_products',
    'charity_projects',
    'charity_contributions',
    'attendance_reward_records',
    'mall_opening_schedule',
    'red_packet_activity',
    'red_packet_items',
    'content_faq',
    'content_announcements',
    'system_versions',
    'user_feedback',
    'user_feedback_messages',
    'audit_logs',
    'admin_roles',
    'admin_user_roles',
    'system_settings',
  ];

  async function dumpTable(db, tableName) {
    try {
      const rows = await db.all(`SELECT * FROM ${tableName} ORDER BY id ASC`, []);
      return rows;
    } catch {
      // 无 id 列的表（如 system_settings、mall_opening_schedule）
      try {
        const rows = await db.all(`SELECT * FROM ${tableName}`, []);
        return rows;
      } catch {
        return [];
      }
    }
  }

  function backupStorageDir() {
    return process.env.BOB_BACKUP_DIR || fileURLToPath(new URL('../../data/admin-backups/', import.meta.url));
  }

  function safeBackupFilename(filename) {
    const name = path.basename(String(filename || '').trim());
    if (!/^bob_backup_(settings|full)_\d{8}_\d{4}\.json$/.test(name)) {
      throw new Error('备份文件名不合法');
    }
    return name;
  }

  function backupFilePath(filename) {
    return path.join(backupStorageDir(), safeBackupFilename(filename));
  }

  function writeBackupFile(filename, payload) {
    const dir = backupStorageDir();
    mkdirSync(dir, { recursive: true });
    const filePath = backupFilePath(filename);
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    const stat = statSync(filePath);
    return { filePath, size: stat.size };
  }

  async function appendBackupHistory(db, req, input) {
    const payload = getAdminSessionPayload(req) || {};
    await db.run(
      `INSERT INTO admin_backup_history(action, mode, filename, status, actor_id, actor_name, details, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      [
        input.action,
        input.mode,
        input.filename || '',
        input.status || '完成',
        payload?.userid ? String(payload.userid) : '',
        payload?.name ? String(payload.name) : '',
        input.details ? JSON.stringify(input.details) : null,
      ],
    );
  }

  router.get('/backup/history', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limit = Math.min(100, Math.max(1, toPositiveInt(req.query?.limit, 30)));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT id, action, mode, filename, status, actor_id, actor_name, details, created_at AS at
         FROM admin_backup_history
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [limit],
      );
      return res.json({ ok: true, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // GET /admin/backup/export?mode=settings|full
  router.get('/backup/export', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const mode = req.query?.mode === 'full' ? 'full' : 'settings';
    const tables = mode === 'full' ? FULL_TABLES : SETTINGS_TABLES;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = {};
      for (const t of tables) {
        // eslint-disable-next-line no-await-in-loop
        data[t] = await dumpTable(db, t);
      }
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const filename = `bob_backup_${mode}_${stamp}.json`;
      const payload = {
        _meta: {
          version: 1,
          mode,
          filename,
          exportedAt: now.toISOString(),
          tables: Object.fromEntries(tables.map((t) => [t, data[t]?.length ?? 0])),
        },
        data,
      };
      const stored = writeBackupFile(filename, payload);
      await appendBackupHistory(db, req, {
        action: '导出',
        mode,
        filename,
        status: '完成',
        details: { ...payload._meta, size: stored.size, downloadable: true },
      });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.json(payload);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/backup/history/:id/download', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toPositiveInt(req.params?.id, 0);
    if (!id) return res.status(400).json({ error: '缺少备份记录 ID' });
    try {
      const row = await db.get(
        `SELECT id, action, filename
         FROM admin_backup_history
         WHERE id = ?
         LIMIT 1`,
        [id],
      );
      if (!row || row.action !== '导出' || !row.filename) {
        return res.status(404).json({ error: '未找到可下载的备份文件' });
      }
      const filename = safeBackupFilename(row.filename);
      const filePath = backupFilePath(filename);
      if (!existsSync(filePath)) {
        return res.status(404).json({ error: '服务器上的备份文件不存在，请重新导出' });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.download(filePath, filename);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // POST /admin/backup/import
  // body: { backup: <备份 JSON 对象>, mode: 'merge'|'overwrite' }
  router.post('/backup/import', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const backup = req.body?.backup;
    const mode = req.body?.mode === 'overwrite' ? 'overwrite' : 'merge';

    if (!backup || typeof backup !== 'object' || !backup.data) {
      return res.status(400).json({ error: '无效的备份文件格式' });
    }
    if (backup._meta?.version !== 1) {
      return res.status(400).json({ error: `不支持的备份版本: ${backup._meta?.version}` });
    }

    const backupData = backup.data;
    const report = {};
    const importedRoleIdMap = new Map();
    const parseRolePermissions = (value) => {
      if (Array.isArray(value)) return normalizePermissions(value);
      try {
        return normalizePermissions(JSON.parse(String(value || '[]')));
      } catch {
        return [];
      }
    };

    // system_settings：始终 upsert，不清除
    if (Array.isArray(backupData.system_settings)) {
      let count = 0;
      for (const row of backupData.system_settings) {
        if (!row?.key) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await db.exec(
            'INSERT INTO system_settings(key, value, updated_at) VALUES($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
            [row.key, row.value ?? null, row.updated_at ?? Math.floor(Date.now() / 1000)],
          );
          count++;
        } catch { /* skip */ }
      }
      report.system_settings = count;
    }

    // admin_roles：按 code 恢复，记录旧 role_id 到当前 role_id 的映射，供 admin_user_roles 使用。
    if (Array.isArray(backupData.admin_roles)) {
      let count = 0;
      for (const row of backupData.admin_roles) {
        if (!row?.code || !row?.name) continue;
        const code = String(row.code).trim();
        const name = String(row.name).trim();
        const permissions = parseRolePermissions(row.permissions);
        const now = Math.floor(Date.now() / 1000);
        try {
          // eslint-disable-next-line no-await-in-loop
          const existing = await db.get('SELECT id FROM admin_roles WHERE code = ? LIMIT 1', [code]);
          if (existing?.id) {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `UPDATE admin_roles
               SET name = $1, permissions = $2, is_builtin = $3, is_enabled = $4, updated_at = $5
               WHERE code = $6`,
              [name, JSON.stringify(permissions), row.is_builtin ?? 0, row.is_enabled ?? 1, row.updated_at ?? now, code],
            );
            importedRoleIdMap.set(Number(row.id), Number(existing.id));
          } else {
            const backupId = toOptionalInt(row.id);
            let inserted = null;
            if (backupId) {
              try {
                // eslint-disable-next-line no-await-in-loop
                inserted = await db.get('SELECT id FROM admin_roles WHERE id = ? LIMIT 1', [backupId]);
                if (!inserted?.id) {
                  // eslint-disable-next-line no-await-in-loop
                  await db.exec(
                    `INSERT INTO admin_roles(id, code, name, permissions, is_builtin, is_enabled, created_at, updated_at)
                     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [backupId, code, name, JSON.stringify(permissions), row.is_builtin ?? 0, row.is_enabled ?? 1,
                      row.created_at ?? now, row.updated_at ?? now],
                  );
                } else {
                  inserted = null;
                }
              } catch {
                inserted = null;
              }
            }
            if (!backupId || inserted === null) {
              // eslint-disable-next-line no-await-in-loop
              await db.exec(
                `INSERT INTO admin_roles(code, name, permissions, is_builtin, is_enabled, created_at, updated_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT(code) DO UPDATE SET
                   name=excluded.name, permissions=excluded.permissions, is_builtin=excluded.is_builtin,
                   is_enabled=excluded.is_enabled, updated_at=excluded.updated_at`,
                [code, name, JSON.stringify(permissions), row.is_builtin ?? 0, row.is_enabled ?? 1,
                  row.created_at ?? now, row.updated_at ?? now],
              );
            }
            // eslint-disable-next-line no-await-in-loop
            const saved = await db.get('SELECT id FROM admin_roles WHERE code = ? LIMIT 1', [code]);
            if (saved?.id) importedRoleIdMap.set(Number(row.id), Number(saved.id));
          }
          count++;
        } catch { /* skip */ }
      }
      try { await db.exec(`SELECT setval(pg_get_serial_sequence('admin_roles', 'id'), (SELECT MAX(id) FROM admin_roles))`, []); } catch { /* skip */ }
      report.admin_roles = count;
    }

    // mall_products：upsert by product_id
    if (Array.isArray(backupData.mall_products)) {
      if (mode === 'overwrite') {
        try { await db.exec('DELETE FROM mall_products', []); } catch { /* skip */ }
      }
      let count = 0;
      for (const row of backupData.mall_products) {
        if (!row?.product_id) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await db.exec(
            `INSERT INTO mall_products(product_id, product_name, bob_amount, stock, limit_per_user, limit_round, cdk_enabled, status, sort, image_url, remark, created_at, updated_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT(product_id) DO UPDATE SET
               product_name=excluded.product_name, bob_amount=excluded.bob_amount, stock=excluded.stock,
               limit_per_user=excluded.limit_per_user, limit_round=excluded.limit_round, cdk_enabled=excluded.cdk_enabled, status=excluded.status, sort=excluded.sort,
               image_url=excluded.image_url, remark=excluded.remark, updated_at=excluded.updated_at`,
            [row.product_id, row.product_name, row.bob_amount, row.stock ?? null, row.limit_per_user ?? 0,
              row.limit_round ?? 1, row.cdk_enabled ?? 0, row.status ?? 'on', row.sort ?? null, row.image_url ?? null, row.remark ?? null,
              row.created_at ?? Math.floor(Date.now() / 1000), row.updated_at ?? Math.floor(Date.now() / 1000)],
          );
          count++;
        } catch { /* skip */ }
      }
      report.mall_products = count;
    }

    if (Array.isArray(backupData.charity_projects)) {
      if (mode === 'overwrite') {
        try { await db.exec('DELETE FROM charity_contributions', []); } catch { /* skip */ }
        try { await db.exec('DELETE FROM charity_projects', []); } catch { /* skip */ }
      }
      let count = 0;
      for (const row of backupData.charity_projects) {
        if (!row?.project_id) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await db.exec(
            `INSERT INTO charity_projects(project_id, project_name, cover_image_url, summary, rules_text, target_bob_amount, tier_options_json, status, execution_status, execution_note, sort, created_at, updated_at, executed_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT(project_id) DO UPDATE SET
               project_name=excluded.project_name, cover_image_url=excluded.cover_image_url, summary=excluded.summary,
               rules_text=excluded.rules_text, target_bob_amount=excluded.target_bob_amount, tier_options_json=excluded.tier_options_json,
               status=excluded.status, execution_status=excluded.execution_status, execution_note=excluded.execution_note,
               sort=excluded.sort, updated_at=excluded.updated_at, executed_at=excluded.executed_at`,
            [
              row.project_id,
              row.project_name ?? row.project_id,
              row.cover_image_url ?? null,
              row.summary ?? '',
              row.rules_text ?? '',
              row.target_bob_amount ?? 0,
              row.tier_options_json ?? '[10,20,50,100]',
              row.status ?? 'active',
              row.execution_status ?? 'pending',
              row.execution_note ?? null,
              row.sort ?? null,
              row.created_at ?? Math.floor(Date.now() / 1000),
              row.updated_at ?? Math.floor(Date.now() / 1000),
              row.executed_at ?? null,
            ],
          );
          count++;
        } catch { /* skip */ }
      }
      report.charity_projects = count;
    }

    // mall_opening_schedule：直接 upsert id=1
    // remind_for_open_at / open_notify_for_open_at / close_remind_for_close_at 是调度器运行时状态，恢复时置 null 避免触发错误通知
    if (Array.isArray(backupData.mall_opening_schedule) && backupData.mall_opening_schedule.length > 0) {
      const row = backupData.mall_opening_schedule[0];
      try {
        await db.exec(
          `INSERT INTO mall_opening_schedule(id, is_open, auto_enabled, next_open_at, interval_minutes, open_duration_minutes, remind_before_seconds, close_remind_seconds, remind_for_open_at, open_notify_for_open_at, close_remind_for_close_at, updated_at)
           VALUES(1,$1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,$8)
           ON CONFLICT(id) DO UPDATE SET
             is_open=excluded.is_open, auto_enabled=excluded.auto_enabled, next_open_at=excluded.next_open_at,
             interval_minutes=excluded.interval_minutes, open_duration_minutes=excluded.open_duration_minutes,
             remind_before_seconds=excluded.remind_before_seconds, close_remind_seconds=excluded.close_remind_seconds,
             remind_for_open_at=NULL, open_notify_for_open_at=NULL, close_remind_for_close_at=NULL,
             updated_at=excluded.updated_at`,
          [row.is_open ?? 1, row.auto_enabled ?? 0, row.next_open_at ?? null, row.interval_minutes ?? null,
            row.open_duration_minutes ?? null, row.remind_before_seconds ?? null, row.close_remind_seconds ?? null,
            row.updated_at ?? Math.floor(Date.now() / 1000)],
        );
        report.mall_opening_schedule = 1;
      } catch { report.mall_opening_schedule = 0; }
    }

    // content_faq：overwrite 时清空重插，merge 时按 id 冲突跳过
    if (Array.isArray(backupData.content_faq)) {
      if (mode === 'overwrite') {
        try { await db.exec('DELETE FROM content_faq', []); } catch { /* skip */ }
      }
      let count = 0;
      for (const row of backupData.content_faq) {
        if (!row?.id) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await db.exec(
            'INSERT INTO content_faq(id, question, answer, sort, is_enabled, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
            [row.id, row.question ?? '', row.answer ?? '', row.sort ?? 0, row.is_enabled ?? 1,
              row.created_at ?? Math.floor(Date.now() / 1000), row.updated_at ?? Math.floor(Date.now() / 1000)],
          );
          count++;
        } catch { /* skip */ }
      }
      if (mode === 'overwrite' && count > 0) {
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('content_faq', 'id'), (SELECT MAX(id) FROM content_faq))`, []); } catch { /* skip */ }
      }
      report.content_faq = count;
    }

    // content_announcements：overwrite 时清空重插，merge 时按 id 冲突跳过
    if (Array.isArray(backupData.content_announcements)) {
      if (mode === 'overwrite') {
        try { await db.exec('DELETE FROM content_announcements', []); } catch { /* skip */ }
      }
      let count = 0;
      for (const row of backupData.content_announcements) {
        if (!row?.id) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await db.exec(
            'INSERT INTO content_announcements(id, title, content, level, sort, is_enabled, publish_at, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING',
            [row.id, row.title ?? '', row.content ?? '', row.level ?? 'info', row.sort ?? 0,
              row.is_enabled ?? 1, row.publish_at ?? null,
              row.created_at ?? Math.floor(Date.now() / 1000), row.updated_at ?? Math.floor(Date.now() / 1000)],
          );
          count++;
        } catch { /* skip */ }
      }
      if (mode === 'overwrite' && count > 0) {
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('content_announcements', 'id'), (SELECT MAX(id) FROM content_announcements))`, []); } catch { /* skip */ }
      }
      report.content_announcements = count;
    }

    // system_versions：overwrite 时清空重插，merge 时按 id 冲突跳过
    if (Array.isArray(backupData.system_versions)) {
      if (mode === 'overwrite') {
        try { await db.exec('DELETE FROM system_versions', []); } catch { /* skip */ }
      }
      let count = 0;
      for (const row of backupData.system_versions) {
        if (!row?.id) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await db.exec(
            'INSERT INTO system_versions(id, version_name, release_notes, is_enabled, publish_at, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
            [row.id, row.version_name ?? '', row.release_notes ?? null, row.is_enabled ?? 1,
              row.publish_at ?? null,
              row.created_at ?? Math.floor(Date.now() / 1000), row.updated_at ?? Math.floor(Date.now() / 1000)],
          );
          count++;
        } catch { /* skip */ }
      }
      if (mode === 'overwrite' && count > 0) {
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('system_versions', 'id'), (SELECT MAX(id) FROM system_versions))`, []); } catch { /* skip */ }
      }
      report.system_versions = count;
    }

    // 全量模式才处理用户/账本数据
    if (backup._meta?.mode === 'full') {
      // users：upsert by userid
      if (Array.isArray(backupData.users)) {
        if (mode === 'overwrite') {
          try { await db.exec('DELETE FROM admin_user_roles', []); } catch { /* skip */ }
          try { await db.exec('DELETE FROM audit_logs', []); } catch { /* skip */ }
          try { await db.exec('DELETE FROM attendance_reward_records', []); } catch { /* skip */ }
          try { await db.exec('DELETE FROM ledger', []); } catch { /* skip */ }
          try { await db.exec('DELETE FROM redeem_cdks', []); } catch { /* skip */ }
          try { await db.exec('DELETE FROM redeems', []); } catch { /* skip */ }
          try { await db.exec('DELETE FROM charity_contributions', []); } catch { /* skip */ }
          try { await db.exec('DELETE FROM bob_tokens', []); } catch { /* skip */ }
          try { await db.exec('DELETE FROM accounts', []); } catch { /* skip */ }
          try { await db.exec('DELETE FROM users', []); } catch { /* skip */ }
        }
        let count = 0;
        for (const row of backupData.users) {
          if (!row?.userid) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              'INSERT INTO users(userid, name, is_admin, created_at) VALUES($1,$2,$3,$4) ON CONFLICT(userid) DO UPDATE SET name=excluded.name, is_admin=excluded.is_admin',
              [row.userid, row.name ?? null, row.is_admin ?? 0, row.created_at ?? Math.floor(Date.now() / 1000)],
            );
            count++;
          } catch { /* skip */ }
        }
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT MAX(id) FROM users))`, []); } catch { /* skip */ }
        report.users = count;
      }

      if (Array.isArray(backupData.admin_user_roles)) {
        let count = 0;
        for (const row of backupData.admin_user_roles) {
          if (!row?.userid || !row?.role_id) continue;
          try {
            let roleId = importedRoleIdMap.get(Number(row.role_id)) || toOptionalInt(row.role_id);
            // eslint-disable-next-line no-await-in-loop
            const role = roleId ? await db.get('SELECT id FROM admin_roles WHERE id = ? LIMIT 1', [roleId]) : null;
            if (!role?.id && row.role_code) {
              // eslint-disable-next-line no-await-in-loop
              const byCode = await db.get('SELECT id FROM admin_roles WHERE code = ? LIMIT 1', [String(row.role_code)]);
              roleId = byCode?.id || null;
            }
            if (!roleId) continue;
            // eslint-disable-next-line no-await-in-loop
            const user = await db.get('SELECT userid FROM users WHERE userid = ? LIMIT 1', [row.userid]);
            if (!user?.userid) continue;
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `INSERT INTO admin_user_roles(userid, role_id, assigned_by, assigned_name, assigned_at)
               VALUES($1,$2,$3,$4,$5)
               ON CONFLICT(userid) DO UPDATE SET
                 role_id=excluded.role_id, assigned_by=excluded.assigned_by,
                 assigned_name=excluded.assigned_name, assigned_at=excluded.assigned_at`,
              [row.userid, roleId, row.assigned_by ?? null, row.assigned_name ?? null,
                row.assigned_at ?? Math.floor(Date.now() / 1000)],
            );
            count++;
          } catch { /* skip */ }
        }
        report.admin_user_roles = count;
      }

      // accounts：upsert by userid
      if (Array.isArray(backupData.accounts)) {
        let count = 0;
        for (const row of backupData.accounts) {
          if (!row?.userid) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              'INSERT INTO accounts(userid, balance, updated_at) VALUES($1,$2,$3) ON CONFLICT(userid) DO UPDATE SET balance=excluded.balance, updated_at=excluded.updated_at',
              [row.userid, row.balance ?? 0, row.updated_at ?? Math.floor(Date.now() / 1000)],
            );
            count++;
          } catch { /* skip */ }
        }
        report.accounts = count;
      }

      if (Array.isArray(backupData.bob_tokens)) {
        let count = 0;
        for (const row of backupData.bob_tokens) {
          if (!row?.token_hash) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `INSERT INTO bob_tokens(id, token, token_hash, created_at, revoked_at)
               VALUES($1,$2,$3,$4,$5) ON CONFLICT(token_hash) DO NOTHING`,
              [row.id ?? null, row.token ?? null, row.token_hash, row.created_at ?? Math.floor(Date.now() / 1000), row.revoked_at ?? null],
            );
            count++;
          } catch { /* skip */ }
        }
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('bob_tokens', 'id'), (SELECT MAX(id) FROM bob_tokens))`, []); } catch { /* skip */ }
        report.bob_tokens = count;
      }

      // ledger：无业务唯一约束，保留原始 id，按 id 冲突跳过（merge 时不重复插入同一条）
      if (Array.isArray(backupData.ledger)) {
        let count = 0;
        for (const row of backupData.ledger) {
          if (!row?.userid || !row?.id) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              'INSERT INTO ledger(id, userid, delta, reason, ref_id, created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
              [row.id, row.userid, row.delta, row.reason ?? '', row.ref_id ?? null, row.created_at ?? Math.floor(Date.now() / 1000)],
            );
            count++;
          } catch { /* skip */ }
        }
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('ledger', 'id'), (SELECT MAX(id) FROM ledger))`, []); } catch { /* skip */ }
        report.ledger = count;
      }

      // redeems：exchange_id 唯一，保留原始 id，按 exchange_id 冲突跳过
      if (Array.isArray(backupData.redeems)) {
        let count = 0;
        for (const row of backupData.redeems) {
          if (!row?.exchange_id) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `INSERT INTO redeems(id, exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at, fulfilled_by, fulfilled_name, hidden, limit_round, created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(exchange_id) DO NOTHING`,
              [row.id ?? null, row.exchange_id, row.userid, row.product_id, row.product_name ?? null,
                row.bob_amount, row.fulfilled_at ?? null, row.fulfilled_by ?? null, row.fulfilled_name ?? null, row.hidden ?? 0,
                row.limit_round ?? 1,
                row.created_at ?? Math.floor(Date.now() / 1000)],
            );
            count++;
          } catch { /* skip */ }
        }
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('redeems', 'id'), (SELECT MAX(id) FROM redeems))`, []); } catch { /* skip */ }
        report.redeems = count;
      }

      if (Array.isArray(backupData.redeem_cdks)) {
        let count = 0;
        for (const row of backupData.redeem_cdks) {
          if (!row?.cdk_code) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `INSERT INTO redeem_cdks(id, batch_id, cdk_code, product_id, product_name, product_bob_amount, status, created_by, created_name, created_at, redeemed_by, redeemed_name, redeemed_at, redeem_exchange_id)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(cdk_code) DO NOTHING`,
              [
                row.id ?? null,
                row.batch_id ?? '',
                row.cdk_code,
                row.product_id ?? '',
                row.product_name ?? '',
                row.product_bob_amount ?? 0,
                row.status ?? 'unused',
                row.created_by ?? null,
                row.created_name ?? null,
                row.created_at ?? Math.floor(Date.now() / 1000),
                row.redeemed_by ?? null,
                row.redeemed_name ?? null,
                row.redeemed_at ?? null,
                row.redeem_exchange_id ?? null,
              ],
            );
            count++;
          } catch { /* skip */ }
        }
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('redeem_cdks', 'id'), (SELECT MAX(id) FROM redeem_cdks))`, []); } catch { /* skip */ }
        report.redeem_cdks = count;
      }

      if (Array.isArray(backupData.charity_contributions)) {
        let count = 0;
        for (const row of backupData.charity_contributions) {
          if (!row?.id || !row?.project_id || !row?.userid) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `INSERT INTO charity_contributions(id, project_id, userid, user_name_snapshot, bob_amount, created_at)
               VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
              [
                row.id,
                row.project_id,
                row.userid,
                row.user_name_snapshot ?? null,
                row.bob_amount ?? 0,
                row.created_at ?? Math.floor(Date.now() / 1000),
              ],
            );
            count++;
          } catch { /* skip */ }
        }
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('charity_contributions', 'id'), (SELECT MAX(id) FROM charity_contributions))`, []); } catch { /* skip */ }
        report.charity_contributions = count;
      }

      if (Array.isArray(backupData.attendance_reward_records)) {
        let count = 0;
        for (const row of backupData.attendance_reward_records) {
          if (!row?.userid || !row?.work_date || !row?.check_time_ms) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `INSERT INTO attendance_reward_records(id, userid, user_name_snapshot, work_date, check_time_ms, check_time_text, check_type, source_type, time_result, event_source, status, skip_reason, reward_amount, reward_reason, notify_status, error_message, created_at, updated_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
               ON CONFLICT(userid, work_date, check_time_ms) DO NOTHING`,
              [
                row.id ?? null,
                row.userid,
                row.user_name_snapshot ?? null,
                row.work_date,
                row.check_time_ms,
                row.check_time_text ?? null,
                row.check_type ?? null,
                row.source_type ?? null,
                row.time_result ?? null,
                row.event_source ?? 'stream',
                row.status ?? 'pending',
                row.skip_reason ?? null,
                row.reward_amount ?? null,
                row.reward_reason ?? null,
                row.notify_status ?? null,
                row.error_message ?? null,
                row.created_at ?? Math.floor(Date.now() / 1000),
                row.updated_at ?? Math.floor(Date.now() / 1000),
              ],
            );
            count++;
          } catch { /* skip */ }
        }
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('attendance_reward_records', 'id'), (SELECT MAX(id) FROM attendance_reward_records))`, []); } catch { /* skip */ }
        report.attendance_reward_records = count;
      }

      // user_feedback：overwrite 时清空重插，merge 时按 id 冲突跳过
      if (Array.isArray(backupData.user_feedback)) {
        if (mode === 'overwrite') {
          try { await db.exec('DELETE FROM user_feedback', []); } catch { /* skip */ }
        }
        let count = 0;
        for (const row of backupData.user_feedback) {
          if (!row?.id || !row?.userid) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `INSERT INTO user_feedback(id, userid, name, category, content, contact, status, reply, handled_by, handled_name, handled_at, created_at, updated_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`,
              [row.id, row.userid, row.name ?? null, row.category ?? 'suggestion', row.content,
                row.contact ?? null, row.status ?? 'pending', row.reply ?? null,
                row.handled_by ?? null, row.handled_name ?? null, row.handled_at ?? null,
                row.created_at ?? Math.floor(Date.now() / 1000), row.updated_at ?? Math.floor(Date.now() / 1000)],
            );
            count++;
          } catch { /* skip */ }
        }
        if (mode === 'overwrite' && count > 0) {
          try { await db.exec(`SELECT setval(pg_get_serial_sequence('user_feedback', 'id'), (SELECT MAX(id) FROM user_feedback))`, []); } catch { /* skip */ }
        }
        report.user_feedback = count;
      }

      if (Array.isArray(backupData.user_feedback_messages)) {
        let count = 0;
        for (const row of backupData.user_feedback_messages) {
          if (!row?.id || !row?.feedback_id || !row?.content) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `INSERT INTO user_feedback_messages(id, feedback_id, sender_type, sender_id, sender_name, content, created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
              [row.id, row.feedback_id, row.sender_type ?? 'user', row.sender_id ?? null,
                row.sender_name ?? null, row.content, row.created_at ?? Math.floor(Date.now() / 1000)],
            );
            count++;
          } catch { /* skip */ }
        }
        if (mode === 'overwrite' && count > 0) {
          try { await db.exec(`SELECT setval(pg_get_serial_sequence('user_feedback_messages', 'id'), (SELECT MAX(id) FROM user_feedback_messages))`, []); } catch { /* skip */ }
        }
        report.user_feedback_messages = count;
      }

      if (Array.isArray(backupData.audit_logs)) {
        let count = 0;
        for (const row of backupData.audit_logs) {
          if (!row?.id || !row?.event_type) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `INSERT INTO audit_logs(id, event_type, actor_type, actor_id, actor_name, ip, method, path, status_code, message, payload, created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
              [
                row.id,
                row.event_type,
                row.actor_type ?? null,
                row.actor_id ?? null,
                row.actor_name ?? null,
                row.ip ?? null,
                row.method ?? null,
                row.path ?? null,
                row.status_code ?? null,
                row.message ?? null,
                row.payload ?? null,
                row.created_at ?? Math.floor(Date.now() / 1000),
              ],
            );
            count++;
          } catch { /* skip */ }
        }
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('audit_logs', 'id'), (SELECT MAX(id) FROM audit_logs))`, []); } catch { /* skip */ }
        report.audit_logs = count;
      }

      // red_packet_activity + red_packet_items：
      // 必须保留原始 id，因为 items.activity_id 引用 activity.id
      if (mode === 'overwrite') {
        try { await db.exec('DELETE FROM red_packet_items', []); } catch { /* skip */ }
        try { await db.exec('DELETE FROM red_packet_activity', []); } catch { /* skip */ }
      }
      if (Array.isArray(backupData.red_packet_activity)) {
        let count = 0;
        for (const row of backupData.red_packet_activity) {
          if (!row?.id) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `INSERT INTO red_packet_activity(id, total_amount, total_count, countdown_seconds, duration_minutes, start_at, end_at, status, sponsor, created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
              [row.id, row.total_amount, row.total_count, row.countdown_seconds, row.duration_minutes,
                row.start_at, row.end_at, row.status ?? 'ended', row.sponsor ?? null,
                row.created_at ?? Math.floor(Date.now() / 1000)],
            );
            count++;
          } catch { /* skip */ }
        }
        // 重置序列，防止后续新建活动时 id 冲突
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('red_packet_activity', 'id'), (SELECT MAX(id) FROM red_packet_activity))`, []); } catch { /* skip */ }
        report.red_packet_activity = count;
      }
      if (Array.isArray(backupData.red_packet_items)) {
        let count = 0;
        for (const row of backupData.red_packet_items) {
          if (!row?.activity_id) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            await db.exec(
              `INSERT INTO red_packet_items(id, activity_id, amount, claimed_by, claimed_at)
               VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
              [row.id, row.activity_id, row.amount, row.claimed_by ?? null, row.claimed_at ?? null],
            );
            count++;
          } catch { /* skip */ }
        }
        try { await db.exec(`SELECT setval(pg_get_serial_sequence('red_packet_items', 'id'), (SELECT MAX(id) FROM red_packet_items))`, []); } catch { /* skip */ }
        report.red_packet_items = count;
      }
    }

    await appendBackupHistory(db, req, {
      action: '导入',
      mode,
      filename: backup._meta?.filename || req.body?.filename || '',
      status: '完成',
      details: { backupMode: backup._meta?.mode || '', report },
    });
    publishMallRealtimeFullRefresh('backup_import');
    return res.json({ ok: true, mode, report });
  });

  return router;
}
