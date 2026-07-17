import { verifyBobToken } from '../services/bobTokenService.js';

/**
 * 读取 BOB Token。
 * 安全策略：禁止 query（会进历史/Nginx 日志）；优先 X-BOB-Token；
 * POST 兼容 body.bob_token（旧集成），新调用请只用 Header。
 */
export function extractBobToken(req, { allowBody = true } = {}) {
  const headerToken =
    req.header?.('x-bob-token') ||
    req.headers?.['x-bob-token'] ||
    req.headers?.['X-BOB-Token'];
  if (headerToken) return String(headerToken).trim();
  if (allowBody && req.body?.bob_token) return String(req.body.bob_token).trim();
  return '';
}

export function requireBobToken() {
  return async function requireBobTokenMiddleware(req, res, next) {
    const token = extractBobToken(req, { allowBody: true });
    if (!token) {
      return res.status(401).json({ error: 'missing bob_token', message: '请在 Header 提供 X-BOB-Token' });
    }

    try {
      const db = req.app.locals.db;
      const ok = await verifyBobToken(db, token);
      if (!ok) {
        return res.status(401).json({ error: 'invalid bob_token' });
      }
      req.bobToken = token;
      return next();
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  };
}
