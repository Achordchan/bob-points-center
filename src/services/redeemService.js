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

export async function createRedeemOrderInTx(db, { exchangeId, userid, productId, productName, bobAmount, reason }) {
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
  if (amount === null || amount <= 0) {
    throw new Error('bob_amount must be positive integer');
  }

  const cleanReason = reason ? String(reason) : 'redeem';
  const cleanProductName = productName === null || productName === undefined ? null : String(productName);

  await ensureAccount(db, { userid });

  const account = await db.get('SELECT balance FROM accounts WHERE userid = ?', [String(userid)]);
  const balance = Number(account?.balance ?? 0);
  if (balance < amount) {
    throw new Error('insufficient balance');
  }

  try {
    await db.run(
      'INSERT INTO redeems(exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at) VALUES(?, ?, ?, ?, ?, NULL)',
      [String(exchangeId), String(userid), String(productId), cleanProductName, amount],
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

  await db.run(
    'UPDATE accounts SET balance = balance - ?, updated_at = unixepoch() WHERE userid = ?',
    [amount, String(userid)],
  );

  const row = await db.get('SELECT balance FROM accounts WHERE userid = ?', [String(userid)]);

  return {
    ok: true,
    userid: String(userid),
    balance: Number(row?.balance ?? 0),
    exchange_id: String(exchangeId),
  };
}

export async function confirmRedeem(db, { exchangeId, userid, productId, productName, bobAmount, reason }) {
  if (db?.__txScoped === true) {
    return await confirmRedeemInTx(db, { exchangeId, userid, productId, productName, bobAmount, reason });
  }
  if (typeof db.transaction === 'function') {
    return await db.transaction(async (tx) => await confirmRedeemInTx(tx, { exchangeId, userid, productId, productName, bobAmount, reason }));
  }
  return await confirmRedeemInTx(db, { exchangeId, userid, productId, productName, bobAmount, reason });
}

export async function confirmRedeemInTx(db, { exchangeId, userid, productId, productName, bobAmount, reason }) {
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
      'UPDATE redeems SET fulfilled_at = unixepoch() WHERE exchange_id = ? AND fulfilled_at IS NULL',
      [String(exchangeId)],
    );
    const row = await db.get('SELECT balance FROM accounts WHERE userid = ?', [String(userid)]);
    return {
      ok: true,
      userid: String(userid),
      balance: Number(row?.balance ?? 0),
      exchange_id: String(exchangeId),
    };
  }

  if (amount === null || amount <= 0) {
    throw new Error('bob_amount must be positive integer');
  }

  const account = await db.get('SELECT balance FROM accounts WHERE userid = ?', [String(userid)]);
  const balance = Number(account?.balance ?? 0);
  if (balance < amount) {
    throw new Error('insufficient balance');
  }

  try {
    await db.run(
      'INSERT INTO redeems(exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at) VALUES(?, ?, ?, ?, ?, unixepoch())',
      [String(exchangeId), String(userid), String(productId), cleanProductName, amount],
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

  await db.run(
    'UPDATE accounts SET balance = balance - ?, updated_at = unixepoch() WHERE userid = ?',
    [amount, String(userid)],
  );

  const row = await db.get('SELECT balance FROM accounts WHERE userid = ?', [String(userid)]);

  return {
    ok: true,
    userid: String(userid),
    balance: Number(row?.balance ?? 0),
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
