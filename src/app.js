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
import { startMallOpeningScheduler } from './services/mallOpeningScheduler.js';
import { startDingtalkStream } from './services/dingtalkStreamService.js';
import { handleCheckinEvent, startAttendanceRewardReconcileScheduler } from './services/attendanceRewardService.js';
import { getClientIp, safeAppendAuditLog } from './services/auditLogService.js';

export function createApp({ db, cfg } = {}) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const pagesAssetsRoot = fileURLToPath(new URL('./pages/assets/', import.meta.url));
  app.use('/assets', express.static(pagesAssetsRoot, { maxAge: 0 }));

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
  app.use('/ledger', ledgerRouter());
  app.use('/exchange', exchangeRouter());
  app.use('/redeem', redeemRouter());
  app.use('/web', webRouter());
  app.use('/mall', mallRouter());
  app.use('/admin', adminRouter());
  app.use('/bob-token', bobTokenRouter());
  app.use('/users', usersRouter());
  app.use(docsRouter());

  startMallOpeningScheduler({ db, cfg });

  // 钉钉 Stream 长连接：接收考勤打卡事件并发放 BOB 币奖励
  // 仅当钉钉 appKey / appSecret 已配置时才启动
  const hasStreamConfig = cfg?.dingtalk?.appKey && cfg?.dingtalk?.appSecret;
  if (hasStreamConfig) {
    startDingtalkStream(cfg, {
      // 钉钉考勤打卡事件（eventType = attendance_check_record）
      attendance_check_record: ({ data, headers }) => handleCheckinEvent(db, cfg, { data, headers }),
      // 兼容其他可能的 topic 写法
      attendance_checkin: ({ data, headers }) => handleCheckinEvent(db, cfg, { data, headers }),
      'attendance:CHECKIN': ({ data, headers }) => handleCheckinEvent(db, cfg, { data, headers }),
      // 通配符兜底：打印所有未命中的事件，便于排查
      '*': ({ topic, data }) => {
        // eslint-disable-next-line no-console
        console.log(`[DingtalkStream] 未处理事件 topic="${topic}" data=${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)}`);
      },
    });
    startAttendanceRewardReconcileScheduler({ db, cfg });
  } else {
    // eslint-disable-next-line no-console
    console.warn('[DingtalkStream] 未配置 appKey/appSecret，跳过 Stream 连接');
  }

  return app;
}
