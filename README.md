# BOB币发行与管理中心

这是一个面向移动端的 BOB 币积分系统，包含余额展示、商城兑换、红包活动、订单核销、排行榜与“更多”信息模块，同时提供管理后台用于商品、红包、公告、FAQ、版本等内容管理。近期已强化「打卡奖励」的幂等性与补发安全，避免重复发币/重复通知。

## 功能概览

- 余额与流水：余额展示、积分流水记录
- 商城兑换：商品列表、库存、限购、下单与订单核销
- 红包活动：倒计时、抢红包、领取记录
- 排行榜：大富翁榜单展示
- 更多：公告、FAQ、我的数据、版本信息、反馈
- 管理后台：商品管理、红包管理、公告/FAQ/反馈/版本管理、用户管理
- 钉钉免登：基于钉钉 Web 免登获取用户信息
- 打卡奖励：08:30（含）前的上班打卡可获奖励，支持自动/手动对账补发且不会重复发币

## 技术栈

- Node.js + Express
- PostgreSQL（当前唯一支持的数据库）
- Redis（可选，预留用于缓存/限流）
- 前端：原生 HTML/CSS/JS

## 运行要求

- Node.js 18+（建议 20+）
- PostgreSQL 16+（必需）
- Redis 7+（可选）

## 快速开始（本地开发）

1) 安装依赖
```bash
npm install
```

2) 准备本地 `.env`

从团队安全渠道取得 `.env`，不要提交到仓库。本地开发默认通过 SSH 隧道连接远程 PostgreSQL，数据库地址写成：

```bash
PG_HOST=127.0.0.1
PG_PORT=35432
```

3) 打开远程数据库隧道
```bash
npm run db:tunnel
```

保持这个终端不要关闭；结束开发时按 `Ctrl+C`。`npm run pg:up` 当前也是打开同一个隧道，不会在本机创建数据库。

4) 另开一个终端启动服务
```bash
npm start
```

服务默认监听 `PORT`（默认 8000）。

## 环境变量说明

以下为常用配置，实际值从团队安全渠道取得后写入本地 `.env`：

- `PORT`：服务端口
- `SERVER_BASE_URL`：对外访问地址（用于通知链接等）

### PostgreSQL
- `DB_KIND=postgres`
- `PG_HOST`：数据库地址
- `PG_PORT`：数据库端口
- `PG_DATABASE`：数据库名
- `PG_USER`：用户
- `PG_PASSWORD`：密码
- `PG_SSL`：是否启用 SSL（true/false）
- `PG_POOL_MAX`：连接池最大连接数

### 安全
- `QR_SIGN_SECRET`：二维码签名密钥
- `ADMIN_SESSION_SECRET` / `WEB_SESSION_SECRET`：会话密钥

### 钉钉
- `DINGTALK_CORP_ID`
- `DINGTALK_APP_KEY`
- `DINGTALK_APP_SECRET`
- `DINGTALK_AGENT_ID`
- `DINGTALK_ROBOT_CODE`
- `DINGTALK_ROBOT_NOTIFY_ENABLED`

### 群卡片通知（可选）
- `DINGTALK_GROUP_CARD_NOTIFY_ENABLED`
- `DINGTALK_GROUP_OPEN_CONVERSATION_ID`
- `DINGTALK_GROUP_CARD_TEMPLATE_ID`
- `DINGTALK_GROUP_CARD_TITLE_KEY`
- `DINGTALK_GROUP_CARD_CONTENT_KEY`
- `DINGTALK_GROUP_CARD_BROADCAST_ALL`
- `DINGTALK_GROUP_CARD_RECIPIENTS`
- `DINGTALK_GROUP_CARD_OPERATOR_USERID`
- `DINGTALK_GROUP_CARD_SEARCH_ICON`

### AI Table（可选）
- `AI_TABLE_BASE_ID`
- `AI_TABLE_SHEET_ID_OR_NAME`
- `AI_TABLE_OPERATOR_ID`

## 数据库初始化

启动服务时会自动执行数据库初始化（建表、索引等）。  
当前项目仅支持 PostgreSQL。

## 数据导入/导出

推荐使用 PG 官方工具：

导出：
```bash
pg_dump -h <host> -p <port> -U <user> -d <db> -Fc -f bob.dump
```

导入：
```bash
pg_restore -h <host> -p <port> -U <user> -d <db> -c --if-exists bob.dump
```

若遇到版本不兼容，可使用 plain SQL：
```bash
pg_dump -Fp -h <host> -p <port> -U <user> -d <db> -f bob.sql
psql -h <host> -p <port> -U <user> -d <db> < bob.sql
```

## 常用脚本

- 启动服务：`npm start`
- 打开远程 PostgreSQL 隧道：`npm run db:tunnel`
- 兼容旧习惯打开数据库隧道：`npm run pg:up`
- 关闭数据库隧道：在运行 `npm run db:tunnel` 或 `npm run pg:up` 的终端按 `Ctrl+C`
- 手动部署到宝塔：`npm run deploy:baota`
- 手动对账补发（管理员）：`POST /admin/settings/attendance-reward/reconcile`，可传 `{"date":"YYYY-MM-DD","notify":false}` 只补账不推送

## 项目结构

```
src/
  app.js                # Express 应用入口
  index.js              # 服务启动入口
  config.js             # 配置读取
  db/                   # 数据库初始化与适配
  routes/               # 路由层（mall/admin/等）
  services/             # 业务逻辑层（账本、兑换、红包、通知等）
  pages/                # 前端页面与静态资源
docs/                   # 文档与说明
```

## 开发与发布流程

当前项目使用 GitHub Actions 自动部署到宝塔 Node 项目，标准顺序是：

```text
本地开发 -> 本地测试 -> git commit -> git push origin main -> GitHub Actions -> 同步到宝塔 -> 宝塔重启 Node 项目 -> 健康检查
```

注意：`git commit` 只保存到本机仓库，不会更新生产环境；只有 `git push origin main` 推送到 GitHub 后，才会触发自动部署。

## 宝塔生产部署

- 生产域名：`bob.baymaxgroup.com`
- 宝塔项目名：`bob_points_center`
- 生产目录：`/www/wwwroot/bob.baymaxgroup.com`
- 服务端口：`8000`
- 部署 workflow：`.github/workflows/deploy-baota.yml`
- 部署脚本：`scripts/deploy-baota.sh`

部署脚本会通过 `rsync` 同步代码，但会保留服务器上的 `.env`、上传文件、日志、备份和 `node_modules` 等运行期文件。同步完成后，脚本使用宝塔 `nodejsModel` 重启项目，并检查本机 `/health` 与公网 `/health`。

## 手动部署

正常开发只需要推送 `main`，不需要手动部署。确实需要从本机直接同步服务器时，可运行：

```bash
npm run deploy:baota
```

手动部署同样不会上传 `.env`，服务器必须已经存在正确的 `.env`。

## 运维与排查建议

- 商品加载慢：优先观察接口 `/mall/products` 和 `/mall/products/version` 响应耗时
- 并发抢红包：数据库 CPU 与锁等待是关键指标
- 钉钉免登失败：检查 `DINGTALK_*` 相关配置
- 打卡奖励补发：可在管理后台“对账并自动补发”或调用接口。逻辑幂等：同一打卡（userid+work_date+check_time_ms）不会重复发币；已发送通知不会重复推送，通知失败会重试。

## 安全提示

- `.env` 中包含敏感信息，禁止提交到公开仓库
- 建议生产环境启用数据库备份与日志监控
