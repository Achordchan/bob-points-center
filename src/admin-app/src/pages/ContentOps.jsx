import { useEffect, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Form, Input, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { api, qs } from '../api.js';
import DataToolbar from '../components/DataToolbar.jsx';
import RichTextEditor from '../components/RichTextEditor.jsx';
import { formatTs, toUnix } from '../utils.js';
import { hasPermission } from '../permissions.js';

const feedbackStatusText = { pending: '待处理', processing: '处理中', resolved: '已处理', rejected: '已驳回' };
const feedbackCategoryText = { bug: '问题反馈', question: '咨询问题', rule: '规则相关', suggestion: '建议', other: '其他' };
const announcementLevelText = { info: '普通', success: '成功', warning: '提醒', danger: '重要' };
const announcementLevelColor = { info: 'blue', success: 'green', warning: 'orange', danger: 'red' };


function toDateTimeLocal(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function richTextIsEmpty(value) {
  const text = String(value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim();
  return !text;
}

function plainText(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function FeedbackMessageContent({ item }) {
  const content = String(item?.content || '');
  if (item?.sender_type === 'admin' && /^\s*</.test(content)) {
    return <div className="feedback-message-content rich-content" dangerouslySetInnerHTML={{ __html: content }} />;
  }
  return <div className="feedback-message-content">{content || '-'}</div>;
}

function Faq({ canEdit, canDelete }) {
  const { message, modal } = App.useApp(); const [rows, setRows] = useState([]); const [editing, setEditing] = useState(null); const [form] = Form.useForm();
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
  const del = (id) => modal.confirm({ title: '删除 FAQ', okButtonProps: { danger: true }, onOk: async () => { await api('/admin/content/faq/delete', { method: 'POST', body: { id } }); load(); } });
  return <Card><DataToolbar onRefresh={load} onCreate={canEdit ? () => open() : null} createText="新增 FAQ" /><Table rowKey="id" dataSource={rows} columns={[{ title: '问题', dataIndex: 'question' }, { title: '顺序', dataIndex: 'sort', width: 110 }, { title: '状态', dataIndex: 'is_enabled', render: (v) => Number(v) === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> }, { title: '操作', render: (_, r, index) => <Space>{canEdit && <Button disabled={index === 0} onClick={() => move(index, -1)}>上移</Button>}{canEdit && <Button disabled={index === rows.length - 1} onClick={() => move(index, 1)}>下移</Button>}{canEdit && <Button onClick={() => open(r)}>编辑</Button>}{canDelete && <Button danger onClick={() => del(r.id)}>删除</Button>}</Space> }]} />
    <Drawer title={editing?.id ? "编辑 FAQ" : "新增 FAQ"} open={Boolean(editing)} onClose={() => { setEditing(null); form.resetFields(); }} extra={canEdit ? <Button type="primary" onClick={() => form.submit()}>保存</Button> : null}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="question" label="问题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="answer" label="答案" rules={[{ required: true }]}><Input.TextArea rows={6} /></Form.Item><Form.Item name="sort" label="顺序"><Input /></Form.Item><Form.Item name="is_enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></Form></Drawer>
  </Card>;
}

function Announcements({ canEdit, canDelete }) {
  const { message, modal } = App.useApp(); const [rows, setRows] = useState([]); const [editing, setEditing] = useState(null); const [form] = Form.useForm();
  const load = async () => setRows((await api('/admin/content/announcements?limit=120')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const open = (r = { level: 'info', is_enabled: 1, sort: 0 }) => { form.resetFields(); setEditing(r); form.setFieldsValue({ ...r, publish_at: toDateTimeLocal(r.publish_at), is_enabled: Number(r.is_enabled ?? 1) === 1 }); };
  const save = async (v) => { await api('/admin/content/announcements/save', { method: 'POST', body: { ...v, id: editing?.id || null, is_enabled: v.is_enabled ? 1 : 0, publish_at: toUnix(v.publish_at) } }); message.success('公告已保存'); setEditing(null); form.resetFields(); load(); };
  const del = (id) => modal.confirm({ title: '删除公告', okButtonProps: { danger: true }, onOk: async () => { await api('/admin/content/announcements/delete', { method: 'POST', body: { id } }); load(); } });
  return <Card><DataToolbar onRefresh={load} onCreate={canEdit ? () => open() : null} createText="新增公告" /><Table rowKey="id" dataSource={rows} columns={[{ title: '标题', dataIndex: 'title' }, { title: '级别', dataIndex: 'level', render: (v) => <Tag color={announcementLevelColor[v] || 'default'}>{announcementLevelText[v] || v || '-'}</Tag> }, { title: '状态', dataIndex: 'is_enabled', render: (v) => Number(v) === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> }, { title: '发布时间', dataIndex: 'publish_at', render: formatTs }, { title: '操作', render: (_, r) => <Space>{canEdit && <Button onClick={() => open(r)}>编辑</Button>}{canDelete && <Button danger onClick={() => del(r.id)}>删除</Button>}</Space> }]} />
    <Drawer title={editing?.id ? "编辑公告" : "新增公告"} open={Boolean(editing)} onClose={() => { setEditing(null); form.resetFields(); }} extra={canEdit ? <Button type="primary" onClick={() => form.submit()}>保存</Button> : null}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="content" label="内容" rules={[{ required: true }]}><Input.TextArea rows={6} /></Form.Item><Form.Item name="level" label="级别"><Select options={[{ value: 'info', label: '普通' }, { value: 'success', label: '成功' }, { value: 'warning', label: '提醒' }, { value: 'danger', label: '重要' }]} /></Form.Item><Form.Item name="publish_at" label="发布时间"><Input type="datetime-local" /></Form.Item><Form.Item name="sort" label="排序"><Input /></Form.Item><Form.Item name="is_enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></Form></Drawer>
  </Card>;
}

function Feedback({ canEdit }) {
  const { message } = App.useApp(); const [rows, setRows] = useState([]); const [status, setStatus] = useState(''); const [keyword, setKeyword] = useState(''); const [handling, setHandling] = useState(null); const [form] = Form.useForm();
  const load = async () => setRows((await api(`/admin/content/feedback?${qs({ limit: 200, status, keyword })}`)).data || []);
  useEffect(() => {
    const timer = window.setTimeout(() => { load().catch((e) => message.error(e.message)); }, 300);
    return () => window.clearTimeout(timer);
  }, [status, keyword]);
  const open = (row) => { form.resetFields(); setHandling(row); form.setFieldsValue({ status: row.status || 'pending', reply: '' }); };
  const saveStatus = async () => {
    const values = await form.validateFields(['status']);
    await api('/admin/content/feedback/handle', { method: 'POST', body: { id: handling.id, status: values.status, reply: '' } });
    message.success('状态已保存');
    await load();
  };
  const sendReply = async () => {
    const values = await form.validateFields(['status']);
    const reply = form.getFieldValue('reply') || '';
    if (richTextIsEmpty(reply)) return message.warning('请先填写回复内容');
    await api('/admin/content/feedback/handle', { method: 'POST', body: { id: handling.id, status: values.status, reply } });
    message.success('回复已发送');
    form.setFieldValue('reply', '');
    setHandling(null);
    await load();
  };
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
      { title: '回复', dataIndex: 'reply', ellipsis: true, render: (v) => plainText(v) || '-' },
      { title: '时间', dataIndex: 'created_at', render: formatTs },
      { title: '操作', render: (_, r) => <Button onClick={() => open(r)}>{canEdit ? '处理' : '详情'}</Button> },
    ]} />
    <Drawer title="处理反馈" open={Boolean(handling)} onClose={() => { setHandling(null); form.resetFields(); }} width={760}>
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
              <FeedbackMessageContent item={item} />
            </div>)}
          </div>
        </Card>
        <Form form={form} layout="vertical">
          <Form.Item label="处理状态" required>
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item name="status" noStyle rules={[{ required: true, message: '请选择状态' }]}><Select disabled={!canEdit} options={[{ value: 'pending', label: '待处理' }, { value: 'processing', label: '处理中' }, { value: 'resolved', label: '已处理' }, { value: 'rejected', label: '已驳回' }]} /></Form.Item>
              {canEdit && <Button onClick={saveStatus}>保存状态</Button>}
            </Space.Compact>
          </Form.Item>
          <Form.Item label="追加回复" name="reply"><RichTextEditor minHeight={150} disabled={!canEdit} /></Form.Item>
          {canEdit && <div className="feedback-reply-actions"><Button type="primary" onClick={sendReply}>发送回复</Button></div>}
        </Form>
      </Space>}
    </Drawer>
  </Card>;
}


function Versions({ canEdit }) {
  const { message } = App.useApp(); const [rows, setRows] = useState([]); const [editing, setEditing] = useState(null); const [form] = Form.useForm();
  const load = async () => setRows((await api('/admin/content/version')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const save = async (v) => { await api('/admin/content/version/save', { method: 'POST', body: { ...v, id: editing?.id || null, is_enabled: v.is_enabled ? 1 : 0, publish_at: toUnix(v.publish_at) } }); message.success('版本已保存'); setEditing(null); form.resetFields(); load(); };
  return <Card><DataToolbar onRefresh={load} onCreate={canEdit ? () => { form.resetFields(); setEditing({ is_enabled: 1 }); form.setFieldsValue({ is_enabled: true, publish_at: '' }); } : null} createText="新增版本" /><Table rowKey="id" dataSource={rows} columns={[{ title: '版本', dataIndex: 'version_name' }, { title: '说明', dataIndex: 'release_notes' }, { title: '状态', dataIndex: 'is_enabled', render: (v) => Number(v) === 1 ? '启用' : '停用' }, { title: '时间', dataIndex: 'publish_at', render: formatTs }, { title: '操作', render: (_, r) => canEdit ? <Button onClick={() => { form.resetFields(); setEditing(r); form.setFieldsValue({ ...r, publish_at: toDateTimeLocal(r.publish_at), is_enabled: Number(r.is_enabled) === 1 }); }}>编辑</Button> : '-' }]} /><Drawer title={editing?.id ? "编辑版本" : "新增版本"} open={Boolean(editing)} onClose={() => { setEditing(null); form.resetFields(); }} extra={canEdit ? <Button type="primary" onClick={() => form.submit()}>保存</Button> : null}><Form form={form} layout="vertical" onFinish={save}><Form.Item name="version_name" label="版本" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="release_notes" label="说明"><Input.TextArea rows={6} /></Form.Item><Form.Item name="publish_at" label="发布时间"><Input type="datetime-local" /></Form.Item><Form.Item name="is_enabled" label="启用" valuePropName="checked"><Switch /></Form.Item></Form></Drawer></Card>;
}

export default function ContentOps({ me }) {
  const canEdit = hasPermission(me, 'content:edit');
  const canDelete = hasPermission(me, 'content:delete');
  return <Tabs items={[{ key: 'faq', label: 'FAQ', children: <Faq canEdit={canEdit} canDelete={canDelete} /> }, { key: 'ann', label: '公告', children: <Announcements canEdit={canEdit} canDelete={canDelete} /> }, { key: 'feedback', label: '反馈', children: <Feedback canEdit={canEdit} /> }, { key: 'version', label: '版本', children: <Versions canEdit={canEdit} /> }]} />;
}
