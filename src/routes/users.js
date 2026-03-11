import { Router } from 'express';

import { requireBobToken } from '../middleware/requireBobToken.js';

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function usersRouter() {
  const router = Router();

  router.post('/list', requireBobToken(), async (req, res) => {
    const db = req.app?.locals?.db;
    const keyword = req.body?.keyword ? String(req.body.keyword).trim() : '';
    const page = toPositiveInt(req.body?.page, 1);
    const pageSize = Math.min(100, toPositiveInt(req.body?.pageSize, 30));
    const offset = (page - 1) * pageSize;

    try {
      const where = [];
      const params = [];
      if (keyword) {
        where.push('(u.userid LIKE ? OR u.name LIKE ?)');
        const kw = `%${keyword}%`;
        params.push(kw, kw);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const totalRow = await db.get(`SELECT COUNT(1) AS c FROM users u ${whereSql}`, params);
      const total = Number(totalRow?.c) || 0;

      const rows = await db.all(
        `SELECT u.userid, u.name, u.is_admin, u.created_at, COALESCE(a.balance, 0) AS balance, a.updated_at
         FROM users u
         LEFT JOIN accounts a ON a.userid = u.userid
         ${whereSql}
         ORDER BY (u.name IS NULL), u.name COLLATE NOCASE, u.userid COLLATE NOCASE
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset],
      );

      return res.json({
        ok: true,
        page,
        pageSize,
        total,
        data: rows || [],
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  return router;
}
