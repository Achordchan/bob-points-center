import { useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Form, Image, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag } from 'antd';
import { api } from '../api.js';
import DataToolbar from '../components/DataToolbar.jsx';
import ProductImageEditor from '../components/ProductImageEditor.jsx';
import { amountText, downloadText, formatTs } from '../utils.js';
import { hasPermission } from '../permissions.js';


function toDateTimeLocal(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDateTimeLocal(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const ms = new Date(text).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function mallOpeningErrorText(error) {
  const text = String(error || '操作失败');
  const map = {
    'missing next_open_at': '请填写下一次开启时间',
    'interval_minutes must be >= 1': '开启频率必须大于等于 1 分钟',
    'open_duration_minutes must be >= 1': '开启持续时间必须大于等于 1 分钟',
    'remind_before_seconds must be >= 0': '开启前提醒秒数不能小于 0',
    'close_remind_seconds must be >= 0': '关闭前提醒秒数不能小于 0',
    'close_remind_seconds requires open_duration_minutes': '设置关闭前提醒需要填写开启持续时间',
    'missing open_duration_minutes': '启用自动开启需要填写开启持续时间',
  };
  return map[text] || text;
}


function personText(name, userid) {
  const n = String(name || '').trim();
  const u = String(userid || '').trim();
  if (n && u) return `${n}（${u}）`;
  return n || u || '-';
}

function nextCloseText(row) {
  const duration = Number(row?.open_duration_minutes || 0);
  const openAt = Number(row?.open_notify_for_open_at || row?.next_open_at || 0);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(openAt) || openAt <= 0) return '-';
  return formatTs(openAt + duration * 60);
}

function MallOpeningControl({ canEdit }) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  const [row, setRow] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const isOpen = Number(row?.is_open || 0) === 1;

  const load = async () => {
    setLoading(true);
    try {
      const data = await api('/admin/mall/opening');
      const next = data.data || {};
      setRow(next);
      form.setFieldsValue({
        auto_enabled: Number(next.auto_enabled) === 1,
        next_open_at: toDateTimeLocal(next.next_open_at),
        interval_minutes: next.interval_minutes ?? null,
        open_duration_minutes: next.open_duration_minutes ?? null,
        remind_before_seconds: next.remind_before_seconds ?? null,
        close_remind_seconds: next.close_remind_seconds ?? null,
      });
    } catch (err) {
      message.error(mallOpeningErrorText(err.message));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleNow = () => {
    if (!canEdit) return;
    modal.confirm({
      title: isOpen ? '确认立即关闭商城？' : '确认立即开启商城？',
      content: isOpen ? '关闭后，用户将不能继续下单。' : '开启后，用户可以立即下单。',
      okText: isOpen ? '确认关闭' : '确认开启',
      cancelText: '取消',
      okButtonProps: { danger: isOpen },
      onOk: async () => {
        setSaving(true);
        try {
          const data = await api(isOpen ? '/admin/mall/opening/close-now' : '/admin/mall/opening/open-now', { method: 'POST' });
          const next = data.data || {};
          setRow(next);
          await load();
          message.success(isOpen ? '商城已关闭' : '商城已开启');
        } catch (err) {
          message.error(mallOpeningErrorText(err.message));
        } finally {
          setSaving(false);
        }
      },
    });
  };

  const saveSchedule = async (values) => {
    const autoEnabled = values.auto_enabled === true;
    const nextOpenAt = parseDateTimeLocal(values.next_open_at);
    if (autoEnabled && !nextOpenAt) return message.warning('请填写下一次开启时间');
    if (autoEnabled && !Number(values.open_duration_minutes || 0)) return message.warning('启用自动开启需要填写开启持续时间');
    setSaving(true);
    try {
      const data = await api('/admin/mall/opening', {
        method: 'POST',
        body: {
          auto_enabled: autoEnabled ? 1 : 0,
          next_open_at: nextOpenAt,
          interval_minutes: values.interval_minutes ?? null,
          open_duration_minutes: values.open_duration_minutes ?? null,
          remind_before_seconds: values.remind_before_seconds ?? null,
          close_remind_seconds: values.close_remind_seconds ?? null,
        },
      });
      setRow(data.data || {});
      await load();
      message.success('商城开启计划已保存');
    } catch (err) {
      message.error(mallOpeningErrorText(err.message));
    } finally {
      setSaving(false);
    }
  };

  return <Card size="small" title="商城开启 / 关闭控制" className="mall-opening-control-card" loading={loading} extra={<Space>
    <Switch
      checked={isOpen}
      loading={saving}
      disabled={!canEdit}
      checkedChildren="已开启"
      unCheckedChildren="已关闭"
      onChange={toggleNow}
    />
    <Button onClick={() => setAdvanced((v) => !v)}>{advanced ? '收起设置' : '更多设置'}</Button>
    {canEdit && <Button danger={isOpen} type={isOpen ? 'default' : 'primary'} loading={saving} onClick={toggleNow}>{isOpen ? '立即关闭' : '立即开启'}</Button>}
  </Space>}>
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Descriptions bordered size="small" column={{ xs: 1, md: 3 }} items={[
        { key: 'status', label: '当前状态', children: <Tag color={isOpen ? 'green' : 'red'}>{isOpen ? '已开启' : '已关闭'}</Tag> },
        { key: 'nextOpen', label: '下一次开启', children: formatTs(row?.next_open_at) || '-' },
        { key: 'nextClose', label: '下一次关闭', children: nextCloseText(row) },
        { key: 'source', label: '商城数据源', children: '自建商城' },
      ]} />
      {advanced && <Form form={form} layout="vertical" onFinish={saveSchedule} className="mall-opening-settings-form">
        <div className="mall-opening-settings-grid">
          <Form.Item name="auto_enabled" label="自动开启计划" valuePropName="checked"><Switch disabled={!canEdit} /></Form.Item>
          <Form.Item name="next_open_at" label="下一次开启时间"><Input type="datetime-local" disabled={!canEdit} /></Form.Item>
          <Form.Item name="interval_minutes" label="开启频率（分钟）"><InputNumber min={1} precision={0} disabled={!canEdit} style={{ width: '100%' }} placeholder="留空表示不循环" /></Form.Item>
          <Form.Item name="open_duration_minutes" label="开启持续（分钟）"><InputNumber min={1} precision={0} disabled={!canEdit} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="remind_before_seconds" label="开启前提醒（秒）"><InputNumber min={0} precision={0} disabled={!canEdit} style={{ width: '100%' }} placeholder="留空为不提醒" /></Form.Item>
          <Form.Item name="close_remind_seconds" label="关闭前提醒（秒）"><InputNumber min={0} precision={0} disabled={!canEdit} style={{ width: '100%' }} placeholder="留空为不提醒" /></Form.Item>
        </div>
        <div className="mall-opening-settings-actions">
          <Button onClick={load} loading={loading}>刷新设置</Button>
          {canEdit && <Button type="primary" loading={saving} onClick={() => form.submit()}>保存开启计划</Button>}
        </div>
      </Form>}
    </Space>
  </Card>;
}

function SiteVisibilityControl({ canEdit }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [row, setRow] = useState({ enabled: true, message: '' });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const enabled = row?.enabled !== false;

  const load = async () => {
    setLoading(true);
    try {
      const data = await api('/admin/site-visibility');
      const next = data.data || { enabled: true, message: '' };
      setRow(next);
      form.setFieldsValue({
        enabled: next.enabled !== false,
        message: next.message || '',
      });
    } catch (err) {
      message.error(err.message || '前台访问设置加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (values) => {
    setSaving(true);
    try {
      const data = await api('/admin/site-visibility', {
        method: 'POST',
        body: {
          enabled: values.enabled !== false,
          message: values.message || '',
        },
      });
      setRow(data.data || {});
      form.setFieldsValue({
        enabled: data.data?.enabled !== false,
        message: data.data?.message || '',
      });
      message.success('前台访问设置已保存');
    } catch (err) {
      message.error(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return <Card size="small" title="前台网站访问控制" loading={loading} extra={<Tag color={enabled ? 'green' : 'red'}>{enabled ? '已开启' : '已关闭'}</Tag>}>
    <Form form={form} layout="vertical" onFinish={save} initialValues={{ enabled: true, message: '' }}>
      <Form.Item name="enabled" label="前台网站是否开启" valuePropName="checked">
        <Switch disabled={!canEdit} checkedChildren="开启" unCheckedChildren="关闭" />
      </Form.Item>
      <Form.Item
        name="message"
        label="关闭时展示给访客的信息"
        extra="关闭后，访客打开前台页面会先看到这段文字，不需要钉钉登录。"
      >
        <Input.TextArea
          disabled={!canEdit}
          rows={3}
          maxLength={500}
          showCount
          placeholder="例如：系统维护中，请稍后再试。"
        />
      </Form.Item>
      <Space>
        <Button onClick={load} loading={loading}>刷新</Button>
        {canEdit && <Button type="primary" htmlType="submit" loading={saving}>保存设置</Button>}
      </Space>
    </Form>
  </Card>;
}

function Products({ me }) {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState([]);
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [stockFilter, setStockFilter] = useState('all');
  const [limitFilter, setLimitFilter] = useState('all');
  const [form] = Form.useForm();
  const canEdit = hasPermission(me, 'commerce:edit');
  const canDelete = me?.isSuperAdmin === true;
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
      publish_to_group: false,
      sort: row.sort ?? null,
      image_url: row.image_url || '',
      remark: row.remark || '',
    });
  };
  const save = async (values) => {
    await api('/admin/mall/self/products', { method: 'POST', body: { ...values, cdk_enabled: values.cdk_enabled ? 1 : 0, publish_to_group: values.publish_to_group ? 1 : 0 } });
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
    modal.confirm({
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
  const remove = (row) => modal.confirm({ title: '危险区：删除商品', content: `确认删除 ${row.product_name}？`, okButtonProps: { danger: true }, onOk: async () => { await api('/admin/mall/self/products/delete', { method: 'POST', body: { product_id: row.product_id } }); message.success('已删除'); load(); } });
  const selectedRows = rows.filter((row) => selected.includes(row.product_id));
  const batchSetStatus = (status) => {
    if (!selectedRows.length) return;
    modal.confirm({
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
    modal.confirm({
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
  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <DataToolbar keyword={keyword} onKeyword={setKeyword} onRefresh={load} onCreate={canEdit ? () => open({ product_id: `P${Date.now().toString(36).toUpperCase()}`, status: 'on', cdk_enabled: false }) : null} createText="新增商品" searchPlaceholder="搜索商品名称 / ID">
      <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 120 }} options={[{ value: 'all', label: '全部状态' }, { value: 'on', label: '上架' }, { value: 'off', label: '下架' }]} />
      <Select value={stockFilter} onChange={setStockFilter} style={{ width: 130 }} options={[{ value: 'all', label: '全部库存' }, { value: 'available', label: '可售库存' }, { value: 'empty', label: '库存为 0' }, { value: 'limited', label: '限库存' }]} />
      <Select value={limitFilter} onChange={setLimitFilter} style={{ width: 130 }} options={[{ value: 'all', label: '全部限购' }, { value: 'limited', label: '已限购' }, { value: 'unlimited', label: '不限购' }]} />
      {selected.length > 0 && <Tag color="blue">已选 {selected.length} 个</Tag>}
      {canEdit && <Button disabled={!selected.length} onClick={() => batchSetStatus('on')}>批量上架</Button>}
      {canEdit && <Button disabled={!selected.length} onClick={() => batchSetStatus('off')}>批量下架</Button>}
      {canDelete && <Button danger disabled={!selected.length} onClick={batchRemove}>批量删除</Button>}
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
      { title: '排序', dataIndex: 'sort', width: 90, sorter: (a, b) => Number(a.sort || 0) - Number(b.sort || 0), render: (v) => v ?? '-' },
      { title: '操作', fixed: 'right', render: (_, r) => <Space>{canEdit && <Button onClick={() => open(r)}>编辑</Button>}{canDelete && <Button danger onClick={() => remove(r)}>删除</Button>}</Space> },
    ]}
    />
    <Drawer title={savedEditing ? "商品编辑" : "新增商品"} open={Boolean(editing)} onClose={() => { setEditing(null); form.resetFields(); }} width={760} extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item label="商品图片" name="image_url"><ProductImageEditor /></Form.Item>
        <div className="product-form-grid product-form-grid-main">
          <Form.Item label="商品ID" name="product_id" rules={[{ required: true }]}><Input readOnly className="readonly-input" /></Form.Item>
          <Form.Item label="名称" name="product_name" rules={[{ required: true }]}><Input /></Form.Item>
        </div>
        <div className="product-form-grid">
          <Form.Item label="金额" name="bob_amount" rules={[{ required: true }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item label="库存" name="stock"><InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="留空为不限" /></Form.Item>
          <Form.Item label="每人限购" name="limit_per_user"><InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="0 表示不限购" /></Form.Item>
        </div>
        <div className="product-limit-round-panel">
          <div>
            <div className="product-limit-round-title">限购轮次</div>
            <div className="product-limit-round-text">{limitRoundText}</div>
          </div>
          <Button disabled={!canStartLimitRound} onClick={startLimitRound}>开启新一轮限购</Button>
        </div>
        <div className="product-form-grid product-form-grid-actions">
          <Form.Item label="状态" name="status"><Select options={[{ value: 'on', label: '上架' }, { value: 'off', label: '下架' }]} /></Form.Item>
          <Form.Item label="启用 CDK" name="cdk_enabled" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item label="保存后通知到群" name="publish_to_group" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item label="排序" name="sort"><InputNumber precision={0} style={{ width: '100%' }} /></Form.Item>
        </div>
        <Form.Item label="备注" name="remark"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Drawer>
  </Space>;
}

function Cdks({ me }) {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generated, setGenerated] = useState(null);
  const [generatedOpen, setGeneratedOpen] = useState(false);
  const [form] = Form.useForm();
  const canCdk = hasPermission(me, 'commerce:cdk');
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
  const remove = (row) => modal.confirm({
    title: '危险区：删除 CDK',
    content: `确认删除 ${row.product_name || '-'} 的 CDK：${row.cdk_code || '-'}？仅未兑换 CDK 可删除。`,
    okText: '确认删除',
    cancelText: '取消',
    okButtonProps: { danger: true },
    onOk: async () => {
      await api('/admin/cdks/delete', { method: 'POST', body: { ids: [row.id] } });
      message.success('已删除');
      load();
    },
  });
  return <Space direction="vertical" style={{ width: '100%' }}>
    <Card size="small" title="生成 CDK"><Form form={form} layout="inline" onFinish={generate}><Form.Item name="product_id" rules={[{ required: true, message: '请选择商品' }]}><Select placeholder="选择商品" style={{ width: 260 }} options={products.map((p) => ({ value: p.product_id, label: `${p.product_name} (${amountText(p.bob_amount)})` }))} /></Form.Item><Form.Item name="quantity" rules={[{ required: true, message: '请输入生成数量' }]}><InputNumber min={1} max={500} precision={0} placeholder="数量" /></Form.Item>{canCdk && <Button type="primary" htmlType="submit">生成并导出</Button>}<Button onClick={load}>刷新</Button></Form></Card>
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
      { title: '商品', dataIndex: 'product_name' }, { title: 'CDK', dataIndex: 'cdk_code', ellipsis: true }, { title: 'CDK 面值', dataIndex: 'product_bob_amount', render: amountText },
      { title: '状态', dataIndex: 'status', render: (v) => <Tag color={v === 'unused' ? 'success' : v === 'redeemed' ? 'red' : 'default'}>{v === 'unused' ? '未兑换' : v === 'redeemed' ? '已兑换' : v === 'deleted' ? '已删除' : v}</Tag> },
      { title: '创建人', render: (_, r) => personText(r.created_name, r.created_by) }, { title: '创建时间', dataIndex: 'created_at', render: formatTs },
      { title: '兑换人', render: (_, r) => personText(r.redeemed_name, r.redeemed_by) }, { title: '兑换时间', dataIndex: 'redeemed_at', render: formatTs },
      { title: '兑换订单', dataIndex: 'redeem_exchange_id', ellipsis: true },
      { title: '操作', render: (_, r) => canCdk ? <Button danger disabled={r.status !== 'unused'} onClick={() => remove(r)}>删除</Button> : '-' },
    ]} />
  </Space>;
}

export default function Commerce({ me }) {
  const canEdit = hasPermission(me, 'commerce:edit');
  const canView = hasPermission(me, 'commerce:view');
  const items = [{ key: 'products', label: '商品管理', children: <Products me={me} /> }];
  if (canView) items.push({ key: 'cdk', label: 'CDK 管理', children: <Cdks me={me} /> });
  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <SiteVisibilityControl canEdit={canEdit} />
    <MallOpeningControl canEdit={canEdit} />
    <Card><Tabs items={items} /></Card>
  </Space>;
}
