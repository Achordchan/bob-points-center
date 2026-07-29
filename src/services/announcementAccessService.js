import { createHash } from 'node:crypto';

export function normalizeAnnouncementContent(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

export function computeAnnouncementContentHash({ title, content, requiresAcknowledgement } = {}) {
  const payload = [
    'announcement:v1',
    normalizeAnnouncementContent(title),
    normalizeAnnouncementContent(content),
    requiresAcknowledgement ? '1' : '0',
  ].join('\n');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function announcementRequiresNewRevision(previous = {}, next = {}) {
  return normalizeAnnouncementContent(previous.title) !== normalizeAnnouncementContent(next.title)
    || normalizeAnnouncementContent(previous.content) !== normalizeAnnouncementContent(next.content)
    || Number(previous.requires_acknowledgement || 0) !== Number(next.requires_acknowledgement || 0);
}

function toAccessItem(row = {}) {
  return {
    id: Number(row.id),
    title: String(row.title || ''),
    content: String(row.content || ''),
    level: String(row.level || 'info'),
    sort: Number(row.sort || 0),
    show_fullscreen: Number(row.show_fullscreen || 0),
    requires_acknowledgement: Number(row.requires_acknowledgement || 0),
    revision: Number(row.revision || 1),
    content_hash: String(row.content_hash || ''),
    publish_at: row.publish_at === null || row.publish_at === undefined ? null : Number(row.publish_at),
    updated_at: Number(row.updated_at || 0),
  };
}

export async function listPendingFullscreenAnnouncements(db, userid, now = Math.floor(Date.now() / 1000)) {
  const uid = String(userid || '').trim();
  if (!uid) return [];
  const rows = await db.all(
    `SELECT a.id, a.title, a.content, a.level, a.sort, a.show_fullscreen,
            a.requires_acknowledgement, a.revision, a.content_hash,
            a.publish_at, a.created_at, a.updated_at, ack.action AS acknowledgement_action
       FROM content_announcements a
       LEFT JOIN content_announcement_acknowledgements ack
         ON ack.userid = ?
        AND ack.announcement_id = a.id
        AND ack.revision = a.revision
        AND ack.content_hash = a.content_hash
      WHERE a.is_enabled = 1
        AND (a.publish_at IS NULL OR a.publish_at <= ?)
        AND (a.show_fullscreen = 1 OR a.requires_acknowledgement = 1)
        AND (
          ack.id IS NULL
          OR (a.requires_acknowledgement = 1 AND ack.action <> 'acknowledged')
        )
      ORDER BY a.requires_acknowledgement DESC,
               a.sort ASC,
               COALESCE(a.publish_at, a.created_at) ASC,
               a.id ASC`,
    [uid, now],
  );
  return (rows || []).map(toAccessItem);
}

export async function getNextAnnouncementCheckAt(db, now = Math.floor(Date.now() / 1000)) {
  const row = await db.get(
    `SELECT MIN(publish_at) AS next_check_at
       FROM content_announcements
      WHERE is_enabled = 1
        AND (show_fullscreen = 1 OR requires_acknowledgement = 1)
        AND publish_at > ?`,
    [now],
  );
  const value = Number(row?.next_check_at || 0);
  return Number.isFinite(value) && value > now ? value : null;
}

export async function buildAnnouncementAccessState(db, userid, now = Math.floor(Date.now() / 1000)) {
  const pending = await listPendingFullscreenAnnouncements(db, userid, now);
  const nextCheckAt = await getNextAnnouncementCheckAt(db, now);
  return {
    ok: true,
    blocked: pending.some((item) => item.requires_acknowledgement === 1),
    pending,
    next_check_at: nextCheckAt,
    server_time: now,
  };
}

export async function hasPendingRequiredAnnouncement(db, userid, now = Math.floor(Date.now() / 1000)) {
  const uid = String(userid || '').trim();
  if (!uid) return false;
  const row = await db.get(
    `SELECT a.id
       FROM content_announcements a
       LEFT JOIN content_announcement_acknowledgements ack
         ON ack.userid = ?
        AND ack.announcement_id = a.id
        AND ack.revision = a.revision
        AND ack.content_hash = a.content_hash
        AND ack.action = 'acknowledged'
      WHERE a.is_enabled = 1
        AND a.requires_acknowledgement = 1
        AND (a.publish_at IS NULL OR a.publish_at <= ?)
        AND ack.id IS NULL
      LIMIT 1`,
    [uid, now],
  );
  return Boolean(row);
}

export async function recordAnnouncementAction(db, {
  userid,
  announcementId,
  revision,
  contentHash,
  action,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  const uid = String(userid || '').trim();
  const id = Number(announcementId);
  const requestedRevision = Number(revision);
  const requestedHash = String(contentHash || '').trim().toLowerCase();
  const requestedAction = String(action || '').trim();
  if (!uid || !Number.isInteger(id) || id <= 0 || !Number.isInteger(requestedRevision) || requestedRevision <= 0) {
    const err = new Error('invalid announcement acknowledgement');
    err.code = 'invalid_announcement_acknowledgement';
    throw err;
  }
  if (!/^[a-f0-9]{64}$/.test(requestedHash)) {
    const err = new Error('invalid announcement content hash');
    err.code = 'invalid_announcement_content_hash';
    throw err;
  }
  if (requestedAction !== 'acknowledged' && requestedAction !== 'dismissed') {
    const err = new Error('invalid announcement action');
    err.code = 'invalid_announcement_action';
    throw err;
  }

  const row = await db.get(
    `SELECT id, is_enabled, publish_at, show_fullscreen, requires_acknowledgement, revision, content_hash
       FROM content_announcements
      WHERE id = ?
      FOR UPDATE`,
    [id],
  );
  if (!row) {
    const err = new Error('announcement not found');
    err.code = 'announcement_not_found';
    throw err;
  }
  if (Number(row.is_enabled || 0) !== 1
    || (row.publish_at !== null && row.publish_at !== undefined && Number(row.publish_at) > now)
    || (Number(row.show_fullscreen || 0) !== 1 && Number(row.requires_acknowledgement || 0) !== 1)) {
    const err = new Error('announcement not active');
    err.code = 'announcement_not_active';
    throw err;
  }
  if (Number(row.revision) !== requestedRevision || String(row.content_hash || '').toLowerCase() !== requestedHash) {
    const err = new Error('announcement revision conflict');
    err.code = 'announcement_revision_conflict';
    err.current = {
      revision: Number(row.revision || 1),
      content_hash: String(row.content_hash || ''),
    };
    throw err;
  }
  if (Number(row.requires_acknowledgement || 0) === 1 && requestedAction !== 'acknowledged') {
    const err = new Error('announcement acknowledgement required');
    err.code = 'announcement_acknowledgement_required';
    throw err;
  }

  await db.run(
    `INSERT INTO content_announcement_acknowledgements(
       userid, announcement_id, revision, content_hash, action, created_at
     ) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(userid, announcement_id, revision)
     DO UPDATE SET content_hash = excluded.content_hash,
                   action = excluded.action,
                   created_at = excluded.created_at`,
    [uid, id, requestedRevision, requestedHash, requestedAction, now],
  );
  return { id, revision: requestedRevision, content_hash: requestedHash, action: requestedAction };
}
