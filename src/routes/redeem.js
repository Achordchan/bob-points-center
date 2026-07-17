import { Router } from 'express';

import { verifyEncoded, QRSignError } from '../utils/qr.js';
import { listRedeemsByUserid } from '../services/redeemService.js';
import { extractBobToken, requireBobToken } from '../middleware/requireBobToken.js';
import { requireSiteEnabled } from '../middleware/requireSiteEnabled.js';
import { verifyBobToken } from '../services/bobTokenService.js';
import { parseCookies } from '../services/adminSession.js';
import { verifyWebSessionToken } from '../services/webSession.js';
import { isSessionVersionValid, webSessionSigningSecret } from '../utils/sessionCrypto.js';
import { toBool } from '../services/notifyOpsService.js';
import { redeemConfirmWithNotify } from '../services/bobOpsService.js';
import { publishMallRealtimeEvent } from '../services/mallRealtimeService.js';

export function redeemRouter() {
  const router = Router();
  router.use(requireSiteEnabled());

  router.post('/confirm', requireBobToken(), async (req, res) => {
    const secret = req.app?.locals?.cfg?.qrSignSecret;
    const cfg = req.app?.locals?.cfg;
    const encoded = req.body?.encoded;
    const awaitNotify = toBool(req.query?.await_notify) || toBool(req.body?.await_notify);

    if (!encoded) {
      return res.status(400).json({ error: 'missing encoded' });
    }

    let payload;
    try {
      payload = verifyEncoded(encoded, secret);
    } catch (err) {
      const message = String(err?.message || err);
      if (err instanceof QRSignError) {
        return res.status(400).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }

    try {
      const db = req.app.locals.db;
      const result = await redeemConfirmWithNotify(db, cfg, {
        exchangeId: payload.exchange_id,
        userid: payload.userid,
        productId: payload.product_id,
        productName: payload.product_name,
        bobAmount: payload.bob_amount,
        reason: 'redeem',
        awaitNotify,
      });
      publishMallRealtimeEvent('order_updated', {
        userid: String(payload.userid || ''),
        exchange_id: String(payload.exchange_id || ''),
        status: 'fulfilled',
        source: 'redeem_confirm',
      });
      publishMallRealtimeEvent('balance_changed', {
        userid: String(payload.userid || ''),
        reason: 'redeem_confirm',
      });
      if (result?.market_listing_cancelled) {
        publishMallRealtimeEvent('market_changed', {
          listing_id: String(result.market_listing_id || ''),
          exchange_id: String(payload.exchange_id || ''),
          reason: 'redeem_confirm',
        });
      }

      if (awaitNotify) {
        return res.json(result);
      }
      return res.json({ ok: true, userid: result.userid, balance: result.balance, exchange_id: result.exchange_id });
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

  function attachOptionalWebSession(req) {
    if (req.webSession?.userid) return;
    try {
      const cfg = req.app?.locals?.cfg;
      const cookies = parseCookies(req.header('cookie'));
      const token = cookies.bob_web_session;
      const secret = webSessionSigningSecret(cfg);
      const payload = verifyWebSessionToken(secret, token);
      if (payload?.userid && isSessionVersionValid(payload, cfg)) req.webSession = payload;
    } catch {
      // optional
    }
  }

  router.get('/', async (req, res) => {
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.page_size ? Number(req.query.page_size) : 20;
    try {
      attachOptionalWebSession(req);
      const db = req.app.locals.db;
      let userid = req.webSession?.userid ? String(req.webSession.userid).trim() : '';
      if (!userid) {
        const token = extractBobToken(req, { allowBody: false });
        if (!token) return res.status(401).json({ error: 'unauthorized', message: '需要 web session 或 Header X-BOB-Token' });
        const ok = await verifyBobToken(db, token);
        if (!ok) return res.status(401).json({ error: 'invalid bob_token' });
        userid = req.query.userid ? String(req.query.userid).trim() : '';
        if (!userid) return res.status(400).json({ error: 'missing userid' });
      }
      const result = await listRedeemsByUserid(db, { userid, page, pageSize });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  return router;
}
