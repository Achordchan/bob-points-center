import React, { useMemo } from 'react';
import NameSphere from './NameSphere.jsx';

const ROLLING_SPEED_RPS = 0.65;
const ROLLING_RAMP_UP_MS = 500;

function computeNextRoundNo(rounds, segmentKey) {
  let maxRoundNo = 0;
  if (Array.isArray(rounds)) {
    for (const round of rounds) {
      if (
        round
        && round.segment === segmentKey
        && Number.isFinite(round.round_no)
        && round.round_no > maxRoundNo
      ) {
        maxRoundNo = round.round_no;
      }
    }
  }
  return maxRoundNo + 1;
}

export default function RollingView({ names, rounds, segmentLabels, state }) {
  const segmentKey = typeof state?.segment === 'string' ? state.segment.trim() : '';

  const statusText = useMemo(() => {
    if (!segmentKey) {
      return '幸运抽取 · 抽取中';
    }
    const segmentName = (segmentLabels && segmentLabels[segmentKey]) || segmentKey;
    const nextRoundNo = computeNextRoundNo(rounds, segmentKey);
    return `${segmentName} · 第 ${nextRoundNo} 轮 · 抽取中`;
  }, [rounds, segmentKey, segmentLabels]);

  return (
    <section className="gs-rolling">
      <div className="gs-rolling-stage">
        <NameSphere
          names={names}
          speed={ROLLING_SPEED_RPS}
          rampUpMs={ROLLING_RAMP_UP_MS}
          highlight
        />
      </div>

      <div className="gs-rolling-status" aria-live="polite">
        <span className="gs-rolling-status-text">{statusText}</span>
        <span className="gs-rolling-dots" aria-hidden="true">
          <span className="gs-rolling-dot">.</span>
          <span className="gs-rolling-dot">.</span>
          <span className="gs-rolling-dot">.</span>
        </span>
      </div>
    </section>
  );
}
