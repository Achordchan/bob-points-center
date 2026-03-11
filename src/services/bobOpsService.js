import { grantBob } from './ledgerService.js';
import { confirmRedeem } from './redeemService.js';
import { getUserName, sendOrQueueNotify } from './notifyOpsService.js';

export async function grantWithNotify(db, cfg, { userid, amount, reason, refId, awaitNotify } = {}) {
  const r = await grantBob(db, { userid, amount, reason, refId });

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
  const ids = Array.isArray(userids) ? userids : [];
  const results = [];
  for (const userid of ids) {
    try {
      const r = await grantBob(db, { userid, amount, reason, refId });

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

export async function redeemConfirmWithNotify(db, cfg, { exchangeId, userid, productId, productName, bobAmount, reason, awaitNotify } = {}) {
  const result = await confirmRedeem(db, { exchangeId, userid, productId, productName, bobAmount, reason });

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
