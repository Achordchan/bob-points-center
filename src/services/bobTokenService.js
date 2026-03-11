import crypto from 'node:crypto';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export async function createBobToken(db) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);

  const result = await db.run(
    'INSERT INTO bob_tokens(token, token_hash, created_at, revoked_at) VALUES(?, ?, unixepoch(), NULL)',
    [token, tokenHash],
  );

  return {
    token,
    tokenId: result?.lastID ?? null,
  };
}

export async function verifyBobToken(db, token) {
  if (!token) {
    return false;
  }

  const tokenHash = hashToken(token);
  const row = await db.get(
    'SELECT id FROM bob_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1',
    [tokenHash],
  );

  return Boolean(row?.id);
}

export async function revokeBobToken(db, tokenId) {
  const id = Number(tokenId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('invalid token id');
  }
  await db.run('UPDATE bob_tokens SET revoked_at = unixepoch() WHERE id = ?', [id]);
  return { ok: true };
}

export async function listBobTokens(db, { includeRevoked = true, limit = 200 } = {}) {
  const n = Number(limit);
  const max = Number.isInteger(n) && n > 0 ? Math.min(500, n) : 200;
  const where = includeRevoked ? '' : 'WHERE revoked_at IS NULL';
  const rows = await db.all(
    `SELECT id, token, created_at, revoked_at FROM bob_tokens ${where} ORDER BY id DESC LIMIT ?`,
    [max],
  );
  return rows || [];
}

export async function deleteBobToken(db, tokenId) {
  const id = Number(tokenId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('invalid token id');
  }

  const row = await db.get('SELECT revoked_at FROM bob_tokens WHERE id = ? LIMIT 1', [id]);
  if (!row) {
    throw new Error('token not found');
  }
  if (!row?.revoked_at) {
    throw new Error('token must be revoked before delete');
  }

  await db.run('DELETE FROM bob_tokens WHERE id = ?', [id]);
  return { ok: true };
}
