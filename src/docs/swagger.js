import swaggerJSDoc from 'swagger-jsdoc';
import { fileURLToPath } from 'node:url';

const routeDocsGlob = fileURLToPath(new URL('../routes/openapi/*.openapi.js', import.meta.url));

const info = {
  title: 'BOB 币 API 文档',
  version: '0.2.0',
  description: 'BOB 币积分系统接口文档。服务基于 Node.js + Express，数据存储为 PostgreSQL。',
};

const tags = [
  { name: '系统', description: '健康检查与基础能力。' },
  { name: '文档', description: 'OpenAPI 文档与文档页入口。' },
  { name: 'Web免登', description: '钉钉 Web 免登与会话相关接口。' },
  { name: '台账', description: '余额、流水、发币、扣币、转账。' },
  { name: '兑换', description: '二维码编码与兑换准备。' },
  { name: '核销', description: '核销确认与核销记录查询。' },
  { name: '用户', description: '用户列表接口（bob_token 鉴权）。' },
  { name: '商城', description: '商城与活动相关接口（web session 或 bob_token）。' },
  { name: '管理端', description: '后台管理接口（管理员会话 Cookie）。' },
  { name: 'Token', description: 'BOB Token 管理（管理员会话）。' },
];

const components = {
  schemas: {
    HealthResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
      },
      required: ['ok'],
    },
    ErrorResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        error: { type: 'string' },
      },
      required: ['error'],
    },
    BalanceResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        userid: { type: 'string' },
        balance: { type: 'integer' },
      },
      required: ['userid', 'balance'],
    },
    GenericObject: {
      type: 'object',
      additionalProperties: true,
    },
  },
};

export function buildOpenApiSpec({ baseUrl }) {
  return swaggerJSDoc({
    definition: {
      openapi: '3.0.3',
      info,
      servers: [{ url: baseUrl }],
      tags,
      components,
    },
    apis: [routeDocsGlob],
  });
}

const docsAuthRedirectScript = `
(function () {
  var originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;

  function isSameOrigin(input) {
    try {
      var raw = typeof input === 'string' ? input : (input && input.url) || '';
      if (!raw) return true;
      return new URL(raw, window.location.origin).origin === window.location.origin;
    } catch (_) {
      return true;
    }
  }

  function redirectToLogin() {
    var target = window.location.pathname + window.location.search + window.location.hash;
    window.location.replace('/admin/login?redirect=' + encodeURIComponent(target || '/docs/'));
  }

  window.fetch = function () {
    var input = arguments[0];
    return originalFetch.apply(this, arguments).then(function (response) {
      if (response && response.status === 401 && isSameOrigin(input)) redirectToLogin();
      return response;
    });
  };
})();`;

export const swaggerUiOptions = {
  customSiteTitle: 'BOB币 API 文档',
  customRobots: 'noindex,nofollow',
  swaggerOptions: {
    docExpansion: 'none',
    filter: true,
    persistAuthorization: true,
    url: '/openapi.json',
    withCredentials: true,
    tryItOutEnabled: true,
  },
  customCss: '',
  customJsStr: docsAuthRedirectScript,
};
