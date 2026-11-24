import React, { useEffect, useRef } from 'react';

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const NORMAL_PARTICLE_COUNT = 120;
const REDUCED_PARTICLE_COUNT = 36;

const GOLD_PALETTE = [
  '255, 236, 179',
  '245, 199, 107',
  '232, 168, 56',
];

const RED_PALETTE = [
  '235, 77, 92',
  '214, 48, 65',
  '255, 126, 107',
];

const GLOW_ORBS = [
  { baseX: 960, baseY: 460, radius: 560, color: '245, 199, 107', alpha: 0.11, driftX: 48, driftY: 24, speed: 0.32, phase: 0 },
  { baseX: 460, baseY: 760, radius: 480, color: '196, 36, 56', alpha: 0.14, driftX: 60, driftY: 34, speed: 0.25, phase: 1.7 },
  { baseX: 1480, baseY: 720, radius: 500, color: '180, 30, 50', alpha: 0.13, driftX: 54, driftY: 30, speed: 0.28, phase: 3.4 },
  { baseX: 960, baseY: 960, radius: 620, color: '218, 138, 42', alpha: 0.08, driftX: 36, driftY: 20, speed: 0.2, phase: 4.8 },
];

function createParticle(randomY) {
  const isGold = Math.random() < 0.7;
  const palette = isGold ? GOLD_PALETTE : RED_PALETTE;
  const color = palette[Math.floor(Math.random() * palette.length)];
  const radius = isGold ? 1.4 + Math.random() * 3.8 : 1.6 + Math.random() * 3.2;

  return {
    x: Math.random() * CANVAS_WIDTH,
    y: randomY ? Math.random() * CANVAS_HEIGHT : CANVAS_HEIGHT + 16 + Math.random() * 60,
    radius,
    vy: 14 + Math.random() * 34,
    swayAmp: 10 + Math.random() * 26,
    swaySpeed: 0.4 + Math.random() * 0.85,
    phase: Math.random() * Math.PI * 2,
    twinkleSpeed: 1.1 + Math.random() * 2.2,
    twinklePhase: Math.random() * Math.PI * 2,
    baseAlpha: 0.28 + Math.random() * 0.56,
    color,
    hasHalo: isGold && radius > 3.2,
  };
}

function getReducedMotionPreference() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function IdleView({ event, names, ready }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let reducedMotion = getReducedMotionPreference();
    let mediaQuery = null;
    let particles = [];
    let rafId = 0;
    let lastTime = 0;
    let elapsed = 0;

    const rebuildParticles = () => {
      const count = reducedMotion ? REDUCED_PARTICLE_COUNT : NORMAL_PARTICLE_COUNT;
      particles = Array.from({ length: count }, () => createParticle(true));
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
      const motionScale = reducedMotion ? 0.16 : 1;
      elapsed += dt * motionScale;

      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      for (const orb of GLOW_ORBS) {
        const cx = orb.baseX + Math.sin(elapsed * orb.speed + orb.phase) * orb.driftX;
        const cy = orb.baseY + Math.cos(elapsed * orb.speed * 0.8 + orb.phase) * orb.driftY;
        const pulse = 0.86 + 0.14 * Math.sin(elapsed * 0.7 + orb.phase);
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, orb.radius);
        grad.addColorStop(0, `rgba(${orb.color}, ${(orb.alpha * pulse).toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(${orb.color}, ${(orb.alpha * 0.35 * pulse).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${orb.color}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, orb.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        p.y -= p.vy * dt * motionScale;
        if (p.y < -24) {
          particles[i] = createParticle(false);
          continue;
        }

        const drawX = p.x + Math.sin(elapsed * p.swaySpeed + p.phase) * p.swayAmp;
        const twinkle = reducedMotion
          ? 0.85
          : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(elapsed * p.twinkleSpeed + p.twinklePhase));
        const alpha = p.baseAlpha * twinkle;

        if (p.hasHalo) {
          const haloRadius = p.radius * 3.8;
          const halo = ctx.createRadialGradient(drawX, p.y, 0, drawX, p.y, haloRadius);
          halo.addColorStop(0, `rgba(${p.color}, ${(alpha * 0.7).toFixed(3)})`);
          halo.addColorStop(0.45, `rgba(${p.color}, ${(alpha * 0.22).toFixed(3)})`);
          halo.addColorStop(1, `rgba(${p.color}, 0)`);
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(drawX, p.y, haloRadius, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = `rgba(${p.color}, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(drawX, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
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
  const participantCount = event ? event.participant_count : names.length;

  return (
    <section className="gs-idle">
      <canvas
        ref={canvasRef}
        className="gs-idle-canvas"
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        aria-hidden="true"
      />
      <div className="gs-idle-content">
        <div className="gs-ornament-line" aria-hidden="true">
          <span className="gs-ornament-rule" />
          <span className="gs-ornament-diamond" />
          <span className="gs-ornament-rule" />
        </div>

        <h1 className="gs-idle-title">{title}</h1>

        {eventDate ? (
          <div className="gs-idle-date-row">
            <span className="gs-idle-date-line" aria-hidden="true" />
            <p className="gs-idle-date">{eventDate}</p>
            <span className="gs-idle-date-line" aria-hidden="true" />
          </div>
        ) : null}

        <div className="gs-idle-count-badge">
          <span className="gs-idle-count-text">参与人数</span>
          <span className="gs-idle-count-value">{participantCount}</span>
          <span className="gs-idle-count-text">人</span>
        </div>

        <div className="gs-ornament-line gs-ornament-line-bottom" aria-hidden="true">
          <span className="gs-ornament-rule" />
          <span className="gs-ornament-diamond" />
          <span className="gs-ornament-rule" />
        </div>
      </div>
    </section>
  );
}
