import { Router } from 'express';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { requireBobToken } from '../middleware/requireBobToken.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { requireWebSession } from '../middleware/requireWebSession.js';
import { requireSiteEnabled } from '../middleware/requireSiteEnabled.js';
import { requireAnnouncementAccess } from '../middleware/requireAnnouncementAccess.js';
import { createRedeemOrderInTx } from '../services/redeemService.js';
import { ensureAccount, listLedgerRecords, transferBob } from '../services/ledgerService.js';
import { getUserName, sendOrQueueNotify, toBool } from '../services/notifyOpsService.js';
import { notifyGroupInteractiveCardBySettings } from '../services/groupCardNotifyService.js';
import { getRedeemCdkInfo, previewRedeemCdk, redeemCdk } from '../services/cdkService.js';
import { contributeToCharity, getCharityProjectDetail, listMallCharityProjects } from '../services/charityService.js';
import { publishMallRealtimeEvent, registerMallRealtimeClient } from '../services/mallRealtimeService.js';
import { getMallProductsSnapshotCached, invalidateMallProductsCache } from '../services/mallProductsCache.js';
import { buildExchangeData, encodeData, QRSignError } from '../utils/qr.js';
import { claimActiveRedPacket, resolveRedPacketActivity } from '../services/redPacketService.js';
import {
  getAuctionDetailForMall,
  getMyAuctionBidForActivity,
  listAuctionActivitiesForMall,
  listMyAuctionBids,
  notifyAuctionWinners,
  placeAuctionBid,
} from '../services/auctionService.js';
import { createQrRenderPath } from '../services/qrImageService.js';
import { getSiteVisibilitySettings } from '../services/systemSettings.js';
import {
  buildAnnouncementAccessState,
  recordAnnouncementAction,
} from '../services/announcementAccessService.js';

const mallEasterTokens = new Map();
function normalizeLimitRound(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return 1;
  }
  return n;
}

async function attachMallLimitUsage(db, userid, rows) {
  const uid = userid ? String(userid) : '';
  const list = Array.isArray(rows) ? rows : [];
  if (!uid || list.length === 0) {
    return list.map((row) => ({ ...row }));
  }

  const limitedRows = list.filter((row) => {
    const limit = toInt(row?.limit_per_user);
    return limit !== null && limit > 0 && row?.product_id;
  });
  if (limitedRows.length === 0) {
    return list.map((row) => ({
      ...row,
      limit_round: normalizeLimitRound(row?.limit_round),
      limit_used: 0,
      limit_total: 0,
      limit_remaining: null,
      limit_reached: false,
    }));
  }

  const productIds = Array.from(new Set(limitedRows.map((row) => String(row.product_id))));
  const usedRows = await db.all(
    `SELECT product_id, COALESCE(limit_round, 1) AS limit_round, COUNT(1) AS cnt
       FROM redeems
      WHERE userid = ?
        AND product_id = ANY(?)
        AND COALESCE(bob_amount, 0) > 0
      GROUP BY product_id, COALESCE(limit_round, 1)`,
    [uid, productIds],
  );
  const usedMap = new Map((usedRows || []).map((row) => [
    `${String(row.product_id)}:${normalizeLimitRound(row.limit_round)}`,
    Number(row.cnt || 0),
  ]));

  return list.map((row) => {
    const limit = toInt(row?.limit_per_user) || 0;
    const round = normalizeLimitRound(row?.limit_round);
    if (limit <= 0) {
      return {
        ...row,
        limit_round: round,
        limit_used: 0,
        limit_total: 0,
        limit_remaining: null,
        limit_reached: false,
      };
    }
    const used = Math.min(limit, Math.max(0, usedMap.get(`${String(row.product_id)}:${round}`) || 0));
    const remaining = Math.max(0, limit - used);
    return {
      ...row,
      limit_round: round,
      limit_used: used,
      limit_total: limit,
      limit_remaining: remaining,
      limit_reached: remaining <= 0,
    };
  });
}

function publishMoreChanged(section, extra = {}) {
  publishMallRealtimeEvent('more_changed', { section, ...extra });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function isValidMallEasterToken({ userid, token }) {
  const uid = userid ? String(userid) : '';
  const t = token ? String(token) : '';
  if (!uid || !t) return false;
  const row = mallEasterTokens.get(t);
  const expiresAt = Number(row?.expires_at || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSec()) {
    mallEasterTokens.delete(t);
    return false;
  }
  return String(row?.userid || '') === uid;
}

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function toOptionalInt(value) {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  if (!t) return null;
  return toInt(t);
}

function resolveDisplayName(name, userid) {
  return (name ? String(name) : '').trim() || (userid ? String(userid) : '').trim() || '用户';
}

function escapeHtmlText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] || ch));
}

function buildSiteDisabledHtml(message) {
  const text = escapeHtmlText(message || '系统维护中，请稍后再试。');
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
    <title>BOB币中心暂未开放</title>
    <style>
      body{margin:0;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
      .card{width:min(420px,100%);border:1px solid rgba(15,23,42,.1);border-radius:20px;background:rgba(255,255,255,.9);box-shadow:0 18px 45px rgba(15,23,42,.08);padding:24px;text-align:center;box-sizing:border-box}
      .title{font-size:20px;font-weight:900}
      .message{margin-top:12px;white-space:pre-wrap;word-break:break-word;line-height:1.7;font-size:14px;color:rgba(15,23,42,.68)}
    </style>
  </head>
  <body>
    <main class="card">
      <div class="title">BOB币中心暂未开放</div>
      <div class="message">${text}</div>
    </main>
  </body>
</html>`;
}

async function sendMallHtmlOrSiteGate(req, res, { pagesRoot, fileName }) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const site = await getSiteVisibilitySettings(req.app?.locals?.db);
    if (site?.enabled === false) {
      return res.type('html').send(buildSiteDisabledHtml(site.message));
    }
  } catch {
    // 设置读取失败时保持前台可访问，避免误伤生产入口。
  }
  return res.type('html').sendFile(fileName, { root: pagesRoot });
}

function normalizeFeedbackCategory(value) {
  const v = value ? String(value).trim() : '';
  if (v === 'bug' || v === 'question' || v === 'rule' || v === 'other') return v;
  return 'suggestion';
}

async function attachFeedbackMessages(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = list.map((row) => Number(row?.id || 0)).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return list;
  const placeholders = ids.map(() => '?').join(',');
  const messages = await db.all(
    `SELECT id, feedback_id, sender_type, sender_id, sender_name, content, created_at
     FROM user_feedback_messages
     WHERE feedback_id IN (${placeholders})
     ORDER BY feedback_id ASC, created_at ASC, id ASC`,
    ids,
  );
  const grouped = new Map();
  (messages || []).forEach((item) => {
    const key = Number(item.feedback_id || 0);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  });
  return list.map((row) => ({ ...row, messages: grouped.get(Number(row.id || 0)) || [] }));
}

async function ensureMallOpeningRow(db) {
  const row = await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
  if (row) return row;
  await db.run('INSERT INTO mall_opening_schedule(id, is_open, auto_enabled) VALUES(1, 1, 0)');
  return await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
}

function genExchangeId() {
  return `MALL_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function genListingId() {
  return `MARKET_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function isMarketOrderExchangeId(value) {
  const id = value ? String(value) : '';
  return id.startsWith('MALL_') || id.startsWith('CDK_');
}

function buildPriceRange(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) {
    return { price_min: 0, price_max: 0 };
  }
  return {
    price_min: Math.floor(n * 0.8),
    price_max: Math.ceil(n * 1.5),
  };
}

function withPriceRange(row = {}) {
  const original = Number(row.original_amount ?? row.bob_amount ?? 0);
  return {
    ...row,
    original_amount: Number.isFinite(original) ? original : 0,
    ...buildPriceRange(original),
  };
}

function isMallOpenRow(row) {
  return Number(row?.is_open) === 1;
}

function normalizeMarketListing(row = {}, currentUserid = '') {
  const sellerUserid = row?.seller_userid ? String(row.seller_userid) : '';
  const buyerName = resolveDisplayName(row?.buyer_name_snapshot, row?.buyer_userid);
  return withPriceRange({
    listing_id: String(row?.listing_id || ''),
    exchange_id: String(row?.exchange_id || ''),
    product_id: String(row?.product_id || ''),
    product_name: String(row?.product_name || ''),
    original_amount: Number(row?.product_price ?? row?.bob_amount ?? 0),
    price: Number(row?.price ?? 0),
    seller_userid: sellerUserid,
    seller_display_name: resolveDisplayName(row?.seller_name_snapshot || row?.seller_name, sellerUserid),
    buyer_userid: row?.buyer_userid ? String(row.buyer_userid) : '',
    buyer_display_name: row?.buyer_userid ? buyerName : '',
    seller_note: row?.seller_note ? String(row.seller_note) : '',
    product_image_url: row?.product_image_url ? String(row.product_image_url) : '',
    product_remark: row?.product_remark ? String(row.product_remark) : '',
    status: String(row?.status || ''),
    created_at: row?.created_at ?? null,
    sold_at: row?.sold_at ?? null,
    cancelled_at: row?.cancelled_at ?? null,
    can_buy: String(currentUserid || '') !== sellerUserid && String(row?.status || '') === 'active',
  });
}

async function getMarketOpen(db) {
  const opening = await ensureMallOpeningRow(db);
  return !isMallOpenRow(opening);
}

async function buildRedPacketScreenPayload(db, now, limit = 12) {
  const activity = await resolveRedPacketActivity(db, now);
  if (!activity) {
    return {
      activity: null,
      claimed_count: 0,
      remaining_count: 0,
      recent_claims: [],
    };
  }

  const counts = await db.get(
    'SELECT COUNT(1) as total, SUM(CASE WHEN claimed_by IS NOT NULL THEN 1 ELSE 0 END) as claimed FROM red_packet_items WHERE activity_id = ?',
    [activity.id],
  );
  const claimed = Number(counts?.claimed ?? 0);
  const total = Number(counts?.total ?? activity.total_count ?? 0);
  const remaining = Math.max(0, total - claimed);
  const recentClaims = await db.all(
    `SELECT r.claimed_by as userid, r.amount, r.claimed_at, u.name
     FROM red_packet_items r
     LEFT JOIN users u ON u.userid = r.claimed_by
     WHERE r.activity_id = ? AND r.claimed_by IS NOT NULL
     ORDER BY r.claimed_at DESC, r.id DESC
     LIMIT ?`,
    [activity.id, limit],
  );

  return {
    activity,
    claimed_count: claimed,
    remaining_count: remaining,
    recent_claims: recentClaims || [],
  };
}

async function buyMallProduct({ db, cfg, userid, name, productId, exchangeId, secret, awaitNotify, skipNotify, omitQr }) {
  if (!productId) {
    throw new Error('missing product_id');
  }
  if (!exchangeId) {
    throw new Error('missing exchange_id');
  }

  const txRunner = typeof db.transaction === 'function'
    ? (fn) => db.transaction(fn)
    : async (fn) => await fn(db);
  const txData = await txRunner(async (tx) => {
    const p = await tx.get('SELECT product_id, product_name, bob_amount, stock, limit_per_user, limit_round, status, image_url FROM mall_products WHERE product_id = ? LIMIT 1 FOR UPDATE', [productId]);
    if (!p) {
      throw new Error('product not found');
    }
    const status = p?.status ? String(p.status) : '';
    if (status !== 'on') {
      throw new Error('product not on sale');
    }
    const amount = toInt(p?.bob_amount);
    if (amount === null || amount <= 0) {
      throw new Error('invalid product price');
    }

    const limitPerUser = toInt(p?.limit_per_user);
    const limitRound = normalizeLimitRound(p?.limit_round);
    let limitUsed = 0;
    if (limitPerUser && limitPerUser > 0) {
      const usedRow = await tx.get(
        'SELECT COUNT(1) as cnt FROM redeems WHERE userid = ? AND product_id = ? AND COALESCE(limit_round, 1) = ? AND COALESCE(bob_amount, 0) > 0',
        [String(userid), String(p.product_id), limitRound],
      );
      limitUsed = Number(usedRow?.cnt ?? 0);
      if (limitUsed >= limitPerUser) {
        throw new Error('purchase_limit_reached');
      }
    }

    const stockRaw = p?.stock;
    const stock = stockRaw === null || stockRaw === undefined ? null : toInt(stockRaw);
    const oldStock = stock;
    const newStock = stock === null ? null : stock - 1;
    if (stock !== null) {
      if (stock <= 0) {
        throw new Error('out of stock');
      }
      await tx.run('UPDATE mall_products SET stock = stock - 1, updated_at = unixepoch() WHERE product_id = ?', [productId]);
    }

    const r = await createRedeemOrderInTx(tx, {
      exchangeId,
      userid,
      productId: String(p.product_id),
      productName: String(p.product_name || ''),
      bobAmount: amount,
      reason: 'mall_buy',
      limitRound,
    });

    let qr = { encoded: null, qr_image_url: null };
    if (!omitQr) {
      try {
        qr = buildQrForRedeem(
          {
            exchange_id: exchangeId,
            userid,
            product_id: String(p.product_id),
            product_name: String(p.product_name || ''),
            bob_amount: amount,
          },
          secret,
        );
      } catch (err) {
        const msg = String(err?.message || err);
        if (err instanceof QRSignError) {
          throw new Error(msg);
        }
        throw err;
      }
    }
    return { p, amount, oldStock, newStock, r, qr, limitPerUser: limitPerUser || 0, limitRound, limitUsed };
  });

  const { p, amount, oldStock, newStock, r, qr, limitPerUser, limitRound, limitUsed } = txData;

  if (!skipNotify && oldStock !== null && newStock !== null) {
      const productText = String(p.product_name || p.product_id || productId);
      const imageUrl = p?.image_url ? String(p.image_url) : '';
      if (oldStock === 2 && newStock === 1) {
        await notifyGroupInteractiveCardBySettings(db, cfg, {
          event: 'stock_low',
          title: `【BOB币中心】库存告急：${productText}`,
          markdown: `## 库存快没啦！\n\n- 商品：${productText}\n- 库存：仅剩 1 件\n\n想要的同学欲购从速，售完为止。`,
          outTrackId: `stock_low_${String(p.product_id || productId)}_${Date.now()}`,
          imageUrl,
          vars: {
            product_name: productText,
            stock: '仅剩 1 件',
          },
        });
      }
      if (newStock === 0) {
        await notifyGroupInteractiveCardBySettings(db, cfg, {
          event: 'stock_soldout',
          title: `【BOB币中心】已售罄：${productText}`,
          markdown: `## 已售罄\n\n- 商品：${productText}\n- 状态：全部卖光啦\n\n感谢支持～`,
          outTrackId: `stock_soldout_${String(p.product_id || productId)}_${Date.now()}`,
          imageUrl,
          vars: {
            product_name: productText,
          },
        });
      }
    }

  let notify;
  if (!skipNotify) {
    const title = name ? `【BOB币中心】恭喜你下单成功 ${name}` : '【BOB币中心】恭喜你下单成功';
    const productText = String(p.product_name || p.product_id || productId);
    notify = await sendOrQueueNotify({
      db,
      cfg,
      userid,
      title,
      lines: [
        `商品：${productText}`,
        `价格：${amount} BOB 币`,
        `当前余额：${r.balance} BOB 币`,
        `请尽快联系工作人员线下核销`,
      ],
      awaitNotify,
      event: 'mall_buy',
      variables: {
        name: name || userid,
        userid,
        product_name: productText,
        amount: String(amount),
        balance: String(r.balance),
        exchange_id: String(r.exchange_id || exchangeId || ''),
      },
    });
  }
  const limitAfter = limitPerUser > 0 ? Math.min(limitPerUser, limitUsed + 1) : 0;
  return {
    ok: true,
    exchange_id: r.exchange_id,
    balance: r.balance,
    encoded: qr.encoded,
    qr_image_url: qr.qr_image_url,
    notify: !skipNotify && awaitNotify ? notify : undefined,
    product: {
      product_id: String(p.product_id),
      product_name: String(p.product_name || ''),
      bob_amount: amount,
      image_url: p?.image_url ? String(p.image_url) : '',
      limit_round: limitRound,
      limit_used: limitAfter,
      limit_total: limitPerUser,
      limit_remaining: limitPerUser > 0 ? Math.max(0, limitPerUser - limitAfter) : null,
    },
  };
}

function buildQrForRedeem({ exchange_id, userid, product_id, product_name, bob_amount }, secret) {
  const data = buildExchangeData({ exchange_id, userid, product_id, product_name, bob_amount }, secret);
  const encoded = encodeData(data);
  const qr_image_url = createQrRenderPath(encoded, { size: 240 });
  return { encoded, qr_image_url };
}

export function mallRouter() {
  const router = Router();
  // 出价按 userid 限流：办公网 NAT 下同 IP 是全公司共享额度，仅按 IP 限会在
  // 热门场次收尾时误伤；IP 级限流（app.js，60/min）保留为 DoS 防护层。
  const auctionUserBidLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 20,
    keyFn: (req) => (req.webSession?.userid ? `auction_bid_user:${String(req.webSession.userid)}` : ''),
    message: '出价过于频繁，请稍后再试',
  });
  // 站点关闭时拦截业务 API（含购买/交易/公益/反馈写接口）；HTML 入口继续走页面 gate。
  // 仅放行：首页/screen/events 页面与红包大屏公开读。
  router.use((req, res, next) => {
    const p = String(req.path || '');
    if (req.method === 'GET' && (p === '/' || p === '/screen' || p === '/events' || p === '/red-packet/screen')) {
      return next();
    }
    return requireSiteEnabled()(req, res, next);
  });
  const pagesRoot = fileURLToPath(new URL('../pages/', import.meta.url));

  router.get('/', async (req, res) => {
    return sendMallHtmlOrSiteGate(req, res, { pagesRoot, fileName: 'mall.html' });
  });

  router.get('/screen', async (req, res) => {
    return sendMallHtmlOrSiteGate(req, res, { pagesRoot, fileName: 'mall_screen.html' });
  });

  router.get('/events', async (req, res) => {
    const scope = req.query?.scope === 'screen' ? 'screen' : 'mall';
    if (scope === 'screen') {
      registerMallRealtimeClient({ req, res, scope });
      return;
    }
    const guard = requireWebSession();
    return guard(req, res, () => {
      const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
      if (!userid) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      registerMallRealtimeClient({ req, res, scope, userid });
      return undefined;
    });
  });

  router.get('/red-packet/screen', async (req, res) => {
    const db = req.app.locals.db;
    const limitRaw = toOptionalInt(req.query?.limit);
    const limit = Math.min(50, Math.max(1, limitRaw || 12));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const now = Math.floor(Date.now() / 1000);
      const payload = await buildRedPacketScreenPayload(db, now, limit);
      return res.json({ ok: true, server_time: now, ...payload });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/access-state', requireWebSession(), async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const state = await buildAnnouncementAccessState(
        req.app.locals.db,
        String(req.webSession.userid || ''),
      );
      return res.json(state);
    } catch (err) {
      return res.status(503).json({
        error: 'announcement_access_unavailable',
        message: '暂时无法确认公告签署状态，请稍后重试。',
        detail: String(err?.message || err),
      });
    }
  });

  router.post('/announcements/:id/acknowledge', requireWebSession(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = String(req.webSession.userid || '');
    try {
      const result = await db.transaction(async (tx) => recordAnnouncementAction(tx, {
        userid,
        announcementId: req.params.id,
        revision: req.body?.revision,
        contentHash: req.body?.content_hash,
        action: req.body?.action,
      }));
      const state = await buildAnnouncementAccessState(db, userid);
      publishMallRealtimeEvent('announcement_access_changed', {
        userid,
        announcement_id: result.id,
        revision: result.revision,
        reason: result.action,
      });
      return res.json({ ...state, acknowledgement: result });
    } catch (err) {
      const code = String(err?.code || '');
      if (code === 'announcement_not_found') return res.status(404).json({ error: code });
      if (code === 'announcement_revision_conflict') {
        return res.status(409).json({ error: code, current: err.current || null });
      }
      if (code === 'announcement_not_active') return res.status(409).json({ error: code });
      if (code.startsWith('invalid_') || code === 'announcement_acknowledgement_required') {
        return res.status(400).json({ error: code, message: String(err?.message || err) });
      }
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/me', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const name = req.webSession?.name ? String(req.webSession.name) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await db.get('SELECT balance FROM accounts WHERE userid = ? LIMIT 1', [userid]);
      const balance = Number(row?.balance ?? 0);
      return res.json({ ok: true, userid, name, balance });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/users', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const keyword = req.query.keyword ? String(req.query.keyword).trim() : '';
    const limitRaw = toOptionalInt(req.query?.limit);
    const limit = Math.min(20, Math.max(1, limitRaw || 8));
    if (!keyword) {
      return res.json({ ok: true, count: 0, data: [] });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const kw = `%${keyword}%`;
      const rows = await db.all(
        `SELECT u.userid, COALESCE(u.name, '') AS name
         FROM users u
         WHERE (LOWER(COALESCE(u.name, '')) LIKE LOWER(?) OR LOWER(u.userid) LIKE LOWER(?))
           AND COALESCE(u.source, 'dingtalk') <> 'external'
         ORDER BY (u.name IS NULL), u.name COLLATE NOCASE, u.userid COLLATE NOCASE
         LIMIT ?`,
        [kw, kw, limit],
      );
      const selfId = req.webSession?.userid ? String(req.webSession.userid) : '';
      const data = (rows || [])
        .filter((x) => String(x?.userid || '') !== selfId)
        .map((x) => ({
          userid: String(x?.userid || ''),
          name: String(x?.name || ''),
          display_name: resolveDisplayName(x?.name, x?.userid),
        }));
      return res.json({ ok: true, count: data.length, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/rich-board', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const limit = Math.min(100, Math.max(1, toOptionalInt(req.query?.limit) || 50));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT a.userid, COALESCE(a.balance, 0) AS balance, COALESCE(u.name, '') AS name
         FROM accounts a
         LEFT JOIN users u ON u.userid = a.userid
         WHERE a.userid IS NOT NULL AND trim(a.userid) <> ''
           AND COALESCE(u.source, 'dingtalk') <> 'external'
         ORDER BY a.balance DESC, a.userid COLLATE NOCASE ASC
         LIMIT ?`,
        [limit],
      );
      const data = (rows || []).map((x, idx) => ({
        rank: idx + 1,
        userid: String(x?.userid || ''),
        display_name: resolveDisplayName(x?.name, x?.userid),
        balance: Number(x?.balance ?? 0),
      }));
      return res.json({ ok: true, limit, count: data.length, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/popular-products', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const limit = Math.min(50, Math.max(1, toOptionalInt(req.query?.limit) || 20));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT r.product_id, r.product_name, COUNT(*) as order_count, SUM(r.bob_amount) as total_amount,
                COALESCE(MAX(p.image_url), '') as image_url
         FROM redeems r
         LEFT JOIN mall_products p ON p.product_id = r.product_id
         WHERE r.product_id IS NOT NULL AND r.product_id <> ''
         GROUP BY r.product_id, r.product_name
         ORDER BY order_count DESC, total_amount DESC
         LIMIT ?`,
        [limit],
      );
      const data = (rows || []).map((x, idx) => ({
        rank: idx + 1,
        product_id: String(x?.product_id || ''),
        product_name: String(x?.product_name || ''),
        order_count: Number(x?.order_count ?? 0),
        total_amount: Number(x?.total_amount ?? 0),
        image_url: String(x?.image_url || ''),
      }));
      return res.json({ ok: true, limit, count: data.length, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/more/faq', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const limit = Math.min(100, Math.max(1, toOptionalInt(req.query?.limit) || 50));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT id, question, answer, sort, updated_at
         FROM content_faq
         WHERE is_enabled = 1
         ORDER BY sort ASC, id DESC
         LIMIT ?`,
        [limit],
      );
      return res.json({ ok: true, count: (rows || []).length, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/more/announcements', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const limit = Math.min(50, Math.max(1, toOptionalInt(req.query?.limit) || 20));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const now = nowSec();
      const rows = await db.all(
        `SELECT id, title, content, level, publish_at, show_fullscreen,
                requires_acknowledgement, revision, content_hash, updated_at
         FROM content_announcements
         WHERE is_enabled = 1
           AND (publish_at IS NULL OR publish_at <= ?)
         ORDER BY COALESCE(publish_at, created_at) DESC, sort ASC, id DESC
         LIMIT ?`,
        [now, limit],
      );
      return res.json({ ok: true, count: (rows || []).length, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/more/version', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const now = nowSec();
      const rows = await db.all(
        `SELECT id, version_name, release_notes, publish_at, updated_at, created_at
         FROM system_versions
         WHERE is_enabled = 1
           AND (publish_at IS NULL OR publish_at <= ?)
         ORDER BY COALESCE(publish_at, created_at) DESC, id DESC`,
        [now],
      );
      return res.json({ ok: true, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/more/stats', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const [balanceRow, pendingRow, fulfilledRow, rankRow, feedbackRow] = await Promise.all([
        db.get('SELECT COALESCE(balance, 0) AS balance FROM accounts WHERE userid = ? LIMIT 1', [userid]),
        db.get("SELECT COUNT(1) AS cnt FROM redeems WHERE userid = ? AND fulfilled_at IS NULL AND (exchange_id LIKE 'MALL_%' OR exchange_id LIKE 'AUCTION_%')", [userid]),
        db.get("SELECT COUNT(1) AS cnt FROM redeems WHERE userid = ? AND fulfilled_at IS NOT NULL AND (exchange_id LIKE 'MALL_%' OR exchange_id LIKE 'AUCTION_%')", [userid]),
        db.get(
          `SELECT rank FROM (
             SELECT userid, ROW_NUMBER() OVER (ORDER BY balance DESC, userid COLLATE NOCASE ASC) AS rank
             FROM accounts
           ) t
           WHERE userid = ?
           LIMIT 1`,
          [userid],
        ),
        db.get('SELECT COUNT(1) AS cnt FROM user_feedback WHERE userid = ?', [userid]),
      ]);
      return res.json({
        ok: true,
        data: {
          balance: Number(balanceRow?.balance ?? 0),
          pending_orders: Number(pendingRow?.cnt ?? 0),
          fulfilled_orders: Number(fulfilledRow?.cnt ?? 0),
          rich_rank: Number(rankRow?.rank ?? 0) || null,
          feedback_count: Number(feedbackRow?.cnt ?? 0),
        },
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/more/feedback/mine', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const limit = Math.min(100, Math.max(1, toOptionalInt(req.query?.limit) || 20));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT id, category, content, contact, status, reply, created_at, handled_at
         FROM user_feedback
         WHERE userid = ?
         ORDER BY id DESC
         LIMIT ?`,
        [userid, limit],
      );
      const data = await attachFeedbackMessages(db, rows || []);
      return res.json({ ok: true, count: data.length, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/more/feedback', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const name = req.webSession?.name ? String(req.webSession.name) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const category = normalizeFeedbackCategory(req.body?.category);
    const content = req.body?.content ? String(req.body.content).trim() : '';
    const contact = req.body?.contact ? String(req.body.contact).trim() : '';
    if (!content) {
      return res.status(400).json({ error: 'missing content' });
    }
    if (content.length > 2000) {
      return res.status(400).json({ error: 'content too long' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      let feedbackId = 0;
      await db.transaction(async (tx) => {
        const r = await tx.run(
          `INSERT INTO user_feedback(userid, name, category, content, contact, status, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, 'pending', unixepoch(), unixepoch())`,
          [userid, name || '', category, content, contact || ''],
        );
        feedbackId = Number(r?.lastID || 0);
        await tx.run(
          `INSERT INTO user_feedback_messages(feedback_id, sender_type, sender_id, sender_name, content, created_at)
           VALUES(?, 'user', ?, ?, ?, unixepoch())`,
          [feedbackId, userid, name || '', content],
        );
      });
      publishMoreChanged('feedback', { userids: [userid], feedback_id: feedbackId });
      return res.json({ ok: true, id: feedbackId });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/more/feedback/:id/messages', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const name = req.webSession?.name ? String(req.webSession.name) : '';
    const id = toOptionalInt(req.params?.id);
    const content = req.body?.content ? String(req.body.content).trim() : '';
    if (!userid) return res.status(401).json({ error: 'unauthorized' });
    if (!id) return res.status(400).json({ error: 'missing id' });
    if (!content) return res.status(400).json({ error: 'missing content' });
    if (content.length > 2000) return res.status(400).json({ error: 'content too long' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await db.get('SELECT id FROM user_feedback WHERE id = ? AND userid = ?', [id, userid]);
      if (!row) return res.status(404).json({ error: 'feedback not found' });
      await db.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO user_feedback_messages(feedback_id, sender_type, sender_id, sender_name, content, created_at)
           VALUES(?, 'user', ?, ?, ?, unixepoch())`,
          [id, userid, name || '', content],
        );
        await tx.run(
          `UPDATE user_feedback SET status = 'pending', updated_at = unixepoch() WHERE id = ?`,
          [id],
        );
      });
      publishMoreChanged('feedback', { userids: [userid], feedback_id: id });
      return res.json({ ok: true, id });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/red-packet/status', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const nowMs = Date.now();
      const now = Math.floor(nowMs / 1000);
      const activity = await resolveRedPacketActivity(db, now);
      if (!activity) {
        return res.json({ ok: true, data: null, server_time: now });
      }

      const counts = await db.get(
        'SELECT COUNT(1) as total, SUM(CASE WHEN claimed_by IS NOT NULL THEN 1 ELSE 0 END) as claimed FROM red_packet_items WHERE activity_id = ?',
        [activity.id],
      );
      const claimed = Number(counts?.claimed ?? 0);
      const total = Number(counts?.total ?? activity.total_count ?? 0);
      const remaining = Math.max(0, total - claimed);
      const mine = await db.get(
        'SELECT amount FROM red_packet_items WHERE activity_id = ? AND claimed_by = ? LIMIT 1',
        [activity.id, userid],
      );

      return res.json({
        ok: true,
        data: activity,
        claimed_count: claimed,
        remaining_count: remaining,
        my_amount: mine?.amount ?? null,
        server_time: now,
        server_time_ms: nowMs,
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/red-packet/claim', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const name = req.webSession?.name ? String(req.webSession.name) : '';
    const awaitNotify = toBool(req.query?.await_notify) || toBool(req.body?.await_notify);
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    let result = null;
    try {
      result = await claimActiveRedPacket(db, { userid, name });
      if (result?.amount) {
        await sendOrQueueNotify({
          db,
          cfg: req.app?.locals?.cfg,
          userid,
          title: name ? `【BOB币中心】红包到账 ${name}` : '【BOB币中心】红包到账',
          lines: [
            `金额：${String(result.amount)} BOB 币`,
            `当前余额：${String(result.balance)} BOB 币`,
            `活动ID：${String(result.activity_id)}`,
          ],
          awaitNotify,
          event: 'red_packet',
          variables: {
            name: name || userid,
            userid,
            amount: String(result.amount),
            balance: String(result.balance),
            activity_id: String(result.activity_id),
          },
        });
      }
      const serverNowMs = Date.now();
      publishMallRealtimeEvent('balance_changed', { userid, reason: 'red_packet' });
      publishMallRealtimeEvent('red_packet_changed', { userid, reason: 'red_packet' });
      publishMallRealtimeEvent('screen_changed', { scopes: ['screen'], reason: 'red_packet' });
      return res.json({
        ok: true,
        amount: result.amount,
        balance: result.balance,
        activity_id: result.activity_id,
        server_time: Math.floor(serverNowMs / 1000),
        server_time_ms: serverNowMs,
      });
    } catch (err) {
      const msg = String(err?.message || err || '');
      const pgCode = String(err?.code || '');
      const isDuplicateClaim = pgCode === '23505';
      const isBusy =
        pgCode === '55P03' ||
        pgCode === '40P01';
      const errorCode = isDuplicateClaim ? 'already_claimed' : isBusy ? 'concurrent_limit' : msg;
      const status = isBusy ? 429 : 400;
      return res.status(status).json({ error: errorCode });
    }
  });

  function mapAuctionBidError(err) {
    const msg = String(err?.message || err || '');
    const pgCode = String(err?.code || '');
    if (pgCode === '23505') return { status: 409, code: 'concurrent_bid_conflict' };
    if (pgCode === '55P03' || pgCode === '40P01') return { status: 429, code: 'concurrent_limit' };
    switch (msg) {
      case 'auction not found':
        return { status: 404, code: msg };
      case 'invalid activity_id':
      case 'invalid amount':
      case 'not_started':
      case 'auction ended':
      case 'auction_cancelled':
      case 'bid_too_low':
      case 'already_highest_bidder':
      case 'insufficient balance':
        return { status: 400, code: msg };
      default:
        return { status: 500, code: msg };
    }
  }

  router.get('/auction/list', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const nowMs = Date.now();
      const now = Math.floor(nowMs / 1000);
      const limitRaw = toOptionalInt(req.query?.limit);
      const result = await listAuctionActivitiesForMall(db, {
        now,
        limit: limitRaw || 20,
      });
      if (result.settledWinners?.length) {
        for (const winner of result.settledWinners) {
          const activity = result.list.find((x) => x.id === winner.activity_id);
          winner.title = activity ? activity.title : '';
        }
        notifyAuctionWinners({ db, cfg: req.app?.locals?.cfg, winners: result.settledWinners });
        publishMallRealtimeEvent('auction_changed', { reason: 'settled' });
      }
      return res.json({
        ok: true,
        data: result.list,
        server_time: now,
        server_time_ms: nowMs,
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/auction/detail', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const activityId = toOptionalInt(req.query?.id);
    if (!activityId) {
      return res.status(400).json({ error: 'invalid activity_id' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const nowMs = Date.now();
      const now = Math.floor(nowMs / 1000);
      const result = await getAuctionDetailForMall(db, { activityId, now });
      if (result.settledWinner) {
        result.settledWinner.title = result.activity.title;
        notifyAuctionWinners({ db, cfg: req.app?.locals?.cfg, winners: [result.settledWinner] });
        publishMallRealtimeEvent('auction_changed', { reason: 'settled', activity_id: activityId });
      }
      const myBid = await getMyAuctionBidForActivity(db, { activityId, userid });
      return res.json({
        ok: true,
        data: result.activity,
        my_bid: myBid,
        server_time: now,
        server_time_ms: nowMs,
      });
    } catch (err) {
      const mapped = mapAuctionBidError(err);
      return res.status(mapped.status).json({ error: mapped.code });
    }
  });

  router.get('/auction/me', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const limitRaw = toOptionalInt(req.query?.limit);
      const data = await listMyAuctionBids(db, { userid, limit: limitRaw || 50 });
      return res.json({ ok: true, ...data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/auction/bid', requireWebSession(), requireAnnouncementAccess(), auctionUserBidLimiter, async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const name = req.webSession?.name ? String(req.webSession.name) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const activityId = toOptionalInt(req.body?.activity_id);
    const amount = toOptionalInt(req.body?.amount);
    try {
      const result = await placeAuctionBid(db, {
        activityId,
        userid,
        name,
        amount,
      });
      if (result.refunded_to) {
        sendOrQueueNotify({
          db,
          cfg: req.app?.locals?.cfg,
          userid: result.refunded_to,
          title: '【BOB币中心】竞拍出价被超出',
          lines: [
            `竞拍 #${result.activity_id} 有新的更高出价 ${String(result.amount)} BOB 币`,
            '你此前冻结的出价金额已全额退回余额。',
          ],
          event: 'auction',
          variables: {
            amount: String(result.amount),
            activity_id: String(result.activity_id),
          },
        }).catch(() => null);
        publishMallRealtimeEvent('balance_changed', {
          userid: result.refunded_to,
          reason: 'auction_outbid_refund',
        });
      }
      publishMallRealtimeEvent('balance_changed', { userid, reason: 'auction_bid' });
      publishMallRealtimeEvent('auction_changed', {
        activity_id: result.activity_id,
        reason: 'bid',
      });
      const serverNowMs = Date.now();
      return res.json({
        ok: true,
        ...result,
        server_time: Math.floor(serverNowMs / 1000),
        server_time_ms: serverNowMs,
      });
    } catch (err) {
      const mapped = mapAuctionBidError(err);
      return res.status(mapped.status).json({ error: mapped.code });
    }
  });

  router.get('/opening', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await ensureMallOpeningRow(db);
      return res.json({ ok: true, data: row || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/easter/unlock', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const opening = await ensureMallOpeningRow(db);
      if (Number(opening?.is_open) === 1) {
        return res.status(400).json({ error: 'mall_open' });
      }
      const expiresAt = nowSec() + 600;
      const token = crypto.randomBytes(18).toString('hex');
      mallEasterTokens.set(token, { userid, expires_at: expiresAt });
      return res.json({ ok: true, expires_at: expiresAt, token });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/ledger', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const name = req.webSession?.name ? String(req.webSession.name) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const page = Math.max(1, toOptionalInt(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, toOptionalInt(req.query.pageSize) || 20));

    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await listLedgerRecords(db, { userid, name, page, pageSize });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/products', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    try {
      res.setHeader('Cache-Control', 'no-store');
      const snapshot = await getMallProductsSnapshotCached(db);
      const rows = await attachMallLimitUsage(db, userid, snapshot?.rows || []);
      const versionInfo = snapshot?.versionInfo || { total: 0, version: '0:0:0' };
      return res.json({
        ok: true,
        count: (rows || []).length,
        version: versionInfo.version,
        data: rows || [],
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/products/version', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const snapshot = await getMallProductsSnapshotCached(db);
      const info = snapshot?.versionInfo || { total: 0, version: '0:0:0' };
      return res.json({
        ok: true,
        count: info.total,
        version: info.version,
        server_time: nowSec(),
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/charity/projects', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await listMallCharityProjects(db);
      return res.json({ ok: true, count: rows.length, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/charity/project', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await getCharityProjectDetail(db, { projectId: req.query?.project_id, includePaused: true });
      return res.json({ ok: true, data: row });
    } catch (err) {
      const message = String(err?.message || err);
      const status = ['missing project_id', 'charity project not found'].includes(message) ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.post('/charity/contribute', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const cfg = req.app.locals.cfg;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const name = req.webSession?.name ? String(req.webSession.name) : '';
    const awaitNotify = toBool(req.query?.await_notify) || toBool(req.body?.await_notify);
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await contributeToCharity(db, {
        projectId: req.body?.project_id,
        userid,
        userName: name,
        bobAmount: req.body?.bob_amount,
      });
      const displayName = name || await getUserName(db, userid);
      const projectName = result?.project?.project_name
        ? String(result.project.project_name)
        : String(result?.project?.project_id || req.body?.project_id || '-');
      await sendOrQueueNotify({
        db,
        cfg,
        userid,
        title: displayName ? `【BOB币中心】公益助力成功 ${displayName}` : '【BOB币中心】公益助力成功',
        lines: [
          '类型：支出',
          `项目：${projectName}`,
          `金额：${String(result?.contributed_bob_amount ?? req.body?.bob_amount ?? '-') } BOB 币`,
          `当前余额：${String(result?.balance ?? '-')} BOB 币`,
        ],
        awaitNotify,
        event: 'charity',
        variables: {
          name: displayName || userid,
          userid,
          project_id: String(result?.project?.project_id || req.body?.project_id || ''),
          project_name: projectName,
          amount: String(result?.contributed_bob_amount ?? req.body?.bob_amount ?? ''),
          balance: String(result?.balance ?? ''),
        },
      });
      publishMallRealtimeEvent('balance_changed', { userid, reason: 'charity' });
      publishMallRealtimeEvent('charity_changed', {
        userid,
        project_id: String(result?.project?.project_id || req.body?.project_id || ''),
      });
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      const status = [
        'missing project_id',
        'missing userid',
        'invalid bob_amount',
        'charity project not found',
        'charity project not active',
        'invalid charity tier',
        'insufficient balance',
      ].includes(message) ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.get('/market/listings', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const marketOpen = await getMarketOpen(db);
      if (!marketOpen) {
        return res.json({ ok: true, market_open: false, data: [] });
      }
      const rows = await db.all(
        `SELECT l.listing_id, l.exchange_id, l.seller_userid, l.seller_name_snapshot, l.price, l.status, l.created_at, l.seller_note,
                r.product_id, r.product_name, r.bob_amount,
                COALESCE(u.name, '') AS seller_name,
                p.image_url AS product_image_url, p.remark AS product_remark, p.bob_amount AS product_price
           FROM mall_order_listings l
          JOIN redeems r ON r.exchange_id = l.exchange_id
           LEFT JOIN users u ON u.userid = l.seller_userid
           LEFT JOIN mall_products p ON p.product_id = r.product_id
          WHERE l.status = 'active'
            AND r.fulfilled_at IS NULL
            AND r.userid = l.seller_userid
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT 100`,
        [],
      );
      const data = (rows || []).map((row) => normalizeMarketListing(row, userid));
      return res.json({ ok: true, market_open: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/market/mine', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const marketOpen = await getMarketOpen(db);
      const sellableRows = await db.all(
        `SELECT r.exchange_id, r.product_id, r.product_name, r.bob_amount, r.fulfilled_at, r.created_at, r.userid,
                p.image_url AS product_image_url, p.remark AS product_remark, p.bob_amount AS product_price
           FROM redeems r
           LEFT JOIN mall_order_listings active_l
             ON active_l.exchange_id = r.exchange_id
            AND active_l.status = 'active'
           LEFT JOIN mall_products p ON p.product_id = r.product_id
          WHERE r.userid = ?
            AND r.fulfilled_at IS NULL
            AND (r.exchange_id LIKE 'MALL_%' OR r.exchange_id LIKE 'CDK_%')
            AND active_l.id IS NULL
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 100`,
        [userid],
      );
      const listingRows = await db.all(
        `SELECT l.listing_id, l.exchange_id, l.seller_userid, l.seller_name_snapshot,
                l.buyer_userid, l.buyer_name_snapshot, l.price, l.seller_note, l.status, l.created_at, l.sold_at, l.cancelled_at,
                r.product_id, r.product_name, r.bob_amount
           FROM mall_order_listings l
           LEFT JOIN redeems r ON r.exchange_id = l.exchange_id
          WHERE l.seller_userid = ?
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT 100`,
        [userid],
      );
      return res.json({
        ok: true,
        market_open: marketOpen,
        sellable_orders: (sellableRows || []).map((row) => withPriceRange({
          exchange_id: String(row?.exchange_id || ''),
          product_id: String(row?.product_id || ''),
          product_name: String(row?.product_name || ''),
          original_amount: Number(row?.product_price ?? row?.bob_amount ?? 0),
          product_image_url: row?.product_image_url ? String(row.product_image_url) : '',
          product_remark: row?.product_remark ? String(row.product_remark) : '',
          status: 'pending',
          created_at: row?.created_at ?? null,
        })),
        my_listings: (listingRows || []).map((row) => normalizeMarketListing(row, userid)),
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/market/list', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const name = req.webSession?.name ? String(req.webSession.name).trim() : '';
    const exchangeId = req.body?.exchange_id ? String(req.body.exchange_id).trim() : '';
    const price = toInt(req.body?.price);
    const sellerNote = req.body?.note ? String(req.body.note).trim().slice(0, 200) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!exchangeId || !isMarketOrderExchangeId(exchangeId)) {
      return res.status(400).json({ error: 'invalid exchange_id' });
    }
    if (price === null || price <= 0) {
      return res.status(400).json({ error: 'invalid price' });
    }
    if (!Number.isSafeInteger(price)) {
      return res.status(400).json({ error: 'invalid price' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      if (!await getMarketOpen(db)) {
        return res.status(403).json({ error: 'mall_open' });
      }
      const listingId = genListingId();
      const row = await db.transaction(async (tx) => {
        const opening = await tx.get('SELECT * FROM mall_opening_schedule WHERE id = 1 FOR UPDATE');
        if (isMallOpenRow(opening)) {
          throw new Error('mall_open');
        }
        const order = await tx.get(
          `SELECT exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at
             FROM redeems
            WHERE exchange_id = ?
            LIMIT 1
            FOR UPDATE`,
          [exchangeId],
        );
        if (!order) throw new Error('order not found');
        if (String(order.userid || '') !== userid) throw new Error('order not found');
        if (order.fulfilled_at !== null && order.fulfilled_at !== undefined) throw new Error('order fulfilled');
        const active = await tx.get(
          "SELECT listing_id FROM mall_order_listings WHERE exchange_id = ? AND status = 'active' LIMIT 1",
          [exchangeId],
        );
        if (active) throw new Error('already listed');
        await tx.run(
          `INSERT INTO mall_order_listings(listing_id, exchange_id, seller_userid, seller_name_snapshot, price, seller_note, status)
           VALUES(?, ?, ?, ?, ?, ?, 'active')`,
          [listingId, exchangeId, userid, name || null, price, sellerNote || null],
        );
        return await tx.get(
          `SELECT l.*, r.product_id, r.product_name, r.bob_amount
             FROM mall_order_listings l
             JOIN redeems r ON r.exchange_id = l.exchange_id
            WHERE l.listing_id = ?
            LIMIT 1`,
          [listingId],
        );
      });
      publishMallRealtimeEvent('market_changed', { listing_id: listingId, exchange_id: exchangeId });
      return res.json({ ok: true, data: normalizeMarketListing(row, userid) });
    } catch (err) {
      const message = String(err?.message || err);
      if (message === 'mall_open') return res.status(403).json({ error: 'mall_open' });
      if (message === 'order not found') return res.status(404).json({ error: message });
      if (message === 'already listed') return res.status(409).json({ error: message });
      if (message === 'order fulfilled') return res.status(400).json({ error: message });
      return res.status(500).json({ error: message });
    }
  });

  router.post('/market/update', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const listingId = req.body?.listing_id ? String(req.body.listing_id).trim() : '';
    const price = toInt(req.body?.price);
    const sellerNote = req.body?.note ? String(req.body.note).trim().slice(0, 200) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!listingId) {
      return res.status(400).json({ error: 'missing listing_id' });
    }
    if (price === null || price <= 0 || !Number.isSafeInteger(price)) {
      return res.status(400).json({ error: 'invalid price' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      if (!await getMarketOpen(db)) {
        return res.status(403).json({ error: 'mall_open' });
      }
      const row = await db.transaction(async (tx) => {
        const opening = await tx.get('SELECT * FROM mall_opening_schedule WHERE id = 1 FOR UPDATE');
        if (isMallOpenRow(opening)) throw new Error('mall_open');
        const listing = await tx.get(
          'SELECT * FROM mall_order_listings WHERE listing_id = ? FOR UPDATE',
          [listingId],
        );
        if (!listing || String(listing.seller_userid || '') !== userid) throw new Error('listing not found');
        if (String(listing.status || '') !== 'active') throw new Error('listing not active');
        await tx.run(
          'UPDATE mall_order_listings SET price = ?, seller_note = ?, updated_at = unixepoch() WHERE listing_id = ?',
          [price, sellerNote || null, listingId],
        );
        return await tx.get(
          `SELECT l.*, r.product_id, r.product_name, r.bob_amount
             FROM mall_order_listings l
             JOIN redeems r ON r.exchange_id = l.exchange_id
            WHERE l.listing_id = ?
            LIMIT 1`,
          [listingId],
        );
      });
      publishMallRealtimeEvent('market_changed', { listing_id: listingId, exchange_id: row?.exchange_id || '' });
      return res.json({ ok: true, data: normalizeMarketListing(row, userid) });
    } catch (err) {
      const message = String(err?.message || err);
      if (message === 'mall_open') return res.status(403).json({ error: message });
      if (message === 'listing not found') return res.status(404).json({ error: message });
      if (message === 'listing not active') return res.status(409).json({ error: message });
      return res.status(500).json({ error: message });
    }
  });

  router.post('/market/cancel', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const listingId = req.body?.listing_id ? String(req.body.listing_id).trim() : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!listingId) {
      return res.status(400).json({ error: 'missing listing_id' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      if (!await getMarketOpen(db)) {
        return res.status(403).json({ error: 'mall_open' });
      }
      const result = await db.transaction(async (tx) => {
        const opening = await tx.get('SELECT * FROM mall_opening_schedule WHERE id = 1 FOR UPDATE');
        if (isMallOpenRow(opening)) throw new Error('mall_open');
        const row = await tx.get(
          'SELECT * FROM mall_order_listings WHERE listing_id = ? FOR UPDATE',
          [listingId],
        );
        if (!row) throw new Error('listing not found');
        if (String(row.seller_userid || '') !== userid) throw new Error('listing not found');
        if (String(row.status || '') !== 'active') throw new Error('listing not active');
        await tx.run(
          "UPDATE mall_order_listings SET status = 'cancelled', cancelled_at = unixepoch(), updated_at = unixepoch() WHERE listing_id = ?",
          [listingId],
        );
        return row;
      });
      publishMallRealtimeEvent('market_changed', { listing_id: listingId, exchange_id: result?.exchange_id || '' });
      return res.json({ ok: true, listing_id: listingId });
    } catch (err) {
      const message = String(err?.message || err);
      if (message === 'mall_open') return res.status(403).json({ error: 'mall_open' });
      if (message === 'listing not found') return res.status(404).json({ error: message });
      if (message === 'listing not active') return res.status(409).json({ error: message });
      return res.status(500).json({ error: message });
    }
  });

  router.post('/market/buy', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const buyerUserid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const buyerName = req.webSession?.name ? String(req.webSession.name).trim() : '';
    const listingId = req.body?.listing_id ? String(req.body.listing_id).trim() : '';
    if (!buyerUserid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!listingId) {
      return res.status(400).json({ error: 'missing listing_id' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      if (!await getMarketOpen(db)) {
        return res.status(403).json({ error: 'mall_open' });
      }
      const result = await db.transaction(async (tx) => {
        const opening = await tx.get('SELECT * FROM mall_opening_schedule WHERE id = 1 FOR UPDATE');
        if (isMallOpenRow(opening)) throw new Error('mall_open');
        const listingRef = await tx.get(
          'SELECT listing_id, exchange_id FROM mall_order_listings WHERE listing_id = ? LIMIT 1',
          [listingId],
        );
        if (!listingRef) throw new Error('listing not found');
        const order = await tx.get(
          `SELECT exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at
             FROM redeems
            WHERE exchange_id = ?
            LIMIT 1
            FOR UPDATE`,
          [listingRef.exchange_id],
        );
        if (!order) throw new Error('order not found');
        const listing = await tx.get(
          'SELECT * FROM mall_order_listings WHERE listing_id = ? FOR UPDATE',
          [listingId],
        );
        if (!listing) throw new Error('listing not found');
        if (String(listing.exchange_id || '') !== String(order.exchange_id || '')) throw new Error('listing not active');
        if (String(listing.status || '') !== 'active') throw new Error('listing not active');
        const sellerUserid = String(listing.seller_userid || '');
        if (!sellerUserid) throw new Error('listing not found');
        if (sellerUserid === buyerUserid) throw new Error('cannot trade own listing');
        if (String(order.userid || '') !== sellerUserid) throw new Error('listing not active');
        if (order.fulfilled_at !== null && order.fulfilled_at !== undefined) throw new Error('order fulfilled');
        const price = toInt(listing.price);
        if (price === null || price <= 0 || !Number.isSafeInteger(price)) throw new Error('invalid price');
        const sellerName = String(listing.seller_name_snapshot || '') || await getUserName(tx, sellerUserid);
        await ensureAccount(tx, { userid: buyerUserid, name: buyerName });
        await ensureAccount(tx, { userid: sellerUserid, name: sellerName });
        await tx.all(
          'SELECT userid FROM accounts WHERE userid = ANY(?) ORDER BY userid FOR UPDATE',
          [[buyerUserid, sellerUserid].sort()],
        );
        const transfer = await transferBob(tx, {
          fromUserid: buyerUserid,
          toUserid: sellerUserid,
          amount: price,
          refId: listingId,
          fromName: buyerName,
          toName: sellerName,
        });
        const ownership = await tx.run(
          `UPDATE redeems
              SET userid = ?
            WHERE exchange_id = ?
              AND userid = ?
              AND fulfilled_at IS NULL`,
          [buyerUserid, listing.exchange_id, sellerUserid],
        );
        if (!Number(ownership?.changes || 0)) {
          throw new Error('listing not active');
        }
        await tx.run(
          `UPDATE redeem_cdks
              SET redeemed_by = ?, redeemed_name = ?
            WHERE redeem_exchange_id = ?`,
          [buyerUserid, buyerName || null, listing.exchange_id],
        );
        await tx.run(
          `UPDATE mall_order_listings
              SET status = 'sold', buyer_userid = ?, buyer_name_snapshot = ?, sold_at = unixepoch(), updated_at = unixepoch()
            WHERE listing_id = ?`,
          [buyerUserid, buyerName || null, listingId],
        );
        return {
          listing_id: listingId,
          exchange_id: String(listing.exchange_id || ''),
          seller_userid: sellerUserid,
          buyer_userid: buyerUserid,
          price,
          transfer,
          order,
        };
      });
      publishMallRealtimeEvent('balance_changed', { userid: result.buyer_userid, reason: 'market_buy' });
      publishMallRealtimeEvent('balance_changed', { userid: result.seller_userid, reason: 'market_sell' });
      publishMallRealtimeEvent('order_updated', {
        userids: [result.buyer_userid, result.seller_userid],
        exchange_id: result.exchange_id,
        status: 'transferred',
        source: 'market_buy',
      });
      publishMallRealtimeEvent('market_changed', {
        listing_id: result.listing_id,
        exchange_id: result.exchange_id,
      });
      return res.json({
        ok: true,
        listing_id: result.listing_id,
        exchange_id: result.exchange_id,
        price: result.price,
        from_balance: result.transfer?.fromBalance,
        to_balance: result.transfer?.toBalance,
      });
    } catch (err) {
      const message = String(err?.message || err);
      if (message === 'mall_open') return res.status(403).json({ error: 'mall_open' });
      if (message === 'listing not found' || message === 'order not found') return res.status(404).json({ error: message });
      if (message === 'listing not active') return res.status(409).json({ error: message });
      if (['cannot trade own listing', 'invalid price', 'order fulfilled', 'insufficient balance'].includes(message)) {
        return res.status(400).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  router.get('/orders', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const limitRaw = req.query.limit;
    const limit = Math.min(200, Math.max(1, toOptionalInt(limitRaw) || 50));

    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT r.exchange_id, r.product_id, r.product_name, r.bob_amount, r.fulfilled_at, r.created_at,
                CASE
                  WHEN r.exchange_id LIKE 'AUCTION_%' THEN 'auction'
                  WHEN c.id IS NULL THEN 'purchase'
                  ELSE 'cdk'
                END AS redeem_source,
                CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS cdk_info_available,
                CASE WHEN active_l.listing_id IS NOT NULL THEN 1 ELSE 0 END AS is_listed
           FROM redeems r
           LEFT JOIN redeem_cdks c ON c.redeem_exchange_id = r.exchange_id
           LEFT JOIN mall_order_listings active_l
             ON active_l.exchange_id = r.exchange_id AND active_l.status = 'active'
          WHERE r.userid = ? AND (r.exchange_id LIKE 'MALL_%' OR r.exchange_id LIKE 'CDK_%' OR r.exchange_id LIKE 'AUCTION_%')
          ORDER BY r.created_at DESC
          LIMIT ?`,
        [userid, limit],
      );

      const secret = req.app?.locals?.cfg?.qrSignSecret;
      const data = (rows || []).map((x) => {
        const fulfilledAt = x?.fulfilled_at;
        const pending = fulfilledAt === null || fulfilledAt === undefined;
        const redeemSource = x?.redeem_source ? String(x.redeem_source) : 'purchase';
        const cdkInfoAvailable = Number(x?.cdk_info_available || 0) === 1;
        const isListed = Number(x?.is_listed || 0) === 1;
        if (!pending) {
          return {
            ...x,
            redeem_source: redeemSource,
            cdk_info_available: cdkInfoAvailable,
            is_listed: false,
            status: 'fulfilled',
            encoded: null,
            qr_image_url: null,
          };
        }
        // 已上架到交易市场的订单：不生成二维码
        if (isListed) {
          return {
            ...x,
            redeem_source: redeemSource,
            cdk_info_available: cdkInfoAvailable,
            is_listed: true,
            status: 'listed',
            encoded: null,
            qr_image_url: null,
          };
        }
        try {
          const qr = buildQrForRedeem(
            {
              exchange_id: x.exchange_id,
              userid,
              product_id: x.product_id,
              product_name: x.product_name,
              bob_amount: x.bob_amount,
            },
            secret,
          );
          return {
            ...x,
            redeem_source: redeemSource,
            cdk_info_available: cdkInfoAvailable,
            is_listed: false,
            status: 'pending',
            encoded: qr.encoded,
            qr_image_url: qr.qr_image_url,
          };
        } catch (err) {
          return {
            ...x,
            redeem_source: redeemSource,
            cdk_info_available: cdkInfoAvailable,
            is_listed: false,
            status: 'pending',
            encoded: null,
            qr_image_url: null,
            qr_error: String(err?.message || err),
          };
        }
      });

      return res.json({ ok: true, limit, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/cdk/preview', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const result = await previewRedeemCdk(db, { cdk: req.body?.cdk });
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      const status = [
        'missing cdk',
        'invalid cdk format',
        'cdk not found',
        'cdk deleted',
        'cdk already redeemed',
        'cdk product unavailable',
      ].includes(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.post('/cdk/redeem', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const name = req.webSession?.name ? String(req.webSession.name) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const result = await redeemCdk(db, { userid, name, cdk: req.body?.cdk });
      const secret = req.app?.locals?.cfg?.qrSignSecret;
      let qr = { encoded: null, qr_image_url: null };
      try {
        qr = buildQrForRedeem(
          {
            exchange_id: result.exchange_id,
            userid,
            product_id: result.product_id,
            product_name: result.product_name,
            bob_amount: 0,
          },
          secret,
        );
      } catch {
        qr = { encoded: null, qr_image_url: null };
      }
      publishMallRealtimeEvent('order_updated', {
        userid,
        exchange_id: String(result.exchange_id || ''),
        status: 'pending',
        source: 'cdk_redeem',
      });
      return res.json({ ok: true, ...result, status: 'pending', encoded: qr.encoded, qr_image_url: qr.qr_image_url });
    } catch (err) {
      const message = String(err?.message || err);
      const status = [
        'missing userid',
        'missing cdk',
        'invalid cdk format',
        'cdk not found',
        'cdk deleted',
        'cdk already redeemed',
        'cdk product unavailable',
      ].includes(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.get('/cdk/info', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const result = await getRedeemCdkInfo(db, { userid, exchangeId: req.query?.exchange_id });
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      const status = ['missing userid', 'missing exchange_id', 'cdk info not found'].includes(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.post('/buy', requireWebSession(), requireAnnouncementAccess(), async (req, res) => {
    const db = req.app.locals.db;
    const cfg = req.app?.locals?.cfg;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const name = req.webSession?.name ? String(req.webSession.name) : '';
    const awaitNotify = toBool(req.query?.await_notify) || toBool(req.body?.await_notify);
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const opening = await ensureMallOpeningRow(db);
      const open = Number(opening?.is_open) === 1;
      const token = req.body?.easter_token ? String(req.body.easter_token) : '';
      const easter = !open && isValidMallEasterToken({ userid, token });
      if (!open && !easter) {
        return res.status(403).json({ error: 'mall_closed', next_open_at: opening?.next_open_at ?? null });
      }
      const productId = req.body?.product_id ? String(req.body.product_id).trim() : '';
      const exchangeId = genExchangeId();
      const secret = req.app?.locals?.cfg?.qrSignSecret;
      const omitQrByReq = toBool(req.query?.omit_qr) || toBool(req.body?.omit_qr);
      const result = await buyMallProduct({
        db,
        cfg,
        userid,
        name,
        productId,
        exchangeId,
        secret,
        awaitNotify,
        skipNotify: easter,
        omitQr: omitQrByReq,
      });
      if (!awaitNotify && result && 'notify' in result) {
        delete result.notify;
      }
      invalidateMallProductsCache();
      publishMallRealtimeEvent('balance_changed', { userid, reason: 'mall_buy' });
      publishMallRealtimeEvent('order_updated', {
        userid,
        exchange_id: String(result?.exchange_id || exchangeId),
        status: 'pending',
        source: 'mall_buy',
      });
      publishMallRealtimeEvent('products_changed', { product_id: productId });
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      const status =
        [
          'missing product_id',
          'product not found',
          'product not on sale',
          'invalid product price',
          'out of stock',
          'purchase_limit_reached',
          'insufficient balance',
          'exchange already redeemed',
          'QR_SIGN_SECRET missing',
        ].includes(message)
          ? 400
          : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.post('/buy-api', requireBobToken(), async (req, res) => {
    const db = req.app.locals.db;
    const cfg = req.app?.locals?.cfg;
    const userid = req.body?.userid ? String(req.body.userid).trim() : '';
    const productId = req.body?.product_id ? String(req.body.product_id).trim() : '';
    const exchangeId = req.body?.exchange_id ? String(req.body.exchange_id).trim() : genExchangeId();
    const awaitNotify = toBool(req.query?.await_notify) || toBool(req.body?.await_notify);

    if (!userid) {
      return res.status(400).json({ error: 'missing userid' });
    }
    const name = req.body?.name ? String(req.body.name).trim() : await getUserName(db, userid);

    try {
      const opening = await ensureMallOpeningRow(db);
      if (Number(opening?.is_open) !== 1) {
        return res.status(403).json({ error: 'mall_closed', next_open_at: opening?.next_open_at ?? null });
      }
      const secret = req.app?.locals?.cfg?.qrSignSecret;
      const result = await buyMallProduct({ db, cfg, userid, name, productId, exchangeId, secret, awaitNotify });
      if (!awaitNotify && result && 'notify' in result) {
        delete result.notify;
      }
      invalidateMallProductsCache();
      publishMallRealtimeEvent('balance_changed', { userid, reason: 'mall_buy_api' });
      publishMallRealtimeEvent('order_updated', {
        userid,
        exchange_id: String(result?.exchange_id || exchangeId),
        status: 'pending',
        source: 'mall_buy_api',
      });
      publishMallRealtimeEvent('products_changed', { product_id: productId });
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      const status =
        [
          'missing product_id',
          'missing exchange_id',
          'product not found',
          'product not on sale',
          'invalid product price',
          'out of stock',
          'purchase_limit_reached',
          'insufficient balance',
          'exchange already redeemed',
          'QR_SIGN_SECRET missing',
        ].includes(message)
          ? 400
          : 500;
      return res.status(status).json({ error: message });
    }
  });

  return router;
}
