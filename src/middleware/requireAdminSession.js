import { parseCookies, verifySessionToken } from '../services/adminSession.js';
import { adminSessionSigningSecret, isSessionVersionValidLive } from '../utils/sessionCrypto.js';

export function requireAdminSession() {
  return async function requireAdminSessionMiddleware(req, res, next) {
    const cfg = req.app?.locals?.cfg;
    const db = req.app?.locals?.db;
    const cookies = parseCookies(req.header('cookie'));
    const token = cookies.bob_admin_session;

    const secret = adminSessionSigningSecret(cfg);

    let payload;
    try {
      payload = verifySessionToken(secret, token);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }

    if (!payload || !(await isSessionVersionValidLive(payload, db, cfg))) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    req.adminSession = payload;
    return next();
  };
}
