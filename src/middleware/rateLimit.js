import { resolveClientIp, trustProxyFromReq } from '../utils/clientIp.js';

/**
 * 简易内存固定窗口限流。
 * keyFn 返回字符串桶；超限返回 429。
 * 多实例各自计数（进程内），反代仍应配置连接/请求限制作为外层防护。
 */
export function createRateLimiter({
  windowMs = 60_000,
  max = 60,
  keyFn,
  message = '请求过于频繁，请稍后再试',
} = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  function cleanup(now) {
    if (hits.size < 5000) return;
    for (const [k, v] of hits) {
      if (!v || v.resetAt <= now) hits.delete(k);
    }
  }

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = typeof keyFn === 'function' ? keyFn(req) : `${req.ip || ''}:${req.method}:${req.path}`;
    if (!key) return next();

    cleanup(now);
    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + Math.max(1000, Number(windowMs) || 60_000) };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    const limit = Math.max(1, Number(max) || 1);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > limit) {
      return res.status(429).json({ error: 'rate_limited', message });
    }
    return next();
  };
}

export function clientIpKey(req, suffix = '') {
  const ip = resolveClientIp(req, { trustProxy: trustProxyFromReq(req) }) || 'unknown';
  return suffix ? `${ip}:${suffix}` : ip;
}
