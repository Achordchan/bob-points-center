(function () {
  const fetchJson = window.BOB.fetchJson;
  const escapeHtml = window.BOB.escapeHtml;

  const state = {
    payload: null,
    offsetSec: 0,
    tickTimer: null,
    clockTimer: null,
    lastClaimKey: null,
    streamNotice: '',
    eventsSource: null,
    realtimeTimers: {},
    hasSeenRealtimeSnapshot: false,
  };

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setVisible(id, visible) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('hidden', !visible);
  }

  function setScreenStreamNotice(text) {
    state.streamNotice = text ? String(text) : '';
    setText('screenSub', state.streamNotice || '好运开场，红包来袭');
  }

  function clearRealtimeTasks() {
    Object.keys(state.realtimeTimers || {}).forEach((key) => {
      if (state.realtimeTimers[key]) {
        clearTimeout(state.realtimeTimers[key]);
      }
      state.realtimeTimers[key] = null;
    });
  }

  function closeScreenRealtime({ keepNotice = false } = {}) {
    if (state.eventsSource) {
      state.eventsSource.close();
      state.eventsSource = null;
    }
    clearRealtimeTasks();
    if (!keepNotice) {
      setScreenStreamNotice('');
    }
  }

  function formatTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '-';
    const d = new Date(n * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function formatCountdown(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000) + (state.offsetSec || 0);
  }

  function renderCountdown(activity) {
    if (!activity) {
      setText('screenCountdownLabel', '等待活动');
      setText('screenCountdown', '--:--');
      return;
    }
    const now = nowSec();
    const startAt = Number(activity.start_at || 0);
    const endAt = Number(activity.end_at || 0);
    if (now < startAt) {
      setText('screenCountdownLabel', '距离开始');
      setText('screenCountdown', formatCountdown(startAt - now));
      return;
    }
    if (now < endAt) {
      setText('screenCountdownLabel', '距离结束');
      setText('screenCountdown', formatCountdown(endAt - now));
      return;
    }
    setText('screenCountdownLabel', '活动结束');
    setText('screenCountdown', '00:00');
  }

  function setCountdownText(text) {
    const el = document.getElementById('screenCountdown');
    if (!el) return;
    if (el.textContent !== text) {
      el.textContent = text;
      el.classList.remove('pulse');
      void el.offsetWidth;
      el.classList.add('pulse');
    }
  }

  function renderClaims(list, markNew) {
    const wrap = document.getElementById('screenRecentList');
    if (!wrap) return;
    const rows = Array.isArray(list) ? list : [];
    if (rows.length === 0) {
      wrap.innerHTML = '<div class="feedItem"><span class="feedName">等待第一个红包</span><span class="feedAmount">好运将至</span></div>';
      return;
    }
    wrap.innerHTML = rows
      .map((x, idx) => {
        const nameRaw = x?.name ? String(x.name) : '';
        const useridRaw = x?.userid ? String(x.userid) : '';
        const displayName = escapeHtml(nameRaw || useridRaw || '-');
        const amount = Number(x?.amount);
        const amountText = escapeHtml(Number.isFinite(amount) ? `${amount} BOB` : '-');
        const timeText = escapeHtml(formatTime(x?.claimed_at));
        const newClass = markNew && idx === 0 ? ' new' : '';
        return (
          `<div class="feedItem${newClass}">` +
          `<div>` +
          `<div class="feedName">${displayName}</div>` +
          `<div class="feedTime">${timeText}</div>` +
          `</div>` +
          `<div class="feedAmount">${amountText}</div>` +
          `</div>`
        );
      })
      .join('');
  }

  function render(payload, fromPoll) {
    const activity = payload?.activity || null;
    const claimed = Number(payload?.claimed_count ?? 0);
    const remaining = Number(payload?.remaining_count ?? 0);

    if (!activity) {
      setText('screenStatus', '暂无活动');
      setText('screenStatusHint', '等待红包发放中');
      setText('screenHeroStatus', '等待中');
      setText('screenHeroAmount', '等待红包发放中');
      setText('screenHint', '管理员创建红包后将自动展示');
      setVisible('screenSponsorWrap', false);
      setVisible('screenInfoGrid', false);
      setVisible('screenFeedPanel', false);
      setCountdownText('--:--');
      setText('screenCountdownLabel', '等待活动');
      renderClaims([], false);
      return;
    }

    const totalAmount = Number(activity.total_amount ?? 0);
    const totalCount = Number(activity.total_count ?? 0);
    const status = String(activity.status || 'scheduled');
    const now = nowSec();
    const startAt = Number(activity.start_at || 0);
    const endAt = Number(activity.end_at || 0);

    let statusText = '倒计时';
    let statusHint = '准备开始，保持关注';
    if (now >= endAt || status === 'ended') {
      statusText = '已结束';
      statusHint = '感谢参与，红包已收官';
    } else if (now >= startAt) {
      statusText = '进行中';
      statusHint = '红包正在飞，抓紧参与';
    }

    setText('screenStatus', statusText);
    setText('screenStatusHint', statusHint);
    setText('screenHeroStatus', statusText);
    setVisible('screenInfoGrid', true);
    setVisible('screenFeedPanel', true);
    setText('screenTotalAmount', Number.isFinite(totalAmount) ? `${totalAmount} BOB` : '-');
    setText('screenTotalCount', Number.isFinite(totalCount) ? String(totalCount) : '-');
    setText('screenClaimedCount', Number.isFinite(claimed) ? String(claimed) : '-');
    setText('screenRemainingCount', Number.isFinite(remaining) ? String(remaining) : '-');
    setText('screenHeroAmount', Number.isFinite(remaining) ? `${remaining} 份待抢` : '等待红包');
    setText('screenHint', statusText === '进行中' ? '扫码进余额页，立即抢红包' : statusHint);

    const sponsor = activity?.sponsor ? String(activity.sponsor).trim() : '';
    if (sponsor) {
      setText('screenSponsor', sponsor);
      setVisible('screenSponsorWrap', true);
    } else {
      setVisible('screenSponsorWrap', false);
    }

    const nowSecValue = nowSec();
    if (nowSecValue < startAt) {
      setText('screenCountdownLabel', '距离开始');
      setCountdownText(formatCountdown(startAt - nowSecValue));
    } else if (nowSecValue < endAt) {
      setText('screenCountdownLabel', '距离结束');
      setCountdownText(formatCountdown(endAt - nowSecValue));
    } else {
      setText('screenCountdownLabel', '活动结束');
      setCountdownText('00:00');
    }

    const recent = Array.isArray(payload?.recent_claims) ? payload.recent_claims : [];
    const latest = recent[0];
    const latestKey = latest ? `${latest.userid || ''}_${latest.amount || ''}_${latest.claimed_at || ''}` : null;
    const isNew = fromPoll && latestKey && latestKey !== state.lastClaimKey;
    state.lastClaimKey = latestKey;
    renderClaims(recent, isNew);

    if (isNew) {
      const stage = document.getElementById('redPacketStage');
      if (stage) {
        stage.classList.remove('claimPulse');
        void stage.offsetWidth;
        stage.classList.add('claimPulse');
      }
      launchConfetti();
    }
  }

  async function loadScreenData() {
    const r = await fetchJson('/mall/red-packet/screen?limit=12');
    if (!r?.data?.ok) {
      setText('screenStatus', '加载失败');
      setText('screenStatusHint', r?.data?.error || '请稍后重试');
      return;
    }
    const serverTime = Number(r.data?.server_time);
    if (Number.isFinite(serverTime)) {
      state.offsetSec = serverTime - Math.floor(Date.now() / 1000);
    }
    state.payload = r.data || {};
    render(state.payload, true);
  }

  function scheduleRealtimeTask(key, task, delay = 80) {
    if (state.realtimeTimers[key]) return;
    state.realtimeTimers[key] = setTimeout(async () => {
      state.realtimeTimers[key] = null;
      try {
        await task();
      } catch (_) {
        // ignore realtime refresh failures
      }
    }, delay);
  }

  function setQrCode() {
    const img = document.getElementById('screenQrImg');
    if (!img) return;
    const target = `${window.location.origin}/mall?tab=balance`;
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(target)}`;
  }

  function setStageActive() {
    const stage = document.getElementById('redPacketStage');
    if (!stage) return;
    stage.classList.add('stageActive');
  }

  function launchConfetti() {
    const layer = document.getElementById('confettiLayer');
    if (!layer) return;
    layer.innerHTML = '';
    const colors = ['#f8d36b', '#f59e0b', '#f43f5e', '#ef4444', '#fde68a'];
    const count = 18;
    for (let i = 0; i < count; i += 1) {
      const piece = document.createElement('span');
      piece.className = 'confetti';
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.animationDelay = `${Math.random() * 0.3}s`;
      piece.style.background = colors[i % colors.length];
      piece.style.transform = `rotate(${Math.random() * 180}deg)`;
      layer.appendChild(piece);
    }
    setTimeout(() => {
      layer.innerHTML = '';
    }, 1800);
  }

  function ensureScreenRealtime(forceReconnect = false) {
    if (typeof window.EventSource === 'undefined') {
      setScreenStreamNotice('当前环境不支持实时更新，请手动刷新');
      return null;
    }
    if (forceReconnect && state.eventsSource) {
      closeScreenRealtime({ keepNotice: true });
    }
    if (state.eventsSource) return state.eventsSource;

    setScreenStreamNotice(state.hasSeenRealtimeSnapshot ? '实时连接恢复中...' : '实时同步中...');
    const source = new window.EventSource('/mall/events?scope=screen');
    state.eventsSource = source;
    source.onopen = () => {
      if (state.eventsSource !== source) return;
      setScreenStreamNotice('');
    };
    source.onerror = () => {
      if (state.eventsSource !== source) return;
      setScreenStreamNotice('实时连接正在重试...');
    };
    ['snapshot', 'ping', 'screen_changed'].forEach((eventName) => {
      source.addEventListener(eventName, (evt) => {
        if (state.eventsSource !== source) return;
        if (eventName === 'ping' || eventName === 'snapshot') {
          setScreenStreamNotice('');
        }
        if (eventName === 'snapshot') {
          if (!state.hasSeenRealtimeSnapshot) {
            state.hasSeenRealtimeSnapshot = true;
            return;
          }
        }
        if (eventName === 'screen_changed' || eventName === 'snapshot') {
          scheduleRealtimeTask('screen_refresh', async () => {
            await loadScreenData();
          }, 20);
        }
        void evt;
      });
    });
    return source;
  }

  function startTick() {
    if (state.tickTimer) return;
    state.tickTimer = setInterval(() => {
      if (state.payload?.activity) {
        render(state.payload, false);
      }
    }, 1000);
  }

  function startClock() {
    if (state.clockTimer) return;
    state.clockTimer = setInterval(() => {
      setText('screenClock', formatTime(nowSec()));
    }, 1000);
  }

  async function bootstrap() {
    setQrCode();
    setStageActive();
    await loadScreenData();
    ensureScreenRealtime(true);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        ensureScreenRealtime();
      }
    });
    window.addEventListener('focus', () => {
      ensureScreenRealtime();
    });
    window.addEventListener('pagehide', () => {
      closeScreenRealtime({ keepNotice: true });
    });
    startTick();
    startClock();
  }

  bootstrap();
})();
