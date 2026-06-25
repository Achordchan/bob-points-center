import { DeleteOutlined, InboxOutlined, LinkOutlined, PictureOutlined } from '@ant-design/icons';
import { App, Button, Image, Input, Space, Typography, Upload } from 'antd';

const MAX_IMAGE_SIZE = 4 * 1024 * 1024;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

function isImageFile(file) {
  return String(file?.type || '').startsWith('image/');
}

function imageSourceType(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('data:image/')) return '已上传图片';
  return '图片链接';
}

export default function ProductImageEditor({ value, onChange }) {
  const { message } = App.useApp();
  const imageUrl = String(value || '').trim();

  const applyFile = async (file) => {
    if (!isImageFile(file)) {
      message.warning('请选择图片文件');
      return false;
    }
    if (Number(file.size || 0) > MAX_IMAGE_SIZE) {
      message.warning('图片不能超过 4MB');
      return false;
    }
    try {
      onChange(await readFileAsDataUrl(file));
      message.success('图片已更新');
    } catch (err) {
      message.error(err.message || '图片读取失败');
    }
    return false;
  };

  const handlePaste = async (event) => {
    const imageItem = Array.from(event.clipboardData?.items || []).find((item) => item.type.startsWith('image/'));
    const file = imageItem?.getAsFile();
    if (!file) return;
    event.preventDefault();
    await applyFile(file);
  };

  return <div className="product-image-editor" onPaste={handlePaste}>
    <div className="product-image-preview">
      {imageUrl ? <Image src={imageUrl} className="product-image-preview-img" /> : <div className="product-image-empty">
        <PictureOutlined />
        <Typography.Text type="secondary">未设置商品图片</Typography.Text>
      </div>}
    </div>
    <Space direction="vertical" className="product-image-controls" size={10}>
      <Space wrap>
        <Upload accept="image/*" showUploadList={false} beforeUpload={applyFile}>
          <Button type="primary" icon={<InboxOutlined />}>上传图片</Button>
        </Upload>
        <Button icon={<DeleteOutlined />} disabled={!imageUrl} onClick={() => onChange('')}>移除图片</Button>
      </Space>
      <Input prefix={<LinkOutlined />} value={imageUrl} onChange={(event) => onChange(event.target.value)} placeholder="粘贴图片链接，或点击此处后直接粘贴截图" />
      <Typography.Text type="secondary">{imageUrl ? imageSourceType(imageUrl) : '支持上传图片、粘贴截图或填写图片链接。'}</Typography.Text>
    </Space>
  </div>;
}
