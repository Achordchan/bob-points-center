import { verifyBobToken } from '../services/bobTokenService.js';

export function requireBobToken() {
  return async function requireBobTokenMiddleware(req, res, next) {
    const token = req.body?.bob_token;
    if (!token) {
      return res.status(401).json({ error: 'missing bob_token' });
    }

    try {
      const db = req.app.locals.db;
      const ok = await verifyBobToken(db, token);
      if (!ok) {
        return res.status(401).json({ error: 'invalid bob_token' });
      }
      return next();
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  };
}
