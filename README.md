# BOB 币发行与管理中心

企业内部积分（BOB 币）的发行、流通与运营平台。面向钉钉组织内的员工提供移动端积分门户，面向运营与管理人员提供权限分级的 Web 管理后台。

生产环境：`https://b.achord.cn`

## 目录

- [功能范围](#功能范围)
- [技术栈](#技术栈)
- [系统架构](#系统架构)
- [环境要求](#环境要求)
- [本地开发](#本地开发)
- [配置项](#配置项)
- [数据库](#数据库)
- [质量校验](#质量校验)
- [接口文档](#接口文档)
- [部署](#部署)
- [运维手册](#运维手册)
- [安全基线](#安全基线)

## 功能范围

### 员工端（移动端 H5，钉钉免登）

| 模块 | 说明 |
| --- | --- |
| 余额与流水 | 账户余额、积分收支明细、账户间转账 |
| 商城兑换 | 商品浏览、库存与限购轮次控制、下单、CDK 兑换 |
| 交易市场 | 已购订单挂牌转让、购买他人挂牌 |
| 限时竞拍 | 竞拍大厅实时价格与倒计时、出价冻结与被超出自动退回、竞得自动生成核销二维码订单、我的竞拍与在押金额 |
| 红包活动 | 倒计时、抢红包、领取记录 |
| 大富翁榜 | 余额排行榜 |
| 公益助力 | 公益项目集资、分档助力 |
| 更多 | 公告、FAQ、个人数据、版本信息、反馈工单（支持多轮对话） |

### 对外活动账号（浏览器 / 微信内打开）

面向公司外部人员（现场活动、校企活动等）的自助注册通道，入口 `/login`（商城在未登录且非钉钉环境时会跳转到这里）。外部用户用「真实姓名 + 手机号 + 密码」注册，注册后与钉钉员工共用同一套商城、竞拍、红包、公益与核销能力。

- 手机号是唯一登录标识（`users.phone` 唯一索引），姓名仅用于展示与现场核销核对。当前不做短信验证，手机号唯一不代表已验证归属，也不能保证一人一号；密码允许弱口令，请配合现场核验、注册开关、失败锁定与活动后清理使用。
- 手机号命中钉钉**在册**员工（`user_dingtalk_profiles.active = 1`）时不会重复建号，页面直接引导其使用钉钉登录；离职员工不再受此限制，可正常注册外部账号。
- 外部账号 `userid` 以 `ext_` 开头，与钉钉 userid 命名空间隔离，后台可按「来源」筛选与整批清理。
- 部分隔离：外部账号与钉钉员工互不可见、互不可转——转账搜索 `/mall/users` 按会话来源对称过滤（员工只搜到员工，外部用户只搜到外部用户），转账接口服务端拒绝任一方为外部账号的跨来源转账（403 `transfer_not_allowed_between_sources`），外部账号之间可互转；大富翁榜 `/mall/rich-board`不收录外部账号，外部用户访问时返回空；其余商城、下单、竞拍、红包照常。
- 公益榜、竞拍出价与得主、二手市场、红包大屏会如实展示外部用户姓名，注册页的告知文案已如实说明。
- 外部用户没有钉钉：机器人通知统一在 `sendOrQueueNotify` 入口跳过（返回 `skipped`），后台批量发消息对其计入「跳过」而非失败，订单状态与核销码以页面展示为准；打卡补偿、通讯录同步也都排除外部账号。
- 外部账号不能被设为管理员或分配后台角色（后端拒绝，取消角色仍允许）。
- 账号运维：后台用户详情的「外部账号」页签可重置密码（同时清除失败计数与锁定）、禁用/启用账号（禁用后现有会话立即失效）；商城「更多 → 我的数据」对外部用户提供「退出登录」。当前没有用户自助改密/找回密码，现场忘记密码请工作人员在后台重置。

### 管理端（Web 后台，权限分级）

| 模块 | 说明 |
| --- | --- |
| 首页概览 | 关键指标汇总 |
| 用户与账户 | 用户查询、发币/扣币、批量操作、角色分配 |
| 订单与核销 | 订单查询、扫码核销、核销历史 |
| 商城与 CDK | 商品 CRUD、图片编辑、限购轮次、CDK 批量生成 |
| 活动与公益 | 红包活动编排、限时竞拍管理、商城开放时段调度、公益项目管理 |
| 年会 | 年会活动与环节启停、奖池预算、参与名单、服务端抽签、幂等发币；预留名额仅超级管理员可见（`/admin/gala/*`） |
| 消息中心 | 钉钉机器人通知、群卡片推送配置 |
| 内容运营 | 公告、FAQ、版本记录、反馈工单处理 |
| 系统集成 | 钉钉连接配置、打卡奖励规则、数据备份导入导出 |
| 审计安全 | 操作审计日志查询 |

### 自动化任务

| 任务 | 触发方式 | 说明 |
| --- | --- | --- |
| 打卡奖励 | 钉钉 Stream 长连接接收 `attendance_check_record` 事件 | 满足规则的上班打卡自动发币并推送通知 |
| 打卡奖励对账 | 内置定时调度 | 补发漏发奖励，幂等，不会重复发币或重复推送 |
| 商城开放调度 | 内置定时调度 | 按配置周期自动开放/关闭商城，含开关前提醒推送 |
| 竞拍结算调度 | 内置定时调度 | 到期竞拍自动结算并通知获胜者、生成领取订单（核销二维码）；结算幂等，读请求保留兜底触发 |

## 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Node.js 20（生产基线 20.19.0），ES Module |
| 服务端 | Express 4 |
| 数据库 | PostgreSQL 16+（唯一支持的数据库） |
| 管理端前端 | React 19 + Ant Design 5 + Ant Design ProComponents，Vite 构建 |
| 员工端前端 | 原生 HTML / CSS / JavaScript |
| 实时推送 | Server-Sent Events (SSE) |
| 组织集成 | 钉钉开放平台（免登、机器人通知、群卡片、Stream 事件订阅） |
| 接口文档 | OpenAPI 3 + Swagger UI |

项目不依赖 Redis。限流为进程内内存实现，多实例部署时各进程独立计数，外层需由反向代理补充连接与请求限制。

## 系统架构

### 请求链路

```text
客户端
  ↓
反向代理（Nginx，HTTPS 终止，certbot 证书）
  ↓
Express 应用（src/app.js）
  ├─ JSON 解析：默认 1MB，备份导入与图片上传放宽至 50MB
  ├─ 分路径限流：登录 / 二维码 / 反馈 / 转账 / SSE
  ├─ 审计日志：/admin 全量 + 所有非 GET 请求
  ├─ 会话校验：requireWebSession / requireAdminSession / requireBobToken
  └─ 路由层 → 服务层 → 数据访问层（PostgreSQL 连接池）
```

### 分层职责

| 目录 | 职责 |
| --- | --- |
| `src/routes/` | HTTP 路由与参数校验。`mall.js` 为员工端全部接口，`admin/` 按领域拆分为 index / shared / content / settings / backup |
| `src/routes/openapi/` | 各路由对应的 OpenAPI 描述，由 `npm run check:openapi` 强制与实际路由保持一致 |
| `src/services/` | 业务逻辑与外部集成，包含账本、商城、红包、CDK、公益、核销、打卡奖励、钉钉、通知、审计等 |
| `src/middleware/` | 会话校验、限流、站点开关等横切关注点 |
| `src/db/` | 建表、增量迁移与数据库适配层 |
| `src/pages/` | 员工端页面与静态资源，以及管理端构建产物 |
| `src/admin-app/` | 管理端 React 源码，构建输出到 `src/pages/admin-app-dist/` |

### 数据库适配层

`src/db/init.js` 中的 `PgDb` 提供统一的 `get / all / run / exec / transaction` 接口，并在执行前将 SQL 归一化：`?` 占位符转换为 `$n`、`INSERT OR IGNORE` 转换为 `ON CONFLICT DO NOTHING`、`unixepoch()` 转换为 PostgreSQL 时间表达式。

**编写新查询时统一使用 `?` 占位符**，不要直接写 `$1`，以保持与适配层一致。

### 并发与一致性设计

以下机制均有对应测试或数据库约束保障，修改相关代码时需保持不变式：

| 场景 | 保障手段 |
| --- | --- |
| 账户扣减 | 单语句 `UPDATE ... WHERE balance >= ? RETURNING`，避免读后写超扣 |
| 账户间转账 | 按 userid 字典序 `FOR UPDATE` 加锁，避免双向并发死锁 |
| 红包领取 | 部分唯一索引 `(activity_id, claimed_by) WHERE claimed_by IS NOT NULL`，保证一人一次 |
| 商城挂牌 | 部分唯一索引 `(exchange_id) WHERE status = 'active'`，保证同一订单仅一个有效挂牌 |
| 限时竞拍 | 活动行 `FOR UPDATE` 串行化出价；出价即冻结（条件更新防超扣），被超出原额退回；部分唯一索引 `(activity_id) WHERE state = 'held'` 保证每场竞拍至多一条在押出价；结算为惰性条件更新，天然幂等且服务重启安全 |
| 打卡奖励 | 唯一约束 `(userid, work_date, check_time_ms)`，保证同一次打卡不重复发币 |

### 目录结构

```text
src/
  index.js              服务启动入口：载入配置、初始化数据库、恢复会话版本
  app.js                Express 应用装配：中间件、路由挂载、后台任务拉起
  config.js             环境变量读取与生产环境必填校验
  db/                   建表、增量迁移、PostgreSQL 适配层
  middleware/           会话校验、限流、站点开关
  routes/               路由层
  routes/openapi/       OpenAPI 描述
  services/             业务逻辑与外部集成
  utils/                客户端 IP、二维码、HTML 净化、会话加解密
  docs/                 Swagger 规范组装
  pages/                员工端页面与静态资源
  admin-app/            管理端 React 源码
scripts/                质量校验、部署、数据库隧道、内部压测与对账脚本
test/security/          安全与并发单元测试
```

## 环境要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | >= 20 | 生产与 CI 基线为 20.19.0。本地可使用更高主版本，行为差异以 CI 结果为准 |
| PostgreSQL | 16+ | 必需 |
| npm | 与 Node.js 配套 | 依赖锁定使用 `package-lock.json`，CI 通过 `npm ci` 安装 |

## 本地开发

### 1. 安装依赖

```bash
npm install
```

### 2. 准备环境变量

从团队安全渠道获取 `.env` 并放置于项目根目录，或以 `.env.example` 为模板填写。`.env` 已被 `.gitignore` 排除，禁止提交。

本地开发使用本机 PostgreSQL 容器，**不要连接生产数据库**。`.env` 中与开发环境相关的取值：

```bash
NODE_ENV=development
SERVER_BASE_URL=http://127.0.0.1:8000
COOKIE_SECURE=false
TRUST_PROXY=false

PG_HOST=127.0.0.1
PG_PORT=5432

# 清空钉钉凭据，避免本地调试向真实组织发送消息
DINGTALK_APP_KEY=
DINGTALK_APP_SECRET=
DINGTALK_ROBOT_NOTIFY_ENABLED=false
DINGTALK_GROUP_CARD_NOTIFY_ENABLED=0
```

会话密钥（`ADMIN_SESSION_SECRET`、`WEB_SESSION_SECRET`、`QR_SIGN_SECRET`）应使用本地独立随机值，与生产不同，使本地签发的会话在生产端验签必然失败：

```bash
openssl rand -hex 24
```

### 3. 启动本地数据库

```bash
docker compose up -d postgres
```

容器为 PostgreSQL 16（与生产同大版本），监听 `127.0.0.1:5432`，密码由 `POSTGRES_PASSWORD` 指定，仅在数据卷首次初始化时生效。改密码需连带删除数据卷：`docker compose down -v postgres`。

首次需要真实数据时，从生产同步一份快照到本地：

```bash
npm run db:tunnel        # 另开终端保持隧道
PROD_PG_PASSWORD='<生产库密码>' npm run db:sync-from-prod
```

该脚本对生产库只执行 `pg_dump`（只读），写入仅落在本地 Compose 容器。执行前会确认当前 Docker endpoint 是本机 `unix://` socket，并核对 Compose service label、`bob.environment=development` label、loopback 端口绑定、目标数据库名及 PostgreSQL `bob.environment=development` GUC；任一身份无法证明时都会在连接生产库和执行本地恢复前拒绝操作。恢复时，`DROP SCHEMA public CASCADE`、重建 schema 和全部 restore SQL 由同一个 `psql` 事务执行；archive 解析或任一 SQL 失败都会回滚并保留同步前的本地数据库，也不会向 `PUBLIC` 授予 schema 创建权限。事务成功提交后才执行 `ANALYZE` 和行数核对，后两者不属于恢复事务，失败时不会自动撤销已经成功恢复的数据。

> **结构变更不随数据同步传播。** `src/db/init.js` 在服务启动时对所连接的数据库执行 DDL，因此本地新增的表或字段只有在代码经 git 推送并重启生产服务后才会到达生产端。所有 DDL 必须写成幂等语句（`CREATE TABLE IF NOT EXISTS`、`ADD COLUMN IF NOT EXISTS`），否则重复启动会失败。

### 4. 启动服务

```bash
npm start
```

服务监听 `.env` 中的 `PORT`（默认 8000）。启动时自动执行数据库初始化，日志输出到当前终端，`Ctrl+C` 停止。

临时使用其他端口：

```bash
PORT=8080 npm start
```

端口被占用时先确认占用者：

```bash
lsof -nP -iTCP:8000 -sTCP:LISTEN
```

### 5. 本地登录

员工端与管理端的登录均只有钉钉 OAuth 一条链路，清空钉钉凭据后本地无法完成授权往返。开发期用以下命令签发一张合法会话 Cookie，输出中包含可直接粘贴到浏览器控制台的语句与等价的 `curl` 命令：

本地 `start.sh` 会启用 `http://127.0.0.1:8000/__dev/login`，提供两个普通测试账号和一个本地管理员账号。选择账号后由服务端写入 HttpOnly 会话 Cookie，不请求钉钉授权。该入口默认关闭，仅在 `NODE_ENV=development`、本机数据库、本地 HTTP 地址、开发数据库标记和独立会话密钥全部通过校验时挂载。

手动启用需要在 `.env` 中同时配置（`start.sh` 已包含，但它不入库）：

```bash
LOCAL_DEV_AUTH_ENABLED=true
DEV_SESSION_DATABASE=bob   # 必须与 PG_DATABASE 完全相同
```

并确认本地数据库带有 `bob.environment=development` GUC 标记（Docker Compose 已配置，见 `docker-compose.yml` 的 `command` 参数）。任一条件缺失时 `/__dev/login` 不会挂载（访问返回 404，无其他提示），这是有意的 fail-closed 设计；排查时先逐项核对上述条件。

```bash
npm run dev:session -- admin
```

```bash
npm run dev:session -- web
```

该脚本不修改任何认证逻辑，直接调用项目自身的签名函数。仅允许在明确的 `NODE_ENV=development` 下使用，入口仅接受 loopback 地址或 HTTPS 的 `dev.b.achord.cn`。执行前必须将 `PG_DATABASE` 和 `DEV_SESSION_DATABASE` 显式设为同一个预期开发库名（Docker Compose 默认为 `bob`），并将 `SESSION_SALT` 与仅供本地使用的 `DEV_SESSION_SALT` 设为相同且不少于 32 个字符；`ADMIN_SESSION_SECRET` 和 `WEB_SESSION_SECRET` 也必须分别显式配置、不少于 32 个字符且互不相同。脚本会先以只读事务核对实际数据库名与 PostgreSQL `bob.environment=development` 标记，再从数据库刷新当前全局会话版本，全部通过后才允许查询用户并签发 Token。生产环境不要配置 `DEV_SESSION_SALT`。可追加 `userid` 参数指定用户。

### 6. 访问入口

| 入口 | 路径 | 说明 |
| --- | --- | --- |
| 员工端 | `/mall` | 移动端积分门户 |
| 大屏 | `/mall/screen` | 活动大屏展示 |
| 管理后台 | `/admin/home` | React 管理端 |
| 管理端登录 | `/admin/login` | 钉钉环境自动免登，普通浏览器手动登录 |
| 接口文档 | `/docs/` | 需管理员会话，未登录跳转登录页 |
| 健康检查 | `/health` | 返回 `{"ok":true}` |

### 管理端前端开发

管理端为独立的 Vite 应用。修改 `src/admin-app/` 下的源码后需重新构建，Express 才能提供更新后的产物：

```bash
npm run admin:build
```

开发期可启动带热更新的独立前端服务：

```bash
npm run admin:dev
```

构建产物目录 `src/pages/admin-app-dist/` 已被 `.gitignore` 排除，由部署脚本在本机构建后同步到服务器。

## 配置项

全部配置通过环境变量注入，由 `src/config.js` 统一读取。敏感值从团队安全渠道获取。

### 基础

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8000` | 服务监听端口 |
| `NODE_ENV` | 空 | 设为 `production` 时启用生产必填校验 |
| `SERVER_BASE_URL` | `http://127.0.0.1:$PORT` | 对外访问地址，用于通知链接与 OpenAPI server |
| `COOKIE_SECURE` | 自动判定 | 未显式配置时，`NODE_ENV=production` 或 `SERVER_BASE_URL` 为 HTTPS 即启用 |
| `TRUST_PROXY` | 自动判定 | 是否信任反向代理的 `X-Forwarded-For` |
| `SERVER_PUBLIC_IP` | 空 | 管理端系统信息展示用，未配置时回退自动解析 |
| `DNS_RESULT_ORDER` | `ipv4first` | 外部接口 DNS 地址优先级；钉钉 IP 白名单按 IPv4 配置时保持默认值，需要系统原始顺序时设为 `verbatim` |
| `LOCAL_DEV_AUTH_ENABLED` | `false` | 是否启用受限制的本地测试账号免登录入口。还需同时满足：`NODE_ENV=development`、`PG_HOST` 为回环地址、`DEV_SESSION_DATABASE` 与 `PG_DATABASE` 相同、数据库带 `bob.environment=development` GUC 标记、`SERVER_BASE_URL` 为本地 HTTP 地址、两把会话密钥均不少于 32 字符且互不相同。任一条件缺失时入口静默不挂载（fail-closed） |

### 数据库

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DB_KIND` | `postgres` | 仅支持 `postgres` |
| `PG_HOST` | `127.0.0.1` | 数据库地址 |
| `PG_PORT` | `5432` | 数据库端口，走隧道时为 `35432` |
| `PG_DATABASE` | `bob` | 数据库名 |
| `PG_USER` | `bob` | 数据库用户 |
| `PG_PASSWORD` | — | 数据库密码 |
| `PG_SSL` | `false` | 是否启用 SSL |
| `PG_POOL_MAX` | `20` | 连接池上限 |

### 安全与会话

| 变量 | 生产要求 | 说明 |
| --- | --- | --- |
| `ADMIN_USERIDS` | **必填** | 超级管理员 userid 列表，逗号分隔。生产未配置则启动失败，无内置默认超管 |
| `ADMIN_SESSION_SECRET` | **必填** | 管理端会话签名密钥 |
| `WEB_SESSION_SECRET` | **必填，且不得与上一项相同** | 员工端会话签名密钥。生产禁止回退到管理端密钥 |
| `QR_SIGN_SECRET` | 建议配置 | 核销二维码签名密钥 |
| `SESSION_SALT` | 空 | 会话轮换盐；运行 `dev:session` 时必须与 `DEV_SESSION_SALT` 相同且不少于 32 个字符 |
| `DEV_SESSION_SALT` | 生产不要配置 | 仅本地 `dev:session` 的开发环境见证，必须与本地 `SESSION_SALT` 相同 |
| `DEV_SESSION_DATABASE` | 生产不要配置 | 仅本地 `dev:session` 使用，必须与本地 `PG_DATABASE` 相同 |
| `ADMIN_FALLBACK_USERID` | 空 | 追加到超管名单的兜底 userid |
| `ADMIN_FALLBACK_NAME` | 空 | 兜底超管显示名 |

会话 Token 通过 `aud` 字段做域隔离，即使密钥被误配置为相同值，员工端 Token 也无法当作管理端凭证使用。

### 运行限制

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SSE_MAX_TOTAL` | `500` | SSE 全局最大连接数 |
| `SSE_MAX_PER_IP` | `20` | 单 IP 最大 SSE 连接数 |
| `AUDIT_LOG_RETENTION_DAYS` | `0` | 审计日志保留天数。`0` 或未配置表示不自动清理，避免历史证据丢失 |
| `BOB_BACKUP_DIR` | 项目父目录下 `bob-admin-backups` | 后台备份文件存储目录。默认置于项目外，避免被部署时的 `rsync --delete` 清除 |

接口限流为固定窗口（单位：次/分钟/IP）：登录 30、二维码 120、反馈提交 20、转账 30、SSE 连接 60。

外部活动账号单独限流：注册 60、登录 120。阈值宽于内部登录，因为活动现场 WiFi 与运营商 CGNAT 下大量用户共用同一个出口 IP，过严会误伤整场活动；针对单账号的暴力破解由「连续 5 次密码失败锁定 10 分钟」兜底。

转账、竞拍出价、实时推送（SSE）、反馈提交这类面向登录用户的限流按**账号**计数（只信任签名校验通过的会话 Cookie，不查库），未登录或会话无效时退回按 IP；这样会场几百人共用一个出口 IP 时不会互相误限，伪造 Cookie 也绕不过 IP 桶。阈值不变：转账 30、出价 60、实时推送 60、反馈 20（均为每账号每分钟）。

### 钉钉集成

| 变量 | 说明 |
| --- | --- |
| `DINGTALK_CORP_ID` | 企业 CorpId |
| `DINGTALK_APP_KEY` | 应用 AppKey |
| `DINGTALK_APP_SECRET` | 应用 AppSecret |
| `DINGTALK_AGENT_ID` | 应用 AgentId |
| `DINGTALK_ROBOT_CODE` | 机器人编码 |
| `DINGTALK_ROBOT_NOTIFY_ENABLED` | 是否启用机器人通知，默认启用 |
| `DINGTALK_STREAM_ENABLED` | 是否建立 Stream 长连接并运行打卡奖励对账，默认启用；仅测试 OAuth/通知时可设为 `false` |

`DINGTALK_APP_KEY` 与 `DINGTALK_APP_SECRET` 同时配置且 `DINGTALK_STREAM_ENABLED=true` 时才会建立 Stream 长连接并启用打卡奖励；缺失凭据或显式关闭时服务正常启动，仅跳过该能力并输出告警。

### 群卡片通知（可选）

`DINGTALK_GROUP_CARD_NOTIFY_ENABLED`、`DINGTALK_GROUP_OPEN_CONVERSATION_ID`、`DINGTALK_GROUP_CARD_TEMPLATE_ID`、`DINGTALK_GROUP_CARD_TITLE_KEY`、`DINGTALK_GROUP_CARD_CONTENT_KEY`、`DINGTALK_GROUP_CARD_BROADCAST_ALL`、`DINGTALK_GROUP_CARD_RECIPIENTS`、`DINGTALK_GROUP_CARD_OPERATOR_USERID`、`DINGTALK_GROUP_CARD_SEARCH_ICON`

多数项也可在管理后台「消息中心」中配置，数据库配置优先于环境变量。

### AI Table（可选）

`AI_TABLE_BASE_ID`、`AI_TABLE_SHEET_ID_OR_NAME`、`AI_TABLE_OPERATOR_ID`

用于从钉钉多维表同步商品数据。

## 数据库

### 初始化与迁移

服务启动时自动执行 `src/db/init.js`，完成建表、索引创建、增量列补充、外键补挂与初始数据写入。所有语句均为幂等形式（`CREATE TABLE IF NOT EXISTS`、`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 等），可重复执行。

项目未引入独立的迁移工具。**新增表或字段时，请在 `init.js` 中以幂等语句追加**，不要依赖手工执行的一次性 SQL。

### 主要数据表

| 表 | 用途 |
| --- | --- |
| `users` / `accounts` | 用户与账户余额 |
| `ledger` | 积分流水，所有余额变动的唯一凭证 |
| `redeems` | 兑换订单与核销状态 |
| `mall_products` / `mall_order_listings` | 商品与交易市场挂牌 |
| `mall_opening_schedule` | 商城开放时段调度状态 |
| `red_packet_activity` / `red_packet_items` | 红包活动与红包份额 |
| `auction_activities` / `auction_bids` | 限时竞拍活动与出价（在押/退回/竞得状态流转） |
| `redeem_cdks` | CDK 兑换码 |
| `charity_projects` / `charity_contributions` | 公益项目与助力记录 |
| `attendance_reward_records` | 打卡奖励发放记录，承担幂等去重职责 |
| `admin_roles` / `admin_user_roles` | 管理端角色与权限分配 |
| `audit_logs` | 操作审计日志 |
| `content_faq` / `content_announcements` / `system_versions` | 内容运营数据 |
| `user_feedback` / `user_feedback_messages` | 反馈工单与多轮对话 |
| `user_dingtalk_profiles` | 钉钉用户档案缓存 |
| `system_settings` | 运行期系统配置（键值） |
| `bob_tokens` | 对外接口 Token，仅存哈希 |

### 备份与恢复

推荐使用 PostgreSQL 官方工具。

导出：

```bash
pg_dump -h <host> -p <port> -U <user> -d <db> -Fc -f bob.dump
```

恢复：

```bash
pg_restore -h <host> -p <port> -U <user> -d <db> -c --if-exists bob.dump
```

遇版本不兼容时改用纯文本格式：

```bash
pg_dump -Fp -h <host> -p <port> -U <user> -d <db> -f bob.sql
```

```bash
psql -h <host> -p <port> -U <user> -d <db> < bob.sql
```

管理后台「系统集成」另提供业务级的设置项与全量数据导出导入，用于配置迁移与数据校对，不替代数据库物理备份。

## 质量校验

提交前请执行完整校验：

```bash
npm run check
```

该命令依次执行 lint、OpenAPI 覆盖率校验与测试。各项也可单独运行：

| 命令 | 检查内容 |
| --- | --- |
| `npm run lint` | 语法检查、生产依赖未锁定版本、残留备份文件、误跟踪的构建产物 |
| `npm run typecheck` | 对核心文件执行 `node --check` 语法校验 |
| `npm test` | 安全与并发单元测试，不依赖数据库 |
| `npm run test:security` | 仅运行 `test/security/` 下的测试 |
| `npm run check:openapi` | 校验 OpenAPI 描述与实际路由一一对应，缺失或多余均报错 |
| `npm run audit:prod` | 生产依赖高危漏洞审计 |

CI 在 push 到 `main` 及所有 Pull Request 上运行上述全部检查并构建管理端（`.github/workflows/ci.yml`）。

`scripts/` 下另有内部压测与核对脚本（红包并发、竞拍集成、打卡奖励核对等）。这些脚本会连接真实数据库，需通过显式的环境变量确认目标库后才会执行，使用前请先阅读脚本内的保护逻辑。

## 接口文档

Swagger UI 位于 `/docs/`，OpenAPI 规范位于 `/docs/openapi.json`，两者均要求有效的管理员会话。页面请求未通过校验时重定向至登录页，接口请求返回 401。

规范由 `src/routes/openapi/*.openapi.js` 中的描述组装。**新增或修改路由时必须同步更新对应的 OpenAPI 描述**，否则 `npm run check:openapi` 会失败。

## 部署

### 生产环境信息

| 项 | 值 |
| --- | --- |
| 域名 | `b.achord.cn`（Cloudflare DNS，仅 DNS 解析，不走代理） |
| 服务器 | 腾讯云香港轻量 `43.161.221.5`，Ubuntu 22.04，SSH 别名 `bob-hk`（用户 `ubuntu`，有 sudo） |
| 部署目录 | `/srv/bob/app`（属主 `bob`） |
| 运行方式 | systemd 服务 `bob.service`，以 `bob` 用户运行，只监听 `127.0.0.1:8000` |
| Node 版本 | `v20.19.0`（`/opt/node/bin/node`） |
| 反向代理 | Nginx `/etc/nginx/sites-available/b.achord.cn` → `127.0.0.1:8000`，certbot 自动续期 |
| 数据库 | 本机 PostgreSQL 16，库 `bob`，用户 `bob`，`127.0.0.1:5432` |
| 配置文件 | `/srv/bob/app/.env`（权限 600，不在 git 中） |
| 日志 | `/var/log/bob/app.log` |
| 数据库备份 | 每天 03:17 执行 `/usr/local/sbin/bob-backup.sh`，本机保留在 `/var/backups/bob`（14 天），另推一份到异地 |

本机 `~/.ssh/config` 需要有 `bob-hk` 别名：

```text
Host bob-hk
  HostName 43.161.221.5
  User ubuntu
  IdentityFile ~/.ssh/chordv_deploy
  IdentitiesOnly yes
```

### 标准发布流程

```text
本地开发 → 本地校验（npm run check）→ PR 合并到 main
  → 本机切到最新 main → 服务器备份数据库 → npm run deploy
```

合并到 `main` 只会触发 CI 校验，**不会自动部署**。发布由人在本机手动执行：

```bash
git switch main && git pull --ff-only
```

```bash
ssh bob-hk 'sudo /usr/local/sbin/bob-backup.sh'
```

```bash
DRY_RUN=1 npm run deploy
```

```bash
npm run deploy
```

`DRY_RUN=1` 只预览 rsync 将新增、修改、删除哪些文件，不改动应用目录、不重启服务。

### 部署脚本行为

`scripts/deploy.sh` 依次执行：

1. 检查工作区干净且 `HEAD` 等于 `origin/main`，否则拒绝部署（确需强制可设 `ALLOW_DIRTY=1`）。
2. 本机 `npm run build` 构建管理端，然后在服务器上获取部署锁 `/var/lock/bob-deploy.lock`（同一时间只允许一次部署，结束时自动释放；中断残留时脚本会提示清理命令）。
3. `rsync --delete` 以 `bob` 用户身份同步到 `/srv/bob/app`，排除 `.env`、`.env.*`、`.git/`、`node_modules/`、上传文件（`uploads/`）、日志与备份目录等运行期文件，这些文件不会被覆盖或删除。
4. 服务器只检查 `.env` 存在且已配置 `SERVER_BASE_URL`、`ADMIN_SESSION_SECRET`、`WEB_SESSION_SECRET`，不读取、不修改任何值。
5. `sudo -u bob npm ci --omit=dev`，然后 `sudo systemctl restart bob`。
6. 等待本机 `/health` 通过，检查重启后的日志出现 `[DingtalkStream] connected`，并列出重启后出现的 error 行。
7. 检查公网 `https://b.achord.cn/health` 返回 `{"ok":true}`，否则部署视为失败。

> 上传的图片位于 `src/pages/assets/uploads/`，部署时被排除；它不在数据库备份范围内，迁移或重建服务器时需单独拷贝。

### 开发辅助脚本

| 命令 | 作用 |
| --- | --- |
| `npm run db:tunnel` | SSH 隧道：本机 `127.0.0.1:35432` → `bob-hk` 的 `127.0.0.1:5432` |
| `npm run db:sync-from-prod` | 经隧道把生产库只读导出并恢复到本地 Compose 容器 |
| `npm run dev:tunnel` | SSH 反向隧道：`https://dev.b.achord.cn` → `bob-hk` 的 `127.0.0.1:18000` → 本机 `127.0.0.1:8000` |

## 运维手册

### 打卡奖励补发

打卡奖励的规则（生效日期、时间阈值、金额、适用部门等）在管理后台「活动运营」中配置。早于生效日期的实时事件和自动对账都会跳过，不发币、不发送通知。

自动对账由内置调度器执行。需要手动补发时，可在后台点击「对账并自动补发」，或调用接口：

```text
POST /admin/settings/attendance-reward/reconcile
```

请求体可选：

```json
{ "date": "YYYY-MM-DD", "notify": false }
```

`notify` 为 `false` 时仅补账不推送通知。补发逻辑幂等：同一次打卡（`userid` + `work_date` + `check_time_ms`）不会重复发币；已成功推送的通知不会重复发送，推送失败的会重试。

### 常见问题排查

| 现象 | 排查方向 |
| --- | --- |
| 商品列表加载缓慢 | 观察 `/mall/products` 与 `/mall/products/version` 响应耗时，检查商品缓存是否失效 |
| 抢红包期间响应变慢 | 关注数据库 CPU 与锁等待，红包领取为数据库约束保障的串行化操作 |
| 钉钉免登失败 | 核对 `DINGTALK_*` 配置，以及后台「系统集成」中的钉钉连接设置（数据库配置优先） |
| 打卡奖励未发放 | 确认 Stream 长连接已建立（缺少 appKey/appSecret 时会输出告警），再执行对账补发 |
| 管理端页面未更新 | 确认 `npm run admin:build` 已执行，或 CI 构建步骤是否成功 |
| 会话需要全局失效 | 递增 `system_settings` 中的 `session_global_version`。各实例按 2 秒节流自行刷新，约 2 秒内全量生效，服务重启不影响 |
| 备份文件丢失 | 检查 `BOB_BACKUP_DIR`，默认目录在项目之外以避免被部署清除 |

### 站点开关

管理后台提供站点启用开关。关闭后员工端业务接口返回 403 并展示维护提示页；站点状态查询失败时按 fail-closed 处理，返回 503。管理端不受该开关影响。

### 对外活动账号

开关与批次管理在管理后台「系统集成 → 系统设置 → 对外活动账号」。注册开关**默认关闭**，未显式打开时 `/web/ext/register` 一律返回 403，`/web/ext/status` 也只会返回未开放。

活动流程：

1. 活动前：设置「活动批次标识」（例如 `2026秋季校园行`）并打开注册开关；外部用户在 `/login` 自助注册，注册记录带上该批次。
2. 活动中：发币走后台「批量发币」或红包活动；核销按姓名 + 手机号现场核对（管理后台用户列表可直接看到外部账号手机号）。
3. 活动后：关闭注册开关（已注册用户仍可登录兑换），需要时在「对外活动账号」卡片按批次「清理批次」——删除该批次全部外部账号及其流水、订单、竞拍、公益记录。

注意：

- 清理不可恢复，**先导出**用户与订单数据留档；清理要求输入 `DELETE` 二次确认，且仅超级管理员（`ADMIN_USERIDS`）可执行。
- 关闭注册开关只影响注册，不影响登录；需要彻底停止服务时用站点开关。
- 密码采用 `node:crypto` 的 scrypt 加盐哈希存储，数据库中不保存明文；允许弱口令是产品取舍，请配合活动现场核验使用。

## 安全基线

- `.env` 包含敏感凭证，已被 `.gitignore` 排除，禁止提交到任何仓库
- 生产环境强制要求配置 `ADMIN_USERIDS`、`ADMIN_SESSION_SECRET`、`WEB_SESSION_SECRET`，且后两者不得相同，缺失或相同则启动失败
- 管理端权限采用「超管名单 + 角色权限点」两层模型。删除用户、删除商品、清空核销历史、导入备份等高危操作标记为 `superOnly`，普通角色无法获得
- 对外接口 Token 仅存储哈希值，历史明文已在启动迁移中清空
- 审计日志默认永久保留。`/admin` 全部请求与所有非 GET 请求均记录操作者、IP、路径与状态码
- 会话 Cookie 为 `HttpOnly` + `SameSite=Lax`，HTTPS 环境自动附加 `Secure`
- 对外活动账号：注册默认关闭（fail-closed），密码以 scrypt 加盐哈希存储，登录失败 5 次锁定 10 分钟；注册需显式勾选个人信息收集告知；外部账号手机号唯一，命中钉钉在册员工时不建号并引导钉钉登录
- 生产环境建议同时启用数据库定期备份与日志监控

## 版本记录

系统版本与更新说明维护在数据库 `system_versions` 表中，员工端「更多 → 版本信息」与管理后台「内容运营」均可查看。初始版本数据由 `src/db/init.js` 写入。


