(function () {
  const currentUrl = window.location.origin + window.location.pathname + window.location.search;

  const fetchJson = window.BOB.fetchJson;
  const escapeHtml = window.BOB.escapeHtml;

  let redeemModalSuccessPending = false;
  let redeemModalBusy = false;

  const mallState = {
    mode: 'self',
    rowsById: new Map(),
    cdkRows: [],
    cdkProducts: [],
    lastGeneratedCdks: [],
    openingRow: null,
    openingAdvancedVisible: false,
    crop: {
      dataUrl: '',
      image: null,
      scale: 1,
      left: 0,
      top: 0,
    },
  };

  const charityState = {
    rows: [],
    rowsById: new Map(),
    contributions: [],
    summary: null,
    crop: {
      dataUrl: '',
      image: null,
      scale: 1,
      left: 0,
      top: 0,
    },
  };

  const auditLogState = {
    auto: false,
    timer: null,
  };

  const attendanceStatusState = {
    rows: [],
    activeDate: '',
    detailRows: [],
  };

  const contentState = {
    faq: [],
    announcements: [],
    feedback: [],
    versions: [],
  };

  const notifyState = {
    templates: {},
    activeTemplate: 'grant',
    testCandidates: [],
    testTarget: null,
    testSearchTimer: null,
    testSearchSeq: 0,
  };

  const defaultNotifyTemplates = {
    grant: {
      enabled: true,
      title: '【BOB币中心】恭喜你！{{name}}',
      content: '类型：收入\n原因：{{reason}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币',
    },
    deduct: {
      enabled: true,
      title: '【BOB币中心】余额变动通知 {{name}}',
      content: '类型：支出\n原因：{{reason}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币\n单号：{{exchange_id}}',
    },
    redeem: {
      enabled: true,
      title: '【BOB币中心】核销完成 {{name}}',
      content: '商品：{{product_name}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币\n订单号：{{exchange_id}}',
    },
    mall_buy: {
      enabled: true,
      title: '【BOB币中心】下单成功 {{name}}',
      content: '商品：{{product_name}}\n价格：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币\n请尽快联系工作人员线下核销',
    },
    transfer_out: {
      enabled: true,
      title: '【BOB币中心】转账成功 {{name}}',
      content: '转出给：{{to_name}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币',
    },
    transfer_in: {
      enabled: true,
      title: '【BOB币中心】转账到账 {{name}}',
      content: '来自：{{from_name}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币',
    },
    red_packet: {
      enabled: true,
      title: '【BOB币中心】红包到账 {{name}}',
      content: '金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币\n活动ID：{{activity_id}}',
    },
    charity: {
      enabled: true,
      title: '【BOB币中心】公益助力成功 {{name}}',
      content: '类型：支出\n项目：{{project_name}}\n金额：{{amount}} BOB 币\n当前余额：{{balance}} BOB 币',
    },
  };

  const groupCardState = {
    channel: {},
    templates: {},
    activeTemplate: 'manual',
  };

  const groupCardConversationPresets = [
    { label: 'BOB大群', value: 'cidxEY0ywSnrjDytDeXzEscwg==' },
    { label: '测试群', value: 'cidGgW6mYLsdUyYN4rIuPvgYw==' },
  ];

  function getDefaultGroupCardChannel() {
    return {
      openConversationId: '',
      cardTemplateId: '',
      operatorUserid: '',
      broadcastAll: false,
      recipients: [],
      titleKey: '',
      contentKey: '',
      searchIcon: '',
    };
  }

  let globalToastTimer = null;

  function genMallProductId() {
    const base = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    const id = `P${base}`;
    if (mallState?.rowsById?.has && mallState.rowsById.has(id)) {
      return `P${base}${Math.random().toString(36).slice(2, 4)}`.toUpperCase();
    }
    return id;
  }

  function decodeBase64UrlToText(encoded) {
    const raw = String(encoded || '').replaceAll('-', '+').replaceAll('_', '/');
    const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
    const bin = atob(raw + pad);
    try {
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch (_) {
      return bin;
    }
  }

  function parseEncodedPayload(encoded) {
    const text = decodeBase64UrlToText(encoded);
    const data = JSON.parse(text);
    const payload = data?.payload;
    if (!payload || typeof payload !== 'object') {
      throw new Error('missing fields');
    }
    return payload;
  }

  function tryParseEncodedPayload(encoded) {
    try {
      return parseEncodedPayload(encoded);
    } catch (_) {
      return null;
    }
  }

  function setRedeemModalVisible(on) {
    const modal = document.getElementById('redeemModal');
    if (!modal) return;
    if (on) modal.classList.remove('hidden');
    else modal.classList.add('hidden');
  }

  function setRedeemModalField(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value || '-';
  }

  function setRedeemModalToast(text, isError) {
    const el = document.getElementById('redeemModalToast');
    if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.style.color = isError ? '#b00020' : 'inherit';
    el.textContent = String(text || '');
  }

  function closeRedeemModal() {
    if (redeemModalBusy) {
      return;
    }
    if (redeemModalSuccessPending) {
      redeemModalSuccessPending = false;
      document.getElementById('confirmEncoded').value = '';
      setConfirmText('');
      stopCamera();
    }
    setRedeemModalVisible(false);
    setRedeemModalToast('', false);
  }

  function openRedeemModalFromEncoded(encoded, { showError } = {}) {
    if (redeemModalSuccessPending) {
      return null;
    }
    const v = String(encoded || '').trim();
    if (!v) {
      closeRedeemModal();
      return null;
    }

    const payload = tryParseEncodedPayload(v);
    if (!payload) {
      if (showError) {
        const encodedBox = document.getElementById('redeemModalEncoded');
        if (encodedBox) encodedBox.textContent = v;
        setRedeemModalField('redeemModalUserid', '-');
        setRedeemModalField('redeemModalExchange', '-');
        setRedeemModalField('redeemModalProduct', '-');
        setRedeemModalField('redeemModalAmount', '-');
        const confirmBtn = document.getElementById('btnRedeemModalConfirm');
        if (confirmBtn) confirmBtn.disabled = true;
        setRedeemModalToast('二维码内容无效：无法解析', true);
        setRedeemModalVisible(true);
      } else {
        closeRedeemModal();
      }
      return null;
    }

    const userid = payload.userid ? String(payload.userid) : '';
    const exchangeId = payload.exchange_id ? String(payload.exchange_id) : '';
    const productId = payload.product_id ? String(payload.product_id) : '';
    const productName = payload.product_name ? String(payload.product_name) : '';
    const bobAmount = payload.bob_amount === null || payload.bob_amount === undefined ? '' : String(payload.bob_amount);
    const productText = productName && productId ? `${productName} (${productId})` : (productName || productId);

    setRedeemModalField('redeemModalUserid', userid);
    setRedeemModalField('redeemModalExchange', exchangeId);
    setRedeemModalField('redeemModalProduct', productText);
    setRedeemModalField('redeemModalAmount', bobAmount);

    const encodedBox = document.getElementById('redeemModalEncoded');
    if (encodedBox) encodedBox.textContent = v;

    const confirmBtn = document.getElementById('btnRedeemModalConfirm');
    if (confirmBtn) confirmBtn.disabled = false;

    setRedeemModalToast('', false);
    setRedeemModalVisible(true);

    return { encoded: v, userid, exchangeId, productText, bobAmount };
  }

  function humanizeRedeemError(message) {
    const m = String(message || '');
    if (!m) return '核销失败';
    const map = {
      'missing exchange_id': '二维码无效：缺少兑换单号',
      'missing userid': '二维码无效：缺少用户信息',
      'missing product_id': '二维码无效：缺少商品信息',
      'bob_amount must be positive integer': '二维码无效：扣减数量不正确',
      'insufficient balance': '余额不足，无法核销',
      'exchange already redeemed': '该兑换单已核销过',
      'payload mismatch': '二维码无效：订单信息不匹配',
    };
    return map[m] || m;
  }

  function setConfirmText(text, isError) {
    const el = document.getElementById('outConfirm');
    if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.style.color = isError ? '#b00020' : 'inherit';
    el.textContent = String(text || '');
  }

  function showRedeemResult(resp) {
    const status = Number(resp?.status) || 0;
    const data = resp?.data;
    if (data?.ok) {
      const userid = data?.userid ? String(data.userid) : '';
      const exchangeId = data?.exchange_id ? String(data.exchange_id) : '';
      const balance = Number(data?.balance);
      const balanceText = Number.isFinite(balance) ? String(balance) : '-';
      return { ok: true, text: `核销成功\n\n用户：${userid || '-'}\n兑换单号：${exchangeId || '-'}\n剩余余额：${balanceText}` };
    }

    const msg = humanizeRedeemError(data?.error || (status ? `HTTP ${status}` : ''));
    return { ok: false, text: `核销失败：${msg}` };
  }

  function safeText(value) {
    if (typeof escapeHtml === 'function') {
      return escapeHtml(String(value || ''));
    }
    return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  function setMallToast(text, isError) {
    const el = document.getElementById('mallAiToast');
    if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.style.color = isError ? '#b00020' : 'inherit';
    el.textContent = String(text || '');
  }

  function setCdkToast(text, isError) {
    const el = document.getElementById('cdkToast');
    if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.style.color = isError ? '#b00020' : 'inherit';
    el.textContent = String(text || '');
  }

  function setCdkErr(text) {
    const el = document.getElementById('cdkErr');
    if (!el) return;
    el.textContent = String(text || '');
  }

  function setCharityToast(text, isError) {
    const el = document.getElementById('charityProjectToast');
    if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.style.color = isError ? '#b00020' : 'inherit';
    el.textContent = String(text || '');
  }

  function setCharityErr(text) {
    const el = document.getElementById('charityProjectErr');
    if (!el) return;
    el.textContent = String(text || '');
  }

  function setCharityContributionErr(text) {
    const el = document.getElementById('charityContributionErr');
    if (!el) return;
    el.textContent = String(text || '');
  }

  function setCharityProjectModalVisible(on) {
    const modal = document.getElementById('charityProjectModal');
    if (!modal) return;
    modal.classList.toggle('hidden', !on);
  }

  function setCharityProjectModalErr(text) {
    const el = document.getElementById('charityProjectModalErr');
    if (!el) return;
    el.textContent = String(text || '');
  }

  function genCharityProjectId() {
    const base = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
    const id = `CHARITY_${base}`;
    if (charityState.rowsById.has(id)) {
      return `${id}_${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
    }
    return id;
  }

  function setGroupCardOut(text, isError) {
    const out = document.getElementById('groupCardOut');
    if (out) {
      out.style.whiteSpace = 'pre-wrap';
      out.style.color = isError ? '#b00020' : 'inherit';
      out.textContent = String(text || '');
    }
    const err = document.getElementById('groupCardErr');
    if (err) {
      err.textContent = isError ? String(text || '') : '';
    }
  }

  function setAuditLogToast(text, isError) {
    const el = document.getElementById('auditLogToast');
    if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.style.color = isError ? '#b00020' : 'inherit';
    el.textContent = String(text || '');
  }

  function setSimpleText(id, text, isError) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.style.color = isError ? '#b00020' : 'inherit';
    el.textContent = String(text || '');
  }

  function setAttendanceStatusToast(text, isError) {
    setSimpleText('attendanceStatusToast', text, isError);
  }

  function setAttendanceStatusErr(text) {
    setSimpleText('attendanceStatusErr', text, true);
  }

  function setAttendanceStatusDetailVisible(on) {
    const modal = document.getElementById('attendanceStatusDetailModal');
    if (!modal) return;
    modal.classList.toggle('hidden', !on);
  }

  function stopAuditLogAutoRefresh() {
    if (auditLogState.timer) {
      clearInterval(auditLogState.timer);
      auditLogState.timer = null;
    }
  }

  function startAuditLogAutoRefresh() {
    stopAuditLogAutoRefresh();
    if (!auditLogState.auto) return;
    auditLogState.timer = setInterval(() => {
      const tab = document.getElementById('tabSettings');
      if (!tab || !tab.classList.contains('active')) return;
      loadAuditLogs();
    }, 5000);
  }

  async function loadAuditLogs() {
    const stat = document.getElementById('auditLogStat');
    const tbody = document.getElementById('auditLogTable');
    if (!stat || !tbody) return;
    stat.textContent = '加载中…';
    setAuditLogToast('', false);
    const r = await fetchJson('/admin/logs?days=30');
    if (!r?.data?.ok) {
      stat.textContent = '加载失败';
      setAuditLogToast(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '加载失败'), true);
      tbody.innerHTML = '';
      return;
    }
    const rows = Array.isArray(r.data?.data) ? r.data.data : [];
    if (!rows.length) {
      stat.textContent = '暂无日志';
      tbody.innerHTML = '<tr><td colspan="7" class="muted">暂无日志</td></tr>';
      return;
    }
    const eventTypeMap = {
      request: '接口请求',
      admin_login_success: '管理员登录',
      admin_login_failed: '管理员登录失败',
      admin_logout: '管理员退出',
      attendance_reward: '打卡奖励',
      attendance_skip: '打卡未奖励',
    };
    const requestActionMap = {
      'GET /admin/login': '打开管理员登录页',
      'POST /admin/login': '管理员登录',
      'POST /admin/logout': '管理员退出登录',
      'GET /admin/home': '加载后台首页',
      'GET /admin/me': '获取当前管理员信息',
      'GET /admin/config': '获取后台配置',
      'GET /admin/auth': '获取鉴权信息',
      'GET /admin/logs': '查看系统日志',
      'GET /admin/settings/notify': '查看通知配置',
      'POST /admin/settings/notify': '更新通知配置',
      'POST /admin/settings/notify/test': '测试通知发送',
      'GET /admin/settings/group-card': '查看群名片配置',
      'POST /admin/settings/group-card': '更新群名片配置',
      'POST /admin/settings/group-card/test': '测试群名片同步',
      'GET /admin/settings/attendance-reward': '查看考勤奖励配置',
      'POST /admin/settings/attendance-reward': '更新考勤奖励配置',
      'GET /admin/redeem/history': '查看兑换历史',
      'GET /admin/redeem/pending': '查看待处理兑换',
      'POST /admin/redeem/confirm': '确认兑换发放',
      'POST /admin/redeem/history/clear': '清空兑换历史',
      'POST /admin/redeem/history/delete': '删除兑换记录',
      'POST /admin/redeem/deduct-batch': '批量扣减余额',
      'GET /admin/users': '查看用户列表',
      'POST /admin/users/sync': '同步用户数据',
      'POST /admin/users/set-admin': '设置管理员权限',
      'POST /admin/users/delete': '删除用户',
      'POST /admin/users/notify': '发送用户通知',
      'GET /admin/content/faq': '查看常见问题',
      'POST /admin/content/faq/save': '保存常见问题',
      'POST /admin/content/faq/delete': '删除常见问题',
      'GET /admin/content/announcements': '查看公告',
      'POST /admin/content/announcements/save': '保存公告',
      'POST /admin/content/announcements/delete': '删除公告',
      'GET /admin/content/feedback': '查看反馈',
      'POST /admin/content/feedback/handle': '处理反馈',
      'GET /admin/content/version': '查看版本信息',
      'POST /admin/content/version/save': '保存版本信息',
      'GET /admin/mall/opening': '查看商城开场设置',
      'POST /admin/mall/opening': '更新商城开场设置',
      'POST /admin/mall/opening/open-now': '立即开场',
      'POST /admin/mall/opening/close-now': '立即闭场',
      'GET /admin/mall/self/products': '查看自营商品',
      'POST /admin/mall/self/products': '保存自营商品',
      'POST /admin/mall/self/products/delete': '删除自营商品',
      'GET /admin/charity/projects': '查看公益项目',
      'POST /admin/charity/projects/save': '保存公益项目',
      'GET /admin/charity/contributions': '查看公益助力记录',
      'POST /mall/cdk/preview': '预览CDK兑换商品',
      'POST /mall/cdk/redeem': '提交CDK兑换',
      'GET /mall/cdk/info': '查看CDK兑换信息',
      'GET /mall/charity/projects': '查看公益区项目',
      'GET /mall/charity/project': '查看公益项目详情',
      'POST /mall/charity/contribute': '提交公益助力',
      'GET /admin/cdks/products': '查看可兑换商品',
      'GET /admin/cdks': '查看CDK列表',
      'POST /admin/cdks/generate': '生成CDK',
      'POST /admin/cdks/delete': '删除CDK',
      'GET /admin/mall/aitable/products': '拉取飞书商品',
      'GET /admin/red-packet/status': '查看红包状态',
      'POST /admin/red-packet/start': '发放红包',
      'GET /admin/red-packet/history': '查看红包记录',
      'POST /admin/red-packet/history/clear': '清空红包记录',
      'POST /admin/red-packet/history/delete': '删除红包记录',
      'POST /admin/notify/group-card': '推送群名片通知',
      'POST /admin/ledger/grant-batch': '批量发放积分',
      'POST /admin/data/reset-user': '重置用户数据',
      'POST /admin/data/reset-all': '重置全量数据',
      'GET /admin/backup/export': '导出备份',
      'POST /admin/backup/import': '导入备份',
    };
    const actorTypeMap = {
      admin: '管理员',
      user: '用户',
      anonymous: '匿名',
      system: '系统',
    };
    const parsePayload = (row) => {
      const raw = row?.payload;
      if (!raw) return null;
      if (typeof raw === 'object') return raw;
      try {
        return JSON.parse(String(raw));
      } catch {
        return null;
      }
    };
    const getRequestDuration = (message) => {
      const text = message ? String(message) : '';
      const match = text.match(/耗时\s*(\d+)\s*ms/i);
      return match ? Number(match[1]) : null;
    };
    const getStatusLabel = (statusCode) => {
      const code = Number(statusCode);
      if (!Number.isFinite(code)) return '';
      if (code >= 200 && code < 300) return '成功';
      if (code >= 400 && code < 500) return '失败';
      if (code >= 500) return '异常';
      return String(code);
    };
    const toRequestAction = (row) => {
      const method = row?.method ? String(row.method).toUpperCase() : '';
      const rawPath = row?.path ? String(row.path) : '';
      const pathname = rawPath.split('?')[0] || rawPath;
      const key = `${method} ${pathname}`;
      return requestActionMap[key] || '';
    };
    const toRedeemConfirmMessage = (row) => {
      const payload = parsePayload(row);
      if (!payload) return '';
      const name = payload.productName || payload.product_name;
      const amount = payload.bobAmount ?? payload.bob_amount;
      const parts = [];
      if (name) parts.push(String(name));
      if (Number.isFinite(Number(amount))) parts.push(`扣${Number(amount)}BOB`);
      if (!parts.length) return '';
      return `确认兑换：${parts.join('，')}`;
    };
    const getAttendanceTags = (row) => {
      const payload = parsePayload(row);
      const reason = payload?.reason ? String(payload.reason) : '';
      if (row?.event_type === 'attendance_reward') {
        return [{ label: '已奖励', className: 'pillOk' }];
      }
      if (row?.event_type !== 'attendance_skip') return [];
      if (reason === 'late') {
        return [{ label: '迟到', className: 'pillBad' }];
      }
      if (reason === 'off_duty_ignored') {
        return [
          { label: '下班打卡', className: 'pillWarn' },
          { label: '已忽略', className: 'pillInfo' },
        ];
      }
      if (reason === 'max_per_day') {
        return [{ label: '次数已满', className: 'pillInfo' }];
      }
      return [{ label: '未奖励', className: 'pill' }];
    };
    const toZhMessage = (row) => {
      const msg = row?.message ? String(row.message) : '';
      if (row?.event_type === 'request') {
        const action = toRequestAction(row);
        const statusLabel = getStatusLabel(row?.status_code);
        const duration = getRequestDuration(msg);
        const tail = [
          statusLabel ? `状态：${statusLabel}` : '',
          duration !== null ? `耗时：${duration}ms` : '',
        ].filter(Boolean).join('，');
        const redeemConfirmMessage = toRedeemConfirmMessage(row);
        if (redeemConfirmMessage) return tail ? `${redeemConfirmMessage}（${tail}）` : redeemConfirmMessage;
        if (action) return tail ? `${action}（${tail}）` : action;
        return tail ? `接口调用（${tail}）` : '接口调用';
      }
      if (msg === 'admin login success') return '管理员登录成功';
      if (msg === 'admin logout') return '管理员退出登录';
      if (msg.includes('missing username or password')) return '管理员登录失败：缺少用户名或密码';
      if (msg.includes('invalid password')) return '管理员登录失败：账号或密码错误';
      return msg || '-';
    };
    const renderAuditLogMessage = (row) => {
      const message = toZhMessage(row);
      const tags = getAttendanceTags(row);
      const tagsHtml = tags.length
        ? `<div class="audit-log-tags">${tags.map((tag) => `<span class="pill ${safeText(tag.className || '')}">${safeText(tag.label || '')}</span>`).join('')}</div>`
        : '';
      return `<div class="audit-log-entry">${tagsHtml}<div>${safeText(message)}</div></div>`;
    };

    tbody.innerHTML = rows
      .map((x) => {
        const ts = formatTs(x?.created_at);
        const eventTypeRaw = x?.event_type ? String(x.event_type) : '-';
        const eventType = eventTypeMap[eventTypeRaw] || eventTypeRaw;
        const actorType = x?.actor_type ? String(x.actor_type) : '';
        const actorId = x?.actor_id ? String(x.actor_id) : '';
        const actorName = x?.actor_name ? String(x.actor_name) : '';
        const actor = actorName ? `${actorName} (${actorId || '-'})` : (actorId || '-');
        const actorTypeText = actorTypeMap[actorType] || actorType;
        const ip = x?.ip ? String(x.ip) : '-';
        const method = x?.method ? String(x.method).toUpperCase() : '';
        const path = x?.path ? String(x.path) : '';
        const status = x?.status_code === null || x?.status_code === undefined ? '-' : String(x.status_code);
        const messageHtml = renderAuditLogMessage(x);
        return `<tr>
          <td class="muted">${safeText(ts)}</td>
          <td>${safeText(eventType)}</td>
          <td>${safeText(actorTypeText ? `${actorTypeText}:${actor}` : actor)}</td>
          <td class="mono">${safeText(ip)}</td>
          <td>${safeText(status)}</td>
          <td class="mono">${safeText([method, path].filter(Boolean).join(' '))}</td>
          <td class="audit-log-message">${messageHtml}</td>
        </tr>`;
      })
      .join('');
    const days = Number(r?.data?.days || 30);
    stat.textContent = `已加载近 ${days} 天内的 ${rows.length} 条日志`;
  }

  function resetFaqForm() {
    if (document.getElementById('faqId')) document.getElementById('faqId').value = '';
    if (document.getElementById('faqQuestion')) document.getElementById('faqQuestion').value = '';
    if (document.getElementById('faqAnswer')) document.getElementById('faqAnswer').value = '';
    if (document.getElementById('faqSort')) document.getElementById('faqSort').value = '0';
    const enabled = document.getElementById('faqEnabled');
    if (enabled) enabled.checked = true;
    setSimpleText('faqErr', '', false);
    setSimpleText('faqToast', '', false);
  }

  function fillFaqForm(row) {
    if (!row) return;
    if (document.getElementById('faqId')) document.getElementById('faqId').value = String(row?.id || '');
    if (document.getElementById('faqQuestion')) document.getElementById('faqQuestion').value = row?.question ? String(row.question) : '';
    if (document.getElementById('faqAnswer')) document.getElementById('faqAnswer').value = row?.answer ? String(row.answer) : '';
    if (document.getElementById('faqSort')) document.getElementById('faqSort').value = String(Number(row?.sort ?? 0));
    const enabled = document.getElementById('faqEnabled');
    if (enabled) enabled.checked = Number(row?.is_enabled) === 1;
  }

  function renderFaqTable(rows) {
    const tbody = document.getElementById('faqTable');
    if (!tbody) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">暂无 FAQ</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((x) => {
      const id = Number(x?.id || 0);
      const statusText = Number(x?.is_enabled) === 1
        ? '<span class="pill pillOk">启用</span>'
        : '<span class="pill pillBad">停用</span>';
      return `<tr>
        <td class="muted">${safeText(String(id || '-'))}</td>
        <td>${safeText(x?.question ? String(x.question) : '-')}</td>
        <td>${safeText(String(Number(x?.sort ?? 0)))}</td>
        <td>${statusText}</td>
        <td>
          <button class="secondary" data-faq-edit="${safeText(String(id))}" type="button">编辑</button>
          <button class="secondary" data-faq-delete="${safeText(String(id))}" type="button">删除</button>
        </td>
      </tr>`;
    }).join('');
  }

  async function loadFaqList() {
    setSimpleText('faqToast', '加载中…', false);
    const r = await fetchJson('/admin/content/faq?limit=200');
    if (!r?.data?.ok) {
      setSimpleText('faqErr', r?.data?.error || '加载失败', true);
      renderFaqTable([]);
      return;
    }
    contentState.faq = Array.isArray(r.data?.data) ? r.data.data : [];
    renderFaqTable(contentState.faq);
    setSimpleText('faqErr', '', false);
    setSimpleText('faqToast', `已加载 ${contentState.faq.length} 条`, false);
  }

  async function saveFaq() {
    const id = document.getElementById('faqId')?.value ? String(document.getElementById('faqId').value).trim() : '';
    const question = document.getElementById('faqQuestion')?.value ? String(document.getElementById('faqQuestion').value).trim() : '';
    const answer = document.getElementById('faqAnswer')?.value ? String(document.getElementById('faqAnswer').value).trim() : '';
    const sortText = document.getElementById('faqSort')?.value ? String(document.getElementById('faqSort').value).trim() : '0';
    const sort = Number.isFinite(Number(sortText)) ? Math.floor(Number(sortText)) : 0;
    const isEnabled = document.getElementById('faqEnabled')?.checked === true;
    if (!question || !answer) {
      setSimpleText('faqErr', '问题和答案不能为空', true);
      return;
    }
    setSimpleText('faqErr', '', false);
    const r = await fetchJson('/admin/content/faq/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id || null, question, answer, sort, is_enabled: isEnabled }),
    });
    if (!r?.data?.ok) {
      setSimpleText('faqErr', r?.data?.error || '保存失败', true);
      return;
    }
    setSimpleText('faqToast', 'FAQ 已保存', false);
    resetFaqForm();
    await loadFaqList();
  }

  async function deleteFaq(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    if (!window.confirm(`确认删除 FAQ #${n} 吗？`)) return;
    const r = await fetchJson('/admin/content/faq/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: n }),
    });
    if (!r?.data?.ok) {
      setSimpleText('faqErr', r?.data?.error || '删除失败', true);
      return;
    }
    await loadFaqList();
  }

  function resetAnnouncementForm() {
    if (document.getElementById('announcementId')) document.getElementById('announcementId').value = '';
    if (document.getElementById('announcementTitle')) document.getElementById('announcementTitle').value = '';
    if (document.getElementById('announcementContent')) document.getElementById('announcementContent').value = '';
    if (document.getElementById('announcementSort')) document.getElementById('announcementSort').value = '0';
    if (document.getElementById('announcementPublishAt')) document.getElementById('announcementPublishAt').value = '';
    if (document.getElementById('announcementLevel')) document.getElementById('announcementLevel').value = 'info';
    const enabled = document.getElementById('announcementEnabled');
    if (enabled) enabled.checked = true;
    setSimpleText('announcementErr', '', false);
  }

  function fillAnnouncementForm(row) {
    if (!row) return;
    if (document.getElementById('announcementId')) document.getElementById('announcementId').value = String(row?.id || '');
    if (document.getElementById('announcementTitle')) document.getElementById('announcementTitle').value = row?.title ? String(row.title) : '';
    if (document.getElementById('announcementContent')) document.getElementById('announcementContent').value = row?.content ? String(row.content) : '';
    if (document.getElementById('announcementSort')) document.getElementById('announcementSort').value = String(Number(row?.sort ?? 0));
    if (document.getElementById('announcementPublishAt')) document.getElementById('announcementPublishAt').value = toDateTimeLocalValue(row?.publish_at);
    if (document.getElementById('announcementLevel')) document.getElementById('announcementLevel').value = row?.level ? String(row.level) : 'info';
    const enabled = document.getElementById('announcementEnabled');
    if (enabled) enabled.checked = Number(row?.is_enabled) === 1;
  }

  function renderAnnouncementTable(rows) {
    const tbody = document.getElementById('announcementTable');
    if (!tbody) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">暂无公告</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((x) => {
      const id = Number(x?.id || 0);
      const enabledText = Number(x?.is_enabled) === 1
        ? '<span class="pill pillOk">启用</span>'
        : '<span class="pill pillBad">停用</span>';
      return `<tr>
        <td class="muted">${safeText(String(id || '-'))}</td>
        <td>${safeText(x?.title ? String(x.title) : '-')}</td>
        <td><span class="pill">${safeText(x?.level ? String(x.level) : 'info')}</span></td>
        <td>${enabledText}</td>
        <td>
          <button class="secondary" data-announcement-edit="${safeText(String(id))}" type="button">编辑</button>
          <button class="secondary" data-announcement-delete="${safeText(String(id))}" type="button">删除</button>
        </td>
      </tr>`;
    }).join('');
  }

  async function loadAnnouncementList() {
    setSimpleText('announcementToast', '加载中…', false);
    const r = await fetchJson('/admin/content/announcements?limit=120');
    if (!r?.data?.ok) {
      setSimpleText('announcementErr', r?.data?.error || '加载失败', true);
      renderAnnouncementTable([]);
      return;
    }
    contentState.announcements = Array.isArray(r.data?.data) ? r.data.data : [];
    renderAnnouncementTable(contentState.announcements);
    setSimpleText('announcementErr', '', false);
    setSimpleText('announcementToast', `已加载 ${contentState.announcements.length} 条`, false);
  }

  async function saveAnnouncement() {
    const id = document.getElementById('announcementId')?.value ? String(document.getElementById('announcementId').value).trim() : '';
    const title = document.getElementById('announcementTitle')?.value ? String(document.getElementById('announcementTitle').value).trim() : '';
    const content = document.getElementById('announcementContent')?.value ? String(document.getElementById('announcementContent').value).trim() : '';
    const level = document.getElementById('announcementLevel')?.value ? String(document.getElementById('announcementLevel').value) : 'info';
    const sortText = document.getElementById('announcementSort')?.value ? String(document.getElementById('announcementSort').value).trim() : '0';
    const sort = Number.isFinite(Number(sortText)) ? Math.floor(Number(sortText)) : 0;
    const publishAt = fromDateTimeLocalValue(document.getElementById('announcementPublishAt')?.value);
    const isEnabled = document.getElementById('announcementEnabled')?.checked === true;
    if (!title || !content) {
      setSimpleText('announcementErr', '标题和内容不能为空', true);
      return;
    }
    const r = await fetchJson('/admin/content/announcements/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id || null, title, content, level, sort, publish_at: publishAt, is_enabled: isEnabled }),
    });
    if (!r?.data?.ok) {
      setSimpleText('announcementErr', r?.data?.error || '保存失败', true);
      return;
    }
    setSimpleText('announcementErr', '', false);
    setSimpleText('announcementToast', '公告已保存', false);
    resetAnnouncementForm();
    await loadAnnouncementList();
  }

  async function deleteAnnouncement(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    if (!window.confirm(`确认删除公告 #${n} 吗？`)) return;
    const r = await fetchJson('/admin/content/announcements/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: n }),
    });
    if (!r?.data?.ok) {
      setSimpleText('announcementErr', r?.data?.error || '删除失败', true);
      return;
    }
    await loadAnnouncementList();
  }

  function renderFeedbackTable(rows) {
    const tbody = document.getElementById('feedbackTable');
    if (!tbody) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">暂无反馈</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((x) => {
      const id = Number(x?.id || 0);
      const userid = x?.userid ? String(x.userid) : '';
      const name = x?.name ? String(x.name) : '';
      const userText = name ? `${name} (${userid})` : (userid || '-');
      const category = x?.category ? String(x.category) : 'suggestion';
      const status = x?.status ? String(x.status) : 'pending';
      const reply = x?.reply ? String(x.reply) : '';
      const categoryText = category === 'bug'
        ? '问题'
        : (category === 'question' ? '咨询' : (category === 'rule' ? '规则' : (category === 'other' ? '其他' : '建议')));
      const statusPill = status === 'resolved'
        ? '<span class="pill pillOk">已处理</span>'
        : (status === 'rejected' ? '<span class="pill pillBad">已驳回</span>' : `<span class="pill">${safeText(status === 'processing' ? '处理中' : '待处理')}</span>`);
      return `<tr>
        <td class="muted">${safeText(String(id || '-'))}</td>
        <td>${safeText(userText)}</td>
        <td><span class="pill">${safeText(categoryText)}</span></td>
        <td>${safeText(x?.content ? String(x.content) : '-')}</td>
        <td>${statusPill}</td>
        <td>
          <select data-feedback-status="${safeText(String(id))}">
            <option value="pending"${status === 'pending' ? ' selected' : ''}>待处理</option>
            <option value="processing"${status === 'processing' ? ' selected' : ''}>处理中</option>
            <option value="resolved"${status === 'resolved' ? ' selected' : ''}>已处理</option>
            <option value="rejected"${status === 'rejected' ? ' selected' : ''}>已驳回</option>
          </select>
          <input data-feedback-reply="${safeText(String(id))}" value="${safeText(reply)}" placeholder="回复（可选）" />
          <button class="secondary" data-feedback-handle="${safeText(String(id))}" type="button">保存</button>
        </td>
      </tr>`;
    }).join('');
  }

  async function loadFeedbackList() {
    setSimpleText('feedbackToast', '加载中…', false);
    const keyword = document.getElementById('feedbackKeyword')?.value ? String(document.getElementById('feedbackKeyword').value).trim() : '';
    const status = document.getElementById('feedbackStatusFilter')?.value ? String(document.getElementById('feedbackStatusFilter').value) : '';
    const qs = new URLSearchParams();
    qs.set('limit', '200');
    if (keyword) qs.set('keyword', keyword);
    if (status) qs.set('status', status);
    const r = await fetchJson(`/admin/content/feedback?${qs.toString()}`);
    if (!r?.data?.ok) {
      setSimpleText('feedbackErr', r?.data?.error || '加载失败', true);
      renderFeedbackTable([]);
      return;
    }
    contentState.feedback = Array.isArray(r.data?.data) ? r.data.data : [];
    renderFeedbackTable(contentState.feedback);
    setSimpleText('feedbackErr', '', false);
    setSimpleText('feedbackToast', `已加载 ${contentState.feedback.length} 条`, false);
  }

  async function handleFeedback(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    const statusEl = document.querySelector(`[data-feedback-status="${String(n)}"]`);
    const replyEl = document.querySelector(`[data-feedback-reply="${String(n)}"]`);
    const status = statusEl?.value ? String(statusEl.value) : 'pending';
    const reply = replyEl?.value ? String(replyEl.value).trim() : '';
    const r = await fetchJson('/admin/content/feedback/handle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: n, status, reply }),
    });
    if (!r?.data?.ok) {
      setSimpleText('feedbackErr', r?.data?.error || '保存失败', true);
      return;
    }
    setSimpleText('feedbackErr', '', false);
    setSimpleText('feedbackToast', `反馈 #${n} 已更新`, false);
    await loadFeedbackList();
  }

  function resetVersionForm() {
    if (document.getElementById('versionId')) document.getElementById('versionId').value = '';
    if (document.getElementById('versionName')) document.getElementById('versionName').value = '';
    if (document.getElementById('versionNotes')) document.getElementById('versionNotes').value = '';
    if (document.getElementById('versionPublishAt')) document.getElementById('versionPublishAt').value = '';
    const enabled = document.getElementById('versionEnabled');
    if (enabled) enabled.checked = true;
    setSimpleText('versionErr', '', false);
  }

  function fillVersionForm(row) {
    if (!row) return;
    if (document.getElementById('versionId')) document.getElementById('versionId').value = String(row?.id || '');
    if (document.getElementById('versionName')) document.getElementById('versionName').value = row?.version_name ? String(row.version_name) : '';
    if (document.getElementById('versionNotes')) document.getElementById('versionNotes').value = row?.release_notes ? String(row.release_notes) : '';
    if (document.getElementById('versionPublishAt')) document.getElementById('versionPublishAt').value = toDateTimeLocalValue(row?.publish_at);
    const enabled = document.getElementById('versionEnabled');
    if (enabled) enabled.checked = Number(row?.is_enabled) === 1;
  }

  function renderVersionTable(rows) {
    const tbody = document.getElementById('versionTable');
    if (!tbody) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">暂无版本信息</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((x) => {
      const id = Number(x?.id || 0);
      const statusText = Number(x?.is_enabled) === 1
        ? '<span class="pill pillOk">启用</span>'
        : '<span class="pill pillBad">停用</span>';
      const publishAt = formatTs(x?.publish_at);
      return `<tr>
        <td class="muted">${safeText(String(id || '-'))}</td>
        <td>${safeText(x?.version_name ? String(x.version_name) : '-')}</td>
        <td>${statusText}</td>
        <td>${safeText(publishAt || '-')}</td>
        <td><button class="secondary" data-version-edit="${safeText(String(id))}" type="button">编辑</button></td>
      </tr>`;
    }).join('');
  }

  async function loadVersionList() {
    setSimpleText('versionToast', '加载中…', false);
    const r = await fetchJson('/admin/content/version');
    if (!r?.data?.ok) {
      setSimpleText('versionErr', r?.data?.error || '加载失败', true);
      renderVersionTable([]);
      return;
    }
    contentState.versions = Array.isArray(r.data?.data) ? r.data.data : [];
    renderVersionTable(contentState.versions);
    setSimpleText('versionErr', '', false);
    setSimpleText('versionToast', `已加载 ${contentState.versions.length} 条`, false);
  }

  async function saveVersion() {
    const id = document.getElementById('versionId')?.value ? String(document.getElementById('versionId').value).trim() : '';
    const versionName = document.getElementById('versionName')?.value ? String(document.getElementById('versionName').value).trim() : '';
    const releaseNotes = document.getElementById('versionNotes')?.value ? String(document.getElementById('versionNotes').value).trim() : '';
    const publishAt = fromDateTimeLocalValue(document.getElementById('versionPublishAt')?.value);
    const isEnabled = document.getElementById('versionEnabled')?.checked === true;
    if (!versionName) {
      setSimpleText('versionErr', '版本号不能为空', true);
      return;
    }
    const r = await fetchJson('/admin/content/version/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id || null, version_name: versionName, release_notes: releaseNotes, publish_at: publishAt, is_enabled: isEnabled }),
    });
    if (!r?.data?.ok) {
      setSimpleText('versionErr', r?.data?.error || '保存失败', true);
      return;
    }
    setSimpleText('versionErr', '', false);
    setSimpleText('versionToast', '版本信息已保存', false);
    resetVersionForm();
    await loadVersionList();
  }

  function setRedPacketToast(text, isError) {
    const el = document.getElementById('redPacketToast');
    if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.style.color = isError ? '#b00020' : 'inherit';
    el.textContent = String(text || '');
  }

  function setRedPacketHistoryToast(text, isError) {
    const el = document.getElementById('redPacketHistoryToast');
    if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.style.color = isError ? '#b00020' : 'inherit';
    el.textContent = String(text || '');
  }

  function formatClaimedItemLine(x) {
    const name = x?.name ? String(x.name) : '';
    const userid = x?.userid ? String(x.userid) : '';
    const amount = Number(x?.amount);
    const amountText = Number.isFinite(amount) ? `${amount} BOB` : '-';
    const who = name ? `${name}(${userid || '-'})` : (userid || '-');
    const atText = formatTs(x?.claimed_at);
    return `${who}：${amountText}（${atText}）`;
  }

  function formatClaimedItemsHtml(items) {
    if (!items || items.length === 0) return '<span class="muted">-</span>';
    const all = items.map((x) => safeText(formatClaimedItemLine(x)));
    if (all.length <= 3) {
      return `<div class="rpClaimsPreview">${all.join('<br/>')}</div>`;
    }
    const preview = all.slice(0, 3).join('<br/>');
    return `<details class="rpClaimsDetails">
      <summary>共 ${all.length} 条，点击查看详情</summary>
      <div class="rpClaimsPreview" style="margin-top:6px;">${preview}</div>
      <div class="rpClaimsFull">${all.join('<br/>')}</div>
    </details>`;
  }

  function renderRedPacketHistory(rows) {
    const tbody = document.getElementById('redPacketHistoryTable');
    if (!tbody) return;
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">暂无记录</td></tr>';
      return;
    }
    tbody.innerHTML = list
      .map((x) => {
        const totalAmount = Number(x?.total_amount);
        const totalCount = Number(x?.total_count);
        const totalText = `${Number.isFinite(totalAmount) ? totalAmount : '-'} / ${Number.isFinite(totalCount) ? totalCount : '-'}`;
        const claimed = Number(x?.claimed_count ?? 0);
        const remaining = Number(x?.remaining_count ?? 0);
        const countsText = `${claimed}/${Number.isFinite(remaining) ? remaining : '-'}`;
        const statusRaw = x?.status ? String(x.status) : 'scheduled';
        const statusTextMap = {
          scheduled: '倒计时',
          active: '进行中',
          ended: '已结束',
        };
        const statusText = statusTextMap[statusRaw] || statusRaw;
        const sponsor = x?.sponsor ? String(x.sponsor) : '-';
        const created = formatTs(x?.created_at);
        const detailHtml = formatClaimedItemsHtml(x?.claimed_items || []);
        const activityId = String(x?.id ?? '').trim();
        return `<tr>
          <td class="muted">${safeText(String(x?.id ?? '-'))}</td>
          <td>${safeText(created)}</td>
          <td>${safeText(totalText)}</td>
          <td>${safeText(countsText)}</td>
          <td>${safeText(statusText)}</td>
          <td>${safeText(sponsor)}</td>
          <td>${detailHtml}</td>
          <td>
            <button class="secondary" data-rp-delete="${safeText(activityId)}" type="button">删除</button>
          </td>
        </tr>`;
      })
      .join('');
  }

  async function deleteRedPacketHistoryItem(activityId) {
    const id = Number(activityId);
    if (!Number.isFinite(id) || id <= 0) return;
    const ok = window.confirm(`确认删除红包历史 #${id}？\n\n该条活动及其发放明细会被删除，操作不可撤销。`);
    if (!ok) return;
    setRedPacketHistoryToast('删除中…', false);
    const r = await fetchJson('/admin/red-packet/history/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activity_id: id }),
    });
    if (!r?.data?.ok) {
      setRedPacketHistoryToast(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '删除失败'), true);
      return;
    }
    setRedPacketHistoryToast(`已删除 #${id}`, false);
    await loadRedPacketStatus();
  }

  async function loadRedPacketHistory() {
    setRedPacketHistoryToast('加载中…', false);
    const r = await fetchJson('/admin/red-packet/history');
    if (!r?.data?.ok) {
      setRedPacketHistoryToast(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '加载失败'), true);
      renderRedPacketHistory([]);
      return;
    }
    setRedPacketHistoryToast('', false);
    renderRedPacketHistory(r.data?.data || []);
  }

  async function clearRedPacketHistory() {
    const ok = window.confirm('确认清空全部红包历史？此操作不可撤销。');
    if (!ok) return;
    setRedPacketHistoryToast('清空中…', false);
    const r = await fetchJson('/admin/red-packet/history/clear', { method: 'POST' });
    if (!r?.data?.ok) {
      setRedPacketHistoryToast(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '清空失败'), true);
      return;
    }
    setRedPacketHistoryToast('已清空', false);
    renderRedPacketHistory([]);
  }

  function renderRedPacketStatus(payload) {
    const statusBox = document.getElementById('redPacketStatus');
    const startBox = document.getElementById('redPacketStartAt');
    const endBox = document.getElementById('redPacketEndAt');
    const claimedBox = document.getElementById('redPacketClaimed');

    if (!statusBox || !startBox || !endBox || !claimedBox) return;
    if (!payload?.data) {
      statusBox.textContent = '-';
      statusBox.className = 'pill';
      startBox.textContent = '-';
      endBox.textContent = '-';
      claimedBox.textContent = '-';
      return;
    }

    const statusRaw = payload.data?.status ? String(payload.data.status) : 'scheduled';
    const statusTextMap = {
      scheduled: '倒计时中',
      active: '进行中',
      ended: '已结束',
    };
    const statusText = statusTextMap[statusRaw] || statusRaw;
    statusBox.textContent = statusText;
    statusBox.className = `pill ${statusRaw === 'active' ? 'pillOk' : (statusRaw === 'ended' ? 'pillBad' : '')}`.trim();
    startBox.textContent = formatTs(payload.data?.start_at);
    endBox.textContent = formatTs(payload.data?.end_at);
    const totalCount = Number(payload.data?.total_count ?? 0);
    const claimed = Number(payload.claimed_count ?? 0);
    claimedBox.textContent = `${claimed}/${Number.isFinite(totalCount) ? totalCount : '-'}`;
  }

  async function loadRedPacketStatus() {
    setRedPacketToast('加载中…', false);
    const r = await fetchJson('/admin/red-packet/status');
    if (!r?.data?.ok) {
      setRedPacketToast(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '加载失败'), true);
      renderRedPacketStatus(null);
      return;
    }
    setRedPacketToast('', false);
    renderRedPacketStatus(r.data);
    loadRedPacketHistory();
  }

  async function startRedPacket() {
    const btn = document.getElementById('btnRedPacketStart');
    if (btn) btn.disabled = true;
    setRedPacketToast('', false);

    try {
      const totalAmount = Number(getInputValue('redPacketTotalAmount'));
      const totalCount = Number(getInputValue('redPacketTotalCount'));
      const countdownSeconds = Number(getInputValue('redPacketCountdown'));
      const durationMinutes = Number(getInputValue('redPacketDuration'));
      const sponsorRaw = getInputValue('redPacketSponsor');
      const sponsor = sponsorRaw ? String(sponsorRaw).trim() : '';

      if (!Number.isFinite(totalAmount) || totalAmount < 1) {
        setRedPacketToast('红包总金额必须是正整数', true);
        return;
      }
      if (!Number.isFinite(totalCount) || totalCount < 1) {
        setRedPacketToast('参与人数必须是正整数', true);
        return;
      }
      if (totalAmount < totalCount) {
        setRedPacketToast('总金额必须 ≥ 参与人数（确保每人 ≥ 1）', true);
        return;
      }
      if (!Number.isFinite(countdownSeconds) || countdownSeconds < 0) {
        setRedPacketToast('倒计时必须是 >= 0 的整数', true);
        return;
      }
      if (!Number.isFinite(durationMinutes) || durationMinutes < 1) {
        setRedPacketToast('活动持续时间必须是 >= 1 的整数', true);
        return;
      }

      const r = await fetchJson('/admin/red-packet/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          total_amount: Math.floor(totalAmount),
          total_count: Math.floor(totalCount),
          countdown_seconds: Math.floor(countdownSeconds),
          duration_minutes: Math.floor(durationMinutes),
          sponsor,
        }),
      });
      if (!r?.data?.ok) {
        setRedPacketToast(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '创建失败'), true);
        return;
      }
      setRedPacketToast('已创建红包活动', false);
      renderRedPacketStatus(r.data);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function getGroupCardInput(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }

  function clearGroupCardForm() {
    const ids = ['groupCardTitle', 'groupCardContent', 'groupCardLinkUrl', 'groupCardImageUrl', 'groupCardOutTrackId', 'groupCardButtons'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.value = '';
    }
    setGroupCardOut('', false);
  }

  function parseGroupCardButtonsJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      throw new Error('btns 必须是 JSON 数组');
    }
    return data;
  }

  function setNotifyTplToast(text, isError) {
    const el = document.getElementById('notifyTplToast');
    if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.style.color = isError ? '#b00020' : 'inherit';
    el.textContent = String(text || '');
    showGlobalToast(String(text || ''), isError ? 'error' : 'success');
  }

  function setNotifyTplErr(text) {
    const el = document.getElementById('notifyTplErr');
    if (el) el.textContent = String(text || '');
    if (text) showGlobalToast(String(text), 'error');
  }

  function setNotifyTplInput(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value === null || value === undefined ? '' : String(value);
  }

  function showGlobalToast(text, type = 'success') {
    const box = document.getElementById('globalToast');
    if (!box) return;
    box.textContent = String(text || '');
    box.classList.remove('hidden', 'success', 'error');
    box.classList.add(type === 'error' ? 'error' : 'success');
    if (globalToastTimer) {
      clearTimeout(globalToastTimer);
      globalToastTimer = null;
    }
    globalToastTimer = setTimeout(() => {
      box.classList.add('hidden');
    }, 1800);
  }

  function normalizeTemplateEntry(entry, fallback = {}) {
    const t = entry && typeof entry === 'object' ? entry : {};
    return {
      enabled: t.enabled !== false,
      title: t.title ? String(t.title) : String(fallback?.title || ''),
      content: t.content ? String(t.content) : String(fallback?.content || ''),
    };
  }

  function syncNotifyTemplateFromInputs(key) {
    if (!key) return;
    notifyState.templates[key] = {
      enabled: document.getElementById('notifyTplEnabled')?.checked !== false,
      title: document.getElementById('notifyTplTitle')?.value || '',
      content: document.getElementById('notifyTplContent')?.value || '',
    };
  }

  function renderNotifyTemplate(key) {
    const tpl = normalizeTemplateEntry(notifyState.templates?.[key], defaultNotifyTemplates[key]);
    notifyState.activeTemplate = key;
    const select = document.getElementById('notifyTemplateSelect');
    if (select) select.value = key;
    document.getElementById('notifyTplEnabled').checked = tpl.enabled !== false;
    setNotifyTplInput('notifyTplTitle', tpl.title);
    setNotifyTplInput('notifyTplContent', tpl.content);
  }

  function renderNotifyTestList(rows) {
    const list = document.getElementById('notifyTestList');
    if (!list) return;
    if (!rows || rows.length === 0) {
      list.innerHTML = '<div class="muted">没有匹配到用户</div>';
      list.classList.add('hidden');
      return;
    }
    list.classList.remove('hidden');
    const selected = notifyState.testTarget?.userid || '';
    list.innerHTML = rows
      .map((x) => {
        const userid = x?.userid ? String(x.userid) : '';
        const name = x?.name ? String(x.name) : '';
        const display = x?.display_name ? String(x.display_name) : (name || userid || '用户');
        const cls = selected && userid === selected ? 'notifyTestItem notifyTestItemActive' : 'notifyTestItem';
        return (
          `<div class="${cls}" data-userid="${escapeHtml(userid)}" data-name="${escapeHtml(name)}" data-display="${escapeHtml(display)}">` +
          `<div>` +
          `<div style="font-weight:700;">${escapeHtml(display)}</div>` +
          `<div class="muted" style="font-size:12px;">${escapeHtml(userid)}</div>` +
          `</div>` +
          `<div class="pill pillOk">选择</div>` +
          `</div>`
        );
      })
      .join('');
  }

  function setNotifyTestTarget(user) {
    notifyState.testTarget = user ? { ...user } : null;
    const hint = document.getElementById('notifyTestTargetHint');
    if (!hint) return;
    if (!notifyState.testTarget) {
      hint.textContent = '默认接收人：陈驰宇-Achord';
      return;
    }
    const display = notifyState.testTarget.display_name || notifyState.testTarget.name || notifyState.testTarget.userid || '用户';
    hint.textContent = `当前接收人：${display}`;
  }

  async function fetchNotifyTestCandidates(keyword, silent = false) {
    const kw = String(keyword || '').trim();
    if (!kw) {
      notifyState.testCandidates = [];
      renderNotifyTestList([]);
      return [];
    }
    const r = await fetchJson(`/admin/users?keyword=${encodeURIComponent(kw)}&page=1&pageSize=8`);
    if (!r?.data?.ok) {
      if (!silent) setNotifyTplErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '搜索失败'));
      renderNotifyTestList([]);
      return [];
    }
    const rows = Array.isArray(r?.data?.data) ? r.data.data : [];
    notifyState.testCandidates = rows;
    renderNotifyTestList(rows);
    return rows;
  }

  function collectNotifySettings() {
    const enabled = document.getElementById('notifyEnabled')?.checked || false;
    const selected = document.getElementById('notifyTemplateSelect')?.value || 'grant';
    syncNotifyTemplateFromInputs(selected);
    return {
      enabled,
      templates: notifyState.templates,
    };
  }

  function fillNotifySettings(data) {
    const settings = data || {};
    document.getElementById('notifyEnabled').checked = settings.enabled !== false;
    notifyState.templates = settings.templates || {};
    const defaults = ['grant', 'deduct', 'redeem', 'mall_buy', 'transfer_out', 'transfer_in', 'red_packet', 'charity'];
    const select = document.getElementById('notifyTemplateSelect');
    if (select && !Array.from(select.options || []).some((opt) => opt.value === 'charity')) {
      const option = document.createElement('option');
      option.value = 'charity';
      option.textContent = '公益助力通知';
      select.appendChild(option);
    }
    for (const key of defaults) {
      if (!notifyState.templates[key]) {
        notifyState.templates[key] = { ...defaultNotifyTemplates[key] };
      }
    }
    const current = document.getElementById('notifyTemplateSelect')?.value || notifyState.activeTemplate;
    notifyState.activeTemplate = current;
    renderNotifyTemplate(current);
  }

  async function loadNotifySettings() {
    setNotifyTplErr('');
    setNotifyTplToast('', false);
    const r = await fetchJson('/admin/settings/notify');
    if (!r?.data?.ok) {
      setNotifyTplErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '加载失败'));
      return;
    }
    fillNotifySettings(r.data?.data || {});
  }

  async function saveNotifySettings({ reset = false } = {}) {
    setNotifyTplErr('');
    setNotifyTplToast('', false);
    const btnSave = document.getElementById('btnNotifyTplSave');
    const btnReset = document.getElementById('btnNotifyTplReset');
    const prevSaveDisabled = btnSave ? btnSave.disabled : false;
    const prevResetDisabled = btnReset ? btnReset.disabled : false;
    if (btnSave) btnSave.disabled = true;
    if (btnReset) btnReset.disabled = true;
    try {
      const payload = reset ? { reset: true } : collectNotifySettings();
      const r = await fetchJson('/admin/settings/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r?.data?.ok) {
        setNotifyTplErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '保存失败'));
        return;
      }
      fillNotifySettings(r.data?.data || {});
      setNotifyTplToast(reset ? '已恢复默认模板' : '已保存通知设置', false);
    } finally {
      if (btnSave) btnSave.disabled = prevSaveDisabled;
      if (btnReset) btnReset.disabled = prevResetDisabled;
    }
  }

  function insertVarAtCursor(el, text) {
    if (!el || !text) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const value = el.value || '';
    el.value = value.slice(0, start) + text + value.slice(end);
    const pos = start + text.length;
    el.selectionStart = pos;
    el.selectionEnd = pos;
    el.focus();
  }

  function bindNotifyVarChips() {
    document.querySelectorAll('.varChip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('data-var') || '';
        if (!v) return;
        const token = `{{${v}}}`;
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
          insertVarAtCursor(active, token);
          return;
        }
        const card = btn.closest('.card');
        const fallback = card?.querySelector('#notifyTplContent, #groupCardTplContent, #notifyTplTitle, #groupCardTplTitle')
          || document.getElementById('notifyTplContent')
          || document.getElementById('groupCardTplContent');
        insertVarAtCursor(fallback, token);
      });
    });
  }

  async function sendNotifyTest() {
    setNotifyTplErr('');
    setNotifyTplToast('', false);
    const btn = document.getElementById('btnNotifyTest');
    const prevDisabled = btn ? btn.disabled : false;
    if (btn) btn.disabled = true;
    try {
      const target = notifyState.testTarget;
      let userid = target?.userid ? String(target.userid) : '';
      if (!userid) {
        const name = document.getElementById('notifyTestName')?.value?.trim() || '陈驰宇-Achord';
        const rows = await fetchNotifyTestCandidates(name, true);
        if (rows && rows.length === 1) {
          setNotifyTestTarget(rows[0]);
          userid = rows[0].userid;
        }
      }
      if (!userid) {
        setNotifyTplErr('请先选择接收人');
        return;
      }
      const event = document.getElementById('notifyTemplateSelect')?.value || 'grant';
      if (!event) {
        setNotifyTplErr('请选择测试类型');
        return;
      }
      const r = await fetchJson('/admin/settings/notify/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userid,
          name: document.getElementById('notifyTestName')?.value?.trim() || '陈驰宇-Achord',
          event,
        }),
      });
      if (!r?.data?.ok) {
        setNotifyTplErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '发送失败'));
        return;
      }
      setNotifyTplToast('测试消息已发送', false);
    } finally {
      if (btn) btn.disabled = prevDisabled;
    }
  }

  function setGroupCardTplToast(text, isError) {
    const el = document.getElementById('groupCardTplToast');
    if (!el) return;
    el.style.whiteSpace = 'pre-wrap';
    el.style.color = isError ? '#b00020' : 'inherit';
    el.textContent = String(text || '');
    if (text) showGlobalToast(String(text || ''), isError ? 'error' : 'success');
  }

  function setGroupCardTplErr(text) {
    const el = document.getElementById('groupCardTplErr');
    if (el) el.textContent = String(text || '');
    if (text) showGlobalToast(String(text), 'error');
  }

  function normalizeGroupCardRecipients(value) {
    const source = Array.isArray(value)
      ? value
      : String(value || '').split(/[\r\n,，]+/g);
    return source
      .map((item) => String(item || '').trim())
      .filter((item) => item);
  }

  function normalizeGroupCardChannel(channel) {
    const src = channel && typeof channel === 'object' ? channel : {};
    return {
      openConversationId: src.openConversationId ? String(src.openConversationId).trim() : '',
      cardTemplateId: src.cardTemplateId ? String(src.cardTemplateId).trim() : '',
      operatorUserid: src.operatorUserid ? String(src.operatorUserid).trim() : '',
      broadcastAll: src.broadcastAll === true,
      recipients: normalizeGroupCardRecipients(src.recipients),
      titleKey: src.titleKey ? String(src.titleKey).trim() : '',
      contentKey: src.contentKey ? String(src.contentKey).trim() : '',
      searchIcon: src.searchIcon ? String(src.searchIcon).trim() : '',
    };
  }

  function matchGroupCardConversationPreset(value) {
    const current = String(value || '').trim();
    const matched = groupCardConversationPresets.find((item) => item.value === current);
    return matched ? matched.value : '__custom__';
  }

  function syncGroupCardConversationPresetUi() {
    const select = document.getElementById('groupCardConversationPreset');
    const input = document.getElementById('groupCardOpenConversationId');
    if (!select || !input) return;
    const selected = select.value || '__custom__';
    const isCustom = selected === '__custom__';
    if (!isCustom) {
      input.value = selected;
    }
    input.readOnly = !isCustom;
    input.placeholder = isCustom ? '填写钉钉群 openConversationId' : '已从预设自动填入';
  }

  function fillGroupCardChannel(channel) {
    const normalized = normalizeGroupCardChannel(channel);
    groupCardState.channel = normalized;
    const preset = document.getElementById('groupCardConversationPreset');
    const openConversationId = document.getElementById('groupCardOpenConversationId');
    const cardTemplateId = document.getElementById('groupCardChannelTemplateId');
    const operatorUserid = document.getElementById('groupCardOperatorUserid');
    const broadcastAll = document.getElementById('groupCardBroadcastAll');
    const recipients = document.getElementById('groupCardRecipients');
    const titleKey = document.getElementById('groupCardTitleKey');
    const contentKey = document.getElementById('groupCardContentKey');
    const searchIcon = document.getElementById('groupCardSearchIcon');
    if (preset) preset.value = matchGroupCardConversationPreset(normalized.openConversationId);
    if (openConversationId) openConversationId.value = normalized.openConversationId || '';
    if (cardTemplateId) cardTemplateId.value = normalized.cardTemplateId || '';
    if (operatorUserid) operatorUserid.value = normalized.operatorUserid || '';
    if (broadcastAll) broadcastAll.checked = normalized.broadcastAll === true;
    if (recipients) recipients.value = normalized.recipients.join('\n');
    if (titleKey) titleKey.value = normalized.titleKey || '';
    if (contentKey) contentKey.value = normalized.contentKey || '';
    if (searchIcon) searchIcon.value = normalized.searchIcon || '';
    syncGroupCardConversationPresetUi();
  }

  function collectGroupCardChannelFromInputs() {
    return normalizeGroupCardChannel({
      openConversationId: document.getElementById('groupCardOpenConversationId')?.value || '',
      cardTemplateId: document.getElementById('groupCardChannelTemplateId')?.value || '',
      operatorUserid: document.getElementById('groupCardOperatorUserid')?.value || '',
      broadcastAll: document.getElementById('groupCardBroadcastAll')?.checked === true,
      recipients: document.getElementById('groupCardRecipients')?.value || '',
      titleKey: document.getElementById('groupCardTitleKey')?.value || '',
      contentKey: document.getElementById('groupCardContentKey')?.value || '',
      searchIcon: document.getElementById('groupCardSearchIcon')?.value || '',
    });
  }

  function normalizeGroupTemplateEntry(entry) {
    const t = entry && typeof entry === 'object' ? entry : {};
    let buttons = t.buttons;
    if (!Array.isArray(buttons)) {
      if (typeof buttons === 'string') {
        try { buttons = JSON.parse(buttons); } catch { buttons = []; }
      } else {
        buttons = [];
      }
    }
    return {
      enabled: t.enabled !== false,
      title: t.title ? String(t.title) : '',
      content: t.content ? String(t.content) : '',
      buttons,
    };
  }

  function syncGroupTemplateFromInputs(key) {
    if (!key) return;
    let buttons = [];
    const btnsEl = document.getElementById('groupCardTplButtons');
    if (btnsEl) {
      try { buttons = JSON.parse(btnsEl.value || '[]'); } catch { buttons = []; }
    }
    groupCardState.templates[key] = {
      enabled: document.getElementById('groupCardTplEnabled')?.checked !== false,
      title: document.getElementById('groupCardTplTitle')?.value || '',
      content: document.getElementById('groupCardTplContent')?.value || '',
      buttons,
    };
  }

  function renderGroupTemplate(key) {
    const tpl = normalizeGroupTemplateEntry(groupCardState.templates?.[key]);
    groupCardState.activeTemplate = key;
    const select = document.getElementById('groupCardTemplateSelect');
    if (select) select.value = key;
    const title = document.getElementById('groupCardTplTitle');
    const content = document.getElementById('groupCardTplContent');
    const enabled = document.getElementById('groupCardTplEnabled');
    const btnsEl = document.getElementById('groupCardTplButtons');
    if (enabled) enabled.checked = tpl.enabled !== false;
    if (title) title.value = tpl.title || '';
    if (content) content.value = tpl.content || '';
    if (btnsEl) {
      btnsEl.value = tpl.buttons && tpl.buttons.length
        ? JSON.stringify(tpl.buttons, null, 2)
        : '';
    }
  }

  async function loadGroupCardSettings() {
    setGroupCardTplErr('');
    setGroupCardTplToast('', false);
    const r = await fetchJson('/admin/settings/group-card');
    if (!r?.data?.ok) {
      setGroupCardTplErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '加载失败'));
      return;
    }
    const data = r.data?.data || {};
    const enabled = document.getElementById('groupCardEnabled');
    if (enabled) enabled.checked = data.enabled !== false;
    fillGroupCardChannel(data.channel || getDefaultGroupCardChannel());
    groupCardState.templates = data.templates || {};
    const defaults = ['manual', 'mall_open', 'mall_open_remind', 'mall_close_remind', 'stock_low', 'stock_soldout', 'new_product'];
    for (const key of defaults) {
      if (!groupCardState.templates[key]) {
        groupCardState.templates[key] = { enabled: true, title: '{{title}}', content: '{{content}}' };
      }
    }
    const current = document.getElementById('groupCardTemplateSelect')?.value || groupCardState.activeTemplate;
    renderGroupTemplate(current || 'manual');
  }

  async function saveGroupCardSettings({ reset = false } = {}) {
    setGroupCardTplErr('');
    setGroupCardTplToast('', false);
    const btnSave = document.getElementById('btnGroupCardTplSave');
    const btnReset = document.getElementById('btnGroupCardTplReset');
    const prevSave = btnSave ? btnSave.disabled : false;
    const prevReset = btnReset ? btnReset.disabled : false;
    if (btnSave) btnSave.disabled = true;
    if (btnReset) btnReset.disabled = true;
    try {
      const payload = reset
        ? { reset: true }
        : {
            enabled: document.getElementById('groupCardEnabled')?.checked !== false,
            channel: collectGroupCardChannelFromInputs(),
            templates: (() => {
              const selected = document.getElementById('groupCardTemplateSelect')?.value || groupCardState.activeTemplate || 'manual';
              syncGroupTemplateFromInputs(selected);
              return groupCardState.templates;
            })(),
          };
      const r = await fetchJson('/admin/settings/group-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r?.data?.ok) {
        setGroupCardTplErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '保存失败'));
        return;
      }
      setGroupCardTplToast(reset ? '已恢复群卡默认设置' : '已保存群卡设置', false);
      await loadGroupCardSettings();
    } finally {
      if (btnSave) btnSave.disabled = prevSave;
      if (btnReset) btnReset.disabled = prevReset;
    }
  }

  async function sendGroupCardTemplateTest() {
    setGroupCardTplErr('');
    setGroupCardTplToast('', false);
    const btn = document.getElementById('btnGroupCardTplTest');
    const prev = btn ? btn.disabled : false;
    if (btn) btn.disabled = true;
    try {
      const event = document.getElementById('groupCardTemplateSelect')?.value || groupCardState.activeTemplate || 'manual';
      syncGroupTemplateFromInputs(event);
      const r = await fetchJson('/admin/settings/group-card/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event }),
      });
      if (!r?.data?.ok) {
        setGroupCardTplErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '测试发送失败'));
        return;
      }
      setGroupCardTplToast('群卡测试已发送', false);
    } catch (err) {
      setGroupCardTplErr(String(err?.message || err || '测试发送失败'));
    } finally {
      if (btn) btn.disabled = prev;
    }
  }

  function mountMessagePanels() {
    const notify = document.getElementById('notifySettingsDetails');
    const group = document.getElementById('groupCardDetails');
    const notifyMount = document.getElementById('messagesNotifyMount');
    const groupMount = document.getElementById('messagesGroupMount');
    if (notify && notifyMount && notify.parentElement !== notifyMount) {
      notifyMount.appendChild(notify);
      notify.open = false;
    }
    if (group && groupMount && group.parentElement !== groupMount) {
      groupMount.appendChild(group);
      group.open = false;
    }
  }

  async function sendGroupCardFromForm() {
    setGroupCardOut('', false);

    const title = getGroupCardInput('groupCardTitle');
    const markdown = getGroupCardInput('groupCardContent');
    const linkUrl = getGroupCardInput('groupCardLinkUrl');
    const imageUrl = getGroupCardInput('groupCardImageUrl');
    const outTrackId = getGroupCardInput('groupCardOutTrackId');
    const btnsText = getGroupCardInput('groupCardButtons');

    if (!title && !markdown) {
      setGroupCardOut('请至少填写 biaoti 或 neirong', true);
      return;
    }

    let buttons;
    try {
      buttons = parseGroupCardButtonsJson(btnsText);
    } catch (err) {
      setGroupCardOut(String(err?.message || err), true);
      return;
    }

    const btn = document.getElementById('btnGroupCardSend');
    const prevDisabled = btn ? btn.disabled : false;
    if (btn) btn.disabled = true;

    try {
      const r = await fetchJson('/admin/notify/group-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          markdown,
          linkUrl,
          imageUrl,
          outTrackId,
          buttons,
        }),
      });
      if (!r?.data?.ok) {
        setGroupCardOut(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '推送失败'), true);
        return;
      }
      setGroupCardOut('推送成功', false);
    } finally {
      if (btn) btn.disabled = prevDisabled;
    }
  }

  function setMallMode(mode) {
    const m = 'self';
    mallState.mode = m;
    const hint = document.getElementById('mallModeHint');
    if (hint) {
      hint.textContent = '当前：自建版（可编辑）';
    }

    const btnSelf = document.getElementById('btnMallModeSelf');
    if (btnSelf) btnSelf.classList.toggle('secondary', m !== 'self');

    const btnCreate = document.getElementById('btnMallProductCreate');
    if (btnCreate) btnCreate.disabled = m !== 'self';
  }

  function formatDateTimeLocal(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day}T${hh}:${mm}`;
  }

  function parseDateTimeLocal(value) {
    const v = String(value || '').trim();
    if (!v) return null;
    const t = new Date(v);
    const ms = t.getTime();
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 1000);
  }

  function setMallOpeningStatus(row) {
    const el = document.getElementById('mallOpeningStatus');
    if (!el) return;
    const open = Number(row?.is_open) === 1;
    el.textContent = open ? '已开启' : '已关闭';
    el.classList.toggle('is-open', open);
    el.classList.toggle('is-closed', !open);
  }

  function setMallOpeningAdvancedVisible(visible) {
    const on = !!visible;
    mallState.openingAdvancedVisible = on;
    const box = document.getElementById('mallOpeningAdvanced');
    if (box) box.classList.toggle('hidden', !on);
    const actions = document.getElementById('mallOpeningAdvancedActions');
    if (actions) actions.classList.toggle('hidden', !on);
    const btn = document.getElementById('btnMallOpeningMore');
    if (btn) btn.textContent = on ? '收起设置' : '更多设置';
  }

  function syncMallToggleButton(row) {
    const btn = document.getElementById('btnMallToggleNow');
    if (!btn) return;
    const open = Number(row?.is_open) === 1;
    btn.textContent = open ? '立即关闭' : '立即开启';
    btn.classList.toggle('secondary', open);
  }

  function setMallOpeningNextText(row) {
    const el = document.getElementById('mallNextOpenText');
    if (!el) return;
    const ts = Number(row?.next_open_at);
    el.textContent = Number.isFinite(ts) && ts > 0 ? formatTs(ts) : '-';
  }

  function setMallClosingNextText(row) {
    const el = document.getElementById('mallNextCloseText');
    if (!el) return;
    const duration = Number(row?.open_duration_minutes);
    const openAt = Number(row?.open_notify_for_open_at || row?.next_open_at);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(openAt) || openAt <= 0) {
      el.textContent = '-';
      return;
    }
    const closeAt = openAt + duration * 60;
    el.textContent = Number.isFinite(closeAt) && closeAt > 0 ? formatTs(closeAt) : '-';
  }

  async function loadMallOpening() {
    const err = document.getElementById('mallOpeningErr');
    if (err) err.textContent = '';
    const r = await fetchJson('/admin/mall/opening');
    if (!r?.data?.ok) {
      if (err) err.textContent = r?.data?.error || '加载失败';
      return null;
    }
    const row = r.data.data || {};
    mallState.openingRow = row;
    setMallOpeningStatus(row);
    syncMallToggleButton(row);
    setMallOpeningNextText(row);
    setMallClosingNextText(row);
    const auto = document.getElementById('mallAutoEnable');
    if (auto) auto.checked = Number(row.auto_enabled) === 1;
    const nextAt = document.getElementById('mallNextOpenAt');
    if (nextAt) nextAt.value = formatDateTimeLocal(row.next_open_at);
    const interval = document.getElementById('mallIntervalMinutes');
    if (interval) interval.value = row.interval_minutes !== null && row.interval_minutes !== undefined ? String(row.interval_minutes) : '';
    const duration = document.getElementById('mallOpenDuration');
    if (duration) duration.value = row.open_duration_minutes !== null && row.open_duration_minutes !== undefined ? String(row.open_duration_minutes) : '';
    const remind = document.getElementById('mallRemindSeconds');
    if (remind) remind.value = row.remind_before_seconds !== null && row.remind_before_seconds !== undefined ? String(row.remind_before_seconds) : '';
    const closeRemind = document.getElementById('mallCloseRemindSeconds');
    if (closeRemind) closeRemind.value = row.close_remind_seconds !== null && row.close_remind_seconds !== undefined ? String(row.close_remind_seconds) : '';
    return row;
  }

  async function saveMallOpening() {
    const err = document.getElementById('mallOpeningErr');
    if (err) err.textContent = '';
    const auto = document.getElementById('mallAutoEnable')?.checked ? 1 : 0;
    const nextOpenAt = parseDateTimeLocal(document.getElementById('mallNextOpenAt')?.value || '');
    const interval = document.getElementById('mallIntervalMinutes')?.value || '';
    const duration = document.getElementById('mallOpenDuration')?.value || '';
    const remind = document.getElementById('mallRemindSeconds')?.value || '';
    const closeRemind = document.getElementById('mallCloseRemindSeconds')?.value || '';

    const intervalMinutes = interval === '' ? null : Number(interval);
    const openDurationMinutes = duration === '' ? null : Number(duration);
    const remindSeconds = remind === '' ? null : Number(remind);
    const closeRemindSeconds = closeRemind === '' ? null : Number(closeRemind);
    if (auto && !nextOpenAt) {
      if (err) err.textContent = '请填写下一次开启时间';
      return;
    }
    if (interval !== '' && (!Number.isFinite(intervalMinutes) || intervalMinutes < 1)) {
      if (err) err.textContent = '开启频率必须是 >= 1 的整数';
      return;
    }
    if (duration !== '' && (!Number.isFinite(openDurationMinutes) || openDurationMinutes < 1)) {
      if (err) err.textContent = '开启持续必须是 >= 1 的整数';
      return;
    }
    if (remind !== '' && (!Number.isFinite(remindSeconds) || remindSeconds < 0)) {
      if (err) err.textContent = '提前提醒必须是 >= 0 的整数';
      return;
    }
    if (closeRemind !== '' && (!Number.isFinite(closeRemindSeconds) || closeRemindSeconds < 0)) {
      if (err) err.textContent = '关闭前提醒必须是 >= 0 的整数';
      return;
    }
    if (closeRemindSeconds !== null && closeRemindSeconds !== undefined && closeRemindSeconds !== '' && !openDurationMinutes) {
      if (err) err.textContent = '设置关闭前提醒需填写开启持续时间';
      return;
    }
    if (auto && !openDurationMinutes) {
      if (err) err.textContent = '启用自动开启需填写开启持续时间';
      return;
    }

    const btn = document.getElementById('btnMallOpeningSave');
    const prevDisabled = btn ? btn.disabled : false;
    if (btn) btn.disabled = true;
    try {
      const r = await fetchJson('/admin/mall/opening', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auto_enabled: auto,
          next_open_at: nextOpenAt,
          interval_minutes: interval === '' ? null : Math.floor(intervalMinutes),
          open_duration_minutes: duration === '' ? null : Math.floor(openDurationMinutes),
          remind_before_seconds: remind === '' ? null : Math.floor(remindSeconds),
          close_remind_seconds: closeRemind === '' ? null : Math.floor(closeRemindSeconds),
        }),
      });
      if (!r?.data?.ok) {
        if (err) err.textContent = r?.data?.error || '保存失败';
        return;
      }
      await loadMallOpening();
    } finally {
      if (btn) btn.disabled = prevDisabled;
    }
  }

  async function openMallNow() {
    const err = document.getElementById('mallOpeningErr');
    if (err) err.textContent = '';
    const r = await fetchJson('/admin/mall/opening/open-now', { method: 'POST' });
    if (!r?.data?.ok) {
      if (err) err.textContent = r?.data?.error || '开启失败';
      return;
    }
    await loadMallOpening();
  }

  async function closeMallNow() {
    const err = document.getElementById('mallOpeningErr');
    if (err) err.textContent = '';
    const r = await fetchJson('/admin/mall/opening/close-now', { method: 'POST' });
    if (!r?.data?.ok) {
      if (err) err.textContent = r?.data?.error || '关闭失败';
      return;
    }
    await loadMallOpening();
  }

  async function toggleMallNow() {
    const row = mallState.openingRow || {};
    const isOpen = Number(row?.is_open) === 1;
    if (isOpen) {
      await closeMallNow();
      return;
    }
    await openMallNow();
  }

  function getMallProductStatusValue() {
    const on = document.getElementById('mallProductStatusOn');
    const off = document.getElementById('mallProductStatusOff');
    if (on?.checked) return 'on';
    if (off?.checked) return 'off';
    return 'on';
  }

  function setMallProductStatusValue(value) {
    const v = value === 'off' ? 'off' : 'on';
    const on = document.getElementById('mallProductStatusOn');
    const off = document.getElementById('mallProductStatusOff');
    if (on) on.checked = v === 'on';
    if (off) off.checked = v === 'off';
  }

  function setMallProductImageDataUrl(dataUrl) {
    const hidden = document.getElementById('mallProductImageUrl');
    if (hidden) hidden.value = dataUrl ? String(dataUrl) : '';

    const img = document.getElementById('mallProductImagePreview');
    if (!img) return;
    const u = dataUrl ? String(dataUrl) : '';
    if (!u) {
      img.src = '';
      img.style.display = 'none';
      return;
    }
    img.src = u;
    img.style.display = 'block';
  }

  function setCharityProjectImageDataUrl(dataUrl) {
    const hidden = document.getElementById('charityProjectCoverUrl');
    if (hidden) hidden.value = dataUrl ? String(dataUrl) : '';

    const img = document.getElementById('charityProjectImagePreview');
    if (!img) return;
    const u = dataUrl ? String(dataUrl) : '';
    if (!u) {
      img.src = '';
      img.style.display = 'none';
      return;
    }
    img.src = u;
    img.style.display = 'block';
  }

  function setMallCropVisible(on) {
    const box = document.getElementById('mallImageCropBox');
    if (!box) return;
    box.classList.toggle('hidden', !on);
  }

  function resetMallCropState() {
    mallState.crop = {
      dataUrl: '',
      image: null,
      scale: 1,
      left: 0,
      top: 0,
    };
    const img = document.getElementById('mallCropImage');
    if (img) {
      img.removeAttribute('src');
      img.style.width = '';
      img.style.height = '';
      img.style.left = '';
      img.style.top = '';
    }
    const zoom = document.getElementById('mallCropZoom');
    const x = document.getElementById('mallCropX');
    const y = document.getElementById('mallCropY');
    const zoomText = document.getElementById('mallCropZoomText');
    if (zoom) zoom.value = '100';
    if (x) x.value = '50';
    if (y) y.value = '50';
    if (zoomText) zoomText.textContent = '100%';
  }

  function hideMallCropper() {
    resetMallCropState();
    setMallCropVisible(false);
  }

  function setCharityCropVisible(on) {
    const box = document.getElementById('charityImageCropBox');
    if (!box) return;
    box.classList.toggle('hidden', !on);
  }

  function resetCharityCropState() {
    charityState.crop = {
      dataUrl: '',
      image: null,
      scale: 1,
      left: 0,
      top: 0,
    };
    const img = document.getElementById('charityCropImage');
    if (img) {
      img.removeAttribute('src');
      img.style.width = '';
      img.style.height = '';
      img.style.left = '';
      img.style.top = '';
    }
    const zoom = document.getElementById('charityCropZoom');
    const x = document.getElementById('charityCropX');
    const y = document.getElementById('charityCropY');
    const zoomText = document.getElementById('charityCropZoomText');
    if (zoom) zoom.value = '100';
    if (x) x.value = '50';
    if (y) y.value = '50';
    if (zoomText) zoomText.textContent = '100%';
  }

  function hideCharityCropper() {
    resetCharityCropState();
    setCharityCropVisible(false);
  }

  async function loadImageFromDataUrl(dataUrl) {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = String(dataUrl || '');
    });
  }

  function updateMallCropPreview() {
    const frame = document.getElementById('mallCropFrame');
    const img = document.getElementById('mallCropImage');
    const zoomInput = document.getElementById('mallCropZoom');
    const xInput = document.getElementById('mallCropX');
    const yInput = document.getElementById('mallCropY');
    const zoomText = document.getElementById('mallCropZoomText');
    const source = mallState.crop?.image;
    if (!frame || !img || !zoomInput || !xInput || !yInput || !source) return;
    const fw = frame.clientWidth || 260;
    const fh = frame.clientHeight || fw;
    const sw = Number(source.naturalWidth || source.width || 0);
    const sh = Number(source.naturalHeight || source.height || 0);
    if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) return;
    const zoomPct = Math.max(100, Math.min(300, Number(zoomInput.value || 100)));
    const zoomFactor = zoomPct / 100;
    const baseScale = Math.max(fw / sw, fh / sh);
    const scale = baseScale * zoomFactor;
    const dw = sw * scale;
    const dh = sh * scale;
    const panMaxX = Math.max(0, (dw - fw) / 2);
    const panMaxY = Math.max(0, (dh - fh) / 2);
    const xRatio = (Math.max(0, Math.min(100, Number(xInput.value || 50))) - 50) / 50;
    const yRatio = (Math.max(0, Math.min(100, Number(yInput.value || 50))) - 50) / 50;
    const offsetX = panMaxX * xRatio;
    const offsetY = panMaxY * yRatio;
    const left = (fw - dw) / 2 - offsetX;
    const top = (fh - dh) / 2 - offsetY;
    img.style.width = `${dw}px`;
    img.style.height = `${dh}px`;
    img.style.left = `${left}px`;
    img.style.top = `${top}px`;
    if (zoomText) zoomText.textContent = `${Math.round(zoomPct)}%`;
    mallState.crop.scale = scale;
    mallState.crop.left = left;
    mallState.crop.top = top;
  }

  async function openMallCropper(dataUrl) {
    const text = dataUrl ? String(dataUrl) : '';
    if (!text) return;
    const source = await loadImageFromDataUrl(text);
    mallState.crop.dataUrl = text;
    mallState.crop.image = source;
    setMallCropVisible(true);
    const img = document.getElementById('mallCropImage');
    if (img) img.src = text;
    updateMallCropPreview();
  }

  function applyMallCrop() {
    const frame = document.getElementById('mallCropFrame');
    const source = mallState.crop?.image;
    if (!frame || !source) return;
    const fw = frame.clientWidth || 260;
    const fh = frame.clientHeight || fw;
    const scale = Number(mallState.crop?.scale || 1);
    const left = Number(mallState.crop?.left || 0);
    const top = Number(mallState.crop?.top || 0);
    if (!Number.isFinite(scale) || scale <= 0) return;
    const srcX = Math.max(0, (0 - left) / scale);
    const srcY = Math.max(0, (0 - top) / scale);
    const srcW = Math.max(1, fw / scale);
    const srcH = Math.max(1, fh / scale);
    const outSize = 720;
    const canvas = document.createElement('canvas');
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, srcX, srcY, srcW, srcH, 0, 0, outSize, outSize);
    const out = canvas.toDataURL('image/jpeg', 0.9);
    setMallProductImageDataUrl(out);
    hideMallCropper();
  }

  function updateCharityCropPreview() {
    const frame = document.getElementById('charityCropFrame');
    const img = document.getElementById('charityCropImage');
    const zoomInput = document.getElementById('charityCropZoom');
    const xInput = document.getElementById('charityCropX');
    const yInput = document.getElementById('charityCropY');
    const zoomText = document.getElementById('charityCropZoomText');
    const source = charityState.crop?.image;
    if (!frame || !img || !zoomInput || !xInput || !yInput || !source) return;
    const fw = frame.clientWidth || 260;
    const fh = frame.clientHeight || fw;
    const sw = Number(source.naturalWidth || source.width || 0);
    const sh = Number(source.naturalHeight || source.height || 0);
    if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) return;
    const zoomPct = Math.max(100, Math.min(300, Number(zoomInput.value || 100)));
    const zoomFactor = zoomPct / 100;
    const baseScale = Math.max(fw / sw, fh / sh);
    const scale = baseScale * zoomFactor;
    const dw = sw * scale;
    const dh = sh * scale;
    const panMaxX = Math.max(0, (dw - fw) / 2);
    const panMaxY = Math.max(0, (dh - fh) / 2);
    const xRatio = (Math.max(0, Math.min(100, Number(xInput.value || 50))) - 50) / 50;
    const yRatio = (Math.max(0, Math.min(100, Number(yInput.value || 50))) - 50) / 50;
    const offsetX = panMaxX * xRatio;
    const offsetY = panMaxY * yRatio;
    const left = (fw - dw) / 2 - offsetX;
    const top = (fh - dh) / 2 - offsetY;
    img.style.width = `${dw}px`;
    img.style.height = `${dh}px`;
    img.style.left = `${left}px`;
    img.style.top = `${top}px`;
    if (zoomText) zoomText.textContent = `${Math.round(zoomPct)}%`;
    charityState.crop.scale = scale;
    charityState.crop.left = left;
    charityState.crop.top = top;
  }

  async function openCharityCropper(dataUrl) {
    const text = dataUrl ? String(dataUrl) : '';
    if (!text) return;
    const source = await loadImageFromDataUrl(text);
    charityState.crop.dataUrl = text;
    charityState.crop.image = source;
    setCharityCropVisible(true);
    const img = document.getElementById('charityCropImage');
    if (img) img.src = text;
    updateCharityCropPreview();
  }

  function applyCharityCrop() {
    const frame = document.getElementById('charityCropFrame');
    const source = charityState.crop?.image;
    if (!frame || !source) return;
    const fw = frame.clientWidth || 260;
    const fh = frame.clientHeight || fw;
    const scale = Number(charityState.crop?.scale || 1);
    const left = Number(charityState.crop?.left || 0);
    const top = Number(charityState.crop?.top || 0);
    if (!Number.isFinite(scale) || scale <= 0) return;
    const srcX = Math.max(0, (0 - left) / scale);
    const srcY = Math.max(0, (0 - top) / scale);
    const srcW = Math.max(1, fw / scale);
    const srcH = Math.max(1, fh / scale);
    const outSize = 720;
    const canvas = document.createElement('canvas');
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, srcX, srcY, srcW, srcH, 0, 0, outSize, outSize);
    const out = canvas.toDataURL('image/jpeg', 0.9);
    setCharityProjectImageDataUrl(out);
    hideCharityCropper();
  }

  async function fileToDataUrl(file) {
    if (!file) {
      throw new Error('missing image');
    }
    if (Number(file.size) > 5 * 1024 * 1024) {
      throw new Error('图片太大（建议小于 5MB）');
    }

    const maxSide = 800;
    const quality = 0.85;

    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (_) {
      bitmap = null;
    }

    if (!bitmap) {
      return await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error('read image failed'));
        r.onload = () => resolve(String(r.result || ''));
        r.readAsDataURL(file);
      });
    }

    const sw = Number(bitmap.width) || 0;
    const sh = Number(bitmap.height) || 0;
    if (sw <= 0 || sh <= 0) {
      throw new Error('invalid image');
    }

    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, dw, dh);
    try {
      return canvas.toDataURL('image/jpeg', quality);
    } finally {
      try {
        bitmap.close();
      } catch (_) {
        // ignore
      }
    }
  }

  function setMallProductModalVisible(on) {
    const modal = document.getElementById('mallProductModal');
    if (!modal) return;
    if (on) modal.classList.remove('hidden');
    else modal.classList.add('hidden');
  }

  function setMallProductModalErr(text) {
    const el = document.getElementById('mallProductErr');
    if (!el) return;
    el.textContent = String(text || '');
  }

  function syncMallProductLimitInput() {
    const enabled = document.getElementById('mallProductLimitEnable')?.checked;
    const input = document.getElementById('mallProductLimit');
    if (!input) return;
    input.disabled = !enabled;
    if (!enabled) input.value = '';
  }

  function getInputValue(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || '') : '';
  }

  function setInputValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value === null || value === undefined ? '' : String(value);
  }

  function openMallProductModal(row) {
    setMallProductModalErr('');
    hideMallCropper();
    const r = row && typeof row === 'object' ? row : {};

    const pid = r.product_id ? String(r.product_id) : '';
    setInputValue('mallProductId', pid || genMallProductId());
    setInputValue('mallProductName', r.product_name || '');
    setInputValue('mallProductAmount', r.bob_amount === null || r.bob_amount === undefined ? '' : String(r.bob_amount));
    setInputValue('mallProductStock', r.stock === null || r.stock === undefined ? '' : String(r.stock));
    setMallProductStatusValue(r.status || 'on');
    setInputValue('mallProductSort', r.sort === null || r.sort === undefined ? '' : String(r.sort));
    setMallProductImageDataUrl(r.image_url || '');
    setInputValue('mallProductRemark', r.remark || '');
    const cdkEnabledBox = document.getElementById('mallProductCdkEnabled');
    if (cdkEnabledBox) cdkEnabledBox.checked = Number(r.cdk_enabled || 0) === 1;

    const limitRaw = r.limit_per_user === null || r.limit_per_user === undefined ? 0 : Number(r.limit_per_user);
    const limitEnabled = Number.isFinite(limitRaw) && limitRaw > 0;
    const limitEnableBox = document.getElementById('mallProductLimitEnable');
    if (limitEnableBox) limitEnableBox.checked = limitEnabled;
    const limitInput = document.getElementById('mallProductLimit');
    if (limitInput) limitInput.value = limitEnabled ? String(limitRaw) : '';
    syncMallProductLimitInput();

    const publish = document.getElementById('mallProductPublishGroup');
    if (publish) publish.checked = false;

    const imgFile = document.getElementById('mallProductImageFile');
    if (imgFile) imgFile.value = '';
    const pasteBox = document.getElementById('mallProductImagePaste');
    if (pasteBox) pasteBox.value = '';

    const btnSave = document.getElementById('btnMallProductSave');
    if (btnSave) btnSave.disabled = false;
    setMallProductModalVisible(true);
  }

  function closeMallProductModal() {
    setMallProductModalVisible(false);
    setMallProductModalErr('');
    hideMallCropper();
  }

  async function saveMallProductModal() {
    if (mallState.mode !== 'self') {
      setMallProductModalErr('当前模式为只读，无法保存。');
      return;
    }
    const body = {
      product_id: getInputValue('mallProductId').trim(),
      product_name: getInputValue('mallProductName').trim(),
      bob_amount: getInputValue('mallProductAmount').trim(),
      stock: getInputValue('mallProductStock').trim(),
      limit_per_user: 0,
      cdk_enabled: document.getElementById('mallProductCdkEnabled')?.checked ? 1 : 0,
      status: getMallProductStatusValue(),
      sort: getInputValue('mallProductSort').trim(),
      image_url: getInputValue('mallProductImageUrl').trim(),
      remark: getInputValue('mallProductRemark').trim(),
      publish_to_group: document.getElementById('mallProductPublishGroup')?.checked ? 1 : 0,
    };

    const limitEnabled = document.getElementById('mallProductLimitEnable')?.checked;
    const limitInput = getInputValue('mallProductLimit').trim();
    const limitValue = limitInput === '' ? null : Number(limitInput);
    if (limitEnabled) {
      if (!Number.isFinite(limitValue) || limitValue < 1) {
        setMallProductModalErr('限购数量必须是 >= 1 的整数');
        if (btnSave) btnSave.disabled = prevDisabled;
        return;
      }
      body.limit_per_user = Math.floor(limitValue);
    }

    const btnSave = document.getElementById('btnMallProductSave');
    const prevDisabled = btnSave ? btnSave.disabled : false;
    if (btnSave) btnSave.disabled = true;
    setMallProductModalErr('');
    try {
      const r = await fetchJson('/admin/mall/self/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r?.data?.ok) {
        setMallProductModalErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '保存失败'));
        return;
      }
      closeMallProductModal();
      await loadMallProducts();
    } finally {
      if (btnSave) btnSave.disabled = prevDisabled;
    }
  }

  function formatUpdatedAtMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '-';
    const d = new Date(n);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${hh}:${mm}`;
  }

  async function loadMallProducts() {
    const tbody = document.getElementById('mallProductTable');
    if (!tbody) return;

    setMallToast('加载中…', false);
    const r = await fetchJson('/admin/mall/self/products');
    if (!r?.data?.ok) {
      const msg = r?.data?.error || (r?.status ? `HTTP ${r.status}` : 'error');
      setMallToast(`加载失败：${msg}`, true);
      tbody.innerHTML = '';
      return;
    }

    const rows = Array.isArray(r.data.data) ? r.data.data : [];
    mallState.rowsById = new Map(rows.map((x) => [String(x?.product_id || ''), x]));
    tbody.innerHTML = rows
      .map((x) => {
        const productId = x?.product_id ? String(x.product_id) : '';
        const name = x?.product_name ? String(x.product_name) : '';
        const amount = Number(x?.bob_amount);
        const amountText = Number.isFinite(amount) ? String(amount) : '-';

        const stockRaw = x?.stock;
        const stockNum = stockRaw === null || stockRaw === undefined ? null : Number(stockRaw);
        const stockText = stockNum === null ? '无限' : (Number.isFinite(stockNum) ? String(stockNum) : '-');

        const limitRaw = x?.limit_per_user;
        const limitNum = limitRaw === null || limitRaw === undefined ? 0 : Number(limitRaw);
        const limitText = Number.isFinite(limitNum) && limitNum > 0 ? String(limitNum) : '不限';

        const cdkEnabled = Number(x?.cdk_enabled || 0) === 1;
        const cdkHtml = `<span class="pill ${cdkEnabled ? 'pillOk' : 'pillBad'}">${safeText(cdkEnabled ? '可兑换' : '关闭')}</span>`;

        const statusRaw = x?.status ? String(x.status) : '';
        const isOn = statusRaw !== 'off';
        const statusText = isOn ? '上架' : '下架';
        const statusHtml = `<span class="pill ${isOn ? 'pillOk' : 'pillBad'}">${safeText(statusText)}</span>`;

        const sort = x?.sort === null || x?.sort === undefined ? null : Number(x.sort);
        const sortText = sort === null ? '-' : (Number.isFinite(sort) ? String(sort) : '-');

        const updated = formatTs(x?.updated_at);
        const imageUrl = x?.image_url ? String(x.image_url) : '';

        const nameText = name || '-';
        const imgHtml = imageUrl
          ? `<img src="${safeText(imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="width:44px; height:44px; object-fit:cover; border-radius:6px; border:1px solid #eee; background:#fafafa;" />`
          : '';
        const nameHtml = imageUrl
          ? `<div style="display:flex; gap:10px; align-items:center;">
              <div style="flex:0 0 auto;">${imgHtml}</div>
              <div style="min-width:0;">
                <div style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${safeText(nameText)}</div>
                <div class="muted" style="margin-top:2px;">${safeText(updated)}</div>
              </div>
            </div>`
          : `${safeText(nameText)}<div class="muted" style="margin-top:2px;">${safeText(updated)}</div>`;

        const actionHtml = `<div class="tableActions compact">
          <button class="secondary mallMiniBtn" data-mall-edit="${safeText(productId)}" type="button">编辑</button>
          <button class="secondary mallMiniBtn danger" data-mall-delete="${safeText(productId)}" type="button">删除</button>
        </div>`;

        return `<tr>
          <td class="muted">${safeText(productId || '-')}</td>
          <td>${nameHtml}</td>
          <td>${safeText(amountText)}</td>
          <td>${safeText(stockText)}</td>
          <td>${safeText(limitText)}</td>
          <td>${cdkHtml}</td>
          <td>${statusHtml}</td>
          <td>${safeText(sortText)}</td>
          <td>${actionHtml}</td>
        </tr>`;
      })
      .join('');

    setMallToast(`已加载 ${rows.length} 个商品`, false);
  }

  async function deleteMallProduct(productId) {
    const pid = productId ? String(productId).trim() : '';
    if (!pid) return;
    const row = mallState.rowsById.get(pid) || null;
    const name = row?.product_name ? String(row.product_name) : pid;
    const ok = window.confirm(`确认删除商品吗？\n\n${name}\n(${pid})\n\n该操作不可撤销。`);
    if (!ok) return;
    const r = await fetchJson('/admin/mall/self/products/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: pid }),
    });
    if (!r?.data?.ok) {
      setMallToast(`删除失败：${r?.data?.error || 'error'}`, true);
      return;
    }
    setMallToast(`已删除商品：${name}`, false);
    await loadMallProducts();
  }

  function openCharityProjectModal(row) {
    const data = row && typeof row === 'object' ? row : {};
    setCharityProjectModalErr('');
    setInputValue('charityProjectId', data.project_id || genCharityProjectId());
    setInputValue('charityProjectName', data.project_name || '');
    setCharityProjectImageDataUrl(data.cover_image_url || '');
    setInputValue('charityProjectSummary', data.summary || '');
    setInputValue('charityProjectRules', data.rules_text || '');
    setInputValue('charityProjectTarget', data.target_bob_amount === null || data.target_bob_amount === undefined ? '' : String(data.target_bob_amount));
    setInputValue('charityProjectTiers', Array.isArray(data.tier_options) ? data.tier_options.join(',') : '10,20,50,100');
    setInputValue('charityProjectSort', data.sort === null || data.sort === undefined ? '' : String(data.sort));
    const status = document.getElementById('charityProjectStatus');
    if (status) status.value = data.status || 'active';
    const execStatus = document.getElementById('charityProjectExecutionStatus');
    if (execStatus) execStatus.value = data.execution_status || 'pending';
    setInputValue('charityProjectExecutionNote', data.execution_note || '');
    const imgFile = document.getElementById('charityProjectImageFile');
    if (imgFile) imgFile.value = '';
    const pasteBox = document.getElementById('charityProjectImagePaste');
    if (pasteBox) pasteBox.value = '';
    hideCharityCropper();
    const btn = document.getElementById('btnCharityProjectSave');
    if (btn) btn.disabled = false;
    setCharityProjectModalVisible(true);
  }

  function closeCharityProjectModal() {
    setCharityProjectModalVisible(false);
    setCharityProjectModalErr('');
    hideCharityCropper();
  }

  function renderCharityProjectTable(rows) {
    const tbody = document.getElementById('charityProjectTable');
    if (!tbody) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="muted">暂无公益项目</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((row) => {
      const statusText = row?.status === 'paused' ? '暂停' : (row?.status === 'archived' ? '归档' : '启用');
      const statusClass = row?.status === 'active' ? 'pillOk' : (row?.status === 'paused' ? 'pillBad' : '');
      const execText = row?.execution_status === 'completed' ? '已完成' : (row?.execution_status === 'in_progress' ? '执行中' : '待执行');
      const reached = row?.goal_reached === true || Number(row?.goal_reached || 0) === 1;
      return `<tr>
        <td class="mono">${safeText(row?.project_id || '-')}</td>
        <td>${safeText(row?.project_name || '-')}</td>
        <td>${safeText(`${Number(row?.target_bob_amount || 0)} BOB`)}</td>
        <td>${safeText(`${Number(row?.total_bob_amount || 0)} BOB`)}</td>
        <td>${safeText(String(Number(row?.donor_count || 0)))}</td>
        <td>${safeText(String(Number(row?.contribution_count || 0)))}</td>
        <td><span class="pill ${statusClass}">${safeText(statusText)}</span></td>
        <td><span class="pill ${row?.execution_status === 'completed' ? 'pillOk' : ''}">${safeText(execText)}</span></td>
        <td>${safeText(row?.sort === null || row?.sort === undefined ? '-' : String(row.sort))}</td>
        <td>
          ${reached ? '<span class="pill pillOk">已达标</span> ' : ''}
          <button class="secondary" data-charity-edit="${safeText(row?.project_id || '')}">编辑</button>
        </td>
      </tr>`;
    }).join('');
  }

  function renderCharityContributionProjectOptions(rows) {
    const select = document.getElementById('charityContributionProjectFilter');
    if (!select) return;
    const current = select.value;
    const list = Array.isArray(rows) ? rows : [];
    select.innerHTML = '<option value="">全部项目</option>' + list.map((row) => `<option value="${safeText(row?.project_id || '')}">${safeText(row?.project_name || row?.project_id || '')}</option>`).join('');
    if (current && list.some((row) => String(row?.project_id || '') === current)) {
      select.value = current;
    }
  }

  async function loadCharityProjectsAdmin() {
    setCharityToast('加载中…', false);
    setCharityErr('');
    const r = await fetchJson('/admin/charity/projects');
    if (!r?.data?.ok) {
      setCharityToast(`加载失败：${r?.data?.error || (r?.status ? `HTTP ${r.status}` : 'error')}`, true);
      return;
    }
    const rows = Array.isArray(r.data?.data) ? r.data.data : [];
    charityState.rows = rows;
    charityState.rowsById = new Map(rows.map((row) => [String(row?.project_id || ''), row]));
    renderCharityProjectTable(rows);
    renderCharityContributionProjectOptions(rows);
    setCharityToast(`已加载 ${rows.length} 个公益项目`, false);
  }

  async function saveCharityProjectModal() {
    const btn = document.getElementById('btnCharityProjectSave');
    const prevDisabled = btn ? btn.disabled : false;
    if (btn) btn.disabled = true;
    setCharityProjectModalErr('');
    try {
      const payload = {
        project_id: getInputValue('charityProjectId').trim(),
        project_name: getInputValue('charityProjectName').trim(),
        cover_image_url: getInputValue('charityProjectCoverUrl').trim(),
        summary: getInputValue('charityProjectSummary').trim(),
        rules_text: getInputValue('charityProjectRules').trim(),
        target_bob_amount: getInputValue('charityProjectTarget').trim(),
        tier_options: getInputValue('charityProjectTiers').trim(),
        status: document.getElementById('charityProjectStatus')?.value || 'active',
        execution_status: document.getElementById('charityProjectExecutionStatus')?.value || 'pending',
        execution_note: getInputValue('charityProjectExecutionNote').trim(),
        sort: getInputValue('charityProjectSort').trim(),
      };
      const r = await fetchJson('/admin/charity/projects/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r?.data?.ok) {
        setCharityProjectModalErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '保存失败'));
        return;
      }
      closeCharityProjectModal();
      setCharityToast(`已保存公益项目：${payload.project_name || payload.project_id}`, false);
      await loadCharityProjectsAdmin();
      await loadCharityContributionsAdmin();
    } finally {
      if (btn) btn.disabled = prevDisabled;
    }
  }

  async function loadCharityContributionsAdmin() {
    const stat = document.getElementById('charityContributionStat');
    const tbody = document.getElementById('charityContributionTable');
    const select = document.getElementById('charityContributionProjectFilter');
    const projectId = select?.value ? String(select.value) : '';
    if (!stat || !tbody) return;
    stat.textContent = '加载中…';
    setCharityContributionErr('');
    const qs = new URLSearchParams();
    qs.set('limit', '200');
    if (projectId) qs.set('project_id', projectId);
    const r = await fetchJson(`/admin/charity/contributions?${qs.toString()}`);
    if (!r?.data?.ok) {
      stat.textContent = '加载失败';
      setCharityContributionErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '加载失败'));
      tbody.innerHTML = '';
      return;
    }
    const rows = Array.isArray(r.data?.data) ? r.data.data : [];
    charityState.contributions = rows;
    charityState.summary = r.data?.summary || null;
    if (!rows.length) {
      stat.textContent = '暂无助力记录';
      tbody.innerHTML = '<tr><td colspan="4" class="muted">暂无助力记录</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((row) => `<tr>
      <td class="muted">${safeText(formatTs(row?.created_at))}</td>
      <td>${safeText(row?.project_name || row?.project_id || '-')}</td>
      <td>${safeText(row?.user_name_snapshot || row?.userid || '-')}</td>
      <td>${safeText(`${Number(row?.bob_amount || 0)} BOB`)}</td>
    </tr>`).join('');
    const summary = r.data?.summary;
    stat.textContent = summary
      ? `累计 ${Number(summary?.total_bob_amount || 0)} BOB 币 · ${Number(summary?.donor_count || 0)} 人 · ${Number(summary?.contribution_count || 0)} 次`
      : `已加载 ${rows.length} 条助力记录`;
  }

  function updateCdkBatchOutput(codes, batchId) {
    const rows = Array.isArray(codes) ? codes : [];
    mallState.lastGeneratedCdks = rows;
    const output = document.getElementById('cdkBatchOutput');
    const hint = document.getElementById('cdkBatchHint');
    const copyBtn = document.getElementById('btnCdkCopyBatch');
    if (output) output.value = rows.join('\n');
    if (hint) hint.textContent = rows.length > 0
      ? `批次 ${batchId || '-'}，共 ${rows.length} 个 CDK，可在此处一键复制。`
      : '生成成功后，可在此处一键复制全部 CDK。编码由系统自动生成。';
    if (copyBtn) copyBtn.disabled = rows.length === 0;
  }

  async function loadCdkProducts() {
    const select = document.getElementById('cdkProductSelect');
    if (!select) return;
    const current = select.value;
    const r = await fetchJson('/admin/cdks/products');
    if (!r?.data?.ok) {
      setCdkErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '加载可兑换商品失败'));
      return;
    }
    const rows = Array.isArray(r.data.data) ? r.data.data : [];
    mallState.cdkProducts = rows;
    select.innerHTML = '<option value="">请选择商品</option>' + rows.map((x) => {
      const productId = x?.product_id ? String(x.product_id) : '';
      const name = x?.product_name ? String(x.product_name) : productId;
      const amount = Number(x?.bob_amount);
      const amountText = Number.isFinite(amount) ? `${amount} BOB 币` : '-';
      return `<option value="${safeText(productId)}">${safeText(name)} (${safeText(amountText)})</option>`;
    }).join('');
    if (current && rows.some((x) => String(x?.product_id || '') === current)) {
      select.value = current;
    }
  }

  function renderCdkTable(rows) {
    const tbody = document.getElementById('cdkTable');
    if (!tbody) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="muted">暂无 CDK 记录</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((row) => {
      const id = Number(row?.id) || 0;
      const status = String(row?.status || 'unused');
      const statusMap = {
        unused: ['未兑换', 'pillOk'],
        redeemed: ['已兑换', 'pillBad'],
        deleted: ['已删除', ''],
      };
      const [statusText, pillClass] = statusMap[status] || [status, ''];
      const productName = row?.product_name ? String(row.product_name) : String(row?.product_id || '-');
      const creator = row?.created_name ? `${String(row.created_name)}\n${String(row?.created_by || '')}` : String(row?.created_by || '-');
      const redeemer = row?.redeemed_name ? `${String(row.redeemed_name)}\n${String(row?.redeemed_by || '')}` : String(row?.redeemed_by || '-');
      const deleteDisabled = status !== 'unused' ? 'disabled' : '';
      return `<tr data-cdk-id="${id}">
        <td>${safeText(productName)}</td>
        <td class="mono">${safeText(row?.cdk_code || '-')}</td>
        <td><span class="pill ${pillClass}">${safeText(statusText)}</span></td>
        <td style="white-space:pre-line;">${safeText(creator)}</td>
        <td class="muted">${safeText(formatTs(row?.created_at))}</td>
        <td style="white-space:pre-line;">${safeText(redeemer)}</td>
        <td class="muted">${safeText(formatTs(row?.redeemed_at))}</td>
        <td class="mono">${safeText(row?.redeem_exchange_id || '-')}</td>
        <td><button class="secondary" data-cdk-delete="${id}" ${deleteDisabled}>删除</button></td>
      </tr>`;
    }).join('');
  }

  async function loadCdkList() {
    const tbody = document.getElementById('cdkTable');
    if (!tbody) return;
    setCdkToast('加载中…', false);
    setCdkErr('');
    const r = await fetchJson('/admin/cdks?limit=200');
    if (!r?.data?.ok) {
      setCdkToast(`加载失败：${r?.data?.error || r?.status || 'error'}`, true);
      renderCdkTable([]);
      return;
    }
    const rows = Array.isArray(r.data.data) ? r.data.data : [];
    mallState.cdkRows = rows;
    renderCdkTable(rows);
    setCdkToast(`已加载 ${rows.length} 条 CDK 记录`, false);
  }

  async function generateCdks() {
    const select = document.getElementById('cdkProductSelect');
    const quantityInput = document.getElementById('cdkQuantityInput');
    const productId = select?.value ? String(select.value) : '';
    const quantity = quantityInput?.value ? Number(quantityInput.value) : 0;
    if (!productId) {
      setCdkErr('请选择商品');
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0 || Math.floor(quantity) !== quantity) {
      setCdkErr('生成数量必须是 1 到 500 的整数');
      return;
    }
    setCdkErr('');
    setCdkToast('正在生成 CDK…', false);
    const r = await fetchJson('/admin/cdks/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: productId, quantity }),
    });
    if (!r?.data?.ok) {
      setCdkToast(`生成失败：${r?.data?.error || r?.status || 'error'}`, true);
      return;
    }
    updateCdkBatchOutput(r.data?.codes || [], r.data?.batch_id ? String(r.data.batch_id) : '');
    setCdkToast(`已生成 ${Number(r.data?.quantity || 0)} 个 CDK`, false);
    await loadCdkList();
  }

  async function deleteCdk(id) {
    const cdkId = Number(id) || 0;
    if (!cdkId) return;
    const row = (mallState.cdkRows || []).find((x) => Number(x?.id) === cdkId);
    const name = row?.product_name ? String(row.product_name) : '该 CDK';
    const code = row?.cdk_code ? String(row.cdk_code) : String(cdkId);
    const ok = window.confirm(`确认删除该 CDK 吗？\n\n${name}\n${code}`);
    if (!ok) return;
    const r = await fetchJson('/admin/cdks/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [cdkId] }),
    });
    if (!r?.data?.ok) {
      setCdkToast(`删除失败：${r?.data?.error || r?.status || 'error'}`, true);
      return;
    }
    setCdkToast('CDK 已删除', false);
    await loadCdkList();
  }

  async function loadRedeemHistory() {
    const stat = document.getElementById('redeemHistoryStat');
    const tbody = document.getElementById('redeemHistoryTable');
    if (!stat || !tbody) return;
    stat.textContent = '加载中…';
    redeemHistoryState.cursor = '';
    redeemHistoryState.hasMore = false;
    const r = await fetchJson('/admin/redeem/history?limit=80');
    if (!r?.data?.ok) {
      stat.textContent = `加载失败：${r?.data?.error || r?.status || 'error'}`;
      tbody.innerHTML = '';
      return;
    }

    redeemHistoryState.cursor = r.data?.nextCursor ? String(r.data.nextCursor) : '';
    redeemHistoryState.hasMore = r.data?.hasMore === true;

    const rows = Array.isArray(r.data.data) ? r.data.data : [];
    tbody.innerHTML = rows
      .map((x) => {
        const ts = formatTs(x?.fulfilled_at || x?.created_at);
        const userid = x?.userid ? String(x.userid) : '';
        const name = x?.name ? String(x.name) : '';
        const exchangeId = x?.exchange_id ? String(x.exchange_id) : '';
        const productId = x?.product_id ? String(x.product_id) : '';
        const productName = x?.product_name ? String(x.product_name) : '';
        const productText = productName && productId ? `${productName} (${productId})` : (productName || productId);
        const amount = Number(x?.bob_amount);
        const amountText = Number.isFinite(amount) ? `-${amount}` : '-';
        return `<tr>
          <td class="muted">${safeText(ts)}</td>
          <td class="muted">${safeText(userid)}</td>
          <td>${safeText(name || '-')}</td>
          <td class="muted">${safeText(exchangeId)}</td>
          <td>${safeText(productText)}</td>
          <td>${safeText(amountText)}</td>
        </tr>`;
      })
      .join('');

    stat.textContent = `已加载 ${rows.length} 条${redeemHistoryState.hasMore ? '（可继续加载）' : ''}`;

    const btnMore = document.getElementById('btnRedeemHistoryMore');
    if (btnMore) btnMore.disabled = !redeemHistoryState.hasMore;
  }

  const redeemHistoryState = {
    cursor: '',
    hasMore: false,
  };

  async function loadRedeemHistoryMore() {
    const stat = document.getElementById('redeemHistoryStat');
    const tbody = document.getElementById('redeemHistoryTable');
    if (!stat || !tbody) return;
    if (!redeemHistoryState.hasMore || !redeemHistoryState.cursor) return;

    const btnMore = document.getElementById('btnRedeemHistoryMore');
    const prevDisabled = btnMore ? btnMore.disabled : false;
    if (btnMore) btnMore.disabled = true;

    try {
      stat.textContent = '加载中…';
      const qs = new URLSearchParams();
      qs.set('limit', '80');
      qs.set('cursor', redeemHistoryState.cursor);
      const r = await fetchJson(`/admin/redeem/history?${qs.toString()}`);
      if (!r?.data?.ok) {
        stat.textContent = `加载失败：${r?.data?.error || r?.status || 'error'}`;
        return;
      }

      redeemHistoryState.cursor = r.data?.nextCursor ? String(r.data.nextCursor) : '';
      redeemHistoryState.hasMore = r.data?.hasMore === true;

      const rows = Array.isArray(r.data.data) ? r.data.data : [];
      const html = rows
        .map((x) => {
          const ts = formatTs(x?.fulfilled_at || x?.created_at);
          const userid = x?.userid ? String(x.userid) : '';
          const name = x?.name ? String(x.name) : '';
          const exchangeId = x?.exchange_id ? String(x.exchange_id) : '';
          const productId = x?.product_id ? String(x.product_id) : '';
          const productName = x?.product_name ? String(x.product_name) : '';
          const productText = productName && productId ? `${productName} (${productId})` : (productName || productId);
          const amount = Number(x?.bob_amount);
          const amountText = Number.isFinite(amount) ? `-${amount}` : '-';
          return `<tr>
            <td class="muted">${safeText(ts)}</td>
            <td class="muted">${safeText(userid)}</td>
            <td>${safeText(name || '-')}</td>
            <td class="muted">${safeText(exchangeId)}</td>
            <td>${safeText(productText)}</td>
            <td>${safeText(amountText)}</td>
          </tr>`;
        })
        .join('');

      tbody.insertAdjacentHTML('beforeend', html);

      const total = tbody.querySelectorAll('tr').length;
      stat.textContent = `已加载 ${total} 条${redeemHistoryState.hasMore ? '（可继续加载）' : ''}`;
    } finally {
      if (btnMore) btnMore.disabled = !redeemHistoryState.hasMore;
    }
  }

  async function clearRedeemHistory() {
    const ok = window.confirm('确定清空核销历史？\n\n说明：不会删除订单本身，只会把历史标记为隐藏。\n\n此操作无法恢复。\n\n下一步会要求你输入确认口令。');
    if (!ok) return;
    const confirmText = window.prompt('请输入确认口令：CLEAR_REDEEM_HISTORY');
    if (confirmText !== 'CLEAR_REDEEM_HISTORY') {
      document.getElementById('redeemHistoryStat').textContent = '已取消（确认口令不正确）';
      return;
    }
    const r = await fetchJson('/admin/redeem/history/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'CLEAR_REDEEM_HISTORY' }),
    });
    if (r?.data?.ok) {
      document.getElementById('redeemHistoryStat').textContent = `已清空：${Number(r.data.cleared) || 0} 条`;
      await loadRedeemHistory();
      return;
    }
    document.getElementById('redeemHistoryStat').textContent = `清空失败：${r?.data?.error || r?.status || 'error'}`;
  }

  const redeemPendingState = {
    cursor: '',
    hasMore: false,
  };

  async function loadRedeemPending() {
    const stat = document.getElementById('redeemPendingStat');
    const tbody = document.getElementById('redeemPendingTable');
    const btnMore = document.getElementById('btnRedeemPendingMore');
    if (!stat || !tbody) return;
    stat.textContent = '加载中…';
    redeemPendingState.cursor = '';
    redeemPendingState.hasMore = false;

    const r = await fetchJson('/admin/redeem/pending?limit=80');
    if (!r?.data?.ok) {
      stat.textContent = `加载失败：${r?.data?.error || r?.status || 'error'}`;
      tbody.innerHTML = '';
      if (btnMore) btnMore.disabled = true;
      return;
    }

    redeemPendingState.cursor = r.data?.nextCursor ? String(r.data.nextCursor) : '';
    redeemPendingState.hasMore = r.data?.hasMore === true;

    const rows = Array.isArray(r.data.data) ? r.data.data : [];
    tbody.innerHTML = rows
      .map((x) => {
        const ts = formatTs(x?.created_at);
        const userid = x?.userid ? String(x.userid) : '';
        const name = x?.name ? String(x.name) : '';
        const exchangeId = x?.exchange_id ? String(x.exchange_id) : '';
        const productId = x?.product_id ? String(x.product_id) : '';
        const productName = x?.product_name ? String(x.product_name) : '';
        const productText = productName && productId ? `${productName} (${productId})` : (productName || productId);
        const amount = Number(x?.bob_amount);
        const amountText = Number.isFinite(amount) ? `-${amount}` : '-';
        return `<tr>
          <td class="muted">${safeText(ts)}</td>
          <td class="muted">${safeText(userid)}</td>
          <td>${safeText(name || '-')}</td>
          <td class="muted">${safeText(exchangeId)}</td>
          <td>${safeText(productText)}</td>
          <td>${safeText(amountText)}</td>
        </tr>`;
      })
      .join('');

    stat.textContent = `已加载 ${rows.length} 条${redeemPendingState.hasMore ? '（可继续加载）' : ''}`;
    if (btnMore) btnMore.disabled = !redeemPendingState.hasMore;
  }

  async function loadRedeemPendingMore() {
    const stat = document.getElementById('redeemPendingStat');
    const tbody = document.getElementById('redeemPendingTable');
    const btnMore = document.getElementById('btnRedeemPendingMore');
    if (!stat || !tbody || !btnMore) return;
    if (!redeemPendingState.hasMore || !redeemPendingState.cursor) return;

    btnMore.disabled = true;
    try {
      stat.textContent = '加载中…';
      const qs = new URLSearchParams();
      qs.set('limit', '80');
      qs.set('cursor', redeemPendingState.cursor);
      const r = await fetchJson(`/admin/redeem/pending?${qs.toString()}`);
      if (!r?.data?.ok) {
        stat.textContent = `加载失败：${r?.data?.error || r?.status || 'error'}`;
        return;
      }

      redeemPendingState.cursor = r.data?.nextCursor ? String(r.data.nextCursor) : '';
      redeemPendingState.hasMore = r.data?.hasMore === true;

      const rows = Array.isArray(r.data.data) ? r.data.data : [];
      const html = rows
        .map((x) => {
          const ts = formatTs(x?.created_at);
          const userid = x?.userid ? String(x.userid) : '';
          const name = x?.name ? String(x.name) : '';
          const exchangeId = x?.exchange_id ? String(x.exchange_id) : '';
          const productId = x?.product_id ? String(x.product_id) : '';
          const productName = x?.product_name ? String(x.product_name) : '';
          const productText = productName && productId ? `${productName} (${productId})` : (productName || productId);
          const amount = Number(x?.bob_amount);
          const amountText = Number.isFinite(amount) ? `-${amount}` : '-';
          return `<tr>
            <td class="muted">${safeText(ts)}</td>
            <td class="muted">${safeText(userid)}</td>
            <td>${safeText(name || '-')}</td>
            <td class="muted">${safeText(exchangeId)}</td>
            <td>${safeText(productText)}</td>
            <td>${safeText(amountText)}</td>
          </tr>`;
        })
        .join('');

      tbody.insertAdjacentHTML('beforeend', html);
      const total = tbody.querySelectorAll('tr').length;
      stat.textContent = `已加载 ${total} 条${redeemPendingState.hasMore ? '（可继续加载）' : ''}`;
    } finally {
      btnMore.disabled = !redeemPendingState.hasMore;
    }
  }

  function formatTs(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '-';
    const d = new Date(n * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function renderAttendanceStatusTable(rows) {
    const tbody = document.getElementById('attendanceStatusTable');
    if (!tbody) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="muted">暂无记录</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((row) => {
      const hasAnomaly = row?.has_anomaly === true || Number(row?.has_anomaly || 0) === 1;
      const statusText = hasAnomaly ? '异常' : '正常';
      const statusClass = hasAnomaly ? 'pillBad' : 'pillOk';
      return `<tr>
        <td class="mono">${safeText(row?.work_date || '-')}</td>
        <td>${safeText(String(Number(row?.total_records || 0)))}</td>
        <td>${safeText(String(Number(row?.rewarded_count || 0)))}</td>
        <td>${safeText(String(Number(row?.skipped_count || 0)))}</td>
        <td>${safeText(String(Number(row?.anomaly_count || 0)))}</td>
        <td>${safeText(String(Number(row?.auto_compensated_count || 0)))}</td>
        <td>${safeText(`${Number(row?.total_reward_amount || 0)} BOB`)}</td>
        <td><span class="pill ${statusClass}">${safeText(statusText)}</span></td>
        <td><button class="secondary" data-attendance-detail="${safeText(row?.work_date || '')}">查看详情</button></td>
      </tr>`;
    }).join('');
  }

  function renderAttendanceSummary(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const row = list.find((item) => String(item?.work_date || '') === today) || null;
    const rewarded = Number(row?.rewarded_count || 0);
    const reconciled = Number(row?.auto_compensated_count || 0);
    const streamRewarded = Math.max(0, rewarded - reconciled);
    const grid = document.getElementById('attendanceSummaryGrid');
    if (grid) {
      grid.querySelectorAll('.stat-card').forEach((card) => card.classList.remove('stat-alert'));
      const errorCard = document.getElementById('attendanceSummaryErrors')?.closest('.stat-card');
      if (errorCard && Number(row?.error_count || 0) > 0) errorCard.classList.add('stat-alert');
    }
    setSimpleText('attendanceSummaryStreamRewarded', row ? String(streamRewarded) : '-', false);
    setSimpleText('attendanceSummaryReconcileRewarded', row ? String(reconciled) : '-', false);
    setSimpleText('attendanceSummarySkipped', row ? String(Number(row?.skipped_count || 0)) : '-', false);
    setSimpleText('attendanceSummaryErrors', row ? String(Number(row?.error_count || 0)) : '-', Number(row?.error_count || 0) > 0);
    setSimpleText('attendanceSummaryTotalAmount', row ? `${Number(row?.total_reward_amount || 0)} BOB` : '-', false);
  }

  async function loadAttendanceStatusList() {
    const days = document.getElementById('attendanceStatusDays')?.value || '7';
    setAttendanceStatusToast('加载中…', false);
    setAttendanceStatusErr('');
    const r = await fetchJson(`/admin/settings/attendance-reward/status?days=${encodeURIComponent(days)}`);
    if (!r?.data?.ok) {
      setAttendanceStatusErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '加载失败'));
      return;
    }
    attendanceStatusState.rows = Array.isArray(r.data?.data) ? r.data.data : [];
    renderAttendanceSummary(attendanceStatusState.rows);
    renderAttendanceStatusTable(attendanceStatusState.rows);
    setAttendanceStatusToast(`已加载 ${attendanceStatusState.rows.length} 天记录`, false);
  }

  function renderAttendanceStatusDetail(date, rows) {
    const hint = document.getElementById('attendanceStatusDetailHint');
    const stat = document.getElementById('attendanceStatusDetailStat');
    const tbody = document.getElementById('attendanceStatusDetailTable');
    if (hint) hint.textContent = date ? `日期：${date}` : '-';
    if (!tbody || !stat) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      stat.textContent = '暂无明细';
      tbody.innerHTML = '<tr><td colspan="7" class="muted">暂无明细</td></tr>';
      return;
    }
    const rewarded = list.filter((row) => String(row?.status || '') === 'rewarded');
    const errors = list.filter((row) => String(row?.status || '') === 'error');
    stat.textContent = `总计 ${list.length} 条，奖励 ${rewarded.length} 条，异常 ${errors.length} 条`;
    tbody.innerHTML = list.map((row) => {
      const status = String(row?.status || '');
      const statusText = status === 'rewarded' ? '已奖励' : (status === 'skipped' ? '已跳过' : (status === 'error' ? '异常' : status));
      const statusClass = status === 'rewarded' ? 'pillOk' : (status === 'error' ? 'pillBad' : '');
      const sourceText = row?.event_source === 'reconcile' ? '自动补发/对账' : '实时推送';
      const note = row?.error_message || row?.skip_reason || row?.reward_reason || '-';
      return `<tr>
        <td class="mono">${safeText(String(row?.check_time_text || '-'))}</td>
        <td>${safeText(row?.user_name_snapshot || row?.userid || '-')}</td>
        <td>${safeText(row?.check_type || '-')}</td>
        <td>${safeText(sourceText)}</td>
        <td><span class="pill ${statusClass}">${safeText(statusText)}</span></td>
        <td>${safeText(status === 'rewarded' ? `${Number(row?.reward_amount || 0)} BOB` : '-')}</td>
        <td>${safeText(note)}</td>
      </tr>`;
    }).join('');
  }

  async function openAttendanceStatusDetail(date) {
    attendanceStatusState.activeDate = String(date || '');
    const r = await fetchJson(`/admin/settings/attendance-reward/detail?date=${encodeURIComponent(attendanceStatusState.activeDate)}`);
    if (!r?.data?.ok) {
      setSimpleText('attendanceStatusDetailErr', r?.data?.error || (r?.status ? `HTTP ${r.status}` : '加载失败'), true);
      return;
    }
    setSimpleText('attendanceStatusDetailErr', '', false);
    attendanceStatusState.detailRows = Array.isArray(r.data?.rows) ? r.data.rows : [];
    renderAttendanceStatusDetail(attendanceStatusState.activeDate, attendanceStatusState.detailRows);
    setAttendanceStatusDetailVisible(true);
  }

  async function reconcileAttendanceStatusDetail() {
    if (!attendanceStatusState.activeDate) return;
    const btn = document.getElementById('btnAttendanceDetailReconcile');
    const prev = btn ? btn.disabled : false;
    if (btn) btn.disabled = true;
    setSimpleText('attendanceStatusDetailErr', '', false);
    try {
      const r = await fetchJson('/admin/settings/attendance-reward/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: attendanceStatusState.activeDate }),
      });
      if (!r?.data?.ok) {
        setSimpleText('attendanceStatusDetailErr', r?.data?.error || (r?.status ? `HTTP ${r.status}` : '对账失败'), true);
        return;
      }
      if (r.data?.data?.skipped && r.data?.data?.reason === 'after_cutoff') {
        setSimpleText('attendanceStatusDetailErr', '已过北京时间 09:00，今天不再执行自动补发。', true);
        return;
      }
      await loadAttendanceStatusList();
      await openAttendanceStatusDetail(attendanceStatusState.activeDate);
      setAttendanceStatusToast(`已完成 ${attendanceStatusState.activeDate} 的自动对账`, false);
    } finally {
      if (btn) btn.disabled = prev;
    }
  }

  function toDateTimeLocalValue(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day}T${hh}:${mm}`;
  }

  function fromDateTimeLocalValue(value) {
    const text = value ? String(value).trim() : '';
    if (!text) return null;
    const ms = new Date(text).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return Math.floor(ms / 1000);
  }

  async function createBobToken() {
    document.getElementById('tokenErr').textContent = '';
    const r = await fetchJson('/bob-token/create', { method: 'POST' });
    if (r.data?.ok) {
      await refreshTokenList();
      return;
    }
    document.getElementById('tokenErr').textContent = r.data?.error || '创建失败';
  }

  let userSearchTimer = null;

  function scheduleUserSearch() {
    if (userSearchTimer) {
      clearTimeout(userSearchTimer);
    }
    userSearchTimer = setTimeout(() => {
      userState.page = 1;
      loadUsers();
    }, 250);
  }

  function enableActions() {
    document.getElementById('btnConfirm').disabled = false;
    document.getElementById('btnScan').disabled = false;
    document.getElementById('btnSyncUsers').disabled = false;
    document.getElementById('btnToggleSelect').disabled = false;
    document.getElementById('btnSelectMenu').disabled = false;
    document.getElementById('btnBulkGrant').disabled = false;
    document.getElementById('btnBulkDeduct').disabled = false;
    const btnBulkNotify = document.getElementById('btnBulkNotify');
    if (btnBulkNotify) btnBulkNotify.disabled = false;
    document.getElementById('btnBulkDelete').disabled = false;
    const btnResetUser = document.getElementById('btnResetUserData');
    if (btnResetUser) btnResetUser.disabled = false;
    const btnResetAll = document.getElementById('btnResetAllData');
    if (btnResetAll) btnResetAll.disabled = false;

    document.getElementById('btnCreateToken').disabled = false;
    document.getElementById('btnRefreshTokens').disabled = false;
    document.getElementById('btnLogout').disabled = false;
    const btnRedeemHistoryRefresh = document.getElementById('btnRedeemHistoryRefresh');
    if (btnRedeemHistoryRefresh) btnRedeemHistoryRefresh.disabled = false;

    const btnRedeemHistoryMore = document.getElementById('btnRedeemHistoryMore');
    if (btnRedeemHistoryMore) btnRedeemHistoryMore.disabled = false;

    const btnRedeemHistoryClear = document.getElementById('btnRedeemHistoryClear');
    if (btnRedeemHistoryClear) btnRedeemHistoryClear.disabled = false;

    const btnRedeemPendingRefresh = document.getElementById('btnRedeemPendingRefresh');
    if (btnRedeemPendingRefresh) btnRedeemPendingRefresh.disabled = false;

    const btnRedeemPendingMore = document.getElementById('btnRedeemPendingMore');
    if (btnRedeemPendingMore) btnRedeemPendingMore.disabled = false;

    const btnMallRefresh = document.getElementById('btnMallProductRefresh');
    if (btnMallRefresh) btnMallRefresh.disabled = false;

    const btnCharityProjectRefresh = document.getElementById('btnCharityProjectRefresh');
    if (btnCharityProjectRefresh) btnCharityProjectRefresh.disabled = false;

    const btnCharityProjectCreate = document.getElementById('btnCharityProjectCreate');
    if (btnCharityProjectCreate) btnCharityProjectCreate.disabled = false;

    const btnCharityContributionRefresh = document.getElementById('btnCharityContributionRefresh');
    if (btnCharityContributionRefresh) btnCharityContributionRefresh.disabled = false;

    const btnMallCreate = document.getElementById('btnMallProductCreate');
    if (btnMallCreate) btnMallCreate.disabled = mallState.mode !== 'self';

    const btnMallModeAi = document.getElementById('btnMallModeAiTable');
    const btnMallModeSelf = document.getElementById('btnMallModeSelf');
    const btnMallModeYida = document.getElementById('btnMallModeYida');
    if (btnMallModeAi) btnMallModeAi.disabled = true;
    if (btnMallModeSelf) btnMallModeSelf.disabled = false;
    if (btnMallModeYida) btnMallModeYida.disabled = true;

    const btnMallToggleNow = document.getElementById('btnMallToggleNow');
    if (btnMallToggleNow) btnMallToggleNow.disabled = false;
    const btnMallOpeningMore = document.getElementById('btnMallOpeningMore');
    if (btnMallOpeningMore) btnMallOpeningMore.disabled = false;
    const btnMallOpeningSave = document.getElementById('btnMallOpeningSave');
    if (btnMallOpeningSave) btnMallOpeningSave.disabled = false;
    const btnMallOpeningRefresh = document.getElementById('btnMallOpeningRefresh');
    if (btnMallOpeningRefresh) btnMallOpeningRefresh.disabled = false;

    const btnGroupCardSend = document.getElementById('btnGroupCardSend');
    if (btnGroupCardSend) btnGroupCardSend.disabled = false;
    const btnGroupCardClear = document.getElementById('btnGroupCardClear');
    if (btnGroupCardClear) btnGroupCardClear.disabled = false;
    const btnGroupCardTplSave = document.getElementById('btnGroupCardTplSave');
    if (btnGroupCardTplSave) btnGroupCardTplSave.disabled = false;
    const btnGroupCardTplReset = document.getElementById('btnGroupCardTplReset');
    if (btnGroupCardTplReset) btnGroupCardTplReset.disabled = false;
    const btnGroupCardTplTest = document.getElementById('btnGroupCardTplTest');
    if (btnGroupCardTplTest) btnGroupCardTplTest.disabled = false;

    const btnNotifyTest = document.getElementById('btnNotifyTest');
    if (btnNotifyTest) btnNotifyTest.disabled = false;
    const btnNotifyTplSave = document.getElementById('btnNotifyTplSave');
    if (btnNotifyTplSave) btnNotifyTplSave.disabled = false;
    const btnNotifyTplReset = document.getElementById('btnNotifyTplReset');
    if (btnNotifyTplReset) btnNotifyTplReset.disabled = false;

    const btnAttendanceRewardSave = document.getElementById('btnAttendanceRewardSave');
    if (btnAttendanceRewardSave) btnAttendanceRewardSave.disabled = false;
    const btnAttendanceRewardReset = document.getElementById('btnAttendanceRewardReset');
    if (btnAttendanceRewardReset) btnAttendanceRewardReset.disabled = false;
    const btnAttendanceStatusRefresh = document.getElementById('btnAttendanceStatusRefresh');
    if (btnAttendanceStatusRefresh) btnAttendanceStatusRefresh.disabled = false;

    const btnExportSettings = document.getElementById('btnExportSettings');
    if (btnExportSettings) btnExportSettings.disabled = false;
    const btnExportFull = document.getElementById('btnExportFull');
    if (btnExportFull) btnExportFull.disabled = false;
    const btnImportBackup = document.getElementById('btnImportBackup');
    if (btnImportBackup) btnImportBackup.disabled = false;

    const btnCdkGenerate = document.getElementById('btnCdkGenerate');
    if (btnCdkGenerate) btnCdkGenerate.disabled = false;
    const btnCdkRefresh = document.getElementById('btnCdkRefresh');
    if (btnCdkRefresh) btnCdkRefresh.disabled = false;

    const btnRedPacketStart = document.getElementById('btnRedPacketStart');
    if (btnRedPacketStart) btnRedPacketStart.disabled = false;

    const btnRedPacketHistoryRefresh = document.getElementById('btnRedPacketHistoryRefresh');
    if (btnRedPacketHistoryRefresh) btnRedPacketHistoryRefresh.disabled = false;
    const btnRedPacketHistoryClear = document.getElementById('btnRedPacketHistoryClear');
    if (btnRedPacketHistoryClear) btnRedPacketHistoryClear.disabled = false;

    const btnAuditLogRefresh = document.getElementById('btnAuditLogRefresh');
    if (btnAuditLogRefresh) btnAuditLogRefresh.disabled = false;

    const ids = [
      'btnFaqRefresh',
      'btnFaqClear',
      'btnFaqSave',
      'btnAnnouncementRefresh',
      'btnAnnouncementClear',
      'btnAnnouncementSave',
      'btnFeedbackRefresh',
      'btnVersionRefresh',
      'btnVersionClear',
      'btnVersionSave',
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    }
  }

  function bindButtons() {
    document.getElementById('btnConfirm').addEventListener('click', async () => {
      const encoded = document.getElementById('confirmEncoded').value.trim();

      openRedeemModalFromEncoded(encoded, { showError: true });
    });
    document.getElementById('btnConfirmClear').addEventListener('click', () => {
      setConfirmText('');
    });

    document.getElementById('confirmEncoded').addEventListener('input', () => {
      if (redeemModalSuccessPending) return;
      const encoded = document.getElementById('confirmEncoded').value;
      openRedeemModalFromEncoded(encoded);
    });

    document.getElementById('btnRedeemModalClose').addEventListener('click', () => {
      closeRedeemModal();
    });

    document.getElementById('redeemModal').addEventListener('click', (ev) => {
      if (ev?.target?.id === 'redeemModal') {
        closeRedeemModal();
      }
    });

    document.getElementById('btnRedeemModalConfirm').addEventListener('click', async () => {
      const encoded = document.getElementById('confirmEncoded').value.trim();
      const preview = openRedeemModalFromEncoded(encoded, { showError: true });
      if (!preview) return;

      const btn = document.getElementById('btnRedeemModalConfirm');
      const btnClose = document.getElementById('btnRedeemModalClose');
      const prevDisabled = btn ? btn.disabled : false;
      const prevCloseDisabled = btnClose ? btnClose.disabled : false;
      if (btn) btn.disabled = true;
      if (btnClose) btnClose.disabled = true;
      redeemModalBusy = true;
      setRedeemModalToast('正在核销…', false);

      try {
        const r = await fetchJson('/admin/redeem/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ encoded: preview.encoded }),
        });
        const result = showRedeemResult(r);
        if (result?.ok) {
          setRedeemModalToast(result.text, false);
          redeemModalSuccessPending = true;
          await loadRedeemHistory();
        } else {
          setRedeemModalToast(result?.text || '核销失败', true);
        }
      } finally {
        redeemModalBusy = false;
        if (btn) btn.disabled = redeemModalSuccessPending ? true : prevDisabled;
        if (btnClose) btnClose.disabled = prevCloseDisabled;
      }
    });

    const details = document.getElementById('redeemHistoryDetails');
    if (details) {
      details.addEventListener('toggle', async () => {
        if (details.open) {
          await loadRedeemHistory();
        }
      });
    }
    const btnHist = document.getElementById('btnRedeemHistoryRefresh');
    if (btnHist) {
      btnHist.addEventListener('click', async () => {
        await loadRedeemHistory();
      });
    }

    const btnHistMore = document.getElementById('btnRedeemHistoryMore');
    if (btnHistMore) {
      btnHistMore.addEventListener('click', async () => {
        await loadRedeemHistoryMore();
      });
    }

    const btnHistClear = document.getElementById('btnRedeemHistoryClear');
    if (btnHistClear) {
      btnHistClear.addEventListener('click', async () => {
        await clearRedeemHistory();
      });
    }

    const pendingDetails = document.getElementById('redeemPendingDetails');
    if (pendingDetails) {
      pendingDetails.addEventListener('toggle', async () => {
        if (pendingDetails.open) {
          await loadRedeemPending();
        }
      });
    }

    const btnPending = document.getElementById('btnRedeemPendingRefresh');
    if (btnPending) {
      btnPending.addEventListener('click', async () => {
        await loadRedeemPending();
      });
    }

    const btnPendingMore = document.getElementById('btnRedeemPendingMore');
    if (btnPendingMore) {
      btnPendingMore.addEventListener('click', async () => {
        await loadRedeemPendingMore();
      });
    }

    document.getElementById('tabUsers').addEventListener('click', () => switchTab('users'));
    document.getElementById('tabRedeem').addEventListener('click', () => switchTab('redeem'));
    document.getElementById('tabMall').addEventListener('click', () => switchTab('mall'));
    const tabRedPacket = document.getElementById('tabRedPacket');
    if (tabRedPacket) tabRedPacket.addEventListener('click', () => switchTab('redPacket'));
    const tabMessages = document.getElementById('tabMessages');
    if (tabMessages) tabMessages.addEventListener('click', () => switchTab('messages'));
    document.getElementById('tabSettings').addEventListener('click', () => switchTab('settings'));

    document.getElementById('btnSyncUsers').addEventListener('click', syncUsers);
    document.getElementById('btnToggleSelect').addEventListener('click', toggleSelectMode);
    document.getElementById('btnSelectMenu').addEventListener('click', toggleSelectMenu);
    document.getElementById('btnSelectPage').addEventListener('click', selectCurrentPage);
    document.getElementById('btnSelectAll').addEventListener('click', selectAllUsers);
    document.getElementById('btnSelectClear').addEventListener('click', clearPicked);
    document.getElementById('btnBulkGrant').addEventListener('click', openGrantModal);
    document.getElementById('btnBulkDeduct').addEventListener('click', openDeductModal);
    const btnBulkNotify = document.getElementById('btnBulkNotify');
    if (btnBulkNotify) btnBulkNotify.addEventListener('click', openNotifyModal);
    document.getElementById('btnBulkDelete').addEventListener('click', bulkDelete);

    const btnResetUser = document.getElementById('btnResetUserData');
    if (btnResetUser) {
      btnResetUser.addEventListener('click', resetSelectedUserData);
    }
    const btnResetAll = document.getElementById('btnResetAllData');
    if (btnResetAll) {
      btnResetAll.addEventListener('click', resetAllData);
    }

    const userKeyword = document.getElementById('userKeyword');
    if (userKeyword) {
      userKeyword.addEventListener('input', scheduleUserSearch);
    }
    document.getElementById('btnUserPrev').addEventListener('click', () => {
      if (userState.page <= 1) return;
      userState.page -= 1;
      loadUsers();
    });
    document.getElementById('btnUserNext').addEventListener('click', () => {
      const maxPage = Math.max(1, Math.ceil((userState.total || 0) / userState.pageSize));
      if (userState.page >= maxPage) return;
      userState.page += 1;
      loadUsers();
    });

    document.getElementById('btnScan').addEventListener('click', scanQr);
    document.getElementById('btnStopScan').addEventListener('click', stopCamera);

    document.getElementById('btnCreateToken').addEventListener('click', createBobToken);
    document.getElementById('btnRefreshTokens').addEventListener('click', refreshTokenList);

    const btnGroupCardSend = document.getElementById('btnGroupCardSend');
    if (btnGroupCardSend) {
      btnGroupCardSend.addEventListener('click', async () => {
        await sendGroupCardFromForm();
      });
    }
    const btnGroupCardClear = document.getElementById('btnGroupCardClear');
    if (btnGroupCardClear) {
      btnGroupCardClear.addEventListener('click', () => {
        clearGroupCardForm();
      });
    }
    const btnGroupCardTplSave = document.getElementById('btnGroupCardTplSave');
    if (btnGroupCardTplSave) {
      btnGroupCardTplSave.addEventListener('click', async () => {
        await saveGroupCardSettings();
      });
    }
    const btnGroupCardTplReset = document.getElementById('btnGroupCardTplReset');
    if (btnGroupCardTplReset) {
      btnGroupCardTplReset.addEventListener('click', async () => {
        await saveGroupCardSettings({ reset: true });
      });
    }
    const btnGroupCardTplTest = document.getElementById('btnGroupCardTplTest');
    if (btnGroupCardTplTest) {
      btnGroupCardTplTest.addEventListener('click', async () => {
        await sendGroupCardTemplateTest();
      });
    }

    const btnAttendanceRewardSave = document.getElementById('btnAttendanceRewardSave');
    if (btnAttendanceRewardSave) {
      btnAttendanceRewardSave.addEventListener('click', async () => {
        await saveAttendanceRewardSettings();
      });
    }
    const btnAttendanceRewardReset = document.getElementById('btnAttendanceRewardReset');
    if (btnAttendanceRewardReset) {
      btnAttendanceRewardReset.addEventListener('click', async () => {
        await saveAttendanceRewardSettings({ reset: true });
      });
    }
    const btnAttendanceStatusRefresh = document.getElementById('btnAttendanceStatusRefresh');
    if (btnAttendanceStatusRefresh) {
      btnAttendanceStatusRefresh.addEventListener('click', async () => {
        await loadAttendanceStatusList();
      });
    }
    const attendanceStatusDays = document.getElementById('attendanceStatusDays');
    if (attendanceStatusDays) {
      attendanceStatusDays.addEventListener('change', async () => {
        await loadAttendanceStatusList();
      });
    }
    const attendanceStatusTable = document.getElementById('attendanceStatusTable');
    if (attendanceStatusTable) {
      attendanceStatusTable.addEventListener('click', async (ev) => {
        const target = ev?.target;
        const date = target?.getAttribute ? target.getAttribute('data-attendance-detail') : '';
        if (!date) return;
        await openAttendanceStatusDetail(date);
      });
    }
    const attendanceDetailModal = document.getElementById('attendanceStatusDetailModal');
    if (attendanceDetailModal) {
      attendanceDetailModal.addEventListener('click', (ev) => {
        if (ev?.target?.id === 'attendanceStatusDetailModal') setAttendanceStatusDetailVisible(false);
      });
    }
    const btnAttendanceDetailClose = document.getElementById('btnAttendanceDetailClose');
    if (btnAttendanceDetailClose) btnAttendanceDetailClose.addEventListener('click', () => setAttendanceStatusDetailVisible(false));
    const btnAttendanceDetailReconcile = document.getElementById('btnAttendanceDetailReconcile');
    if (btnAttendanceDetailReconcile) btnAttendanceDetailReconcile.addEventListener('click', async () => { await reconcileAttendanceStatusDetail(); });

    // ── 备份管理 ──
    function setBackupToast(msg) {
      const el = document.getElementById('backupToast');
      if (el) { el.textContent = msg; el.style.display = msg ? '' : 'none'; }
    }
    function setBackupErr(msg) {
      const el = document.getElementById('backupErr');
      if (el) { el.textContent = msg; el.style.display = msg ? '' : 'none'; }
    }
    function setBackupReport(report) {
      const el = document.getElementById('backupReport');
      if (!el) return;
      if (!report) { el.style.display = 'none'; return; }
      const lines = Object.entries(report).map(([k, v]) => `${k}：${v} 条`).join('<br>');
      el.innerHTML = `<b>导入结果：</b><br>${lines}`;
      el.style.display = '';
    }

    async function exportBackup(mode) {
      setBackupToast(''); setBackupErr(''); setBackupReport(null);
      try {
        const res = await fetch(`/admin/backup/export?mode=${mode}`, { credentials: 'include' });
        if (!res.ok) { const e = await res.json().catch(() => ({})); setBackupErr(e.error || '导出失败'); return; }
        const blob = await res.blob();
        const cd = res.headers.get('content-disposition') || '';
        const match = cd.match(/filename="([^"]+)"/);
        const filename = match ? match[1] : `bob_backup_${mode}_${Date.now()}.json`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        setBackupToast(`✅ 已导出：${filename}`);
      } catch (err) {
        setBackupErr(String(err?.message || err));
      }
    }

    const btnExportSettings = document.getElementById('btnExportSettings');
    if (btnExportSettings) btnExportSettings.addEventListener('click', () => exportBackup('settings'));
    const btnExportFull = document.getElementById('btnExportFull');
    if (btnExportFull) btnExportFull.addEventListener('click', () => exportBackup('full'));

    const backupFileInput = document.getElementById('backupFileInput');
    const backupFileName = document.getElementById('backupFileName');
    if (backupFileInput) {
      backupFileInput.addEventListener('change', () => {
        const f = backupFileInput.files?.[0];
        if (backupFileName) backupFileName.textContent = f ? f.name : '选择备份文件…';
        setBackupToast(''); setBackupErr(''); setBackupReport(null);
      });
    }

    const btnImportBackup = document.getElementById('btnImportBackup');
    if (btnImportBackup) {
      btnImportBackup.addEventListener('click', async () => {
        const file = backupFileInput?.files?.[0];
        if (!file) { setBackupErr('请先选择备份文件'); return; }
        const importMode = document.getElementById('backupImportMode')?.value || 'merge';
        if (importMode === 'overwrite') {
          const ok = window.confirm('⚠️ 覆盖模式会清空并替换对应表的所有数据，此操作不可撤销。\n\n确认继续？');
          if (!ok) return;
        }
        setBackupToast('导入中…'); setBackupErr(''); setBackupReport(null);
        btnImportBackup.disabled = true;
        try {
          let backup;
          try {
            const text = await file.text();
            backup = JSON.parse(text);
          } catch {
            setBackupToast('');
            setBackupErr('备份文件解析失败，请确认文件完整且为有效的 JSON 格式');
            return;
          }
          const res = await fetch('/admin/backup/import', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backup, mode: importMode }),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || !json.ok) {
            setBackupToast('');
            setBackupErr(json.error || `导入失败（HTTP ${res.status}）`);
            return;
          }
          setBackupToast(`✅ 导入完成（${importMode === 'overwrite' ? '覆盖' : '合并'}模式）`);
          setBackupReport(json.report);
        } catch (err) {
          setBackupToast('');
          setBackupErr(String(err?.message || err));
        } finally {
          btnImportBackup.disabled = false;
        }
      });
    }

    const groupTplSelect = document.getElementById('groupCardTemplateSelect');
    if (groupTplSelect) {
      groupTplSelect.addEventListener('change', () => {
        const prev = groupCardState.activeTemplate || 'manual';
        syncGroupTemplateFromInputs(prev);
        renderGroupTemplate(groupTplSelect.value || 'manual');
      });
    }
    const groupConversationPreset = document.getElementById('groupCardConversationPreset');
    if (groupConversationPreset) {
      groupConversationPreset.addEventListener('change', () => {
        syncGroupCardConversationPresetUi();
      });
    }
    const groupTplTitle = document.getElementById('groupCardTplTitle');
    const groupTplContent = document.getElementById('groupCardTplContent');
    const groupTplEnabled = document.getElementById('groupCardTplEnabled');
    const groupTplButtons = document.getElementById('groupCardTplButtons');
    const syncGroupNow = () => {
      const key = document.getElementById('groupCardTemplateSelect')?.value || groupCardState.activeTemplate || 'manual';
      syncGroupTemplateFromInputs(key);
    };
    if (groupTplTitle) groupTplTitle.addEventListener('input', syncGroupNow);
    if (groupTplContent) groupTplContent.addEventListener('input', syncGroupNow);
    if (groupTplEnabled) groupTplEnabled.addEventListener('change', syncGroupNow);
    if (groupTplButtons) groupTplButtons.addEventListener('input', syncGroupNow);

    const btnNotifyTplSave = document.getElementById('btnNotifyTplSave');
    if (btnNotifyTplSave) {
      btnNotifyTplSave.addEventListener('click', async () => {
        await saveNotifySettings();
      });
    }
    const btnNotifyTplReset = document.getElementById('btnNotifyTplReset');
    if (btnNotifyTplReset) {
      btnNotifyTplReset.addEventListener('click', async () => {
        await saveNotifySettings({ reset: true });
      });
    }
    const btnNotifyTest = document.getElementById('btnNotifyTest');
    if (btnNotifyTest) {
      btnNotifyTest.addEventListener('click', async () => {
        await sendNotifyTest();
      });
    }
    const notifyTemplateSelect = document.getElementById('notifyTemplateSelect');
    if (notifyTemplateSelect) {
      notifyTemplateSelect.addEventListener('change', () => {
        const prev = notifyState.activeTemplate || 'grant';
        syncNotifyTemplateFromInputs(prev);
        renderNotifyTemplate(notifyTemplateSelect.value || 'grant');
      });
    }
    const notifyTplTitle = document.getElementById('notifyTplTitle');
    const notifyTplContent = document.getElementById('notifyTplContent');
    const notifyTplEnabled = document.getElementById('notifyTplEnabled');
    const syncNow = () => {
      const key = document.getElementById('notifyTemplateSelect')?.value || notifyState.activeTemplate || 'grant';
      syncNotifyTemplateFromInputs(key);
    };
    if (notifyTplTitle) notifyTplTitle.addEventListener('input', syncNow);
    if (notifyTplContent) notifyTplContent.addEventListener('input', syncNow);
    if (notifyTplEnabled) notifyTplEnabled.addEventListener('change', syncNow);

    const notifyTestName = document.getElementById('notifyTestName');
    const notifyTestList = document.getElementById('notifyTestList');
    if (notifyTestName) {
      notifyTestName.addEventListener('input', () => {
        if (notifyState.testSearchTimer) {
          clearTimeout(notifyState.testSearchTimer);
        }
        notifyState.testSearchTimer = setTimeout(async () => {
          notifyState.testSearchSeq += 1;
          const seq = notifyState.testSearchSeq;
          const keyword = notifyTestName.value;
          const rows = await fetchNotifyTestCandidates(keyword);
          if (seq !== notifyState.testSearchSeq) return;
          if (!keyword) {
            setNotifyTestTarget(null);
          }
          return rows;
        }, 240);
      });
    }
    if (notifyTestList) {
      notifyTestList.addEventListener('click', (ev) => {
        const node = ev?.target?.closest?.('.notifyTestItem');
        if (!node) return;
        const userid = node.getAttribute('data-userid') || '';
        const name = node.getAttribute('data-name') || '';
        const display = node.getAttribute('data-display') || '';
        if (!userid) return;
        const target = { userid, name, display_name: display || name || userid || '用户' };
        setNotifyTestTarget(target);
        if (notifyTestName) notifyTestName.value = target.display_name;
        notifyTestList.classList.add('hidden');
      });
    }

    document.getElementById('btnModalCancel').addEventListener('click', closeGrantModal);
    document.getElementById('btnModalSubmit').addEventListener('click', submitGrantModal);

    document.getElementById('btnDeductCancel').addEventListener('click', closeDeductModal);
    document.getElementById('btnDeductSubmit').addEventListener('click', submitDeductModal);

    const btnNotifyCancel = document.getElementById('btnNotifyCancel');
    if (btnNotifyCancel) btnNotifyCancel.addEventListener('click', closeNotifyModal);
    const btnNotifySubmit = document.getElementById('btnNotifySubmit');
    if (btnNotifySubmit) btnNotifySubmit.addEventListener('click', submitNotifyModal);

    document.getElementById('grantModal').addEventListener('click', (ev) => {
      if (ev?.target?.id === 'grantModal') {
        closeGrantModal();
      }
    });

    document.getElementById('deductModal').addEventListener('click', (ev) => {
      if (ev?.target?.id === 'deductModal') {
        closeDeductModal();
      }
    });

    const notifyModal = document.getElementById('notifyModal');
    if (notifyModal) {
      notifyModal.addEventListener('click', (ev) => {
        if (ev?.target?.id === 'notifyModal') {
          closeNotifyModal();
        }
      });
    }

    document.addEventListener('click', (ev) => {
      const menu = document.getElementById('selectMenu');
      if (!menu || menu.classList.contains('hidden')) return;
      const wrap = document.querySelector('.selectWrap');
      if (wrap && wrap.contains(ev.target)) return;
      menu.classList.add('hidden');
    });

    document.getElementById('btnLogout').addEventListener('click', async () => {
      await fetchJson('/admin/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      window.location.replace('/admin/login');
    });

    const btnMallRefresh = document.getElementById('btnMallProductRefresh');
    if (btnMallRefresh) {
      btnMallRefresh.addEventListener('click', async () => {
        await loadMallProducts();
      });
    }

    const btnMallModeSelf = document.getElementById('btnMallModeSelf');
    if (btnMallModeSelf) {
      btnMallModeSelf.addEventListener('click', async () => {
        setMallMode('self');
        await loadMallProducts();
        await loadMallOpening();
      });
    }

    const btnMallCreate = document.getElementById('btnMallProductCreate');
    if (btnMallCreate) {
      btnMallCreate.addEventListener('click', () => {
        openMallProductModal({ status: 'on' });
      });
    }

    const btnRedPacketStart = document.getElementById('btnRedPacketStart');
    if (btnRedPacketStart) {
      btnRedPacketStart.addEventListener('click', () => {
        startRedPacket();
      });
    }

    const btnRedPacketHistoryRefresh = document.getElementById('btnRedPacketHistoryRefresh');
    if (btnRedPacketHistoryRefresh) {
      btnRedPacketHistoryRefresh.addEventListener('click', () => {
        loadRedPacketHistory();
      });
    }

    const btnRedPacketHistoryClear = document.getElementById('btnRedPacketHistoryClear');
    if (btnRedPacketHistoryClear) {
      btnRedPacketHistoryClear.addEventListener('click', () => {
        clearRedPacketHistory();
      });
    }

    const btnAuditLogRefresh = document.getElementById('btnAuditLogRefresh');
    if (btnAuditLogRefresh) {
      btnAuditLogRefresh.addEventListener('click', () => {
        loadAuditLogs();
      });
    }

    const auditLogAuto = document.getElementById('auditLogAuto');
    if (auditLogAuto) {
      auditLogAuto.addEventListener('change', () => {
        auditLogState.auto = Boolean(auditLogAuto.checked);
        if (auditLogState.auto) {
          startAuditLogAutoRefresh();
        } else {
          stopAuditLogAutoRefresh();
        }
      });
    }

    const btnFaqRefresh = document.getElementById('btnFaqRefresh');
    if (btnFaqRefresh) btnFaqRefresh.addEventListener('click', () => loadFaqList());
    const btnFaqClear = document.getElementById('btnFaqClear');
    if (btnFaqClear) btnFaqClear.addEventListener('click', () => resetFaqForm());
    const btnFaqSave = document.getElementById('btnFaqSave');
    if (btnFaqSave) btnFaqSave.addEventListener('click', () => saveFaq());

    const faqTable = document.getElementById('faqTable');
    if (faqTable) {
      faqTable.addEventListener('click', (ev) => {
        const target = ev?.target;
        const editId = target?.getAttribute ? target.getAttribute('data-faq-edit') : '';
        if (editId) {
          const row = contentState.faq.find((x) => String(x?.id || '') === String(editId));
          fillFaqForm(row || null);
          return;
        }
        const deleteId = target?.getAttribute ? target.getAttribute('data-faq-delete') : '';
        if (deleteId) {
          deleteFaq(deleteId);
        }
      });
    }

    const btnAnnouncementRefresh = document.getElementById('btnAnnouncementRefresh');
    if (btnAnnouncementRefresh) btnAnnouncementRefresh.addEventListener('click', () => loadAnnouncementList());
    const btnAnnouncementClear = document.getElementById('btnAnnouncementClear');
    if (btnAnnouncementClear) btnAnnouncementClear.addEventListener('click', () => resetAnnouncementForm());
    const btnAnnouncementSave = document.getElementById('btnAnnouncementSave');
    if (btnAnnouncementSave) btnAnnouncementSave.addEventListener('click', () => saveAnnouncement());

    const announcementTable = document.getElementById('announcementTable');
    if (announcementTable) {
      announcementTable.addEventListener('click', (ev) => {
        const target = ev?.target;
        const editId = target?.getAttribute ? target.getAttribute('data-announcement-edit') : '';
        if (editId) {
          const row = contentState.announcements.find((x) => String(x?.id || '') === String(editId));
          fillAnnouncementForm(row || null);
          return;
        }
        const deleteId = target?.getAttribute ? target.getAttribute('data-announcement-delete') : '';
        if (deleteId) {
          deleteAnnouncement(deleteId);
        }
      });
    }

    const btnFeedbackRefresh = document.getElementById('btnFeedbackRefresh');
    if (btnFeedbackRefresh) btnFeedbackRefresh.addEventListener('click', () => loadFeedbackList());
    const feedbackKeyword = document.getElementById('feedbackKeyword');
    if (feedbackKeyword) feedbackKeyword.addEventListener('input', () => loadFeedbackList());
    const feedbackStatusFilter = document.getElementById('feedbackStatusFilter');
    if (feedbackStatusFilter) feedbackStatusFilter.addEventListener('change', () => loadFeedbackList());
    const feedbackTable = document.getElementById('feedbackTable');
    if (feedbackTable) {
      feedbackTable.addEventListener('click', (ev) => {
        const target = ev?.target;
        const id = target?.getAttribute ? target.getAttribute('data-feedback-handle') : '';
        if (!id) return;
        handleFeedback(id);
      });
    }

    const btnVersionRefresh = document.getElementById('btnVersionRefresh');
    if (btnVersionRefresh) btnVersionRefresh.addEventListener('click', () => loadVersionList());
    const btnVersionClear = document.getElementById('btnVersionClear');
    if (btnVersionClear) btnVersionClear.addEventListener('click', () => resetVersionForm());
    const btnVersionSave = document.getElementById('btnVersionSave');
    if (btnVersionSave) btnVersionSave.addEventListener('click', () => saveVersion());
    const versionTable = document.getElementById('versionTable');
    if (versionTable) {
      versionTable.addEventListener('click', (ev) => {
        const target = ev?.target;
        const id = target?.getAttribute ? target.getAttribute('data-version-edit') : '';
        if (!id) return;
        const row = contentState.versions.find((x) => String(x?.id || '') === String(id));
        fillVersionForm(row || null);
      });
    }

    const redPacketHistoryTable = document.getElementById('redPacketHistoryTable');
    if (redPacketHistoryTable) {
      redPacketHistoryTable.addEventListener('click', (ev) => {
        const target = ev?.target;
        const id = target?.getAttribute ? target.getAttribute('data-rp-delete') : '';
        if (!id) return;
        deleteRedPacketHistoryItem(id);
      });
    }

    const mallProductLimitEnable = document.getElementById('mallProductLimitEnable');
    if (mallProductLimitEnable) {
      mallProductLimitEnable.addEventListener('change', syncMallProductLimitInput);
    }

    const tbody = document.getElementById('mallProductTable');
    if (tbody) {
      tbody.addEventListener('click', (ev) => {
        const t = ev?.target;
        const pid = t?.getAttribute ? t.getAttribute('data-mall-edit') : '';
        if (pid) {
          const row = mallState.rowsById.get(String(pid)) || null;
          openMallProductModal(row);
          return;
        }
        const delPid = t?.getAttribute ? t.getAttribute('data-mall-delete') : '';
        if (delPid) {
          deleteMallProduct(delPid);
        }
      });
    }

    const charityProjectTable = document.getElementById('charityProjectTable');
    if (charityProjectTable) {
      charityProjectTable.addEventListener('click', (ev) => {
        const target = ev?.target;
        const projectId = target?.getAttribute ? target.getAttribute('data-charity-edit') : '';
        if (!projectId) return;
        const row = charityState.rowsById.get(String(projectId)) || null;
        openCharityProjectModal(row);
      });
    }

    const btnCharityProjectRefresh = document.getElementById('btnCharityProjectRefresh');
    if (btnCharityProjectRefresh) {
      btnCharityProjectRefresh.addEventListener('click', async () => {
        await loadCharityProjectsAdmin();
      });
    }

    const btnCharityProjectCreate = document.getElementById('btnCharityProjectCreate');
    if (btnCharityProjectCreate) {
      btnCharityProjectCreate.addEventListener('click', () => {
        openCharityProjectModal({ status: 'active', execution_status: 'pending', tier_options: [10, 20, 50, 100] });
      });
    }

    const btnCharityContributionRefresh = document.getElementById('btnCharityContributionRefresh');
    if (btnCharityContributionRefresh) {
      btnCharityContributionRefresh.addEventListener('click', async () => {
        await loadCharityContributionsAdmin();
      });
    }

    const charityContributionProjectFilter = document.getElementById('charityContributionProjectFilter');
    if (charityContributionProjectFilter) {
      charityContributionProjectFilter.addEventListener('change', async () => {
        await loadCharityContributionsAdmin();
      });
    }

    const cdkTable = document.getElementById('cdkTable');
    if (cdkTable) {
      cdkTable.addEventListener('click', (ev) => {
        const target = ev?.target;
        const id = target?.getAttribute ? target.getAttribute('data-cdk-delete') : '';
        if (id) deleteCdk(id);
      });
    }

    const btnMallCancel = document.getElementById('btnMallProductCancel');
    if (btnMallCancel) {
      btnMallCancel.addEventListener('click', () => {
        closeMallProductModal();
      });
    }

    const btnMallSave = document.getElementById('btnMallProductSave');
    if (btnMallSave) {
      btnMallSave.addEventListener('click', async () => {
        await saveMallProductModal();
      });
    }

    const btnCharityProjectCancel = document.getElementById('btnCharityProjectCancel');
    if (btnCharityProjectCancel) {
      btnCharityProjectCancel.addEventListener('click', () => {
        closeCharityProjectModal();
      });
    }

    const btnCharityProjectSave = document.getElementById('btnCharityProjectSave');
    if (btnCharityProjectSave) {
      btnCharityProjectSave.addEventListener('click', async () => {
        await saveCharityProjectModal();
      });
    }

    const btnMallToggleNow = document.getElementById('btnMallToggleNow');
    if (btnMallToggleNow) {
      btnMallToggleNow.addEventListener('click', async () => {
        await toggleMallNow();
      });
    }
    const btnMallOpeningMore = document.getElementById('btnMallOpeningMore');
    if (btnMallOpeningMore) {
      btnMallOpeningMore.addEventListener('click', () => {
        setMallOpeningAdvancedVisible(!mallState.openingAdvancedVisible);
      });
    }

    const btnMallOpeningSave = document.getElementById('btnMallOpeningSave');
    if (btnMallOpeningSave) {
      btnMallOpeningSave.addEventListener('click', async () => {
        await saveMallOpening();
      });
    }

    const btnMallOpeningRefresh = document.getElementById('btnMallOpeningRefresh');
    if (btnMallOpeningRefresh) {
      btnMallOpeningRefresh.addEventListener('click', async () => {
        await loadMallOpening();
      });
    }

    const btnCdkGenerate = document.getElementById('btnCdkGenerate');
    if (btnCdkGenerate) {
      btnCdkGenerate.addEventListener('click', async () => {
        await generateCdks();
      });
    }

    const btnCdkRefresh = document.getElementById('btnCdkRefresh');
    if (btnCdkRefresh) {
      btnCdkRefresh.addEventListener('click', async () => {
        await loadCdkProducts();
        await loadCdkList();
      });
    }

    const btnCdkCopyBatch = document.getElementById('btnCdkCopyBatch');
    if (btnCdkCopyBatch) {
      btnCdkCopyBatch.addEventListener('click', async () => {
        if (!mallState.lastGeneratedCdks.length) return;
        try {
          await navigator.clipboard.writeText(mallState.lastGeneratedCdks.join('\n'));
          setCdkToast('已复制本批次 CDK', false);
        } catch (err) {
          setCdkToast(String(err?.message || err), true);
        }
      });
    }

    const mallModal = document.getElementById('mallProductModal');
    if (mallModal) {
      mallModal.addEventListener('click', (ev) => {
        if (ev?.target?.id === 'mallProductModal') {
          closeMallProductModal();
        }
      });
    }

    const charityModal = document.getElementById('charityProjectModal');
    if (charityModal) {
      charityModal.addEventListener('click', (ev) => {
        if (ev?.target?.id === 'charityProjectModal') {
          closeCharityProjectModal();
        }
      });
    }

    const imgFile = document.getElementById('mallProductImageFile');
    if (imgFile) {
      imgFile.addEventListener('change', async () => {
        const file = imgFile.files && imgFile.files[0] ? imgFile.files[0] : null;
        if (!file) return;
        try {
          const dataUrl = await fileToDataUrl(file);
          await openMallCropper(dataUrl);
        } catch (err) {
          setMallProductModalErr(String(err?.message || err));
        }
      });
    }

    const btnImgClear = document.getElementById('btnMallProductImageClear');
    if (btnImgClear) {
      btnImgClear.addEventListener('click', () => {
        if (imgFile) imgFile.value = '';
        setMallProductImageDataUrl('');
        hideMallCropper();
      });
    }

    const charityImgFile = document.getElementById('charityProjectImageFile');
    if (charityImgFile) {
      charityImgFile.addEventListener('change', async () => {
        const file = charityImgFile.files && charityImgFile.files[0] ? charityImgFile.files[0] : null;
        if (!file) return;
        try {
          const dataUrl = await fileToDataUrl(file);
          await openCharityCropper(dataUrl);
        } catch (err) {
          setCharityProjectModalErr(String(err?.message || err));
        }
      });
    }

    const btnCharityImgClear = document.getElementById('btnCharityProjectImageClear');
    if (btnCharityImgClear) {
      btnCharityImgClear.addEventListener('click', () => {
        if (charityImgFile) charityImgFile.value = '';
        setCharityProjectImageDataUrl('');
        hideCharityCropper();
      });
    }

    const pasteBox = document.getElementById('mallProductImagePaste');
    if (pasteBox) {
      pasteBox.addEventListener('paste', async (ev) => {
        const items = ev?.clipboardData?.items;
        if (!items || items.length === 0) return;
        for (const it of items) {
          if (!it || !it.type || !String(it.type).startsWith('image/')) continue;
          const file = it.getAsFile ? it.getAsFile() : null;
          if (!file) continue;
          ev.preventDefault();
          try {
            const dataUrl = await fileToDataUrl(file);
            await openMallCropper(dataUrl);
            pasteBox.value = '';
          } catch (err) {
            setMallProductModalErr(String(err?.message || err));
          }
          break;
        }
      });
      pasteBox.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        const drop = pasteBox.closest('.upload-drop');
        if (drop) drop.classList.add('dragover');
      });
      pasteBox.addEventListener('dragleave', () => {
        const drop = pasteBox.closest('.upload-drop');
        if (drop) drop.classList.remove('dragover');
      });
      pasteBox.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        const drop = pasteBox.closest('.upload-drop');
        if (drop) drop.classList.remove('dragover');
        const file = ev?.dataTransfer?.files && ev.dataTransfer.files[0] ? ev.dataTransfer.files[0] : null;
        if (!file || !String(file.type || '').startsWith('image/')) return;
        try {
          const dataUrl = await fileToDataUrl(file);
          await openMallCropper(dataUrl);
          pasteBox.value = '';
        } catch (err) {
          setMallProductModalErr(String(err?.message || err));
        }
      });
    }

    const charityPasteBox = document.getElementById('charityProjectImagePaste');
    if (charityPasteBox) {
      charityPasteBox.addEventListener('paste', async (ev) => {
        const items = ev?.clipboardData?.items;
        if (!items || items.length === 0) return;
        for (const it of items) {
          if (!it || !it.type || !String(it.type).startsWith('image/')) continue;
          const file = it.getAsFile ? it.getAsFile() : null;
          if (!file) continue;
          ev.preventDefault();
          try {
            const dataUrl = await fileToDataUrl(file);
            await openCharityCropper(dataUrl);
            charityPasteBox.value = '';
          } catch (err) {
            setCharityProjectModalErr(String(err?.message || err));
          }
          break;
        }
      });
      charityPasteBox.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        const drop = charityPasteBox.closest('.upload-drop');
        if (drop) drop.classList.add('dragover');
      });
      charityPasteBox.addEventListener('dragleave', () => {
        const drop = charityPasteBox.closest('.upload-drop');
        if (drop) drop.classList.remove('dragover');
      });
      charityPasteBox.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        const drop = charityPasteBox.closest('.upload-drop');
        if (drop) drop.classList.remove('dragover');
        const file = ev?.dataTransfer?.files && ev.dataTransfer.files[0] ? ev.dataTransfer.files[0] : null;
        if (!file || !String(file.type || '').startsWith('image/')) return;
        try {
          const dataUrl = await fileToDataUrl(file);
          await openCharityCropper(dataUrl);
          charityPasteBox.value = '';
        } catch (err) {
          setCharityProjectModalErr(String(err?.message || err));
        }
      });
    }

    const cropZoom = document.getElementById('mallCropZoom');
    if (cropZoom) cropZoom.addEventListener('input', updateMallCropPreview);
    const cropX = document.getElementById('mallCropX');
    if (cropX) cropX.addEventListener('input', updateMallCropPreview);
    const cropY = document.getElementById('mallCropY');
    if (cropY) cropY.addEventListener('input', updateMallCropPreview);
    const btnCropCancel = document.getElementById('btnMallCropCancel');
    if (btnCropCancel) btnCropCancel.addEventListener('click', hideMallCropper);
    const btnCropApply = document.getElementById('btnMallCropApply');
    if (btnCropApply) btnCropApply.addEventListener('click', applyMallCrop);

    const charityCropZoom = document.getElementById('charityCropZoom');
    if (charityCropZoom) charityCropZoom.addEventListener('input', updateCharityCropPreview);
    const charityCropX = document.getElementById('charityCropX');
    if (charityCropX) charityCropX.addEventListener('input', updateCharityCropPreview);
    const charityCropY = document.getElementById('charityCropY');
    if (charityCropY) charityCropY.addEventListener('input', updateCharityCropPreview);
    const btnCharityCropCancel = document.getElementById('btnCharityCropCancel');
    if (btnCharityCropCancel) btnCharityCropCancel.addEventListener('click', hideCharityCropper);
    const btnCharityCropApply = document.getElementById('btnCharityCropApply');
    if (btnCharityCropApply) btnCharityCropApply.addEventListener('click', applyCharityCrop);
  }

  const userState = {
    keyword: '',
    page: 1,
    pageSize: 30,
    total: 0,
    selected: null,
    selectMode: false,
    picked: new Set(),
    notifyTargets: [],
    nameCache: new Map(),
  };

  function switchTab(name) {
    const usersBtn = document.getElementById('tabUsers');
    const redeemBtn = document.getElementById('tabRedeem');
    const mallBtn = document.getElementById('tabMall');
    const redPacketBtn = document.getElementById('tabRedPacket');
    const messagesBtn = document.getElementById('tabMessages');
    const settingsBtn = document.getElementById('tabSettings');
    const usersPanel = document.getElementById('panelUsers');
    const redeemPanel = document.getElementById('panelRedeem');
    const mallPanel = document.getElementById('panelMall');
    const redPacketPanel = document.getElementById('panelRedPacket');
    const messagesPanel = document.getElementById('panelMessages');
    const settingsPanel = document.getElementById('panelSettings');

    if (name === 'redeem') {
      stopAuditLogAutoRefresh();
      usersBtn.classList.remove('active');
      redeemBtn.classList.add('active');
      mallBtn.classList.remove('active');
      if (redPacketBtn) redPacketBtn.classList.remove('active');
      if (messagesBtn) messagesBtn.classList.remove('active');
      settingsBtn.classList.remove('active');
      usersPanel.classList.add('hidden');
      redeemPanel.classList.remove('hidden');
      mallPanel.classList.add('hidden');
      if (redPacketPanel) redPacketPanel.classList.add('hidden');
      if (messagesPanel) messagesPanel.classList.add('hidden');
      settingsPanel.classList.add('hidden');
      return;
    }

    if (name === 'mall') {
      stopAuditLogAutoRefresh();
      stopCamera();
      usersBtn.classList.remove('active');
      redeemBtn.classList.remove('active');
      mallBtn.classList.add('active');
      if (redPacketBtn) redPacketBtn.classList.remove('active');
      if (messagesBtn) messagesBtn.classList.remove('active');
      settingsBtn.classList.remove('active');
      usersPanel.classList.add('hidden');
      redeemPanel.classList.add('hidden');
      mallPanel.classList.remove('hidden');
      if (redPacketPanel) redPacketPanel.classList.add('hidden');
      if (messagesPanel) messagesPanel.classList.add('hidden');
      settingsPanel.classList.add('hidden');
      setMallToast('', false);
      setMallMode('self');
      loadMallProducts();
      loadMallOpening();
      return;
    }

    if (name === 'redPacket') {
      stopAuditLogAutoRefresh();
      stopCamera();
      usersBtn.classList.remove('active');
      redeemBtn.classList.remove('active');
      mallBtn.classList.remove('active');
      if (redPacketBtn) redPacketBtn.classList.add('active');
      if (messagesBtn) messagesBtn.classList.remove('active');
      settingsBtn.classList.remove('active');
      usersPanel.classList.add('hidden');
      redeemPanel.classList.add('hidden');
      mallPanel.classList.add('hidden');
      if (redPacketPanel) redPacketPanel.classList.remove('hidden');
      if (messagesPanel) messagesPanel.classList.add('hidden');
      settingsPanel.classList.add('hidden');
      loadRedPacketStatus();
      return;
    }

    if (name === 'messages') {
      stopCamera();
      usersBtn.classList.remove('active');
      redeemBtn.classList.remove('active');
      mallBtn.classList.remove('active');
      if (redPacketBtn) redPacketBtn.classList.remove('active');
      if (messagesBtn) messagesBtn.classList.add('active');
      settingsBtn.classList.remove('active');
      usersPanel.classList.add('hidden');
      redeemPanel.classList.add('hidden');
      mallPanel.classList.add('hidden');
      if (redPacketPanel) redPacketPanel.classList.add('hidden');
      if (messagesPanel) messagesPanel.classList.remove('hidden');
      settingsPanel.classList.add('hidden');
      return;
    }

    if (name === 'settings') {
      stopCamera();
      usersBtn.classList.remove('active');
      redeemBtn.classList.remove('active');
      mallBtn.classList.remove('active');
      if (redPacketBtn) redPacketBtn.classList.remove('active');
      if (messagesBtn) messagesBtn.classList.remove('active');
      settingsBtn.classList.add('active');
      usersPanel.classList.add('hidden');
      redeemPanel.classList.add('hidden');
      mallPanel.classList.add('hidden');
      if (redPacketPanel) redPacketPanel.classList.add('hidden');
      if (messagesPanel) messagesPanel.classList.add('hidden');
      settingsPanel.classList.remove('hidden');
      loadCdkProducts();
      loadCdkList();
      refreshTokenList();
      loadAuditLogs();
      loadFaqList();
      loadAnnouncementList();
      loadFeedbackList();
      loadVersionList();
      startAuditLogAutoRefresh();
      return;
    }

    stopAuditLogAutoRefresh();
    stopCamera();

    redeemBtn.classList.remove('active');
    mallBtn.classList.remove('active');
    if (redPacketBtn) redPacketBtn.classList.remove('active');
    if (messagesBtn) messagesBtn.classList.remove('active');
    settingsBtn.classList.remove('active');
    usersBtn.classList.add('active');
    redeemPanel.classList.add('hidden');
    mallPanel.classList.add('hidden');
    if (redPacketPanel) redPacketPanel.classList.add('hidden');
    if (messagesPanel) messagesPanel.classList.add('hidden');
    settingsPanel.classList.add('hidden');
    usersPanel.classList.remove('hidden');
  }

  async function syncUsers() {
    document.getElementById('userToast').textContent = '正在同步通讯录…';
    const r = await fetchJson('/admin/users/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (r?.data?.ok) {
      document.getElementById('userToast').textContent = `同步完成：upserted=${r.data.upserted || 0}`;
    } else {
      document.getElementById('userToast').textContent = `同步失败：${r.data?.error || 'error'}`;
    }
    await loadUsers();
  }

  function toggleSelectMode() {
    userState.selectMode = !userState.selectMode;
    if (!userState.selectMode) {
      userState.picked = new Set();
      hideSelectMenu();
    }
    updatePickUi();
    renderUserTable(userState.lastRows);
  }

  function hideSelectMenu() {
    const menu = document.getElementById('selectMenu');
    if (menu) menu.classList.add('hidden');
  }

  function toggleSelectMenu() {
    if (!userState.selectMode) {
      userState.selectMode = true;
      updatePickUi();
      renderUserTable(userState.lastRows);
    }
    const menu = document.getElementById('selectMenu');
    if (!menu) return;
    menu.classList.toggle('hidden');
  }

  function updatePickUi() {
    const th = document.getElementById('thPick');
    const btn = document.getElementById('btnToggleSelect');
    const btnMenu = document.getElementById('btnSelectMenu');
    if (userState.selectMode) {
      th.classList.remove('hidden');
      btn.textContent = '完成';
      if (btnMenu) btnMenu.classList.remove('hidden');
    } else {
      th.classList.add('hidden');
      btn.textContent = '选择';
      if (btnMenu) btnMenu.classList.add('hidden');
    }
    updateSelectedLabel();
  }

  function updateSelectedLabel() {}

  function selectCurrentPage() {
    if (!userState.selectMode) return;
    const rows = Array.isArray(userState.lastRows) ? userState.lastRows : [];
    for (const r of rows) {
      const userid = r?.userid ? String(r.userid) : '';
      if (userid) userState.picked.add(userid);
    }
    hideSelectMenu();
    updateSelectedLabel();
    renderUserTable(userState.lastRows);
  }

  function clearPicked() {
    if (!userState.selectMode) return;
    userState.picked = new Set();
    hideSelectMenu();
    updateSelectedLabel();
    renderUserTable(userState.lastRows);
  }

  async function selectAllUsers() {
    if (!userState.selectMode) return;
    const ok = window.confirm('确定全选全部？\n\n说明：会按当前搜索条件，把所有用户都加入选择列表。');
    if (!ok) return;

    const btn = document.getElementById('btnSelectAll');
    const toast = document.getElementById('userToast');
    const prevDisabled = btn ? btn.disabled : false;
    if (btn) btn.disabled = true;

    try {
      const keyword = String(userState.keyword || '').trim();
      const pageSize = Math.min(100, Math.max(1, Number(userState.pageSize) || 30));
      let page = 1;
      let total = 0;
      let fetched = 0;

      while (true) {
        const qs = new URLSearchParams();
        qs.set('page', String(page));
        qs.set('pageSize', String(pageSize));
        if (keyword) qs.set('keyword', keyword);

        const r = await fetchJson(`/admin/users?${qs.toString()}`);
        if (!r?.data?.ok) {
          toast.textContent = `全选失败：${r?.data?.error || r?.status || 'error'}`;
          return;
        }

        total = Number(r.data.total) || 0;
        const rows = Array.isArray(r.data.data) ? r.data.data : [];
        for (const u of rows) {
          const userid = u?.userid ? String(u.userid) : '';
          if (!userid) continue;
          userState.picked.add(userid);
          const name = u?.name ? String(u.name) : '';
          if (name) userState.nameCache.set(userid, name);
        }

        fetched += rows.length;
        toast.textContent = `全选中… ${Math.min(fetched, total)}/${total}`;

        const maxPage = Math.max(1, Math.ceil(total / pageSize));
        if (page >= maxPage) break;
        page += 1;
      }

      toast.textContent = `已全选：${userState.picked.size} 人`;
      hideSelectMenu();
      updateSelectedLabel();
      loadUsers();
    } finally {
      if (btn) btn.disabled = prevDisabled;
    }
  }

  function getGrantTargetsWithNames() {
    const userids = userState.selectMode ? Array.from(userState.picked.values()) : (userState.selected?.userid ? [userState.selected.userid] : []);
    return userids
      .map((uid) => {
        const userid = String(uid || '');
        return { userid, name: userState.nameCache.get(userid) || '' };
      })
      .filter((x) => x.userid);
  }

  function openGrantModal() {
    const targets = getGrantTargetsWithNames();
    if (targets.length === 0) {
      document.getElementById('userToast').textContent = '请先选择要发币的用户';
      return;
    }

    document.getElementById('grantModalErr').textContent = '';
    document.getElementById('grantModalHint').textContent = `将发币给 ${targets.length} 人`;
    document.getElementById('grantModalTargets').textContent = targets
      .map((t) => (t.name ? `${t.name}\n${t.userid}` : t.userid))
      .join('\n\n');

    document.getElementById('grantModal').classList.remove('hidden');
  }

  function closeGrantModal() {
    document.getElementById('grantModal').classList.add('hidden');
  }

  function openDeductModal() {
    const targets = getGrantTargetsWithNames();
    if (targets.length === 0) {
      document.getElementById('userToast').textContent = '请先选择要减币的用户';
      return;
    }

    document.getElementById('deductModalErr').textContent = '';
    document.getElementById('deductModalHint').textContent = `将减币给 ${targets.length} 人`;
    document.getElementById('deductModalTargets').textContent = targets
      .map((t) => (t.name ? `${t.name}\n${t.userid}` : t.userid))
      .join('\n\n');

    document.getElementById('deductNote').value = '';
    document.getElementById('deductModal').classList.remove('hidden');
  }

  function closeDeductModal() {
    document.getElementById('deductModal').classList.add('hidden');
  }

  function openNotifyModal(targetsInput) {
    const targets = Array.isArray(targetsInput) ? targetsInput : getGrantTargetsWithNames();
    if (targets.length === 0) {
      document.getElementById('userToast').textContent = '请先选择要发送消息的用户';
      return;
    }

    const err = document.getElementById('notifyModalErr');
    if (err) err.textContent = '';
    const hint = document.getElementById('notifyModalHint');
    if (hint) hint.textContent = `将发送消息给 ${targets.length} 人`;
    const out = document.getElementById('notifyModalTargets');
    if (out) {
      out.textContent = targets
        .map((t) => (t.name ? `${t.name}\n${t.userid}` : t.userid))
        .join('\n\n');
    }
    const title = document.getElementById('notifyTitle');
    if (title) title.value = '';
    const content = document.getElementById('notifyContent');
    if (content) content.value = '';

    userState.notifyTargets = targets.map((t) => ({ userid: String(t.userid || ''), name: String(t.name || '') })).filter((x) => x.userid);
    document.getElementById('notifyModal').classList.remove('hidden');
  }

  function closeNotifyModal() {
    const m = document.getElementById('notifyModal');
    if (m) m.classList.add('hidden');
  }

  async function submitNotifyModal() {
    const targets = Array.isArray(userState.notifyTargets) ? userState.notifyTargets : [];
    if (targets.length === 0) {
      document.getElementById('notifyModalErr').textContent = '未选择用户';
      return;
    }

    const title = document.getElementById('notifyTitle')?.value?.trim() || '';
    const content = document.getElementById('notifyContent')?.value?.trim() || '';
    if (!content) {
      document.getElementById('notifyModalErr').textContent = '内容不能为空';
      return;
    }

    const ok = window.confirm(`确定发送消息给 ${targets.length} 人？`);
    if (!ok) return;

    const btn = document.getElementById('btnNotifySubmit');
    if (btn) btn.disabled = true;
    document.getElementById('notifyModalErr').textContent = '';

    try {
      const body = {
        userids: targets.map((t) => t.userid),
        title,
        content,
      };
      const r = await fetchJson('/admin/users/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!r?.data) {
        document.getElementById('notifyModalErr').textContent = '发送失败';
        return;
      }

      if (r.data?.ok) {
        document.getElementById('userToast').textContent = `发送完成：${r.data.count || targets.length} 人`;
        closeNotifyModal();
        return;
      }

      const results = Array.isArray(r.data?.results) ? r.data.results : [];
      const failed = results.filter((x) => !x?.ok);
      const failHint = failed.length ? `，失败 ${failed.length} 人` : '';
      document.getElementById('userToast').textContent = `发送完成：${results.length || targets.length} 人${failHint}`;
      if (failed.length) {
        document.getElementById('notifyModalErr').textContent = failed
          .slice(0, 8)
          .map((x) => `${x.userid || '-'}: ${x.error || 'error'}`)
          .join('\n');
      } else {
        closeNotifyModal();
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function submitDeductModal() {
    const targets = getGrantTargetsWithNames();
    if (targets.length === 0) {
      document.getElementById('deductModalErr').textContent = '未选择用户';
      return;
    }

    const amount = Number(document.getElementById('deductAmount').value);
    const productName = document.getElementById('deductNote').value.trim();

    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      document.getElementById('deductModalErr').textContent = '减币数量必须是正整数';
      return;
    }
    if (!productName) {
      document.getElementById('deductModalErr').textContent = '原因不能为空';
      return;
    }

    const ok = window.confirm(`确定减币 ${targets.length} 人，每人 ${amount}？`);
    if (!ok) return;

    document.getElementById('btnDeductSubmit').disabled = true;
    document.getElementById('deductModalErr').textContent = '';

    try {
      const body = {
        userids: targets.map((t) => t.userid),
        amount,
        product_name: productName,
      };

      const r = await fetchJson('/admin/redeem/deduct-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (r?.data?.ok) {
        document.getElementById('userToast').textContent = `减币完成：${r.data.count || 0} 人`;
        closeDeductModal();
        await loadUsers();
        return;
      }

      const msg = r?.data?.error || '减币失败';
      document.getElementById('deductModalErr').textContent = msg;
    } finally {
      document.getElementById('btnDeductSubmit').disabled = false;
    }
  }

  async function submitGrantModal() {
    const targets = getGrantTargetsWithNames();
    if (targets.length === 0) {
      document.getElementById('grantModalErr').textContent = '未选择用户';
      return;
    }

    const amount = Number(document.getElementById('modalAmount').value);
    const reason = document.getElementById('modalReason').value.trim();
    const refId = document.getElementById('modalRefId').value.trim();

    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      document.getElementById('grantModalErr').textContent = '发币数量必须是正整数';
      return;
    }

    document.getElementById('btnModalSubmit').disabled = true;
    document.getElementById('grantModalErr').textContent = '';

    try {
      const body = {
        userids: targets.map((t) => t.userid),
        amount,
      };
      if (reason) body.reason = reason;
      if (refId) body.refId = refId;

      const r = await fetchJson('/admin/ledger/grant-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (r?.data?.ok) {
        document.getElementById('userToast').textContent = `发币完成：${r.data.count || 0} 人`;
        closeGrantModal();
        await loadUsers();
        return;
      }
      document.getElementById('grantModalErr').textContent = r.data?.error || '发币失败';
    } finally {
      document.getElementById('btnModalSubmit').disabled = false;
    }
  }

  async function bulkDelete() {
    if (!userState.selectMode || userState.picked.size === 0) {
      document.getElementById('userToast').textContent = '请先选择要删除的用户';
      return;
    }
    const count = userState.picked.size;
    const ok = window.confirm(`确定删除本地用户 ${count} 个？\n\n注意：会级联删除账户/流水/核销记录，无法恢复。`);
    if (!ok) return;
    const userids = Array.from(userState.picked.values());
    const r = await fetchJson('/admin/users/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userids }),
    });
    if (r?.data?.ok) {
      document.getElementById('userToast').textContent = `已删除 ${r.data.deleted || 0} 个用户`;
      userState.picked = new Set();
      updateSelectedLabel();
      await loadUsers();
      return;
    }
    document.getElementById('userToast').textContent = `删除失败：${r.data?.error || 'error'}`;
  }

  function renderUserTable(rowsInput) {
    const rows = Array.isArray(rowsInput) ? rowsInput : [];
    userState.lastRows = rows;
    for (const u of rows) {
      const userid = u?.userid ? String(u.userid) : '';
      if (!userid) continue;
      const name = u?.name ? String(u.name) : '';
      if (name) userState.nameCache.set(userid, name);
    }

    const tbody = document.getElementById('userTable');
    tbody.innerHTML = rows
      .map((u) => {
        const userid = u?.userid ? String(u.userid) : '';
        const name = u?.name ? String(u.name) : '';
        const isAdmin = Number(u?.is_admin) === 1;
        const isFixedAdmin = Number(u?.is_fixed_admin) === 1;
        const balance = Number(u?.balance) || 0;
        const updatedAt = u?.updated_at ? formatTs(u.updated_at) : '-';
        const selected = userState.selected?.userid === userid ? 'selected' : '';
        const picked = userState.picked.has(userid);
        const safeName = name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        const safeUser = userid.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        const pickCell = userState.selectMode ? `<td><input type="checkbox" ${picked ? 'checked' : ''} data-pick="1" /></td>` : '';
        const pickClass = userState.selectMode && picked ? 'selected' : selected;
        const adminCell = isAdmin ? '<span class="pill">管理员</span>' : '<span class="muted">-</span>';
        const btnText = isAdmin ? '取消管理员' : '设为管理员';
        const btnDisabled = isFixedAdmin ? 'disabled' : '';
        const btnTitle = isFixedAdmin ? 'title="固定管理员不可修改"' : '';
        return `<tr class="${pickClass}" data-userid="${safeUser}" data-name="${safeName}" data-is-admin="${isAdmin ? '1' : '0'}" data-fixed-admin="${isFixedAdmin ? '1' : '0'}">${pickCell}<td>${safeName || '-'}</td><td class="muted">${safeUser}</td><td>${adminCell}</td><td>${balance}</td><td class="muted">${updatedAt}</td><td><div class="row tableActions" style="justify-content:flex-end;"><button class="secondary" data-act="notify">发消息</button><button class="secondary" data-act="toggle-admin" ${btnDisabled} ${btnTitle}>${btnText}</button></div></td></tr>`;
      })
      .join('');

    tbody.querySelectorAll('button[data-act="toggle-admin"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const tr = btn.closest('tr');
        const userid = tr?.getAttribute('data-userid') || '';
        const isAdmin = tr?.getAttribute('data-is-admin') === '1';
        const isFixedAdmin = tr?.getAttribute('data-fixed-admin') === '1';
        if (!userid) return;
        if (isFixedAdmin) {
          document.getElementById('userToast').textContent = '固定管理员不可修改';
          return;
        }
        const ok = window.confirm(isAdmin ? `确定取消管理员：${userid}？` : `确定设为管理员：${userid}？`);
        if (!ok) return;
        const r2 = await fetchJson('/admin/users/set-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userid, isAdmin: !isAdmin }),
        });
        if (!r2?.data?.ok) {
          document.getElementById('userToast').textContent = `设置失败：${r2?.data?.error || 'error'}`;
          return;
        }
        document.getElementById('userToast').textContent = '已更新管理员权限';
        await loadUsers();
      });
    });

    tbody.querySelectorAll('button[data-act="notify"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const tr = btn.closest('tr');
        const userid = tr?.getAttribute('data-userid') || '';
        const name = tr?.getAttribute('data-name') || '';
        if (!userid) return;
        openNotifyModal([{ userid, name }]);
      });
    });

    tbody.querySelectorAll('tr').forEach((tr) => {
      tr.addEventListener('click', (ev) => {
        const act = ev?.target && ev.target.getAttribute ? ev.target.getAttribute('data-act') : '';
        if (act) return;
        const userid = tr.getAttribute('data-userid') || '';
        const name = tr.getAttribute('data-name') || '';
        if (userState.selectMode) {
          const isPick = ev?.target && ev.target.getAttribute && ev.target.getAttribute('data-pick') === '1';
          if (!isPick) {
            const cb = tr.querySelector('input[type="checkbox"]');
            if (cb) cb.checked = !cb.checked;
          }
          const checked = Boolean(tr.querySelector('input[type="checkbox"]')?.checked);
          if (checked) userState.picked.add(userid);
          else userState.picked.delete(userid);
          updateSelectedLabel();
          renderUserTable(userState.lastRows);
          return;
        }

        selectUser({ userid, name });
        tbody.querySelectorAll('tr').forEach((x) => x.classList.remove('selected'));
        tr.classList.add('selected');
      });
    });

    const maxPage = Math.max(1, Math.ceil((userState.total || 0) / userState.pageSize));
    const pickedHint = userState.selectMode ? `，已选 ${userState.picked.size} 人` : '';
    document.getElementById('userStat').textContent = `共 ${userState.total} 人，第 ${userState.page}/${maxPage} 页${pickedHint}`;
    document.getElementById('btnUserPrev').disabled = userState.page <= 1;
    document.getElementById('btnUserNext').disabled = userState.page >= maxPage;
  }

  async function loadUsers() {
    const keyword = document.getElementById('userKeyword').value.trim();
    userState.keyword = keyword;

    const qs = new URLSearchParams();
    qs.set('page', String(userState.page));
    qs.set('pageSize', String(userState.pageSize));
    if (keyword) qs.set('keyword', keyword);

    const r = await fetchJson(`/admin/users?${qs.toString()}`);
    if (!r?.data?.ok) {
      document.getElementById('userToast').textContent = `加载用户失败：${r?.data?.error || r?.status || 'error'}`;
      return;
    }

    userState.total = Number(r.data.total) || 0;
    const rows = Array.isArray(r.data.data) ? r.data.data : [];
    renderUserTable(rows);
  }

  function selectUser(u) {
    userState.selected = u;
  }

  async function resetSelectedUserData() {
    const u = userState.selected;
    const userid = u?.userid ? String(u.userid) : '';
    if (!userid) {
      document.getElementById('userToast').textContent = '请先点击选择一个用户';
      return;
    }
    const ok = window.confirm(`确定清空该用户所有数据？\n\n用户：${userid}\n\n将删除：积分流水(ledger) + 兑换订单(redeems)，并把余额重置为 0。\n此操作无法恢复。`);
    if (!ok) return;

    const r = await fetchJson('/admin/data/reset-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userid }),
    });
    if (r?.data?.ok) {
      document.getElementById('userToast').textContent = `已清空用户：${userid}`;
      await loadUsers();
      return;
    }
    document.getElementById('userToast').textContent = `清空失败：${r?.data?.error || r?.status || 'error'}`;
  }

  async function resetAllData() {
    const ok = window.confirm('确定清空全部数据？\n\n将删除：所有积分流水(ledger) + 所有兑换订单(redeems)，并把所有人的余额重置为 0。\n\n此操作无法恢复。\n\n下一步会要求你输入确认口令。');
    if (!ok) return;
    const confirmText = window.prompt('请输入确认口令：RESET_ALL');
    if (confirmText !== 'RESET_ALL') {
      document.getElementById('userToast').textContent = '已取消（确认口令不正确）';
      return;
    }
    const r = await fetchJson('/admin/data/reset-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'RESET_ALL' }),
    });
    if (r?.data?.ok) {
      document.getElementById('userToast').textContent = '已清空全部数据';
      userState.selected = null;
      userState.picked = new Set();
      await loadUsers();
      return;
    }
    document.getElementById('userToast').textContent = `清空失败：${r?.data?.error || r?.status || 'error'}`;
  }

  async function refreshTokenList() {
    const tbody = document.getElementById('tokenTable');
    if (!tbody) return;
    const r = await fetchJson('/bob-token/list?includeRevoked=true&limit=200');
    if (!r?.data?.ok) {
      document.getElementById('tokenErr').textContent = r.data?.error || '获取列表失败';
      return;
    }

    const rows = Array.isArray(r.data.data) ? r.data.data : [];
    tbody.innerHTML = rows
      .map((t) => {
        const id = Number(t?.id) || 0;
        const token = t?.token ? String(t.token) : '';
        const created = formatTs(t?.created_at);
        const revoked = t?.revoked_at ? formatTs(t.revoked_at) : '-';
        return `<tr data-tokenid="${id}">
          <td>${id}</td>
          <td class="mono">${token || '-'}</td>
          <td class="muted">${created}</td>
          <td class="muted">${revoked}</td>
          <td>
            <button class="secondary" data-act="copy" ${token ? '' : 'disabled'}>复制</button>
            <button class="secondary" data-act="revoke" ${t?.revoked_at ? 'disabled' : ''}>吊销</button>
            <button class="secondary" data-act="delete" ${t?.revoked_at ? '' : 'disabled'}>删除</button>
          </td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('button[data-act="copy"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const tr = btn.closest('tr');
        const tokenText = tr?.querySelector('td.mono')?.textContent || '';
        if (!tokenText || tokenText === '-') return;
        try {
          await navigator.clipboard.writeText(tokenText);
          document.getElementById('tokenErr').textContent = '';
        } catch (err) {
          document.getElementById('tokenErr').textContent = String(err?.message || err);
        }
      });
    });

    tbody.querySelectorAll('button[data-act="revoke"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const tr = btn.closest('tr');
        const tokenId = tr?.getAttribute('data-tokenid');
        const ok = window.confirm(`确定吊销 tokenId=${tokenId}？`);
        if (!ok) return;
        const resp = await fetchJson('/bob-token/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId }),
        });
        if (!resp?.data?.ok) {
          document.getElementById('tokenErr').textContent = resp.data?.error || '吊销失败';
          return;
        }
        await refreshTokenList();
      });
    });

    tbody.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const tr = btn.closest('tr');
        const tokenId = tr?.getAttribute('data-tokenid');
        const ok = window.confirm(`确定删除 tokenId=${tokenId}？\n\n提示：只能删除已吊销的 token。`);
        if (!ok) return;
        const resp = await fetchJson('/bob-token/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId }),
        });
        if (!resp?.data?.ok) {
          document.getElementById('tokenErr').textContent = resp.data?.error || '删除失败';
          return;
        }
        await refreshTokenList();
      });
    });

    document.getElementById('tokenErr').textContent = '';
  }

  let cameraStream = null;
  let cameraTimer = null;

  let ddScanReadyPromise = null;

  async function ensureDdScanReady() {
    if (typeof dd === 'undefined') {
      return false;
    }
    if (ddScanReadyPromise) {
      return ddScanReadyPromise;
    }

    ddScanReadyPromise = (async () => {
      const cfgResp = await fetchJson(`/admin/config?url=${encodeURIComponent(currentUrl)}`);
      if (cfgResp.data?.error) {
        return false;
      }

      const cfg = cfgResp.data;
      return new Promise((resolve) => {
        try {
          dd.config({
            agentId: cfg.agentId,
            corpId: cfg.corpId,
            timeStamp: cfg.timeStamp,
            nonceStr: cfg.nonceStr,
            signature: cfg.signature,
            jsApiList: ['biz.util.scan'],
          });

          dd.ready(() => resolve(true));
          dd.error(() => resolve(false));
        } catch (_) {
          resolve(false);
        }
      });
    })();

    return ddScanReadyPromise;
  }

  async function scanQr() {
    document.getElementById('btnStopScan').disabled = true;

    const ddOk = await ensureDdScanReady();
    if (ddOk && dd?.biz?.util?.scan) {
      dd.biz.util.scan({
        type: 'qrCode',
        onSuccess: (data) => {
          const v = data?.text || data?.resultStr || '';
          if (v) {
            document.getElementById('confirmEncoded').value = v;
            openRedeemModalFromEncoded(v);
          }
        },
        onFail: () => {
          setConfirmText('扫码失败，请重试', true);
        },
      });
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setConfirmText('当前浏览器不支持摄像头', true);
      return;
    }

    if (typeof BarcodeDetector !== 'function') {
      setConfirmText('当前浏览器不支持二维码识别', true);
      return;
    }

    stopCamera();

    const video = document.getElementById('video');
    video.classList.remove('hidden');
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = cameraStream;
    await video.play();

    document.getElementById('btnStopScan').disabled = false;

    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    cameraTimer = setInterval(async () => {
      if (!video.videoWidth || !video.videoHeight) return;
      try {
        const codes = await detector.detect(video);
        if (!codes || codes.length === 0) return;
        const raw = codes[0]?.rawValue || '';
        if (!raw) return;
        document.getElementById('confirmEncoded').value = raw;
        openRedeemModalFromEncoded(raw);
        stopCamera();
      } catch (err) {
        setConfirmText(String(err?.message || err), true);
        stopCamera();
      }
    }, 400);
  }

  function stopCamera() {
    if (cameraTimer) {
      clearInterval(cameraTimer);
      cameraTimer = null;
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    const video = document.getElementById('video');
    video.pause();
    video.srcObject = null;
    video.classList.add('hidden');
    document.getElementById('btnStopScan').disabled = true;
  }

  // ─── 打卡奖励设置 ─────────────────────────────────────────────────────────

  function setAttendanceRewardToast(text, isError) {
    const el = document.getElementById('attendanceRewardToast');
    if (el) {
      el.textContent = String(text || '');
      el.style.color = isError ? '#b00020' : 'inherit';
    }
    if (text) showGlobalToast(String(text), isError ? 'error' : 'success');
  }

  function setAttendanceRewardErr(text) {
    const el = document.getElementById('attendanceRewardErr');
    if (el) el.textContent = String(text || '');
    if (text) showGlobalToast(String(text), 'error');
  }

  function fillAttendanceRewardSettings(data) {
    const d = data && typeof data === 'object' ? data : {};
    const enabledEl = document.getElementById('attendanceRewardEnabled');
    if (enabledEl) enabledEl.checked = d.enabled === true;
    const testModeEl = document.getElementById('attendanceTestMode');
    if (testModeEl) testModeEl.checked = d.testMode === true;
    const workStartEl = document.getElementById('attendanceWorkStartTime');
    if (workStartEl) workStartEl.value = d.workStartTime || '09:00';
    const graceEl = document.getElementById('attendanceLateGraceMinutes');
    if (graceEl) graceEl.value = d.lateGraceMinutes ?? 0;
    const minEl = document.getElementById('attendanceRewardMin');
    if (minEl) minEl.value = d.rewardMin ?? 1;
    const maxEl = document.getElementById('attendanceRewardMax');
    if (maxEl) maxEl.value = d.rewardMax ?? 5;
    const perDayEl = document.getElementById('attendanceMaxPerDay');
    if (perDayEl) perDayEl.value = d.maxPerDay ?? 1;
    const onlyEl = document.getElementById('attendanceOnlyCheckin');
    if (onlyEl) onlyEl.checked = d.onlyCheckin !== false;
    const reasonEl = document.getElementById('attendanceReason');
    if (reasonEl) reasonEl.value = d.reason || '打卡奖励';
  }

  async function loadAttendanceRewardSettings() {
    setAttendanceRewardErr('');
    setAttendanceRewardToast('', false);
    const r = await fetchJson('/admin/settings/attendance-reward');
    if (!r?.data?.ok) {
      setAttendanceRewardErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '加载失败'));
      return;
    }
    fillAttendanceRewardSettings(r.data?.data || {});
  }

  async function saveAttendanceRewardSettings({ reset = false } = {}) {
    setAttendanceRewardErr('');
    setAttendanceRewardToast('', false);
    const btnSave = document.getElementById('btnAttendanceRewardSave');
    const btnReset = document.getElementById('btnAttendanceRewardReset');
    const prevSave = btnSave ? btnSave.disabled : false;
    const prevReset = btnReset ? btnReset.disabled : false;
    if (btnSave) btnSave.disabled = true;
    if (btnReset) btnReset.disabled = true;
    try {
      const payload = reset
        ? { reset: true }
        : {
            enabled: document.getElementById('attendanceRewardEnabled')?.checked === true,
            testMode: document.getElementById('attendanceTestMode')?.checked === true,
            workStartTime: document.getElementById('attendanceWorkStartTime')?.value?.trim() || '09:00',
            lateGraceMinutes: Number(document.getElementById('attendanceLateGraceMinutes')?.value) || 0,
            rewardMin: Number(document.getElementById('attendanceRewardMin')?.value) || 1,
            rewardMax: Number(document.getElementById('attendanceRewardMax')?.value) || 5,
            maxPerDay: Number(document.getElementById('attendanceMaxPerDay')?.value) || 1,
            onlyCheckin: document.getElementById('attendanceOnlyCheckin')?.checked !== false,
            reason: document.getElementById('attendanceReason')?.value?.trim() || '打卡奖励',
          };
      const r = await fetchJson('/admin/settings/attendance-reward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r?.data?.ok) {
        setAttendanceRewardErr(r?.data?.error || (r?.status ? `HTTP ${r.status}` : '保存失败'));
        return;
      }
      fillAttendanceRewardSettings(r.data?.data || {});
      setAttendanceRewardToast(reset ? '已恢复默认' : '已保存', false);
    } finally {
      if (btnSave) btnSave.disabled = prevSave;
      if (btnReset) btnReset.disabled = prevReset;
    }
  }

  async function bootstrap() {
    bindButtons();
    mountMessagePanels();
    const me = await fetchJson('/admin/me');
    if (!me.data?.ok) {
      window.location.replace('/admin/login');
      return;
    }

    document.getElementById('userHint').textContent = me.data?.name ? `你好，${me.data.name}` : '你好';
    setMallMode(mallState.mode);
    setMallOpeningAdvancedVisible(false);
    enableActions();
    updatePickUi();
    await loadUsers();
    await refreshTokenList();
    await loadNotifySettings();
    await loadGroupCardSettings();
    await loadAttendanceRewardSettings();
    await loadAttendanceStatusList();
    updateCdkBatchOutput([], '');
    await loadCharityProjectsAdmin();
    await loadCharityContributionsAdmin();
    bindNotifyVarChips();
    setNotifyTestTarget(null);
  }

  bootstrap();
})();
