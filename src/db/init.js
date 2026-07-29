import { Pool } from 'pg';
import { ensureAdminRoles } from '../services/adminPermissionService.js';
import { computeAnnouncementContentHash } from '../services/announcementAccessService.js';

const nowExpr = 'EXTRACT(EPOCH FROM NOW())::bigint';
const schemaSql = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  userid TEXT NOT NULL UNIQUE,
  name TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr})
);

CREATE TABLE IF NOT EXISTS accounts (
  id BIGSERIAL PRIMARY KEY,
  userid TEXT NOT NULL UNIQUE,
  balance BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  FOREIGN KEY (userid) REFERENCES users(userid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ledger (
  id BIGSERIAL PRIMARY KEY,
  userid TEXT NOT NULL,
  delta BIGINT NOT NULL,
  reason TEXT NOT NULL,
  ref_id TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  FOREIGN KEY (userid) REFERENCES users(userid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS redeems (
  id BIGSERIAL PRIMARY KEY,
  exchange_id TEXT NOT NULL UNIQUE,
  userid TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT,
  bob_amount BIGINT NOT NULL,
  fulfilled_at BIGINT,
  fulfilled_by TEXT,
  fulfilled_name TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  limit_round INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  FOREIGN KEY (userid) REFERENCES users(userid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_redeems_userid_created_at ON redeems(userid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_redeems_fulfilled_created_at ON redeems(fulfilled_at, created_at DESC);

CREATE TABLE IF NOT EXISTS mall_order_listings (
  id BIGSERIAL PRIMARY KEY,
  listing_id TEXT NOT NULL UNIQUE,
  exchange_id TEXT NOT NULL,
  seller_userid TEXT NOT NULL,
  seller_name_snapshot TEXT,
  buyer_userid TEXT,
  buyer_name_snapshot TEXT,
  price BIGINT NOT NULL,
  seller_note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  sold_at BIGINT,
  cancelled_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_mall_order_listings_status_created
  ON mall_order_listings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mall_order_listings_seller_status
  ON mall_order_listings(seller_userid, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mall_order_listings_buyer_status
  ON mall_order_listings(buyer_userid, status, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_mall_order_listings_exchange_id
  ON mall_order_listings(exchange_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mall_order_listings_active_exchange
  ON mall_order_listings(exchange_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS bob_tokens (
  id BIGSERIAL PRIMARY KEY,
  token TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  revoked_at BIGINT
);

CREATE TABLE IF NOT EXISTS mall_products (
  id BIGSERIAL PRIMARY KEY,
  product_id TEXT NOT NULL UNIQUE,
  product_name TEXT NOT NULL,
  bob_amount BIGINT NOT NULL,
  stock BIGINT,
  limit_per_user INTEGER NOT NULL DEFAULT 0,
  limit_round INTEGER NOT NULL DEFAULT 1,
  cdk_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'on',
  sort INTEGER,
  image_url TEXT,
  remark TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr})
);
CREATE INDEX IF NOT EXISTS idx_mall_products_status_sort_pid
  ON mall_products(status, sort, product_id);

CREATE TABLE IF NOT EXISTS mall_opening_schedule (
  id BIGINT PRIMARY KEY CHECK (id = 1),
  is_open INTEGER NOT NULL DEFAULT 1,
  auto_enabled INTEGER NOT NULL DEFAULT 0,
  next_open_at BIGINT,
  interval_minutes INTEGER,
  open_duration_minutes INTEGER,
  remind_before_seconds INTEGER,
  close_remind_seconds INTEGER,
  remind_for_open_at BIGINT,
  open_notify_for_open_at BIGINT,
  close_remind_for_close_at BIGINT,
  close_notify_for_close_at BIGINT,
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr})
);

CREATE TABLE IF NOT EXISTS red_packet_activity (
  id BIGSERIAL PRIMARY KEY,
  total_amount BIGINT NOT NULL,
  total_count BIGINT NOT NULL,
  countdown_seconds INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  start_at BIGINT NOT NULL,
  end_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  sponsor TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr})
);

CREATE TABLE IF NOT EXISTS red_packet_items (
  id BIGSERIAL PRIMARY KEY,
  activity_id BIGINT NOT NULL,
  amount BIGINT NOT NULL,
  claimed_by TEXT,
  claimed_at BIGINT,
  FOREIGN KEY (activity_id) REFERENCES red_packet_activity(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_red_packet_items_activity_claimed_id
  ON red_packet_items(activity_id, claimed_by, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_red_packet_items_activity_claimed_once
  ON red_packet_items(activity_id, claimed_by)
  WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_red_packet_items_activity_unclaimed
  ON red_packet_items(activity_id, id)
  WHERE claimed_by IS NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  actor_name TEXT,
  ip TEXT,
  method TEXT,
  path TEXT,
  status_code INTEGER,
  message TEXT,
  payload TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr})
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs(event_type);

CREATE TABLE IF NOT EXISTS admin_roles (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr})
);
CREATE INDEX IF NOT EXISTS idx_admin_roles_enabled ON admin_roles(is_enabled, id);

CREATE TABLE IF NOT EXISTS admin_user_roles (
  userid TEXT PRIMARY KEY,
  role_id BIGINT NOT NULL,
  assigned_by TEXT,
  assigned_name TEXT,
  assigned_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  FOREIGN KEY (userid) REFERENCES users(userid) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES admin_roles(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_admin_user_roles_role_id ON admin_user_roles(role_id);

CREATE TABLE IF NOT EXISTS content_faq (
  id BIGSERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr})
);
CREATE INDEX IF NOT EXISTS idx_content_faq_enabled_sort ON content_faq(is_enabled, sort, id DESC);

CREATE TABLE IF NOT EXISTS content_announcements (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  sort INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  publish_at BIGINT,
  show_fullscreen INTEGER NOT NULL DEFAULT 0 CHECK (show_fullscreen IN (0, 1)),
  requires_acknowledgement INTEGER NOT NULL DEFAULT 0 CHECK (requires_acknowledgement IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  content_hash TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  CHECK (requires_acknowledgement = 0 OR show_fullscreen = 1)
);
CREATE INDEX IF NOT EXISTS idx_content_announcements_enabled_publish ON content_announcements(is_enabled, publish_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS content_announcement_revisions (
  id BIGSERIAL PRIMARY KEY,
  announcement_id BIGINT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  requires_acknowledgement INTEGER NOT NULL DEFAULT 0 CHECK (requires_acknowledgement IN (0, 1)),
  content_hash TEXT NOT NULL CHECK (char_length(content_hash) = 64),
  created_by TEXT,
  created_name TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  FOREIGN KEY (announcement_id) REFERENCES content_announcements(id) ON DELETE CASCADE,
  UNIQUE (announcement_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_content_announcement_revisions_announcement ON content_announcement_revisions(announcement_id, revision DESC);

CREATE TABLE IF NOT EXISTS content_announcement_acknowledgements (
  id BIGSERIAL PRIMARY KEY,
  userid TEXT NOT NULL,
  announcement_id BIGINT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_hash TEXT NOT NULL CHECK (char_length(content_hash) = 64),
  action TEXT NOT NULL CHECK (action IN ('acknowledged', 'dismissed')),
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  FOREIGN KEY (userid) REFERENCES users(userid) ON DELETE CASCADE,
  FOREIGN KEY (announcement_id) REFERENCES content_announcements(id) ON DELETE CASCADE,
  UNIQUE (userid, announcement_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_content_announcement_ack_announcement ON content_announcement_acknowledgements(announcement_id, revision);

CREATE TABLE IF NOT EXISTS user_feedback (
  id BIGSERIAL PRIMARY KEY,
  userid TEXT NOT NULL,
  name TEXT,
  category TEXT NOT NULL DEFAULT 'suggestion',
  content TEXT NOT NULL,
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reply TEXT,
  handled_by TEXT,
  handled_name TEXT,
  handled_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr})
);
CREATE INDEX IF NOT EXISTS idx_user_feedback_userid_created ON user_feedback(userid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_feedback_status_created ON user_feedback(status, created_at DESC);

CREATE TABLE IF NOT EXISTS user_feedback_messages (
  id BIGSERIAL PRIMARY KEY,
  feedback_id BIGINT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  FOREIGN KEY (feedback_id) REFERENCES user_feedback(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_feedback_messages_feedback_created ON user_feedback_messages(feedback_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS user_dingtalk_profiles (
  userid TEXT PRIMARY KEY,
  unionid TEXT,
  name TEXT,
  avatar TEXT,
  mobile TEXT,
  telephone TEXT,
  email TEXT,
  org_email TEXT,
  title TEXT,
  job_number TEXT,
  work_place TEXT,
  remark TEXT,
  dept_ids TEXT,
  dept_names TEXT,
  extension TEXT,
  hired_date BIGINT,
  active INTEGER,
  is_admin INTEGER,
  is_boss INTEGER,
  leader_in_dept TEXT,
  exclusive_account INTEGER,
  raw TEXT,
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  FOREIGN KEY (userid) REFERENCES users(userid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_dingtalk_profiles_updated ON user_dingtalk_profiles(updated_at DESC);

CREATE TABLE IF NOT EXISTS admin_backup_history (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  mode TEXT NOT NULL,
  filename TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  actor_id TEXT,
  actor_name TEXT,
  details TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr})
);
CREATE INDEX IF NOT EXISTS idx_admin_backup_history_created ON admin_backup_history(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS system_versions (
  id BIGSERIAL PRIMARY KEY,
  version_name TEXT NOT NULL,
  release_notes TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  publish_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr})
);
CREATE INDEX IF NOT EXISTS idx_system_versions_enabled_publish ON system_versions(is_enabled, publish_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr})
);

CREATE TABLE IF NOT EXISTS redeem_cdks (
  id BIGSERIAL PRIMARY KEY,
  batch_id TEXT NOT NULL,
  cdk_code TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_bob_amount BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unused',
  created_by TEXT,
  created_name TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  redeemed_by TEXT,
  redeemed_name TEXT,
  redeemed_at BIGINT,
  redeem_exchange_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_redeem_cdks_status_created_at ON redeem_cdks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_redeem_cdks_product_created_at ON redeem_cdks(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_redeem_cdks_exchange_id ON redeem_cdks(redeem_exchange_id);

CREATE TABLE IF NOT EXISTS charity_projects (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  project_name TEXT NOT NULL,
  cover_image_url TEXT,
  summary TEXT NOT NULL,
  rules_text TEXT NOT NULL,
  target_bob_amount BIGINT NOT NULL,
  tier_options_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  execution_status TEXT NOT NULL DEFAULT 'pending',
  execution_note TEXT,
  sort INTEGER,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  executed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_charity_projects_status_sort ON charity_projects(status, sort, project_id);

CREATE TABLE IF NOT EXISTS charity_contributions (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL,
  userid TEXT NOT NULL,
  user_name_snapshot TEXT,
  bob_amount BIGINT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  FOREIGN KEY (project_id) REFERENCES charity_projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY (userid) REFERENCES users(userid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_charity_contributions_project_created ON charity_contributions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_charity_contributions_user_created ON charity_contributions(userid, created_at DESC);

CREATE TABLE IF NOT EXISTS attendance_reward_records (
  id BIGSERIAL PRIMARY KEY,
  userid TEXT NOT NULL,
  user_name_snapshot TEXT,
  work_date TEXT NOT NULL,
  check_time_ms BIGINT NOT NULL,
  check_time_text TEXT,
  check_type TEXT,
  source_type TEXT,
  time_result TEXT,
  event_source TEXT NOT NULL DEFAULT 'stream',
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  reward_amount BIGINT,
  reward_reason TEXT,
  notify_status TEXT,
  error_message TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  UNIQUE(userid, work_date, check_time_ms)
);
CREATE INDEX IF NOT EXISTS idx_attendance_reward_records_work_date_status ON attendance_reward_records(work_date, status, userid);
CREATE INDEX IF NOT EXISTS idx_attendance_reward_records_user_work_date ON attendance_reward_records(userid, work_date, check_time_ms DESC);
`;

function resolvePgConfig(input) {
  if (input?.db?.kind === 'postgres') return input.db;
  if (input?.kind === 'postgres') return input;
  const envSsl = String(process.env.PG_SSL || '').trim().toLowerCase();
  const ssl = ['1', 'true', 'yes', 'on'].includes(envSsl);
  return {
    kind: 'postgres',
    host: process.env.PG_HOST || '127.0.0.1',
    port: Number(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE || 'bob',
    user: process.env.PG_USER || 'bob',
    password: process.env.PG_PASSWORD || 'bob123456',
    ssl,
    poolMax: Number(process.env.PG_POOL_MAX || 20),
  };
}

function replaceQuestionParams(sql) {
  let idx = 1;
  let inSingle = false;
  let inDouble = false;
  let out = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'" && !inDouble) {
      if (inSingle && sql[i + 1] === "'") {
        out += "''";
        i += 1;
        continue;
      }
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    if (ch === '?' && !inSingle && !inDouble) {
      out += `$${idx}`;
      idx += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function appendBeforeEndingSemicolon(sql, suffix) {
  return `${String(sql || '').replace(/;\s*$/, '')}${suffix}`;
}

function normalizeSql(rawSql, { forRun = false } = {}) {
  let sql = String(rawSql || '');
  sql = sql.replace(/\bBEGIN\s+IMMEDIATE\b/gi, 'BEGIN');
  sql = sql.replace(/\bCOLLATE\s+NOCASE\b/gi, '');
  sql = sql.replace(/\bchar\(/gi, 'chr(');
  sql = sql.replace(/\bunixepoch\(\)/gi, nowExpr);
  const hasInsertOrIgnore = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  if (hasInsertOrIgnore) {
    sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO');
  }
  if (hasInsertOrIgnore && !/\bON\s+CONFLICT\b/i.test(sql)) {
    sql = appendBeforeEndingSemicolon(sql, ' ON CONFLICT DO NOTHING');
  }
  if (forRun && /^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql)) {
    sql = appendBeforeEndingSemicolon(sql, ' RETURNING id');
  }
  return sql;
}

const defaultSystemVersions = [
  {
    version_name: 'v2026.6.25',
    publish_at: 1782316800,
    release_notes: [
      '管理端升级为 React + Ant Design 企业后台，完成首页概览、用户与账户、订单与核销、商城与 CDK、消息中心、内容运营、系统集成、审计安全的信息架构重组。',
      '钉钉连接提升为全局状态能力，支持组织识别、连接面板、部门选择和打卡奖励适用范围控制。',
      '订单核销补齐扫码、图片上传、剪贴板识别和手动 encoded 兜底；修复 CDK 金额显示、历史核销日志金额和管理员减币误入订单列表。',
      '商城商品补齐图片预览/编辑器、限购轮次、加载状态和核心 CRUD 体验，登录页与后台视觉统一商用化。',
    ].join('\n'),
  },
  {
    version_name: 'v2026.5.2',
    publish_at: 1777651200,
    release_notes: [
      '修复商城商品缓存失效和前台余额显示一致性问题。',
      '余额扣减改为数据库原子更新，避免并发下余额被重复读取或超扣。',
      '完善商城限购提交审查流程并保留生产部署校验记录。',
    ].join('\n'),
  },
  {
    version_name: 'v2026.4.30',
    publish_at: 1777478400,
    release_notes: [
      '完成宝塔 Node 项目与 PostgreSQL 生产环境迁移，确认 bob.baymaxgroup.com 健康检查正常。',
      '接入 GitHub Actions 自动部署到宝塔项目，保留服务器项目目录和面板管理链路。',
      '新增商城限购轮次，付费购买计入当前轮次，CDK 兑换不占用限购名额。',
      '补齐部署文档、备份导入导出和生产运行校验流程。',
    ].join('\n'),
  },
  {
    version_name: 'v2026.4.5',
    publish_at: 1775318400,
    release_notes: [
      '修复公益项目赞助后无推送事件的问题，公益助力后前端可及时刷新。',
      '前端实时更新从轮询改为 SSE 连接推送。',
      '新增打卡奖励自动对账补发能力，降低漏发奖励风险。',
    ].join('\n'),
  },
  {
    version_name: 'v2026.3.11',
    publish_at: 1773158400,
    release_notes: [
      '初始化 BOB 积分中心代码仓库，补齐 README、运行说明和基础部署文档。',
      '新增打卡奖励对账指引，明确奖励补发和异常排查流程。',
    ].join('\n'),
  },
  {
    version_name: 'v2026.3.2',
    publish_at: 1772441160,
    release_notes: '增加转账、提现（占位）等功能；修复已知问题；新增大富翁板块；后台优化；前端调优。',
  },
  {
    version_name: 'v2026.2.27',
    publish_at: 1772153040,
    release_notes: '数据库更换为 PostgreSQL；针对并发场景优化；新增多项功能；修复已知问题。',
  },
  {
    version_name: 'v2026.2.3',
    publish_at: 1770056820,
    release_notes: '针对系统进行自检修复；引入代码审计；修复已知问题。',
  },
  {
    version_name: 'v2026.1.29',
    publish_at: 1769676180,
    release_notes: '发行第一版：余额、抢红包、商城等核心功能初版上线。',
  },
];

async function seedSystemVersions(db) {
  await db.exec("UPDATE system_versions SET version_name = regexp_replace(version_name, '^v26\\.', 'v2026.') WHERE version_name ~ '^v26\\.'");
  await db.exec("UPDATE system_versions SET version_name = 'v2026.2.3' WHERE version_name = 'v2.0' AND NOT EXISTS (SELECT 1 FROM system_versions WHERE version_name = 'v2026.2.3')");
  await db.exec("UPDATE system_versions SET version_name = 'v2026.1.29' WHERE version_name = 'v1.0' AND NOT EXISTS (SELECT 1 FROM system_versions WHERE version_name = 'v2026.1.29')");
  for (const item of defaultSystemVersions) {
    await db.run(
      `INSERT INTO system_versions(version_name, release_notes, is_enabled, publish_at, created_at, updated_at)
       SELECT ?, ?, 1, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM system_versions WHERE version_name = ?)`,
      [item.version_name, item.release_notes, item.publish_at, item.publish_at, item.publish_at, item.version_name],
    );
  }
}

class PgDb {
  constructor(pool) {
    this.pool = pool;
    this._scopedCache = new WeakMap();
  }

  async _query(sql, params = [], options = {}, client = null) {
    const normalized = normalizeSql(sql, options);
    const text = replaceQuestionParams(normalized);
    if (client) {
      return await client.query(text, params || []);
    }
    return await this.pool.query(text, params || []);
  }

  async exec(sql, params = [], client = null) {
    await this._query(sql, params, {}, client);
  }

  async all(sql, params = [], client = null) {
    const result = await this._query(sql, params, {}, client);
    return result.rows || [];
  }

  async get(sql, params = [], client = null) {
    const result = await this._query(sql, params, {}, client);
    return result.rows?.[0];
  }

  async run(sql, params = [], client = null) {
    const result = await this._query(sql, params, { forRun: true }, client);
    return {
      changes: Number(result.rowCount || 0),
      lastID: result.rows?.[0]?.id ?? null,
    };
  }

  async prepare(sql, client = null) {
    const db = this;
    return {
      async run(...args) {
        return await db.run(sql, args, client);
      },
      async finalize() {
        // no-op for pg
      },
    };
  }

  _getScoped(client) {
    const cached = this._scopedCache.get(client);
    if (cached) return cached;
    const db = this;
    const scoped = {
      __txScoped: true,
      exec(sql, params = []) {
        return db.exec(sql, params, client);
      },
      all(sql, params = []) {
        return db.all(sql, params, client);
      },
      get(sql, params = []) {
        return db.get(sql, params, client);
      },
      run(sql, params = []) {
        return db.run(sql, params, client);
      },
      prepare(sql) {
        return db.prepare(sql, client);
      },
      transaction(fn) {
        return db.transaction(fn);
      },
      close() {
        return db.close();
      },
    };
    this._scopedCache.set(client, scoped);
    return scoped;
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = this._getScoped(client);
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

export async function initDb(input) {
  const pg = resolvePgConfig(input);
  if (pg.kind !== 'postgres') {
    throw new Error('Only PostgreSQL is supported now.');
  }
  const pool = new Pool({
    host: pg.host,
    port: Number(pg.port || 5432),
    database: pg.database,
    user: pg.user,
    password: pg.password,
    max: Number(pg.poolMax || 20),
    ssl: pg.ssl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  const db = new PgDb(pool);
  await db.get('SELECT 1');
  await db.exec(schemaSql);
  await db.exec("ALTER TABLE mall_products ADD COLUMN IF NOT EXISTS cdk_enabled INTEGER NOT NULL DEFAULT 0");
  await db.exec("ALTER TABLE mall_products ADD COLUMN IF NOT EXISTS limit_round INTEGER NOT NULL DEFAULT 1");
  await db.exec("ALTER TABLE mall_opening_schedule ADD COLUMN IF NOT EXISTS close_notify_for_close_at BIGINT");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_mall_order_listings_status_created ON mall_order_listings(status, created_at DESC)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_mall_order_listings_seller_status ON mall_order_listings(seller_userid, status, created_at DESC)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_mall_order_listings_buyer_status ON mall_order_listings(buyer_userid, status, sold_at DESC)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_mall_order_listings_exchange_id ON mall_order_listings(exchange_id)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_mall_order_listings_active_exchange ON mall_order_listings(exchange_id) WHERE status = 'active'");
  await db.exec("ALTER TABLE redeems ADD COLUMN IF NOT EXISTS limit_round INTEGER NOT NULL DEFAULT 1");
  await db.exec("ALTER TABLE redeems ADD COLUMN IF NOT EXISTS fulfilled_by TEXT");
  await db.exec("ALTER TABLE redeems ADD COLUMN IF NOT EXISTS fulfilled_name TEXT");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_redeems_user_product_round ON redeems(userid, product_id, limit_round)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_red_packet_items_activity_claimed_once ON red_packet_items(activity_id, claimed_by) WHERE claimed_by IS NOT NULL");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_red_packet_items_activity_unclaimed ON red_packet_items(activity_id, id) WHERE claimed_by IS NULL");
  await db.exec("ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS permissions TEXT NOT NULL DEFAULT '[]'");
  await db.exec("ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS is_builtin INTEGER NOT NULL DEFAULT 0");
  await db.exec("ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS is_enabled INTEGER NOT NULL DEFAULT 1");
  await db.exec("ALTER TABLE user_dingtalk_profiles ADD COLUMN IF NOT EXISTS telephone TEXT");
  await db.exec("ALTER TABLE user_dingtalk_profiles ADD COLUMN IF NOT EXISTS org_email TEXT");
  await db.exec("ALTER TABLE user_dingtalk_profiles ADD COLUMN IF NOT EXISTS extension TEXT");
  await db.exec("ALTER TABLE user_dingtalk_profiles ADD COLUMN IF NOT EXISTS hired_date BIGINT");
  await db.exec("ALTER TABLE user_dingtalk_profiles ADD COLUMN IF NOT EXISTS leader_in_dept TEXT");
  await db.exec("ALTER TABLE mall_order_listings ADD COLUMN IF NOT EXISTS seller_note TEXT");
  await db.exec("ALTER TABLE content_announcements ADD COLUMN IF NOT EXISTS show_fullscreen INTEGER NOT NULL DEFAULT 0");
  await db.exec("ALTER TABLE content_announcements ADD COLUMN IF NOT EXISTS requires_acknowledgement INTEGER NOT NULL DEFAULT 0");
  await db.exec("ALTER TABLE content_announcements ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1");
  await db.exec("ALTER TABLE content_announcements ADD COLUMN IF NOT EXISTS content_hash TEXT NOT NULL DEFAULT ''");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_content_announcements_access ON content_announcements(is_enabled, requires_acknowledgement, show_fullscreen, publish_at)");
  const announcementsMissingHash = await db.all(
    `SELECT id, title, content, requires_acknowledgement, revision, created_at
       FROM content_announcements
      WHERE content_hash IS NULL OR char_length(content_hash) <> 64`,
  );
  for (const announcement of announcementsMissingHash || []) {
    const contentHash = computeAnnouncementContentHash({
      title: announcement.title,
      content: announcement.content,
      requiresAcknowledgement: Number(announcement.requires_acknowledgement || 0) === 1,
    });
    await db.run(
      `UPDATE content_announcements
          SET content_hash = ?, revision = CASE WHEN revision < 1 THEN 1 ELSE revision END
        WHERE id = ?`,
      [contentHash, announcement.id],
    );
  }
  await db.exec(`
    INSERT INTO content_announcement_revisions(
      announcement_id, revision, title, content, requires_acknowledgement,
      content_hash, created_at
    )
    SELECT id, revision, title, content, requires_acknowledgement,
           content_hash, created_at
      FROM content_announcements
    ON CONFLICT(announcement_id, revision) DO NOTHING
  `);
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_content_announcements_fullscreen') THEN
        ALTER TABLE content_announcements
          ADD CONSTRAINT chk_content_announcements_fullscreen CHECK (show_fullscreen IN (0, 1));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_content_announcements_acknowledgement') THEN
        ALTER TABLE content_announcements
          ADD CONSTRAINT chk_content_announcements_acknowledgement CHECK (requires_acknowledgement IN (0, 1));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_content_announcements_revision') THEN
        ALTER TABLE content_announcements
          ADD CONSTRAINT chk_content_announcements_revision CHECK (revision >= 1);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_content_announcements_hash') THEN
        ALTER TABLE content_announcements
          ADD CONSTRAINT chk_content_announcements_hash CHECK (char_length(content_hash) = 64);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_content_announcements_ack_fullscreen') THEN
        ALTER TABLE content_announcements
          ADD CONSTRAINT chk_content_announcements_ack_fullscreen
          CHECK (requires_acknowledgement = 0 OR show_fullscreen = 1);
      END IF;
    END $$;
  `);
  await ensureAdminRoles(db);
  // 历史 bob_tokens.token 明文清空（仅保留 hash）；新 Token 创建时本就写 null。
  try {
    await db.exec("UPDATE bob_tokens SET token = NULL WHERE token IS NOT NULL");
  } catch (err) {
    // 非阻塞：表不存在或权限问题时不阻止启动
  }

  // P2: 用户关联外键（存在则跳过；脏数据失败只告警不阻断启动）
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_mall_order_listings_seller') THEN
        ALTER TABLE mall_order_listings
          ADD CONSTRAINT fk_mall_order_listings_seller
          FOREIGN KEY (seller_userid) REFERENCES users(userid) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'skip fk_mall_order_listings_seller: %', SQLERRM;
    END $$;
  `);
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_feedback_userid') THEN
        ALTER TABLE user_feedback
          ADD CONSTRAINT fk_user_feedback_userid
          FOREIGN KEY (userid) REFERENCES users(userid) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'skip fk_user_feedback_userid: %', SQLERRM;
    END $$;
  `);
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_attendance_reward_userid') THEN
        ALTER TABLE attendance_reward_records
          ADD CONSTRAINT fk_attendance_reward_userid
          FOREIGN KEY (userid) REFERENCES users(userid) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'skip fk_attendance_reward_userid: %', SQLERRM;
    END $$;
  `);

  await db.exec(`INSERT INTO user_feedback_messages(feedback_id, sender_type, sender_id, sender_name, content, created_at)
    SELECT f.id, 'user', f.userid, COALESCE(f.name, ''), f.content, f.created_at
    FROM user_feedback f
    WHERE NOT EXISTS (SELECT 1 FROM user_feedback_messages m WHERE m.feedback_id = f.id AND m.sender_type = 'user')`);
  await db.exec(`INSERT INTO user_feedback_messages(feedback_id, sender_type, sender_id, sender_name, content, created_at)
    SELECT f.id, 'admin', COALESCE(f.handled_by, ''), COALESCE(f.handled_name, ''), f.reply, COALESCE(f.handled_at, f.updated_at, f.created_at)
    FROM user_feedback f
    WHERE COALESCE(f.reply, '') <> ''
      AND NOT EXISTS (SELECT 1 FROM user_feedback_messages m WHERE m.feedback_id = f.id AND m.sender_type = 'admin')`);
  await db.run('INSERT INTO mall_opening_schedule(id, is_open, auto_enabled) VALUES(1, 1, 0) ON CONFLICT DO NOTHING');
  await seedSystemVersions(db);
  return db;
}
