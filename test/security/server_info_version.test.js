import test from 'node:test';
import assert from 'node:assert/strict';

import { getPackageMeta } from '../../src/routes/admin/shared.js';

test('管理端系统信息读取项目根目录版本号', () => {
  assert.deepEqual(getPackageMeta(), { name: 'bob', version: '0.1.0' });
});
