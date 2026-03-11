import { Router } from 'express';

export function healthRouter() {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ ok: true });
  });

  return router;
}
