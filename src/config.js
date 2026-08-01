import dotenv from 'dotenv';

function toBool(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

export function loadConfig() {
  dotenv.config();

  // 不再内置固定超级管理员。生产必须显式配置 ADMIN_USERIDS。
  const adminFallbackUserid = (process.env.ADMIN_FALLBACK_USERID || '').trim();
  const adminUserids = (process.env.ADMIN_USERIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (adminFallbackUserid && !adminUserids.includes(adminFallbackUserid)) {
    adminUserids.push(adminFallbackUserid);
  }
  // 仅在明确 production 时强制要求；本地未设 NODE_ENV 可空跑，但无硬编码超管。
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv === 'production' && adminUserids.length === 0) {
    throw new Error('生产环境必须配置 ADMIN_USERIDS（超级管理员名单），已取消内置默认 userid');
  }

  const dbKind = (process.env.DB_KIND || 'postgres').trim().toLowerCase();
  const pgSsl = toBool(process.env.PG_SSL, false);

  // 会话与 Cookie：sessionSalt 已废弃，签名仅依赖稳定 secret。
  // Secure 判定：显式 COOKIE_SECURE > HTTPS 的 SERVER_BASE_URL > NODE_ENV=production。
  // 宝塔反代 HTTPS 时即使 NODE_ENV 为空，也不应发出可被 HTTP 窃听的会话 Cookie。
  const serverBaseUrl = process.env.SERVER_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8000}`;
  const baseIsHttps = /^https:\/\//i.test(String(serverBaseUrl).trim());
  const cookieSecureEnv = process.env.COOKIE_SECURE;
  let cookieSecure;
  if (cookieSecureEnv !== undefined && cookieSecureEnv !== '') {
    cookieSecure = toBool(cookieSecureEnv, false);
  } else {
    cookieSecure = nodeEnv === 'production' || baseIsHttps;
  }

  const trustProxy = toBool(process.env.TRUST_PROXY, baseIsHttps || nodeEnv === 'production');

  return {
    port: Number(process.env.PORT || 8000),
    nodeEnv,
    cookieSecure,
    trustProxy,
    // 启动时由 index 从 DB 载入；此处默认 0
    sessionGlobalVersion: 0,
    // 可选会话轮换盐（稳定配置，不再启动时随机）；默认空
    sessionSalt: (process.env.SESSION_SALT || '').trim(),
    serverBaseUrl,
    db: {
      kind: dbKind === 'postgres' ? 'postgres' : dbKind,
      host: process.env.PG_HOST || '127.0.0.1',
      port: Number(process.env.PG_PORT || 5432),
      database: process.env.PG_DATABASE || 'bob',
      user: process.env.PG_USER || 'bob',
      password: process.env.PG_PASSWORD || 'bob123456',
      ssl: pgSsl,
      poolMax: Number(process.env.PG_POOL_MAX || 20),
    },
    qrSignSecret: process.env.QR_SIGN_SECRET || '',
    mallAiTable: {
      baseId: process.env.AI_TABLE_BASE_ID || '',
      sheetIdOrName: process.env.AI_TABLE_SHEET_ID_OR_NAME || '',
      operatorId: process.env.AI_TABLE_OPERATOR_ID || '',
    },
    adminUserids,
    adminFallbackUserid,
    adminFallbackName: (process.env.ADMIN_FALLBACK_NAME || '').trim(),
    adminSessionSecret: (() => {
      const secret = process.env.ADMIN_SESSION_SECRET || '';
      if (nodeEnv === 'production' && !String(secret).trim()) {
        throw new Error('生产环境必须配置 ADMIN_SESSION_SECRET');
      }
      return secret;
    })(),
    webSessionSecret: (() => {
      const adminSecret = String(process.env.ADMIN_SESSION_SECRET || '').trim();
      const webSecret = String(process.env.WEB_SESSION_SECRET || '').trim();
      if (nodeEnv === 'production') {
        if (!webSecret) {
          throw new Error('生产环境必须配置 WEB_SESSION_SECRET，禁止回退到 ADMIN_SESSION_SECRET');
        }
        if (webSecret === adminSecret) {
          throw new Error('生产环境 WEB_SESSION_SECRET 必须与 ADMIN_SESSION_SECRET 不同');
        }
        return webSecret;
      }
      // 本地开发：未配置 WEB_SESSION_SECRET 时才回退；Token 仍带 aud 域隔离。
      return webSecret || adminSecret || '';
    })(),
    dingtalk: {
      corpId: process.env.DINGTALK_CORP_ID || '',
      appKey: process.env.DINGTALK_APP_KEY || '',
      appSecret: process.env.DINGTALK_APP_SECRET || '',
      agentId: process.env.DINGTALK_AGENT_ID || '',
      robotCode: process.env.DINGTALK_ROBOT_CODE || '',
      robotNotifyEnabled: toBool(process.env.DINGTALK_ROBOT_NOTIFY_ENABLED, true),
      streamEnabled: toBool(process.env.DINGTALK_STREAM_ENABLED, true),

      groupCardNotifyEnabled: toBool(process.env.DINGTALK_GROUP_CARD_NOTIFY_ENABLED, undefined),
      groupOpenConversationId: process.env.DINGTALK_GROUP_OPEN_CONVERSATION_ID || '',
      groupCardTemplateId: process.env.DINGTALK_GROUP_CARD_TEMPLATE_ID || '',
      groupCardOperatorUserid: process.env.DINGTALK_GROUP_CARD_OPERATOR_USERID || '',
      groupCardBroadcastAll: toBool(process.env.DINGTALK_GROUP_CARD_BROADCAST_ALL, false),
      groupCardRecipients: (process.env.DINGTALK_GROUP_CARD_RECIPIENTS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      groupCardTitleKey: process.env.DINGTALK_GROUP_CARD_TITLE_KEY || '',
      groupCardContentKey: process.env.DINGTALK_GROUP_CARD_CONTENT_KEY || '',
      groupCardSearchIcon: process.env.DINGTALK_GROUP_CARD_SEARCH_ICON || '',
    },
  };
}
