import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

import { buildOpenApiSpec, swaggerUiOptions } from '../docs/swagger.js';

function getBaseUrl(req) {
  const cfg = req.app?.locals?.cfg;
  return cfg?.serverBaseUrl || `${req.protocol}://${req.get('host')}`;
}

export function docsRouter() {
  const router = Router();

  router.get('/openapi.json', (req, res) => {
    res.json(buildOpenApiSpec({ baseUrl: getBaseUrl(req) }));
  });

  router.use('/docs', swaggerUi.serve, swaggerUi.setup(null, swaggerUiOptions));

  return router;
}
