/**
 * 用户重置/删除时的关联数据清理（同一事务内调用）。
 * 已有 FK CASCADE 的表仍显式删除，便于返回计数与兼容历史数据。
 */

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
