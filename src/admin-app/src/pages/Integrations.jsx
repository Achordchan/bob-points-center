import { useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { api } from '../api.js';
import { formatTs } from '../utils.js';

function Attendance({ dingtalk, onOpenDingtalk }) {
  const { message } = App.useApp(); const [form] = Form.useForm(); const [departments, setDepartments] = useState([]); const [mode, setMode] = useState('all');
  const load = async () => { const data = await api('/admin/settings/attendance-reward'); form.setFieldsValue(data.data || {}); setMode(data.data?.departmentMode || 'all'); };
  const loadDepartments = async () => { if (!dingtalk?.connected) return setDepartments([]); setDepartments((await api('/admin/settings/dingtalk/departments')).data || []); };
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  useEffect(() => { loadDepartments().catch(() => setDepartments([])); }, [dingtalk?.connected]);
  const save = async (values) => { await api('/admin/settings/attendance-reward', { method: 'POST', body: { ...values, departmentMode: mode, departmentIds: mode === 'selected' ? values.departmentIds || [] : [] } }); message.success('打卡奖励已保存'); load(); };
  return <Card title="钉钉打卡奖励" extra={<Space><Button onClick={onOpenDingtalk}>钉钉连接</Button><Button type="primary" onClick={() => form.submit()}>保存</Button></Space>}>
    {!dingtalk?.connected && <Typography.Paragraph type="warning">请先完成钉钉连接。当前不阻断本地管理功能，但部门选择不可用。</Typography.Paragraph>}
    <Form form={form} layout="vertical" onFinish={save} className="settings-form">
      <Form.Item name="enabled" label="启用打卡奖励" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item name="testMode" label="测试模式" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item name="lateGraceMinutes" label="宽限分钟数"><InputNumber min={0} precision={0} /></Form.Item>
      <Form.Item label="奖励范围"><Space><Form.Item name="rewardMin" noStyle><InputNumber min={1} precision={0} /></Form.Item><span>—</span><Form.Item name="rewardMax" noStyle><InputNumber min={1} precision={0} /></Form.Item></Space></Form.Item>
      <Form.Item name="maxPerDay" label="每日上限"><InputNumber min={1} precision={0} /></Form.Item>
      <Form.Item name="onlyCheckin" label="仅上班打卡" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item label="适用部门"><Select value={mode} onChange={setMode} options={[{ value: 'all', label: '全部部门' }, { value: 'selected', label: '指定部门' }]} style={{ width: 160 }} /></Form.Item>
      {mode === 'selected' && <Form.Item name="departmentIds" label="部门多选"><Select mode="multiple" disabled={!dingtalk?.connected} placeholder={dingtalk?.connected ? '选择部门' : '请先完成钉钉连接'} options={departments.map((d) => ({ value: String(d.dept_id), label: `${'　'.repeat(Number(d.depth || 0))}${d.name}` }))} /></Form.Item>}
      <Form.Item name="reason" label="奖励理由"><Input placeholder="打卡奖励" /></Form.Item>
    </Form>
  </Card>;
}

function Tokens() {
  const { message } = App.useApp(); const [rows, setRows] = useState([]);
  const load = async () => setRows((await api('/bob-token/list?includeRevoked=true&limit=200')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const create = async () => { const data = await api('/bob-token/create', { method: 'POST' }); message.success('Token 已创建'); if (data.token) navigator.clipboard?.writeText(data.token); load(); };
  return <Card title="BOB Token" extra={<Space><Button onClick={load}>刷新</Button><Button type="primary" onClick={create}>创建 Token</Button></Space>}>
    <Table rowKey="id" dataSource={rows} columns={[{ title: 'ID', dataIndex: 'id' }, { title: 'Token', dataIndex: 'token', ellipsis: true }, { title: '创建时间', dataIndex: 'created_at', render: formatTs }, { title: '吊销时间', dataIndex: 'revoked_at', render: formatTs }, { title: '状态', render: (_, r) => r.revoked_at ? <Tag>已吊销</Tag> : <Tag color="green">有效</Tag> }, { title: '操作', render: (_, r) => <Space><Button disabled={!r.token} onClick={() => navigator.clipboard?.writeText(r.token)}>复制</Button><Button danger disabled={Boolean(r.revoked_at)} onClick={() => api('/bob-token/revoke', { method: 'POST', body: { tokenId: r.id } }).then(load)}>吊销</Button></Space> }]} />
  </Card>;
}

function Backup() {
  return <Card title="备份导入导出"><Space direction="vertical"><Typography.Text type="secondary">覆盖导入属于高危操作，新版后台只保留安全入口，具体导入仍按原接口二次确认。</Typography.Text><Button href="/admin/backup/export?scope=full" target="_blank">导出完整备份</Button></Space></Card>;
}

export default function Integrations(props) {
  return <Tabs items={[{ key: 'ding', label: '钉钉与打卡', children: <Attendance {...props} /> }, { key: 'token', label: 'BOB Token', children: <Tokens /> }, { key: 'backup', label: '备份', children: <Backup /> }]} />;
}
