import { useEffect, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Form, Input, InputNumber, Modal, Space, Switch, Table, Tabs, Tag } from 'antd';
import { api, qs } from '../api.js';
import DataToolbar from '../components/DataToolbar.jsx';
import { amountText, formatTs } from '../utils.js';

export default function Users() {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [op, setOp] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState([]);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [form] = Form.useForm();

  const normalizeKeyword = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  const load = async (nextPage = page, nextKeyword = keyword) => {
    setLoading(true);
    try {
      const data = await api(`/admin/users?${qs({ page: nextPage, pageSize: 30, keyword: normalizeKeyword(nextKeyword) })}`);
      setRows(data.data || []);
      setTotal(data.total || 0);
      setPage(data.page || nextPage);
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

  const openDetail = async (userid) => {
    const data = await api(`/admin/users/${encodeURIComponent(userid)}`);
    setDetail(data.data);
  };

  const submitOp = async (values) => {
    const userids = op.userid ? [op.userid] : selected;
    const path = op.type === 'grant' ? '/admin/ledger/grant-batch' : '/admin/redeem/deduct-batch';
    const body = op.type === 'grant'
      ? { userids, amount: values.amount, reason: values.reason || '后台发币' }
      : { userids, amount: values.amount, product_name: values.reason || '后台减币' };
    await api(path, { method: 'POST', body });
    message.success(op.type === 'grant' ? '发币完成' : '减币完成');
    setOp(null);
    await load();
    if (detail?.user?.userid) await openDetail(detail.user.userid);
  };

  const setAdmin = async (record, checked) => {
    await api('/admin/users/set-admin', { method: 'POST', body: { userid: record.userid, isAdmin: checked } });
    message.success('管理员权限已更新');
    load();
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
      setSelected([]);
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
    { title: '管理员', render: (_, r) => <Switch size="small" checked={Number(r.is_admin) === 1} disabled={Number(r.is_fixed_admin) === 1} onChange={(v) => setAdmin(r, v)} /> },
    { title: '更新时间', dataIndex: 'updated_at', render: formatTs },
    { title: '操作', fixed: 'right', render: (_, r) => <Space><Button onClick={() => { setOp({ type: 'grant', userid: r.userid }); form.resetFields(); }}>发币</Button><Button onClick={() => { setOp({ type: 'deduct', userid: r.userid }); form.resetFields(); }}>减币</Button></Space> },
  ];

  return (
    <Card>
      <DataToolbar keyword={keyword} onKeyword={setKeyword} onRefresh={() => load(1, keyword)} searchPlaceholder="搜索姓名 / Userid">
        <Button onClick={() => api('/admin/users/sync', { method: 'POST', body: {} }).then(() => { message.success('通讯录同步完成'); load(1, keyword); })}>同步通讯录</Button>
        <Button disabled={!selected.length} onClick={() => { setOp({ type: 'grant' }); form.resetFields(); }}>批量发币</Button>
        <Button disabled={!selected.length} onClick={() => { setOp({ type: 'deduct' }); form.resetFields(); }}>批量减币</Button>
        <Button danger disabled={!selected.length} onClick={() => deleteUsers(selected)}>危险区：删除</Button>
      </DataToolbar>
      <Table
        rowKey="userid"
        loading={loading}
        columns={columns}
        dataSource={rows}
        rowSelection={{ selectedRowKeys: selected, onChange: setSelected }}
        pagination={{ current: page, pageSize: 30, total, onChange: load, showTotal: (n) => `共 ${n} 人` }}
        scroll={{ x: 980 }}
      />
      <Drawer title="用户账户详情" open={Boolean(detail)} onClose={() => setDetail(null)} width={860}>
        {detail && <Tabs items={[
          { key: 'info', label: '账户信息', children: <Descriptions bordered column={2} items={[
            { key: 'name', label: '姓名', children: detail.user?.name || '-' },
            { key: 'userid', label: 'Userid', children: detail.user?.userid || '-' },
            { key: 'balance', label: '余额', children: amountText(detail.account?.balance) },
            { key: 'admin', label: '管理员', children: Number(detail.user?.is_admin) === 1 ? <Tag color="blue">是</Tag> : '否' },
          ]} /> },
          { key: 'ledger', label: '余额流水', children: <Table rowKey="id" size="small" dataSource={detail.ledger || []} pagination={false} columns={[{ title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '金额', dataIndex: 'delta', render: amountText }, { title: '原因', dataIndex: 'reason' }, { title: '单号', dataIndex: 'ref_id' }]} /> },
          { key: 'orders', label: '订单记录', children: <Table rowKey="exchange_id" size="small" dataSource={detail.redeems || []} pagination={false} columns={[{ title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '商品', dataIndex: 'product_name' }, { title: '金额', dataIndex: 'bob_amount', render: amountText }, { title: '状态', render: (_, r) => r.fulfilled_at ? '已核销' : '未核销' }]} /> },
        ]} />}
      </Drawer>
      <Modal title={op?.type === 'grant' ? '发币' : '减币'} open={Boolean(op)} onCancel={() => setOp(null)} onOk={() => form.submit()} okText="确认" cancelText="取消">
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
      </Modal>
    </Card>
  );
}
