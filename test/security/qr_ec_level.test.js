import test from 'node:test';
import assert from 'node:assert/strict';
import { createQrPngBuffer, normalizeQrEcLevel } from '../../src/services/qrImageService.js';

// 转发核销图要在二维码中间盖产品名，需要 H 级容错；默认仍是 M，非法值回落 M。
test('二维码容错等级参数', async () => {
  assert.equal(normalizeQrEcLevel(), 'M');
  assert.equal(normalizeQrEcLevel('h'), 'H');
  assert.equal(normalizeQrEcLevel('Q'), 'Q');
  assert.equal(normalizeQrEcLevel('X'), 'M');

  const data = 'bob-qr-ec-level-test';
  const m = await createQrPngBuffer(data, { size: 240 });
  const h = await createQrPngBuffer(data, { size: 240, ec: 'H' });
  const mAgain = await createQrPngBuffer(data, { size: 240, ec: 'm' });
  // 缓存键要区分容错等级，不能把 M 的图当成 H 返回。
  assert.notDeepEqual(h, m);
  assert.deepEqual(mAgain, m);
});
