import crypto from 'node:crypto';

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(str) {
  return Buffer.from(String(str), 'base64url');
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  const parts = String(header).split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function sign(secret, data) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(data).digest();
}

export function createSessionToken(secret, payload, ttlSeconds) {
  if (!secret) {
    throw new Error('ADMIN_SESSION_SECRET missing');
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.max(60, Number(ttlSeconds || 0) || 3600);
  const body = { ...payload, iat: now, exp };
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const sig = sign(secret, raw);
  return `${b64urlEncode(raw)}.${b64urlEncode(sig)}`;
}

export function verifySessionToken(secret, token) {
  if (!secret) {
    throw new Error('ADMIN_SESSION_SECRET missing');
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
  return payload;
}

function cookieSecureFlag(options) {
  if (options && typeof options.secure === 'boolean') return options.secure;
  return false;
}

export function buildSessionCookie(token, options = {}) {
  // 使用 Path=/ + 无 Domain；生产补 Secure。不用 __Host- 前缀，避免破坏既有 Cookie 名与兼容。
  const attrs = [
    `bob_admin_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (cookieSecureFlag(options)) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearSessionCookie(options = {}) {
  const attrs = [
    'bob_admin_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (cookieSecureFlag(options)) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearLegacyAdminPathCookie(options = {}) {
  const attrs = [
    'bob_admin_session=',
    'Path=/admin',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (cookieSecureFlag(options)) attrs.push('Secure');
  return attrs.join('; ');
}
