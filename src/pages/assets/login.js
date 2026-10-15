(function () {
  'use strict';

  var DEFAULT_REDIRECT = '/mall';

  var state = {
    redirect: DEFAULT_REDIRECT,
    registerEnabled: false,
    siteEnabled: true,
    submitting: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function normalizeRedirect(value) {
    var target = value ? String(value).trim() : '';
    if (!target || target.charAt(0) !== '/' || target.indexOf('//') === 0) return DEFAULT_REDIRECT;
    return target;
  }

  function readRedirect() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      return normalizeRedirect(params.get('redirect'));
    } catch (_) {
      return DEFAULT_REDIRECT;
    }
  }

  function dingtalkLoginUrl() {
    return '/web/oauth/start?redirect=' + encodeURIComponent(state.redirect);
  }

  function applyDingtalkLinks() {
    var url = dingtalkLoginUrl();
    var btn = $('btnDingtalk');
    var link = $('dingtalkLink');
    if (btn) btn.setAttribute('href', url);
    if (link) link.setAttribute('href', url);
  }

  function setAlert(message, kind) {
    var el = $('alert');
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = '';
      el.classList.remove('is-warn');
      return;
    }
    el.hidden = false;
    el.textContent = String(message);
    el.classList.toggle('is-warn', kind === 'warn');
    el.classList.remove('hidden');
  }

  function showDingtalkCard(show) {
    var card = $('dingtalkCard');
    if (!card) return;
    card.classList.toggle('hidden', !show);
  }

  function setTab(tab) {
    var isRegister = tab === 'register';
    var loginTab = $('tabLogin');
    var registerTab = $('tabRegister');
    var loginForm = $('formLogin');
    var registerForm = $('formRegister');
    if (loginTab) loginTab.classList.toggle('is-active', !isRegister);
    if (registerTab) registerTab.classList.toggle('is-active', isRegister);
    if (loginForm) loginForm.classList.toggle('hidden', isRegister);
    if (registerForm) registerForm.classList.toggle('hidden', !isRegister);
    setAlert('');
    showDingtalkCard(false);

    if (isRegister && !state.registerEnabled) {
      setAlert(state.registerMessage || '本次活动的自助注册未开放，请联系现场工作人员。', 'warn');
    }
  }

  function setSubmitting(busy) {
    state.submitting = busy;
    ['btnLogin', 'btnRegister'].forEach(function (id) {
      var btn = $(id);
      if (btn) btn.disabled = busy;
    });
  }

  function onlyDigits(el) {
    if (!el) return;
    el.addEventListener('input', function () {
      var cleaned = String(el.value || '').replace(/\D/g, '').slice(0, 11);
      if (cleaned !== el.value) el.value = cleaned;
    });
  }

  async function postJson(path, body) {
    var resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    var data = null;
    try {
      data = await resp.json();
    } catch (_) {
      data = null;
    }
    return { status: resp.status, data: data || {} };
  }

  function describeError(result) {
    var data = result && result.data ? result.data : {};
    var code = String(data.error || '');
    if (code === 'phone_is_dingtalk_user') return { message: '', dingtalk: true };
    if (code === 'phone_registered') return { message: '该手机号已注册，请切换到登录。', warn: true };
    if (code === 'account_locked') return { message: '密码错误次数过多，请 10 分钟后再试。', warn: true };
    if (code === 'register_disabled') return { message: String(data.message || '本次活动的自助注册未开放。'), warn: true };
    if (code === 'rate_limited') return { message: String(data.message || '操作过于频繁，请稍后再试。'), warn: true };
    if (code === 'site_disabled') return { message: '活动暂未开放，请稍后再试。', warn: true };
    if (data.message) return { message: String(data.message) };
    if (code === 'invalid_credentials') return { message: '手机号或密码错误。' };
    if (result && result.status >= 500) return { message: '服务异常，请稍后重试。' };
    return { message: '操作失败，请稍后重试。' };
  }

  function handleResult(result) {
    var info = describeError(result);
    if (info.dingtalk) {
      showDingtalkCard(true);
      setAlert('该手机号已绑定企业钉钉账号，请使用钉钉登录。', 'warn');
      return;
    }
    if (info.message) setAlert(info.message, info.warn ? 'warn' : 'error');
  }

  async function submitLogin(event) {
    event.preventDefault();
    if (state.submitting) return;
    setAlert('');
    showDingtalkCard(false);
    setSubmitting(true);
    try {
      var result = await postJson('/web/ext/login', {
        phone: String($('loginPhone').value || '').trim(),
        password: String($('loginPassword').value || ''),
      });
      if (result.status === 200 && result.data.ok) {
        window.location.replace(state.redirect);
        return;
      }
      handleResult(result);
    } catch (_) {
      setAlert('网络异常，请检查网络后重试。', 'warn');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitRegister(event) {
    event.preventDefault();
    if (state.submitting) return;
    setAlert('');
    showDingtalkCard(false);

    if (!state.registerEnabled) {
      setAlert(state.registerMessage || '本次活动的自助注册未开放，请联系现场工作人员。', 'warn');
      return;
    }
    if (!$('regConsent').checked) {
      setAlert('请先阅读并勾选同意个人信息收集告知。', 'warn');
      return;
    }

    setSubmitting(true);
    try {
      var result = await postJson('/web/ext/register', {
        name: String($('regName').value || '').trim(),
        phone: String($('regPhone').value || '').trim(),
        password: String($('regPassword').value || ''),
        consent: true,
      });
      if (result.status === 200 && result.data.ok) {
        window.location.replace(state.redirect);
        return;
      }
      handleResult(result);
      if (String(result.data?.error || '') === 'phone_registered') setTab('login');
    } catch (_) {
      setAlert('网络异常，请检查网络后重试。', 'warn');
    } finally {
      setSubmitting(false);
    }
  }

  function applyStatus(payload) {
    var data = payload && payload.data ? payload.data : {};
    state.registerEnabled = payload && payload.status === 200 && data.register_enabled === true;
    state.siteEnabled = data.site_enabled !== false;
    state.registerMessage = String(data.message || '');

    var notice = $('siteNotice');
    if (notice && !state.siteEnabled) {
      notice.textContent = String(data.site_message || '系统维护中，请稍后再试。');
      notice.classList.remove('hidden');
    }

    var tip = $('registerTip');
    if (tip) {
      tip.textContent = state.registerEnabled
        ? '手机号将作为登录账号，请牢记密码；密码可简单，但不要使用他人手机号注册。'
        : (state.registerMessage || '自助注册当前未开放，请在活动现场由工作人员指引。');
    }

    if (!state.registerEnabled) {
      var registerTab = $('tabRegister');
      if (registerTab) registerTab.classList.add('is-dim');
    }
  }

  async function checkExistingSession() {
    try {
      var resp = await fetch('/web/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (resp.status !== 200) return false;
      var data = await resp.json();
      if (data && data.userid) {
        window.location.replace(state.redirect);
        return true;
      }
    } catch (_) {
      // 忽略：未登录或网络异常都停留在登录页
    }
    return false;
  }

  async function bootstrap() {
    state.redirect = readRedirect();
    applyDingtalkLinks();
    onlyDigits($('loginPhone'));
    onlyDigits($('regPhone'));
    $('tabLogin').addEventListener('click', function () { setTab('login'); });
    $('tabRegister').addEventListener('click', function () { setTab('register'); });
    $('formLogin').addEventListener('submit', submitLogin);
    $('formRegister').addEventListener('submit', submitRegister);

    if (await checkExistingSession()) return;

    try {
      var resp = await fetch('/web/ext/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      var data = await resp.json().catch(function () { return null; });
      applyStatus({ status: resp.status, data: data });
    } catch (_) {
      // 状态未知时按未开放处理（fail-closed），登录仍可尝试。
      applyStatus({ status: 0, data: {} });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
