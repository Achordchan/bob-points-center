import crypto from 'node:crypto';
import { isSessionVersionValidLive } from '../utils/sessionCrypto.js';

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(str) {
  return Buffer.from(String(str), 'base64url');
}

function sign(secret, data) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(data).digest();
}

export function createWebSessionToken(secret, payload, ttlSeconds) {
  if (!secret) {
    throw new Error('WEB_SESSION_SECRET missing');
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.max(60, Number(ttlSeconds || 0) || 86400 * 7);
  // aud 固定为 web，即使密钥误配置相同也不能当 Admin Token。
  const body = { ...payload, aud: 'web', iat: now, exp };
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const sig = sign(secret, raw);
  return `${b64urlEncode(raw)}.${b64urlEncode(sig)}`;
}

export function verifyWebSessionToken(secret, token) {
  if (!secret) {
    throw new Error('WEB_SESSION_SECRET missing');
  }
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;

  let raw;
  let sig;
  try {
    raw = b64urlDecode(parts[0]);
    sig = b64urlDecode(parts[1]);
  } catch {
    return null;
  }

  const expected = sign(secret, raw);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(sig, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload?.exp || now >= payload.exp) return null;
  if (payload?.aud !== 'web') return null;
  return payload;
}

export async function isWebSessionValidLive(payload, db, cfg) {
  if (!payload?.userid || !(await isSessionVersionValidLive(payload, db, cfg))) return false;
  if (!db) return false;
  // 来源以持久化记录为准，已有钉钉 userid 也可能以 ext_ 开头；旧 Cookie 无需补字段。
  // 不缓存账号状态：用户被清理后不能凭旧 Cookie 进入 ensureAccount 重建记录。
  const user = await db.get(
    `SELECT u.source, a.status AS external_status FROM users u
       LEFT JOIN external_accounts a ON a.userid = u.userid
      WHERE u.userid = ? LIMIT 1`,
    [String(payload.userid)],
  );
  return Boolean(user && (user.source === 'dingtalk'
    || (user.source === 'external' && user.external_status === 'active')));
}

function cookieSecureFlag(options) {
  if (options && typeof options.secure === 'boolean') return options.secure;
  return false;
}

export function buildWebSessionCookie(token, maxAgeSeconds, options = {}) {
  const attrs = [
    `bob_web_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  const maxAge = Number(maxAgeSeconds);
  if (Number.isFinite(maxAge) && maxAge > 0) {
    attrs.push(`Max-Age=${Math.floor(maxAge)}`);
  }
  if (cookieSecureFlag(options)) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearWebSessionCookie(options = {}) {
  const attrs = [
    'bob_web_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (cookieSecureFlag(options)) attrs.push('Secure');
  return attrs.join('; ');
}
