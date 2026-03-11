import { parseCookies } from '../services/adminSession.js';
import { verifyWebSessionToken } from '../services/webSession.js';

export function requireWebSession() {
  return function requireWebSessionMiddleware(req, res, next) {
    const cfg = req.app?.locals?.cfg;
    const cookies = parseCookies(req.header('cookie'));
    const token = cookies.bob_web_session;

    const secret = `${cfg?.webSessionSecret || ''}:${cfg?.sessionSalt || ''}`;

    let payload;
    try {
      payload = verifyWebSessionToken(secret, token);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }

    if (!payload) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    req.webSession = payload;
    return next();
  };
}
