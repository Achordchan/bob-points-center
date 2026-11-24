import React, { useEffect, useMemo, useRef } from 'react';

const NORMAL_SCROLL_SPEED_PX = 46;
const REDUCED_SCROLL_SPEED_PX = 20;
const TOP_PAUSE_MS = 1400;
const BOTTOM_PAUSE_MS = 3000;

function getReducedMotionPreference() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function groupRoundsBySegment(rounds, segmentLabels) {
  if (!Array.isArray(rounds) || rounds.length === 0) return [];
  const labelMap = segmentLabels && typeof segmentLabels === 'object' ? segmentLabels : {};
  const bucket = new Map();

  for (const round of rounds) {
    if (!round || !Array.isArray(round.winners) || round.winners.length === 0) {
      continue;
    }
    const segKey = typeof round.segment === 'string' && round.segment ? round.segment : '__other__';
    if (!bucket.has(segKey)) {
      const groupTitle = labelMap[segKey]
        || round.segment_label
        || (segKey === '__other__' ? '中奖名单' : segKey);
      bucket.set(segKey, {
        key: segKey,
        title: groupTitle,
        rounds: [],
      });
    }
    const group = bucket.get(segKey);
    if (!group.title && round.segment_label) {
      group.title = round.segment_label;
    }
    group.rounds.push(round);
  }

  const ordered = [];
  for (const key of Object.keys(labelMap)) {
    if (bucket.has(key)) {
      ordered.push(bucket.get(key));
      bucket.delete(key);
    }
  }
  for (const entry of bucket.values()) {
    ordered.push(entry);
  }

  for (const group of ordered) {
    group.rounds.sort((a, b) => (a.round_no - b.round_no) || (a.id - b.id));
  }

  return ordered;
}

export default function WinnersView({ rounds, segmentLabels }) {
  const viewportRef = useRef(null);
  const trackRef = useRef(null);

  const groups = useMemo(
    () => groupRoundsBySegment(rounds, segmentLabels),
    [rounds, segmentLabels],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return undefined;

    let reducedMotion = getReducedMotionPreference();
    let mediaQuery = null;
    let rafId = 0;
    let lastTime = 0;
    let offset = 0;
    let phase = 'pause-top';
    let pauseElapsed = 0;

    const handleMotionChange = (evt) => {
      reducedMotion = Boolean(evt.matches);
    };

    if (typeof window.matchMedia === 'function') {
      mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handleMotionChange);
      } else if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(handleMotionChange);
      }
    }

    const step = (now) => {
      const dtMs = lastTime ? Math.min(now - lastTime, 100) : 0;
      lastTime = now;

      const maxOffset = Math.max(0, track.offsetHeight - viewport.clientHeight);
      if (maxOffset <= 1) {
        if (offset !== 0) {
          offset = 0;
          track.style.transform = 'translate3d(0, 0, 0)';
        }
        phase = 'pause-top';
        pauseElapsed = 0;
      } else {
        if (offset > maxOffset) {
          offset = maxOffset;
        }
        const speed = reducedMotion ? REDUCED_SCROLL_SPEED_PX : NORMAL_SCROLL_SPEED_PX;

        if (phase === 'pause-top') {
          pauseElapsed += dtMs;
          if (pauseElapsed >= TOP_PAUSE_MS) {
            phase = 'scrolling';
            pauseElapsed = 0;
          }
        } else if (phase === 'scrolling') {
          offset += (speed * dtMs) / 1000;
          if (offset >= maxOffset) {
            offset = maxOffset;
            phase = 'pause-bottom';
            pauseElapsed = 0;
          }
        } else if (phase === 'pause-bottom') {
          pauseElapsed += dtMs;
          if (pauseElapsed >= BOTTOM_PAUSE_MS) {
            offset = 0;
            phase = 'pause-top';
            pauseElapsed = 0;
          }
        }

        track.style.transform = `translate3d(0, ${(-offset).toFixed(2)}px, 0)`;
      }

      rafId = window.requestAnimationFrame(step);
    };

    track.style.transform = 'translate3d(0, 0, 0)';
    rafId = window.requestAnimationFrame(step);

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      if (mediaQuery) {
        if (typeof mediaQuery.removeEventListener === 'function') {
          mediaQuery.removeEventListener('change', handleMotionChange);
        } else if (typeof mediaQuery.removeListener === 'function') {
          mediaQuery.removeListener(handleMotionChange);
        }
      }
    };
  }, [groups]);

  return (
    <section className="gs-winners">
      <header className="gs-winners-header">
        <span className="gs-winners-header-rule" aria-hidden="true" />
        <h1 className="gs-winners-title">中奖榜</h1>
        <span className="gs-winners-header-rule" aria-hidden="true" />
      </header>

      <div ref={viewportRef} className="gs-winners-viewport">
        <div ref={trackRef} className="gs-winners-track">
          {groups.length === 0 ? (
            <div className="gs-winners-empty">敬请期待中奖揭晓</div>
          ) : (
            groups.map((group) => (
              <section key={group.key} className="gs-segment-group">
                <div className="gs-segment-heading">
                  <span className="gs-segment-diamond" aria-hidden="true" />
                  <h2 className="gs-segment-title">{group.title}</h2>
                  <span className="gs-segment-line" aria-hidden="true" />
                </div>

                <div className="gs-round-list">
                  {group.rounds.map((round) => {
                    const showPrize = round.prize_type === 'coin';
                    return (
                      <article key={round.id} className="gs-round-card">
                        <h3 className="gs-round-meta">
                          <span className="gs-round-no">第 {round.round_no} 轮</span>
                          {round.title ? (
                            <>
                              <span className="gs-round-dot" aria-hidden="true"> · </span>
                              <span className="gs-round-name">{round.title}</span>
                            </>
                          ) : null}
                          {showPrize ? (
                            <>
                              <span className="gs-round-dot" aria-hidden="true"> · </span>
                              <span className="gs-round-prize">每人 {round.amount_each} BOB</span>
                            </>
                          ) : null}
                        </h3>

                        <ul className="gs-winner-list">
                          {round.winners.map((winnerName, idx) => (
                            <li key={`${round.id}-${idx}`} className="gs-winner-pill">
                              {winnerName}
                            </li>
                          ))}
                        </ul>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
