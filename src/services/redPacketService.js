import { ensureAccount } from './ledgerService.js';

export async function resolveRedPacketActivity(db, now) {
  const activity = await db.get('SELECT * FROM red_packet_activity ORDER BY id DESC LIMIT 1');
  if (!activity) return null;
  let nextStatus = activity.status;
  if (now >= Number(activity.end_at)) {
    nextStatus = 'ended';
  } else if (now >= Number(activity.start_at) && activity.status === 'scheduled') {
    nextStatus = 'active';
  }
  if (nextStatus !== activity.status) {
    await db.run('UPDATE red_packet_activity SET status = ? WHERE id = ?', [nextStatus, activity.id]);
    return await db.get('SELECT * FROM red_packet_activity WHERE id = ?', [activity.id]);
  }
  return activity;
}

export async function claimActiveRedPacket(db, { userid, name = '', now = Math.floor(Date.now() / 1000), ledgerReason = '红包收入', refPrefix = 'RED_PACKET' } = {}) {
  const uid = userid ? String(userid).trim() : '';
  if (!uid) throw new Error('unauthorized');
  const displayName = name ? String(name) : '';
  const txRunner = typeof db.transaction === 'function'
    ? (fn) => db.transaction(fn)
    : async (fn) => await fn(db);

  return await txRunner(async (tx) => {
    const activity = await resolveRedPacketActivity(tx, now);
    if (!activity) throw new Error('no_active');
    if (now < Number(activity.start_at)) throw new Error('not_started');
    if (now >= Number(activity.end_at)) {
      await tx.run('UPDATE red_packet_activity SET status = ? WHERE id = ?', ['ended', activity.id]);
      throw new Error('ended');
    }
    if (activity.status === 'ended') throw new Error('ended');
    if (activity.status !== 'active') {
      await tx.run('UPDATE red_packet_activity SET status = ? WHERE id = ?', ['active', activity.id]);
    }

    const mine = await tx.get(
      'SELECT id, amount FROM red_packet_items WHERE activity_id = ? AND claimed_by = ? LIMIT 1 FOR UPDATE',
      [activity.id, uid],
    );
    if (mine?.id) throw new Error('already_claimed');

    const item = await tx.get(
      'SELECT id, amount FROM red_packet_items WHERE activity_id = ? AND claimed_by IS NULL ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED',
      [activity.id],
    );
    if (!item?.id) {
      await tx.run('UPDATE red_packet_activity SET status = ? WHERE id = ?', ['ended', activity.id]);
      throw new Error('sold_out');
    }

    const updated = await tx.run(
      'UPDATE red_packet_items SET claimed_by = ?, claimed_at = unixepoch() WHERE id = ? AND claimed_by IS NULL',
      [uid, item.id],
    );
    if (!updated?.changes) throw new Error('sold_out');

    await ensureAccount(tx, { userid: uid, name: displayName });
    await tx.run(
      'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
      [uid, Number(item.amount), ledgerReason, `${refPrefix}_${activity.id}_${item.id}`],
    );
    await tx.run(
      'UPDATE accounts SET balance = balance + ?, updated_at = unixepoch() WHERE userid = ?',
      [Number(item.amount), uid],
    );
    const balanceRow = await tx.get('SELECT balance FROM accounts WHERE userid = ?', [uid]);

    return {
      amount: Number(item.amount),
      balance: balanceRow?.balance ?? 0,
      activity_id: activity.id,
      item_id: Number(item.id),
    };
  });
}
