import crypto from 'node:crypto';

class QRSignError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QRSignError';
  }
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return `[${obj.map(stableStringify).join(',')}]`;
  }

  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

function sign(raw, secret) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(raw, 'utf8').digest('hex');
}

export function buildExchangeData({ exchange_id, userid, product_id, product_name, bob_amount }, secret) {
  if (!secret) {
    throw new QRSignError('QR_SIGN_SECRET missing');
  }

  const payload = {
    exchange_id: String(exchange_id),
    userid: String(userid),
    product_id: String(product_id),
    bob_amount: Number(bob_amount),
  };

  if (product_name !== null && product_name !== undefined && String(product_name)) {
    payload.product_name = String(product_name);
  }

  const raw = stableStringify(payload);
  const signature = sign(raw, secret);
  return { payload, signature };
}

export function encodeData(data) {
  const raw = stableStringify(data);
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeData(encoded) {
  try {
    const raw = Buffer.from(String(encoded), 'base64url').toString('utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new QRSignError('invalid payload');
  }
}

export function verifyEncoded(encoded, secret) {
  if (!secret) {
    throw new QRSignError('QR_SIGN_SECRET missing');
  }

  const data = decodeData(encoded);
  const payload = data?.payload;
  const signature = data?.signature;

  if (!payload || !signature) {
    throw new QRSignError('missing fields');
  }

  const raw = stableStringify(payload);
  if (sign(raw, secret) !== signature) {
    throw new QRSignError('signature mismatch');
  }

  return payload;
}

export { QRSignError };
