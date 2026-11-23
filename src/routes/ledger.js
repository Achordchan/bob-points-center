import { Router } from 'express';

import { getBalance, listLedgerRecords, transferBob } from '../services/ledgerService.js';
import { extractBobToken, requireBobToken } from '../middleware/requireBobToken.js';
import { verifyBobToken } from '../services/bobTokenService.js';
import { requireWebSession } from '../middleware/requireWebSession.js';
import { requireSiteEnabled } from '../middleware/requireSiteEnabled.js';
import { requireAnnouncementAccess } from '../middleware/requireAnnouncementAccess.js';
import { parseCookies } from '../services/adminSession.js';
import { isWebSessionValidLive, verifyWebSessionToken } from '../services/webSession.js';
import { webSessionSigningSecret } from '../utils/sessionCrypto.js';
import { getUserName, sendOrQueueNotify, toBool } from '../services/notifyOpsService.js';
import {
  RESERVED_REF_ID_ERROR, deductBatchWithNotify, deductWithNotify, getTrustedAccountOptions, grantBatchWithNotify, grantWithNotify,
} from '../services/bobOpsService.js';
import { publishMallRealtimeEvent } from '../services/mallRealtimeService.js';

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function genExchangeId(prefix) {
  const p = prefix ? String(prefix) : 'API';
  return `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function ledgerRouter() {
  const router = Router();
  // 站点关闭时拦截业务读写；查询接口同样受限。
  router.use(requireSiteEnabled());

  async function attachOptionalWebSession(req) {
    if (req.webSession?.userid) return;
    try {
      const cfg = req.app?.locals?.cfg;
      const db = req.app?.locals?.db;
      const cookies = parseCookies(req.header('cookie'));
      const token = cookies.bob_web_session;
      const secret = webSessionSigningSecret(cfg);
      const payload = verifyWebSessionToken(secret, token);
      if (payload?.userid && (await isWebSessionValidLive(payload, db, cfg))) req.webSession = payload;
    } catch {
      // optional
    }
  }

  async function enforceAnnouncementAccessForWebSession(req, res) {
    if (!req.webSession?.userid) return true;
    let allowed = false;
    await requireAnnouncementAccess()(req, res, () => { allowed = true; });
    return allowed;
  }

  // 前台仅查自己；内部 API 用 bob_token 指定 userid。禁止匿名/伪造查询主体。
  async function resolveQueryUserid(req, res) {
    await attachOptionalWebSession(req);
    const db = req.app.locals.db;
    const sessionUser = req.webSession?.userid ? String(req.webSession.userid).trim() : '';
    if (sessionUser) {
      if (!(await enforceAnnouncementAccessForWebSession(req, res))) return null;
      return sessionUser;
    }

    // 禁止 ?bob_token=；仅 Header（GET 不使用 body）
    const token = extractBobToken(req, { allowBody: false });
    if (!token) {
      res.status(401).json({ error: 'unauthorized', message: '需要 web session 或 Header X-BOB-Token' });
      return null;
    }
    const ok = await verifyBobToken(db, token);
    if (!ok) {
      res.status(401).json({ error: 'invalid bob_token' });
      return null;
    }
    const userid = req.query.userid ? String(req.query.userid).trim() : '';
    if (!userid) {
      res.status(400).json({ error: 'missing userid' });
      return null;
    }
    req.bobToken = token;
    return userid;
  }

  router.get('/balance', async (req, res) => {
    try {
      const userid = await resolveQueryUserid(req, res);
      if (!userid) return;
      const db = req.app.locals.db;
      const account = req.bobToken
        ? await getTrustedAccountOptions(db, req.app.locals.cfg, userid)
        : { userid };
      const balance = await getBalance(db, account);
      return res.json({ userid, balance });
    } catch (err) {
      const message = String(err?.message || err);
      return res.status(message === 'unauthorized' ? 401 : 500).json({ error: message });
    }
  });

  router.get('/records', async (req, res) => {
    try {
      const userid = await resolveQueryUserid(req, res);
      if (!userid) return;
      const page = req.query.page ? Number(req.query.page) : 1;
      const pageSize = req.query.page_size ? Number(req.query.page_size) : 20;
      const db = req.app.locals.db;
      const account = req.bobToken
        ? await getTrustedAccountOptions(db, req.app.locals.cfg, userid)
        : { userid };
      // 第三方系统（bob_token）查询时不返回任何年会发放流水（只藏预留那一笔会让预留对象显得与众不同）；用户本人（会话）照常可见。
      const result = await listLedgerRecords(db, { ...account, page, pageSize, hideGalaAwards: Boolean(req.bobToken) });
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      return res.status(message === 'unauthorized' ? 401 : 500).json({ error: message });
    }
  });

  router.post('/transfer', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const session = req.webSession || {};
    const fromUserid = session?.userid ? String(session.userid).trim() : '';
    const fromName = session?.name ? String(session.name).trim() : '';
    const toUserid = req.body?.to_userid ? String(req.body.to_userid).trim() : '';
    const amount = toInt(req.body?.amount);
    const transferId = genExchangeId('TRANSFER');
    const awaitNotify = toBool(req.query?.await_notify) || toBool(req.body?.await_notify);

    if (!fromUserid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!toUserid) {
      return res.status(400).json({ error: 'missing to userid' });
    }
    if (amount === null || amount <= 0) {
      return res.status(400).json({ error: 'amount must be positive integer' });
    }
    if (toUserid === fromUserid) {
      return res.status(400).json({ error: 'cannot transfer to self' });
    }

    try {
      const db = req.app.locals.db;
      const cfg = req.app.locals.cfg;
      const result = await transferBob(db, {
        fromUserid,
        toUserid,
        amount,
        refId: transferId,
        fromName,
      });
      const fromDisplay = fromName || await getUserName(db, fromUserid);
      const toDisplay = await getUserName(db, toUserid);
      await sendOrQueueNotify({
        db,
        cfg,
        userid: fromUserid,
        title: fromDisplay ? `【BOB币中心】转账成功 ${fromDisplay}` : '【BOB币中心】转账成功',
        lines: [
          `转出给：${toDisplay || toUserid}`,
          `金额：${String(amount)} BOB 币`,
          `当前余额：${String(result.fromBalance)} BOB 币`,
        ],
        awaitNotify,
        event: 'transfer_out',
        variables: {
          name: fromDisplay || fromUserid,
          userid: fromUserid,
          to_name: toDisplay || toUserid,
          amount: String(amount),
          balance: String(result.fromBalance),
          transfer_id: transferId,
        },
      });
      await sendOrQueueNotify({
        db,
        cfg,
        userid: toUserid,
        title: toDisplay ? `【BOB币中心】转账到账 ${toDisplay}` : '【BOB币中心】转账到账',
        lines: [
          `来自：${fromDisplay || fromUserid}`,
          `金额：${String(amount)} BOB 币`,
          `当前余额：${String(result.toBalance)} BOB 币`,
        ],
        awaitNotify,
        event: 'transfer_in',
        variables: {
          name: toDisplay || toUserid,
          userid: toUserid,
          from_name: fromDisplay || fromUserid,
          amount: String(amount),
          balance: String(result.toBalance),
          transfer_id: transferId,
        },
      });
      publishMallRealtimeEvent('balance_changed', { userid: fromUserid, reason: 'transfer_out' });
      publishMallRealtimeEvent('balance_changed', { userid: toUserid, reason: 'transfer_in' });
      return res.json({
        ok: true,
        transfer_id: transferId,
        from_userid: result.fromUserid,
        to_userid: result.toUserid,
        from_balance: result.fromBalance,
        to_balance: result.toBalance,
      });
    } catch (err) {
      const message = String(err?.message || err);
      const status = message === 'transfer_not_allowed_between_sources'
        ? 403
        : [
          'missing from userid',
          'missing to userid',
          'amount must be positive integer',
          'cannot transfer to self',
          'insufficient balance',
        ].includes(message)
          ? 400
          : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.post('/grant', requireBobToken(), async (req, res) => {
    const body = req.body || {};
    const userid = body.userid ? String(body.userid) : '';
    const awaitNotify = toBool(req.query?.await_notify) || toBool(body.await_notify);

    if (!userid) {
      return res.status(400).json({ error: 'missing userid' });
    }

    try {
      const db = req.app.locals.db;
      const cfg = req.app.locals.cfg;
      const out = await grantWithNotify(db, cfg, {
        userid,
        amount: body.amount,
        reason: body.reason,
        refId: body.refId,
        awaitNotify,
      });
      publishMallRealtimeEvent('balance_changed', { userid, reason: 'grant' });

      if (awaitNotify) {
        return res.json({ ok: true, ...out });
      }
      return res.json({ ok: true, userid: out.userid, balance: out.balance, ledgerId: out.ledgerId });
    } catch (err) {
      const message = String(err?.message || err);
      const status = message.includes('amount must be positive') || message === RESERVED_REF_ID_ERROR ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.post('/grant-batch', requireBobToken(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const ids = Array.isArray(req.body?.userids) ? req.body.userids : [];
    const userids = ids
      .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
      .filter((x) => x);

    const amount = toInt(req.body?.amount);
    const reason = req.body?.reason ? String(req.body.reason) : undefined;
    const refId = req.body?.refId ? String(req.body.refId) : undefined;
    const awaitNotify = toBool(req.query?.await_notify) || toBool(req.body?.await_notify);

    if (userids.length === 0) {
      return res.status(400).json({ error: 'missing userids' });
    }
    if (amount === null || amount <= 0) {
      return res.status(400).json({ error: 'amount must be positive integer' });
    }

    try {
      const result = await grantBatchWithNotify(db, cfg, { userids, amount, reason, refId, awaitNotify });
      for (const row of (result?.results || [])) {
        if (row?.ok && row?.userid) {
          publishMallRealtimeEvent('balance_changed', { userid: String(row.userid), reason: 'grant_batch' });
        }
      }
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      return res.status(message === RESERVED_REF_ID_ERROR ? 400 : 500).json({ error: message });
    }
  });

  router.post('/deduct', requireBobToken(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const body = req.body || {};
    const userid = body.userid ? String(body.userid).trim() : '';
    const amount = toInt(body.amount);
    const productName = body.product_name ? String(body.product_name).trim() : '';
    const exchangeId = body.exchange_id ? String(body.exchange_id).trim() : genExchangeId('API_DEDUCT');
    const awaitNotify = toBool(req.query?.await_notify) || toBool(body.await_notify);

    if (!userid) {
      return res.status(400).json({ error: 'missing userid' });
    }
    if (amount === null || amount <= 0) {
      return res.status(400).json({ error: 'bob_amount must be positive integer' });
    }
    if (!productName) {
      return res.status(400).json({ error: 'missing product_name' });
    }

    try {
      const out = await deductWithNotify(db, cfg, {
        exchangeId,
        userid,
        productId: 'API_DEDUCT',
        productName,
        bobAmount: amount,
        reason: 'api_deduct',
        awaitNotify,
      });
      publishMallRealtimeEvent('balance_changed', { userid, reason: 'deduct' });

      if (awaitNotify) {
        return res.json({ ok: true, ...out });
      }
      return res.json({ ok: true, userid: out.userid, balance: out.balance, exchange_id: out.exchange_id });
    } catch (err) {
      const message = String(err?.message || err);
      const status = [
        'missing exchange_id',
        'missing userid',
        'missing product_id',
        'bob_amount must be positive integer',
        'insufficient balance',
        'exchange already redeemed',
        'payload mismatch',
      ].includes(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.post('/deduct-batch', requireBobToken(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const ids = Array.isArray(req.body?.userids) ? req.body.userids : [];
    const userids = ids
      .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
      .filter((x) => x);

    const amount = toInt(req.body?.amount);
    const productName = req.body?.product_name ? String(req.body.product_name).trim() : '';
    const baseExchangeId = req.body?.exchange_id ? String(req.body.exchange_id).trim() : genExchangeId('API_DEDUCT_BATCH');
    const awaitNotify = toBool(req.query?.await_notify) || toBool(req.body?.await_notify);

    if (userids.length === 0) {
      return res.status(400).json({ error: 'missing userids' });
    }
    if (amount === null || amount <= 0) {
      return res.status(400).json({ error: 'bob_amount must be positive integer' });
    }
    if (!productName) {
      return res.status(400).json({ error: 'missing product_name' });
    }

    try {
      const result = await deductBatchWithNotify(db, cfg, {
        userids,
        baseExchangeId,
        productId: 'API_DEDUCT',
        productName,
        bobAmount: amount,
        reason: 'api_deduct',
        awaitNotify,
      });
      for (const row of (result?.results || [])) {
        if (row?.ok && row?.userid) {
          publishMallRealtimeEvent('balance_changed', { userid: String(row.userid), reason: 'deduct_batch' });
        }
      }
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  return router;
}
