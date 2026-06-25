import { useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, Space, Switch, Tabs, Typography } from 'antd';
import { api } from '../api.js';

function JsonSettings({ title, loadPath, savePath }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const data = await api(loadPath);
      form.setFieldsValue({ json: JSON.stringify(data.data || {}, null, 2) });
    } finally { setLoading(false); }
  };
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const save = async ({ json }) => {
    const payload = JSON.parse(json || '{}');
    await api(savePath, { method: 'POST', body: payload });
    message.success(`${title}已保存`);
    load();
  };
  return <Card title={title} loading={loading} extra={<Space><Button onClick={load}>刷新</Button><Button danger onClick={() => api(savePath, { method: 'POST', body: { reset: true } }).then(() => { message.success('已恢复默认'); load(); })}>恢复默认</Button><Button type="primary" onClick={() => form.submit()}>保存</Button></Space>}>
    <Typography.Paragraph type="secondary">测试发送入口已从新版后台隐藏，避免误触真实消息；需要测试时使用内部测试流程。</Typography.Paragraph>
    <Form form={form} onFinish={save} layout="vertical"><Form.Item name="json" rules={[{ required: true }]}><Input.TextArea rows={18} className="code-editor" /></Form.Item></Form>
  </Card>;
}

export default function Messages() {
  return <Tabs items={[
    { key: 'notify', label: '私聊通知模板', children: <JsonSettings title="私聊通知模板" loadPath="/admin/settings/notify" savePath="/admin/settings/notify" /> },
    { key: 'group', label: '群卡片模板', children: <JsonSettings title="群卡片模板" loadPath="/admin/settings/group-card" savePath="/admin/settings/group-card" /> },
  ]} />;
}
