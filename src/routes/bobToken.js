import { Router } from 'express';

import { requireAdminSession } from '../middleware/requireAdminSession.js';
import { createBobToken, deleteBobToken, listBobTokens, revokeBobToken } from '../services/bobTokenService.js';
import { getAdminAccess, hasAdminPermission } from '../services/adminPermissionService.js';


function requireIntegrationPermission(permission) {
  return async (req, res, next) => {
    try {
      if (!req.adminAccess) {
        req.adminAccess = await getAdminAccess(req.app?.locals?.db, req.app?.locals?.cfg, req.adminSession || {});
      }
      if (!hasAdminPermission(req.adminAccess, permission)) {
        return res.status(403).json({ error: '权限不足，无法执行该操作' });
      }
      return next();
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  };
}

export function bobTokenRouter() {
  const router = Router();

  router.get('/list', requireAdminSession(), requireIntegrationPermission('integrations:view'), async (req, res) => {
    try {
      const db = req.app.locals.db;
      const includeRevoked = req.query.includeRevoked !== '0' && req.query.includeRevoked !== 'false';
      const limit = req.query.limit;
      const rows = await listBobTokens(db, { includeRevoked, limit });
      return res.json({ ok: true, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/create', requireAdminSession(), requireIntegrationPermission('integrations:edit'), async (req, res) => {
    try {
      const db = req.app.locals.db;
      const result = await createBobToken(db);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/revoke', requireAdminSession(), requireIntegrationPermission('integrations:edit'), async (req, res) => {
    try {
      const db = req.app.locals.db;
      const id = req.body?.tokenId;
      const result = await revokeBobToken(db, id);
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      const status = message === 'invalid token id' ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.post('/delete', requireAdminSession(), requireIntegrationPermission('integrations:edit'), async (req, res) => {
    try {
      const db = req.app.locals.db;
      const id = req.body?.tokenId;
      const result = await deleteBobToken(db, id);
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      const status = ['invalid token id', 'token not found', 'token must be revoked before delete'].includes(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  return router;
}
