import { Router } from 'express';

import { createQrPngBuffer } from '../services/qrImageService.js';

export function qrImageRouter() {
  const router = Router();

  router.get('/render', async (req, res) => {
    try {
      const data = req.query?.data ? String(req.query.data) : '';
      const size = req.query?.size ? Number(req.query.size) : 240;
      const ec = req.query?.ec ? String(req.query.ec) : 'M';
      const buffer = await createQrPngBuffer(data, { size, ec });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(buffer);
    } catch (err) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({ error: String(err?.message || err) });
    }
  });

  return router;
}
