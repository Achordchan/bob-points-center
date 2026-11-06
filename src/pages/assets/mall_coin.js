// 余额页的 3D 币：滑动推近、翻面、拨转、下拉刷新；同时维护顶部应用栏和底部标签栏的状态。
// 只读写本文件创建或 mall.html 里 coin* 前缀的元素，余额和流水通过 #balance 的变化、bob:ledger 事件及 window.bobLatestLedger 快照获得。
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const reduce = (() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  })();

  // ---------- 币面图形 ----------
  let coinUid = 0;
  function coinSvg(withArc, top, bottom) {
    const id = 'bobc' + (++coinUid);
    let lathe = '';
    for (let r = 6; r < 70; r += 2.2) {
      lathe += `<circle cx="100" cy="100" r="${r.toFixed(1)}" fill="none" stroke="#FFF6D8" stroke-opacity="${r % 4.4 < 2.2 ? 0.07 : 0.03}" stroke-width="0.7"/>`;
    }
    const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<svg viewBox="0 0 200 200" width="100%" height="100%" aria-hidden="true">
  <defs>
    <radialGradient id="${id}f" cx="38%" cy="30%" r="80%"><stop offset="0" stop-color="#F8E6AC"/><stop offset=".38" stop-color="#E5BD5A"/><stop offset=".78" stop-color="#C5953A"/><stop offset="1" stop-color="#A2741F"/></radialGradient>
    <linearGradient id="${id}r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FBEBB8"/><stop offset=".5" stop-color="#D2A247"/><stop offset="1" stop-color="#7E5714"/></linearGradient>
    <linearGradient id="${id}l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8A611A"/><stop offset="1" stop-color="#FFF1C6"/></linearGradient>
    <linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".38"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <clipPath id="${id}k"><circle cx="100" cy="100" r="88"/></clipPath>
    <path id="${id}t" d="M 27,100 A 73,73 0 0 1 173,100"/>
    <path id="${id}b" d="M 18,100 A 82,82 0 0 0 182,100"/>
  </defs>
  <circle cx="100" cy="100" r="99.5" fill="#6E4C10"/>
  <circle cx="100" cy="100" r="98" fill="url(#${id}r)"/>
  <circle cx="100" cy="100" r="96.6" fill="none" stroke="#6E4C10" stroke-opacity=".35" stroke-width="2" stroke-dasharray=".6 1.1"/>
  <circle cx="100" cy="100" r="88" fill="url(#${id}f)"/>
  <circle cx="100" cy="100" r="88" fill="none" stroke="url(#${id}l)" stroke-width="1.6"/>
  <g clip-path="url(#${id}k)">${lathe}<rect x="-40" y="20" width="90" height="220" fill="url(#${id}s)" transform="rotate(-32 100 100)"/></g>
  <circle cx="100" cy="100" r="70" fill="none" stroke="#8A611A" stroke-opacity=".45" stroke-width=".8"/>
  <circle cx="100" cy="100" r="68.6" fill="none" stroke="#FFF1C6" stroke-opacity=".5" stroke-width=".6"/>
  ${withArc ? `<g font-family="-apple-system, PingFang SC, Noto Sans SC, sans-serif" font-weight="600" font-size="8.6" letter-spacing="2.4" fill="#6B4C10" fill-opacity=".85" text-anchor="middle">
    <text><textPath href="#${id}t" startOffset="50%">${esc(top)}</textPath></text>
    <text><textPath href="#${id}b" startOffset="50%">${esc(bottom)}</textPath></text>
  </g>` : ''}
</svg>`;
  }
  function paintCoin(el) {
    if (!el) return;
    const old = el.querySelector('svg');
    if (old) old.remove();
    el.insertAdjacentHTML('afterbegin', coinSvg(el.dataset.arc !== '0', el.dataset.top, el.dataset.bottom));
  }
  document.querySelectorAll('[data-coin]').forEach(paintCoin);

  // ---------- 元素 ----------
  const hero = $('coinHero');
  const coin = $('coin3d');
  const stage = $('coinStage');
  if (!hero || !coin || !stage) return;
  const backdrop = $('coinBackdrop');
  const shadow = $('coinShadow');
  const hit = $('coinHit');
  const frontInner = $('coinFrontInner');
  const backInner = $('coinBackInner');
  const sheen = $('coinSheen');
  const numEl = $('coinNum');
  const acts = $('coinActs');
  const note = $('coinNote');
  const toast = $('coinToast');
  const sheet = $('coinSheet');
  const pullTip = $('coinPullTip');
  const pullTipText = $('coinPullTipText');
  const topbar = document.querySelector('.topbar');
  const appBar = $('appBar');
  const appBarTitle = $('appBarTitle');
  const appBarBalance = $('appBarBalance');
  const balanceEl = $('balance');
  const tabBalance = $('tabBalance');
  const btnRefresh = $('btnRefresh');

  // 币的厚度：正反两面之间叠一圈边
  const LAYERS = 14;
  const GAP = 2.2;
  const front = $('coinFront');
  for (let i = 1; i <= LAYERS; i += 1) {
    const d = document.createElement('div');
    d.className = 'coinEdge';
    d.style.transform = `translateZ(${-i * GAP}px)`;
    if (i % 2) d.style.filter = 'brightness(1.12)';
    coin.insertBefore(d, front);
  }
  $('coinBack').style.transform = `translateZ(${-(LAYERS + 1) * GAP}px) rotateY(180deg)`;
  front.style.transform = 'translateZ(0.5px)';

  // ---------- 工具 ----------
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const rubber = (d, c = 150) => (d * c * 0.55) / (c + 0.55 * Math.abs(d));
  const mod360 = (v) => ((v % 360) + 360) % 360;

  function Spring(x, k, c) { return { x, v: 0, t: x, k, c }; }
  // 手势拖动时直接把弹簧钉在手指位置：目标跟着走，帧循环就不会把它拉回去
  function hold(s, x) { s.x = x; s.t = x; s.v = 0; }
  function stepSpring(s, dt) {
    if (reduce) { s.x = s.t; s.v = 0; return; }
    const a = -s.k * (s.x - s.t) - s.c * s.v;
    s.v += a * dt;
    s.x += s.v * dt;
    if (Math.abs(s.x - s.t) < 0.01 && Math.abs(s.v) < 0.01) { s.x = s.t; s.v = 0; }
  }
  const sp = {
    dx: Spring(0, 320, 13),
    dy: Spring(-46, 320, 13),
    rot: Spring(-180, 70, 11),
    tiltX: Spring(0, 260, 16),
    lift: Spring(1, 300, 18),
  };
  // 首次进入：币从背面转到正面、从上方落下
  sp.rot.t = 0;
  sp.dy.t = 0;
  if (reduce) { sp.dy.x = 0; sp.rot.x = 0; }
  let base = 0;
  let dragging = false;
  const springsIdle = () => Object.values(sp).every((s) => s.x === s.t && s.v === 0);
  // 手势用的弹簧偏活泼；从胶囊飞回时临时换成接近临界阻尼的一组，落定或有新手势时恢复
  const springBase = {};
  Object.keys(sp).forEach((k) => { springBase[k] = [sp[k].k, sp[k].c]; });
  const ARRIVE_SPRINGS = { dx: [170, 19.5], dy: [170, 19.5], lift: [200, 21] };
  function restoreSprings() {
    Object.keys(springBase).forEach((k) => { sp[k].k = springBase[k][0]; sp[k].c = springBase[k][1]; });
  }

  // ---------- 余额 ----------
  let shown = 0;
  let target = null;
  let rollFrom = 0;
  let rollStart = 0;
  let rollDur = 0;
  let firstBalance = true;
  function rollTo(v, delay, dur) {
    rollFrom = shown;
    target = v;
    rollStart = performance.now() + (delay || 0);
    rollDur = reduce ? 1 : (dur || 900);
    kick();
  }
  function readBalance() {
    const raw = String(balanceEl?.textContent || '').replace(/[^\d-]/g, '');
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
      target = null;
      numEl.textContent = '--';
      if (appBarBalance) appBarBalance.textContent = '--';
      return;
    }
    if (appBarBalance) appBarBalance.textContent = fmt(n);
    if (firstBalance) {
      firstBalance = false;
      shown = 0;
      rollTo(n, 250, 1000);
    } else if (n !== target) {
      rollTo(n, 0, 700);
    }
  }
  if (balanceEl) new MutationObserver(readBalance).observe(balanceEl, { childList: true, characterData: true, subtree: true });

  // ---------- 本周进出（币的背面） ----------
  const weekIn = $('coinWeekIn');
  const weekOut = $('coinWeekOut');
  const weekNet = $('coinWeekNet');
  const ledgerWeek = $('ledgerWeek');
  const backArt = $('coinBackArt');
  function weekStart() {
    const d = new Date();
    const day = (d.getDay() + 6) % 7;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day);
    return d;
  }
  const weekSr = $('coinWeekSr');
  function applyLedger(rowsIn) {
    const rows = Array.isArray(rowsIn) ? rowsIn : [];
    const ws = weekStart();
    const wsSec = ws.getTime() / 1000;
    let inc = 0;
    let out = 0;
    let inWeek = 0;
    rows.forEach((r) => {
      const t = Number(r?.created_at);
      const d = Number(r?.delta);
      if (!Number.isFinite(t) || !Number.isFinite(d) || t < wsSec) return;
      inWeek += 1;
      if (d > 0) inc += d; else out += -d;
    });
    // 一页最多 20 条，全在本周时可能还有更早的本周记录没加载到
    const partial = rows.length >= 20 && inWeek === rows.length;
    const net = inc - out;
    weekIn.textContent = `+${fmt(inc)}`;
    weekOut.textContent = `−${fmt(out)}`;
    weekNet.textContent = net > 0 ? `+${fmt(net)}` : (net < 0 ? `−${fmt(-net)}` : '0');
    if (weekSr) weekSr.textContent = `${partial ? '最近 20 笔' : '本周'}收入 ${weekIn.textContent}，支出 ${weekOut.textContent}，净额 ${weekNet.textContent} BOB 币`;
    const end = new Date(ws.getTime() + 6 * 86400000);
    const p2 = (n) => String(n).padStart(2, '0');
    backArt.dataset.bottom = partial ? '最近 20 笔' : `${p2(ws.getMonth() + 1)}.${p2(ws.getDate())} – ${p2(end.getMonth() + 1)}.${p2(end.getDate())}`;
    paintCoin(backArt);
    if (ledgerWeek) {
      ledgerWeek.innerHTML = inWeek
        ? `本周净${net >= 0 ? '收入' : '支出'} <b class="${net >= 0 ? 'good' : 'bad'}">${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</b>${partial ? '（最近 20 笔）' : ''}`
        : '';
    }
  }
  window.addEventListener('bob:ledger', (ev) => applyLedger(ev?.detail?.rows));
  // 首次流水若在本文件初始化前已渲染，事件已错过，用 mall.js 留下的快照补一次
  if (Array.isArray(window.bobLatestLedger)) applyLedger(window.bobLatestLedger);

  // ---------- 当前标签 ----------
  const tabNames = { balance: '余额', shop: '商城', market: '市场', orders: '订单', more: '更多' };
  let snapTimer = 0; // 推近吸附的延时任务，离开余额页时要取消
  function syncTab() {
    const on = tabBalance && !tabBalance.classList.contains('hidden');
    body.classList.toggle('onBalance', !!on);
    if (!on) { clearTimeout(snapTimer); snapTimer = 0; }
    const active = document.querySelector('.navBtn.active');
    const t = active?.getAttribute('data-tab') || 'balance';
    if (appBarTitle) appBarTitle.textContent = tabNames[t] || 'BOB 币中心';
    if (on) {
      layout();
      kick();
    } else {
      // 离开余额页时清掉逐帧写入的内联样式，交还给样式表
      if (appBar) { appBar.style.opacity = ''; appBar.style.transform = ''; appBar.style.pointerEvents = ''; }
      if (topbar) topbar.style.opacity = '';
    }
  }
  if (tabBalance) new MutationObserver(syncTab).observe(tabBalance, { attributes: true, attributeFilter: ['class'] });
  document.querySelectorAll('.navBtn').forEach((b) => new MutationObserver(syncTab).observe(b, { attributes: true, attributeFilter: ['class'] }));

  // ---------- 几何 ----------
  let W = 0;
  let H = 0;
  let D = 280;
  let heroTop = 0;
  let A = null;
  let B = null;
  function layout() {
    W = document.documentElement.clientWidth;
    H = window.innerHeight;
    const f = clamp(H / 844, 0.78, 1);
    const big = clamp(W / 390, 1, 1.5);
    D = Math.round(280 * f);
    A = { d: 256 * f, cy: 214 * f, num: 72 * Math.max(f, 0.9), acts: 378 * f, note: 434 * f, sheet: 470 * f };
    const bd = 600 * f * big;
    const bSheet = 404 * f;
    const bcy = bSheet + 14 - bd * 0.49;
    B = { d: bd, cy: bcy, num: 104 * (bd / 600), acts: bcy + 0.2 * bd, sheet: bSheet };
    heroTop = hero.getBoundingClientRect().top + window.scrollY;
    hero.style.height = `${Math.max(0, B.sheet + D - heroTop)}px`;
    sheet.style.minHeight = `${H}px`;
  }

  // ---------- 逐帧 ----------
  let cur = 0;
  let last = 0;
  let running = false;
  let entryT0 = 0;
  function kick() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  function frame(now) {
    const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000));
    last = now;
    if (!body.classList.contains('onBalance') || !A) { running = false; return; }
    // 弹窗打开时页面被固定，滚动位置不可信，保持现状
    const frozen = body.classList.contains('modalOpenFixed');
    const y = frozen ? (cur * D) : Math.max(0, window.scrollY);
    const raw = clamp(y / D, 0, 1);
    cur = reduce ? raw : cur + (raw - cur) * 0.2;
    if (Math.abs(raw - cur) < 0.0005) cur = raw;
    const p = ease(cur);
    const over = Math.max(0, y - D);

    if (!entryT0) entryT0 = now;
    const e = reduce ? 1 : clamp((now - entryT0) / 450, 0, 1);

    if (raw > 0.05 && !dragging && mod360(base) === 180) { base += 180; sp.rot.t = base; }
    Object.values(sp).forEach((s) => stepSpring(s, dt));

    const d = lerp(A.d, B.d, p);
    const s = d / 600;
    const cx = W / 2 + sp.dx.x * (1 - p);
    const baseCy = lerp(A.cy, B.cy, p) - over * 0.35;
    const cy = baseCy + sp.dy.x * (1 - p);
    const arc = Math.sin(Math.PI * cur);
    // 远景时略微前倾 10°，露出下沿的币厚；推近后转正
    const rx = 10 * (1 - p) + 26 * arc + sp.tiltX.x;
    const ry = -10 * arc + sp.rot.x;
    const rz = -4 * arc + sp.dx.x * 0.04;
    coin.style.transform = `translate3d(${cx}px, ${cy}px, 0) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${s * sp.lift.x})`;
    stage.style.opacity = e;
    const inner = lerp(A.num, B.num, p) / (104 * s);
    frontInner.style.transform = `translateY(${lerp(0, 8, p)}px) scale(${inner})`;
    backInner.style.transform = `scale(${inner})`;
    sheen.style.setProperty('--sx', `${lerp(4, 70, cur) + Math.sin((ry * Math.PI) / 180) * 45 + sp.tiltX.x}%`);

    const liftK = (sp.lift.x - 1) * 6;
    const turnK = 0.6 + 0.4 * Math.abs(Math.cos((ry * Math.PI) / 180));
    shadow.style.transform = `translate3d(${cx}px, ${baseCy + d * 0.5 + 18}px, 0) scale(${(d / 220) * (1 - arc * 0.25) * (1 - liftK * 0.3) * turnK}, ${1 - arc * 0.4})`;
    shadow.style.opacity = String((1 - p) * (1 - liftK * 0.5) * clamp(1 + sp.dy.x / 200, 0.3, 1));

    hit.style.transform = `translate3d(${W / 2}px, ${A.cy}px, 0)`;
    hit.style.width = hit.style.height = `${A.d + 4}px`;
    hit.style.margin = `${-(A.d + 4) / 2}px 0 0 ${-(A.d + 4) / 2}px`;
    hit.style.pointerEvents = cur < 0.06 ? 'auto' : 'none';

    const pull = Math.max(0, sp.dy.x);
    pullTip.style.opacity = String(clamp(pull / 50, 0, 1) * (dragging ? 1 : 0.6));
    pullTip.style.transform = `translateY(${pull * 0.25}px)`;

    if (target !== null && rollDur && now >= rollStart) {
      const t = clamp((now - rollStart) / rollDur, 0, 1);
      shown = lerp(rollFrom, target, 1 - Math.pow(1 - t, 4));
      if (t >= 1) { rollDur = 0; shown = target; }
    }
    if (target !== null) numEl.textContent = fmt(shown);

    acts.style.transform = `translate3d(0, ${lerp(A.acts, B.acts, p) - over * 0.35 + (1 - e) * 16}px, 0)`;
    acts.style.opacity = String(e);
    acts.style.setProperty('--ga', (0.4 * p).toFixed(3));
    note.style.transform = `translate3d(0, ${A.note - y * 0.6}px, 0)`;
    note.style.opacity = String(clamp(1 - cur * 3, 0, 1) * e);

    // 抽屉：推近阶段跟进度走，之后自然随页面滚动
    const sheetVisual = y <= D ? lerp(A.sheet, B.sheet, y / D) : B.sheet - over;
    const sheetShift = y <= D ? lerp(A.sheet, B.sheet, y / D) - (B.sheet + D - y) : 0;
    sheet.style.transform = `translate3d(0, ${sheetShift + (1 - e) * 40}px, 0)`;
    sheet.style.setProperty('--sa', (0.08 + 0.12 * p).toFixed(3));

    const appH = appBar ? appBar.offsetHeight : 56;
    const hb = clamp((appH + 110 - sheetVisual) / 60, 0, 1);
    if (appBar) {
      appBar.style.opacity = String(hb);
      appBar.style.transform = `translateY(${(1 - hb) * -8}px)`;
      appBar.style.pointerEvents = hb > 0.5 ? 'auto' : 'none';
    }
    if (topbar) topbar.style.opacity = String(1 - hb);

    const c0 = [251, 248, 241];
    const c1 = [233, 221, 195];
    if (backdrop) backdrop.style.background = `rgb(${c0.map((v, i) => Math.round(lerp(v, c1[i], p))).join(',')})`;

    const moving = dragging || Math.abs(raw - cur) > 0 || !springsIdle() || e < 1 || (rollDur && target !== null);
    if (moving) requestAnimationFrame(frame); else { running = false; restoreSprings(); }
  }

  window.addEventListener('scroll', kick, { passive: true });
  window.addEventListener('resize', () => { if (body.classList.contains('onBalance')) { layout(); kick(); } });

  // 推近途中松手，吸附到最近的一端
  const canSnap = () => body.classList.contains('onBalance') && !body.classList.contains('modalOpenFixed');
  window.addEventListener('scroll', () => {
    clearTimeout(snapTimer);
    snapTimer = 0;
    if (!canSnap()) return;
    snapTimer = setTimeout(() => {
      snapTimer = 0;
      // 等待期间可能已切走标签或打开弹窗，执行时再确认一次
      if (!canSnap()) return;
      const y = window.scrollY;
      if (y > 4 && y < D - 4) window.scrollTo({ top: y < D * 0.45 ? 0 : D, behavior: reduce ? 'auto' : 'smooth' });
    }, 140);
  }, { passive: true });

  // ---------- 手势：轻点翻面 / 左右拨转 / 下拉刷新 / 上推看流水 ----------
  let start = null;
  let mode = null;
  let lastPt = null;
  let vel = { x: 0, y: 0 };
  const PULL = 90;
  const PUSH = 80;

  function flip(dir) {
    restoreSprings();
    base += 180 * (dir || 1);
    sp.rot.t = base;
    sp.rot.v = 520 * (dir || 1);
    sp.lift.x = 1.12;
    sp.lift.v = 1.2;
    sp.dy.v = -420;
    hit.setAttribute('aria-pressed', mod360(base) === 180 ? 'true' : 'false');
    kick();
  }

  hit.addEventListener('pointerdown', (ev) => {
    try { hit.setPointerCapture(ev.pointerId); } catch (_) {}
    restoreSprings();
    dragging = true;
    mode = null;
    start = { x: ev.clientX, y: ev.clientY, t: performance.now(), rot: sp.rot.x };
    lastPt = { x: ev.clientX, y: ev.clientY, t: start.t };
    vel = { x: 0, y: 0 };
    sp.lift.t = 1.05;
    kick();
  });
  hit.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const now = performance.now();
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    const dtm = Math.max(1, now - lastPt.t);
    vel = { x: (ev.clientX - lastPt.x) / dtm, y: (ev.clientY - lastPt.y) / dtm };
    lastPt = { x: ev.clientX, y: ev.clientY, t: now };
    if (!mode && Math.hypot(dx, dy) > 6) mode = Math.abs(dx) > Math.abs(dy) ? 'turn' : 'pull';
    if (mode === 'turn') {
      hold(sp.rot, start.rot + dx * 0.75);
      hold(sp.dx, rubber(dx * 0.35, 60));
      hold(sp.tiltX, clamp(-dy * 0.08, -10, 10));
    } else if (mode === 'pull') {
      hold(sp.dy, rubber(dy));
      hold(sp.tiltX, clamp(-sp.dy.x * 0.22, -22, 22));
      hold(sp.dx, rubber(dx * 0.3, 40));
      pullTipText.textContent = dy > PULL ? '松手刷新余额' : '继续下拉刷新余额';
    }
  });
  let lastPointerUp = 0;
  function release(ev) {
    if (!dragging) return;
    dragging = false;
    if (ev.type === 'pointerup') lastPointerUp = performance.now();
    sp.lift.t = 1;
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    const quick = performance.now() - start.t < 260 && Math.hypot(dx, dy) < 8;
    if (!mode && quick && ev.type === 'pointerup') {
      flip(1);
    } else if (mode === 'turn') {
      const turned = sp.rot.x - base;
      const flick = vel.x * 1000 * 0.75;
      const proj = turned + flick * 0.18;
      if (Math.abs(proj) > 90) base += 180 * (Math.round(proj / 180) || Math.sign(proj));
      sp.rot.t = base;
      sp.rot.v = flick;
      hit.setAttribute('aria-pressed', mod360(base) === 180 ? 'true' : 'false');
    } else if (mode === 'pull') {
      if (dy > PULL) refresh();
      else if (dy < -PUSH) window.scrollTo({ top: D, behavior: reduce ? 'auto' : 'smooth' });
      sp.dy.v = -vel.y * 400;
    }
    sp.dy.t = 0;
    sp.dx.t = 0;
    sp.tiltX.t = 0;
    mode = null;
    kick();
  }
  hit.addEventListener('pointerup', release);
  hit.addEventListener('pointercancel', release);
  hit.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); flip(1); }
  });
  // 读屏等辅助技术只合成 click，不带指针事件；指针手势结束后浏览器补发的 click 已由 release 处理过，跳过
  hit.addEventListener('click', () => {
    if (performance.now() - lastPointerUp < 600) return;
    flip(1);
  });

  // ---------- 刷新：币边转边回弹，数字滚到新值 ----------
  let toastTimer = 0;
  let refreshing = false;
  function spin() {
    restoreSprings();
    if (mod360(base) === 180) base += 180;
    base += 720;
    sp.rot.t = base;
    sp.rot.v = 900;
    sp.lift.x = 1.08;
    kick();
  }
  function showToast(text, ok) {
    toast.textContent = text;
    toast.style.color = ok ? '' : 'var(--debit)';
    note.classList.add('toasting');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => note.classList.remove('toasting'), 2200);
  }
  function refresh() {
    if (refreshing || !btnRefresh || btnRefresh.disabled) return;
    refreshing = true;
    spin();
    btnRefresh.classList.add('spinning');
    window.dispatchEvent(new CustomEvent('bob:refresh-balance'));
  }
  window.addEventListener('bob:balance-refreshed', (ev) => {
    refreshing = false;
    if (btnRefresh) btnRefresh.classList.remove('spinning');
    const ok = !!ev?.detail?.ok;
    const t = new Date();
    showToast(ok ? `余额已更新 · ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '刷新失败，请稍后再试', ok);
  });
  // 顶部刷新按钮：同样让币转一下
  if (btnRefresh) btnRefresh.addEventListener('click', () => { if (body.classList.contains('onBalance')) spin(); });

  // ---------- 顶部余额胶囊：点一下回到余额页，币从胶囊里飞出来落到中央 ----------
  const chip = $('appBarChip');
  function arriveFrom(rect) {
    layout();
    // 舞台是 fixed 全屏层，币心在视口坐标 (W/2 + dx, A.cy + dy)；把起点放到胶囊里的小币上，弹簧负责把它带回中央
    cur = 0;
    if (mod360(base) === 180) base += 180;
    sp.dx.x = rect.left + rect.width / 2 - W / 2;
    sp.dy.x = rect.top + rect.height / 2 - A.cy;
    sp.lift.x = Math.max(0.06, rect.height / A.d);
    sp.rot.x = base - 360;
    sp.tiltX.x = 18;
    ['dx', 'dy', 'lift', 'rot', 'tiltX'].forEach((k) => { sp[k].v = 0; });
    Object.keys(ARRIVE_SPRINGS).forEach((k) => { [sp[k].k, sp[k].c] = ARRIVE_SPRINGS[k]; });
    sp.dx.t = 0;
    sp.dy.t = 0;
    sp.lift.t = 1;
    sp.rot.t = base;
    sp.tiltX.t = 0;
    hit.setAttribute('aria-pressed', 'false');
    kick();
  }
  if (chip) {
    chip.addEventListener('click', () => {
      // 已在余额页（滑到了流水）：平滑回到币面
      if (body.classList.contains('onBalance')) {
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
        return;
      }
      const navBalance = document.querySelector('.navBtn[data-tab="balance"]');
      if (!navBalance) return;
      const mini = chip.querySelector('.miniCoin') || chip;
      const rect = mini.getBoundingClientRect();
      navBalance.click();
      syncTab();
      if (!body.classList.contains('onBalance')) return;
      arriveFrom(rect);
    });
  }

  // ---------- 启动 ----------
  syncTab();
  readBalance();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { layout(); kick(); });
  layout();
  kick();
})();
