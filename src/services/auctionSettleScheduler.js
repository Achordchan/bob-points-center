// 限时竞拍定时结算：周期扫描到期活动并结算 + 通知获胜者。
// 结算本身是惰性条件更新（settleAuctionIfDue 幂等），调度器只是让结算与通知
// 不再依赖“有人读取”；读请求里的结算逻辑保留为 0-5s 窗口内的兜底。
import { notifyAuctionWinners, settleAuctionIfDue } from './auctionService.js';
import { publishMallRealtimeEvent } from './mallRealtimeService.js';

export function startAuctionSettleScheduler({ db, cfg, intervalMs = 5000, logger = console } = {}) {
  if (!db) return () => null;
  let ticking = false;

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const rows = await db.all(
        `SELECT id, title FROM auction_activities
          WHERE status IN ('scheduled', 'active') AND end_at <= ?
          ORDER BY end_at ASC
          LIMIT 20`,
        [now],
      );
      const winners = [];
      for (const row of rows || []) {
        // eslint-disable-next-line no-await-in-loop
        const result = await settleAuctionIfDue(db, { activityId: row.id, now });
        if (result.just_settled && result.winner) {
          winners.push({ activity_id: Number(row.id), title: String(row.title || ''), ...result.winner });
        }
      }
      if (winners.length) {
        notifyAuctionWinners({ db, cfg, winners });
        publishMallRealtimeEvent('auction_changed', { reason: 'settled' });
      }
    } catch (err) {
      // 与商城开放调度一致：单次 tick 失败静默，下一轮重扫自愈。
      logger.warn?.(`[AuctionSettle] tick failed: ${err?.message || err}`);
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(tick, Math.max(1000, Number(intervalMs) || 5000));
  // 不阻止进程正常退出（测试/脚本中创建 app 时无需显式清理）。
  if (typeof timer?.unref === 'function') timer.unref();
  tick();
  return () => clearInterval(timer);
}
