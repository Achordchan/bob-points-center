import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Space, Spin, Tabs, Tag, Typography } from 'antd';
import { api, qs } from '../../api.js';
import { hasPermission } from '../../permissions.js';
import { galaErrorText, isGalaVersionError } from './errors.js';
import { EVENT_STATUS_COLORS, EVENT_STATUS_LABELS } from './EventFormModal.jsx';
import OverviewTab from './OverviewTab.jsx';
import ParticipantsTab from './ParticipantsTab.jsx';
import PoolsTab from './PoolsTab.jsx';
import RoundsTab from './RoundsTab.jsx';

export default function EventDetail({ eventId, me, onBack }) {
  const { message } = AntApp.useApp();
  const canEdit = hasPermission(me, 'gala:edit');

  const [detail, setDetail] = useState(null);
  const [galaVersion, setGalaVersion] = useState('');
  const [segments, setSegments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activeTab, setActiveTab] = useState('overview');

  const requestSeqRef = useRef(0);

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
    try {
      const resp = await api('/admin/gala/segments');
      setSegments(Array.isArray(resp?.data) ? resp.data : []);
    } catch {
      // 环节名称展示失败不阻塞详情页主流程
    }
  }, []);

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

  const tabSharedProps = {
    eventId,
    detail,
    galaVersion,
    segments,
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
          <Button onClick={reload} loading={loading}>
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
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={tabItems}
        />
      ) : null}
    </Card>
  );
}
