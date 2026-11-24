import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useScreenData } from './useScreenData.js';
import IdleView from './IdleView.jsx';
import RollingView from './RollingView.jsx';
import RevealView from './RevealView.jsx';
import WinnersView from './WinnersView.jsx';

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;
const CURSOR_HIDE_DELAY_MS = 3000;
const TRANSITION_DURATION_MS = 600;

function computeStageScale() {
  if (typeof window === 'undefined') return 1;
  const vw = window.innerWidth || STAGE_WIDTH;
  const vh = window.innerHeight || STAGE_HEIGHT;
  return Math.min(vw / STAGE_WIDTH, vh / STAGE_HEIGHT);
}

function toggleFullscreen() {
  if (typeof document === 'undefined') return;
  try {
    if (!document.fullscreenElement) {
      const request = document.documentElement && document.documentElement.requestFullscreen;
      if (typeof request === 'function') {
        Promise.resolve(request.call(document.documentElement)).catch(() => {});
      }
    } else if (typeof document.exitFullscreen === 'function') {
      Promise.resolve(document.exitFullscreen()).catch(() => {});
    }
  } catch {
    // 浏览器限制或不支持全屏时静默忽略
  }
}

function resolveSegmentBadge(state, rounds, segmentLabels) {
  if (!state || (state.mode !== 'rolling' && state.mode !== 'reveal')) {
    return '';
  }
  if (state.mode === 'reveal' && state.round_id && Array.isArray(rounds)) {
    const matched = rounds.find((item) => item && item.id === state.round_id);
    if (matched) {
      return (matched.segment && segmentLabels?.[matched.segment])
        || matched.segment_label
        || '';
    }
  }
  if (state.segment) {
    return segmentLabels?.[state.segment] || state.segment;
  }
  return '';
}

function renderModeView(mode, props) {
  switch (mode) {
    case 'rolling':
      return <RollingView {...props} />;
    case 'reveal':
      return <RevealView {...props} />;
    case 'winners':
      return <WinnersView {...props} />;
    case 'idle':
    default:
      return <IdleView {...props} />;
  }
}

export default function ScreenApp() {
  const { eventId, event, names, rounds, segmentLabels, state, ready } = useScreenData();
  const [scale, setScale] = useState(computeStageScale);
  const [cursorHidden, setCursorHidden] = useState(false);

  const [layers, setLayers] = useState(() => [
    { id: 1, mode: state.mode, status: 'stable', snapshot: null },
  ]);
  const activeModeRef = useRef(state.mode);
  const latestStateRef = useRef(state);
  const nextLayerIdRef = useRef(2);
  const transitionTimerRef = useRef(null);

  useEffect(() => {
    const handleResize = () => {
      setScale(computeStageScale());
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    document.addEventListener('fullscreenchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('fullscreenchange', handleResize);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (evt) => {
      if (evt.repeat || evt.ctrlKey || evt.metaKey || evt.altKey) return;
      if (evt.key === 'f' || evt.key === 'F') {
        evt.preventDefault();
        toggleFullscreen();
      }
    };
    const handleDoubleClick = () => {
      toggleFullscreen();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('dblclick', handleDoubleClick);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('dblclick', handleDoubleClick);
    };
  }, []);

  useEffect(() => {
    let hideTimer = null;
    const scheduleHide = () => {
      if (hideTimer !== null) {
        clearTimeout(hideTimer);
      }
      hideTimer = setTimeout(() => {
        hideTimer = null;
        setCursorHidden(true);
      }, CURSOR_HIDE_DELAY_MS);
    };
    const handlePointerActivity = () => {
      setCursorHidden(false);
      scheduleHide();
    };

    scheduleHide();
    window.addEventListener('mousemove', handlePointerActivity, { passive: true });
    window.addEventListener('mousedown', handlePointerActivity, { passive: true });
    return () => {
      if (hideTimer !== null) {
        clearTimeout(hideTimer);
      }
      window.removeEventListener('mousemove', handlePointerActivity);
      window.removeEventListener('mousedown', handlePointerActivity);
    };
  }, []);

  useEffect(() => {
    const nextMode = state.mode;
    if (nextMode === activeModeRef.current) {
      latestStateRef.current = state;
      return;
    }

    const previousSnapshot = latestStateRef.current;
    activeModeRef.current = nextMode;
    latestStateRef.current = state;

    const nextId = nextLayerIdRef.current;
    nextLayerIdRef.current += 1;

    setLayers((prev) => {
      const currentActive = prev.find((item) => item.status !== 'exiting') || prev[prev.length - 1];
      const nextList = [];
      if (currentActive) {
        nextList.push({
          ...currentActive,
          status: 'exiting',
          snapshot: previousSnapshot,
        });
      }
      nextList.push({
        id: nextId,
        mode: nextMode,
        status: 'entering',
        snapshot: null,
      });
      return nextList;
    });

    if (transitionTimerRef.current !== null) {
      clearTimeout(transitionTimerRef.current);
    }
    transitionTimerRef.current = setTimeout(() => {
      transitionTimerRef.current = null;
      setLayers((prev) => prev
        .filter((item) => item.id === nextId)
        .map((item) => ({ ...item, status: 'stable' })));
    }, TRANSITION_DURATION_MS + 40);
  }, [state]);

  useEffect(() => () => {
    if (transitionTimerRef.current !== null) {
      clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
  }, []);

  const cornerTitle = event?.title || '';
  const segmentBadge = useMemo(
    () => resolveSegmentBadge(state, rounds, segmentLabels),
    [state, rounds, segmentLabels],
  );
  const viewportClass = cursorHidden ? 'gs-viewport gs-cursor-hidden' : 'gs-viewport';

  return (
    <div className={viewportClass}>
      <div
        className="gs-stage"
        style={{ transform: `scale(${scale})` }}
      >
        <div className="gs-stage-vignette" aria-hidden="true" />
        <div className="gs-stage-texture" aria-hidden="true" />

        {!eventId ? (
          <div className="gs-view-layer">
            <section className="gs-empty-stage">
              <h1 className="gs-placeholder-title">缺少活动参数</h1>
            </section>
          </div>
        ) : (
          <>
            <header className="gs-stage-chrome">
              {cornerTitle ? (
                <div className="gs-corner-event-title">{cornerTitle}</div>
              ) : (
                <div className="gs-corner-spacer" aria-hidden="true" />
              )}
              {segmentBadge ? (
                <div className="gs-corner-segment-pill">{segmentBadge}</div>
              ) : null}
            </header>

            {layers.map((layer) => {
              const layerClass = layer.status === 'entering'
                ? 'gs-view-layer gs-view-entering'
                : layer.status === 'exiting'
                  ? 'gs-view-layer gs-view-exiting'
                  : 'gs-view-layer';
              const viewState = layer.status === 'exiting' && layer.snapshot
                ? layer.snapshot
                : state;

              return (
                <div key={layer.id} className={layerClass}>
                  {renderModeView(layer.mode, {
                    event,
                    names,
                    rounds,
                    segmentLabels,
                    state: viewState,
                    ready,
                  })}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
