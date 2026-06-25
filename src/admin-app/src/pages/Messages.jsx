import { useEffect, useState } from 'react';
import { App, Button, Card, Collapse, Divider, Form, Input, Modal, Select, Space, Switch, Tabs, Typography } from 'antd';
import { api, qs } from '../api.js';
import { hasPermission } from '../permissions.js';

const notifyTemplates = [
  { key: 'grant', label: '发币通知', vars: '{{name}} {{reason}} {{amount}} {{balance}}' },
  { key: 'deduct', label: '减币通知', vars: '{{name}} {{reason}} {{amount}} {{balance}} {{exchange_id}}' },
  { key: 'redeem', label: '核销通知', vars: '{{name}} {{product_name}} {{amount}} {{balance}} {{exchange_id}}' },
  { key: 'mall_buy', label: '下单通知', vars: '{{name}} {{product_name}} {{amount}} {{balance}}' },
  { key: 'transfer_out', label: '转出通知', vars: '{{name}} {{to_name}} {{amount}} {{balance}} {{transfer_id}}' },
  { key: 'transfer_in', label: '转入通知', vars: '{{name}} {{from_name}} {{amount}} {{balance}} {{transfer_id}}' },
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

const groupConversationPresets = [
  { label: 'BOB大群', value: 'cidxEY0ywSnrjDytDeXzEscwg==' },
  { label: '测试群', value: 'cidGgW6mYLsdUyYN4rIuPvgYw==' },
  { label: '自定义群', value: '__custom__' },
];

function matchConversationPreset(value) {
  const current = String(value || '').trim();
  return groupConversationPresets.find((item) => item.value === current)?.value || '__custom__';
}

const variableDescriptions = {
  name: '接收消息的用户姓名',
  reason: '发币或减币的业务原因',
  amount: '本次变动的 BOB 币数量',
  balance: '操作完成后的账户余额',
  exchange_id: '订单或核销单号',
  transfer_id: '转账流水编号',
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

function parseTemplateVars(vars) {
  const keys = Array.from(String(vars || '').matchAll(/\{\{([^}]+)\}\}/g)).map((m) => m[1]).filter(Boolean);
  return keys;
}

function collectTemplateVars(templates) {
  const seen = new Set();
  const keys = [];
  templates.forEach((item) => {
    parseTemplateVars(item.vars).forEach((key) => {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    });
  });
  return keys;
}

function renderVariableHelp(keys) {
  if (!keys.length) return null;
  return <div className="template-variable-help">
    <Typography.Text type="secondary">模板变量</Typography.Text>
    <div className="template-variable-grid">
      {keys.map((key) => <div className="template-variable-item" key={key}>
        <code>{`{{${key}}}`}</code>
        <span>{variableDescriptions[key] || '模板变量'}</span>
      </div>)}
    </div>
  </div>;
}

function Toolbar({ onRefresh, onReset, onSave, canEdit = true }) {
  return <Space className="table-toolbar" wrap>
    <Button onClick={onRefresh}>刷新</Button>
    {canEdit && <Button danger onClick={onReset}>恢复默认</Button>}
    {canEdit && <Button type="primary" onClick={onSave}>保存</Button>}
  </Space>;
}

function TemplateFields({ namePrefix, withButtons = false, canEdit = true }) {
  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <Form.Item label="启用" name={[...namePrefix, 'enabled']} valuePropName="checked"><Switch disabled={!canEdit} /></Form.Item>
    <Form.Item label="标题" name={[...namePrefix, 'title']} rules={[{ required: true, message: '请输入标题' }]}><Input readOnly={!canEdit} className={!canEdit ? 'readonly-input' : ''} /></Form.Item>
    <Form.Item label="正文" name={[...namePrefix, 'content']} rules={[{ required: true, message: '请输入正文' }]}><Input.TextArea rows={6} readOnly={!canEdit} className={!canEdit ? 'readonly-input' : ''} /></Form.Item>
    {withButtons && <>
      <Divider style={{ margin: '4px 0' }} />
      <Form.List name={[...namePrefix, 'buttons']}>
        {(fields, { add, remove }) => <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Space><Typography.Text strong>按钮</Typography.Text>{canEdit && <Button onClick={() => add({ text: '', url: '', color: 'blue' })}>新增按钮</Button>}</Space>
          {fields.map((field) => <Card size="small" key={field.key}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Form.Item label="按钮文字" name={[field.name, 'text']} rules={[{ required: true, message: '请输入按钮文字' }]}><Input readOnly={!canEdit} /></Form.Item>
              <Form.Item label="跳转链接" name={[field.name, 'url']} rules={[{ required: true, message: '请输入跳转链接' }]}><Input readOnly={!canEdit} /></Form.Item>
              <Form.Item label="颜色" name={[field.name, 'color']}><Select disabled={!canEdit} options={colorOptions} /></Form.Item>
              {canEdit && <Button danger onClick={() => remove(field.name)}>删除按钮</Button>}
            </Space>
          </Card>)}
        </Space>}
      </Form.List>
    </>}
  </Space>;
}

function SettingsEditor({ title, loadPath, savePath, templates, withChannel = false, withButtons = false, canEdit = true, extraPanel = null }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [channelEditing, setChannelEditing] = useState(false);
  const channelConversationId = Form.useWatch(['channel', 'openConversationId'], form);
  const channelPreset = matchConversationPreset(channelConversationId);

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
    children: <TemplateFields namePrefix={['templates', item.key]} withButtons={withButtons} canEdit={canEdit} />,
  }));
  const templateVars = collectTemplateVars(templates);

  return <Card loading={loading}>
    <Toolbar onRefresh={load} onReset={reset} onSave={save} canEdit={canEdit} />
    <Form form={form} layout="vertical">
      <Form.Item label="总开关" name="enabled" valuePropName="checked"><Switch disabled={!canEdit} /></Form.Item>
      {renderVariableHelp(templateVars)}
      {withChannel && <Card
        size="small"
        title="群发送配置"
        extra={canEdit ? <Button onClick={() => setChannelEditing((v) => !v)}>{channelEditing ? '锁定配置' : '编辑配置'}</Button> : null}
        style={{ marginBottom: 12 }}
      >
        <Form.Item label="群会话预设"><Select disabled={!canEdit} value={channelPreset} options={groupConversationPresets} onChange={(value) => { if (value === '__custom__') { setChannelEditing(true); return; } form.setFieldValue(['channel', 'openConversationId'], value); setChannelEditing(false); }} /></Form.Item>
        <Form.Item label="群会话 ID" name={['channel', 'openConversationId']}><Input readOnly={!channelEditing || channelPreset !== '__custom__'} className={!channelEditing || channelPreset !== '__custom__' ? 'readonly-input' : ''} placeholder={channelPreset === '__custom__' ? '填写钉钉群 openConversationId' : '已从预设自动填入'} /></Form.Item>
        <Form.Item label="卡片模板 ID" name={['channel', 'cardTemplateId']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} /></Form.Item>
        <Form.Item label="操作人 Userid" name={['channel', 'operatorUserid']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} /></Form.Item>
        <Form.Item label="全员广播" name={['channel', 'broadcastAll']} valuePropName="checked"><Switch disabled={!channelEditing} /></Form.Item>
        <Form.Item label="指定接收人" name={['channel', 'recipients']}><Input.TextArea readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} rows={3} placeholder="多个 Userid 可用换行或逗号分隔" /></Form.Item>
        <Form.Item label="标题字段 Key" name={['channel', 'titleKey']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} placeholder="留空使用模板默认标题字段" /></Form.Item>
        <Form.Item label="内容字段 Key" name={['channel', 'contentKey']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} placeholder="例如 spyj_neirong" /></Form.Item>
        <Form.Item label="搜索图标" name={['channel', 'searchIcon']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} placeholder="可选，群卡搜索图标地址" /></Form.Item>
      </Card>}
      <Collapse defaultActiveKey={[]} items={items} />
    </Form>
    {extraPanel}
  </Card>;
}


function NotifyTestPanel({ disabled, canSearchUsers }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [userOptions, setUserOptions] = useState([]);
  const searchUsers = async (keyword) => {
    if (!String(keyword || '').trim()) return;
    const data = await api(`/admin/users?${qs({ keyword, page: 1, pageSize: 20 })}`);
    setUserOptions((data.data || []).map((row) => ({ value: row.userid, label: row.name ? `${row.name}（${row.userid}）` : row.userid, name: row.name || '' })));
  };
  const submit = async (values) => {
    Modal.confirm({
      title: '确认发送私聊测试？',
      content: '这会向指定用户发送一条测试通知，请只填写内部测试账号。',
      okText: '确认发送',
      cancelText: '取消',
      onOk: async () => {
        setLoading(true);
        try {
          await api('/admin/settings/notify/test', { method: 'POST', body: values });
          message.success('私聊测试已发送');
        } catch (err) {
          message.error(err.message || '私聊测试失败');
        } finally {
          setLoading(false);
        }
      },
    });
  };
  return <Card size="small" title="私聊测试" style={{ marginTop: 12 }}>
    <Form form={form} layout="inline" onFinish={submit}>
      <Form.Item name="event" rules={[{ required: true, message: '请选择事件' }]}><Select placeholder="选择通知类型" style={{ width: 180 }} options={notifyTemplates.map((item) => ({ value: item.key, label: item.label }))} /></Form.Item>
{canSearchUsers ? <Form.Item name="userid" rules={[{ required: true, message: '请选择测试用户' }]}><Select showSearch placeholder="搜索并选择内部测试用户" style={{ width: 280 }} filterOption={false} onSearch={searchUsers} options={userOptions} onChange={(userid, option) => form.setFieldsValue({ userid, name: option?.name || '' })} /></Form.Item> : <Form.Item name="userid" rules={[{ required: true, message: '请输入测试用户 Userid' }]}><Input placeholder="内部测试用户 Userid" style={{ width: 220 }} /></Form.Item>}
      <Form.Item name="name"><Input placeholder={canSearchUsers ? "用户姓名" : "可选：用户姓名"} style={{ width: 160 }} readOnly={canSearchUsers} /></Form.Item>
      <Button type="primary" htmlType="submit" loading={loading} disabled={disabled}>发送测试</Button>
    </Form>
  </Card>;
}

function GroupCardActions({ canManual, canTest }) {
  const { message } = App.useApp();
  const [testForm] = Form.useForm();
  const [manualForm] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const confirmRun = (title, content, fn) => Modal.confirm({ title, content, okText: '确认发送', cancelText: '取消', onOk: fn });
  const testSend = async (values) => confirmRun('确认发送群卡测试？', '这会向当前配置的测试群或群会话发送一条测试群卡。', async () => {
    setLoading(true);
    try {
      await api('/admin/settings/group-card/test', { method: 'POST', body: values });
      message.success('群卡测试已发送');
    } catch (err) {
      message.error(err.message || '群卡测试失败');
    } finally {
      setLoading(false);
    }
  });
  const manualSend = async (values) => {
    if (!String(values.title || '').trim() && !String(values.markdown || '').trim()) {
      message.warning('标题和内容至少填写一项');
      return;
    }
    return confirmRun('确认发送手动群卡？', '这会向当前群卡配置对应的群发送手动群卡，请确认内容和群会话无误。', async () => {
    setLoading(true);
    try {
      await api('/admin/notify/group-card', { method: 'POST', body: values });
      message.success('手动群卡已发送');
      manualForm.resetFields();
    } catch (err) {
      message.error(err.message || '手动群卡发送失败');
    } finally {
      setLoading(false);
    }
  });
  };
  return <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size={12}>
    <Card size="small" title="群卡模板测试">
      <Form form={testForm} layout="inline" onFinish={testSend}>
        <Form.Item name="event" initialValue="manual"><Select style={{ width: 200 }} options={groupTemplates.map((item) => ({ value: item.key, label: item.label }))} /></Form.Item>
        <Button type="primary" htmlType="submit" loading={loading} disabled={!canTest}>发送模板测试</Button>
      </Form>
    </Card>
    <Card size="small" title="手动群卡推送">
      <Form form={manualForm} layout="vertical" onFinish={manualSend}>
        <Form.Item label="标题" name="title"><Input readOnly={!canManual} /></Form.Item>
        <Form.Item label="Markdown 内容" name="markdown"><Input.TextArea rows={5} readOnly={!canManual} /></Form.Item>
        <Form.Item label="图片地址" name="imageUrl"><Input placeholder="可选" readOnly={!canManual} /></Form.Item>
        <Form.Item label="外部追踪 ID" name="outTrackId"><Input placeholder="可选，留空自动生成" readOnly={!canManual} /></Form.Item>
        <Form.List name="buttons">
          {(fields, { add, remove }) => <Space direction="vertical" style={{ width: '100%' }}>
            <Space><Typography.Text strong>按钮</Typography.Text>{canManual && <Button onClick={() => add({ text: '', url: '', color: 'blue' })}>新增按钮</Button>}</Space>
            {fields.map((field) => <Card size="small" key={field.key}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Form.Item label="按钮文字" name={[field.name, 'text']} rules={[{ required: true, message: '请输入按钮文字' }]}><Input readOnly={!canManual} /></Form.Item>
                <Form.Item label="跳转链接" name={[field.name, 'url']} rules={[{ required: true, message: '请输入跳转链接' }]}><Input readOnly={!canManual} /></Form.Item>
                <Form.Item label="颜色" name={[field.name, 'color']}><Select disabled={!canManual} options={colorOptions} /></Form.Item>
                {canManual && <Button danger onClick={() => remove(field.name)}>删除按钮</Button>}
              </Space>
            </Card>)}
          </Space>}
        </Form.List>
        <Button type="primary" htmlType="submit" loading={loading} disabled={!canManual}>发送手动群卡</Button>
      </Form>
    </Card>
  </Space>;
}

export default function Messages({ me }) {
  const canEdit = hasPermission(me, 'messages:edit');
  const canTest = hasPermission(me, 'messages:test');
  const canSearchUsers = hasPermission(me, 'users:view');
  return <Tabs items={[
    { key: 'notify', label: '私聊通知模板', children: <SettingsEditor title="私聊通知模板" loadPath="/admin/settings/notify" savePath="/admin/settings/notify" templates={notifyTemplates} canEdit={canEdit} extraPanel={<NotifyTestPanel disabled={!canTest} canSearchUsers={canSearchUsers} />} /> },
    { key: 'group', label: '群卡片模板', children: <SettingsEditor title="群卡片模板" loadPath="/admin/settings/group-card" savePath="/admin/settings/group-card" templates={groupTemplates} withChannel withButtons canEdit={canEdit} extraPanel={<GroupCardActions canManual={canEdit} canTest={canTest} />} /> },
  ]} />;
}
