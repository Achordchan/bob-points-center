import { useEffect, useMemo, useState } from 'react';
import { App } from 'antd';
import { Editor, Toolbar } from '@wangeditor/editor-for-react';
import '@wangeditor/editor/dist/css/style.css';
import { uploadOptimizedImage, validateImageFile } from '../imageUpload.js';

function normalizeHtml(value) {
  return String(value || '').trim();
}

function successText(result) {
  if (!result?.converted) return result?.message || '图片已上传';
  const saved = Number(result.savedBytes || 0);
  if (!saved) return '图片已转为 WebP';
  return `图片已转为 WebP，节省 ${Math.round(saved / 1024)} KB`;
}

export default function RichTextEditor({ value, onChange, minHeight = 180 }) {
  const { message } = App.useApp();
  const [editor, setEditor] = useState(null);
  const html = normalizeHtml(value);

  useEffect(() => () => editor?.destroy(), [editor]);

  const toolbarConfig = useMemo(() => ({
    excludeKeys: ['fullScreen', 'group-video', 'insertTable', 'codeBlock'],
  }), []);

  const editorConfig = useMemo(() => ({
    placeholder: '请输入内容',
    scroll: false,
    MENU_CONF: {
      uploadImage: {
        async customUpload(file, insertFn) {
          const invalid = validateImageFile(file);
          if (invalid) {
            message.warning(invalid);
            return;
          }
          try {
            const result = await uploadOptimizedImage(file);
            insertFn(result.url || '', file?.name || '图片', result.url || '');
            message.success(successText(result));
          } catch (err) {
            message.error(err.message || '图片上传失败');
          }
        },
      },
    },
  }), [message]);

  return <div className="rich-text-editor">
    <Toolbar editor={editor} defaultConfig={toolbarConfig} mode="default" />
    <Editor
      defaultConfig={editorConfig}
      value={html}
      mode="default"
      style={{ minHeight, overflowY: 'hidden' }}
      onCreated={setEditor}
      onChange={(instance) => onChange?.(instance.getHtml())}
    />
  </div>;
}
