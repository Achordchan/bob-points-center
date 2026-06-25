import { useEffect, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Form, Input, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { api, qs } from '../api.js';
import DataToolbar from '../components/DataToolbar.jsx';
import { formatTs, toUnix } from '../utils.js';

const feedbackStatusText = { pending: '待处理', processing: '处理中', resolved: '已处理', rejected: '已驳回' };
const feedbackCategoryText = { bug: '问题反馈', question: '咨询问题', rule: '规则相关', suggestion: '建议', other: '其他' };
const announcementLevelText = { info: '普通', warning: '提醒', danger: '重要' };
const announcementLevelColor = { info: 'blue', warning: 'orange', danger: 'red' };

function Faq() {
  const { message } = App.useApp(); const [rows, setRows] = useState([]); const [editing, setEditing] = useState(null); const [form] = Form.useForm();
  const load = async () => setRows((await api('/admin/content/faq?limit=200')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const open = (r = { is_enabled: 1, sort: 0 }) => { form.resetFields(); setEditing(r); form.setFieldsValue({ ...r, is_enabled: Number(r.is_enabled ?? 1) === 1 }); };
  const save = async (v) => { await api('/admin/content/faq/save', { method: 'POST', body: { ...v, id: editing?.id || null, is_enabled: v.is_enabled ? 1 : 0 } }); message.success('FAQ 已保存'); setEditing(null); form.resetFields(); load(); };
  const saveOrder = async (nextRows) => {
    setRows(nextRows.map((row, index) => ({ ...row, sort: index })));
    await Promise.all(nextRows.map((row, index) => api('/admin/content/faq/save', { method: 'POST', body: { ...row, sort: index, is_enabled: Number(row.is_enabled) === 1 ? 1 : 0 } })));
    message.success('排序已更新');
    load();
  };
  const move = async (index, offset) => {
    const target = index + offset;
    if (target < 0 || target >= rows.length) return;
    const nextRows = rows.slice();
    [nextRows[index], nextRows[target]] = [nextRows[target], nextRows[index]];
    await saveOrder(nextRows);
  };
  const del = (id) => Modal.confirm({ title: '删除 FAQ', okButtonProps: { danger: true }, onOk: async () => { await api('/admin/content/faq/delete', { method: 'POST', body: { id } }); load(); } });
  return <Card><DataToolbar onRefresh={load} onCreate={() => open()} createText="新增 FAQ" /><Table rowKey="id" dataSource={rows} columns={[{ title: '问题', dataIndex: 'question' }, { title: '顺序', dataIndex: 'sort', width: 110 }, { title: '状态', dataIndex: 'is_enabled', render: (v) => Number(v) === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> }, { title: '操作', render: (_, r, index) => <Space><Button disabled={index === 0} onClick={() => move(index, -1)}>上移</Button><Button disabled={index === rows.length - 1} onClick={() => move(index, 1)}>下移</Button><Button onClick={() => open(r)}>编辑</Button><Button danger onClick={() => del(r.id)}>删除</Button></Space> }]} />
    <Drawer title={editing?.id ? "编辑 FAQ" : "新增 FAQ"} open={Boolean(editing)} onClose={() => { setEditing(null); form.resetFields(); }} extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="question" label="问题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="answer" label="答案" rules={[{ required: true }]}><Input.TextArea rows={6} /></Form.Item><Form.Item name="sort" label="顺序"><Input /></Form.Item><Form.Item name="is_enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></Form></Drawer>
  </Card>;
}

function Announcements() {
  const { message } = App.useApp(); const [rows, setRows] = useState([]); const [editing, setEditing] = useState(null); const [form] = Form.useForm();
  const load = async () => setRows((await api('/admin/content/announcements?limit=120')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const open = (r = { level: 'info', is_enabled: 1, sort: 0 }) => { form.resetFields(); setEditing(r); form.setFieldsValue({ ...r, is_enabled: Number(r.is_enabled ?? 1) === 1 }); };
  const save = async (v) => { await api('/admin/content/announcements/save', { method: 'POST', body: { ...v, id: editing?.id || null, is_enabled: v.is_enabled ? 1 : 0, publish_at: toUnix(v.publish_at) } }); message.success('公告已保存'); setEditing(null); form.resetFields(); load(); };
  const del = (id) => Modal.confirm({ title: '删除公告', okButtonProps: { danger: true }, onOk: async () => { await api('/admin/content/announcements/delete', { method: 'POST', body: { id } }); load(); } });
  return <Card><DataToolbar onRefresh={load} onCreate={() => open()} createText="新增公告" /><Table rowKey="id" dataSource={rows} columns={[{ title: '标题', dataIndex: 'title' }, { title: '级别', dataIndex: 'level', render: (v) => <Tag color={announcementLevelColor[v] || 'default'}>{announcementLevelText[v] || v || '-'}</Tag> }, { title: '状态', dataIndex: 'is_enabled', render: (v) => Number(v) === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> }, { title: '发布时间', dataIndex: 'publish_at', render: formatTs }, { title: '操作', render: (_, r) => <Space><Button onClick={() => open(r)}>编辑</Button><Button danger onClick={() => del(r.id)}>删除</Button></Space> }]} />
    <Drawer title={editing?.id ? "编辑公告" : "新增公告"} open={Boolean(editing)} onClose={() => { setEditing(null); form.resetFields(); }} extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="content" label="内容" rules={[{ required: true }]}><Input.TextArea rows={6} /></Form.Item><Form.Item name="level" label="级别"><Select options={[{ value: 'info', label: '普通' }, { value: 'warning', label: '提醒' }, { value: 'danger', label: '重要' }]} /></Form.Item><Form.Item name="sort" label="排序"><Input /></Form.Item><Form.Item name="is_enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></Form></Drawer>
  </Card>;
}

function Feedback() {
  const { message } = App.useApp(); const [rows, setRows] = useState([]); const [status, setStatus] = useState(''); const [keyword, setKeyword] = useState(''); const [handling, setHandling] = useState(null); const [form] = Form.useForm();
  const load = async () => setRows((await api(`/admin/content/feedback?${qs({ limit: 200, status, keyword })}`)).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, [status]);
  const open = (row) => { form.resetFields(); setHandling(row); form.setFieldsValue({ status: row.status || 'pending', reply: '' }); };
  const save = async (values) => { await api('/admin/content/feedback/handle', { method: 'POST', body: { id: handling.id, status: values.status, reply: values.reply || '' } }); message.success(values.reply ? '回复已追加' : '状态已更新'); setHandling(null); form.resetFields(); load(); };
  const messages = (row) => {
    const list = Array.isArray(row?.messages) ? row.messages : [];
    if (list.length) return list;
    const fallback = row?.content ? [{ sender_type: 'user', sender_name: row.name, content: row.content, created_at: row.created_at }] : [];
    if (row?.reply) fallback.push({ sender_type: 'admin', sender_name: row.handled_name || row.handled_by, content: row.reply, created_at: row.handled_at });
    return fallback;
  };
  return <Card>
    <DataToolbar keyword={keyword} onKeyword={setKeyword} onRefresh={load}><Select allowClear placeholder="状态" style={{ width: 140 }} value={status || undefined} onChange={(v) => setStatus(v || '')} options={[{ value: 'pending', label: '待处理' }, { value: 'processing', label: '处理中' }, { value: 'resolved', label: '已处理' }, { value: 'rejected', label: '已驳回' }]} /></DataToolbar>
    <Table rowKey="id" dataSource={rows} columns={[
      { title: '用户', render: (_, r) => r.name ? `${r.name} (${r.userid})` : r.userid },
      { title: '类型', dataIndex: 'category', render: (v) => feedbackCategoryText[v] || v || '-' },
      { title: '内容', dataIndex: 'content', ellipsis: true },
      { title: '状态', dataIndex: 'status', render: (v) => <Tag color={v === 'resolved' ? 'green' : v === 'rejected' ? 'red' : v === 'processing' ? 'blue' : 'default'}>{feedbackStatusText[v] || v || '-'}</Tag> },
      { title: '回复', dataIndex: 'reply', ellipsis: true, render: (v) => v || '-' },
      { title: '时间', dataIndex: 'created_at', render: formatTs },
      { title: '操作', render: (_, r) => <Button onClick={() => open(r)}>处理</Button> },
    ]} />
    <Drawer title="处理反馈" open={Boolean(handling)} onClose={() => { setHandling(null); form.resetFields(); }} width={720} extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}>
      {handling && <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Descriptions bordered column={1} items={[
          { key: 'user', label: '用户', children: handling.name ? `${handling.name} (${handling.userid})` : handling.userid },
          { key: 'category', label: '类型', children: feedbackCategoryText[handling.category] || handling.category || '-' },
          { key: 'contact', label: '联系方式', children: handling.contact || '-' },
          { key: 'created', label: '提交时间', children: formatTs(handling.created_at) },
          { key: 'handled', label: '处理人', children: handling.handled_name || handling.handled_by || '-' },
        ]} />
        <Card size="small" title="反馈内容"><Typography.Paragraph className="feedback-content-text">{handling.content || '-'}</Typography.Paragraph></Card>
        <Card size="small" title="对话记录">
          <div className="feedback-message-list">
            {messages(handling).map((item, index) => <div className={`feedback-message ${item.sender_type === 'admin' ? 'is-admin' : 'is-user'}`} key={item.id || index}>
              <div className="feedback-message-meta">{item.sender_type === 'admin' ? '后台回复' : '用户反馈'} · {item.sender_name || '-'} · {formatTs(item.created_at)}</div>
              <div className="feedback-message-content">{item.content || '-'}</div>
            </div>)}
          </div>
        </Card>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item label="处理状态" name="status" rules={[{ required: true, message: '请选择状态' }]}><Select options={[{ value: 'pending', label: '待处理' }, { value: 'processing', label: '处理中' }, { value: 'resolved', label: '已处理' }, { value: 'rejected', label: '已驳回' }]} /></Form.Item>
          <Form.Item label="追加回复" name="reply"><Input.TextArea rows={5} placeholder="填写本次回复内容，保存后会追加到对话记录" /></Form.Item>
        </Form>
      </Space>}
    </Drawer>
  </Card>;
}


function Versions() {
  const { message } = App.useApp(); const [rows, setRows] = useState([]); const [editing, setEditing] = useState(null); const [form] = Form.useForm();
  const load = async () => setRows((await api('/admin/content/version')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const save = async (v) => { await api('/admin/content/version/save', { method: 'POST', body: { ...v, id: editing?.id || null, is_enabled: v.is_enabled ? 1 : 0 } }); message.success('版本已保存'); setEditing(null); form.resetFields(); load(); };
  return <Card><DataToolbar onRefresh={load} onCreate={() => { form.resetFields(); setEditing({ is_enabled: 1 }); form.setFieldsValue({ is_enabled: true }); }} createText="新增版本" /><Table rowKey="id" dataSource={rows} columns={[{ title: '版本', dataIndex: 'version_name' }, { title: '说明', dataIndex: 'release_notes' }, { title: '状态', dataIndex: 'is_enabled', render: (v) => Number(v) === 1 ? '启用' : '停用' }, { title: '时间', dataIndex: 'publish_at', render: formatTs }, { title: '操作', render: (_, r) => <Button onClick={() => { form.resetFields(); setEditing(r); form.setFieldsValue({ ...r, is_enabled: Number(r.is_enabled) === 1 }); }}>编辑</Button> }]} /><Drawer title={editing?.id ? "编辑版本" : "新增版本"} open={Boolean(editing)} onClose={() => { setEditing(null); form.resetFields(); }} extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="version_name" label="版本" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="release_notes" label="说明"><Input.TextArea rows={6} /></Form.Item><Form.Item name="is_enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></Form></Drawer></Card>;
}

export default function ContentOps() {
  return <Tabs items={[{ key: 'faq', label: 'FAQ', children: <Faq /> }, { key: 'ann', label: '公告', children: <Announcements /> }, { key: 'feedback', label: '反馈', children: <Feedback /> }, { key: 'version', label: '版本', children: <Versions /> }]} />;
}
