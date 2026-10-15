import express from 'express';
import { fileURLToPath } from 'node:url';
import { healthRouter } from './routes/health.js';
import { ledgerRouter } from './routes/ledger.js';
import { exchangeRouter } from './routes/exchange.js';
import { redeemRouter } from './routes/redeem.js';
import { docsRouter } from './routes/docs.js';
import { webRouter } from './routes/web.js';
import { mallRouter } from './routes/mall.js';
import { adminRouter } from './routes/admin.js';
import { bobTokenRouter } from './routes/bobToken.js';
import { usersRouter } from './routes/users.js';
import { qrImageRouter } from './routes/qrImage.js';
import { devAuthRouter, shouldEnableLocalDevAuth } from './routes/devAuth.js';
import { startMallOpeningScheduler } from './services/mallOpeningScheduler.js';
import { startAuctionSettleScheduler } from './services/auctionSettleScheduler.js';
import { startDingtalkStream } from './services/dingtalkStreamService.js';
import { clearAttendanceDepartmentCache, handleCheckinEvent, startAttendanceRewardReconcileScheduler } from './services/attendanceRewardService.js';
import {
  DINGTALK_CONTACT_DEPT_EVENTS,
  DINGTALK_CONTACT_USER_EVENTS,
  handleContactUserEvent,
  startDingtalkUserSyncScheduler,
} from './services/dingtalkUserSyncService.js';
import { getClientIp, safeAppendAuditLog } from './services/auditLogService.js';
import { clientIpKey, createRateLimiter } from './middleware/rateLimit.js';

export function shouldStartDingtalkStream(cfg) {
  return Boolean(
    cfg?.dingtalk?.appKey
    && cfg?.dingtalk?.appSecret
    && cfg?.dingtalk?.streamEnabled !== false,
  );
}

export function createApp({ db, cfg } = {}) {
  const app = express();
  if (cfg?.trustProxy) {
    // 仅在配置信任反代时启用；配合 clientIp 工具只读 XFF。
    app.set('trust proxy', 1);
  }
  // 默认 JSON 1MB；备份导入/图片 base64 上传路由单独放宽到 50MB。
  app.use((req, res, next) => {
    const pth = String(req.path || '');
    const large = pth === '/admin/backup/import' || pth === '/admin/image-optimization/upload';
    return express.json({
      limit: large ? '50mb' : '1mb',
      verify: (req2, _res, buf) => {
        req2.rawBodyLength = buf?.length || 0;
      },
    })(req, res, next);
  });

  const oauthLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyFn: (req) => clientIpKey(req, 'oauth'),
    message: '登录请求过于频繁，请稍后再试',
  });
  const qrLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 120,
    keyFn: (req) => clientIpKey(req, 'qr'),
    message: '二维码请求过于频繁，请稍后再试',
  });
  const feedbackLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 20,
    keyFn: (req) => clientIpKey(req, 'feedback'),
    message: '反馈提交过于频繁，请稍后再试',
  });
  const transferLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyFn: (req) => clientIpKey(req, 'transfer'),
    message: '转账过于频繁，请稍后再试',
  });
  const auctionBidLimiter = createRateLimiter({
    windowMs: 60_000,
    // 出价高峰集中在活动最后几秒；办公网 NAT 下同 IP 并发更高，阈值宽于转账。
    max: 60,
    keyFn: (req) => clientIpKey(req, 'auction_bid'),
    message: '出价过于频繁，请稍后再试',
  });
  const sseLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 60,
    keyFn: (req) => clientIpKey(req, 'sse'),
    message: '实时连接请求过于频繁，请稍后再试',
  });

  app.use((req, res, next) => {
    const p = String(req.path || '');
    if (p.startsWith('/admin/oauth') || p.startsWith('/web/oauth')) return oauthLimiter(req, res, next);
    if (p.startsWith('/qr/')) return qrLimiter(req, res, next);
    if (p === '/mall/events') return sseLimiter(req, res, next);
    if (req.method === 'POST' && (p === '/mall/more/feedback' || p.startsWith('/mall/more/feedback/'))) {
      return feedbackLimiter(req, res, next);
    }
    if (req.method === 'POST' && (p === '/ledger/transfer' || p === '/mall/transfer')) {
      return transferLimiter(req, res, next);
    }
    if (req.method === 'POST' && p === '/mall/auction/bid') {
      return auctionBidLimiter(req, res, next);
    }
    return next();
  });

  const pagesAssetsRoot = fileURLToPath(new URL('./pages/assets/', import.meta.url));
  app.use('/assets', express.static(pagesAssetsRoot, { maxAge: 0 }));
  app.get('/favicon.ico', (_req, res) => {
    res.redirect(302, '/assets/favicon.png');
  });
  // 对外活动短链：现场二维码直接指向 /login，保留查询串（含回跳地址）。
  app.get('/login', (req, res) => {
    const original = String(req.originalUrl || '/login');
    const queryIndex = original.indexOf('?');
    const query = queryIndex === -1 ? '' : original.slice(queryIndex);
    res.redirect(302, `/web/login${query}`);
  });
  const adminAppRoot = fileURLToPath(new URL('./pages/admin-app-dist/', import.meta.url));
  app.use('/admin-app', express.static(adminAppRoot, { maxAge: 0 }));

  app.locals.db = db;
  app.locals.cfg = cfg;

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const pathname = req?.path ? String(req.path) : '';
      const method = String(req.method || '').toUpperCase();
      const isAdminLogPolling = pathname === '/admin/logs';
      const shouldLog = !isAdminLogPolling && (pathname.startsWith('/admin') || method !== 'GET');
      if (!shouldLog) return;

      const admin = req.adminSession;
      const web = req.webSession;
      const actorType = admin ? 'admin' : (web ? 'user' : 'anonymous');
      const actorId = admin?.userid || web?.userid || '';
      const actorName = admin?.name || web?.name || '';
      safeAppendAuditLog(req.app?.locals?.db, {
        eventType: 'request',
        actorType,
        actorId,
        actorName,
        ip: getClientIp(req),
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: res.statusCode,
        message: `请求 ${String(req.method || '').toUpperCase()} ${req.originalUrl || req.url}，状态 ${res.statusCode}，耗时 ${Date.now() - startedAt}ms`,
        payload: req.auditLogPayload,
      });
    });
    return next();
  });

  app.use('/health', healthRouter());
  if (shouldEnableLocalDevAuth(cfg)) {
    app.use('/__dev', devAuthRouter());
  }
  app.use('/ledger', ledgerRouter());
  app.use('/exchange', exchangeRouter());
  app.use('/redeem', redeemRouter());
  app.use('/web', webRouter());
  app.use('/mall', mallRouter());
  app.use('/admin', adminRouter());
  app.use('/bob-token', bobTokenRouter());
  app.use('/users', usersRouter());
  app.use('/qr', qrImageRouter());
  app.use(docsRouter());

  startMallOpeningScheduler({ db, cfg });
  startAuctionSettleScheduler({ db, cfg });

  // 钉钉 Stream 长连接：接收考勤打卡事件并发放 BOB 币奖励
  // 仅当钉钉 appKey / appSecret 已配置时才启动
  if (shouldStartDingtalkStream(cfg)) {
    startDingtalkStream(cfg, {
      // 钉钉考勤打卡事件（eventType = attendance_check_record）
      attendance_check_record: ({ data, headers }) => handleCheckinEvent(db, cfg, { data, headers }),
      // 兼容其他可能的 topic 写法
      attendance_checkin: ({ data, headers }) => handleCheckinEvent(db, cfg, { data, headers }),
      'attendance:CHECKIN': ({ data, headers }) => handleCheckinEvent(db, cfg, { data, headers }),
      // 通讯录事件：入职/资料修改/离职实时更新本地资料；部门变更清空考勤部门缓存
      ...Object.fromEntries(DINGTALK_CONTACT_USER_EVENTS.map((eventType) => [
        eventType,
        ({ data }) => handleContactUserEvent(db, cfg, { topic: eventType, data }),
      ])),
      ...Object.fromEntries(DINGTALK_CONTACT_DEPT_EVENTS.map((eventType) => [
        eventType,
        () => clearAttendanceDepartmentCache(),
      ])),
      // 通配符兜底：打印所有未命中的事件，便于排查
      '*': ({ topic, data, headers }) => {
        // eslint-disable-next-line no-console
        console.log(`[DingtalkStream] 未处理事件 topic="${topic}" headers=${JSON.stringify(headers||{}).slice(0,300)} data=${typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500)}`);
      },
    });
    startAttendanceRewardReconcileScheduler({ db, cfg });
    startDingtalkUserSyncScheduler({ db, cfg });
  } else if (cfg?.dingtalk?.streamEnabled === false) {
    // eslint-disable-next-line no-console
    console.warn('[DingtalkStream] 已通过 DINGTALK_STREAM_ENABLED=false 禁用 Stream 连接');
  } else {
    // eslint-disable-next-line no-console
    console.warn('[DingtalkStream] 未配置 appKey/appSecret，跳过 Stream 连接');
  }

  return app;
}
