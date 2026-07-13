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

  const adminFallbackUserid = (process.env.ADMIN_FALLBACK_USERID || '021444176521-1423302501').trim();
  const adminUserids = (process.env.ADMIN_USERIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (adminFallbackUserid && !adminUserids.includes(adminFallbackUserid)) {
    adminUserids.push(adminFallbackUserid);
  }

  const dbKind = (process.env.DB_KIND || 'postgres').trim().toLowerCase();
  const pgSsl = toBool(process.env.PG_SSL, false);

  return {
    port: Number(process.env.PORT || 8000),
    serverBaseUrl: process.env.SERVER_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8000}`,
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
    adminSessionSecret: process.env.ADMIN_SESSION_SECRET || '',
    webSessionSecret: process.env.WEB_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET || '',
    dingtalk: {
      corpId: process.env.DINGTALK_CORP_ID || '',
      appKey: process.env.DINGTALK_APP_KEY || '',
      appSecret: process.env.DINGTALK_APP_SECRET || '',
      agentId: process.env.DINGTALK_AGENT_ID || '',
      robotCode: process.env.DINGTALK_ROBOT_CODE || '',
      robotNotifyEnabled: toBool(process.env.DINGTALK_ROBOT_NOTIFY_ENABLED, true),

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
