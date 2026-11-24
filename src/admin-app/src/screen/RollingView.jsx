import React from 'react';

export default function RollingView({ segmentLabels, state }) {
  const segmentTitle = state?.segment
    ? (segmentLabels?.[state.segment] || state.segment)
    : '';
  const heading = segmentTitle ? `${segmentTitle} · 抽奖进行中` : '抽奖进行中';

  return (
    <section className="gs-placeholder">
      <h1 className="gs-placeholder-title">{heading}</h1>
    </section>
  );
}
