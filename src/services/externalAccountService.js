/**
 * 对外活动外部账号：真实姓名 + 手机号 + 密码。
 *
 * 设计要点：
 * - userid 使用 ext_ 前缀，与钉钉 userid 命名空间隔离；业务数据仍走 users/accounts/ledger，
 *   因此商城、核销、拍卖、红包等模块无需感知账号来源。
 * - 手机号是唯一登录标识（users.phone 唯一索引），姓名仅作展示与现场核销核对。
 * - 密码允许弱口令（活动场景），安全边界依靠「手机号唯一 + 注册开关 + 失败锁定 + 活动后清理」。
 * - 连续失败 MAX_FAILED_ATTEMPTS 次锁定 LOCK_DURATION_SECONDS 秒，防止在线暴力破解。
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const EXTERNAL_USERID_PREFIX = 'ext_';
export const EXTERNAL_SOURCE = 'external';
export const DINGTALK_SOURCE = 'dingtalk';
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_DURATION_SECONDS = 600;
export const MIN_PASSWORD_LENGTH = 3;
export const MAX_PASSWORD_LENGTH = 64;
export const MAX_NAME_LENGTH = 20;
export const DEFAULT_BATCH_ID = 'default';

const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 });
const SCRYPT_ALGO = 'scrypt';
const HASH_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]*)$/;
const PHONE_PATTERN = /^1[3-9]\d{9}$/;
// 中文姓名、少数民族姓名分隔符、拉丁字母均放行；禁止控制字符与数字串。
const NAME_PATTERN = /^[\u3400-\u4dbf\u4e00-\u9fa5A-Za-z][\u3400-\u4dbf\u4e00-\u9fa5A-Za-z·．.\-\s]*$/u;

export class ExternalAuthError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'ExternalAuthError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export function isExternalUserid(userid) {
  return String(userid || '').trim().startsWith(EXTERNAL_USERID_PREFIX);
}

export function isUniqueViolation(err) {
  return String(err?.code || '') === '23505';
}

function isForeignKeyViolation(err) {
  return String(err?.code || '') === '23503';
}

/**
 * 归一化手机号：去空格、连字符、括号，去掉 +86 / 86 国际前缀。
 * 仅支持中国大陆手机号，返回空字符串表示不合法。
 */
export function normalizePhone(value) {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (!raw) return '';
  let digits = raw.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('86') && digits.length === 13) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return '';
  return PHONE_PATTERN.test(digits) ? digits : '';
}

export function normalizeRealName(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  // 折叠内部连续空白，去掉首尾空白与控制字符
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[·．]\s*/g, '·')
    .trim();
}

export function isValidRealName(name) {
  const text = String(name || '');
  if (text.length < 2 || text.length > MAX_NAME_LENGTH) return false;
  return NAME_PATTERN.test(text);
}

export function isValidPassword(password) {
  const text = password === null || password === undefined ? '' : String(password);
  return text.length >= MIN_PASSWORD_LENGTH && text.length <= MAX_PASSWORD_LENGTH;
}

function encodeParams() {
  return { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p };
}

export async function hashPassword(password, { salt } = {}) {
  const text = String(password ?? '');
  const saltBuf = salt ? Buffer.from(String(salt), 'base64') : crypto.randomBytes(16);
  const { N, r, p } = encodeParams();
  const derived = await scrypt(text, saltBuf, SCRYPT_PARAMS.keylen, { N, r, p });
  return {
    hash: `${SCRYPT_ALGO}$${N}$${r}$${p}$${Buffer.from(derived).toString('base64')}`,
    salt: saltBuf.toString('base64'),
  };
}

export async function verifyPasswordHash(password, { hash, salt } = {}) {
  const stored = String(hash || '');
  const saltText = String(salt || '');
  const match = HASH_PATTERN.exec(stored);
  if (!match || !saltText) return false;

  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  const expected = Buffer.from(match[4], 'base64');
  if (!expected.length) return false;
  // 只接受本服务生成的参数范围，避免被构造的超大参数拖垮进程。
  if (N !== SCRYPT_PARAMS.N || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p) return false;

  let derived;
  try {
    derived = await scrypt(String(password ?? ''), Buffer.from(saltText, 'base64'), expected.length, { N, r, p });
  } catch {
    return false;
  }
  const actual = Buffer.from(derived);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function generateExternalUserid() {
  return `${EXTERNAL_USERID_PREFIX}${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * 该手机号是否属于钉钉在册员工（user_dingtalk_profiles.active = 1）。
 * 命中时不允许注册外部账号，前端引导改用钉钉登录，避免同一个人出现两套账号。
 * 手机号格式不统一（可能带 +86 / 空格 / 座机分机），统一取末 11 位数字比较。
 * 离职（active = 0）员工不再受此限制：他们已无法走钉钉登录，可正常注册外部账号。
 */
export async function findActiveDingtalkUserByPhone(db, phone) {
  const phoneNumber = normalizePhone(phone);
  if (!phoneNumber) return null;
  const row = await db.get(
    `SELECT p.userid, COALESCE(p.name, '') AS name
       FROM user_dingtalk_profiles p
      WHERE COALESCE(p.active, 0) = 1
        AND (
          right(regexp_replace(COALESCE(p.mobile, ''), '\\D', '', 'g'), 11) = ?
          OR right(regexp_replace(COALESCE(p.telephone, ''), '\\D', '', 'g'), 11) = ?
        )
      LIMIT 1`,
    [phoneNumber, phoneNumber],
  );
  if (!row?.userid) return null;
  return { userid: String(row.userid), name: String(row.name || '') };
}

function normalizeBatchId(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return (text || DEFAULT_BATCH_ID).slice(0, 64);
}

/**
 * 注册外部账号。失败抛 ExternalAuthError（invalid_phone / invalid_name / weak_password / phone_registered）。
 * 事务内同时写入 users / accounts / external_accounts，保证三者一致。
 */
export async function registerExternalAccount(db, { name, phone, password, batchId } = {}) {
  const phoneNumber = normalizePhone(phone);
  if (!phoneNumber) {
    throw new ExternalAuthError('invalid_phone', '请输入正确的手机号');
  }
  const realName = normalizeRealName(name);
  if (!isValidRealName(realName)) {
    throw new ExternalAuthError('invalid_name', '请输入 2-20 位真实姓名');
  }
  if (!isValidPassword(password)) {
    throw new ExternalAuthError('weak_password', `密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`);
  }

  const existing = await db.get('SELECT userid FROM external_accounts WHERE phone = ? LIMIT 1', [phoneNumber]);
  if (existing) {
    throw new ExternalAuthError('phone_registered', '该手机号已注册，请直接登录');
  }

  // 命中钉钉在册员工时不再创建第二套账号，交由前端引导到钉钉登录。
  const dingtalkUser = await findActiveDingtalkUserByPhone(db, phoneNumber);
  if (dingtalkUser) {
    throw new ExternalAuthError('phone_is_dingtalk_user', '该手机号已绑定企业钉钉账号，请使用钉钉登录', {
      dingtalk_userid: dingtalkUser.userid,
    });
  }

  const credentials = await hashPassword(password);
  const batch = normalizeBatchId(batchId);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const userid = generateExternalUserid();
    try {
      await db.transaction(async (tx) => {
        await tx.run(
          'INSERT INTO users(userid, name, source, phone) VALUES(?, ?, ?, ?)',
          [userid, realName, EXTERNAL_SOURCE, phoneNumber],
        );
        await tx.run(
          'INSERT INTO accounts(userid, balance, updated_at) VALUES(?, 0, unixepoch())',
          [userid],
        );
        await tx.run(
          `INSERT INTO external_accounts(userid, phone, name, password_hash, password_salt, batch_id)
           VALUES(?, ?, ?, ?, ?, ?)`,
          [userid, phoneNumber, realName, credentials.hash, credentials.salt, batch],
        );
      });
      return { userid, name: realName, phone: phoneNumber, batch_id: batch };
    } catch (err) {
      if (isUniqueViolation(err) || isForeignKeyViolation(err)) {
        const duplicated = await db.get('SELECT userid FROM users WHERE phone = ? LIMIT 1', [phoneNumber]);
        if (duplicated) {
          throw new ExternalAuthError('phone_registered', '该手机号已注册，请直接登录');
        }
        // 否则视为 userid 随机碰撞，换一个重试
        continue;
      }
      throw err;
    }
  }
  throw new ExternalAuthError('register_failed', '注册失败，请稍后重试');
}

const LOGIN_LOCKS = new Map();

/**
 * 按账号串行化「锁定检查 + 密码校验 + 失败计数写入」。
 * 否则 N 个并发错误尝试会读到同一个 failed_count 再各自写回，计数丢失（20 次并发可能只记 1 次），
 * 相当于把「5 次失败锁定」放大成任意次在线爆破。
 * 与 middleware/rateLimit.js 一致，是进程内锁：当前为单进程部署，若将来多进程，
 * 失败计数仍由单条原子 UPDATE（CASE WHEN 自增）保证不丢更新。
 */
async function withLoginLock(key, fn) {
  const previous = LOGIN_LOCKS.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  LOGIN_LOCKS.set(key, tail);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (LOGIN_LOCKS.get(key) === tail) LOGIN_LOCKS.delete(key);
  }
}

/**
 * 校验手机号 + 密码。失败抛 ExternalAuthError
 * （invalid_credentials / account_locked / account_disabled）。
 */
export async function authenticateExternalAccount(db, { phone, password } = {}) {
  const phoneNumber = normalizePhone(phone);
  return await withLoginLock(`ext-login:${phoneNumber || 'invalid'}`, async () => {
    const now = Math.floor(Date.now() / 1000);

    const row = phoneNumber
      ? await db.get(
        `SELECT userid, phone, name, password_hash, password_salt, status, failed_count, locked_until
           FROM external_accounts
          WHERE phone = ?
          LIMIT 1`,
        [phoneNumber],
      )
      : null;

    if (!row) {
      // 未注册过的手机号：若属于钉钉在册员工，直接引导到钉钉登录。
      const dingtalkUser = await findActiveDingtalkUserByPhone(db, phoneNumber);
      // 抹平「手机号不存在」与「密码错误」的耗时差异，避免账号枚举。
      await hashPassword(String(password ?? ''));
      if (dingtalkUser) {
        throw new ExternalAuthError('phone_is_dingtalk_user', '该手机号已绑定企业钉钉账号，请使用钉钉登录', {
          dingtalk_userid: dingtalkUser.userid,
        });
      }
      throw new ExternalAuthError('invalid_credentials', '手机号或密码错误');
    }

    if (String(row.status || 'active') !== 'active') {
      throw new ExternalAuthError('account_disabled', '账号已停用，请联系现场工作人员');
    }

    const lockedUntil = Number(row.locked_until || 0);
    if (lockedUntil > now) {
      throw new ExternalAuthError('account_locked', '密码错误次数过多，请稍后再试', {
        retry_after: lockedUntil - now,
      });
    }

    const ok = await verifyPasswordHash(password, { hash: row.password_hash, salt: row.password_salt });
    if (!ok) {
      // 单条原子 UPDATE：并发下也不会丢计数（不能先读 failed_count 再写回）。
      const locked = await db.get(
        `UPDATE external_accounts
            SET failed_count = CASE WHEN failed_count + 1 >= ? THEN 0 ELSE failed_count + 1 END,
                locked_until = CASE WHEN failed_count + 1 >= ? THEN ? ELSE locked_until END,
                updated_at = unixepoch()
          WHERE userid = ?
          RETURNING locked_until`,
        [MAX_FAILED_ATTEMPTS, MAX_FAILED_ATTEMPTS, now + LOCK_DURATION_SECONDS, String(row.userid)],
      );
      if (Number(locked?.locked_until || 0) > now) {
        throw new ExternalAuthError('account_locked', '密码错误次数过多，请稍后再试', {
          retry_after: LOCK_DURATION_SECONDS,
        });
      }
      throw new ExternalAuthError('invalid_credentials', '手机号或密码错误');
    }

    await db.run(
      'UPDATE external_accounts SET failed_count = 0, locked_until = NULL, last_login_at = ?, updated_at = unixepoch() WHERE userid = ?',
      [now, String(row.userid)],
    );

    return { userid: String(row.userid), name: String(row.name || ''), phone: String(row.phone || '') };
  });
}
