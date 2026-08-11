import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeAdminRedeemCursor,
  encodeAdminRedeemCursor,
  publicAdminOrderReference,
  serializeAdminRedeemRow,
} from '../../src/services/adminRedeemVisibilityService.js';

const cdkOrder = {
  exchange_id: 'CDK_EXAMPLE',
  bob_amount: 0,
  created_at: 1_765_000_000,
  redeem_source: 'cdk',
  cdk_product_bob_amount: 88,
  cdk_code: 'SECRET-CDK',
  batch_id: 'SECRET-BATCH',
};

test('普通管理员读取 CDK 订单时隐藏内部来源和兑换生成时间', () => {
  assert.deepEqual(serializeAdminRedeemRow(cdkOrder), {
    exchange_id: publicAdminOrderReference('CDK_EXAMPLE'),
    bob_amount: 88,
    created_at: null,
  });
  assert.match(publicAdminOrderReference('CDK_EXAMPLE'), /^ORDER_[A-F0-9]{16}$/);
  assert.doesNotMatch(publicAdminOrderReference('CDK_EXAMPLE'), /CDK/i);
});

test('普通商城订单保留下单时间且不返回内部来源字段', () => {
  assert.deepEqual(serializeAdminRedeemRow({
    exchange_id: 'ORDER_EXAMPLE',
    bob_amount: 20,
    created_at: 1_765_000_100,
    redeem_source: 'purchase',
    cdk_product_bob_amount: null,
  }), {
    exchange_id: 'ORDER_EXAMPLE',
    bob_amount: 20,
    created_at: 1_765_000_100,
  });
});

test('超级管理员审计详情保留完整 CDK 追溯字段', () => {
  assert.deepEqual(serializeAdminRedeemRow(cdkOrder, { isSuperAdmin: true }), cdkOrder);
  assert.notEqual(serializeAdminRedeemRow(cdkOrder, { isSuperAdmin: true }), cdkOrder);
});

test('订单翻页游标不暴露原始 CDK 单号和兑换时间', () => {
  const cursor = encodeAdminRedeemCursor({ at: 1_765_000_000, exchangeId: 'CDK_EXAMPLE' }, 'test-secret');
  assert.match(cursor, /^v1\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(cursor, /CDK|1765000000/);
  assert.deepEqual(decodeAdminRedeemCursor(cursor, 'test-secret'), {
    at: 1_765_000_000,
    exchangeId: 'CDK_EXAMPLE',
  });
  assert.equal(decodeAdminRedeemCursor(cursor, 'wrong-secret'), null);
});
