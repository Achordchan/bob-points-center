import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Card, Select, Space, Tag, Typography } from 'antd';
import { api, qs } from '../../api.js';
import { hasPermission } from '../../permissions.js';
import { galaErrorText } from './errors.js';

const POLL_INTERVAL_MS = 10000;

const MODE_SUCCESS_TEXT = {
  idle: '大屏已切换为待机',
  rolling: '大屏已开始滚动',
  reveal: '大屏已切换为揭晓所选轮次',
  winners: '大屏已切换为中奖榜',
};

function formatRoundOptionLabel(round, segmentLabelMap) {
  const segLabel = round?.segment_label || segmentLabelMap.get(round?.segment) || round?.segment || '';
  const roundNo = round?.round_no ?? '-';
  const base = segLabel ? `${segLabel} 第 ${roundNo} 轮` : `第 ${roundNo} 轮`;
  const title = typeof round?.title === 'string' ? round.title.trim() : '';
  return title ? `${base} · ${title}` : base;
}

export default function ScreenControlCard({ eventId, galaVersion, me, segments = [], rounds = [], onError }) {
  const { message } = AntApp.useApp();
  const canView = hasPermission(me, 'gala:view');
  const canOperate = hasPermission(me, 'gala:operate');

  const [screenState, setScreenState] = useState(null);
  const [selectedSegment, setSelectedSegment] = useState(undefined);
  const [selectedRoundId, setSelectedRoundId] = useState(undefined);
  const [submittingMode, setSubmittingMode] = useState(null);

  const mountedRef = useRef(true);
  const currentEventIdRef = useRef(eventId);
  const requestSeqRef = useRef(0);
  const submittingRef = useRef(false);
  const screenStateRef = useRef(screenState);
  const latestRoundIdRef = useRef(null);
  currentEventIdRef.current = eventId;
  screenStateRef.current = screenState;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const segmentLabelMap = useMemo(
    () => new Map((Array.isArray(segments) ? segments : []).map((item) => [item.key, item.label || item.key])),
    [segments],
  );

  const drawableSegmentOptions = useMemo(
    () =>
      (Array.isArray(segments) ? segments : [])
        .filter((item) => item?.drawable)
        .map((item) => ({
          value: item.key,
          label: item.label || item.key,
        })),
    [segments],
  );

  // 仅读取公开展示字段（id / segment / segment_label / round_no / title），不读取任何预留字段。
  const roundMap = useMemo(() => {
    const map = new Map();
    for (const item of Array.isArray(rounds) ? rounds : []) {
      const id = Number(item?.id);
      if (Number.isSafeInteger(id) && id > 0) {
        map.set(id, {
          id,
          segment: item.segment,
          segment_label: item.segment_label,
          round_no: item.round_no,
          title: item.title,
        });
      }
    }
    return map;
  }, [rounds]);

  const roundOptions = useMemo(
    () =>
      Array.from(roundMap.values()).map((round) => ({
        value: round.id,
        label: formatRoundOptionLabel(round, segmentLabelMap),
      })),
    [roundMap, segmentLabelMap],
  );

  const validSelectedRoundId =
    selectedRoundId != null && roundMap.has(Number(selectedRoundId))
      ? Number(selectedRoundId)
      : undefined;

  const loadScreenState = useCallback(async () => {
    if (!eventId) return;
    const seq = ++requestSeqRef.current;
    const targetEventId = eventId;
    try {
      const resp = await api(`/admin/gala/screen/state?${qs({ event_id: targetEventId })}`);
      if (
        !mountedRef.current ||
        seq !== requestSeqRef.current ||
        Number(targetEventId) !== Number(currentEventIdRef.current)
      ) {
        return;
      }
      setScreenState(resp?.data || null);
    } catch {
      // 定时刷新失败时保留上次状态，避免周期性弹窗打扰。
    }
  }, [eventId]);

  useEffect(() => {
    requestSeqRef.current += 1;
    submittingRef.current = false;
    latestRoundIdRef.current = null;
    setScreenState(null);
    setSelectedSegment(undefined);
    setSelectedRoundId(undefined);
    setSubmittingMode(null);

    if (!eventId) return undefined;
    loadScreenState();
    const timer = setInterval(() => {
      loadScreenState();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [eventId, loadScreenState]);

  // 滚动中如果新抽出轮次，后端会自动切换为揭晓，这里及时同步一次大屏状态。
  const latestRoundId = Array.isArray(rounds) && rounds.length > 0 ? Number(rounds[0]?.id) || null : null;
  useEffect(() => {
    const prevLatest = latestRoundIdRef.current;
    latestRoundIdRef.current = latestRoundId;
    if (latestRoundId && latestRoundId !== prevLatest && screenStateRef.current?.mode === 'rolling') {
      loadScreenState();
    }
  }, [latestRoundId, loadScreenState]);

  const handleOpenScreen = () => {
    if (!eventId) return;
    window.open(`/admin/gala/screen?event_id=${eventId}`, '_blank');
  };

  const handleSwitchMode = async (mode) => {
    if (!canOperate || !eventId || submittingRef.current) return;
    if (mode === 'reveal' && !validSelectedRoundId) return;

    // 带回读到轮次列表时的数据版本：全量恢复后同一个轮次 ID 可能已是另一轮，服务端会拒绝（409 gala_data_changed）。
    const body = { event_id: eventId, mode, gala_version: typeof galaVersion === 'string' ? galaVersion : '' };
    if (mode === 'rolling' && selectedSegment) {
      body.segment = selectedSegment;
    }
    if (mode === 'reveal') {
      body.round_id = validSelectedRoundId;
    }

    const targetEventId = eventId;
    submittingRef.current = true;
    setSubmittingMode(mode);
    try {
      const resp = await api('/admin/gala/screen/state', {
        method: 'POST',
        body,
      });
      if (!mountedRef.current || Number(targetEventId) !== Number(currentEventIdRef.current)) {
        return;
      }
      requestSeqRef.current += 1;
      setScreenState(resp?.data || null);
      message.success(MODE_SUCCESS_TEXT[mode] || '大屏状态已更新');
    } catch (err) {
      if (!mountedRef.current || Number(targetEventId) !== Number(currentEventIdRef.current)) {
        return;
      }
      // 交给页面统一处理：数据版本变化时整页刷新（轮次列表随之重载），其余错误弹提示。
      if (typeof onError === 'function') onError(err);
      else message.error(galaErrorText(err));
    } finally {
      if (mountedRef.current && Number(targetEventId) === Number(currentEventIdRef.current)) {
        submittingRef.current = false;
        setSubmittingMode(null);
      }
    }
  };

  const renderStatusTag = () => {
    if (!screenState) {
      return <Tag>加载中</Tag>;
    }
    if (screenState.mode === 'rolling') {
      const segLabel = screenState.segment
        ? segmentLabelMap.get(screenState.segment) || screenState.segment
        : '';
      return (
        <Tag color="processing">
          {segLabel ? `滚动中（${segLabel}）` : '滚动中'}
        </Tag>
      );
    }
    if (screenState.mode === 'reveal') {
      const rid = Number(screenState.round_id);
      const round = Number.isSafeInteger(rid) ? roundMap.get(rid) : null;
      if (round) {
        const segLabel = round.segment_label || segmentLabelMap.get(round.segment) || round.segment || '';
        const detailText = segLabel ? `${segLabel} 第 ${round.round_no} 轮` : `第 ${round.round_no} 轮`;
        return <Tag color="gold">{`揭晓：${detailText}`}</Tag>;
      }
      return <Tag color="gold">{rid > 0 ? `揭晓：轮次 #${rid}` : '揭晓'}</Tag>;
    }
    if (screenState.mode === 'winners') {
      return <Tag color="green">中奖榜</Tag>;
    }
    return <Tag>待机</Tag>;
  };

  const isSubmitting = Boolean(submittingMode);

  return (
    <Card
      size="small"
      title="大屏控制"
      extra={
        canView ? (
          <Button size="small" disabled={!eventId} onClick={handleOpenScreen}>
            打开大屏
          </Button>
        ) : null
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <Space size={8} wrap align="center">
          <Typography.Text>大屏当前：</Typography.Text>
          {renderStatusTag()}
        </Space>

        {canOperate && (
          <Space size={[8, 8]} wrap align="center">
            <Button
              size="small"
              type={screenState?.mode === 'idle' ? 'primary' : 'default'}
              loading={submittingMode === 'idle'}
              disabled={isSubmitting && submittingMode !== 'idle'}
              onClick={() => handleSwitchMode('idle')}
            >
              待机
            </Button>

            <Space.Compact size="small">
              <Select
                size="small"
                allowClear
                placeholder="不指定环节"
                style={{ width: 160 }}
                value={selectedSegment}
                disabled={isSubmitting}
                options={drawableSegmentOptions}
                onChange={(value) => setSelectedSegment(value || undefined)}
              />
              <Button
                size="small"
                type={screenState?.mode === 'rolling' ? 'primary' : 'default'}
                loading={submittingMode === 'rolling'}
                disabled={isSubmitting && submittingMode !== 'rolling'}
                onClick={() => handleSwitchMode('rolling')}
              >
                开始滚动
              </Button>
            </Space.Compact>

            <Space.Compact size="small">
              <Select
                size="small"
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="选择已抽轮次"
                style={{ width: 240 }}
                value={validSelectedRoundId}
                disabled={isSubmitting}
                options={roundOptions}
                onChange={(value) => setSelectedRoundId(value ?? undefined)}
              />
              <Button
                size="small"
                type={screenState?.mode === 'reveal' ? 'primary' : 'default'}
                loading={submittingMode === 'reveal'}
                disabled={!validSelectedRoundId || (isSubmitting && submittingMode !== 'reveal')}
                onClick={() => handleSwitchMode('reveal')}
              >
                揭晓所选轮次
              </Button>
            </Space.Compact>

            <Button
              size="small"
              type={screenState?.mode === 'winners' ? 'primary' : 'default'}
              loading={submittingMode === 'winners'}
              disabled={isSubmitting && submittingMode !== 'winners'}
              onClick={() => handleSwitchMode('winners')}
            >
              中奖榜
            </Button>
          </Space>
        )}

        <Typography.Text type="secondary">
          先点“开始滚动”，再发起抽签，抽签成功后大屏会自动揭晓。
        </Typography.Text>
      </Space>
    </Card>
  );
}
