import { Router } from 'express';
import { fileURLToPath } from 'node:url';

import { buildOpenApiSpec } from '../docs/openapi.js';

export function docsRouter() {
  const router = Router();
  const pagesRoot = fileURLToPath(new URL('../pages/', import.meta.url));

  router.get('/openapi.json', (req, res) => {
    const cfg = req.app?.locals?.cfg;
    const baseUrl = cfg?.serverBaseUrl || `${req.protocol}://${req.get('host')}`;
    res.json(buildOpenApiSpec({ baseUrl }));
  });

  router.get('/docs', (_req, res) => {
    res.type('html').sendFile('docs.html', { root: pagesRoot });
  });

  return router;
}
