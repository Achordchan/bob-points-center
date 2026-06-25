import { parseCookies, verifySessionToken } from '../services/adminSession.js';
import { getAdminAccess } from '../services/adminPermissionService.js';

export function requireAdminSession() {
  return async function requireAdminSessionMiddleware(req, res, next) {
    const cfg = req.app?.locals?.cfg;
    const cookies = parseCookies(req.header('cookie'));
    const token = cookies.bob_admin_session;

    const secret = `${cfg?.adminSessionSecret || ''}:${cfg?.sessionSalt || ''}`;

    let payload;
    try {
      payload = verifySessionToken(secret, token);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }

    if (!payload) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      req.adminSession = payload;
      if (!req.adminAccess) {
        req.adminAccess = await getAdminAccess(req.app?.locals?.db, cfg, payload);
      }
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }

    return next();
  };
}
