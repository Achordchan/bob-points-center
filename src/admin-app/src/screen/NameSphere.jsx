import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SPHERE_CARD_BASE_FONT_PX, computeSphereNameFit } from './nameFit.js';

const MAX_SPHERE_CARDS = 120;
const SWAP_INTERVAL_MS = 2500;
const SWAP_BATCH_SIZE = 10;
const MAX_CONCURRENT_FLASH = 3;
const FLASH_RISE_MS = 180;
const FLASH_FADE_MS = 400;
const FLASH_TOTAL_MS = FLASH_RISE_MS + FLASH_FADE_MS;
const FLASH_TICK_MS = 260;
const REDUCED_FLASH_TICK_MS = 640;
const DEFAULT_SPEED_RPS = 0.65;
const REDUCED_SPEED_RPS = 0.08;
const RAMP_START_FACTOR = 0.12;
const DEFAULT_RADIUS_PX = 420;
const SPHERE_DEPTH_OFFSET_PX = 320;
const DEFAULT_DECELERATE_MS = 1200;
const REDUCED_DECELERATE_MS = 240;
const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5));
const RAD_TO_DEG = 180 / Math.PI;
const NORMAL_TILT_AMP_DEG = 6;
const REDUCED_TILT_AMP_DEG = 3;

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

// 保证不镜像：槽位按 rotateY(lon) rotateX(-lat) translateZ(+r) 使每张卡片法线严格指向球外；
// .gs-sphere-body 保持纯粹 preserve-3d（不设 opacity/will-change: opacity 以免压平 3D 上下文），
// 卡片正反两面均设 backface-visibility: hidden 且背面 rotateY(180deg)，前半球显正向正面、后半球显正向 25% 透明背面。
function computeFibonacciSlots(count, radius) {
  if (count <= 0) return [];
  const slots = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const latDeg = Math.asin(Math.max(-1, Math.min(1, y))) * RAD_TO_DEG;
    const lonDeg = ((i * GOLDEN_ANGLE_RAD) * RAD_TO_DEG) % 360;
    slots[i] = {
      key: i,
      transform: `translate3d(-50%, -50%, 0) rotateY(${lonDeg.toFixed(2)}deg) rotateX(${(-latDeg).toFixed(2)}deg) translateZ(${radius}px)`,
    };
  }
  return slots;
}

export default function NameSphere({
  names,
  speed = DEFAULT_SPEED_RPS,
  rampUpMs = 0,
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

  const viewportRef = useRef(null);
  const sphereRef = useRef(null);
  const cardRefs = useRef([]);
  const speedRef = useRef(speed);
  const rampUpMsRef = useRef(rampUpMs);
  const deceleratingRef = useRef(decelerating);
  const decelerateKeyRef = useRef(decelerateKey);
  const decelerateMsRef = useRef(decelerateDurationMs);
  const decelTriggerRef = useRef(decelerating);

  speedRef.current = speed;
  rampUpMsRef.current = rampUpMs;
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
    const viewportEl = viewportRef.current;
    if (!sphereEl || !viewportEl) return undefined;

    let reducedMotion = getReducedMotionPreference();
    let mediaQuery = null;
    let rafId = 0;
    let lastTime = 0;
    let rampStartTime = null;
    let angleY = 0;
    let elapsed = 0;
    let decelStartTime = null;
    let isDecelActive = false;
    let opacityDirty = false;

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
      if (rampStartTime === null) {
        rampStartTime = now;
      }
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
        if (opacityDirty) {
          viewportEl.style.opacity = '1';
          opacityDirty = false;
        }
      }

      const baseRps = reducedMotion
        ? Math.min(speedRef.current, REDUCED_SPEED_RPS)
        : speedRef.current;

      let speedFactor = 1;
      let scale = 1;

      if (isDecelActive && decelStartTime !== null) {
        const duration = reducedMotion
          ? Math.min(decelerateMsRef.current, REDUCED_DECELERATE_MS)
          : decelerateMsRef.current;
        const progress = duration > 0 ? Math.min(1, (now - decelStartTime) / duration) : 1;
        const inv = 1 - progress;
        const easeOut = 1 - inv * inv * inv;
        speedFactor = inv * inv;
        scale = Math.max(0.12, 1 - 0.88 * easeOut);
        const opacity = Math.max(0, 1 - Math.pow(progress, 1.45));
        // 透明度挂在外层透视容器而非 preserve-3d 球体本身，避免减速阶段压平 3D 层级
        viewportEl.style.opacity = opacity.toFixed(4);
        opacityDirty = true;
      } else if (!reducedMotion && rampUpMsRef.current > 0) {
        const rampProgress = Math.min(1, (now - rampStartTime) / rampUpMsRef.current);
        speedFactor = RAMP_START_FACTOR + (1 - RAMP_START_FACTOR) * rampProgress * rampProgress;
      }

      const angularVelocityDeg = baseRps * 360 * speedFactor;
      angleY = (angleY + angularVelocityDeg * dt) % 360;
      elapsed += dt * speedFactor;

      const tiltAmp = reducedMotion ? REDUCED_TILT_AMP_DEG : NORMAL_TILT_AMP_DEG;
      const tiltX = Math.sin(elapsed * 0.5) * tiltAmp;

      if (scale < 0.9999) {
        const s = scale.toFixed(4);
        sphereEl.style.transform = `translate3d(0, 0, -${SPHERE_DEPTH_OFFSET_PX}px) scale3d(${s}, ${s}, ${s}) rotateX(${tiltX.toFixed(2)}deg) rotateY(${angleY.toFixed(2)}deg)`;
      } else {
        sphereEl.style.transform = `translate3d(0, 0, -${SPHERE_DEPTH_OFFSET_PX}px) rotateX(${tiltX.toFixed(2)}deg) rotateY(${angleY.toFixed(2)}deg)`;
      }

      rafId = window.requestAnimationFrame(step);
    };

    viewportEl.style.opacity = '1';
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
    const clearAllFlashes = () => {
      for (let i = 0; i < cardRefs.current.length; i += 1) {
        const el = cardRefs.current[i];
        if (el) el.classList.remove('gs-sphere-card-flash');
      }
    };

    if (!highlight || decelerating || cardCount === 0) {
      clearAllFlashes();
      return undefined;
    }

    const activeFlashes = new Map();
    const reduced = getReducedMotionPreference();
    const tickMs = reduced ? REDUCED_FLASH_TICK_MS : FLASH_TICK_MS;
    const maxActive = Math.min(MAX_CONCURRENT_FLASH, cardCount);

    const triggerFlash = () => {
      if (activeFlashes.size >= maxActive) return;

      let picked = -1;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = Math.floor(Math.random() * cardCount);
        if (!activeFlashes.has(candidate)) {
          picked = candidate;
          break;
        }
      }
      if (picked < 0) return;

      const cardEl = cardRefs.current[picked];
      if (!cardEl) return;

      cardEl.classList.add('gs-sphere-card-flash');

      const offTimer = setTimeout(() => {
        const currentEl = cardRefs.current[picked];
        if (currentEl) currentEl.classList.remove('gs-sphere-card-flash');
      }, FLASH_RISE_MS);

      const doneTimer = setTimeout(() => {
        activeFlashes.delete(picked);
      }, FLASH_TOTAL_MS);

      activeFlashes.set(picked, { offTimer, doneTimer });
    };

    triggerFlash();
    const intervalId = setInterval(triggerFlash, tickMs);

    return () => {
      clearInterval(intervalId);
      for (const entry of activeFlashes.values()) {
        clearTimeout(entry.offTimer);
        clearTimeout(entry.doneTimer);
      }
      activeFlashes.clear();
      clearAllFlashes();
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
    <div className={decelerating ? 'gs-sphere-wrap gs-sphere-wrap-decelerating' : 'gs-sphere-wrap'}>
      <div
        className="gs-sphere-halo"
        style={decelerating ? { animationDuration: `${decelerateDurationMs}ms` } : undefined}
        aria-hidden="true"
      />
      <div ref={viewportRef} className="gs-sphere-viewport">
        <div ref={sphereRef} className="gs-sphere-body">
          {slots.map((slot, idx) => {
            const name = safeNames[activeIndices[idx]] || '';
            const fit = computeSphereNameFit(name);
            const textClass = fit.lines > 1 ? 'gs-sphere-card-text gs-sphere-card-text-wrap' : 'gs-sphere-card-text';
            const textStyle = fit.lines > 1
              ? { fontSize: `${fit.fontSize}px`, WebkitLineClamp: fit.lines }
              : fit.fontSize < SPHERE_CARD_BASE_FONT_PX ? { fontSize: `${fit.fontSize}px` } : undefined;
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
                  <div className="gs-sphere-card-face gs-sphere-card-front">
                    <span className={textClass} style={textStyle}>{name}</span>
                  </div>
                  <div className="gs-sphere-card-face gs-sphere-card-back" aria-hidden="true">
                    <span className={textClass} style={textStyle}>{name}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
