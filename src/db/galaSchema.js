// 年会模块（gala）数据表。由 initDb 在主 schema 之后执行，全部幂等。
const nowExpr = 'EXTRACT(EPOCH FROM NOW())::bigint';

export const galaSchemaSql = `
CREATE TABLE IF NOT EXISTS gala_events (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  event_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  total_budget BIGINT NOT NULL DEFAULT 0,
  enabled_segments TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_name TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  CONSTRAINT chk_gala_events_status CHECK (status IN ('draft', 'live', 'ended')),
  CONSTRAINT chk_gala_events_budget CHECK (total_budget >= 0)
);

-- 奖池：每笔年会发币都从奖池扣 spent，条件更新保证 spent 永不超过 budget。
-- is_reserved = 1 为预留名额专用奖池，只对超级管理员可见，不计入活动总预算。
CREATE TABLE IF NOT EXISTS gala_pools (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES gala_events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sponsor TEXT,
  budget BIGINT NOT NULL,
  spent BIGINT NOT NULL DEFAULT 0,
  is_reserved INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  CONSTRAINT chk_gala_pools_budget CHECK (budget >= 0 AND spent >= 0 AND spent <= budget),
  CONSTRAINT chk_gala_pools_reserved CHECK (is_reserved IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_gala_pools_event ON gala_pools(event_id, id);

-- 参与名单：抽奖池。第三期由手机扫码签到写入（source='checkin'），现在可由后台导入（source='admin'）。
CREATE TABLE IF NOT EXISTS gala_participants (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES gala_events(id) ON DELETE CASCADE,
  userid TEXT NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  name_snapshot TEXT,
  table_no INTEGER,
  source TEXT NOT NULL DEFAULT 'admin',
  joined_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  CONSTRAINT uq_gala_participants_event_user UNIQUE (event_id, userid)
);
CREATE INDEX IF NOT EXISTS idx_gala_participants_event ON gala_participants(event_id, id);

CREATE TABLE IF NOT EXISTS gala_rounds (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES gala_events(id) ON DELETE CASCADE,
  segment TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  title TEXT,
  prize_type TEXT NOT NULL DEFAULT 'none',
  pool_id BIGINT REFERENCES gala_pools(id) ON DELETE RESTRICT,
  amount_each BIGINT NOT NULL DEFAULT 0,
  draw_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'drawn',
  created_by TEXT,
  created_name TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  granted_at BIGINT,
  -- 非超管看到的“已发放”时间：只要普通中奖记录全部发完（或本轮没有普通奖励）且执行过发放就写入，
  -- 与预留名额发放成败无关，避免公开状态随预留奖励变化而暴露预留对象。
  public_granted_at BIGINT,
  CONSTRAINT uq_gala_rounds_segment_no UNIQUE (event_id, segment, round_no),
  CONSTRAINT chk_gala_rounds_prize CHECK (prize_type IN ('none', 'coin')),
  CONSTRAINT chk_gala_rounds_status CHECK (status IN ('drawn', 'granted'))
);
CREATE INDEX IF NOT EXISTS idx_gala_rounds_event ON gala_rounds(event_id, id DESC);

-- 每轮中奖人。awarded_at 为发币幂等闸门：只有把它从 NULL 改成时间戳的那个事务才会写账本。
CREATE TABLE IF NOT EXISTS gala_round_winners (
  id BIGSERIAL PRIMARY KEY,
  round_id BIGINT NOT NULL REFERENCES gala_rounds(id) ON DELETE CASCADE,
  event_id BIGINT NOT NULL REFERENCES gala_events(id) ON DELETE CASCADE,
  userid TEXT NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  name_snapshot TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  pool_id BIGINT REFERENCES gala_pools(id) ON DELETE RESTRICT,
  amount BIGINT NOT NULL DEFAULT 0,
  is_reserved INTEGER NOT NULL DEFAULT 0,
  awarded_at BIGINT,
  ledger_id BIGINT,
  award_error TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  CONSTRAINT uq_gala_round_winners_round_user UNIQUE (round_id, userid),
  CONSTRAINT chk_gala_round_winners_amount CHECK (amount >= 0),
  CONSTRAINT chk_gala_round_winners_reserved CHECK (is_reserved IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_gala_round_winners_event_user ON gala_round_winners(event_id, userid);

-- 预留名额：指定某人在某环节第 N 轮中奖。仅超级管理员可读写，占本轮一个名额（抽 N 人时普通抽 N-1 人）。
CREATE TABLE IF NOT EXISTS gala_reserved_slots (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES gala_events(id) ON DELETE CASCADE,
  segment TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  userid TEXT NOT NULL REFERENCES users(userid) ON DELETE CASCADE,
  pool_id BIGINT REFERENCES gala_pools(id) ON DELETE RESTRICT,
  amount BIGINT NOT NULL DEFAULT 0,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  used_round_id BIGINT,
  created_by TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  updated_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  CONSTRAINT chk_gala_reserved_status CHECK (status IN ('pending', 'used', 'cancelled')),
  CONSTRAINT chk_gala_reserved_amount CHECK (amount >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gala_reserved_pending_round
  ON gala_reserved_slots(event_id, segment, round_no)
  WHERE status = 'pending';
`;
