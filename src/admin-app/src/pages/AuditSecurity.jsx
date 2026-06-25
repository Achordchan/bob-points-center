import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Drawer, Form, Input, InputNumber, Modal, Space, Table, Tabs, Tag } from 'antd';
import { api, qs } from '../api.js';
import { formatTs } from '../utils.js';

function statusTag(code) {
  if (code === null || code === undefined || code === '' || Number(code) === 0) return <Tag>已记录</Tag>;
  const n = Number(code);
  if (n >= 200 && n < 300) return <Tag color="green">成功</Tag>;
  if (n >= 400) return <Tag color="red">失败</Tag>;
  return <Tag color="orange">需确认</Tag>;
}

function AuditLogs() {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setRows((await api(`/admin/logs?${qs({ days, limit: 300 })}`)).data || []);
    } catch (e) {
      message.error(e.message || '审计日志加载失败');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load().catch(() => null); }, []);
  return <Card title="审计日志" extra={<Space><InputNumber value={days} onChange={(v) => setDays(v || 30)} addonAfter="天" min={1} max={365} style={{ width: 140 }} /><Button onClick={load}>刷新</Button></Space>}>
    <Table rowKey="id" loading={loading} dataSource={rows} scroll={{ x: 1180 }} columns={[
      { title: '时间', dataIndex: 'created_at', render: formatTs, width: 180 },
      { title: '事件', dataIndex: 'event_label', render: (v, r) => <Tag color={r.event_group === 'danger' ? 'red' : undefined}>{v || r.event_type}</Tag>, width: 150 },
      { title: '操作者', render: (_, r) => r.actor_display_name || r.actor_name || r.actor_id || r.actor_type, width: 180 },
      { title: 'IP', dataIndex: 'ip', ellipsis: true, width: 150 },
      { title: '路径', dataIndex: 'path', ellipsis: true },
      { title: '状态', dataIndex: 'status_code', render: statusTag, width: 100 },
      { title: '说明', dataIndex: 'message', ellipsis: true },
    ]} />
  </Card>;
}

function RoleManagement() {
  const { message } = App.useApp();
  const [roles, setRoles] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  const load = async () => {
    const [roleData, catalogData] = await Promise.all([api('/admin/roles'), api('/admin/permissions/catalog')]);
    setRoles(roleData.data || []);
    setCatalog(catalogData.data || []);
  };
  useEffect(() => { load().catch((e) => message.error(e.message || '角色权限加载失败')); }, []);

  const open = (role = null) => {
    setEditing(role || {});
    form.setFieldsValue({ name: role?.name || '', permissions: role?.permissions || [] });
  };
  const save = async (values) => {
    await api('/admin/roles/save', { method: 'POST', body: { id: editing?.id || null, name: values.name, permissions: values.permissions || [] } });
    message.success('角色已保存');
    setEditing(null);
    await load();
  };
  const disable = (role) => Modal.confirm({
    title: '停用角色',
    content: `确认停用「${role.name}」？已有用户使用时请先调整用户角色。`,
    okText: '确认停用',
    cancelText: '取消',
    okButtonProps: { danger: true },
    onOk: async () => { await api('/admin/roles/disable', { method: 'POST', body: { id: role.id } }); message.success('角色已停用'); load(); },
  });

  return <Card title="角色与权限" extra={<Button type="primary" onClick={() => open()}>新增角色</Button>}>
    <Table rowKey="id" dataSource={roles} columns={[
      { title: '角色名称', dataIndex: 'name' },
      { title: '成员数', dataIndex: 'user_count', width: 100 },
      { title: '状态', dataIndex: 'is_enabled', render: (v) => Number(v) === 1 ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>, width: 100 },
      { title: '权限数', render: (_, r) => `${r.permissions?.length || 0} 项`, width: 100 },
      { title: '操作', width: 160, render: (_, r) => <Space><Button onClick={() => open(r)}>编辑</Button><Button danger disabled={Number(r.is_enabled) !== 1} onClick={() => disable(r)}>停用</Button></Space> },
    ]} />
    <Drawer title={editing?.id ? '编辑角色' : '新增角色'} open={Boolean(editing)} onClose={() => setEditing(null)} width={720} extra={<Button type="primary" onClick={() => form.submit()}>保存角色</Button>}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="name" label="角色名称" rules={[{ required: true, message: '请输入角色名称' }]}><Input placeholder="例如：区域运营" /></Form.Item>
        <Form.Item name="permissions" label="权限范围">
          <Checkbox.Group style={{ width: '100%' }}>
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              {catalog.map((group) => <Card size="small" key={group.group} title={group.group}>
                <Space wrap>{(group.permissions || []).map((item) => <Checkbox key={item.key} value={item.key} disabled={item.superOnly}>{item.label}{item.superOnly ? '（仅超级管理员）' : ''}</Checkbox>)}</Space>
              </Card>)}
            </Space>
          </Checkbox.Group>
        </Form.Item>
      </Form>
    </Drawer>
  </Card>;
}

function DangerZone() {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  const submit = async (values) => {
    if (values.confirm !== 'RESET_ALL') return message.warning('确认口令不正确，已取消');
    setLoading(true);
    try {
      await api('/admin/data/reset-all', { method: 'POST', body: { confirm: 'RESET_ALL' } });
      message.success('积分与订单业务数据已清空');
      setOpen(false);
      form.resetFields();
    } finally {
      setLoading(false);
    }
  };

  return <Card title="危险操作" className="danger-card">
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Alert
        type="warning"
        showIcon
        message="仅清空积分与订单业务数据"
        description="会删除余额流水、兑换订单、公益助力记录，并把用户余额重置为 0；不会删除用户、商品、CDK、内容、系统配置和角色权限。"
      />
      <Button danger onClick={() => setOpen(true)}>清空积分与订单业务数据</Button>
    </Space>
    <Modal
      title="确认清空积分与订单业务数据"
      open={open}
      onCancel={() => setOpen(false)}
      onOk={() => form.submit()}
      confirmLoading={loading}
      okText="确认清空"
      okButtonProps={{ danger: true }}
      cancelText="取消"
    >
      <Alert
        type="error"
        showIcon
        message="此操作不可撤销"
        description="执行后，所有用户余额流水、兑换订单、公益助力记录会被删除，所有用户余额会重置为 0。"
        style={{ marginBottom: 12 }}
      />
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item
          name="confirm"
          label="输入确认口令 RESET_ALL"
          rules={[{ required: true, message: '请输入确认口令' }]}
        >
          <Input placeholder="RESET_ALL" autoComplete="off" />
        </Form.Item>
      </Form>
    </Modal>
  </Card>;
}

export default function AuditSecurity({ me }) {
  const items = [{ key: 'logs', label: '审计日志', children: <AuditLogs /> }];
  if (me?.isSuperAdmin) items.push({ key: 'roles', label: '角色与权限', children: <RoleManagement /> }, { key: 'danger', label: '危险区', children: <DangerZone /> });
  return <Tabs items={items} />;
}
