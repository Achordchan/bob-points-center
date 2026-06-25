function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return null;
  }
  return n;
}

export async function ensureAccount(db, { userid, name }) {
  const uid = userid === null || userid === undefined ? '' : String(userid).trim();
  if (!uid) {
    throw new Error('missing userid');
  }
  const rawDisplayName = name === null || name === undefined ? '' : String(name).trim();
  // Do not persist userid placeholders as the user's canonical name.
  const displayName = rawDisplayName && rawDisplayName !== uid ? rawDisplayName : '';

  await db.run(
    'INSERT OR IGNORE INTO users(userid, name) VALUES(?, ?)',
    [uid, null],
  );

  if (displayName) {
    await db.run(
      'UPDATE users SET name = ? WHERE userid = ?',
      [displayName, uid],
    );
  }

  await db.run(
    'INSERT OR IGNORE INTO accounts(userid, balance) VALUES(?, 0)',
    [uid],
  );
}

export async function getBalance(db, { userid, name }) {
  await ensureAccount(db, { userid, name });

  const row = await db.get(
    'SELECT balance FROM accounts WHERE userid = ?',
    [String(userid)],
  );

  return row?.balance ?? 0;
}

export async function grantBob(db, { userid, amount, reason, refId, name }) {
  const delta = toInt(amount);
  if (delta === null || delta <= 0) {
    throw new Error('amount must be positive integer');
  }

  const cleanReason = reason ? String(reason) : 'grant';

  const run = async (tx) => {
    await ensureAccount(tx, { userid, name });

    const insert = await tx.run(
      'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
      [String(userid), delta, cleanReason, refId ? String(refId) : null],
    );

    await tx.run(
      'UPDATE accounts SET balance = balance + ?, updated_at = unixepoch() WHERE userid = ?',
      [delta, String(userid)],
    );

    const row = await tx.get(
      'SELECT balance FROM accounts WHERE userid = ?',
      [String(userid)],
    );

    return {
      userid: String(userid),
      balance: row?.balance ?? 0,
      ledgerId: insert?.lastID ?? null,
    };
  };

  if (db?.__txScoped === true) {
    return await run(db);
  }
  if (typeof db.transaction === 'function') {
    return await db.transaction(run);
  }
  return await run(db);
}

export async function deductBob(db, { userid, amount, reason, refId, name }) {
  const delta = toInt(amount);
  if (delta === null || delta <= 0) {
    throw new Error('amount must be positive integer');
  }

  const cleanReason = reason ? String(reason) : 'deduct';

  const run = async (tx) => {
    await ensureAccount(tx, { userid, name });

    const updated = await tx.get(
      `UPDATE accounts
          SET balance = balance - ?, updated_at = unixepoch()
        WHERE userid = ?
          AND balance >= ?
        RETURNING balance`,
      [delta, String(userid), delta],
    );
    if (!updated) {
      throw new Error('insufficient balance');
    }

    const insert = await tx.run(
      'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
      [String(userid), -delta, cleanReason, refId ? String(refId) : null],
    );

    return {
      userid: String(userid),
      balance: Number(updated.balance ?? 0),
      ledgerId: insert?.lastID ?? null,
      refId: refId ? String(refId) : null,
    };
  };

  if (db?.__txScoped === true) {
    return await run(db);
  }
  if (typeof db.transaction === 'function') {
    return await db.transaction(run);
  }
  return await run(db);
}

export async function listLedgerRecords(db, { userid, page = 1, pageSize = 20, name }) {
  if (!userid) {
    throw new Error('missing userid');
  }

  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const offset = (p - 1) * ps;

  await ensureAccount(db, { userid, name });

  const rows = await db.all(
    `SELECT l.id, l.userid, l.delta, l.reason, l.ref_id, l.created_at, COALESCE(u.name, '') AS peer_name
     FROM ledger l
     LEFT JOIN users u ON u.userid = l.ref_id
     WHERE l.userid = ?
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT ? OFFSET ?`,
    [String(userid), ps, offset],
  );

  return {
    userid: String(userid),
    page: p,
    pageSize: ps,
    data: rows || [],
  };
}

export async function transferBob(db, {
  fromUserid,
  toUserid,
  amount,
  refId,
  fromName,
  toName,
}) {
  const fromId = fromUserid === null || fromUserid === undefined ? '' : String(fromUserid).trim();
  const toId = toUserid === null || toUserid === undefined ? '' : String(toUserid).trim();
  if (!fromId) {
    throw new Error('missing from userid');
  }
  if (!toId) {
    throw new Error('missing to userid');
  }
  if (fromId === toId) {
    throw new Error('cannot transfer to self');
  }
  const delta = toInt(amount);
  if (delta === null || delta <= 0) {
    throw new Error('amount must be positive integer');
  }

  const run = async (tx) => {
    await ensureAccount(tx, { userid: fromId, name: fromName });
    await ensureAccount(tx, { userid: toId, name: toName });

    const fromRow = await tx.get('SELECT balance FROM accounts WHERE userid = ? FOR UPDATE', [fromId]);
    const toRow = await tx.get('SELECT balance FROM accounts WHERE userid = ? FOR UPDATE', [toId]);
    const fromBalance = Number(fromRow?.balance ?? 0);
    if (fromBalance < delta) {
      throw new Error('insufficient balance');
    }

    await tx.run(
      'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
      [fromId, -delta, 'transfer_out', toId],
    );
    await tx.run(
      'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
      [toId, delta, 'transfer_in', fromId],
    );
    await tx.run(
      'UPDATE accounts SET balance = balance - ?, updated_at = unixepoch() WHERE userid = ?',
      [delta, fromId],
    );
    await tx.run(
      'UPDATE accounts SET balance = balance + ?, updated_at = unixepoch() WHERE userid = ?',
      [delta, toId],
    );

    const fromAfter = await tx.get('SELECT balance FROM accounts WHERE userid = ?', [fromId]);
    const toAfter = await tx.get('SELECT balance FROM accounts WHERE userid = ?', [toId]);
    return {
      fromUserid: fromId,
      toUserid: toId,
      fromBalance: fromAfter?.balance ?? 0,
      toBalance: toAfter?.balance ?? 0,
    };
  };

  if (db?.__txScoped === true) {
    return await run(db);
  }
  if (typeof db.transaction === 'function') {
    return await db.transaction(run);
  }
  return await run(db);
}
