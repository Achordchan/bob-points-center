import { useEffect, useState } from 'react';
import { App, Button, Card, Drawer, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag } from 'antd';
import { api } from '../api.js';
import DataToolbar from '../components/DataToolbar.jsx';
import { amountText, downloadText, formatTs } from '../utils.js';

function Products() {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  const load = async () => setRows((await api('/admin/mall/self/products')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const open = (row = {}) => { setEditing(row); form.setFieldsValue({ ...row, cdk_enabled: Number(row.cdk_enabled) === 1, stock: row.stock ?? null }); };
  const save = async (values) => {
    await api('/admin/mall/self/products', { method: 'POST', body: { ...values, cdk_enabled: values.cdk_enabled ? 1 : 0 } });
    message.success('商品已保存'); setEditing(null); load();
  };
  const remove = (row) => Modal.confirm({ title: '危险区：删除商品', content: `确认删除 ${row.product_name}？`, okButtonProps: { danger: true }, onOk: async () => { await api('/admin/mall/self/products/delete', { method: 'POST', body: { product_id: row.product_id } }); message.success('已删除'); load(); } });
  return <>
    <DataToolbar onRefresh={load} onCreate={() => open({ product_id: `P${Date.now().toString(36).toUpperCase()}`, status: 'on', cdk_enabled: false })} createText="新增商品" />
    <Table rowKey="product_id" dataSource={rows} scroll={{ x: 1120 }} columns={[
      { title: '商品ID', dataIndex: 'product_id', ellipsis: true },
      { title: '名称', dataIndex: 'product_name' },
      { title: '金额', dataIndex: 'bob_amount', render: amountText },
      { title: '库存', render: (_, r) => r.stock ?? '不限' },
      { title: '限购', dataIndex: 'limit_per_user' },
      { title: 'CDK', dataIndex: 'cdk_enabled', render: (v) => Number(v) === 1 ? <Tag color="purple">启用</Tag> : '关闭' },
      { title: '状态', dataIndex: 'status', render: (v) => <Tag color={v === 'on' ? 'success' : 'default'}>{v === 'on' ? '上架' : '下架'}</Tag> },
      { title: '操作', fixed: 'right', render: (_, r) => <Space><Button onClick={() => open(r)}>编辑</Button><Button danger onClick={() => remove(r)}>删除</Button></Space> },
    ]} />
    <Drawer title="商品编辑" open={Boolean(editing)} onClose={() => setEditing(null)} width={620} extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item label="商品ID" name="product_id" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item label="名称" name="product_name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item label="金额" name="bob_amount" rules={[{ required: true }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="库存" name="stock"><InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="留空为不限" /></Form.Item>
        <Form.Item label="每人限购" name="limit_per_user"><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="状态" name="status"><Select options={[{ value: 'on', label: '上架' }, { value: 'off', label: '下架' }]} /></Form.Item>
        <Form.Item label="启用 CDK" name="cdk_enabled" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item label="排序" name="sort"><InputNumber precision={0} style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="图片 URL" name="image_url"><Input /></Form.Item>
        <Form.Item label="备注" name="remark"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Drawer>
  </>;
}

function Cdks() {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [products, setProducts] = useState([]);
  const [form] = Form.useForm();
  const load = async () => { setRows((await api('/admin/cdks?limit=200')).data || []); setProducts((await api('/admin/cdks/products')).data || []); };
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const generate = async (values) => {
    const data = await api('/admin/cdks/generate', { method: 'POST', body: values });
    message.success('CDK 已生成');
    if (data.codes?.length) downloadText(`cdk-${data.batch_id || Date.now()}.txt`, data.codes.join('\n'));
    load();
  };
  const remove = (id) => Modal.confirm({ title: '危险区：删除 CDK', content: '仅未兑换 CDK 可删除。', okButtonProps: { danger: true }, onOk: async () => { await api('/admin/cdks/delete', { method: 'POST', body: { ids: [id] } }); message.success('已删除'); load(); } });
  return <Space direction="vertical" style={{ width: '100%' }}>
    <Card size="small" title="生成 CDK"><Form form={form} layout="inline" onFinish={generate}><Form.Item name="product_id" rules={[{ required: true }]}><Select placeholder="选择商品" style={{ width: 260 }} options={products.map((p) => ({ value: p.product_id, label: `${p.product_name} (${amountText(p.bob_amount)})` }))} /></Form.Item><Form.Item name="quantity" rules={[{ required: true }]}><InputNumber min={1} max={500} precision={0} placeholder="数量" /></Form.Item><Button type="primary" htmlType="submit">生成并导出</Button><Button onClick={load}>刷新</Button></Form></Card>
    <Table rowKey="id" dataSource={rows} scroll={{ x: 1120 }} columns={[
      { title: '商品', dataIndex: 'product_name' }, { title: 'CDK', dataIndex: 'cdk_code', ellipsis: true },
      { title: '状态', dataIndex: 'status', render: (v) => <Tag color={v === 'unused' ? 'success' : v === 'redeemed' ? 'red' : 'default'}>{v === 'unused' ? '未兑换' : v === 'redeemed' ? '已兑换' : v}</Tag> },
      { title: '创建人', dataIndex: 'created_name' }, { title: '创建时间', dataIndex: 'created_at', render: formatTs },
      { title: '兑换人', dataIndex: 'redeemed_name' }, { title: '兑换订单', dataIndex: 'redeem_exchange_id', ellipsis: true },
      { title: '操作', render: (_, r) => <Button danger disabled={r.status !== 'unused'} onClick={() => remove(r.id)}>删除</Button> },
    ]} />
  </Space>;
}

export default function Commerce() {
  return <Card title="商城与 CDK"><Tabs items={[{ key: 'products', label: '商品管理', children: <Products /> }, { key: 'cdk', label: 'CDK 管理', children: <Cdks /> }]} /></Card>;
}
