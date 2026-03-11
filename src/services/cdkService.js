import crypto from 'node:crypto';

const CDK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CDK_PREFIX = 'BOB-LIFT_';
const CDK_BODY_LENGTH = 10;
const CDK_FORMAT = /^BOB-LIFT_[A-HJ-NP-Z2-9]{10}$/;

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function isUniqueViolation(err) {
  return String(err?.code || '') === '23505';
}

export function normalizeCdkCode(value) {
  return String(value || '').trim().replaceAll(' ', '').toUpperCase();
}

export function isValidCdkCode(value) {
  return CDK_FORMAT.test(String(value || ''));
}

export function generateCdkCode() {
  let out = '';
  for (let i = 0; i < CDK_BODY_LENGTH; i += 1) {
    out += CDK_ALPHABET[crypto.randomInt(0, CDK_ALPHABET.length)];
  }
  return `${CDK_PREFIX}${out}`;
}

function genBatchId() {
  return `CDK_BATCH_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function genCdkExchangeId() {
  return `CDK_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

async function findCdkRowForUse(db, cdkCode) {
  return await db.get(
    `SELECT id, batch_id, cdk_code, product_id, product_name, product_bob_amount, status,
            created_by, created_name, created_at, redeemed_by, redeemed_name, redeemed_at, redeem_exchange_id
       FROM redeem_cdks
      WHERE cdk_code = ?
      LIMIT 1
      FOR UPDATE`,
    [cdkCode],
  );
}

export async function listCdkEnabledProducts(db) {
  return await db.all(
    `SELECT product_id, product_name, bob_amount, image_url, remark, status, cdk_enabled, updated_at
       FROM mall_products
      WHERE COALESCE(cdk_enabled, 0) = 1
      ORDER BY (sort IS NULL), sort ASC, product_id COLLATE NOCASE`,
  );
}

export async function listRedeemCdks(db, { includeDeleted = false, limit = 200 } = {}) {
  const max = Math.min(500, Math.max(1, toInt(limit) || 200));
  const where = includeDeleted ? '' : "WHERE c.status <> 'deleted'";
  return await db.all(
    `SELECT c.id, c.batch_id, c.cdk_code, c.product_id, c.product_name, c.product_bob_amount,
            c.status, c.created_by, c.created_name, c.created_at,
            c.redeemed_by, c.redeemed_name, c.redeemed_at, c.redeem_exchange_id,
            r.fulfilled_at,
            p.image_url, p.remark
       FROM redeem_cdks c
       LEFT JOIN redeems r ON r.exchange_id = c.redeem_exchange_id
       LEFT JOIN mall_products p ON p.product_id = c.product_id
       ${where}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ?`,
    [max],
  );
}

export async function generateRedeemCdks(db, { productId, quantity, createdBy, createdName } = {}) {
  const pid = String(productId || '').trim();
  const qty = toInt(quantity);
  if (!pid) throw new Error('missing product_id');
  if (qty === null || qty <= 0 || qty > 500) throw new Error('quantity must be between 1 and 500');

  const runner = typeof db.transaction === 'function'
    ? (fn) => db.transaction(fn)
    : async (fn) => await fn(db);

  return await runner(async (tx) => {
    const product = await tx.get(
      `SELECT product_id, product_name, bob_amount
         FROM mall_products
        WHERE product_id = ? AND COALESCE(cdk_enabled, 0) = 1
        LIMIT 1`,
      [pid],
    );
    if (!product) throw new Error('cdk product not found');

    const batchId = genBatchId();
    const codes = [];
    for (let i = 0; i < qty; i += 1) {
      let inserted = false;
      for (let attempt = 0; attempt < 20 && !inserted; attempt += 1) {
        const code = generateCdkCode();
        try {
          // eslint-disable-next-line no-await-in-loop
          await tx.run(
            `INSERT INTO redeem_cdks(
               batch_id, cdk_code, product_id, product_name, product_bob_amount,
               status, created_by, created_name, created_at
             ) VALUES(?, ?, ?, ?, ?, 'unused', ?, ?, unixepoch())`,
            [
              batchId,
              code,
              String(product.product_id),
              String(product.product_name || product.product_id || ''),
              Number(product.bob_amount || 0),
              createdBy ? String(createdBy) : null,
              createdName ? String(createdName) : null,
            ],
          );
          codes.push(code);
          inserted = true;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
      if (!inserted) {
        throw new Error('failed to generate unique cdk');
      }
    }

    return {
      ok: true,
      batch_id: batchId,
      product_id: String(product.product_id),
      product_name: String(product.product_name || product.product_id || ''),
      quantity: codes.length,
      codes,
    };
  });
}

export async function deleteRedeemCdks(db, { ids } = {}) {
  const list = Array.isArray(ids) ? ids : [ids];
  const cleanIds = Array.from(new Set(list.map((x) => toInt(x)).filter((x) => Number.isFinite(x) && x > 0)));
  if (cleanIds.length === 0) throw new Error('invalid ids');

  const runner = typeof db.transaction === 'function'
    ? (fn) => db.transaction(fn)
    : async (fn) => await fn(db);

  return await runner(async (tx) => {
    const placeholders = cleanIds.map(() => '?').join(',');
    const rows = await tx.all(
      `SELECT id, cdk_code, status FROM redeem_cdks WHERE id IN (${placeholders}) FOR UPDATE`,
      cleanIds,
    );
    if (rows.length !== cleanIds.length) throw new Error('cdk not found');
    if (rows.some((row) => String(row?.status || '') === 'redeemed')) {
      throw new Error('redeemed cdk cannot be deleted');
    }
    const result = await tx.run(
      `UPDATE redeem_cdks SET status = 'deleted' WHERE id IN (${placeholders}) AND status = 'unused'`,
      cleanIds,
    );
    return { ok: true, changes: Number(result?.changes || 0) };
  });
}

export async function previewRedeemCdk(db, { cdk } = {}) {
  const code = normalizeCdkCode(cdk);
  if (!code) throw new Error('missing cdk');
  if (!isValidCdkCode(code)) throw new Error('invalid cdk format');

  const row = await db.get(
    `SELECT cdk_code, product_id, product_name, product_bob_amount, status
       FROM redeem_cdks
      WHERE cdk_code = ?
      LIMIT 1`,
    [code],
  );
  if (!row) throw new Error('cdk not found');
  const status = String(row?.status || '');
  if (status === 'deleted') throw new Error('cdk deleted');
  if (status === 'redeemed') throw new Error('cdk already redeemed');

  const product = await db.get(
    `SELECT product_id, product_name, image_url, remark, bob_amount, cdk_enabled
       FROM mall_products
      WHERE product_id = ?
      LIMIT 1`,
    [String(row.product_id || '')],
  );
  if (!product || Number(product?.cdk_enabled || 0) !== 1) {
    throw new Error('cdk product unavailable');
  }

  return {
    ok: true,
    cdk: code,
    product_id: String(row.product_id || product.product_id || ''),
    product_name: String(row.product_name || product.product_name || product.product_id || ''),
    image_url: product?.image_url ? String(product.image_url) : '',
    remark: product?.remark ? String(product.remark) : '',
    product_bob_amount: Number(row.product_bob_amount ?? product?.bob_amount ?? 0),
  };
}

export async function redeemCdk(db, { userid, name, cdk } = {}) {
  const uid = String(userid || '').trim();
  const displayName = String(name || '').trim();
  const code = normalizeCdkCode(cdk);
  if (!uid) throw new Error('missing userid');
  if (!code) throw new Error('missing cdk');
  if (!isValidCdkCode(code)) throw new Error('invalid cdk format');

  const runner = typeof db.transaction === 'function'
    ? (fn) => db.transaction(fn)
    : async (fn) => await fn(db);

  return await runner(async (tx) => {
    const row = await findCdkRowForUse(tx, code);
    if (!row) throw new Error('cdk not found');
    const status = String(row?.status || '');
    if (status === 'deleted') throw new Error('cdk deleted');
    if (status === 'redeemed') throw new Error('cdk already redeemed');

    const product = await tx.get(
      `SELECT product_id, product_name, image_url, remark, cdk_enabled
         FROM mall_products
        WHERE product_id = ?
        LIMIT 1`,
      [String(row.product_id || '')],
    );
    if (!product || Number(product?.cdk_enabled || 0) !== 1) {
      throw new Error('cdk product unavailable');
    }

    const exchangeId = genCdkExchangeId();
    await tx.run(
      `INSERT INTO redeems(exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at, hidden, created_at)
       VALUES(?, ?, ?, ?, 0, NULL, 0, unixepoch())`,
      [
        exchangeId,
        uid,
        String(row.product_id || product.product_id || ''),
        String(row.product_name || product.product_name || product.product_id || ''),
      ],
    );

    const update = await tx.run(
      `UPDATE redeem_cdks
          SET status = 'redeemed', redeemed_by = ?, redeemed_name = ?, redeemed_at = unixepoch(), redeem_exchange_id = ?
        WHERE id = ? AND status = 'unused'`,
      [uid, displayName || null, exchangeId, row.id],
    );
    if (Number(update?.changes || 0) !== 1) throw new Error('cdk already redeemed');

    return {
      ok: true,
      exchange_id: exchangeId,
      cdk: code,
      redeem_source: 'cdk',
      cdk_info_available: true,
      product_id: String(row.product_id || product.product_id || ''),
      product_name: String(row.product_name || product.product_name || product.product_id || ''),
      product_bob_amount: Number(row.product_bob_amount ?? 0),
      image_url: product?.image_url ? String(product.image_url) : '',
      remark: product?.remark ? String(product.remark) : '',
      bob_amount: 0,
      created_at: Math.floor(Date.now() / 1000),
      fulfilled_at: null,
    };
  });
}

export async function getRedeemCdkInfo(db, { userid, exchangeId } = {}) {
  const uid = String(userid || '').trim();
  const xid = String(exchangeId || '').trim();
  if (!uid) throw new Error('missing userid');
  if (!xid) throw new Error('missing exchange_id');

  const row = await db.get(
    `SELECT c.cdk_code, c.product_id, c.product_name, c.product_bob_amount,
            c.created_at, c.redeemed_at, c.redeem_exchange_id,
            r.userid, r.fulfilled_at
       FROM redeem_cdks c
       JOIN redeems r ON r.exchange_id = c.redeem_exchange_id
      WHERE c.redeem_exchange_id = ? AND r.userid = ?
      LIMIT 1`,
    [xid, uid],
  );
  if (!row) throw new Error('cdk info not found');

  return {
    ok: true,
    cdk: String(row.cdk_code || ''),
    product_id: String(row.product_id || ''),
    product_name: String(row.product_name || row.product_id || ''),
    product_bob_amount: Number(row.product_bob_amount ?? 0),
    exchange_id: String(row.redeem_exchange_id || xid),
    redeemed_at: Number(row.redeemed_at ?? row.created_at ?? 0),
    source_type: 'CDK兑换',
    order_status: row?.fulfilled_at === null || row?.fulfilled_at === undefined ? 'pending' : 'fulfilled',
  };
}
