import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Drawer, Input, Modal, Space, Spin, Table, Tabs, Typography } from 'antd';
import { api, qs } from '../api.js';
import { amountText, formatTs, localTablePagination, orderAmount } from '../utils.js';
import RedeemScanner from '../components/RedeemScanner.jsx';
import { hasPermission } from '../permissions.js';

const CLEAR_HISTORY_CONFIRM = 'CLEAR_REDEEM_HISTORY';

function verifierText(row) {
  const name = String(row?.fulfilled_name || '').trim();
  const userid = String(row?.fulfilled_by || '').trim();
  if (name && userid) return `${name} (${userid})`;
  return name || userid || '-';
}

function decodeBase64UrlToText(encoded) {
  const input = String(encoded || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!input) return '';
  const padded = input.padEnd(input.length + ((4 - (input.length % 4)) % 4), '=');
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function parseEncodedPayload(encoded) {
  try {
    const data = JSON.parse(decodeBase64UrlToText(encoded));
    const payload = data?.payload;
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

function payloadProductText(payload) {
  const name = String(payload?.product_name || '').trim();
  const id = String(payload?.product_id || '').trim();
  if (name && id) return `${name} (${id})`;
  return name || id || '-';
}

function RedeemCenter({ onRedeemed }) {
  const { message } = App.useApp();
  const [encoded, setEncoded] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [lastResult, setLastResult] = useState(null);
  const payload = useMemo(() => parseEncodedPayload(encoded), [encoded]);
  const trimmedEncoded = encoded.trim();

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError('');
    setPreviewing(false);
    if (!trimmedEncoded) return undefined;
    if (!payload?.exchange_id) {
      setPreviewError('二维码内容无效，请重新扫码');
      return undefined;
    }

    setPreviewing(true);
    api(`/admin/orders/${encodeURIComponent(payload.exchange_id)}`)
      .then((result) => {
        if (!cancelled) setPreview(result.data || null);
      })
      .catch((err) => {
        if (!cancelled) setPreviewError(err.message || '订单信息读取失败，请重新扫码');
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => { cancelled = true; };
  }, [payload?.exchange_id, trimmedEncoded]);

  const resetScan = () => {
    setEncoded('');
    setPreview(null);
    setPreviewError('');
    setPreviewing(false);
  };

  const doRedeem = async () => {
    if (!trimmedEncoded) {
      message.warning('请先扫码识别订单');
      return false;
    }
    if (!payload) {
      message.error('二维码内容无效，请重新扫码');
      return false;
    }
    if (preview?.order?.fulfilled_at) {
      message.warning('该订单已核销，不能重复操作');
      return false;
    }

    setRedeeming(true);
    try {
      const result = await api('/admin/redeem/confirm', { method: 'POST', body: { encoded: trimmedEncoded } });
      message.success('核销完成');
      setLastResult({ ...result, payload, order: preview?.order || null });
      resetScan();
      onRedeemed?.();
      return true;
    } catch (err) {
      message.error(err.message || '核销失败');
      return false;
    } finally {
      setRedeeming(false);
    }
  };

  const order = preview?.order || null;
  const confirmDisabled = !payload || !order || Boolean(order.fulfilled_at) || previewing || Boolean(previewError);

  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <RedeemScanner encoded={encoded} onEncodedChange={setEncoded} />
    {trimmedEncoded && <Card size="small" className="redeem-confirm-card" title="待核销订单">
      {previewing ? <div className="redeem-confirm-loading"><Spin />正在读取订单信息…</div> : previewError ? <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Alert type="error" showIcon message={previewError} />
        <Button onClick={resetScan}>重新扫码</Button>
      </Space> : order ? <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {order.fulfilled_at && <Alert type="warning" showIcon message="该订单已核销" description={`核销时间：${formatTs(order.fulfilled_at)}`} />}
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={[
          { key: 'status', label: '订单状态', children: order.fulfilled_at ? '已核销' : '待核销' },
          { key: 'exchange', label: '兑换单号', children: order.exchange_id || payload.exchange_id || '-' },
          { key: 'user', label: '用户', children: order.name ? `${order.name} (${order.userid})` : (order.userid || payload.userid || '-') },
          { key: 'product', label: '商品', children: payloadProductText(order) },
          { key: 'amount', label: '金额', children: amountText(orderAmount(order)) },
          ...(order.redeem_source !== 'cdk' && order.created_at ? [
            { key: 'created', label: '下单时间', children: formatTs(order.created_at) },
          ] : []),
        ]} />
        <Space className="redeem-confirm-actions" wrap>
          <Button onClick={resetScan}>重新扫码</Button>
          <Button type="primary" loading={redeeming} disabled={confirmDisabled} onClick={doRedeem}>确认核销</Button>
        </Space>
      </Space> : <Typography.Text type="secondary">识别成功后将在这里显示订单信息。</Typography.Text>}
    </Card>}
    {lastResult && <Card size="small" title="最近核销结果">
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={[
        { key: 'exchange', label: '兑换单号', children: lastResult.order?.exchange_id || lastResult.exchange_id || lastResult.payload?.exchange_id || '-' },
        { key: 'userid', label: '用户', children: lastResult.order?.name ? `${lastResult.order.name} (${lastResult.userid || lastResult.order.userid})` : (lastResult.userid || lastResult.payload?.userid || '-') },
        { key: 'product', label: '商品', children: payloadProductText(lastResult.order || lastResult.payload) },
        { key: 'amount', label: '金额', children: amountText(orderAmount(lastResult.order || lastResult.payload)) },
        { key: 'balance', label: '剩余余额', children: amountText(lastResult.balance) },
      ]} />
    </Card>}
  </Space>;
}

function OrderTable({ type, onOpen, reloadKey, me }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearText, setClearText] = useState('');
  const [clearing, setClearing] = useState(false);

  const load = async ({ append = false, cursor = '' } = {}) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const data = await api(`/admin/redeem/${type}?${qs({ limit: 120, cursor })}`);
      const nextRows = data.data || [];
      setRows((prev) => append ? [...prev, ...nextRows] : nextRows);
      setNextCursor(data.nextCursor || '');
      setHasMore(Boolean(data.hasMore));
    } catch (err) {
      message.error(err.message);
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  };
  useEffect(() => { load(); }, [type, reloadKey]);

  const clearHistory = async () => {
    if (clearText !== CLEAR_HISTORY_CONFIRM) {
      message.warning('确认口令不正确');
      return;
    }
    setClearing(true);
    try {
      await api('/admin/redeem/history/clear', { method: 'POST', body: { confirm: CLEAR_HISTORY_CONFIRM } });
      message.success('已清空');
      setClearOpen(false);
      setClearText('');
      load();
    } finally {
      setClearing(false);
    }
  };

  const columns = [];
  if (type === 'history') {
    columns.push({
      title: '时间',
      render: (_, row) => type === 'history'
        ? formatTs(row.fulfilled_at)
        : (row.redeem_source === 'cdk' ? '-' : formatTs(row.created_at)),
    });
  }
  columns.push(
    { title: '用户', render: (_, r) => r.name ? `${r.name} (${r.userid})` : r.userid },
    { title: '兑换单号', dataIndex: 'exchange_id', ellipsis: true },
    { title: '商品', dataIndex: 'product_name' },
    { title: '金额', render: (_, r) => amountText(orderAmount(r)) },
  );
  if (type === 'history') columns.push({ title: '核销人', render: (_, r) => verifierText(r) });
  if (type === 'history') {
    columns.push({
      title: '操作',
      render: (_, r) => r.created_at
        ? <Button onClick={() => onOpen(r.exchange_id)}>详情</Button>
        : <Typography.Text type="secondary">-</Typography.Text>,
    });
  }

  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <Space>
      <Button onClick={() => load()}>刷新</Button>
      {type === 'history' && me?.isSuperAdmin && <Button danger onClick={() => { setClearText(''); setClearOpen(true); }}>危险区：清空历史</Button>}
    </Space>
    <Table rowKey="exchange_id" loading={loading} dataSource={rows} pagination={localTablePagination('单', 30)} scroll={{ x: type === 'history' ? 1120 : 760 }} columns={columns} />
    {hasMore && <Button block loading={loadingMore} onClick={() => load({ append: true, cursor: nextCursor })}>加载更多</Button>}
    <Modal
      title="危险区：清空已核销历史"
      open={clearOpen}
      onCancel={() => setClearOpen(false)}
      onOk={clearHistory}
      confirmLoading={clearing}
      okText="确认清空"
      okButtonProps={{ danger: true, disabled: clearText !== CLEAR_HISTORY_CONFIRM }}
      cancelText="取消"
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <div>该操作会隐藏历史核销记录，不会删除订单本身。请输入确认口令：</div>
        <Input value={clearText} onChange={(event) => setClearText(event.target.value)} placeholder={CLEAR_HISTORY_CONFIRM} />
      </Space>
    </Modal>
  </Space>;
}

export default function Orders({ me }) {
  const [detail, setDetail] = useState(null);
  const [redeemVersion, setRedeemVersion] = useState(0);
  const open = async (id) => setDetail((await api(`/admin/orders/${encodeURIComponent(id)}`)).data);
  const items = [];
  if (hasPermission(me, 'orders:redeem')) items.push({ key: 'redeem', label: '核销中心', children: <RedeemCenter onRedeemed={() => setRedeemVersion((v) => v + 1)} /> });
  items.push(
    { key: 'pending', label: '未核销', children: <OrderTable type="pending" onOpen={open} reloadKey={redeemVersion} me={me} /> },
    { key: 'history', label: '已核销', children: <OrderTable type="history" onOpen={open} reloadKey={redeemVersion} me={me} /> },
  );
  return <Card>
    <Tabs defaultActiveKey={items[0]?.key} items={items} />
    <Drawer title="订单详情" open={Boolean(detail)} onClose={() => setDetail(null)} width={720}>
      {detail && <Descriptions bordered column={1} items={[
        { key: 'id', label: '兑换单号', children: detail.order?.exchange_id },
        { key: 'user', label: '用户', children: `${detail.order?.name || '-'} (${detail.order?.userid || '-'})` },
        { key: 'product', label: '商品', children: detail.order?.product_name || '-' },
        { key: 'amount', label: '金额', children: amountText(orderAmount(detail.order)) },
        { key: 'fulfilled', label: '核销时间', children: formatTs(detail.order?.fulfilled_at) },
        { key: 'verifier', label: '核销人', children: verifierText(detail.order) },
      ]} />}
    </Drawer>
  </Card>;
}
