/**
 * 解析客户端 IP。
 *
 * trustProxy=true 时优先使用 Express 已按 trust proxy 规则校验的 req.ip
 *（hop 计数从右侧算，Nginx 追加的真实地址会生效，左侧伪造值不会被当成客户端）。
 * 禁止直接取 X-Forwarded-For 最左侧。
 *
 * trustProxy=false 时只用 socket 地址。
 */
export function resolveClientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const fromExpress = req?.ip != null ? String(req.ip).trim() : '';
    if (fromExpress) return fromExpress;
    // 无 Express 处理时，退回 socket（不要读 XFF 左侧）
    return String(req?.socket?.remoteAddress || '');
  }
  return String(req?.socket?.remoteAddress || '');
}

export function trustProxyFromReq(req) {
  const cfg = req?.app?.locals?.cfg;
  if (cfg && typeof cfg.trustProxy === 'boolean') return cfg.trustProxy;
  const t = req?.app?.get?.('trust proxy');
  return Boolean(t);
}
