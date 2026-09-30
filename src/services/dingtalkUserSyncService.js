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
  const snapshotVersion = beginUserSnapshot();
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

  // 逐个员工加锁写入；采集开始之后有事件到达的员工，其快照已过期，跳过以免覆盖更新的数据。
  let upserted = 0;
  for (const u of users.values()) {
    // eslint-disable-next-line no-await-in-loop
    const written = await withUserLock(u.userid, async () => {
      if (isSuperseded(u.userid, snapshotVersion)) return false;
      await inTransaction(db, (tx) => upsertDingtalkUserProfile(tx, u));
      commitVersion(u.userid, snapshotVersion);
      // 本地资料已被这份快照替换，getUserProfile 里可能残留的旧缓存/进行中请求一并作废。
      invalidateUserProfileCache(u.userid);
      return true;
    });
    if (written) upserted += 1;
  }

  if (users.size > 0) {
    publishMallRealtimeEvent('balance_changed', { reason: 'users_sync' });
    publishMallRealtimeEvent('charity_changed', { reason: 'users_sync' });
  }

  return { deptCount: deptIds.length, fetched, active: activeCount, upserted };
}

// 同一员工的写操作按到达顺序串行：Stream 事件是并发处理的，
// 否则慢的“资料修改”可能在“离职”之后才写库，把 active 改回 1。
const userLocks = new Map();
function withUserLock(userid, fn) {
  const key = String(userid);
  const previous = userLocks.get(key) || Promise.resolve();
  const run = previous.then(fn);
  const tail = run.catch(() => {});
  userLocks.set(key, tail);
  tail.then(() => {
    if (userLocks.get(key) === tail) userLocks.delete(key);
  });
  return run;
}

// 版本：每个通讯录事件在到达的那一刻（早于任何 await）给该员工打一个递增版本号；
// 每次成功写库的快照也把自己的版本记为该员工的最新版本。
// 凡是从钉钉取到的快照（全量同步、登录/打卡写回、事件自己的拉取），写库前都要确认
// “取数开始之后，没有更新的事件到达，也没有更晚取数的快照已经写库”，否则丢弃。
// 版本号只增不清理（只包含有过写入/事件的员工，体量有限），因此重叠的全量同步、
// 尚无本地资料行的员工（首次登录）都不会丢失“已离职/已变更”的信息。
let versionCounter = 0;
const userLatestVersion = new Map();

// 取数（发起钉钉请求）之前调用，返回的版本号随快照一起交给写库函数。
export function beginUserSnapshot() {
  versionCounter += 1;
  return versionCounter;
}

function noteUserEvent(userid) {
  versionCounter += 1;
  userLatestVersion.set(String(userid), versionCounter);
  // 该员工缓存里、进行中请求里的资料都可能是变更前的，一并作废。
  invalidateUserProfileCache(userid);
  return versionCounter;
}

function isSuperseded(userid, snapshotVersion) {
  return (userLatestVersion.get(String(userid)) || 0) > snapshotVersion;
}

// 调用方在取数前用 beginUserSnapshot() 拿版本，取数后用它判断“取数期间是否有更新的事件到达”。
// 与是否写库无关：缓存命中/合并到他人请求的调用者同样需要判断。
export function isUserSnapshotSuperseded(userid, snapshotVersion) {
  return isSuperseded(userid, snapshotVersion);
}

function commitVersion(userid, snapshotVersion) {
  const key = String(userid);
  if ((userLatestVersion.get(key) || 0) < snapshotVersion) userLatestVersion.set(key, snapshotVersion);
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
// snapshotVersion：调用方在取数前用 beginUserSnapshot() 拿到的版本号，取数期间有新事件到达则丢弃本次写入。
export async function persistDingtalkUserDetail(db, cfg, raw, options = {}) {
  const userid = firstPresent(raw?.userid);
  if (!userid) return { ok: false, reason: 'missing_userid' };
  return withUserLock(userid, () => persistDetailUnlocked(db, cfg, raw, options));
}

async function persistDetailUnlocked(db, cfg, raw, { onlyIfStale = false, snapshotVersion } = {}) {
  const userid = firstPresent(raw?.userid);
  if (snapshotVersion !== undefined && isSuperseded(userid, snapshotVersion)) {
    return { ok: true, skipped: true, reason: 'superseded' };
  }

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
  // 补查部门名称期间可能有新事件到达，落库前再确认一次。
  if (snapshotVersion !== undefined && isSuperseded(userid, snapshotVersion)) {
    return { ok: true, skipped: true, reason: 'superseded' };
  }
  await inTransaction(db, (tx) => upsertDingtalkUserProfile(tx, profile));
  if (snapshotVersion !== undefined) commitVersion(userid, snapshotVersion);
  return { ok: true, userid };
}

// 注意：这两个函数在第一个 await 之前就完成“打版本号 + 入队”，保证事件按到达顺序排队。
export function syncDingtalkUserById(db, cfg, userid, { eventVersion } = {}) {
  const version = eventVersion ?? noteUserEvent(userid);
  // 拿锁之后再请求钉钉，读到的是前序事件处理完之后的最新状态。
  return withUserLock(userid, async () => {
    // 已有更新的事件排在后面，它会自己取数写库，这里不必重复请求。
    if (isSuperseded(userid, version)) return { ok: true, skipped: true, reason: 'superseded' };
    invalidateUserProfileCache(userid);
    const raw = await getUserDetail(cfg, userid);
    return persistDetailUnlocked(db, cfg, raw, { snapshotVersion: version });
  });
}

// 离职只标记为停用，保留 users/accounts（BOB 币余额与流水不能丢）。
export function markDingtalkUserLeft(db, userid, { eventVersion } = {}) {
  if (eventVersion === undefined) noteUserEvent(userid);
  return withUserLock(userid, () => db.run(
    'UPDATE user_dingtalk_profiles SET active = 0, updated_at = unixepoch() WHERE userid = ?',
    [String(userid)],
  ));
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

const EVENT_RETRY_DELAYS_MS = [2000, 10000, 60000];

// 事件处理失败（如数据库瞬时故障）时有限次重试。Stream 已经确认过该事件，钉钉不会重推。
// 重试前若同一员工已有更新的事件到达，则放弃：更新的事件会自己处理，旧的离职不能再把重新入职的人停用。
// 仅在进程内重试，进程重启会丢失。
async function runWithRetry(op, userid, eventVersion, delaysMs, firstErr) {
  let lastErr = firstErr;
  for (const delay of delaysMs) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (isSuperseded(userid, eventVersion)) throw lastErr;
    try {
      // eslint-disable-next-line no-await-in-loop
      return await op();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function handleContactUserEvent(db, cfg, { topic, data, retryDelaysMs = EVENT_RETRY_DELAYS_MS } = {}) {
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
  // 先给同一批里的所有员工同步打版本号并入队，再统一等待：
  // 批内某个员工的慢请求不能让后到的事件（如重新入职）抢在同批其他员工的处理之前。
  const tasks = ids.map((userid) => {
    const eventVersion = noteUserEvent(userid);
    // 第一次尝试同步入队（保证按到达顺序）；只有失败后才进入重试。
    const first = topic === 'user_leave_org'
      ? markDingtalkUserLeft(db, userid, { eventVersion }).then(() => '已标记停用')
      : syncDingtalkUserById(db, cfg, userid, { eventVersion })
        .then((out) => (out?.skipped ? `已跳过(${out.reason})` : '资料已更新'));
    const task = first.catch((firstErr) => {
      if (retryDelaysMs.length === 0 || isSuperseded(userid, eventVersion)) throw firstErr;
      // eslint-disable-next-line no-console
      console.warn(`[DingtalkUserSync] ${topic} ${userid} 处理失败，将重试:`, firstErr?.message || firstErr);
      return runWithRetry(
        () => (topic === 'user_leave_org'
          ? markDingtalkUserLeft(db, userid, { eventVersion }).then(() => '已标记停用')
          : syncDingtalkUserById(db, cfg, userid, { eventVersion })
            .then((out) => (out?.skipped ? `已跳过(${out.reason})` : '资料已更新'))),
        userid,
        eventVersion,
        retryDelaysMs,
        firstErr,
      );
    });
    return task
      .then((result) => {
        // eslint-disable-next-line no-console
        console.log(`[DingtalkUserSync] ${topic} ${userid} ${result}`);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[DingtalkUserSync] ${topic} ${userid} failed:`, err?.message || err);
      });
  });
  await Promise.all(tasks);
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
