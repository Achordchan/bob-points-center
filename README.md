# BOB币发行与管理中心

这是一个面向移动端的 BOB 币积分系统，包含余额展示、商城兑换、红包活动、订单核销、排行榜与“更多”信息模块，同时提供管理后台用于商品、红包、公告、FAQ、版本等内容管理。

## 功能概览

- 余额与流水：余额展示、积分流水记录
- 商城兑换：商品列表、库存、限购、下单与订单核销
- 红包活动：倒计时、抢红包、领取记录
- 排行榜：大富翁榜单展示
- 更多：公告、FAQ、我的数据、版本信息、反馈
- 管理后台：商品管理、红包管理、公告/FAQ/反馈/版本管理、用户管理
- 钉钉免登：基于钉钉 Web 免登获取用户信息

## 技术栈

- Node.js + Express
- PostgreSQL（当前唯一支持的数据库）
- Redis（可选，预留用于缓存/限流）
- 前端：原生 HTML/CSS/JS

## 运行要求

- Node.js 18+（建议 20+）
- PostgreSQL 16+（必需）
- Redis 7+（可选）

## 快速开始（本地）

1) 安装依赖
```bash
npm install
```

2) 准备环境变量
```bash
cp .env.example .env
```
按需修改 `.env` 中的数据库与钉钉配置。

3) 启动数据库（Docker）
```bash
npm run pg:up
```

4) 启动服务
```bash
npm start
```

服务默认监听 `PORT`（默认 8000）。

## 环境变量说明

以下为常用配置（见 `.env.example`）：

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

- 启动 PG/Redis（Docker）：`npm run pg:up`
- 停止 PG/Redis（Docker）：`npm run pg:down`
- 启动服务：`npm start`

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

## 宝塔面板部署（建议流程）

1) 宝塔安装：Nginx + Node.js + PostgreSQL + Redis  
2) 上传项目到 `/www/wwwroot/你的目录`  
3) `npm install --production`  
4) 配好 `.env`（PG 配置、钉钉配置等）  
5) 使用 `pm2` 启动：`pm2 start src/index.js --name bob`  
6) Nginx 反代到 `127.0.0.1:8000`  
7) 配置 SSL

## 运维与排查建议

- 商品加载慢：优先观察接口 `/mall/products` 和 `/mall/products/version` 响应耗时
- 并发抢红包：数据库 CPU 与锁等待是关键指标
- 钉钉免登失败：检查 `DINGTALK_*` 相关配置

## 安全提示

- `.env` 中包含敏感信息，禁止提交到公开仓库
- 建议生产环境启用数据库备份与日志监控
