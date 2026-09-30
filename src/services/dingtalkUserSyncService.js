import {
  getRootDepartmentProfile,
  getUserDetail,
  invalidateUserProfileCache,
  listSubDepartments,
  listUsersByDept,
} from './dingtalkService.js';
import { ensureAccount } from './ledgerService.js';
import { publishMallRealtimeEvent } from './mallRealtimeService.js';

export function isActiveFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function firstPresent(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

export function toJsonText(value) {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeDingtalkDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 100000000000 ? Math.floor(n / 1000) : Math.floor(n);
}

export function normalizeDingtalkUserProfile(raw = {}, deptNameMap = new Map()) {
  const deptIds = Array.isArray(raw.dept_id_list) ? raw.dept_id_list.map((id) => String(id)).filter(Boolean) : [];
  const deptNames = deptIds.map((id) => deptNameMap.get(id) || '').filter(Boolean);
  return {
    userid: firstPresent(raw.userid),
    unionid: firstPresent(raw.unionid),
    name: firstPresent(raw.name),
    avatar: firstPresent(raw.avatar),
    mobile: firstPresent(raw.mobile),
    telephone: firstPresent(raw.telephone),
    email: firstPresent(raw.email),
    org_email: firstPresent(raw.org_email),
    title: firstPresent(raw.title),
    job_number: firstPresent(raw.job_number, raw.jobNumber),
    work_place: firstPresent(raw.work_place, raw.workPlace),
    remark: firstPresent(raw.remark),
    dept_ids: deptIds,
    dept_names: deptNames,
    extension: raw.extension || null,
    hired_date: normalizeDingtalkDate(raw.hired_date),
    active: isActiveFlag(raw.active) ? 1 : 0,
    is_admin: isActiveFlag(raw.admin) ? 1 : 0,
    is_boss: isActiveFlag(raw.boss) ? 1 : 0,
    leader_in_dept: raw.leader_in_dept || null,
    exclusive_account: isActiveFlag(raw.exclusive_account) ? 1 : 0,
    raw,
  };
}

export async function listDingtalkDepartmentsTree(cfg) {
  const seen = new Set();
  const queue = [{ deptId: 1, depth: 0 }];
  const out = [];
  while (queue.length) {
    const item = queue.shift();
    const deptId = Number(item.deptId);
    if (!Number.isFinite(deptId) || seen.has(deptId)) continue;
    seen.add(deptId);
    const subs = await listSubDepartments(cfg, { deptId });
    for (const dept of subs) {
      const id = Number(dept?.dept_id);
      if (!Number.isFinite(id)) continue;
      out.push({
        dept_id: String(id),
        name: dept?.name ? String(dept.name) : String(id),
        parent_id: String(deptId),
        depth: Number(item.depth || 0),
      });
      queue.push({ deptId: id, depth: Number(item.depth || 0) + 1 });
    }
  }
  return out;
}

function inTransaction(db, fn) {
  return typeof db?.transaction === 'function' ? db.transaction(fn) : fn(db);
}

// 写入/更新 users、accounts 与 user_dingtalk_profiles；全量同步、通讯录事件、登录/打卡回写共用。
export async function upsertDingtalkUserProfile(tx, u) {
  await ensureAccount(tx, { userid: u.userid, name: u.name });
  await tx.exec(
    `INSERT INTO user_dingtalk_profiles(
      userid, unionid, name, avatar, mobile, telephone, email, org_email, title, job_number, work_place, remark,
      dept_ids, dept_names, extension, hired_date, active, is_admin, is_boss, leader_in_dept, exclusive_account, raw, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(userid) DO UPDATE SET
      unionid = EXCLUDED.unionid,
      name = EXCLUDED.name,
      avatar = EXCLUDED.avatar,
      mobile = EXCLUDED.mobile,
      telephone = EXCLUDED.telephone,
      email = EXCLUDED.email,
      org_email = EXCLUDED.org_email,
      title = EXCLUDED.title,
      job_number = EXCLUDED.job_number,
      work_place = EXCLUDED.work_place,
      remark = EXCLUDED.remark,
      dept_ids = EXCLUDED.dept_ids,
      dept_names = EXCLUDED.dept_names,
      extension = EXCLUDED.extension,
      hired_date = EXCLUDED.hired_date,
      active = EXCLUDED.active,
      is_admin = EXCLUDED.is_admin,
      is_boss = EXCLUDED.is_boss,
      leader_in_dept = EXCLUDED.leader_in_dept,
      exclusive_account = EXCLUDED.exclusive_account,
      raw = EXCLUDED.raw,
      updated_at = EXCLUDED.updated_at`,
    [
      u.userid, u.unionid, u.name, u.avatar, u.mobile, u.telephone, u.email, u.org_email, u.title, u.job_number, u.work_place, u.remark,
      toJsonText(u.dept_ids), toJsonText(u.dept_names), toJsonText(u.extension), u.hired_date, u.active, u.is_admin, u.is_boss,
      toJsonText(u.leader_in_dept), u.exclusive_account, toJsonText(u.raw),
    ],
  );
}

export async function syncAllDingtalkUsers(db, cfg) {
  const departments = await listDingtalkDepartmentsTree(cfg);
  const deptNameMap = new Map(departments.map((dept) => [String(dept.dept_id), String(dept.name || dept.dept_id)]));
  deptNameMap.set('1', '根部门');
  const deptIds = ['1', ...departments.map((dept) => String(dept.dept_id))];
  const users = new Map();

  let fetched = 0;
  let activeCount = 0;

  for (const deptId of deptIds) {
    let cursor = 0;
    for (;;) {
      const page = await listUsersByDept(cfg, { deptId, cursor, size: 100 });
      cursor = page.nextCursor;

      for (const u of page.list) {
        fetched += 1;
        const userid = u?.userid ? String(u.userid) : '';
        if (!userid) continue;
        if (!isActiveFlag(u?.active)) continue;
        activeCount += 1;

        const profile = normalizeDingtalkUserProfile(u, deptNameMap);
        const existing = users.get(userid);
        if (!existing) {
          users.set(userid, profile);
        } else {
          const deptSet = new Set([...(existing.dept_ids || []), ...(profile.dept_ids || [])]);
          const dept_ids = [...deptSet];
          users.set(userid, {
            ...existing,
            ...Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== '' && value !== null && value !== undefined)),
            dept_ids,
            dept_names: dept_ids.map((id) => deptNameMap.get(id) || '').filter(Boolean),
          });
        }
      }

      if (!page.hasMore) break;
    }
  }

  await inTransaction(db, async (tx) => {
    for (const u of users.values()) {
      await upsertDingtalkUserProfile(tx, u);
    }
  });
  if (users.size > 0) {
    publishMallRealtimeEvent('balance_changed', { reason: 'users_sync' });
    publishMallRealtimeEvent('charity_changed', { reason: 'users_sync' });
  }

  return { deptCount: deptIds.length, fetched, active: activeCount, upserted: users.size };
}

const PROFILE_FRESH_MS = 24 * 60 * 60 * 1000;
const deptNameCache = new Map();
const DEPT_NAME_CACHE_MS = 60 * 60 * 1000;

async function resolveDeptName(cfg, deptId) {
  const id = String(deptId);
  if (id === '1') return '根部门';
  const cached = deptNameCache.get(id);
  if (cached && Date.now() < cached.expiresAt) return cached.name;
  try {
    const dept = await getRootDepartmentProfile(cfg, { deptId: Number(id) });
    const name = firstPresent(dept?.name, dept?.dept_name);
    if (name) deptNameCache.set(id, { name, expiresAt: Date.now() + DEPT_NAME_CACHE_MS });
    return name;
  } catch {
    return '';
  }
}

function parseIdList(text) {
  try {
    const parsed = JSON.parse(String(text || '[]'));
    return Array.isArray(parsed) ? parsed.map((id) => String(id)) : [];
  } catch {
    return [];
  }
}

// 把已经从钉钉取到的 user/get 原始资料写回本地库（新人首次登录、打卡取到资料时顺手落库，无需再请求一次）。
// 部门名称：部门未变则沿用本地已有名称；部门变了才补查变化的部门。
// onlyIfStale：本地资料 24 小时内已更新过则不重复写库（登录这类高频入口使用）。
export async function persistDingtalkUserDetail(db, cfg, raw, { onlyIfStale = false } = {}) {
  const userid = firstPresent(raw?.userid);
  if (!userid) return { ok: false, reason: 'missing_userid' };

  const existing = await db.get(
    'SELECT dept_ids, dept_names, updated_at FROM user_dingtalk_profiles WHERE userid = ? LIMIT 1',
    [userid],
  );
  if (onlyIfStale && existing) {
    const updatedAt = Number(existing.updated_at) || 0;
    const updatedMs = updatedAt > 1e12 ? updatedAt : updatedAt * 1000;
    if (updatedMs > 0 && Date.now() - updatedMs < PROFILE_FRESH_MS) return { ok: true, skipped: true, reason: 'fresh' };
  }
  if (!existing && !isActiveFlag(raw?.active)) return { ok: true, skipped: true, reason: 'inactive' };

  const deptIds = Array.isArray(raw?.dept_id_list) ? raw.dept_id_list.map((id) => String(id)).filter(Boolean) : [];
  const deptNameMap = new Map();
  const oldIds = existing ? parseIdList(existing.dept_ids) : [];
  const oldNames = existing ? parseIdList(existing.dept_names) : [];
  const unchanged = existing && oldIds.length === deptIds.length && oldIds.every((id, i) => id === deptIds[i]);
  if (unchanged && oldNames.length === deptIds.length) {
    deptIds.forEach((id, i) => deptNameMap.set(id, oldNames[i]));
  } else {
    for (const id of deptIds) {
      // eslint-disable-next-line no-await-in-loop
      const name = await resolveDeptName(cfg, id);
      if (name) deptNameMap.set(id, name);
    }
  }

  const profile = normalizeDingtalkUserProfile(raw, deptNameMap);
  await inTransaction(db, (tx) => upsertDingtalkUserProfile(tx, profile));
  return { ok: true, userid };
}

export async function syncDingtalkUserById(db, cfg, userid) {
  invalidateUserProfileCache(userid);
  const raw = await getUserDetail(cfg, userid);
  return persistDingtalkUserDetail(db, cfg, raw);
}

// 离职只标记为停用，保留 users/accounts（BOB 币余额与流水不能丢）。
export async function markDingtalkUserLeft(db, userid) {
  await db.run(
    'UPDATE user_dingtalk_profiles SET active = 0, updated_at = unixepoch() WHERE userid = ?',
    [String(userid)],
  );
}

export function extractEventUserIds(data) {
  let parsed = data;
  if (typeof data === 'string') {
    try { parsed = JSON.parse(data); } catch { return []; }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const key = Object.keys(parsed).find((k) => /^user_?ids?$/i.test(k));
  const value = key ? parsed[key] : null;
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(list.map((id) => String(id || '').trim()).filter(Boolean))];
}

export const DINGTALK_CONTACT_USER_EVENTS = ['user_add_org', 'user_modify_org', 'user_active_org', 'user_leave_org'];
export const DINGTALK_CONTACT_DEPT_EVENTS = ['org_dept_create', 'org_dept_modify', 'org_dept_remove'];

export async function handleContactUserEvent(db, cfg, { topic, data } = {}) {
  const ids = extractEventUserIds(data);
  if (ids.length === 0) {
    // 解析不到 userId 时保留原始内容，便于核对钉钉实际推送的字段格式。
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    // eslint-disable-next-line no-console
    console.warn(`[DingtalkUserSync] ${topic} 未解析到 userId data=${String(raw || '').slice(0, 300)}`);
    return { count: 0 };
  }
  // eslint-disable-next-line no-console
  console.log(`[DingtalkUserSync] 收到通讯录事件 ${topic} users=${ids.length}`);
  for (const userid of ids) {
    try {
      if (topic === 'user_leave_org') {
        // eslint-disable-next-line no-await-in-loop
        await markDingtalkUserLeft(db, userid);
        // eslint-disable-next-line no-console
        console.log(`[DingtalkUserSync] ${topic} ${userid} 已标记停用`);
      } else {
        // eslint-disable-next-line no-await-in-loop
        const out = await syncDingtalkUserById(db, cfg, userid);
        // eslint-disable-next-line no-console
        console.log(`[DingtalkUserSync] ${topic} ${userid} ${out?.skipped ? `已跳过(${out.reason})` : '资料已更新'}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[DingtalkUserSync] ${topic} ${userid} failed:`, err?.message || err);
    }
  }
  return { count: ids.length };
}

// 每周一凌晨 3:30–4:00（北京时间）全量同步一次，作为事件遗漏时的兜底。
const WEEKLY_SYNC_START_MIN = 3 * 60 + 30;
const WEEKLY_SYNC_END_MIN = 4 * 60;
const WEEKLY_SYNC_MAX_ATTEMPTS = 2;

export function getCstNow(nowMs = Date.now()) {
  const d = new Date(nowMs + 8 * 3600 * 1000);
  return {
    date: d.toISOString().slice(0, 10),
    weekday: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

export function isWeeklySyncDue(now, attempts = new Map()) {
  if (Number(now?.weekday) !== 1) return false;
  if (!(now.minutes >= WEEKLY_SYNC_START_MIN && now.minutes < WEEKLY_SYNC_END_MIN)) return false;
  return (attempts.get(now.date) || 0) < WEEKLY_SYNC_MAX_ATTEMPTS;
}

export function startDingtalkUserSyncScheduler({ db, cfg } = {}) {
  const attempts = new Map();
  let inFlight = false;
  async function tick() {
    if (inFlight) return;
    const now = getCstNow();
    if (!isWeeklySyncDue(now, attempts)) return;
    inFlight = true;
    attempts.set(now.date, (attempts.get(now.date) || 0) + 1);
    try {
      const result = await syncAllDingtalkUsers(db, cfg);
      attempts.set(now.date, WEEKLY_SYNC_MAX_ATTEMPTS);
      // eslint-disable-next-line no-console
      console.log('[DingtalkUserSync] weekly sync done', JSON.stringify(result));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[DingtalkUserSync] weekly sync failed:', err?.message || err);
    } finally {
      inFlight = false;
    }
  }
  setInterval(tick, 10 * 60 * 1000);
}
