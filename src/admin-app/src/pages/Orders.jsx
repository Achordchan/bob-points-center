import { useEffect, useState } from 'react';
import { App, Button, Card, Descriptions, Drawer, Modal, Space, Table, Tabs, Tag } from 'antd';
import { api } from '../api.js';
import { amountText, formatTs, orderAmount } from '../utils.js';
import RedeemScanner from '../components/RedeemScanner.jsx';

function RedeemCenter({ onRedeemed }) {
  const { message } = App.useApp();
  const [encoded, setEncoded] = useState('');
  const [redeeming, setRedeeming] = useState(false);

  const confirmRedeem = async () => {
    if (!encoded.trim()) {
      message.warning('请输入二维码 encoded 内容');
      return false;
    }
    setRedeeming(true);
    try {
      await api('/admin/redeem/confirm', { method: 'POST', body: { encoded: encoded.trim() } });
      message.success('核销完成');
      setEncoded('');
      onRedeemed?.();
      return true;
    } catch (err) {
      message.error(err.message || '核销失败');
      return false;
    } finally {
      setRedeeming(false);
    }
  };

  return <RedeemScanner encoded={encoded} onEncodedChange={setEncoded} onRedeem={confirmRedeem} redeeming={redeeming} />;
}

function OrderTable({ type, onOpen, reloadKey }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api(`/admin/redeem/${type}?limit=120`);
      setRows(data.data || []);
    } catch (err) {
      message.error(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [type, reloadKey]);

  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <Space><Button onClick={load}>刷新</Button>{type === 'history' && <Button danger onClick={() => Modal.confirm({ title: '危险区：清空已核销历史', content: '该操作会隐藏历史核销记录，请确认不再需要追溯。', okText: '确认清空', okButtonProps: { danger: true }, cancelText: '取消', onOk: async () => { await api('/admin/redeem/history/clear', { method: 'POST', body: { confirm: 'CLEAR_REDEEM_HISTORY' } }); message.success('已清空'); load(); } })}>危险区：清空历史</Button>}</Space>
    <Table rowKey="exchange_id" loading={loading} dataSource={rows} scroll={{ x: 980 }} columns={[
      { title: '时间', dataIndex: type === 'history' ? 'fulfilled_at' : 'created_at', render: formatTs },
      { title: '用户', render: (_, r) => r.name ? `${r.name} (${r.userid})` : r.userid },
      { title: '兑换单号', dataIndex: 'exchange_id', ellipsis: true },
      { title: '商品', dataIndex: 'product_name' },
      { title: '金额', render: (_, r) => amountText(orderAmount(r)) },
      { title: '操作', render: (_, r) => <Button onClick={() => onOpen(r.exchange_id)}>详情</Button> },
    ]} />
  </Space>;
}

export default function Orders() {
  const [detail, setDetail] = useState(null);
  const [redeemVersion, setRedeemVersion] = useState(0);
  const open = async (id) => setDetail((await api(`/admin/orders/${encodeURIComponent(id)}`)).data);
  return <Card>
    <Tabs
      defaultActiveKey="redeem"
      items={[
        { key: 'redeem', label: '核销中心', children: <RedeemCenter onRedeemed={() => setRedeemVersion((v) => v + 1)} /> },
        { key: 'pending', label: '未核销', children: <OrderTable type="pending" onOpen={open} reloadKey={redeemVersion} /> },
        { key: 'history', label: '已核销', children: <OrderTable type="history" onOpen={open} reloadKey={redeemVersion} /> },
      ]}
    />
    <Drawer title="订单详情" open={Boolean(detail)} onClose={() => setDetail(null)} width={720}>
      {detail && <Descriptions bordered column={1} items={[
        { key: 'id', label: '兑换单号', children: detail.order?.exchange_id },
        { key: 'user', label: '用户', children: `${detail.order?.name || '-'} (${detail.order?.userid || '-'})` },
        { key: 'product', label: '商品', children: detail.order?.product_name || '-' },
        { key: 'amount', label: '金额', children: amountText(orderAmount(detail.order)) },
        { key: 'source', label: '来源', children: detail.order?.redeem_source === 'cdk' ? 'CDK' : '商城' },
        { key: 'created', label: '下单时间', children: formatTs(detail.order?.created_at) },
        { key: 'fulfilled', label: '核销时间', children: formatTs(detail.order?.fulfilled_at) },
      ]} />}
    </Drawer>
  </Card>;
}
