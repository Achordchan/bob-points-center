import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Drawer, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag } from 'antd';
import { api, qs } from '../api.js';
import DataToolbar from '../components/DataToolbar.jsx';
import { amountText, formatTs } from '../utils.js';
import { hasPermission } from '../permissions.js';

export default function Users({ me }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState([]);
  const [selectedUsers, setSelectedUsers] = useState({});
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [op, setOp] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState([]);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [roles, setRoles] = useState([]);
  const [form] = Form.useForm();

  const normalizeKeyword = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const canGrant = hasPermission(me, 'users:grant');
  const canDeduct = hasPermission(me, 'users:deduct');
  const canDelete = me?.isSuperAdmin === true;
  const canEdit = hasPermission(me, 'users:edit');
  const canAssignRole = me?.isSuperAdmin === true;

  const load = async (nextPage = page, nextKeyword = keyword, nextPageSize = pageSize) => {
    setLoading(true);
    try {
      const data = await api(`/admin/users?${qs({ page: nextPage, pageSize: nextPageSize, keyword: normalizeKeyword(nextKeyword) })}`);
      const nextRows = data.data || [];
      setRows(nextRows);
      setSelectedUsers((prev) => {
        const next = { ...prev };
        nextRows.forEach((row) => {
          if (selected.includes(row.userid)) next[row.userid] = row;
        });
        return next;
      });
      setTotal(data.total || 0);
      setPage(data.page || nextPage);
      setPageSize(data.pageSize || nextPageSize);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load(1, keyword).catch((e) => message.error(e.message));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    if (!canAssignRole) return;
    api('/admin/roles').then((data) => setRoles((data.data || []).filter((role) => Number(role.is_enabled) === 1))).catch(() => null);
  }, [canAssignRole]);

  const openDetail = async (userid) => {
    const data = await api(`/admin/users/${encodeURIComponent(userid)}`);
    setDetail(data.data);
  };

  const rememberSelectedRows = (keys, selectedRows = []) => {
    const nextKeys = keys.map(String);
    setSelected(nextKeys);
    setSelectedUsers((prev) => {
      const next = {};
      nextKeys.forEach((userid) => {
        const known = selectedRows.find((row) => String(row.userid) === userid) || rows.find((row) => String(row.userid) === userid) || prev[userid];
        next[userid] = known || { userid };
      });
      return next;
    });
  };

  const clearSelected = () => {
    setSelected([]);
    setSelectedUsers({});
  };

  const recipientRows = op?.userid
    ? [rows.find((row) => row.userid === op.userid) || selectedUsers[op.userid] || { userid: op.userid }]
    : selected.map((userid) => selectedUsers[userid] || rows.find((row) => row.userid === userid) || { userid });

  const submitOp = async (values) => {
    const userids = op.userid ? [op.userid] : selected;
    const path = op.type === 'grant' ? '/admin/ledger/grant-batch' : '/admin/redeem/deduct-batch';
    const body = op.type === 'grant'
      ? { userids, amount: values.amount, reason: values.reason || '后台发币' }
      : { userids, amount: values.amount, product_name: values.reason || '后台减币' };
    await api(path, { method: 'POST', body });
    message.success(op.type === 'grant' ? '发币完成' : '减币完成');
    if (!op.userid) clearSelected();
    setOp(null);
    await load();
    if (detail?.user?.userid) await openDetail(detail.user.userid);
  };

  const assignRole = async (record, roleId) => {
    const role = roles.find((item) => String(item.id) === String(roleId));
    const roleName = role?.name || '无后台角色';
    Modal.confirm({
      title: '确认修改后台角色？',
      content: `将把 ${record.name || record.userid} 的后台角色改为「${roleName}」，权限会立即生效。`,
      okText: '确认修改',
      cancelText: '取消',
      onOk: async () => {
        await api('/admin/users/assign-role', { method: 'POST', body: { userid: record.userid, roleId: roleId || null } });
        message.success('后台角色已更新');
        await load();
        if (detail?.user?.userid === record.userid) await openDetail(record.userid);
      },
    });
  };

  const deleteUsers = (userids) => {
    if (!userids.length) return;
    setDeleteTarget(userids);
  };

  const confirmDeleteUsers = async () => {
    setDeleteLoading(true);
    try {
      const data = await api('/admin/users/delete', { method: 'POST', body: { userids: deleteTarget } });
      message.success(`已删除 ${data.deleted || deleteTarget.length} 个用户`);
      clearSelected();
      setDeleteTarget([]);
      await load(1, keyword);
    } catch (err) {
      message.error(err.message || '删除失败');
    } finally {
      setDeleteLoading(false);
    }
  };

  const columns = [
    { title: '姓名', dataIndex: 'name', render: (v, r) => <Button type="link" onClick={() => openDetail(r.userid)}>{v || '-'}</Button> },
    { title: 'Userid', dataIndex: 'userid', ellipsis: true },
    { title: '余额', dataIndex: 'balance', render: amountText, sorter: (a, b) => Number(a.balance) - Number(b.balance) },
    { title: '后台角色', render: (_, r) => r.is_fixed_admin ? <Tag color="gold">超级管理员</Tag> : (canAssignRole ? <Select size="small" value={r.role?.id || null} placeholder="无后台角色" style={{ width: 150 }} options={[{ value: null, label: '无后台角色' }, ...roles.map((role) => ({ value: role.id, label: role.name }))]} onChange={(v) => assignRole(r, v)} /> : (r.role?.name ? <Tag color="blue">{r.role.name}</Tag> : '-')) },
    { title: '更新时间', dataIndex: 'updated_at', render: formatTs },
    { title: '操作', fixed: 'right', render: (_, r) => <Space>{canGrant && <Button onClick={() => { setOp({ type: 'grant', userid: r.userid }); form.resetFields(); }}>发币</Button>}{canDeduct && <Button onClick={() => { setOp({ type: 'deduct', userid: r.userid }); form.resetFields(); }}>减币</Button>}</Space> },
  ];

  return (
    <Card>
      <DataToolbar keyword={keyword} onKeyword={setKeyword} onRefresh={() => load(1, keyword)} searchPlaceholder="搜索姓名 / Userid">
        {canEdit && <Button onClick={() => api('/admin/users/sync', { method: 'POST', body: {} }).then(() => { message.success('通讯录同步完成'); load(1, keyword); })}>同步通讯录</Button>}
        {selected.length > 0 && <Tag color="blue">已选 {selected.length} 人</Tag>}
        {canGrant && <Button disabled={!selected.length} onClick={() => { setOp({ type: 'grant' }); form.resetFields(); }}>批量发币</Button>}
        {canDeduct && <Button disabled={!selected.length} onClick={() => { setOp({ type: 'deduct' }); form.resetFields(); }}>批量减币</Button>}
        {canDelete && <Button danger disabled={!selected.length} onClick={() => deleteUsers(selected)}>危险区：删除</Button>}
        <Button disabled={!selected.length} onClick={clearSelected}>清空选择</Button>
      </DataToolbar>
      <Table
        rowKey="userid"
        loading={loading}
        columns={columns}
        dataSource={rows}
        rowSelection={{ selectedRowKeys: selected, preserveSelectedRowKeys: true, onChange: rememberSelectedRows }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 30, 50, 100],
          onChange: (nextPage, nextPageSize) => {
            const sizeChanged = nextPageSize !== pageSize;
            load(sizeChanged ? 1 : nextPage, keyword, nextPageSize);
          },
          showTotal: (n) => `共 ${n} 人`,
        }}
        scroll={{ x: 980 }}
      />
      <Drawer title="用户账户详情" open={Boolean(detail)} onClose={() => setDetail(null)} width={860}>
        {detail && <Tabs items={[
          { key: 'info', label: '账户信息', children: <Descriptions bordered column={2} items={[
            { key: 'name', label: '姓名', children: detail.user?.name || '-' },
            { key: 'userid', label: 'Userid', children: detail.user?.userid || '-' },
            { key: 'balance', label: '余额', children: amountText(detail.account?.balance) },
            { key: 'admin', label: '后台角色', children: detail.user?.is_fixed_admin ? <Tag color="gold">超级管理员</Tag> : (detail.user?.role?.name ? <Tag color="blue">{detail.user.role.name}</Tag> : '无后台角色') },
          ]} /> },
          { key: 'ledger', label: '余额流水', children: <Table rowKey="id" size="small" dataSource={detail.ledger || []} pagination={false} columns={[{ title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '金额', dataIndex: 'delta', render: amountText }, { title: '原因', dataIndex: 'reason' }, { title: '单号', dataIndex: 'ref_id' }]} /> },
          { key: 'orders', label: '订单记录', children: <Table rowKey="exchange_id" size="small" dataSource={detail.redeems || []} pagination={false} columns={[{ title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '商品', dataIndex: 'product_name' }, { title: '金额', dataIndex: 'bob_amount', render: amountText }, { title: '状态', render: (_, r) => r.fulfilled_at ? '已核销' : '未核销' }]} /> },
          { key: 'ops', label: '最近操作', children: <Table rowKey="id" size="small" dataSource={detail.operations || []} pagination={false} columns={[{ title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '操作', dataIndex: 'event_label' }, { title: '状态', dataIndex: 'status_code' }, { title: '说明', dataIndex: 'message', ellipsis: true }]} /> },
        ]} />}
      </Drawer>
      <Modal title={op?.type === 'grant' ? '发币' : '减币'} open={Boolean(op)} onCancel={() => setOp(null)} onOk={() => form.submit()} okText="确认" cancelText="取消">
        {op && <Alert type={op.type === 'deduct' ? 'warning' : 'info'} showIcon message={`本次将${op.type === 'grant' ? '发币给' : '减币'} ${recipientRows.length} 人`} description={<div className="batch-recipient-list">{recipientRows.map((user) => <Tag key={user.userid}>{user.name ? `${user.name}（${user.userid}）` : user.userid}</Tag>)}</div>} style={{ marginBottom: 12 }} />}
        <Form form={form} layout="vertical" onFinish={submitOp}>
          <Form.Item label="金额" name="amount" rules={[{ required: true, message: '请输入金额' }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item label="原因" name="reason"><Input placeholder={op?.type === 'grant' ? '后台发币' : '后台减币'} /></Form.Item>
        </Form>
      </Modal>
      <Modal
        title="确认删除用户？"
        open={deleteTarget.length > 0}
        onCancel={() => setDeleteTarget([])}
        onOk={confirmDeleteUsers}
        confirmLoading={deleteLoading}
        okText="确认删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        将删除 {deleteTarget.length} 个用户及关联账户、余额流水、核销记录，此操作不可撤销。
        <div className="batch-recipient-list">{deleteTarget.map((userid) => { const user = selectedUsers[userid] || rows.find((row) => row.userid === userid) || { userid }; return <Tag key={userid}>{user.name ? `${user.name}（${userid}）` : userid}</Tag>; })}</div>
      </Modal>
    </Card>
  );
}
