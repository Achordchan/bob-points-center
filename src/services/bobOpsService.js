import { GALA_PAYOUT_REF_PREFIX, deductBob, grantBob } from './ledgerService.js';
import { confirmRedeem } from './redeemService.js';
import { getUserName, sendOrQueueNotify } from './notifyOpsService.js';
import { getUserDetail } from './dingtalkService.js';

export async function getTrustedAccountOptions(db, cfg, userid) {
  const uid = String(userid || '').trim();
  if (!uid) throw new Error('missing userid');
  const user = await db.get('SELECT source FROM users WHERE userid = ? LIMIT 1', [uid]);
  let createUser = false;
  let name;
  if (!user) {
    // 缺失账号只接受钉钉实时证明；不按 userid 前缀猜来源，亦不复用缓存的旧身份。
    const profile = await getUserDetail(cfg, uid);
    if (String(profile?.userid || '') !== uid) throw new Error('unauthorized');
    name = profile.name;
    createUser = true;
  } else if (user.source === 'dingtalk') {
    createUser = true;
  }
  return { userid: uid, name, createUser };
}

// GALA_W 前缀的引用号留给年会发放：外部发币（单发、批量、后台批量）都走这里，统一拒绝。
export const RESERVED_REF_ID_ERROR = 'reserved refId prefix';
export function assertExternalRefIdAllowed(refId) {
  if (refId != null && String(refId).trim().toUpperCase().startsWith(GALA_PAYOUT_REF_PREFIX)) {
    throw new Error(RESERVED_REF_ID_ERROR);
  }
}

async function trustedGrant(db, cfg, { userid, amount, reason, refId }) {
  assertExternalRefIdAllowed(refId);
  if (!Number.isInteger(Number(amount)) || Number(amount) <= 0) throw new Error('amount must be positive integer');
  const account = await getTrustedAccountOptions(db, cfg, userid);
  return await grantBob(db, { ...account, amount, reason, refId });
}

export async function grantWithNotify(db, cfg, { userid, amount, reason, refId, awaitNotify } = {}) {
  const r = await trustedGrant(db, cfg, { userid, amount, reason, refId });

  const displayName = await getUserName(db, userid);
  const title = displayName ? `【BOB币中心】恭喜你！${displayName}` : '【BOB币中心】恭喜你！';
  const notify = await sendOrQueueNotify({
    db,
    cfg,
    userid,
    title,
    lines: [`类型：收入`, `原因：${reason || '-'}`, `金额：${String(amount)} BOB 币`, `当前余额：${r.balance} BOB 币`],
    awaitNotify,
    event: 'grant',
    variables: {
      name: displayName || userid,
      userid,
      reason: reason || '-',
      amount: String(amount),
      balance: String(r.balance),
    },
  });

  return { ...r, notify: awaitNotify ? notify : undefined };
}

export async function grantBatchWithNotify(db, cfg, { userids, amount, reason, refId, awaitNotify } = {}) {
  assertExternalRefIdAllowed(refId);
  const ids = Array.isArray(userids) ? userids : [];
  const results = [];
  for (const userid of ids) {
    try {
      const r = await trustedGrant(db, cfg, { userid, amount, reason, refId });

      const displayName = await getUserName(db, userid);
      const title = displayName ? `【BOB币中心】恭喜你！${displayName}` : '【BOB币中心】恭喜你！';
      const notify = await sendOrQueueNotify({
        db,
        cfg,
        userid,
        title,
        lines: [`类型：收入`, `原因：${reason || '-'}`, `金额：${String(amount)} BOB 币`, `当前余额：${r.balance} BOB 币`],
        awaitNotify,
        event: 'grant',
        variables: {
          name: displayName || userid,
          userid,
          reason: reason || '-',
          amount: String(amount),
          balance: String(r.balance),
        },
      });

      results.push(
        awaitNotify
          ? { ok: true, userid: r.userid, balance: r.balance, ledgerId: r.ledgerId, notify }
          : { ok: true, userid: r.userid, balance: r.balance, ledgerId: r.ledgerId },
      );
    } catch (err) {
      results.push({ ok: false, userid: String(userid), error: String(err?.message || err) });
    }
  }

  const ok = results.every((x) => x.ok);
  return { ok, count: results.length, results };
}

export async function deductWithNotify(db, cfg, { exchangeId, userid, productId, productName, bobAmount, reason, awaitNotify } = {}) {
  const r = await confirmRedeem(db, {
    exchangeId,
    userid,
    productId,
    productName,
    bobAmount,
    reason,
  });

  const displayName = await getUserName(db, userid);
  const title = displayName ? `【BOB币中心】余额变动通知 ${displayName}` : '【BOB币中心】余额变动通知';
  const notify = await sendOrQueueNotify({
    db,
    cfg,
    userid,
    title,
    lines: [`类型：支出`, `原因：${productName || '-'}`, `金额：${String(bobAmount)} BOB 币`, `当前余额：${r.balance} BOB 币`, `单号：${String(exchangeId)}`],
    awaitNotify,
    event: 'deduct',
    variables: {
      name: displayName || userid,
      userid,
      reason: productName || '-',
      amount: String(bobAmount),
      balance: String(r.balance),
      exchange_id: String(exchangeId),
      product_name: productName || productId,
    },
  });

  return { ...r, notify: awaitNotify ? notify : undefined };
}

export async function deductBatchWithNotify(db, cfg, { userids, baseExchangeId, productId, productName, bobAmount, reason, awaitNotify } = {}) {
  const ids = Array.isArray(userids) ? userids : [];
  const results = [];

  for (const userid of ids) {
    const exchangeId = `${String(baseExchangeId)}_${String(userid)}`;
    try {
      const r = await confirmRedeem(db, {
        exchangeId,
        userid,
        productId,
        productName,
        bobAmount,
        reason,
      });

      const displayName = await getUserName(db, userid);
      const title = displayName ? `【BOB币中心】余额变动通知 ${displayName}` : '【BOB币中心】余额变动通知';
      const notify = await sendOrQueueNotify({
        db,
        cfg,
        userid,
        title,
        lines: [`类型：支出`, `原因：${productName || '-'}`, `金额：${String(bobAmount)} BOB 币`, `当前余额：${r.balance} BOB 币`, `单号：${exchangeId}`],
        awaitNotify,
        event: 'deduct',
        variables: {
          name: displayName || userid,
          userid,
          reason: productName || '-',
          amount: String(bobAmount),
          balance: String(r.balance),
          exchange_id: String(exchangeId),
          product_name: productName || productId,
        },
      });

      results.push(
        awaitNotify
          ? { ok: true, userid: String(userid), balance: r.balance, exchange_id: exchangeId, notify }
          : { ok: true, userid: String(userid), balance: r.balance, exchange_id: exchangeId },
      );
    } catch (err) {
      results.push({ ok: false, userid: String(userid), error: String(err?.message || err), exchange_id: exchangeId });
    }
  }

  const ok = results.every((x) => x.ok);
  return { ok, count: results.length, results };
}


export async function adminDeductBatchWithNotify(db, cfg, { userids, baseExchangeId, productName, bobAmount, reason, awaitNotify } = {}) {
  const ids = Array.isArray(userids) ? userids : [];
  const results = [];

  for (const userid of ids) {
    const exchangeId = `${String(baseExchangeId)}_${String(userid)}`;
    try {
      const r = await deductBob(db, {
        userid,
        amount: bobAmount,
        reason: reason || 'admin_deduct',
        refId: exchangeId,
      });

      const displayName = await getUserName(db, userid);
      const title = displayName ? `【BOB币中心】余额变动通知 ${displayName}` : '【BOB币中心】余额变动通知';
      const notify = await sendOrQueueNotify({
        db,
        cfg,
        userid,
        title,
        lines: [`类型：支出`, `原因：${productName || '-'}`, `金额：${String(bobAmount)} BOB 币`, `当前余额：${r.balance} BOB 币`, `单号：${exchangeId}`],
        awaitNotify,
        event: 'deduct',
        variables: {
          name: displayName || userid,
          userid,
          reason: productName || '-',
          amount: String(bobAmount),
          balance: String(r.balance),
          exchange_id: exchangeId,
          product_name: productName || '后台减币',
        },
      });

      results.push(
        awaitNotify
          ? { ok: true, userid: String(userid), balance: r.balance, ledgerId: r.ledgerId, ref_id: exchangeId, notify }
          : { ok: true, userid: String(userid), balance: r.balance, ledgerId: r.ledgerId, ref_id: exchangeId },
      );
    } catch (err) {
      results.push({ ok: false, userid: String(userid), error: String(err?.message || err), ref_id: exchangeId });
    }
  }

  const ok = results.every((x) => x.ok);
  return { ok, count: results.length, results };
}

export async function redeemConfirmWithNotify(db, cfg, { exchangeId, userid, productId, productName, bobAmount, reason, awaitNotify, fulfilledBy, fulfilledName } = {}) {
  const result = await confirmRedeem(db, { exchangeId, userid, productId, productName, bobAmount, reason, fulfilledBy, fulfilledName });

  const displayName = await getUserName(db, userid);
  const title = displayName ? `【BOB币中心】核销完成 ${displayName}` : '【BOB币中心】核销完成';
  const notify = await sendOrQueueNotify({
    db,
    cfg,
    userid,
    title,
    lines: [
      `商品：${String(productName || productId)}`,
      `金额：${String(bobAmount)} BOB 币`,
      `当前余额：${result.balance} BOB 币`,
      `订单号：${String(exchangeId)}`,
    ],
    awaitNotify,
    event: 'redeem',
    variables: {
      name: displayName || userid,
      userid,
      product_name: String(productName || productId),
      amount: String(bobAmount),
      balance: String(result.balance),
      exchange_id: String(exchangeId),
    },
  });

  return { ...result, notify: awaitNotify ? notify : undefined };
}
