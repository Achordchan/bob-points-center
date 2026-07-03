import { ensureAccount } from './ledgerService.js';

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return null;
  }
  return n;
}

function isUniqueViolation(err) {
  const code = String(err?.code || '');
  return code === '23505';
}

function normalizeLimitRound(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return 1;
  }
  return n;
}

async function deductBalanceInTx(db, { userid, amount }) {
  const updated = await db.get(
    `UPDATE accounts
        SET balance = balance - ?, updated_at = unixepoch()
      WHERE userid = ?
        AND balance >= ?
      RETURNING balance`,
    [amount, String(userid), amount],
  );
  if (!updated) {
    throw new Error('insufficient balance');
  }
  return Number(updated.balance ?? 0);
}

export async function createRedeemOrderInTx(db, { exchangeId, userid, productId, productName, bobAmount, reason, limitRound }) {
  const amount = toInt(bobAmount);
  const round = normalizeLimitRound(limitRound);
  if (!exchangeId) {
    throw new Error('missing exchange_id');
  }
  if (!userid) {
    throw new Error('missing userid');
  }
  if (!productId) {
    throw new Error('missing product_id');
  }
  if (amount === null || amount <= 0) {
    throw new Error('bob_amount must be positive integer');
  }

  const cleanReason = reason ? String(reason) : 'redeem';
  const cleanProductName = productName === null || productName === undefined ? null : String(productName);

  await ensureAccount(db, { userid });

  try {
    await db.run(
      'INSERT INTO redeems(exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at, limit_round) VALUES(?, ?, ?, ?, ?, NULL, ?)',
      [String(exchangeId), String(userid), String(productId), cleanProductName, amount, round],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error('exchange already redeemed');
    }
    throw err;
  }

  await db.run(
    'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
    [String(userid), -amount, cleanReason, String(exchangeId)],
  );

  const balance = await deductBalanceInTx(db, { userid, amount });

  return {
    ok: true,
    userid: String(userid),
    balance,
    exchange_id: String(exchangeId),
  };
}

export async function confirmRedeem(db, { exchangeId, userid, productId, productName, bobAmount, reason, fulfilledBy, fulfilledName }) {
  if (db?.__txScoped === true) {
    return await confirmRedeemInTx(db, { exchangeId, userid, productId, productName, bobAmount, reason, fulfilledBy, fulfilledName });
  }
  if (typeof db.transaction === 'function') {
    return await db.transaction(async (tx) => await confirmRedeemInTx(tx, { exchangeId, userid, productId, productName, bobAmount, reason, fulfilledBy, fulfilledName }));
  }
  return await confirmRedeemInTx(db, { exchangeId, userid, productId, productName, bobAmount, reason, fulfilledBy, fulfilledName });
}

export async function confirmRedeemInTx(db, { exchangeId, userid, productId, productName, bobAmount, reason, fulfilledBy, fulfilledName }) {
  const amount = toInt(bobAmount);
  if (!exchangeId) {
    throw new Error('missing exchange_id');
  }
  if (!userid) {
    throw new Error('missing userid');
  }
  if (!productId) {
    throw new Error('missing product_id');
  }

  const cleanReason = reason ? String(reason) : 'redeem';
  const cleanProductName = productName === null || productName === undefined ? null : String(productName);
  const cleanFulfilledBy = fulfilledBy === null || fulfilledBy === undefined ? '' : String(fulfilledBy).trim();
  const cleanFulfilledName = fulfilledName === null || fulfilledName === undefined ? '' : String(fulfilledName).trim();

  await ensureAccount(db, { userid });

  const existing = await db.get(
    'SELECT exchange_id, userid, product_id, bob_amount, fulfilled_at FROM redeems WHERE exchange_id = ? LIMIT 1',
    [String(exchangeId)],
  );
  if (existing) {
    const fulfilledAt = existing.fulfilled_at;
    if (fulfilledAt !== null && fulfilledAt !== undefined) {
      throw new Error('exchange already redeemed');
    }

    const sameUser = String(existing.userid || '') === String(userid);
    const sameProduct = String(existing.product_id || '') === String(productId);
    const sameAmount = Number(existing.bob_amount) === Number(amount);
    if (!sameUser || !sameProduct || !sameAmount) {
      throw new Error('payload mismatch');
    }

    await db.run(
      'UPDATE redeems SET fulfilled_at = unixepoch(), fulfilled_by = ?, fulfilled_name = ? WHERE exchange_id = ? AND fulfilled_at IS NULL',
      [cleanFulfilledBy || null, cleanFulfilledName || null, String(exchangeId)],
    );
    const cancelledListing = await db.get(
      `UPDATE mall_order_listings
          SET status = 'cancelled', cancelled_at = unixepoch(), updated_at = unixepoch()
        WHERE exchange_id = ?
          AND status = 'active'
        RETURNING listing_id`,
      [String(exchangeId)],
    );
    const row = await db.get('SELECT balance FROM accounts WHERE userid = ?', [String(userid)]);
    return {
      ok: true,
      userid: String(userid),
      balance: Number(row?.balance ?? 0),
      exchange_id: String(exchangeId),
      market_listing_cancelled: Boolean(cancelledListing?.listing_id),
      market_listing_id: cancelledListing?.listing_id ? String(cancelledListing.listing_id) : '',
    };
  }

  if (amount === null || amount <= 0) {
    throw new Error('bob_amount must be positive integer');
  }

  try {
    await db.run(
      'INSERT INTO redeems(exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at, fulfilled_by, fulfilled_name) VALUES(?, ?, ?, ?, ?, unixepoch(), ?, ?)',
      [String(exchangeId), String(userid), String(productId), cleanProductName, amount, cleanFulfilledBy || null, cleanFulfilledName || null],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error('exchange already redeemed');
    }
    throw err;
  }

  await db.run(
    'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
    [String(userid), -amount, cleanReason, String(exchangeId)],
  );

  const balance = await deductBalanceInTx(db, { userid, amount });

  return {
    ok: true,
    userid: String(userid),
    balance,
    exchange_id: String(exchangeId),
  };
}

export async function listRedeemsByUserid(db, { userid, page = 1, pageSize = 20 }) {
  if (!userid) {
    throw new Error('missing userid');
  }

  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const offset = (p - 1) * ps;

  const rows = await db.all(
    'SELECT exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at, created_at FROM redeems WHERE userid = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [String(userid), ps, offset],
  );

  return {
    userid: String(userid),
    page: p,
    pageSize: ps,
    data: rows || [],
  };
}
