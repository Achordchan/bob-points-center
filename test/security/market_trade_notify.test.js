import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyMarketTrade } from '../../src/routes/mall.js';
import { getDefaultNotifySettings, normalizeNotifySettings } from '../../src/services/systemSettings.js';

const trade = {
  listing_id: 'L_1',
  exchange_id: 'MALL_1',
  seller_userid: 'seller1',
  seller_name: '卖家甲',
  buyer_userid: 'buyer1',
  buyer_name: '买家乙',
  price: 120,
  transfer: { fromBalance: 30, toBalance: 520 },
  order: { product_name: '蓝牙耳机', product_id: 'P1' },
};

test('市场成交：卖家与买家各收到一条私聊，内容带对方姓名与成交价', () => {
  const calls = [];
  notifyMarketTrade({ db: {}, cfg: {}, trade, notify: async (args) => { calls.push(args); return null; } });
  assert.equal(calls.length, 2);

  const seller = calls.find((c) => c.userid === 'seller1');
  assert.equal(seller.event, 'market_sold');
  assert.equal(seller.variables.buyer_name, '买家乙');
  assert.equal(seller.variables.product_name, '蓝牙耳机');
  assert.equal(seller.variables.amount, '120');
  assert.equal(seller.variables.balance, '520');
  assert.ok(seller.lines.includes('买家：买家乙'));

  const buyer = calls.find((c) => c.userid === 'buyer1');
  assert.equal(buyer.event, 'market_bought');
  assert.equal(buyer.variables.seller_name, '卖家甲');
  assert.equal(buyer.variables.balance, '30');
});

test('市场成交：通知失败不会向外抛出', async () => {
  assert.doesNotThrow(() => notifyMarketTrade({
    db: {}, cfg: {}, trade, notify: async () => { throw new Error('dingtalk down'); },
  }));
  await new Promise((r) => setImmediate(r));
});

test('通知模板默认包含市场售出/购买，且旧配置缺少这两项时自动补默认值', () => {
  const defaults = getDefaultNotifySettings();
  assert.equal(defaults.templates.market_sold.enabled, true);
  assert.match(defaults.templates.market_sold.content, /\{\{buyer_name\}\}/);
  assert.match(defaults.templates.market_bought.content, /\{\{seller_name\}\}/);

  const legacy = normalizeNotifySettings({ enabled: true, templates: { grant: { enabled: true, title: 't', content: 'c' } } });
  assert.equal(legacy.templates.market_sold.enabled, true);
  assert.equal(legacy.templates.market_bought.enabled, true);
});
