import React from 'react';
import NameSphere from './NameSphere.jsx';

const ROLLING_SPEED_RPS = 0.6;

export default function RollingView({ names, segmentLabels, state }) {
  const segmentKey = typeof state?.segment === 'string' ? state.segment : '';
  const segmentTitle = (segmentKey && segmentLabels?.[segmentKey]) || '幸运抽取';

  return (
    <section className="gs-rolling">
      <div className="gs-rolling-glow" aria-hidden="true" />

      <header className="gs-rolling-header">
        <span className="gs-rolling-header-rule" aria-hidden="true" />
        <span className="gs-rolling-header-diamond" aria-hidden="true" />
        <h1 className="gs-rolling-title">{segmentTitle}</h1>
        <span className="gs-rolling-header-diamond" aria-hidden="true" />
        <span className="gs-rolling-header-rule" aria-hidden="true" />
      </header>

      <div className="gs-rolling-stage">
        <NameSphere
          names={names}
          speed={ROLLING_SPEED_RPS}
          highlight
        />
      </div>
    </section>
  );
}
