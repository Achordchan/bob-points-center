// 年会管理端路由（挂载于 /admin/gala/*）。权限见 adminPermissionService.matchPathPermission：
// GET → gala:view；抽签与发币 → gala:operate；其余写操作 → gala:edit；/gala/reserved/* 仅超级管理员。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireAdminSession } from '../../middleware/requireAdminSession.js';
import { getAdminAccess, hasAdminPermission } from '../../services/adminPermissionService.js';
import { publishMallRealtimeEvent } from '../../services/mallRealtimeService.js';
import {
  getGalaScreenState,
  revealRoundIfRolling,
  setGalaScreenState,
} from '../../services/galaScreenService.js';
import { getAdminSessionPayload } from './shared.js';
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
  serializeGrantResult,
  parseGalaVersion,
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
    for (const key of ['remaining', 'required', 'spent', 'allocated', 'pools_total', 'max_draw_count', 'next_round_no', 'min_budget', 'index']) {
      if (err[key] !== undefined) body[key] = err[key];
    }
    return res.status(err.status || 400).json(body);
  }
  if (err?.code === '23505') return res.status(409).json({ error: 'conflict' });
  // 意外错误只在服务端记录原文：数据库报错里的表名、约束名等内部信息不返回给调用方。
  // eslint-disable-next-line no-console
  console.error('[gala] unexpected error', err);
  return res.status(500).json({ error: 'internal_error' });
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

// 活动范围内的写接口必须带回读到数据时的 gala_version（活动详情、活动列表返回）：
// 全量恢复可能复用同一个活动/奖池/名额 ID，旧页面的请求不能落到恢复后的另一份数据上。
const versionOf = (b) => parseGalaVersion(b?.gala_version);

const galaScreenHtml = fileURLToPath(new URL('../../pages/admin-app-dist/screen.html', import.meta.url));

export function registerAdminGalaRoutes(router) {
  router.get('/gala/screen', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const redirectToLogin = () => res.redirect(302, `/admin/login?redirect=${encodeURIComponent(req.originalUrl || '/admin/gala/screen')}`);
    let payload;
    try {
      payload = await getAdminSessionPayload(req);
      if (!payload) return redirectToLogin();
      const db = req.app?.locals?.db;
      const cfg = req.app?.locals?.cfg;
      const access = await getAdminAccess(db, cfg, payload);
      if (!access?.ok || !hasAdminPermission(access, 'gala:view')) {
        return redirectToLogin();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[gala] screen auth error', err);
      return res.status(500).type('text').send('internal_error');
    }
    req.adminSession = payload;
    if (!existsSync(galaScreenHtml)) {
      return res.status(503).type('text').send('大屏页面未构建');
    }
    return res.type('html').sendFile(galaScreenHtml);
  });

  router.get('/gala/segments', requireAdminSession(), handle(async (_req, res) => {
    res.json({
      ok: true,
      data: Object.entries(GALA_SEGMENTS).map(([key, label]) => ({ key, label, drawable: GALA_DRAW_SEGMENTS.has(key) })),
    });
  }));

  router.get('/gala/events', requireAdminSession(), handle(async (req, res, db) => {
    res.json({ ok: true, data: await listGalaEvents(db, { beforeId: req.query?.before_id, limit: req.query?.limit }) });
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
      expectedVersion: versionOf(b),
    });
    publishMallRealtimeEvent('gala_changed', { event_id: data.id, reason: 'event_updated' });
    res.json({ ok: true, data });
  }));

  router.post('/gala/pools/create', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await createGalaPool(db, { eventId: b.event_id, name: b.name, sponsor: b.sponsor, budget: b.budget, expectedVersion: versionOf(b) });
    res.json({ ok: true, data });
  }));

  router.post('/gala/pools/update', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await updateGalaPool(db, { poolId: b.id, name: b.name, sponsor: b.sponsor, budget: b.budget, expectedVersion: versionOf(b) });
    res.json({ ok: true, data });
  }));

  router.get('/gala/participants', requireAdminSession(), handle(async (req, res, db) => {
    res.json({ ok: true, data: await listGalaParticipants(db, {
      eventId: req.query?.event_id,
      afterId: req.query?.after_id,
      limit: req.query?.limit,
      includeReserved: isSuper(req),
    }) });
  }));

  router.post('/gala/participants/add', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await addGalaParticipants(db, {
      eventId: b.event_id,
      userids: b.userids,
      allActiveDingtalk: b.all_active_dingtalk === true,
      tableNo: b.table_no,
      expectedVersion: versionOf(b),
    });
    res.json({ ok: true, data });
  }));

  router.post('/gala/participants/remove', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    res.json({ ok: true, data: await removeGalaParticipant(db, { eventId: b.event_id, userid: b.userid, participantId: b.participant_id, expectedVersion: versionOf(b) }) });
  }));

  router.get('/gala/rounds', requireAdminSession(), handle(async (req, res, db) => {
    const data = await listGalaRounds(db, {
      eventId: req.query?.event_id,
      beforeId: req.query?.before_id,
      limit: req.query?.limit,
      includeReserved: isSuper(req),
    });
    res.json({ ok: true, data });
  }));

  router.post('/gala/rounds/draw', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const result = await drawGalaRound(db, {
      eventId: b.event_id,
      segment: b.segment,
      title: b.title,
      drawCount: b.draw_count,
      // 只有没传时才默认无币轮；显式的 null、空串、false、0 等无效值交给服务层报 invalid_prize_type，
      // 不能当成省略：否则带着奖池和单价的请求会落库成一轮无币轮，重试也改不回来。
      prizeType: b.prize_type === undefined ? 'none' : b.prize_type,
      poolId: b.pool_id,
      amountEach: b.amount_each,
      excludePreviousWinners: b.exclude_previous_winners === undefined ? true : b.exclude_previous_winners,
      actor: actorOf(req),
      expectedVersion: versionOf(b),
      // 必传：本环节要抽的轮次号（最新一轮 + 1）。同样参数的重试返回已抽出的那一轮，不会多抽。
      expectedRoundNo: b.round_no === undefined ? null : b.round_no,
    });
    const data = serializeDrawResult(result, { includeReserved: isSuper(req) });
    // 重放也发：上一次请求可能在事务提交后、发通知前退出，重试是补发的唯一机会。通知只是“按轮次 ID 刷新”的信号，
    // 订阅端收到重复的同一轮次不会有副作用。通知走进程内订阅表，只送达本实例的连接（与其他实时事件相同）。
    publishMallRealtimeEvent('gala_changed', { event_id: data.event_id, round_id: data.id, reason: 'round_drawn' });
    try {
      const screen = revealRoundIfRolling(data.event_id, data.id);
      if (screen) {
        publishMallRealtimeEvent('gala_screen', { event_id: screen.event_id, version: screen.version, scopes: ['screen'] });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[gala] screen reveal hook error', err);
    }
    res.json({ ok: true, data });
  }));

  router.get('/gala/screen/state', requireAdminSession(), handle(async (req, res) => {
    const data = getGalaScreenState(req.query?.event_id);
    res.json({ ok: true, data });
  }));

  router.post('/gala/screen/state', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await setGalaScreenState(db, {
      eventId: b.event_id,
      mode: b.mode,
      segment: b.segment,
      roundId: b.round_id,
    });
    publishMallRealtimeEvent('gala_screen', { event_id: data.event_id, version: data.version, scopes: ['screen'] });
    res.json({ ok: true, data });
  }));

  router.post('/gala/rounds/grant', requireAdminSession(), handle(async (req, res, db) => {
    const result = await grantGalaRound(db, {
      roundId: req.body?.round_id,
      grantToken: req.body?.grant_token,
      // 每笔到账事务提交后立即通知，不等整次发放结束：中途因恢复停止时已到账的人也能收到。
      onAwarded: (g) => publishMallRealtimeEvent('balance_changed', { userid: g.userid, reason: 'gala_award' }),
    });
    // 广播给所有订阅者（含大屏、商城）的公共事件：只说整轮是否发完，不含逐人结果。
    publishMallRealtimeEvent('gala_changed', {
      round_id: result.round_id,
      reason: result.pending === 0 ? 'round_granted' : 'round_grant_partial',
    });
    res.json({ ok: true, data: serializeGrantResult(result, { includeReserved: isSuper(req) }) });
  }));

  router.get('/gala/reserved', requireAdminSession(), handle(async (req, res, db) => {
    res.json({ ok: true, data: await listGalaReservedSlots(db, { eventId: req.query?.event_id, beforeId: req.query?.before_id, limit: req.query?.limit }) });
  }));

  router.post('/gala/reserved/pools/create', requireAdminSession(), handle(async (req, res, db) => {
    const b = req.body || {};
    const data = await createGalaPool(db, {
      eventId: b.event_id,
      name: b.name,
      sponsor: b.sponsor,
      budget: b.budget,
      reserved: true,
      expectedVersion: versionOf(b),
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
      reserved: true,
      expectedVersion: versionOf(b),
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
      note: b.note,
      actor: actorOf(req),
      expectedVersion: versionOf(b),
    });
    res.json({ ok: true, data });
  }));

  router.post('/gala/reserved/cancel', requireAdminSession(), handle(async (req, res, db) => {
    res.json({ ok: true, data: await cancelGalaReservedSlot(db, { slotId: req.body?.id, expectedVersion: versionOf(req.body) }) });
  }));
}
