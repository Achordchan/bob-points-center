// Auto-split from admin.js — settingsRoutes.js
import { requireAdminSession } from '../../middleware/requireAdminSession.js';
import {
  applyDingtalkConnectionSettings,
  getAttendanceRewardSettings,
  getDingtalkConnectionSettings,
  getExternalLoginSettings,
  getGroupCardSettings,
  getNotifySettings,
  getSiteVisibilitySettings,
  saveAttendanceRewardSettings,
  saveDingtalkConnectionSettings,
  saveExternalLoginSettings,
  saveSiteVisibilitySettings,
  toPublicDingtalkConnectionSettings,
  saveGroupCardSettings,
  saveNotifySettings,
} from '../../services/systemSettings.js';
import {
  ExternalAuthError,
  resetExternalAccountPassword,
  setExternalAccountStatus,
} from '../../services/externalAccountService.js';
import { deleteUsersCompletely } from '../../services/userDataPurgeService.js';
import { lockAdminAccountProtection } from '../../services/adminPermissionService.js';
import { publishMallRealtimeEvent } from '../../services/mallRealtimeService.js';
import { runInTransaction } from './shared.js';
import { getAttendanceRewardDailySummary, getAttendanceRewardDayDetail, reconcileAttendanceRewards } from '../../services/attendanceRewardService.js';
import { getUserName, sendOrQueueNotify } from '../../services/notifyOpsService.js';
import { toBool } from '../../services/notifyOpsService.js';
import {
  buildEffectiveGroupCardSettings,
  mergeGroupCardChannelIntoCfg,
  notifyGroupInteractiveCardBySettings,
  sendGroupInteractiveCard,
} from '../../services/groupCardNotifyService.js';
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
  listUsersByDept,
  notableListRecords,
  queryDingtalkOpenGroupBaseInfo,
  queryDingtalkGroupRobot,
} from '../../services/dingtalkService.js';
import {
  buildDingtalkAdvisoryWarning,
  buildGroupCardTestVars,
  ensureMallOpeningRow,
  expandDepartmentIdsFromTree,
  hasDingtalkApiCredential,
  listDingtalkDepartmentsTree,
  normalizeGroupCardButtons,
  renderTemplateVars,
  resolveDingtalkOrganizationName,
  toPositiveInt,
  withTimeout,
} from './shared.js';

export function registerAdminSettingsRoutes(router) {
  router.get('/settings/notify', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await getNotifySettings(db);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/notify', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await saveNotifySettings(db, req.body || {});
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/notify/test', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    let userid = req.body?.userid ? String(req.body.userid).trim() : '';
    const nameKeyword = req.body?.name ? String(req.body.name).trim() : '';
    const event = req.body?.event ? String(req.body.event).trim() : '';
    if (!event) {
      return res.status(400).json({ error: 'missing event' });
    }
    try {
      if (!userid && nameKeyword) {
        const kw = `%${nameKeyword}%`;
        const row = await db.get(
          `SELECT userid
           FROM users
           WHERE (LOWER(COALESCE(name, '')) LIKE LOWER(?) OR LOWER(userid) LIKE LOWER(?))
             AND COALESCE(source, 'dingtalk') <> 'external'
           ORDER BY (name IS NULL), name COLLATE NOCASE, userid COLLATE NOCASE
           LIMIT 1`,
          [kw, kw],
        );
        userid = row?.userid ? String(row.userid) : '';
      }
      if (!userid) {
        return res.status(400).json({ error: 'missing userid' });
      }
      const name = await getUserName(db, userid);
      const variables = {
        name: name || userid,
        userid,
        reason: '测试原因',
        product_name: '测试商品',
        project_id: 'TEST_CHARITY_001',
        project_name: '测试公益项目',
        amount: '10',
        balance: '100',
        exchange_id: 'TEST_EXCHANGE_001',
        from_name: '测试转出人',
        to_name: '测试收款人',
        activity_id: 'TEST_ACTIVITY_001',
        transfer_id: 'TEST_TRANSFER_001',
        buyer_name: '测试买家',
        seller_name: '测试卖家',
        listing_id: 'TEST_LISTING_001',
      };
      const notify = await sendOrQueueNotify({
        db,
        cfg,
        userid,
        title: '【BOB币中心】测试通知',
        lines: ['这是一条测试通知'],
        awaitNotify: true,
        event,
        variables,
      });
      if (notify?.ok === false) {
        return res.status(400).json({ ok: false, error: notify.error || '私聊测试发送失败', notify });
      }
      return res.json({ ok: true, notify });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/group-card', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const raw = await getGroupCardSettings(db);
      const data = buildEffectiveGroupCardSettings(cfg, raw);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/group-card', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const saved = await saveGroupCardSettings(db, req.body || {});
      const data = buildEffectiveGroupCardSettings(cfg, saved);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/group-card/preset', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const rawOpenConversationId = req.body?.openConversationId ? String(req.body.openConversationId).trim() : '';
    const incomingOpenConversationId = rawOpenConversationId;
    const name = req.body?.name ? String(req.body.name).trim() : '';
    if (!incomingOpenConversationId) return res.status(400).json({ error: '缺少钉钉群会话' });
    if (!name) return res.status(400).json({ error: 'missing preset name' });
    const rawConversationType = req.body?.conversationType ?? '';
    const conversationType = String(rawConversationType).toLowerCase();
    const hasGroupFlag = req.body?.isGroup !== undefined && req.body?.isGroup !== null;
    const isGroupFlag = req.body?.isGroup === true || req.body?.isGroup === 'true';
    const memberCount = Number(req.body?.memberCount || 0);
    const hasConversationId = hasDingtalkGroupOpenConversationId(incomingOpenConversationId);
    const explicitSingle = ['single', 'private', 'p2p', 'one2one', 'oto', '0', '1'].includes(conversationType)
      || (hasGroupFlag && !isGroupFlag)
      || (memberCount > 0 && memberCount <= 2);
    const explicitGroup = ['group', 'enterprise_group', 'org_group', '2'].includes(conversationType)
      || isGroupFlag
      || memberCount > 2;
    if (explicitSingle) return res.status(400).json({ error: '不能选择单聊，请选择群聊' });
    if (!incomingOpenConversationId || !hasConversationId) {
      return res.status(400).json({ error: '钉钉没有返回可用群会话 ID，请重新选择群聊' });
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      const openConversationId = incomingOpenConversationId;
      const current = await getGroupCardSettings(db);
      const oldPresets = Array.isArray(current?.channelPresets) ? current.channelPresets : [];
      const nextPresets = [
        { name, openConversationId },
        ...oldPresets.filter((item) => String(item?.openConversationId || '').trim() !== openConversationId),
      ];
      const saved = await saveGroupCardSettings(db, {
        ...current,
        channelPresets: nextPresets,
        channelPresetsEmpty: false,
        channel: {
          ...(current?.channel || {}),
          openConversationId,
        },
      });
      const data = buildEffectiveGroupCardSettings(cfg, saved);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/group-card/check', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const dingtalkSettings = await getDingtalkConnectionSettings(db, cfg);
      applyDingtalkConnectionSettings(cfg, dingtalkSettings);
      const settings = await getGroupCardSettings(db);
      const effective = buildEffectiveGroupCardSettings(cfg, settings);
      const channel = effective?.channel || {};
      const dingtalk = cfg?.dingtalk || {};
      const items = [
        { key: 'appKey', label: '钉钉应用 AppKey', ok: Boolean(String(dingtalk.appKey || '').trim()) },
        { key: 'appSecret', label: '钉钉应用 AppSecret', ok: Boolean(String(dingtalk.appSecret || '').trim()) },
        { key: 'agentId', label: '钉钉应用 AgentId', ok: Boolean(String(dingtalk.agentId || '').trim()) },
        { key: 'robotCode', label: '机器人编码', ok: Boolean(String(dingtalk.robotCode || '').trim()) },
        {
          key: 'openConversationId',
          label: '群会话',
          ok: Boolean(String(channel.openConversationId || '').trim()),
          message: channel.openConversationId ? '' : '未配置群会话',
        },
        { key: 'cardTemplateId', label: '卡片模板', ok: Boolean(String(channel.cardTemplateId || '').trim()) },
        { key: 'operatorUserid', label: '操作人 Userid', ok: Boolean(String(channel.operatorUserid || '').trim()) },
      ];
      if (items.find((item) => item.key === 'appKey')?.ok && items.find((item) => item.key === 'appSecret')?.ok) {
        try {
          await withTimeout(getV1AccessToken(cfg), 4000, '钉钉接口凭证检测超时');
          items.push({ key: 'accessToken', label: '钉钉接口凭证', ok: true });
        } catch (err) {
          items.push({ key: 'accessToken', label: '钉钉接口凭证', ok: false, message: String(err?.message || err) });
        }
      }
      if (channel.openConversationId && hasDingtalkApiCredential(cfg)) {
        try {
          const groupInfo = await withTimeout(
            queryDingtalkOpenGroupBaseInfo(cfg, channel.openConversationId),
            4000,
            '钉钉群聊校验超时',
          );
          items.push({
            key: 'groupInfo',
            label: '钉钉群聊校验',
            ok: true,
            message: groupInfo?.title ? `群聊：${groupInfo.title}` : '',
          });
        } catch (err) {
          items.push(buildDingtalkAdvisoryWarning(
            'groupInfo',
            '钉钉群聊校验',
            err,
            '钉钉返回接口权限不足，无法提前校验群聊；这不代表群会话不可用，请以模板测试发送结果为准。',
          ));
        }
      }
      if (channel.openConversationId && dingtalk.robotCode && hasDingtalkApiCredential(cfg)) {
        try {
          const robotInfo = await withTimeout(
            queryDingtalkGroupRobot(cfg, { openConversationId: channel.openConversationId, robotCode: dingtalk.robotCode }),
            4000,
            '群机器人校验超时',
          );
          items.push({
            key: 'groupRobot',
            label: '群机器人校验',
            ok: Boolean(robotInfo?.userId || robotInfo?.unionId),
            message: robotInfo?.userId || robotInfo?.unionId ? '机器人已在当前群内' : '未检测到该机器人，请先把机器人添加到群。',
          });
        } catch (err) {
          items.push(buildDingtalkAdvisoryWarning(
            'groupRobot',
            '群机器人校验',
            err,
            '钉钉返回接口权限不足，无法判断机器人是否在群内；如果测试发送收不到，请先把机器人添加到群。',
          ));
        }
      }
      const ok = items.every((item) => item.ok === true);
      return res.json({
        ok: true,
        data: {
          ok,
          items,
          note: '本检测会校验配置完整性和钉钉凭证；群聊资料与机器人检测仅作辅助，真实可用性以模板测试发送结果为准。',
        },
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/group-card/test', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const event = req.body?.event ? String(req.body.event).trim() : 'manual';
    try {
      const scheduleRow = await ensureMallOpeningRow(db);
      const vars = buildGroupCardTestVars(scheduleRow);
      const settings = await getGroupCardSettings(db);
      if (settings?.enabled === false) {
        return res.status(400).json({ error: 'group_card_disabled' });
      }
      const tpl = settings?.templates?.[event] || settings?.templates?.manual;
      if (tpl?.enabled === false) {
        return res.status(400).json({ error: 'group_card_template_disabled' });
      }
      const runtimeCfg = mergeGroupCardChannelIntoCfg(cfg, settings);
      const title = renderTemplateVars(tpl?.title, vars) || '【BOB币中心】测试群卡标题';
      const markdown = renderTemplateVars(tpl?.content, vars) || '这是一条测试群卡内容';
      const buttons = normalizeGroupCardButtons(
        (Array.isArray(tpl?.buttons) ? tpl.buttons : []).map((button) => ({
          ...button,
          text: renderTemplateVars(button?.text, vars),
          url: renderTemplateVars(button?.url, vars),
        })),
      );
      await sendGroupInteractiveCard(runtimeCfg, {
        title,
        markdown,
        outTrackId: `group_test_${event}_${Date.now()}`,
        buttons,
      });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });


  router.get('/settings/image-optimization', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await getImageOptimizationOverview(db);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/image-optimization', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await saveImageOptimizationSettings(db, req.body || {});
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/image-optimization/upload', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await optimizeUploadedImage(db, req.body || {});
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(400).json({ error: String(err?.message || err) });
    }
  });

  router.post('/image-optimization/batch', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await runImageOptimizationBatch(db, { mode: req.body?.mode || 'pending' });
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  const scanResourcesResponse = async (req, res, onlyUnused = false) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await scanResources(db);
      return res.json({ ok: true, data: onlyUnused ? { scannedAt: data.scannedAt, summary: data.summary, unused: data.unused, ignored: data.ignored } : data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  };

  router.get('/resources/overview', requireAdminSession(), (req, res) => scanResourcesResponse(req, res));
  router.get('/resources/scan', requireAdminSession(), (req, res) => scanResourcesResponse(req, res));
  router.get('/resources/unused', requireAdminSession(), (req, res) => scanResourcesResponse(req, res, true));

  router.post('/resources/ignore', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const paths = await saveIgnoredResourcePaths(db, req.body?.paths || []);
      return res.json({ ok: true, data: { paths } });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/dingtalk/status', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const settings = await getDingtalkConnectionSettings(db, cfg);
      applyDingtalkConnectionSettings(cfg, settings);
      let connected = false;
      let error = '';
      try {
        await getAccessToken(cfg);
        connected = true;
      } catch (err) {
        error = String(err?.message || err);
      }
      return res.json({ ok: true, connected, error, data: { organizationName: settings.organizationName || '', corpId: settings.corpId ? `${String(settings.corpId).slice(0, 4)}****` : '' } });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/dingtalk', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      let settings = await getDingtalkConnectionSettings(db, cfg);
      applyDingtalkConnectionSettings(cfg, settings);
      let connected = false;
      let error = '';
      try {
        await getAccessToken(cfg);
        connected = true;
        try {
          settings = await resolveDingtalkOrganizationName(cfg, settings);
          applyDingtalkConnectionSettings(cfg, settings);
        } catch (err) {
          error = String(err?.message || err);
        }
      } catch (err) {
        error = String(err?.message || err);
      }
      return res.json({ ok: true, connected, error, data: toPublicDingtalkConnectionSettings(settings) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/dingtalk', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const input = { ...(req.body || {}) };
      delete input.organizationName;
      let settings = await saveDingtalkConnectionSettings(db, input, cfg);
      applyDingtalkConnectionSettings(cfg, settings);
      try {
        settings = await resolveDingtalkOrganizationName(cfg, settings);
        if (settings.organizationName) {
          settings = await saveDingtalkConnectionSettings(db, settings, cfg);
        }
        applyDingtalkConnectionSettings(cfg, settings);
      } catch (err) {
        // 连接配置仍可保存；组织名称会在权限恢复或下次校验成功后自动补齐。
      }
      return res.json({ ok: true, data: toPublicDingtalkConnectionSettings(settings) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/dingtalk/departments', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const settings = await getDingtalkConnectionSettings(db, cfg);
      applyDingtalkConnectionSettings(cfg, settings);
      await getAccessToken(cfg);
      const data = await listDingtalkDepartmentsTree(cfg);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/attendance-reward', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await getAttendanceRewardSettings(db);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/attendance-reward', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const input = { ...(req.body || {}) };
      if (String(input.departmentMode || '') === 'selected' && Array.isArray(input.departmentIds) && input.departmentIds.length) {
        try {
          const departments = await listDingtalkDepartmentsTree(cfg);
          input.departmentExpandedIds = expandDepartmentIdsFromTree(departments, input.departmentIds);
        } catch {
          input.departmentExpandedIds = input.departmentIds;
        }
      } else {
        input.departmentExpandedIds = [];
      }
      const data = await saveAttendanceRewardSettings(db, input);
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/attendance-reward/status', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const days = Math.min(14, Math.max(1, toPositiveInt(req.query?.days, 7)));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await getAttendanceRewardDailySummary(db, { days });
      return res.json({ ok: true, days, data: rows });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/settings/attendance-reward/detail', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const date = req.query?.date ? String(req.query.date).trim() : '';
    if (!date) return res.status(400).json({ error: 'missing date' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await getAttendanceRewardDayDetail(db, { date });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/attendance-reward/reconcile', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const date = req.body?.date ? String(req.body.date).trim() : '';
    const notify = req.body?.notify === undefined ? false : toBool(req.body.notify);
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await reconcileAttendanceRewards(db, cfg, { date, notifyOnReward: notify });
      return res.json({ ok: true, data: result });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // 对外活动外部账号：注册开关、批次统计与活动结束后的批量清理。
  router.get('/settings/external-login', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const settings = await getExternalLoginSettings(db);
      const summary = await db.get(
        `SELECT COUNT(1) AS total,
                SUM(CASE WHEN COALESCE(status, 'active') = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN last_login_at IS NOT NULL THEN 1 ELSE 0 END) AS logged_in
           FROM external_accounts`,
      );
      const batches = await db.all(
        `SELECT COALESCE(batch_id, '') AS batch_id, COUNT(1) AS count,
                MIN(created_at) AS first_at, MAX(created_at) AS last_at
           FROM external_accounts
          GROUP BY COALESCE(batch_id, '')
          ORDER BY MAX(created_at) DESC NULLS LAST
          LIMIT 50`,
      );
      return res.json({
        ok: true,
        data: {
          settings,
          summary: {
            total: Number(summary?.total || 0),
            active: Number(summary?.active || 0),
            logged_in: Number(summary?.logged_in || 0),
          },
          batches: batches || [],
        },
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/settings/external-login', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await runInTransaction(db, async (tx) => {
        await lockAdminAccountProtection(tx);
        return await saveExternalLoginSettings(tx, {
          enabled: req.body?.enabled,
          batch_id: req.body?.batch_id,
          message: req.body?.message,
        });
      });
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // 外部账号运维：现场忘记密码时由工作人员重置；出问题的账号可禁用（立即踢下线）/ 重新启用。
  router.post('/users/external/reset-password', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const userid = String(req.body?.userid ?? '').trim();
    try {
      res.setHeader('Cache-Control', 'no-store');
      await resetExternalAccountPassword(db, { userid, password: req.body?.password });
      // 审计只记目标账号，绝不记录密码。
      req.auditLogPayload = { userid };
      return res.json({ ok: true });
    } catch (err) {
      if (err instanceof ExternalAuthError) {
        return res.status(err.code === 'not_external_account' ? 404 : 400).json({ error: err.message, code: err.code });
      }
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/users/external/set-status', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const userid = String(req.body?.userid ?? '').trim();
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await setExternalAccountStatus(db, { userid, status: req.body?.status });
      req.auditLogPayload = { userid, status: data.status };
      return res.json({ ok: true, data });
    } catch (err) {
      if (err instanceof ExternalAuthError) {
        return res.status(err.code === 'not_external_account' ? 404 : 400).json({ error: err.message, code: err.code });
      }
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // 活动结束后按批次清理外部账号（连带清除其流水/订单/竞拍等业务数据）。
  // 需要显式 confirm=DELETE 二次确认；管理员账号不会被清理。
  router.post('/settings/external-login/purge', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const cfg = req.app?.locals?.cfg;
    const batchId = req.body?.batch_id === undefined || req.body?.batch_id === null
      ? ''
      : String(req.body.batch_id).trim();
    const confirm = String(req.body?.confirm || '').trim().toUpperCase();
    if (confirm !== 'DELETE') {
      return res.status(400).json({ error: 'confirmation_required', message: '请输入 DELETE 以确认清理' });
    }

    try {
      res.setHeader('Cache-Control', 'no-store');
      const protectUserids = (Array.isArray(cfg?.adminUserids) ? cfg.adminUserids : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);
      const result = await runInTransaction(db, async (tx) => {
        await lockAdminAccountProtection(tx);
        const rows = await tx.all(
          `SELECT a.userid
             FROM external_accounts a
             JOIN users u ON u.userid = a.userid
            WHERE COALESCE(a.batch_id, '') = ?
              AND COALESCE(u.is_admin, 0) = 0
              AND NOT EXISTS (
                SELECT 1 FROM admin_user_roles ur
                JOIN admin_roles r ON r.id = ur.role_id
                WHERE ur.userid = a.userid AND r.is_enabled = 1
              )
            ORDER BY a.userid`,
          [batchId],
        );
        const userids = (rows || []).map((row) => String(row.userid || '')).filter(Boolean);
        return await deleteUsersCompletely(tx, userids, { protectUserids });
      });
      if (Number(result?.deleted_users || 0) > 0) {
        publishMallRealtimeEvent('balance_changed', { reason: 'external_purge' });
        publishMallRealtimeEvent('charity_changed', { reason: 'external_purge' });
      }
      return res.json({
        ok: true,
        batch_id: batchId,
        deleted: result?.deleted_users ?? 0,
        counts: result?.counts || {},
      });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

}
