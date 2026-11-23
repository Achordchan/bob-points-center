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
  -- 抽签时是否排除本环节已中奖者（1 排除）。抽签重试按它和其他参数判断是不是同一个请求。
  exclude_previous_winners SMALLINT NOT NULL DEFAULT 1 CHECK (exclude_previous_winners IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'drawn',
  created_by TEXT,
  created_name TEXT,
  created_at BIGINT NOT NULL DEFAULT (${nowExpr}),
  -- status = 'granted' 当且仅当 granted_at 非空：本轮全部正数奖励都已到账。超管与非超管看同一个状态。
  -- （早期测试库里可能还留着已不再使用的 public_granted_at 列，可为空、无人读写，不做删除以免滚动升级时旧实例出错。）
  granted_at BIGINT,
  CONSTRAINT uq_gala_rounds_segment_no UNIQUE (event_id, segment, round_no),
  CONSTRAINT chk_gala_rounds_prize CHECK (prize_type IN ('none', 'coin')),
  CONSTRAINT chk_gala_rounds_status CHECK (status IN ('drawn', 'granted'))
);
CREATE INDEX IF NOT EXISTS idx_gala_rounds_event ON gala_rounds(event_id, id DESC);
-- 按奖池统计已分配额（allocatedByPool）：发币抽签持有活动行锁时只扫本奖池的轮次。
CREATE INDEX IF NOT EXISTS idx_gala_rounds_pool ON gala_rounds(pool_id) WHERE pool_id IS NOT NULL;

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
-- 一条流水只能支付一笔奖励：ledger_id（包括用户重置后流水已删、凭据仍保留的）全局唯一，导入数据里重复的凭据也会被拒绝。
CREATE UNIQUE INDEX IF NOT EXISTS uq_gala_round_winners_ledger ON gala_round_winners(ledger_id) WHERE ledger_id IS NOT NULL;

-- 预留名额：指定某人在某环节第 N 轮中奖。仅超级管理员可读写，占本轮一个名额（抽 N 人时普通抽 N-1 人）。
-- 奖励与本轮普通中奖人一致（发币轮按单价、无币轮为 0），从 pool_id 指定的预留奖池扣；amount 在名额被使用时记下实际金额。
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
-- 用户重置按 userid 跨活动清理：待发中奖记录、名单、待用名额。
CREATE INDEX IF NOT EXISTS idx_gala_winners_user_unawarded ON gala_round_winners(userid) WHERE awarded_at IS NULL;
-- 按奖池汇总待发奖励（预留发币轮的预算准入、预留奖池调额的下限）：只扫目标奖池的待发记录。
CREATE INDEX IF NOT EXISTS idx_gala_winners_pool_unawarded ON gala_round_winners(pool_id) WHERE awarded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gala_participants_user ON gala_participants(userid);
CREATE INDEX IF NOT EXISTS idx_gala_reserved_user_pending ON gala_reserved_slots(userid) WHERE status = 'pending';
-- 预留名额列表按活动、id 倒序分页
CREATE INDEX IF NOT EXISTS idx_gala_reserved_event ON gala_reserved_slots(event_id, id);
-- 按人查未取消名额（抽签候选排除、超管名单的预留标记、名额唯一性）。
CREATE INDEX IF NOT EXISTS idx_gala_reserved_live_user
  ON gala_reserved_slots(event_id, userid)
  WHERE status <> 'cancelled';

-- 早期库补列（放在中奖表建好之后：回填要读中奖记录，按顺序执行时中奖表必须已存在）：新轮次默认排除已中奖者；补列前已有的轮次若有“同环节更早轮次的中奖人再次中奖”的记录，
-- 说明当时关闭了排除，回填为 0，免得升级后导出的备份（含自动恢复点）被跨轮重复中奖校验拒绝。只在补列时执行一次。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'gala_rounds'
                    AND column_name = 'exclude_previous_winners') THEN
    ALTER TABLE gala_rounds ADD COLUMN exclude_previous_winners SMALLINT NOT NULL DEFAULT 1
      CHECK (exclude_previous_winners IN (0, 1));
    UPDATE gala_rounds r SET exclude_previous_winners = 0
     WHERE EXISTS (
       SELECT 1 FROM gala_round_winners w
         JOIN gala_round_winners pw ON pw.event_id = w.event_id AND pw.userid = w.userid
         JOIN gala_rounds pr ON pr.id = pw.round_id
        WHERE w.round_id = r.id AND pr.event_id = r.event_id AND pr.segment = r.segment AND pr.round_no < r.round_no);
  END IF;
END $$;

-- 旧版本在最后一笔到账提交后、发放收尾之前退出，会留下“正数奖励已全部到账、却仍是 drawn”的发币轮。
-- 现在最后一笔到账与完成标记在同一事务里，不会再产生这种状态；这里在启动迁移时补齐（与备份导入的
-- completeFinishedCoinRounds 同一条件：完成时间取最后一笔到账时间，没有则取轮次创建时间）。仍有待发奖励的轮次、无币轮不动。幂等。
UPDATE gala_rounds r
   SET status = 'granted',
       granted_at = COALESCE((SELECT MAX(w.awarded_at) FROM gala_round_winners w WHERE w.round_id = r.id), r.created_at)
 WHERE r.prize_type = 'coin' AND r.status = 'drawn'
   AND NOT EXISTS (SELECT 1 FROM gala_round_winners w WHERE w.round_id = r.id AND w.awarded_at IS NULL AND w.amount > 0);

-- 全量恢复状态：单行。generation 计数，version_token 是数据版本（建库时随机生成，每次成功的全量恢复换新值，
-- 失败回滚则不变）。不进备份；写接口和发放用 version_token 识别“读到数据之后发生过恢复”，换库也不会撞上旧值。
CREATE TABLE IF NOT EXISTS gala_restore_state (
  id INTEGER PRIMARY KEY,
  generation BIGINT NOT NULL DEFAULT 0,
  version_token TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  CONSTRAINT chk_gala_restore_state_singleton CHECK (id = 1)
);
ALTER TABLE gala_restore_state ADD COLUMN IF NOT EXISTS version_token TEXT NOT NULL DEFAULT gen_random_uuid()::text;
INSERT INTO gala_restore_state(id, generation) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- 年会表 ID 不超过 JS 安全整数（接口按 Number 解析 ID）：到上限时插入失败，而不是生成接口无法引用的记录。
-- 流水表同样设上限：年会付款凭据（中奖记录的 ledger_id、GALA_W 引用）和备份校验都按安全整数处理流水 ID。
-- 升级前的库里流水序列或已有流水 ID 可能已超过这个上限（旧版本的全量恢复按原值导入并推进序列）：
-- 这时不收紧流水序列，保持原范围让服务照常启动；年会发放在付款凭据处兜底（流水 ID 不是安全整数时整笔回滚）。
DO $$
DECLARE
  t TEXT;
  ledger_seq regclass := pg_get_serial_sequence('ledger', 'id')::regclass;
BEGIN
  FOREACH t IN ARRAY ARRAY['gala_events', 'gala_pools', 'gala_participants', 'gala_rounds', 'gala_round_winners', 'gala_reserved_slots'] LOOP
    EXECUTE format('ALTER SEQUENCE %s MAXVALUE 9007199254740991', pg_get_serial_sequence(t, 'id'));
  END LOOP;
  IF COALESCE(pg_sequence_last_value(ledger_seq), 0) <= 9007199254740991
     AND COALESCE((SELECT MAX(id) FROM ledger), 0) <= 9007199254740991 THEN
    EXECUTE format('ALTER SEQUENCE %s MAXVALUE 9007199254740991', ledger_seq);
  ELSE
    RAISE WARNING 'ledger ids already exceed 9007199254740991; keeping the ledger sequence range (gala payouts refuse unsafe ledger ids)';
  END IF;
END $$;

-- 升级前第三方发币可以写入 GALA_W<n> 形式的引用号：把中奖记录序列推进到这些引用号之后（只升不降），
-- 新抽出的中奖记录 ID 不会与历史流水同名（否则那条流水像是它的付款，之后的备份无法恢复）。
-- 之后第三方接口不再接受 GALA_W 引用号；全量恢复后同样推进（见 backupRoutes）。
DO $$
DECLARE
  w_seq regclass := pg_get_serial_sequence('gala_round_winners', 'id')::regclass;
  legacy_ref NUMERIC := (SELECT MAX(substring(ref_id FROM 7)::numeric) FROM ledger WHERE ref_id ~ '^GALA_W[1-9][0-9]{0,18}$');
  cur NUMERIC := GREATEST(COALESCE(pg_sequence_last_value(w_seq), 0), COALESCE((SELECT MAX(id) FROM gala_round_winners), 0));
BEGIN
  IF legacy_ref IS NOT NULL AND legacy_ref > cur THEN
    PERFORM setval(w_seq, LEAST(legacy_ref, 9007199254740991)::bigint, true);
  END IF;
END $$;
`;
