import React from 'react';

export default function RevealView({ rounds, state }) {
  const matchedRound = Array.isArray(rounds) && state?.round_id
    ? rounds.find((item) => item && item.id === state.round_id)
    : null;
  const heading = matchedRound?.title ? `${matchedRound.title} · 中奖揭晓` : '中奖揭晓';

  return (
    <section className="gs-placeholder">
      <h1 className="gs-placeholder-title">{heading}</h1>
    </section>
  );
}
