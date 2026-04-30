const REF_ERROR = { $ref: '#/components/schemas/ErrorResponse' };
const REF_GENERIC = { $ref: '#/components/schemas/GenericObject' };

function jsonContent(schema = REF_GENERIC, example) {
  const media = { schema };
  if (example !== undefined) {
    media.examples = { example: { value: example } };
  }
  return { 'application/json': media };
}

function successResponse(description = '成功', schema = REF_GENERIC, example) {
  return {
    description,
    content: jsonContent(schema, example),
  };
}

function errorResponse(description = '请求失败') {
  return {
    description,
    content: jsonContent(REF_ERROR),
  };
}

function requestJson(schema = REF_GENERIC, example, required = true) {
  const media = { schema };
  if (example !== undefined) {
    media.examples = { example: { value: example } };
  }
  return {
    required,
    content: {
      'application/json': media,
    },
  };
}

function withCommonErrors(base, {
  badRequest = false,
  unauthorized = false,
  forbidden = false,
  notFound = false,
} = {}) {
  const out = { ...base };
  if (badRequest && !out['400']) out['400'] = errorResponse('参数错误');
  if (unauthorized && !out['401']) out['401'] = errorResponse('未授权');
  if (forbidden && !out['403']) out['403'] = errorResponse('无权限');
  if (notFound && !out['404']) out['404'] = errorResponse('资源不存在');
  if (!out['500']) out['500'] = errorResponse('服务端错误');
  return out;
}

function qp(name, description, {
  required = false,
  type = 'string',
  minimum,
  maximum,
  example,
  defaultValue,
  enumValues,
} = {}) {
  const schema = { type };
  if (minimum !== undefined) schema.minimum = minimum;
  if (maximum !== undefined) schema.maximum = maximum;
  if (defaultValue !== undefined) schema.default = defaultValue;
  if (Array.isArray(enumValues) && enumValues.length > 0) schema.enum = enumValues;
  const param = {
    name,
    in: 'query',
    required,
    description,
    schema,
  };
  if (example !== undefined) param.example = example;
  return param;
}

export function buildOpenApiSpec({ baseUrl }) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'BOB 币 API 文档',
      version: '0.2.0',
      description: 'BOB 币积分系统接口文档。服务基于 Node.js + Express，数据存储为 PostgreSQL。',
    },
    servers: [{ url: baseUrl }],
    tags: [
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
    ],
    paths: {
      '/health': {
        get: {
          tags: ['系统'],
          summary: '健康检查',
          responses: withCommonErrors({
            '200': successResponse('成功', { $ref: '#/components/schemas/HealthResponse' }, { ok: true }),
          }),
        },
      },

      '/openapi.json': {
        get: {
          tags: ['文档'],
          summary: '获取 OpenAPI 文档 JSON',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }),
        },
      },

      '/web/config': {
        get: {
          tags: ['Web免登'],
          summary: '获取钉钉 JSAPI 配置',
          parameters: [
            qp('url', '当前页面 URL（完整 URL）', { required: true, example: 'https://example.com/mall' }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { badRequest: true }),
        },
      },

      '/web/auth': {
        get: {
          tags: ['Web免登'],
          summary: '钉钉免登换取用户并建立 web 会话',
          parameters: [
            qp('code', '钉钉授权码', { required: true, example: 'auth_code_xxx' }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { userid: 'u001', name: '张三', avatar: '' }),
          }, { badRequest: true }),
        },
      },

      '/web/logout': {
        get: {
          tags: ['Web免登'],
          summary: '清理 web 会话',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true }),
          }),
        },
      },

      '/users/list': {
        post: {
          tags: ['用户'],
          summary: '按条件分页查询用户列表（bob_token）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              bob_token: { type: 'string' },
              keyword: { type: 'string' },
              page: { type: 'integer', minimum: 1, default: 1 },
              pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
            },
            required: ['bob_token'],
          }, {
            bob_token: '<BOB_TOKEN>',
            keyword: '',
            page: 1,
            pageSize: 30,
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未授权（缺少或无效 bob_token）'),
          }),
        },
      },

      '/ledger/balance': {
        get: {
          tags: ['台账'],
          summary: '查询余额',
          parameters: [
            qp('userid', '用户 userid', { required: true, example: 'u001' }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', { $ref: '#/components/schemas/BalanceResponse' }, { userid: 'u001', balance: 100 }),
          }, { badRequest: true }),
        },
      },

      '/ledger/records': {
        get: {
          tags: ['台账'],
          summary: '查询积分流水',
          parameters: [
            qp('userid', '用户 userid', { required: true, example: 'u001' }),
            qp('page', '页码，从 1 开始', { type: 'integer', minimum: 1, defaultValue: 1 }),
            qp('page_size', '每页条数', { type: 'integer', minimum: 1, defaultValue: 20 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { badRequest: true }),
        },
      },

      '/ledger/transfer': {
        post: {
          tags: ['台账'],
          summary: '用户转账（web session）',
          description: '需要 bob_web_session，会从当前登录用户扣减并给目标用户加币。',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              to_userid: { type: 'string' },
              amount: { type: 'integer', minimum: 1 },
              await_notify: { type: 'boolean' },
            },
            required: ['to_userid', 'amount'],
          }, {
            to_userid: 'u002',
            amount: 10,
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }, { badRequest: true }),
        },
      },

      '/ledger/grant': {
        post: {
          tags: ['台账'],
          summary: '单个发币（bob_token）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              bob_token: { type: 'string' },
              userid: { type: 'string' },
              amount: { type: 'integer', minimum: 1 },
              reason: { type: 'string' },
              refId: { type: 'string' },
              await_notify: { type: 'boolean' },
            },
            required: ['bob_token', 'userid', 'amount'],
          }, {
            bob_token: '<BOB_TOKEN>',
            userid: 'u001',
            amount: 10,
            reason: 'admin_grant',
            refId: 'batch_20260310',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未授权（缺少或无效 bob_token）'),
          }, { badRequest: true }),
        },
      },

      '/ledger/grant-batch': {
        post: {
          tags: ['台账'],
          summary: '批量发币（bob_token）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              bob_token: { type: 'string' },
              userids: { type: 'array', items: { type: 'string' } },
              amount: { type: 'integer', minimum: 1 },
              reason: { type: 'string' },
              refId: { type: 'string' },
              await_notify: { type: 'boolean' },
            },
            required: ['bob_token', 'userids', 'amount'],
          }, {
            bob_token: '<BOB_TOKEN>',
            userids: ['u001', 'u002'],
            amount: 10,
            reason: 'admin_grant',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未授权（缺少或无效 bob_token）'),
          }, { badRequest: true }),
        },
      },

      '/ledger/deduct': {
        post: {
          tags: ['台账'],
          summary: '单个扣币（bob_token）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              bob_token: { type: 'string' },
              userid: { type: 'string' },
              amount: { type: 'integer', minimum: 1, description: '对应 bob_amount' },
              product_name: { type: 'string' },
              exchange_id: { type: 'string' },
              await_notify: { type: 'boolean' },
            },
            required: ['bob_token', 'userid', 'amount', 'product_name'],
          }, {
            bob_token: '<BOB_TOKEN>',
            userid: 'u001',
            amount: 10,
            product_name: '咖啡券',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未授权（缺少或无效 bob_token）'),
          }, { badRequest: true }),
        },
      },

      '/ledger/deduct-batch': {
        post: {
          tags: ['台账'],
          summary: '批量扣币（bob_token）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              bob_token: { type: 'string' },
              userids: { type: 'array', items: { type: 'string' } },
              amount: { type: 'integer', minimum: 1, description: '对应 bob_amount' },
              product_name: { type: 'string' },
              exchange_id: { type: 'string', description: '批次 exchange_id 前缀' },
              await_notify: { type: 'boolean' },
            },
            required: ['bob_token', 'userids', 'amount', 'product_name'],
          }, {
            bob_token: '<BOB_TOKEN>',
            userids: ['u001', 'u002'],
            amount: 5,
            product_name: '活动扣减',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未授权（缺少或无效 bob_token）'),
          }, { badRequest: true }),
        },
      },

      '/exchange/qr': {
        post: {
          tags: ['兑换'],
          summary: '生成签名核销二维码数据（bob_token）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              bob_token: { type: 'string' },
              exchange_id: { type: 'string' },
              userid: { type: 'string' },
              product_id: { type: 'string' },
              product_name: { type: 'string' },
              bob_amount: { type: 'integer', minimum: 1 },
            },
            required: ['bob_token', 'userid', 'product_id', 'bob_amount'],
          }, {
            bob_token: '<BOB_TOKEN>',
            userid: 'u001',
            product_id: 'P01',
            product_name: '咖啡券',
            bob_amount: 10,
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未授权（缺少或无效 bob_token）'),
          }, { badRequest: true }),
        },
      },

      '/redeem/confirm': {
        post: {
          tags: ['核销'],
          summary: '按 encoded 核销确认（bob_token）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              bob_token: { type: 'string' },
              encoded: { type: 'string' },
              await_notify: { type: 'boolean' },
            },
            required: ['bob_token', 'encoded'],
          }, {
            bob_token: '<BOB_TOKEN>',
            encoded: '<ENCODED_PAYLOAD>',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未授权（缺少或无效 bob_token）'),
          }, { badRequest: true }),
        },
      },

      '/redeem': {
        get: {
          tags: ['核销'],
          summary: '按用户查询核销记录',
          parameters: [
            qp('userid', '用户 userid', { required: true, example: 'u001' }),
            qp('page', '页码', { type: 'integer', minimum: 1, defaultValue: 1 }),
            qp('page_size', '每页条数', { type: 'integer', minimum: 1, defaultValue: 20 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { badRequest: true }),
        },
      },

      '/mall/red-packet/screen': {
        get: {
          tags: ['商城'],
          summary: '红包大屏数据（公开）',
          parameters: [
            qp('limit', '最近领取记录条数', { type: 'integer', minimum: 1, maximum: 50, defaultValue: 12 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }),
        },
      },

      '/mall/me': {
        get: {
          tags: ['商城'],
          summary: '获取当前登录用户信息（web session）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/users': {
        get: {
          tags: ['商城'],
          summary: '按关键字搜索用户（web session）',
          parameters: [
            qp('keyword', '搜索关键字（姓名或 userid）', { required: false, example: '张' }),
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 20, defaultValue: 8 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/rich-board': {
        get: {
          tags: ['商城'],
          summary: '财富排行榜（web session）',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 100, defaultValue: 50 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/popular-products': {
        get: {
          tags: ['商城'],
          summary: '热门商品排行（web session）',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 50, defaultValue: 20 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/more/faq': {
        get: {
          tags: ['商城'],
          summary: '更多-FAQ（web session）',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 100, defaultValue: 50 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/more/announcements': {
        get: {
          tags: ['商城'],
          summary: '更多-公告（web session）',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 50, defaultValue: 20 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/more/version': {
        get: {
          tags: ['商城'],
          summary: '更多-版本信息（web session）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/more/stats': {
        get: {
          tags: ['商城'],
          summary: '更多-我的统计（web session）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/more/feedback/mine': {
        get: {
          tags: ['商城'],
          summary: '更多-我的反馈列表（web session）',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 100, defaultValue: 20 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/more/feedback': {
        post: {
          tags: ['商城'],
          summary: '更多-提交反馈（web session）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              category: { type: 'string', enum: ['suggestion', 'bug', 'question', 'rule', 'other'] },
              content: { type: 'string', minLength: 1, maxLength: 2000 },
              contact: { type: 'string' },
            },
            required: ['content'],
          }, {
            category: 'suggestion',
            content: '建议增加兑换筛选',
            contact: 'ding_userid_xxx',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true, id: 1 }),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }, { badRequest: true }),
        },
      },

      '/mall/red-packet/status': {
        get: {
          tags: ['商城'],
          summary: '红包活动状态（web session）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/red-packet/claim': {
        post: {
          tags: ['商城'],
          summary: '抢红包（web session）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              await_notify: { type: 'boolean' },
            },
          }, {
            await_notify: false,
          }, false),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
            '429': errorResponse('并发冲突，请稍后重试'),
          }, { badRequest: true }),
        },
      },

      '/mall/opening': {
        get: {
          tags: ['商城'],
          summary: '获取商城开关与排期（web session）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/easter/unlock': {
        post: {
          tags: ['商城'],
          summary: '商城关闭时申请彩蛋购买 token（web session）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }, { badRequest: true }),
        },
      },

      '/mall/ledger': {
        get: {
          tags: ['商城'],
          summary: '当前用户积分流水（web session）',
          parameters: [
            qp('page', '页码', { type: 'integer', minimum: 1, defaultValue: 1 }),
            qp('pageSize', '每页条数', { type: 'integer', minimum: 1, maximum: 50, defaultValue: 20 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/products': {
        get: {
          tags: ['商城'],
          summary: '商城商品列表（web session）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/products/version': {
        get: {
          tags: ['商城'],
          summary: '商城商品版本信息（web session）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/orders': {
        get: {
          tags: ['商城'],
          summary: '我的商城订单（web session）',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 200, defaultValue: 50 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
          }),
        },
      },

      '/mall/buy': {
        post: {
          tags: ['商城'],
          summary: '下单购买（web session）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              product_id: { type: 'string' },
              easter_token: { type: 'string' },
              omit_qr: { type: 'boolean' },
              await_notify: { type: 'boolean' },
            },
            required: ['product_id'],
          }, {
            product_id: 'P01',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未登录（缺少或无效 web session）'),
            '403': errorResponse('商城关闭，且未通过彩蛋解锁'),
          }, { badRequest: true }),
        },
      },

      '/mall/buy-api': {
        post: {
          tags: ['商城'],
          summary: '代下单接口（bob_token）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              bob_token: { type: 'string' },
              userid: { type: 'string' },
              name: { type: 'string' },
              product_id: { type: 'string' },
              exchange_id: { type: 'string' },
              await_notify: { type: 'boolean' },
            },
            required: ['bob_token', 'userid', 'product_id'],
          }, {
            bob_token: '<BOB_TOKEN>',
            userid: 'u001',
            product_id: 'P01',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
            '401': errorResponse('未授权（缺少或无效 bob_token）'),
          }, { badRequest: true }),
        },
      },

      '/bob-token/list': {
        get: {
          tags: ['Token'],
          summary: '列出 BOB Token（管理员会话）',
          parameters: [
            qp('includeRevoked', '是否包含已吊销 Token', { type: 'string', example: 'true' }),
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 500, defaultValue: 200 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/bob-token/create': {
        post: {
          tags: ['Token'],
          summary: '创建 BOB Token（管理员会话）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true, token: '...', tokenId: 1 }),
          }, { unauthorized: true }),
        },
      },

      '/bob-token/revoke': {
        post: {
          tags: ['Token'],
          summary: '吊销 BOB Token（管理员会话）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              tokenId: { type: 'integer', minimum: 1 },
            },
            required: ['tokenId'],
          }, { tokenId: 1 }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true }),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/bob-token/delete': {
        post: {
          tags: ['Token'],
          summary: '删除 BOB Token（管理员会话，仅允许删除已吊销）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              tokenId: { type: 'integer', minimum: 1 },
            },
            required: ['tokenId'],
          }, { tokenId: 1 }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true }),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/me': {
        get: {
          tags: ['管理端'],
          summary: '获取当前管理员会话信息',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true, name: '管理员', userid: 'u_admin' }),
            '401': errorResponse('未登录或会话无效'),
          }),
        },
      },

      '/admin/login': {
        post: {
          tags: ['管理端'],
          summary: '密码登录后台',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              username: { type: 'string' },
              password: { type: 'string' },
            },
            required: ['username', 'password'],
          }, {
            username: 'admin',
            password: '******',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true, name: '管理员' }),
            '401': errorResponse('账号或密码错误'),
          }, { badRequest: true }),
        },
      },

      '/admin/logout': {
        post: {
          tags: ['管理端'],
          summary: '退出后台登录',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true }),
          }),
        },
      },

      '/admin/config': {
        get: {
          tags: ['管理端'],
          summary: '获取后台钉钉 JSAPI 配置',
          parameters: [
            qp('url', '当前页面 URL（完整 URL）', { required: true, example: 'https://example.com/admin/home' }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { badRequest: true }),
        },
      },

      '/admin/auth': {
        get: {
          tags: ['管理端'],
          summary: '钉钉免登后台并建立管理员会话',
          parameters: [
            qp('code', '钉钉授权码', { required: true, example: 'auth_code_xxx' }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true, name: '管理员' }),
            '403': errorResponse('非管理员账号'),
          }, { badRequest: true }),
        },
      },

      '/admin/users/sync': {
        post: {
          tags: ['管理端'],
          summary: '同步钉钉组织用户到本地',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/users': {
        get: {
          tags: ['管理端'],
          summary: '后台用户列表',
          parameters: [
            qp('keyword', '关键字（userid/name）'),
            qp('page', '页码', { type: 'integer', minimum: 1, defaultValue: 1 }),
            qp('pageSize', '每页条数', { type: 'integer', minimum: 1, maximum: 100, defaultValue: 30 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/users/set-admin': {
        post: {
          tags: ['管理端'],
          summary: '设置/取消管理员',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              userid: { type: 'string' },
              isAdmin: { type: 'boolean' },
            },
            required: ['userid', 'isAdmin'],
          }, {
            userid: 'u001',
            isAdmin: true,
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true }),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/users/delete': {
        post: {
          tags: ['管理端'],
          summary: '批量删除用户',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              userids: { type: 'array', items: { type: 'string' } },
            },
            required: ['userids'],
          }, {
            userids: ['u001', 'u002'],
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true, deleted: 2 }),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/users/notify': {
        post: {
          tags: ['管理端'],
          summary: '批量发送钉钉私聊通知',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              userids: { type: 'array', items: { type: 'string' } },
              title: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['userids'],
          }, {
            userids: ['u001', 'u002'],
            title: '系统通知',
            content: '本周五有活动',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/data/reset-user': {
        post: {
          tags: ['管理端'],
          summary: '重置单个用户数据（流水/兑换/余额）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              userid: { type: 'string' },
            },
            required: ['userid'],
          }, {
            userid: 'u001',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true }),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/data/reset-all': {
        post: {
          tags: ['管理端'],
          summary: '重置全量业务数据（流水/兑换/余额）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              confirm: { type: 'string', enum: ['RESET_ALL'] },
            },
            required: ['confirm'],
          }, {
            confirm: 'RESET_ALL',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true }),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/ledger/grant-batch': {
        post: {
          tags: ['管理端'],
          summary: '后台批量发币',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              userids: { type: 'array', items: { type: 'string' } },
              amount: { type: 'integer', minimum: 1 },
              reason: { type: 'string' },
              refId: { type: 'string' },
            },
            required: ['userids', 'amount'],
          }, {
            userids: ['u001', 'u002'],
            amount: 20,
            reason: 'manual_grant',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/redeem/confirm': {
        post: {
          tags: ['管理端'],
          summary: '后台按 encoded 核销',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              encoded: { type: 'string' },
            },
            required: ['encoded'],
          }, {
            encoded: '<ENCODED_PAYLOAD>',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/redeem/deduct-batch': {
        post: {
          tags: ['管理端'],
          summary: '后台批量扣币',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              userids: { type: 'array', items: { type: 'string' } },
              amount: { type: 'integer', minimum: 1 },
              product_name: { type: 'string' },
            },
            required: ['userids', 'amount', 'product_name'],
          }, {
            userids: ['u001', 'u002'],
            amount: 5,
            product_name: '活动扣减',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/redeem/history': {
        get: {
          tags: ['管理端'],
          summary: '后台核销历史（已核销）',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 200, defaultValue: 80 }),
            qp('cursor', '分页游标，格式：timestamp|exchange_id'),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/redeem/pending': {
        get: {
          tags: ['管理端'],
          summary: '后台待核销列表',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 200, defaultValue: 80 }),
            qp('cursor', '分页游标，格式：timestamp|exchange_id'),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/redeem/history/clear': {
        post: {
          tags: ['管理端'],
          summary: '清空核销历史（逻辑隐藏）',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              confirm: { type: 'string', enum: ['CLEAR_REDEEM_HISTORY'] },
            },
            required: ['confirm'],
          }, {
            confirm: 'CLEAR_REDEEM_HISTORY',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true, cleared: 12 }),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/logs': {
        get: {
          tags: ['管理端'],
          summary: '审计日志查询',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 500, defaultValue: 100 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/content/faq': {
        get: {
          tags: ['管理端'],
          summary: 'FAQ 列表（后台）',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 300, defaultValue: 120 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/content/faq/save': {
        post: {
          tags: ['管理端'],
          summary: '创建/更新 FAQ',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer' },
              question: { type: 'string' },
              answer: { type: 'string' },
              sort: { type: 'integer' },
              is_enabled: { type: 'string', description: "兼容 true/false 或 1/0 字符串" },
            },
            required: ['question', 'answer'],
          }, {
            question: '如何获得 BOB 币？',
            answer: '通过发币或活动获取。',
            sort: 0,
            is_enabled: 1,
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/content/faq/delete': {
        post: {
          tags: ['管理端'],
          summary: '删除 FAQ',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer', minimum: 1 },
            },
            required: ['id'],
          }, { id: 1 }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true }),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/content/announcements': {
        get: {
          tags: ['管理端'],
          summary: '公告列表（后台）',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 200, defaultValue: 80 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/content/announcements/save': {
        post: {
          tags: ['管理端'],
          summary: '创建/更新公告',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer' },
              title: { type: 'string' },
              content: { type: 'string' },
              level: { type: 'string', enum: ['info', 'success', 'warning', 'danger'] },
              sort: { type: 'integer' },
              is_enabled: { type: 'string', description: "兼容 true/false 或 1/0 字符串" },
              publish_at: { type: 'integer' },
            },
            required: ['title', 'content'],
          }, {
            title: '系统维护通知',
            content: '今晚 23:00 维护',
            level: 'warning',
            is_enabled: 1,
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/content/announcements/delete': {
        post: {
          tags: ['管理端'],
          summary: '删除公告',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer', minimum: 1 },
            },
            required: ['id'],
          }, { id: 1 }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true }),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/content/feedback': {
        get: {
          tags: ['管理端'],
          summary: '反馈列表（后台）',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 300, defaultValue: 120 }),
            qp('status', '状态过滤', { enumValues: ['pending', 'processing', 'resolved', 'rejected'] }),
            qp('keyword', '关键字（userid/name/content）'),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/content/feedback/handle': {
        post: {
          tags: ['管理端'],
          summary: '处理反馈',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer', minimum: 1 },
              status: { type: 'string', enum: ['pending', 'processing', 'resolved', 'rejected'] },
              reply: { type: 'string' },
            },
            required: ['id'],
          }, {
            id: 1,
            status: 'resolved',
            reply: '已修复',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/content/version': {
        get: {
          tags: ['管理端'],
          summary: '版本列表（后台）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/content/version/save': {
        post: {
          tags: ['管理端'],
          summary: '创建/更新版本信息',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer' },
              version_name: { type: 'string' },
              release_notes: { type: 'string' },
              is_enabled: { type: 'string', description: "兼容 true/false 或 1/0 字符串" },
              publish_at: { type: 'integer' },
            },
            required: ['version_name'],
          }, {
            version_name: 'v26.3.3',
            release_notes: '修复若干问题',
            is_enabled: 1,
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/settings/notify': {
        get: {
          tags: ['管理端'],
          summary: '读取通知模板设置',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
        post: {
          tags: ['管理端'],
          summary: '保存通知模板设置',
          requestBody: requestJson(REF_GENERIC, {
            enabled: true,
            templates: {},
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/settings/notify/test': {
        post: {
          tags: ['管理端'],
          summary: '发送通知模板测试消息',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              userid: { type: 'string' },
              name: { type: 'string' },
              event: { type: 'string' },
            },
            required: ['event'],
          }, {
            userid: 'u001',
            event: 'grant',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/settings/group-card': {
        get: {
          tags: ['管理端'],
          summary: '读取群卡模板设置',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
        post: {
          tags: ['管理端'],
          summary: '保存群卡模板设置',
          requestBody: requestJson(REF_GENERIC, {
            enabled: true,
            templates: {},
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/settings/group-card/test': {
        post: {
          tags: ['管理端'],
          summary: '发送群卡测试消息',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              event: { type: 'string' },
            },
          }, {
            event: 'manual',
          }, false),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true }),
          }, { unauthorized: true }),
        },
      },

      '/admin/settings/attendance-reward': {
        get: {
          tags: ['管理端'],
          summary: '读取打卡奖励设置',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
        post: {
          tags: ['管理端'],
          summary: '保存打卡奖励设置',
          requestBody: requestJson(REF_GENERIC, {
            enabled: false,
            rewardMin: 1,
            rewardMax: 5,
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/notify/group-card': {
        post: {
          tags: ['管理端'],
          summary: '发送自定义群卡通知',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              markdown: { type: 'string' },
              outTrackId: { type: 'string' },
              imageUrl: { type: 'string' },
              buttons: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
            },
          }, {
            title: '系统通知',
            markdown: '这是一条群卡消息',
          }, false),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/mall/opening': {
        get: {
          tags: ['管理端'],
          summary: '读取商城开关与自动排期',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
        post: {
          tags: ['管理端'],
          summary: '保存商城开关与自动排期',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              auto_enabled: { type: 'boolean' },
              next_open_at: { type: 'integer' },
              interval_minutes: { type: 'integer', minimum: 1 },
              open_duration_minutes: { type: 'integer', minimum: 1 },
              remind_before_seconds: { type: 'integer', minimum: 0 },
              close_remind_seconds: { type: 'integer', minimum: 0 },
            },
          }, {
            auto_enabled: true,
            next_open_at: 1760000000,
            interval_minutes: 1440,
            open_duration_minutes: 60,
          }, false),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/mall/opening/open-now': {
        post: {
          tags: ['管理端'],
          summary: '立即开启商城',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/mall/opening/close-now': {
        post: {
          tags: ['管理端'],
          summary: '立即关闭商城',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/mall/self/products': {
        get: {
          tags: ['管理端'],
          summary: '后台商品列表（全量）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
        post: {
          tags: ['管理端'],
          summary: '创建/更新商品',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              product_id: { type: 'string' },
              product_name: { type: 'string' },
              bob_amount: { type: 'integer', minimum: 1 },
              stock: { type: 'integer', minimum: 0 },
              limit_per_user: { type: 'integer', minimum: 0 },
              status: { type: 'string', enum: ['on', 'off'] },
              sort: { type: 'integer' },
              image_url: { type: 'string' },
              remark: { type: 'string' },
              publish_to_group: { type: 'boolean' },
            },
            required: ['product_id', 'product_name', 'bob_amount'],
          }, {
            product_id: 'P01',
            product_name: '咖啡券',
            bob_amount: 10,
            stock: 100,
            status: 'on',
            publish_to_group: true,
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/mall/self/products/delete': {
        post: {
          tags: ['管理端'],
          summary: '删除商品',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              product_id: { type: 'string' },
            },
            required: ['product_id'],
          }, {
            product_id: 'P01',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true, deleted: 'P01' }),
          }, { unauthorized: true, badRequest: true, notFound: true }),
        },
      },

      '/admin/mall/self/products/limit-round': {
        post: {
          tags: ['管理端'],
          summary: '开启商品新一轮限购',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              product_id: { type: 'string' },
            },
            required: ['product_id'],
          }, {
            product_id: 'P01',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true, notFound: true }),
        },
      },

      '/admin/mall/aitable/products': {
        get: {
          tags: ['管理端'],
          summary: '从 AI Table 拉取商品清单',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/red-packet/status': {
        get: {
          tags: ['管理端'],
          summary: '红包活动当前状态（后台）',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/red-packet/start': {
        post: {
          tags: ['管理端'],
          summary: '创建红包活动',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              total_amount: { type: 'integer', minimum: 1 },
              total_count: { type: 'integer', minimum: 1 },
              countdown_seconds: { type: 'integer', minimum: 0 },
              duration_minutes: { type: 'integer', minimum: 1 },
              sponsor: { type: 'string' },
            },
            required: ['total_amount', 'total_count', 'countdown_seconds', 'duration_minutes'],
          }, {
            total_amount: 100,
            total_count: 20,
            countdown_seconds: 60,
            duration_minutes: 10,
            sponsor: '运营部',
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },

      '/admin/red-packet/history': {
        get: {
          tags: ['管理端'],
          summary: '红包活动历史（后台）',
          parameters: [
            qp('limit', '返回条数上限', { type: 'integer', minimum: 1, maximum: 100, defaultValue: 30 }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/red-packet/history/clear': {
        post: {
          tags: ['管理端'],
          summary: '清空红包活动历史',
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC, { ok: true }),
          }, { unauthorized: true }),
        },
      },

      '/admin/red-packet/history/delete': {
        post: {
          tags: ['管理端'],
          summary: '删除指定红包活动',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              activity_id: { type: 'integer', minimum: 1 },
            },
            required: ['activity_id'],
          }, {
            activity_id: 1,
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true, notFound: true }),
        },
      },

      '/admin/backup/export': {
        get: {
          tags: ['管理端'],
          summary: '导出备份 JSON',
          parameters: [
            qp('mode', '导出模式', { enumValues: ['settings', 'full'], defaultValue: 'settings' }),
          ],
          responses: withCommonErrors({
            '200': successResponse('成功（下载 JSON）', REF_GENERIC),
          }, { unauthorized: true }),
        },
      },

      '/admin/backup/import': {
        post: {
          tags: ['管理端'],
          summary: '导入备份 JSON',
          requestBody: requestJson({
            type: 'object',
            additionalProperties: false,
            properties: {
              backup: { type: 'object', additionalProperties: true },
              mode: { type: 'string', enum: ['merge', 'overwrite'] },
            },
            required: ['backup'],
          }, {
            mode: 'merge',
            backup: {
              _meta: { version: 1, mode: 'settings' },
              data: {},
            },
          }),
          responses: withCommonErrors({
            '200': successResponse('成功', REF_GENERIC),
          }, { unauthorized: true, badRequest: true }),
        },
      },
    },
    components: {
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
    },
  };
}
