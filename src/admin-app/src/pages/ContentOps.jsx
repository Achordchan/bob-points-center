import { useEffect, useState } from 'react';
import { App, Button, Card, Drawer, Form, Input, Modal, Select, Space, Switch, Table, Tabs, Tag } from 'antd';
import { api, qs } from '../api.js';
import DataToolbar from '../components/DataToolbar.jsx';
import { formatTs, toUnix } from '../utils.js';

function Faq() {
  const { message } = App.useApp(); const [rows, setRows] = useState([]); const [editing, setEditing] = useState(null); const [form] = Form.useForm();
  const load = async () => setRows((await api('/admin/content/faq?limit=200')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const open = (r = { is_enabled: 1 }) => { setEditing(r); form.setFieldsValue({ ...r, is_enabled: Number(r.is_enabled ?? 1) === 1 }); };
  const save = async (v) => { await api('/admin/content/faq/save', { method: 'POST', body: { ...v, id: editing?.id || null, is_enabled: v.is_enabled ? 1 : 0 } }); message.success('FAQ 已保存'); setEditing(null); load(); };
  const del = (id) => Modal.confirm({ title: '删除 FAQ', okButtonProps: { danger: true }, onOk: async () => { await api('/admin/content/faq/delete', { method: 'POST', body: { id } }); load(); } });
  return <Card><DataToolbar onRefresh={load} onCreate={() => open()} createText="新增 FAQ" /><Table rowKey="id" dataSource={rows} columns={[{ title: '问题', dataIndex: 'question' }, { title: '排序', dataIndex: 'sort' }, { title: '状态', dataIndex: 'is_enabled', render: (v) => Number(v) === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> }, { title: '操作', render: (_, r) => <Space><Button onClick={() => open(r)}>编辑</Button><Button danger onClick={() => del(r.id)}>删除</Button></Space> }]} />
    <Drawer title="FAQ" open={Boolean(editing)} onClose={() => setEditing(null)} extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="question" label="问题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="answer" label="答案" rules={[{ required: true }]}><Input.TextArea rows={6} /></Form.Item><Form.Item name="sort" label="排序"><Input /></Form.Item><Form.Item name="is_enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></Form></Drawer>
  </Card>;
}

function Announcements() {
  const { message } = App.useApp(); const [rows, setRows] = useState([]); const [editing, setEditing] = useState(null); const [form] = Form.useForm();
  const load = async () => setRows((await api('/admin/content/announcements?limit=120')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const open = (r = { level: 'info', is_enabled: 1 }) => { setEditing(r); form.setFieldsValue({ ...r, is_enabled: Number(r.is_enabled ?? 1) === 1 }); };
  const save = async (v) => { await api('/admin/content/announcements/save', { method: 'POST', body: { ...v, id: editing?.id || null, is_enabled: v.is_enabled ? 1 : 0, publish_at: toUnix(v.publish_at) } }); message.success('公告已保存'); setEditing(null); load(); };
  const del = (id) => Modal.confirm({ title: '删除公告', okButtonProps: { danger: true }, onOk: async () => { await api('/admin/content/announcements/delete', { method: 'POST', body: { id } }); load(); } });
  return <Card><DataToolbar onRefresh={load} onCreate={() => open()} createText="新增公告" /><Table rowKey="id" dataSource={rows} columns={[{ title: '标题', dataIndex: 'title' }, { title: '级别', dataIndex: 'level' }, { title: '状态', dataIndex: 'is_enabled', render: (v) => Number(v) === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> }, { title: '发布时间', dataIndex: 'publish_at', render: formatTs }, { title: '操作', render: (_, r) => <Space><Button onClick={() => open(r)}>编辑</Button><Button danger onClick={() => del(r.id)}>删除</Button></Space> }]} />
    <Drawer title="公告" open={Boolean(editing)} onClose={() => setEditing(null)} extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="content" label="内容" rules={[{ required: true }]}><Input.TextArea rows={6} /></Form.Item><Form.Item name="level" label="级别"><Select options={[{ value: 'info', label: '普通' }, { value: 'warning', label: '提醒' }, { value: 'danger', label: '重要' }]} /></Form.Item><Form.Item name="sort" label="排序"><Input /></Form.Item><Form.Item name="is_enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></Form></Drawer>
  </Card>;
}

function Feedback() {
  const { message } = App.useApp(); const [rows, setRows] = useState([]); const [status, setStatus] = useState(''); const [keyword, setKeyword] = useState('');
  const load = async () => setRows((await api(`/admin/content/feedback?${qs({ limit: 200, status, keyword })}`)).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, [status]);
  const handle = async (r, nextStatus) => { await api('/admin/content/feedback/handle', { method: 'POST', body: { id: r.id, status: nextStatus, reply: r.reply || '' } }); message.success('反馈已更新'); load(); };
  return <Card><DataToolbar keyword={keyword} onKeyword={setKeyword} onRefresh={load}><Select allowClear placeholder="状态" style={{ width: 140 }} value={status || undefined} onChange={(v) => setStatus(v || '')} options={[{ value: 'pending', label: '待处理' }, { value: 'processing', label: '处理中' }, { value: 'resolved', label: '已处理' }, { value: 'rejected', label: '已驳回' }]} /></DataToolbar><Table rowKey="id" dataSource={rows} columns={[{ title: '用户', render: (_, r) => r.name ? `${r.name} (${r.userid})` : r.userid }, { title: '类型', dataIndex: 'category' }, { title: '内容', dataIndex: 'content' }, { title: '状态', dataIndex: 'status' }, { title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '操作', render: (_, r) => <Space><Button onClick={() => handle(r, 'processing')}>处理中</Button><Button type="primary" onClick={() => handle(r, 'resolved')}>处理完成</Button></Space> }]} /></Card>;
}

function Versions() {
  const { message } = App.useApp(); const [rows, setRows] = useState([]); const [editing, setEditing] = useState(null); const [form] = Form.useForm();
  const load = async () => setRows((await api('/admin/content/version')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const save = async (v) => { await api('/admin/content/version/save', { method: 'POST', body: { ...v, id: editing?.id || null, is_enabled: v.is_enabled ? 1 : 0 } }); message.success('版本已保存'); setEditing(null); load(); };
  return <Card><DataToolbar onRefresh={load} onCreate={() => { setEditing({ is_enabled: 1 }); form.setFieldsValue({ is_enabled: true }); }} createText="新增版本" /><Table rowKey="id" dataSource={rows} columns={[{ title: '版本', dataIndex: 'version_name' }, { title: '说明', dataIndex: 'release_notes' }, { title: '状态', dataIndex: 'is_enabled', render: (v) => Number(v) === 1 ? '启用' : '停用' }, { title: '时间', dataIndex: 'publish_at', render: formatTs }, { title: '操作', render: (_, r) => <Button onClick={() => { setEditing(r); form.setFieldsValue({ ...r, is_enabled: Number(r.is_enabled) === 1 }); }}>编辑</Button> }]} /><Drawer title="版本信息" open={Boolean(editing)} onClose={() => setEditing(null)} extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="version_name" label="版本" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="release_notes" label="说明"><Input.TextArea rows={6} /></Form.Item><Form.Item name="is_enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></Form></Drawer></Card>;
}

export default function ContentOps() {
  return <Tabs items={[{ key: 'faq', label: 'FAQ', children: <Faq /> }, { key: 'ann', label: '公告', children: <Announcements /> }, { key: 'feedback', label: '反馈', children: <Feedback /> }, { key: 'version', label: '版本', children: <Versions /> }]} />;
}
