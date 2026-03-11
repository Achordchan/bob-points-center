import { Router } from 'express';
import { buildJsapiConfig, getUserIdByAuthCode, getUserProfile } from '../services/dingtalkService.js';
import { ensureAccount } from '../services/ledgerService.js';
import { buildClearWebSessionCookie, buildWebSessionCookie, createWebSessionToken } from '../services/webSession.js';

export function webRouter() {
  const router = Router();

  router.get('/', (_req, res) => {
    res.status(410).type('text').send('该页面已废弃，请使用 /mall');
  });

  router.get('/config', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const url = req.query.url ? String(req.query.url) : '';
    if (!url) {
      return res.status(400).json({ error: 'missing url' });
    }

    try {
      const result = await buildJsapiConfig(cfg, url);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/auth', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const code = req.query.code ? String(req.query.code) : '';
    if (!code) {
      return res.status(400).json({ error: 'missing code' });
    }

    try {
      const db = req.app.locals.db;
      const userid = await getUserIdByAuthCode(cfg, code);

      const sessionSecret = `${cfg?.webSessionSecret || ''}:${cfg?.sessionSalt || ''}`;
      const sessionTtlSeconds = 86400 * 7;

      const cached = await db.get('SELECT name FROM users WHERE userid = ?', [userid]);
      const cachedName = cached?.name ? String(cached.name) : '';

      let profile;
      try {
        profile = await getUserProfile(cfg, userid);
      } catch {
        profile = cachedName ? { userid, name: cachedName, avatar: '' } : null;
      }

      if (!profile?.userid) {
        return res.status(500).json({ error: 'missing userid' });
      }

      const finalUserid = String(profile.userid);
      const finalName = profile?.name ? String(profile.name) : '';
      const finalAvatar = profile?.avatar ? String(profile.avatar) : '';
      await ensureAccount(db, { userid: finalUserid, name: finalName });

      const token = createWebSessionToken(sessionSecret, { userid: finalUserid, name: finalName }, sessionTtlSeconds);
      res.setHeader('Set-Cookie', buildWebSessionCookie(token, sessionTtlSeconds));

      return res.json({ userid: finalUserid, name: finalName, avatar: finalAvatar });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/logout', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', buildClearWebSessionCookie());
    return res.json({ ok: true });
  });

  return router;
}
