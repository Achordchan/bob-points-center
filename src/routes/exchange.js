import { Router } from 'express';
import crypto from 'node:crypto';

import { buildExchangeData, encodeData, QRSignError } from '../utils/qr.js';
import { requireBobToken } from '../middleware/requireBobToken.js';

function genExchangeId() {
  return `BOB_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

export function exchangeRouter() {
  const router = Router();

  router.post('/qr', requireBobToken(), (req, res) => {
    const secret = req.app?.locals?.cfg?.qrSignSecret;
    const body = req.body || {};

    const required = ['userid', 'product_id', 'bob_amount'];
    const ok = required.every((k) => Object.prototype.hasOwnProperty.call(body, k));
    if (!ok) {
      return res.status(400).json({ error: 'missing fields' });
    }

    if (!Object.prototype.hasOwnProperty.call(body, 'exchange_id') || !String(body.exchange_id || '').trim()) {
      body.exchange_id = genExchangeId();
    }

    try {
      const data = buildExchangeData(body, secret);
      const encoded = encodeData(data);
      const qr_image_url = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(encoded)}`;
      return res.json({ encoded, data, qr_image_url });
    } catch (err) {
      const message = String(err?.message || err);
      if (err instanceof QRSignError) {
        return res.status(400).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
