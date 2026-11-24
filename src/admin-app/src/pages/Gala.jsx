import { useState } from 'react';
import { Button, Card, Empty, Space, Tag } from 'antd';
import { hasPermission } from '../permissions.js';
import EventList from './gala/EventList.jsx';
import { EVENT_STATUS_COLORS, EVENT_STATUS_LABELS } from './gala/EventFormModal.jsx';

function EventDetailPlaceholder({ event, onBack }) {
  return (
    <Card
      title={
        <Space>
          <span>{event.title}</span>
          <Tag color={EVENT_STATUS_COLORS[event.status] || 'default'}>
            {EVENT_STATUS_LABELS[event.status] || event.status || '-'}
          </Tag>
        </Space>
      }
      extra={<Button onClick={onBack}>返回列表</Button>}
    >
      <Empty description="活动详情建设中" />
    </Card>
  );
}

export default function Gala({ me }) {
  const canEdit = hasPermission(me, 'gala:edit');
  const [selectedEvent, setSelectedEvent] = useState(null);

  if (selectedEvent) {
    return (
      <EventDetailPlaceholder
        event={selectedEvent}
        onBack={() => setSelectedEvent(null)}
      />
    );
  }

  return (
    <EventList
      canEdit={canEdit}
      onSelectEvent={setSelectedEvent}
    />
  );
}
