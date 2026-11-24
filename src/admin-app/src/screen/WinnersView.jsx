import React, { useEffect, useMemo, useRef } from 'react';

const NORMAL_SCROLL_SPEED_PX = 30;
const REDUCED_SCROLL_SPEED_PX = 16;
const TOP_PAUSE_MS = 1500;
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
        || (segKey === '__other__' ? '荣耀名单' : segKey);
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

function resolveColumnCount(groupCount) {
  if (groupCount <= 1) return 1;
  if (groupCount === 2 || groupCount === 4) return 2;
  return 3;
}

function formatRoundHeading(round, groupTitle) {
  const base = `第 ${round.round_no} 轮`;
  const rawTitle = typeof round.title === 'string' ? round.title.trim() : '';
  const normalizedGroup = typeof groupTitle === 'string' ? groupTitle.trim() : '';
  const normalizedSegment = typeof round.segment_label === 'string' ? round.segment_label.trim() : '';
  if (
    !rawTitle
    || rawTitle === normalizedGroup
    || (normalizedSegment && rawTitle === normalizedSegment)
  ) {
    return base;
  }
  return `${base} · ${rawTitle}`;
}

function renderSegmentTitle(title) {
  const text = String(title || '');
  const parts = text.split(/([A-Za-z0-9]+)/g);
  return parts.map((part, idx) => {
    if (!part) return null;
    if (/^[A-Za-z0-9]+$/.test(part)) {
      return (
        <span key={idx} className="gs-segment-title-latin">
          {part}
        </span>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
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
    let fadeTop = false;
    let fadeBottom = false;

    const syncMaskClasses = (nextFadeTop, nextFadeBottom) => {
      if (nextFadeTop !== fadeTop) {
        fadeTop = nextFadeTop;
        viewport.classList.toggle('gs-winners-viewport-fade-top', fadeTop);
      }
      if (nextFadeBottom !== fadeBottom) {
        fadeBottom = nextFadeBottom;
        viewport.classList.toggle('gs-winners-viewport-fade-bottom', fadeBottom);
      }
    };

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
        syncMaskClasses(false, false);
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
        syncMaskClasses(offset > 0.5, offset < maxOffset - 0.5);
      }

      rafId = window.requestAnimationFrame(step);
    };

    viewport.classList.remove('gs-winners-viewport-fade-top', 'gs-winners-viewport-fade-bottom');
    track.style.transform = 'translate3d(0, 0, 0)';
    rafId = window.requestAnimationFrame(step);

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      viewport.classList.remove('gs-winners-viewport-fade-top', 'gs-winners-viewport-fade-bottom');
      if (mediaQuery) {
        if (typeof mediaQuery.removeEventListener === 'function') {
          mediaQuery.removeEventListener('change', handleMotionChange);
        } else if (typeof mediaQuery.removeListener === 'function') {
          mediaQuery.removeListener(handleMotionChange);
        }
      }
    };
  }, [groups]);

  const columnCount = resolveColumnCount(groups.length);

  return (
    <section className="gs-winners">
      <header className="gs-winners-header">
        <h1 className="gs-winners-title">荣耀榜</h1>
        <div className="gs-ornament-line gs-winners-ornament" aria-hidden="true">
          <span className="gs-ornament-rule gs-ornament-rule-left" />
          <span className="gs-ornament-diamond" />
          <span className="gs-ornament-rule gs-ornament-rule-right" />
        </div>
      </header>

      <div ref={viewportRef} className="gs-winners-viewport">
        <div ref={trackRef} className="gs-winners-track">
          {groups.length === 0 ? (
            <div className="gs-winners-empty">敬请期待中奖揭晓</div>
          ) : (
            <div className={`gs-winners-columns gs-winners-columns-${columnCount}`}>
              {groups.map((group) => (
                <section key={group.key} className="gs-segment-column">
                  <div className="gs-segment-heading">
                    <h2 className="gs-segment-title">{renderSegmentTitle(group.title)}</h2>
                    <span className="gs-segment-line" aria-hidden="true" />
                  </div>

                  <div className="gs-round-list">
                    {group.rounds.map((round) => {
                      const showPrize = round.prize_type === 'coin';
                      const roundHeading = formatRoundHeading(round, group.title);

                      return (
                        <article key={round.id} className="gs-round-card">
                          <div className="gs-round-head">
                            <h3 className="gs-round-meta">{roundHeading}</h3>
                            {showPrize ? (
                              <span className="gs-prize-capsule">
                                每人 {round.amount_each} BOB
                              </span>
                            ) : null}
                          </div>

                          <ul className="gs-winner-list">
                            {round.winners.map((winnerName, idx) => (
                              <li key={`${round.id}-${idx}`} className="gs-winner-name">
                                {winnerName}
                              </li>
                            ))}
                          </ul>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
