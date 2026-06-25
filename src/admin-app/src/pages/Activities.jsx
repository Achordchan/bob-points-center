import { useEffect, useState } from 'react';
import { App, Button, Card, Drawer, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag } from 'antd';
import { api, qs } from '../api.js';
import DataToolbar from '../components/DataToolbar.jsx';
import { amountText, formatTs } from '../utils.js';

function RedPackets() {
  const { message } = App.useApp();
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [form] = Form.useForm();
  const load = async () => { setStatus((await api('/admin/red-packet/status')).data); setHistory((await api('/admin/red-packet/history')).data || []); };
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const start = async (values) => { await api('/admin/red-packet/start', { method: 'POST', body: values }); message.success('红包活动已创建'); form.resetFields(); load(); };
  const clear = () => Modal.confirm({ title: '危险区：清空红包历史', content: '清空后无法恢复。', okButtonProps: { danger: true }, onOk: async () => { await api('/admin/red-packet/history/clear', { method: 'POST' }); message.success('已清空'); load(); } });
  return <Space direction="vertical" style={{ width: '100%' }}>
    <Card size="small" title="红包配置" extra={<Tag color={status?.active ? 'green' : 'default'}>{status?.active ? '进行中' : '未开始'}</Tag>}>
      <Form form={form} layout="inline" onFinish={start}><Form.Item name="total_amount" rules={[{ required: true }]}><InputNumber min={1} placeholder="总金额" /></Form.Item><Form.Item name="total_count" rules={[{ required: true }]}><InputNumber min={1} placeholder="人数" /></Form.Item><Form.Item name="countdown_seconds" rules={[{ required: true }]}><InputNumber min={0} placeholder="倒计时秒" /></Form.Item><Form.Item name="duration_minutes" rules={[{ required: true }]}><InputNumber min={1} placeholder="持续分钟" /></Form.Item><Form.Item name="sponsor"><Input placeholder="赞助人" /></Form.Item><Button type="primary" htmlType="submit">创建并开始</Button><Button onClick={load}>刷新</Button></Form>
    </Card>
    <DataToolbar onRefresh={load}><Button danger onClick={clear}>危险区：清空历史</Button></DataToolbar>
    <Table rowKey="id" dataSource={history} scroll={{ x: 980 }} columns={[{ title: 'ID', dataIndex: 'id' }, { title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '总额', dataIndex: 'total_amount', render: amountText }, { title: '份数', dataIndex: 'total_count' }, { title: '状态', dataIndex: 'status' }, { title: '赞助人', dataIndex: 'sponsor' }]} />
  </Space>;
}

function Charity() {
  const { message } = App.useApp();
  const [projects, setProjects] = useState([]);
  const [contribs, setContribs] = useState([]);
  const [editing, setEditing] = useState(null);
  const [projectFilter, setProjectFilter] = useState('');
  const [form] = Form.useForm();
  const loadProjects = async () => setProjects((await api('/admin/charity/projects')).data || []);
  const loadContribs = async () => setContribs((await api(`/admin/charity/contributions?${qs({ limit: 200, project_id: projectFilter })}`)).data || []);
  useEffect(() => { loadProjects().catch((e) => message.error(e.message)); }, []);
  useEffect(() => { loadContribs().catch(() => null); }, [projectFilter]);
  const open = (row = {}) => { setEditing(row); form.setFieldsValue({ ...row, tier_options: Array.isArray(row.tier_options) ? row.tier_options.join(',') : '10,20,50,100' }); };
  const save = async (values) => { await api('/admin/charity/projects/save', { method: 'POST', body: values }); message.success('公益项目已保存'); setEditing(null); loadProjects(); loadContribs(); };
  return <Space direction="vertical" style={{ width: '100%' }}>
    <DataToolbar onRefresh={() => { loadProjects(); loadContribs(); }} onCreate={() => open({ project_id: `CHARITY_${Date.now().toString(36).toUpperCase()}`, status: 'active', execution_status: 'pending' })} createText="新增公益项目" />
    <Table rowKey="project_id" dataSource={projects} scroll={{ x: 1100 }} columns={[{ title: '项目ID', dataIndex: 'project_id', ellipsis: true }, { title: '名称', dataIndex: 'project_name' }, { title: '目标', dataIndex: 'target_bob_amount', render: amountText }, { title: '已助力', dataIndex: 'total_bob_amount', render: amountText }, { title: '人数', dataIndex: 'donor_count' }, { title: '状态', dataIndex: 'status' }, { title: '执行', dataIndex: 'execution_status' }, { title: '操作', render: (_, r) => <Button onClick={() => open(r)}>编辑</Button> }]} />
    <Card size="small" title="助力记录" extra={<Select allowClear placeholder="项目筛选" style={{ width: 220 }} value={projectFilter || undefined} onChange={(v) => setProjectFilter(v || '')} options={projects.map((p) => ({ value: p.project_id, label: p.project_name }))} />}>
      <Table rowKey="id" size="small" dataSource={contribs} columns={[{ title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '项目', dataIndex: 'project_name' }, { title: '用户', dataIndex: 'user_name_snapshot' }, { title: '金额', dataIndex: 'bob_amount', render: amountText }]} />
    </Card>
    <Drawer title="公益项目" open={Boolean(editing)} onClose={() => setEditing(null)} width={680} extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="project_id" label="项目ID" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="project_name" label="项目名称" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="summary" label="简介" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
        <Form.Item name="rules_text" label="规则" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item>
        <Form.Item name="target_bob_amount" label="目标 BOB" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
        <Form.Item name="tier_options" label="助力档位"><Input placeholder="10,20,50,100" /></Form.Item>
        <Form.Item name="status" label="状态"><Select options={[{ value: 'active', label: '启用' }, { value: 'paused', label: '暂停' }, { value: 'archived', label: '归档' }]} /></Form.Item>
        <Form.Item name="execution_status" label="执行状态"><Select options={[{ value: 'pending', label: '待执行' }, { value: 'in_progress', label: '执行中' }, { value: 'completed', label: '已完成' }]} /></Form.Item>
        <Form.Item name="execution_note" label="执行说明"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Drawer>
  </Space>;
}

export default function Activities() {
  return <Card><Tabs items={[{ key: 'red', label: '红包活动', children: <RedPackets /> }, { key: 'charity', label: '公益助力', children: <Charity /> }]} /></Card>;
}
