/**
 * 用户重置/删除时的关联数据清理（同一事务内调用）。
 * 已有 FK CASCADE 的表仍显式删除，便于返回计数与兼容历史数据。
 */
import { purgeUserAuctionBids } from './auctionService.js';
import { GALA_RESET_LOCK } from './galaService.js';

function asList(userids) {
  return (Array.isArray(userids) ? userids : [userids])
    .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
    .filter(Boolean);
}

async function del(tx, sql, params) {
  const r = await tx.run(sql, params);
  return Number(r?.changes || 0);
}

/**
 * 清理用户业务数据，保留 users/accounts 行（重置场景）。
 * - 挂单/流水/兑换/公益/反馈/打卡/角色/钉钉资料：删除
 * - CDK：保留码池与“已使用”状态，仅解除 redeemed_by 指向（不把 used 改回 unused，避免重复核销）
 * - 红包领取：保留领取记录与金额占用，避免活动账目回滚
 */
export async function purgeUserBusinessData(tx, userids, { protectUserids = [] } = {}) {
  const ids = asList(userids);
  const protectedSet = new Set(asList(protectUserids));
  const targets = ids.filter((id) => !protectedSet.has(id));
  if (!targets.length) {
    return { targets: [], counts: {} };
  }
  const placeholders = targets.map(() => '?').join(',');
  const counts = {};

  // 与出价/结算统一加锁顺序：先锁定与目标用户相关的竞拍活动，再锁定其账户。
  // - placeAuctionBid：先锁 auction_activities FOR UPDATE，再锁 accounts FOR UPDATE；
  // - settleAuctionIfDue：仅锁 auction_activities FOR UPDATE。
  // 因此清理必须同样「先活动、后账户」，否则会与出价反向加锁而死锁(40P01)。
  // 先锁活动还能把清理与并发结算串行化：结算先锁活动，会阻塞到清理提交，
  // 不会在清理删除 ledger/redeems 之后再为获胜者补写账目/兑换单而残留数据。
  // ORDER BY 保证多行加锁次序确定，避免并发清理之间互相死锁。
  await tx.all(
    `SELECT id FROM auction_activities
       WHERE current_bid_userid IN (${placeholders})
          OR winner_userid IN (${placeholders})
          OR id IN (SELECT activity_id FROM auction_bids WHERE userid IN (${placeholders}))
       ORDER BY id
       FOR UPDATE`,
    [...targets, ...targets, ...targets],
  );
  // 与年会抽签串行（抽签是唯一写入中奖记录的地方）：抽签在锁活动行之前拿 GALA_RESET_LOCK 的共享锁，
  // 这里拿排他锁。抽签先拿到，清理等它提交后再删除新写入的未发放中奖记录；清理先拿到，抽签等清理提交后
  // 才读参与者，此时目标用户已不在名单里。用全局锁而不是锁活动行：清理开始后才创建的活动也被覆盖。
  await tx.get('SELECT pg_advisory_xact_lock(hashtext(?)) AS locked', [GALA_RESET_LOCK]);
  // 年会发币的加锁顺序是「轮次 → 中奖记录 → 奖池 → 账户」，这里同样先锁涉及的轮次（排他：等进行中的到账、
  // 失败回写、收尾都提交，之后它们排在清理后面），再锁未发放的中奖记录、再锁账户：
  // 并发发币要么在清理前完成（随后流水被删、余额清零），要么等清理提交后发现记录已删除而跳过，
  // 不会给已重置的账户补发旧奖励。抽签已被上面的排他锁挡住，期间不会出现新的待发记录。
  await tx.all(
    `SELECT id FROM gala_rounds
      WHERE id IN (SELECT round_id FROM gala_round_winners WHERE userid IN (${placeholders}) AND awarded_at IS NULL)
      ORDER BY id
      FOR UPDATE`,
    targets,
  );
  await tx.all(
    `SELECT id FROM gala_round_winners
      WHERE userid IN (${placeholders}) AND awarded_at IS NULL
      ORDER BY id
      FOR UPDATE`,
    targets,
  );
  await tx.all(
    `SELECT userid FROM accounts WHERE userid IN (${placeholders}) ORDER BY userid FOR UPDATE`,
    targets,
  );

  counts.mall_order_listings = await del(
    tx,
    `DELETE FROM mall_order_listings WHERE seller_userid IN (${placeholders}) OR buyer_userid IN (${placeholders})`,
    [...targets, ...targets],
  );
  counts.ledger = await del(tx, `DELETE FROM ledger WHERE userid IN (${placeholders})`, targets);
  counts.redeems = await del(tx, `DELETE FROM redeems WHERE userid IN (${placeholders})`, targets);
  counts.charity_contributions = await del(
    tx,
    `DELETE FROM charity_contributions WHERE userid IN (${placeholders})`,
    targets,
  );
  counts.redeem_cdks_unlink = await del(
    tx,
    `UPDATE redeem_cdks
     SET redeemed_by = NULL, redeemed_name = NULL
     WHERE redeemed_by IN (${placeholders})`,
    targets,
  );
  counts.user_feedback = await del(tx, `DELETE FROM user_feedback WHERE userid IN (${placeholders})`, targets);
  counts.attendance_reward_records = await del(
    tx,
    `DELETE FROM attendance_reward_records WHERE userid IN (${placeholders})`,
    targets,
  );
  counts.admin_user_roles = await del(tx, `DELETE FROM admin_user_roles WHERE userid IN (${placeholders})`, targets);
  counts.user_dingtalk_profiles = await del(
    tx,
    `DELETE FROM user_dingtalk_profiles WHERE userid IN (${placeholders})`,
    targets,
  );
  const purgedWinners = await tx.all(
    `DELETE FROM gala_round_winners WHERE userid IN (${placeholders}) AND awarded_at IS NULL RETURNING round_id, amount`,
    targets,
  );
  counts.gala_round_winners_unawarded = purgedWinners.length;
  // 删掉的可能正是某轮最后一笔待发奖励：与发放收尾同一口径（没有待发的正数奖励即整轮完成），在同一事务里补标完成。
  // 这些轮次在开头已被这里排他锁住，进行中的到账都已提交、新的到账在等这里，所以下面这条语句的快照
  // 就是最终的待发状态；之后的发放收尾等这里提交后再数，状态已是 granted，条件更新不再生效。
  const touchedRounds = [...new Set(purgedWinners.filter((w) => Number(w.amount) > 0).map((w) => Number(w.round_id)))]
    .sort((a, b) => a - b);
  counts.gala_rounds_completed = 0;
  if (touchedRounds.length > 0) {
    counts.gala_rounds_completed = await del(
      tx,
      `UPDATE gala_rounds r SET status = 'granted', granted_at = unixepoch()
        WHERE r.id = ANY(?::bigint[]) AND r.status = 'drawn'
          AND NOT EXISTS (SELECT 1 FROM gala_round_winners w WHERE w.round_id = r.id AND w.awarded_at IS NULL AND w.amount > 0)`,
      [touchedRounds],
    );
  }
  counts.gala_participants = await del(tx, `DELETE FROM gala_participants WHERE userid IN (${placeholders})`, targets);
  counts.gala_reserved_slots_cancelled = await del(
    tx,
    `UPDATE gala_reserved_slots SET status = 'cancelled', updated_at = unixepoch()
      WHERE userid IN (${placeholders}) AND status = 'pending'`,
    targets,
  );
  // 拍卖在押出价：置为失效并回退竞拍最高价指针（不退款入账，余额随后清零）。
  // 必须在清零余额/删除流水之前完成对账逻辑之外的清理，避免删除用户时结算/退回悬挂外键。
  const auctionPurge = await purgeUserAuctionBids(tx, targets);
  counts.auction_bids_voided = auctionPurge.held_voided;
  counts.auction_activities_reverted = auctionPurge.activities_reverted;

  counts.accounts_zero = await del(
    tx,
    `UPDATE accounts SET balance = 0, updated_at = unixepoch() WHERE userid IN (${placeholders})`,
    targets,
  );

  return { targets, counts };
}

/**
 * 删除用户主档（含业务数据）。accounts/ledger 等有 FK CASCADE，但仍先清无 FK 表。
 */
export async function deleteUsersCompletely(tx, userids, { protectUserids = [] } = {}) {
  const purge = await purgeUserBusinessData(tx, userids, { protectUserids });
  if (!purge.targets.length) {
    return { ...purge, deleted_users: 0 };
  }
  const placeholders = purge.targets.map(() => '?').join(',');
  // accounts 有 ON DELETE CASCADE；无 FK 的表已在 purge 中清理
  const r = await tx.run(`DELETE FROM users WHERE userid IN (${placeholders})`, purge.targets);
  return { ...purge, deleted_users: Number(r?.changes || 0) };
}
