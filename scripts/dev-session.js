#!/usr/bin/env node
/**
 * 本地开发用：签发一张合法的会话 Cookie，绕过钉钉 OAuth 往返。
 *
 * 用法：
 *   node scripts/dev-session.js admin            # 签发管理端会话（取 ADMIN_USERIDS 第一个）
 *   node scripts/dev-session.js web              # 签发员工端会话（取库里第一个用户）
 *   node scripts/dev-session.js admin <userid>   # 指定 userid
 */
import 'dotenv/config';
import { Client } from 'pg';
import { loadConfig } from '../src/config.js';
import { initDb } from '../src/db/init.js';
import { createSessionToken } from '../src/services/adminSession.js';
import { createWebSessionToken } from '../src/services/webSession.js';
import {
  adminSessionSigningSecret,
  refreshSessionGlobalVersion,
  webSessionSigningSecret,
  withSessionVersion,
} from '../src/utils/sessionCrypto.js';

const KIND = (process.argv[2] || '').toLowerCase();
const WANT_USERID = process.argv[3] || '';
const MIN_SECRET_LENGTH = 32;

function refuse(message) {
  console.error(`拒绝执行：${message}`);
  process.exit(1);
}

if (KIND !== 'admin' && KIND !== 'web') {
  refuse('用法：node scripts/dev-session.js <admin|web> [userid]');
}

const cfg = loadConfig();
const expectedDatabase = String(process.env.DEV_SESSION_DATABASE || '').trim();
const configuredDatabase = String(process.env.PG_DATABASE || '').trim();
const host = String(cfg.db?.host || '').trim().toLowerCase();
const sessionSalt = String(process.env.SESSION_SALT || '').trim();
const devSessionSalt = String(process.env.DEV_SESSION_SALT || '').trim();
const adminSecret = String(process.env.ADMIN_SESSION_SECRET || '').trim();
const webSecret = String(process.env.WEB_SESSION_SECRET || '').trim();

if (cfg.nodeEnv !== 'development') {
  refuse(`NODE_ENV 必须明确为 development，当前为 ${cfg.nodeEnv || '空'}。`);
}
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  refuse(`PG_HOST=${host} 不是本地地址。`);
}
if (!configuredDatabase || !expectedDatabase || configuredDatabase !== expectedDatabase) {
  refuse('必须显式配置相同的 PG_DATABASE 与 DEV_SESSION_DATABASE。');
}
if (sessionSalt.length < MIN_SECRET_LENGTH || devSessionSalt !== sessionSalt) {
  refuse(`SESSION_SALT 与 DEV_SESSION_SALT 必须相同，且至少 ${MIN_SECRET_LENGTH} 个字符。`);
}
if (adminSecret.length < MIN_SECRET_LENGTH || webSecret.length < MIN_SECRET_LENGTH || adminSecret === webSecret) {
  refuse(`ADMIN_SESSION_SECRET 与 WEB_SESSION_SECRET 必须分别显式配置、互不相同，且至少 ${MIN_SECRET_LENGTH} 个字符。`);
}

let baseUrl;
try {
  baseUrl = new URL(String(cfg.serverBaseUrl || ''));
} catch {
  refuse('SERVER_BASE_URL 不是合法 URL。');
}
const baseHost = baseUrl.hostname.toLowerCase();
const loopbackBase = ['localhost', '127.0.0.1', '::1'].includes(baseHost);
const developmentDomain = baseHost === 'dev.b.achord.cn';
if ((!loopbackBase && !developmentDomain)
  || !['http:', 'https:'].includes(baseUrl.protocol)
  || (developmentDomain && baseUrl.protocol !== 'https:')
  || baseUrl.username
  || baseUrl.password
  || (baseUrl.pathname && baseUrl.pathname !== '/')
  || baseUrl.search
  || baseUrl.hash) {
  refuse(`SERVER_BASE_URL=${cfg.serverBaseUrl} 不是允许的开发入口。`);
}

const preflight = new Client({
  host: cfg.db.host,
  port: Number(cfg.db.port || 5432),
  database: cfg.db.database,
  user: cfg.db.user,
  password: cfg.db.password,
  ssl: cfg.db.ssl ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  application_name: 'bob-dev-session-preflight',
});
try {
  await preflight.connect();
  await preflight.query('BEGIN READ ONLY');
  const result = await preflight.query(
    "SELECT current_database() AS database, current_setting('bob.environment', true) AS environment",
  );
  const identity = result.rows?.[0] || {};
  if (String(identity.database || '') !== expectedDatabase) {
    throw new Error(`实际数据库 ${identity.database || '未知'} 与预期 ${expectedDatabase} 不一致`);
  }
  if (String(identity.environment || '').trim().toLowerCase() !== 'development') {
    throw new Error('目标 PostgreSQL 未设置 bob.environment=development');
  }
  await preflight.query('ROLLBACK');
} catch (err) {
  console.error(`拒绝执行：开发数据库身份校验失败：${String(err?.message || err)}`);
  process.exitCode = 1;
  try {
    await preflight.query('ROLLBACK');
  } catch {
    // 连接或事务尚未建立
  }
  await preflight.end().catch(() => {});
  process.exit();
}
await preflight.end();

const db = await initDb(cfg);
try {
  await refreshSessionGlobalVersion(db, cfg, { force: true, throwOnError: true });

  let userid = WANT_USERID;
  let name = '';
  if (KIND === 'admin') {
    if (!userid) userid = cfg.adminUserids?.[0] || '';
    if (!userid) throw new Error('未找到管理员 userid：请配置 ADMIN_USERIDS 或在命令行指定。');
  } else if (!userid) {
    const row = await db.get('SELECT userid, name FROM users ORDER BY id LIMIT 1');
    if (!row) throw new Error('users 表为空，请先同步数据或指定 userid。');
    userid = row.userid;
    name = row.name || '';
  }

  if (!name) {
    const row = await db.get('SELECT name FROM users WHERE userid = ?', [userid]);
    name = row?.name || '本地开发';
  }

  const ttl = 8 * 3600;
  let cookieName;
  let token;
  if (KIND === 'admin') {
    cookieName = 'bob_admin_session';
    token = createSessionToken(
      adminSessionSigningSecret(cfg),
      withSessionVersion({ userid, name, mode: 'dingtalk' }, cfg),
      ttl,
    );
  } else {
    cookieName = 'bob_web_session';
    token = createWebSessionToken(
      webSessionSigningSecret(cfg),
      withSessionVersion({ userid, name }, cfg),
      ttl,
    );
  }

  const base = baseUrl.origin;
  console.log(`\n用户：${name} (${userid})`);
  console.log('有效期：8 小时\n');
  console.log('在浏览器打开目标站点后，于 DevTools Console 执行：\n');
  console.log(`document.cookie = ${JSON.stringify(`${cookieName}=${token}; path=/; max-age=${ttl}`)};`);
  console.log(`location.href = ${JSON.stringify(KIND === 'admin' ? `${base}/admin/` : `${base}/mall`)};\n`);
  console.log('或用 curl 直接调接口：\n');
  console.log(`curl -s -b '${cookieName}=${token}' ${base}${KIND === 'admin' ? '/admin/me' : '/web/me'}\n`);
} catch (err) {
  console.error(`拒绝执行：${String(err?.message || err)}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
