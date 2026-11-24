import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Card, Space, Table, Tag, Typography } from 'antd';
import { api, qs } from '../../api.js';
import { amountText } from '../../utils.js';
import { galaErrorText, isGalaVersionError } from './errors.js';
import EventFormModal, { EVENT_STATUS_COLORS, EVENT_STATUS_LABELS } from './EventFormModal.jsx';

const PAGE_SIZE = 100;

export default function EventList({ canEdit, onSelectEvent }) {
  const { message } = AntApp.useApp();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const [segments, setSegments] = useState([]);
  const [segmentsLoading, setSegmentsLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);

  const requestSeqRef = useRef(0);

  const loadSegments = useCallback(async () => {
    setSegmentsLoading(true);
    try {
      const resp = await api('/admin/gala/segments');
      setSegments(Array.isArray(resp?.data) ? resp.data : []);
    } catch (err) {
      message.error(galaErrorText(err));
    } finally {
      setSegmentsLoading(false);
    }
  }, [message]);

  const loadEvents = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const resp = await api(`/admin/gala/events?${qs({ limit: PAGE_SIZE })}`);
      if (seq !== requestSeqRef.current) return;
      const list = Array.isArray(resp?.data) ? resp.data : [];
      setEvents(list);
      setHasMore(list.length >= PAGE_SIZE);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      message.error(galaErrorText(err));
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [message]);

  const loadMore = async () => {
    if (loading || loadingMore || !hasMore || events.length === 0) return;
    const lastId = events[events.length - 1]?.id;
    if (!lastId) return;
    const seq = requestSeqRef.current;
    setLoadingMore(true);
    try {
      const resp = await api(`/admin/gala/events?${qs({ before_id: lastId, limit: PAGE_SIZE })}`);
      if (seq !== requestSeqRef.current) return;
      const list = Array.isArray(resp?.data) ? resp.data : [];
      setEvents((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const appended = list.filter((item) => !seen.has(item.id));
        return [...prev, ...appended];
      });
      setHasMore(list.length >= PAGE_SIZE);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      if (isGalaVersionError(err)) {
        message.warning('数据已变化，已刷新');
        loadEvents();
      } else {
        message.error(galaErrorText(err));
      }
    } finally {
      if (seq === requestSeqRef.current) setLoadingMore(false);
    }
  };

  useEffect(() => {
    loadEvents();
    loadSegments();
  }, [loadEvents, loadSegments]);

  const handleRefresh = () => {
    loadEvents();
    if (segments.length === 0) loadSegments();
  };

  const openCreate = () => {
    if (segments.length === 0 && !segmentsLoading) loadSegments();
    setEditingEvent(null);
    setModalOpen(true);
  };

  const openEdit = (record) => {
    if (segments.length === 0 && !segmentsLoading) loadSegments();
    setEditingEvent(record);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingEvent(null);
  };

  const handleFormSuccess = () => {
    closeModal();
    loadEvents();
  };

  const handleVersionMismatch = () => {
    closeModal();
    loadEvents();
  };

  const columns = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 80,
    },
    {
      title: '标题',
      dataIndex: 'title',
      ellipsis: true,
    },
    {
      title: '日期',
      dataIndex: 'event_date',
      width: 130,
      render: (value) => value || '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value) => (
        <Tag color={EVENT_STATUS_COLORS[value] || 'default'}>
          {EVENT_STATUS_LABELS[value] || value || '-'}
        </Tag>
      ),
    },
    {
      title: '总预算',
      dataIndex: 'total_budget',
      width: 140,
      render: (value) => (Number(value) > 0 ? amountText(value) : '不限'),
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: canEdit ? 150 : 90,
      render: (_, record) => (
        <Space>
          <Button
            size="small"
            type="primary"
            ghost
            onClick={(e) => {
              e.stopPropagation();
              onSelectEvent?.(record);
            }}
          >
            进入
          </Button>
          {canEdit && (
            <Button
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                openEdit(record);
              }}
            >
              编辑
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      <Card
        title="年会管理"
        extra={
          <Space>
            <Button onClick={handleRefresh} loading={loading}>
              刷新
            </Button>
            {canEdit && (
              <Button type="primary" onClick={openCreate}>
                新建活动
              </Button>
            )}
          </Space>
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          dataSource={events}
          columns={columns}
          pagination={false}
          scroll={{ x: 760 }}
          onRow={(record) => ({
            onClick: () => onSelectEvent?.(record),
            style: { cursor: 'pointer' },
          })}
        />

        {(events.length > 0 || hasMore) && (
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography.Text type="secondary">已加载 {events.length} 个活动</Typography.Text>
            {hasMore ? (
              <Button onClick={loadMore} loading={loadingMore}>
                加载更多
              </Button>
            ) : (
              <Typography.Text type="secondary">已显示全部活动</Typography.Text>
            )}
          </div>
        )}
      </Card>

      <EventFormModal
        open={modalOpen}
        event={editingEvent}
        segments={segments}
        segmentsLoading={segmentsLoading}
        onCancel={closeModal}
        onSuccess={handleFormSuccess}
        onVersionMismatch={handleVersionMismatch}
      />
    </>
  );
}
