import { getSiteVisibilitySettings } from '../services/systemSettings.js';

/**
 * 前台业务接口站点开关。
 * site_visibility_settings.enabled === false 时拒绝写/读业务 API。
 * 登录、站点状态、OAuth、健康检查等入口由调用方自行排除。
 * 设置读取异常时 fail-closed（拒绝），避免维护状态被意外打开。
 */
export function requireSiteEnabled() {
  return async function requireSiteEnabledMiddleware(req, res, next) {
    try {
      const site = await getSiteVisibilitySettings(req.app?.locals?.db);
      if (site?.enabled === false) {
        return res.status(403).json({
          error: 'site_disabled',
          message: site.message || '系统维护中，请稍后再试。',
        });
      }
      return next();
    } catch (err) {
      return res.status(503).json({
        error: 'site_status_unavailable',
        message: '暂时无法确认站点状态，请稍后重试。',
      });
    }
  };
}
