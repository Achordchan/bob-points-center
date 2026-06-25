const DEFAULT_NOTIFY_SETTINGS = {
  enabled: true,
  templates: {
    grant: {
      enabled: true,
      title: '【BOB币中心】恭喜你！{{name}}',
      content: '类型：收入\n原因：{{reason}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币',
    },
    deduct: {
      enabled: true,
      title: '【BOB币中心】余额变动通知 {{name}}',
      content: '类型：支出\n原因：{{reason}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币\n单号：{{exchange_id}}',
    },
    redeem: {
      enabled: true,
      title: '【BOB币中心】核销完成 {{name}}',
      content: '商品：{{product_name}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币\n订单号：{{exchange_id}}',
    },
    mall_buy: {
      enabled: true,
      title: '【BOB币中心】下单成功 {{name}}',
      content: '商品：{{product_name}}\n价格：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币\n请尽快联系工作人员线下核销',
    },
    transfer_out: {
      enabled: true,
      title: '【BOB币中心】转账成功 {{name}}',
      content: '转出给：{{to_name}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币',
    },
    transfer_in: {
      enabled: true,
      title: '【BOB币中心】转账到账 {{name}}',
      content: '来自：{{from_name}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币',
    },
    red_packet: {
      enabled: true,
      title: '【BOB币中心】红包到账 {{name}}',
      content: '金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币\n活动ID：{{activity_id}}',
    },
    charity: {
      enabled: true,
      title: '【BOB币中心】公益助力成功 {{name}}',
      content: '类型：支出\n项目：{{project_name}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币',
    },
  },
};

const DEFAULT_GROUP_CARD_SETTINGS = {
  enabled: true,
  channelPresets: [
    { name: 'BOB大群', openConversationId: 'cidxEY0ywSnrjDytDeXzEscwg==' },
    { name: '测试群', openConversationId: 'cidGgW6mYLsdUyYN4rIuPvgYw==' },
  ],
  channel: {
    openConversationId: null,
    cardTemplateId: null,
    operatorUserid: null,
    broadcastAll: null,
    recipients: null,
    titleKey: null,
    contentKey: null,
    searchIcon: null,
  },
  templates: {
    manual: {
      enabled: true,
      title: '{{title}}',
      content: '{{content}}',
      buttons: [
        { text: '去商城', url: 'https://bob.baymaxgroup.com/mall?tab=shop', color: 'blue' },
        { text: '查余额', url: 'https://bob.baymaxgroup.com/mall?tab=balance', color: 'gray' },
      ],
    },
    mall_open: {
      enabled: true,
      title: '【BOB币中心】商城已开启',
      content: '## 商城已开启\n\n- 开启时间：{{open_time}}\n\n现在可以下单啦！',
      buttons: [
        { text: '立刻下单', url: 'https://bob.baymaxgroup.com/mall?tab=shop', color: 'blue' },
        { text: '查余额', url: 'https://bob.baymaxgroup.com/mall?tab=balance', color: 'gray' },
      ],
    },
    mall_open_remind: {
      enabled: true,
      title: '【BOB币中心】即将开启下单',
      content: '## 即将开启下单\n\n- 开启时间：{{open_time}}\n\n请提前准备，下单即将开放。',
      buttons: [
        { text: '去商城看看', url: 'https://bob.baymaxgroup.com/mall?tab=shop', color: 'blue' },
      ],
    },
    mall_close_remind: {
      enabled: true,
      title: '【BOB币中心】商城即将关闭',
      content: '## 即将关闭\n\n- 关闭时间：{{close_time}}\n\n请尽快完成下单。',
      buttons: [
        { text: '抢购！', url: 'https://bob.baymaxgroup.com/mall?tab=shop', color: 'blue' },
      ],
    },
    stock_low: {
      enabled: true,
      title: '【BOB币中心】库存告急：{{product_name}}',
      content: '## 库存快没啦！\n\n- 商品：{{product_name}}\n- 库存：{{stock}}\n\n想要的同学欲购从速，售完为止。',
      buttons: [
        { text: '抢购', url: 'https://bob.baymaxgroup.com/mall?tab=shop', color: 'blue' },
      ],
    },
    stock_soldout: {
      enabled: true,
      title: '【BOB币中心】已售罄：{{product_name}}',
      content: '## 已售罄\n\n- 商品：{{product_name}}\n- 状态：全部卖光啦\n\n感谢支持～',
      buttons: [],
    },
    new_product: {
      enabled: true,
      title: '【BOB币中心】新品上架：{{product_name}}',
      content: '## 新品上架\n\n- 商品：{{product_name}}\n- 价格：{{amount}}\n- 库存：{{stock}}\n\n欢迎在商城下单。',
      buttons: [
        { text: '去下单', url: 'https://bob.baymaxgroup.com/mall?tab=shop', color: 'blue' },
        { text: '查余额', url: 'https://bob.baymaxgroup.com/mall?tab=balance', color: 'gray' },
      ],
    },
  },
};

function toBool(value, fallback) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  const raw = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  if (!raw) return fallback;
  return ['true', 'yes', 'y', 'on'].includes(raw);
}

function normalizeTemplate(input, fallback) {
  const t = input && typeof input === 'object' ? input : {};
  const enabled = toBool(t.enabled, fallback.enabled !== false);
  const title = t.title === null || t.title === undefined ? '' : String(t.title);
  const content = t.content === null || t.content === undefined ? '' : String(t.content);
  return {
    enabled,
    title: title || fallback.title || '',
    content: content || fallback.content || '',
  };
}

export function normalizeNotifySettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  const defaults = DEFAULT_NOTIFY_SETTINGS;
  const templates = {};
  const templateKeys = Object.keys(defaults.templates || {});
  for (const key of templateKeys) {
    templates[key] = normalizeTemplate(src?.templates?.[key], defaults.templates[key]);
  }
  return {
    enabled: toBool(src.enabled, defaults.enabled),
    templates,
  };
}

export async function getNotifySettings(db) {
  if (!db) return DEFAULT_NOTIFY_SETTINGS;
  const row = await db.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', ['notify_settings']);
  if (!row?.value) return DEFAULT_NOTIFY_SETTINGS;
  try {
    const parsed = JSON.parse(String(row.value));
    return normalizeNotifySettings(parsed);
  } catch {
    return DEFAULT_NOTIFY_SETTINGS;
  }
}

export async function saveNotifySettings(db, input) {
  if (!db) return DEFAULT_NOTIFY_SETTINGS;
  const normalized = input?.reset === true
    ? DEFAULT_NOTIFY_SETTINGS
    : normalizeNotifySettings(input);
  await db.exec(
    'INSERT INTO system_settings(key, value, updated_at) VALUES(?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()',
    ['notify_settings', JSON.stringify(normalized)],
  );
  return normalized;
}

export function getDefaultNotifySettings() {
  return DEFAULT_NOTIFY_SETTINGS;
}

function normalizeButtons(value, fallback) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }
  return Array.isArray(fallback) ? fallback : [];
}

function normalizeOptionalText(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim();
}

function normalizeOptionalRecipients(value) {
  if (value === undefined || value === null) return null;
  const source = Array.isArray(value)
    ? value
    : String(value).split(/[\r\n,，]+/g);
  return source
    .map((item) => (item === null || item === undefined ? '' : String(item).trim()))
    .filter((item) => item);
}

function normalizeGroupChannelPresets(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  const seen = new Set();
  return source
    .map((item) => {
      const src = item && typeof item === 'object' ? item : {};
      const openConversationId = normalizeOptionalText(src.openConversationId);
      if (!openConversationId || seen.has(openConversationId)) return null;
      seen.add(openConversationId);
      const name = normalizeOptionalText(src.name) || '未命名群聊';
      return {
        name: name.slice(0, 40),
        openConversationId,
      };
    })
    .filter(Boolean)
    .slice(0, 30);
}

export function normalizeGroupCardSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  const defaults = DEFAULT_GROUP_CARD_SETTINGS.templates || {};
  const nextTemplates = {};
  for (const [key, def] of Object.entries(defaults)) {
    const curr = src?.templates?.[key] && typeof src.templates[key] === 'object' ? src.templates[key] : {};
    nextTemplates[key] = {
      enabled: toBool(curr?.enabled, def.enabled !== false),
      title: curr?.title === null || curr?.title === undefined ? def.title : String(curr.title),
      content: curr?.content === null || curr?.content === undefined ? def.content : String(curr.content),
      buttons: normalizeButtons(curr?.buttons, def.buttons),
    };
  }
  return {
    enabled: toBool(src.enabled, DEFAULT_GROUP_CARD_SETTINGS.enabled),
    channelPresets: normalizeGroupChannelPresets(src.channelPresets, DEFAULT_GROUP_CARD_SETTINGS.channelPresets),
    channel: {
      openConversationId: normalizeOptionalText(src?.channel?.openConversationId),
      cardTemplateId: normalizeOptionalText(src?.channel?.cardTemplateId),
      operatorUserid: normalizeOptionalText(src?.channel?.operatorUserid),
      broadcastAll: typeof src?.channel?.broadcastAll === 'boolean'
        ? src.channel.broadcastAll
        : null,
      recipients: normalizeOptionalRecipients(src?.channel?.recipients),
      titleKey: normalizeOptionalText(src?.channel?.titleKey),
      contentKey: normalizeOptionalText(src?.channel?.contentKey),
      searchIcon: normalizeOptionalText(src?.channel?.searchIcon),
    },
    templates: nextTemplates,
  };
}

export async function getGroupCardSettings(db) {
  if (!db) return DEFAULT_GROUP_CARD_SETTINGS;
  const row = await db.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', ['group_card_settings']);
  if (!row?.value) return DEFAULT_GROUP_CARD_SETTINGS;
  try {
    const parsed = JSON.parse(String(row.value));
    return normalizeGroupCardSettings(parsed);
  } catch {
    return DEFAULT_GROUP_CARD_SETTINGS;
  }
}

export async function saveGroupCardSettings(db, input) {
  if (!db) return DEFAULT_GROUP_CARD_SETTINGS;
  const normalized = input?.reset === true
    ? DEFAULT_GROUP_CARD_SETTINGS
    : normalizeGroupCardSettings(input);
  await db.exec(
    'INSERT INTO system_settings(key, value, updated_at) VALUES(?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()',
    ['group_card_settings', JSON.stringify(normalized)],
  );
  return normalized;
}

// ─── 钉钉连接设置 ────────────────────────────────────────────────────────────

function maskSecret(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!text) return '';
  return text.length <= 8 ? '********' : `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function cleanDingtalkText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

export function normalizeDingtalkConnectionSettings(input = {}, fallback = {}) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    organizationName: cleanDingtalkText(src.organizationName ?? fallback.organizationName),
    corpId: cleanDingtalkText(src.corpId ?? fallback.corpId),
    appKey: cleanDingtalkText(src.appKey ?? fallback.appKey),
    appSecret: cleanDingtalkText(src.appSecret ?? fallback.appSecret),
    agentId: cleanDingtalkText(src.agentId ?? fallback.agentId),
  };
}

export function toPublicDingtalkConnectionSettings(settings = {}) {
  return {
    organizationName: cleanDingtalkText(settings.organizationName),
    corpId: cleanDingtalkText(settings.corpId),
    appKey: cleanDingtalkText(settings.appKey),
    appSecretConfigured: Boolean(cleanDingtalkText(settings.appSecret)),
    appSecretMasked: maskSecret(settings.appSecret),
    agentId: cleanDingtalkText(settings.agentId),
  };
}

export function applyDingtalkConnectionSettings(cfg, settings = {}) {
  if (!cfg) return cfg;
  cfg.dingtalk = {
    ...(cfg.dingtalk || {}),
    corpId: cleanDingtalkText(settings.corpId),
    appKey: cleanDingtalkText(settings.appKey),
    appSecret: cleanDingtalkText(settings.appSecret),
    agentId: cleanDingtalkText(settings.agentId),
    organizationName: cleanDingtalkText(settings.organizationName),
  };
  return cfg;
}

export async function getDingtalkConnectionSettings(db, cfg = {}) {
  const envFallback = normalizeDingtalkConnectionSettings(cfg?.dingtalk || {});
  if (!db) return envFallback;
  const row = await db.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', ['dingtalk_connection_settings']);
  if (!row?.value) return envFallback;
  try {
    const parsed = JSON.parse(String(row.value));
    return normalizeDingtalkConnectionSettings(parsed, envFallback);
  } catch {
    return envFallback;
  }
}

export async function saveDingtalkConnectionSettings(db, input = {}, cfg = {}) {
  const current = await getDingtalkConnectionSettings(db, cfg);
  const src = input && typeof input === 'object' ? input : {};
  const nextInput = {
    organizationName: src.organizationName,
    corpId: src.corpId,
    appKey: src.appKey,
    appSecret: cleanDingtalkText(src.appSecret) ? src.appSecret : current.appSecret,
    agentId: src.agentId,
  };
  const normalized = normalizeDingtalkConnectionSettings(nextInput, current);
  await db.exec(
    'INSERT INTO system_settings(key, value, updated_at) VALUES(?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()',
    ['dingtalk_connection_settings', JSON.stringify(normalized)],
  );
  return normalized;
}

// ─── 打卡奖励设置 ────────────────────────────────────────────────────────────

const DEFAULT_ATTENDANCE_REWARD_SETTINGS = {
  enabled: false,
  testMode: false,
  workStartTime: '08:30',
  lateGraceMinutes: 0,
  rewardMin: 1,
  rewardMax: 5,
  maxPerDay: 1,
  onlyCheckin: true,
  departmentMode: 'all',
  departmentIds: [],
  departmentExpandedIds: [],
  reason: '打卡奖励',
};

function normalizeDepartmentMode(value) {
  const mode = value === null || value === undefined ? '' : String(value).trim();
  return mode === 'selected' ? 'selected' : 'all';
}

function normalizeDepartmentIds(value) {
  const raw = Array.isArray(value) ? value : [];
  return Array.from(new Set(raw
    .map((id) => (id === null || id === undefined ? '' : String(id).trim()))
    .filter((id) => /^\d+$/.test(id))));
}

function toPositiveIntSetting(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) return n;
  return fallback;
}

export function normalizeAttendanceRewardSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  const def = DEFAULT_ATTENDANCE_REWARD_SETTINGS;
  return {
    enabled: toBool(src.enabled, def.enabled),
    testMode: toBool(src.testMode, def.testMode),
    workStartTime: typeof src.workStartTime === 'string' && /^\d{1,2}:\d{2}$/.test(src.workStartTime.trim())
      ? src.workStartTime.trim()
      : def.workStartTime,
    lateGraceMinutes: toPositiveIntSetting(src.lateGraceMinutes, def.lateGraceMinutes),
    rewardMin: toPositiveIntSetting(src.rewardMin, def.rewardMin),
    rewardMax: toPositiveIntSetting(src.rewardMax, def.rewardMax),
    maxPerDay: toPositiveIntSetting(src.maxPerDay, def.maxPerDay),
    onlyCheckin: toBool(src.onlyCheckin, def.onlyCheckin),
    departmentMode: normalizeDepartmentMode(src.departmentMode),
    departmentIds: normalizeDepartmentIds(src.departmentIds),
    departmentExpandedIds: normalizeDepartmentIds(src.departmentExpandedIds),
    reason: src.reason && String(src.reason).trim() ? String(src.reason).trim() : def.reason,
  };
}

export async function getAttendanceRewardSettings(db) {
  if (!db) return { ...DEFAULT_ATTENDANCE_REWARD_SETTINGS };
  const row = await db.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', ['attendance_reward_settings']);
  if (!row?.value) return { ...DEFAULT_ATTENDANCE_REWARD_SETTINGS };
  try {
    const parsed = JSON.parse(String(row.value));
    return normalizeAttendanceRewardSettings(parsed);
  } catch {
    return { ...DEFAULT_ATTENDANCE_REWARD_SETTINGS };
  }
}

export async function saveAttendanceRewardSettings(db, input) {
  if (!db) return { ...DEFAULT_ATTENDANCE_REWARD_SETTINGS };
  const normalized = input?.reset === true
    ? { ...DEFAULT_ATTENDANCE_REWARD_SETTINGS }
    : normalizeAttendanceRewardSettings(input);
  await db.exec(
    'INSERT INTO system_settings(key, value, updated_at) VALUES(?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()',
    ['attendance_reward_settings', JSON.stringify(normalized)],
  );
  return normalized;
}

export function getDefaultAttendanceRewardSettings() {
  return { ...DEFAULT_ATTENDANCE_REWARD_SETTINGS };
}
