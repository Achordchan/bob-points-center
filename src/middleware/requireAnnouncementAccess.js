import { hasPendingRequiredAnnouncement } from '../services/announcementAccessService.js';

export function requireAnnouncementAccess() {
  return async function requireAnnouncementAccessMiddleware(req, res, next) {
    const userid = req.webSession?.userid ? String(req.webSession.userid).trim() : '';
    if (!userid) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const blocked = await hasPendingRequiredAnnouncement(req.app?.locals?.db, userid);
      if (blocked) {
        return res.status(403).json({
          error: 'announcement_ack_required',
          message: '请先阅读并确认最新规则',
          access_state_url: '/mall/access-state',
        });
      }
      return next();
    } catch {
      return res.status(503).json({
        error: 'announcement_access_unavailable',
        message: '暂时无法确认公告签署状态，请稍后重试。',
      });
    }
  };
}
