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
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    },
    ErrorResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
        access_state_url: { type: 'string', description: '需要处理公告时的访问状态查询地址' },
      },
      required: ['error'],
    },
    OkResponse: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    },
    GalaErrorResponse: {
      type: 'object',
      additionalProperties: false,
      description: '年会接口的业务错误。部分 409 错误附带公开的数值字段，方便前端提示。',
      properties: {
        error: { type: 'string' },
        remaining: { type: 'integer', description: 'pool_budget_insufficient：员工奖池按已分配额计算的剩余额度' },
        required: { type: 'integer', description: 'pool_budget_insufficient：本轮需要的额度（单价 × 抽签人数）' },
        allocated: { type: 'integer', description: 'budget_below_allocated：奖池预算不能低于的已分配额' },
        spent: { type: 'integer', description: 'budget_below_spent：预留奖池实际支出（仅超级管理员接口）' },
        min_budget: { type: 'integer', description: 'budget_below_spent：预留奖池最低可设预算 = 实际支出 + 已抽中待发的预留奖励（仅超级管理员接口）' },
        next_round_no: { type: 'integer', description: 'round_no_changed：本环节下一轮的轮次号' },
        pools_total: { type: 'integer' },
        max_draw_count: { type: 'integer', description: 'not_enough_participants：按公开规则本轮最多可抽人数' },
      },
      required: ['error'],
    },
    OkDataObjectResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        data: {
          type: 'object',
          nullable: true,
          additionalProperties: true,
          description: '业务对象（允许扩展字段）',
        },
      },
      required: ['ok', 'data'],
    },
    OkDataArrayResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        data: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['ok', 'data'],
    },
    OkDataWithServerTimeResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        data: { nullable: true },
        server_time: { type: 'integer' },
      },
      required: ['ok', 'server_time'],
    },
    OkCountsResponse: {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "counts": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "required": [
        "ok",
        "counts"
      ]
    },
    AdminResetAllResponse: {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "protected_admins": {
          "type": "integer"
        },
        "counts": {
          "type": "object",
          "additionalProperties": true
        },
        "targets": {
          "type": "integer"
        }
      },
      "required": [
        "ok",
        "protected_admins",
        "counts",
        "targets"
      ]
    },
    AdminDeleteUsersResponse: {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "deleted": {
          "type": "integer"
        },
        "counts": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "required": [
        "ok",
        "deleted"
      ]
    },
    AdminUsersSyncResponse: {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "deptCount": {
          "type": "integer"
        },
        "active": {
          "type": "integer"
        },
        "upserted": {
          "type": "integer"
        }
      },
      "required": [
        "ok",
        "deptCount",
        "active",
        "upserted"
      ]
    },
    AdminNotifyBatchResponse: {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "count": {
          "type": "integer"
        },
        "success_count": {
          "type": "integer"
        },
        "failed_count": {
          "type": "integer"
        },
        "error": {
          "type": "string"
        },
        "results": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        }
      },
      "required": [
        "ok",
        "count",
        "success_count",
        "failed_count",
        "results"
      ]
    },
    OkResultResponse: {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "result": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "required": [
        "ok",
        "result"
      ]
    },
    OkConnectedDataResponse: {
      type: 'object',
      additionalProperties: false,
      description: '连接状态 + 配置 {ok, connected, error, data}',
      properties: {
        ok: { type: 'boolean' },
        connected: { type: 'boolean' },
        error: { type: 'string' },
        data: {
          type: 'object',
          nullable: true,
          additionalProperties: true,
        },
      },
      required: ['ok', 'connected', 'data'],
    },
    OkDaysDataResponse: {
      type: 'object',
      additionalProperties: false,
      description: '按天数汇总列表 {ok, days, data}',
      properties: {
        ok: { type: 'boolean' },
        days: { type: 'integer' },
        data: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['ok', 'days', 'data'],
    },
    OkNotifyResponse: {
      type: 'object',
      additionalProperties: false,
      description: '通知测试成功 {ok, notify}',
      properties: {
        ok: { type: 'boolean' },
        notify: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'notify'],
    },
    AdminRedPacketStatusResponse: {
      type: 'object',
      additionalProperties: false,
      description: '后台红包状态 {ok, data, claimed_count?, server_time}',
      properties: {
        ok: { type: 'boolean' },
        data: { nullable: true, description: '活动对象或 null' },
        claimed_count: { type: 'integer' },
        server_time: { type: 'integer' },
      },
      required: ['ok', 'server_time'],
    },
    OkClearedResponse: {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "cleared": {
          "type": "integer"
        }
      },
      "required": [
        "ok",
        "cleared"
      ]
    },
    OkDeletedActivityResponse: {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "deleted": {
          "type": "integer"
        },
        "activity_id": {
          "type": "integer"
        }
      },
      "required": [
        "ok",
        "deleted",
        "activity_id"
      ]
    },
    RuntimeResultResponse: {
      "type": "object",
      "additionalProperties": true,
      "description": "处理函数直接返回的结果对象（顶层字段随业务变化，但必须是 JSON 对象）",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      }
    },
// 兼容旧名：明确 data 只能是 object|array|null，顶层禁止额外字段
    OkDataResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        data: {
          nullable: true,
          description: '业务数据：对象或数组',
          oneOf: [
            { type: 'object', additionalProperties: true },
            { type: 'array', items: { type: 'object', additionalProperties: true } },
          ],
        },
      },
      required: ['ok', 'data'],
    },
    OkCountDataResponse: {
      type: 'object',
      additionalProperties: false,
      description: '仅用于返回 {ok,count,data} 的列表接口',
      properties: {
        ok: { type: 'boolean' },
        count: { type: 'integer' },
        data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok', 'count', 'data'],
    },
    OkLimitCountDataResponse: {
      type: 'object',
      additionalProperties: false,
      description: '返回 {ok,limit,count,data}',
      properties: {
        ok: { type: 'boolean' },
        limit: { type: 'integer' },
        count: { type: 'integer' },
        data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok', 'limit', 'count', 'data'],
    },
    PagedListResponse: {
      type: 'object',
      additionalProperties: false,
      description: '分页列表 {ok,page,pageSize,total,data}',
      properties: {
        ok: { type: 'boolean' },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
        total: { type: 'integer' },
        data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok', 'page', 'pageSize', 'total', 'data'],
    },
    AuditLogsResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        days: { type: 'integer' },
        limit: { type: 'integer', nullable: true },
        data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok', 'days', 'data'],
    },
    AdminOperationsResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        days: { type: 'integer' },
        limit: { type: 'integer' },
        scope: { type: 'string' },
        actors: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              userid: { type: 'string' },
              name: { type: 'string' },
            },
            required: ['userid'],
          },
        },
        data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok', 'data'],
    },
    AdminDashboardSummaryResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        data: {
          type: 'object',
          additionalProperties: false,
          properties: {
            users: { type: 'integer' },
            balanceTotal: { type: 'integer' },
            pendingOrders: { type: 'integer' },
            fulfilledOrders: { type: 'integer' },
            activeProducts: { type: 'integer' },
            unusedCdks: { type: 'integer' },
            charityTotal: { type: 'integer' },
            dingtalk: { type: 'object', additionalProperties: true },
          },
          required: ['users', 'balanceTotal', 'pendingOrders', 'fulfilledOrders', 'activeProducts', 'unusedCdks', 'charityTotal'],
        },
      },
      required: ['ok', 'data'],
    },
    CharityContributionsResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        project_id: { type: 'string', nullable: true },
        limit: { type: 'integer' },
        summary: { type: 'object', additionalProperties: true },
        data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok', 'data'],
    },
    CdkGenerateResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        batch_id: { type: 'string' },
        product_id: { type: 'string' },
        product_name: { type: 'string' },
        quantity: { type: 'integer' },
        codes: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'batch_id', 'product_id', 'quantity', 'codes'],
    },
    CdkDeleteResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        changes: { type: 'integer' },
      },
      required: ['ok', 'changes'],
    },
    OkCountResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        count: { type: 'integer' },
      },
      required: ['ok', 'count'],
    },
    RedPacketHistoryResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        data: { type: 'array', items: { type: 'object', additionalProperties: true } },
        server_time: { type: 'integer' },
      },
      required: ['ok'],
    },
    AttendanceDetailResponse: {
      type: 'object',
      additionalProperties: false,
      description: '打卡奖励某日明细 {ok, work_date, rows}',
      properties: {
        ok: { type: 'boolean' },
        work_date: { type: 'string' },
        rows: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['ok', 'work_date', 'rows'],
    },
    OkIdResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        id: { type: 'integer' },
      },
      required: ['ok', 'id'],
    },
    OkDeletedResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        deleted: { type: 'integer' },
      },
      required: ['ok'],
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
    GrantResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        userid: { type: 'string' },
        balance: { type: 'integer' },
        ledgerId: { type: 'integer' },
        notify: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'userid', 'balance'],
    },
    DeductResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        userid: { type: 'string' },
        balance: { type: 'integer' },
        exchange_id: { type: 'string' },
        notify: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'userid', 'balance'],
    },
    RedeemConfirmResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        userid: { type: 'string' },
        balance: { type: 'integer' },
        exchange_id: { type: 'string' },
      },
      required: ['ok'],
    },
    TransferResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        transfer_id: { type: 'string' },
        from_userid: { type: 'string' },
        to_userid: { type: 'string' },
        from_balance: { type: 'integer' },
        to_balance: { type: 'integer' },
      },
      required: ['ok', 'from_userid', 'to_userid', 'from_balance', 'to_balance'],
    },
    BatchResultResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', description: '是否全部成功' },
        count: { type: 'integer', description: '处理条数' },
        results: {
          type: 'array',
          items: { $ref: '#/components/schemas/BatchItemResult' },
        },
      },
      required: ['ok', 'count', 'results'],
    },
    BatchItemResult: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        userid: { type: 'string' },
        balance: { type: 'integer' },
        ledgerId: { type: 'integer' },
        exchange_id: { type: 'string' },
        error: { type: 'string' },
        notify: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'userid'],
    },
    LedgerRecord: {
      type: 'object',
      additionalProperties: true,
      properties: {
        id: { type: 'integer' },
        userid: { type: 'string' },
        delta: { type: 'integer', description: '变动值，正为收入、负为支出' },
        reason: { type: 'string' },
        ref_id: { type: 'string', nullable: true },
        created_at: { type: 'integer' },
        display_reason: { type: 'string' },
        peer_userid: { type: 'string' },
        peer_name: { type: 'string' },
        product_name: { type: 'string' },
      },
      required: ['id', 'userid', 'delta'],
    },
    LedgerRecordsResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        userid: { type: 'string' },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
        data: { type: 'array', items: { $ref: '#/components/schemas/LedgerRecord' } },
      },
      required: ['userid', 'page', 'pageSize', 'data'],
    },
    MallLedgerResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        userid: { type: 'string' },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
        data: { type: 'array', items: { $ref: '#/components/schemas/LedgerRecord' } },
      },
      required: ['ok', 'userid', 'page', 'pageSize', 'data'],
    },
    RedeemRecord: {
      type: 'object',
      additionalProperties: true,
      properties: {
        exchange_id: { type: 'string' },
        userid: { type: 'string' },
        product_id: { type: 'string' },
        product_name: { type: 'string' },
        bob_amount: { type: 'integer' },
        fulfilled_at: { type: 'integer', nullable: true },
        created_at: { type: 'integer' },
      },
      required: ['exchange_id', 'userid'],
    },
    RedeemListResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        userid: { type: 'string' },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
        data: { type: 'array', items: { $ref: '#/components/schemas/RedeemRecord' } },
      },
      required: ['userid', 'page', 'pageSize', 'data'],
    },
    SiteStatusResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        data: {
          type: 'object',
          additionalProperties: true,
          properties: {
            site_enabled: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
      required: ['ok', 'data'],
    },
    WebUserResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        userid: { type: 'string' },
        name: { type: 'string' },
        avatar: { type: 'string' },
      },
      required: ['userid'],
    },
    AdminExternalPurgeResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        batch_id: { type: 'string' },
        deleted: { type: 'integer', description: '被删除的外部账号数量' },
        counts: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'batch_id', 'deleted', 'counts'],
    },
    ExtAuthLoginRequest: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phone: { type: 'string', description: '大陆手机号，容忍空格/连字符/+86 前缀', example: '13800000000' },
        password: { type: 'string', description: '注册时设置的密码（允许弱口令，连续 5 次失败锁定 10 分钟）' },
      },
      required: ['phone', 'password'],
    },
    ExtAuthRegisterRequest: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 20, description: '真实姓名，用于现场核销核对' },
        phone: { type: 'string', description: '手机号，作为唯一登录账号；已绑定钉钉在册员工时引导使用钉钉登录' },
        password: { type: 'string', minLength: 3, maxLength: 64 },
        consent: { type: 'boolean', enum: [true], description: '必须显式同意个人信息收集告知' },
      },
      required: ['name', 'phone', 'password', 'consent'],
    },
    ExtAuthSessionResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        userid: { type: 'string', description: '外部账号 userid，前缀 ext_' },
        name: { type: 'string' },
      },
      required: ['ok', 'userid'],
    },
    ExtAuthStatusResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        register_enabled: { type: 'boolean', description: '后台是否开放外部自助注册（默认关闭）' },
        site_enabled: { type: 'boolean' },
        message: { type: 'string', description: '注册关闭时的提示文案' },
        site_message: { type: 'string', description: '站点维护提示文案' },
      },
      required: ['ok', 'register_enabled', 'site_enabled'],
    },
    WebAuthResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        userid: { type: 'string' },
        name: { type: 'string' },
        avatar: { type: 'string' },
      },
      required: ['userid'],
    },
    JsapiConfigResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        agentId: {},
        corpId: { type: 'string' },
        timeStamp: {},
        nonceStr: { type: 'string' },
        signature: { type: 'string' },
      },
    },
    UsersListResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
        total: { type: 'integer' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              userid: { type: 'string' },
              name: { type: 'string' },
              is_admin: {},
              created_at: {},
              balance: { type: 'integer' },
              updated_at: {},
            },
            required: ['userid'],
          },
        },
      },
      required: ['ok', 'page', 'pageSize', 'total', 'data'],
    },
    QrEncodeResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        encoded: { type: 'string' },
        data: { type: 'object', additionalProperties: true },
        qr_image_url: { type: 'string' },
      },
      required: ['encoded', 'data', 'qr_image_url'],
    },
    BobTokenListResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer' },
              created_at: { type: 'integer' },
              revoked_at: { type: 'integer', nullable: true },
              status: { type: 'string', enum: ['active', 'revoked'] },
            },
            required: ['id', 'status'],
          },
        },
      },
      required: ['ok', 'data'],
    },
    BobTokenCreateResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        token: { type: 'string', description: '明文仅创建时返回一次' },
        tokenId: { type: 'integer', nullable: true },
      },
      required: ['ok', 'token'],
    },
    MallMeResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        userid: { type: 'string' },
        name: { type: 'string' },
        balance: { type: 'integer' },
      },
      required: ['ok', 'userid', 'balance'],
    },
    MallProductsResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        count: { type: 'integer' },
        version: { type: 'string' },
        data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok', 'count', 'version', 'data'],
    },
    MallProductsVersionResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        count: { type: 'integer' },
        version: { type: 'string' },
        server_time: { type: 'integer' },
      },
      required: ['ok', 'count', 'version', 'server_time'],
    },
    MallOrdersResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        limit: { type: 'integer' },
        data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok', 'limit', 'data'],
    },
    MallBuyResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        exchange_id: { type: 'string' },
        userid: { type: 'string' },
        product_id: { type: 'string' },
        product_name: { type: 'string' },
        bob_amount: { type: 'integer' },
        balance: { type: 'integer' },
        encoded: { type: 'string', nullable: true },
        qr_image_url: { type: 'string', nullable: true },
      },
    },
    MallStatsResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        balance: { type: 'integer' },
        order_count: { type: 'integer' },
        pending_count: { type: 'integer' },
      },
      required: ['ok'],
    },
    MallOpeningResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        data: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'data'],
    },
    MallEasterUnlockResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        expires_at: { type: 'integer' },
        token: { type: 'string' },
      },
      required: ['ok', 'expires_at', 'token'],
    },
    MallFeedbackCreateResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        id: { type: 'integer' },
      },
      required: ['ok', 'id'],
    },
    MallRedPacketStatusResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        data: { nullable: true },
        server_time: { type: 'integer' },
      },
      required: ['ok'],
    },
    MallRedPacketClaimResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        amount: { type: 'integer' },
        balance: { type: 'integer' },
      },
      required: ['ok'],
    },
    AuctionActivity: {
      type: 'object',
      additionalProperties: true,
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        description: { type: 'string' },
        image_url: { type: 'string' },
        start_price: { type: 'integer', minimum: 1 },
        min_increment: { type: 'integer', minimum: 1 },
        start_at: { type: 'integer', description: 'Unix 秒' },
        end_at: { type: 'integer', description: 'Unix 秒' },
        anti_snipe_seconds: { type: 'integer', minimum: 0, maximum: 600 },
        status: { type: 'string', enum: ['scheduled', 'active', 'settled', 'cancelled'] },
        effective_status: { type: 'string', enum: ['scheduled', 'active', 'settling', 'settled', 'cancelled'] },
        current_price: { type: 'integer', nullable: true },
        current_bidder_name: { type: 'string', description: '员工端仅下发展示名，不含 userid（current_bid_userid / winner_userid 仅管理端返回）' },
        bid_count: { type: 'integer' },
        winner_name: { type: 'string' },
        final_price: { type: 'integer', nullable: true },
        seconds_remaining: { type: 'integer' },
        next_bid_floor: { type: 'integer' },
      },
      required: ['id', 'title', 'start_price', 'min_increment', 'start_at', 'end_at', 'status', 'effective_status'],
    },
    AuctionBidRecord: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'integer' },
        display_name: { type: 'string' },
        amount: { type: 'integer' },
        state: { type: 'string', enum: ['held', 'refunded', 'won'] },
        created_at: { type: 'integer' },
      },
      required: ['id', 'amount', 'state', 'created_at'],
    },
    MallAuctionListResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        data: { type: 'array', items: { $ref: '#/components/schemas/AuctionActivity' } },
        server_time: { type: 'integer' },
        server_time_ms: { type: 'integer' },
      },
      required: ['ok', 'data'],
    },
    MallAuctionDetailResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        data: { allOf: [{ $ref: '#/components/schemas/AuctionActivity' }] },
        my_bid: { nullable: true },
        server_time: { type: 'integer' },
        server_time_ms: { type: 'integer' },
      },
      required: ['ok', 'data'],
    },
    MallAuctionBidResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        activity_id: { type: 'integer' },
        bid_id: { type: 'integer' },
        amount: { type: 'integer' },
        balance: { type: 'integer' },
        end_at: { type: 'integer' },
      },
      required: ['ok', 'activity_id', 'bid_id', 'amount', 'balance'],
    },
    AdminAuctionCreateRequest: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', maxLength: 80 },
        description: { type: 'string', maxLength: 2000 },
        image_url: { type: 'string', maxLength: 500 },
        start_price: { type: 'integer', minimum: 1 },
        min_increment: { type: 'integer', minimum: 1 },
        start_at: { type: 'integer', description: 'Unix 秒' },
        end_at: { type: 'integer', description: 'Unix 秒' },
        anti_snipe_seconds: { type: 'integer', minimum: 0, maximum: 600, default: 0 },
      },
      required: ['title', 'start_price', 'min_increment', 'start_at', 'end_at'],
    },
    AnnouncementItem: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        content: { type: 'string' },
        level: { type: 'string', enum: ['info', 'success', 'warning', 'danger'] },
        sort: { type: 'integer' },
        show_fullscreen: { type: 'integer', enum: [0, 1] },
        requires_acknowledgement: { type: 'integer', enum: [0, 1] },
        revision: { type: 'integer', minimum: 1 },
        content_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        publish_at: { type: 'integer', nullable: true },
        updated_at: { type: 'integer' },
      },
      required: ['id', 'title', 'content', 'show_fullscreen', 'requires_acknowledgement', 'revision', 'content_hash'],
    },
    AdminAnnouncementItem: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        content: { type: 'string' },
        level: { type: 'string', enum: ['info', 'success', 'warning', 'danger'] },
        sort: { type: 'integer' },
        is_enabled: { type: 'integer', enum: [0, 1] },
        publish_at: { type: 'integer', nullable: true },
        show_fullscreen: { type: 'integer', enum: [0, 1] },
        requires_acknowledgement: { type: 'integer', enum: [0, 1] },
        revision: { type: 'integer', minimum: 1 },
        content_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        edit_version: { type: 'integer', minimum: 1 },
        created_at: { type: 'integer' },
        updated_at: { type: 'integer' },
      },
      required: [
        'id', 'title', 'content', 'level', 'sort', 'is_enabled', 'publish_at',
        'show_fullscreen', 'requires_acknowledgement', 'revision', 'content_hash',
        'edit_version', 'created_at', 'updated_at',
      ],
    },
    AdminAnnouncementListResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        count: { type: 'integer', minimum: 0 },
        data: {
          type: 'array',
          items: { $ref: '#/components/schemas/AdminAnnouncementItem' },
        },
      },
      required: ['ok', 'count', 'data'],
    },
    MallAnnouncementAccessStateResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        blocked: { type: 'boolean' },
        pending: { type: 'array', items: { $ref: '#/components/schemas/AnnouncementItem' } },
        next_check_at: { type: 'integer', nullable: true },
        server_time: { type: 'integer' },
      },
      required: ['ok', 'blocked', 'pending', 'next_check_at', 'server_time'],
    },
    AnnouncementAcknowledgement: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'integer' },
        revision: { type: 'integer', minimum: 1 },
        content_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        action: { type: 'string', enum: ['acknowledged', 'dismissed'] },
      },
      required: ['id', 'revision', 'content_hash', 'action'],
    },
    MallAnnouncementAcknowledgeResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        blocked: { type: 'boolean' },
        pending: { type: 'array', items: { $ref: '#/components/schemas/AnnouncementItem' } },
        next_check_at: { type: 'integer', nullable: true },
        server_time: { type: 'integer' },
        acknowledgement: { $ref: '#/components/schemas/AnnouncementAcknowledgement' },
      },
      required: ['ok', 'blocked', 'pending', 'next_check_at', 'server_time', 'acknowledgement'],
    },
    AdminAnnouncementSaveResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        id: { type: 'integer' },
        revision: { type: 'integer', minimum: 1 },
        content_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        edit_version: { type: 'integer', minimum: 1 },
      },
      required: ['ok', 'id', 'revision', 'content_hash', 'edit_version'],
    },
    AnnouncementConflictResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        error: { type: 'string' },
        current: {
          type: 'object',
          nullable: true,
          additionalProperties: false,
          properties: {
            revision: { type: 'integer', minimum: 1 },
            content_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            edit_version: { type: 'integer', minimum: 1 },
          },
        },
      },
      required: ['error'],
    },
    AnnouncementAccessErrorResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        error: { type: 'string', enum: ['announcement_access_unavailable'] },
        message: { type: 'string' },
        detail: { type: 'string' },
      },
      required: ['error', 'message'],
    },
    MallMarketListingsResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        market_open: { type: 'boolean' },
        data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok', 'market_open', 'data'],
    },
    MallMarketMineResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        listings: { type: 'array', items: { type: 'object', additionalProperties: true } },
        orders: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok'],
    },
    MallMarketListResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        data: { type: 'object', additionalProperties: true },
      },
      required: ['ok', 'data'],
    },
    MallMarketCancelResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        listing_id: { type: 'string' },
      },
      required: ['ok', 'listing_id'],
    },
    MallMarketBuyResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        listing_id: { type: 'string' },
        exchange_id: { type: 'string' },
        price: { type: 'integer' },
        from_balance: { type: 'integer' },
        to_balance: { type: 'integer' },
      },
      required: ['ok', 'listing_id', 'exchange_id'],
    },
    AdminMeResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        name: { type: 'string' },
        userid: { type: 'string' },
        mode: { type: 'string' },
        isSuperAdmin: { type: 'boolean' },
        role: { type: 'object', nullable: true, additionalProperties: true },
        permissions: { type: 'array', items: { type: 'string' } },
      },
      required: ['ok', 'userid', 'name', 'isSuperAdmin', 'permissions'],
    },
    AdminAuthResponse: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        name: { type: 'string' },
      },
      required: ['ok'],
    },
    CursorListResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        limit: { type: 'integer' },
        cursor: { type: 'string', nullable: true },
        nextCursor: { type: 'string', nullable: true },
        hasMore: { type: 'boolean' },
        data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['ok', 'data'],
    },
    AdminBackupExportResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        _meta: {
          type: 'object',
          additionalProperties: false,
          properties: {
            version: { type: 'integer', enum: [2] },
            mode: { type: 'string', enum: ['settings', 'full'] },
            filename: { type: 'string' },
            exportedAt: { type: 'string', format: 'date-time' },
            tables: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
            secretsRedacted: { type: 'boolean', enum: [true] },
          },
          required: ['version', 'mode', 'filename', 'exportedAt', 'tables', 'secretsRedacted'],
        },
        data: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      required: ['_meta', 'data'],
    },
    AdminBackupImportResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        mode: { type: 'string', enum: ['merge', 'overwrite'] },
        backupMode: { type: 'string', enum: ['settings', 'full'] },
        report: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
        recoveryPoint: {
          type: 'object',
          nullable: true,
          additionalProperties: false,
          properties: {
            filename: { type: 'string' },
            size: { type: 'integer', minimum: 0 },
            mode: { type: 'string', enum: ['settings', 'full'] },
            tables: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
          },
          required: ['filename', 'size', 'mode', 'tables'],
        },
      },
      required: ['ok', 'mode', 'backupMode', 'report', 'recoveryPoint'],
    },
    OpenApiDocument: {
      type: 'object',
      additionalProperties: true,
      description: 'OpenAPI 3 文档对象',
      properties: {
        openapi: { type: 'string' },
        info: { type: 'object', additionalProperties: true },
        paths: { type: 'object', additionalProperties: true },
        components: { type: 'object', additionalProperties: true },
      },
      required: ['openapi', 'info', 'paths'],
    },
    // 兼容旧引用：不再作为成功响应首选
    DataResponse: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        data: { description: '业务数据', nullable: true },
      },
      required: ['ok'],
      description: '兼容旧名；新文档请使用 OkDataResponse / OkCountDataResponse 等',
    },
    FlexibleObject: {
      type: 'object',
      additionalProperties: true,
      description: '可选 JSON 请求体',
    },
    GenericObject: {
      type: 'object',
      additionalProperties: true,
      description: '已弃用占位；成功响应不应再引用',
    },
  },
  parameters: {
    XBobTokenHeader: {
      name: 'X-BOB-Token',
      in: 'header',
      required: false,
      description: '内部 API 鉴权 Token。优先于 body.bob_token；禁止放在 query。',
      schema: { type: 'string' },
    },
  },
  securitySchemes: {
    BobTokenHeader: {
      type: 'apiKey',
      in: 'header',
      name: 'X-BOB-Token',
      description: 'BOB 内部 API Token',
    },
    AdminSessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: 'bob_admin_session',
    },
    WebSessionCookie: {
      type: 'apiKey',
      in: 'cookie',
      name: 'bob_web_session',
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
