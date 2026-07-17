import { parseCookies } from '../services/adminSession.js';
import { verifyWebSessionToken } from '../services/webSession.js';
import { isSessionVersionValidLive, webSessionSigningSecret } from '../utils/sessionCrypto.js';

export function requireWebSession() {
  return async function requireWebSessionMiddleware(req, res, next) {
    const cfg = req.app?.locals?.cfg;
    const db = req.app?.locals?.db;
    const cookies = parseCookies(req.header('cookie'));
    const token = cookies.bob_web_session;

    const secret = webSessionSigningSecret(cfg);

    let payload;
    try {
      payload = verifyWebSessionToken(secret, token);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }

    if (!payload || !(await isSessionVersionValidLive(payload, db, cfg))) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    req.webSession = payload;
    return next();
  };
}
