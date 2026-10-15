function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return null;
  }
  return n;
}


function firstText(...values) {
  for (const value of values) {
    const s = value === null || value === undefined ? '' : String(value).trim();
    if (s) return s;
  }
  return '';
}

export function formatLedgerReason(row = {}) {
  const reason = firstText(row.reason);
  const delta = Number(row.delta || 0);
  const peer = firstText(row.peer_name, row.peer_userid, row.ref_id);
  const product = firstText(row.product_name);

  if (!reason) return delta < 0 ? '支出' : '收入';
  if (reason === 'mall_buy') return product ? `商城下单：${product}` : '商城下单';
  if (reason === 'transfer_in') return peer ? `转入：${peer}` : '转账转入';
  if (reason === 'transfer_out') return peer ? `转出：${peer}` : '转账转出';
  if (reason === 'red_packet') return '红包收入';
  if (reason === 'grant') return '系统发币';
  if (reason === 'grant_batch') return '批量发币';
  if (reason === 'admin_grant_batch') return '后台批量发币';
  if (reason === 'deduct') return '扣币';
  if (reason === 'deduct_batch') return '批量扣币';
  if (reason === 'admin_deduct') return '管理员扣币';
  if (reason === 'api_deduct') return '接口扣币';
  if (reason === 'redeem') return product ? `核销扣币：${product}` : '核销扣币';
  if (reason === 'auction_bid') return '竞拍出价（冻结）';
  if (reason === 'auction_outbid_refund') return '竞拍被超出退回';
  if (reason === 'auction_cancel_refund') return '竞拍取消退回';
  if (reason === 'auction_settle_refund') return '竞拍成交释放冻结';
  if (reason === 'auction_win_pay') return '竞拍成交扣款';
  if (reason === 'charity' || reason.startsWith('公益助力')) return reason.startsWith('公益助力') ? reason : '公益助力';
  if (reason === '打卡奖励') return '打卡奖励';
  return reason;
}

function withDisplayReason(row = {}) {
  return {
    ...row,
    peer_userid: firstText(row.peer_userid, row.ref_id),
    display_reason: formatLedgerReason(row),
  };
}

export async function ensureAccount(db, { userid, name, createUser = false }) {
  const uid = userid === null || userid === undefined ? '' : String(userid).trim();
  if (!uid) {
    throw new Error('missing userid');
  }
  const rawDisplayName = name === null || name === undefined ? '' : String(name).trim();
  // Do not persist userid placeholders as the user's canonical name.
  const displayName = rawDisplayName && rawDisplayName !== uid ? rawDisplayName : '';

  // 只有可信的钉钉资料入库能创建用户；业务请求不得复活已被清理的用户。
  if (createUser) {
    await db.run(
      'INSERT OR IGNORE INTO users(userid, name) VALUES(?, ?)',
      [uid, null],
    );
  } else {
    const user = await db.get(
      'SELECT userid FROM users WHERE userid = ? LIMIT 1',
      [uid],
    );
    if (!user) throw new Error('unauthorized');
  }

  if (displayName) {
    await db.run(
      'UPDATE users SET name = ? WHERE userid = ?',
      [displayName, uid],
    );
  }

  // 仅从仍存在的 users 补齐账户；SELECT 与 INSERT 为一条语句，FK 保证并发删除时不留孤儿。
  await db.run(
    'INSERT OR IGNORE INTO accounts(userid, balance) SELECT userid, 0 FROM users WHERE userid = ?',
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

export async function grantBob(db, { userid, amount, reason, refId, name, createUser = false }) {
  const delta = toInt(amount);
  if (delta === null || delta <= 0) {
    throw new Error('amount must be positive integer');
  }

  const cleanReason = reason ? String(reason) : 'grant';

  const run = async (tx) => {
    await ensureAccount(tx, { userid, name, createUser });

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
    `SELECT l.id, l.userid, l.delta, l.reason, l.ref_id, l.created_at,
            COALESCE(peer.userid, '') AS peer_userid,
            COALESCE(peer.name, '') AS peer_name,
            COALESCE(r.product_name, '') AS product_name
     FROM ledger l
     LEFT JOIN users peer ON peer.userid = l.ref_id
     LEFT JOIN redeems r ON r.exchange_id = l.ref_id
     WHERE l.userid = ?
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT ? OFFSET ?`,
    [String(userid), ps, offset],
  );

  return {
    userid: String(userid),
    page: p,
    pageSize: ps,
    data: (rows || []).map(withDisplayReason),
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

    // 始终按 userid 字典序加锁，避免 A→B 与 B→A 并发死锁。
    const lockOrder = [fromId, toId].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const uid of lockOrder) {
      await tx.get('SELECT balance FROM accounts WHERE userid = ? FOR UPDATE', [uid]);
    }
    const fromRow = await tx.get('SELECT balance FROM accounts WHERE userid = ?', [fromId]);
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
