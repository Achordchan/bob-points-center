import { useState } from 'react';
import { hasPermission } from '../permissions.js';
import EventList from './gala/EventList.jsx';
import EventDetail from './gala/EventDetail.jsx';

export default function Gala({ me }) {
  const canEdit = hasPermission(me, 'gala:edit');
  const [selectedEvent, setSelectedEvent] = useState(null);

  if (selectedEvent) {
    return (
      <EventDetail
        eventId={selectedEvent.id}
        me={me}
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
