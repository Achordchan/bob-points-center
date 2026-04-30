import { Router } from 'express';

import { verifyEncoded, QRSignError } from '../utils/qr.js';
import { listRedeemsByUserid } from '../services/redeemService.js';
import { requireBobToken } from '../middleware/requireBobToken.js';
import { toBool } from '../services/notifyOpsService.js';
import { redeemConfirmWithNotify } from '../services/bobOpsService.js';
import { publishMallRealtimeEvent } from '../services/mallRealtimeService.js';

export function redeemRouter() {
  const router = Router();

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

  router.get('/', async (req, res) => {
    const userid = req.query.userid ? String(req.query.userid) : '';
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.page_size ? Number(req.query.page_size) : 20;

    if (!userid) {
      return res.status(400).json({ error: 'missing userid' });
    }

    try {
      const db = req.app.locals.db;
      const result = await listRedeemsByUserid(db, { userid, page, pageSize });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  return router;
}
