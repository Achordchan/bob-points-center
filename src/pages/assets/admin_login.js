(function () {
  const currentUrl = window.location.origin + window.location.pathname + window.location.search;
  const currentHostEl = document.getElementById('currentHost');
  if (currentHostEl) currentHostEl.textContent = window.location.host;
  const fetchJson = window.BOB.fetchJson;

  function getLoginRedirectTarget() {
    const fallback = '/admin/home';
    const target = new URLSearchParams(window.location.search).get('redirect') || '';
    if (!target.startsWith('/') || target.startsWith('//')) return fallback;
    if (target.startsWith('/admin/') || target === '/docs' || target.startsWith('/docs/')) return target;
    return fallback;
  }

  function goHome() {
    window.location.replace(getLoginRedirectTarget());
  }

  function showError(message) {
    document.getElementById('dingErr').textContent = message || '';
  }

  function getOAuthErrorText() {
    const code = new URLSearchParams(window.location.search).get('oauth_error') || '';
    if (code === 'forbidden') return '当前钉钉账号没有后台权限';
    if (code === 'expired') return '授权状态已失效，请重新登录';
    if (code === 'config') return '钉钉登录配置不完整，请联系系统管理员';
    if (code === 'failed') return '钉钉授权登录失败，请重试';
    return '';
  }

  function isInDingtalk() {
    return /DingTalk/i.test(window.navigator.userAgent || '')
      && typeof window.dd !== 'undefined'
      && Boolean(window.dd?.runtime?.permission?.requestAuthCode);
  }

  function startWebOAuth() {
    const params = new URLSearchParams({ redirect: getLoginRedirectTarget() });
    window.location.replace(`/admin/oauth/start?${params.toString()}`);
  }

  async function dingLogin() {
    showError('');
    const button = document.getElementById('btnDingLogin');
    button.disabled = true;
    button.textContent = '正在唤起钉钉授权…';

    const cfgResp = await fetchJson(`/admin/config?url=${encodeURIComponent(currentUrl)}`);
    if (cfgResp.data?.error) {
      showError('配置获取失败：' + cfgResp.data.error);
      button.disabled = false;
      button.textContent = '重新登录';
      return;
    }

    const cfg = cfgResp.data;
    window.dd.config({
      agentId: cfg.agentId,
      corpId: cfg.corpId,
      timeStamp: cfg.timeStamp,
      nonceStr: cfg.nonceStr,
      signature: cfg.signature,
      jsApiList: ['runtime.permission.requestAuthCode'],
    });

    window.dd.ready(() => {
      window.dd.runtime.permission.requestAuthCode({
        corpId: cfg.corpId,
        onSuccess: async (info) => {
          const auth = await fetchJson(`/admin/auth?code=${encodeURIComponent(info.code)}`);
          if (auth.status === 403) {
            showError('当前钉钉账号没有后台权限');
            button.disabled = false;
            button.textContent = '重新登录';
            return;
          }
          if (auth.data?.ok) {
            goHome();
            return;
          }
          showError(auth.data?.error || '钉钉登录失败');
          button.disabled = false;
          button.textContent = '重新登录';
        },
        onFail: () => {
          showError('未完成钉钉授权，请重试');
          button.disabled = false;
          button.textContent = '重新登录';
        },
      });
    });

    window.dd.error(() => {
      showError('钉钉免登初始化失败，请重试');
      button.disabled = false;
      button.textContent = '重新登录';
    });
  }

  async function bootstrap() {
    const button = document.getElementById('btnDingLogin');
    const oauthError = getOAuthErrorText();
    button.addEventListener('click', () => {
      if (isInDingtalk()) dingLogin();
      else startWebOAuth();
    });

    const me = await fetchJson('/admin/me');
    if (me.data?.ok) {
      goHome();
      return;
    }

    document.getElementById('hint').textContent = '使用企业钉钉账号完成身份验证';
    button.disabled = false;
    button.textContent = '使用钉钉登录';
    if (oauthError) {
      showError(oauthError);
      return;
    }

    if (isInDingtalk()) {
      dingLogin();
      return;
    }
    startWebOAuth();
  }

  bootstrap();
})();
