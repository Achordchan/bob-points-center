import React, { useEffect, useMemo, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import NameSphere from './NameSphere.jsx';
import { computeCardNameFit } from './nameFit.js';

const WAITING_SPEED_RPS = 0.65;
const DECELERATE_DURATION_MS = 1200;
const REDUCED_DECELERATE_MS = 240;
const POST_SPHERE_PAUSE_MS = 200;
const REDUCED_PAUSE_MS = 40;
const HEADER_ENTER_MS = 400;
const REDUCED_HEADER_ENTER_MS = 160;
const CARD_STAGGER_MS = 250;
const REDUCED_CARD_STAGGER_MS = 24;
const MAX_PAGE_REVEAL_MS = 6000;
const CARD_ANIM_MS = 420;
const REDUCED_CARD_ANIM_MS = 160;
const CONFETTI_DELAY_MS = 300;
const CONFETTI_VOLLEY_INTERVAL_MS = 250;
const MAX_WINNERS_PER_PAGE = 48;
const PAGE_INTERVAL_MS = 10000;
const PAGE_TRANSITION_MS = 600;
const COMPACT_HEADER_THRESHOLD = 24;
const STAGE_INNER_WIDTH = 1760;

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

function paginateWinners(winners) {
  if (!Array.isArray(winners) || winners.length === 0) return [];
  const pages = [];
  for (let i = 0; i < winners.length; i += MAX_WINNERS_PER_PAGE) {
    pages.push(winners.slice(i, i + MAX_WINNERS_PER_PAGE));
  }
  return pages;
}

function computePageStaggerMs(pageCount, isReduced) {
  if (pageCount <= 0) return 0;
  const maxStagger = isReduced ? REDUCED_CARD_STAGGER_MS : CARD_STAGGER_MS;
  return Math.min(maxStagger, MAX_PAGE_REVEAL_MS / pageCount);
}

function computeWinnerLayout(pageSize) {
  if (pageSize <= 1) {
    return { cols: 1, cardW: 900, cardH: 300, gap: 0, fontSize: 160, tier: 'hero', groupGap: 64 };
  }
  if (pageSize === 2) {
    return { cols: 2, cardW: 640, cardH: 240, gap: 32, fontSize: 92, tier: 'large', groupGap: 64 };
  }
  if (pageSize === 3) {
    return { cols: 3, cardW: 520, cardH: 220, gap: 32, fontSize: 80, tier: 'large', groupGap: 64 };
  }
  if (pageSize <= 5) {
    return { cols: 5, cardW: 328, cardH: 180, gap: 28, fontSize: 58, tier: 'medium', groupGap: 64 };
  }
  if (pageSize <= 10) {
    return { cols: 5, cardW: 328, cardH: 168, gap: 28, fontSize: 54, tier: 'medium', groupGap: 52 };
  }
  if (pageSize <= 12) {
    const gap = 28;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 5 * gap) / 6);
    return { cols: 6, cardW, cardH: 148, gap, fontSize: 46, tier: 'normal', groupGap: 52 };
  }
  if (pageSize <= 18) {
    const gap = 24;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 5 * gap) / 6);
    return { cols: 6, cardW, cardH: 132, gap, fontSize: 42, tier: 'normal', groupGap: 40 };
  }
  if (pageSize <= 21) {
    const gap = 24;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 6 * gap) / 7);
    return { cols: 7, cardW, cardH: 128, gap, fontSize: 38, tier: 'compact', groupGap: 40 };
  }
  if (pageSize <= 24) {
    const gap = 22;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 7 * gap) / 8);
    return { cols: 8, cardW, cardH: 120, gap, fontSize: 36, tier: 'compact', groupGap: 40 };
  }
  if (pageSize <= 28) {
    const gap = 22;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 6 * gap) / 7);
    return { cols: 7, cardW, cardH: 112, gap, fontSize: 36, tier: 'compact', groupGap: 28 };
  }
  if (pageSize <= 32) {
    const gap = 20;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 7 * gap) / 8);
    return { cols: 8, cardW, cardH: 110, gap, fontSize: 34, tier: 'compact', groupGap: 28 };
  }
  if (pageSize <= 40) {
    const gap = 18;
    const cardW = Math.floor((STAGE_INNER_WIDTH - 7 * gap) / 8);
    return { cols: 8, cardW, cardH: 90, gap, fontSize: 32, tier: 'compact', groupGap: 24 };
  }
  const gap = 16;
  const cardW = Math.floor((STAGE_INNER_WIDTH - 7 * gap) / 8);
  return { cols: 8, cardW, cardH: 74, gap, fontSize: 30, tier: 'dense', groupGap: 24 };
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
  const pages = useMemo(() => paginateWinners(winners), [winners]);
  const totalPages = pages.length;
  const firstPageCount = pages[0]?.length || 0;

  const [phase, setPhase] = useState(() => (matchedRoundId ? 'decelerating' : 'waiting'));
  const [activeRoundId, setActiveRoundId] = useState(() => matchedRoundId);
  const [reducedMotion, setReducedMotion] = useState(getReducedMotionPreference);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [pageLayers, setPageLayers] = useState(() => [
    { id: 1, pageIndex: 0, status: 'stable' },
  ]);

  const firstPageCountRef = useRef(firstPageCount);
  firstPageCountRef.current = firstPageCount;
  const currentPageRef = useRef(0);
  const nextPageLayerIdRef = useRef(2);

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

    currentPageRef.current = 0;
    setCurrentPageIndex(0);
    const initialLayerId = nextPageLayerIdRef.current;
    nextPageLayerIdRef.current += 1;
    setPageLayers([{ id: initialLayerId, pageIndex: 0, status: 'stable' }]);

    if (!matchedRoundId) {
      setActiveRoundId(null);
      setPhase('waiting');
      return cleanup;
    }

    const isReduced = getReducedMotionPreference();
    const decelMs = isReduced ? REDUCED_DECELERATE_MS : DECELERATE_DURATION_MS;
    const pauseMs = isReduced ? REDUCED_PAUSE_MS : POST_SPHERE_PAUSE_MS;
    const headerMs = isReduced ? REDUCED_HEADER_ENTER_MS : HEADER_ENTER_MS;
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
      const pageCount = firstPageCountRef.current;
      if (pageCount <= 0) {
        setPhase('revealed');
        return;
      }

      setPhase('revealing');
      const staggerMs = computePageStaggerMs(pageCount, isReduced);
      const lastCardFinishMs = Math.round((pageCount - 1) * staggerMs + cardAnimMs);

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

  const isCurrentRoundActive = Boolean(matchedRound) && activeRoundId === matchedRound.id;
  const showSphere = !isCurrentRoundActive || phase === 'waiting' || phase === 'decelerating';
  const isDecelerating = isCurrentRoundActive && phase === 'decelerating';
  const showHeader = isCurrentRoundActive && (phase === 'header' || phase === 'revealing' || phase === 'revealed');
  const showWinners = isCurrentRoundActive && (phase === 'revealing' || phase === 'revealed');

  useEffect(() => {
    if (!showWinners || totalPages <= 1) {
      return undefined;
    }

    let transitionTimer = null;
    const intervalId = setInterval(() => {
      const nextIdx = (currentPageRef.current + 1) % totalPages;
      currentPageRef.current = nextIdx;
      setCurrentPageIndex(nextIdx);

      const nextLayerId = nextPageLayerIdRef.current;
      nextPageLayerIdRef.current += 1;

      setPageLayers((prev) => {
        const currentActive = prev.find((item) => item.status !== 'exiting') || prev[prev.length - 1];
        const nextList = [];
        if (currentActive) {
          nextList.push({ ...currentActive, status: 'exiting' });
        }
        nextList.push({ id: nextLayerId, pageIndex: nextIdx, status: 'entering' });
        return nextList;
      });

      if (transitionTimer !== null) {
        clearTimeout(transitionTimer);
      }
      transitionTimer = setTimeout(() => {
        transitionTimer = null;
        setPageLayers((prev) => prev
          .filter((item) => item.id === nextLayerId)
          .map((item) => ({ ...item, status: 'stable' })));
      }, PAGE_TRANSITION_MS + 40);
    }, PAGE_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      if (transitionTimer !== null) {
        clearTimeout(transitionTimer);
      }
    };
  }, [activeRoundId, showWinners, totalPages]);

  const layoutCount = Math.min(winners.length, MAX_WINNERS_PER_PAGE);
  const layout = useMemo(() => computeWinnerLayout(layoutCount), [layoutCount]);
  const maxRows = layoutCount > 0 ? Math.ceil(layoutCount / layout.cols) : 0;
  const gridSlotHeight = maxRows > 0
    ? maxRows * layout.cardH + Math.max(0, maxRows - 1) * layout.gap
    : 0;

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

  const isCompactHeader = winners.length > COMPACT_HEADER_THRESHOLD;
  const titleFontSize = isCompactHeader ? 72 : (heading.title.length > 12 ? 96 : 104);
  const showPrize = Boolean(matchedRound && matchedRound.prize_type === 'coin');
  const isPaginated = totalPages > 1;
  const displayPage = Math.min(currentPageIndex + 1, Math.max(1, totalPages));

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
          <div
            className={isCompactHeader ? 'gs-reveal-group gs-reveal-group-compact' : 'gs-reveal-group'}
            style={{ gap: `${layout.groupGap}px` }}
          >
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
              style={gridSlotHeight > 0 ? { height: `${gridSlotHeight}px` } : undefined}
            >
              {showWinners ? (
                winners.length === 0 ? (
                  <div className="gs-reveal-empty">本轮暂无中奖人</div>
                ) : (
                  pageLayers.map((layer) => {
                    const pageItems = pages[layer.pageIndex] || [];
                    const pageRows = chunkIntoRows(pageItems, layout.cols);
                    const pageStaggerMs = computePageStaggerMs(pageItems.length, reducedMotion);
                    const pageClass = layer.status === 'entering'
                      ? 'gs-reveal-page gs-reveal-page-entering'
                      : layer.status === 'exiting'
                        ? 'gs-reveal-page gs-reveal-page-exiting'
                        : 'gs-reveal-page';

                    return (
                      <div key={`${activeRoundId}-page-${layer.id}`} className={pageClass}>
                        <div
                          className={`gs-reveal-grid gs-reveal-grid-${layout.tier}`}
                          style={{ rowGap: `${layout.gap}px` }}
                        >
                          {pageRows.map((row, rowIdx) => (
                            <div
                              key={`${activeRoundId}-p${layer.id}-row-${rowIdx}`}
                              className="gs-reveal-grid-row"
                              style={{
                                gridTemplateColumns: `repeat(${row.length}, ${layout.cardW}px)`,
                                columnGap: `${layout.gap}px`,
                              }}
                            >
                              {row.map(({ name: winnerName, index }) => {
                                const nameFit = computeCardNameFit(winnerName, layout);
                                return (
                                  <div
                                    key={`${activeRoundId}-p${layer.id}-${index}`}
                                    className={`gs-reveal-card gs-reveal-card-${layout.tier}`}
                                    style={{
                                      width: `${layout.cardW}px`,
                                      height: `${layout.cardH}px`,
                                      animationDelay: `${Math.round(index * pageStaggerMs)}ms`,
                                      animationDuration: `${cardAnimMs}ms`,
                                    }}
                                  >
                                    <div className="gs-reveal-card-inner">
                                      <span
                                        className={
                                          nameFit.lines > 1
                                            ? 'gs-reveal-card-name gs-reveal-card-name-wrap'
                                            : 'gs-reveal-card-name'
                                        }
                                        style={
                                          nameFit.lines > 1
                                            ? { fontSize: `${nameFit.fontSize}px`, WebkitLineClamp: nameFit.lines }
                                            : { fontSize: `${nameFit.fontSize}px` }
                                        }
                                      >
                                        {winnerName}
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })
                )
              ) : null}
            </div>

            {isPaginated ? (
              <div
                className={showWinners ? 'gs-reveal-pager gs-reveal-pager-visible' : 'gs-reveal-pager'}
                aria-live="polite"
              >
                {displayPage} / {totalPages}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
