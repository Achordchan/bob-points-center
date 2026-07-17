import test from 'node:test';
import assert from 'node:assert/strict';

// 纯逻辑：模拟 transfer 锁序（与 ledgerService 一致）
function lockOrder(fromId, toId) {
  return [fromId, toId].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

test('双向转账锁序一致', () => {
  assert.deepEqual(lockOrder('a', 'b'), ['a', 'b']);
  assert.deepEqual(lockOrder('b', 'a'), ['a', 'b']);
});
