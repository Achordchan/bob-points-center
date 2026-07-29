import test from 'node:test';
import assert from 'node:assert/strict';
import {
  announcementRequiresNewRevision,
  buildAnnouncementAccessState,
  computeAnnouncementContentHash,
  recordAnnouncementAction,
} from '../../src/services/announcementAccessService.js';

const base = {
  title: '隐私守则',
  content: '请阅读以下规则。',
  requiresAcknowledgement: true,
};

test('公告 hash 绑定标题、正文和确认语义', () => {
  const hash = computeAnnouncementContentHash(base);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, computeAnnouncementContentHash({ ...base }));
  assert.notEqual(hash, computeAnnouncementContentHash({ ...base, title: '新隐私守则' }));
  assert.notEqual(hash, computeAnnouncementContentHash({ ...base, content: '新正文' }));
  assert.notEqual(hash, computeAnnouncementContentHash({ ...base, requiresAcknowledgement: false }));
});

test('只有标题、正文和要求确认语义生成新修订', () => {
  const previous = { title: '公告', content: '正文', requires_acknowledgement: 1 };
  assert.equal(announcementRequiresNewRevision(previous, { ...previous, level: 'danger', show_fullscreen: 0 }), false);
  assert.equal(announcementRequiresNewRevision(previous, { ...previous, title: '公告 2' }), true);
  assert.equal(announcementRequiresNewRevision(previous, { ...previous, content: '新正文' }), true);
  assert.equal(announcementRequiresNewRevision(previous, { ...previous, requires_acknowledgement: 0 }), true);
});

test('访问状态按待处理项判断阻断并返回未来检查时间', async () => {
  const db = {
    async all() {
      return [{
        id: 2,
        title: '规则',
        content: '正文',
        level: 'warning',
        sort: 1,
        show_fullscreen: 1,
        requires_acknowledgement: 1,
        revision: 2,
        content_hash: 'a'.repeat(64),
        publish_at: 100,
        updated_at: 101,
      }];
    },
    async get() {
      return { next_check_at: 300 };
    },
  };
  const state = await buildAnnouncementAccessState(db, 'u1', 200);
  assert.equal(state.blocked, true);
  assert.equal(state.pending[0].revision, 2);
  assert.equal(state.next_check_at, 300);
});

test('强制公告不能 dismissed，版本冲突携带当前修订', async () => {
  const hash = 'b'.repeat(64);
  const db = {
    async get() {
      return {
        id: 5,
        is_enabled: 1,
        publish_at: null,
        show_fullscreen: 1,
        requires_acknowledgement: 1,
        revision: 3,
        content_hash: hash,
      };
    },
    async run() {
      throw new Error('不应写入');
    },
  };
  await assert.rejects(
    recordAnnouncementAction(db, {
      userid: 'u1', announcementId: 5, revision: 3, contentHash: hash, action: 'dismissed', now: 200,
    }),
    (err) => err.code === 'announcement_acknowledgement_required',
  );
  await assert.rejects(
    recordAnnouncementAction(db, {
      userid: 'u1', announcementId: 5, revision: 2, contentHash: 'c'.repeat(64), action: 'acknowledged', now: 200,
    }),
    (err) => err.code === 'announcement_revision_conflict' && err.current.revision === 3,
  );
});

test('确认写入使用唯一键实现幂等更新', async () => {
  const hash = 'd'.repeat(64);
  let write = null;
  const db = {
    async get() {
      return {
        id: 8,
        is_enabled: 1,
        publish_at: 100,
        show_fullscreen: 1,
        requires_acknowledgement: 0,
        revision: 1,
        content_hash: hash,
      };
    },
    async run(sql, params) {
      write = { sql, params };
      return { changes: 1 };
    },
  };
  const result = await recordAnnouncementAction(db, {
    userid: 'u2', announcementId: 8, revision: 1, contentHash: hash, action: 'dismissed', now: 200,
  });
  assert.equal(result.action, 'dismissed');
  assert.match(write.sql, /ON CONFLICT\(userid, announcement_id, revision\)/);
  assert.deepEqual(write.params, ['u2', 8, 1, hash, 'dismissed', 200]);
});
