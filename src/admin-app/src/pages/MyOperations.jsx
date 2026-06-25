import { useEffect, useState } from 'react';
import { App, Button, Card, DatePicker, Descriptions, Drawer, Select, Space, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import zhCN from 'antd/es/date-picker/locale/zh_CN';
import { api, qs } from '../api.js';
import { formatTs } from '../utils.js';

const { RangePicker } = DatePicker;

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
  if (code === null || code === undefined || code === '' || Number(code) === 0) return <Tag>已记录</Tag>;
  const n = Number(code);
  if (n >= 200 && n < 300) return <Tag color="green">成功</Tag>;
  if (n >= 400) return <Tag color="red">失败</Tag>;
  return <Tag color="orange">需确认</Tag>;
}

function actorText(row) {
  const name = String(row?.actor_display_name || row?.actor_name || '').trim();
  const userid = String(row?.actor_id || '').trim();
  if (name && userid && name !== userid) return `${name}（${userid}）`;
  return name || userid || '-';
}

function operationSummary(row) {
  const text = String(row?.operation_summary || '').trim();
  if (text && text !== '-') return text;
  return row?.message || '-';
}

function detailItems(row) {
  return [
    { key: 'time', label: '时间', children: formatTs(row?.created_at) },
    { key: 'actor', label: '操作者', children: actorText(row) },
    { key: 'event', label: '操作', children: row?.event_label || '后台操作' },
    { key: 'result', label: '结果', children: statusTag(row?.status_code) },
    { key: 'target', label: '对象', children: row?.target_text || '-' },
    { key: 'amount', label: '单人金额', children: row?.amount ? `${row.amount} BOB币` : '-' },
    { key: 'total', label: '合计金额', children: row?.amount_total ? `${row.amount_total} BOB币` : '-' },
    { key: 'reason', label: '原因', children: row?.reason || '-' },
    { key: 'ip', label: 'IP', children: row?.ip || '-' },
    { key: 'path', label: '接口路径', children: row?.path || '-' },
    { key: 'message', label: '日志说明', children: row?.message || '-' },
  ];
}

export default function MyOperations({ me }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [actors, setActors] = useState([]);
  const [eventGroup, setEventGroup] = useState('');
  const [actorId, setActorId] = useState('');
  const [range, setRange] = useState([dayjs().subtract(30, 'day'), dayjs()]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const isSuperAdmin = me?.isSuperAdmin === true;

  const load = async (next = {}) => {
    const nextGroup = next.eventGroup ?? eventGroup;
    const nextActorId = next.actorId ?? actorId;
    const nextRange = next.range ?? range;
    const dateFrom = nextRange?.[0] ? nextRange[0].startOf('day').unix() : '';
    const dateTo = nextRange?.[1] ? nextRange[1].endOf('day').unix() : '';
    setLoading(true);
    try {
      const data = await api(`/admin/my/operations?${qs({ limit: 300, event_group: nextGroup, actor_id: isSuperAdmin ? nextActorId : '', date_from: dateFrom, date_to: dateTo })}`);
      setRows(data.data || []);
      if (isSuperAdmin) setActors(data.actors || []);
    } catch (err) {
      message.error(err.message || '操作记录加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load().catch(() => null); }, [isSuperAdmin]);

  const columns = [
    { title: '时间', dataIndex: 'created_at', render: formatTs, width: 180 },
    ...(isSuperAdmin ? [{ title: '操作者', render: (_, r) => actorText(r), width: 240 }] : []),
    { title: '操作', dataIndex: 'event_label', render: (v, r) => <Tag color={r.event_group === 'danger' ? 'red' : 'blue'}>{v || '后台操作'}</Tag>, width: 140 },
    { title: '结果', dataIndex: 'status_code', render: statusTag, width: 90 },
    { title: '对象与金额', render: (_, r) => operationSummary(r), ellipsis: true },
    { title: '操作', fixed: 'right', width: 90, render: (_, r) => <Button size="small" onClick={() => setDetail(r)}>详情</Button> },
  ];

  return <Card
    title={isSuperAdmin ? '全部管理员操作记录' : '我的操作记录'}
    extra={<Space wrap>
      {isSuperAdmin && <Select
        allowClear
        value={actorId || undefined}
        placeholder="筛选管理员"
        onChange={(v) => { const next = v || ''; setActorId(next); load({ actorId: next }); }}
        options={actors.map((item) => ({ value: item.userid, label: item.name && item.name !== item.userid ? `${item.name}（${item.userid}）` : item.userid }))}
        style={{ width: 260 }}
      />}
      <Select value={eventGroup} onChange={(v) => { setEventGroup(v); load({ eventGroup: v }); }} options={eventOptions} style={{ width: 140 }} />
      <RangePicker locale={zhCN} value={range} format="YYYY-MM-DD" placeholder={["开始日期", "结束日期"]} onChange={(v) => { setRange(v || []); load({ range: v || [] }); }} allowClear />
      <Button onClick={() => load()}>刷新</Button>
    </Space>}
  >
    <Table
      rowKey="id"
      loading={loading}
      dataSource={rows}
      pagination={{ pageSize: 20, showSizeChanger: true }}
      columns={columns}
      scroll={{ x: isSuperAdmin ? 1180 : 980 }}
    />
    <Drawer title="操作详情" open={Boolean(detail)} onClose={() => setDetail(null)} width={760}>
      {detail && <Descriptions bordered column={1} items={detailItems(detail)} />}
    </Drawer>
  </Card>;
}
