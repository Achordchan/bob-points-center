import { api } from './api.js';

const MAX_IMAGE_SIZE = 4 * 1024 * 1024;

export function isImageFile(file) {
  return String(file?.type || '').startsWith('image/');
}

export function validateImageFile(file) {
  if (!isImageFile(file)) return '请选择图片文件';
  if (Number(file.size || 0) > MAX_IMAGE_SIZE) return '图片不能超过 4MB';
  return '';
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

export async function uploadOptimizedImage(file) {
  const error = validateImageFile(file);
  if (error) throw new Error(error);
  const image = await readFileAsDataUrl(file);
  const result = await api('/admin/image-optimization/upload', {
    method: 'POST',
    body: { image, filename: file.name || '' },
  });
  return result.data || {};
}
