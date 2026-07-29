// Auto-split from admin.js — contentRoutes.js
import { requireAdminSession } from '../../middleware/requireAdminSession.js';
import { sanitizeRichHtml } from '../../utils/sanitizeHtml.js';
import {
  announcementRequiresNewRevision,
  computeAnnouncementContentHash,
} from '../../services/announcementAccessService.js';
import {
  attachFeedbackMessages,
  getAdminSessionPayload,
  isTruthyFlag,
  normalizeAnnouncementLevel,
  normalizeFeedbackStatus,
  publishAnnouncementAccessChanged,
  publishMoreChanged,
  runInTransaction,
  toOptionalInt,
  toPositiveInt,
} from './shared.js';

export function registerAdminContentRoutes(router) {
  router.get('/content/faq', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limit = Math.min(300, Math.max(1, toPositiveInt(req.query?.limit, 120)));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT id, question, answer, sort, is_enabled, created_at, updated_at
         FROM content_faq
         ORDER BY sort ASC, id DESC
         LIMIT ?`,
        [limit],
      );
      return res.json({ ok: true, count: (rows || []).length, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/faq/save', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    const question = req.body?.question ? String(req.body.question).trim() : '';
    const answer = req.body?.answer ? String(req.body.answer).trim() : '';
    const sort = toOptionalInt(req.body?.sort) ?? 0;
    const isEnabled = isTruthyFlag(req.body?.is_enabled) ? 1 : 0;
    if (!question) return res.status(400).json({ error: 'missing question' });
    if (!answer) return res.status(400).json({ error: 'missing answer' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (id) {
        const r = await db.run(
          `UPDATE content_faq
           SET question = ?, answer = ?, sort = ?, is_enabled = ?, updated_at = unixepoch()
           WHERE id = ?`,
          [question, answer, sort, isEnabled, id],
        );
        if (!r?.changes) return res.status(400).json({ error: 'faq not found' });
        publishMoreChanged('faq');
        return res.json({ ok: true, id });
      }
      const r = await db.run(
        `INSERT INTO content_faq(question, answer, sort, is_enabled, created_at, updated_at)
         VALUES(?, ?, ?, ?, unixepoch(), unixepoch())`,
        [question, answer, sort, isEnabled],
      );
      publishMoreChanged('faq');
      return res.json({ ok: true, id: Number(r?.lastID || 0) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/faq/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    if (!id) return res.status(400).json({ error: 'missing id' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const r = await db.run('DELETE FROM content_faq WHERE id = ?', [id]);
      if (!r?.changes) return res.status(400).json({ error: 'faq not found' });
      publishMoreChanged('faq');
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/content/announcements', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limit = Math.min(200, Math.max(1, toPositiveInt(req.query?.limit, 80)));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT id, title, content, level, sort, is_enabled, publish_at,
                show_fullscreen, requires_acknowledgement, revision, content_hash,
                created_at, updated_at
         FROM content_announcements
         ORDER BY COALESCE(publish_at, created_at) DESC, sort ASC, id DESC
         LIMIT ?`,
        [limit],
      );
      return res.json({ ok: true, count: (rows || []).length, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/announcements/save', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    const title = req.body?.title ? String(req.body.title).trim() : '';
    const content = req.body?.content ? String(req.body.content).trim() : '';
    const level = normalizeAnnouncementLevel(req.body?.level);
    const sort = toOptionalInt(req.body?.sort) ?? 0;
    const isEnabled = isTruthyFlag(req.body?.is_enabled) ? 1 : 0;
    const publishAt = toOptionalInt(req.body?.publish_at);
    const requiresAcknowledgement = isTruthyFlag(req.body?.requires_acknowledgement) ? 1 : 0;
    const showFullscreen = requiresAcknowledgement || isTruthyFlag(req.body?.show_fullscreen) ? 1 : 0;
    if (!title) return res.status(400).json({ error: 'missing title' });
    if (!content) return res.status(400).json({ error: 'missing content' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const admin = (await getAdminSessionPayload(req)) || {};
      const actorId = admin?.userid ? String(admin.userid) : '';
      const actorName = admin?.name ? String(admin.name) : '';
      const saved = await runInTransaction(db, async (tx) => {
        if (id) {
          const previous = await tx.get(
            `SELECT id, title, content, requires_acknowledgement, revision, content_hash
               FROM content_announcements
              WHERE id = ?
              FOR UPDATE`,
            [id],
          );
          if (!previous) return null;
          const revisionChanged = announcementRequiresNewRevision(previous, {
            title,
            content,
            requires_acknowledgement: requiresAcknowledgement,
          });
          const revision = revisionChanged ? Number(previous.revision || 1) + 1 : Number(previous.revision || 1);
          const contentHash = revisionChanged
            ? computeAnnouncementContentHash({ title, content, requiresAcknowledgement: requiresAcknowledgement === 1 })
            : String(previous.content_hash || '');
          await tx.run(
            `UPDATE content_announcements
                SET title = ?, content = ?, level = ?, sort = ?, is_enabled = ?, publish_at = ?,
                    show_fullscreen = ?, requires_acknowledgement = ?, revision = ?, content_hash = ?,
                    updated_at = unixepoch()
              WHERE id = ?`,
            [title, content, level, sort, isEnabled, publishAt, showFullscreen,
              requiresAcknowledgement, revision, contentHash, id],
          );
          if (revisionChanged) {
            await tx.run(
              `INSERT INTO content_announcement_revisions(
                 announcement_id, revision, title, content, requires_acknowledgement,
                 content_hash, created_by, created_name, created_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
              [id, revision, title, content, requiresAcknowledgement, contentHash, actorId, actorName],
            );
          }
          return { id, revision, content_hash: contentHash };
        }
        const revision = 1;
        const contentHash = computeAnnouncementContentHash({
          title,
          content,
          requiresAcknowledgement: requiresAcknowledgement === 1,
        });
        const inserted = await tx.run(
          `INSERT INTO content_announcements(
             title, content, level, sort, is_enabled, publish_at, show_fullscreen,
             requires_acknowledgement, revision, content_hash, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
          [title, content, level, sort, isEnabled, publishAt, showFullscreen,
            requiresAcknowledgement, revision, contentHash],
        );
        const announcementId = Number(inserted?.lastID || 0);
        await tx.run(
          `INSERT INTO content_announcement_revisions(
             announcement_id, revision, title, content, requires_acknowledgement,
             content_hash, created_by, created_name, created_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
          [announcementId, revision, title, content, requiresAcknowledgement, contentHash, actorId, actorName],
        );
        return { id: announcementId, revision, content_hash: contentHash };
      });
      if (!saved) return res.status(400).json({ error: 'announcement not found' });
      req.auditLogPayload = {
        announcement_id: saved.id,
        revision: saved.revision,
        content_hash: saved.content_hash,
        show_fullscreen: showFullscreen,
        requires_acknowledgement: requiresAcknowledgement,
      };
      publishMoreChanged('announcements');
      publishAnnouncementAccessChanged({
        announcement_id: saved.id,
        revision: saved.revision,
        reason: id ? 'updated' : 'created',
      });
      return res.json({ ok: true, ...saved });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/announcements/delete', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    if (!id) return res.status(400).json({ error: 'missing id' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      const r = await db.run('DELETE FROM content_announcements WHERE id = ?', [id]);
      if (!r?.changes) return res.status(400).json({ error: 'announcement not found' });
      publishMoreChanged('announcements');
      publishAnnouncementAccessChanged({ announcement_id: id, reason: 'deleted' });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/content/feedback', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limit = Math.min(300, Math.max(1, toPositiveInt(req.query?.limit, 120)));
    const status = req.query?.status ? String(req.query.status).trim() : '';
    const keyword = req.query?.keyword ? String(req.query.keyword).trim() : '';
    try {
      res.setHeader('Cache-Control', 'no-store');
      const where = [];
      const params = [];
      if (status) {
        where.push('f.status = ?');
        params.push(normalizeFeedbackStatus(status));
      }
      if (keyword) {
        const kw = `%${keyword}%`;
        where.push('(f.userid LIKE ? OR COALESCE(f.name, \'\') LIKE ? OR f.content LIKE ?)');
        params.push(kw, kw, kw);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = await db.all(
        `SELECT f.id, f.userid, COALESCE(f.name, '') AS name, f.category, f.content, f.contact,
                f.status, f.reply, f.handled_by, f.handled_name, f.handled_at, f.created_at, f.updated_at
         FROM user_feedback f
         ${whereSql}
         ORDER BY f.id DESC
         LIMIT ?`,
        [...params, limit],
      );
      const data = await attachFeedbackMessages(db, rows || []);
      return res.json({ ok: true, count: data.length, data });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/feedback/handle', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    const status = normalizeFeedbackStatus(req.body?.status);
    const reply = req.body?.reply ? sanitizeRichHtml(String(req.body.reply).trim()) : '';
    if (!id) return res.status(400).json({ error: 'missing id' });
    const payload = (await getAdminSessionPayload(req)) || {};
    const actorId = payload?.userid ? String(payload.userid) : '';
    const actorName = payload?.name ? String(payload.name) : '';
    try {
      res.setHeader('Cache-Control', 'no-store');
      const row = await db.get('SELECT id FROM user_feedback WHERE id = ?', [id]);
      if (!row) return res.status(400).json({ error: 'feedback not found' });
      await runInTransaction(db, async (tx) => {
        if (reply) {
          await tx.run(
            `INSERT INTO user_feedback_messages(feedback_id, sender_type, sender_id, sender_name, content, created_at)
             VALUES(?, 'admin', ?, ?, ?, unixepoch())`,
            [id, actorId, actorName, reply],
          );
        }
        await tx.run(
          `UPDATE user_feedback
           SET status = ?, reply = CASE WHEN ? <> '' THEN ? ELSE reply END, handled_by = ?, handled_name = ?, handled_at = unixepoch(), updated_at = unixepoch()
           WHERE id = ?`,
          [status, reply, reply, actorId, actorName, id],
        );
      });
      publishMoreChanged('feedback');
      return res.json({ ok: true, id });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/content/version', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT id, version_name, release_notes, is_enabled, publish_at, created_at, updated_at
         FROM system_versions
         ORDER BY COALESCE(publish_at, created_at) DESC, id DESC
         LIMIT 50`,
      );
      return res.json({ ok: true, count: (rows || []).length, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/content/version/save', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toOptionalInt(req.body?.id);
    const versionName = req.body?.version_name ? String(req.body.version_name).trim() : '';
    const releaseNotes = req.body?.release_notes ? String(req.body.release_notes).trim() : '';
    const isEnabled = isTruthyFlag(req.body?.is_enabled) ? 1 : 0;
    const publishAt = toOptionalInt(req.body?.publish_at);
    if (!versionName) return res.status(400).json({ error: 'missing version_name' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (id) {
        const r = await db.run(
          `UPDATE system_versions
           SET version_name = ?, release_notes = ?, is_enabled = ?, publish_at = ?, updated_at = unixepoch()
           WHERE id = ?`,
          [versionName, releaseNotes, isEnabled, publishAt, id],
        );
        if (!r?.changes) return res.status(400).json({ error: 'version not found' });
        publishMoreChanged('version');
        return res.json({ ok: true, id });
      }
      const r = await db.run(
        `INSERT INTO system_versions(version_name, release_notes, is_enabled, publish_at, created_at, updated_at)
         VALUES(?, ?, ?, ?, unixepoch(), unixepoch())`,
        [versionName, releaseNotes, isEnabled, publishAt],
      );
      publishMoreChanged('version');
      return res.json({ ok: true, id: Number(r?.lastID || 0) });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });


}
