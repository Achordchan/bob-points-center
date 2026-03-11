import { ensureAccount } from './ledgerService.js';

const DEFAULT_TIER_OPTIONS = [10, 20, 50, 100];

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeProjectStatus(value) {
  const v = normalizeText(value).toLowerCase();
  if (v === 'active' || v === 'paused' || v === 'archived') return v;
  return 'active';
}

function normalizeExecutionStatus(value) {
  const v = normalizeText(value).toLowerCase();
  if (v === 'pending' || v === 'in_progress' || v === 'completed') return v;
  return 'pending';
}

function parseTierOptions(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[，,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  const nums = Array.from(new Set(source
    .map((x) => toInt(x))
    .filter((x) => Number.isFinite(x) && x > 0)))
    .sort((a, b) => a - b);
  return nums.length ? nums : [...DEFAULT_TIER_OPTIONS];
}

function parseStoredTierOptions(raw) {
  if (Array.isArray(raw)) return parseTierOptions(raw);
  if (raw === null || raw === undefined || raw === '') return [...DEFAULT_TIER_OPTIONS];
  try {
    return parseTierOptions(JSON.parse(String(raw)));
  } catch {
    return parseTierOptions(String(raw));
  }
}

function toProjectPayload(row) {
  const target = Number(row?.target_bob_amount || 0);
  const total = Number(row?.total_bob_amount || 0);
  const donorCount = Number(row?.donor_count || 0);
  const contributionCount = Number(row?.contribution_count || 0);
  const progressPercent = target > 0 ? Math.min(100, Math.floor((total / target) * 100)) : 0;
  return {
    project_id: String(row?.project_id || ''),
    project_name: String(row?.project_name || ''),
    cover_image_url: row?.cover_image_url ? String(row.cover_image_url) : '',
    summary: row?.summary ? String(row.summary) : '',
    rules_text: row?.rules_text ? String(row.rules_text) : '',
    target_bob_amount: target,
    tier_options: parseStoredTierOptions(row?.tier_options_json),
    status: normalizeProjectStatus(row?.status),
    execution_status: normalizeExecutionStatus(row?.execution_status),
    execution_note: row?.execution_note ? String(row.execution_note) : '',
    sort: row?.sort === null || row?.sort === undefined ? null : Number(row.sort),
    created_at: Number(row?.created_at || 0),
    updated_at: Number(row?.updated_at || 0),
    executed_at: row?.executed_at === null || row?.executed_at === undefined ? null : Number(row.executed_at),
    total_bob_amount: total,
    donor_count: donorCount,
    contribution_count: contributionCount,
    progress_percent: progressPercent,
    goal_reached: target > 0 && total >= target,
  };
}

function getProjectSelectSql(whereSql = '') {
  return `SELECT p.project_id, p.project_name, p.cover_image_url, p.summary, p.rules_text,
      p.target_bob_amount, p.tier_options_json, p.status, p.execution_status,
      p.execution_note, p.sort, p.created_at, p.updated_at, p.executed_at,
      COALESCE(s.total_bob_amount, 0) AS total_bob_amount,
      COALESCE(s.donor_count, 0) AS donor_count,
      COALESCE(s.contribution_count, 0) AS contribution_count
    FROM charity_projects p
    LEFT JOIN (
      SELECT project_id,
        COALESCE(SUM(bob_amount), 0) AS total_bob_amount,
        COUNT(DISTINCT userid) AS donor_count,
        COUNT(*) AS contribution_count
      FROM charity_contributions
      GROUP BY project_id
    ) s ON s.project_id = p.project_id
    ${whereSql}
    ORDER BY (p.sort IS NULL), p.sort ASC, p.created_at DESC, p.project_id`;
}

export function normalizeCharityProjectInput(body) {
  const projectId = normalizeText(body?.project_id);
  const projectName = normalizeText(body?.project_name);
  const coverImageUrl = normalizeText(body?.cover_image_url);
  const summary = normalizeText(body?.summary);
  const rulesText = normalizeText(body?.rules_text);
  const targetBobAmount = toInt(body?.target_bob_amount);
  const tierOptions = parseTierOptions(body?.tier_options);
  const status = normalizeProjectStatus(body?.status);
  const executionStatus = normalizeExecutionStatus(body?.execution_status);
  const executionNote = normalizeText(body?.execution_note);
  const sort = body?.sort === null || body?.sort === undefined || String(body?.sort).trim() === '' ? null : toInt(body?.sort);

  if (!projectId) throw new Error('missing project_id');
  if (!projectName) throw new Error('missing project_name');
  if (targetBobAmount === null || targetBobAmount <= 0) throw new Error('target_bob_amount must be positive integer');
  if (!summary) throw new Error('missing summary');
  if (!rulesText) throw new Error('missing rules_text');
  if (!Array.isArray(tierOptions) || tierOptions.length === 0) throw new Error('invalid tier_options');
  if (sort !== null && sort < 0) throw new Error('invalid sort');

  return {
    project_id: projectId,
    project_name: projectName,
    cover_image_url: coverImageUrl,
    summary,
    rules_text: rulesText,
    target_bob_amount: targetBobAmount,
    tier_options_json: JSON.stringify(tierOptions),
    status,
    execution_status: executionStatus,
    execution_note: executionNote,
    sort,
  };
}

export async function listAdminCharityProjects(db) {
  const rows = await db.all(getProjectSelectSql(''));
  return (rows || []).map(toProjectPayload);
}

export async function listMallCharityProjects(db) {
  const rows = await db.all(getProjectSelectSql("WHERE p.status IN ('active', 'paused')"));
  return (rows || []).map(toProjectPayload);
}

export async function saveCharityProject(db, input) {
  const row = normalizeCharityProjectInput(input);
  const exists = await db.get('SELECT id FROM charity_projects WHERE project_id = ? LIMIT 1', [row.project_id]);
  if (exists) {
    await db.run(
      `UPDATE charity_projects
          SET project_name = ?, cover_image_url = ?, summary = ?, rules_text = ?,
              target_bob_amount = ?, tier_options_json = ?, status = ?, execution_status = ?,
              execution_note = ?, sort = ?,
              executed_at = CASE WHEN ? = 'completed' THEN COALESCE(executed_at, unixepoch()) ELSE NULL END,
              updated_at = unixepoch()
        WHERE project_id = ?`,
      [
        row.project_name,
        row.cover_image_url || null,
        row.summary,
        row.rules_text,
        row.target_bob_amount,
        row.tier_options_json,
        row.status,
        row.execution_status,
        row.execution_note || null,
        row.sort,
        row.execution_status,
        row.project_id,
      ],
    );
  } else {
    await db.run(
      `INSERT INTO charity_projects(
        project_id, project_name, cover_image_url, summary, rules_text,
        target_bob_amount, tier_options_json, status, execution_status,
        execution_note, sort, executed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'completed' THEN unixepoch() ELSE NULL END)`,
      [
        row.project_id,
        row.project_name,
        row.cover_image_url || null,
        row.summary,
        row.rules_text,
        row.target_bob_amount,
        row.tier_options_json,
        row.status,
        row.execution_status,
        row.execution_note || null,
        row.sort,
        row.execution_status,
      ],
    );
  }
  const saved = await db.get(`${getProjectSelectSql('WHERE p.project_id = ?')} LIMIT 1`, [row.project_id]);
  return toProjectPayload(saved || row);
}

export async function getCharityProjectDetail(db, { projectId, includePaused = true } = {}) {
  const pid = normalizeText(projectId);
  if (!pid) throw new Error('missing project_id');
  const statuses = includePaused ? ['active', 'paused'] : ['active'];
  const placeholders = statuses.map(() => '?').join(',');
  const row = await db.get(
    `${getProjectSelectSql(`WHERE p.project_id = ? AND p.status IN (${placeholders})`)} LIMIT 1`,
    [pid, ...statuses],
  );
  if (!row) throw new Error('charity project not found');

  const leaderboard = await db.all(
    `SELECT userid,
        COALESCE(MAX(NULLIF(user_name_snapshot, '')), '') AS user_name_snapshot,
        COALESCE(SUM(bob_amount), 0) AS total_bob_amount,
        COUNT(*) AS contribution_count,
        COALESCE(MAX(created_at), 0) AS last_contributed_at
      FROM charity_contributions
      WHERE project_id = ?
      GROUP BY userid
      ORDER BY total_bob_amount DESC, contribution_count DESC, last_contributed_at ASC, userid ASC
      LIMIT 20`,
    [pid],
  );
  const recentContributions = await db.all(
    `SELECT userid, user_name_snapshot, bob_amount, created_at
      FROM charity_contributions
      WHERE project_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 20`,
    [pid],
  );

  return {
    ...toProjectPayload(row),
    leaderboard: (leaderboard || []).map((item, index) => ({
      rank: index + 1,
      userid: String(item?.userid || ''),
      user_name_snapshot: item?.user_name_snapshot ? String(item.user_name_snapshot) : String(item?.userid || ''),
      total_bob_amount: Number(item?.total_bob_amount || 0),
      contribution_count: Number(item?.contribution_count || 0),
      last_contributed_at: Number(item?.last_contributed_at || 0),
    })),
    recent_contributions: (recentContributions || []).map((item) => ({
      userid: String(item?.userid || ''),
      user_name_snapshot: item?.user_name_snapshot ? String(item.user_name_snapshot) : String(item?.userid || ''),
      bob_amount: Number(item?.bob_amount || 0),
      created_at: Number(item?.created_at || 0),
    })),
  };
}

export async function listAdminCharityContributions(db, { projectId = '', limit = 200 } = {}) {
  const max = Math.min(500, Math.max(1, toInt(limit) || 200));
  const pid = normalizeText(projectId);
  const where = pid ? 'WHERE c.project_id = ?' : '';
  const params = pid ? [pid, max] : [max];
  const rows = await db.all(
    `SELECT c.id, c.project_id, c.userid, c.user_name_snapshot, c.bob_amount, c.created_at,
        p.project_name,
        COALESCE(s.total_bob_amount, 0) AS project_total_bob_amount,
        COALESCE(s.donor_count, 0) AS project_donor_count,
        COALESCE(s.contribution_count, 0) AS project_contribution_count
      FROM charity_contributions c
      JOIN charity_projects p ON p.project_id = c.project_id
      LEFT JOIN (
        SELECT project_id,
          COALESCE(SUM(bob_amount), 0) AS total_bob_amount,
          COUNT(DISTINCT userid) AS donor_count,
          COUNT(*) AS contribution_count
        FROM charity_contributions
        GROUP BY project_id
      ) s ON s.project_id = c.project_id
      ${where}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ?`,
    params,
  );

  const summary = pid
    ? await db.get(
      `SELECT COALESCE(SUM(bob_amount), 0) AS total_bob_amount,
          COUNT(DISTINCT userid) AS donor_count,
          COUNT(*) AS contribution_count
        FROM charity_contributions
        WHERE project_id = ?`,
      [pid],
    )
    : null;

  return {
    summary: summary
      ? {
        project_id: pid,
        total_bob_amount: Number(summary?.total_bob_amount || 0),
        donor_count: Number(summary?.donor_count || 0),
        contribution_count: Number(summary?.contribution_count || 0),
      }
      : null,
    rows: (rows || []).map((row) => ({
      id: Number(row?.id || 0),
      project_id: String(row?.project_id || ''),
      project_name: String(row?.project_name || row?.project_id || ''),
      userid: String(row?.userid || ''),
      user_name_snapshot: row?.user_name_snapshot ? String(row.user_name_snapshot) : String(row?.userid || ''),
      bob_amount: Number(row?.bob_amount || 0),
      created_at: Number(row?.created_at || 0),
      project_total_bob_amount: Number(row?.project_total_bob_amount || 0),
      project_donor_count: Number(row?.project_donor_count || 0),
      project_contribution_count: Number(row?.project_contribution_count || 0),
    })),
  };
}

export async function contributeToCharity(db, { projectId, userid, userName, bobAmount } = {}) {
  const pid = normalizeText(projectId);
  const uid = normalizeText(userid);
  const amount = toInt(bobAmount);
  const userNameSnapshot = normalizeText(userName);
  if (!pid) throw new Error('missing project_id');
  if (!uid) throw new Error('missing userid');
  if (amount === null || amount <= 0) throw new Error('invalid bob_amount');

  return await db.transaction(async (tx) => {
    const project = await tx.get('SELECT * FROM charity_projects WHERE project_id = ? LIMIT 1 FOR UPDATE', [pid]);
    if (!project) throw new Error('charity project not found');
    if (normalizeProjectStatus(project?.status) !== 'active') throw new Error('charity project not active');
    const tierOptions = parseStoredTierOptions(project?.tier_options_json);
    if (!tierOptions.includes(amount)) throw new Error('invalid charity tier');

    await ensureAccount(tx, { userid: uid, name: userNameSnapshot || uid });
    const account = await tx.get('SELECT balance FROM accounts WHERE userid = ? LIMIT 1 FOR UPDATE', [uid]);
    const balance = Number(account?.balance || 0);
    if (balance < amount) throw new Error('insufficient balance');

    await tx.run('INSERT INTO charity_contributions(project_id, userid, user_name_snapshot, bob_amount, created_at) VALUES(?, ?, ?, ?, unixepoch())', [
      pid,
      uid,
      userNameSnapshot || uid,
      amount,
    ]);
    await tx.run('INSERT INTO ledger(userid, delta, reason, ref_id) VALUES(?, ?, ?, ?)', [
      uid,
      -amount,
      `公益助力：${String(project?.project_name || pid)}`,
      pid,
    ]);
    await tx.run('UPDATE accounts SET balance = balance - ?, updated_at = unixepoch() WHERE userid = ?', [amount, uid]);

    const detail = await getCharityProjectDetail(tx, { projectId: pid, includePaused: true });
    const nextAccount = await tx.get('SELECT balance FROM accounts WHERE userid = ? LIMIT 1', [uid]);
    return {
      ok: true,
      project: detail,
      balance: Number(nextAccount?.balance || 0),
      contributed_bob_amount: amount,
    };
  });
}
