(function () {
  function pretty(obj) {
    try {
      return JSON.stringify(obj, null, 2);
    } catch (_) {
      return String(obj);
    }
  }

  async function fetchJson(url, opts) {
    const source = opts || {};
    const timeoutMsRaw = source.timeoutMs;
    const timeoutMs = Number.isFinite(Number(timeoutMsRaw)) ? Number(timeoutMsRaw) : 8000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1000, timeoutMs));
    const init = { cache: 'no-store', ...source, signal: controller.signal };
    delete init.timeoutMs;
    let resp;
    try {
      resp = await fetch(url, init);
    } finally {
      clearTimeout(timeout);
    }
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
    return { status: resp.status, data };
  }

  async function postJson(url, body, opts) {
    return fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      ...(opts || {}),
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  window.BOB = {
    pretty,
    fetchJson,
    postJson,
    escapeHtml,
  };
})();
