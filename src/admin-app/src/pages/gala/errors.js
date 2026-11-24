export const GALA_VERSION_ERRORS = new Set([
  'invalid_gala_version',
  'gala_data_changed',
  'round_changed',
  'round_no_changed',
]);

function hasFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

const DYNAMIC_ERROR_MESSAGES = {
  pool_budget_insufficient(data) {
    const hasRemaining = hasFiniteNumber(data.remaining);
    const hasRequired = hasFiniteNumber(data.required);
    if (hasRemaining && hasRequired) {
      return `奖池余额不足：剩余 ${data.remaining}，本轮需要 ${data.required}`;
    }
    if (hasRemaining) return `奖池余额不足（剩余 ${data.remaining}）`;
    if (hasRequired) return `奖池余额不足（本轮需要 ${data.required}）`;
    return '奖池余额不足';
  },
  not_enough_participants(data) {
    if (hasFiniteNumber(data.max_draw_count)) {
      return `可抽人数不足，最多还能抽 ${data.max_draw_count} 人`;
    }
    return '可抽人数不足';
  },
  round_no_changed(data) {
    if (hasFiniteNumber(data.next_round_no)) {
      return `轮次号已变化，下一轮应为第 ${data.next_round_no} 轮`;
    }
    return '轮次号已变化，请刷新后重试';
  },
  budget_below_spent(data) {
    const hasSpent = hasFiniteNumber(data.spent);
    const hasMin = hasFiniteNumber(data.min_budget);
    if (hasSpent && hasMin && data.min_budget !== data.spent) {
      return `奖池预算不能低于最低可设预算 ${data.min_budget}（已支出 ${data.spent}，含待发奖励）`;
    }
    if (hasSpent) return `奖池预算不能低于已支出金额（${data.spent}）`;
    if (hasMin) return `奖池预算不能低于最低可设预算（${data.min_budget}）`;
    return '奖池预算不能低于已支出金额';
  },
  budget_below_allocated(data) {
    if (hasFiniteNumber(data.allocated)) {
      return `奖池预算不能低于已分配金额（${data.allocated}）`;
    }
    return '奖池预算不能低于已分配金额';
  },
  pools_exceed_total_budget(data) {
    if (hasFiniteNumber(data.pools_total)) {
      return `奖池预算合计（${data.pools_total}）超出活动总预算`;
    }
    return '奖池预算合计超出活动总预算';
  },
  invalid_userid(data) {
    if (hasFiniteNumber(data.index)) {
      return `第 ${data.index + 1} 行的用户 ID 格式无效`;
    }
    return '用户 ID 格式无效';
  },
};

const STATIC_ERROR_MESSAGES = {
  // 版本与并发
  invalid_gala_version: '页面数据版本无效，请刷新页面后重试',
  gala_data_changed: '年会数据已变更（可能刚执行过备份恢复），请刷新页面后重试',
  round_changed: '轮次数据已变化，请刷新后重试',
  invalid_grant_token: '发币凭据无效，请刷新轮次后重试',
  conflict: '数据发生冲突，请刷新后重试',

  // 活动配置
  title_required: '请填写活动标题',
  invalid_total_budget: '活动总预算必须为非负整数',
  invalid_event_id: '活动 ID 无效',
  event_not_found: '年会活动不存在',
  invalid_status: '活动状态无效',
  invalid_enabled_segments: '启用的环节配置无效',
  event_ended: '活动已结束，不能继续抽签',

  // 分页
  invalid_before_id: '分页参数 before_id 无效',
  invalid_after_id: '分页参数 after_id 无效',
  invalid_limit: '分页条数参数无效',

  // 奖池
  pool_name_required: '请填写奖池名称',
  invalid_budget: '奖池预算必须为非负整数',
  invalid_pool_id: '奖池 ID 无效',
  pool_not_found: '奖池不存在',
  pool_required: '发币轮次必须选择奖池',
  pools_total_too_large: '奖池预算总和超出系统允许上限',
  pool_budget_exceeded: '发币时奖池余额不足，已回滚本笔发放',

  // 参与名单
  invalid_table_no: '桌号必须为正整数',
  invalid_userids: '导入名单格式无效，请传入用户 ID 列表',
  ambiguous_participant_source: '不能同时选择“全部在册员工”和指定名单导入',
  userids_required: '请至少填写一个用户 ID',
  too_many_userids: '单次最多导入 2000 个用户 ID',
  ambiguous_participant_target: '不能同时指定名单记录 ID 和用户 ID',
  invalid_participant_id: '参与名单记录 ID 无效',

  // 环节与抽签
  invalid_segment: '环节标识无效',
  segment_not_drawable: '该环节不支持抽签',
  segment_disabled: '该环节未启用，请先在活动设置中开启后再抽签',
  invalid_draw_count: '抽签人数必须是 1 到 100 之间的整数',
  invalid_exclude_previous_winners: '“排除已中奖者”参数必须为布尔值',
  invalid_prize_type: '奖励类型无效',
  invalid_amount_each: '每人发放金额必须为正整数',
  draw_total_too_large: '本轮发币总金额超出安全上限',
  invalid_round_no: '轮次号无效，必须为正整数',
  round_no_exhausted: '本环节轮次号已达上限，无法继续抽签',

  // 发币
  invalid_round_id: '轮次 ID 无效',
  round_not_found: '抽签轮次不存在',
  round_not_coin: '该轮次不是发币轮，无需发币',
  invalid_winner_userid: '中奖人用户 ID 格式异常，无法自动发币',
  winner_pool_missing: '中奖记录关联的奖池缺失或不可用，无法发币',
  winner_round_mismatch: '中奖记录与所属轮次配置不一致，无法发币',
  ledger_id_unsafe: '账本流水号超出范围，本次发币已回滚',
  award_failed: '发币失败，请稍后重试',

  // 预留名额
  user_not_found: '用户不存在',
  participant_required: '该用户尚未加入本场活动参与名单，请先导入名单',
  reserved_pool_required: '请选择有效的预留奖池',
  round_already_drawn: '该轮次已经抽过，不能再设置预留名额',
  slot_already_exists: '该环节该轮次已有待用的预留名额',
  reserved_slot_limit: '本场活动的预留名额数量已达上限（最多 3 个）',
  already_won_in_segment: '该用户已在本环节中过奖或已有预留名额',
  invalid_slot_id: '预留名额 ID 无效',
  slot_not_pending: '该预留名额不存在或已不再处于待用状态',

  // 路由与通用权限
  internal_error: '服务器内部错误，请稍后重试',
  forbidden: '权限不足，无法执行该操作',
  permission_denied: '权限不足，无法执行该操作',
  'Permission denied': '权限不足，无法执行该操作',
  unauthorized: '登录状态已失效，请重新登录',
};

export function isGalaVersionError(err) {
  return Boolean(err?.code && GALA_VERSION_ERRORS.has(err.code));
}

export function galaErrorText(err) {
  const code = typeof err?.code === 'string' ? err.code.trim() : '';
  if (!code) {
    const msg = typeof err?.message === 'string' ? err.message.trim() : '';
    return msg || '操作失败';
  }
  const data = err?.data && typeof err.data === 'object' ? err.data : {};
  const dynamic = DYNAMIC_ERROR_MESSAGES[code];
  if (dynamic) return dynamic(data);
  if (Object.hasOwn(STATIC_ERROR_MESSAGES, code)) return STATIC_ERROR_MESSAGES[code];
  return `操作失败（错误码：${code}）`;
}
