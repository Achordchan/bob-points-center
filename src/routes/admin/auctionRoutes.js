// 限时竞拍管理端路由（挂载于 /admin/auction/*）
import { requireAdminSession } from '../../middleware/requireAdminSession.js';
import { publishMallRealtimeEvent } from '../../services/mallRealtimeService.js';
import { sendOrQueueNotify } from '../../services/notifyOpsService.js';
import {
  cancelAuction,
  createAuction,
  getAuctionDetailForAdmin,
  listAuctionActivitiesForAdmin,
  notifyAuctionWinners,
} from '../../services/auctionService.js';
import { toInt, toOptionalInt } from './shared.js';

function mapAuctionAdminError(err) {
  const msg = String(err?.message || err || '');
  if (err?.code === 'invalid_auction_input') return { status: 400, code: msg, errors: err.errors };
  if (err?.code === '23505') return { status: 409, code: 'concurrent_bid_conflict' };
  if (msg === 'auction not found') return { status: 404, code: msg };
  if (msg === 'auction_already_cancelled' || msg === 'auction_already_settled') {
    return { status: 409, code: msg };
  }
  if (msg === 'invalid activity_id') return { status: 400, code: msg };
  return { status: 500, code: msg };
}

function publishAuctionChanged(reason, activityId) {
  publishMallRealtimeEvent('auction_changed', {
    reason,
    ...(activityId ? { activity_id: Number(activityId) } : {}),
  });
}

export function registerAdminAuctionRoutes(router) {
  router.get('/auction/list', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const now = Math.floor(Date.now() / 1000);
      const limitRaw = toOptionalInt(req.query?.limit);
      const status = req.query?.status ? String(req.query.status).trim() : '';
      const result = await listAuctionActivitiesForAdmin(db, {
        now,
        status,
        limit: limitRaw || 50,
      });
      if (result.settledWinners?.length) {
        for (const winner of result.settledWinners) {
          const activity = result.list.find((x) => x.id === winner.activity_id);
          winner.title = activity ? activity.title : '';
        }
        notifyAuctionWinners({ db, cfg: req.app?.locals?.cfg, winners: result.settledWinners });
        publishAuctionChanged('settled');
      }
      return res.json({
        ok: true,
        data: result.list,
        server_time: now,
        server_time_ms: Date.now(),
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/auction/create', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const admin = req.adminSession || {};
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await createAuction(db, {
        input: req.body || {},
        createdBy: admin.userid ? String(admin.userid) : '',
        createdName: admin.name ? String(admin.name) : '',
      });
      publishAuctionChanged('created', data.id);
      return res.json({ ok: true, data });
    } catch (err) {
      const mapped = mapAuctionAdminError(err);
      const body = { error: mapped.code };
      if (mapped.errors) body.errors = mapped.errors;
      return res.status(mapped.status).json(body);
    }
  });

  router.get('/auction/detail', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const activityId = toOptionalInt(req.query?.id);
    if (!activityId) {
      return res.status(400).json({ error: 'invalid activity_id' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const now = Math.floor(Date.now() / 1000);
      const result = await getAuctionDetailForAdmin(db, { activityId, now });
      if (result.settledWinner) {
        result.settledWinner.title = result.activity.title;
        notifyAuctionWinners({ db, cfg: req.app?.locals?.cfg, winners: [result.settledWinner] });
        publishAuctionChanged('settled', activityId);
      }
      return res.json({ ok: true, data: result.activity, server_time: now });
    } catch (err) {
      const mapped = mapAuctionAdminError(err);
      return res.status(mapped.status).json({ error: mapped.code });
    }
  });

  router.post('/auction/cancel', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const activityId = toInt(req.body?.activity_id);
    const reason = req.body?.reason === null || req.body?.reason === undefined
      ? ''
      : String(req.body.reason).trim();
    if (activityId === null || activityId <= 0) {
      return res.status(400).json({ error: 'invalid activity_id' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await cancelAuction(db, { activityId, reason });
      if (result.refunded?.userid) {
        sendOrQueueNotify({
          db,
          cfg: req.app?.locals?.cfg,
          userid: result.refunded.userid,
          title: '【BOB币中心】竞拍已取消',
          lines: [
            `竞拍 #${activityId} 已被管理员取消`,
            `你冻结的 ${String(result.refunded.amount)} BOB 币出价已全额退回余额。`,
          ],
          event: 'auction',
          variables: {
            amount: String(result.refunded.amount),
            activity_id: String(activityId),
          },
        }).catch(() => null);
        publishMallRealtimeEvent('balance_changed', {
          userid: result.refunded.userid,
          reason: 'auction_cancel_refund',
        });
      }
      publishAuctionChanged('cancelled', activityId);
      return res.json({ ok: true, data: result.activity, refunded: result.refunded });
    } catch (err) {
      const mapped = mapAuctionAdminError(err);
      return res.status(mapped.status).json({ error: mapped.code });
    }
  });
}
