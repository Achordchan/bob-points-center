import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Space, Spin, Tabs, Tag, Typography } from 'antd';
import { api, qs } from '../../api.js';
import { hasPermission } from '../../permissions.js';
import { galaErrorText, isGalaVersionError } from './errors.js';
import { EVENT_STATUS_COLORS, EVENT_STATUS_LABELS } from './EventFormModal.jsx';
import OverviewTab from './OverviewTab.jsx';
import ParticipantsTab from './ParticipantsTab.jsx';
import PoolsTab from './PoolsTab.jsx';
import RoundsTab from './RoundsTab.jsx';

const ReservedTab = lazy(() => import('./ReservedTab.jsx'));

export default function EventDetail({ eventId, me, onBack }) {
  const { message } = AntApp.useApp();
  const canEdit = hasPermission(me, 'gala:edit');
  const isSuperAdmin = me?.isSuperAdmin === true;

  const [detail, setDetail] = useState(null);
  const [galaVersion, setGalaVersion] = useState('');
  const [segments, setSegments] = useState([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);
  const [segmentsError, setSegmentsError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activeTab, setActiveTab] = useState('overview');

  const requestSeqRef = useRef(0);
  const segmentsSeqRef = useRef(0);

  const reload = useCallback(async () => {
    if (!eventId) return null;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const resp = await api(`/admin/gala/events/detail?${qs({ id: eventId })}`);
      if (seq !== requestSeqRef.current) return null;
      const data = resp?.data || null;
      setDetail(data);
      setGalaVersion(typeof data?.gala_version === 'string' ? data.gala_version : '');
      return data;
    } catch (err) {
      if (seq !== requestSeqRef.current) return null;
      const text = galaErrorText(err);
      setLoadError(text);
      message.error(text);
      return null;
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [eventId, message]);

  const loadSegments = useCallback(async () => {
    const seq = ++segmentsSeqRef.current;
    setSegmentsLoading(true);
    try {
      const resp = await api('/admin/gala/segments');
      if (seq !== segmentsSeqRef.current) return null;
      const list = Array.isArray(resp?.data) ? resp.data : [];
      setSegments(list);
      setSegmentsError('');
      return list;
    } catch (err) {
      if (seq !== segmentsSeqRef.current) return null;
      setSegmentsError(galaErrorText(err));
      return null;
    } finally {
      if (seq === segmentsSeqRef.current) setSegmentsLoading(false);
    }
  }, []);

  const handleRefresh = () => {
    reload();
    if (segments.length === 0 || segmentsError) {
      loadSegments();
    }
  };

  useEffect(() => {
    setDetail(null);
    setGalaVersion('');
    setActiveTab('overview');
    reload();
  }, [eventId, reload]);

  useEffect(() => {
    loadSegments();
  }, [loadSegments]);

  const handleError = useCallback(
    (err) => {
      if (isGalaVersionError(err)) {
        message.warning('数据已变化，已刷新');
        reload();
        return true;
      }
      message.error(galaErrorText(err));
      return false;
    },
    [message, reload],
  );

  const segmentsLoadFailed = Boolean(segmentsError);

  const tabSharedProps = {
    eventId,
    detail,
    galaVersion,
    segments,
    segmentsError,
    segmentsLoadFailed,
    loadSegments,
    me,
    canEdit,
    loading,
    reload,
    handleError,
  };

  const tabItems = [
    {
      key: 'overview',
      label: '概览',
      children: <OverviewTab {...tabSharedProps} />,
    },
    {
      key: 'pools',
      label: '奖池',
      children: <PoolsTab {...tabSharedProps} />,
    },
    {
      key: 'participants',
      label: '参与人',
      children: <ParticipantsTab {...tabSharedProps} />,
    },
    {
      key: 'rounds',
      label: '抽签与发币',
      children: <RoundsTab {...tabSharedProps} />,
    },
  ];

  if (isSuperAdmin) {
    tabItems.push({
      key: 'reserved',
      label: '预留名额',
      children: (
        <Suspense
          fallback={
            <div style={{ padding: '32px 0', textAlign: 'center' }}>
              <Spin />
            </div>
          }
        >
          <ReservedTab {...tabSharedProps} />
        </Suspense>
      ),
    });
  }

  const effectiveActiveTab = !isSuperAdmin && activeTab === 'reserved' ? 'overview' : activeTab;

  return (
    <Card
      title={
        <Space wrap>
          <span>{detail?.title || `年会活动 #${eventId}`}</span>
          {detail?.status && (
            <Tag color={EVENT_STATUS_COLORS[detail.status] || 'default'}>
              {EVENT_STATUS_LABELS[detail.status] || detail.status}
            </Tag>
          )}
          {detail?.event_date && (
            <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
              {detail.event_date}
            </Typography.Text>
          )}
        </Space>
      }
      extra={
        <Space>
          <Button onClick={handleRefresh} loading={loading}>
            刷新
          </Button>
          <Button onClick={onBack}>返回列表</Button>
        </Space>
      }
    >
      {!detail && loading ? (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <Spin />
        </div>
      ) : !detail && loadError ? (
        <Alert
          type="error"
          showIcon
          message="活动详情加载失败"
          description={loadError}
          action={
            <Button size="small" onClick={reload}>
              重试
            </Button>
          }
        />
      ) : detail ? (
        <>
          {segmentsError && (
            <Alert
              type="warning"
              showIcon
              message="环节列表加载失败"
              description={segmentsError}
              action={
                <Button size="small" onClick={loadSegments} loading={segmentsLoading}>
                  重试
                </Button>
              }
              style={{ marginBottom: 16 }}
            />
          )}
          <Tabs
            activeKey={effectiveActiveTab}
            onChange={setActiveTab}
            items={tabItems}
          />
        </>
      ) : null}
    </Card>
  );
}
