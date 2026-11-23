// Auto-split from admin.js — backupRoutes.js
import { requireAdminSession } from '../../middleware/requireAdminSession.js';
import {
  ADMIN_PERMISSION_CATALOG,
  adminAccessMiddleware,
  getAdminAccess,
  hasAdminPermission,
  isSuperAdminSession,
  lockAdminAccountProtection,
  normalizePermissions,
  serializeRole,
} from '../../services/adminPermissionService.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAdminSessionPayload,
  publishMallRealtimeFullRefresh,
  runInTransaction,
  toOptionalInt,
  toPositiveInt,
} from './shared.js';
import { computeAnnouncementContentHash } from '../../services/announcementAccessService.js';

// 年会表按外键依赖排列（父表在前）。导入时按此顺序插入，overwrite 按逆序清空。
const GALA_BACKUP_TABLES = [
  { name: 'gala_events', columns: ['id', 'title', 'event_date', 'status', 'total_budget', 'enabled_segments', 'created_by', 'created_name', 'created_at', 'updated_at'], defaults: { status: 'draft', total_budget: 0, enabled_segments: '[]' } },
  { name: 'gala_pools', columns: ['id', 'event_id', 'name', 'sponsor', 'budget', 'spent', 'is_reserved', 'created_at', 'updated_at'], defaults: { spent: 0, is_reserved: 0 } },
  { name: 'gala_participants', columns: ['id', 'event_id', 'userid', 'name_snapshot', 'table_no', 'source', 'joined_at'], defaults: { source: 'admin' } },
  { name: 'gala_rounds', columns: ['id', 'event_id', 'segment', 'round_no', 'title', 'prize_type', 'pool_id', 'amount_each', 'draw_count', 'status', 'created_by', 'created_name', 'created_at', 'granted_at'], defaults: { prize_type: 'none', amount_each: 0, status: 'drawn' } },
  { name: 'gala_round_winners', columns: ['id', 'round_id', 'event_id', 'userid', 'name_snapshot', 'display_order', 'pool_id', 'amount', 'is_reserved', 'awarded_at', 'ledger_id', 'award_error', 'created_at'], defaults: { display_order: 0, amount: 0, is_reserved: 0 } },
  { name: 'gala_reserved_slots', columns: ['id', 'event_id', 'segment', 'round_no', 'userid', 'pool_id', 'amount', 'note', 'status', 'used_round_id', 'created_by', 'created_at', 'updated_at'], defaults: { amount: 0, status: 'pending' } },
];

// 校验备份中年会数据的资金关系，返回错误描述列表（为空表示通过）。
export function findGalaFundingErrors(backupData) {
  const errors = [];
  const asList = (v) => (Array.isArray(v) ? v : []);
  const pools = new Map(asList(backupData?.gala_pools).map((p) => [Number(p?.id), p]));
  const rounds = new Map(asList(backupData?.gala_rounds).map((r) => [Number(r?.id), r]));
  const poolOk = (poolId, eventId, reserved) => {
    const pool = pools.get(Number(poolId));
    if (!pool || Number(pool.event_id) !== Number(eventId)) return false;
    return reserved == null || (Number(pool.is_reserved) === 1) === reserved;
  };
  for (const w of asList(backupData?.gala_round_winners)) {
    const round = rounds.get(Number(w?.round_id));
    if (!round || Number(round.event_id) !== Number(w?.event_id)) {
      errors.push(`gala_round_winners#${w?.id} 的轮次不存在或不属于同一活动`);
      continue;
    }
    if (w?.awarded_at == null && Number(w?.amount) > 0 && !poolOk(w?.pool_id, w?.event_id, null)) {
      errors.push(`gala_round_winners#${w?.id} 未发放奖励 ${w?.amount} 缺少同一活动的奖池`);
    }
  }
  for (const slot of asList(backupData?.gala_reserved_slots)) {
    if ((slot?.status ?? 'pending') === 'pending' && Number(slot?.amount) > 0 && !poolOk(slot?.pool_id, slot?.event_id, true)) {
      errors.push(`gala_reserved_slots#${slot?.id} 待用名额奖励 ${slot?.amount} 缺少同一活动的预留奖池`);
    }
  }
  return errors;
}

export function registerAdminBackupRoutes(router) {

  // 设置类表：结构配置，适合日常导出恢复
  const SETTINGS_TABLES = [
    'system_settings',
    'mall_products',
    'charity_projects',
    'mall_opening_schedule',
    'content_faq',
    'content_announcements',
    'content_announcement_revisions',
    'system_versions',
    'admin_roles',
  ];

  const SETTINGS_RECOVERY_TABLES = [
    ...SETTINGS_TABLES,
    'content_announcement_acknowledgements',
  ];

  // 全量表：包含用户数据（顺序决定导入顺序，users 必须最先）
  const FULL_TABLES = [
    'users',
    'accounts',
    'external_accounts',
    'bob_tokens',
    'ledger',
    'redeems',
    'mall_order_listings',
    'redeem_cdks',
    'mall_products',
    'charity_projects',
    'charity_contributions',
    'attendance_reward_records',
    'mall_opening_schedule',
    'red_packet_activity',
    'red_packet_items',
    'auction_activities',
    'auction_bids',
    'gala_events',
    'gala_pools',
    'gala_participants',
    'gala_rounds',
    'gala_round_winners',
    'gala_reserved_slots',
    'content_faq',
    'content_announcements',
    'content_announcement_revisions',
    'content_announcement_acknowledgements',
    'system_versions',
    'user_feedback',
    'user_feedback_messages',
    'audit_logs',
    'admin_roles',
    'admin_user_roles',
    'system_settings',
  ];

  async function dumpTable(db, tableName) {
    try {
      const rows = await db.all(`SELECT * FROM ${tableName}`, []);
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      throw new Error(`导出表 ${tableName} 失败: ${String(err?.message || err)}`);
    }
  }

  function backupStorageDir() {
    // 优先 BOB_BACKUP_DIR；默认使用项目父目录 bob-admin-backups，避免被部署 rsync --delete 清掉。
    if (process.env.BOB_BACKUP_DIR) return String(process.env.BOB_BACKUP_DIR);
    return path.join(path.dirname(fileURLToPath(new URL('../../../', import.meta.url))), 'bob-admin-backups');
  }

  function safeBackupFilename(filename) {
    const name = path.basename(String(filename || '').trim());
    // 兼容旧：YYYYMMDD_HHMM；新：YYYYMMDD_HHMMSS_随机后缀，避免同一分钟互相覆盖
    if (!/^bob_backup_(settings|full)_\d{8}_\d{4,6}(?:_[a-zA-Z0-9]+)?\.json$/.test(name)) {
      throw new Error('备份文件名不合法');
    }
    return name;
  }

  function buildBackupFilename(mode) {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');
    const rand = Math.random().toString(36).slice(2, 8);
    return `bob_backup_${mode}_${stamp}_${rand}.json`;
  }

  function isFullBackupFilename(filename) {
    return /^bob_backup_full_/.test(String(filename || ''));
  }

  function backupFilePath(filename) {
    return path.join(backupStorageDir(), safeBackupFilename(filename));
  }

  function writeBackupFile(filename, payload) {
    const dir = backupStorageDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // 部分文件系统/属主下 chmod 可能失败，不阻断写入
    }
    const filePath = backupFilePath(filename);
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // ignore
    }
    const stat = statSync(filePath);
    return { filePath, size: stat.size };
  }

  async function appendBackupHistory(db, req, input) {
    const payload = (await getAdminSessionPayload(req)) || {};
    await db.run(
      `INSERT INTO admin_backup_history(action, mode, filename, status, actor_id, actor_name, details, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      [
        input.action,
        input.mode,
        input.filename || '',
        input.status || '完成',
        payload?.userid ? String(payload.userid) : '',
        payload?.name ? String(payload.name) : '',
        input.details ? JSON.stringify(input.details) : null,
      ],
    );
  }

  router.get('/backup/history', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const limit = Math.min(100, Math.max(1, toPositiveInt(req.query?.limit, 30)));
    try {
      res.setHeader('Cache-Control', 'no-store');
      const rows = await db.all(
        `SELECT id, action, mode, filename, status, actor_id, actor_name, details, created_at AS at
         FROM admin_backup_history
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [limit],
      );
      return res.json({ ok: true, data: rows || [] });
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  function redactBackupSecrets(tableName, rows, { keepSecrets = false } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    // 自动恢复点必须保留密钥，否则回滚后钉钉 OAuth/通知/Stream 会中断。
    // 普通导出仍脱敏。
    if (keepSecrets) return list.map((row) => ({ ...row }));
    if (tableName === 'bob_tokens') {
      return list.map((row) => ({
        ...row,
        token: null,
      }));
    }
    if (tableName === 'system_settings') {
      return list.map((row) => {
        const key = String(row?.key || '');
        if (key !== 'dingtalk_connection_settings') return row;
        try {
          const parsed = JSON.parse(String(row.value || '{}'));
          if (parsed && typeof parsed === 'object') {
            if (parsed.appSecret) parsed.appSecret = '';
            if (parsed.app_secret) parsed.app_secret = '';
            return { ...row, value: JSON.stringify(parsed) };
          }
        } catch {
          // keep original if not json
        }
        return row;
      });
    }
    return list;
  }

  async function mergeSystemSettingValue(tx, key, value) {
    const k = String(key || '');
    if (k !== 'dingtalk_connection_settings') return value ?? null;
    let incoming = {};
    try {
      incoming = JSON.parse(String(value || '{}')) || {};
    } catch {
      return value ?? null;
    }
    if (!incoming || typeof incoming !== 'object') return value ?? null;
    const secretIn = String(incoming.appSecret || incoming.app_secret || '').trim();
    if (secretIn) return JSON.stringify(incoming);
    const existing = await tx.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', [k]);
    let current = {};
    try {
      current = JSON.parse(String(existing?.value || '{}')) || {};
    } catch {
      current = {};
    }
    if (current && typeof current === 'object') {
      if (current.appSecret) incoming.appSecret = current.appSecret;
      if (current.app_secret) incoming.app_secret = current.app_secret;
    }
    return JSON.stringify(incoming);
  }

  async function dumpTablesConsistently(db, tables, { keepSecrets = false } = {}) {
    return runInTransaction(db, async (tx) => {
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', []);
      const data = {};
      for (const tableName of tables) {
        // eslint-disable-next-line no-await-in-loop
        data[tableName] = redactBackupSecrets(tableName, await dumpTable(tx, tableName), { keepSecrets });
      }
      return data;
    });
  }

  // GET /admin/backup/export?mode=settings|full
  router.get('/backup/export', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const mode = req.query?.mode === 'full' ? 'full' : 'settings';
    const tables = mode === 'full' ? FULL_TABLES : SETTINGS_TABLES;
    try {
      // 全量备份仅超级管理员；设置备份保持 integrations:export 权限控制。
      if (mode === 'full' && !isSuperAdminSession(req.app?.locals?.cfg, req.adminSession || {})) {
        return res.status(403).json({ error: '全量备份仅超级管理员可导出' });
      }
      res.setHeader('Cache-Control', 'no-store');
      const data = await dumpTablesConsistently(db, tables);
      const now = new Date();
      const filename = buildBackupFilename(mode);
      const payload = {
        _meta: {
          version: 2,
          mode,
          filename,
          exportedAt: now.toISOString(),
          tables: Object.fromEntries(tables.map((t) => [t, data[t]?.length ?? 0])),
          secretsRedacted: true,
        },
        data,
      };
      const stored = writeBackupFile(filename, payload);
      await appendBackupHistory(db, req, {
        action: '导出',
        mode,
        filename,
        status: '完成',
        details: { ...payload._meta, size: stored.size, downloadable: true },
      });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.json(payload);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.get('/backup/history/:id/download', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const id = toPositiveInt(req.params?.id, 0);
    if (!id) return res.status(400).json({ error: '缺少备份记录 ID' });
    try {
      const row = await db.get(
        `SELECT id, action, filename, mode, details
         FROM admin_backup_history
         WHERE id = ?
         LIMIT 1`,
        [id],
      );
      if (!row || row.action !== '导出' || !row.filename) {
        return res.status(404).json({ error: '未找到可下载的备份文件' });
      }
      const filename = safeBackupFilename(row.filename);
      const modeHint = String(row.mode || '').trim().toLowerCase();
      const isFull = modeHint === 'full' || isFullBackupFilename(filename);
      let isRecoveryPoint = false;
      let secretsNotRedacted = false;
      try {
        const details = row.details ? JSON.parse(String(row.details)) : null;
        isRecoveryPoint = details?.purpose === 'pre_import_recovery_point';
        secretsNotRedacted = details?.secretsRedacted === false;
      } catch {
        isRecoveryPoint = false;
        secretsNotRedacted = false;
      }
      // 全量备份 / 导入前恢复点（含明文 AppSecret）仅超级管理员可下载。
      // 设置模式的普通导出仍可由 integrations:export 下载（已脱敏）。
      const needsSuper = isFull || isRecoveryPoint || secretsNotRedacted;
      if (needsSuper && !isSuperAdminSession(req.app?.locals?.cfg, req.adminSession || {})) {
        return res.status(403).json({
          error: isFull
            ? '全量备份仅超级管理员可下载'
            : '含密钥的恢复点仅超级管理员可下载',
        });
      }
      const filePath = backupFilePath(filename);
      if (!existsSync(filePath)) {
        return res.status(404).json({ error: '服务器上的备份文件不存在，请重新导出' });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.download(filePath, filename);
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // POST /admin/backup/import
  // body: { backup: <备份 JSON 对象>, mode: 'merge'|'overwrite' }
  // 安全约束：预校验 schema、覆盖前自动快照、全量在单事务内执行；任意失败回滚，禁止吞错后返回成功。
  router.post('/backup/import', requireAdminSession(), async (req, res) => {
    const db = req.app?.locals?.db;
    const backup = req.body?.backup;
    const mode = req.body?.mode === 'overwrite' ? 'overwrite' : 'merge';
    const requestedFilename = String(req.body?.filename || backup?._meta?.filename || '').trim();

    const failHistory = async (status, details) => {
      try {
        await appendBackupHistory(db, req, {
          action: '导入',
          mode,
          filename: requestedFilename,
          status,
          details,
        });
      } catch {
        // 历史记录失败不影响主错误返回
      }
    };

    if (!backup || typeof backup !== 'object' || !backup.data || typeof backup.data !== 'object') {
      return res.status(400).json({ error: '无效的备份文件格式' });
    }
    const backupVersion = Number(backup._meta?.version);
    if (![1, 2].includes(backupVersion)) {
      return res.status(400).json({ error: `不支持的备份版本: ${backup._meta?.version}` });
    }

    const backupMode = backup._meta?.mode === 'full' ? 'full' : 'settings';
    const isSettingsRecoveryPoint = backupMode === 'settings'
      && backup._meta?.purpose === 'pre_import_recovery_point';
    if (isSettingsRecoveryPoint && backupVersion !== 2) {
      return res.status(400).json({ error: '设置自动恢复点必须使用备份版本 2' });
    }
    if (isSettingsRecoveryPoint && mode !== 'overwrite') {
      return res.status(400).json({ error: '设置自动恢复点仅允许覆盖导入' });
    }
    const backupData = backup.data;
    const v1ExcludedTables = new Set([
      'content_announcement_revisions',
      'content_announcement_acknowledgements',
    ]);
    const modeTables = backupMode === 'full'
      ? FULL_TABLES
      : isSettingsRecoveryPoint
        ? SETTINGS_RECOVERY_TABLES
        : SETTINGS_TABLES;
    const versionTables = backupVersion === 1
      ? modeTables.filter((name) => !v1ExcludedTables.has(name))
      : modeTables;
    const allowedTables = new Set(versionTables);
    const unknownTables = Object.keys(backupData).filter((name) => !allowedTables.has(name));
    if (unknownTables.length > 0) {
      await failHistory('失败', { reason: 'unknown_tables', unknownTables, backupMode });
      return res.status(400).json({
        error: `备份包含未知表，已拒绝导入: ${unknownTables.join(', ')}`,
        unknownTables,
      });
    }

    // overwrite 必须包含该模式下的完整表集合；缺失表不得被当成空数组后 DELETE。
    // 例外：拍卖表与外部账号表晚于备份版本号引入，早于该功能的旧全量备份（v1 或对应功能之前的 v2）
    // 都不含这些表，不能因此拒绝旧备份恢复；仍需校验快照内的关联数据完整性。
    const optionalFullTables = new Set(['auction_activities', 'auction_bids', 'external_accounts']);
    // 年会表同理：早于年会功能的全量备份不含这些表；含其一则下面要求六张齐全。
    for (const table of GALA_BACKUP_TABLES) optionalFullTables.add(table.name);
    const expectedTables = versionTables.filter((name) => !optionalFullTables.has(name));
    if (mode === 'overwrite') {
      const missingTables = expectedTables.filter((name) => backupData[name] == null);
      if (missingTables.length > 0) {
        await failHistory('失败', { reason: 'missing_tables_for_overwrite', missingTables, backupMode });
        return res.status(400).json({
          error: `覆盖导入要求备份包含全部 ${expectedTables.length} 张表，缺失: ${missingTables.join(', ')}`,
          missingTables,
          backupMode,
        });
      }
    }

    // 年会表晚于拍卖引入：旧备份可以一张都没有；只要含其中任意一张，就必须六张齐全，
    // 否则会恢复出有中奖记录却无奖池/活动、或有发放流水却无幂等记录的残缺账目。
    if (backupMode === 'full') {
      const present = GALA_BACKUP_TABLES.filter((t) => backupData[t.name] != null).map((t) => t.name);
      if (present.length > 0 && present.length < GALA_BACKUP_TABLES.length) {
        const missingTables = GALA_BACKUP_TABLES.map((t) => t.name).filter((n) => !present.includes(n));
        await failHistory('失败', { reason: 'incomplete_gala_tables', missingTables, backupMode });
        return res.status(400).json({ error: `年会数据必须整组导入，缺失: ${missingTables.join(', ')}`, missingTables, backupMode });
      }
      // 资金关系校验：未发放的正数奖励（中奖记录/待用预留名额）必须挂在备份内同一活动的奖池上，
      // 中奖记录必须属于备份内同一活动的轮次。否则发币时会在任何预算之外入账。
      // merge 拒绝任何年会 ID 冲突、overwrite 会先清空年会表，所以只需在备份内部校验。
      if (present.length === GALA_BACKUP_TABLES.length) {
        const galaFundingErrors = findGalaFundingErrors(backupData);
        if (galaFundingErrors.length) {
          await failHistory('失败', { reason: 'invalid_gala_funding', errors: galaFundingErrors.slice(0, 20), backupMode });
          return res.status(400).json({
            error: `年会数据资金关系不完整，已拒绝导入：${galaFundingErrors.slice(0, 5).join('；')}`,
            errors: galaFundingErrors.slice(0, 20),
            backupMode,
          });
        }
      }
    }

    // 拍卖两张表必须成对出现：旧备份可以两张都没有（按空处理），
    // 但只含活动、缺出价（或反之）的残缺备份会恢复出带 current_bid_id/冻结价却无出价记录的活动，
    // 造成有扣款无可退出价、拍卖无法结算，故拒绝“只缺其一”的备份。
    if (backupMode === 'full') {
      const hasAuctionActivities = backupData.auction_activities != null;
      const hasAuctionBids = backupData.auction_bids != null;
      if (hasAuctionActivities !== hasAuctionBids) {
        const missingTable = hasAuctionActivities ? 'auction_bids' : 'auction_activities';
        await failHistory('失败', { reason: 'incomplete_auction_pair', missingTable, backupMode });
        return res.status(400).json({
          error: `拍卖数据必须成对导入，缺失: ${missingTable}`,
          missingTable,
          backupMode,
        });
      }
    }

    const parseRolePermissions = (value) => {
      if (Array.isArray(value)) return normalizePermissions(value);
      try {
        return normalizePermissions(JSON.parse(String(value || '[]')));
      } catch (err) {
        throw new Error(`角色权限 JSON 无效: ${String(err?.message || err)}`);
      }
    };

    const nowTs = () => Math.floor(Date.now() / 1000);

    const requireArray = (tableName) => {
      if (backupData[tableName] == null) return null;
      if (!Array.isArray(backupData[tableName])) {
        throw new Error(`备份表 ${tableName} 必须是数组`);
      }
      return backupData[tableName];
    };

    const bumpSerial = async (tx, tableName) => {
      await tx.exec(
        `SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), COALESCE((SELECT MAX(id) FROM ${tableName}), 1), true)`,
        [],
      );
    };

    const execOrThrow = async (tx, sql, params, context) => {
      try {
        await tx.exec(sql, params);
      } catch (err) {
        const msg = String(err?.message || err);
        throw new Error(`${context}: ${msg}`);
      }
    };

    // 预校验：不改库，只验证结构与关键键，避免覆盖删除后才发现备份不可恢复。
    const preflightErrors = [];
    const pushPreflight = (table, index, message) => {
      preflightErrors.push({ table, index, message });
    };

    try {
      for (const tableName of Object.keys(backupData)) {
        requireArray(tableName);
      }

      const systemSettings = requireArray('system_settings') || [];
      systemSettings.forEach((row, index) => {
        if (!row || typeof row !== 'object' || !row.key) pushPreflight('system_settings', index, '缺少 key');
      });

      const adminRoles = requireArray('admin_roles') || [];
      adminRoles.forEach((row, index) => {
        if (!row?.code || !row?.name) pushPreflight('admin_roles', index, '缺少 code/name');
        try {
          parseRolePermissions(row?.permissions);
        } catch (err) {
          pushPreflight('admin_roles', index, String(err.message || err));
        }
      });

      const mallProducts = requireArray('mall_products') || [];
      mallProducts.forEach((row, index) => {
        if (!row?.product_id) pushPreflight('mall_products', index, '缺少 product_id');
      });

      const charityProjects = requireArray('charity_projects') || [];
      charityProjects.forEach((row, index) => {
        if (!row?.project_id) pushPreflight('charity_projects', index, '缺少 project_id');
      });

      // 拍卖恢复一致性：结算按 bid id 查获胜者但不约束 activity_id，
      // 故快照里 current_bid_id 必须指向本活动、状态 held 的出价，且 bidder/金额一致；
      // 出价的 activity_id 也不得悬挂。拒绝损坏/被篡改的快照，避免恢复后错判获胜者。
      const auctionActivities = requireArray('auction_activities') || [];
      const auctionBids = requireArray('auction_bids') || [];
      const auctionBidById = new Map(auctionBids.map((b) => [Number(b?.id), b]));
      const auctionActivityById = new Map(auctionActivities.map((a) => [Number(a?.id), a]));
      const auctionActivityIds = new Set(auctionActivities.map((a) => Number(a?.id)).filter(Number.isSafeInteger));
      auctionActivities.forEach((row, index) => {
        if (!row?.id) {
          pushPreflight('auction_activities', index, '缺少 id');
          return;
        }
        if (row.current_bid_id === undefined || row.current_bid_id === null) return;
        const bid = auctionBidById.get(Number(row.current_bid_id));
        if (!bid) {
          pushPreflight('auction_activities', index, `current_bid_id ${row.current_bid_id} 无对应出价`);
          return;
        }
        if (Number(bid.activity_id) !== Number(row.id)) {
          pushPreflight('auction_activities', index, `current_bid_id ${row.current_bid_id} 属于其他活动`);
        }
        if (String(bid.state) !== 'held') {
          pushPreflight('auction_activities', index, `current_bid_id ${row.current_bid_id} 出价状态非 held`);
        }
        if (row.current_bid_userid != null && String(bid.userid) !== String(row.current_bid_userid)) {
          pushPreflight('auction_activities', index, 'current_bid_userid 与出价不一致');
        }
        if (row.current_price != null && Number(bid.amount) !== Number(row.current_price)) {
          pushPreflight('auction_activities', index, 'current_price 与出价金额不一致');
        }
      });
      auctionBids.forEach((row, index) => {
        if (!row?.id) {
          pushPreflight('auction_bids', index, '缺少 id');
          return;
        }
        if (!auctionActivityIds.has(Number(row?.activity_id))) {
          pushPreflight('auction_bids', index, `activity_id ${row?.activity_id} 无对应活动`);
        }
        // 反向不变式：每条 held 出价必须正被其所属活动的 current_bid_id 引用。
        // 否则恢复后出现「有扣款却无活动指针」的在押出价：结算判定无获胜者、取消不退款，
        // 且后续任何出价都会撞 idx_auction_bids_held_once（每场至多一条 held）。
        if (String(row?.state) === 'held') {
          const activity = auctionActivityById.get(Number(row?.activity_id));
          if (activity && Number(activity.current_bid_id) !== Number(row?.id)) {
            pushPreflight('auction_bids', index, `held 出价 ${row?.id} 未被所属活动 current_bid_id 引用`);
          }
        }
      });

      const mallOpening = requireArray('mall_opening_schedule') || [];
      if (mallOpening.length > 0 && (!mallOpening[0] || typeof mallOpening[0] !== 'object')) {
        pushPreflight('mall_opening_schedule', 0, '行数据无效');
      }

      for (const tableName of ['content_faq', 'content_announcements', 'system_versions']) {
        const rows = requireArray(tableName) || [];
        rows.forEach((row, index) => {
          if (!row?.id) pushPreflight(tableName, index, '缺少 id');
        });
      }

      const announcements = requireArray('content_announcements') || [];
      announcements.forEach((row, index) => {
        if (row?.edit_version === undefined || row?.edit_version === null) return;
        const editVersion = Number(row.edit_version);
        if (!Number.isSafeInteger(editVersion) || editVersion <= 0) {
          pushPreflight('content_announcements', index, 'edit_version 必须为正整数');
        }
      });
      const announcementIds = new Set(announcements.map((row) => Number(row?.id)).filter(Number.isSafeInteger));
      const announcementRevisionHashes = new Map();
      const seenAnnouncementRevisionKeys = new Set();
      const revisions = requireArray('content_announcement_revisions') || [];
      revisions.forEach((row, index) => {
        const announcementId = Number(row?.announcement_id);
        const revision = Number(row?.revision);
        const contentHash = String(row?.content_hash || '').toLowerCase();
        const expectedHash = computeAnnouncementContentHash({
          title: row?.title,
          content: row?.content,
          requiresAcknowledgement: Number(row?.requires_acknowledgement || 0) === 1,
        });
        if (!Number.isSafeInteger(announcementId) || announcementId <= 0) {
          pushPreflight('content_announcement_revisions', index, 'announcement_id 无效');
        }
        if (!Number.isSafeInteger(revision) || revision <= 0) {
          pushPreflight('content_announcement_revisions', index, 'revision 无效');
        }
        if (!/^[a-f0-9]{64}$/i.test(contentHash)) {
          pushPreflight('content_announcement_revisions', index, 'content_hash 必须为 64 位十六进制');
        } else if (contentHash !== expectedHash) {
          pushPreflight('content_announcement_revisions', index, 'content_hash 与修订正文不匹配');
        }
        if (!announcementIds.has(announcementId)) {
          pushPreflight('content_announcement_revisions', index, '找不到关联公告');
        }
        if (Number.isSafeInteger(announcementId) && announcementId > 0
          && Number.isSafeInteger(revision) && revision > 0) {
          const revisionKey = `${announcementId}:${revision}`;
          if (seenAnnouncementRevisionKeys.has(revisionKey)) {
            pushPreflight('content_announcement_revisions', index, 'announcement_id/revision 重复');
          } else {
            seenAnnouncementRevisionKeys.add(revisionKey);
            announcementRevisionHashes.set(revisionKey, {
              hash: expectedHash,
              requiresAcknowledgement: Number(row?.requires_acknowledgement || 0) === 1,
            });
          }
        }
      });

      if (backupVersion === 2) {
        announcements.forEach((row, index) => {
          const announcementId = Number(row?.id);
          const revision = Number(row?.revision);
          const contentHash = String(row?.content_hash || '').toLowerCase();
          const requiresAcknowledgement = Number(row?.requires_acknowledgement || 0) === 1;
          const expectedHash = computeAnnouncementContentHash({
            title: row?.title,
            content: row?.content,
            requiresAcknowledgement,
          });
          if (!Number.isSafeInteger(revision) || revision <= 0) {
            pushPreflight('content_announcements', index, 'revision 无效');
          }
          if (!/^[a-f0-9]{64}$/i.test(contentHash)) {
            pushPreflight('content_announcements', index, 'content_hash 必须为 64 位十六进制');
          } else if (contentHash !== expectedHash) {
            pushPreflight('content_announcements', index, 'content_hash 与当前正文不匹配');
          }
          if (requiresAcknowledgement && Number(row?.show_fullscreen || 0) !== 1) {
            pushPreflight('content_announcements', index, '要求确认的公告必须全屏展示');
          }
          if (announcementRevisionHashes.get(`${announcementId}:${revision}`)?.hash !== expectedHash) {
            pushPreflight('content_announcements', index, '找不到与当前公告一致的修订快照');
          }
        });
      }

      if (backupMode === 'full' || isSettingsRecoveryPoint) {
        const users = backupMode === 'full' ? (requireArray('users') || []) : [];
        const currentUsers = isSettingsRecoveryPoint
          ? await db.all('SELECT userid FROM users', [])
          : users;
        const userIds = new Set(currentUsers.map((row) => String(row?.userid || '')).filter(Boolean));
        if (backupMode === 'full') {
          users.forEach((row, index) => {
            if (!row?.userid) pushPreflight('users', index, '缺少 userid');
          });
        }
        const acknowledgements = requireArray('content_announcement_acknowledgements') || [];
        acknowledgements.forEach((row, index) => {
          const announcementId = Number(row?.announcement_id);
          const revision = Number(row?.revision);
          const action = String(row?.action || '');
          if (!row?.userid) pushPreflight('content_announcement_acknowledgements', index, '缺少 userid');
          if (row?.userid && !userIds.has(String(row.userid))) {
            pushPreflight('content_announcement_acknowledgements', index, '找不到关联用户');
          }
          if (!Number.isSafeInteger(announcementId) || announcementId <= 0) {
            pushPreflight('content_announcement_acknowledgements', index, 'announcement_id 无效');
          }
          if (!Number.isSafeInteger(revision) || revision <= 0) {
            pushPreflight('content_announcement_acknowledgements', index, 'revision 无效');
          }
          if (!/^[a-f0-9]{64}$/i.test(String(row?.content_hash || ''))) {
            pushPreflight('content_announcement_acknowledgements', index, 'content_hash 必须为 64 位十六进制');
          }
          if (!['acknowledged', 'dismissed'].includes(action)) {
            pushPreflight('content_announcement_acknowledgements', index, 'action 无效');
          }
          const revisionSnapshot = announcementRevisionHashes.get(`${announcementId}:${revision}`);
          if (!revisionSnapshot) {
            pushPreflight('content_announcement_acknowledgements', index, '找不到关联公告修订');
          } else if (revisionSnapshot.hash !== String(row?.content_hash || '').toLowerCase()) {
            pushPreflight('content_announcement_acknowledgements', index, 'content_hash 与关联修订不匹配');
          } else if (revisionSnapshot.requiresAcknowledgement && action !== 'acknowledged') {
            pushPreflight('content_announcement_acknowledgements', index, '强制确认公告不允许 dismissed');
          }
        });

        // 外部账号必须带凭据且能对上本批 users：缺凭据恢复后无法登录，手机号唯一还会挡住重新注册。
        if (backupMode === 'full') {
          const externalAccounts = requireArray('external_accounts') || [];
          const usersById = new Map(users.map((row) => [String(row?.userid || ''), row]));
          const externalByUserid = new Map(externalAccounts.map((row) => [String(row?.userid || ''), row]));
          users.forEach((row, index) => {
            if (row?.source === 'external' && !externalByUserid.has(String(row.userid))) {
              pushPreflight('users', index, '外部用户缺少关联密码凭据');
            }
          });
          externalAccounts.forEach((row, index) => {
            if (!row?.userid || !row?.phone) pushPreflight('external_accounts', index, '缺少 userid/phone');
            if (!row?.password_hash || !row?.password_salt) {
              pushPreflight('external_accounts', index, '缺少密码凭据');
            }
            const user = usersById.get(String(row?.userid || ''));
            if (!user) {
              pushPreflight('external_accounts', index, '找不到关联用户');
            } else if (user.source !== 'external' || String(user.phone || '') !== String(row.phone || '')) {
              pushPreflight('external_accounts', index, '关联用户来源或手机号不一致');
            }
          });
        }
      }

      if (backupMode === 'full') {
        const accounts = requireArray('accounts') || [];
        accounts.forEach((row, index) => {
          if (!row?.userid) pushPreflight('accounts', index, '缺少 userid');
        });

        const bobTokens = requireArray('bob_tokens') || [];
        bobTokens.forEach((row, index) => {
          if (!row?.token_hash) pushPreflight('bob_tokens', index, '缺少 token_hash');
        });

        const ledger = requireArray('ledger') || [];
        ledger.forEach((row, index) => {
          if (!row?.id || !row?.userid) pushPreflight('ledger', index, '缺少 id/userid');
        });

        const redeems = requireArray('redeems') || [];
        redeems.forEach((row, index) => {
          if (!row?.exchange_id) pushPreflight('redeems', index, '缺少 exchange_id');
        });

        const listings = requireArray('mall_order_listings') || [];
        listings.forEach((row, index) => {
          if (!row?.listing_id || !row?.exchange_id || !row?.seller_userid) {
            pushPreflight('mall_order_listings', index, '缺少 listing_id/exchange_id/seller_userid');
          }
        });

        const cdks = requireArray('redeem_cdks') || [];
        cdks.forEach((row, index) => {
          if (!row?.cdk_code) pushPreflight('redeem_cdks', index, '缺少 cdk_code');
        });

        const contributions = requireArray('charity_contributions') || [];
        contributions.forEach((row, index) => {
          if (!row?.id || !row?.project_id || !row?.userid) {
            pushPreflight('charity_contributions', index, '缺少 id/project_id/userid');
          }
        });

        const attendance = requireArray('attendance_reward_records') || [];
        attendance.forEach((row, index) => {
          if (!row?.userid || !row?.work_date || !row?.check_time_ms) {
            pushPreflight('attendance_reward_records', index, '缺少 userid/work_date/check_time_ms');
          }
        });

        const feedback = requireArray('user_feedback') || [];
        feedback.forEach((row, index) => {
          if (!row?.id || !row?.userid || row?.content == null) {
            pushPreflight('user_feedback', index, '缺少 id/userid/content');
          }
        });

        const feedbackMessages = requireArray('user_feedback_messages') || [];
        feedbackMessages.forEach((row, index) => {
          if (!row?.id || !row?.feedback_id || !row?.content) {
            pushPreflight('user_feedback_messages', index, '缺少 id/feedback_id/content');
          }
        });

        const auditLogs = requireArray('audit_logs') || [];
        auditLogs.forEach((row, index) => {
          if (!row?.id || !row?.event_type) pushPreflight('audit_logs', index, '缺少 id/event_type');
        });

        const adminUserRoles = requireArray('admin_user_roles') || [];
        adminUserRoles.forEach((row, index) => {
          if (!row?.userid || (!row?.role_id && !row?.role_code)) {
            pushPreflight('admin_user_roles', index, '缺少 userid/role_id(role_code)');
          }
        });

        const activities = requireArray('red_packet_activity') || [];
        activities.forEach((row, index) => {
          if (!row?.id) pushPreflight('red_packet_activity', index, '缺少 id');
        });

        const items = requireArray('red_packet_items') || [];
        items.forEach((row, index) => {
          if (!row?.activity_id || row?.amount == null) {
            pushPreflight('red_packet_items', index, '缺少 activity_id/amount');
          }
        });
      }
    } catch (err) {
      await failHistory('失败', { reason: 'preflight_exception', message: String(err?.message || err), backupMode });
      return res.status(400).json({ error: String(err?.message || err) });
    }

    if (preflightErrors.length > 0) {
      const sample = preflightErrors.slice(0, 20);
      await failHistory('失败', {
        reason: 'preflight_failed',
        backupMode,
        errorCount: preflightErrors.length,
        errors: sample,
      });
      return res.status(400).json({
        error: `备份预校验失败，共 ${preflightErrors.length} 处错误，未修改数据库`,
        errorCount: preflightErrors.length,
        errors: sample,
      });
    }

    // 覆盖导入前自动生成恢复点，防止中途失败后无回滚文件。
    let recoveryPoint = null;
    try {
      const tablesToSnapshot = backupMode === 'full'
        ? FULL_TABLES
        : SETTINGS_RECOVERY_TABLES;
      const snapshotData = await dumpTablesConsistently(
        db,
        tablesToSnapshot,
        { keepSecrets: true },
      );
      const stampDate = new Date();
      const recoveryFilename = buildBackupFilename(backupMode);
      const recoveryPayload = {
        _meta: {
          version: 2,
          mode: backupMode,
          filename: recoveryFilename,
          exportedAt: stampDate.toISOString(),
          purpose: 'pre_import_recovery_point',
          importMode: mode,
          sourceFilename: requestedFilename || null,
          secretsRedacted: false,
          tables: Object.fromEntries(tablesToSnapshot.map((t) => [t, snapshotData[t]?.length ?? 0])),
        },
        data: snapshotData,
      };
      const stored = writeBackupFile(recoveryFilename, recoveryPayload);
      recoveryPoint = {
        filename: recoveryFilename,
        size: stored.size,
        mode: backupMode,
        tables: recoveryPayload._meta.tables,
      };
      await appendBackupHistory(db, req, {
        action: '导出',
        mode: backupMode,
        filename: recoveryFilename,
        status: '完成',
        details: {
          ...recoveryPayload._meta,
          size: stored.size,
          downloadable: true,
          purpose: 'pre_import_recovery_point',
          secretsRedacted: false,
          sensitive: true,
        },
      });
    } catch (err) {
      await failHistory('失败', {
        reason: 'recovery_point_failed',
        message: String(err?.message || err),
        backupMode,
        mode,
      });
      return res.status(500).json({
        error: `导入前自动快照失败，已中止导入: ${String(err?.message || err)}`,
      });
    }

    const importedRoleIdMap = new Map();

    try {
      const report = await runInTransaction(db, async (tx) => {
        await lockAdminAccountProtection(tx);
        const report = {};
        let failedTable = null;
        let failedIndex = null;

        const markAndThrow = (table, index, err) => {
          failedTable = table;
          failedIndex = index;
          const msg = String(err?.message || err);
          throw new Error(`导入失败 @${table}${index == null ? '' : `[${index}]`}: ${msg}`);
        };

        // system_settings：始终 upsert，不清除；钉钉 AppSecret 若备份为空则保留库内现有值
        {
          const rows = requireArray('system_settings') || [];
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.key) continue;
            try {
              // eslint-disable-next-line no-await-in-loop
              const mergedValue = await mergeSystemSettingValue(tx, row.key, row.value ?? null);
              // eslint-disable-next-line no-await-in-loop
              await execOrThrow(
                tx,
                'INSERT INTO system_settings(key, value, updated_at) VALUES($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
                [row.key, mergedValue, row.updated_at ?? nowTs()],
                `system_settings[${i}]`,
              );
              count++;
            } catch (err) {
              markAndThrow('system_settings', i, err);
            }
          }
          report.system_settings = count;
        }

        // admin_roles
        {
          const rows = requireArray('admin_roles') || [];
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.code || !row?.name) continue;
            const code = String(row.code).trim();
            const name = String(row.name).trim();
            const permissions = parseRolePermissions(row.permissions);
            const now = nowTs();
            try {
              // eslint-disable-next-line no-await-in-loop
              const existing = await tx.get('SELECT id FROM admin_roles WHERE code = ? LIMIT 1', [code]);
              if (existing?.id) {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `UPDATE admin_roles
                   SET name = $1, permissions = $2, is_builtin = $3, is_enabled = $4, updated_at = $5
                   WHERE code = $6`,
                  [name, JSON.stringify(permissions), row.is_builtin ?? 0, row.is_enabled ?? 1, row.updated_at ?? now, code],
                  `admin_roles[${i}] update`,
                );
                importedRoleIdMap.set(Number(row.id), Number(existing.id));
              } else {
                const backupId = toOptionalInt(row.id);
                let insertedWithBackupId = false;
                if (backupId) {
                  // eslint-disable-next-line no-await-in-loop
                  const occupied = await tx.get('SELECT id FROM admin_roles WHERE id = ? LIMIT 1', [backupId]);
                  if (!occupied?.id) {
                    // eslint-disable-next-line no-await-in-loop
                    await execOrThrow(
                      tx,
                      `INSERT INTO admin_roles(id, code, name, permissions, is_builtin, is_enabled, created_at, updated_at)
                       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
                      [
                        backupId,
                        code,
                        name,
                        JSON.stringify(permissions),
                        row.is_builtin ?? 0,
                        row.is_enabled ?? 1,
                        row.created_at ?? now,
                        row.updated_at ?? now,
                      ],
                      `admin_roles[${i}] insert-id`,
                    );
                    insertedWithBackupId = true;
                  }
                }
                if (!insertedWithBackupId) {
                  // eslint-disable-next-line no-await-in-loop
                  await execOrThrow(
                    tx,
                    `INSERT INTO admin_roles(code, name, permissions, is_builtin, is_enabled, created_at, updated_at)
                     VALUES($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT(code) DO UPDATE SET
                       name=excluded.name, permissions=excluded.permissions, is_builtin=excluded.is_builtin,
                       is_enabled=excluded.is_enabled, updated_at=excluded.updated_at`,
                    [
                      code,
                      name,
                      JSON.stringify(permissions),
                      row.is_builtin ?? 0,
                      row.is_enabled ?? 1,
                      row.created_at ?? now,
                      row.updated_at ?? now,
                    ],
                    `admin_roles[${i}] upsert`,
                  );
                }
                // eslint-disable-next-line no-await-in-loop
                const saved = await tx.get('SELECT id FROM admin_roles WHERE code = ? LIMIT 1', [code]);
                if (saved?.id) importedRoleIdMap.set(Number(row.id), Number(saved.id));
              }
              count++;
            } catch (err) {
              markAndThrow('admin_roles', i, err);
            }
          }
          try {
            await bumpSerial(tx, 'admin_roles');
          } catch (err) {
            markAndThrow('admin_roles', null, err);
          }
          report.admin_roles = count;
        }

        // mall_products
        {
          const rowsRaw = requireArray('mall_products');
          const rows = rowsRaw || [];
          if (mode === 'overwrite' && rowsRaw !== null) {
            await execOrThrow(tx, 'DELETE FROM mall_products', [], 'mall_products overwrite delete');
          }
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.product_id) continue;
            try {
              // eslint-disable-next-line no-await-in-loop
              await execOrThrow(
                tx,
                `INSERT INTO mall_products(product_id, product_name, bob_amount, stock, limit_per_user, limit_round, cdk_enabled, status, sort, image_url, remark, created_at, updated_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                 ON CONFLICT(product_id) DO UPDATE SET
                   product_name=excluded.product_name, bob_amount=excluded.bob_amount, stock=excluded.stock,
                   limit_per_user=excluded.limit_per_user, limit_round=excluded.limit_round, cdk_enabled=excluded.cdk_enabled, status=excluded.status, sort=excluded.sort,
                   image_url=excluded.image_url, remark=excluded.remark, updated_at=excluded.updated_at`,
                [
                  row.product_id,
                  row.product_name,
                  row.bob_amount,
                  row.stock ?? null,
                  row.limit_per_user ?? 0,
                  row.limit_round ?? 1,
                  row.cdk_enabled ?? 0,
                  row.status ?? 'on',
                  row.sort ?? null,
                  row.image_url ?? null,
                  row.remark ?? null,
                  row.created_at ?? nowTs(),
                  row.updated_at ?? nowTs(),
                ],
                `mall_products[${i}]`,
              );
              count++;
            } catch (err) {
              markAndThrow('mall_products', i, err);
            }
          }
          report.mall_products = count;
        }

        // charity_projects
        {
          const rowsRaw = requireArray('charity_projects');
          const rows = rowsRaw || [];
          if (mode === 'overwrite' && rowsRaw !== null) {
            await execOrThrow(tx, 'DELETE FROM charity_contributions', [], 'charity_contributions overwrite delete');
            await execOrThrow(tx, 'DELETE FROM charity_projects', [], 'charity_projects overwrite delete');
          }
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.project_id) continue;
            try {
              // eslint-disable-next-line no-await-in-loop
              await execOrThrow(
                tx,
                `INSERT INTO charity_projects(project_id, project_name, cover_image_url, summary, rules_text, target_bob_amount, tier_options_json, status, execution_status, execution_note, sort, created_at, updated_at, executed_at)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                 ON CONFLICT(project_id) DO UPDATE SET
                   project_name=excluded.project_name, cover_image_url=excluded.cover_image_url, summary=excluded.summary,
                   rules_text=excluded.rules_text, target_bob_amount=excluded.target_bob_amount, tier_options_json=excluded.tier_options_json,
                   status=excluded.status, execution_status=excluded.execution_status, execution_note=excluded.execution_note,
                   sort=excluded.sort, updated_at=excluded.updated_at, executed_at=excluded.executed_at`,
                [
                  row.project_id,
                  row.project_name ?? row.project_id,
                  row.cover_image_url ?? null,
                  row.summary ?? '',
                  row.rules_text ?? '',
                  row.target_bob_amount ?? 0,
                  row.tier_options_json ?? '[10,20,50,100]',
                  row.status ?? 'active',
                  row.execution_status ?? 'pending',
                  row.execution_note ?? null,
                  row.sort ?? null,
                  row.created_at ?? nowTs(),
                  row.updated_at ?? nowTs(),
                  row.executed_at ?? null,
                ],
                `charity_projects[${i}]`,
              );
              count++;
            } catch (err) {
              markAndThrow('charity_projects', i, err);
            }
          }
          report.charity_projects = count;
        }

        // mall_opening_schedule
        {
          const rows = requireArray('mall_opening_schedule') || [];
          if (rows.length > 0) {
            const row = rows[0];
            try {
              await execOrThrow(
                tx,
                `INSERT INTO mall_opening_schedule(id, is_open, auto_enabled, next_open_at, interval_minutes, open_duration_minutes, remind_before_seconds, close_remind_seconds, remind_for_open_at, open_notify_for_open_at, close_remind_for_close_at, close_notify_for_close_at, updated_at)
                 VALUES(1,$1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL,$8)
                 ON CONFLICT(id) DO UPDATE SET
                   is_open=excluded.is_open, auto_enabled=excluded.auto_enabled, next_open_at=excluded.next_open_at,
                   interval_minutes=excluded.interval_minutes, open_duration_minutes=excluded.open_duration_minutes,
                   remind_before_seconds=excluded.remind_before_seconds, close_remind_seconds=excluded.close_remind_seconds,
                   remind_for_open_at=NULL, open_notify_for_open_at=NULL, close_remind_for_close_at=NULL, close_notify_for_close_at=NULL,
                   updated_at=excluded.updated_at`,
                [
                  row.is_open ?? 1,
                  row.auto_enabled ?? 0,
                  row.next_open_at ?? null,
                  row.interval_minutes ?? null,
                  row.open_duration_minutes ?? null,
                  row.remind_before_seconds ?? null,
                  row.close_remind_seconds ?? null,
                  row.updated_at ?? nowTs(),
                ],
                'mall_opening_schedule[0]',
              );
              report.mall_opening_schedule = 1;
            } catch (err) {
              markAndThrow('mall_opening_schedule', 0, err);
            }
          }
        }

        // content_faq / content_announcements / system_versions
        const contentTables = [
          {
            name: 'content_faq',
            sql: 'INSERT INTO content_faq(id, question, answer, sort, is_enabled, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
            params: (row) => [
              row.id,
              row.question ?? '',
              row.answer ?? '',
              row.sort ?? 0,
              row.is_enabled ?? 1,
              row.created_at ?? nowTs(),
              row.updated_at ?? nowTs(),
            ],
          },
          {
            name: 'content_announcements',
            sql: `INSERT INTO content_announcements(
                    id, title, content, level, sort, is_enabled, publish_at,
                    show_fullscreen, requires_acknowledgement, revision, content_hash, edit_version,
                    created_at, updated_at
                  )
                  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                  ON CONFLICT(id) DO NOTHING`,
            overwriteSql: `INSERT INTO content_announcements(
                    id, title, content, level, sort, is_enabled, publish_at,
                    show_fullscreen, requires_acknowledgement, revision, content_hash, edit_version,
                    created_at, updated_at
                  )
                  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                  ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title, content=excluded.content, level=excluded.level,
                    sort=excluded.sort, is_enabled=excluded.is_enabled, publish_at=excluded.publish_at,
                    show_fullscreen=excluded.show_fullscreen,
                    requires_acknowledgement=excluded.requires_acknowledgement,
                    revision=excluded.revision, content_hash=excluded.content_hash,
                    edit_version=excluded.edit_version,
                    created_at=excluded.created_at, updated_at=excluded.updated_at`,
            params: (row) => {
              const requiresAcknowledgement = backupVersion === 2
                && Number(row.requires_acknowledgement || 0) === 1;
              const showFullscreen = requiresAcknowledgement
                || (backupVersion === 2 && Number(row.show_fullscreen || 0) === 1);
              const revision = backupVersion === 2 ? Number(row.revision) : 1;
              const contentHash = backupVersion === 2
                ? String(row.content_hash).toLowerCase()
                : computeAnnouncementContentHash({
                    title: row.title,
                    content: row.content,
                    requiresAcknowledgement: false,
                  });
              return [
                row.id,
                row.title ?? '',
                row.content ?? '',
                row.level ?? 'info',
                row.sort ?? 0,
                row.is_enabled ?? 1,
                row.publish_at ?? null,
                showFullscreen ? 1 : 0,
                requiresAcknowledgement ? 1 : 0,
                revision,
                contentHash,
                row.edit_version === undefined || row.edit_version === null ? 1 : Number(row.edit_version),
                row.created_at ?? nowTs(),
                row.updated_at ?? nowTs(),
              ];
            },
          },
          {
            name: 'system_versions',
            sql: 'INSERT INTO system_versions(id, version_name, release_notes, is_enabled, publish_at, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
            params: (row) => [
              row.id,
              row.version_name ?? '',
              row.release_notes ?? null,
              row.is_enabled ?? 1,
              row.publish_at ?? null,
              row.created_at ?? nowTs(),
              row.updated_at ?? nowTs(),
            ],
          },
        ];

        for (const table of contentTables) {
          const rowsRaw = requireArray(table.name);
          const rows = rowsRaw || [];
          if (mode === 'overwrite' && rowsRaw !== null) {
            if (table.name === 'content_announcements') {
              const ids = rows.map((row) => Number(row?.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
              if (ids.length > 0) {
                const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
                await execOrThrow(
                  tx,
                  `DELETE FROM content_announcements WHERE id NOT IN (${placeholders})`,
                  ids,
                  'content_announcements overwrite delete missing',
                );
              } else {
                await execOrThrow(tx, 'DELETE FROM content_announcements', [], 'content_announcements overwrite delete all');
              }
            } else {
              await execOrThrow(tx, `DELETE FROM ${table.name}`, [], `${table.name} overwrite delete`);
            }
          }
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.id) continue;
            try {
              const sql = mode === 'overwrite' && table.overwriteSql ? table.overwriteSql : table.sql;
              // eslint-disable-next-line no-await-in-loop
              await execOrThrow(tx, sql, table.params(row), `${table.name}[${i}]`);
              count++;
            } catch (err) {
              markAndThrow(table.name, i, err);
            }
          }
          if (mode === 'overwrite' && count > 0) {
            try {
              await bumpSerial(tx, table.name);
            } catch (err) {
              markAndThrow(table.name, null, err);
            }
          }
          report[table.name] = count;
        }

        // content_announcement_revisions：v1 备份按普通公告补齐 v1 快照
        {
          const rows = backupVersion === 1
            ? (requireArray('content_announcements') || []).map((row) => ({
                announcement_id: row.id,
                revision: 1,
                title: row.title ?? '',
                content: row.content ?? '',
                requires_acknowledgement: 0,
                content_hash: computeAnnouncementContentHash({
                  title: row.title,
                  content: row.content,
                  requiresAcknowledgement: false,
                }),
                created_by: null,
                created_name: null,
                created_at: row.created_at ?? nowTs(),
              }))
            : (requireArray('content_announcement_revisions') || []);
          if (mode === 'overwrite' && requireArray('content_announcements') !== null) {
            const announcementIds = (requireArray('content_announcements') || [])
              .map((row) => Number(row?.id))
              .filter((id) => Number.isSafeInteger(id) && id > 0);
            if (announcementIds.length > 0) {
              const placeholders = announcementIds.map((_, index) => `$${index + 1}`).join(',');
              await execOrThrow(
                tx,
                `DELETE FROM content_announcement_revisions WHERE announcement_id IN (${placeholders})`,
                announcementIds,
                'content_announcement_revisions overwrite delete restored announcements',
              );
            }
          }
          let count = 0;
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row?.announcement_id || !row?.revision) continue;
            try {
              // eslint-disable-next-line no-await-in-loop
              await execOrThrow(
                tx,
                `INSERT INTO content_announcement_revisions(
                   announcement_id, revision, title, content, requires_acknowledgement,
                   content_hash, created_by, created_name, created_at
                 )
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT(announcement_id, revision) DO NOTHING`,
                [
                  row.announcement_id,
                  row.revision,
                  row.title ?? '',
                  row.content ?? '',
                  row.requires_acknowledgement ?? 0,
                  String(row.content_hash || '').toLowerCase(),
                  row.created_by ?? null,
                  row.created_name ?? null,
                  row.created_at ?? nowTs(),
                ],
                `content_announcement_revisions[${i}]`,
              );
              count++;
            } catch (err) {
              markAndThrow('content_announcement_revisions', i, err);
            }
          }
          if (mode === 'overwrite' && requireArray('content_announcements') !== null) {
            const announcementIds = (requireArray('content_announcements') || [])
              .map((row) => Number(row?.id))
              .filter((id) => Number.isSafeInteger(id) && id > 0);
            if (announcementIds.length > 0) {
              const placeholders = announcementIds.map((_, index) => `$${index + 1}`).join(',');
              await execOrThrow(
                tx,
                `DELETE FROM content_announcement_acknowledgements ack
                  WHERE ack.announcement_id IN (${placeholders})
                    AND NOT EXISTS (
                      SELECT 1
                        FROM content_announcement_revisions revision
                       WHERE revision.announcement_id = ack.announcement_id
                         AND revision.revision = ack.revision
                         AND revision.content_hash = ack.content_hash
                    )`,
                announcementIds,
                'content_announcement_acknowledgements overwrite delete incompatible',
              );
            }
          }
          report.content_announcement_revisions = count;
        }

        if (backupMode === 'full') {
          // users overwrite cascade
          // 仅当备份包含 users 数组时才清空用户链路，避免 settings/full 混用导致误删。
          {
            const rows = Array.isArray(backupData.users) ? backupData.users : null;
            if (rows && mode === 'overwrite') {
              const deleteOrder = [
                ...[...GALA_BACKUP_TABLES].reverse().map((t) => t.name),
                'admin_user_roles',
                'auction_bids',
                'auction_activities',
                'audit_logs',
                'attendance_reward_records',
                'ledger',
                'mall_order_listings',
                'redeem_cdks',
                'redeems',
                'charity_contributions',
                'user_feedback_messages',
                'user_feedback',
                'content_announcement_acknowledgements',
                'bob_tokens',
                'external_accounts',
                'accounts',
                'users',
              ];
              for (const tableName of deleteOrder) {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(tx, `DELETE FROM ${tableName}`, [], `${tableName} overwrite delete`);
              }
            }
            let count = 0;
            const userRows = rows || [];
            for (let i = 0; i < userRows.length; i++) {
              const row = userRows[i];
              if (!row?.userid) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO users(userid, name, is_admin, source, phone, created_at)
                   VALUES($1,$2,$3,$4,$5,$6)
                   ON CONFLICT(userid) DO UPDATE SET
                     name=excluded.name, is_admin=excluded.is_admin,
                     source=excluded.source, phone=excluded.phone`,
                  [
                    row.userid,
                    row.name ?? null,
                    row.is_admin ?? 0,
                    // 旧备份没有 source/phone 列时按钉钉员工恢复；外部用户保留来源与手机号。
                    String(row.source || '') === 'external' ? 'external' : 'dingtalk',
                    row.phone ? String(row.phone) : null,
                    row.created_at ?? nowTs(),
                  ],
                  `users[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('users', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'users');
            } catch (err) {
              markAndThrow('users', null, err);
            }
            if (rows) report.users = count;
          }
        }

        if (backupMode === 'full' || isSettingsRecoveryPoint) {
          // content_announcement_acknowledgements
          {
            const rows = requireArray('content_announcement_acknowledgements') || [];
            if (isSettingsRecoveryPoint) {
              await execOrThrow(
                tx,
                'DELETE FROM content_announcement_acknowledgements',
                [],
                'content_announcement_acknowledgements recovery delete',
              );
            }
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid || !row?.announcement_id || !row?.revision) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                const revisionSnapshot = await tx.get(
                  `SELECT content_hash, requires_acknowledgement
                   FROM content_announcement_revisions
                   WHERE announcement_id = ? AND revision = ?
                   LIMIT 1`,
                  [row.announcement_id, row.revision],
                );
                const contentHash = String(row.content_hash || '').toLowerCase();
                if (!revisionSnapshot || String(revisionSnapshot.content_hash || '').toLowerCase() !== contentHash) {
                  throw new Error('数据库中的公告修订与确认记录不匹配');
                }
                if (Number(revisionSnapshot.requires_acknowledgement || 0) === 1 && row.action !== 'acknowledged') {
                  throw new Error('强制确认公告不允许 dismissed');
                }
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO content_announcement_acknowledgements(
                     userid, announcement_id, revision, content_hash, action, created_at
                   )
                   VALUES($1,$2,$3,$4,$5,$6)
                   ON CONFLICT(userid, announcement_id, revision) DO UPDATE SET
                     content_hash=excluded.content_hash,
                     action=excluded.action,
                     created_at=excluded.created_at`,
                  [
                    row.userid,
                    row.announcement_id,
                    row.revision,
                    contentHash,
                    row.action,
                    row.created_at ?? nowTs(),
                  ],
                  `content_announcement_acknowledgements[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('content_announcement_acknowledgements', i, err);
              }
            }
            report.content_announcement_acknowledgements = count;
          }
        }

        if (backupMode === 'full') {
          // admin_user_roles
          {
            const rows = requireArray('admin_user_roles') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid || (!row?.role_id && !row?.role_code)) continue;
              try {
                let roleId = importedRoleIdMap.get(Number(row.role_id)) || toOptionalInt(row.role_id);
                // eslint-disable-next-line no-await-in-loop
                let role = roleId ? await tx.get('SELECT id FROM admin_roles WHERE id = ? LIMIT 1', [roleId]) : null;
                if (!role?.id && row.role_code) {
                  // eslint-disable-next-line no-await-in-loop
                  const byCode = await tx.get('SELECT id FROM admin_roles WHERE code = ? LIMIT 1', [String(row.role_code)]);
                  roleId = byCode?.id || null;
                  role = byCode;
                }
                if (!roleId) {
                  throw new Error(`无法映射 role_id=${row.role_id} role_code=${row.role_code || ''}`);
                }
                // eslint-disable-next-line no-await-in-loop
                const user = await tx.get('SELECT userid FROM users WHERE userid = ? LIMIT 1', [row.userid]);
                if (!user?.userid) {
                  throw new Error(`用户不存在: ${row.userid}`);
                }
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO admin_user_roles(userid, role_id, assigned_by, assigned_name, assigned_at)
                   VALUES($1,$2,$3,$4,$5)
                   ON CONFLICT(userid) DO UPDATE SET
                     role_id=excluded.role_id, assigned_by=excluded.assigned_by,
                     assigned_name=excluded.assigned_name, assigned_at=excluded.assigned_at`,
                  [
                    row.userid,
                    roleId,
                    row.assigned_by ?? null,
                    row.assigned_name ?? null,
                    row.assigned_at ?? nowTs(),
                  ],
                  `admin_user_roles[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('admin_user_roles', i, err);
              }
            }
            report.admin_user_roles = count;
          }

          // accounts
          {
            const rows = requireArray('accounts') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  'INSERT INTO accounts(userid, balance, updated_at) VALUES($1,$2,$3) ON CONFLICT(userid) DO UPDATE SET balance=excluded.balance, updated_at=excluded.updated_at',
                  [row.userid, row.balance ?? 0, row.updated_at ?? nowTs()],
                  `accounts[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('accounts', i, err);
              }
            }
            report.accounts = count;
          }

          // external_accounts（对外活动账号凭据）
          // 必须与 users 同批恢复：只恢复 users 会留下「有余额但无法登录、且手机号唯一挡住重新注册」的账号。
          // 旧备份没有外部用户时可省略该数组；覆盖导入仍按 users 的快照恢复。
          {
            const rows = requireArray('external_accounts') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid || !row?.phone || !row?.password_hash || !row?.password_salt) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO external_accounts(
                     userid, phone, name, password_hash, password_salt, status, batch_id,
                     failed_count, locked_until, last_login_at, created_at, updated_at
                   ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                   ON CONFLICT(userid) DO UPDATE SET
                     phone=excluded.phone, name=excluded.name,
                     password_hash=excluded.password_hash, password_salt=excluded.password_salt,
                     status=excluded.status, batch_id=excluded.batch_id,
                     failed_count=excluded.failed_count, locked_until=excluded.locked_until,
                     last_login_at=excluded.last_login_at, updated_at=excluded.updated_at`,
                  [
                    row.userid,
                    String(row.phone),
                    row.name ?? '',
                    String(row.password_hash),
                    String(row.password_salt),
                    row.status ?? 'active',
                    row.batch_id ?? '',
                    Number.isFinite(Number(row.failed_count)) ? Number(row.failed_count) : 0,
                    row.locked_until ?? null,
                    row.last_login_at ?? null,
                    row.created_at ?? nowTs(),
                    row.updated_at ?? nowTs(),
                  ],
                  `external_accounts[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('external_accounts', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'external_accounts');
            } catch (err) {
              markAndThrow('external_accounts', null, err);
            }
            report.external_accounts = count;
          }

          // bob_tokens
          {
            const rows = requireArray('bob_tokens') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.token_hash) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO bob_tokens(id, token, token_hash, created_at, revoked_at)
                   VALUES($1,$2,$3,$4,$5) ON CONFLICT(token_hash) DO NOTHING`,
                  [
                    row.id ?? null,
                    row.token ?? null,
                    row.token_hash,
                    row.created_at ?? nowTs(),
                    row.revoked_at ?? null,
                  ],
                  `bob_tokens[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('bob_tokens', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'bob_tokens');
            } catch (err) {
              markAndThrow('bob_tokens', null, err);
            }
            report.bob_tokens = count;
          }

          // ledger
          {
            const rows = requireArray('ledger') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid || !row?.id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  'INSERT INTO ledger(id, userid, delta, reason, ref_id, created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
                  [row.id, row.userid, row.delta, row.reason ?? '', row.ref_id ?? null, row.created_at ?? nowTs()],
                  `ledger[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('ledger', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'ledger');
            } catch (err) {
              markAndThrow('ledger', null, err);
            }
            report.ledger = count;
          }

          // redeems
          {
            const rows = requireArray('redeems') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.exchange_id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO redeems(id, exchange_id, userid, product_id, product_name, bob_amount, fulfilled_at, fulfilled_by, fulfilled_name, hidden, limit_round, created_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(exchange_id) DO NOTHING`,
                  [
                    row.id ?? null,
                    row.exchange_id,
                    row.userid,
                    row.product_id,
                    row.product_name ?? null,
                    row.bob_amount,
                    row.fulfilled_at ?? null,
                    row.fulfilled_by ?? null,
                    row.fulfilled_name ?? null,
                    row.hidden ?? 0,
                    row.limit_round ?? 1,
                    row.created_at ?? nowTs(),
                  ],
                  `redeems[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('redeems', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'redeems');
            } catch (err) {
              markAndThrow('redeems', null, err);
            }
            report.redeems = count;
          }

          // mall_order_listings
          {
            const rows = requireArray('mall_order_listings') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.listing_id || !row?.exchange_id || !row?.seller_userid) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO mall_order_listings(id, listing_id, exchange_id, seller_userid, seller_name_snapshot, buyer_userid, buyer_name_snapshot, price, seller_note, status, created_at, updated_at, sold_at, cancelled_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                   ON CONFLICT(listing_id) DO NOTHING`,
                  [
                    row.id ?? null,
                    row.listing_id,
                    row.exchange_id,
                    row.seller_userid,
                    row.seller_name_snapshot ?? null,
                    row.buyer_userid ?? null,
                    row.buyer_name_snapshot ?? null,
                    row.price ?? 0,
                    row.seller_note ?? null,
                    row.status ?? 'active',
                    row.created_at ?? nowTs(),
                    row.updated_at ?? nowTs(),
                    row.sold_at ?? null,
                    row.cancelled_at ?? null,
                  ],
                  `mall_order_listings[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('mall_order_listings', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'mall_order_listings');
            } catch (err) {
              markAndThrow('mall_order_listings', null, err);
            }
            report.mall_order_listings = count;
          }

          // redeem_cdks
          {
            const rows = requireArray('redeem_cdks') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.cdk_code) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO redeem_cdks(id, batch_id, cdk_code, product_id, product_name, product_bob_amount, status, created_by, created_name, created_at, redeemed_by, redeemed_name, redeemed_at, redeem_exchange_id)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(cdk_code) DO NOTHING`,
                  [
                    row.id ?? null,
                    row.batch_id ?? '',
                    row.cdk_code,
                    row.product_id ?? '',
                    row.product_name ?? '',
                    row.product_bob_amount ?? 0,
                    row.status ?? 'unused',
                    row.created_by ?? null,
                    row.created_name ?? null,
                    row.created_at ?? nowTs(),
                    row.redeemed_by ?? null,
                    row.redeemed_name ?? null,
                    row.redeemed_at ?? null,
                    row.redeem_exchange_id ?? null,
                  ],
                  `redeem_cdks[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('redeem_cdks', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'redeem_cdks');
            } catch (err) {
              markAndThrow('redeem_cdks', null, err);
            }
            report.redeem_cdks = count;
          }

          // charity_contributions
          {
            const rows = requireArray('charity_contributions') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id || !row?.project_id || !row?.userid) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO charity_contributions(id, project_id, userid, user_name_snapshot, bob_amount, created_at)
                   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.project_id,
                    row.userid,
                    row.user_name_snapshot ?? null,
                    row.bob_amount ?? 0,
                    row.created_at ?? nowTs(),
                  ],
                  `charity_contributions[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('charity_contributions', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'charity_contributions');
            } catch (err) {
              markAndThrow('charity_contributions', null, err);
            }
            report.charity_contributions = count;
          }

          // attendance_reward_records
          {
            const rows = requireArray('attendance_reward_records') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.userid || !row?.work_date || !row?.check_time_ms) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO attendance_reward_records(id, userid, user_name_snapshot, work_date, check_time_ms, check_time_text, check_type, source_type, time_result, event_source, status, skip_reason, reward_amount, reward_reason, notify_status, error_message, created_at, updated_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                   ON CONFLICT(userid, work_date, check_time_ms) DO NOTHING`,
                  [
                    row.id ?? null,
                    row.userid,
                    row.user_name_snapshot ?? null,
                    row.work_date,
                    row.check_time_ms,
                    row.check_time_text ?? null,
                    row.check_type ?? null,
                    row.source_type ?? null,
                    row.time_result ?? null,
                    row.event_source ?? 'stream',
                    row.status ?? 'pending',
                    row.skip_reason ?? null,
                    row.reward_amount ?? null,
                    row.reward_reason ?? null,
                    row.notify_status ?? null,
                    row.error_message ?? null,
                    row.created_at ?? nowTs(),
                    row.updated_at ?? nowTs(),
                  ],
                  `attendance_reward_records[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('attendance_reward_records', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'attendance_reward_records');
            } catch (err) {
              markAndThrow('attendance_reward_records', null, err);
            }
            report.attendance_reward_records = count;
          }

          // user_feedback
          {
            const rowsRaw = requireArray('user_feedback');
            const rows = rowsRaw || [];
            if (mode === 'overwrite' && rowsRaw !== null) {
              // users 段已清空时这里是 no-op；若备份未含 users，仍需确保反馈表可完整覆盖。
              await execOrThrow(tx, 'DELETE FROM user_feedback_messages', [], 'user_feedback_messages overwrite delete');
              await execOrThrow(tx, 'DELETE FROM user_feedback', [], 'user_feedback overwrite delete');
            }
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id || !row?.userid) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO user_feedback(id, userid, name, category, content, contact, status, reply, handled_by, handled_name, handled_at, created_at, updated_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.userid,
                    row.name ?? null,
                    row.category ?? 'suggestion',
                    row.content,
                    row.contact ?? null,
                    row.status ?? 'pending',
                    row.reply ?? null,
                    row.handled_by ?? null,
                    row.handled_name ?? null,
                    row.handled_at ?? null,
                    row.created_at ?? nowTs(),
                    row.updated_at ?? nowTs(),
                  ],
                  `user_feedback[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('user_feedback', i, err);
              }
            }
            if (mode === 'overwrite' && count > 0) {
              try {
                await bumpSerial(tx, 'user_feedback');
              } catch (err) {
                markAndThrow('user_feedback', null, err);
              }
            }
            report.user_feedback = count;
          }

          // user_feedback_messages
          {
            const rows = requireArray('user_feedback_messages') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id || !row?.feedback_id || !row?.content) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO user_feedback_messages(id, feedback_id, sender_type, sender_id, sender_name, content, created_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.feedback_id,
                    row.sender_type ?? 'user',
                    row.sender_id ?? null,
                    row.sender_name ?? null,
                    row.content,
                    row.created_at ?? nowTs(),
                  ],
                  `user_feedback_messages[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('user_feedback_messages', i, err);
              }
            }
            if (mode === 'overwrite' && count > 0) {
              try {
                await bumpSerial(tx, 'user_feedback_messages');
              } catch (err) {
                markAndThrow('user_feedback_messages', null, err);
              }
            }
            report.user_feedback_messages = count;
          }

          // audit_logs
          {
            const rows = requireArray('audit_logs') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id || !row?.event_type) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO audit_logs(id, event_type, actor_type, actor_id, actor_name, ip, method, path, status_code, message, payload, created_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.event_type,
                    row.actor_type ?? null,
                    row.actor_id ?? null,
                    row.actor_name ?? null,
                    row.ip ?? null,
                    row.method ?? null,
                    row.path ?? null,
                    row.status_code ?? null,
                    row.message ?? null,
                    row.payload ?? null,
                    row.created_at ?? nowTs(),
                  ],
                  `audit_logs[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('audit_logs', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'audit_logs');
            } catch (err) {
              markAndThrow('audit_logs', null, err);
            }
            report.audit_logs = count;
          }

          // red packet
          {
            const activityRowsRaw = requireArray('red_packet_activity');
            const itemRowsRaw = requireArray('red_packet_items');
            if (mode === 'overwrite' && (activityRowsRaw !== null || itemRowsRaw !== null)) {
              await execOrThrow(tx, 'DELETE FROM red_packet_items', [], 'red_packet_items overwrite delete');
              await execOrThrow(tx, 'DELETE FROM red_packet_activity', [], 'red_packet_activity overwrite delete');
            }
          }
          {
            const rows = requireArray('red_packet_activity') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO red_packet_activity(id, total_amount, total_count, countdown_seconds, duration_minutes, start_at, end_at, status, sponsor, created_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.total_amount,
                    row.total_count,
                    row.countdown_seconds,
                    row.duration_minutes,
                    row.start_at,
                    row.end_at,
                    row.status ?? 'ended',
                    row.sponsor ?? null,
                    row.created_at ?? nowTs(),
                  ],
                  `red_packet_activity[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('red_packet_activity', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'red_packet_activity');
            } catch (err) {
              markAndThrow('red_packet_activity', null, err);
            }
            report.red_packet_activity = count;
          }
          {
            const rows = requireArray('red_packet_items') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.activity_id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO red_packet_items(id, activity_id, amount, claimed_by, claimed_at)
                   VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
                  [row.id, row.activity_id, row.amount, row.claimed_by ?? null, row.claimed_at ?? null],
                  `red_packet_items[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('red_packet_items', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'red_packet_items');
            } catch (err) {
              markAndThrow('red_packet_items', null, err);
            }
            report.red_packet_items = count;
          }

          // auction（活动为父、出价为子；auction_bids FK→auction_activities）
          // merge 模式下拍卖资金无法安全对账，任何 ID 冲突都直接拒绝、回滚整个导入：
          // - 活动 ID 冲突：父行会被 ON CONFLICT DO NOTHING 跳过，其出价却挂到目标库不相关活动上；
          // - 出价 ID 冲突：出价被 DO NOTHING 跳过，而新活动仍保留指向该出价的 current_bid_id，
          //   结算按 id 查出价时不约束 activity_id，可能把目标库不相关的出价当成获胜者。
          if (mode !== 'overwrite') {
            const activityRows = requireArray('auction_activities') || [];
            const activityIds = [...new Set(activityRows.map((r) => Number(r?.id)).filter((n) => Number.isFinite(n) && n > 0))];
            if (activityIds.length) {
              const rows = await tx.all(
                `SELECT id FROM auction_activities WHERE id IN (${activityIds.map(() => '?').join(',')})`,
                activityIds,
              );
              if (rows.length) {
                throw new Error(`合并导入存在拍卖活动 ID 冲突（${rows.map((r) => r.id).join(', ')}）：为避免出价挂到不相关活动，已拒绝导入`);
              }
            }
            const bidRows = requireArray('auction_bids') || [];
            const bidIds = [...new Set(bidRows.map((r) => Number(r?.id)).filter((n) => Number.isFinite(n) && n > 0))];
            if (bidIds.length) {
              const rows = await tx.all(
                `SELECT id FROM auction_bids WHERE id IN (${bidIds.map(() => '?').join(',')})`,
                bidIds,
              );
              if (rows.length) {
                throw new Error(`合并导入存在拍卖出价 ID 冲突（${rows.map((r) => r.id).join(', ')}）：为避免结算命中不相关出价，已拒绝导入`);
              }
            }
          }
          {
            const activityRowsRaw = requireArray('auction_activities');
            const bidRowsRaw = requireArray('auction_bids');
            if (mode === 'overwrite' && (activityRowsRaw !== null || bidRowsRaw !== null)) {
              await execOrThrow(tx, 'DELETE FROM auction_bids', [], 'auction_bids overwrite delete');
              await execOrThrow(tx, 'DELETE FROM auction_activities', [], 'auction_activities overwrite delete');
            }
          }
          {
            const rows = requireArray('auction_activities') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO auction_activities(id, title, description, image_url, start_price, min_increment, start_at, end_at, anti_snipe_seconds, status, current_price, current_bid_userid, current_bid_id, bid_count, winner_userid, winner_name, final_price, settled_at, cancelled_at, cancel_reason, created_by, created_name, created_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.title,
                    row.description ?? null,
                    row.image_url ?? null,
                    row.start_price,
                    row.min_increment,
                    row.start_at,
                    row.end_at,
                    row.anti_snipe_seconds ?? 0,
                    row.status ?? 'scheduled',
                    row.current_price ?? null,
                    row.current_bid_userid ?? null,
                    row.current_bid_id ?? null,
                    row.bid_count ?? 0,
                    row.winner_userid ?? null,
                    row.winner_name ?? null,
                    row.final_price ?? null,
                    row.settled_at ?? null,
                    row.cancelled_at ?? null,
                    row.cancel_reason ?? null,
                    row.created_by ?? null,
                    row.created_name ?? null,
                    row.created_at ?? nowTs(),
                  ],
                  `auction_activities[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('auction_activities', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'auction_activities');
            } catch (err) {
              markAndThrow('auction_activities', null, err);
            }
            report.auction_activities = count;
          }
          {
            const rows = requireArray('auction_bids') || [];
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
              const row = rows[i];
              if (!row?.id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(
                  tx,
                  `INSERT INTO auction_bids(id, activity_id, userid, user_name_snapshot, amount, state, created_at, settled_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
                  [
                    row.id,
                    row.activity_id,
                    row.userid,
                    row.user_name_snapshot ?? null,
                    row.amount,
                    row.state ?? 'held',
                    row.created_at ?? nowTs(),
                    row.settled_at ?? null,
                  ],
                  `auction_bids[${i}]`,
                );
                count++;
              } catch (err) {
                markAndThrow('auction_bids', i, err);
              }
            }
            try {
              await bumpSerial(tx, 'auction_bids');
            } catch (err) {
              markAndThrow('auction_bids', null, err);
            }
            report.auction_bids = count;
          }

          // 年会（父表在前）。merge 模式任何 ID 冲突都拒绝：中奖记录的 awarded_at 是发币幂等闸门，
          // 挂到目标库不相关的轮次或奖池上会造成重复发币或奖池账目错乱。
          {
            const hasGala = GALA_BACKUP_TABLES.some((t) => requireArray(t.name) !== null);
            if (hasGala && mode !== 'overwrite') {
              for (const table of GALA_BACKUP_TABLES) {
                const ids = [...new Set((requireArray(table.name) || []).map((r) => Number(r?.id)).filter((n) => Number.isFinite(n) && n > 0))];
                if (!ids.length) continue;
                // eslint-disable-next-line no-await-in-loop
                const rows = await tx.all(`SELECT id FROM ${table.name} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
                if (rows.length) {
                  throw new Error(`合并导入存在年会数据 ID 冲突（${table.name}: ${rows.map((r) => r.id).join(', ')}），已拒绝导入`);
                }
              }
            }
            if (hasGala && mode === 'overwrite') {
              for (const table of [...GALA_BACKUP_TABLES].reverse()) {
                // eslint-disable-next-line no-await-in-loop
                await execOrThrow(tx, `DELETE FROM ${table.name}`, [], `${table.name} overwrite delete`);
              }
            }
            for (const table of GALA_BACKUP_TABLES) {
              const rows = requireArray(table.name) || [];
              let count = 0;
              const placeholders = table.columns.map((_, i) => `$${i + 1}`).join(',');
              for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (!row?.id) continue;
                try {
                  // eslint-disable-next-line no-await-in-loop
                  await execOrThrow(
                    tx,
                    `INSERT INTO ${table.name}(${table.columns.join(', ')}) VALUES(${placeholders}) ON CONFLICT(id) DO NOTHING`,
                    table.columns.map((col) => (row[col] === undefined ? (table.defaults?.[col] ?? null) : row[col])),
                    `${table.name}[${i}]`,
                  );
                  count++;
                } catch (err) {
                  markAndThrow(table.name, i, err);
                }
              }
              if (rows.length) {
                try {
                  // eslint-disable-next-line no-await-in-loop
                  await bumpSerial(tx, table.name);
                } catch (err) {
                  markAndThrow(table.name, null, err);
                }
              }
              report[table.name] = count;
            }
          }
        }

        // 防御：事务内若有未统计表也算成功报告
        report._failedTable = failedTable;
        report._failedIndex = failedIndex;
        return report;
      });

      // 清理内部字段
      delete report._failedTable;
      delete report._failedIndex;

      await appendBackupHistory(db, req, {
        action: '导入',
        mode,
        filename: requestedFilename,
        status: '完成',
        details: {
          backupMode,
          report,
          recoveryPoint,
        },
      });
      publishMallRealtimeFullRefresh('backup_import');
      return res.json({
        ok: true,
        mode,
        backupMode,
        report,
        recoveryPoint,
      });
    } catch (err) {
      const message = String(err?.message || err);
      // 从错误消息解析失败表/行
      let failedTable = null;
      let failedIndex = null;
      const m = message.match(/@([a-z_]+)(?:\[(\d+)\])?/i);
      if (m) {
        failedTable = m[1];
        failedIndex = m[2] == null ? null : Number(m[2]);
      }
      await failHistory('失败', {
        reason: 'import_transaction_failed',
        message,
        backupMode,
        mode,
        failedTable,
        failedIndex,
        recoveryPoint,
      });
      return res.status(500).json({
        ok: false,
        error: message,
        mode,
        backupMode,
        failedTable,
        failedIndex,
        recoveryPoint,
      });
    }
  });


}
