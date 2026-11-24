import React, { useEffect, useMemo, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import NameSphere from './NameSphere.jsx';

const WAITING_SPEED_RPS = 0.65;
const DECELERATE_DURATION_MS = 1200;
const REDUCED_DECELERATE_MS = 240;
const POST_SPHERE_PAUSE_MS = 200;
const REDUCED_PAUSE_MS = 40;
const HEADER_ENTER_MS = 400;
const REDUCED_HEADER_ENTER_MS = 160;
const CARD_STAGGER_MS = 250;
const REDUCED_CARD_STAGGER_MS = 24;
const CARD_ANIM_MS = 420;
const REDUCED_CARD_ANIM_MS = 160;
const CONFETTI_DELAY_MS = 300;
const CONFETTI_VOLLEY_INTERVAL_MS = 250;
const STAGE_INNER_WIDTH = 1760;
const GRID_MAX_HEIGHT = 592;
const MIN_SCREEN_FONT_SIZE = 28;

const CONFETTI_COLORS = ['#F6D58E', '#C9973B', '#C8102E', '#FFF4DC'];

const CONFETTI_VOLLEYS = [
  {
    offsetMs: 0,
    particleCount: 100,
    angle: 60,
    spread: 62,
    startVelocity: 52,
    origin: { x: 0.08, y: 1.05 },
  },
  {
    offsetMs: CONFETTI_VOLLEY_INTERVAL_MS,
    particleCount: 100,
    angle: 120,
    spread: 62,
    startVelocity: 52,
    origin: { x: 0.92, y: 1.05 },
  },
  {
    offsetMs: CONFETTI_VOLLEY_INTERVAL_MS * 2,
    particleCount: 110,
    angle: 90,
    spread: 66,
    startVelocity: 54,
    origin: { x: 0.5, y: 1.05 },
  },
];

function getReducedMotionPreference() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function normalizeTitleKey(text) {
  return String(text || '').replace(/[\s·•・\-—_]+/g, '').trim();
}

function resolveRevealHeading(round, segmentTitle) {
  const roundLabel = `第 ${round.round_no} 轮`;
  const defaultKicker = `${segmentTitle} · ${roundLabel}`;
  const fallbackTitle = `${segmentTitle} ${roundLabel}`;
  const rawTitle = typeof round.title === 'string' ? round.title.trim() : '';

  if (!rawTitle) {
    return { kicker: '', title: fallbackTitle };
  }

  const normRaw = normalizeTitleKey(rawTitle);
  const normSeg = normalizeTitleKey(segmentTitle);
  const normRound = normalizeTitleKey(roundLabel);
  const normFull = normalizeTitleKey(fallbackTitle);

  if (normRaw === normFull) {
    return { kicker: '', title: rawTitle };
  }
  if (normRaw === normSeg) {
    return { kicker: roundLabel, title: rawTitle };
  }
  if (normRaw === normRound) {
    return { kicker: segmentTitle, title: rawTitle };
  }
  return { kicker: defaultKicker, title: rawTitle };
}

function computeWinnerLayout(count) {
  if (count <= 1) {
    return { cols: 1, cardW: 900, cardH: 300, gap: 0, fontSize: 160, tier: 'hero' };
  }
  if (count === 2) {
    return { cols: 2, cardW: 640, cardH: 240, gap: 32, fontSize: 92, tier: 'large' };
  }
  if (count === 3) {
    return { cols: 3, cardW: 520, cardH: 220, gap: 32, fontSize: 80, tier: 'large' };
  }
  if (count <= 5) {
    return { cols: 5, cardW: 328, cardH: 180, gap: 28, fontSize: 58, tier: 'medium' };
  }
  if (count <= 10) {
    return { cols: 5, cardW: 328, cardH: 168, gap: 28, fontSize: 54, tier: 'medium' };
  }
  if (count <= 12) {
    const gap = 28;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 5 * gap) / 6);
    return { cols: 6, cardW, cardH: 148, gap, fontSize: 46, tier: 'normal' };
  }
  if (count <= 18) {
    const gap = 28;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 5 * gap) / 6);
    return { cols: 6, cardW, cardH: 136, gap, fontSize: 42, tier: 'normal' };
  }
  if (count <= 21) {
    const gap = 24;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 6 * gap) / 7);
    return { cols: 7, cardW, cardH: 128, gap, fontSize: 38, tier: 'compact' };
  }
  if (count <= 28) {
    const gap = 24;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 6 * gap) / 7);
    return { cols: 7, cardW, cardH: 116, gap, fontSize: 36, tier: 'compact' };
  }
  if (count <= 32) {
    const gap = 24;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 7 * gap) / 8);
    return { cols: 8, cardW, cardH: 112, gap, fontSize: 34, tier: 'compact' };
  }
  if (count <= 40) {
    const gap = 24;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 7 * gap) / 8);
    return { cols: 8, cardW, cardH: 98, gap, fontSize: 32, tier: 'compact' };
  }
  if (count <= 48) {
    const gap = 24;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 7 * gap) / 8);
    return { cols: 8, cardW, cardH: 78, gap, fontSize: 30, tier: 'dense' };
  }

  const cols = 8;
  const gap = 24;
  const rows = Math.ceil(count / cols);
  const cardW = Math.floor((STAGE_INNER_WIDTH - (cols - 1) * gap) / cols);
  const cardH = Math.max(58, Math.floor((GRID_MAX_HEIGHT - (rows - 1) * gap) / rows));
  const fontSize = Math.max(MIN_SCREEN_FONT_SIZE, Math.min(30, Math.floor(cardH * 0.44)));
  return { cols, cardW, cardH, gap, fontSize, tier: 'dense' };
}

function countNameChars(text) {
  return Array.from(String(text || '').trim()).length;
}

function getLengthScaleFactor(charCount) {
  if (charCount <= 3) return 1;
  if (charCount === 4) return 0.85;
  if (charCount === 5) return 0.75;
  return 0.65;
}

function estimateVisualUnits(text) {
  const str = String(text || '').trim();
  let units = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) || 0;
    units += code <= 0x7f ? 0.66 : 1.08;
  }
  return Math.max(1, units);
}

function computeRoundFontSize(winnerNames, layout) {
  if (!Array.isArray(winnerNames) || winnerNames.length === 0) {
    return layout.fontSize;
  }
  let maxChars = 0;
  let maxUnits = 1;
  for (const name of winnerNames) {
    const chars = countNameChars(name);
    if (chars > maxChars) maxChars = chars;
    const units = estimateVisualUnits(name);
    if (units > maxUnits) maxUnits = units;
  }
  const tierScaled = Math.round(layout.fontSize * getLengthScaleFactor(maxChars));
  const horizontalPadding = layout.tier === 'hero' ? 100 : 32;
  const availWidth = Math.max(80, layout.cardW - horizontalPadding);
  const fitWidth = Math.floor(availWidth / maxUnits);
  return Math.max(MIN_SCREEN_FONT_SIZE, Math.min(tierScaled, fitWidth));
}

function chunkIntoRows(items, cols) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const rows = [];
  for (let i = 0; i < items.length; i += cols) {
    rows.push(
      items.slice(i, i + cols).map((name, offset) => ({
        name,
        index: i + offset,
      })),
    );
  }
  return rows;
}

function fireConfettiVolley(volley) {
  try {
    confetti({
      particleCount: volley.particleCount,
      angle: volley.angle,
      spread: volley.spread,
      startVelocity: volley.startVelocity,
      origin: volley.origin,
      colors: CONFETTI_COLORS,
      gravity: 1,
      ticks: 250,
      scalar: 1.1,
      zIndex: 9999,
      disableForReducedMotion: true,
    });
  } catch {
    // 非浏览器画布环境静默忽略
  }
}

export default function RevealView({ names, rounds, segmentLabels, state }) {
  const targetRoundId = state?.round_id || null;

  const matchedRound = useMemo(() => {
    if (!targetRoundId || !Array.isArray(rounds)) return null;
    return rounds.find((item) => item && item.id === targetRoundId) || null;
  }, [rounds, targetRoundId]);

  const matchedRoundId = matchedRound ? matchedRound.id : null;
  const winners = useMemo(
    () => (matchedRound && Array.isArray(matchedRound.winners) ? matchedRound.winners : []),
    [matchedRound],
  );

  const [phase, setPhase] = useState(() => (matchedRoundId ? 'decelerating' : 'waiting'));
  const [activeRoundId, setActiveRoundId] = useState(() => matchedRoundId);
  const [reducedMotion, setReducedMotion] = useState(getReducedMotionPreference);

  const winnersCountRef = useRef(winners.length);
  winnersCountRef.current = winners.length;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (evt) => {
      setReducedMotion(Boolean(evt.matches));
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handleChange);
    } else if (typeof mq.addListener === 'function') {
      mq.addListener(handleChange);
    }
    return () => {
      if (typeof mq.removeEventListener === 'function') {
        mq.removeEventListener('change', handleChange);
      } else if (typeof mq.removeListener === 'function') {
        mq.removeListener(handleChange);
      }
    };
  }, []);

  useEffect(() => {
    const timers = [];
    const schedule = (fn, delay) => {
      const id = setTimeout(fn, delay);
      timers.push(id);
      return id;
    };

    const cleanup = () => {
      for (const id of timers) {
        clearTimeout(id);
      }
      timers.length = 0;
      try {
        confetti.reset();
      } catch {
        // 忽略清理异常
      }
    };

    if (!matchedRoundId) {
      setActiveRoundId(null);
      setPhase('waiting');
      return cleanup;
    }

    const isReduced = getReducedMotionPreference();
    const decelMs = isReduced ? REDUCED_DECELERATE_MS : DECELERATE_DURATION_MS;
    const pauseMs = isReduced ? REDUCED_PAUSE_MS : POST_SPHERE_PAUSE_MS;
    const headerMs = isReduced ? REDUCED_HEADER_ENTER_MS : HEADER_ENTER_MS;
    const staggerMs = isReduced ? REDUCED_CARD_STAGGER_MS : CARD_STAGGER_MS;
    const cardAnimMs = isReduced ? REDUCED_CARD_ANIM_MS : CARD_ANIM_MS;

    setActiveRoundId(matchedRoundId);
    setPhase('decelerating');

    schedule(() => {
      setPhase('pause');
    }, decelMs);

    schedule(() => {
      setPhase('header');
    }, decelMs + pauseMs);

    schedule(() => {
      const count = winnersCountRef.current;
      if (count <= 0) {
        setPhase('revealed');
        return;
      }

      setPhase('revealing');
      const lastCardFinishMs = (count - 1) * staggerMs + cardAnimMs;

      schedule(() => {
        setPhase('revealed');
        if (isReduced) return;
        for (const volley of CONFETTI_VOLLEYS) {
          schedule(() => {
            fireConfettiVolley(volley);
          }, volley.offsetMs);
        }
      }, lastCardFinishMs + CONFETTI_DELAY_MS);
    }, decelMs + pauseMs + headerMs);

    return cleanup;
  }, [matchedRoundId]);

  const layout = useMemo(() => computeWinnerLayout(winners.length), [winners.length]);
  const winnerRows = useMemo(() => chunkIntoRows(winners, layout.cols), [winners, layout.cols]);
  const roundFontSize = useMemo(
    () => computeRoundFontSize(winners, layout),
    [winners, layout],
  );
  const gridSlotHeight = winnerRows.length > 0
    ? winnerRows.length * layout.cardH + Math.max(0, winnerRows.length - 1) * layout.gap
    : 0;

  const staggerMs = reducedMotion ? REDUCED_CARD_STAGGER_MS : CARD_STAGGER_MS;
  const cardAnimMs = reducedMotion ? REDUCED_CARD_ANIM_MS : CARD_ANIM_MS;

  const segmentTitle = matchedRound
    ? ((matchedRound.segment && segmentLabels?.[matchedRound.segment])
      || matchedRound.segment_label
      || '幸运抽取')
    : '';

  const heading = useMemo(() => {
    if (!matchedRound) return { kicker: '', title: '' };
    return resolveRevealHeading(matchedRound, segmentTitle);
  }, [matchedRound, segmentTitle]);

  const titleFontSize = heading.title.length > 12 ? 96 : 104;
  const showPrize = Boolean(matchedRound && matchedRound.prize_type === 'coin');
  const isCurrentRoundActive = Boolean(matchedRound) && activeRoundId === matchedRound.id;
  const showSphere = !isCurrentRoundActive || phase === 'waiting' || phase === 'decelerating';
  const isDecelerating = isCurrentRoundActive && phase === 'decelerating';
  const showHeader = isCurrentRoundActive && (phase === 'header' || phase === 'revealing' || phase === 'revealed');
  const showWinners = isCurrentRoundActive && (phase === 'revealing' || phase === 'revealed');

  return (
    <section className="gs-reveal">
      {isCurrentRoundActive ? (
        <div key={`pulse-${activeRoundId}`} className="gs-reveal-pulse" aria-hidden="true">
          <div className="gs-reveal-pulse-dim" />
          <div className="gs-reveal-pulse-bright" />
        </div>
      ) : null}

      {showSphere ? (
        <div className="gs-reveal-sphere-layer">
          <NameSphere
            names={names}
            speed={WAITING_SPEED_RPS}
            highlight={!isDecelerating}
            decelerating={isDecelerating}
            decelerateKey={activeRoundId}
            decelerateDurationMs={DECELERATE_DURATION_MS}
          />
        </div>
      ) : null}

      {showHeader ? (
        <div className="gs-reveal-content">
          <div className="gs-reveal-group">
            <header key={`header-${activeRoundId}`} className="gs-reveal-header">
              {heading.kicker ? (
                <p className="gs-reveal-kicker">{heading.kicker}</p>
              ) : null}
              <h1
                className="gs-reveal-title"
                style={{ fontSize: `${titleFontSize}px` }}
              >
                {heading.title}
              </h1>
              {showPrize ? (
                <p className="gs-reveal-prize">每人 {matchedRound.amount_each} BOB</p>
              ) : null}
            </header>

            <div
              className="gs-reveal-stage"
              style={gridSlotHeight > 0 ? { minHeight: `${gridSlotHeight}px` } : undefined}
            >
              {showWinners ? (
                winners.length === 0 ? (
                  <div className="gs-reveal-empty">本轮暂无中奖人</div>
                ) : (
                  <div
                    key={`grid-${activeRoundId}`}
                    className={`gs-reveal-grid gs-reveal-grid-${layout.tier}`}
                    style={{ rowGap: `${layout.gap}px` }}
                  >
                    {winnerRows.map((row, rowIdx) => (
                      <div
                        key={`${activeRoundId}-row-${rowIdx}`}
                        className="gs-reveal-grid-row"
                        style={{
                          gridTemplateColumns: `repeat(${row.length}, ${layout.cardW}px)`,
                          columnGap: `${layout.gap}px`,
                        }}
                      >
                        {row.map(({ name: winnerName, index }) => (
                          <div
                            key={`${activeRoundId}-${index}`}
                            className={`gs-reveal-card gs-reveal-card-${layout.tier}`}
                            style={{
                              width: `${layout.cardW}px`,
                              height: `${layout.cardH}px`,
                              animationDelay: `${index * staggerMs}ms`,
                              animationDuration: `${cardAnimMs}ms`,
                            }}
                          >
                            <div className="gs-reveal-card-inner">
                              <span
                                className="gs-reveal-card-name"
                                style={{ fontSize: `${roundFontSize}px` }}
                              >
                                {winnerName}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
