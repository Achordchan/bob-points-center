import { parseCookies, verifySessionToken } from './adminSession.js';
import { adminSessionSigningSecret, isSessionVersionValidLive } from '../utils/sessionCrypto.js';
export const ADMIN_PERMISSION_CATALOG = [
  { group: '首页概览', permissions: [{ key: 'dashboard:view', label: '查看首页' }] },
  { group: '用户与账户', permissions: [
    { key: 'users:view', label: '查看用户' },
    { key: 'users:edit', label: '编辑用户' },
    { key: 'users:grant', label: '发币' },
    { key: 'users:deduct', label: '减币' },
    { key: 'users:delete', label: '删除用户', superOnly: true },
  ] },
  { group: '订单与核销', permissions: [
    { key: 'orders:view', label: '查看订单' },
    { key: 'orders:redeem', label: '核销订单' },
    { key: 'orders:clear', label: '清空核销历史', superOnly: true },
  ] },
  { group: '商城与 CDK', permissions: [
    { key: 'commerce:view', label: '查看商城' },
    { key: 'commerce:edit', label: '编辑商品' },
    { key: 'commerce:cdk', label: '管理 CDK' },
    { key: 'commerce:delete', label: '删除商品', superOnly: true },
  ] },
  { group: '活动与公益', permissions: [
    { key: 'activities:view', label: '查看活动' },
    { key: 'activities:edit', label: '编辑活动' },
  ] },
  { group: '消息中心', permissions: [
    { key: 'messages:view', label: '查看消息配置' },
    { key: 'messages:edit', label: '编辑消息配置' },
    { key: 'messages:test', label: '内部测试发送' },
  ] },
  { group: '内容运营', permissions: [
    { key: 'content:view', label: '查看内容' },
    { key: 'content:edit', label: '编辑内容' },
    { key: 'content:delete', label: '删除内容' },
  ] },
  { group: '系统集成', permissions: [
    { key: 'integrations:view', label: '查看集成' },
    { key: 'integrations:edit', label: '编辑集成' },
    { key: 'integrations:export', label: '导出备份' },
    { key: 'integrations:import', label: '导入备份', superOnly: true },
  ] },
  { group: '审计安全', permissions: [{ key: 'audit:view', label: '查看审计' }] },
];

export const ADMIN_PERMISSION_KEYS = ADMIN_PERMISSION_CATALOG.flatMap((group) => group.permissions.map((item) => item.key));
export const SUPER_ONLY_PERMISSION_KEYS = new Set(
  ADMIN_PERMISSION_CATALOG.flatMap((group) => group.permissions.filter((item) => item.superOnly).map((item) => item.key)),
);

const ROLE_DEFAULTS = [
  {
    code: 'admin',
    name: '管理员',
    permissions: ADMIN_PERMISSION_KEYS.filter((key) => !SUPER_ONLY_PERMISSION_KEYS.has(key) && !key.startsWith('audit:')),
  },
  {
    code: 'operator',
    name: '运营管理员',
    permissions: [
      'dashboard:view', 'users:view', 'users:grant', 'orders:view', 'commerce:view', 'commerce:edit', 'commerce:cdk',
      'activities:view', 'activities:edit', 'messages:view', 'messages:edit', 'messages:test', 'content:view', 'content:edit',
    ],
  },
  { code: 'readonly_audit', name: '只读审计', permissions: ['dashboard:view', 'users:view', 'orders:view', 'commerce:view', 'activities:view', 'content:view', 'audit:view'] },
];

function safeJsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizePermissions(input, { allowSuperOnly = false } = {}) {
  const allow = new Set(ADMIN_PERMISSION_KEYS);
  const list = Array.isArray(input) ? input : [];
  return [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))]
    .filter((key) => allow.has(key))
    .filter((key) => allowSuperOnly || !SUPER_ONLY_PERMISSION_KEYS.has(key));
}

export function isSuperAdminSession(cfg, payload = {}) {
  const uid = String(payload?.userid || '').trim();
  const allow = Array.isArray(cfg?.adminUserids) ? cfg.adminUserids.map(String) : [];
  return Boolean(uid && allow.includes(uid));
}

// 调用方须处于事务中；先锁保护状态，再锁业务行，避免清理使用过期的管理员名单。
export async function lockAdminAccountProtection(tx) {
  await tx.exec('SELECT pg_advisory_xact_lock(71010, 1)', []);
}

export async function ensureAdminRoles(db) {
  if (!db) return;
  for (const role of ROLE_DEFAULTS) {
    await db.run(
      `INSERT INTO admin_roles(code, name, permissions, is_builtin, is_enabled, created_at, updated_at)
       SELECT ?, ?, ?, 1, 1, unixepoch(), unixepoch()
       WHERE NOT EXISTS (SELECT 1 FROM admin_roles WHERE code = ?)`,
      [role.code, role.name, JSON.stringify(role.permissions), role.code],
    );
  }
  await db.exec(
    `INSERT INTO admin_user_roles(userid, role_id, assigned_at)
     SELECT u.userid, r.id, unixepoch()
     FROM users u CROSS JOIN admin_roles r
     WHERE u.is_admin = 1 AND r.code = 'admin'
       AND NOT EXISTS (SELECT 1 FROM admin_user_roles ur WHERE ur.userid = u.userid)`,
  );
}

export async function getAdminAccess(db, cfg, payload = {}) {
  const userid = String(payload?.userid || '').trim();
  if (isSuperAdminSession(cfg, payload)) {
    return {
      ok: true,
      isSuperAdmin: true,
      role: { id: null, code: 'super_admin', name: '超级管理员' },
      permissions: ADMIN_PERMISSION_KEYS,
    };
  }
  if (!userid || !db) return { ok: false, isSuperAdmin: false, role: null, permissions: [] };
  await ensureAdminRoles(db);
  const row = await db.get(
    `SELECT r.id, r.code, r.name, r.permissions, r.is_enabled
     FROM admin_user_roles ur
     JOIN admin_roles r ON r.id = ur.role_id
     WHERE ur.userid = ?
     LIMIT 1`,
    [userid],
  );
  if (!row || Number(row.is_enabled) !== 1) return { ok: false, isSuperAdmin: false, role: null, permissions: [] };
  const permissions = normalizePermissions(safeJsonParse(row.permissions, []));
  return { ok: true, isSuperAdmin: false, role: { id: row.id, code: row.code, name: row.name }, permissions };
}

export function hasAdminPermission(access, permission) {
  if (access?.isSuperAdmin) return true;
  return Array.isArray(access?.permissions) && access.permissions.includes(permission);
}

export function matchPathPermission(method, path) {
  // Express 路由默认大小写不敏感（/users/DELETE 同样会命中 /users/delete 处理器），
  // 而下面的规则是字面前缀匹配：不统一转小写，换个大小写就会漏过规则落到 /users 的 users:view 兜底。
  const p = String(path || '').toLowerCase();
  const m = String(method || 'GET').toUpperCase();
  if (p.startsWith('/legacy')) return 'super';
  if (p.startsWith('/dashboard') || p.startsWith('/system/info')) return 'dashboard:view';
  if (p.startsWith('/users/assign-role') || p.startsWith('/roles') || p.startsWith('/permissions')) return 'super';
  if (p.startsWith('/users/set-admin')) return 'super';
  // 精确匹配两个外部账号运维接口（容忍尾斜杠，Express 默认也会匹配）；不能用前缀，
  // 否则 userid 以 external 开头的用户详情 GET /users/external_xxx 会被误判成 users:edit。
  if (/^\/users\/external\/(reset-password|set-status)\/*$/.test(p)) return 'users:edit';
  if (p.startsWith('/users/sync')) return 'users:edit';
  if (p.startsWith('/users/notify')) return 'messages:edit';
  if (p.startsWith('/users/delete') || p.startsWith('/data/reset-user') || p.startsWith('/data/reset-all')) return 'super';
  if (p.startsWith('/users') || p.startsWith('/ledger/grant-batch')) return p.startsWith('/ledger/grant-batch') ? 'users:grant' : 'users:view';
  if (p.startsWith('/redeem/deduct-batch')) return 'users:deduct';
  if (p.startsWith('/redeem/confirm')) return 'orders:redeem';
  if (p.startsWith('/redeem/history/clear')) return 'super';
  if (p.startsWith('/redeem') || p.startsWith('/orders')) return 'orders:view';
  if (p.startsWith('/mall/self/products/delete')) return 'super';
  if (p.startsWith('/mall/self/products') || p.startsWith('/mall/opening')) return m === 'GET' ? 'commerce:view' : 'commerce:edit';
  if (p.startsWith('/cdks')) return m === 'GET' ? 'commerce:view' : 'commerce:cdk';
  if (p.startsWith('/red-packet/history/clear') || p.startsWith('/red-packet/history/delete')) return 'super';
  if (p.startsWith('/settings/dingtalk/status')) return 'dashboard:view';
  if (p.startsWith('/settings/dingtalk/departments')) return ['integrations:view', 'activities:view'];
  if (p.startsWith('/red-packet') || p.startsWith('/charity') || p.startsWith('/auction') || p.startsWith('/settings/attendance-reward')) return m === 'GET' ? 'activities:view' : 'activities:edit';
  if (p.startsWith('/settings/notify/test') || p.startsWith('/settings/group-card/test')) return 'messages:test';
  if (p.startsWith('/notify') || p.startsWith('/settings/notify') || p.startsWith('/settings/group-card')) return m === 'GET' ? 'messages:view' : 'messages:edit';
  if (p.startsWith('/content')) {
    if (m === 'GET') return 'content:view';
    if (p.endsWith('/delete')) return 'content:delete';
    return 'content:edit';
  }
  if (p.startsWith('/image-optimization/upload')) return ['integrations:edit', 'commerce:edit', 'activities:edit', 'content:edit'];
  if (p.startsWith('/resources')) return m === 'GET' ? 'integrations:view' : 'integrations:edit';
  // 外部活动账号：清理会连带删除业务数据，仅超级管理员可执行。
  if (p.startsWith('/settings/external-login/purge')) return 'super';
  if (p.startsWith('/settings/external-login')) return m === 'GET' ? 'integrations:view' : 'integrations:edit';
  if (p.startsWith('/site-visibility') || p.startsWith('/settings/image-optimization') || p.startsWith('/settings/dingtalk') || p.startsWith('/image-optimization') || p.startsWith('/bob-token')) return m === 'GET' ? 'integrations:view' : 'integrations:edit';
  if (p.startsWith('/backup/export')) return 'integrations:export';
  if (p.startsWith('/backup/history') && p.includes('/download')) return 'integrations:export'; // full 另在 handler 校验 super
  if (p.startsWith('/backup/import')) return 'super';
  if (p.startsWith('/backup/history')) return 'integrations:view';
  if (p.startsWith('/logs')) return 'audit:view';
  if (p.startsWith('/my/operations')) return 'dashboard:view';
  return m === 'GET' ? 'dashboard:view' : 'super';
}

function isPublicAdminPath(method, path) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(path || '');
  return (m === 'GET' && ['/', '/login', '/auth', '/config', '/me', '/home', '/oauth/start', '/oauth/callback'].includes(p)) || (m === 'POST' && p === '/logout');
}

export function adminAccessMiddleware() {
  return async function adminAccess(req, res, next) {
    try {
      if (isPublicAdminPath(req.method, req.path)) return next();
      const cfg = req.app?.locals?.cfg;
      let payload = req.adminSession || null;
      const db = req.app?.locals?.db;
      if (!payload) {
        const cookies = parseCookies(req.header('cookie'));
        const token = cookies.bob_admin_session;
        const secret = adminSessionSigningSecret(cfg);
        payload = verifySessionToken(secret, token);
        if (payload && !(await isSessionVersionValidLive(payload, db, cfg))) payload = null;
        if (payload) req.adminSession = payload;
      } else if (!(await isSessionVersionValidLive(payload, db, cfg))) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      if (!payload) return next();
      const access = await getAdminAccess(db, cfg, payload);
      req.adminAccess = access;
      const permission = matchPathPermission(req.method, req.path);
      if (permission === 'super' && !access.isSuperAdmin) return res.status(403).json({ error: '权限不足，无法执行该操作' });
      if (Array.isArray(permission) && !permission.some((key) => hasAdminPermission(access, key))) return res.status(403).json({ error: '权限不足，无法执行该操作' });
      if (permission && !Array.isArray(permission) && permission !== 'super' && !hasAdminPermission(access, permission)) return res.status(403).json({ error: '权限不足，无法执行该操作' });
      return next();
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  };
}

export function serializeRole(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code || '',
    name: row.name || '',
    permissions: normalizePermissions(safeJsonParse(row.permissions, [])),
    is_builtin: Number(row.is_builtin) === 1 ? 1 : 0,
    is_enabled: Number(row.is_enabled) === 1 ? 1 : 0,
    user_count: Number(row.user_count || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export { normalizePermissions };
