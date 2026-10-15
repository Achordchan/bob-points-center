import { Router } from 'express';
import { fileURLToPath } from 'node:url';
import {
  buildDingtalkOAuthAuthorizeUrl,
  buildJsapiConfig,
  getUserIdByAuthCode,
  getUserIdByOAuthCode,
  getUserProfile,
} from '../services/dingtalkService.js';
import { beginUserSnapshot, persistDingtalkUserDetail } from '../services/dingtalkUserSyncService.js';
import { ensureAccount } from '../services/ledgerService.js';
import { buildClearWebSessionCookie, buildWebSessionCookie, createWebSessionToken } from '../services/webSession.js';
import { cookieOptions, webOAuthSigningSecret, webSessionSigningSecret, withSessionVersion } from '../utils/sessionCrypto.js';
import { getExternalLoginSettings, getSiteVisibilitySettings } from '../services/systemSettings.js';
import { parseCookies } from '../services/adminSession.js';
import { requireWebSession } from '../middleware/requireWebSession.js';
import { requireSiteEnabled } from '../middleware/requireSiteEnabled.js';
import {
  authenticateExternalAccount,
  ExternalAuthError,
  registerExternalAccount,
} from '../services/externalAccountService.js';
import {
  buildClearDingtalkOAuthStateCookie,
  buildDingtalkOAuthStateCookie,
  createDingtalkOAuthState,
  verifyDingtalkOAuthState,
} from '../services/dingtalkOAuthState.js';

const WEB_OAUTH_COOKIE = 'bob_web_oauth_state';

function getWebOAuthSecret(cfg) {
  return webOAuthSigningSecret(cfg);
}

function normalizeMallReturnTo(value) {
  const target = value ? String(value).trim() : '';
  if (!target.startsWith('/') || target.startsWith('//')) return '/mall';
  if (target === '/mall' || target.startsWith('/mall?') || target.startsWith('/mall#')) return target;
  return '/mall';
}

function getOAuthCallbackUrl(cfg, pathname) {
  const baseUrl = cfg?.serverBaseUrl ? String(cfg.serverBaseUrl).trim() : '';
  if (!baseUrl) throw new Error('SERVER_BASE_URL missing');
  return new URL(pathname, baseUrl).toString();
}

function sendOAuthError(res, message, status = 400) {
  const text = String(message || '钉钉登录失败').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  return res.status(status).type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录失败</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#17233d"><main style="width:min(420px,calc(100% - 40px));box-sizing:border-box;padding:28px;border:1px solid #e5e7eb;border-radius:16px;background:#fff"><h1 style="margin:0 0 12px;font-size:22px">钉钉登录未完成</h1><p style="margin:0 0 22px;line-height:1.7;color:#64748b">${text}</p><a href="/mall" style="display:block;padding:12px 16px;border-radius:10px;background:#1677ff;color:#fff;text-align:center;text-decoration:none;font-weight:700">重新登录</a></main></body></html>`);
}

async function establishWebSession(req, res, userid) {
  const cfg = req.app?.locals?.cfg;
  const db = req.app.locals.db;
  const cached = await db.get('SELECT name FROM users WHERE userid = ?', [userid]);
  const cachedName = cached?.name ? String(cached.name) : '';

  let profile;
  try {
    const snapshotVersion = beginUserSnapshot();
    profile = await getUserProfile(cfg, userid);
    if (profile?.raw && profile.freshFetch) {
      // 新人首次进入时补全部门/职位等资料，后台无需再手动同步；失败不影响登录。
      await persistDingtalkUserDetail(db, cfg, profile.raw, { onlyIfStale: true, snapshotVersion }).catch(() => {});
    }
  } catch {
    profile = cachedName ? { userid, name: cachedName, avatar: '' } : null;
  }

  if (!profile?.userid) throw new Error('missing userid');
  const finalUserid = String(profile.userid);
  const finalName = profile?.name ? String(profile.name) : '';
  const finalAvatar = profile?.avatar ? String(profile.avatar) : '';
  await ensureAccount(db, { userid: finalUserid, name: finalName });

  const sessionSecret = webSessionSigningSecret(cfg);
  const sessionTtlSeconds = 86400 * 7;
  const token = createWebSessionToken(
    sessionSecret,
    withSessionVersion({ userid: finalUserid, name: finalName }, cfg),
    sessionTtlSeconds,
  );
  res.setHeader('Set-Cookie', buildWebSessionCookie(token, sessionTtlSeconds, cookieOptions(cfg)));
  return { userid: finalUserid, name: finalName, avatar: finalAvatar };
}

const EXTERNAL_AUTH_STATUS = {
  invalid_phone: 400,
  invalid_name: 400,
  weak_password: 400,
  consent_required: 400,
  phone_registered: 409,
  phone_is_dingtalk_user: 409,
  invalid_credentials: 401,
  register_disabled: 403,
  account_disabled: 403,
  account_locked: 429,
  register_failed: 500,
};

/**
 * 外部账号登录成功后签发与钉钉免登完全相同的 web 会话：
 * 业务侧（商城、核销、拍卖、红包）无需区分账号来源。
 */
function establishExternalWebSession(req, res, { userid, name }) {
  const cfg = req.app?.locals?.cfg;
  const ttlSeconds = 86400 * 7;
  const token = createWebSessionToken(
    webSessionSigningSecret(cfg),
    withSessionVersion({ userid: String(userid), name: String(name || '') }, cfg),
    ttlSeconds,
  );
  res.setHeader('Set-Cookie', buildWebSessionCookie(token, ttlSeconds, cookieOptions(cfg)));
  req.webSession = { userid: String(userid), name: String(name || '') };
  return { userid: String(userid), name: String(name || '') };
}

async function handleExternalAuth(req, res, run) {
  try {
    const payload = await run();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, ...payload });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    if (err instanceof ExternalAuthError) {
      const body = { error: err.code, message: err.message };
      // 手机号属于钉钉在册员工：前端据此提示并引导到钉钉登录。
      if (err.code === 'phone_is_dingtalk_user') body.action = 'dingtalk_login';
      if (err.retry_after) body.retry_after = Number(err.retry_after);
      return res.status(EXTERNAL_AUTH_STATUS[err.code] || 400).json(body);
    }
    return res.status(500).json({ error: 'server_error', message: '服务异常，请稍后重试' });
  }
}

export function webRouter() {
  const router = Router();
  const pagesRoot = fileURLToPath(new URL('../pages/', import.meta.url));

  router.get('/', (_req, res) => {
    res.status(410).type('text').send('该页面已废弃，请使用 /mall');
  });

  // 对外活动登录页（浏览器/微信内打开）：外部用户注册登录，员工走钉钉登录。
  router.get('/login', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.type('html').sendFile('login.html', { root: pagesRoot });
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

  router.get('/site-status', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await getSiteVisibilitySettings(req.app?.locals?.db);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/me', requireWebSession(), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      userid: req.webSession?.userid || '',
      name: req.webSession?.name || '',
      avatar: '',
    });
  });

  router.get('/oauth/start', (req, res) => {
    try {
      const cfg = req.app?.locals?.cfg;
      const returnTo = normalizeMallReturnTo(req.query.redirect);
      const secret = getWebOAuthSecret(cfg);
      const { state, nonce } = createDingtalkOAuthState(secret, { purpose: 'web', returnTo });
      const redirectUri = getOAuthCallbackUrl(cfg, '/web/oauth/callback');
      const authorizeUrl = buildDingtalkOAuthAuthorizeUrl(cfg, { redirectUri, state });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Set-Cookie', buildDingtalkOAuthStateCookie(WEB_OAUTH_COOKIE, nonce, 600, cookieOptions(cfg)));
      return res.redirect(302, authorizeUrl);
    } catch (err) {
      return sendOAuthError(res, String(err?.message || err), 500);
    }
  });

  router.get('/oauth/callback', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const cookies = parseCookies(req.header('cookie'));
    const state = req.query.state ? String(req.query.state) : '';
    const code = req.query.authCode || req.query.code ? String(req.query.authCode || req.query.code) : '';
    const payload = verifyDingtalkOAuthState(getWebOAuthSecret(cfg), state, {
      purpose: 'web',
      nonce: cookies[WEB_OAUTH_COOKIE],
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', buildClearDingtalkOAuthStateCookie(WEB_OAUTH_COOKIE, cookieOptions(cfg)));
    if (!payload || !code) return sendOAuthError(res, '授权状态已失效，请重新登录');

    try {
      const userid = await getUserIdByOAuthCode(cfg, code);
      await establishWebSession(req, res, userid);
      const sessionCookie = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', [
        buildClearDingtalkOAuthStateCookie(WEB_OAUTH_COOKIE, cookieOptions(cfg)),
        sessionCookie,
      ]);
      return res.redirect(302, normalizeMallReturnTo(payload.returnTo));
    } catch (err) {
      return sendOAuthError(res, String(err?.message || err), 502);
    }
  });

  router.get('/auth', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const code = req.query.code ? String(req.query.code) : '';
    if (!code) {
      return res.status(400).json({ error: 'missing code' });
    }

    try {
      const userid = await getUserIdByAuthCode(cfg, code);
      return res.json(await establishWebSession(req, res, userid));
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/logout', (req, res) => {
    const cfg = req.app?.locals?.cfg;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', buildClearWebSessionCookie(cookieOptions(cfg)));
    return res.json({ ok: true });
  });

  router.get('/ext/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const db = req.app?.locals?.db;
      const [external, site] = await Promise.all([
        getExternalLoginSettings(db),
        getSiteVisibilitySettings(db),
      ]);
      const siteEnabled = site?.enabled !== false;
      return res.json({
        ok: true,
        register_enabled: external.enabled === true,
        site_enabled: siteEnabled,
        message: external.message || '',
        site_message: siteEnabled ? '' : String(site?.message || ''),
      });
    } catch (err) {
      // fail-closed：状态读不到时前端按「未开放」处理，登录仍由后端开关兜底。
      return res.status(500).json({ error: 'server_error', message: String(err?.message || err) });
    }
  });

  router.post('/ext/register', requireSiteEnabled(), async (req, res) => {
    const db = req.app?.locals?.db;
    return handleExternalAuth(req, res, async () => {
      const settings = await getExternalLoginSettings(db);
      if (settings.enabled !== true) {
        throw new ExternalAuthError(
          'register_disabled',
          settings.message || '本次活动的自助注册未开放，请联系现场工作人员',
        );
      }
      if (req.body?.consent !== true) {
        throw new ExternalAuthError('consent_required', '请先阅读并同意个人信息收集告知');
      }
      const account = await registerExternalAccount(db, {
        name: req.body?.name,
        phone: req.body?.phone,
        password: req.body?.password,
        batchId: settings.batch_id,
      });
      establishExternalWebSession(req, res, account);
      return { userid: account.userid, name: account.name };
    });
  });

  // 登录不受注册开关影响：活动结束关闭注册后，已注册用户仍可登录兑换。
  router.post('/ext/login', requireSiteEnabled(), async (req, res) => {
    const db = req.app?.locals?.db;
    return handleExternalAuth(req, res, async () => {
      const account = await authenticateExternalAccount(db, {
        phone: req.body?.phone,
        password: req.body?.password,
      });
      establishExternalWebSession(req, res, account);
      return { userid: account.userid, name: account.name };
    });
  });

  return router;
}
