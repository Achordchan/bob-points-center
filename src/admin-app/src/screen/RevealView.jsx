import React, { useEffect, useMemo, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import NameSphere from './NameSphere.jsx';

const WAITING_SPEED_RPS = 0.6;
const DECELERATE_DURATION_MS = 1500;
const REDUCED_DECELERATE_MS = 280;
const CARD_STAGGER_MS = 350;
const REDUCED_CARD_STAGGER_MS = 24;
const CARD_ANIM_MS = 480;
const REDUCED_CARD_ANIM_MS = 180;
const GRID_MAX_WIDTH = 1728;
const GRID_MAX_HEIGHT = 720;

const CONFETTI_COLORS = [
  '#fff1b8',
  '#f5c76b',
  '#d99626',
  '#e63946',
  '#ff5464',
  '#ffd166',
];

const CONFETTI_VOLLEY_OFFSETS_MS = [0, 480, 960, 1440, 1920, 2400];

function getReducedMotionPreference() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function computeWinnerLayout(count) {
  if (count <= 1) {
    return { cols: 1, cardW: 720, cardH: 256, gapX: 0, gapY: 0, fontSize: 112, radius: 28, tier: 'hero' };
  }
  if (count === 2) {
    return { cols: 2, cardW: 560, cardH: 216, gapX: 48, gapY: 36, fontSize: 84, radius: 24, tier: 'large' };
  }
  if (count === 3) {
    return { cols: 3, cardW: 480, cardH: 196, gapX: 40, gapY: 32, fontSize: 72, radius: 22, tier: 'large' };
  }
  if (count === 4) {
    return { cols: 2, cardW: 500, cardH: 184, gapX: 44, gapY: 36, fontSize: 72, radius: 22, tier: 'large' };
  }
  if (count <= 6) {
    return { cols: 3, cardW: 460, cardH: 174, gapX: 36, gapY: 32, fontSize: 64, radius: 20, tier: 'medium' };
  }
  if (count <= 8) {
    return { cols: 4, cardW: 382, cardH: 156, gapX: 28, gapY: 28, fontSize: 56, radius: 18, tier: 'medium' };
  }
  if (count <= 10) {
    return { cols: 5, cardW: 318, cardH: 150, gapX: 26, gapY: 28, fontSize: 50, radius: 18, tier: 'medium' };
  }
  if (count <= 15) {
    return { cols: 5, cardW: 312, cardH: 136, gapX: 24, gapY: 24, fontSize: 44, radius: 16, tier: 'normal' };
  }
  if (count <= 24) {
    return { cols: 6, cardW: 262, cardH: 118, gapX: 22, gapY: 22, fontSize: 38, radius: 14, tier: 'normal' };
  }
  if (count <= 35) {
    return { cols: 7, cardW: 224, cardH: 102, gapX: 18, gapY: 18, fontSize: 34, radius: 14, tier: 'compact' };
  }
  if (count <= 48) {
    return { cols: 8, cardW: 198, cardH: 90, gapX: 16, gapY: 16, fontSize: 30, radius: 12, tier: 'compact' };
  }
  if (count <= 60) {
    return { cols: 10, cardW: 158, cardH: 82, gapX: 14, gapY: 16, fontSize: 26, radius: 12, tier: 'dense' };
  }

  const cols = Math.min(12, Math.ceil(Math.sqrt(count * 2.1)));
  const rows = Math.ceil(count / cols);
  const gapX = 12;
  const gapY = 12;
  const cardW = Math.max(116, Math.floor((GRID_MAX_WIDTH - (cols - 1) * gapX) / cols));
  const cardH = Math.max(58, Math.floor((GRID_MAX_HEIGHT - (rows - 1) * gapY) / rows));
  const fontSize = Math.max(18, Math.min(26, Math.floor(cardH * 0.36)));
  return { cols, cardW, cardH, gapX, gapY, fontSize, radius: 10, tier: 'dense' };
}

function computeAdjustedFontSize(name, baseFontSize) {
  const len = typeof name === 'string' ? name.length : 0;
  if (len <= 4) return baseFontSize;
  if (len <= 6) return Math.max(16, Math.round(baseFontSize * 0.82));
  if (len <= 9) return Math.max(15, Math.round(baseFontSize * 0.68));
  return Math.max(14, Math.round(baseFontSize * 0.56));
}

function fireSideConfetti(isMajor) {
  const particleCount = isMajor ? 48 : 30;
  const spread = isMajor ? 66 : 56;
  const startVelocity = isMajor ? 58 : 48;

  try {
    confetti({
      particleCount,
      angle: 58,
      spread,
      startVelocity,
      origin: { x: 0.01, y: 0.68 },
      colors: CONFETTI_COLORS,
      ticks: 220,
      gravity: 0.92,
      scalar: 1.15,
      zIndex: 9999,
      disableForReducedMotion: true,
    });
    confetti({
      particleCount,
      angle: 122,
      spread,
      startVelocity,
      origin: { x: 0.99, y: 0.68 },
      colors: CONFETTI_COLORS,
      ticks: 220,
      gravity: 0.92,
      scalar: 1.15,
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
    const staggerMs = isReduced ? REDUCED_CARD_STAGGER_MS : CARD_STAGGER_MS;
    const animMs = isReduced ? REDUCED_CARD_ANIM_MS : CARD_ANIM_MS;

    setActiveRoundId(matchedRoundId);
    setPhase('decelerating');

    schedule(() => {
      const count = winnersCountRef.current;
      if (count <= 0) {
        setPhase('revealed');
        return;
      }

      setPhase('revealing');
      const totalCardsMs = (count - 1) * staggerMs + animMs;

      schedule(() => {
        setPhase('revealed');
        if (isReduced) return;
        CONFETTI_VOLLEY_OFFSETS_MS.forEach((offset, idx) => {
          schedule(() => {
            const isMajor = idx === 0 || idx === CONFETTI_VOLLEY_OFFSETS_MS.length - 1;
            fireSideConfetti(isMajor);
          }, offset);
        });
      }, totalCardsMs);
    }, decelMs);

    return cleanup;
  }, [targetRoundId, matchedRoundId]);

  const layout = useMemo(() => computeWinnerLayout(winners.length), [winners.length]);
  const gridWidth = layout.cols * layout.cardW + Math.max(0, layout.cols - 1) * layout.gapX;
  const totalRows = winners.length > 0 ? Math.ceil(winners.length / layout.cols) : 0;

  const staggerMs = reducedMotion ? REDUCED_CARD_STAGGER_MS : CARD_STAGGER_MS;
  const animMs = reducedMotion ? REDUCED_CARD_ANIM_MS : CARD_ANIM_MS;

  const waitingSegmentTitle = (state?.segment && segmentLabels?.[state.segment]) || '幸运揭晓';
  const segmentTitle = matchedRound
    ? ((matchedRound.segment && segmentLabels?.[matchedRound.segment])
      || matchedRound.segment_label
      || '幸运抽取')
    : waitingSegmentTitle;

  const showPrize = Boolean(matchedRound && matchedRound.prize_type === 'coin');
  const isCurrentRoundActive = Boolean(matchedRound) && activeRoundId === matchedRound.id;
  const showWinners = isCurrentRoundActive && (phase === 'revealing' || phase === 'revealed');
  const showSphere = !showWinners;
  const isDecelerating = isCurrentRoundActive && phase === 'decelerating';

  return (
    <section className="gs-reveal">
      <div className="gs-reveal-glow" aria-hidden="true" />

      <header className="gs-reveal-header">
        {matchedRound ? (
          <>
            <div className="gs-reveal-meta-row">
              <span className="gs-reveal-rule" aria-hidden="true" />
              <h1 className="gs-reveal-meta">
                <span className="gs-reveal-segment">{segmentTitle}</span>
                <span className="gs-reveal-dot" aria-hidden="true"> · </span>
                <span className="gs-reveal-round-no">第 {matchedRound.round_no} 轮</span>
                {matchedRound.title ? (
                  <>
                    <span className="gs-reveal-dot" aria-hidden="true"> · </span>
                    <span className="gs-reveal-round-title">{matchedRound.title}</span>
                  </>
                ) : null}
              </h1>
              <span className="gs-reveal-rule" aria-hidden="true" />
            </div>

            {showPrize ? (
              <p className="gs-reveal-prize">每人 {matchedRound.amount_each} BOB</p>
            ) : null}
          </>
        ) : (
          <div className="gs-reveal-meta-row">
            <span className="gs-reveal-rule" aria-hidden="true" />
            <h1 className="gs-reveal-meta">
              <span className="gs-reveal-segment">{waitingSegmentTitle}</span>
            </h1>
            <span className="gs-reveal-rule" aria-hidden="true" />
          </div>
        )}
      </header>

      <div className="gs-reveal-stage">
        {showSphere ? (
          <NameSphere
            names={names}
            speed={WAITING_SPEED_RPS}
            highlight={!isDecelerating}
            decelerating={isDecelerating}
            decelerateKey={activeRoundId}
            decelerateDurationMs={DECELERATE_DURATION_MS}
          />
        ) : null}

        {showWinners ? (
          winners.length === 0 ? (
            <div className="gs-reveal-empty">本轮暂无中奖人</div>
          ) : (
            <div
              key={activeRoundId || 'reveal-grid'}
              className={`gs-reveal-grid gs-reveal-grid-${layout.tier}`}
              style={{
                width: `${gridWidth}px`,
                columnGap: `${layout.gapX}px`,
                rowGap: `${layout.gapY}px`,
              }}
            >
              {winners.map((winnerName, idx) => {
                const row = Math.floor(idx / layout.cols);
                const col = idx % layout.cols;
                const itemsInRow = row === totalRows - 1
                  ? winners.length - row * layout.cols
                  : layout.cols;
                const posX = (col - (itemsInRow - 1) / 2) * (layout.cardW + layout.gapX);
                const posY = (row - (totalRows - 1) / 2) * (layout.cardH + layout.gapY);
                const fontSize = computeAdjustedFontSize(winnerName, layout.fontSize);

                return (
                  <div
                    key={`${activeRoundId}-${idx}`}
                    className={`gs-reveal-card gs-reveal-card-${layout.tier}`}
                    style={{
                      width: `${layout.cardW}px`,
                      height: `${layout.cardH}px`,
                      borderRadius: `${layout.radius}px`,
                      fontSize: `${fontSize}px`,
                      '--gs-from-x': `${(-posX).toFixed(1)}px`,
                      '--gs-from-y': `${(-posY).toFixed(1)}px`,
                      animationDelay: `${idx * staggerMs}ms`,
                      animationDuration: `${animMs}ms`,
                    }}
                  >
                    <span className="gs-reveal-card-name">{winnerName}</span>
                  </div>
                );
              })}
            </div>
          )
        ) : null}
      </div>
    </section>
  );
}
