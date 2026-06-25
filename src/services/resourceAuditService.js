import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IGNORE_KEY = 'resource_audit_ignored_paths';

const MEDIA_EXTENSIONS = new Map([
  ['.jpg', 'image'], ['.jpeg', 'image'], ['.png', 'image'], ['.webp', 'image'], ['.gif', 'image'], ['.svg', 'image'], ['.avif', 'image'], ['.ico', 'image'],
  ['.mp3', 'audio'], ['.wav', 'audio'], ['.m4a', 'audio'], ['.aac', 'audio'], ['.ogg', 'audio'], ['.flac', 'audio'],
  ['.mp4', 'video'], ['.webm', 'video'], ['.mov', 'video'], ['.m4v', 'video'],
]);

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.html', '.css', '.scss', '.md', '.txt', '.vue',
]);

const SKIP_DIRS = new Set([
  '.git', '.cache', '.vite', 'node_modules', 'coverage', '.DS_Store',
]);

const SKIP_RELATIVE_DIRS = new Set([
  'src/pages/admin-app-dist',
]);

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function toPosix(value) {
  return String(value || '').split(path.sep).join('/');
}

function isSkippedDir(fullPath) {
  const name = path.basename(fullPath);
  if (SKIP_DIRS.has(name)) return true;
  const rel = toPosix(path.relative(PROJECT_ROOT, fullPath));
  return SKIP_RELATIVE_DIRS.has(rel);
}

function typeFromExt(ext) {
  return MEDIA_EXTENSIONS.get(String(ext || '').toLowerCase()) || 'other';
}

async function walk(dir, visitor) {
  if (!existsSync(dir) || isSkippedDir(dir)) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, visitor);
    } else if (entry.isFile()) {
      await visitor(full);
    }
  }
}

async function collectMediaFiles() {
  const files = [];
  await walk(PROJECT_ROOT, async (full) => {
    const ext = path.extname(full).toLowerCase();
    const type = typeFromExt(ext);
    if (type === 'other') return;
    const stat = await fs.stat(full);
    const rel = toPosix(path.relative(PROJECT_ROOT, full));
    files.push({
      path: rel,
      name: path.basename(full),
      ext,
      type,
      size: Number(stat.size || 0),
      modified_at: Math.floor(Number(stat.mtimeMs || 0) / 1000),
    });
  });
  return files;
}

async function collectTextCorpus() {
  const chunks = [];
  await walk(PROJECT_ROOT, async (full) => {
    const ext = path.extname(full).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return;
    try {
      const stat = await fs.stat(full);
      if (Number(stat.size || 0) > 1024 * 1024) return;
      chunks.push(await fs.readFile(full, 'utf8'));
    } catch {
      // ignore unreadable files
    }
  });
  return chunks.join('\n');
}

async function collectDbReferenceText(db) {
  if (!db) return '';
  const parts = [];
  const safeAll = async (sql) => {
    try {
      return await db.all(sql);
    } catch {
      return [];
    }
  };
  const rows = [
    ...await safeAll('SELECT image_url FROM mall_products'),
    ...await safeAll('SELECT cover_image_url, summary, rules_text, execution_note FROM charity_projects'),
    ...await safeAll('SELECT answer FROM content_faq'),
    ...await safeAll('SELECT content FROM content_announcements'),
    ...await safeAll('SELECT value FROM system_settings'),
  ];
  for (const row of rows) {
    for (const value of Object.values(row || {})) {
      if (value !== null && value !== undefined) parts.push(String(value));
    }
  }
  return parts.join('\n');
}

async function getIgnoredPaths(db) {
  if (!db) return [];
  const row = await db.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', [IGNORE_KEY]);
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(String(row.value));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function saveIgnoredResourcePaths(db, paths = []) {
  const unique = [...new Set((Array.isArray(paths) ? paths : []).map((item) => toPosix(item).trim()).filter(Boolean))].slice(0, 1000);
  await db.exec(
    'INSERT INTO system_settings(key, value, updated_at) VALUES(?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()',
    [IGNORE_KEY, JSON.stringify(unique)],
  );
  return unique;
}

function isReferenced(file, corpus) {
  const rel = toPosix(file.path);
  const basename = file.name;
  const publicPath = rel.startsWith('src/pages') ? rel.slice('src/pages'.length) : '';
  return corpus.includes(rel) || corpus.includes(`/${rel}`) || (publicPath && corpus.includes(publicPath)) || corpus.includes(basename);
}

function riskFor(file) {
  if (file.path.includes('/uploads/originals/')) return '低';
  if (file.path.includes('/uploads/')) return '中';
  if (file.path.startsWith('src/pages/assets/')) return '高';
  return '中';
}

function summarize(files, unused) {
  const byType = {};
  let totalSize = 0;
  let unusedSize = 0;
  for (const file of files) {
    totalSize += file.size;
    byType[file.type] = byType[file.type] || { type: file.type, count: 0, size: 0 };
    byType[file.type].count += 1;
    byType[file.type].size += file.size;
  }
  for (const file of unused) unusedSize += file.size;
  return {
    total: files.length,
    totalSize,
    unused: unused.length,
    unusedSize,
    byType: Object.values(byType),
  };
}

export async function scanResources(db) {
  const [files, textCorpus, dbCorpus, ignoredPaths] = await Promise.all([
    collectMediaFiles(),
    collectTextCorpus(),
    collectDbReferenceText(db),
    getIgnoredPaths(db),
  ]);
  const ignored = new Set(ignoredPaths);
  const corpus = `${textCorpus}\n${dbCorpus}`;
  const enriched = files.map((file) => {
    const referenced = isReferenced(file, corpus);
    const ignoredFile = ignored.has(file.path);
    return {
      ...file,
      referenced,
      ignored: ignoredFile,
      status: ignoredFile ? '已忽略' : referenced ? '使用中' : '疑似未使用',
      risk: referenced ? '-' : riskFor(file),
      suggestion: referenced ? '保留' : ignoredFile ? '已标记忽略' : '建议人工确认后清理',
    };
  });
  const unused = enriched.filter((file) => !file.referenced && !file.ignored).sort((a, b) => b.size - a.size);
  return {
    scannedAt: nowTs(),
    root: PROJECT_ROOT,
    summary: summarize(enriched, unused),
    files: enriched.sort((a, b) => b.size - a.size),
    unused,
    ignored: ignoredPaths,
  };
}
