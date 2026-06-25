import { useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Drawer, Form, Image, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag } from 'antd';
import { api } from '../api.js';
import DataToolbar from '../components/DataToolbar.jsx';
import ProductImageEditor from '../components/ProductImageEditor.jsx';
import { amountText, downloadText, formatTs } from '../utils.js';

function Products() {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState([]);
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [stockFilter, setStockFilter] = useState('all');
  const [limitFilter, setLimitFilter] = useState('all');
  const [form] = Form.useForm();
  const load = async () => {
    setLoading(true);
    try {
      const data = (await api('/admin/mall/self/products')).data || [];
      setRows(data);
      return data;
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const filteredRows = useMemo(() => {
    const q = String(keyword || '').trim().toLowerCase();
    return rows.filter((row) => {
      const text = `${row.product_id || ''} ${row.product_name || ''}`.toLowerCase();
      if (q && !text.includes(q)) return false;
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      const stock = row.stock;
      const stockNumber = Number(stock);
      if (stockFilter === 'limited' && (stock === null || stock === undefined || stock === '')) return false;
      if (stockFilter === 'empty' && !(stock !== null && stock !== undefined && stock !== '' && stockNumber <= 0)) return false;
      if (stockFilter === 'available' && !(stock === null || stock === undefined || stock === '' || stockNumber > 0)) return false;
      if (limitFilter === 'limited' && Number(row.limit_per_user || 0) <= 0) return false;
      if (limitFilter === 'unlimited' && Number(row.limit_per_user || 0) > 0) return false;
      return true;
    });
  }, [keyword, limitFilter, rows, statusFilter, stockFilter]);
  const watchedProductId = Form.useWatch('product_id', form);
  const watchedLimit = Form.useWatch('limit_per_user', form);
  const savedEditing = rows.find((row) => String(row.product_id) === String(watchedProductId || editing?.product_id || ''));
  const savedLimit = Number(savedEditing?.limit_per_user || 0);
  const currentLimit = Number(watchedLimit || 0);
  const currentRound = Math.max(1, Number(savedEditing?.limit_round || editing?.limit_round || 1));
  const canStartLimitRound = Boolean(savedEditing && savedLimit > 0);
  const limitRoundText = canStartLimitRound
    ? `当前第 ${currentRound} 轮，每人限购 ${Math.floor(savedLimit)} 件`
    : savedEditing && currentLimit > 0 ? '保存后可开启新一轮限购' : '未启用限购';
  const open = (row = {}) => {
    form.resetFields();
    setEditing(row);
    form.setFieldsValue({
      product_id: row.product_id || '',
      product_name: row.product_name || '',
      bob_amount: row.bob_amount ?? null,
      stock: row.stock ?? null,
      limit_per_user: row.limit_per_user ?? 0,
      status: row.status || 'on',
      cdk_enabled: Number(row.cdk_enabled) === 1,
      sort: row.sort ?? null,
      image_url: row.image_url || '',
      remark: row.remark || '',
    });
  };
  const save = async (values) => {
    await api('/admin/mall/self/products', { method: 'POST', body: { ...values, cdk_enabled: values.cdk_enabled ? 1 : 0 } });
    message.success('商品已保存'); setEditing(null); load();
  };
  const startLimitRound = () => {
    if (!savedEditing) {
      message.warning('请先保存商品');
      return;
    }
    if (savedLimit <= 0) {
      message.warning('该商品未启用限购');
      return;
    }
    Modal.confirm({
      title: '开启新一轮限购',
      content: `${savedEditing.product_name || savedEditing.product_id}：历史订单保留，新一轮购买从 0/${Math.floor(savedLimit)} 重新统计。`,
      okText: '确认开启',
      cancelText: '取消',
      onOk: async () => {
        const data = await api('/admin/mall/self/products/limit-round', { method: 'POST', body: { product_id: savedEditing.product_id } });
        const nextRow = data.data || savedEditing;
        setEditing(nextRow);
        form.setFieldsValue({ ...nextRow, cdk_enabled: Number(nextRow.cdk_enabled) === 1, stock: nextRow.stock ?? null });
        await load();
        message.success('已开启新一轮限购');
      },
    });
  };
  const remove = (row) => Modal.confirm({ title: '危险区：删除商品', content: `确认删除 ${row.product_name}？`, okButtonProps: { danger: true }, onOk: async () => { await api('/admin/mall/self/products/delete', { method: 'POST', body: { product_id: row.product_id } }); message.success('已删除'); load(); } });
  const selectedRows = rows.filter((row) => selected.includes(row.product_id));
  const batchSetStatus = (status) => {
    if (!selectedRows.length) return;
    Modal.confirm({
      title: status === 'on' ? '批量上架商品' : '批量下架商品',
      content: `将处理 ${selectedRows.length} 个商品。`,
      okText: '确认',
      cancelText: '取消',
      onOk: async () => {
        await Promise.all(selectedRows.map((row) => api('/admin/mall/self/products', {
          method: 'POST',
          body: { ...row, status, cdk_enabled: Number(row.cdk_enabled) === 1 ? 1 : 0 },
        })));
        message.success(status === 'on' ? '已批量上架' : '已批量下架');
        setSelected([]);
        await load();
      },
    });
  };
  const batchRemove = () => {
    if (!selectedRows.length) return;
    Modal.confirm({
      title: '危险区：批量删除商品',
      content: `确认删除 ${selectedRows.length} 个商品？此操作不可撤销。`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await Promise.all(selectedRows.map((row) => api('/admin/mall/self/products/delete', { method: 'POST', body: { product_id: row.product_id } })));
        message.success('已批量删除');
        setSelected([]);
        await load();
      },
    });
  };
  return <>
    <DataToolbar keyword={keyword} onKeyword={setKeyword} onRefresh={load} onCreate={() => open({ product_id: `P${Date.now().toString(36).toUpperCase()}`, status: 'on', cdk_enabled: false })} createText="新增商品" searchPlaceholder="搜索商品名称 / ID">
      <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 120 }} options={[{ value: 'all', label: '全部状态' }, { value: 'on', label: '上架' }, { value: 'off', label: '下架' }]} />
      <Select value={stockFilter} onChange={setStockFilter} style={{ width: 130 }} options={[{ value: 'all', label: '全部库存' }, { value: 'available', label: '可售库存' }, { value: 'empty', label: '库存为 0' }, { value: 'limited', label: '限库存' }]} />
      <Select value={limitFilter} onChange={setLimitFilter} style={{ width: 130 }} options={[{ value: 'all', label: '全部限购' }, { value: 'limited', label: '已限购' }, { value: 'unlimited', label: '不限购' }]} />
      {selected.length > 0 && <Tag color="blue">已选 {selected.length} 个</Tag>}
      <Button disabled={!selected.length} onClick={() => batchSetStatus('on')}>批量上架</Button>
      <Button disabled={!selected.length} onClick={() => batchSetStatus('off')}>批量下架</Button>
      <Button danger disabled={!selected.length} onClick={batchRemove}>批量删除</Button>
      <Button disabled={!selected.length} onClick={() => setSelected([])}>清空选择</Button>
    </DataToolbar>
    <Table
      rowKey="product_id"
      loading={loading}
      dataSource={filteredRows}
      rowSelection={{ selectedRowKeys: selected, onChange: setSelected, preserveSelectedRowKeys: true }}
      scroll={{ x: 1080 }}
      columns={[
      { title: '图片', dataIndex: 'image_url', width: 86, render: (url) => url ? <Image src={url} width={44} height={44} style={{ objectFit: 'cover', borderRadius: 8 }} /> : '-' },
      { title: '商品ID', dataIndex: 'product_id', ellipsis: true },
      { title: '名称', dataIndex: 'product_name' },
      { title: '金额', dataIndex: 'bob_amount', render: amountText },
      { title: '库存', render: (_, r) => r.stock ?? '不限' },
      { title: '限购', render: (_, r) => Number(r.limit_per_user) > 0 ? `每人 ${Number(r.limit_per_user)} · 第 ${Math.max(1, Number(r.limit_round || 1))} 轮` : '不限' },
      { title: '状态', dataIndex: 'status', render: (v) => <Tag color={v === 'on' ? 'success' : 'default'}>{v === 'on' ? '上架' : '下架'}</Tag> },
      { title: '操作', fixed: 'right', render: (_, r) => <Space><Button onClick={() => open(r)}>编辑</Button><Button danger onClick={() => remove(r)}>删除</Button></Space> },
    ]}
    />
    <Drawer title={savedEditing ? "商品编辑" : "新增商品"} open={Boolean(editing)} onClose={() => { setEditing(null); form.resetFields(); }} width={620} extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item label="商品图片" name="image_url"><ProductImageEditor /></Form.Item>
        <Form.Item label="商品ID" name="product_id" rules={[{ required: true }]}><Input readOnly className="readonly-input" /></Form.Item>
        <Form.Item label="名称" name="product_name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item label="金额" name="bob_amount" rules={[{ required: true }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="库存" name="stock"><InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="留空为不限" /></Form.Item>
        <Form.Item label="每人限购" name="limit_per_user"><InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="0 表示不限购" /></Form.Item>
        <div className="product-limit-round-panel">
          <div>
            <div className="product-limit-round-title">限购轮次</div>
            <div className="product-limit-round-text">{limitRoundText}</div>
          </div>
          <Button disabled={!canStartLimitRound} onClick={startLimitRound}>开启新一轮限购</Button>
        </div>
        <Form.Item label="状态" name="status"><Select options={[{ value: 'on', label: '上架' }, { value: 'off', label: '下架' }]} /></Form.Item>
        <Form.Item label="启用 CDK" name="cdk_enabled" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item label="排序" name="sort"><InputNumber precision={0} style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="备注" name="remark"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Drawer>
  </>;
}

function Cdks() {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generated, setGenerated] = useState(null);
  const [generatedOpen, setGeneratedOpen] = useState(false);
  const [form] = Form.useForm();
  const load = async () => {
    setLoading(true);
    try {
      const [cdks, productOptions] = await Promise.all([
        api('/admin/cdks?limit=200'),
        api('/admin/cdks/products'),
      ]);
      setRows(cdks.data || []);
      setProducts(productOptions.data || []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const generate = async (values) => {
    const data = await api('/admin/cdks/generate', { method: 'POST', body: values });
    const codes = Array.isArray(data.codes) ? data.codes : [];
    const batchId = data.batch_id || Date.now();
    setGenerated({ batchId, codes, createdAt: Date.now() });
    setGeneratedOpen(true);
    message.success(`已生成 ${codes.length} 个 CDK`);
    if (codes.length) downloadText(`cdk-${batchId}.txt`, codes.join('\n'));
    load();
  };
  const copyGenerated = async () => {
    if (!generated?.codes?.length) return;
    try {
      await navigator.clipboard.writeText(generated.codes.join('\n'));
      message.success('CDK 已复制');
    } catch {
      message.warning('复制失败，请手动选中文本复制');
    }
  };
  const downloadGenerated = () => {
    if (!generated?.codes?.length) return;
    downloadText(`cdk-${generated.batchId}.txt`, generated.codes.join('\n'));
  };
  const remove = (id) => Modal.confirm({ title: '危险区：删除 CDK', content: '仅未兑换 CDK 可删除。', okButtonProps: { danger: true }, onOk: async () => { await api('/admin/cdks/delete', { method: 'POST', body: { ids: [id] } }); message.success('已删除'); load(); } });
  return <Space direction="vertical" style={{ width: '100%' }}>
    <Card size="small" title="生成 CDK"><Form form={form} layout="inline" onFinish={generate}><Form.Item name="product_id" rules={[{ required: true, message: '请选择商品' }]}><Select placeholder="选择商品" style={{ width: 260 }} options={products.map((p) => ({ value: p.product_id, label: `${p.product_name} (${amountText(p.bob_amount)})` }))} /></Form.Item><Form.Item name="quantity" rules={[{ required: true, message: '请输入生成数量' }]}><InputNumber min={1} max={500} precision={0} placeholder="数量" /></Form.Item><Button type="primary" htmlType="submit">生成并导出</Button><Button onClick={load}>刷新</Button></Form></Card>
    <Modal
      title={`本次生成：${generated?.codes?.length || 0} 个 CDK`}
      open={generatedOpen}
      onCancel={() => setGeneratedOpen(false)}
      footer={<Space><Button onClick={copyGenerated}>复制全部</Button><Button onClick={downloadGenerated}>下载</Button><Button type="primary" onClick={() => setGeneratedOpen(false)}>完成</Button></Space>}
      width={680}
    >
      <Input.TextArea value={(generated?.codes || []).join('\n')} rows={Math.min(10, Math.max(4, generated?.codes?.length || 0))} readOnly />
    </Modal>
    <Table rowKey="id" loading={loading} dataSource={rows} scroll={{ x: 1120 }} columns={[
      { title: '商品', dataIndex: 'product_name' }, { title: 'CDK', dataIndex: 'cdk_code', ellipsis: true },
      { title: '状态', dataIndex: 'status', render: (v) => <Tag color={v === 'unused' ? 'success' : v === 'redeemed' ? 'red' : 'default'}>{v === 'unused' ? '未兑换' : v === 'redeemed' ? '已兑换' : v}</Tag> },
      { title: '创建人', dataIndex: 'created_name' }, { title: '创建时间', dataIndex: 'created_at', render: formatTs },
      { title: '兑换人', dataIndex: 'redeemed_name' }, { title: '兑换订单', dataIndex: 'redeem_exchange_id', ellipsis: true },
      { title: '操作', render: (_, r) => <Button danger disabled={r.status !== 'unused'} onClick={() => remove(r.id)}>删除</Button> },
    ]} />
  </Space>;
}

export default function Commerce() {
  return <Card><Tabs items={[{ key: 'products', label: '商品管理', children: <Products /> }, { key: 'cdk', label: 'CDK 管理', children: <Cdks /> }]} /></Card>;
}
