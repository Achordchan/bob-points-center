import { useEffect, useState } from 'react';
import { App, Button, Card, Collapse, Divider, Form, Input, Select, Space, Switch, Tabs, Typography } from 'antd';
import { api } from '../api.js';

const notifyTemplates = [
  { key: 'grant', label: '发币通知', vars: '{{name}} {{reason}} {{amount}} {{balance}}' },
  { key: 'deduct', label: '减币通知', vars: '{{name}} {{reason}} {{amount}} {{balance}} {{exchange_id}}' },
  { key: 'redeem', label: '核销通知', vars: '{{name}} {{product_name}} {{amount}} {{balance}} {{exchange_id}}' },
  { key: 'mall_buy', label: '下单通知', vars: '{{name}} {{product_name}} {{amount}} {{balance}}' },
  { key: 'transfer_out', label: '转出通知', vars: '{{name}} {{to_name}} {{amount}} {{balance}}' },
  { key: 'transfer_in', label: '转入通知', vars: '{{name}} {{from_name}} {{amount}} {{balance}}' },
  { key: 'red_packet', label: '红包通知', vars: '{{name}} {{amount}} {{balance}} {{activity_id}}' },
  { key: 'charity', label: '公益通知', vars: '{{name}} {{project_name}} {{amount}} {{balance}}' },
];

const groupTemplates = [
  { key: 'manual', label: '手动群通知', vars: '{{title}} {{content}}' },
  { key: 'mall_open', label: '商城开启', vars: '{{open_time}}' },
  { key: 'mall_open_remind', label: '商城开启提醒', vars: '{{open_time}}' },
  { key: 'mall_close_remind', label: '商城关闭提醒', vars: '{{close_time}}' },
  { key: 'stock_low', label: '库存告急', vars: '{{product_name}} {{stock}}' },
  { key: 'stock_soldout', label: '售罄通知', vars: '{{product_name}}' },
  { key: 'new_product', label: '新品上架', vars: '{{product_name}} {{amount}} {{stock}}' },
];

const colorOptions = [
  { value: 'blue', label: '蓝色' },
  { value: 'gray', label: '灰色' },
  { value: 'red', label: '红色' },
];

const variableDescriptions = {
  name: '接收消息的用户姓名',
  reason: '发币或减币的业务原因',
  amount: '本次变动的 BOB 币数量',
  balance: '操作完成后的账户余额',
  exchange_id: '订单或核销单号',
  product_name: '商品名称',
  to_name: '转账接收人姓名',
  from_name: '转账发起人姓名',
  activity_id: '红包活动编号',
  project_name: '公益项目名称',
  title: '群消息标题',
  content: '群消息正文',
  open_time: '商城开启时间',
  close_time: '商城关闭时间',
  stock: '商品当前库存',
};

function renderVariableHelp(vars) {
  const keys = Array.from(String(vars || '').matchAll(/\{\{([^}]+)\}\}/g)).map((m) => m[1]).filter(Boolean);
  if (!keys.length) return null;
  return <div className="template-variable-help">
    <Typography.Text type="secondary">变量说明</Typography.Text>
    <div className="template-variable-grid">
      {keys.map((key) => <div className="template-variable-item" key={key}>
        <code>{`{{${key}}}`}</code>
        <span>{variableDescriptions[key] || '模板变量'}</span>
      </div>)}
    </div>
  </div>;
}

function Toolbar({ onRefresh, onReset, onSave }) {
  return <Space className="table-toolbar" wrap>
    <Button onClick={onRefresh}>刷新</Button>
    <Button danger onClick={onReset}>恢复默认</Button>
    <Button type="primary" onClick={onSave}>保存</Button>
  </Space>;
}

function TemplateFields({ namePrefix, vars, withButtons = false }) {
  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <Form.Item label="启用" name={[...namePrefix, 'enabled']} valuePropName="checked"><Switch /></Form.Item>
    <Form.Item label="标题" name={[...namePrefix, 'title']} rules={[{ required: true, message: '请输入标题' }]}><Input /></Form.Item>
    <Form.Item label="正文" name={[...namePrefix, 'content']} rules={[{ required: true, message: '请输入正文' }]}><Input.TextArea rows={6} /></Form.Item>
    {renderVariableHelp(vars)}
    {withButtons && <>
      <Divider style={{ margin: '4px 0' }} />
      <Form.List name={[...namePrefix, 'buttons']}>
        {(fields, { add, remove }) => <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Space><Typography.Text strong>按钮</Typography.Text><Button onClick={() => add({ text: '', url: '', color: 'blue' })}>新增按钮</Button></Space>
          {fields.map((field) => <Card size="small" key={field.key}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Form.Item label="按钮文字" name={[field.name, 'text']} rules={[{ required: true, message: '请输入按钮文字' }]}><Input /></Form.Item>
              <Form.Item label="跳转链接" name={[field.name, 'url']} rules={[{ required: true, message: '请输入跳转链接' }]}><Input /></Form.Item>
              <Form.Item label="颜色" name={[field.name, 'color']}><Select options={colorOptions} /></Form.Item>
              <Button danger onClick={() => remove(field.name)}>删除按钮</Button>
            </Space>
          </Card>)}
        </Space>}
      </Form.List>
    </>}
  </Space>;
}

function SettingsEditor({ title, loadPath, savePath, templates, withChannel = false, withButtons = false }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [channelEditing, setChannelEditing] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api(loadPath);
      form.setFieldsValue(data.data || {});
      setChannelEditing(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);

  const save = async () => {
    const payload = await form.validateFields();
    await api(savePath, { method: 'POST', body: payload });
    message.success(`${title}已保存`);
    setChannelEditing(false);
    load();
  };

  const reset = async () => {
    await api(savePath, { method: 'POST', body: { reset: true } });
    message.success('已恢复默认');
    load();
  };

  const items = templates.map((item) => ({
    key: item.key,
    label: item.label,
    children: <TemplateFields namePrefix={['templates', item.key]} vars={item.vars} withButtons={withButtons} />,
  }));

  return <Card loading={loading}>
    <Toolbar onRefresh={load} onReset={reset} onSave={save} />
    <Form form={form} layout="vertical">
      <Form.Item label="总开关" name="enabled" valuePropName="checked"><Switch /></Form.Item>
      {withChannel && <Card
        size="small"
        title="群发送配置"
        extra={<Button onClick={() => setChannelEditing((v) => !v)}>{channelEditing ? '锁定配置' : '编辑配置'}</Button>}
        style={{ marginBottom: 12 }}
      >
        <Form.Item label="群会话 ID" name={['channel', 'openConversationId']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} /></Form.Item>
        <Form.Item label="卡片模板 ID" name={['channel', 'cardTemplateId']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} /></Form.Item>
        <Form.Item label="操作人 Userid" name={['channel', 'operatorUserid']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} /></Form.Item>
        <Form.Item label="指定接收人" name={['channel', 'recipients']}><Input.TextArea readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} rows={3} placeholder="多个 Userid 可用换行或逗号分隔" /></Form.Item>
      </Card>}
      <Collapse defaultActiveKey={[]} items={items} />
    </Form>
  </Card>;
}

export default function Messages() {
  return <Tabs items={[
    { key: 'notify', label: '私聊通知模板', children: <SettingsEditor title="私聊通知模板" loadPath="/admin/settings/notify" savePath="/admin/settings/notify" templates={notifyTemplates} /> },
    { key: 'group', label: '群卡片模板', children: <SettingsEditor title="群卡片模板" loadPath="/admin/settings/group-card" savePath="/admin/settings/group-card" templates={groupTemplates} withChannel withButtons /> },
  ]} />;
}
