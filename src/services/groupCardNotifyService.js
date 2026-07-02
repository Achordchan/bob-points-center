import { createRequire } from 'node:module';

import { getV1AccessToken } from './dingtalkService.js';
import { getGroupCardSettings } from './systemSettings.js';
import { safeAppendAuditLog } from './auditLogService.js';

const require = createRequire(import.meta.url);

const Util = require('@alicloud/tea-util');
const dingtalkcard_1_0 = require('@alicloud/dingtalk/card_1_0');
const OpenApi = require('@alicloud/openapi-client');

class DingtalkCardError extends Error {
  constructor(message, { code, data } = {}) {
    super(message);
    this.name = 'DingtalkCardError';
    this.code = code;
    this.data = data;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

let notifyQueue = Promise.resolve();

function enqueueNotify(fn, { onError } = {}) {
  notifyQueue = notifyQueue
    .then(fn)
    .catch(async (err) => {
      if (typeof onError === 'function') {
        await onError(err);
      }
    });
  return notifyQueue;
}

async function sendWithRetry(sendFn) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await sendFn();
    } catch (err) {
      const code = err instanceof DingtalkCardError ? String(err.code || '') : '';
      const retryable = code === 'TooManyRequests' || code === 'Throttling' || code === 'ServiceUnavailable';
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }
      const backoffMs = 300 * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
  }
  return null;
}

function isGroupCardNotifyEnabled(cfg) {
  if (cfg?.dingtalk?.groupCardNotifyEnabled === true) return true;
  if (cfg?.dingtalk?.groupCardNotifyEnabled === false) return false;
  const openConversationId = cfg?.dingtalk?.groupOpenConversationId ? String(cfg.dingtalk.groupOpenConversationId).trim() : '';
  const templateId = cfg?.dingtalk?.groupCardTemplateId ? String(cfg.dingtalk.groupCardTemplateId).trim() : '';
  return Boolean(openConversationId && templateId);
}

function renderVars(template, vars) {
  const source = template === null || template === undefined ? '' : String(template);
  const map = vars && typeof vars === 'object' ? vars : {};
  return source.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key) => {
    const v = map[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

function convertJSONValuesToString(obj) {
  const raw = obj && typeof obj === 'object' ? obj : {};
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      result[key] = value;
    } else {
      try {
        result[key] = JSON.stringify(value);
      } catch {
        result[key] = '';
      }
    }
  }
  return result;
}

function createClient() {
  const config = new OpenApi.Config({});
  config.protocol = 'https';
  config.regionId = 'central';
  return new dingtalkcard_1_0.default(config);
}

function toOutTrackId(prefix) {
  const p = String(prefix || 'CARD').replace(/[^a-zA-Z0-9_\-]/g, '_');
  return `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRecipients(value) {
  const arr = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[\r\n,，]+/g) : []);
  return arr
    .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
    .filter((x) => x);
}

function pickChannelValue(overrideValue, fallbackValue) {
  return overrideValue === null || overrideValue === undefined ? fallbackValue : overrideValue;
}

export function resolveGroupCardChannel(cfg, settings = {}) {
  const channel = settings?.channel && typeof settings.channel === 'object' ? settings.channel : {};
  return {
    openConversationId: pickChannelValue(
      channel.openConversationId,
      cfg?.dingtalk?.groupOpenConversationId ? String(cfg.dingtalk.groupOpenConversationId).trim() : '',
    ),
    cardTemplateId: pickChannelValue(
      channel.cardTemplateId,
      cfg?.dingtalk?.groupCardTemplateId ? String(cfg.dingtalk.groupCardTemplateId).trim() : '',
    ),
    operatorUserid: pickChannelValue(
      channel.operatorUserid,
      cfg?.dingtalk?.groupCardOperatorUserid
        ? String(cfg.dingtalk.groupCardOperatorUserid).trim()
        : (cfg?.adminFallbackUserid ? String(cfg.adminFallbackUserid).trim() : ''),
    ),
    broadcastAll: typeof channel.broadcastAll === 'boolean'
      ? channel.broadcastAll
      : (cfg?.dingtalk?.groupCardBroadcastAll === true),
    recipients: channel.recipients === null || channel.recipients === undefined
      ? normalizeRecipients(cfg?.dingtalk?.groupCardRecipients)
      : normalizeRecipients(channel.recipients),
    titleKey: pickChannelValue(
      channel.titleKey,
      cfg?.dingtalk?.groupCardTitleKey ? String(cfg.dingtalk.groupCardTitleKey).trim() : '',
    ),
    contentKey: pickChannelValue(
      channel.contentKey,
      cfg?.dingtalk?.groupCardContentKey ? String(cfg.dingtalk.groupCardContentKey).trim() : 'spyj_neirong',
    ),
    searchIcon: pickChannelValue(
      channel.searchIcon,
      cfg?.dingtalk?.groupCardSearchIcon ? String(cfg.dingtalk.groupCardSearchIcon).trim() : '',
    ),
  };
}

export function buildEffectiveGroupCardSettings(cfg, settings = {}) {
  return {
    ...(settings && typeof settings === 'object' ? settings : {}),
    channel: resolveGroupCardChannel(cfg, settings),
  };
}

export function mergeGroupCardChannelIntoCfg(cfg, settings = {}) {
  const channel = resolveGroupCardChannel(cfg, settings);
  return {
    ...(cfg && typeof cfg === 'object' ? cfg : {}),
    dingtalk: {
      ...(cfg?.dingtalk && typeof cfg.dingtalk === 'object' ? cfg.dingtalk : {}),
      groupCardNotifyEnabled: settings?.enabled !== false,
      groupOpenConversationId: channel.openConversationId,
      groupCardTemplateId: channel.cardTemplateId,
      groupCardOperatorUserid: channel.operatorUserid,
      groupCardBroadcastAll: channel.broadcastAll === true,
      groupCardRecipients: channel.recipients,
      groupCardTitleKey: channel.titleKey,
      groupCardContentKey: channel.contentKey,
      groupCardSearchIcon: channel.searchIcon,
    },
  };
}


function cleanOneLineText(value, maxLen) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.replace(/[\r\n]+/g, ' ').trim().slice(0, Math.max(0, Number(maxLen) || 0));
}

function cleanMarkdown(value, maxLen) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.trim().slice(0, Math.max(0, Number(maxLen) || 0));
}

function isBadLocalUrl(url) {
  const u = String(url || '').trim();
  if (!u) return true;
  if (!(u.startsWith('http://') || u.startsWith('https://'))) return true;
  const lower = u.toLowerCase();
  if (lower.includes('127.0.0.1') || lower.includes('localhost') || lower.includes('0.0.0.0')) return true;
  return false;
}

export async function sendGroupInteractiveCard(cfg, {
  title,
  markdown,
  cardParamKey,
  outTrackId,
  openConversationId,
  cardTemplateId,
  operatorUserid,
  recipients,
  buttons,
  imageUrl,
} = {}) {
  const robotCode = cfg?.dingtalk?.robotCode ? String(cfg.dingtalk.robotCode).trim() : '';
  if (!robotCode) {
    throw new Error('DINGTALK_ROBOT_CODE missing');
  }

  const conv = openConversationId
    ? String(openConversationId).trim()
    : (cfg?.dingtalk?.groupOpenConversationId ? String(cfg.dingtalk.groupOpenConversationId).trim() : '');
  if (!conv) {
    throw new Error('DINGTALK_GROUP_OPEN_CONVERSATION_ID missing');
  }

  const tpl = cardTemplateId
    ? String(cardTemplateId).trim()
    : (cfg?.dingtalk?.groupCardTemplateId ? String(cfg.dingtalk.groupCardTemplateId).trim() : '');
  if (!tpl) {
    throw new Error('DINGTALK_GROUP_CARD_TEMPLATE_ID missing');
  }

  const op = operatorUserid
    ? String(operatorUserid).trim()
    : (
        cfg?.dingtalk?.groupCardOperatorUserid
          ? String(cfg.dingtalk.groupCardOperatorUserid).trim()
          : (cfg?.adminFallbackUserid ? String(cfg.adminFallbackUserid).trim() : '')
      );
  if (!op) {
    throw new Error('DINGTALK_GROUP_CARD_OPERATOR_USERID missing');
  }

  const recips = normalizeRecipients(recipients && recipients.length ? recipients : cfg?.dingtalk?.groupCardRecipients);
  const broadcastAll = cfg?.dingtalk?.groupCardBroadcastAll === true;
  const deliverRecipients = broadcastAll ? [] : (recips.length ? recips : [op]);

  const token = await getV1AccessToken(cfg);

  const client = createClient();
  const headers = new dingtalkcard_1_0.CreateAndDeliverHeaders({});
  headers.xAcsDingtalkAccessToken = token;

  const mdBase = cleanMarkdown(markdown, 6000);
  const rawImg = imageUrl ? String(imageUrl).trim() : '';
  const img = rawImg && !isBadLocalUrl(rawImg) ? rawImg : '';
  const md = img ? cleanMarkdown(`${mdBase}\n\n![](${img})`, 6500) : mdBase;

  const titleText = cleanOneLineText(title, 120);

  const titleKey = cfg?.dingtalk?.groupCardTitleKey ? String(cfg.dingtalk.groupCardTitleKey).trim() : '';
  const contentKey = cardParamKey
    ? String(cardParamKey).trim()
    : (cfg?.dingtalk?.groupCardContentKey ? String(cfg.dingtalk.groupCardContentKey).trim() : 'spyj_neirong');

  function toFullButton(btn) {
    if (!btn || typeof btn !== 'object') return null;
    if (btn.event && btn.event.type) return btn;
    const text = btn.text ? String(btn.text).trim() : '';
    const url = btn.url ? String(btn.url).trim() : '';
    const color = btn.color ? String(btn.color).trim() : 'blue';
    const status = btn.status ? String(btn.status).trim() : 'normal';
    if (!text || !url || isBadLocalUrl(url)) return null;
    return { text, color, status, event: { type: 'openLink', params: { url } } };
  }

  const btns = Array.isArray(buttons)
    ? buttons.map(toFullButton).filter(Boolean)
    : [];

  const cardParamMap = { btns };
  if (titleKey && titleText) {
    cardParamMap[titleKey] = titleText;
  }
  if (contentKey) {
    cardParamMap[contentKey] = md;
  }

  const cardData = new dingtalkcard_1_0.CreateAndDeliverRequestCardData({
    cardParamMap: convertJSONValuesToString(cardParamMap),
  });

  const deliverPayload = { robotCode };
  if (deliverRecipients.length) {
    deliverPayload.recipients = deliverRecipients;
  }
  const imGroupOpenDeliverModel = new dingtalkcard_1_0.CreateAndDeliverRequestImGroupOpenDeliverModel(deliverPayload);

  const lastMessage = (title ? String(title) : 'BOB币中心')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);
  const searchIcon = cfg?.dingtalk?.groupCardSearchIcon ? String(cfg.dingtalk.groupCardSearchIcon).trim() : '';
  const searchDesc = (title ? String(title) : '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);

  const spaceModelPayload = {
    supportForward: false,
    lastMessageI18n: { ZH_CN: lastMessage || 'BOB币中心' },
  };
  if (searchIcon && searchDesc) {
    spaceModelPayload.searchSupport = new dingtalkcard_1_0.CreateAndDeliverRequestImGroupOpenSpaceModelSearchSupport({
      searchIcon,
      searchDesc,
    });
  }

  const imGroupOpenSpaceModel = new dingtalkcard_1_0.CreateAndDeliverRequestImGroupOpenSpaceModel(spaceModelPayload);

  const req = new dingtalkcard_1_0.CreateAndDeliverRequest({
    userId: op,
    cardTemplateId: tpl,
    outTrackId: outTrackId ? String(outTrackId) : toOutTrackId('BOB'),
    callbackType: 'STREAM',
    cardData,
    imGroupOpenSpaceModel,
    imGroupOpenDeliverModel,
    openSpaceId: `dtv1.card//im_group.${conv}`,
    userIdType: 1,
  });

  try {
    return await client.createAndDeliverWithOptions(req, headers, new Util.RuntimeOptions({}));
  } catch (err) {
    const code = err?.code ? String(err.code) : '';
    const message = err?.message ? String(err.message) : String(err);
    throw new DingtalkCardError(message || 'dingtalk card send failed', { code, data: err });
  }
}

export function notifyGroupInteractiveCard(cfg, {
  db,
  event,
  title,
  markdown,
  outTrackId,
  buttons,
  imageUrl,
} = {}) {
  if (!isGroupCardNotifyEnabled(cfg)) return;

  const t = title ? String(title).trim() : '';
  const md = markdown ? String(markdown).trim() : '';
  if (!t && !md) return;

  enqueueNotify(async () => {
    await sendWithRetry(() =>
      sendGroupInteractiveCard(cfg, {
        title: t || 'BOB币中心',
        markdown: md || t,
        outTrackId,
        buttons,
        imageUrl,
      }),
    );
    await sleep(200);
  }, {
    onError: async (err) => {
      await safeAppendAuditLog(db, {
        eventType: 'group_card_send_failed',
        actorType: 'system',
        statusCode: 500,
        message: String(err?.message || err),
        payload: {
          event: event || '',
          outTrackId: outTrackId || '',
          title: t || 'BOB币中心',
        },
      });
    },
  });
}

function renderButtonVars(buttons, vars) {
  if (!Array.isArray(buttons)) return buttons;
  return buttons.map((btn) => {
    if (!btn || typeof btn !== 'object') return btn;
    const result = { ...btn };
    if (typeof result.text === 'string') result.text = renderVars(result.text, vars);
    if (typeof result.url === 'string') result.url = renderVars(result.url, vars);
    return result;
  });
}

export async function notifyGroupInteractiveCardBySettings(db, cfg, payload = {}) {
  const settings = await getGroupCardSettings(db);
  if (settings?.enabled === false) return;
  const event = payload?.event ? String(payload.event) : 'manual';
  const template = settings?.templates?.[event] || settings?.templates?.manual || { title: '{{title}}', content: '{{content}}' };
  if (template?.enabled === false) return;
  const titleRaw = payload?.title ? String(payload.title) : '';
  const contentRaw = payload?.markdown ? String(payload.markdown) : '';
  const vars = {
    title: titleRaw,
    content: contentRaw,
    ...(payload?.vars && typeof payload.vars === 'object' ? payload.vars : {}),
  };
  const title = renderVars(template?.title, vars) || titleRaw;
  const markdown = renderVars(template?.content, vars) || contentRaw;

  // payload.buttons takes priority; otherwise use template buttons with variable substitution
  const buttons = Array.isArray(payload?.buttons) && payload.buttons.length
    ? renderButtonVars(payload.buttons, vars)
    : (Array.isArray(template?.buttons) ? renderButtonVars(template.buttons, vars) : undefined);

  const runtimeCfg = mergeGroupCardChannelIntoCfg(cfg, settings);

  notifyGroupInteractiveCard(runtimeCfg, {
    db,
    event,
    outTrackId: payload?.outTrackId,
    imageUrl: payload?.imageUrl,
    title,
    markdown,
    buttons,
  });
}
