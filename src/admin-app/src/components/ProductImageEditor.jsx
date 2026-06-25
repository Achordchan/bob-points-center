import { DeleteOutlined, InboxOutlined, PictureOutlined } from '@ant-design/icons';
import { App, Button, Image, Space, Typography, Upload } from 'antd';
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

export default function ProductImageEditor({ value, onChange, emptyText = '未设置商品图片', disabled = false }) {
  const { message } = App.useApp();
  const imageUrl = String(value || '').trim();

  const applyFile = async (file) => {
    if (disabled) return false;
    const invalid = validateImageFile(file);
    if (invalid) {
      message.warning(invalid);
      return false;
    }
    try {
      const result = await uploadOptimizedImage(file);
      onChange(result.url || '');
      message.success(successText(result));
    } catch (err) {
      message.error(err.message || '图片上传失败');
    }
    return false;
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
          <Button type="primary" icon={<InboxOutlined />} disabled={disabled}>上传图片</Button>
        </Upload>
        <Button icon={<DeleteOutlined />} disabled={disabled || !imageUrl} onClick={() => onChange('')}>移除图片</Button>
      </Space>
      <Typography.Text type="secondary">{imageUrl ? imageSourceType(imageUrl) : disabled ? '当前权限仅可查看图片。' : '支持上传图片，或点击此区域后粘贴截图。'}</Typography.Text>
    </Space>
  </div>;
}
