/**
 * 稳定会话密钥拼装：不再使用启动时随机 sessionSalt。
 * 可选 SESSION_SALT/env 仅用于轮换；默认空字符串。
 */

const SESSION_VERSION_KEY = 'session_global_version';
let lastSessionVersionRefreshAt = 0;
let sessionVersionRefreshPromise = null;

export function adminSessionSigningSecret(cfg) {
  const base = cfg?.adminSessionSecret || '';
  const salt = cfg?.sessionSalt || '';
  return salt ? `${base}:${salt}` : String(base);
}

export function webSessionSigningSecret(cfg) {
  // 禁止在签名层回退到 admin 密钥；配置层已负责本地兼容与生产强校验。
  const base = cfg?.webSessionSecret || '';
  const salt = cfg?.sessionSalt || '';
  return salt ? `${base}:${salt}` : String(base);
}

export function adminOAuthSigningSecret(cfg) {
  return `${adminSessionSigningSecret(cfg)}:dingtalk-oauth`;
}

export function webOAuthSigningSecret(cfg) {
  return `${webSessionSigningSecret(cfg)}:dingtalk-oauth`;
}

export function cookieOptions(cfg) {
  return { secure: Boolean(cfg?.cookieSecure) };
}

export function withSessionVersion(payload, cfg) {
  const sv = Number(cfg?.sessionGlobalVersion);
  return {
    ...(payload || {}),
    sv: Number.isFinite(sv) && sv >= 0 ? Math.floor(sv) : 0,
  };
}

function normalizeVersion(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * 从 DB 刷新进程内 sessionGlobalVersion（节流 2s）。
 * 多实例各自刷新，修改 system_settings 后最多约 2s 生效。
 */
export async function refreshSessionGlobalVersion(db, cfg, { force = false } = {}) {
  if (!db || !cfg) return normalizeVersion(cfg?.sessionGlobalVersion);
  const now = Date.now();
  if (!force && now - lastSessionVersionRefreshAt < 2000) {
    return normalizeVersion(cfg.sessionGlobalVersion);
  }
  if (sessionVersionRefreshPromise) return sessionVersionRefreshPromise;
  sessionVersionRefreshPromise = (async () => {
    try {
      const row = await db.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', [SESSION_VERSION_KEY]);
      cfg.sessionGlobalVersion = normalizeVersion(row?.value);
      lastSessionVersionRefreshAt = Date.now();
      return cfg.sessionGlobalVersion;
    } catch {
      return normalizeVersion(cfg.sessionGlobalVersion);
    } finally {
      sessionVersionRefreshPromise = null;
    }
  })();
  return sessionVersionRefreshPromise;
}

export function isSessionVersionValid(payload, cfg) {
  const expected = normalizeVersion(cfg?.sessionGlobalVersion);
  const got = Number(payload?.sv);
  const g = Number.isFinite(got) && got >= 0 ? Math.floor(got) : 0;
  // 旧 Cookie 无 sv 字段：视为 0，仅当全局版本仍为 0 时兼容
  if (payload?.sv === undefined || payload?.sv === null) {
    return expected === 0;
  }
  return g === expected;
}

export async function isSessionVersionValidLive(payload, db, cfg) {
  await refreshSessionGlobalVersion(db, cfg);
  return isSessionVersionValid(payload, cfg);
}
