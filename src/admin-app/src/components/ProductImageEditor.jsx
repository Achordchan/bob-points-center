import { useEffect, useState } from 'react';
import { DeleteOutlined, InboxOutlined, PictureOutlined } from '@ant-design/icons';
import { App, Button, Image, Modal, Slider, Space, Typography, Upload } from 'antd';
import { uploadOptimizedImage, validateImageFile } from '../imageUpload.js';

function imageSourceType(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('/assets/uploads/') && text.toLowerCase().split('?')[0].endsWith('.webp')) return 'WebP 图片';
  if (text.startsWith('/assets/uploads/')) return '已上传图片';
  if (text.startsWith('data:image/')) return '已上传图片';
  return '外链图片';
}

function successText(result) {
  if (!result?.converted) return result?.message || '图片已上传';
  const saved = Number(result.savedBytes || 0);
  if (!saved) return '图片已转为 WebP';
  return `图片已转为 WebP，节省 ${Math.round(saved / 1024)} KB`;
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img');
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = url;
  });
}

async function makeSquareImageFile(file, previewUrl, crop) {
  const img = await loadImageFromUrl(previewUrl);
  const size = Math.min(1200, Math.max(800, Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height)));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight) * Number(crop.scale || 1);
  const width = img.naturalWidth * scale;
  const height = img.naturalHeight * scale;
  const dx = (size - width) / 2 + Number(crop.x || 0);
  const dy = (size - height) / 2 + Number(crop.y || 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, dx, dy, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('图片裁切失败');
  return new File([blob], file.name || 'image.jpg', { type: 'image/jpeg' });
}

export default function ProductImageEditor({ value, onChange, emptyText = '未设置商品图片', disabled = false, squareCrop = true }) {
  const { message } = App.useApp();
  const imageUrl = String(value || '').trim();
  const [cropTarget, setCropTarget] = useState(null);
  const [crop, setCrop] = useState({ scale: 1, x: 0, y: 0 });
  const [uploading, setUploading] = useState(false);

  useEffect(() => () => {
    if (cropTarget?.url) URL.revokeObjectURL(cropTarget.url);
  }, [cropTarget?.url]);

  const uploadFile = async (file) => {
    setUploading(true);
    try {
      const result = await uploadOptimizedImage(file);
      onChange(result.url || '');
      message.success(successText(result));
    } catch (err) {
      message.error(err.message || '图片上传失败');
    } finally {
      setUploading(false);
    }
  };

  const applyFile = async (file) => {
    if (disabled) return false;
    const invalid = validateImageFile(file);
    if (invalid) {
      message.warning(invalid);
      return false;
    }
    if (!squareCrop) {
      await uploadFile(file);
      return false;
    }
    if (cropTarget?.url) URL.revokeObjectURL(cropTarget.url);
    setCrop({ scale: 1, x: 0, y: 0 });
    setCropTarget({ file, url: URL.createObjectURL(file) });
    return false;
  };

  const applyCrop = async () => {
    if (!cropTarget?.file || !cropTarget?.url) return;
    try {
      const file = await makeSquareImageFile(cropTarget.file, cropTarget.url, crop);
      setCropTarget(null);
      await uploadFile(file);
    } catch (err) {
      message.error(err.message || '图片裁切失败');
    }
  };

  const handlePaste = async (event) => {
    const imageItem = Array.from(event.clipboardData?.items || []).find((item) => item.type.startsWith('image/'));
    const file = imageItem?.getAsFile();
    if (!file || disabled) return;
    event.preventDefault();
    await applyFile(file);
  };

  return <div className="product-image-editor" onPaste={handlePaste}>
    <div className="product-image-preview">
      {imageUrl ? <Image src={imageUrl} className="product-image-preview-img" /> : <div className="product-image-empty">
        <PictureOutlined />
        <Typography.Text type="secondary">{emptyText}</Typography.Text>
      </div>}
    </div>
    <Space direction="vertical" className="product-image-controls" size={10}>
      <Space wrap>
        <Upload accept="image/*" showUploadList={false} beforeUpload={applyFile} disabled={disabled}>
          <Button type="primary" icon={<InboxOutlined />} loading={uploading} disabled={disabled}>上传图片</Button>
        </Upload>
        <Button icon={<DeleteOutlined />} disabled={disabled || !imageUrl} onClick={() => onChange('')}>移除图片</Button>
      </Space>
      <Typography.Text type="secondary">{imageUrl ? imageSourceType(imageUrl) : disabled ? '当前权限仅可查看图片。' : '支持上传、拖入或粘贴图片，上传前可裁切为 1:1。'}</Typography.Text>
    </Space>
    <Modal
      title="图片 1:1 裁切"
      open={Boolean(cropTarget)}
      onCancel={() => setCropTarget(null)}
      onOk={applyCrop}
      okText="应用裁切并上传"
      cancelText="取消"
      confirmLoading={uploading}
      width={640}
    >
      {cropTarget && <Space direction="vertical" style={{ width: '100%' }} size={14}>
        <div className="image-crop-preview">
          <img src={cropTarget.url} alt="待裁切图片" style={{ transform: `translate(${crop.x}px, ${crop.y}px) scale(${crop.scale})` }} />
        </div>
        <div><Typography.Text type="secondary">缩放</Typography.Text><Slider min={1} max={2.5} step={0.05} value={crop.scale} onChange={(scale) => setCrop((v) => ({ ...v, scale }))} /></div>
        <div><Typography.Text type="secondary">左右位置</Typography.Text><Slider min={-300} max={300} value={crop.x} onChange={(x) => setCrop((v) => ({ ...v, x }))} /></div>
        <div><Typography.Text type="secondary">上下位置</Typography.Text><Slider min={-300} max={300} value={crop.y} onChange={(y) => setCrop((v) => ({ ...v, y }))} /></div>
      </Space>}
    </Modal>
  </div>;
}
