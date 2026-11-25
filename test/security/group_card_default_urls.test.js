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
