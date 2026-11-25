import test from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultGroupCardSettings, normalizeGroupCardSettings } from '../../src/services/systemSettings.js';

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function allButtonUrls(settings) {
  return Object.values(settings.templates).flatMap((tpl) => (tpl.buttons || []).map((btn) => btn.url));
}

test('群卡片默认按钮链接按 SERVER_BASE_URL 拼接，不含写死的域名', () => {
  withEnv({ SERVER_BASE_URL: 'https://b.example.test/' }, () => {
    const urls = allButtonUrls(getDefaultGroupCardSettings());
    assert.equal(urls.length, 10);
    for (const url of urls) {
      assert.match(url, /^https:\/\/b\.example\.test\/mall\?tab=(shop|balance|orders)$/);
    }
  });
});

test('SERVER_BASE_URL 在调用时读取，而不是在 import 时固化', () => {
  const first = withEnv({ SERVER_BASE_URL: 'https://one.example.test' }, () => getDefaultGroupCardSettings());
  const second = withEnv({ SERVER_BASE_URL: 'https://two.example.test' }, () => normalizeGroupCardSettings({}));
  assert.equal(first.templates.manual.buttons[0].url, 'https://one.example.test/mall?tab=shop');
  assert.equal(second.templates.manual.buttons[0].url, 'https://two.example.test/mall?tab=shop');
});

test('未配置 SERVER_BASE_URL 时退回本机地址', () => {
  withEnv({ SERVER_BASE_URL: undefined, PORT: '8123' }, () => {
    assert.equal(getDefaultGroupCardSettings().templates.mall_close.buttons[0].url, 'http://127.0.0.1:8123/mall?tab=orders');
  });
});

test('已保存设置里指向旧域名的按钮在读取时改指 SERVER_BASE_URL，其它自定义链接不变', () => {
  withEnv({ SERVER_BASE_URL: 'https://b.example.test' }, () => {
    const saved = {
      templates: {
        manual: {
          buttons: [
            { text: '去商城', url: 'https://bob.baymaxgroup.com/mall?tab=shop', color: 'blue' },
            { text: '外链', url: 'https://example.org/page', color: 'gray' },
            { text: '相似域名', url: 'https://bob.baymaxgroup.com.evil.test/x', color: 'gray' },
          ],
        },
        mall_close: { buttons: JSON.stringify([{ text: '订单', url: 'http://bob.baymaxgroup.com/mall?tab=orders' }]) },
      },
    };
    const settings = normalizeGroupCardSettings(saved);
    assert.deepEqual(settings.templates.manual.buttons.map((b) => b.url), [
      'https://b.example.test/mall?tab=shop',
      'https://example.org/page',
      'https://bob.baymaxgroup.com.evil.test/x',
    ]);
    assert.equal(settings.templates.mall_close.buttons[0].url, 'https://b.example.test/mall?tab=orders');
    assert.equal(saved.templates.manual.buttons[0].url, 'https://bob.baymaxgroup.com/mall?tab=shop');
  });
});

test('完整格式按钮（event.params.url）里的旧域名同样在读取时改指新地址', () => {
  withEnv({ SERVER_BASE_URL: 'https://b.example.test' }, () => {
    const saved = {
      templates: {
        manual: {
          buttons: [
            { text: '去商城', color: 'blue', status: 'normal', event: { type: 'openLink', params: { url: 'https://bob.baymaxgroup.com/mall?tab=shop' } } },
            { text: '外链', event: { type: 'openLink', params: { url: 'https://example.org/x' } } },
          ],
        },
      },
    };
    const buttons = normalizeGroupCardSettings(saved).templates.manual.buttons;
    assert.equal(buttons[0].event.params.url, 'https://b.example.test/mall?tab=shop');
    assert.equal(buttons[0].event.type, 'openLink');
    assert.equal(buttons[0].text, '去商城');
    assert.equal(buttons[1].event.params.url, 'https://example.org/x');
    assert.equal(saved.templates.manual.buttons[0].event.params.url, 'https://bob.baymaxgroup.com/mall?tab=shop');
  });
});
