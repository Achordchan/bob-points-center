// 年会管理端路由（挂载于 /admin/gala/*）。权限见 adminPermissionService.matchPathPermission：
// GET → gala:view；抽签与发币 → gala:operate；其余写操作 → gala:edit；/gala/reserved/* 仅超级管理员。
import { requireAdminSession } from '../../middleware/requireAdminSession.js';
import { publishMallRealtimeEvent } from '../../services/mallRealtimeService.js';
import {
  GalaError,
  GALA_SEGMENTS,
  GALA_DRAW_SEGMENTS,
  addGalaParticipants,
  cancelGalaReservedSlot,
  createGalaEvent,
  createGalaPool,
  createGalaReservedSlot,
  drawGalaRound,
  getGalaEventDetail,
  grantGalaRound,
  listGalaEvents,
  listGalaParticipants,
  listGalaReservedSlots,
  listGalaRounds,
  removeGalaParticipant,
  serializeDrawResult,
  updateGalaEvent,
  updateGalaPool,
} from '../../services/galaService.js';

function actorOf(req) {
  return { userid: req.adminSession?.userid || '', name: req.adminSession?.name || '' };
}

function isSuper(req) {
  return req.adminAccess?.isSuperAdmin === true;
}

function sendError(res, err) {
  if (err instanceof GalaError) {
    const body = { error: err.code };
    for (const key of ['remaining', 'required', 'spent', 'pools_total']) {
      if (err[key] !== undefined) body[key] = err[key];
    }
    return res.status(err.status || 400).json(body);
  }
  if (err?.code === '23505') return res.status(409).json({ error: 'conflict' });
  return res.status(500).json({ error: String(err?.message || err) });
}

function handle(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      return await fn(req, res, req.app?.locals?.db);
    } catch (err) {
      return sendError(res, err);
    }
  };
}

export function registerAdminGalaRoutes(router) {
  router.get('/gala/segments', requireAdminSession(), handle(async (_req, res) => {
    res.json({
      ok: true,
      data: Object.entries(GALA_SEGMENTS).map(([key, label]) => ({ key, label, drawable: GALA_DRAW_SEGMENTS.has(key) })),
    });
  }));

  router.get('/gala/events', requireAdminSession(), handle(async (_req, res, db) => {
    res.json({ ok: true, data: await listGalaEvents(db) });
  }));

  router.get('/gala/events/detail', requireAdminSession(), handle(async (req, res, db) => {
    const data = await getGalaEventDetail(db, { eventId: req.query?.id, includeReserved: isSuper(req) });
    res.json({ ok: true, data });
  }));

  router.post('/gala/events/create', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await createGalaEvent(db, {
      title: b.title,
      eventDate: b.event_date,
      totalBudget: b.total_budget,
      enabledSegments: b.enabled_segments,
      actor: actorOf(req),
    });
    res.json({ ok: true, data });
  }));

  router.post('/gala/events/update', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await updateGalaEvent(db, {
      eventId: b.id,
      title: b.title,
      eventDate: b.event_date,
      totalBudget: b.total_budget,
      status: b.status,
      enabledSegments: b.enabled_segments,
    });
    publishMallRealtimeEvent('gala_changed', { event_id: data.id, reason: 'event_updated' });
    res.json({ ok: true, data });
  }));

  router.post('/gala/pools/create', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await createGalaPool(db, { eventId: b.event_id, name: b.name, sponsor: b.sponsor, budget: b.budget });
    res.json({ ok: true, data });
  }));

  router.post('/gala/pools/update', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await updateGalaPool(db, { poolId: b.id, name: b.name, sponsor: b.sponsor, budget: b.budget });
    res.json({ ok: true, data });
  }));

  router.get('/gala/participants', requireAdminSession(), handle(async (req, res, db) => {
    res.json({ ok: true, data: await listGalaParticipants(db, { eventId: req.query?.event_id }) });
  }));

  router.post('/gala/participants/add', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await addGalaParticipants(db, {
      eventId: b.event_id,
      userids: b.userids,
      allActiveDingtalk: b.all_active_dingtalk === true,
      tableNo: b.table_no,
    });
    res.json({ ok: true, data });
  }));

  router.post('/gala/participants/remove', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    res.json({ ok: true, data: await removeGalaParticipant(db, { eventId: b.event_id, userid: b.userid }) });
  }));

  router.get('/gala/rounds', requireAdminSession(), handle(async (req, res, db) => {
    const data = await listGalaRounds(db, { eventId: req.query?.event_id, includeReserved: isSuper(req) });
    res.json({ ok: true, data });
  }));

  router.post('/gala/rounds/draw', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const result = await drawGalaRound(db, {
      eventId: b.event_id,
      segment: b.segment,
      title: b.title,
      drawCount: b.draw_count,
      prizeType: b.prize_type || 'none',
      poolId: b.pool_id,
      amountEach: b.amount_each,
      excludePreviousWinners: b.exclude_previous_winners !== false,
      actor: actorOf(req),
    });
    const data = serializeDrawResult(result, { includeReserved: isSuper(req) });
    publishMallRealtimeEvent('gala_changed', { event_id: data.event_id, round_id: data.id, reason: 'round_drawn' });
    res.json({ ok: true, data });
  }));

  router.post('/gala/rounds/grant', requireAdminSession(), handle(async (req, res, db) => {
    const data = await grantGalaRound(db, { roundId: req.body?.round_id });
    for (const g of data.granted) {
      publishMallRealtimeEvent('balance_changed', { userid: g.userid, reason: 'gala_award' });
    }
    publishMallRealtimeEvent('gala_changed', { round_id: data.round_id, reason: 'round_granted' });
    res.json({ ok: true, data });
  }));

  router.get('/gala/reserved', requireAdminSession(), handle(async (req, res, db) => {
    res.json({ ok: true, data: await listGalaReservedSlots(db, { eventId: req.query?.event_id }) });
  }));

  router.post('/gala/reserved/pools/create', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await createGalaPool(db, {
      eventId: b.event_id,
      name: b.name,
      sponsor: b.sponsor,
      budget: b.budget,
      reserved: true,
    });
    res.json({ ok: true, data });
  }));

  router.post('/gala/reserved/pools/update', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await updateGalaPool(db, {
      poolId: b.id,
      name: b.name,
      sponsor: b.sponsor,
      budget: b.budget,
      allowReserved: true,
    });
    res.json({ ok: true, data });
  }));

  router.post('/gala/reserved/create', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await createGalaReservedSlot(db, {
      eventId: b.event_id,
      segment: b.segment,
      roundNo: b.round_no,
      userid: b.userid,
      poolId: b.pool_id,
      amount: b.amount,
      note: b.note,
      actor: actorOf(req),
    });
    res.json({ ok: true, data });
  }));

  router.post('/gala/reserved/cancel', requireAdminSession(), handle(async (req, res, db) => {
    res.json({ ok: true, data: await cancelGalaReservedSlot(db, { slotId: req.body?.id }) });
  }));
}
