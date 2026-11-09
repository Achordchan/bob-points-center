import QRCode from 'qrcode';

const DEFAULT_QR_SIZE = 240;
const MIN_QR_SIZE = 120;
const MAX_QR_SIZE = 720;
const MAX_QR_TEXT_LENGTH = 1024;
const QR_PNG_CACHE_LIMIT = 200;
const qrPngCache = new Map();

function normalizeQrText(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('缺少二维码内容');
  if (text.length > MAX_QR_TEXT_LENGTH) throw new Error('二维码内容过长');
  return text;
}

function normalizeQrSize(value, fallback = DEFAULT_QR_SIZE) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.min(MAX_QR_SIZE, Math.max(MIN_QR_SIZE, n));
}

const QR_EC_LEVELS = new Set(['L', 'M', 'Q', 'H']);

// 默认 M；转发核销图要在二维码中间盖产品名，需要 H。
export function normalizeQrEcLevel(value) {
  const level = String(value || '').trim().toUpperCase();
  return QR_EC_LEVELS.has(level) ? level : 'M';
}

function qrOptions(size, ecLevel = 'M') {
  return {
    errorCorrectionLevel: normalizeQrEcLevel(ecLevel),
    type: 'image/png',
    margin: 2,
    width: normalizeQrSize(size),
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  };
}

function normalizeQrBuildError(err) {
  const message = String(err?.message || err || '');
  if (/too big|amount of data|code length/i.test(message)) {
    return new Error('二维码内容过长，无法生成');
  }
  return err;
}

function rememberQrPng(key, buffer) {
  qrPngCache.set(key, buffer);
  while (qrPngCache.size > QR_PNG_CACHE_LIMIT) {
    const firstKey = qrPngCache.keys().next().value;
    qrPngCache.delete(firstKey);
  }
}

export async function createQrDataUrl(data, { size = DEFAULT_QR_SIZE } = {}) {
  try {
    return await QRCode.toDataURL(normalizeQrText(data), qrOptions(size));
  } catch (err) {
    throw normalizeQrBuildError(err);
  }
}

export async function createQrPngBuffer(data, { size = DEFAULT_QR_SIZE, ec = 'M' } = {}) {
  const text = normalizeQrText(data);
  const normalizedSize = normalizeQrSize(size);
  const ecLevel = normalizeQrEcLevel(ec);
  const cacheKey = `${normalizedSize}:${ecLevel}:${text}`;
  const cached = qrPngCache.get(cacheKey);
  if (cached) {
    qrPngCache.delete(cacheKey);
    qrPngCache.set(cacheKey, cached);
    return cached;
  }
  try {
    const buffer = await QRCode.toBuffer(text, qrOptions(normalizedSize, ecLevel));
    rememberQrPng(cacheKey, buffer);
    return buffer;
  } catch (err) {
    throw normalizeQrBuildError(err);
  }
}

export function createQrRenderPath(data, { size = DEFAULT_QR_SIZE } = {}) {
  const text = normalizeQrText(data);
  return `/qr/render?size=${normalizeQrSize(size)}&data=${encodeURIComponent(text)}`;
}
