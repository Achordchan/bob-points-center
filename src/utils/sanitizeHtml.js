const ALLOWED_TAGS = new Set([
  'a', 'b', 'br', 'div', 'em', 'i', 'img', 'li', 'ol', 'p', 'span', 'strong', 'u', 'ul',
]);
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'target', 'rel']);

function isSafeUrl(value, attrName) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (attrName === 'src') return /^(https?:|data:image\/)/i.test(text);
  if (attrName === 'href') return /^(https?:|mailto:|#)/i.test(text);
  return true;
}

/**
 * 富文本清洗：去掉脚本、事件属性和危险 URL，只保留基础排版标签。
 * 无第三方依赖，供服务端入库与前端展示共用思路。
 */
export function sanitizeRichHtml(input) {
  const raw = String(input || '');
  if (!raw.trim()) return '';

  // 无 DOM 环境时用保守正则清洗；有 DOM 时走更精确路径。
  if (typeof document !== 'undefined' && document.createElement) {
    const template = document.createElement('template');
    template.innerHTML = raw;
    template.content.querySelectorAll('*').forEach((node) => {
      const tag = String(node.tagName || '').toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        node.replaceWith(document.createTextNode(node.textContent || ''));
        return;
      }
      Array.from(node.attributes || []).forEach((attr) => {
        const name = String(attr.name || '').toLowerCase();
        const value = String(attr.value || '').trim();
        if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) {
          node.removeAttribute(attr.name);
          return;
        }
        if ((name === 'href' || name === 'src') && !isSafeUrl(value, name)) {
          node.removeAttribute(attr.name);
        }
      });
      if (tag === 'a') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return template.innerHTML;
  }

  let html = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(script|style|iframe|object|embed|link|meta|form|input|button|textarea|svg|math)(\s[^>]*)?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, '')
    .replace(/\s(href|src)\s*=\s*javascript:[^\s>]+/gi, '');

  // 去掉不在白名单的标签，保留内容。
  html = html.replace(/<\/?([a-z0-9-]+)(\s[^>]*)?>/gi, (match, tagName, attrs = '') => {
    const tag = String(tagName || '').toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (match.startsWith('</')) return `</${tag}>`;
    if (tag === 'br') return '<br>';

    const kept = [];
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9:._]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let m;
    while ((m = attrRe.exec(String(attrs || '')))) {
      const name = String(m[1] || '').toLowerCase();
      const value = m[3] ?? m[4] ?? m[5] ?? '';
      if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) continue;
      if ((name === 'href' || name === 'src') && !isSafeUrl(value, name)) continue;
      kept.push(`${name}="${String(value).replace(/"/g, '&quot;')}"`);
    }
    if (tag === 'a') {
      kept.push('target="_blank"', 'rel="noopener noreferrer"');
    }
    return kept.length ? `<${tag} ${kept.join(' ')}>` : `<${tag}>`;
  });

  return html;
}

export function richTextIsEmpty(value) {
  return !String(value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}
