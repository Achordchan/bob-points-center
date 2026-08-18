import { Router } from 'express';
import { buildSessionCookie, createSessionToken } from '../services/adminSession.js';
import { buildWebSessionCookie, createWebSessionToken } from '../services/webSession.js';
import {
  adminSessionSigningSecret,
  cookieOptions,
  webSessionSigningSecret,
  withSessionVersion,
} from '../utils/sessionCrypto.js';

const TEST_ACCOUNTS = Object.freeze({
  'user-1': { userid: 'local_test_user_1', name: '测试用户一', isAdmin: false, initialBalance: 1000 },
  'user-2': { userid: 'local_test_user_2', name: '测试用户二', isAdmin: false, initialBalance: 1000 },
  admin: { userid: 'local_test_admin', name: '本地管理员', isAdmin: true, initialBalance: 1000 },
});

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MIN_SECRET_LENGTH = 32;

function isLoopbackHost(value) {
  return LOOPBACK_HOSTS.has(String(value || '').trim().toLowerCase());
}

export function isLoopbackSocketAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return isLoopbackHost(address) || address === '::ffff:127.0.0.1';
}

function isAllowedOrigin(value) {
  if (!value) return true;
  try {
    return isLoopbackHost(new URL(String(value)).hostname);
  } catch {
    return false;
  }
}

export function shouldEnableLocalDevAuth(cfg) {
  if (!cfg?.localDevAuthEnabled || cfg?.nodeEnv !== 'development') return false;
  if (!isLoopbackHost(cfg?.db?.host)) return false;
  if (!cfg?.devSessionDatabase || cfg.devSessionDatabase !== cfg?.db?.database) return false;

  let baseUrl;
  try {
    baseUrl = new URL(String(cfg?.serverBaseUrl || ''));
  } catch {
    return false;
  }
  if (!isLoopbackHost(baseUrl.hostname) || baseUrl.protocol !== 'http:') return false;

  const adminSecret = String(cfg?.adminSessionSecret || '');
  const webSecret = String(cfg?.webSessionSecret || '');
  return adminSecret.length >= MIN_SECRET_LENGTH
    && webSecret.length >= MIN_SECRET_LENGTH
    && adminSecret !== webSecret;
}

async function assertDevelopmentDatabase(db, cfg) {
  const row = await db.get(
    "SELECT current_database() AS database, current_setting('bob.environment', true) AS environment",
  );
  if (String(row?.database || '') !== String(cfg?.devSessionDatabase || '')) {
    throw new Error('开发数据库名称校验失败');
  }
  if (String(row?.environment || '').trim().toLowerCase() !== 'development') {
    throw new Error('数据库未标记为 development');
  }
}

async function ensureTestAccount(db, account) {
  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO users(userid, name, is_admin)
       VALUES(?, ?, ?)
       ON CONFLICT(userid) DO UPDATE SET name = EXCLUDED.name, is_admin = EXCLUDED.is_admin`,
      [account.userid, account.name, account.isAdmin ? 1 : 0],
    );
    await tx.run(
      `INSERT INTO accounts(userid, balance, updated_at)
       VALUES(?, ?, unixepoch())
       ON CONFLICT(userid) DO NOTHING`,
      [account.userid, account.initialBalance],
    );
  });
}

function renderLoginPage() {
  const buttons = Object.entries(TEST_ACCOUNTS).map(([key, account]) => `
    <form method="post" action="/__dev/login/${key}">
      <button type="submit">
        <strong>${account.name}</strong>
        <span>${account.userid}${account.isAdmin ? ' · 管理端' : ' · 员工端'}</span>
      </button>
    </form>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>本地测试登录</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fa;color:#17233d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.dev-login{width:min(440px,calc(100% - 32px));padding:28px;border:1px solid #e5e7eb;border-radius:14px;background:#fff}.dev-login h1{margin:0 0 8px;font-size:24px}.dev-login p{margin:0 0 22px;color:#64748b;line-height:1.6}.dev-login form+form{margin-top:12px}.dev-login button{width:100%;padding:14px 16px;border:1px solid #dbe2ea;border-radius:10px;background:#fff;color:inherit;text-align:left;cursor:pointer}.dev-login button:hover{border-color:#1677ff;background:#f0f7ff}.dev-login strong,.dev-login span{display:block}.dev-login strong{font-size:16px}.dev-login span{margin-top:5px;color:#64748b;font-size:13px}
  </style>
</head>
<body>
  <main class="dev-login">
    <h1>本地测试登录</h1>
    <p>选择账号后将写入本地会话 Cookie，不会请求钉钉授权。</p>
    ${buttons}
  </main>
</body>
</html>`;
}

export function devAuthRouter() {
  const router = Router();

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!isLoopbackSocketAddress(req.socket?.remoteAddress)) {
      return res.status(403).json({ error: '本地测试登录仅允许本机访问' });
    }
    if (!isAllowedOrigin(req.get('origin'))) {
      return res.status(403).json({ error: '请求来源不是本地地址' });
    }
    return next();
  });

  router.get('/login', async (req, res) => {
    try {
      await assertDevelopmentDatabase(req.app.locals.db, req.app.locals.cfg);
      return res.type('html').send(renderLoginPage());
    } catch (err) {
      return res.status(503).json({ error: String(err?.message || err) });
    }
  });

  router.post('/login/:account', async (req, res) => {
    const account = TEST_ACCOUNTS[String(req.params.account || '')];
    if (!account) return res.status(404).json({ error: '测试账号不存在' });

    const cfg = req.app.locals.cfg;
    const db = req.app.locals.db;
    try {
      await assertDevelopmentDatabase(db, cfg);
      await ensureTestAccount(db, account);

      if (account.isAdmin) {
        const token = createSessionToken(
          adminSessionSigningSecret(cfg),
          withSessionVersion({ userid: account.userid, name: account.name, mode: 'local-dev' }, cfg),
          8 * 3600,
        );
        res.setHeader('Set-Cookie', buildSessionCookie(token, cookieOptions(cfg)));
        return res.redirect(303, '/admin/home');
      }

      const ttl = 8 * 3600;
      const token = createWebSessionToken(
        webSessionSigningSecret(cfg),
        withSessionVersion({ userid: account.userid, name: account.name }, cfg),
        ttl,
      );
      res.setHeader('Set-Cookie', buildWebSessionCookie(token, ttl, cookieOptions(cfg)));
      return res.redirect(303, '/mall');
    } catch (err) {
      return res.status(503).json({ error: String(err?.message || err) });
    }
  });

  return router;
}

export { TEST_ACCOUNTS };
