import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function cursorKey(secret) {
  const value = String(secret || '');
  if (!value) throw new Error('admin cursor secret missing');
  return createHash('sha256').update(value).digest();
}

export function encodeAdminRedeemCursor({ at, exchangeId }, secret) {
  const timestamp = Number(at);
  const id = String(exchangeId || '').trim();
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !id) return '';

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cursorKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ at: Math.floor(timestamp), exchangeId: id }), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1.${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

export function decodeAdminRedeemCursor(value, secret) {
  const token = String(value || '').trim();
  if (!token.startsWith('v1.')) return null;
  try {
    const packed = Buffer.from(token.slice(3), 'base64url');
    if (packed.length <= 28) return null;
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(secret), iv);
    decipher.setAuthTag(tag);
    const data = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    const at = Number(data?.at);
    const exchangeId = String(data?.exchangeId || '').trim();
    if (!Number.isFinite(at) || at <= 0 || !exchangeId) return null;
    return { at: Math.floor(at), exchangeId };
  } catch {
    return null;
  }
}

export function publicAdminOrderReference(exchangeId) {
  const value = String(exchangeId || '').trim();
  if (!value) return '';
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16).toUpperCase();
  return `ORDER_${digest}`;
}

export function serializeAdminRedeemRow(row, { isSuperAdmin = false } = {}) {
  if (!row || typeof row !== 'object') return row;

  const result = { ...row };
  if (isSuperAdmin) return result;

  if (result.redeem_source === 'cdk') {
    if (result.cdk_product_bob_amount !== null && result.cdk_product_bob_amount !== undefined) {
      result.bob_amount = result.cdk_product_bob_amount;
    }
    result.created_at = null;
    result.exchange_id = publicAdminOrderReference(result.exchange_id);
  }

  delete result.redeem_source;
  delete result.cdk_product_bob_amount;
  delete result.cdk_code;
  delete result.batch_id;
  return result;
}
