import { useEffect, useState } from 'react';
import { App, Card, Select, Space, Table, Tag } from 'antd';
import { api, qs } from '../api.js';
import { formatTs } from '../utils.js';

const eventOptions = [
  { value: '', label: '全部操作' },
  { value: 'grant', label: '发币' },
  { value: 'deduct', label: '减币' },
  { value: 'redeem', label: '核销' },
  { value: 'backup', label: '备份' },
  { value: 'role', label: '角色权限' },
  { value: 'danger', label: '危险操作' },
];

function statusTag(code) {
  const n = Number(code || 0);
  if (n >= 200 && n < 300) return <Tag color="green">成功</Tag>;
  if (n >= 400) return <Tag color="red">失败</Tag>;
  return <Tag>未知</Tag>;
}

function payloadSummary(payload) {
  const data = payload && typeof payload === 'object' ? payload : null;
  if (!data) return '-';
  const parts = [];
  if (Array.isArray(data.userids)) parts.push(`用户 ${data.userids.length} 人`);
  if (data.amount) parts.push(`金额 ${data.amount}`);
  if (data.product_name) parts.push(`原因 ${data.product_name}`);
  if (data.reason) parts.push(`原因 ${data.reason}`);
  if (data.userid) parts.push(`用户 ${data.userid}`);
  if (data.roleId) parts.push(`角色 ${data.roleId}`);
  return parts.join('，') || '-';
}

export default function MyOperations({ me }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [eventGroup, setEventGroup] = useState('');
  const [loading, setLoading] = useState(false);
  const isSuperAdmin = me?.isSuperAdmin === true;

  const load = async (nextGroup = eventGroup) => {
    setLoading(true);
    try {
      const data = await api(`/admin/my/operations?${qs({ days: 30, limit: 200, event_group: nextGroup })}`);
      setRows(data.data || []);
    } catch (err) {
      message.error(err.message || '操作记录加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load().catch(() => null); }, []);

  const columns = [
    { title: '时间', dataIndex: 'created_at', render: formatTs, width: 180 },
    ...(isSuperAdmin ? [{ title: '操作者', render: (_, r) => r.actor_name ? `${r.actor_name}（${r.actor_id || '-'}）` : (r.actor_id || '-'), width: 220 }] : []),
    { title: '操作', dataIndex: 'event_label', render: (v, r) => <Tag color={r.event_group === 'danger' ? 'red' : 'blue'}>{v || '后台操作'}</Tag>, width: 150 },
    { title: '结果', dataIndex: 'status_code', render: statusTag, width: 100 },
    { title: '内容', render: (_, r) => payloadSummary(r.payload), ellipsis: true },
    { title: '路径', dataIndex: 'path', ellipsis: true },
  ];

  return <Card title={isSuperAdmin ? '全部管理员操作记录' : '我的操作记录'} extra={<Space><Select value={eventGroup} onChange={(v) => { setEventGroup(v); load(v); }} options={eventOptions} style={{ width: 160 }} /></Space>}>
    <Table
      rowKey="id"
      loading={loading}
      dataSource={rows}
      pagination={{ pageSize: 20, showSizeChanger: true }}
      columns={columns}
      scroll={{ x: isSuperAdmin ? 1180 : 980 }}
    />
  </Card>;
}
