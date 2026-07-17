import crypto from 'node:crypto';

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function decode(value) {
  return Buffer.from(String(value), 'base64url');
}

function sign(secret, raw) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(raw).digest();
}

export function createDingtalkOAuthState(secret, { purpose, returnTo }, ttlSeconds = 600) {
  if (!secret) throw new Error('OAuth state secret missing');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    purpose: String(purpose || ''),
    returnTo: String(returnTo || ''),
    nonce: crypto.randomBytes(24).toString('base64url'),
    iat: now,
    exp: now + Math.max(60, Number(ttlSeconds) || 600),
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    state: `${encode(raw)}.${encode(sign(secret, raw))}`,
    nonce: payload.nonce,
  };
}

export function verifyDingtalkOAuthState(secret, state, expected = {}) {
  if (!secret || !state) return null;
  const parts = String(state).split('.');
  if (parts.length !== 2) return null;

  let raw;
  let signature;
  try {
    raw = decode(parts[0]);
    signature = decode(parts[1]);
  } catch {
    return null;
  }

  const expectedSignature = sign(secret, raw);
  if (signature.length !== expectedSignature.length || !crypto.timingSafeEqual(signature, expectedSignature)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload?.exp || now >= Number(payload.exp)) return null;
  if (expected.purpose && payload.purpose !== expected.purpose) return null;
  if (expected.nonce && payload.nonce !== expected.nonce) return null;
  return payload;
}

function cookieSecureFlag(options = {}) {
  if (options && typeof options.secure === 'boolean') return options.secure;
  return false;
}

export function buildDingtalkOAuthStateCookie(name, nonce, maxAgeSeconds = 600, options = {}) {
  const attrs = [
    `${name}=${encodeURIComponent(String(nonce || ''))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(60, Number(maxAgeSeconds) || 600)}`,
  ];
  if (cookieSecureFlag(options)) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearDingtalkOAuthStateCookie(name, options = {}) {
  const attrs = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (cookieSecureFlag(options)) attrs.push('Secure');
  return attrs.join('; ');
}
