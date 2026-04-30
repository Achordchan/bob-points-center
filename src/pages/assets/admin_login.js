(function () {
  const currentUrl = window.location.origin + window.location.pathname + window.location.search;

  const fetchJson = window.BOB.fetchJson;
  const postJson = window.BOB.postJson;

  function goHome() {
    window.location.replace('/admin/home');
  }

  function getFallbackLoginErrorText(error) {
    const code = error === null || error === undefined ? '' : String(error).trim();
    if (!code) return '登录失败，请稍后再试';
    if (code === 'missing username or password') return '请输入账号和密码';
    if (code === 'unauthorized') return '账号或密码错误，请重新输入';
    return code;
  }

  async function dingLogin() {
    document.getElementById('dingErr').textContent = '';

    const cfgResp = await fetchJson(`/admin/config?url=${encodeURIComponent(currentUrl)}`);
    if (cfgResp.data?.error) {
      document.getElementById('dingErr').textContent = '配置获取失败：' + cfgResp.data.error;
      return;
    }

    const cfg = cfgResp.data;
    if (typeof dd === 'undefined') {
      document.getElementById('dingErr').textContent = '当前环境不是钉钉';
      return;
    }

    dd.config({
      agentId: cfg.agentId,
      corpId: cfg.corpId,
      timeStamp: cfg.timeStamp,
      nonceStr: cfg.nonceStr,
      signature: cfg.signature,
      jsApiList: ['runtime.permission.requestAuthCode'],
    });

    dd.ready(() => {
      dd.runtime.permission.requestAuthCode({
        corpId: cfg.corpId,
        onSuccess: async (info) => {
          const auth = await fetchJson(`/admin/auth?code=${encodeURIComponent(info.code)}`);
          if (auth.status === 403) {
            const uid = auth.data?.userid || '';
            const nm = auth.data?.name || '';
            const hint = uid ? `无权限：你不是管理员。你的 userid 是：${uid}（把它加入 .env 的 ADMIN_USERIDS）` : '无权限：你不是管理员';
            document.getElementById('dingErr').textContent = hint;
            document.getElementById('hint').textContent = nm ? `你好，${nm}` : '未授权';
            return;
          }
          if (auth.data?.ok) {
            goHome();
            return;
          }
          document.getElementById('dingErr').textContent = auth.data?.error || '钉钉登录失败';
        },
        onFail: (err) => {
          document.getElementById('dingErr').textContent = JSON.stringify(err);
        },
      });
    });

    dd.error((err) => {
      const raw = JSON.stringify(err);
      if (raw === '{}' || raw === 'null' || raw === 'undefined') {
        const card = document.getElementById('cardDingtalk');
        if (card) card.classList.add('hidden');
        document.getElementById('hint').textContent = '当前不在钉钉，请使用账号密码登录';
        document.getElementById('dingErr').textContent = '';
        return;
      }
      document.getElementById('dingErr').textContent = 'dd.config 失败：' + raw;
    });
  }

  async function bootstrap() {
    document.getElementById('btnReload').addEventListener('click', () => window.location.reload());
    document.getElementById('btnDingLogin').addEventListener('click', dingLogin);

    document.getElementById('fbLogin').addEventListener('click', async () => {
      document.getElementById('fbErr').textContent = '';
      const username = document.getElementById('fbUser').value.trim();
      const password = document.getElementById('fbPass').value;
      const r = await postJson('/admin/login', { username, password });
      if (r.data?.ok) {
        goHome();
        return;
      }
      document.getElementById('fbErr').textContent = getFallbackLoginErrorText(r.data?.error);
    });

    const me = await fetchJson('/admin/me');
    if (me.data?.ok) {
      goHome();
      return;
    }

    document.getElementById('hint').textContent = '请登录后进入管理端';
    document.getElementById('btnDingLogin').disabled = false;

    if (typeof dd !== 'undefined') {
      dingLogin();
    }
  }

  bootstrap();
})();
