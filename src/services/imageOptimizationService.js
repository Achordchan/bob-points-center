import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const UPLOAD_ROOT = fileURLToPath(new URL('../pages/assets/uploads/', import.meta.url));
const UPLOAD_PREFIX = '/assets/uploads';
const IMAGE_SETTINGS_KEY = 'image_optimization_settings';
const IMAGE_JOB_KEY = 'image_optimization_last_job';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

const DEFAULT_IMAGE_SETTINGS = {
  enabled: true,
  quality: 82,
  maxWidth: 1600,
  maxHeight: 1600,
  keepOriginal: false,
};

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function toBool(value, fallback) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  const text = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  if (!text) return fallback;
  return ['true', 'yes', 'on'].includes(text);
}

function toBoundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeImageOptimizationSettings(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    enabled: toBool(src.enabled, DEFAULT_IMAGE_SETTINGS.enabled),
    quality: toBoundedInt(src.quality, DEFAULT_IMAGE_SETTINGS.quality, 60, 95),
    maxWidth: toBoundedInt(src.maxWidth, DEFAULT_IMAGE_SETTINGS.maxWidth, 320, 4096),
    maxHeight: toBoundedInt(src.maxHeight, DEFAULT_IMAGE_SETTINGS.maxHeight, 320, 4096),
    keepOriginal: toBool(src.keepOriginal, DEFAULT_IMAGE_SETTINGS.keepOriginal),
  };
}

export async function getImageOptimizationSettings(db) {
  if (!db) return { ...DEFAULT_IMAGE_SETTINGS };
  const row = await db.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', [IMAGE_SETTINGS_KEY]);
  if (!row?.value) return { ...DEFAULT_IMAGE_SETTINGS };
  try {
    return normalizeImageOptimizationSettings(JSON.parse(String(row.value)));
  } catch {
    return { ...DEFAULT_IMAGE_SETTINGS };
  }
}

export async function saveImageOptimizationSettings(db, input) {
  const settings = normalizeImageOptimizationSettings(input);
  await db.exec(
    'INSERT INTO system_settings(key, value, updated_at) VALUES(?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()',
    [IMAGE_SETTINGS_KEY, JSON.stringify(settings)],
  );
  return settings;
}

async function readLastJob(db) {
  if (!db) return null;
  const row = await db.get('SELECT value FROM system_settings WHERE key = ? LIMIT 1', [IMAGE_JOB_KEY]);
  if (!row?.value) return null;
  try {
    return JSON.parse(String(row.value));
  } catch {
    return null;
  }
}

async function saveLastJob(db, job) {
  await db.exec(
    'INSERT INTO system_settings(key, value, updated_at) VALUES(?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()',
    [IMAGE_JOB_KEY, JSON.stringify(job)],
  );
}

function parseDataUrl(value) {
  const text = String(value || '').trim();
  const matched = text.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!matched) return null;
  return {
    mime: matched[1].toLowerCase(),
    buffer: Buffer.from(matched[2], 'base64'),
  };
}

function extFromMime(mime) {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/avif') return '.avif';
  return '.img';
}

function publicUrlFromFile(filePath) {
  const rel = path.relative(UPLOAD_ROOT, filePath).split(path.sep).join('/');
  return `${UPLOAD_PREFIX}/${rel}`;
}

function fileFromPublicUrl(url) {
  const text = String(url || '').trim().split('?')[0];
  if (!text.startsWith(`${UPLOAD_PREFIX}/`)) return null;
  const rel = decodeURIComponent(text.slice(`${UPLOAD_PREFIX}/`.length));
  const full = path.resolve(UPLOAD_ROOT, rel);
  if (!full.startsWith(path.resolve(UPLOAD_ROOT))) return null;
  return full;
}

function isWebpRef(value) {
  const text = String(value || '').trim().toLowerCase();
  return text.startsWith('data:image/webp;') || text.split('?')[0].endsWith('.webp');
}

function isImageUrl(value) {
  const text = String(value || '').trim().toLowerCase().split('?')[0];
  if (text.startsWith('data:image/')) return true;
  return Array.from(IMAGE_EXTENSIONS).some((ext) => text.endsWith(ext));
}

async function ensureUploadDir(subdir = 'images') {
  const date = new Date();
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const dir = path.join(UPLOAD_ROOT, subdir, ymd);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeOriginal(buffer, mime, hash) {
  const dir = await ensureUploadDir('originals');
  const file = path.join(dir, `${hash}${extFromMime(mime)}`);
  await fs.writeFile(file, buffer);
  return publicUrlFromFile(file);
}

async function convertBufferToWebp(buffer, settings) {
  return await sharp(buffer)
    .rotate()
    .resize({ width: settings.maxWidth, height: settings.maxHeight, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: settings.quality })
    .toBuffer();
}

async function writeWebp(buffer, settings) {
  const output = await convertBufferToWebp(buffer, settings);
  const hash = crypto.createHash('sha256').update(output).digest('hex').slice(0, 24);
  const dir = await ensureUploadDir('images');
  const file = path.join(dir, `${hash}.webp`);
  if (!existsSync(file)) await fs.writeFile(file, output);
  return { url: publicUrlFromFile(file), bytes: output.length, hash };
}

export async function optimizeUploadedImage(db, input = {}) {
  const data = parseDataUrl(input.image || input.dataUrl);
  if (!data?.buffer?.length) throw new Error('无效的图片数据');
  const settings = await getImageOptimizationSettings(db);
  const originalBytes = data.buffer.length;

  if (!settings.enabled) {
    const hash = crypto.createHash('sha256').update(data.buffer).digest('hex').slice(0, 24);
    const originalUrl = await writeOriginal(data.buffer, data.mime, hash);
    return { url: originalUrl, converted: false, originalBytes, optimizedBytes: originalBytes, message: '图片已上传' };
  }

  const result = await writeWebp(data.buffer, settings);
  let originalUrl = '';
  if (settings.keepOriginal) originalUrl = await writeOriginal(data.buffer, data.mime, result.hash);
  return {
    url: result.url,
    originalUrl,
    converted: true,
    originalBytes,
    optimizedBytes: result.bytes,
    savedBytes: Math.max(0, originalBytes - result.bytes),
    message: '图片已转为 WebP',
  };
}

function extractImageSources(html) {
  const text = String(html || '');
  const out = [];
  const re = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let match = re.exec(text);
  while (match) {
    if (match[1]) out.push(match[1]);
    match = re.exec(text);
  }
  return out;
}

async function collectDbRefs(db) {
  const refs = [];
  const products = await db.all('SELECT product_id, image_url FROM mall_products WHERE image_url IS NOT NULL AND image_url <> ?', ['']);
  for (const row of products || []) {
    refs.push({ type: 'field', table: 'mall_products', idField: 'product_id', id: row.product_id, column: 'image_url', value: String(row.image_url || '') });
  }

  const projects = await db.all('SELECT project_id, cover_image_url, summary, rules_text, execution_note FROM charity_projects', []);
  for (const row of projects || []) {
    if (row.cover_image_url) refs.push({ type: 'field', table: 'charity_projects', idField: 'project_id', id: row.project_id, column: 'cover_image_url', value: String(row.cover_image_url || '') });
    for (const column of ['summary', 'rules_text', 'execution_note']) {
      for (const src of extractImageSources(row[column])) {
        refs.push({ type: 'html', table: 'charity_projects', idField: 'project_id', id: row.project_id, column, value: src });
      }
    }
  }

  const faqRows = await db.all('SELECT id, answer FROM content_faq', []);
  for (const row of faqRows || []) {
    for (const src of extractImageSources(row.answer)) refs.push({ type: 'html', table: 'content_faq', idField: 'id', id: row.id, column: 'answer', value: src });
  }

  const announcementRows = await db.all('SELECT id, content FROM content_announcements', []);
  for (const row of announcementRows || []) {
    for (const src of extractImageSources(row.content)) refs.push({ type: 'html', table: 'content_announcements', idField: 'id', id: row.id, column: 'content', value: src });
  }
  return refs.filter((ref) => isImageUrl(ref.value));
}

async function listUploadFiles(dir = UPLOAD_ROOT) {
  const out = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await listUploadFiles(full));
      if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  } catch {
    return out;
  }
  return out;
}

function refKey(ref) {
  return `${ref.table}:${ref.column}:${ref.id}:${ref.value}`;
}

function summarizeRefs(refs, uploadFiles) {
  const uniqueRefValues = new Set(refs.map((ref) => String(ref.value || '').trim()).filter(Boolean));
  const fileUrls = new Set(uploadFiles.map(publicUrlFromFile));
  let converted = 0;
  let pending = 0;
  let external = 0;

  for (const value of uniqueRefValues) {
    if (isWebpRef(value)) converted += 1;
    else if (parseDataUrl(value) || fileFromPublicUrl(value)) pending += 1;
    else external += 1;
  }
  for (const url of fileUrls) {
    if (uniqueRefValues.has(url)) continue;
    if (isWebpRef(url)) converted += 1;
    else pending += 1;
  }
  return {
    total: uniqueRefValues.size + Array.from(fileUrls).filter((url) => !uniqueRefValues.has(url)).length,
    converted,
    pending,
    external,
  };
}

export async function getImageOptimizationOverview(db) {
  const [settings, refs, uploadFiles, lastJob] = await Promise.all([
    getImageOptimizationSettings(db),
    collectDbRefs(db),
    listUploadFiles(),
    readLastJob(db),
  ]);
  return {
    settings,
    stats: summarizeRefs(refs, uploadFiles),
    lastJob,
  };
}

async function replaceDbRef(db, ref, nextValue) {
  if (ref.type === 'field') {
    await db.exec(`UPDATE ${ref.table} SET ${ref.column} = ?, updated_at = unixepoch() WHERE ${ref.idField} = ?`, [nextValue, ref.id]);
    return;
  }
  const row = await db.get(`SELECT ${ref.column} FROM ${ref.table} WHERE ${ref.idField} = ? LIMIT 1`, [ref.id]);
  const current = String(row?.[ref.column] || '');
  if (!current) return;
  const next = current.split(ref.value).join(nextValue);
  await db.exec(`UPDATE ${ref.table} SET ${ref.column} = ?, updated_at = unixepoch() WHERE ${ref.idField} = ?`, [next, ref.id]);
}

async function convertRef(db, ref, settings) {
  const value = String(ref.value || '').trim();
  if (!value || isWebpRef(value)) return { skipped: true };
  const data = parseDataUrl(value);
  if (data?.buffer?.length) {
    const result = await writeWebp(data.buffer, settings);
    await replaceDbRef(db, ref, result.url);
    return { ok: true, url: result.url };
  }
  const sourceFile = fileFromPublicUrl(value);
  if (sourceFile && existsSync(sourceFile)) {
    const buffer = await fs.readFile(sourceFile);
    const result = await writeWebp(buffer, settings);
    await replaceDbRef(db, ref, result.url);
    return { ok: true, url: result.url };
  }
  return { skipped: true, reason: '不支持的图片来源' };
}

export async function runImageOptimizationBatch(db, { mode = 'pending' } = {}) {
  const settings = await getImageOptimizationSettings(db);
  const refs = await collectDbRefs(db);
  const targets = refs
    .filter((ref) => !isWebpRef(ref.value))
    .filter((ref) => parseDataUrl(ref.value) || fileFromPublicUrl(ref.value));
  const unique = Array.from(new Map(targets.map((ref) => [refKey(ref), ref])).values());
  const job = { mode, startedAt: nowTs(), total: unique.length, success: 0, skipped: 0, failed: 0, errors: [] };

  if (!settings.enabled) {
    job.endedAt = nowTs();
    job.errors.push('图片优化已关闭');
    await saveLastJob(db, job);
    return job;
  }

  for (const ref of unique) {
    try {
      const result = await convertRef(db, ref, settings);
      if (result.ok) job.success += 1;
      else job.skipped += 1;
    } catch (err) {
      job.failed += 1;
      job.errors.push(`${ref.table}.${ref.column}:${ref.id} ${String(err?.message || err)}`);
    }
  }
  job.endedAt = nowTs();
  await saveLastJob(db, job);
  return job;
}
