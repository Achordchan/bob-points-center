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

function qrOptions(size) {
  return {
    errorCorrectionLevel: 'M',
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

export async function createQrPngBuffer(data, { size = DEFAULT_QR_SIZE } = {}) {
  const text = normalizeQrText(data);
  const normalizedSize = normalizeQrSize(size);
  const cacheKey = `${normalizedSize}:${text}`;
  const cached = qrPngCache.get(cacheKey);
  if (cached) {
    qrPngCache.delete(cacheKey);
    qrPngCache.set(cacheKey, cached);
    return cached;
  }
  try {
    const buffer = await QRCode.toBuffer(text, qrOptions(normalizedSize));
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
