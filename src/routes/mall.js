import { Router } from 'express';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { requireBobToken } from '../middleware/requireBobToken.js';
import { requireWebSession } from '../middleware/requireWebSession.js';
import { createRedeemOrderInTx } from '../services/redeemService.js';
import { ensureAccount, listLedgerRecords } from '../services/ledgerService.js';
import { getUserName, sendOrQueueNotify, toBool } from '../services/notifyOpsService.js';
import { notifyGroupInteractiveCardBySettings } from '../services/groupCardNotifyService.js';
import { getRedeemCdkInfo, previewRedeemCdk, redeemCdk } from '../services/cdkService.js';
import { contributeToCharity, getCharityProjectDetail, listMallCharityProjects } from '../services/charityService.js';
import { publishMallRealtimeEvent, registerMallRealtimeClient } from '../services/mallRealtimeService.js';
import { buildExchangeData, encodeData, QRSignError } from '../utils/qr.js';

const mallEasterTokens = new Map();
let redPacketClaimQueue = Promise.resolve();
const MALL_PRODUCTS_CACHE_TTL_MS = 2500;
const mallProductsCache = {
  snapshot: null,
  cachedAtMs: 0,
  inflight: null,
};
const MALL_PRODUCTS_QUERY =
  "SELECT product_id, product_name, bob_amount, stock, limit_per_user, limit_round, status, sort, image_url, remark, updated_at FROM mall_products WHERE status = 'on' ORDER BY (sort IS NULL), sort ASC, product_id COLLATE NOCASE";

function enqueueRedPacketClaim(task) {
  const next = redPacketClaimQueue.then(task, task);
  redPacketClaimQueue = next.catch(() => {});
  return next;
}

async function listMallProducts(db) {
  return await db.all(MALL_PRODUCTS_QUERY);
}

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

async function getMallProductsVersionInfo(db) {
  const row = await db.get(
    `SELECT
       COUNT(1) AS total,
       COALESCE(MAX(COALESCE(updated_at, 0)), 0) AS updated_max,
       COALESCE(SUM(COALESCE(updated_at, 0)), 0) AS updated_sum
     FROM mall_products
     WHERE status = 'on'`,
  );
  const total = Number(row?.total ?? 0);
  const updatedMax = Number(row?.updated_max ?? 0);
  const updatedSum = Number(row?.updated_sum ?? 0);
  return {
    total,
    version: `${total}:${updatedMax}:${updatedSum}`,
  };
}

function invalidateMallProductsCache() {
  mallProductsCache.snapshot = null;
  mallProductsCache.cachedAtMs = 0;
}

function publishMoreChanged(section, extra = {}) {
  publishMallRealtimeEvent('more_changed', { section, ...extra });
}

async function getMallProductsSnapshotCached(db, { force = false } = {}) {
  const nowMs = Date.now();
  if (
    !force &&
    mallProductsCache.snapshot &&
    (nowMs - mallProductsCache.cachedAtMs) < MALL_PRODUCTS_CACHE_TTL_MS
  ) {
    return mallProductsCache.snapshot;
  }
  if (!force && mallProductsCache.inflight) {
    return await mallProductsCache.inflight;
  }
  const inflight = (async () => {
    const [rows, versionInfo] = await Promise.all([
      listMallProducts(db),
      getMallProductsVersionInfo(db),
    ]);
    const snapshot = {
      rows: rows || [],
      versionInfo: versionInfo || { total: 0, version: '0:0:0' },
    };
    mallProductsCache.snapshot = snapshot;
    mallProductsCache.cachedAtMs = Date.now();
    return snapshot;
  })();
  mallProductsCache.inflight = inflight;
  try {
    return await inflight;
  } finally {
    if (mallProductsCache.inflight === inflight) {
      mallProductsCache.inflight = null;
    }
  }
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

function normalizeFeedbackCategory(value) {
  const v = value ? String(value).trim() : '';
  if (v === 'bug' || v === 'question' || v === 'rule' || v === 'other') return v;
  return 'suggestion';
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

async function resolveRedPacketActivity(db, now) {
  const activity = await db.get('SELECT * FROM red_packet_activity ORDER BY id DESC LIMIT 1');
  if (!activity) return null;
  let nextStatus = activity.status;
  if (now >= Number(activity.end_at)) {
    nextStatus = 'ended';
  } else if (now >= Number(activity.start_at) && activity.status === 'scheduled') {
    nextStatus = 'active';
  }
  if (nextStatus !== activity.status) {
    await db.run('UPDATE red_packet_activity SET status = ? WHERE id = ?', [nextStatus, activity.id]);
    return await db.get('SELECT * FROM red_packet_activity WHERE id = ?', [activity.id]);
  }
  return activity;
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
  const qr_image_url = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(encoded)}`;
  return { encoded, qr_image_url };
}

export function mallRouter() {
  const router = Router();
  const pagesRoot = fileURLToPath(new URL('../pages/', import.meta.url));

  router.get('/', (_req, res) => {
    res.type('html').sendFile('mall.html', { root: pagesRoot });
  });

  router.get('/screen', (_req, res) => {
    res.type('html').sendFile('mall_screen.html', { root: pagesRoot });
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

  router.get('/me', requireWebSession(), async (req, res) => {
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

  router.get('/users', requireWebSession(), async (req, res) => {
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

  router.get('/rich-board', requireWebSession(), async (req, res) => {
    const db = req.app.locals.db;
    const limit = Math.min(100, Math.max(1, toOptionalInt(req.query?.limit) || 50));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT a.userid, COALESCE(a.balance, 0) AS balance, COALESCE(u.name, '') AS name
         FROM accounts a
         LEFT JOIN users u ON u.userid = a.userid
         WHERE a.userid IS NOT NULL AND trim(a.userid) <> ''
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

  router.get('/popular-products', requireWebSession(), async (req, res) => {
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

  router.get('/more/faq', requireWebSession(), async (req, res) => {
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

  router.get('/more/announcements', requireWebSession(), async (req, res) => {
    const db = req.app.locals.db;
    const limit = Math.min(50, Math.max(1, toOptionalInt(req.query?.limit) || 20));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const now = nowSec();
      const rows = await db.all(
        `SELECT id, title, content, level, publish_at, updated_at
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

  router.get('/more/version', requireWebSession(), async (req, res) => {
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

  router.get('/more/stats', requireWebSession(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const [balanceRow, pendingRow, fulfilledRow, rankRow, feedbackRow] = await Promise.all([
        db.get('SELECT COALESCE(balance, 0) AS balance FROM accounts WHERE userid = ? LIMIT 1', [userid]),
        db.get("SELECT COUNT(1) AS cnt FROM redeems WHERE userid = ? AND fulfilled_at IS NULL AND exchange_id LIKE 'MALL_%'", [userid]),
        db.get("SELECT COUNT(1) AS cnt FROM redeems WHERE userid = ? AND fulfilled_at IS NOT NULL AND exchange_id LIKE 'MALL_%'", [userid]),
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

  router.get('/more/feedback/mine', requireWebSession(), async (req, res) => {
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
      return res.json({ ok: true, count: (rows || []).length, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/more/feedback', requireWebSession(), async (req, res) => {
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
      const r = await db.run(
        `INSERT INTO user_feedback(userid, name, category, content, contact, status, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, 'pending', unixepoch(), unixepoch())`,
        [userid, name || '', category, content, contact || ''],
      );
      publishMoreChanged('feedback', { userids: [userid], feedback_id: Number(r?.lastID || 0) });
      return res.json({ ok: true, id: Number(r?.lastID || 0) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/red-packet/status', requireWebSession(), async (req, res) => {
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

  router.post('/red-packet/claim', requireWebSession(), async (req, res) => {
    const db = req.app.locals.db;
    const userid = req.webSession?.userid ? String(req.webSession.userid) : '';
    const name = req.webSession?.name ? String(req.webSession.name) : '';
    const awaitNotify = toBool(req.query?.await_notify) || toBool(req.body?.await_notify);
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    let result = null;
    try {
      result = await enqueueRedPacketClaim(async () => {
        const now = Math.floor(Date.now() / 1000);
        const txRunner = typeof db.transaction === 'function'
          ? (fn) => db.transaction(fn)
          : async (fn) => await fn(db);
        return await txRunner(async (tx) => {
          const activity = await resolveRedPacketActivity(tx, now);
          if (!activity) {
            throw new Error('no_active');
          }
          if (now < Number(activity.start_at)) {
            throw new Error('not_started');
          }
          if (now >= Number(activity.end_at)) {
            await tx.run('UPDATE red_packet_activity SET status = ? WHERE id = ?', ['ended', activity.id]);
            throw new Error('ended');
          }
          if (activity.status === 'ended') {
            throw new Error('ended');
          }
          if (activity.status !== 'active') {
            await tx.run('UPDATE red_packet_activity SET status = ? WHERE id = ?', ['active', activity.id]);
          }

          const mine = await tx.get(
            'SELECT id, amount FROM red_packet_items WHERE activity_id = ? AND claimed_by = ? LIMIT 1',
            [activity.id, userid],
          );
          if (mine?.id) {
            throw new Error('already_claimed');
          }

          const item = await tx.get(
            'SELECT id, amount FROM red_packet_items WHERE activity_id = ? AND claimed_by IS NULL ORDER BY id ASC LIMIT 1',
            [activity.id],
          );
          if (!item) {
            await tx.run('UPDATE red_packet_activity SET status = ? WHERE id = ?', ['ended', activity.id]);
            throw new Error('sold_out');
          }

          const updated = await tx.run(
            'UPDATE red_packet_items SET claimed_by = ?, claimed_at = unixepoch() WHERE id = ? AND claimed_by IS NULL',
            [userid, item.id],
          );
          if (!updated?.changes) {
            throw new Error('sold_out');
          }

          await ensureAccount(tx, { userid, name });
          await tx.run(
            'INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)',
            [userid, Number(item.amount), '红包收入', `RED_PACKET_${activity.id}_${item.id}`],
          );
          await tx.run(
            'UPDATE accounts SET balance = balance + ?, updated_at = unixepoch() WHERE userid = ?',
            [Number(item.amount), userid],
          );
          const balanceRow = await tx.get('SELECT balance FROM accounts WHERE userid = ?', [userid]);

          return {
            amount: Number(item.amount),
            balance: balanceRow?.balance ?? 0,
            activity_id: activity.id,
          };
        });
      });
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
      const isBusy =
        pgCode === '55P03' ||
        pgCode === '40P01';
      const errorCode = isBusy ? 'concurrent_limit' : msg;
      const status = isBusy ? 429 : 400;
      return res.status(status).json({ error: errorCode });
    }
  });

  router.get('/opening', requireWebSession(), async (req, res) => {
    const db = req.app.locals.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await ensureMallOpeningRow(db);
      return res.json({ ok: true, data: row || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/easter/unlock', requireWebSession(), async (req, res) => {
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

  router.get('/ledger', requireWebSession(), async (req, res) => {
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

  router.get('/products', requireWebSession(), async (req, res) => {
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

  router.get('/products/version', requireWebSession(), async (req, res) => {
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

  router.get('/charity/projects', requireWebSession(), async (req, res) => {
    const db = req.app.locals.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await listMallCharityProjects(db);
      return res.json({ ok: true, count: rows.length, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/charity/project', requireWebSession(), async (req, res) => {
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

  router.post('/charity/contribute', requireWebSession(), async (req, res) => {
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

  router.get('/orders', requireWebSession(), async (req, res) => {
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
                CASE WHEN c.id IS NULL THEN 'purchase' ELSE 'cdk' END AS redeem_source,
                CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS cdk_info_available
           FROM redeems r
           LEFT JOIN redeem_cdks c ON c.redeem_exchange_id = r.exchange_id
          WHERE r.userid = ? AND (r.exchange_id LIKE 'MALL_%' OR r.exchange_id LIKE 'CDK_%')
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
        if (!pending) {
          return {
            ...x,
            redeem_source: redeemSource,
            cdk_info_available: cdkInfoAvailable,
            status: 'fulfilled',
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
            status: 'pending',
            encoded: qr.encoded,
            qr_image_url: qr.qr_image_url,
          };
        } catch (err) {
          return {
            ...x,
            redeem_source: redeemSource,
            cdk_info_available: cdkInfoAvailable,
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

  router.post('/cdk/preview', requireWebSession(), async (req, res) => {
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

  router.post('/cdk/redeem', requireWebSession(), async (req, res) => {
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

  router.get('/cdk/info', requireWebSession(), async (req, res) => {
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

  router.post('/buy', requireWebSession(), async (req, res) => {
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
