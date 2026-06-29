import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

import { buildOpenApiSpec, swaggerUiOptions } from '../docs/swagger.js';
import { parseCookies, verifySessionToken } from '../services/adminSession.js';
import { getAdminAccess } from '../services/adminPermissionService.js';

function getBaseUrl(req) {
  const cfg = req.app?.locals?.cfg;
  return cfg?.serverBaseUrl || `${req.protocol}://${req.get('host')}`;
}

function isDocsPageRequest(req) {
  const path = String(req.path || '');
  return req.method === 'GET' && (path === '/' || path === '');
}

function requireDocsAdminSession() {
  return async function requireDocsAdminSessionMiddleware(req, res, next) {
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
      if (isDocsPageRequest(req)) {
        return res.redirect(302, '/admin/login?redirect=%2Fdocs%2F');
      }
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      req.adminSession = payload;
      req.adminAccess = await getAdminAccess(req.app?.locals?.db, cfg, payload);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }

    return next();
  };
}

export function docsRouter() {
  const router = Router();
  const requireDocsAdmin = requireDocsAdminSession();

  router.get('/openapi.json', requireDocsAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(buildOpenApiSpec({ baseUrl: getBaseUrl(req) }));
  });

  router.use('/docs', requireDocsAdmin, swaggerUi.serve, swaggerUi.setup(null, swaggerUiOptions));

  return router;
}
