import { lazy, Suspense, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { App, Alert, Button, Card, Col, DatePicker, Descriptions, Drawer, Form, Image, Input, InputNumber, Modal, Row, Select, Space, Statistic, Switch, Table, Tabs, Tag } from 'antd';
import { api, qs } from '../api.js';
import DataToolbar from '../components/DataToolbar.jsx';
import ProductImageEditor from '../components/ProductImageEditor.jsx';
const RichTextEditor = lazy(() => import('../components/RichTextEditor.jsx'));
import { amountText, formatTs, localTablePagination } from '../utils.js';
import { hasPermission } from '../permissions.js';

const redPacketStatusText = { pending: '待开始', scheduled: '倒计时中', active: '进行中', ended: '已结束', cancelled: '已取消' };
const charityStatusText = { active: '启用', paused: '暂停', archived: '归档' };
const executionStatusText = { pending: '待执行', in_progress: '执行中', completed: '已完成' };
const attendanceStatusText = { rewarded: '已奖励', skipped: '已跳过', test_passed: '测试通过', error: '异常', pending: '待处理' };
const attendanceSourceText = { stream: '实时推送', reconcile: '自动补发/对账', audit_seed: '历史补录', historical: '历史记录' };
const attendanceCheckTypeText = { on_duty: '上班打卡', off_duty: '下班打卡' };
const attendanceReasonText = {
  test_mode: '测试模式：未发放 BOB 币，未发送通知',
  skipped_off_duty: '下班打卡已按规则忽略',
  skip_not_on_duty: '非上班打卡按规则不发放',
  not_on_duty: '非上班打卡按规则不发放',
  skipped_late: '迟到打卡不发放',
  late: '迟到打卡不发放',
  duplicate: '当天已发放，重复打卡不再发放',
  department_not_allowed: '未命中奖励部门',
  department_not_matched: '不在适用部门范围内',
  before_start_date: '早于奖励生效日期，未发放',
};

function statusText(map, value) {
  return map[value] || value || '-';
}

function isCurrentRedPacketStatus(value) {
  return ['pending', 'scheduled', 'active'].includes(String(value || ''));
}

function packetClaimUser(row) {
  const name = String(row?.name || '').trim();
  const userid = String(row?.userid || '').trim();
  if (name && userid) return `${name} (${userid})`;
  return name || userid || '-';
}

function RedPackets({ me }) {
  const { message, modal } = App.useApp();
  const canEdit = hasPermission(me, 'activities:edit');
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [detail, setDetail] = useState(null);
  const [form] = Form.useForm();
  const load = async () => { const statusResp = await api('/admin/red-packet/status'); setStatus(statusResp.data ? { ...statusResp.data, claimed_count: statusResp.claimed_count, server_time: statusResp.server_time } : null); setHistory((await api('/admin/red-packet/history')).data || []); };
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const start = async (values) => { await api('/admin/red-packet/start', { method: 'POST', body: values }); message.success('红包活动已创建'); form.resetFields(); load(); };
  const clear = () => modal.confirm({ title: '危险区：清空红包历史', content: '清空后无法恢复。', okButtonProps: { danger: true }, onOk: async () => { await api('/admin/red-packet/history/clear', { method: 'POST' }); message.success('已清空'); load(); } });
  const remove = (row) => modal.confirm({ title: '删除红包活动', content: `确认删除红包活动 #${row.id}？该活动及领取明细会被删除。`, okText: '确认删除', cancelText: '取消', okButtonProps: { danger: true }, onOk: async () => { await api('/admin/red-packet/history/delete', { method: 'POST', body: { activity_id: row.id } }); message.success('已删除'); if (detail?.id === row.id) setDetail(null); load(); } });
  return <Space direction="vertical" style={{ width: '100%' }}>
    <Card size="small" title="红包配置" extra={<Tag color={status?.status === 'active' ? 'green' : 'default'}>{isCurrentRedPacketStatus(status?.status) ? statusText(redPacketStatusText, status.status) : '未开始'}</Tag>}>
      <Form form={form} layout="inline" onFinish={start}><Form.Item name="total_amount" rules={[{ required: true }]}><InputNumber min={1} placeholder="总金额" disabled={!canEdit} /></Form.Item><Form.Item name="total_count" rules={[{ required: true }]}><InputNumber min={1} placeholder="人数" disabled={!canEdit} /></Form.Item><Form.Item name="countdown_seconds" rules={[{ required: true }]}><InputNumber min={0} placeholder="倒计时秒" disabled={!canEdit} /></Form.Item><Form.Item name="duration_minutes" rules={[{ required: true }]}><InputNumber min={1} placeholder="持续分钟" disabled={!canEdit} /></Form.Item><Form.Item name="sponsor"><Input placeholder="赞助人" readOnly={!canEdit} /></Form.Item>{canEdit && <Button type="primary" htmlType="submit">创建并开始</Button>}<Button onClick={load}>刷新</Button></Form>
    </Card>
    <DataToolbar onRefresh={load}>{me?.isSuperAdmin && <Button danger onClick={clear}>危险区：清空历史</Button>}</DataToolbar>
    <Table rowKey="id" dataSource={history} pagination={localTablePagination('个活动')} scroll={{ x: 1080 }} columns={[{ title: 'ID', dataIndex: 'id' }, { title: '创建时间', dataIndex: 'created_at', render: formatTs }, { title: '总额', dataIndex: 'total_amount', render: amountText }, { title: '份数', dataIndex: 'total_count' }, { title: '已抢', dataIndex: 'claimed_count' }, { title: '状态', dataIndex: 'status', render: (v) => statusText(redPacketStatusText, v) }, { title: '赞助人', dataIndex: 'sponsor' }, { title: '操作', fixed: 'right', render: (_, r) => <Space><Button onClick={() => setDetail(r)}>详情</Button>{me?.isSuperAdmin && <Button danger onClick={() => remove(r)}>删除</Button>}</Space> }]} />
    <Drawer title="红包详情" open={Boolean(detail)} onClose={() => setDetail(null)} width={720}>
      {detail && <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Descriptions bordered column={1} size="small" items={[
          { key: 'id', label: '活动ID', children: detail.id },
          { key: 'created', label: '创建时间', children: formatTs(detail.created_at) },
          { key: 'start', label: '发起时间', children: formatTs(detail.start_at) },
          { key: 'end', label: '结束时间', children: formatTs(detail.end_at) },
          { key: 'amount', label: '总额', children: amountText(detail.total_amount) },
          { key: 'count', label: '份数', children: `${detail.claimed_count || 0}/${detail.total_count || 0}` },
          { key: 'status', label: '状态', children: statusText(redPacketStatusText, detail.status) },
          { key: 'sponsor', label: '赞助人', children: detail.sponsor || '-' },
        ]} />
        <Table
          rowKey={(row) => `${row.userid || 'unknown'}_${row.claimed_at || 0}_${row.amount || 0}`}
          size="small"
          pagination={localTablePagination('条记录', 8)}
          dataSource={detail.claimed_items || []}
          columns={[
            { title: '领取时间', dataIndex: 'claimed_at', render: formatTs },
            { title: '领取人', render: (_, row) => packetClaimUser(row) },
            { title: '金额', dataIndex: 'amount', render: amountText },
          ]}
        />
      </Space>}
    </Drawer>
  </Space>;
}


const auctionStatusText = { scheduled: '待开始', active: '进行中', settled: '已结算', cancelled: '已取消', settling: '待结算' };
const auctionStatusColor = { scheduled: 'blue', active: 'green', settled: 'default', cancelled: 'red', settling: 'orange' };
const auctionBidStateText = { held: '在押', refunded: '已退回', won: '竞得' };
const auctionBidStateColor = { held: 'processing', refunded: 'default', won: 'gold' };

const auctionAdminErrorText = {
  'missing title': '请填写竞拍标题',
  'title too long': '标题最多 80 字',
  'description too long': '活动说明最多 2000 字',
  'image_url too long': '图片地址过长',
  'start_price must be positive integer': '起拍价必须是正整数',
  'start_price too large': '起拍价超出上限',
  'min_increment must be positive integer': '最低加价必须是正整数',
  'min_increment too large': '最低加价超出上限',
  'invalid start_at': '开始时间无效',
  'start_at is in the past': '开始时间不能早于当前时间',
  'invalid end_at': '结束时间无效',
  'end_at must be at least 60 seconds in the future': '结束时间至少要在 1 分钟后',
  'auction duration must be at least 60 seconds': '竞拍时长至少 1 分钟',
  'anti_snipe_seconds must be between 0 and 600': '防狙击秒数需在 0-600 之间',
  'auction not found': '竞拍不存在，请刷新列表',
  'auction_already_cancelled': '该竞拍已被取消',
  'auction_already_settled': '该竞拍已结束（到期后不可取消，最高出价已锁定）',
  'invalid activity_id': '参数错误：活动 ID 无效',
  concurrent_bid_conflict: '操作冲突，请刷新后重试',
};

function humanizeAuctionAdminError(err) {
  const key = String(err?.message || err || '');
  return auctionAdminErrorText[key] || (Number(err?.status) >= 500 ? '系统繁忙，请稍后再试' : `操作失败：${key}`);
}

function Auctions({ me }) {
  const { message, modal } = App.useApp();
  const canEdit = hasPermission(me, 'activities:edit');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [form] = Form.useForm();

  const load = async (nextStatus = statusFilter) => {
    setLoading(true);
    try {
      const resp = await api(`/admin/auction/list?${qs({ limit: 100, status: nextStatus })}`);
      setRows(resp.data || []);
    } catch (err) {
      message.error(err.message || '竞拍列表加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load().catch(() => null); }, []);

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({
      start_price: 100,
      min_increment: 10,
      range: [dayjs().add(10, 'minute'), dayjs().add(1, 'day')],
      anti_snipe_seconds: 0,
    });
    setCreating(true);
  };

  const submitCreate = async (values) => {
    const [startAt, endAt] = values.range || [];
    if (!startAt || !endAt) {
      message.error('请选择开始与结束时间');
      return;
    }
    try {
      await api('/admin/auction/create', {
        method: 'POST',
        body: {
          title: values.title,
          description: values.description || '',
          image_url: values.image_url || '',
          start_price: values.start_price,
          min_increment: values.min_increment,
          start_at: startAt.unix(),
          end_at: endAt.unix(),
          anti_snipe_seconds: values.anti_snipe_seconds ?? 0,
        },
      });
      message.success('竞拍活动已创建');
      setCreating(false);
      form.resetFields();
      load();
    } catch (err) {
      message.error(humanizeAuctionAdminError(err));
    }
  };

  const openDetail = async (id) => {
    setDetailLoading(true);
    try {
      const resp = await api(`/admin/auction/detail?id=${id}`);
      setDetail(resp.data || null);
    } catch (err) {
      message.error(err.message || '详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const submitCancel = async () => {
    if (!cancelling) return;
    setCancelBusy(true);
    try {
      await api('/admin/auction/cancel', {
        method: 'POST',
        body: { activity_id: cancelling.id, reason: cancelReason || '' },
      });
      message.success('竞拍已取消，在押金额已退回');
      setCancelling(null);
      setCancelReason('');
      if (detail?.id === cancelling.id) setDetail(null);
      load();
    } catch (err) {
      message.error(humanizeAuctionAdminError(err));
    } finally {
      setCancelBusy(false);
    }
  };

  // 以 effective_status 为准：到期未结算（settling）的活动服务端会拒绝取消，前端直接隐藏入口。
  const canCancelRow = (row) => canEdit && ['scheduled', 'active'].includes(String(row?.effective_status || row?.status || ''));
  const auctionUser = (row) => {
    const name = String(row?.display_name || row?.winner_name || '').trim();
    const userid = String(row?.userid || row?.winner_userid || '').trim();
    if (name && userid && name !== userid) return `${name} (${userid})`;
    return name || userid || '-';
  };

  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <DataToolbar
      onRefresh={() => load()}
      onCreate={canEdit ? openCreate : null}
      createText="新建竞拍"
    >
      <Select
        allowClear
        placeholder="状态筛选"
        style={{ width: 140 }}
        value={statusFilter || undefined}
        onChange={(v) => { const next = v || ''; setStatusFilter(next); load(next); }}
        options={Object.entries(auctionStatusText).filter(([k]) => k !== 'settling').map(([k, v]) => ({ value: k, label: v }))}
      />
    </DataToolbar>
    <Table
      rowKey="id"
      loading={loading}
      dataSource={rows}
      pagination={localTablePagination('场竞拍')}
      scroll={{ x: 1180 }}
      columns={[
        { title: 'ID', dataIndex: 'id', width: 64 },
        { title: '标题', dataIndex: 'title', ellipsis: true },
        { title: '起拍价', dataIndex: 'start_price', width: 110, render: amountText },
        { title: '当前价', dataIndex: 'current_price', width: 110, render: (v) => v === null || v === undefined ? '-' : amountText(v) },
        { title: '出价数', dataIndex: 'bid_count', width: 80 },
        { title: '状态', dataIndex: 'status', width: 90, render: (v, r) => <Tag color={auctionStatusColor[r.effective_status] || auctionStatusColor[v] || 'default'}>{statusText(auctionStatusText, r.effective_status === 'settling' ? 'settling' : v)}</Tag> },
        { title: '开始时间', dataIndex: 'start_at', width: 160, render: formatTs },
        { title: '结束时间', dataIndex: 'end_at', width: 160, render: formatTs },
        { title: '得主', width: 170, render: (_, r) => r.winner_userid ? auctionUser(r) : (r.current_bidder_name ? `${r.current_bidder_name}（领先）` : '-') },
        { title: '操作', fixed: 'right', width: 150, render: (_, r) => <Space>
          <Button size="small" onClick={() => openDetail(r.id)}>详情</Button>
          {canCancelRow(r) && <Button size="small" danger onClick={() => { setCancelling(r); setCancelReason(''); }}>取消</Button>}
        </Space> },
      ]}
    />

    <Modal
      title="新建限时竞拍"
      open={creating}
      onCancel={() => setCreating(false)}
      onOk={() => form.submit()}
      okText="创建"
      cancelText="取消"
      okButtonProps={{ disabled: !canEdit }}
      width={640}
      destroyOnClose
    >
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="用户出价即冻结 BOB 币；被他人超出自动退回；结束后最高出价人竞得，冻结金额转为成交扣款。" />
      <Form form={form} layout="vertical" onFinish={submitCreate}>
        <Form.Item name="title" label="竞拍标题" rules={[{ required: true, whitespace: true, message: '请输入标题' }, { max: 80, message: '标题最多 80 字' }]}>
          <Input placeholder="如：限量周边礼盒" readOnly={!canEdit} />
        </Form.Item>
        <Form.Item name="image_url" label="商品图片">
          <ProductImageEditor emptyText="未设置商品图片" disabled={!canEdit} />
        </Form.Item>
        <Row gutter={[12, 0]}>
          <Col span={12}><Form.Item name="start_price" label="起拍价（BOB 币）" rules={[{ required: true, message: '请输入起拍价' }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} disabled={!canEdit} /></Form.Item></Col>
          <Col span={12}><Form.Item name="min_increment" label="最低加价幅度（BOB 币）" rules={[{ required: true, message: '请输入加价幅度' }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} disabled={!canEdit} /></Form.Item></Col>
          <Col span={24}><Form.Item name="range" label="起止时间" rules={[{ required: true, message: '请选择起止时间' }]}>
            <DatePicker.RangePicker
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              style={{ width: '100%' }}
              disabled={!canEdit}
              disabledDate={(d) => d && d.isBefore(dayjs().subtract(1, 'day'))}
              disabledTime={(current, type) => {
                const now = dayjs();
                if (!current || !current.isSame(now, 'day')) return {};
                if (type === 'start') {
                  return {
                    disabledHours: () => Array.from({ length: now.hour() }, (_, i) => i),
                    disabledMinutes: (selectedHour) => selectedHour === now.hour()
                      ? Array.from({ length: now.minute() }, (_, i) => i)
                      : [],
                  };
                }
                return {};
              }}
            />
          </Form.Item></Col>
          <Col span={12}><Form.Item name="anti_snipe_seconds" label="防狙击秒数（0 关闭）" extra="结束前该秒数内出价会顺延结束时间"><InputNumber min={0} max={600} precision={0} style={{ width: '100%' }} disabled={!canEdit} /></Form.Item></Col>
        </Row>
        <Form.Item name="description" label="活动说明">
          <Input.TextArea rows={3} maxLength={2000} readOnly={!canEdit} placeholder="可填写商品介绍、领取方式等" />
        </Form.Item>
      </Form>
    </Modal>

    <Modal
      title={`取消竞拍 #${cancelling?.id ?? ''}`}
      open={Boolean(cancelling)}
      onCancel={() => { setCancelling(null); setCancelReason(''); }}
      onOk={submitCancel}
      okText="确认取消"
      cancelText="返回"
      okButtonProps={{ danger: true, loading: cancelBusy }}
      destroyOnClose
    >
      {cancelling?.current_price ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`当前已有在押出价 ${cancelling.current_price} BOB 币，取消后将全额退回出价人余额。`} /> : null}
      <Input placeholder="取消原因（可选，最多 200 字）" maxLength={200} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
    </Modal>

    <Drawer title={`竞拍详情 #${detail?.id ?? ''}`} open={Boolean(detail)} onClose={() => setDetail(null)} width={760}>
      {detail && <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Descriptions bordered size="small" column={2} items={[
          { key: 'title', label: '标题', span: 2, children: detail.title },
          { key: 'status', label: '状态', children: <Tag color={auctionStatusColor[detail.effective_status] || auctionStatusColor[detail.status] || 'default'}>{statusText(auctionStatusText, detail.effective_status === 'settling' ? 'settling' : detail.status)}</Tag> },
          { key: 'bids', label: '出价次数', children: detail.bid_count },
          { key: 'start_price', label: '起拍价', children: amountText(detail.start_price) },
          { key: 'min_increment', label: '最低加价', children: amountText(detail.min_increment) },
          { key: 'start', label: '开始时间', children: formatTs(detail.start_at) },
          { key: 'end', label: '结束时间', children: formatTs(detail.end_at) },
          { key: 'anti', label: '防狙击', children: Number(detail.anti_snipe_seconds) > 0 ? `${detail.anti_snipe_seconds} 秒` : '关闭' },
          { key: 'current', label: '当前价', children: detail.current_price === null || detail.current_price === undefined ? '-' : amountText(detail.current_price) },
          { key: 'leader', label: '当前领先', children: detail.current_bidder_name ? `${detail.current_bidder_name} (${detail.current_bid_userid})` : '-' },
          { key: 'winner', label: '得主', children: detail.winner_userid ? `${detail.winner_name || '-'} (${detail.winner_userid})` : (detail.status === 'settled' ? '流拍' : '-') },
          { key: 'final', label: '成交价', children: detail.final_price === null || detail.final_price === undefined ? '-' : amountText(detail.final_price) },
          { key: 'settled', label: '结算时间', children: formatTs(detail.settled_at) },
          { key: 'redeem', label: '领取单号', children: detail.winner_userid ? `AUCTION_${detail.id}（用户端出示核销二维码，扫码即完成发放）` : '-' },
          { key: 'cancel', label: '取消原因', children: detail.cancel_reason || '-' },
          { key: 'created', label: '创建人', span: 2, children: detail.created_name ? `${detail.created_name} (${detail.created_by})` : '-' },
        ]} />
        {detail.description ? <Card size="small" title="活动说明"><div style={{ whiteSpace: 'pre-wrap' }}>{detail.description}</div></Card> : null}
        <Card size="small" title={`出价记录（最近 ${Array.isArray(detail.bids) ? detail.bids.length : 0} 条）`}>
          <Table
            rowKey="id"
            size="small"
            loading={detailLoading}
            dataSource={detail.bids || []}
            pagination={localTablePagination('条出价', 10)}
            columns={[
              { title: '出价时间', dataIndex: 'created_at', render: formatTs, width: 170 },
              { title: '出价人', render: (_, r) => auctionUser(r), width: 200 },
              { title: '金额', dataIndex: 'amount', render: amountText, width: 120 },
              { title: '状态', dataIndex: 'state', width: 100, render: (v) => <Tag color={auctionBidStateColor[v] || 'default'}>{statusText(auctionBidStateText, v)}</Tag> },
            ]}
          />
        </Card>
        {canCancelRow(detail) && <Button danger block onClick={() => { setCancelling(detail); setCancelReason(''); }}>取消这场竞拍并退回在押金额</Button>}
      </Space>}
    </Drawer>
  </Space>;
}


function todayDate() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function attendanceUser(row) {
  const name = String(row?.user_name_snapshot || '').trim();
  const userid = String(row?.userid || '').trim();
  if (name && userid && name !== userid) return `${name} (${userid})`;
  return name || userid || '-';
}

function attendanceNote(row) {
  const raw = row?.error_message || row?.skip_reason || row?.reward_reason || '';
  const key = String(raw || '').trim();
  if (attendanceReasonText[key]) return attendanceReasonText[key];
  if (row?.check_type === 'off_duty' && row?.status === 'skipped') return '下班打卡已按规则忽略';
  return key || '-';
}

function AttendanceRewards({ dingtalk, me }) {
  const { message, modal } = App.useApp();
  const canEdit = hasPermission(me, 'activities:edit');
  const [form] = Form.useForm();
  const [departments, setDepartments] = useState([]);
  const [mode, setMode] = useState('all');
  const [days, setDays] = useState(7);
  const [summaryRows, setSummaryRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  const loadSettings = async () => {
    const data = await api('/admin/settings/attendance-reward');
    form.setFieldsValue(data.data || {});
    setMode(data.data?.departmentMode || 'all');
    return data.data || {};
  };

  const loadDepartments = async (selectedSettings = null) => {
    if (!dingtalk?.connected) {
      setDepartments([]);
      return;
    }
    const data = await api('/admin/settings/dingtalk/departments');
    setDepartments(data.data || []);
    if (selectedSettings) form.setFieldValue('departmentIds', selectedSettings.departmentIds || []);
  };

  const loadStatus = async (nextDays = days) => {
    const data = await api(`/admin/settings/attendance-reward/status?days=${nextDays}`);
    setSummaryRows(data.data || []);
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      const settings = await loadSettings();
      await Promise.all([loadDepartments(settings), loadStatus(days)]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll().catch((e) => message.error(e.message)); }, [dingtalk?.connected]);

  const save = async (values) => {
    setSaving(true);
    try {
      const result = await api('/admin/settings/attendance-reward', { method: 'POST', body: { ...values, departmentMode: mode, departmentIds: mode === 'selected' ? values.departmentIds || [] : [] } });
      const saved = result.data || {};
      form.setFieldsValue(saved);
      setMode(saved.departmentMode || 'all');
      message.success('打卡奖励已保存');
      await loadStatus(days);
    } catch (err) {
      message.error(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };


  const resetSettings = () => modal.confirm({
    title: '恢复打卡奖励默认配置？',
    content: '会把打卡奖励配置恢复为系统默认值，历史记录不会删除。',
    okText: '确认恢复',
    cancelText: '取消',
    onOk: async () => {
      setSaving(true);
      try {
        await api('/admin/settings/attendance-reward', { method: 'POST', body: { reset: true } });
        message.success('打卡奖励配置已恢复默认');
        await loadAll();
      } finally {
        setSaving(false);
      }
    },
  });

  const changeDays = async (value) => {
    const next = Number(value || 7);
    setDays(next);
    await loadStatus(next).catch((e) => message.error(e.message));
  };

  const openDetail = async (date) => {
    const data = await api(`/admin/settings/attendance-reward/detail?date=${date}`);
    setDetail({ date: data.work_date || date, rows: data.rows || [] });
  };

  const reconcile = (date) => modal.confirm({
    title: '确认执行打卡对账？',
    content: '系统会根据当天打卡记录补发缺失的 BOB 币奖励。本次不发送钉钉消息。',
    okText: '确认对账',
    cancelText: '取消',
    onOk: async () => {
      setReconciling(true);
      try {
        await api('/admin/settings/attendance-reward/reconcile', { method: 'POST', body: { date, notify: false } });
        message.success('打卡对账已完成');
        await loadStatus(days);
        await openDetail(date);
      } finally {
        setReconciling(false);
      }
    },
  });

  const today = summaryRows.find((row) => row.work_date === todayDate()) || summaryRows[0] || null;
  const detailRows = detail?.rows || [];

  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    {!dingtalk?.connected && <Alert type="warning" showIcon message="钉钉未连接，部门选择和实时打卡奖励不可用。" />}
    <Card title="打卡奖励配置" extra={canEdit ? <Space><Button danger loading={saving} onClick={resetSettings}>恢复默认</Button><Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button></Space> : null} loading={loading}>
      <Form form={form} layout="vertical" onFinish={save} className="attendance-settings-form">
        <Row gutter={[16, 8]} align="middle">
          <Col xs={24} md={8} lg={6}><Form.Item name="enabled" label="启用打卡奖励" valuePropName="checked"><Switch disabled={!canEdit} /></Form.Item></Col>
          <Col xs={24} md={8} lg={6}><Form.Item name="testMode" label="测试模式" valuePropName="checked"><Switch disabled={!canEdit} /></Form.Item></Col>
          <Col xs={24} md={8} lg={6}><Form.Item name="onlyCheckin" label="仅上班打卡" valuePropName="checked"><Switch disabled={!canEdit} /></Form.Item></Col>
          <Col xs={24} md={8} lg={6}><Form.Item name="startDate" label="生效日期"><Input type="date" readOnly={!canEdit} /></Form.Item></Col>
        </Row>
        <Row gutter={[16, 8]}>
          <Col xs={24} sm={12} lg={6}><Form.Item name="workStartTime" label="上班时间"><Input placeholder="08:30" readOnly={!canEdit} /></Form.Item></Col>
          <Col xs={24} sm={12} lg={6}><Form.Item name="lateGraceMinutes" label="宽限分钟数"><InputNumber min={0} precision={0} disabled={!canEdit} style={{ width: '100%' }} /></Form.Item></Col>
          <Col xs={24} sm={12} lg={6}><Form.Item name="maxPerDay" label="每日上限"><InputNumber min={1} precision={0} disabled={!canEdit} style={{ width: '100%' }} /></Form.Item></Col>
          <Col xs={24} sm={12} lg={6}><Form.Item label="奖励范围"><Space.Compact style={{ width: '100%' }}><Form.Item name="rewardMin" noStyle><InputNumber min={1} precision={0} disabled={!canEdit} style={{ width: '50%' }} /></Form.Item><Form.Item name="rewardMax" noStyle><InputNumber min={1} precision={0} disabled={!canEdit} style={{ width: '50%' }} /></Form.Item></Space.Compact></Form.Item></Col>
        </Row>
        <Row gutter={[16, 8]}>
          <Col xs={24} md={8} lg={6}><Form.Item label="适用部门"><Select value={mode} onChange={setMode} disabled={!canEdit} options={[{ value: 'all', label: '全部部门' }, { value: 'selected', label: '指定部门' }]} /></Form.Item></Col>
          {mode === 'selected' && <Col xs={24} md={16} lg={10}><Form.Item name="departmentIds" label="部门多选"><Select mode="multiple" disabled={!canEdit || !dingtalk?.connected} placeholder={dingtalk?.connected ? '选择部门' : '请先完成钉钉连接'} options={departments.map((d) => ({ value: String(d.dept_id), label: `${'　'.repeat(Number(d.depth || 0))}${d.name}` }))} /></Form.Item></Col>}
          <Col xs={24} md={mode === 'selected' ? 24 : 16} lg={mode === 'selected' ? 8 : 12}><Form.Item name="reason" label="奖励理由"><Input placeholder="打卡奖励" readOnly={!canEdit} /></Form.Item></Col>
        </Row>
      </Form>
    </Card>

    <Card title="今日摘要" extra={<Button onClick={() => loadStatus(days)}>刷新</Button>}>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={5}><Statistic title="已奖励" value={Number(today?.rewarded_count || 0)} /></Col>
        <Col xs={12} md={5}><Statistic title="自动补发" value={Number(today?.auto_compensated_count || 0)} /></Col>
        <Col xs={12} md={5}><Statistic title="已跳过" value={Number(today?.skipped_count || 0)} /></Col>
        <Col xs={12} md={5}><Statistic title="异常" value={Number(today?.error_count || 0)} /></Col>
        <Col xs={24} md={4}><Statistic title="总发放" value={Number(today?.total_reward_amount || 0)} suffix="BOB" /></Col>
      </Row>
    </Card>

    <Card title="打卡奖励历史" extra={<Space><Select value={days} onChange={changeDays} style={{ width: 120 }} options={[{ value: 7, label: '近 7 天' }, { value: 14, label: '近 14 天' }]} /><Button onClick={() => loadStatus(days)}>刷新</Button></Space>}>
      <Table rowKey="work_date" dataSource={summaryRows} pagination={localTablePagination('天')} columns={[
        { title: '日期', dataIndex: 'work_date' },
        { title: '总记录', dataIndex: 'total_records' },
        { title: '已奖励', dataIndex: 'rewarded_count' },
        { title: '已跳过', dataIndex: 'skipped_count' },
        { title: '异常', dataIndex: 'error_count', render: (v) => Number(v) > 0 ? <Tag color="red">{v}</Tag> : 0 },
        { title: '自动补发', dataIndex: 'auto_compensated_count' },
        { title: '总发放', dataIndex: 'total_reward_amount', render: amountText },
        { title: '更新时间', dataIndex: 'updated_at', render: formatTs },
        { title: '操作', render: (_, row) => <Space><Button onClick={() => openDetail(row.work_date)}>详情</Button>{canEdit && <Button loading={reconciling} onClick={() => reconcile(row.work_date)}>对账补发</Button>}</Space> },
      ]} />
    </Card>

    <Drawer title="打卡奖励明细" open={Boolean(detail)} onClose={() => setDetail(null)} width={920} extra={detail && canEdit ? <Button loading={reconciling} onClick={() => reconcile(detail.date)}>对账补发</Button> : null}>
      {detail && <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Descriptions bordered size="small" column={2} items={[
          { key: 'date', label: '日期', children: detail.date },
          { key: 'count', label: '记录数', children: detailRows.length },
        ]} />
        <Table rowKey={(row) => `${row.userid}_${row.check_time_ms}`} size="small" dataSource={detailRows} pagination={localTablePagination('条记录')} scroll={{ x: 960 }} columns={[
          { title: '打卡时间', dataIndex: 'check_time_text', width: 160 },
          { title: '用户', render: (_, row) => attendanceUser(row), width: 220 },
          { title: '类型', dataIndex: 'check_type', width: 120, render: (v) => attendanceCheckTypeText[v] || v || '-' },
          { title: '来源', dataIndex: 'event_source', width: 130, render: (v) => attendanceSourceText[v] || v || '-' },
          { title: '状态', dataIndex: 'status', width: 110, render: (v) => <Tag color={v === 'rewarded' ? 'green' : v === 'test_passed' ? 'blue' : v === 'error' ? 'red' : 'default'}>{attendanceStatusText[v] || v || '-'}</Tag> },
          { title: '奖励', dataIndex: 'reward_amount', width: 110, render: (v, row) => row.status === 'rewarded' ? amountText(v) : '-' },
          { title: '说明', render: (_, row) => attendanceNote(row) },
        ]} />
      </Space>}
    </Drawer>
  </Space>;
}

function Charity({ me }) {
  const { message } = App.useApp();
  const canEdit = hasPermission(me, 'activities:edit');
  const [projects, setProjects] = useState([]);
  const [contribs, setContribs] = useState([]);
  const [contribSummary, setContribSummary] = useState({ total_bob_amount: 0, donor_count: 0, contribution_count: 0 });
  const [editing, setEditing] = useState(null);
  const [projectFilter, setProjectFilter] = useState('');
  const [form] = Form.useForm();
  const loadProjects = async () => setProjects((await api('/admin/charity/projects')).data || []);
  const loadContribs = async () => { const resp = await api(`/admin/charity/contributions?${qs({ limit: 200, project_id: projectFilter })}`); setContribs(resp.data || []); setContribSummary(resp.summary || { total_bob_amount: 0, donor_count: 0, contribution_count: 0 }); };
  useEffect(() => { loadProjects().catch((e) => message.error(e.message)); }, []);
  useEffect(() => { loadContribs().catch(() => null); }, [projectFilter]);
  const open = (row = {}) => { form.resetFields(); setEditing(row); form.setFieldsValue({ ...row, tier_options: Array.isArray(row.tier_options) ? row.tier_options.join(',') : '10,20,50,100' }); };
  const save = async (values) => { await api('/admin/charity/projects/save', { method: 'POST', body: values }); message.success('公益项目已保存'); setEditing(null); form.resetFields(); loadProjects(); loadContribs(); };
  return <Space direction="vertical" style={{ width: '100%' }}>
    <DataToolbar onRefresh={() => { loadProjects(); loadContribs(); }} onCreate={canEdit ? () => open({ project_id: `CHARITY_${Date.now().toString(36).toUpperCase()}`, status: 'active', execution_status: 'pending' }) : null} createText="新增公益项目" />
    <Table rowKey="project_id" dataSource={projects} pagination={localTablePagination('个项目')} scroll={{ x: 1180 }} columns={[{ title: '封面', dataIndex: 'cover_image_url', width: 86, render: (url) => url ? <Image src={url} width={44} height={44} style={{ objectFit: 'cover', borderRadius: 8 }} /> : '-' }, { title: '项目ID', dataIndex: 'project_id', ellipsis: true }, { title: '名称', dataIndex: 'project_name' }, { title: '目标BOB币', dataIndex: 'target_bob_amount', render: amountText }, { title: '已助力', dataIndex: 'total_bob_amount', render: amountText }, { title: '人数', dataIndex: 'donor_count' }, { title: '次数', dataIndex: 'contribution_count' }, { title: '达标', dataIndex: 'goal_reached', render: (v) => v ? <Tag color="green">已达标</Tag> : <Tag>未达标</Tag> }, { title: '排序', dataIndex: 'sort', render: (v) => v ?? '-' }, { title: '状态', dataIndex: 'status', render: (v) => statusText(charityStatusText, v) }, { title: '执行', dataIndex: 'execution_status', render: (v) => statusText(executionStatusText, v) }, { title: '操作', render: (_, r) => canEdit ? <Button onClick={() => open(r)}>编辑</Button> : '-' }]} />
    <Card size="small" title="助力记录" extra={<Select allowClear placeholder="项目筛选" style={{ width: 220 }} value={projectFilter || undefined} onChange={(v) => setProjectFilter(v || '')} options={projects.map((p) => ({ value: p.project_id, label: p.project_name }))} />}>
      <Row gutter={[16, 16]} style={{ marginBottom: 12 }}>
        <Col xs={8}><Statistic title="累计 BOB 币" value={Number(contribSummary.total_bob_amount || 0)} /></Col>
        <Col xs={8}><Statistic title="助力人数" value={Number(contribSummary.donor_count || 0)} /></Col>
        <Col xs={8}><Statistic title="助力次数" value={Number(contribSummary.contribution_count || 0)} /></Col>
      </Row>
      <Table rowKey="id" size="small" dataSource={contribs} pagination={localTablePagination('条记录')} columns={[{ title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '项目', dataIndex: 'project_name' }, { title: '用户', dataIndex: 'user_name_snapshot' }, { title: '金额', dataIndex: 'bob_amount', render: amountText }]} />
    </Card>
    <Drawer title={editing?.id ? "编辑公益项目" : "新增公益项目"} open={Boolean(editing)} onClose={() => { setEditing(null); form.resetFields(); }} width={680} extra={canEdit ? <Button type="primary" onClick={() => form.submit()}>保存</Button> : null}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="project_id" label="项目ID" rules={[{ required: true }]}><Input readOnly className="readonly-input" /></Form.Item>
        <Form.Item name="project_name" label="项目名称" rules={[{ required: true }]}><Input readOnly={!canEdit} /></Form.Item>
        <Form.Item name="cover_image_url" label="项目封面"><ProductImageEditor emptyText="未设置项目封面" disabled={!canEdit} /></Form.Item>
        <Form.Item name="summary" label="简介" rules={[{ required: true }]}><Suspense fallback={<Input.TextArea rows={4} disabled placeholder="编辑器加载中..." />}><RichTextEditor minHeight={150} disabled={!canEdit} /></Suspense></Form.Item>
        <Form.Item name="rules_text" label="规则" rules={[{ required: true }]}><Suspense fallback={<Input.TextArea rows={5} disabled placeholder="编辑器加载中..." />}><RichTextEditor minHeight={180} disabled={!canEdit} /></Suspense></Form.Item>
        <Form.Item name="target_bob_amount" label="目标BOB币" rules={[{ required: true }]}><InputNumber min={1} disabled={!canEdit} style={{ width: '100%' }} /></Form.Item>
        <Form.Item name="tier_options" label="助力档位"><Input placeholder="10,20,50,100" readOnly={!canEdit} /></Form.Item>
        <Form.Item name="sort" label="排序"><InputNumber min={0} precision={0} disabled={!canEdit} style={{ width: '100%' }} /></Form.Item>
        <Form.Item name="status" label="状态"><Select disabled={!canEdit} options={[{ value: 'active', label: '启用' }, { value: 'paused', label: '暂停' }, { value: 'archived', label: '归档' }]} /></Form.Item>
        <Form.Item name="execution_status" label="执行状态"><Select disabled={!canEdit} options={[{ value: 'pending', label: '待执行' }, { value: 'in_progress', label: '执行中' }, { value: 'completed', label: '已完成' }]} /></Form.Item>
        <Form.Item name="execution_note" label="执行说明"><Suspense fallback={<Input.TextArea rows={3} disabled placeholder="编辑器加载中..." />}><RichTextEditor minHeight={130} disabled={!canEdit} /></Suspense></Form.Item>
      </Form>
    </Drawer>
  </Space>;
}

export default function Activities(props) {
  return <Card><Tabs items={[{ key: 'red', label: '红包活动', children: <RedPackets {...props} /> }, { key: 'auction', label: '限时竞拍', children: <Auctions {...props} /> }, { key: 'attendance', label: '打卡奖励', children: <AttendanceRewards {...props} /> }, { key: 'charity', label: '公益助力', children: <Charity {...props} /> }]} /></Card>;
}
