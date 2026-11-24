import React, { useEffect, useMemo, useRef, useState } from 'react';

const MAX_SPHERE_CARDS = 120;
const SWAP_INTERVAL_MS = 2000;
const SWAP_BATCH_SIZE = 10;
const HIGHLIGHT_INTERVAL_MS = 120;
const REDUCED_HIGHLIGHT_INTERVAL_MS = 480;
const DEFAULT_SPEED_RPS = 0.6;
const REDUCED_SPEED_RPS = 0.08;
const DEFAULT_RADIUS_PX = 350;
const DEFAULT_DECELERATE_MS = 1500;
const REDUCED_DECELERATE_MS = 320;
const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5));
const RAD_TO_DEG = 180 / Math.PI;

function getReducedMotionPreference() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function pickInitialIndices(totalCount) {
  if (totalCount <= 0) return [];
  if (totalCount <= MAX_SPHERE_CARDS) {
    return Array.from({ length: totalCount }, (_, i) => i);
  }
  const pool = Array.from({ length: totalCount }, (_, i) => i);
  for (let i = 0; i < MAX_SPHERE_CARDS; i += 1) {
    const j = i + Math.floor(Math.random() * (totalCount - i));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, MAX_SPHERE_CARDS);
}

function swapRandomIndices(currentIndices, totalCount) {
  const cardCount = currentIndices.length;
  const unusedCount = totalCount - cardCount;
  if (unusedCount <= 0 || cardCount <= 0) return currentIndices;

  const activeSet = new Set(currentIndices);
  const unusedPool = [];
  for (let i = 0; i < totalCount; i += 1) {
    if (!activeSet.has(i)) unusedPool.push(i);
  }

  const swapCount = Math.min(SWAP_BATCH_SIZE, cardCount, unusedPool.length);
  if (swapCount <= 0) return currentIndices;

  const slotPool = Array.from({ length: cardCount }, (_, i) => i);
  for (let i = 0; i < swapCount; i += 1) {
    const j = i + Math.floor(Math.random() * (cardCount - i));
    const tmp = slotPool[i];
    slotPool[i] = slotPool[j];
    slotPool[j] = tmp;
  }

  for (let i = 0; i < swapCount; i += 1) {
    const j = i + Math.floor(Math.random() * (unusedPool.length - i));
    const tmp = unusedPool[i];
    unusedPool[i] = unusedPool[j];
    unusedPool[j] = tmp;
  }

  const next = currentIndices.slice();
  for (let i = 0; i < swapCount; i += 1) {
    next[slotPool[i]] = unusedPool[i];
  }
  return next;
}

function computeFibonacciSlots(count, radius) {
  if (count <= 0) return [];
  const slots = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const latDeg = Math.asin(Math.max(-1, Math.min(1, y))) * RAD_TO_DEG;
    const lonDeg = ((i * GOLDEN_ANGLE_RAD) * RAD_TO_DEG) % 360;
    slots[i] = {
      key: i,
      transform: `translate3d(-50%, -50%, 0) rotateY(${lonDeg.toFixed(2)}deg) rotateX(${latDeg.toFixed(2)}deg) translateZ(${radius}px)`,
    };
  }
  return slots;
}

export default function NameSphere({
  names,
  speed = DEFAULT_SPEED_RPS,
  highlight = false,
  decelerating = false,
  decelerateKey = null,
  decelerateDurationMs = DEFAULT_DECELERATE_MS,
  radius = DEFAULT_RADIUS_PX,
}) {
  const safeNames = useMemo(
    () => (Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n.length > 0) : []),
    [names],
  );
  const totalCount = safeNames.length;

  const [activeIndices, setActiveIndices] = useState(() => pickInitialIndices(totalCount));

  const stageRef = useRef(null);
  const sphereRef = useRef(null);
  const cardRefs = useRef([]);
  const speedRef = useRef(speed);
  const deceleratingRef = useRef(decelerating);
  const decelerateKeyRef = useRef(decelerateKey);
  const decelerateMsRef = useRef(decelerateDurationMs);
  const decelTriggerRef = useRef(decelerating);

  speedRef.current = speed;
  decelerateMsRef.current = decelerateDurationMs;

  if (decelerating !== deceleratingRef.current || decelerateKey !== decelerateKeyRef.current) {
    deceleratingRef.current = decelerating;
    decelerateKeyRef.current = decelerateKey;
    decelTriggerRef.current = decelerating;
  }

  useEffect(() => {
    setActiveIndices(pickInitialIndices(totalCount));
  }, [safeNames, totalCount]);

  useEffect(() => {
    if (totalCount <= MAX_SPHERE_CARDS || decelerating) return undefined;
    const timer = setInterval(() => {
      setActiveIndices((prev) => {
        if (prev.length !== MAX_SPHERE_CARDS) {
          return pickInitialIndices(totalCount);
        }
        return swapRandomIndices(prev, totalCount);
      });
    }, SWAP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [totalCount, decelerating]);

  const cardCount = activeIndices.length;
  const slots = useMemo(() => computeFibonacciSlots(cardCount, radius), [cardCount, radius]);

  useEffect(() => {
    if (cardCount === 0) return undefined;
    const sphereEl = sphereRef.current;
    const stageEl = stageRef.current;
    if (!sphereEl || !stageEl) return undefined;

    let reducedMotion = getReducedMotionPreference();
    let mediaQuery = null;
    let rafId = 0;
    let lastTime = 0;
    let angleY = 0;
    let elapsed = 0;
    let decelStartTime = null;
    let isDecelActive = false;

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
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0;
      lastTime = now;

      if (deceleratingRef.current) {
        if (!isDecelActive || decelTriggerRef.current) {
          isDecelActive = true;
          decelTriggerRef.current = false;
          decelStartTime = now;
        }
      } else if (isDecelActive) {
        isDecelActive = false;
        decelStartTime = null;
        stageEl.style.transform = 'scale3d(1, 1, 1)';
        stageEl.style.opacity = '1';
      }

      const baseRps = reducedMotion
        ? Math.min(speedRef.current, REDUCED_SPEED_RPS)
        : speedRef.current;
      let speedFactor = 1;

      if (isDecelActive && decelStartTime !== null) {
        const duration = reducedMotion
          ? Math.min(decelerateMsRef.current, REDUCED_DECELERATE_MS)
          : decelerateMsRef.current;
        const progress = duration > 0 ? Math.min(1, (now - decelStartTime) / duration) : 1;
        const inv = 1 - progress;
        speedFactor = inv * inv;
        const shrinkEase = progress * progress * progress;
        const scale = Math.max(0.24, 1 - 0.76 * shrinkEase);
        const opacity = Math.max(0, 1 - Math.pow(progress, 1.35));
        stageEl.style.transform = `scale3d(${scale.toFixed(4)}, ${scale.toFixed(4)}, 1)`;
        stageEl.style.opacity = opacity.toFixed(4);
      }

      const angularVelocityDeg = baseRps * 360 * speedFactor;
      angleY = (angleY + angularVelocityDeg * dt) % 360;
      elapsed += dt * speedFactor;

      const tiltAmp = reducedMotion ? 4 : 13;
      const tiltX = Math.sin(elapsed * 0.55) * tiltAmp;
      sphereEl.style.transform = `rotateX(${tiltX.toFixed(2)}deg) rotateY(${angleY.toFixed(2)}deg)`;

      rafId = window.requestAnimationFrame(step);
    };

    stageEl.style.transform = 'scale3d(1, 1, 1)';
    stageEl.style.opacity = '1';
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
  }, [cardCount]);

  useEffect(() => {
    const clearHighlights = (indices) => {
      for (const idx of indices) {
        const el = cardRefs.current[idx];
        if (el) el.classList.remove('gs-sphere-card-hot');
      }
    };

    if (!highlight || decelerating || cardCount === 0) {
      for (let i = 0; i < cardRefs.current.length; i += 1) {
        const el = cardRefs.current[i];
        if (el) el.classList.remove('gs-sphere-card-hot');
      }
      return undefined;
    }

    let hotIndices = [];
    const reduced = getReducedMotionPreference();
    const intervalMs = reduced ? REDUCED_HIGHLIGHT_INTERVAL_MS : HIGHLIGHT_INTERVAL_MS;

    const tick = () => {
      clearHighlights(hotIndices);
      const pickCount = Math.min(cardCount, 1 + Math.floor(Math.random() * 3));
      const picked = new Set();
      let guard = 0;
      while (picked.size < pickCount && guard < 24) {
        picked.add(Math.floor(Math.random() * cardCount));
        guard += 1;
      }
      hotIndices = Array.from(picked);
      for (const idx of hotIndices) {
        const el = cardRefs.current[idx];
        if (el) el.classList.add('gs-sphere-card-hot');
      }
    };

    tick();
    const timer = setInterval(tick, intervalMs);

    return () => {
      clearInterval(timer);
      clearHighlights(hotIndices);
    };
  }, [highlight, decelerating, cardCount]);

  if (cardCount === 0) {
    return (
      <div className="gs-sphere-wrap">
        <div className="gs-sphere-empty">暂无参与人</div>
      </div>
    );
  }

  return (
    <div className="gs-sphere-wrap">
      <div className="gs-sphere-halo" aria-hidden="true" />
      <div ref={stageRef} className="gs-sphere-stage">
        <div ref={sphereRef} className="gs-sphere-body">
          {slots.map((slot, idx) => {
            const name = safeNames[activeIndices[idx]] || '';
            return (
              <div
                key={slot.key}
                className="gs-sphere-slot"
                style={{ transform: slot.transform }}
              >
                <div
                  className="gs-sphere-card"
                  ref={(el) => {
                    cardRefs.current[idx] = el;
                  }}
                >
                  <span className="gs-sphere-card-face gs-sphere-card-front">
                    {name}
                  </span>
                  <span className="gs-sphere-card-face gs-sphere-card-back" aria-hidden="true">
                    {name}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
