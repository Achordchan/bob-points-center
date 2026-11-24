import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { api } from '../../api.js';
import { amountText } from '../../utils.js';
import { galaErrorText } from './errors.js';

const MAX_DRAW_COUNT = 100;
const MAX_TITLE_LENGTH = 80;

export default function DrawModal({
  open,
  onCancel,
  eventId,
  detail,
  drawGalaVersion,
  segments = [],
  nextRoundNos,
  getNextRoundNo,
  onRoundNoChanged,
  onSuccess,
  onRefreshAll,
  onRefreshRounds,
  handleError,
}) {
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [roundNoNotice, setRoundNoNotice] = useState('');

  const selectedSegment = Form.useWatch('segment', form);
  const prizeType = Form.useWatch('prize_type', form);
  const drawCount = Form.useWatch('draw_count', form);
  const amountEach = Form.useWatch('amount_each', form);
  const selectedPoolId = Form.useWatch('pool_id', form);

  const enabledSegmentSet = useMemo(
    () => new Set(Array.isArray(detail?.enabled_segments) ? detail.enabled_segments : []),
    [detail?.enabled_segments],
  );

  // 只列 detail.enabled_segments 中且 GET /admin/gala/segments 返回 drawable=true 的环节
  const drawableSegments = useMemo(
    () => segments.filter((item) => item?.drawable === true && enabledSegmentSet.has(item.key)),
    [segments, enabledSegmentSet],
  );

  // 发币只列公开奖池（is_reserved === 0），绝不展示预留奖池
  const publicPools = useMemo(
    () => (Array.isArray(detail?.pools) ? detail.pools : []).filter((pool) => Number(pool?.is_reserved) === 0),
    [detail?.pools],
  );

  const hasNextRoundNos = Boolean(
    nextRoundNos && typeof nextRoundNos === 'object' && !Array.isArray(nextRoundNos),
  );

  const nextRoundNo = hasNextRoundNos && selectedSegment ? getNextRoundNo(selectedSegment) : null;

  const selectedPool = useMemo(
    () => publicPools.find((pool) => Number(pool.id) === Number(selectedPoolId)) || null,
    [publicPools, selectedPoolId],
  );

  const estimatedTotal = useMemo(() => {
    if (prizeType !== 'coin') return null;
    const c = Number(drawCount);
    const a = Number(amountEach);
    if (!Number.isSafeInteger(c) || c <= 0 || !Number.isSafeInteger(a) || a <= 0) return null;
    const total = c * a;
    return Number.isSafeInteger(total) ? total : null;
  }, [prizeType, drawCount, amountEach]);

  useEffect(() => {
    if (!open) return;
    setRoundNoNotice('');
    form.resetFields();
    form.setFieldsValue({
      segment: drawableSegments[0]?.key,
      title: '',
      draw_count: 1,
      prize_type: 'none',
      pool_id: undefined,
      amount_each: undefined,
      exclude_previous_winners: true,
    });
  }, [open, form]); // 仅在打开时初始化表单，刷新数据后不清空用户输入

  useEffect(() => {
    if (!open) return;
    const current = form.getFieldValue('segment');
    if (!current && drawableSegments.length > 0) {
      form.setFieldValue('segment', drawableSegments[0].key);
    }
  }, [open, drawableSegments, form]);

  const handleFinish = (values) => {
    const segment = values.segment;
    const segmentObj = drawableSegments.find((item) => item.key === segment);
    const segmentLabel = segmentObj?.label || segment;
    const roundNo = hasNextRoundNos ? getNextRoundNo(segment) : null;
    if (!Number.isSafeInteger(roundNo) || roundNo < 1) {
      message.error('尚未获取到最新轮次号，请关闭弹窗后重试');
      return;
    }
    const title = String(values.title || '').trim();
    const count = Number(values.draw_count);
    const isCoin = values.prize_type === 'coin';
    const excludePrevious = Boolean(values.exclude_previous_winners);

    let poolId = null;
    let poolName = '';
    let each = 0;
    let total = 0;

    if (isCoin) {
      poolId = Number(values.pool_id);
      const pool = publicPools.find((p) => Number(p.id) === poolId);
      poolName = pool?.name || `奖池 #${poolId}`;
      each = Number(values.amount_each);
      total = count * each;
      if (!Number.isSafeInteger(total)) {
        message.error('本轮发币总金额超出安全上限');
        return;
      }
    }

    const confirmItems = [
      { key: 'segment', label: '环节', children: segmentLabel },
      { key: 'round_no', label: '轮次', children: `第 ${roundNo} 轮` },
    ];
    if (title) {
      confirmItems.push({ key: 'title', label: '标题', children: title });
    }
    confirmItems.push(
      { key: 'draw_count', label: '抽取人数', children: `${count} 人` },
      { key: 'prize_type', label: '奖品类型', children: isCoin ? '发币' : '无币' },
    );
    if (isCoin) {
      confirmItems.push(
        { key: 'pool', label: '扣除奖池', children: poolName },
        { key: 'amount_each', label: '每人金额', children: amountText(each) },
        { key: 'total', label: '本轮总额', children: amountText(total) },
      );
    }
    confirmItems.push({
      key: 'exclude',
      label: '排除已中奖者',
      children: excludePrevious ? '是' : '否',
    });

    const version = typeof drawGalaVersion === 'string' ? drawGalaVersion : '';

    modal.confirm({
      title: '确认发起抽签',
      width: 480,
      okText: '确认抽签',
      cancelText: '取消',
      content: (
        <Descriptions
          bordered
          size="small"
          column={1}
          style={{ marginTop: 12 }}
          items={confirmItems}
        />
      ),
      onOk: async () => {
        setSubmitting(true);
        try {
          const payload = {
            event_id: eventId,
            segment,
            title,
            draw_count: count,
            prize_type: values.prize_type,
            exclude_previous_winners: excludePrevious,
            round_no: roundNo,
            gala_version: version,
          };
          if (isCoin) {
            payload.pool_id = poolId;
            payload.amount_each = each;
          }

          const resp = await api('/admin/gala/rounds/draw', {
            method: 'POST',
            body: payload,
          });
          setRoundNoNotice('');
          await onSuccess(resp?.data || null);
        } catch (err) {
          if (err?.code === 'round_no_changed') {
            const nextNo = Number(err?.data?.next_round_no);
            if (Number.isSafeInteger(nextNo) && nextNo > 0) {
              onRoundNoChanged(segment, nextNo);
            }
            const notice = `${galaErrorText(err)}，已刷新列表，请重新确认后再提交`;
            setRoundNoNotice(notice);
            message.warning(notice);
            await onRefreshAll();
            return;
          }
          const versionChanged = handleError(err);
          if (versionChanged) {
            await onRefreshRounds();
            onCancel();
          }
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  return (
    <Modal
      title="发起抽签"
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText="下一步"
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: drawableSegments.length === 0 || !hasNextRoundNos }}
      width={560}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {drawableSegments.length === 0 && (
          <Alert
            type="warning"
            showIcon
            message="当前活动没有启用支持抽签的环节，请先在活动设置中启用可抽签环节。"
          />
        )}

        {roundNoNotice && (
          <Alert
            type="warning"
            showIcon
            closable
            onClose={() => setRoundNoNotice('')}
            message={roundNoNotice}
          />
        )}

        <Form form={form} layout="vertical" onFinish={handleFinish}>
          <Form.Item
            name="segment"
            label="环节"
            extra={
              !hasNextRoundNos
                ? '尚未获取到轮次信息，请关闭后重新发起抽签'
                : nextRoundNo !== null
                  ? `本环节下一轮次号：第 ${nextRoundNo} 轮`
                  : '仅显示已启用且支持抽签的环节'
            }
            rules={[{ required: true, message: '请选择抽签环节' }]}
          >
            <Select
              placeholder="请选择抽签环节"
              onChange={() => setRoundNoNotice('')}
              options={drawableSegments.map((item) => ({
                value: item.key,
                label: item.label,
              }))}
            />
          </Form.Item>

          <Form.Item
            name="title"
            label="轮次标题（选填）"
            rules={[{ max: MAX_TITLE_LENGTH, message: `标题最多 ${MAX_TITLE_LENGTH} 字` }]}
          >
            <Input placeholder="例如：一等奖 / 幸运观众" maxLength={MAX_TITLE_LENGTH} />
          </Form.Item>

          <Form.Item
            name="draw_count"
            label="抽取人数"
            extra={`填写 1 到 ${MAX_DRAW_COUNT} 之间的正整数`}
            rules={[
              { required: true, message: '请输入抽取人数' },
              {
                validator: (_, value) => {
                  if (value === undefined || value === null || value === '') return Promise.resolve();
                  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_DRAW_COUNT) {
                    return Promise.reject(new Error(`抽取人数必须为 1 到 ${MAX_DRAW_COUNT} 之间的正整数`));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <InputNumber
              min={1}
              max={MAX_DRAW_COUNT}
              step={1}
              precision={0}
              style={{ width: '100%' }}
              placeholder="请输入正整数"
            />
          </Form.Item>

          <Form.Item
            name="prize_type"
            label="奖品类型"
            rules={[{ required: true, message: '请选择奖品类型' }]}
          >
            <Radio.Group>
              <Radio value="none">无币</Radio>
              <Radio value="coin">发币</Radio>
            </Radio.Group>
          </Form.Item>

          {prizeType === 'coin' && (
            <>
              <Form.Item
                name="pool_id"
                label="选择奖池"
                extra={
                  publicPools.length === 0
                    ? '当前活动暂无可用奖池，请先在“奖池”页创建'
                    : undefined
                }
                rules={[{ required: true, message: '请选择奖池' }]}
              >
                <Select
                  placeholder="请选择奖池"
                  options={publicPools.map((pool) => ({
                    value: pool.id,
                    label: `${pool.name}（剩余 ${amountText(pool.remaining)}）`,
                  }))}
                />
              </Form.Item>

              <Form.Item
                name="amount_each"
                label="每人金额（BOB 币）"
                extra={
                  estimatedTotal !== null ? (
                    <Typography.Text
                      type={
                        selectedPool && estimatedTotal > Number(selectedPool.remaining || 0)
                          ? 'danger'
                          : 'secondary'
                      }
                    >
                      本轮预计总额：{amountText(estimatedTotal)}
                      {selectedPool && estimatedTotal > Number(selectedPool.remaining || 0)
                        ? `（超出所选奖池剩余 ${amountText(selectedPool.remaining)}）`
                        : ''}
                    </Typography.Text>
                  ) : (
                    '填写正整数 BOB 币'
                  )
                }
                rules={[
                  { required: true, message: '请输入每人金额' },
                  {
                    validator: (_, value) => {
                      if (value === undefined || value === null || value === '') return Promise.resolve();
                      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
                        return Promise.reject(new Error('每人金额必须为正整数'));
                      }
                      return Promise.resolve();
                    },
                  },
                ]}
              >
                <InputNumber
                  min={1}
                  step={1}
                  precision={0}
                  style={{ width: '100%' }}
                  placeholder="请输入整数金额"
                />
              </Form.Item>
            </>
          )}

          <Form.Item
            name="exclude_previous_winners"
            label="排除本环节已中奖者"
            valuePropName="checked"
          >
            <Switch checkedChildren="是" unCheckedChildren="否" />
          </Form.Item>
        </Form>
      </Space>
    </Modal>
  );
}
