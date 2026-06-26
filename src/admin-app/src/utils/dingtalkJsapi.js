import { api } from '../api.js';

const DINGTALK_JSAPI_SRC = 'https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.27/dingtalk.open.js';

let dingtalkScriptPromise = null;

export function isDingtalkClient() {
  return /DingTalk/i.test(navigator.userAgent || '');
}

export function loadDingtalkJsapi() {
  if (window.dd) return Promise.resolve(true);
  if (dingtalkScriptPromise) return dingtalkScriptPromise;
  dingtalkScriptPromise = new Promise((resolve) => {
    const existing = document.querySelector(`script[src="${DINGTALK_JSAPI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(Boolean(window.dd)), { once: true });
      existing.addEventListener('error', () => resolve(false), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = DINGTALK_JSAPI_SRC;
    script.async = true;
    script.onload = () => resolve(Boolean(window.dd));
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return dingtalkScriptPromise;
}

export async function initDingtalkJsapi(jsApiList = []) {
  if (!isDingtalkClient()) throw new Error('请在钉钉客户端内打开后台');
  const loaded = await loadDingtalkJsapi();
  const dd = window.dd;
  if (!loaded || !dd) throw new Error('钉钉能力加载失败，请刷新后重试');

  const url = window.location.href.split('#')[0];
  const cfg = await api(`/admin/config?url=${encodeURIComponent(url)}`);
  if (cfg?.error) throw new Error(cfg.error);

  const ready = await new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(false), 4000);
    try {
      dd.config({
        agentId: cfg.agentId,
        corpId: cfg.corpId,
        timeStamp: cfg.timeStamp,
        nonceStr: cfg.nonceStr,
        signature: cfg.signature,
        jsApiList,
      });
      dd.ready(() => {
        window.clearTimeout(timer);
        resolve(true);
      });
      dd.error(() => {
        window.clearTimeout(timer);
        resolve(false);
      });
    } catch {
      window.clearTimeout(timer);
      resolve(false);
    }
  });

  if (!ready) throw new Error('钉钉鉴权失败，请检查应用可信域名和 JSAPI 权限');
  return { dd, cfg };
}
