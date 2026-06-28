(function () {
  const state = {
    spec: null,
    endpoints: [],
    current: null,
    bodyMode: 'raw',
    collapsedTags: new Set(['管理端', 'Token']),
  };

  const escapeHtml = window.BOB.escapeHtml;
  const pretty = window.BOB.pretty;

  function getBaseUrl() {
    const v = document.getElementById('baseUrl').value.trim();
    return v || window.location.origin;
  }

  function buildUrl(path, queryValues) {
    const url = new URL(getBaseUrl() + path);
    for (const [k, v] of Object.entries(queryValues || {})) {
      if (v !== '' && v !== undefined && v !== null) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  function collectQueryValues(params) {
    const out = {};
    for (const p of params || []) {
      if (p.in !== 'query') continue;
      const el = document.getElementById(`q_${p.name}`);
      if (!el) continue;
      out[p.name] = el.value;
    }
    return out;
  }

  function makeCurl(ep) {
    const params = ep.parameters || [];
    const query = collectQueryValues(params);
    const url = buildUrl(ep.path, query);
    const method = ep.method.toUpperCase();

    const parts = [`curl -sS -X ${method} \"${url}\"`];
    parts.push(`  -H \"Content-Type: application/json\"`);

    if (method !== 'GET') {
      const raw = document.getElementById('tryBody').value || '';
      if (raw.trim()) {
        parts.push(`  -d '${raw.replaceAll("'", "'\\''")}'`);
      }
    }
    return parts.join(' \\\n');
  }

  function extractExample(ep) {
    const req = ep.requestBody?.content?.['application/json'];
    const examples = req?.examples;
    const example = examples ? Object.values(examples)[0] : null;
    if (example && example.value) {
      return example.value;
    }
    return null;
  }

  function derefSchema(schema) {
    if (!schema) return null;
    if (schema.$ref) {
      const ref = String(schema.$ref);
      const m = ref.match(/^#\/components\/schemas\/(.+)$/);
      if (m) {
        const key = m[1];
        return state.spec?.components?.schemas?.[key] || null;
      }
    }
    return schema;
  }

  function getJsonBodySchema(ep) {
    const req = ep.requestBody?.content?.['application/json'];
    if (!req) return null;
    const schema = req.schema;
    return derefSchema(schema);
  }

  function schemaFields(schema) {
    const s = derefSchema(schema);
    if (!s) return null;
    if (s.type !== 'object' || !s.properties) return null;
    const required = Array.isArray(s.required) ? new Set(s.required) : new Set();
    const fields = [];
    for (const [name, prop0] of Object.entries(s.properties)) {
      const prop = derefSchema(prop0) || prop0;
      fields.push({
        name,
        required: required.has(name),
        schema: prop,
        description: prop?.description || '',
        example: prop?.example,
        default: prop?.default,
      });
    }
    return fields;
  }

  function coerceValue(schema, raw) {
    const s = derefSchema(schema) || {};
    const t = (s.type || 'string');
    if (raw === '' || raw === undefined || raw === null) return undefined;
    if (t === 'integer') {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return raw;
      return n;
    }
    if (t === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return raw;
      return n;
    }
    if (t === 'boolean') {
      if (raw === true || raw === false) return raw;
      const v = String(raw).trim().toLowerCase();
      return v === '1' || v === 'true' || v === 'yes';
    }
    if (t === 'array') {
      const v = String(raw).trim();
      if (!v) return undefined;
      return v.split(',').map((x) => x.trim()).filter((x) => x);
    }
    return String(raw);
  }

  function buildBodyFromFields(fields) {
    const out = {};
    for (const f of fields || []) {
      const el = document.getElementById(`b_${f.name}`);
      if (!el) continue;
      const v = coerceValue(f.schema, el.value);
      if (v !== undefined) out[f.name] = v;
    }
    return out;
  }

  function flattenEndpoints(spec) {
    const result = [];
    for (const [path, item] of Object.entries(spec.paths || {})) {
      for (const method of Object.keys(item)) {
        const op = item[method];
        result.push({
          id: `${method.toUpperCase()} ${path}`,
          method,
          path,
          tags: op.tags || [],
          summary: op.summary || '',
          description: op.description || '',
          parameters: op.parameters || [],
          requestBody: op.requestBody,
          responses: op.responses || {},
        });
      }
    }
    return result;
  }

  function groupByTag(endpoints) {
    const map = new Map();
    for (const ep of endpoints) {
      const tag = (ep.tags && ep.tags[0]) || '其他';
      if (!map.has(tag)) map.set(tag, []);
      map.get(tag).push(ep);
    }
    return map;
  }

  function tagRank(tag) {
    const order = ['系统', '文档', 'Web免登', '台账', '兑换', '核销', '用户', '商城'];
    const i = order.indexOf(tag);
    if (i >= 0) return i;
    if (tag === '管理端') return 90;
    if (tag === 'Token') return 91;
    return 50;
  }

  function renderNav() {
    const nav = document.getElementById('nav');
    const keyword = document.getElementById('search').value.trim().toLowerCase();
    const currentTag = (state.current?.tags && state.current.tags[0]) || '';
    const visible = state.endpoints.filter((ep) => {
      if (!keyword) return true;
      const tag = (ep.tags && ep.tags[0]) || '其他';
      const hay = `${ep.path} ${ep.summary} ${tag}`.toLowerCase();
      return hay.includes(keyword);
    });

    const grouped = groupByTag(visible);
    const tags = Array.from(grouped.keys()).sort((a, b) => {
      const ra = tagRank(a);
      const rb = tagRank(b);
      if (ra !== rb) return ra - rb;
      return String(a).localeCompare(String(b), 'zh-CN');
    });

    const blocks = [];
    for (const tag of tags) {
      const eps = grouped.get(tag) || [];
      if (eps.length === 0) continue;

      const collapsed = !keyword && state.collapsedTags.has(tag) && tag !== currentTag;
      const actText = collapsed ? '展开' : '收起';
      blocks.push(
        `<div class="tagGroup" data-tag="${escapeHtml(tag)}">` +
        `<button class="tagHeader" data-tag="${escapeHtml(tag)}" type="button">` +
        `<span class="tagTitle">${escapeHtml(tag)}</span>` +
        `<span class="tagMeta">${escapeHtml(actText)} · ${eps.length}</span>` +
        `</button>` +
        `<div class="tagBody" style="${collapsed ? 'display:none;' : ''}">`
      );

      for (const ep of eps) {
        const active = state.current?.id === ep.id ? 'active' : '';
        blocks.push(
          `<div class="endpoint ${active}" data-id="${escapeHtml(ep.id)}">` +
          `<span class="method ${escapeHtml(ep.method.toUpperCase())}">${escapeHtml(ep.method.toUpperCase())}</span>` +
          `<div class="path" title="${escapeHtml(ep.path)}">${escapeHtml(ep.path)}</div>` +
          `</div>`
        );
      }

      blocks.push(`</div></div>`);
    }

    nav.innerHTML = blocks.join('');

    nav.querySelectorAll('.tagHeader').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.getAttribute('data-tag') || '';
        if (!tag) return;
        if (state.collapsedTags.has(tag)) {
          state.collapsedTags.delete(tag);
        } else {
          state.collapsedTags.add(tag);
        }
        renderNav();
      });
    });

    nav.querySelectorAll('.endpoint').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-id');
        const ep = state.endpoints.find((x) => x.id === id);
        if (ep) selectEndpoint(ep);
      });
    });
  }

  function renderDoc(ep) {
    document.getElementById('docTitle').textContent = ep.summary || '接口说明';
    document.getElementById('docPath').textContent = `${ep.method.toUpperCase()} ${ep.path}`;

    const doc = document.getElementById('doc');
    const params = (ep.parameters || []).filter((p) => p.in === 'query');

    const reqExample = extractExample(ep);
    const resp200 = ep.responses?.['200']?.content?.['application/json']?.examples;
    const respExample = resp200 ? Object.values(resp200)[0]?.value : null;

    const parts = [];
    parts.push(`<div class="muted small">标签：${escapeHtml((ep.tags && ep.tags[0]) || '其他')}</div>`);
    if (ep.description) {
      parts.push(`<div class="section"><h3>说明</h3><div class="small">${escapeHtml(ep.description)}</div></div>`);
    }

    parts.push(`<div class="section"><h3>基础信息</h3>`);
    parts.push(`<div class="kv"><div class="k">请求方式</div><div class="v">${escapeHtml(ep.method.toUpperCase())}</div></div>`);
    parts.push(`<div class="kv"><div class="k">请求路径</div><div class="v">${escapeHtml(ep.path)}</div></div>`);
    parts.push(`</div>`);

    if (params.length > 0) {
      parts.push(`<div class="section"><h3>Query 参数</h3>`);
      for (const p of params) {
        const req = p.required ? '是' : '否';
        parts.push(`<div class="kv"><div class="k">${escapeHtml(p.name)}（必填：${req}）</div><div class="v">${escapeHtml(p.description || '')}</div></div>`);
      }
      parts.push(`</div>`);
    }

    if (ep.requestBody) {
      parts.push(`<div class="section"><h3>请求体</h3>`);
      parts.push(`<div class="small muted">Content-Type: application/json</div>`);
      const bodySchema = getJsonBodySchema(ep);
      const fields = schemaFields(bodySchema);
      if (fields && fields.length > 0) {
        parts.push(`<div style="height:8px"></div>`);
        for (const f of fields) {
          const req = f.required ? '是' : '否';
          const t = f.schema?.type ? String(f.schema.type) : 'string';
          const ex = f.example !== undefined ? ` 例如：${escapeHtml(String(f.example))}` : '';
          parts.push(`<div class="kv"><div class="k">${escapeHtml(f.name)}（必填：${req}，类型：${escapeHtml(t)}）</div><div class="v">${escapeHtml(f.description || '')}${ex}</div></div>`);
        }
      }
      if (reqExample) {
        parts.push(`<div style="height:8px"></div>`);
        parts.push(`<div class="code">${escapeHtml(pretty(reqExample))}</div>`);
      } else {
        parts.push(`<div style="height:8px"></div>`);
        parts.push(`<div class="code">{}</div>`);
      }
      parts.push(`</div>`);
    }

    parts.push(`<div class="section"><h3>响应</h3>`);
    const respKeys = Object.keys(ep.responses || {});
    if (respKeys.length === 0) {
      parts.push(`<div class="muted small">未定义响应结构</div>`);
    } else {
      for (const code of respKeys) {
        const r = ep.responses[code];
        parts.push(`<div class="kv"><div class="k">HTTP ${escapeHtml(code)}</div><div class="v">${escapeHtml(r.description || '')}</div></div>`);
      }
    }
    if (respExample) {
      parts.push(`<div style="height:8px"></div>`);
      parts.push(`<div class="code">${escapeHtml(pretty(respExample))}</div>`);
    }
    parts.push(`</div>`);

    doc.innerHTML = parts.join('');
  }

  function renderTry(ep) {
    document.getElementById('tryMethod').textContent = ep.method.toUpperCase();
    document.getElementById('tryMethod').className = `method ${ep.method.toUpperCase()}`;
    document.getElementById('tryPath').textContent = ep.path;

    const queryParams = (ep.parameters || []).filter((p) => p.in === 'query');
    const qWrap = document.getElementById('tryQuery');
    const qSec = document.getElementById('tryQuerySection');
    if (queryParams.length === 0) {
      qSec.style.display = 'none';
      qWrap.innerHTML = '';
    } else {
      qSec.style.display = 'block';
      qWrap.innerHTML = queryParams
        .map((p) => {
          const req = p.required ? '必填' : '可选';
          const v = p.example !== undefined ? String(p.example) : '';
          return (
            `<div class="kv">` +
            `<div class="k">${escapeHtml(p.name)} <span class="muted">(${req})</span></div>` +
            `<div class="v"><input id="q_${escapeHtml(p.name)}" value="${escapeHtml(v)}" placeholder="${escapeHtml(p.description || '')}" /></div>` +
            `</div>`
          );
        })
        .join('');
    }

    const bodySec = document.getElementById('tryBodySection');
    const bodyEl = document.getElementById('tryBody');
    const bodyFieldsSec = document.getElementById('tryBodyFieldsSection');
    const bodyFieldsWrap = document.getElementById('tryBodyFields');
    const toggleBtn = document.getElementById('toggleBodyMode');

    toggleBtn.onclick = null;
    state.bodyMode = 'raw';

    if (ep.method.toUpperCase() === 'GET' || !ep.requestBody) {
      bodySec.style.display = 'none';
      bodyEl.value = '';
      bodyFieldsSec.style.display = 'none';
      bodyFieldsWrap.innerHTML = '';
      return;
    }

    const ex = extractExample(ep);
    const schema = getJsonBodySchema(ep);
    const fields = schemaFields(schema);

    if (fields && fields.length > 0) {
      state.bodyMode = 'fields';
      bodyFieldsSec.style.display = 'block';
      bodySec.style.display = 'none';

      bodyFieldsWrap.innerHTML = fields
        .map((f) => {
          const req = f.required ? '必填' : '可选';
          const hint = f.description || '';
          const init = (ex && typeof ex === 'object' && ex[f.name] !== undefined)
            ? String(ex[f.name])
            : (f.default !== undefined ? String(f.default) : (f.example !== undefined ? String(f.example) : ''));
          return (
            `<div class="kv">` +
            `<div class="k">${escapeHtml(f.name)} <span class="muted">(${req})</span></div>` +
            `<div class="v"><input id="b_${escapeHtml(f.name)}" value="${escapeHtml(init)}" placeholder="${escapeHtml(hint)}" /></div>` +
            `</div>`
          );
        })
        .join('');

      toggleBtn.textContent = '切换：原始 JSON';
      toggleBtn.onclick = () => {
        if (state.bodyMode === 'fields') {
          const b = buildBodyFromFields(fields);
          bodyEl.value = pretty(b);
          bodySec.style.display = 'block';
          bodyFieldsSec.style.display = 'none';
          state.bodyMode = 'raw';
          toggleBtn.textContent = '切换：表单字段';
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(bodyEl.value || '{}');
        } catch {
          parsed = {};
        }
        for (const f of fields) {
          const el = document.getElementById(`b_${f.name}`);
          if (!el) continue;
          const v = parsed && typeof parsed === 'object' && parsed[f.name] !== undefined ? String(parsed[f.name]) : '';
          el.value = v;
        }

        bodySec.style.display = 'none';
        bodyFieldsSec.style.display = 'block';
        state.bodyMode = 'fields';
        toggleBtn.textContent = '切换：原始 JSON';
      };

      return;
    }

    bodyFieldsSec.style.display = 'none';
    bodyFieldsWrap.innerHTML = '';
    bodySec.style.display = 'block';
    bodyEl.value = ex ? pretty(ex) : '{\n\n}';
  }

  function selectEndpoint(ep) {
    state.current = ep;
    renderNav();
    renderDoc(ep);
    renderTry(ep);
    document.getElementById('respStatus').textContent = '-';
    document.getElementById('respBody').textContent = '-';
    document.getElementById('respQrWrap').style.display = 'none';
  }

  async function send() {
    const ep = state.current;
    if (!ep) return;

    const params = ep.parameters || [];
    const query = collectQueryValues(params);
    const url = buildUrl(ep.path, query);

    const method = ep.method.toUpperCase();
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    };

    if (method !== 'GET') {
      if (state.bodyMode === 'fields') {
        const schema = getJsonBodySchema(ep);
        const fields = schemaFields(schema) || [];
        opts.body = JSON.stringify(buildBodyFromFields(fields));
      } else {
        const raw = document.getElementById('tryBody').value || '';
        if (raw.trim()) {
          opts.body = raw;
        }
      }
    }

    const resp = await fetch(url, opts);
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }

    document.getElementById('respStatus').textContent = `${resp.status}`;
    document.getElementById('respBody').textContent = pretty(data);

    const qrWrap = document.getElementById('respQrWrap');
    const qrImg = document.getElementById('respQrImg');
    qrWrap.style.display = 'none';
    qrImg.removeAttribute('src');

    const encoded = data && typeof data === 'object' ? data.encoded : null;
    if (resp.status >= 200 && resp.status < 300 && ep.path === '/exchange/qr' && encoded) {
      const s = String(encoded);
      const url = (data && typeof data === 'object' && data.qr_image_url) ? String(data.qr_image_url) : '';
      qrImg.src = url || `/qr/render?size=220&data=${encodeURIComponent(s)}`;
      qrWrap.style.display = 'block';
    }
  }

  async function init() {
    document.getElementById('baseUrl').value = window.location.origin;
    document.getElementById('useCurrent').addEventListener('click', () => {
      document.getElementById('baseUrl').value = window.location.origin;
    });
    document.getElementById('search').addEventListener('input', renderNav);
    document.getElementById('send').addEventListener('click', send);
    document.getElementById('copyCurl').addEventListener('click', async () => {
      if (!state.current) return;
      const curl = makeCurl(state.current);
      await navigator.clipboard.writeText(curl);
      document.getElementById('respStatus').textContent = '已复制';
    });

    const spec = await fetch('/openapi.json').then((r) => r.json());
    state.spec = spec;
    state.endpoints = flattenEndpoints(spec);
    document.getElementById('version').textContent = spec?.info?.version || '';

    renderNav();
    const first = state.endpoints[0];
    if (first) {
      selectEndpoint(first);
    }
  }

  init().catch((err) => {
    document.getElementById('docTitle').textContent = '加载失败';
    document.getElementById('doc').innerHTML = `<div class="code">${escapeHtml(String(err?.message || err))}</div>`;
  });
})();
