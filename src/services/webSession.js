import crypto from 'node:crypto';
import { isExternalUserid } from './externalAccountService.js';
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
  if (!isExternalUserid(payload.userid)) return true;
  if (!db) return false;
  // 旧 Cookie 没有来源字段，按外部 userid 命名空间识别；不缓存，清理/停用后立即拒绝。
  const account = await db.get(
    `SELECT a.userid FROM external_accounts a
       JOIN users u ON u.userid = a.userid
      WHERE a.userid = ? AND a.status = 'active' AND u.source = 'external'
      LIMIT 1`,
    [String(payload.userid)],
  );
  return Boolean(account);
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
