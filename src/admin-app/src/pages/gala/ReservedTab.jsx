import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { api, qs } from '../../api.js';
import { amountText, formatTs, localTablePagination } from '../../utils.js';

const PAGE_SIZE = 100;
const MAX_RESERVED_SLOTS = 3;
const PG_INT_MAX = 2147483647;
const MAX_NOTE_LENGTH = 200;

const SLOT_STATUS_META = {
  pending: { label: '待用', color: 'blue' },
  used: { label: '已用', color: 'green' },
  cancelled: { label: '已取消', color: 'default' },
};

function normalizeNextRoundNos(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function resolveNextRoundNo(nextRoundNos, segmentKey) {
  if (!segmentKey || !nextRoundNos) return 1;
  const raw = Number(nextRoundNos[segmentKey]);
  return Number.isSafeInteger(raw) && raw >= 1 ? raw : 1;
}

export default function ReservedTab({
  eventId,
  detail,
  galaVersion,
  segments = [],
  me,
  loading: detailLoading,
  reload,
  handleError,
}) {
  const { message } = AntApp.useApp();
  const [poolForm] = Form.useForm();
  const [slotForm] = Form.useForm();

  const isSuperAdmin = me?.isSuperAdmin === true;

  const [poolEditing, setPoolEditing] = useState(null);
  const [poolSubmitting, setPoolSubmitting] = useState(false);

  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cancellingSlotId, setCancellingSlotId] = useState(null);

  const [slotModal, setSlotModal] = useState(null);
  const [openingSlotModal, setOpeningSlotModal] = useState(false);
  const [slotSubmitting, setSlotSubmitting] = useState(false);
  const [nextRoundNos, setNextRoundNos] = useState(() => normalizeNextRoundNos(detail?.next_round_nos));

  const selectedSlotSegment = Form.useWatch('segment', slotForm);

  const requestSeqRef = useRef(0);
  const nextRoundNosRef = useRef(nextRoundNos);
  nextRoundNosRef.current = nextRoundNos;
  const roundNoManualRef = useRef(false);

  const reservedPools = useMemo(
    () => (Array.isArray(detail?.pools) ? detail.pools : []).filter((pool) => Number(pool?.is_reserved) === 1),
    [detail?.pools],
  );

  const reservedPoolMap = useMemo(
    () => new Map(reservedPools.map((pool) => [Number(pool.id), pool])),
    [reservedPools],
  );

  const poolsSummary = useMemo(
    () =>
      reservedPools.reduce(
        (acc, pool) => {
          acc.budget += Number(pool?.budget || 0);
          acc.spent += Number(pool?.spent || 0);
          acc.remaining += Number(pool?.remaining || 0);
          return acc;
        },
        { budget: 0, spent: 0, remaining: 0 },
      ),
    [reservedPools],
  );

  const segmentLabelMap = useMemo(
    () => new Map(segments.map((item) => [item.key, item.label])),
    [segments],
  );

  const enabledSegmentSet = useMemo(
    () => new Set(Array.isArray(detail?.enabled_segments) ? detail.enabled_segments : []),
    [detail?.enabled_segments],
  );

  const drawableSegments = useMemo(
    () => segments.filter((item) => item?.drawable === true && enabledSegmentSet.has(item.key)),
    [segments, enabledSegmentSet],
  );

  const drawableSegmentsRef = useRef(drawableSegments);
  drawableSegmentsRef.current = drawableSegments;

  const reservedPoolsRef = useRef(reservedPools);
  reservedPoolsRef.current = reservedPools;

  const activeSlotCount = useMemo(
    () => slots.filter((slot) => slot?.status !== 'cancelled').length,
    [slots],
  );
  const atSlotLimit = activeSlotCount >= MAX_RESERVED_SLOTS;

  const loadSlots = useCallback(async () => {
    if (!isSuperAdmin || !eventId) return;
    const seq = ++requestSeqRef.current;
    setSlotsLoading(true);
    setLoadingMore(false);
    try {
      const resp = await api(`/admin/gala/reserved?${qs({ event_id: eventId, limit: PAGE_SIZE })}`);
      if (seq !== requestSeqRef.current) return;
      const list = Array.isArray(resp?.data) ? resp.data : [];
      setSlots(list);
      setHasMore(list.length >= PAGE_SIZE);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      handleError(err);
    } finally {
      if (seq === requestSeqRef.current) setSlotsLoading(false);
    }
  }, [isSuperAdmin, eventId, handleError]);

  const loadMoreSlots = async () => {
    if (!isSuperAdmin || slotsLoading || loadingMore || !hasMore || slots.length === 0) return;
    const lastId = slots[slots.length - 1]?.id;
    if (!lastId) return;
    const seq = requestSeqRef.current;
    setLoadingMore(true);
    try {
      const resp = await api(
        `/admin/gala/reserved?${qs({ event_id: eventId, before_id: lastId, limit: PAGE_SIZE })}`,
      );
      if (seq !== requestSeqRef.current) return;
      const list = Array.isArray(resp?.data) ? resp.data : [];
      setSlots((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const appended = list.filter((item) => !seen.has(item.id));
        return [...prev, ...appended];
      });
      setHasMore(list.length >= PAGE_SIZE);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      const versionChanged = handleError(err);
      if (versionChanged) loadSlots();
    } finally {
      if (seq === requestSeqRef.current) setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!isSuperAdmin) return;
    setSlots([]);
    setHasMore(false);
    loadSlots();
  }, [isSuperAdmin, eventId, galaVersion, loadSlots]);

  const poolModalOpen = Boolean(poolEditing);
  const editingPool = poolEditing?.pool || null;
  const isEditPool = Boolean(editingPool?.id);
  const slotModalOpen = Boolean(slotModal);

  useEffect(() => {
    if (!poolEditing) return;
    poolForm.resetFields();
    if (poolEditing.pool?.id) {
      poolForm.setFieldsValue({
        name: poolEditing.pool.name || '',
        sponsor: poolEditing.pool.sponsor || '',
        budget: Number.isSafeInteger(Number(poolEditing.pool.budget)) ? Number(poolEditing.pool.budget) : 0,
      });
    } else {
      poolForm.setFieldsValue({
        name: '',
        sponsor: '',
        budget: 0,
      });
    }
  }, [poolEditing, poolForm]);

  useEffect(() => {
    const normalized = normalizeNextRoundNos(detail?.next_round_nos);
    nextRoundNosRef.current = normalized;
    setNextRoundNos(normalized);
  }, [detail]);

  useEffect(() => {
    if (!slotModalOpen) return;
    roundNoManualRef.current = false;
    const defaultSegment = drawableSegmentsRef.current[0]?.key;
    const defaultRoundNo = resolveNextRoundNo(nextRoundNosRef.current, defaultSegment);
    slotForm.resetFields();
    slotForm.setFieldsValue({
      segment: defaultSegment,
      round_no: defaultRoundNo > PG_INT_MAX ? undefined : defaultRoundNo,
      userid: '',
      pool_id: reservedPoolsRef.current[0]?.id,
      note: '',
    });
  }, [slotModalOpen, slotForm]);

  const openCreatePool = () => {
    setPoolEditing({
      pool: null,
      version: typeof galaVersion === 'string' ? galaVersion : '',
    });
  };

  const openEditPool = (pool) => {
    setPoolEditing({
      pool,
      version: typeof galaVersion === 'string' ? galaVersion : '',
    });
  };

  const closePoolModal = () => {
    setPoolEditing(null);
  };

  const handlePoolSubmit = async (values) => {
    if (!poolEditing) return;
    const targetPool = poolEditing.pool;
    const version = poolEditing.version;
    setPoolSubmitting(true);
    try {
      const name = String(values.name || '').trim();
      const sponsor = String(values.sponsor || '').trim();
      const budget = Number(values.budget);

      if (targetPool?.id) {
        await api('/admin/gala/reserved/pools/update', {
          method: 'POST',
          body: {
            id: targetPool.id,
            name,
            sponsor,
            budget,
            gala_version: version,
          },
        });
        message.success('预留奖池已更新');
      } else {
        await api('/admin/gala/reserved/pools/create', {
          method: 'POST',
          body: {
            event_id: eventId,
            name,
            sponsor,
            budget,
            gala_version: version,
          },
        });
        message.success('预留奖池已创建');
      }
      closePoolModal();
      await Promise.all([loadSlots(), reload()]);
    } catch (err) {
      const versionChanged = handleError(err);
      if (versionChanged) {
        closePoolModal();
        loadSlots();
      }
    } finally {
      setPoolSubmitting(false);
    }
  };

  const openCreateSlot = async () => {
    if (openingSlotModal) return;
    setOpeningSlotModal(true);
    try {
      const latestDetail = await reload();
      if (!latestDetail) return;
      const normalized = normalizeNextRoundNos(latestDetail.next_round_nos);
      nextRoundNosRef.current = normalized;
      setNextRoundNos(normalized);
      setSlotModal({
        version: typeof latestDetail.gala_version === 'string' ? latestDetail.gala_version : '',
      });
    } finally {
      setOpeningSlotModal(false);
    }
  };

  const closeSlotModal = () => {
    setSlotModal(null);
  };

  const handleSlotFormValuesChange = (changedValues) => {
    if (Object.hasOwn(changedValues, 'round_no')) {
      roundNoManualRef.current = true;
    }
    if (Object.hasOwn(changedValues, 'segment') && !roundNoManualRef.current) {
      const nextNo = resolveNextRoundNo(nextRoundNosRef.current, changedValues.segment);
      slotForm.setFieldValue('round_no', nextNo > PG_INT_MAX ? undefined : nextNo);
    }
  };

  const handleSlotSubmit = async (values) => {
    if (!slotModal) return;
    if (resolveNextRoundNo(nextRoundNosRef.current, values.segment) > PG_INT_MAX) {
      message.error('该环节轮次号已用尽');
      return;
    }
    const version = slotModal.version;
    setSlotSubmitting(true);
    try {
      await api('/admin/gala/reserved/create', {
        method: 'POST',
        body: {
          event_id: eventId,
          segment: values.segment,
          round_no: Number(values.round_no),
          userid: String(values.userid ?? ''),
          pool_id: Number(values.pool_id),
          note: String(values.note || '').trim(),
          gala_version: version,
        },
      });
      message.success('预留名额已创建');
      closeSlotModal();
      await Promise.all([loadSlots(), reload()]);
    } catch (err) {
      const versionChanged = handleError(err);
      if (versionChanged) {
        closeSlotModal();
        loadSlots();
      }
    } finally {
      setSlotSubmitting(false);
    }
  };

  const handleCancelSlot = async (record) => {
    setCancellingSlotId(record.id);
    try {
      await api('/admin/gala/reserved/cancel', {
        method: 'POST',
        body: {
          id: record.id,
          gala_version: typeof record?.gala_version === 'string' ? record.gala_version : '',
        },
      });
      message.success('预留名额已取消');
      await Promise.all([loadSlots(), reload()]);
    } catch (err) {
      const versionChanged = handleError(err);
      if (versionChanged) loadSlots();
    } finally {
      setCancellingSlotId(null);
    }
  };

  const slotDefaultRoundNo = selectedSlotSegment
    ? resolveNextRoundNo(nextRoundNos, selectedSlotSegment)
    : null;
  const slotRoundNoExhausted = slotDefaultRoundNo !== null && slotDefaultRoundNo > PG_INT_MAX;

  if (!isSuperAdmin) return null;

  const poolColumns = [
    {
      title: '名称',
      dataIndex: 'name',
      ellipsis: true,
    },
    {
      title: '赞助方',
      dataIndex: 'sponsor',
      ellipsis: true,
      render: (value) => value || '-',
    },
    {
      title: '预算',
      dataIndex: 'budget',
      width: 140,
      render: amountText,
    },
    {
      title: '已发',
      dataIndex: 'spent',
      width: 140,
      render: amountText,
    },
    {
      title: '剩余',
      dataIndex: 'remaining',
      width: 140,
      render: amountText,
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 90,
      render: (_, record) => (
        <Button size="small" onClick={() => openEditPool(record)}>
          编辑
        </Button>
      ),
    },
  ];

  const slotColumns = [
    {
      title: '环节',
      dataIndex: 'segment',
      width: 120,
      render: (value) => segmentLabelMap.get(value) || value || '-',
    },
    {
      title: '轮次号',
      dataIndex: 'round_no',
      width: 96,
      render: (value) => (value ? `第 ${value} 轮` : '-'),
    },
    {
      title: 'userid / 姓名',
      key: 'user',
      width: 210,
      render: (_, record) => (
        <div>
          <div>{record.name || record.userid || '-'}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.userid || '-'}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: '预留奖池',
      dataIndex: 'pool_id',
      width: 150,
      ellipsis: true,
      render: (value) => {
        if (!value) return '-';
        return reservedPoolMap.get(Number(value))?.name || `奖池 #${value}`;
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      render: (value) => {
        const meta = SLOT_STATUS_META[value] || { label: value || '-', color: 'default' };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '备注',
      dataIndex: 'note',
      width: 220,
      render: (value) => value || '-',
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 170,
      render: formatTs,
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 90,
      render: (_, record) => {
        if (record.status !== 'pending') return null;
        return (
          <Popconfirm
            title="确认取消该预留名额？"
            description={`取消后，${record.name || record.userid}（${record.userid}）将恢复参与正常抽签`}
            okText="确认取消"
            cancelText="返回"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleCancelSlot(record)}
          >
            <Button size="small" danger loading={cancellingSlotId === record.id}>
              取消
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Space wrap align="center">
            <Typography.Title level={5} style={{ margin: 0 }}>
              预留奖池
            </Typography.Title>
            <Typography.Text type="secondary">
              共 {reservedPools.length} 个，预算合计 {amountText(poolsSummary.budget)}，已发{' '}
              {amountText(poolsSummary.spent)}，剩余 {amountText(poolsSummary.remaining)}
            </Typography.Text>
          </Space>
          <Button type="primary" onClick={openCreatePool}>
            新建预留奖池
          </Button>
        </div>

        <Table
          rowKey="id"
          loading={detailLoading}
          dataSource={reservedPools}
          columns={poolColumns}
          pagination={localTablePagination('个预留奖池')}
          scroll={{ x: 680 }}
          locale={{ emptyText: '暂无预留奖池' }}
        />
      </Space>

      <Divider style={{ margin: '4px 0' }} />

      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Space wrap align="center">
            <Typography.Title level={5} style={{ margin: 0 }}>
              预留名额
            </Typography.Title>
            <Typography.Text type="secondary">
              已占名额 {activeSlotCount} / {MAX_RESERVED_SLOTS}（待用与已用合计上限 {MAX_RESERVED_SLOTS} 个）
            </Typography.Text>
            {atSlotLimit && <Tag color="orange">已达上限</Tag>}
          </Space>
          <Space>
            <Button onClick={loadSlots} loading={slotsLoading}>
              刷新名额
            </Button>
            <Button
              type="primary"
              onClick={openCreateSlot}
              loading={openingSlotModal}
              disabled={atSlotLimit || openingSlotModal}
            >
              新建预留名额
            </Button>
          </Space>
        </div>

        <Table
          rowKey="id"
          loading={slotsLoading}
          dataSource={slots}
          columns={slotColumns}
          pagination={false}
          scroll={{ x: 1150 }}
          locale={{ emptyText: '暂无预留名额' }}
        />

        {(slots.length > 0 || hasMore) && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <Typography.Text type="secondary">已加载 {slots.length} 条记录</Typography.Text>
            {hasMore ? (
              <Button onClick={loadMoreSlots} loading={loadingMore}>
                加载更多
              </Button>
            ) : (
              <Typography.Text type="secondary">已显示全部预留名额</Typography.Text>
            )}
          </div>
        )}
      </Space>

      <Modal
        title={isEditPool ? `编辑预留奖池 #${editingPool.id}` : '新建预留奖池'}
        open={poolModalOpen}
        onCancel={closePoolModal}
        onOk={() => poolForm.submit()}
        okText={isEditPool ? '保存' : '创建'}
        cancelText="取消"
        confirmLoading={poolSubmitting}
        width={520}
        destroyOnHidden
      >
        <Form form={poolForm} layout="vertical" onFinish={handlePoolSubmit}>
          <Form.Item
            name="name"
            label="奖池名称"
            rules={[
              { required: true, whitespace: true, message: '请填写奖池名称' },
              { max: 40, message: '奖池名称最多 40 字' },
            ]}
          >
            <Input placeholder="例如：专项预留奖池" maxLength={40} />
          </Form.Item>

          <Form.Item
            name="sponsor"
            label="赞助方"
            rules={[{ max: 40, message: '赞助方最多 40 字' }]}
          >
            <Input placeholder="选填，例如：管理层赞助" maxLength={40} />
          </Form.Item>

          <Form.Item
            name="budget"
            label="预算（BOB 币）"
            extra={
              isEditPool
                ? `填写非负整数 BOB 币，不能低于已发金额（${amountText(editingPool.spent)}）与待发预留奖励之和`
                : '填写非负整数 BOB 币，允许为 0'
            }
            rules={[
              { required: true, message: '请输入奖池预算' },
              {
                validator: (_, value) => {
                  if (value === undefined || value === null || value === '') return Promise.resolve();
                  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
                    return Promise.reject(new Error('奖池预算必须为非负整数'));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <InputNumber min={0} step={1} precision={0} style={{ width: '100%' }} placeholder="请输入整数金额" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="新建预留名额"
        open={slotModalOpen}
        onCancel={closeSlotModal}
        onOk={() => slotForm.submit()}
        okText="创建"
        cancelText="取消"
        confirmLoading={slotSubmitting}
        okButtonProps={{
          disabled:
            drawableSegments.length === 0
            || reservedPools.length === 0
            || atSlotLimit
            || slotRoundNoExhausted,
        }}
        width={540}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {drawableSegments.length === 0 && (
            <Alert
              type="warning"
              showIcon
              message="当前活动没有已启用的可抽签环节，请先在概览中启用可抽签环节。"
            />
          )}
          {reservedPools.length === 0 && (
            <Alert
              type="warning"
              showIcon
              message="当前活动暂无预留奖池，请先在上方新建预留奖池。"
            />
          )}

          <Form
            form={slotForm}
            layout="vertical"
            onFinish={handleSlotSubmit}
            onValuesChange={handleSlotFormValuesChange}
          >
            <Form.Item
              name="segment"
              label="环节"
              rules={[{ required: true, message: '请选择环节' }]}
            >
              <Select
                placeholder="请选择已启用的可抽签环节"
                options={drawableSegments.map((item) => ({
                  value: item.key,
                  label: item.label,
                }))}
              />
            </Form.Item>

            <Form.Item
              name="round_no"
              label="轮次号"
              validateStatus={slotRoundNoExhausted ? 'error' : undefined}
              extra={
                slotRoundNoExhausted ? (
                  <Typography.Text type="danger">该环节轮次号已用尽</Typography.Text>
                ) : (
                  '填写正整数，须大于该环节当前已抽的最大轮次号'
                )
              }
              rules={[
                { required: true, message: '请输入轮次号' },
                {
                  validator: (_, value) => {
                    if (value === undefined || value === null || value === '') return Promise.resolve();
                    if (
                      typeof value !== 'number'
                      || !Number.isSafeInteger(value)
                      || value < 1
                      || value > PG_INT_MAX
                    ) {
                      return Promise.reject(new Error('轮次号必须为正整数'));
                    }
                    return Promise.resolve();
                  },
                },
              ]}
            >
              <InputNumber
                min={1}
                max={PG_INT_MAX}
                step={1}
                precision={0}
                disabled={slotRoundNoExhausted}
                style={{ width: '100%' }}
                placeholder="请输入正整数，例如：1"
              />
            </Form.Item>

            <Form.Item
              name="userid"
              label="用户 ID（userid）"
              extra="该用户须已加入本场活动参与名单，且本环节未中过奖、无未取消的预留名额"
              rules={[
                { required: true, whitespace: true, message: '请填写用户 ID' },
              ]}
            >
              <Input placeholder="请输入参与人的 userid" />
            </Form.Item>

            <Form.Item
              name="pool_id"
              label="预留奖池"
              extra="发币轮次中奖时按本轮单价从此预留奖池扣款"
              rules={[{ required: true, message: '请选择预留奖池' }]}
            >
              <Select
                placeholder="请选择预留奖池"
                options={reservedPools.map((pool) => ({
                  value: pool.id,
                  label: `${pool.name}（剩余 ${amountText(pool.remaining)}）`,
                }))}
              />
            </Form.Item>

            <Form.Item
              name="note"
              label="备注（选填）"
              rules={[{ max: MAX_NOTE_LENGTH, message: `备注最多 ${MAX_NOTE_LENGTH} 字` }]}
            >
              <Input.TextArea
                rows={2}
                maxLength={MAX_NOTE_LENGTH}
                showCount
                placeholder="选填，例如：管理层专项预留"
              />
            </Form.Item>
          </Form>
        </Space>
      </Modal>
    </Space>
  );
}
