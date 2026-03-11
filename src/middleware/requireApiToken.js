export function requireApiToken() {
  return function requireApiTokenMiddleware(req, res, next) {
    const cfg = req.app?.locals?.cfg;
    const token = cfg?.apiToken;

    if (!token) {
      return next();
    }

    const incoming = req.header('x-api-token');
    if (!incoming || incoming !== token) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    return next();
  };
}
