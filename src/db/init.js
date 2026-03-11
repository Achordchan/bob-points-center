import { Pool } from 'pg';

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
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  FOREIGN KEY (userid) REFERENCES users(userid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_redeems_userid_created_at ON redeems(userid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_redeems_fulfilled_created_at ON redeems(fulfilled_at, created_at DESC);

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
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr})
);
CREATE INDEX IF NOT EXISTS idx_content_announcements_enabled_publish ON content_announcements(is_enabled, publish_at DESC, id DESC);

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
  await db.run('INSERT INTO mall_opening_schedule(id, is_open, auto_enabled) VALUES(1, 1, 0) ON CONFLICT DO NOTHING');
  return db;
}
