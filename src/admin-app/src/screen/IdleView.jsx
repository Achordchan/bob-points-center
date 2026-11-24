import React, { useEffect, useRef, useState } from 'react';

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const NORMAL_PARTICLE_COUNT = 80;
const REDUCED_PARTICLE_COUNT = 24;
const COUNT_ANIMATION_MS = 1200;

const DUST_PALETTE = [
  '246, 213, 142',
  '201, 151, 59',
  '255, 244, 220',
];

function createDustParticle(randomY) {
  const blurred = Math.random() < 0.3;
  const color = DUST_PALETTE[Math.floor(Math.random() * DUST_PALETTE.length)];
  const radius = blurred
    ? 1.1 + Math.random() * 0.9
    : 0.65 + Math.random() * 0.95;

  return {
    x: Math.random() * CANVAS_WIDTH,
    y: randomY ? Math.random() * CANVAS_HEIGHT : CANVAS_HEIGHT + 12 + Math.random() * 48,
    radius,
    vy: 5 + Math.random() * 10,
    swayAmp: 4 + Math.random() * 10,
    swaySpeed: 0.12 + Math.random() * 0.22,
    phase: Math.random() * Math.PI * 2,
    twinkleSpeed: 0.35 + Math.random() * 0.75,
    twinklePhase: Math.random() * Math.PI * 2,
    baseAlpha: 0.15 + Math.random() * 0.35,
    color,
    blurred,
  };
}

function getReducedMotionPreference() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function IdleView({ event, names, ready }) {
  const sharpCanvasRef = useRef(null);
  const blurCanvasRef = useRef(null);

  const rawCount = event ? event.participant_count : names.length;
  const participantCount = Math.max(0, Math.floor(Number(rawCount) || 0));

  const [displayCount, setDisplayCount] = useState(0);
  const displayedRef = useRef(0);

  useEffect(() => {
    if (getReducedMotionPreference()) {
      displayedRef.current = participantCount;
      setDisplayCount(participantCount);
      return undefined;
    }

    const startValue = displayedRef.current;
    const delta = participantCount - startValue;
    if (delta === 0) {
      setDisplayCount(participantCount);
      return undefined;
    }

    let rafId = 0;
    let startTime = null;

    const tick = (now) => {
      if (startTime === null) {
        startTime = now;
      }
      const progress = Math.min(1, (now - startTime) / COUNT_ANIMATION_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextValue = Math.round(startValue + delta * eased);

      if (nextValue !== displayedRef.current) {
        displayedRef.current = nextValue;
        setDisplayCount(nextValue);
      }

      if (progress < 1) {
        rafId = window.requestAnimationFrame(tick);
      } else {
        displayedRef.current = participantCount;
        setDisplayCount(participantCount);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [participantCount]);

  useEffect(() => {
    const sharpCanvas = sharpCanvasRef.current;
    const blurCanvas = blurCanvasRef.current;
    if (!sharpCanvas || !blurCanvas) return undefined;
    const sharpCtx = sharpCanvas.getContext('2d');
    const blurCtx = blurCanvas.getContext('2d');
    if (!sharpCtx || !blurCtx) return undefined;

    let reducedMotion = getReducedMotionPreference();
    let mediaQuery = null;
    let particles = [];
    let rafId = 0;
    let lastTime = 0;
    let elapsed = 0;

    const rebuildParticles = () => {
      const count = reducedMotion ? REDUCED_PARTICLE_COUNT : NORMAL_PARTICLE_COUNT;
      particles = Array.from({ length: count }, () => createDustParticle(true));
    };

    const handleMotionChange = (evt) => {
      reducedMotion = Boolean(evt.matches);
      rebuildParticles();
    };

    if (typeof window.matchMedia === 'function') {
      mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handleMotionChange);
      } else if (typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(handleMotionChange);
      }
    }

    rebuildParticles();

    const renderFrame = (now) => {
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0;
      lastTime = now;
      const motionScale = reducedMotion ? 0.2 : 1;
      elapsed += dt * motionScale;

      sharpCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      blurCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        p.y -= p.vy * dt * motionScale;
        if (p.y < -16) {
          particles[i] = createDustParticle(false);
          continue;
        }

        const drawX = p.x + Math.sin(elapsed * p.swaySpeed + p.phase) * p.swayAmp;
        const twinkle = reducedMotion
          ? 0.9
          : 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(elapsed * p.twinkleSpeed + p.twinklePhase));
        const alpha = Math.max(0.15, Math.min(0.5, p.baseAlpha * twinkle));

        const targetCtx = p.blurred ? blurCtx : sharpCtx;
        targetCtx.fillStyle = `rgba(${p.color}, ${alpha.toFixed(3)})`;
        targetCtx.beginPath();
        targetCtx.arc(drawX, p.y, p.radius, 0, Math.PI * 2);
        targetCtx.fill();
      }

      rafId = window.requestAnimationFrame(renderFrame);
    };

    rafId = window.requestAnimationFrame(renderFrame);

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
  }, []);

  const title = event?.title || (ready ? '年度盛典' : '');
  const eventDate = event?.event_date || '';

  return (
    <section className="gs-idle">
      <canvas
        ref={sharpCanvasRef}
        className="gs-idle-canvas"
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        aria-hidden="true"
      />
      <canvas
        ref={blurCanvasRef}
        className="gs-idle-canvas gs-idle-canvas-blur"
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        aria-hidden="true"
      />

      <div className="gs-idle-content">
        <div className="gs-ornament-line" aria-hidden="true">
          <span className="gs-ornament-rule gs-ornament-rule-left" />
          <span className="gs-ornament-diamond" />
          <span className="gs-ornament-rule gs-ornament-rule-right" />
        </div>

        <div className="gs-idle-title-wrap">
          <h1 className="gs-idle-title">{title}</h1>
          {title ? (
            <span className="gs-idle-title-sheen" aria-hidden="true">
              {title}
            </span>
          ) : null}
        </div>

        <div className="gs-ornament-line gs-ornament-line-bottom" aria-hidden="true">
          <span className="gs-ornament-rule gs-ornament-rule-left" />
          <span className="gs-ornament-diamond" />
          <span className="gs-ornament-rule gs-ornament-rule-right" />
        </div>

        <div className="gs-idle-meta">
          {eventDate ? (
            <p className="gs-idle-date">{eventDate}</p>
          ) : null}
          <p className="gs-idle-count">
            <span className="gs-idle-count-value">{displayCount}</span>
            <span className="gs-idle-count-unit"> 位伙伴已入场</span>
          </p>
        </div>
      </div>
    </section>
  );
}
