const errorTextMap = {
  'Permission denied': '权限不足，无法执行该操作',
  permission_denied: '权限不足，无法执行该操作',
  forbidden: '权限不足，无法执行该操作',
  unauthorized: '登录状态已失效，请重新登录',
  'missing id': '缺少记录 ID',
  'feedback not found': '反馈记录不存在',
  'missing content': '请填写内容',
  'content too long': '内容过长',
  'missing userid': '缺少用户 ID',
  'DINGTALK_ROBOT_CODE missing': '钉钉机器人编码未配置，无法发送钉钉消息',
  'DINGTALK_GROUP_OPEN_CONVERSATION_ID missing': '钉钉群会话未配置，无法发送群卡',
  'DINGTALK_GROUP_CARD_TEMPLATE_ID missing': '钉钉群卡片模板未配置，无法发送群卡',
  'DINGTALK_GROUP_CARD_OPERATOR_USERID missing': '钉钉群卡操作人未配置，无法发送群卡',
  'missing openConversationId': '缺少钉钉群会话',
  'missing preset name': '请输入群预设名称',
  notify_disabled: '私聊通知总开关已关闭，无法发送测试',
  notify_event_disabled: '当前通知模板已停用，无法发送测试',
  'empty content': '通知内容为空，无法发送测试',
  'fixed admin cannot be reset': '超级管理员受保护，不能清空业务数据',
  'missing role name': '请输入角色名称',
  '角色不存在或已停用': '角色不存在或已停用',
  'missing product_id': '缺少商品 ID',
  'missing product_name': '缺少商品名称',
  'invalid amount': '金额无效',
  'amount must be positive integer': '金额必须是正整数',
  'insufficient balance': '余额不足',
  'product not found': '商品不存在',
  'product not on sale': '商品未上架',
  'out of stock': '库存不足',
  'purchase_limit_reached': '已达到限购次数',
  'cdk not found': 'CDK 不存在',
  'cdk already redeemed': 'CDK 已兑换',
  'redeemed cdk cannot be deleted': '已兑换的 CDK 不能删除',
  'exchange already redeemed': '该订单已核销',
  'payload mismatch': '核销内容不匹配',
};

function getAdminLoginUrl() {
  const target = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/admin/home';
  return `/admin/login?redirect=${encodeURIComponent(target)}`;
}

function redirectToAdminLogin() {
  if (window.__bobAdminRedirecting) return;
  window.__bobAdminRedirecting = true;
  window.location.replace(getAdminLoginUrl());
}

export function translateErrorMessage(error) {
  const raw = String(error || '').trim();
  if (!raw) return '操作失败';
  if (errorTextMap[raw]) return errorTextMap[raw];
  const lower = raw.toLowerCase();
  if (errorTextMap[lower]) return errorTextMap[lower];
  if (lower.includes('permission denied')) return '权限不足，无法执行该操作';
  if (lower.includes('dingtalk http')) return '钉钉接口返回失败，请检查机器人配置和接收人是否可接收消息';
  if (lower.includes('unauthorized')) return '登录状态已失效，请重新登录';
  if (lower.includes('failed to fetch') || lower.includes('network')) return '网络异常，请稍后重试';
  if (lower.startsWith('http 401')) return '登录状态已失效，请重新登录';
  if (lower.startsWith('http 403')) return '权限不足，无法执行该操作';
  if (lower.startsWith('http 404')) return '请求的资源不存在';
  if (lower.startsWith('http 500')) return '服务器异常，请稍后重试';
  return raw;
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { ...options, headers, body, credentials: 'same-origin' });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401) {
    redirectToAdminLogin();
    throw new Error(translateErrorMessage(data?.error || 'unauthorized'));
  }
  if (!res.ok || data?.ok === false || data?.error) {
    throw new Error(translateErrorMessage(data?.error || `HTTP ${res.status}`));
  }
  return data;
}

export function qs(params = {}) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') sp.set(key, String(value));
  });
  return sp.toString();
}
