import React from 'react';
import { createRoot } from 'react-dom/client';
import { useScreenData } from './useScreenData.js';
import './screen.css';

function GalaScreenApp() {
  const { eventId, event, names, rounds, segmentLabels, state, ready } = useScreenData();

  if (!eventId) {
    return (
      <main className="gala-screen-shell">
        <p className="gala-screen-message">缺少活动参数</p>
      </main>
    );
  }

  const participantCount = event ? event.participant_count : names.length;
  const activeSegment = state.segment ? (segmentLabels[state.segment] || state.segment) : '—';

  return (
    <main className="gala-screen-shell">
      <section className="gala-screen-debug">
        <h1 className="gala-screen-title">{event?.title || (ready ? '年会大屏' : '加载中…')}</h1>
        <dl className="gala-screen-metrics">
          <div>
            <dt>当前模式</dt>
            <dd>{state.mode}</dd>
          </div>
          <div>
            <dt>参与人数</dt>
            <dd>{participantCount}</dd>
          </div>
          <div>
            <dt>轮次数</dt>
            <dd>{rounds.length}</dd>
          </div>
          {state.mode === 'rolling' && (
            <div>
              <dt>当前环节</dt>
              <dd>{activeSegment}</dd>
            </div>
          )}
        </dl>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <GalaScreenApp />
  </React.StrictMode>,
);
