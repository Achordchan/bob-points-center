import { useEffect, useRef, useState } from 'react';
import { App, Button, Input, Space, Upload } from 'antd';
import { DeleteOutlined, InboxOutlined, LinkOutlined } from '@ant-design/icons';

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

function normalizeHtml(value) {
  return String(value || '').trim();
}

export default function RichTextEditor({ value, onChange, minHeight = 150 }) {
  const { message } = App.useApp();
  const editorRef = useRef(null);
  const [linkUrl, setLinkUrl] = useState('');
  const html = normalizeHtml(value);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.innerHTML !== html) editor.innerHTML = html;
  }, [html]);

  const emit = () => onChange?.(editorRef.current?.innerHTML || '');
  const focus = () => editorRef.current?.focus();
  const command = (name, commandValue = null) => {
    focus();
    document.execCommand(name, false, commandValue);
    emit();
  };

  const insertImage = async (file) => {
    if (!isImageFile(file)) {
      message.warning('请选择图片文件');
      return false;
    }
    if (Number(file.size || 0) > MAX_IMAGE_SIZE) {
      message.warning('图片不能超过 4MB');
      return false;
    }
    try {
      command('insertImage', await readFileAsDataUrl(file));
      message.success('图片已插入');
    } catch (err) {
      message.error(err.message || '图片读取失败');
    }
    return false;
  };

  const insertLink = () => {
    const url = linkUrl.trim();
    if (!url) return;
    command('createLink', url);
    setLinkUrl('');
  };

  const handlePaste = async (event) => {
    const imageItem = Array.from(event.clipboardData?.items || []).find((item) => item.type.startsWith('image/'));
    const file = imageItem?.getAsFile();
    if (!file) return;
    event.preventDefault();
    await insertImage(file);
  };

  return <div className="rich-text-editor">
    <Space className="rich-text-toolbar" wrap>
      <Button onClick={() => command('bold')}>加粗</Button>
      <Button onClick={() => command('insertUnorderedList')}>项目符号</Button>
      <Button onClick={() => command('insertOrderedList')}>编号</Button>
      <Upload accept="image/*" showUploadList={false} beforeUpload={insertImage}>
        <Button icon={<InboxOutlined />}>上传图片</Button>
      </Upload>
      <Input prefix={<LinkOutlined />} value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} onPressEnter={insertLink} placeholder="链接地址" style={{ width: 220 }} />
      <Button onClick={insertLink}>插入链接</Button>
      <Button icon={<DeleteOutlined />} onClick={() => command('removeFormat')}>清除格式</Button>
    </Space>
    <div
      ref={editorRef}
      className="rich-text-content"
      contentEditable
      style={{ minHeight }}
      onInput={emit}
      onBlur={emit}
      onPaste={handlePaste}
      suppressContentEditableWarning
    />
  </div>;
}
