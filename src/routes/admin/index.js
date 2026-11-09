import { Router } from 'express';
import dns from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDingtalkOAuthAuthorizeUrl,
  buildJsapiConfig,
  getAccessToken,
  getDingtalkOrganizationProfile,
  getV1AccessToken,
  getUserIdByAuthCode,
  getUserIdByOAuthCode,
  getUserProfile,
  hasDingtalkGroupOpenConversationId,
  listSubDepartments,
  notableListRecords,
  queryDingtalkOpenGroupBaseInfo,
  queryDingtalkGroupRobot,
} from '../../services/dingtalkService.js';
import {
  buildClearDingtalkOAuthStateCookie,
  buildDingtalkOAuthStateCookie,
  createDingtalkOAuthState,
  verifyDingtalkOAuthState,
} from '../../services/dingtalkOAuthState.js';
import {
  buildClearSessionCookie,
  buildClearLegacyAdminPathCookie,
  buildSessionCookie,
  createSessionToken,
  parseCookies,
  verifySessionToken,
} from '../../services/adminSession.js';
import { ensureAccount, listLedgerRecords } from '../../services/ledgerService.js';
import { deleteRedeemCdks, generateRedeemCdks, listCdkEnabledProducts, listRedeemCdks } from '../../services/cdkService.js';
import { deleteUsersCompletely, purgeUserBusinessData } from '../../services/userDataPurgeService.js';
import { adminSessionSigningSecret, cookieOptions, withSessionVersion, isSessionVersionValidLive } from '../../utils/sessionCrypto.js';
import {
  listAdminCharityContributions,
  listAdminCharityProjects,
  saveCharityProject,
} from '../../services/charityService.js';
import { normalizeMallProductInput } from '../../services/mallService.js';
import { adminDeductBatchWithNotify, grantBatchWithNotify, redeemConfirmWithNotify } from '../../services/bobOpsService.js';
import { toBool } from '../../services/notifyOpsService.js';
import { sendRobotPrivateText } from '../../services/robotNotifyService.js';
import {
  buildEffectiveGroupCardSettings,
  mergeGroupCardChannelIntoCfg,
  notifyGroupInteractiveCardBySettings,
  sendGroupInteractiveCard,
} from '../../services/groupCardNotifyService.js';
import { getClientIp, purgeExpiredAuditLogs, safeAppendAuditLog } from '../../services/auditLogService.js';
import { getAttendanceRewardDailySummary, getAttendanceRewardDayDetail, reconcileAttendanceRewards } from '../../services/attendanceRewardService.js';
import { publishMallRealtimeEvent } from '../../services/mallRealtimeService.js';
import { syncAllDingtalkUsers } from '../../services/dingtalkUserSyncService.js';
import { invalidateMallProductsCache } from '../../services/mallProductsCache.js';
import {
  decodeAdminRedeemCursor,
  encodeAdminRedeemCursor,
  publicAdminOrderReference,
  serializeAdminRedeemRow,
} from '../../services/adminRedeemVisibilityService.js';
import {
  applyDingtalkConnectionSettings,
  getAttendanceRewardSettings,
  getDingtalkConnectionSettings,
  getGroupCardSettings,
  getNotifySettings,
  getSiteVisibilitySettings,
  saveAttendanceRewardSettings,
  saveDingtalkConnectionSettings,
  saveSiteVisibilitySettings,
  toPublicDingtalkConnectionSettings,
  saveGroupCardSettings,
  saveNotifySettings,
} from '../../services/systemSettings.js';
import { EXTERNAL_NOTIFY_SKIPPED, getUserName, sendOrQueueNotify } from '../../services/notifyOpsService.js';
import { getExternalUserids, isExternalUser } from '../../services/externalAccountService.js';
import { requireAdminSession } from '../../middleware/requireAdminSession.js';
import {
  ADMIN_PERMISSION_CATALOG,
  adminAccessMiddleware,
  getAdminAccess,
  hasAdminPermission,
  isSuperAdminSession,
  lockAdminAccountProtection,
  normalizePermissions,
  serializeRole,
} from '../../services/adminPermissionService.js';
import { verifyEncoded, QRSignError } from '../../utils/qr.js';
import { sanitizeRichHtml } from '../../utils/sanitizeHtml.js';
import {
  getImageOptimizationOverview,
  optimizeUploadedImage,
  runImageOptimizationBatch,
  saveImageOptimizationSettings,
} from '../../services/imageOptimizationService.js';
import {
  saveIgnoredResourcePaths,
  scanResources,
} from '../../services/resourceAuditService.js';

import { registerAdminContentRoutes } from './contentRoutes.js';
import { registerAdminSettingsRoutes } from './settingsRoutes.js';
import { registerAdminBackupRoutes } from './backupRoutes.js';
import { registerAdminAuctionRoutes } from './auctionRoutes.js';

import {
  ADMIN_OAUTH_COOKIE,
  buildAdminLoginErrorUrl,
  buildMallCloseCard,
  buildMallOpenCard,
  buildNotifyContent,
  buildRedPacketAmounts,
  compactUserSearchKeyword,
  enrichRedeemConfirmAuditRows,
  ensureMallOpeningRow,
  formatTs,
  getAdminOAuthCallbackUrl,
  getAdminOAuthSecret,
  getAdminSessionPayload,
  getServerInfo,
  isAdmin,
  isFixedAdmin,
  normalizeAdminReturnTo,
  normalizeGroupCardButtons,
  normalizeNotableProductRecordFields,
  normalizeUserSearchKeyword,
  parseAuditPayload,
  publishMallProductsChanged,
  publishMallRealtimeFullRefresh,
  publishMallRealtimeResetForUser,
  renderTemplateVars,
  resolveAdminDisplayName,
  runInTransaction,
  sendRobotPrivateTextWithRetry,
  serializeAuditRow,
  serializeOperationRows,
  sleep,
  toInt,
  toOptionalInt,
  toPositiveInt,
} from './shared.js';

export function adminRouter() {
  const router = Router();
  const pagesRoot = fileURLToPath(new URL('../../pages/', import.meta.url));
  const adminAppIndex = fileURLToPath(new URL('../../pages/admin-app-dist/index.html', import.meta.url));

  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, '/admin/login');
  });

  router.use(adminAccessMiddleware());

  router.post('/notify/group-card', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const title = req.body?.title === null || req.body?.title === undefined ? '' : String(req.body.title).trim();
    const markdown = req.body?.markdown === null || req.body?.markdown === undefined ? '' : String(req.body.markdown).trim();
    const outTrackId = req.body?.outTrackId === null || req.body?.outTrackId === undefined ? '' : String(req.body.outTrackId).trim();
    const imageUrl = req.body?.imageUrl === null || req.body?.imageUrl === undefined ? '' : String(req.body.imageUrl).trim();
    const buttons = normalizeGroupCardButtons(req.body?.buttons);

    if (!title && !markdown) {
      return res.status(400).json({ error: 'missing title or content' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const groupCardSettings = await getGroupCardSettings(db);
      if (groupCardSettings?.enabled === false) {
        return res.status(400).json({ error: 'group_card_disabled' });
      }
      const tpl = groupCardSettings?.templates?.manual || { title: '{{title}}', content: '{{content}}' };
      if (tpl?.enabled === false) {
        return res.status(400).json({ error: 'group_card_manual_disabled' });
      }
      const vars = { title, content: markdown };
      const titleFinal = renderTemplateVars(tpl?.title, vars) || title || 'BOB币中心';
      const markdownFinal = renderTemplateVars(tpl?.content, vars) || markdown || title;
      // Use explicitly submitted buttons first, then template buttons, then form buttons array
      const tplButtons = Array.isArray(tpl?.buttons) ? tpl.buttons : [];
      const finalButtons = buttons.length ? buttons : tplButtons;
      const runtimeCfg = mergeGroupCardChannelIntoCfg(cfg, groupCardSettings);
      const result = await sendGroupInteractiveCard(runtimeCfg, {
        title: titleFinal,
        markdown: markdownFinal,
        outTrackId: outTrackId || undefined,
        buttons: finalButtons.length ? finalButtons : undefined,
        imageUrl: imageUrl || undefined,
      });
      return res.json({ ok: true, result });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/red-packet/status', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const now = Math.floor(Date.now() / 1000);
      const activity = await db.get('SELECT * FROM red_packet_activity ORDER BY id DESC LIMIT 1');
      if (!activity) {
        return res.json({ ok: true, data: null, server_time: now });
      }
      let nextStatus = activity.status;
      if (now >= Number(activity.end_at)) {
        nextStatus = 'ended';
      } else if (now >= Number(activity.start_at) && activity.status === 'scheduled') {
        nextStatus = 'active';
      }
      let current = activity;
      if (nextStatus !== activity.status) {
        await db.run('UPDATE red_packet_activity SET status = ? WHERE id = ?', [nextStatus, activity.id]);
        current = await db.get('SELECT * FROM red_packet_activity WHERE id = ?', [activity.id]);
      }
      const counts = await db.get(
        'SELECT COUNT(1) as total, SUM(CASE WHEN claimed_by IS NOT NULL THEN 1 ELSE 0 END) as claimed FROM red_packet_items WHERE activity_id = ?',
        [current.id],
      );
      const claimed = Number(counts?.claimed ?? 0);
      return res.json({
        ok: true,
        data: current,
        claimed_count: claimed,
        server_time: now,
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/red-packet/start', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const totalAmount = toInt(req.body?.total_amount);
    const totalCount = toInt(req.body?.total_count);
    const countdownSeconds = toInt(req.body?.countdown_seconds);
    const durationMinutes = toInt(req.body?.duration_minutes);
    const sponsorRaw = req.body?.sponsor;
    const sponsor = sponsorRaw === null || sponsorRaw === undefined ? '' : String(sponsorRaw).trim();

    if (totalAmount === null || totalAmount <= 0) {
      return res.status(400).json({ error: 'total_amount must be positive integer' });
    }
    if (totalCount === null || totalCount <= 0) {
      return res.status(400).json({ error: 'total_count must be positive integer' });
    }
    if (totalAmount < totalCount) {
      return res.status(400).json({ error: 'total_amount must be >= total_count' });
    }
    if (countdownSeconds === null || countdownSeconds < 0) {
      return res.status(400).json({ error: 'countdown_seconds must be >= 0' });
    }
    if (durationMinutes === null || durationMinutes < 1) {
      return res.status(400).json({ error: 'duration_minutes must be >= 1' });
    }

    let amounts;
    try {
      amounts = buildRedPacketAmounts(totalAmount, totalCount);
    } catch (err) {
      return res.status(400).json({ error: String(err?.message || err) });
    }

    const now = Math.floor(Date.now() / 1000);
    const startAt = now + countdownSeconds;
    const endAt = startAt + durationMinutes * 60;

    try {
      res.setHeader('Cache-Control', 'no-store');
      const activityId = await runInTransaction(db, async (tx) => {
        await tx.run("UPDATE red_packet_activity SET status = 'ended' WHERE status != 'ended'");
        const insert = await tx.run(
          'INSERT INTO red_packet_activity(total_amount, total_count, countdown_seconds, duration_minutes, start_at, end_at, status, sponsor) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
          [totalAmount, totalCount, countdownSeconds, durationMinutes, startAt, endAt, 'scheduled', sponsor || null],
        );
        const nextActivityId = insert?.lastID;
        if (!nextActivityId) {
          throw new Error('create activity failed');
        }
        for (const amount of amounts) {
          await tx.run('INSERT INTO red_packet_items(activity_id, amount) VALUES(?, ?)', [nextActivityId, amount]);
        }
        return nextActivityId;
      });

      const activity = await db.get('SELECT * FROM red_packet_activity WHERE id = ?', [activityId]);
      publishMallRealtimeEvent('red_packet_changed', { activity_id: Number(activityId) });
      publishMallRealtimeEvent('screen_changed', { scopes: ['screen'], activity_id: Number(activityId) });
      return res.json({ ok: true, data: activity, server_time: now });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/red-packet/history', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limitRaw = toOptionalInt(req.query?.limit);
    const limit = Math.min(100, Math.max(1, limitRaw || 30));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const activities = await db.all(
        'SELECT * FROM red_packet_activity ORDER BY id DESC LIMIT ?',
        [limit],
      );
      const data = [];
      for (const activity of activities || []) {
        const counts = await db.get(
          'SELECT COUNT(1) as total, SUM(CASE WHEN claimed_by IS NOT NULL THEN 1 ELSE 0 END) as claimed FROM red_packet_items WHERE activity_id = ?',
          [activity.id],
        );
        const total = Number(counts?.total ?? activity.total_count ?? 0);
        const claimed = Number(counts?.claimed ?? 0);
        const remaining = Math.max(0, total - claimed);
        const claimedItems = await db.all(
          `SELECT r.claimed_by as userid, r.amount, r.claimed_at, u.name
           FROM red_packet_items r
           LEFT JOIN users u ON u.userid = r.claimed_by
           WHERE r.activity_id = ? AND r.claimed_by IS NOT NULL
           ORDER BY r.claimed_at ASC, r.id ASC`,
          [activity.id],
        );
        data.push({
          ...activity,
          claimed_count: claimed,
          remaining_count: remaining,
          claimed_items: claimedItems || [],
        });
      }
      return res.json({ ok: true, data, server_time: Math.floor(Date.now() / 1000) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/red-packet/history/clear', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      await runInTransaction(db, async (tx) => {
        await tx.run('DELETE FROM red_packet_items');
        await tx.run('DELETE FROM red_packet_activity');
      });
      publishMallRealtimeEvent('red_packet_changed', { reason: 'clear' });
      publishMallRealtimeEvent('screen_changed', { scopes: ['screen'], reason: 'clear' });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/red-packet/history/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const activityId = toInt(req.body?.activity_id);
    if (activityId === null || activityId <= 0) {
      return res.status(400).json({ error: 'invalid activity_id' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const r = await runInTransaction(db, async (tx) => {
        const result = await tx.run('DELETE FROM red_packet_activity WHERE id = ?', [activityId]);
        if (!result?.changes) {
          throw new Error('activity not found');
        }
        return result;
      });
      publishMallRealtimeEvent('red_packet_changed', { activity_id: activityId, reason: 'delete' });
      publishMallRealtimeEvent('screen_changed', { scopes: ['screen'], activity_id: activityId, reason: 'delete' });
      return res.json({ ok: true, deleted: r?.changes ?? 0, activity_id: activityId });
    } catch (err) {
      const msg = String(err?.message || err);
      const status = msg === 'activity not found' ? 404 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  router.get('/mall/opening', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await ensureMallOpeningRow(db);
      return res.json({ ok: true, data: row || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/site-visibility', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await getSiteVisibilitySettings(db);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/site-visibility', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await saveSiteVisibilitySettings(db, {
        enabled: toBool(req.body?.enabled),
        message: req.body?.message,
      });
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/opening', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const autoEnabled = toBool(req.body?.auto_enabled) ? 1 : 0;
    const nextOpenAt = toOptionalInt(req.body?.next_open_at);
    const intervalMinutes = toOptionalInt(req.body?.interval_minutes);
    const openDurationMinutes = toOptionalInt(req.body?.open_duration_minutes);
    const remindSeconds = toOptionalInt(req.body?.remind_before_seconds);
    const closeRemindSeconds = toOptionalInt(req.body?.close_remind_seconds);

    if (autoEnabled && !nextOpenAt) {
      return res.status(400).json({ error: 'missing next_open_at' });
    }
    if (intervalMinutes !== null && intervalMinutes < 1) {
      return res.status(400).json({ error: 'interval_minutes must be >= 1' });
    }
    if (openDurationMinutes !== null && openDurationMinutes < 1) {
      return res.status(400).json({ error: 'open_duration_minutes must be >= 1' });
    }
    if (remindSeconds !== null && remindSeconds < 0) {
      return res.status(400).json({ error: 'remind_before_seconds must be >= 0' });
    }
    if (closeRemindSeconds !== null && closeRemindSeconds < 0) {
      return res.status(400).json({ error: 'close_remind_seconds must be >= 0' });
    }
    if (closeRemindSeconds !== null && closeRemindSeconds > 0 && openDurationMinutes === null) {
      return res.status(400).json({ error: 'close_remind_seconds requires open_duration_minutes' });
    }
    if (autoEnabled && openDurationMinutes === null) {
      return res.status(400).json({ error: 'missing open_duration_minutes' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await ensureMallOpeningRow(db);
      const updates = {
        auto_enabled: autoEnabled,
        next_open_at: nextOpenAt,
        interval_minutes: intervalMinutes,
        open_duration_minutes: openDurationMinutes,
        remind_before_seconds: remindSeconds,
        close_remind_seconds: closeRemindSeconds,
      };

      if (!autoEnabled) {
        updates.next_open_at = null;
        updates.interval_minutes = null;
        updates.remind_for_open_at = null;
        updates.open_notify_for_open_at = null;
        updates.close_remind_for_close_at = null;
        updates.close_notify_for_close_at = null;
      }

      if (toOptionalInt(row?.next_open_at) !== nextOpenAt) {
        updates.remind_for_open_at = null;
        updates.open_notify_for_open_at = null;
        updates.close_remind_for_close_at = null;
        updates.close_notify_for_close_at = null;
      }
      if (toOptionalInt(row?.open_duration_minutes) !== openDurationMinutes) {
        updates.close_remind_for_close_at = null;
        updates.close_notify_for_close_at = null;
      }

      if (autoEnabled && Number(row?.is_open) === 1 && !row?.open_notify_for_open_at) {
        updates.open_notify_for_open_at = Math.floor(Date.now() / 1000);
        updates.close_remind_for_close_at = null;
        updates.close_notify_for_close_at = null;
      }

      const fields = Object.entries(updates).filter(([, v]) => v !== undefined);
      const sets = fields.map(([k]) => `${k} = ?`).join(', ');
      const values = fields.map(([, v]) => v);
      await db.run(`UPDATE mall_opening_schedule SET ${sets}, updated_at = unixepoch() WHERE id = 1`, values);

      const next = await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
      publishMallRealtimeEvent('opening_changed', {
        reason: 'admin_update',
        is_open: Number(next?.is_open ?? 0),
        next_open_at: next?.next_open_at ?? null,
      });
      return res.json({ ok: true, data: next || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/opening/open-now', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      await ensureMallOpeningRow(db);
      const now = Math.floor(Date.now() / 1000);
      await db.run(
        'UPDATE mall_opening_schedule SET is_open = 1, open_notify_for_open_at = ?, close_remind_for_close_at = NULL, close_notify_for_close_at = NULL, updated_at = unixepoch() WHERE id = 1',
        [now],
      );

      const row = await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
      const openDurationMinutes = toOptionalInt(row?.open_duration_minutes);
      const closeAt = openDurationMinutes ? now + openDurationMinutes * 60 : null;
      const cfg = req.app?.locals?.cfg;
      await notifyGroupInteractiveCardBySettings(db, cfg, {
        ...buildMallOpenCard(now, closeAt),
        event: 'mall_open',
        vars: {
          open_time: formatTs(now) || '-',
          close_time: formatTs(closeAt) || '-',
        },
      });
      publishMallRealtimeEvent('opening_changed', {
        reason: 'open_now',
        is_open: Number(row?.is_open ?? 0),
        next_open_at: row?.next_open_at ?? null,
      });
      return res.json({ ok: true, data: row || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/opening/close-now', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const before = await ensureMallOpeningRow(db);
      const wasOpen = Number(before?.is_open) === 1;
      const now = Math.floor(Date.now() / 1000);
      if (wasOpen) {
        await db.run('UPDATE mall_opening_schedule SET is_open = 0, close_notify_for_close_at = ?, updated_at = unixepoch() WHERE id = 1', [now]);
      } else {
        await db.run('UPDATE mall_opening_schedule SET is_open = 0, updated_at = unixepoch() WHERE id = 1');
      }
      const row = await db.get('SELECT * FROM mall_opening_schedule WHERE id = 1');
      if (wasOpen) {
        const cfg = req.app?.locals?.cfg;
        await notifyGroupInteractiveCardBySettings(db, cfg, {
          ...buildMallCloseCard(now),
          event: 'mall_close',
          vars: { close_time: formatTs(now) || '-' },
        });
      }
      publishMallRealtimeEvent('opening_changed', {
        reason: 'close_now',
        is_open: Number(row?.is_open ?? 0),
        next_open_at: row?.next_open_at ?? null,
      });
      return res.json({ ok: true, data: row || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/users/notify', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const ids = Array.isArray(req.body?.userids) ? req.body.userids : [];
    const userids = ids
      .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
      .filter((x) => x);

    if (userids.length === 0) {
      return res.status(400).json({ error: 'missing userids' });
    }

    const content = buildNotifyContent({ title: req.body?.title, content: req.body?.content });
    if (!content) {
      return res.status(400).json({ error: 'missing content' });
    }

    const max = 500;
    if (userids.length > max) {
      return res.status(400).json({ error: `too many users (max ${max})` });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const results = [];
      // 外部活动账号没有钉钉身份，直接跳过且不算失败。
      const externalUserids = await getExternalUserids(db, userids);
      let sent = 0;
      for (let i = 0; i < userids.length; i += 1) {
        const userid = userids[i];
        if (externalUserids.has(userid)) {
          results.push({ ok: false, skipped: true, userid, error: EXTERNAL_NOTIFY_SKIPPED });
          continue;
        }
        const r = await sendRobotPrivateTextWithRetry(cfg, { userid, content });
        results.push(r.ok ? { ok: true, userid } : { ok: false, userid, error: r.error });
        sent += 1;
        if (userids.length > 1 && sent < userids.length - externalUserids.size) {
          await sleep(120);
        }
      }
      const skipped = results.filter((x) => x.skipped);
      const failed = results.filter((x) => !x.ok && !x.skipped);
      const successCount = results.filter((x) => x.ok).length;
      return res.json({
        ok: failed.length === 0,
        count: results.length,
        success_count: successCount,
        failed_count: failed.length,
        skipped_count: skipped.length,
        error: failed.length ? `私聊消息发送失败 ${failed.length} 人` : undefined,
        results,
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/mall/self/products', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        "SELECT product_id, product_name, bob_amount, stock, limit_per_user, limit_round, cdk_enabled, status, sort, image_url, remark, created_at, updated_at FROM mall_products ORDER BY (sort IS NULL), sort ASC, product_id COLLATE NOCASE",
      );
      return res.json({ ok: true, count: (rows || []).length, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/self/products', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    let input;
    try {
      input = normalizeMallProductInput(req.body || {});
    } catch (err) {
      return res.status(400).json({ error: String(err?.message || err) });
    }

    const publishToGroup = toBool(req.body?.publish_to_group);

    try {
      res.setHeader('Cache-Control', 'no-store');
      const exists = await db.get('SELECT id FROM mall_products WHERE product_id = ? LIMIT 1', [input.product_id]);
      const isCreate = !exists?.id;
      if (exists?.id) {
        await db.run(
          'UPDATE mall_products SET product_name = ?, bob_amount = ?, stock = ?, limit_per_user = ?, cdk_enabled = ?, status = ?, sort = ?, image_url = ?, remark = ?, updated_at = unixepoch() WHERE product_id = ?',
          [
            input.product_name,
            input.bob_amount,
            input.stock,
            input.limit_per_user,
            input.cdk_enabled,
            input.status,
            input.sort,
            input.image_url || null,
            input.remark || null,
            input.product_id,
          ],
        );
      } else {
        await db.run(
          'INSERT INTO mall_products(product_id, product_name, bob_amount, stock, limit_per_user, cdk_enabled, status, sort, image_url, remark) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            input.product_id,
            input.product_name,
            input.bob_amount,
            input.stock,
            input.limit_per_user,
            input.cdk_enabled,
            input.status,
            input.sort,
            input.image_url || null,
            input.remark || null,
          ],
        );
      }

      const row = await db.get(
        'SELECT product_id, product_name, bob_amount, stock, limit_per_user, limit_round, cdk_enabled, status, sort, image_url, remark, created_at, updated_at FROM mall_products WHERE product_id = ? LIMIT 1',
        [input.product_id],
      );

      if (publishToGroup && row) {
        const name = row?.product_name ? String(row.product_name) : String(row?.product_id || input.product_id);
        const amount = Number(row?.bob_amount);
        const amountText = Number.isFinite(amount) ? `${amount} BOB 币` : '-';
        const stockRaw = row?.stock;
        const stockText = stockRaw === null || stockRaw === undefined ? '无限' : String(stockRaw);
        const imageUrl = row?.image_url ? String(row.image_url) : '';
        const actionText = isCreate ? '新品上架' : '商品更新';
        await notifyGroupInteractiveCardBySettings(db, req.app?.locals?.cfg, {
          event: 'new_product',
          title: `【BOB币中心】${actionText}：${name}`,
          markdown: `## ${actionText}\n\n- 商品：${name}\n- 价格：${amountText}\n- 库存：${stockText}\n\n欢迎在商城下单。`,
          outTrackId: `new_product_${String(row?.product_id || input.product_id)}_${Date.now()}`,
          imageUrl,
          vars: {
            product_name: name,
            amount: amountText,
            stock: stockText,
          },
        });
      }
      publishMallProductsChanged({
        product_id: String(input.product_id),
        reason: isCreate ? 'create' : 'update',
      });
      return res.json({ ok: true, data: row });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/self/products/limit-round', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const productId = req.body?.product_id ? String(req.body.product_id).trim() : '';
    if (!productId) {
      return res.status(400).json({ error: 'missing product_id' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await db.get(
        `UPDATE mall_products
            SET limit_round = GREATEST(COALESCE(limit_round, 1), 1) + 1,
                updated_at = unixepoch()
          WHERE product_id = ?
            AND COALESCE(limit_per_user, 0) > 0
          RETURNING product_id, product_name, bob_amount, stock, limit_per_user, limit_round,
                    cdk_enabled, status, sort, image_url, remark, created_at, updated_at`,
        [productId],
      );
      if (!row) {
        const exists = await db.get('SELECT product_id, limit_per_user FROM mall_products WHERE product_id = ? LIMIT 1', [productId]);
        if (!exists) {
          return res.status(404).json({ error: 'product not found' });
        }
        return res.status(400).json({ error: '该商品未启用限购' });
      }
      publishMallProductsChanged({ product_id: productId, reason: 'limit_round' });
      return res.json({ ok: true, data: row });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/mall/self/products/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const productId = req.body?.product_id ? String(req.body.product_id).trim() : '';
    if (!productId) {
      return res.status(400).json({ error: 'missing product_id' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const r = await db.run('DELETE FROM mall_products WHERE product_id = ?', [productId]);
      if (!r?.changes) {
        return res.status(404).json({ error: 'product not found' });
      }
      publishMallProductsChanged({ product_id: productId, reason: 'delete' });
      return res.json({ ok: true, deleted: productId });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/charity/projects', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await listAdminCharityProjects(db);
      return res.json({ ok: true, count: rows.length, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/charity/projects/save', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await saveCharityProject(db, req.body || {});
      publishMallRealtimeEvent('charity_changed', {
        project_id: String(row?.project_id || req.body?.project_id || ''),
        reason: 'save',
      });
      return res.json({ ok: true, data: row });
    } catch (err) {
      const message = String(err?.message || err);
      const status = [
        'missing project_id',
        'missing project_name',
        'missing summary',
        'missing rules_text',
        'invalid tier_options',
        'invalid sort',
        'target_bob_amount must be positive integer',
      ].includes(message) ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.get('/charity/contributions', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const projectId = req.query?.project_id ? String(req.query.project_id).trim() : '';
    const limit = Math.min(500, Math.max(1, toPositiveInt(req.query?.limit, 200)));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await listAdminCharityContributions(db, { projectId, limit });
      return res.json({ ok: true, project_id: projectId, limit, summary: result.summary, data: result.rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/cdks/products', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await listCdkEnabledProducts(db);
      return res.json({ ok: true, count: rows.length, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/cdks', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const includeDeleted = req.query.includeDeleted === '1' || req.query.includeDeleted === 'true';
      const rows = await listRedeemCdks(db, { includeDeleted, limit: req.query.limit });
      return res.json({ ok: true, count: rows.length, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/cdks/generate', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const admin = req.adminSession || {};
    try {
      const result = await generateRedeemCdks(db, {
        productId: req.body?.product_id,
        quantity: req.body?.quantity,
        createdBy: admin?.userid ? String(admin.userid) : '',
        createdName: admin?.name ? String(admin.name) : '',
      });
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      const status = [
        'missing product_id',
        'quantity must be between 1 and 500',
        'cdk product not found',
        'failed to generate unique cdk',
      ].includes(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.post('/cdks/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      const result = await deleteRedeemCdks(db, { ids: req.body?.ids });
      return res.json(result);
    } catch (err) {
      const message = String(err?.message || err);
      const status = ['invalid ids', 'cdk not found', 'redeemed cdk cannot be deleted'].includes(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  router.get('/mall/aitable/products', requireAdminSession(), async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const baseId = cfg?.mallAiTable?.baseId ? String(cfg.mallAiTable.baseId).trim() : '';
    const sheetIdOrName = cfg?.mallAiTable?.sheetIdOrName ? String(cfg.mallAiTable.sheetIdOrName).trim() : '';
    const operatorId = cfg?.mallAiTable?.operatorId ? String(cfg.mallAiTable.operatorId).trim() : '';

    if (!baseId || !sheetIdOrName || !operatorId) {
      return res.status(400).json({ error: 'missing mall ai table config' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');

      const rawRecords = [];
      let nextToken;
      let guard = 0;
      while (true) {
        guard += 1;
        if (guard > 50) {
          throw new Error('too many pages');
        }

        const page = await notableListRecords(cfg, {
          baseId,
          sheetIdOrName,
          operatorId,
          maxResults: 100,
          nextToken,
        });

        const rows = Array.isArray(page?.records) ? page.records : [];
        for (const r of rows) {
          rawRecords.push(r);
        }

        const hasMore = page?.hasMore === true;
        const nt = page?.nextToken ? String(page.nextToken) : '';
        if (!hasMore || !nt) {
          break;
        }
        nextToken = nt;
      }

      const data = rawRecords
        .map((r) => {
          const recordId = r?.id ? String(r.id) : '';
          const fields = normalizeNotableProductRecordFields(r?.fields);
          return { record_id: recordId, ...fields };
        })
        .sort((a, b) => {
          const sa = Number.isFinite(a?.sort) ? Number(a.sort) : Number.POSITIVE_INFINITY;
          const sb = Number.isFinite(b?.sort) ? Number(b.sort) : Number.POSITIVE_INFINITY;
          if (sa !== sb) return sa - sb;
          const pa = a?.product_id ? String(a.product_id) : '';
          const pb = b?.product_id ? String(b.product_id) : '';
          return pa.localeCompare(pb, 'zh');
        });

      return res.json({ ok: true, count: data.length, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/login', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').sendFile('admin_login.html', { root: pagesRoot });
  });

  router.get('/oauth/start', (req, res) => {
    try {
      const cfg = req.app?.locals?.cfg;
      const returnTo = normalizeAdminReturnTo(req.query.redirect);
      const { state, nonce } = createDingtalkOAuthState(getAdminOAuthSecret(cfg), {
        purpose: 'admin',
        returnTo,
      });
      const authorizeUrl = buildDingtalkOAuthAuthorizeUrl(cfg, {
        redirectUri: getAdminOAuthCallbackUrl(cfg),
        state,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Set-Cookie', buildDingtalkOAuthStateCookie(ADMIN_OAUTH_COOKIE, nonce, 600, cookieOptions(cfg)));
      return res.redirect(302, authorizeUrl);
    } catch (err) {
      return res.redirect(302, buildAdminLoginErrorUrl('config', req.query.redirect));
    }
  });

  router.get('/oauth/callback', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const cookies = parseCookies(req.header('cookie'));
    const state = req.query.state ? String(req.query.state) : '';
    const code = req.query.authCode || req.query.code ? String(req.query.authCode || req.query.code) : '';
    const payload = verifyDingtalkOAuthState(getAdminOAuthSecret(cfg), state, {
      purpose: 'admin',
      nonce: cookies[ADMIN_OAUTH_COOKIE],
    });
    const returnTo = normalizeAdminReturnTo(payload?.returnTo);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', buildClearDingtalkOAuthStateCookie(ADMIN_OAUTH_COOKIE, cookieOptions(cfg)));
    if (!payload || !code) {
      return res.redirect(302, buildAdminLoginErrorUrl('expired', returnTo));
    }

    try {
      const db = req.app.locals.db;
      const userid = await getUserIdByOAuthCode(cfg, code);
      const cached = await db.get('SELECT name FROM users WHERE userid = ?', [userid]);
      const cachedName = cached?.name ? String(cached.name) : '';
      const profile = cachedName ? { userid, name: cachedName } : await getUserProfile(cfg, userid);
      await ensureAccount(db, { userid: profile.userid, name: profile.name, createUser: true });

      if (!(await isAdmin(db, cfg, profile.userid))) {
        safeAppendAuditLog(db, {
          eventType: 'admin_login_failed',
          actorType: 'admin',
          actorId: profile.userid,
          actorName: profile.name,
          ip: getClientIp(req),
          method: req.method,
          path: req.originalUrl || req.url,
          statusCode: 403,
          message: '管理员钉钉授权登录失败：无后台权限',
        });
        return res.redirect(302, buildAdminLoginErrorUrl('forbidden', returnTo));
      }

      const secret = adminSessionSigningSecret(cfg);
      const token = createSessionToken(secret, withSessionVersion({ userid: profile.userid, name: profile.name, mode: 'dingtalk' }, cfg), 8 * 3600);
      res.setHeader('Set-Cookie', [
        buildClearDingtalkOAuthStateCookie(ADMIN_OAUTH_COOKIE, cookieOptions(cfg)),
        buildClearLegacyAdminPathCookie(cookieOptions(cfg)),
        buildSessionCookie(token, cookieOptions(cfg)),
      ]);
      safeAppendAuditLog(db, {
        eventType: 'admin_login_success',
        actorType: 'admin',
        actorId: profile.userid,
        actorName: profile.name,
        ip: getClientIp(req),
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: 302,
        message: '管理员钉钉授权登录成功',
      });
      return res.redirect(302, returnTo);
    } catch (err) {
      console.error('[admin/oauth/callback] login failed:', err?.message || err);
      return res.redirect(302, buildAdminLoginErrorUrl('failed', returnTo));
    }
  });

  router.get('/home', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', buildClearLegacyAdminPathCookie(cookieOptions(cfg)));
    let payload;
    try {
      payload = await getAdminSessionPayload(req);
    } catch (err) {
      return res.status(500).type('text').send(String(err?.message || err));
    }
    if (!payload) {
      // 保留原始链接（如转发核销带的 ?encoded=），登录后回到这里。
      // 回跳地址放在 # 后：钉钉 JSAPI 签名 URL 不含 # 部分，登录页 URL 保持干净，
      // 避免查询串里的 %2F 等转义字符导致钉钉内 dd.config 签名校验失败。
      const returnTo = normalizeAdminReturnTo(req.originalUrl);
      const loginUrl = returnTo === '/admin/home'
        ? '/admin/login'
        : `/admin/login#${new URLSearchParams({ redirect: returnTo }).toString()}`;
      return res.redirect(302, loginUrl);
    }
    if (existsSync(adminAppIndex)) {
      return res.type('html').sendFile(adminAppIndex);
    }
    return res.type('html').sendFile('admin.html', { root: pagesRoot });
  });

  // legacy 双实现：默认入口已是 React admin-app；本路由仅兼容旧书签，计划移除。
  router.get('/legacy', requireAdminSession(), (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Bob-Deprecated', 'admin-legacy; sunset=TBD');
    return res.type('html').sendFile('admin.html', { root: pagesRoot });
  });

  router.get('/me', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const cookies = parseCookies(req.header('cookie'));
    const token = cookies.bob_admin_session;
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Set-Cookie', buildClearLegacyAdminPathCookie(cookieOptions(cfg)));
      const secret = adminSessionSigningSecret(cfg);
      const payload = verifySessionToken(secret, token);
      const db = req.app?.locals?.db;
      if (!payload || !(await isSessionVersionValidLive(payload, db, cfg))) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      const name = await resolveAdminDisplayName(db, cfg, payload);
      const access = await getAdminAccess(db, cfg, { ...payload, name });
      return res.json({
        ok: true,
        name,
        userid: payload.userid || '',
        mode: payload.mode || '',
        isSuperAdmin: access.isSuperAdmin === true,
        role: access.role,
        permissions: access.permissions || [],
        env: cfg?.env || process.env.NODE_ENV || 'production',
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/system/info', requireAdminSession(), async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, data: await getServerInfo(req, cfg) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/dashboard/summary', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const [usersRow, balanceRow, pendingRow, fulfilledRow, productRow, cdkRow, charityRow] = await Promise.all([
        db.get('SELECT COUNT(1) AS c FROM users'),
        db.get('SELECT COALESCE(SUM(balance), 0) AS c FROM accounts'),
        db.get("SELECT COUNT(1) AS c FROM redeems WHERE fulfilled_at IS NULL AND COALESCE(product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')"),
        db.get("SELECT COUNT(1) AS c FROM redeems WHERE fulfilled_at IS NOT NULL AND COALESCE(hidden, 0) = 0 AND COALESCE(product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')"),
        db.get("SELECT COUNT(1) AS c FROM mall_products WHERE status = 'on'"),
        db.get("SELECT COUNT(1) AS c FROM redeem_cdks WHERE status = 'unused'"),
        db.get('SELECT COALESCE(SUM(bob_amount), 0) AS c FROM charity_contributions'),
      ]);
      const settings = await getDingtalkConnectionSettings(db, cfg);
      return res.json({
        ok: true,
        data: {
          users: Number(usersRow?.c || 0),
          balanceTotal: Number(balanceRow?.c || 0),
          pendingOrders: Number(pendingRow?.c || 0),
          fulfilledOrders: Number(fulfilledRow?.c || 0),
          activeProducts: Number(productRow?.c || 0),
          unusedCdks: Number(cdkRow?.c || 0),
          charityTotal: Number(charityRow?.c || 0),
          dingtalk: toPublicDingtalkConnectionSettings(settings),
        },
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/users/:userid', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const userid = req.params?.userid ? String(req.params.userid).trim() : '';
    if (!userid) return res.status(400).json({ error: 'missing userid' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const user = await db.get(
        `SELECT u.userid, u.name, u.is_admin, u.created_at, COALESCE(a.balance, 0) AS balance, a.updated_at,
                COALESCE(u.source, 'dingtalk') AS source, COALESCE(u.phone, '') AS phone,
                r.id AS role_id, r.name AS role_name, r.permissions AS role_permissions, r.is_enabled AS role_enabled
         FROM users u
         LEFT JOIN accounts a ON a.userid = u.userid
         LEFT JOIN admin_user_roles ur ON ur.userid = u.userid
         LEFT JOIN admin_roles r ON r.id = ur.role_id
         WHERE u.userid = ?
         LIMIT 1`,
        [userid],
      );
      if (!user) return res.status(404).json({ error: 'user not found' });
      const externalAccount = user.source === 'external'
        ? await db.get(
          `SELECT COALESCE(batch_id, '') AS batch_id, COALESCE(status, 'active') AS status, last_login_at
             FROM external_accounts WHERE userid = ? LIMIT 1`,
          [userid],
        )
        : null;
      const ledgerResult = await listLedgerRecords(db, { userid, page: 1, pageSize: 120 });
      const ledger = ledgerResult.data || [];
      const redeems = await db.all(
        `SELECT r.exchange_id, r.userid, r.product_id, r.product_name, r.bob_amount, r.fulfilled_at, r.created_at,
                CASE WHEN r.exchange_id LIKE 'AUCTION_%' THEN 'auction' WHEN c.id IS NULL THEN 'purchase' ELSE 'cdk' END AS redeem_source,
                c.product_bob_amount AS cdk_product_bob_amount
         FROM redeems r
         LEFT JOIN redeem_cdks c ON c.redeem_exchange_id = r.exchange_id
         WHERE r.userid = ?
           AND COALESCE(r.product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')
         ORDER BY r.created_at DESC
         LIMIT 80`,
        [userid],
      );
      const contributions = await db.all(
        `SELECT c.id, c.project_id, p.project_name, c.user_name_snapshot, c.bob_amount, c.created_at
         FROM charity_contributions c
         LEFT JOIN charity_projects p ON p.project_id = c.project_id
         WHERE c.userid = ?
         ORDER BY c.created_at DESC
         LIMIT 80`,
        [userid],
      );
      const dingtalkProfile = await db.get(
        `SELECT userid, unionid, name, avatar, mobile, telephone, email, org_email, title, job_number, work_place, remark,
                dept_ids, dept_names, extension, hired_date, active, is_admin, is_boss, leader_in_dept, exclusive_account, raw, updated_at
         FROM user_dingtalk_profiles
         WHERE userid = ?
         LIMIT 1`,
        [userid],
      );
      const operations = await db.all(
        `SELECT id, event_type, actor_type, actor_id, actor_name, ip, method, path, status_code, message, payload, created_at
         FROM audit_logs
         WHERE actor_id = ?
           AND actor_type = 'admin'
           AND event_type NOT IN ('attendance_reward', 'attendance_skip')
           AND (
             COALESCE(method, '') <> 'GET'
             OR event_type IN ('admin_login_success', 'admin_logout', 'admin_login_failed')
           )
         ORDER BY id DESC
         LIMIT 20`,
        [userid],
      );
      const fixedAdmin = isFixedAdmin(cfg, userid);
      const role = fixedAdmin
        ? { id: null, code: 'super_admin', name: '超级管理员', permissions: [] }
        : (user.role_id ? { id: user.role_id, name: user.role_name, permissions: normalizePermissions(parseAuditPayload(user.role_permissions) || []) } : null);
      return res.json({
        ok: true,
        data: {
          user: {
            ...user,
            is_admin: fixedAdmin || Number(user.is_admin) === 1 || role ? 1 : 0,
            is_fixed_admin: fixedAdmin ? 1 : 0,
            role,
            external: externalAccount ? { ...externalAccount, last_login_at: externalAccount.last_login_at ?? null } : null,
          },
          account: { balance: Number(user.balance || 0), updated_at: user.updated_at },
          ledger,
          redeems: (redeems || []).map((row) => serializeAdminRedeemRow(row)),
          contributions,
          dingtalk: dingtalkProfile ? {
            ...dingtalkProfile,
            dept_ids: parseAuditPayload(dingtalkProfile.dept_ids) || [],
            dept_names: parseAuditPayload(dingtalkProfile.dept_names) || [],
            extension: parseAuditPayload(dingtalkProfile.extension) || null,
            leader_in_dept: parseAuditPayload(dingtalkProfile.leader_in_dept) || null,
            raw: parseAuditPayload(dingtalkProfile.raw) || null,
          } : null,
          operations: (operations || []).map(serializeAuditRow),
        },
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/orders/:exchangeId', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const exchangeId = req.params?.exchangeId ? String(req.params.exchangeId).trim() : '';
    if (!exchangeId) return res.status(400).json({ error: 'missing exchange_id' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const order = await db.get(
        `SELECT r.exchange_id, r.userid, COALESCE(u.name, '') AS name, r.product_id, r.product_name,
                r.bob_amount, r.fulfilled_at, r.created_at,
                COALESCE(r.fulfilled_by, audit.actor_id, '') AS fulfilled_by,
                COALESCE(r.fulfilled_name, audit.actor_name, '') AS fulfilled_name,
                CASE WHEN r.exchange_id LIKE 'AUCTION_%' THEN 'auction' WHEN c.id IS NULL THEN 'purchase' ELSE 'cdk' END AS redeem_source,
                c.product_bob_amount AS cdk_product_bob_amount,
                c.cdk_code, c.batch_id
         FROM redeems r
         LEFT JOIN users u ON u.userid = r.userid
         LEFT JOIN redeem_cdks c ON c.redeem_exchange_id = r.exchange_id
         LEFT JOIN LATERAL (
           SELECT a.actor_id, a.actor_name
             FROM audit_logs a
            WHERE r.fulfilled_at IS NOT NULL
              AND a.path LIKE '/admin/redeem/confirm%'
              AND COALESCE(a.status_code, 0) BETWEEN 200 AND 299
              AND a.payload LIKE '%' || r.exchange_id || '%'
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT 1
         ) audit ON TRUE
         WHERE r.exchange_id = ?
           AND COALESCE(r.product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')
         LIMIT 1`,
        [exchangeId],
      );
      if (!order) return res.status(404).json({ error: 'order not found' });
      const ledger = await db.all(
        'SELECT id, userid, delta, reason, ref_id, created_at FROM ledger WHERE ref_id = ? ORDER BY created_at DESC, id DESC LIMIT 20',
        [exchangeId],
      );
      return res.json({
        ok: true,
        data: {
          order: serializeAdminRedeemRow(order),
          ledger,
        },
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/redeem/deduct-batch', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const ids = Array.isArray(req.body?.userids) ? req.body.userids : [];
    const userids = ids
      .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
      .filter((x) => x);

    const amount = toInt(req.body?.amount);
    const productName = req.body?.product_name ? String(req.body.product_name).trim() : '';

    if (userids.length === 0) {
      return res.status(400).json({ error: 'missing userids' });
    }
    if (amount === null || amount <= 0) {
      return res.status(400).json({ error: 'bob_amount must be positive integer' });
    }
    if (!productName) {
      return res.status(400).json({ error: 'missing product_name' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      req.auditLogPayload = { userids, amount, product_name: productName };

      const baseExchangeId = `ADMIN_DEDUCT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await adminDeductBatchWithNotify(db, cfg, {
        userids,
        baseExchangeId,
        productName,
        bobAmount: amount,
        reason: 'admin_deduct',
        awaitNotify: false,
      });
      for (const row of (result?.results || [])) {
        if (row?.ok && row?.userid) {
          publishMallRealtimeEvent('balance_changed', {
            userid: String(row.userid),
            reason: 'admin_deduct_batch',
          });
        }
      }
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/redeem/history', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cursorSecret = adminSessionSigningSecret(req.app?.locals?.cfg);
    const limitRaw = req.query.limit;
    const limit = Math.min(200, Math.max(1, toPositiveInt(limitRaw, 80)));
    const cursorRaw = req.query.cursor ? String(req.query.cursor) : '';
    try {
      res.setHeader('Cache-Control', 'no-store');

      let whereCursorSql = '';
      const params = [];
      if (cursorRaw) {
        const decodedCursor = decodeAdminRedeemCursor(cursorRaw, cursorSecret);
        const legacyCursor = decodedCursor ? '' : cursorRaw;
        const idx = legacyCursor.indexOf('|');
        const at = decodedCursor?.at ?? (idx > 0 ? toInt(legacyCursor.slice(0, idx)) : null);
        const ex = decodedCursor?.exchangeId ?? (idx > 0 ? legacyCursor.slice(idx + 1) : '');
        if (at !== null && at > 0 && ex) {
          whereCursorSql = ' AND (r.fulfilled_at < ? OR (r.fulfilled_at = ? AND r.exchange_id < ?))';
          params.push(at, at, String(ex));
        }
      }

      const rows = await db.all(
        `SELECT r.exchange_id, r.userid, COALESCE(u.name, '') AS name, r.product_id, r.product_name,
                r.bob_amount, r.fulfilled_at, r.created_at,
                COALESCE(r.fulfilled_by, audit.actor_id, '') AS fulfilled_by,
                COALESCE(r.fulfilled_name, audit.actor_name, '') AS fulfilled_name,
                CASE WHEN r.exchange_id LIKE 'AUCTION_%' THEN 'auction' WHEN c.id IS NULL THEN 'purchase' ELSE 'cdk' END AS redeem_source,
                c.product_bob_amount AS cdk_product_bob_amount
         FROM redeems r
         LEFT JOIN users u ON u.userid = r.userid
         LEFT JOIN redeem_cdks c ON c.redeem_exchange_id = r.exchange_id
         LEFT JOIN LATERAL (
           SELECT a.actor_id, a.actor_name
             FROM audit_logs a
            WHERE a.path LIKE '/admin/redeem/confirm%'
              AND COALESCE(a.status_code, 0) BETWEEN 200 AND 299
              AND a.payload LIKE '%' || r.exchange_id || '%'
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT 1
         ) audit ON TRUE
         WHERE r.fulfilled_at IS NOT NULL
           AND COALESCE(r.hidden, 0) = 0
           AND COALESCE(r.product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')${whereCursorSql}
         ORDER BY r.fulfilled_at DESC, r.exchange_id DESC
         LIMIT ?`,
        [...params, limit],
      );

      const rawData = rows || [];
      const last = rawData.length ? rawData[rawData.length - 1] : null;
      const nextCursor = last && last.fulfilled_at ? encodeAdminRedeemCursor({
        at: last.fulfilled_at,
        exchangeId: last.exchange_id,
      }, cursorSecret) : '';
      const hasMore = rawData.length >= limit && Boolean(nextCursor);
      const data = rawData.map((row) => serializeAdminRedeemRow(row));

      return res.json({ ok: true, limit, cursor: cursorRaw, nextCursor, hasMore, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/redeem/pending', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cursorSecret = adminSessionSigningSecret(req.app?.locals?.cfg);
    const limitRaw = req.query.limit;
    const limit = Math.min(200, Math.max(1, toPositiveInt(limitRaw, 80)));
    const cursorRaw = req.query.cursor ? String(req.query.cursor) : '';

    try {
      res.setHeader('Cache-Control', 'no-store');

      let whereCursorSql = '';
      const params = [];
      if (cursorRaw) {
        const decodedCursor = decodeAdminRedeemCursor(cursorRaw, cursorSecret);
        if (decodedCursor?.queueKey && decodedCursor?.exchangeId) {
          const queueSortSql = "lower(COALESCE(r.product_name, '')) || chr(31) || lower(COALESCE(u.name, '')) || chr(31) || md5(r.exchange_id)";
          whereCursorSql = ` AND (${queueSortSql} > ? OR (${queueSortSql} = ? AND r.exchange_id > ?))`;
          params.push(decodedCursor.queueKey, decodedCursor.queueKey, decodedCursor.exchangeId);
        }
      }

      const rows = await db.all(
        `SELECT r.exchange_id, r.userid, COALESCE(u.name, '') AS name, r.product_id, r.product_name,
                r.bob_amount, r.fulfilled_at, r.created_at,
                lower(COALESCE(r.product_name, '')) || chr(31) || lower(COALESCE(u.name, '')) || chr(31) || md5(r.exchange_id) AS queue_sort_key,
                CASE WHEN r.exchange_id LIKE 'AUCTION_%' THEN 'auction' WHEN c.id IS NULL THEN 'purchase' ELSE 'cdk' END AS redeem_source,
                c.product_bob_amount AS cdk_product_bob_amount
         FROM redeems r
         LEFT JOIN users u ON u.userid = r.userid
         LEFT JOIN redeem_cdks c ON c.redeem_exchange_id = r.exchange_id
         WHERE r.fulfilled_at IS NULL
           AND COALESCE(r.product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')${whereCursorSql}
         ORDER BY queue_sort_key ASC, r.exchange_id ASC
         LIMIT ?`,
        [...params, limit],
      );

      const rawData = rows || [];
      const last = rawData.length ? rawData[rawData.length - 1] : null;
      const nextCursor = last ? encodeAdminRedeemCursor({
        queueKey: last.queue_sort_key,
        exchangeId: last.exchange_id,
      }, cursorSecret) : '';
      const hasMore = rawData.length >= limit && Boolean(nextCursor);
      const data = rawData.map((row) => serializeAdminRedeemRow(row));

      return res.json({ ok: true, limit, cursor: cursorRaw, nextCursor, hasMore, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/redeem/history/clear', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const confirm = req.body?.confirm ? String(req.body.confirm).trim() : '';
    if (confirm !== 'CLEAR_REDEEM_HISTORY') {
      return res.status(400).json({ error: '确认口令不正确，已取消' });
    }

    try {
      const r = await runInTransaction(db, async (tx) => (
        await tx.run("UPDATE redeems SET hidden = 1 WHERE fulfilled_at IS NOT NULL AND COALESCE(hidden, 0) = 0 AND COALESCE(product_id, '') NOT IN ('ADMIN_DEDUCT', 'API_DEDUCT')")
      ));
      return res.json({ ok: true, cleared: r?.changes ?? 0 });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/users/set-admin', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const userid = req.body?.userid ? String(req.body.userid).trim() : '';
    const flag = req.body?.isAdmin;
    const isAdminFlag = flag === true || flag === 1 || flag === '1' || flag === 'true';

    if (!userid) {
      return res.status(400).json({ error: 'missing userid' });
    }

    if (isFixedAdmin(cfg, userid)) {
      return res.status(400).json({ error: 'cannot modify fixed admin' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      // 外部活动账号永远登录不了后台，授予管理员只会让批次清理静默跳过该账号；撤销仍允许。
      if (isAdminFlag && await isExternalUser(db, userid)) {
        return res.status(400).json({ error: '外部活动账号不能设为管理员' });
      }
      const changed = await runInTransaction(db, async (tx) => {
        await lockAdminAccountProtection(tx);
        const r = await tx.run('UPDATE users SET is_admin = ? WHERE userid = ?', [isAdminFlag ? 1 : 0, userid]);
        if (!r?.changes) return false;
        if (isAdminFlag) {
          const role = await tx.get("SELECT id FROM admin_roles WHERE code = 'admin' LIMIT 1");
          if (role?.id) {
            await tx.exec(
              `INSERT INTO admin_user_roles(userid, role_id, assigned_by, assigned_name, assigned_at)
               VALUES(?, ?, ?, ?, unixepoch())
               ON CONFLICT(userid) DO UPDATE SET role_id = EXCLUDED.role_id, assigned_by = EXCLUDED.assigned_by, assigned_name = EXCLUDED.assigned_name, assigned_at = EXCLUDED.assigned_at`,
              [userid, role.id, req.adminSession?.userid || '', req.adminSession?.name || ''],
            );
          }
        } else {
          await tx.run('DELETE FROM admin_user_roles WHERE userid = ?', [userid]);
        }
        return true;
      });
      if (!changed) return res.status(400).json({ error: 'user not found' });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/permissions/catalog', requireAdminSession(), async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, data: ADMIN_PERMISSION_CATALOG });
  });

  router.get('/roles', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT r.*, COUNT(ur.userid) AS user_count
         FROM admin_roles r
         LEFT JOIN admin_user_roles ur ON ur.role_id = r.id
         GROUP BY r.id
         ORDER BY r.is_builtin DESC, r.id ASC`,
      );
      return res.json({ ok: true, data: (rows || []).map(serializeRole) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/roles/save', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    const name = req.body?.name ? String(req.body.name).trim() : '';
    const permissions = normalizePermissions(req.body?.permissions || []);
    if (!name) return res.status(400).json({ error: 'missing role name' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      let roleId = id;
      if (roleId) {
        const r = await db.run(
          'UPDATE admin_roles SET name = ?, permissions = ?, updated_at = unixepoch() WHERE id = ?',
          [name, JSON.stringify(permissions), roleId],
        );
        if (!r?.changes) return res.status(404).json({ error: '角色不存在' });
      } else {
        const code = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const r = await db.run(
          'INSERT INTO admin_roles(code, name, permissions, is_builtin, is_enabled, created_at, updated_at) VALUES(?, ?, ?, 0, 1, unixepoch(), unixepoch())',
          [code, name, JSON.stringify(permissions)],
        );
        roleId = r.lastID;
      }
      return res.json({ ok: true, id: roleId });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/roles/disable', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toInt(req.body?.id);
    if (!id) return res.status(400).json({ error: 'missing id' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await runInTransaction(db, async (tx) => {
        await lockAdminAccountProtection(tx);
        const role = await tx.get('SELECT id, is_builtin FROM admin_roles WHERE id = ? LIMIT 1', [id]);
        if (!role) return { status: 404, error: '角色不存在' };
        if (Number(role.is_builtin) === 1) return { status: 400, error: '系统内置角色不能停用' };
        const count = await tx.get('SELECT COUNT(1) AS c FROM admin_user_roles WHERE role_id = ?', [id]);
        if (Number(count?.c || 0) > 0) return { status: 400, error: '该角色已有用户使用，请先调整用户角色' };
        await tx.run('UPDATE admin_roles SET is_enabled = 0, updated_at = unixepoch() WHERE id = ?', [id]);
        return null;
      });
      if (result) return res.status(result.status).json({ error: result.error });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/users/assign-role', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const userid = req.body?.userid ? String(req.body.userid).trim() : '';
    const roleId = toOptionalInt(req.body?.roleId);
    if (!userid) return res.status(400).json({ error: 'missing userid' });
    if (isFixedAdmin(cfg, userid)) return res.status(400).json({ error: '超级管理员不能修改角色' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      req.auditLogPayload = { userid, roleId };
      const error = await runInTransaction(db, async (tx) => {
        await lockAdminAccountProtection(tx);
        const user = await tx.get("SELECT userid, COALESCE(source, 'dingtalk') AS source FROM users WHERE userid = ? LIMIT 1", [userid]);
        if (!user) return 'user not found';
        // 外部活动账号登录不了后台，挂角色只会让批次清理静默跳过它；取消角色（roleId 为空）仍允许。
        if (roleId && user.source === 'external') return '外部活动账号不能分配后台角色';
        if (roleId) {
          const role = await tx.get('SELECT id, is_enabled FROM admin_roles WHERE id = ?', [roleId]);
          if (!role || Number(role.is_enabled) !== 1) return '角色不存在或已停用';
          await tx.exec(
            `INSERT INTO admin_user_roles(userid, role_id, assigned_by, assigned_name, assigned_at)
             VALUES(?, ?, ?, ?, unixepoch())
             ON CONFLICT(userid) DO UPDATE SET role_id = EXCLUDED.role_id, assigned_by = EXCLUDED.assigned_by, assigned_name = EXCLUDED.assigned_name, assigned_at = EXCLUDED.assigned_at`,
            [userid, roleId, req.adminSession?.userid || '', req.adminSession?.name || ''],
          );
          await tx.run('UPDATE users SET is_admin = 1 WHERE userid = ?', [userid]);
        } else {
          await tx.run('DELETE FROM admin_user_roles WHERE userid = ?', [userid]);
          await tx.run('UPDATE users SET is_admin = 0 WHERE userid = ?', [userid]);
        }
        return null;
      });
      if (error) return res.status(400).json({ error });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/logs', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const days = Math.min(365, Math.max(1, toPositiveInt(req.query?.days, 30)));
    const limitRaw = toPositiveInt(req.query?.limit, null);
    const hasLimit = Number.isFinite(limitRaw) && limitRaw > 0;
    const limit = hasLimit ? Math.min(10000, limitRaw) : null;
    const minCreatedAt = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    try {
      res.setHeader('Cache-Control', 'no-store');
      await purgeExpiredAuditLogs(db);
      const sql = `SELECT id, event_type, actor_type, actor_id, actor_name, ip, method, path, status_code, message, payload, created_at
         FROM audit_logs
         WHERE created_at >= ?
         ORDER BY id DESC${hasLimit ? '\n         LIMIT ?' : ''}`;
      const rows = await db.all(sql, hasLimit ? [minCreatedAt, limit] : [minCreatedAt]);
      await enrichRedeemConfirmAuditRows(db, rows);
      return res.json({ ok: true, days, limit, data: (rows || []).map(serializeAuditRow) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/my/operations', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const days = Math.min(90, Math.max(1, toPositiveInt(req.query?.days, 30)));
    const limit = Math.min(500, Math.max(1, toPositiveInt(req.query?.limit, 120)));
    const eventGroup = String(req.query?.event_group || '').trim();
    const dateFrom = toOptionalInt(req.query?.date_from);
    const dateTo = toOptionalInt(req.query?.date_to);
    const minCreatedAt = dateFrom || Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const maxCreatedAt = dateTo || null;
    const currentActorId = String(req.adminSession?.userid || '').trim();
    const isSuperAdmin = req.adminAccess?.isSuperAdmin === true;
    const selectedActorId = isSuperAdmin ? String(req.query?.actor_id || '').trim() : currentActorId;
    if (!selectedActorId && !isSuperAdmin) return res.json({ ok: true, data: [], actors: [] });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const relevantSql = `(path LIKE '%/ledger/grant-batch%' OR path LIKE '%/redeem/deduct-batch%' OR path LIKE '%/redeem/confirm%' OR path LIKE '%/backup/export%' OR path LIKE '%/backup/import%' OR path LIKE '%/users/delete%' OR path LIKE '%/data/reset%' OR path LIKE '%/history/clear%' OR path LIKE '%/users/assign-role%' OR path LIKE '%/roles/%')`;
      const where = ['a.created_at >= ?', relevantSql];
      const params = [minCreatedAt];
      if (maxCreatedAt) {
        where.push('a.created_at <= ?');
        params.push(maxCreatedAt);
      }
      if (selectedActorId) {
        where.push('a.actor_id = ?');
        params.push(selectedActorId);
      }
      if (eventGroup) {
        const groupSql = {
          grant: "a.path LIKE '%/ledger/grant-batch%'",
          deduct: "a.path LIKE '%/redeem/deduct-batch%'",
          redeem: "a.path LIKE '%/redeem/confirm%'",
          backup: "(a.path LIKE '%/backup/export%' OR a.path LIKE '%/backup/import%')",
          role: "(a.path LIKE '%/roles/%' OR a.path LIKE '%/users/assign-role%')",
          danger: "(a.path LIKE '%/users/delete%' OR a.path LIKE '%/data/reset%' OR a.path LIKE '%/history/clear%')",
        }[eventGroup];
        if (groupSql) where.push(groupSql);
      }
      const rows = await db.all(
        `SELECT a.id, a.event_type, a.actor_type, a.actor_id, a.actor_name, COALESCE(u.name, '') AS actor_user_name,
                a.ip, a.method, a.path, a.status_code, a.message, a.payload, a.created_at
         FROM audit_logs a
         LEFT JOIN users u ON u.userid = a.actor_id
         WHERE ${where.join(' AND ')}
         ORDER BY a.id DESC
         LIMIT ?`,
        [...params, limit],
      );
      const actorRows = isSuperAdmin ? await db.all(
        `SELECT a.actor_id, COALESCE(NULLIF(MAX(u.name), ''), NULLIF(MAX(a.actor_name), ''), a.actor_id) AS actor_name
         FROM audit_logs a
         LEFT JOIN users u ON u.userid = a.actor_id
         WHERE a.created_at >= ? AND a.actor_type = 'admin' AND COALESCE(a.actor_id, '') <> '' AND ${relevantSql}
         GROUP BY a.actor_id
         ORDER BY actor_name ASC`,
        [minCreatedAt],
      ) : [];
      await enrichRedeemConfirmAuditRows(db, rows);
      return res.json({
        ok: true,
        days,
        limit,
        scope: isSuperAdmin ? 'all' : 'mine',
        actors: (actorRows || []).map((row) => ({ userid: row.actor_id, name: row.actor_name || row.actor_id })),
        data: await serializeOperationRows(db, rows || []),
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  registerAdminContentRoutes(router);

  router.post('/logout', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const payload = await getAdminSessionPayload(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', [buildClearLegacyAdminPathCookie(cookieOptions(cfg)), buildClearSessionCookie(cookieOptions(cfg))]);
    safeAppendAuditLog(req.app?.locals?.db, {
      eventType: 'admin_logout',
      actorType: 'admin',
      actorId: payload?.userid || '',
      actorName: payload?.name || '',
      ip: getClientIp(req),
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode: 200,
      message: '管理员退出登录',
    });
    return res.json({ ok: true });
  });

  router.get('/config', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const url = req.query.url ? String(req.query.url) : '';
    if (!url) {
      return res.status(400).json({ error: 'missing url' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await buildJsapiConfig(cfg, url);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/auth', async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const code = req.query.code ? String(req.query.code) : '';
    if (!code) {
      return res.status(400).json({ error: 'missing code' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const db = req.app.locals.db;
      const userid = await getUserIdByAuthCode(cfg, code);

      const cached = await db.get('SELECT name FROM users WHERE userid = ?', [userid]);
      const cachedName = cached?.name ? String(cached.name) : '';
      const profile = cachedName ? { userid, name: cachedName } : await getUserProfile(cfg, userid);

      await ensureAccount(db, { userid: profile.userid, name: profile.name, createUser: true });

      if (!(await isAdmin(db, cfg, profile.userid))) {
        return res.status(403).json({ error: 'forbidden', userid: profile.userid, name: profile.name });
      }

      const secret = adminSessionSigningSecret(cfg);
      const token = createSessionToken(secret, withSessionVersion({ userid: profile.userid, name: profile.name, mode: 'dingtalk' }, cfg), 8 * 3600);
      res.setHeader('Set-Cookie', [buildClearLegacyAdminPathCookie(cookieOptions(cfg)), buildSessionCookie(token, cookieOptions(cfg))]);
      return res.json({ ok: true, name: profile.name });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/users/sync', requireAdminSession(), async (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const db = req.app?.locals?.db;

    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await syncAllDingtalkUsers(db, cfg);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/users', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const keyword = normalizeUserSearchKeyword(req.query.keyword);
    const page = toPositiveInt(req.query.page, 1);
    const pageSize = Math.min(100, toPositiveInt(req.query.pageSize, 30));
    const offset = (page - 1) * pageSize;

    try {
      res.setHeader('Cache-Control', 'no-store');

      const where = [];
      const params = [];
      if (keyword) {
        const tokens = keyword.toLowerCase().split(/\s+/g).filter(Boolean).slice(0, 6);
        for (const token of tokens) {
          const kw = `%${token}%`;
          const compactToken = compactUserSearchKeyword(token);
          const group = [
            "LOWER(COALESCE(u.userid, '')) LIKE ?",
            "LOWER(COALESCE(u.name, '')) LIKE ?",
            "COALESCE(u.phone, '') LIKE ?",
          ];
          params.push(kw, kw, kw);
          if (compactToken) {
            group.push("REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(u.userid, '') || COALESCE(u.name, '')), ' ', ''), '-', ''), '_', ''), '.', '') LIKE ?");
            params.push(`%${compactToken}%`);
          }
          where.push(`(${group.join(' OR ')})`);
        }
      }

      // 来源筛选：区分钉钉员工与对外活动外部账号（按批次清理外部账号时使用）。
      const sourceFilter = String(req.query.source || '').trim().toLowerCase();
      if (sourceFilter === 'external' || sourceFilter === 'dingtalk') {
        where.push("COALESCE(u.source, 'dingtalk') = ?");
        params.push(sourceFilter);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const totalRow = await db.get(`SELECT COUNT(1) AS c FROM users u ${whereSql}`, params);
      const total = Number(totalRow?.c) || 0;

      const rows = await db.all(
        `SELECT u.userid, u.name, u.is_admin, u.created_at, COALESCE(u.source, 'dingtalk') AS source,
                u.phone, COALESCE(a.balance, 0) AS balance, a.updated_at,
                ea.batch_id, ea.last_login_at, ea.status AS external_status,
                r.id AS role_id, r.name AS role_name, r.is_enabled AS role_enabled
         FROM users u
         LEFT JOIN accounts a ON a.userid = u.userid
         LEFT JOIN external_accounts ea ON ea.userid = u.userid
         LEFT JOIN admin_user_roles ur ON ur.userid = u.userid
         LEFT JOIN admin_roles r ON r.id = ur.role_id
         ${whereSql}
         ORDER BY (u.name IS NULL), u.name COLLATE NOCASE, u.userid COLLATE NOCASE
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset],
      );

      const data = (rows || []).map((u) => {
        const userid = u?.userid ? String(u.userid) : '';
        const fixedAdmin = isFixedAdmin(cfg, userid);
        const isAdminFlag = fixedAdmin || Number(u?.is_admin) === 1;
        return {
          ...u,
          is_admin: isAdminFlag || u.role_id ? 1 : 0,
          is_fixed_admin: fixedAdmin ? 1 : 0,
          role: fixedAdmin ? { id: null, name: '超级管理员' } : (u.role_id ? { id: u.role_id, name: u.role_name, is_enabled: u.role_enabled } : null),
        };
      });

      return res.json({
        ok: true,
        page,
        pageSize,
        total,
        data,
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/data/reset-user', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const userid = req.body?.userid ? String(req.body.userid).trim() : '';
    if (!userid) {
      return res.status(400).json({ error: 'missing userid' });
    }
    if (isFixedAdmin(cfg, userid)) {
      return res.status(400).json({ error: 'fixed admin cannot be reset' });
    }

    try {
      const result = await runInTransaction(db, async (tx) => purgeUserBusinessData(tx, [userid]));
      publishMallRealtimeResetForUser(userid, 'reset_user');
      return res.json({ ok: true, counts: result.counts || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/data/reset-all', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const confirm = req.body?.confirm ? String(req.body.confirm).trim() : '';
    if (confirm !== 'RESET_ALL') {
      return res.status(400).json({ error: '确认口令不正确，已取消' });
    }

    try {
      const fixedAdminIds = (Array.isArray(cfg?.adminUserids) ? cfg.adminUserids : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);
      const allUsers = await db.all('SELECT userid FROM users', []);
      const targets = (allUsers || [])
        .map((r) => String(r?.userid || '').trim())
        .filter((id) => id && !fixedAdminIds.includes(id));
      const result = await runInTransaction(db, async (tx) => {
        // 全局业务表清空（保留受保护超管账户数据）
        if (fixedAdminIds.length) {
          await tx.run('DELETE FROM mall_order_listings WHERE NOT (seller_userid = ANY(?))', [fixedAdminIds]);
        } else {
          await tx.run('DELETE FROM mall_order_listings');
        }
        return purgeUserBusinessData(tx, targets, { protectUserids: fixedAdminIds });
      });
      publishMallRealtimeFullRefresh('reset_all');
      return res.json({ ok: true, protected_admins: fixedAdminIds.length, counts: result.counts || {}, targets: targets.length });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/users/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const ids = Array.isArray(req.body?.userids) ? req.body.userids : [];
    const userids = ids
      .map((x) => (x === null || x === undefined ? '' : String(x)))
      .filter((x) => x.length > 0);

    if (userids.length === 0) {
      return res.status(400).json({ error: 'missing userids' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const cfg = req.app?.locals?.cfg;
      const protectUserids = (Array.isArray(cfg?.adminUserids) ? cfg.adminUserids : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);
      const result = await runInTransaction(db, async (tx) => deleteUsersCompletely(tx, userids, { protectUserids }));
      if (Number(result?.deleted_users || 0) > 0) {
        publishMallRealtimeEvent('balance_changed', { reason: 'users_delete' });
        publishMallRealtimeEvent('charity_changed', { reason: 'users_delete' });
      }
      return res.json({ ok: true, deleted: result?.deleted_users ?? 0, counts: result?.counts || {} });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  registerAdminSettingsRoutes(router);

  router.post('/ledger/grant-batch', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const ids = Array.isArray(req.body?.userids) ? req.body.userids : [];
    const userids = ids
      .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
      .filter((x) => x);

    const amount = toInt(req.body?.amount);
    const reason = req.body?.reason ? String(req.body.reason) : undefined;
    const refId = req.body?.refId ? String(req.body.refId) : undefined;

    if (userids.length === 0) {
      return res.status(400).json({ error: 'missing userids' });
    }
    if (amount === null || amount <= 0) {
      return res.status(400).json({ error: 'amount must be positive integer' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      req.auditLogPayload = { userids, amount, reason: reason || '后台发币' };
      const result = await grantBatchWithNotify(db, cfg, { userids, amount, reason, refId, awaitNotify: false });
      for (const row of (result?.results || [])) {
        if (row?.ok && row?.userid) {
          publishMallRealtimeEvent('balance_changed', { userid: String(row.userid), reason: 'admin_grant_batch' });
        }
      }
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/redeem/confirm', requireAdminSession(), async (req, res) => {
    const secret = req.app?.locals?.cfg?.qrSignSecret;
    const cfg = req.app?.locals?.cfg;
    const encoded = req.body?.encoded;

    if (!encoded) {
      return res.status(400).json({ error: 'missing encoded' });
    }

    let payload;
    try {
      payload = verifyEncoded(encoded, secret);
    } catch (err) {
      const message = String(err?.message || err);
      if (err instanceof QRSignError) {
        return res.status(400).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }

    try {
      const db = req.app.locals.db;
      const cdkRow = await db.get(
        'SELECT product_bob_amount FROM redeem_cdks WHERE redeem_exchange_id = ? LIMIT 1',
        [String(payload.exchange_id || '')],
      );
      const displayBobAmount = Number(cdkRow?.product_bob_amount);
      req.auditLogPayload = {
        action: 'redeem_confirm',
        exchangeId: payload.exchange_id,
        productId: payload.product_id,
        productName: payload.product_name,
        bobAmount: Number.isFinite(displayBobAmount) && displayBobAmount > 0 ? displayBobAmount : payload.bob_amount,
        actualBobAmount: payload.bob_amount,
        userid: payload.userid,
        fulfilledBy: req.adminSession?.userid || '',
        fulfilledName: req.adminSession?.name || '',
      };
      const admin = req.adminSession || {};
      const result = await redeemConfirmWithNotify(db, cfg, {
        exchangeId: payload.exchange_id,
        userid: payload.userid,
        productId: payload.product_id,
        productName: payload.product_name,
        bobAmount: payload.bob_amount,
        reason: 'redeem',
        awaitNotify: false,
        fulfilledBy: admin?.userid ? String(admin.userid) : '',
        fulfilledName: admin?.name ? String(admin.name) : '',
      });
      publishMallRealtimeEvent('order_updated', {
        userid: String(payload.userid || ''),
        exchange_id: String(payload.exchange_id || ''),
        status: 'fulfilled',
        source: 'admin_redeem_confirm',
      });
      publishMallRealtimeEvent('balance_changed', {
        userid: String(payload.userid || ''),
        reason: 'admin_redeem_confirm',
      });
      if (result?.market_listing_cancelled) {
        publishMallRealtimeEvent('market_changed', {
          listing_id: String(result.market_listing_id || ''),
          exchange_id: String(payload.exchange_id || ''),
          reason: 'admin_redeem_confirm',
        });
      }

      const exchangeId = cdkRow
        ? publicAdminOrderReference(result.exchange_id)
        : result.exchange_id;
      return res.json({ ok: true, userid: result.userid, balance: result.balance, exchange_id: exchangeId });
    } catch (err) {
      const message = String(err?.message || err);
      const status = [
        'missing exchange_id',
        'missing userid',
        'missing product_id',
        'bob_amount must be positive integer',
        'insufficient balance',
        'exchange already redeemed',
        'payload mismatch',
        'order listed on market',
      ].includes(message)
        ? 400
        : 500;
      return res.status(status).json({ error: message });
    }
  });

  // ── 备份管理 ──────────────────────────────────────────────────────────────
  registerAdminBackupRoutes(router);
  registerAdminAuctionRoutes(router);

  return router;
}
