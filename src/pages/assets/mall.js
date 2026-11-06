/* LEGACY_MALL_MODULE: 前台商城大文件；新功能优先拆到 src/routes/mall.js + 按业务域页面模块，避免继续堆叠本文件。 */
(function () {
  const currentUrl = window.location.origin + window.location.pathname + window.location.search;

  const fetchJson = window.BOB.fetchJson;
  const postJson = window.BOB.postJson;
  const escapeHtml = window.BOB.escapeHtml;
  const CART_STORAGE_KEY = 'bob.mall.cart.v1';

  const state = {
    activeTab: 'balance',
    cfg: null,
    me: null,
    marketListings: [],
    marketMine: null,
    marketLoading: false,
    products: [],
    charityProjects: [],
    charityProjectDetail: null,
    activeCharityProjectId: '',
    activeCharityTab: 'intro',
    charityVisibleCount: 2,
    charityLoading: false,
    charityContributeBusy: false,
    charityPendingAmount: 0,
    productsVersion: '',
    productsLoading: false,
    richBoard: [],
    popularProducts: [],
    activeRichTab: 'wealth',
    userSource: '',
    moreFaq: [],
    moreAnnouncements: [],
    moreMyFeedback: [],
    moreStats: null,
    moreVersion: null,
    activeMoreTab: 'announcements',
    ledger: [],
    orders: [],
    pendingBuyProductId: null,
    cartItems: [],
    cartCheckoutInFlight: false,
    ordersFilter: null,
    ordersSearchKeyword: '',
    ordersTimeFilter: 'all',
    shopFilter: 'all',
    productSearchKeyword: '',
    reqSeq: 0,
    qrModalExchangeId: null,
    qrModalPayload: null,
    cdkPreview: null,
    cdkInfoExchangeId: '',
    cdkInfoOpenSource: '',
    cdkInfoReturnQrPayload: null,
    cdkRedeemBusy: false,
    opening: null,
    countdownTimer: null,
    closeCountdownTimer: null,
    openingRefreshPromise: null,
    openingRefreshPending: false,
    noticeTimer: null,
    redPacket: null,
    redPacketTimer: null,
    redPacketOffsetMs: 0,
    redPacketClaimInFlight: false,
    redPacketLastCountdown: null,
    auctionList: null,
    marketTab: 'buy',
    auctionDetail: null,
    auctionDetailId: null,
    auctionTimer: null,
    auctionOffsetMs: 0,
    auctionBidInFlight: false,
    auctionListRefreshing: false,
    auctionDetailRefreshing: false,
    myAuction: null,
    reauthInFlight: false,
    oauthSession: null,
    modalLockScrollTop: 0,

    mallEasterClicks: 0,
    mallEasterClickTimer: null,
    mallEasterUnlockedUntil: 0,
    mallEasterUnlockInFlight: false,
    mallEasterToken: '',

    transferCandidates: [],
    transferTarget: null,
    transferSearchTimer: null,
    transferSearchSeq: 0,
    transferBound: false,
    sessionUserName: '',
    streamNotice: '',
    eventsSource: null,
    realtimeTimers: {},
    hasSeenRealtimeSnapshot: false,
    realtimeLastActivityAt: 0,
    realtimeRetryTimer: null,
    realtimeRetryDelay: 0,
    realtimeAuthLost: false,
    realtimeProbing: false,
    announcementPending: [],
    announcementCurrent: null,
    announcementRefreshInFlight: null,
    announcementNextTimer: null,
    announcementSubmitting: false,
    announcementReadyResolver: null,
    announcementGateBound: false,
  };

  function normalizeCartItems(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map((x) => {
        const productId = x?.productId ? String(x.productId).trim() : '';
        const qty = Math.max(1, Math.floor(Number(x?.qty || 0)));
        if (!productId || !Number.isFinite(qty)) return null;
        return { productId, qty };
      })
      .filter((x) => !!x);
  }

  function loadCartFromStorage() {
    try {
      const raw = window.localStorage.getItem(CART_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return normalizeCartItems(parsed);
    } catch {
      return [];
    }
  }

  function saveCartToStorage() {
    try {
      window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(state.cartItems || []));
    } catch {
      // ignore persistence failures
    }
  }

  state.cartItems = loadCartFromStorage();

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  function isMallOpen(row) {
    return Number(row?.is_open) === 1;
  }

  function isMallEasterUnlocked() {
    const until = Number(state.mallEasterUnlockedUntil || 0);
    return Number.isFinite(until) && until > nowSec();
  }

  function clearMallEasterUnlock() {
    state.mallEasterUnlockedUntil = 0;
    state.mallEasterToken = '';
  }

  function isStale(seq) {
    return seq !== state.reqSeq;
  }

  function formatShortCountdown(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  function setRedPacketVisible(visible) {
    const card = document.getElementById('redPacketCard');
    if (!card) return;
    card.classList.toggle('hidden', !visible);
  }

  function renderRedPacket(data) {
    const card = document.getElementById('redPacketCard');
    if (!card) return;

    if (!data?.activity) {
      setRedPacketVisible(false);
      return;
    }

    const now = Math.floor((Date.now() + (Number(state.redPacketOffsetMs) || 0)) / 1000);
    const activity = data.activity;
    const startAt = Number(activity.start_at || 0);
    const endAt = Number(activity.end_at || 0);
    const claimed = Number(data.claimed_count || 0);
    const remaining = Math.max(0, Number(data.remaining_count || 0));
    const total = Number(activity.total_count || 0);
    const myAmount = data.my_amount === null || data.my_amount === undefined ? null : Number(data.my_amount);

    if (now >= endAt || activity.status === 'ended') {
      setRedPacketVisible(false);
      return;
    }

    setRedPacketVisible(true);
    const title = document.getElementById('redPacketTitle');
    const countdown = document.getElementById('redPacketCountdown');
    const status = document.getElementById('redPacketStatusText');
    const hint = document.getElementById('redPacketHint');
    const sponsorBox = document.getElementById('redPacketSponsor');
    const btn = document.getElementById('redPacketClaimBtn');

    if (title) title.textContent = `总额 ${activity.total_amount} · ${claimed}/${total}`;
    if (sponsorBox) {
      const sponsor = activity?.sponsor ? String(activity.sponsor).trim() : '';
      if (sponsor) {
        sponsorBox.textContent = `感谢 ${sponsor} 赞助`;
        sponsorBox.classList.remove('hidden');
      } else {
        sponsorBox.textContent = '';
        sponsorBox.classList.add('hidden');
      }
    }
    const diff = now < startAt ? startAt - now : Math.max(0, endAt - now);
    if (countdown) {
      countdown.textContent = formatShortCountdown(diff);
      if (state.redPacketLastCountdown !== diff) {
        state.redPacketLastCountdown = diff;
        countdown.classList.remove('pulse');
        requestAnimationFrame(() => countdown.classList.add('pulse'));
      }
    }

    const isActive = now >= startAt && now < endAt && activity.status !== 'ended';
    if (status) status.textContent = now < startAt ? '倒计时' : '进行中';

    if (myAmount && Number.isFinite(myAmount)) {
      if (hint) hint.textContent = `你已抢到 ${myAmount} BOB 币`;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '已领取';
      }
      card.classList.add('redPacketOpened');
      return;
    }

    card.classList.remove('redPacketOpened');

    if (remaining <= 0) {
      if (hint) hint.textContent = '已抢完';
      if (btn) {
        btn.disabled = true;
        btn.textContent = '已抢完';
      }
      return;
    }

    if (!isActive) {
      if (hint) hint.textContent = '倒计时结束后可抢';
      if (btn) {
        btn.disabled = true;
        btn.textContent = '等待开始';
      }
      return;
    }

    if (hint) hint.textContent = '点击抢红包，金额随机';
    if (btn) {
      btn.disabled = false;
      btn.textContent = '抢红包';
    }
  }

  async function loadRedPacketStatus() {
    const reqStartMs = Date.now();
    const r = await safeFetchJson('/mall/red-packet/status');
    const reqEndMs = Date.now();
    if (!r?.data?.ok) {
      setRedPacketVisible(false);
      return;
    }
    const serverTimeMs = Number(r.data?.server_time_ms);
    const serverTimeSec = Number(r.data?.server_time);
    const baseServerMs = Number.isFinite(serverTimeMs)
      ? serverTimeMs
      : (Number.isFinite(serverTimeSec) ? serverTimeSec * 1000 : NaN);
    if (Number.isFinite(baseServerMs)) {
      const rttMs = Math.max(0, reqEndMs - reqStartMs);
      const estimatedServerNowMs = baseServerMs + Math.floor(rttMs / 2);
      const nextOffsetMs = estimatedServerNowMs - reqEndMs;
      const prevOffsetMs = Number(state.redPacketOffsetMs) || 0;
      // Smooth small jitter while still converging quickly on real server clock.
      state.redPacketOffsetMs = Math.round(prevOffsetMs * 0.35 + nextOffsetMs * 0.65);
    }
    state.redPacket = {
      activity: r.data?.data || null,
      claimed_count: r.data?.claimed_count || 0,
      remaining_count: r.data?.remaining_count || 0,
      my_amount: r.data?.my_amount ?? null,
    };
    renderRedPacket(state.redPacket);
  }

  function startRedPacketTimer() {
    if (state.redPacketTimer) return;
    state.redPacketTimer = setInterval(() => {
      if (document.hidden) return;
      if (state.activeTab !== 'balance') return;
      if (state.redPacket?.activity) {
        renderRedPacket(state.redPacket);
      }
    }, 1000);
  }

  async function claimRedPacket() {
    if (state.redPacketClaimInFlight) return;
    state.redPacketClaimInFlight = true;
    const btn = document.getElementById('redPacketClaimBtn');
    if (btn) btn.disabled = true;
    try {
      const r = await safeFetchJson('/mall/red-packet/claim', { method: 'POST' });
      if (!r?.data?.ok) {
        const msg = String(r?.data?.error || '抢红包失败');
        const textMap = {
          not_started: '还未开始',
          ended: '活动已结束',
          sold_out: '红包已抢完',
          already_claimed: '',
          no_active: '当前没有红包活动',
          concurrent_limit: '同时抢的人太多啦，请稍后再试',
        };
        if (msg === 'already_claimed') {
          await loadRedPacketStatus();
          const mine = Number(state.redPacket?.my_amount);
          if (Number.isFinite(mine)) {
            showNotice(`你已抢到 ${mine} BOB 币，请在流水查看`, 'info');
          } else {
            showNotice('你已经抢过本轮红包了', 'info');
          }
          return;
        }
        showNotice(textMap[msg] || msg, 'error');
        return;
      }
      const claimServerTimeMs = Number(r?.data?.server_time_ms);
      const claimServerTimeSec = Number(r?.data?.server_time);
      const claimBaseMs = Number.isFinite(claimServerTimeMs)
        ? claimServerTimeMs
        : (Number.isFinite(claimServerTimeSec) ? claimServerTimeSec * 1000 : NaN);
      if (Number.isFinite(claimBaseMs)) {
        state.redPacketOffsetMs = claimBaseMs - Date.now();
      }
      const amount = Number(r.data?.amount);
      if (state.redPacket?.activity) {
        const next = { ...state.redPacket };
        next.my_amount = Number.isFinite(amount) ? amount : next.my_amount;
        if (Number.isFinite(next.claimed_count)) next.claimed_count += 1;
        if (Number.isFinite(next.remaining_count)) next.remaining_count = Math.max(0, next.remaining_count - 1);
        state.redPacket = next;
        renderRedPacket(state.redPacket);
      }
      showNotice(`抢到 ${Number.isFinite(amount) ? amount : '-'} BOB 币`, 'success');
      await refreshBalanceAndLedger();
      await loadRedPacketStatus();
    } finally {
      state.redPacketClaimInFlight = false;
      if (btn) btn.disabled = false;
    }
  }

  function setText(id, text) {
    document.getElementById(id).textContent = text;
  }

  // ── 限时竞拍 ──────────────────────────────────────────────
  function auctionNowSec() {
    return Math.floor((Date.now() + (Number(state.auctionOffsetMs) || 0)) / 1000);
  }

  function smoothAuctionOffset(serverTimeMs, serverTimeSec, reqStartMs, reqEndMs) {
    const baseServerMs = Number.isFinite(Number(serverTimeMs))
      ? Number(serverTimeMs)
      : (Number.isFinite(Number(serverTimeSec)) ? Number(serverTimeSec) * 1000 : NaN);
    if (!Number.isFinite(baseServerMs)) return;
    const rttMs = Math.max(0, reqEndMs - reqStartMs);
    const estimatedServerNowMs = baseServerMs + Math.floor(rttMs / 2);
    const nextOffsetMs = estimatedServerNowMs - reqEndMs;
    const prevOffsetMs = Number(state.auctionOffsetMs) || 0;
    state.auctionOffsetMs = Math.round(prevOffsetMs * 0.35 + nextOffsetMs * 0.65);
  }

  function auctionStatusMeta(status) {
    const s = String(status || '');
    if (s === 'scheduled') return { text: '即将开始', cls: 'auctionTag auctionTagScheduled' };
    if (s === 'active') return { text: '竞拍中', cls: 'auctionTag auctionTagActive' };
    if (s === 'settling') return { text: '结算中', cls: 'auctionTag auctionTagSettling' };
    if (s === 'settled') return { text: '已结束', cls: 'auctionTag auctionTagSettled' };
    if (s === 'cancelled') return { text: '已取消', cls: 'auctionTag auctionTagCancelled' };
    return { text: s || '-', cls: 'auctionTag' };
  }

  function auctionCountdownText(row) {
    const now = auctionNowSec();
    const status = String(row?.effective_status || row?.status || '');
    if (status === 'scheduled') {
      return `开始 ${formatAuctionCountdown(Number(row?.start_at || 0) - now)}`;
    }
    if (status === 'active') {
      return `结束 ${formatAuctionCountdown(Math.max(0, Number(row?.end_at || 0) - now))}`;
    }
    return '';
  }

  function formatAuctionCountdown(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    if (s >= 86400) {
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      return h > 0 ? `${d}天${h}小时` : `${d}天`;
    }
    if (s >= 3600) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return m > 0 ? `${h}小时${m}分` : `${h}小时`;
    }
    if (s >= 600) return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
    return formatShortCountdown(s);
  }

  function humanizeAuctionError(message, httpStatus) {
    const m = String(message || '');
    const map = {
      'invalid activity_id': '活动不存在或参数错误',
      'invalid amount': '出价金额无效，请输入正整数',
      'not_started': '竞拍还未开始',
      'auction ended': '竞拍已结束',
      'auction_cancelled': '该竞拍已被取消',
      'bid_too_low': '出价过低，请按最新价格重新出价',
      'already_highest_bidder': '你已是当前最高出价人',
      'insufficient balance': '余额不足，无法出价',
      'concurrent_bid_conflict': '出价冲突，请按最新价格重试',
      'concurrent_limit': '同时出价的人太多，请稍后再试',
      rate_limited: '出价过于频繁，请稍后再试',
      unauthorized: '登录状态已失效，请重新进入页面',
      'auction not found': '竞拍不存在',
    };
    if (map[m]) return map[m];
    if (httpStatus && Number(httpStatus) >= 500) return '系统繁忙，请稍后再试';
    return m || '出价失败，请稍后再试';
  }

  async function loadAuctionList() {
    const reqStartMs = Date.now();
    const r = await safeFetchJson('/mall/auction/list');
    const reqEndMs = Date.now();
    if (!r?.data?.ok) {
      const el = document.getElementById('auctionListErr');
      if (el) el.textContent = r?.data?.error ? humanizeAuctionError(r.data.error, r.status) : '加载竞拍失败';
      return;
    }
    const errEl = document.getElementById('auctionListErr');
    if (errEl) errEl.textContent = '';
    smoothAuctionOffset(r.data?.server_time_ms, r.data?.server_time, reqStartMs, reqEndMs);
    state.auctionList = Array.isArray(r.data?.data) ? r.data.data : [];
    renderAuctionList();
  }

  function renderAuctionList() {
    const box = document.getElementById('auctionList');
    if (!box) return;
    const rows = state.auctionList || [];
    if (!rows.length) {
      box.innerHTML = '<div class="auctionEmpty">暂无竞拍活动，敬请期待</div>';
      return;
    }
    box.innerHTML = rows.map((row) => {
      const id = Number(row?.id || 0);
      const title = String(row?.title || `竞拍 #${id}`);
      const imageUrl = row?.image_url ? String(row.image_url) : '';
      const status = auctionStatusMeta(row?.effective_status);
      const currentPrice = row?.current_price !== null && row?.current_price !== undefined
        ? Number(row.current_price)
        : Number(row?.start_price || 0);
      const bidder = row?.current_bidder_name ? String(row.current_bidder_name) : '';
      const bids = Number(row?.bid_count || 0);
      const settled = row?.effective_status === 'settled';
      const winnerText = settled
        ? (row?.winner_name ? `得主：${String(row.winner_name)}` : '无人出价，流拍')
        : '';
      return (
        `<article class="auctionItem" data-auction-open="${id}">` +
        `  <div class="auctionItemMedia">${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.classList.add('hidden')" />` : '<div class="auctionItemFallback">拍卖</div>'}</div>` +
        `  <div class="auctionItemMeta">` +
        `    <div class="auctionItemTitleRow"><span class="auctionItemTitle">${escapeHtml(title)}</span><span class="${status.cls}">${escapeHtml(status.text)}</span></div>` +
        `    <div class="auctionItemPrice"><span class="auctionItemPriceValue">${currentPrice}</span> BOB 币</div>` +
        `    <div class="auctionItemSub">${settled ? escapeHtml(winnerText) : (bidder ? `最高出价：${escapeHtml(bidder)} · ${bids} 次出价` : `起拍 ${Number(row?.start_price || 0)} BOB 币 · ${bids} 次出价`)}</div>` +
        `    <div class="auctionItemBottom"><span class="auctionCountdown" data-auction-countdown="${id}">${escapeHtml(auctionCountdownText(row))}</span><span class="auctionItemGo">查看详情 ›</span></div>` +
        `  </div>` +
        `</article>`
      );
    }).join('');
    refreshAuctionCountdowns();
  }

  // 竞拍面板现在挂在「市场」tab 下的子标签里
  function isAuctionVisible() {
    return state.activeTab === 'market' && (state.marketTab === 'auction' || state.marketTab === 'auction-mine');
  }

  function applyMarketTabUi() {
    const tab = ['buy', 'auction', 'sell', 'auction-mine'].includes(state.marketTab) ? state.marketTab : 'buy';
    document.querySelectorAll('[data-market-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-market-tab') === tab);
    });
    setHidden('marketPanelBuy', tab !== 'buy');
    setHidden('auctionPanelLive', tab !== 'auction');
    setHidden('marketPanelSell', tab !== 'sell');
    setHidden('auctionPanelMine', tab !== 'auction-mine');
  }

  function switchMarketTab(tab) {
    const next = ['buy', 'auction', 'sell', 'auction-mine'].includes(tab) ? tab : 'buy';
    const prev = state.marketTab;
    state.marketTab = next;
    applyMarketTabUi();
    if (next === prev) return;
    if (next === 'auction') {
      loadAuctionList().catch(() => null);
    } else if (next === 'auction-mine') {
      loadMyAuction().catch(() => null);
    } else {
      loadMarketData().catch(() => null);
    }
  }

  async function loadMyAuction() {
    const r = await safeFetchJson('/mall/auction/me');
    if (!r?.data?.ok) {
      const el = document.getElementById('auctionMineErr');
      if (el) el.textContent = '加载我的竞拍失败';
      return;
    }
    const errEl = document.getElementById('auctionMineErr');
    if (errEl) errEl.textContent = '';
    state.myAuction = {
      bids: Array.isArray(r.data?.bids) ? r.data.bids : [],
      held_total: Number(r.data?.held_total || 0),
      held_count: Number(r.data?.held_count || 0),
    };
    renderAuctionMine();
  }

  function renderAuctionMine() {
    const summaryEl = document.getElementById('auctionMineSummary');
    const box = document.getElementById('auctionMineList');
    if (!summaryEl || !box) return;
    const mine = state.myAuction || { bids: [], held_total: 0, held_count: 0 };
    summaryEl.innerHTML = (
      `<div class="auctionMineStat"><span>在押金额</span><strong>${Number(mine.held_total || 0)} BOB 币</strong></div>` +
      `<div class="auctionMineStat"><span>在押场次</span><strong>${Number(mine.held_count || 0)}</strong></div>` +
      `<div class="auctionMineStatHelp">出价即冻结，被超出或活动取消后自动退回</div>`
    );
    if (!mine.bids.length) {
      box.innerHTML = '<div class="auctionEmpty">还没有出价记录</div>';
      return;
    }
    box.innerHTML = mine.bids.map((row) => {
      const stateText = row?.state === 'held'
        ? '在押中'
        : row?.state === 'won'
          ? '竞得'
          : '已退回';
      const stateCls = row?.state === 'held'
        ? 'auctionTag auctionTagActive'
        : row?.state === 'won'
          ? 'auctionTag auctionTagWon'
          : 'auctionTag auctionTagSettled';
      const activityStatus = auctionStatusMeta(
        row?.state === 'held' && String(row?.activity_status || '') === 'active' ? 'active' : row?.activity_status,
      );
      const resultText = row?.state === 'won'
        ? `成交价 ${Number(row?.final_price || 0)} BOB 币 · 奖品在「订单」页出示二维码领取`
        : '';
      return (
        `<article class="auctionMineItem" data-auction-open="${Number(row?.activity_id || 0)}">` +
        `  <div class="auctionMineInfo">` +
        `    <div class="auctionItemTitleRow"><span class="auctionItemTitle">${escapeHtml(String(row?.title || '-'))}</span><span class="${stateCls}">${escapeHtml(stateText)}</span></div>` +
        `    <div class="auctionItemSub">我的出价 ${Number(row?.amount || 0)} BOB 币 · ${escapeHtml(activityStatus.text)}${resultText ? ` · ${escapeHtml(resultText)}` : ''}</div>` +
        `    <div class="auctionItemSub muted">${escapeHtml(fmtTs(row?.created_at) || '')}</div>` +
        `  </div>` +
        `  <span class="auctionItemGo">详情 ›</span>` +
        `</article>`
      );
    }).join('');
  }

  async function loadAuctionDetail(id) {
    const reqStartMs = Date.now();
    const r = await safeFetchJson(`/mall/auction/detail?id=${encodeURIComponent(id)}`);
    const reqEndMs = Date.now();
    const errEl = document.getElementById('auctionDetailErr');
    if (!r?.data?.ok) {
      if (errEl) errEl.textContent = humanizeAuctionError(r?.data?.error, r.status);
      return null;
    }
    if (errEl) errEl.textContent = '';
    smoothAuctionOffset(r.data?.server_time_ms, r.data?.server_time, reqStartMs, reqEndMs);
    state.auctionDetail = {
      activity: r.data?.data || null,
      my_bid: r.data?.my_bid || null,
    };
    renderAuctionDetail();
    return state.auctionDetail;
  }

  function renderAuctionDetail() {
    const body = document.getElementById('auctionDetailBody');
    if (!body || !state.auctionDetail?.activity) return;
    const a = state.auctionDetail.activity;
    const myBid = state.auctionDetail.my_bid;
    const status = auctionStatusMeta(a.effective_status);
    const currentPrice = a.current_price !== null && a.current_price !== undefined
      ? Number(a.current_price)
      : Number(a.start_price || 0);
    const floor = Number(a.next_bid_floor || 0);
    const now = auctionNowSec();
    const imageUrl = a.image_url ? String(a.image_url) : '';
    // 员工端响应不含 current_bid_userid；每场至多一条 held 出价（唯一索引保证），
    // 因此「我最近一条出价是 held」等价于「我是当前最高出价人」。
    const iAmHighest = myBid?.state === 'held';

    const bidsHtml = (a.bids || []).length
      ? a.bids.map((bid) => (
        `<div class="auctionBidRow${bid.state === 'held' ? ' auctionBidRowHeld' : ''}">` +
        `<span class="auctionBidName">${escapeHtml(String(bid.display_name || '用户'))}</span>` +
        `<span class="auctionBidAmount">${Number(bid.amount || 0)} BOB 币</span>` +
        `<span class="auctionBidTime">${escapeHtml(fmtTs(bid.created_at) || '')}</span>` +
        `</div>`
      )).join('')
      : '<div class="auctionEmpty">暂无出价</div>';

    const statusLine = a.effective_status === 'scheduled'
      ? `距开始 ${formatAuctionCountdown(Math.max(0, Number(a.start_at || 0) - now))}`
      : a.effective_status === 'active'
        ? `距结束 ${formatAuctionCountdown(Math.max(0, Number(a.end_at || 0) - now))}`
        : status.text;

    body.innerHTML = (
      (imageUrl ? `<div class="auctionDetailMedia"><img src="${escapeHtml(imageUrl)}" alt="" referrerpolicy="no-referrer" /></div>` : '') +
      `<div class="auctionDetailTitleRow"><div class="auctionDetailTitle">${escapeHtml(String(a.title || '-'))}</div><span class="${status.cls}">${escapeHtml(status.text)}</span></div>` +
      (a.description ? `<div class="auctionDetailDesc">${escapeHtml(String(a.description))}</div>` : '') +
      `<div class="auctionDetailGrid">` +
      `<div class="auctionDetailCell"><span>当前价</span><strong>${currentPrice} BOB 币</strong></div>` +
      `<div class="auctionDetailCell"><span>最低加价</span><strong>${Number(a.min_increment || 0)} BOB 币</strong></div>` +
      `<div class="auctionDetailCell"><span>出价次数</span><strong>${Number(a.bid_count || 0)}</strong></div>` +
      `<div class="auctionDetailCell"><span class="auctionCountdown" data-auction-countdown="${Number(a.id || 0)}">${escapeHtml(statusLine)}</span><strong>${escapeHtml(a.effective_status === 'scheduled' ? '等待开始' : iAmHighest ? '你正在领先' : (a.current_bidder_name ? `领先：${String(a.current_bidder_name)}` : '暂无出价'))}</strong></div>` +
      `</div>` +
      (a.anti_snipe_seconds > 0 && a.effective_status === 'active'
        ? `<div class="help">结束前 ${Number(a.anti_snipe_seconds)} 秒内的出价会自动顺延结束时间。</div>`
        : '') +
      (a.effective_status === 'settled'
        ? `<div class="auctionResultBanner">${a.winner_name ? `🏆 ${escapeHtml(String(a.winner_name))} 以 ${Number(a.final_price || 0)} BOB 币竞得<div class="auctionResultHint">奖品领取：请到「订单」页出示核销二维码</div>` : '本场无人出价，已流拍'}</div>`
        : '') +
      (a.effective_status === 'cancelled'
        ? `<div class="auctionResultBanner auctionResultCancelled">该竞拍已取消${a.cancel_reason ? `：${escapeHtml(String(a.cancel_reason))}` : ''}，在押金额已退回。</div>`
        : '') +
      (myBid ? `<div class="auctionMyBidLine">我的最近出价：${Number(myBid.amount || 0)} BOB 币（${myBid.state === 'held' ? '在押中' : myBid.state === 'won' ? '已竞得' : '已退回'}）</div>` : '') +
      `<div class="auctionDetailSectionTitle">出价记录</div>` +
      `<div class="auctionBidList">${bidsHtml}</div>`
    );

    const bidBtn = document.getElementById('btnAuctionBidOpen');
    if (bidBtn) {
      const canBid = a.effective_status === 'active' && !iAmHighest;
      bidBtn.classList.toggle('hidden', !canBid);
      bidBtn.textContent = '我要出价';
    }
    refreshAuctionCountdowns();
  }

  function openAuctionDetail(id) {
    state.auctionDetailId = Number(id) || null;
    state.auctionDetail = null;
    const body = document.getElementById('auctionDetailBody');
    if (body) body.innerHTML = '<div class="auctionEmpty">加载中…</div>';
    const errEl = document.getElementById('auctionDetailErr');
    if (errEl) errEl.textContent = '';
    const bidBtn = document.getElementById('btnAuctionBidOpen');
    if (bidBtn) bidBtn.classList.add('hidden');
    const modal = document.getElementById('auctionDetailModal');
    if (modal) modal.classList.remove('hidden');
    loadAuctionDetail(id);
  }

  function closeAuctionDetail() {
    state.auctionDetailId = null;
    state.auctionDetail = null;
    const modal = document.getElementById('auctionDetailModal');
    if (modal) modal.classList.add('hidden');
    closeAuctionBidModal();
  }

  function openAuctionBidModal() {
    const detail = state.auctionDetail;
    if (!detail?.activity) return;
    const a = detail.activity;
    if (a.effective_status !== 'active') {
      showNotice('竞拍当前不可出价', 'error');
      return;
    }
    setText('auctionBidTitle', String(a.title || '-'));
    setText('auctionBidCurrent', `${a.current_price !== null && a.current_price !== undefined ? Number(a.current_price) : Number(a.start_price || 0)} BOB 币`);
    const floor = Number(a.next_bid_floor || 0);
    setText('auctionBidFloorHint', `最低可出价 ${floor} BOB 币（当前价 + 加价幅度 ${Number(a.min_increment || 0)}）`);
    const input = document.getElementById('auctionBidAmount');
    if (input) {
      input.min = String(floor);
      input.value = String(floor);
    }
    const errEl = document.getElementById('auctionBidErr');
    if (errEl) errEl.textContent = '';
    const modal = document.getElementById('auctionBidModal');
    if (modal) modal.classList.remove('hidden');
  }

  function closeAuctionBidModal() {
    const modal = document.getElementById('auctionBidModal');
    if (modal) modal.classList.add('hidden');
  }

  async function confirmAuctionBid() {
    const detail = state.auctionDetail;
    if (!detail?.activity || state.auctionBidInFlight) return;
    const a = detail.activity;
    const input = document.getElementById('auctionBidAmount');
    const rawAmount = input ? String(input.value || '').trim() : '';
    const amount = Number(rawAmount);
    const errEl = document.getElementById('auctionBidErr');
    if (!rawAmount || !Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      if (errEl) errEl.textContent = '请输入正确的出价金额（正整数）';
      return;
    }
    const floor = Number(a.next_bid_floor || 0);
    if (amount < floor) {
      if (errEl) errEl.textContent = `出价不能低于 ${floor} BOB 币`;
      return;
    }

    state.auctionBidInFlight = true;
    const btn = document.getElementById('btnAuctionBidConfirm');
    if (btn) btn.disabled = true;
    try {
      const r = await safeFetchJson('/mall/auction/bid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_id: Number(a.id), amount }),
      });
      if (!r?.data?.ok) {
        const msg = humanizeAuctionError(r?.data?.error, r.status);
        if (errEl) errEl.textContent = msg;
        // 价格可能已被别人抬高，重新拉详情
        await loadAuctionDetail(a.id);
        return;
      }
      if (errEl) errEl.textContent = '';
      closeAuctionBidModal();
      showNotice(`出价成功，已冻结 ${Number(r.data?.amount || amount)} BOB 币`, 'success');
      await Promise.all([
        loadAuctionDetail(a.id),
        refreshBalanceAndLedger(),
      ]);
      if (isAuctionVisible()) {
        await loadAuctionList();
      }
    } finally {
      state.auctionBidInFlight = false;
      if (btn) btn.disabled = false;
    }
  }

  function refreshAuctionCountdowns() {
    const byId = new Map();
    for (const row of state.auctionList || []) byId.set(Number(row.id), row);
    if (state.auctionDetail?.activity) byId.set(Number(state.auctionDetail.activity.id), state.auctionDetail.activity);
    document.querySelectorAll('[data-auction-countdown]').forEach((node) => {
      const id = Number(node.getAttribute('data-auction-countdown') || 0);
      const row = byId.get(id);
      if (!row) return;
      node.textContent = auctionCountdownText(row) || auctionStatusMeta(row.effective_status).text;
    });
  }

  function startAuctionTimer() {
    if (state.auctionTimer) return;
    state.auctionTimer = setInterval(() => {
      if (document.hidden) return;
      const tabVisible = isAuctionVisible();
      const modalOpen = !document.getElementById('auctionDetailModal')?.classList.contains('hidden');
      if (!tabVisible && !modalOpen) return;
      refreshAuctionCountdowns();
      // 倒计时归零后自动刷新：scheduled 到点要转入进行中，active 到点要触发服务端结算；
      // 用 in-flight 标志去重，避免每秒重复重拉
      const now = auctionNowSec();
      const due = (state.auctionList || []).some((row) => {
        const st = String(row.effective_status || '');
        if (st === 'active') return now >= Number(row.end_at || 0);
        if (st === 'scheduled') return now >= Number(row.start_at || 0);
        return false;
      });
      const detailDue = state.auctionDetail?.activity && (() => {
        const st = String(state.auctionDetail.activity.effective_status || '');
        if (st === 'active') return now >= Number(state.auctionDetail.activity.end_at || 0);
        if (st === 'scheduled') return now >= Number(state.auctionDetail.activity.start_at || 0);
        return false;
      })();
      if (due && tabVisible && !state.auctionListRefreshing) {
        state.auctionListRefreshing = true;
        loadAuctionList().catch(() => null).finally(() => { state.auctionListRefreshing = false; });
      }
      if (detailDue && modalOpen && !state.auctionDetailRefreshing) {
        state.auctionDetailRefreshing = true;
        loadAuctionDetail(state.auctionDetailId).catch(() => null).finally(() => { state.auctionDetailRefreshing = false; });
      }
    }, 1000);
  }

  function bindAuctionEvents() {
    const listEl = document.getElementById('auctionList');
    if (listEl) {
      listEl.addEventListener('click', (ev) => {
        const item = ev?.target?.closest ? ev.target.closest('[data-auction-open]') : null;
        const id = item?.getAttribute ? item.getAttribute('data-auction-open') : '';
        if (id) openAuctionDetail(id);
      });
    }
    const mineEl = document.getElementById('auctionMineList');
    if (mineEl) {
      mineEl.addEventListener('click', (ev) => {
        const item = ev?.target?.closest ? ev.target.closest('[data-auction-open]') : null;
        const id = item?.getAttribute ? item.getAttribute('data-auction-open') : '';
        if (id) openAuctionDetail(id);
      });
    }

    document.getElementById('btnAuctionDetailClose')?.addEventListener('click', closeAuctionDetail);
    document.getElementById('auctionDetailModal')?.addEventListener('click', (ev) => {
      if (ev?.target?.id === 'auctionDetailModal') closeAuctionDetail();
    });
    document.getElementById('btnAuctionBidRefresh')?.addEventListener('click', () => {
      if (state.auctionDetailId) loadAuctionDetail(state.auctionDetailId).catch(() => null);
    });
    document.getElementById('btnAuctionBidOpen')?.addEventListener('click', openAuctionBidModal);
    document.getElementById('btnAuctionBidClose')?.addEventListener('click', closeAuctionBidModal);
    document.getElementById('btnAuctionBidCancel')?.addEventListener('click', closeAuctionBidModal);
    document.getElementById('auctionBidModal')?.addEventListener('click', (ev) => {
      if (ev?.target?.id === 'auctionBidModal') closeAuctionBidModal();
    });
    document.getElementById('btnAuctionBidConfirm')?.addEventListener('click', confirmAuctionBid);
  }

  function stripHtml(value) {
    const box = document.createElement('div');
    box.innerHTML = String(value || '');
    return (box.textContent || box.innerText || '').trim();
  }

  function sanitizeRichHtml(value) {
    const template = document.createElement('template');
    template.innerHTML = String(value || '');
    const allowedTags = new Set(['A', 'B', 'BR', 'DIV', 'EM', 'I', 'IMG', 'LI', 'OL', 'P', 'SPAN', 'STRONG', 'U', 'UL']);
    const allowedAttrs = new Set(['href', 'src', 'alt', 'title', 'target', 'rel']);
    template.content.querySelectorAll('*').forEach((node) => {
      if (!allowedTags.has(node.tagName)) {
        node.replaceWith(document.createTextNode(node.textContent || ''));
        return;
      }
      Array.from(node.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const valueText = String(attr.value || '').trim();
        if (!allowedAttrs.has(name) || name.startsWith('on')) {
          node.removeAttribute(attr.name);
          return;
        }
        if ((name === 'href' || name === 'src') && !/^(https?:|data:image\/)/i.test(valueText)) {
          node.removeAttribute(attr.name);
        }
      });
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return template.innerHTML;
  }

  function setRichHtml(id, html, fallback = '-') {
    const el = document.getElementById(id);
    if (!el) return;
    const safe = sanitizeRichHtml(html);
    el.innerHTML = safe || escapeHtml(fallback);
  }

  function renderUserHint() {
    const safeName = state.sessionUserName ? String(state.sessionUserName).trim() : '';
    const base = safeName ? `你好，${safeName}` : '你好';
    setText('userHint', state.streamNotice ? `${base} · ${state.streamNotice}` : base);
  }

  function setUserIdentity(name, avatarUrl) {
    const safeName = name ? String(name).trim() : '';
    state.sessionUserName = safeName;
    renderUserHint();

    const avatarImg = document.getElementById('userAvatarImg');
    const avatarFallback = document.getElementById('userAvatarFallback');
    const firstChar = Array.from(safeName || '我')[0] || '我';
    if (avatarFallback) {
      avatarFallback.textContent = firstChar;
    }

    const url = avatarUrl ? String(avatarUrl).trim() : '';
    if (url && avatarImg) {
      avatarImg.src = url;
      avatarImg.classList.remove('hidden');
      if (avatarFallback) avatarFallback.classList.add('hidden');
      avatarImg.onerror = () => {
        avatarImg.classList.add('hidden');
        if (avatarFallback) avatarFallback.classList.remove('hidden');
      };
      return;
    }

    if (avatarImg) avatarImg.classList.add('hidden');
    if (avatarFallback) avatarFallback.classList.remove('hidden');
  }

  function syncMeIdentity({ userid, name } = {}) {
    const uid = userid ? String(userid).trim() : '';
    if (!uid) return;
    const safeName = name ? String(name).trim() : '';
    const prev = state.me && typeof state.me === 'object' ? state.me : {};
    state.me = { ...prev, userid: uid, name: safeName || prev?.name || '' };
  }

  function isExternalUser() {
    return state.userSource === 'external';
  }

  // 记录会话来源（dingtalk / external）并按来源调整界面：
  // 外部活动账号不展示大富翁榜、转账文案改为「其他活动参与者」、个人数据页显示退出登录。
  function setUserSource(source) {
    state.userSource = String(source || '').trim() === 'external' ? 'external' : 'dingtalk';
    const external = isExternalUser();

    setHidden('logoutRow', !external);
    setHidden('logoutHelp', !external);
    setText('transferSearchHelp', external ? '搜索其他活动参与者，请点击选择' : '会列出匹配的同事，请点击选择');
    setText('transferHeroHelp', external ? '转账支持活动参与者之间互转 BOB 币。' : '转账支持同事之间互转 BOB 币。');

    // 大富翁榜按余额排名并展示姓名，外部活动账号不参与：隐藏该子页签，仅保留热门商品下单榜。
    setHidden('richTabWealth', external);
    setHidden('richPanelWealth', external || state.activeRichTab !== 'wealth');
    if (external && state.activeRichTab === 'wealth') {
      state.activeRichTab = 'products';
    }
    setHidden('richSubnav', external);
    if (state.activeMoreTab === 'rich') applyRichTabUi();
    if (state.moreStats) renderMoreStats(state.moreStats);
  }

  async function handleLogout() {
    const confirmed = await showConfirmDialog({
      title: '退出登录',
      message: '退出后需要重新输入手机号和密码登录，确定退出吗？',
      confirmText: '退出登录',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const resp = await fetch('/web/logout', { method: 'POST', credentials: 'same-origin' });
      if (!resp.ok) throw new Error(`logout_failed_${resp.status}`);
    } catch (_) {
      showNotice('退出失败，请稍后重试', 'error');
      return;
    }
    window.location.replace('/login');
  }

  function setRealtimeNotice(text) {
    state.streamNotice = text ? String(text) : '';
    renderUserHint();
  }

  function clearRealtimeTasks() {
    Object.keys(state.realtimeTimers || {}).forEach((key) => {
      if (state.realtimeTimers[key]) {
        clearTimeout(state.realtimeTimers[key]);
      }
      state.realtimeTimers[key] = null;
    });
  }

  function clearRealtimeRetry() {
    if (state.realtimeRetryTimer) clearTimeout(state.realtimeRetryTimer);
    state.realtimeRetryTimer = null;
  }

  function closeMallRealtime({ keepNotice = false } = {}) {
    clearRealtimeRetry();
    if (state.eventsSource) {
      state.eventsSource.close();
      state.eventsSource = null;
    }
    clearRealtimeTasks();
    if (!keepNotice) {
      setRealtimeNotice('');
    }
  }

  function updateModalScrollLock() {
    const announcementGate = document.getElementById('announcementGate');
    const hasVisibleModal = (!announcementGate?.classList.contains('hidden'))
      || Array.from(document.querySelectorAll('.modal')).some((el) => !el.classList.contains('hidden'));
    document.body.classList.toggle('modalOpen', hasVisibleModal);
    document.documentElement.classList.toggle('modalOpen', hasVisibleModal);
    if (hasVisibleModal) {
      if (!document.body.classList.contains('modalOpenFixed')) {
        state.modalLockScrollTop = window.scrollY || window.pageYOffset || 0;
        document.body.classList.add('modalOpenFixed');
        document.body.style.top = `-${state.modalLockScrollTop}px`;
        document.body.style.position = 'fixed';
        document.body.style.width = '100%';
      }
      return;
    }
    if (document.body.classList.contains('modalOpenFixed')) {
      document.body.classList.remove('modalOpenFixed');
      document.body.style.top = '';
      document.body.style.position = '';
      document.body.style.width = '';
      window.scrollTo(0, Number(state.modalLockScrollTop || 0));
    }
  }

  function setConfirmModalVisible(visible) {
    const m = document.getElementById('confirmModal');
    if (!m) return;
    m.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function setCartModalVisible(visible) {
    const m = document.getElementById('cartModal');
    if (!m) return;
    m.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function setProductSearchVisible(visible) {
    const m = document.getElementById('productSearchModal');
    if (!m) return;
    m.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function setOrderDetailVisible(visible) {
    const m = document.getElementById('orderDetailModal');
    if (!m) return;
    m.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function setCharityDetailVisible(visible) {
    const modal = document.getElementById('charityDetailModal');
    if (!modal) return;
    modal.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function setCharityConfirmVisible(visible) {
    const m = document.getElementById('charityConfirmModal');
    if (!m) return;
    m.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function setCdkRedeemVisible(visible) {
    const m = document.getElementById('cdkRedeemModal');
    if (!m) return;
    m.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function setCdkInfoVisible(visible) {
    const m = document.getElementById('cdkInfoModal');
    if (!m) return;
    m.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function setCdkRedeemError(text) {
    const el = document.getElementById('cdkRedeemErr');
    if (!el) return;
    el.textContent = String(text || '');
  }

  function setCdkInfoError(text) {
    const el = document.getElementById('cdkInfoErr');
    if (!el) return;
    el.textContent = String(text || '');
  }

  function resetCdkPreview() {
    state.cdkPreview = null;
    setHidden('cdkPreviewBox', true);
    setHidden('cdkPreviewMediaWrap', true);
    setText('cdkPreviewName', '-');
    setText('cdkPreviewAmount', '-');
    setText('cdkPreviewRemark', '-');
    const img = document.getElementById('cdkPreviewImage');
    if (img) img.src = '';
    setHidden('btnCdkRedeemConfirm', true);
  }

  function openCdkRedeemModal() {
    const input = document.getElementById('cdkInput');
    if (input) input.value = '';
    resetCdkPreview();
    setCdkRedeemError('');
    state.cdkRedeemBusy = false;
    setText('cdkRedeemSub', '输入兑换码后预览兑换商品');
    setCdkRedeemVisible(true);
    if (input) input.focus();
  }

  function closeCdkRedeemModal() {
    state.cdkRedeemBusy = false;
    setCdkRedeemVisible(false);
    setCdkRedeemError('');
    resetCdkPreview();
  }

  function renderCdkPreview(data) {
    state.cdkPreview = data || null;
    setText('cdkPreviewName', data?.product_name ? String(data.product_name) : '-');
    setText('cdkPreviewAmount', data?.product_bob_amount !== null && data?.product_bob_amount !== undefined ? `${data.product_bob_amount} BOB 币` : '-');
    setText('cdkPreviewRemark', data?.remark ? String(data.remark) : '暂无兑换说明');
    const img = document.getElementById('cdkPreviewImage');
    const imageUrl = data?.image_url ? String(data.image_url) : '';
    if (img) img.src = imageUrl;
    setHidden('cdkPreviewMediaWrap', !imageUrl);
    setHidden('cdkPreviewBox', false);
    setHidden('btnCdkRedeemConfirm', false);
    setText('cdkRedeemSub', '确认商品信息后完成兑换');
  }

  function humanizeCdkError(message) {
    const text = String(message || '');
    const map = {
      unauthorized: '登录状态已失效，请刷新后重试',
      'missing cdk': '请输入 CDK',
      'invalid cdk format': '兑换码格式错误，请检查后重试',
      'cdk not found': '兑换码不存在，请检查后重试',
      'cdk deleted': '该兑换码已作废',
      'cdk already redeemed': '该兑换码已被使用',
      'cdk product unavailable': '该兑换权益当前不可用，请联系管理员',
    };
    return map[text] || text || '兑换失败';
  }

  async function previewCdk() {
    const input = document.getElementById('cdkInput');
    const cdk = input?.value ? String(input.value).trim().toUpperCase() : '';
    if (!cdk) {
      setCdkRedeemError('请输入 CDK');
      resetCdkPreview();
      return;
    }

    state.cdkRedeemBusy = true;
    setCdkRedeemError('');
    const btn = document.getElementById('btnCdkPreview');
    const prevDisabled = btn ? btn.disabled : false;
    if (btn) btn.disabled = true;
    try {
      const r = await fetchJson('/mall/cdk/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cdk }),
      });
      if (!r?.data?.ok) {
        resetCdkPreview();
        setCdkRedeemError(humanizeCdkError(r?.data?.error || r?.status || ''));
        return;
      }
      renderCdkPreview({ ...r.data, cdk });
    } finally {
      state.cdkRedeemBusy = false;
      if (btn) btn.disabled = prevDisabled;
    }
  }

  async function redeemCdkCode() {
    if (state.cdkRedeemBusy) return;
    const preview = state.cdkPreview;
    const cdk = preview?.cdk ? String(preview.cdk) : '';
    if (!cdk) {
      setCdkRedeemError('请先预览商品后再确认兑换');
      return;
    }

    state.cdkRedeemBusy = true;
    setCdkRedeemError('');
    const btn = document.getElementById('btnCdkRedeemConfirm');
    const prevDisabled = btn ? btn.disabled : false;
    if (btn) btn.disabled = true;
    try {
      const r = await fetchJson('/mall/cdk/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cdk }),
      });
      if (!r?.data?.ok) {
        setCdkRedeemError(humanizeCdkError(r?.data?.error || r?.status || ''));
        return;
      }

      closeCdkRedeemModal();
      state.ordersFilter = 'pending';
      switchTab('orders');
      const seq = ++state.reqSeq;
      await loadOrders(seq);
      if (r?.data?.encoded && r?.data?.qr_image_url) {
        showQrModal({
          exchangeId: r.data.exchange_id ? String(r.data.exchange_id) : '',
          encoded: String(r.data.encoded || ''),
          qrImageUrl: String(r.data.qr_image_url || ''),
          hint: '请出示给核销人员扫码',
          productTitle: r?.data?.product_name ? String(r.data.product_name) : '',
          amountText: '',
          balanceText: '',
          cdkInfoAvailable: true,
          marketListAvailable: true,
          refundAvailable: false,
        });
      }
      showNotice('兑换成功，已生成待核销订单', 'success');
    } finally {
      state.cdkRedeemBusy = false;
      if (btn) btn.disabled = prevDisabled;
    }
  }

  async function openCdkInfoModal(exchangeId, options = {}) {
    const xid = exchangeId ? String(exchangeId) : '';
    if (!xid) return;
    state.cdkInfoOpenSource = options?.source ? String(options.source) : 'order_detail';
    const returnQrPayload = options?.returnQrPayload && typeof options.returnQrPayload === 'object'
      ? options.returnQrPayload
      : null;
    state.cdkInfoReturnQrPayload = returnQrPayload?.exchangeId
      ? { ...returnQrPayload, exchangeId: String(returnQrPayload.exchangeId) }
      : null;
    state.cdkInfoExchangeId = xid;
    setCdkInfoError('');
    setText('cdkInfoSource', '-');
    setText('cdkInfoProductName', '-');
    setText('cdkInfoAmount', '-');
    setText('cdkInfoExchangeId', xid);
    setText('cdkInfoCode', '-');
    setText('cdkInfoRedeemedAt', '-');
    setText('cdkInfoStatus', '-');
    setCdkInfoVisible(true);

    const r = await fetchJson(`/mall/cdk/info?exchange_id=${encodeURIComponent(xid)}`);
    if (!r?.data?.ok) {
      setCdkInfoError(humanizeCdkError(r?.data?.error || r?.status || ''));
      return;
    }
    setText('cdkInfoSource', r.data?.source_type ? String(r.data.source_type) : 'CDK兑换');
    setText('cdkInfoProductName', r.data?.product_name ? String(r.data.product_name) : '-');
    setText('cdkInfoAmount', r.data?.product_bob_amount !== null && r.data?.product_bob_amount !== undefined ? `${r.data.product_bob_amount} BOB 币` : '-');
    setText('cdkInfoExchangeId', r.data?.exchange_id ? String(r.data.exchange_id) : xid);
    setText('cdkInfoCode', r.data?.cdk ? String(r.data.cdk) : '-');
    setText('cdkInfoRedeemedAt', fmtTs(r.data?.redeemed_at));
    setText('cdkInfoStatus', r.data?.order_status === 'fulfilled' ? '已兑换，已核销' : '已兑换，待核销');
  }

  function closeCdkInfoModal() {
    const source = state.cdkInfoOpenSource ? String(state.cdkInfoOpenSource) : '';
    const payload = state.cdkInfoReturnQrPayload && typeof state.cdkInfoReturnQrPayload === 'object'
      ? { ...state.cdkInfoReturnQrPayload }
      : null;
    state.cdkInfoExchangeId = '';
    state.cdkInfoOpenSource = '';
    state.cdkInfoReturnQrPayload = null;
    setCdkInfoVisible(false);
    setCdkInfoError('');
    if (source === 'qr' && payload?.exchangeId) {
      showQrModal(payload);
    }
  }

  function showOrderDetailModal(row) {
    const productNameBox = document.getElementById('orderDetailProductName');
    const exchangeIdBox = document.getElementById('orderDetailExchangeId');
    const amountBox = document.getElementById('orderDetailAmount');
    const createdAtBox = document.getElementById('orderDetailCreatedAt');
    const statusBox = document.getElementById('orderDetailStatus');

    if (productNameBox) productNameBox.textContent = row?.product_name ? String(row.product_name) : '-';
    if (exchangeIdBox) exchangeIdBox.textContent = row?.exchange_id ? String(row.exchange_id) : '-';
    if (amountBox) amountBox.textContent = row?.bob_amount !== null && row?.bob_amount !== undefined ? `${row.bob_amount} BOB 币` : '-';
    if (createdAtBox) createdAtBox.textContent = fmtTs(row?.created_at);
    if (statusBox) {
      const s = String(row?.status || '');
      const isListed = s === 'listed' || row?.is_listed === true || Number(row?.is_listed || 0) === 1;
      const subBox = document.getElementById('orderDetailSub');
      if (isListed) {
        statusBox.innerHTML = '<span class="pill pillListed">挂单中</span>';
        if (subBox) subBox.textContent = '该订单已上架到交易市场';
      } else if (s === 'fulfilled') {
        statusBox.innerHTML = '<span class="pill pillBad">已核销</span>';
        if (subBox) subBox.textContent = '已核销订单信息';
      } else {
        statusBox.innerHTML = '<span class="pill pillOk">待核销</span>';
        if (subBox) subBox.textContent = '订单信息';
      }
    }
    setHidden('btnOrderDetailCdkInfo', !(row?.cdk_info_available === true || Number(row?.cdk_info_available || 0) === 1));

    setOrderDetailVisible(true);
  }

  function setOrderNoticeVisible(visible) {
    const m = document.getElementById('orderNoticeModal');
    if (!m) return;
    m.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function setTransferModalVisible(visible) {
    const m = document.getElementById('transferModal');
    if (!m) return;
    m.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function setTransferConfirmVisible(visible) {
    const m = document.getElementById('transferConfirmModal');
    if (!m) return;
    m.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function setTransferListVisible(visible) {
    const list = document.getElementById('transferList');
    if (!list) return;
    list.classList.toggle('hidden', !visible);
  }

  function showNotice(text, type = 'info') {
    const box = document.getElementById('orderNoticeText');
    const card = document.getElementById('orderNoticeCard');
    const icon = document.querySelector('#orderNoticeCard .noticeIcon');
    const noticeType = type === 'success' || type === 'error' ? type : 'info';
    const iconText = noticeType === 'success' ? '✓' : (noticeType === 'error' ? '×' : '!');
    if (box) box.textContent = String(text || '').trim() || '提示';
    if (icon) icon.textContent = iconText;
    if (card) {
      card.classList.remove('noticeInfo', 'noticeSuccess', 'noticeError');
      card.classList.add(noticeType === 'success' ? 'noticeSuccess' : (noticeType === 'error' ? 'noticeError' : 'noticeInfo'));
    }
    if (state.noticeTimer) {
      clearTimeout(state.noticeTimer);
      state.noticeTimer = null;
    }
    setOrderNoticeVisible(true);
    state.noticeTimer = setTimeout(() => {
      setOrderNoticeVisible(false);
    }, 1000);
  }

  /**
   * 通用确认弹窗，复用项目 .modal/.modalBox 样式，返回 Promise<boolean>。
   * @param {object} opts
   * @param {string} opts.title - 弹窗标题
   * @param {string} [opts.message] - 正文（支持多行 \n）
   * @param {string} [opts.confirmText='确认'] - 确认按钮文字
   * @param {string} [opts.cancelText='取消'] - 取消按钮文字
   * @param {boolean} [opts.danger=false] - 确认按钮是否为危险色
   */
  function showConfirmDialog({ title, message = '', confirmText = '确认', cancelText = '取消', danger = false } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal';
      overlay.style.zIndex = '90';
      const msgHtml = message
        ? `<div style="margin-top:12px;font-size:14px;line-height:1.6;color:rgba(15,23,42,0.72);white-space:pre-wrap;">${escapeHtml(message)}</div>`
        : '';
      overlay.innerHTML =
        `<div class="modalBox" style="max-width:380px;">` +
        `  <div class="modalTop"><div><div class="modalTitle">${escapeHtml(title)}</div></div></div>` +
        msgHtml +
        `  <div class="row modalActions" style="margin-top:16px;">` +
        `    <button class="secondary" type="button" data-role="cancel">${escapeHtml(cancelText)}</button>` +
        `    <button class="${danger ? 'secondary' : 'buyBtn'}" type="button" data-role="ok" ${danger ? 'style="border-color:rgba(239,68,68,0.36);background:rgba(254,202,202,0.92);color:#7f1d1d;font-weight:800;"' : ''}>${escapeHtml(confirmText)}</button>` +
        `  </div>` +
        `</div>`;

      function cleanup(result) {
        overlay.remove();
        resolve(result);
      }

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) cleanup(false);
        if (e.target.dataset?.role === 'cancel') cleanup(false);
        if (e.target.dataset?.role === 'ok') cleanup(true);
      });

      document.body.appendChild(overlay);
    });
  }

  async function safeFetchJson(url, opts) {
    try {
      const resp = await fetchJson(url, opts);
      if (!opts?.skipAnnouncementGate && resp?.status === 403 && resp?.data?.error === 'announcement_ack_required') {
        window.setTimeout(() => refreshAnnouncementAccessState(), 0);
      }
      return resp;
    } catch (err) {
      return { status: 0, data: { error: 'network_error', message: String(err?.message || err) } };
    }
  }

  function clearAnnouncementNextTimer() {
    if (state.announcementNextTimer) clearTimeout(state.announcementNextTimer);
    state.announcementNextTimer = null;
  }

  function scheduleAnnouncementNextCheck(nextCheckAt, serverTime) {
    clearAnnouncementNextTimer();
    const next = Number(nextCheckAt || 0);
    const server = Number(serverTime || nowSec());
    if (!Number.isFinite(next) || next <= server) return;
    const delay = Math.min(2147483647, Math.max(1000, (next - server + 1) * 1000));
    state.announcementNextTimer = setTimeout(() => refreshAnnouncementAccessState(), delay);
  }

  function setAnnouncementGateError(message) {
    const box = document.getElementById('announcementGateError');
    if (!box) return;
    box.textContent = message ? String(message) : '';
    box.classList.toggle('hidden', !message);
  }

  function renderAnnouncementGate() {
    const gate = document.getElementById('announcementGate');
    const current = state.announcementPending[0] || null;
    state.announcementCurrent = current;
    if (!gate) return;
    if (!current) {
      gate.classList.add('hidden');
      updateModalScrollLock();
      if (state.announcementReadyResolver) {
        const resolve = state.announcementReadyResolver;
        state.announcementReadyResolver = null;
        resolve(true);
      }
      return;
    }
    const required = Number(current.requires_acknowledgement || 0) === 1;
    setText('announcementGateProgress', `${required ? '必须确认' : '全屏公告'} · 第 1 / ${state.announcementPending.length} 项`);
    setText('announcementGateTitle', current.title || '公告');
    setText('announcementGateRevision', `v${Number(current.revision || 1)}`);
    setText('announcementGateMeta', current.publish_at ? `发布时间：${fmtTs(current.publish_at)}` : '即时发布');
    setText('announcementGateContent', current.content || '');
    const consent = document.getElementById('announcementGateConsent');
    const checkbox = document.getElementById('announcementGateCheckbox');
    const confirm = document.getElementById('announcementGateConfirm');
    const dismiss = document.getElementById('announcementGateDismiss');
    if (consent) consent.classList.toggle('hidden', !required);
    if (checkbox) checkbox.checked = false;
    if (confirm) {
      confirm.classList.toggle('hidden', !required);
      confirm.disabled = required;
      confirm.textContent = '确认并继续';
    }
    if (dismiss) dismiss.classList.toggle('hidden', required);
    setAnnouncementGateError('');
    gate.classList.remove('hidden');
    updateModalScrollLock();
  }

  async function submitAnnouncementAction(action) {
    const current = state.announcementCurrent;
    if (!current || state.announcementSubmitting) return;
    state.announcementSubmitting = true;
    const confirm = document.getElementById('announcementGateConfirm');
    const dismiss = document.getElementById('announcementGateDismiss');
    if (confirm) confirm.disabled = true;
    if (dismiss) dismiss.disabled = true;
    setAnnouncementGateError('');
    try {
      const resp = await safeFetchJson(`/mall/announcements/${encodeURIComponent(current.id)}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: current.revision,
          content_hash: current.content_hash,
          action,
        }),
        skipAnnouncementGate: true,
      });
      if (!resp?.data?.ok) {
        if (resp?.status === 409) {
          await refreshAnnouncementAccessState({ force: true });
          setAnnouncementGateError('公告内容已更新，请阅读最新版本后重新确认。');
          return;
        }
        setAnnouncementGateError(resp?.data?.message || '提交失败，请稍后重试。');
        return;
      }
      state.announcementPending = Array.isArray(resp.data.pending) ? resp.data.pending : [];
      scheduleAnnouncementNextCheck(resp.data.next_check_at, resp.data.server_time);
      renderAnnouncementGate();
    } finally {
      state.announcementSubmitting = false;
      if (dismiss) dismiss.disabled = false;
      const required = Number(state.announcementCurrent?.requires_acknowledgement || 0) === 1;
      const checkbox = document.getElementById('announcementGateCheckbox');
      if (confirm) confirm.disabled = required && !checkbox?.checked;
    }
  }

  async function waitForAnnouncementAccess() {
    const ready = await refreshAnnouncementAccessState();
    if (ready) return true;
    return await new Promise((resolve) => {
      state.announcementReadyResolver = resolve;
    });
  }

  function bindAnnouncementGate() {
    if (state.announcementGateBound) return;
    state.announcementGateBound = true;
    const checkbox = document.getElementById('announcementGateCheckbox');
    const confirm = document.getElementById('announcementGateConfirm');
    const dismiss = document.getElementById('announcementGateDismiss');
    checkbox?.addEventListener('change', () => {
      if (confirm) confirm.disabled = !checkbox.checked || state.announcementSubmitting;
    });
    confirm?.addEventListener('click', () => {
      if (!state.announcementCurrent) {
        refreshAnnouncementAccessState({ force: true });
        return;
      }
      submitAnnouncementAction('acknowledged');
    });
    dismiss?.addEventListener('click', () => submitAnnouncementAction('dismissed'));
  }

  async function refreshAnnouncementAccessState({ force = false } = {}) {
    if (state.announcementRefreshInFlight) {
      const inFlight = state.announcementRefreshInFlight;
      if (!force) return inFlight;
      await inFlight;
      return refreshAnnouncementAccessState();
    }
    const request = (async () => {
      const resp = await safeFetchJson('/mall/access-state', { skipAnnouncementGate: true });
      if (!resp?.data?.ok) {
        state.announcementPending = [];
        state.announcementCurrent = null;
        const gate = document.getElementById('announcementGate');
        if (gate) gate.classList.remove('hidden');
        setText('announcementGateProgress', '访问状态校验');
        setText('announcementGateTitle', '暂时无法加载公告');
        setText('announcementGateRevision', '');
        setText('announcementGateMeta', '请检查网络后重试');
        setText('announcementGateContent', '系统暂时无法确认您是否已阅读最新规则。为保护访问安全，业务功能暂不可用。');
        document.getElementById('announcementGateConsent')?.classList.add('hidden');
        document.getElementById('announcementGateDismiss')?.classList.add('hidden');
        const confirm = document.getElementById('announcementGateConfirm');
        if (confirm) { confirm.classList.remove('hidden'); confirm.disabled = false; confirm.textContent = '重新加载'; }
        setAnnouncementGateError(resp?.data?.message || '访问状态校验失败');
        updateModalScrollLock();
        return false;
      }
      state.announcementPending = Array.isArray(resp.data.pending) ? resp.data.pending : [];
      scheduleAnnouncementNextCheck(resp.data.next_check_at, resp.data.server_time);
      renderAnnouncementGate();
      return state.announcementPending.length === 0;
    })();
    state.announcementRefreshInFlight = request;
    try {
      return await request;
    } finally {
      if (state.announcementRefreshInFlight === request) state.announcementRefreshInFlight = null;
    }
  }

  function isNetworkError(resp) {
    return resp?.status === 0 || resp?.data?.error === 'network_error';
  }

  function isUnauthorized(resp) {
    return resp?.data?.error === 'unauthorized' || resp?.status === 401;
  }

  async function reauthIfNeeded() {
    if (state.reauthInFlight) return false;
    const cfg = state.cfg;
    if (!cfg || !window.dd?.runtime?.permission?.requestAuthCode) {
      state.reauthInFlight = true;
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const params = new URLSearchParams({ redirect: returnTo });
      window.location.replace(`/login?${params.toString()}`);
      return false;
    }
    state.reauthInFlight = true;
    try {
      const authCode = await new Promise((resolve, reject) => {
        window.dd.runtime.permission.requestAuthCode({
          corpId: cfg.corpId,
          onSuccess: (info) => resolve(info?.code || ''),
          onFail: (err) => reject(err),
        });
      });
      if (!authCode) return false;
      const auth = await safeFetchJson(`/web/auth?code=${encodeURIComponent(authCode)}`);
      if (auth?.data?.userid) {
        setUserIdentity(auth?.data?.name, auth?.data?.avatar);
        setUserSource(auth?.data?.source);
        syncMeIdentity({ userid: auth?.data?.userid, name: auth?.data?.name });
        bindAnnouncementGate();
        if (!(await waitForAnnouncementAccess())) return false;
        ensureMallRealtime(true);
        await refreshBalanceAndLedger();
        return true;
      }
      return false;
    } catch (_) {
      return false;
    } finally {
      state.reauthInFlight = false;
    }
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

  async function refreshRealtimeSnapshot() {
    await loadMallOpening();
    await loadRedPacketStatus();
    if (state.activeTab === 'balance') {
      await refreshBalanceAndLedger();
      return;
    }
    if (state.activeTab === 'shop') {
      if (isMallOpen(state.opening) || isMallEasterUnlocked()) {
        await loadProducts(undefined, { force: true });
      }
      await loadCharityProjects();
      return;
    }
    if (state.activeTab === 'market') {
      if (state.marketTab === 'auction') await loadAuctionList();
      else if (state.marketTab === 'auction-mine') await loadMyAuction();
      else await loadMarketData();
      return;
    }
    if (state.activeTab === 'orders') {
      await loadOrders();
      return;
    }
    if (state.activeTab === 'more') {
      await loadMoreData();
      if (state.activeMoreTab === 'rich') {
        if (state.activeRichTab === 'wealth') await loadRichBoard();
        else await loadPopularProducts();
      }
    }
  }

  function handleRealtimeOrderEvent(payload) {
    const exchangeId = payload?.exchange_id ? String(payload.exchange_id) : '';
    const status = payload?.status ? String(payload.status) : '';
    if (exchangeId && state.qrModalExchangeId === exchangeId && status === 'fulfilled') {
      closeQrModal();
      showNotice('核销完成', 'success');
      switchTab('balance');
      scheduleRealtimeTask('balance', async () => {
        await refreshBalanceAndLedger();
      }, 20);
    }
    scheduleRealtimeTask('orders', async () => {
      await loadOrders();
      if (state.activeTab === 'more') {
        await loadMoreData();
      }
    });
  }

  function handleMallRealtimeEvent(eventName, payload) {
    if (eventName === 'snapshot') {
      setRealtimeNotice('');
      if (!state.hasSeenRealtimeSnapshot) {
        state.hasSeenRealtimeSnapshot = true;
        return;
      }
      scheduleRealtimeTask('snapshot', async () => {
        await refreshRealtimeSnapshot();
      }, 20);
      return;
    }
    if (eventName === 'ping') {
      setRealtimeNotice('');
      return;
    }
    if (eventName === 'balance_changed') {
      scheduleRealtimeTask('balance', async () => {
        await refreshBalanceAndLedger();
        if (state.activeTab === 'more') {
          await loadMoreData();
        }
        if (state.activeTab === 'more' && state.activeMoreTab === 'rich' && state.activeRichTab === 'wealth') {
          await loadRichBoard();
        }
        if (state.activeTab === 'market') {
          await loadMarketData();
        }
      });
      return;
    }
    if (eventName === 'order_updated') {
      handleRealtimeOrderEvent(payload);
      scheduleRealtimeTask('market', async () => {
        if (state.activeTab === 'market') {
          await loadMarketData();
        }
      });
      if (state.activeTab === 'more' && state.activeMoreTab === 'rich' && state.activeRichTab === 'products') {
        scheduleRealtimeTask('rich_products', async () => {
          await loadPopularProducts();
        });
      }
      return;
    }
    if (eventName === 'products_changed') {
      scheduleRealtimeTask('products', async () => {
        await loadProducts(undefined, { force: true });
      });
      if (state.activeTab === 'more' && state.activeMoreTab === 'rich' && state.activeRichTab === 'products') {
        scheduleRealtimeTask('rich_products', async () => {
          await loadPopularProducts();
        });
      }
      return;
    }
    if (eventName === 'charity_changed') {
      scheduleRealtimeTask('charity', async () => {
        await loadCharityProjects();
        if (state.activeCharityProjectId) {
          await loadCharityProjectDetail(null, state.activeCharityProjectId);
        }
      });
      return;
    }
    if (eventName === 'opening_changed') {
      scheduleRealtimeTask('market', async () => {
        if (state.activeTab === 'market') {
          await loadMarketData();
        }
      });
      scheduleRealtimeTask('opening', async () => {
        await refreshOpeningOnce();
      }, 20);
      return;
    }
    if (eventName === 'market_changed') {
      scheduleRealtimeTask('market', async () => {
        if (state.activeTab === 'market') {
          await loadMarketData();
        }
      });
      return;
    }
    if (eventName === 'red_packet_changed') {
      scheduleRealtimeTask('red_packet', async () => {
        await loadRedPacketStatus();
      }, 20);
      return;
    }
    if (eventName === 'auction_changed') {
      scheduleRealtimeTask('auction', async () => {
        const detailOpen = state.auctionDetailId
          && !document.getElementById('auctionDetailModal')?.classList.contains('hidden');
        if (detailOpen) {
          await loadAuctionDetail(state.auctionDetailId);
        }
        if (isAuctionVisible()) {
          if (state.marketTab === 'auction-mine') {
            await loadMyAuction();
          } else {
            await loadAuctionList();
          }
        }
      }, 60);
      return;
    }
    if (eventName === 'announcement_access_changed') {
      scheduleRealtimeTask('announcement_access', async () => {
        await refreshAnnouncementAccessState({ force: true });
      }, 20);
      return;
    }
    if (eventName === 'more_changed') {
      if (state.activeTab === 'more') {
        scheduleRealtimeTask('more', async () => {
          await loadMoreData();
        });
      }
    }
  }

  // 服务端每 25 秒发一次 ping；超过这个时长没有任何动静，说明连接已经名存实亡
  // （锁屏后 WebView 常把套接字留在半开状态：readyState 仍是 OPEN/CONNECTING，却再也收不到数据）。
  const REALTIME_STALE_MS = 60_000;
  const REALTIME_RETRY_MIN_MS = 5_000;
  const REALTIME_RETRY_MAX_MS = 30_000;

  function isMallRealtimeAlive(source) {
    if (!source || source.readyState === window.EventSource.CLOSED) return false;
    return Date.now() - state.realtimeLastActivityAt <= REALTIME_STALE_MS;
  }

  function markMallRealtimeActivity() {
    state.realtimeLastActivityAt = Date.now();
    state.realtimeRetryDelay = 0;
    state.realtimeAuthLost = false;
  }

  // 非 200 响应（429 限流、503 满载、401 会话失效）会让 EventSource 进入 CLOSED，浏览器不再自动重试，
  // 只能由页面自己重建。先探一次会话：已失效就停下并如实提示，否则按退避间隔重连（同一时间只挂一个定时器）。
  async function handleMallRealtimeClosed(source) {
    if (state.eventsSource !== source) return;
    source.close();
    state.eventsSource = null;
    state.realtimeProbing = true;
    let me;
    try {
      me = await safeFetchJson('/web/me');
    } finally {
      state.realtimeProbing = false;
    }
    // 探测期间若已被 revive 重建，交给新连接
    if (state.eventsSource) return;
    if (me?.status === 401) {
      state.realtimeAuthLost = true;
      clearRealtimeRetry();
      setRealtimeNotice('登录已失效，请重新进入页面');
      return;
    }
    setRealtimeNotice('实时连接正在重试...');
    scheduleMallRealtimeRetry();
  }

  function scheduleMallRealtimeRetry() {
    if (state.realtimeRetryTimer || state.realtimeAuthLost) return;
    // 后台时不排定时器，回到前台由 reviveMallRealtime 立即重连
    if (document.hidden) return;
    const delay = state.realtimeRetryDelay
      ? Math.min(REALTIME_RETRY_MAX_MS, state.realtimeRetryDelay * 2)
      : REALTIME_RETRY_MIN_MS;
    state.realtimeRetryDelay = delay;
    state.realtimeRetryTimer = setTimeout(() => {
      state.realtimeRetryTimer = null;
      ensureMallRealtime();
    }, delay);
  }

  // 回到前台 / 网络恢复 / 从往返缓存恢复：不等退避，立即检查并在需要时重建
  function reviveMallRealtime() {
    clearRealtimeRetry();
    state.realtimeAuthLost = false;
    state.realtimeProbing = false;
    ensureMallRealtime();
  }

  function ensureMallRealtime(forceReconnect = false) {
    if (typeof window.EventSource === 'undefined') {
      setRealtimeNotice('当前环境不支持实时更新，请手动刷新');
      return null;
    }
    if (forceReconnect) {
      clearRealtimeRetry();
      state.realtimeAuthLost = false;
      if (state.eventsSource) closeMallRealtime({ keepNotice: true });
    }
    if (state.eventsSource) {
      if (isMallRealtimeAlive(state.eventsSource)) return state.eventsSource;
      closeMallRealtime({ keepNotice: true });
    }
    // 会话探测中、退避等待中或会话已失效时不抢跑，交给探测结果、定时器或下一次 revive
    if (state.realtimeProbing || state.realtimeRetryTimer || state.realtimeAuthLost) return null;

    setRealtimeNotice(state.hasSeenRealtimeSnapshot ? '实时连接恢复中...' : '实时同步中...');
    const source = new window.EventSource('/mall/events');
    state.eventsSource = source;
    state.realtimeLastActivityAt = Date.now();

    source.onopen = () => {
      if (state.eventsSource !== source) return;
      markMallRealtimeActivity();
      setRealtimeNotice('');
    };
    source.onerror = () => {
      if (state.eventsSource !== source) return;
      if (source.readyState === window.EventSource.CLOSED) {
        void handleMallRealtimeClosed(source);
        return;
      }
      // CONNECTING：网络层断开，浏览器会按服务端下发的 retry 间隔自动重连
      setRealtimeNotice('实时连接正在重试...');
    };

    ['snapshot', 'ping', 'balance_changed', 'order_updated', 'products_changed', 'charity_changed', 'opening_changed', 'market_changed', 'red_packet_changed', 'auction_changed', 'more_changed', 'announcement_access_changed']
      .forEach((eventName) => {
        source.addEventListener(eventName, (evt) => {
          if (state.eventsSource !== source) return;
          markMallRealtimeActivity();
          let payload = {};
          try {
            payload = evt?.data ? JSON.parse(evt.data) : {};
          } catch (_) {
            payload = {};
          }
          handleMallRealtimeEvent(eventName, payload);
        });
      });

    return source;
  }

  function humanizeBuyError(message, httpStatus) {
    const m = message === null || message === undefined ? '' : String(message);
    if (m === 'mall_closed') return '商城未到下单时间';
    if (m === 'insufficient balance') return '余额不足，无法下单';
    if (m === 'purchase_limit_reached') return '已达到该商品限购数量';
    if (m === 'out of stock') return '库存不足，已售罄';
    if (m === 'product not on sale') return '商品已下架';
    if (m === 'product not found') return '商品不存在';
    if (m === 'missing product_id') return '参数错误：缺少商品';
    if (m === 'exchange already redeemed') return '下单请求重复，请稍后刷新';
    if (m === 'unauthorized') return '未登录或登录已过期，请重新进入页面';
    if (m === 'QR_SIGN_SECRET missing') return '系统配置异常，请联系管理员';
    if (httpStatus && Number(httpStatus) >= 500) return '系统繁忙，请稍后再试';
    return m || '下单失败，请稍后再试';
  }

  function humanizeCharityError(message, httpStatus) {
    const m = message === null || message === undefined ? '' : String(message);
    if (m === 'missing project_id') return '缺少公益项目';
    if (m === 'invalid bob_amount') return '助力金额无效';
    if (m === 'charity project not found') return '公益项目不存在';
    if (m === 'charity project not active') return '当前项目暂不可助力';
    if (m === 'invalid charity tier') return '请选择有效的助力档位';
    if (m === 'insufficient balance') return '余额不足，无法助力';
    if (m === 'unauthorized') return '登录状态已失效，请重新进入页面';
    if (httpStatus && Number(httpStatus) >= 500) return '系统繁忙，请稍后再试';
    return m || '助力失败，请稍后再试';
  }

  function fmtTs(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    try {
      return new Date(n * 1000).toLocaleString('zh-CN', { hour12: false });
    } catch (_) {
      return String(ts);
    }
  }

  function fmtDate(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    try {
      return new Date(n * 1000).toLocaleDateString('zh-CN');
    } catch (_) {
      return String(ts);
    }
  }

  function humanizeFeedbackCategory(category) {
    const c = category ? String(category) : '';
    if (c === 'bug') return '问题';
    if (c === 'question') return '咨询';
    if (c === 'rule') return '规则相关';
    if (c === 'other') return '其他';
    return '建议';
  }

  function humanizeFeedbackStatus(status) {
    const s = status ? String(status) : '';
    if (s === 'resolved') return '已处理';
    if (s === 'processing') return '处理中';
    if (s === 'rejected') return '已驳回';
    return '待处理';
  }

  function humanizeMarketError(message, httpStatus) {
    const m = message === null || message === undefined ? '' : String(message).trim();
    if (m === 'not found') return '找不到目标订单';
    if (m === 'mall_open') return '商城开放中，交易市场暂停';
    if (m === 'market closed') return '交易市场已暂停';
    if (m === 'cannot trade own listing') return '不能购买自己上架的订单';
    if (m === 'insufficient balance') return '余额不足';
    if (m === 'invalid price') return '上架价格不符合要求';
    if (m === 'price out of range') return '上架价格不在参考区间内';
    if (m === 'already listed') return '该订单已上架';
    if (m === 'listing not found') return '挂单不存在';
    if (m === 'listing already canceled') return '挂单已取消';
    if (m === 'listing already sold') return '挂单已成交';
    if (m === 'unauthorized') return '未登录或登录已过期，请重新进入页面';
    if (httpStatus && Number(httpStatus) >= 500) return '系统繁忙，请稍后重试';
    return m || '请求失败，请稍后重试';
  }

  function fmtPriceRange(minValue, maxValue) {
    const min = Number(minValue);
    const max = Number(maxValue);
    const minText = Number.isFinite(min) ? `${min}` : '-';
    const maxText = Number.isFinite(max) ? `${max}` : '-';
    if (minText === '-' && maxText === '-') return '-';
    if (minText === maxText) return minText;
    return `${minText} - ${maxText}`;
  }

  function marketIsOpen(payload) {
    if (payload === null || payload === undefined) return false;
    if (typeof payload === 'boolean') return payload;
    const value = payload?.market_open;
    if (value === undefined || value === null) return false;
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  function applyCharityTabUi() {
    const subnav = document.getElementById('charitySubnav');
    if (subnav) subnav.setAttribute('data-active-charity-tab', state.activeCharityTab || 'intro');
    setHidden('charityPanelIntro', state.activeCharityTab !== 'intro');
    setHidden('charityPanelLeaderboard', state.activeCharityTab !== 'leaderboard');
    setHidden('charityPanelRecent', state.activeCharityTab !== 'recent');
  }

  function openCharityDetailModal() {
    setCharityDetailVisible(true);
  }

  function closeCharityDetailModal() {
    setCharityDetailVisible(false);
  }

  function closeCharityConfirmModal() {
    state.charityPendingAmount = 0;
    setCharityConfirmVisible(false);
  }

  function renderCharityLeaderboard(rows) {
    const list = document.getElementById('charityLeaderboardList');
    if (!list) return;
    if (!rows || rows.length === 0) {
      list.innerHTML = '<div class="item muted">暂无助力排行</div>';
      return;
    }
    list.innerHTML = rows.map((row) => (
      `<div class="item">` +
      `<div class="orderTop">` +
      `<div>` +
      `<div class="orderTitle">第 ${Number(row?.rank || 0)} 名 · ${escapeHtml(String(row?.user_name_snapshot || row?.userid || '用户'))}</div>` +
      `<div class="orderMeta">累计助力 ${Number(row?.total_bob_amount || 0)} BOB 币 · ${Number(row?.contribution_count || 0)} 次</div>` +
      `</div>` +
      `<div class="pill pillOk">${Number(row?.total_bob_amount || 0)} BOB</div>` +
      `</div>` +
      `</div>`
    )).join('');
  }

  function renderCharityRecent(rows) {
    const list = document.getElementById('charityRecentList');
    if (!list) return;
    if (!rows || rows.length === 0) {
      list.innerHTML = '<div class="item muted">暂无助力动态</div>';
      return;
    }
    list.innerHTML = rows.map((row) => (
      `<div class="item">` +
      `<div class="orderTop">` +
      `<div>` +
      `<div class="orderTitle">${escapeHtml(String(row?.user_name_snapshot || row?.userid || '用户'))}</div>` +
      `<div class="orderMeta mono">${escapeHtml(fmtTs(row?.created_at))}</div>` +
      `</div>` +
      `<div class="pill pillOk">+${Number(row?.bob_amount || 0)} BOB</div>` +
      `</div>` +
      `</div>`
    )).join('');
  }

  function renderCharityProjects(rows) {
    const rail = document.getElementById('charityProjectRail');
    const btnMore = document.getElementById('btnCharityLoadMore');
    if (!rail) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      rail.innerHTML = '<div class="item muted">暂无公益项目</div>';
      if (btnMore) btnMore.classList.add('hidden');
      return;
    }
    const visibleCount = Math.max(2, Number(state.charityVisibleCount || 2));
    const visibleRows = list.slice(0, visibleCount);
    rail.innerHTML = visibleRows.map((row) => {
      const total = Number(row?.total_bob_amount || 0);
      const target = Number(row?.target_bob_amount || 0);
      const summary = row?.summary ? stripHtml(row.summary) : '';
      const imageUrl = row?.cover_image_url ? String(row.cover_image_url) : '';
      const statusText = row?.status === 'paused' ? '暂停助力' : (row?.goal_reached ? '已达标' : '进行中');
      return (
        `<div class="charityProjectCard" data-charity-project="${escapeHtml(String(row?.project_id || ''))}">` +
        `<div class="charityProjectCardMedia">${imageUrl ? `<div class="imgFallback"></div><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(String(row?.project_name || '公益项目'))}" referrerpolicy="no-referrer" onerror="this.classList.add('hidden')" />` : '<div class="imgFallback">公益项目</div>'}` +
        `<button class="charityProjectDetailHint" type="button" aria-label="查看公益项目详情" data-charity-detail="${escapeHtml(String(row?.project_id || ''))}">` +
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>` +
        `</button>` +
        `</div>` +
        `<div class="charityProjectCardBody">` +
        `<div class="charityProjectChipTitle">${escapeHtml(String(row?.project_name || row?.project_id || '公益项目'))}</div>` +
        `<div class="charityProjectCardSummary">${escapeHtml(summary || '点击查看项目详情、规则与助力榜单')}</div>` +
        `<div class="charityProjectChipMeta">累计 ${total} / ${target} BOB 币<br>人数 ${Number(row?.donor_count || 0)} · ${escapeHtml(statusText)}</div>` +
        `</div>` +
        `</div>`
      );
    }).join('');
    if (btnMore) btnMore.classList.toggle('hidden', visibleCount >= list.length);
  }

  function renderCharityDetail(row) {
    if (!row) return;
    const imageUrl = row?.cover_image_url ? String(row.cover_image_url) : '';
    const image = document.getElementById('charityHeroImage');
    if (image) image.src = imageUrl;
    setHidden('charityHeroMediaWrap', !imageUrl);
    setText('charityHeroTitle', row?.project_name ? String(row.project_name) : '-');
    setRichHtml('charityHeroSummary', row?.summary ? String(row.summary) : '', '-');
    setText('charityTargetAmount', `${Number(row?.target_bob_amount || 0)} BOB 币`);
    setText('charityTotalAmount', `${Number(row?.total_bob_amount || 0)} BOB 币`);
    setText('charityDonorCount', `${Number(row?.donor_count || 0)} 人`);
    setText('charityContributionCount', `${Number(row?.contribution_count || 0)} 次`);
    setRichHtml('charityRulesText', row?.rules_text ? String(row.rules_text) : '', '暂无规则');
    setText('charityProgressText', `当前进度 ${Number(row?.progress_percent || 0)}%`);
    const progress = document.getElementById('charityProgressValue');
    if (progress) progress.style.width = `${Math.max(0, Math.min(100, Number(row?.progress_percent || 0)))}%`;
    const statusRow = document.getElementById('charityStatusRow');
    if (statusRow) {
      statusRow.innerHTML = row?.execution_note ? `<div class="charityExecutionNote">${sanitizeRichHtml(row.execution_note)}</div>` : '';
      statusRow.classList.toggle('hidden', !row?.execution_note);
    }
    const amountSelect = document.getElementById('charityAmountSelect');
    const contributeBtn = document.getElementById('btnCharityContribute');
    if (amountSelect) {
      const tiers = Array.isArray(row?.tier_options) ? row.tier_options : [];
      amountSelect.innerHTML = tiers.map((amount) => `<option value="${Number(amount)}">助力 ${Number(amount)} BOB 币</option>`).join('');
      amountSelect.disabled = row?.status !== 'active' || state.charityContributeBusy || tiers.length === 0;
    }
    if (contributeBtn) {
      contributeBtn.disabled = row?.status !== 'active' || state.charityContributeBusy || !Array.isArray(row?.tier_options) || row.tier_options.length === 0;
      contributeBtn.textContent = state.charityContributeBusy ? '助力中…' : '立即助力';
    }
    renderCharityLeaderboard(row?.leaderboard || []);
    renderCharityRecent(row?.recent_contributions || []);
    applyCharityTabUi();
  }

  async function loadCharityProjectDetail(seq, projectId) {
    const pid = projectId ? String(projectId) : '';
    if (!pid) {
      state.charityProjectDetail = null;
      renderCharityDetail(null);
      return null;
    }
    const resp = await safeFetchJson(`/mall/charity/project?project_id=${encodeURIComponent(pid)}`);
    if (seq && isStale(seq)) return null;
    if (isUnauthorized(resp)) {
      setText('charityProjectsErr', '请刷新页面重试或者重新进一次');
      reauthIfNeeded();
      return null;
    }
    if (isNetworkError(resp)) {
      setText('charityProjectsErr', '网络异常，正在重试…');
      return null;
    }
    if (!resp?.data?.ok) {
      setText('charityProjectsErr', humanizeCharityError(resp?.data?.error || resp?.status || '', resp?.status));
      return null;
    }
    setText('charityProjectsErr', '');
    state.charityProjectDetail = resp.data?.data || null;
    renderCharityDetail(state.charityProjectDetail);
    return state.charityProjectDetail;
  }

  async function loadCharityProjects(seq) {
    const rail = document.getElementById('charityProjectRail');
    if (rail && (!state.charityProjects || state.charityProjects.length === 0)) {
      rail.innerHTML = '<div class="listLoading">正在加载公益项目…</div>';
    }
    const resp = await safeFetchJson('/mall/charity/projects');
    if (seq && isStale(seq)) return state.charityProjects;
    if (isUnauthorized(resp)) {
      setText('charityProjectsErr', '请刷新页面重试或者重新进一次');
      reauthIfNeeded();
      return state.charityProjects;
    }
    if (isNetworkError(resp)) {
      setText('charityProjectsErr', '网络异常，正在重试…');
      return state.charityProjects;
    }
    if (!resp?.data?.ok) {
      setText('charityProjectsErr', humanizeCharityError(resp?.data?.error || resp?.status || '', resp?.status));
      return state.charityProjects;
    }

    const rows = Array.isArray(resp?.data?.data) ? resp.data.data : [];
    state.charityProjects = rows;
    state.charityVisibleCount = Math.max(2, Math.min(rows.length || 2, state.charityVisibleCount || 2));
    if (!state.activeCharityProjectId || !rows.some((row) => String(row?.project_id || '') === String(state.activeCharityProjectId))) {
      const preferred = rows.find((row) => String(row?.status || '') === 'active') || rows[0] || null;
      state.activeCharityProjectId = preferred?.project_id ? String(preferred.project_id) : '';
    }
    renderCharityProjects(rows);
    setText('charityProjectsErr', '');
    await loadCharityProjectDetail(seq, state.activeCharityProjectId);
    return rows;
  }

  function openCharityContributeConfirm(amount) {
    const row = state.charityProjectDetail;
    const bobAmount = Number(amount || 0);
    if (!row?.project_id || !Number.isFinite(bobAmount) || bobAmount <= 0) return;
    state.charityPendingAmount = bobAmount;
    setText('charityConfirmProject', row?.project_name ? String(row.project_name) : String(row?.project_id || '-'));
    setText('charityConfirmAmount', `${bobAmount} BOB 币`);
    setText('charityConfirmBalance', Number.isFinite(Number(state.me?.balance ?? NaN)) ? `${Number(state.me.balance)} BOB 币` : '--');
    setCharityConfirmVisible(true);
  }

  async function contributeCharity(amount) {
    const row = state.charityProjectDetail;
    const bobAmount = Number(amount || 0);
    if (!row?.project_id || !Number.isFinite(bobAmount) || bobAmount <= 0) return;
    if (state.charityContributeBusy) return;
    if (String(row?.status || '') !== 'active') {
      setText('charityContributeErr', '当前项目暂不可助力');
      return;
    }

    state.charityContributeBusy = true;
    setText('charityContributeErr', '');
    try {
      const resp = await safeFetchJson('/mall/charity/contribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: row.project_id, bob_amount: bobAmount }),
      });
      if (!resp?.data?.ok) {
        const message = humanizeCharityError(resp?.data?.error || resp?.status || '', resp?.status);
        setText('charityContributeErr', '');
        showNotice(message, 'error');
        return;
      }
      showNotice('助力成功，感谢你的善意', 'success');
      closeCharityConfirmModal();
      await refreshBalanceAndLedger();
      await loadCharityProjects();
    } finally {
      state.charityContributeBusy = false;
      renderCharityDetail(state.charityProjectDetail);
    }
  }

  function humanizeAnnouncementLevel(level) {
    const lv = level ? String(level) : '';
    if (lv === 'success') return '成功';
    if (lv === 'warning') return '提醒';
    if (lv === 'danger') return '重要';
    return '通知';
  }

  function clearCountdown() {
    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
  }

  function clearCloseCountdown() {
    if (state.closeCountdownTimer) {
      clearInterval(state.closeCountdownTimer);
      state.closeCountdownTimer = null;
    }
  }

  function formatCountdown(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = String(Math.floor(n / 3600)).padStart(2, '0');
    const m = String(Math.floor((n % 3600) / 60)).padStart(2, '0');
    const s = String(n % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  function refreshOpeningOnce() {
    state.openingRefreshPending = true;
    if (state.openingRefreshPromise) return state.openingRefreshPromise;

    let request;
    request = (async () => {
      while (state.openingRefreshPending) {
        state.openingRefreshPending = false;
        try {
          await loadMallOpening();
          if (isMallOpen(state.opening) && (!state.products || state.products.length === 0)) {
            const products = await loadProducts(undefined, { force: true });
            state.products = products;
            renderProductsWithFilterAndOrder(state.products);
          }
        } catch (err) {
          if (!state.openingRefreshPending) throw err;
        }
      }
    })().finally(() => {
      if (state.openingRefreshPromise === request) {
        state.openingRefreshPromise = null;
      }
    });
    state.openingRefreshPromise = request;
    return request;
  }

  function applyMallOverlay(row) {
    const overlay = document.getElementById('mallOverlay');
    const productsWrap = document.getElementById('shopProductsWrap');
    if (!overlay) return;
    const open = isMallOpen(row);
    const showOverlay = state.activeTab === 'shop' && !open && !isMallEasterUnlocked();
    overlay.classList.toggle('hidden', !showOverlay);
    if (productsWrap) productsWrap.classList.toggle('hidden', showOverlay);
    syncCartViewButtonState();
    const cartModal = document.getElementById('cartModal');
    if (cartModal && !cartModal.classList.contains('hidden')) {
      // Keep cart checkout button in sync with the latest mall opening state.
      renderCartModal();
    }
    if (open) {
      clearCountdown();
      return;
    }
    if (!showOverlay) {
      clearCountdown();
      return;
    }

    const nextTs = Number(row?.next_open_at);
    const hasNextOpenTime = Number.isFinite(nextTs) && nextTs > 0;
    const nextLabel = document.getElementById('mallNextOpenLabel');
    const nextBox = document.getElementById('mallNextOpenAt');
    if (nextLabel) nextLabel.classList.toggle('hidden', !hasNextOpenTime);
    if (nextBox) nextBox.classList.toggle('hidden', !hasNextOpenTime);
    const nextText = Number.isFinite(nextTs) && nextTs > 0 ? fmtTs(nextTs) : '-';
    if (nextBox) nextBox.textContent = nextText;

    const countdownBox = document.getElementById('mallCountdown');
    clearCountdown();
    if (!Number.isFinite(nextTs) || nextTs <= 0) {
      if (countdownBox) countdownBox.textContent = '--:--:--';
      return;
    }

    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      const diff = Math.max(0, nextTs - now);
      if (countdownBox) countdownBox.textContent = formatCountdown(diff);
      if (diff <= 0) {
        clearCountdown();
        void refreshOpeningOnce().catch(() => {});
      }
    };
    tick();
    state.countdownTimer = setInterval(tick, 1000);
  }

  function applyCloseCountdown(row) {
    const box = document.getElementById('shopCloseTimer');
    const value = document.getElementById('shopCloseCountdown');
    if (!box || !value) return;
    const isOpen = Number(row?.is_open) === 1;
    const autoEnabled = Number(row?.auto_enabled) === 1;
    const openAt = Number(row?.open_notify_for_open_at);
    const duration = Number(row?.open_duration_minutes);
    if (!autoEnabled || !isOpen || !Number.isFinite(openAt) || !Number.isFinite(duration) || duration <= 0) {
      box.classList.add('hidden');
      clearCloseCountdown();
      return;
    }

    const closeAt = openAt + duration * 60;
    if (!Number.isFinite(closeAt) || closeAt <= 0) {
      box.classList.add('hidden');
      clearCloseCountdown();
      return;
    }

    box.classList.toggle('hidden', state.activeTab !== 'shop');
    clearCloseCountdown();

    const tick = () => {
      if (state.activeTab !== 'shop') {
        value.textContent = '--:--:--';
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const diff = Math.max(0, closeAt - now);
      value.textContent = formatCountdown(diff);
      if (diff <= 0) {
        clearCloseCountdown();
        void refreshOpeningOnce().catch(() => {});
      }
    };
    tick();
    state.closeCountdownTimer = setInterval(tick, 1000);
  }

  function setHidden(id, hidden) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('hidden', !!hidden);
  }

  function setQrModalVisible(visible) {
    const m = document.getElementById('qrModal');
    if (!m) return;
    m.classList.toggle('hidden', !visible);
    updateModalScrollLock();
  }

  function showQrModal({ exchangeId, encoded, qrImageUrl, hint, productTitle, amountText, balanceText, createdAt = null, cdkInfoAvailable = false, marketListAvailable = false, refundAvailable = true }) {
    const img = document.getElementById('qrImg');
    const exchangeBox = document.getElementById('qrExchangeId');
    const encodedBox = document.getElementById('qrEncoded');
    const hintBox = document.getElementById('qrHint');
    const productBox = document.getElementById('qrProduct');
    const amountBox = document.getElementById('qrAmount');
    const balanceBox = document.getElementById('qrBalance');
    const createdAtBox = document.getElementById('qrCreatedAt');

    if (hintBox) hintBox.textContent = hint || '请出示给核销人员扫码';
    if (productBox) productBox.textContent = productTitle ? `商品：${String(productTitle)}` : '';
    if (amountBox) amountBox.textContent = amountText ? `价格：${String(amountText)}` : '';
    if (balanceBox) balanceBox.textContent = balanceText ? `剩余：${String(balanceText)}` : '';
    if (createdAtBox) createdAtBox.textContent = createdAt ? `下单时间：${fmtTs(createdAt)}` : '';
    if (exchangeBox) exchangeBox.textContent = exchangeId ? `订单号：${String(exchangeId)}` : '';
    if (encodedBox) encodedBox.textContent = encoded ? String(encoded) : '';

    if (img) {
      img.src = qrImageUrl ? String(qrImageUrl) : '';
    }

    const safeExchangeId = exchangeId ? String(exchangeId) : '';
    const safeEncoded = encoded ? String(encoded) : '';
    const safeQrImageUrl = qrImageUrl ? String(qrImageUrl) : '';
    const safeHint = hint ? String(hint) : '';
    const safeProductTitle = productTitle ? String(productTitle) : '';
    const safeAmountText = amountText ? String(amountText) : '';
    const safeBalanceText = balanceText ? String(balanceText) : '';
    const safeCreatedAt = Number(createdAt);
    const cdkAvailable = cdkInfoAvailable === true || Number(cdkInfoAvailable || 0) === 1;
    const marketListVisible = marketListAvailable === true || Number(marketListAvailable || 0) === 1;
    const refundVisible = refundAvailable === true || Number(refundAvailable || 0) === 1;

    state.qrModalExchangeId = safeExchangeId || null;
    state.qrModalPayload = {
      exchangeId: safeExchangeId,
      encoded: safeEncoded,
      qrImageUrl: safeQrImageUrl,
      hint: safeHint,
      productTitle: safeProductTitle,
      amountText: safeAmountText,
      balanceText: safeBalanceText,
      createdAt: Number.isFinite(safeCreatedAt) && safeCreatedAt > 0 ? safeCreatedAt : null,
      cdkInfoAvailable: cdkAvailable,
      marketListAvailable: marketListVisible,
      refundAvailable: refundVisible,
    };
    setHidden('btnQrCdkInfo', !cdkAvailable);
    setHidden('btnQrListMarket', !marketListVisible);
    setHidden('btnQrRefund', !refundVisible);
    setQrModalVisible(true);
  }

  function closeQrModal(options = {}) {
    const keepPayload = options?.keepPayload === true;
    state.qrModalExchangeId = null;
    if (!keepPayload) state.qrModalPayload = null;
    setHidden('btnQrCdkInfo', true);
    setHidden('btnQrListMarket', true);
    setHidden('btnQrRefund', false);
    setQrModalVisible(false);
  }

  function closeConfirmModal() {
    state.pendingBuyProductId = null;
    const btnOk = document.getElementById('btnConfirmOk');
    const btnAddCart = document.getElementById('btnConfirmAddCart');
    if (btnOk) btnOk.disabled = false;
    if (btnAddCart) btnAddCart.disabled = false;
    setConfirmModalVisible(false);
  }

  function getCartCount() {
    return (state.cartItems || []).reduce((sum, x) => sum + Math.max(0, Number(x?.qty || 0)), 0);
  }

  function getProductById(productId) {
    const pid = productId ? String(productId) : '';
    if (!pid) return null;
    return (state.products || []).find((x) => String(x?.product_id || '') === pid) || null;
  }

  function getProductLimitInfo(p) {
    const totalRaw = p?.limit_total ?? p?.limit_per_user;
    const totalNum = totalRaw === null || totalRaw === undefined ? 0 : Number(totalRaw);
    const total = Number.isFinite(totalNum) && totalNum > 0 ? Math.floor(totalNum) : 0;
    if (total <= 0) {
      return { enabled: false, total: 0, used: 0, remaining: Infinity, reached: false };
    }

    const usedRaw = p?.limit_used;
    const usedNum = usedRaw === null || usedRaw === undefined ? 0 : Number(usedRaw);
    const used = Math.min(total, Math.max(0, Number.isFinite(usedNum) ? Math.floor(usedNum) : 0));
    const remainingRaw = p?.limit_remaining;
    const remainingNum = remainingRaw === null || remainingRaw === undefined ? NaN : Number(remainingRaw);
    const remaining = Math.max(0, Number.isFinite(remainingNum) ? Math.floor(remainingNum) : total - used);
    return {
      enabled: true,
      total,
      used,
      remaining,
      reached: remaining <= 0 || p?.limit_reached === true,
    };
  }

  function getCartQtyForProduct(productId) {
    const pid = productId ? String(productId) : '';
    const item = (state.cartItems || []).find((x) => String(x?.productId || '') === pid);
    return Math.max(0, Math.floor(Number(item?.qty || 0)));
  }

  function updateCartViewButton() {
    const btn = document.getElementById('btnCartView');
    if (!btn) return;
    const count = getCartCount();
    btn.textContent = `购物车（${count}）`;
  }

  function isCartViewLocked() {
    if (!state.opening) return false;
    return !isMallOpen(state.opening) && !isMallEasterUnlocked();
  }

  function syncCartViewButtonState() {
    const btn = document.getElementById('btnCartView');
    if (!btn) return;
    const locked = isCartViewLocked();
    btn.classList.toggle('pseudoDisabled', locked);
    btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
    btn.title = locked ? '商城未到下单时间' : '';
  }

  function upsertCartItem(productId, delta) {
    const pid = productId ? String(productId) : '';
    let step = Number(delta);
    if (!pid || !Number.isFinite(step) || step === 0) return false;
    step = Math.trunc(step);
    if (step === 0) return false;

    if (step > 0) {
      const row = getProductById(pid);
      const limit = getProductLimitInfo(row);
      if (limit.enabled) {
        const currentQty = getCartQtyForProduct(pid);
        const allowed = Math.max(0, limit.remaining - currentQty);
        if (allowed <= 0) return false;
        step = Math.min(step, allowed);
      }
    }

    const idx = state.cartItems.findIndex((x) => String(x?.productId || '') === pid);
    if (idx < 0) {
      if (step > 0) {
        state.cartItems.push({ productId: pid, qty: Math.max(1, Math.floor(step)) });
      }
    } else {
      const nextQty = Math.floor(Number(state.cartItems[idx]?.qty || 0) + step);
      if (nextQty <= 0) {
        state.cartItems.splice(idx, 1);
      } else {
        state.cartItems[idx].qty = nextQty;
      }
    }
    saveCartToStorage();
    updateCartViewButton();
    return true;
  }

  function addToCart(productId) {
    const row = getProductById(productId);
    if (!row) {
      showNotice('商品不存在，无法加入购物车', 'error');
      return false;
    }
    if (!isProductInStock(row)) {
      showNotice('该商品已售罄，无法加入购物车', 'error');
      return false;
    }
    if (!upsertCartItem(row.product_id, 1)) {
      showNotice('已达到该商品限购数量', 'error');
      return false;
    }
    showNotice(`已加入购物车：${String(row?.product_name || row?.product_id || '')}`, 'success');
    return true;
  }

  function renderCartModal() {
    const list = document.getElementById('cartList');
    const totalBox = document.getElementById('cartTotal');
    const balanceBox = document.getElementById('cartBalance');
    const btnCheckout = document.getElementById('btnCartCheckout');
    if (!list || !totalBox || !balanceBox || !btnCheckout) return;

    const rows = state.cartItems || [];
    if (!rows.length) {
      list.innerHTML = '<div class="cartEmpty">购物车还是空的，先去选点商品吧</div>';
      totalBox.textContent = '0 BOB 币';
      balanceBox.textContent = Number.isFinite(Number(state.me?.balance ?? NaN)) ? `${state.me.balance} BOB 币` : '--';
      btnCheckout.disabled = true;
      return;
    }

    let total = 0;
    let validCount = 0;
    let blockedCount = 0;
    list.innerHTML = rows
      .map((item) => {
        const pid = String(item?.productId || '');
        const qty = Math.max(1, Math.floor(Number(item?.qty || 1)));
        const row = getProductById(pid);
        const name = row?.product_name ? String(row.product_name) : pid;
        const amount = Number(row?.bob_amount);
        const inStock = !!row && isProductInStock(row);
        const amountOk = Number.isFinite(amount) && amount > 0;
        const lineAmount = amountOk ? amount * qty : 0;
        const limit = getProductLimitInfo(row);
        const overLimit = limit.enabled && qty > limit.remaining;
        if (inStock && amountOk && !overLimit) {
          total += lineAmount;
          validCount += qty;
        } else if (overLimit) {
          blockedCount += 1;
        }
        const statusText = !row ? '商品已不存在' : (!inStock ? '已售罄' : (amountOk ? `${amount} BOB / 件` : '价格异常'));
        const limitText = limit.enabled ? ` · 已购 ${limit.used}/${limit.total}` : '';
        const blockText = overLimit ? ` · 本轮还可下单 ${limit.remaining} 件` : '';
        const incDisabled = !row || !inStock || overLimit || (limit.enabled && qty >= limit.remaining);
        return `<div class="cartItem">
          <div>
            <div class="cartItemTitle">${escapeHtml(name)}</div>
            <div class="cartItemMeta">${escapeHtml(statusText)}${escapeHtml(limitText)}${escapeHtml(blockText)} · 小计 ${escapeHtml(String(lineAmount))} BOB</div>
          </div>
          <div class="cartQty">
            <button class="cartQtyBtn" type="button" data-cart-dec="${escapeHtml(pid)}">-</button>
            <div class="cartQtyNum">${escapeHtml(String(qty))}</div>
            <button class="cartQtyBtn" type="button" data-cart-inc="${escapeHtml(pid)}" ${incDisabled ? 'disabled' : ''}>+</button>
          </div>
        </div>`;
      })
      .join('');

    const balance = Number(state.me?.balance ?? NaN);
    const balanceOk = Number.isFinite(balance);
    const mallLocked = !isMallOpen(state.opening) && !isMallEasterUnlocked();
    totalBox.textContent = `${total} BOB 币`;
    balanceBox.textContent = balanceOk ? `${balance} BOB 币` : '--';
    const affordable = balanceOk ? balance >= total : false;
    balanceBox.classList.toggle('confirmBalanceBad', balanceOk && !affordable);

    btnCheckout.disabled = state.cartCheckoutInFlight || validCount <= 0 || blockedCount > 0 || mallLocked;
  }

  function openCartModal() {
    renderCartModal();
    setCartModalVisible(true);
  }

  function closeCartModal() {
    setCartModalVisible(false);
  }

  async function checkoutCart() {
    if (state.cartCheckoutInFlight) return;
    const mallLocked = !isMallOpen(state.opening) && !isMallEasterUnlocked();
    if (mallLocked) {
      showNotice('商场未开启，当前不可下单', 'error');
      return;
    }
    const queue = [];
    for (const item of state.cartItems || []) {
      const pid = String(item?.productId || '');
      const qty = Math.max(1, Math.floor(Number(item?.qty || 1)));
      const row = getProductById(pid);
      if (!row || !isProductInStock(row)) continue;
      const limit = getProductLimitInfo(row);
      if (limit.enabled && qty > limit.remaining) {
        showNotice(`已达到${String(row?.product_name || row?.product_id || '该商品')}限购数量`, 'error');
        renderCartModal();
        return;
      }
      for (let i = 0; i < qty; i += 1) {
        queue.push(pid);
      }
    }
    if (!queue.length) {
      showNotice('购物车没有可下单的商品', 'error');
      return;
    }

    state.cartCheckoutInFlight = true;
    renderCartModal();
    const bought = [];
    const errors = [];
    try {
      for (const pid of queue) {
        const result = await buy(pid, { quiet: true, skipReload: true });
        if (result?.ok) bought.push(pid);
        else errors.push(result?.error || '下单失败');
      }
      if (bought.length > 0) {
        for (const pid of bought) {
          upsertCartItem(pid, -1);
        }
      }
      await loadAll();
      renderCartModal();
      const failed = Math.max(0, queue.length - bought.length);
      if (bought.length > 0) {
        showNotice(
          `已下单 ${bought.length} 件${failed > 0 ? `，失败 ${failed} 件` : ''}，请到订单页查看并核销`,
          failed > 0 ? 'error' : 'success',
        );
        switchTab('orders');
      } else {
        const firstError = errors.length ? `：${errors[0]}` : '';
        showNotice(`批量下单未成功${firstError}`, 'error');
      }
    } finally {
      state.cartCheckoutInFlight = false;
      renderCartModal();
    }
  }

  function openConfirmModal(p) {
    if (!p?.product_id) return;
    state.pendingBuyProductId = String(p.product_id);

    const name = p?.product_name ? String(p.product_name) : String(p.product_id);
    const amount = Number(p?.bob_amount);
    const amountText = Number.isFinite(amount) ? `${amount} BOB 币` : '-';
    const limit = getProductLimitInfo(p);
    const limitReached = limit.enabled && limit.remaining <= 0;

    const productBox = document.getElementById('confirmProduct');
    const amountBox = document.getElementById('confirmAmount');
    const limitBox = document.getElementById('confirmLimit');
    const balanceBox = document.getElementById('confirmBalance');
    if (productBox) productBox.textContent = name;
    if (amountBox) amountBox.textContent = amountText;
    if (limitBox) {
      limitBox.textContent = limit.enabled ? `已购 ${limit.used}/${limit.total}` : '不限';
      limitBox.classList.toggle('confirmBalanceBad', limitReached);
    }
    const btnOk = document.getElementById('btnConfirmOk');
    const btnAddCart = document.getElementById('btnConfirmAddCart');
    if (btnOk) btnOk.disabled = limitReached;
    if (btnAddCart) btnAddCart.disabled = limitReached;
    if (balanceBox) {
      balanceBox.textContent = '加载中…';
      balanceBox.classList.remove('confirmBalanceBad');
    }

    setConfirmModalVisible(true);

    if (balanceBox) {
      fetchJson('/mall/me')
        .then((me) => {
          const balance = Number(me?.data?.balance ?? NaN);
          const ok = Number.isFinite(balance);
          const insufficient = ok && Number.isFinite(amount) && balance < amount;
          const diff = ok && Number.isFinite(amount) ? balance - amount : NaN;
          const balanceText = ok
            ? `${insufficient ? diff : balance} BOB 币`
            : '--';
          balanceBox.textContent = balanceText;
          balanceBox.classList.toggle('confirmBalanceBad', insufficient);
        })
        .catch(() => {
          balanceBox.textContent = '--';
          balanceBox.classList.remove('confirmBalanceBad');
        });
    }
  }

  function getDefaultOrdersFilter(rows) {
    const hasPending = (rows || []).some((x) => String(x?.status || '') !== 'fulfilled');
    return hasPending ? 'pending' : 'fulfilled';
  }

  function applyOrdersFilterUi() {
    const filterWrap = document.querySelector('.ordersFilter');
    if (filterWrap) {
      filterWrap.setAttribute('data-active-filter', state.ordersFilter || '');
    }
    document.querySelectorAll('[data-orders-filter]').forEach((btn) => {
      const v = btn.getAttribute('data-orders-filter');
      btn.classList.toggle('active', v === state.ordersFilter);
    });
  }

  function applyOrdersTimeFilterUi() {
    const timeWrap = document.querySelector('.ordersTimeFilter');
    if (timeWrap) {
      timeWrap.setAttribute('data-active-time-filter', state.ordersTimeFilter || 'all');
    }
    document.querySelectorAll('[data-orders-time-filter]').forEach((btn) => {
      const v = btn.getAttribute('data-orders-time-filter');
      btn.classList.toggle('active', v === state.ordersTimeFilter);
    });
  }

  function applyRichTabUi() {
    const subnav = document.getElementById('richSubnav');
    if (subnav) {
      subnav.setAttribute('data-active-rich-tab', state.activeRichTab || 'wealth');
    }
    document.querySelectorAll('[data-rich-tab]').forEach((btn) => {
      const tab = btn.getAttribute('data-rich-tab');
      btn.classList.toggle('active', tab === state.activeRichTab);
    });
    
    setHidden('richPanelWealth', isExternalUser() || state.activeRichTab !== 'wealth');
    setHidden('richPanelProducts', state.activeRichTab !== 'products');
  }

  function switchRichTab(name) {
    let next = name === 'wealth' || name === 'products' ? name : 'wealth';
    if (isExternalUser() && next === 'wealth') next = 'products';
    state.activeRichTab = next;
    applyRichTabUi();
    
    if (next === 'wealth') {
      loadRichBoard();
    } else if (next === 'products') {
      loadPopularProducts();
    }
  }

  function renderOrdersStats(rows, visibleCount) {
    const box = document.getElementById('ordersStat');
    if (!box) return;
    const total = (rows || []).length;
    let pending = 0;
    let fulfilled = 0;
    for (const x of rows || []) {
      const isPending = String(x?.status || '') !== 'fulfilled';
      if (isPending) pending += 1;
      else fulfilled += 1;
    }
    box.textContent = `共 ${total} 单 · 未核销 ${pending} · 已核销 ${fulfilled} · 当前显示 ${visibleCount}`;
  }

  function applyShopFilterUi() {
    const select = document.getElementById('shopFilterSelect');
    if (!select) return;
    select.value = state.shopFilter || 'all';
  }

  function applyMoreTabUi() {
    const subnav = document.getElementById('moreSubnav');
    if (subnav) {
      subnav.setAttribute('data-active-more-tab', state.activeMoreTab || 'announcements');
    }
    setHidden('morePanelAnnouncements', state.activeMoreTab !== 'announcements');
    setHidden('morePanelRich', state.activeMoreTab !== 'rich');
    setHidden('morePanelFaq', state.activeMoreTab !== 'faq');
    setHidden('morePanelStats', state.activeMoreTab !== 'stats');
    setHidden('morePanelVersion', state.activeMoreTab !== 'version');
    setHidden('morePanelFeedback', state.activeMoreTab !== 'feedback');
  }

  function switchMoreTab(name) {
    const next = name === 'faq' || name === 'rich' || name === 'stats' || name === 'version' || name === 'feedback'
      ? name
      : 'announcements';
    const prev = state.activeMoreTab;
    state.activeMoreTab = next;
    applyMoreTabUi();
    if (next === prev || state.activeTab !== 'more') return;
    if (next === 'rich') {
      applyRichTabUi();
      if (state.activeRichTab === 'wealth') {
        loadRichBoard().catch(() => null);
      } else {
        loadPopularProducts().catch(() => null);
      }
    }
  }

  function isProductInStock(p) {
    const stockRaw = p?.stock;
    const stockNum = stockRaw === null || stockRaw === undefined ? null : Number(stockRaw);
    if (stockNum === null) return true;
    return Number.isFinite(stockNum) && stockNum > 0;
  }

  function isProductAffordable(p) {
    const balance = Number(state.me?.balance ?? NaN);
    const amount = Number(p?.bob_amount ?? NaN);
    if (!Number.isFinite(balance) || balance < 0) return false;
    if (!Number.isFinite(amount) || amount <= 0) return false;
    if (!isProductInStock(p)) return false;
    if (getProductLimitInfo(p).reached) return false;
    return amount <= balance;
  }

  function switchTab(name) {
    // 兼容旧入口链接：?tab=auction / ?tab=rich
    let requested = name;
    let legacySub = '';
    if (requested === 'auction') {
      requested = 'market';
      legacySub = 'auction';
    } else if (requested === 'rich') {
      requested = 'more';
      legacySub = 'rich';
    }
    const tab = requested === 'shop' || requested === 'orders' || requested === 'more' || requested === 'market'
      ? requested
      : 'balance';
    state.activeTab = tab;

    document.querySelectorAll('.navBtn').forEach((btn) => {
      const t = btn.getAttribute('data-tab');
      btn.classList.toggle('active', t === tab);
    });

    setHidden('tabBalance', tab !== 'balance');
    setHidden('tabShop', tab !== 'shop');
    setHidden('shopActions', tab !== 'shop');
    setHidden('tabMarket', tab !== 'market');
    setHidden('tabOrders', tab !== 'orders');
    setHidden('tabMore', tab !== 'more');

    if (tab === 'balance') {
      refreshBalanceAndLedger();
    }
    if (tab === 'more') {
      if (legacySub === 'rich' || state.activeMoreTab === 'rich') {
        state.activeMoreTab = 'rich';
      }
      applyMoreTabUi();
      loadMoreData();
      if (state.activeMoreTab === 'rich') {
        applyRichTabUi();
        if (state.activeRichTab === 'wealth') {
          loadRichBoard().catch(() => null);
        } else {
          loadPopularProducts().catch(() => null);
        }
      }
    }
    if (tab === 'market') {
      if (legacySub === 'auction' || state.marketTab === 'auction' || state.marketTab === 'auction-mine') {
        state.marketTab = legacySub === 'auction' ? 'auction' : state.marketTab;
      } else {
        state.marketTab = 'buy';
      }
      applyMarketTabUi();
      startAuctionTimer();
      if (state.marketTab === 'auction') {
        loadAuctionList().catch(() => null);
      } else if (state.marketTab === 'auction-mine') {
        loadMyAuction().catch(() => null);
      } else {
        loadMarketData();
      }
    }

    if (state.opening) {
      applyMallOverlay(state.opening);
      applyCloseCountdown(state.opening);
    }
  }

  function getTabFromUrl() {
    try {
      const sp = new URLSearchParams(window.location.search || '');
      const t = sp.get('tab');
      if (t === 'shop' || t === 'orders' || t === 'balance' || t === 'rich' || t === 'more' || t === 'market' || t === 'auction') return t;
      return null;
    } catch (_) {
      return null;
    }
  }

  function normalizeReason(reason) {
    const r = reason === null || reason === undefined ? '' : String(reason).trim();
    return r;
  }

  function reasonToHuman(reason, { delta, refId, productName, peerName }) {
    const r = normalizeReason(reason);
    if (!r) {
      return delta < 0 ? '支出' : '收入';
    }
    if (r === 'mall_buy') {
      return productName ? `商城下单：${productName}` : '商城下单';
    }
    if (r.startsWith('公益助力：')) return r;
    if (r === 'red_packet') return '红包收入';
    if (r === 'auction_bid') return '竞拍出价（冻结）';
    if (r === 'auction_outbid_refund') return '竞拍被超出退回';
    if (r === 'auction_cancel_refund') return '竞拍取消退回';
    if (r === 'auction_settle_refund') return '竞拍成交释放冻结';
    if (r === 'auction_win_pay') return '竞拍成交扣款';
    if (r === 'admin_deduct') return '管理员扣币';
    if (r === 'redeem') return '核销扣币';
    if (r === 'grant') return '系统发币';
    if (r === 'transfer_out') return `转出：${peerName || '对方'}`;
    if (r === 'transfer_in') return `转入：${peerName || '对方'}`;
    return r;
  }

  function getProductNameByExchangeId(exchangeId) {
    if (!exchangeId) return '';
    const row = (state.orders || []).find((o) => String(o?.exchange_id || '') === String(exchangeId));
    const name = row?.product_name ? String(row.product_name) : '';
    return name;
  }

  function renderLedger(rows) {
    const list = document.getElementById('ledger');
    if (!list) return;
    // 保留最近一次快照：mall_coin.js 晚于首次加载完成初始化时可直接读取，不依赖事件先后
    const ledgerRows = Array.isArray(rows) ? rows : [];
    window.bobLatestLedger = ledgerRows;
    try {
      window.dispatchEvent(new CustomEvent('bob:ledger', { detail: { rows: ledgerRows } }));
    } catch (_) {}
    if (!rows || rows.length === 0) {
      list.innerHTML = '<div class="item muted">暂无流水</div>';
      return;
    }

    list.innerHTML = rows
      .map((x) => {
        const delta = Number(x?.delta);
        const deltaText = Number.isFinite(delta) ? (delta > 0 ? `+${delta}` : (delta < 0 ? `−${Math.abs(delta)}` : '0')) : '-';
        const reasonRaw = x?.reason ? String(x.reason) : '';
        const refId = x?.ref_id ? String(x.ref_id) : '';
        const ts = fmtTs(x?.created_at);
        const peerNameRaw = x?.peer_name ? String(x.peer_name) : '';

        const productName = getProductNameByExchangeId(refId);
        const reason = x?.display_reason ? String(x.display_reason) : reasonToHuman(reasonRaw, { delta, refId, productName, peerName: peerNameRaw });

        const out = delta < 0;
        const title = reason ? escapeHtml(reason) : '-';

        return (
          `<div class="item ledgerRow">` +
          `<span class="ledgerMk ${out ? 'ledgerMkOut' : 'ledgerMkIn'}" aria-label="${out ? '支出' : '收入'}">${out ? '−' : '+'}</span>` +
          `<div class="ledgerTxt">` +
          `<div class="ledgerTitle">${title}</div>` +
          `<div class="ledgerTime">${escapeHtml(ts)}</div>` +
          `</div>` +
          `<div class="ledgerDelta serifNum ${out ? 'ledgerDeltaBad' : 'ledgerDeltaGood'}">${escapeHtml(deltaText)}</div>` +
          `</div>`
        );
      })
      .join('');
  }

  function renderTransferList(rows) {
    const list = document.getElementById('transferList');
    if (!list) return;
    if (!rows || rows.length === 0) {
      list.innerHTML = '<div class="item muted">没有匹配到用户</div>';
      return;
    }
    const selected = state.transferTarget ? String(state.transferTarget.userid) : '';
    list.innerHTML = rows
      .map((x) => {
        const userid = x?.userid ? String(x.userid) : '';
        const name = x?.name ? String(x.name) : '';
        const displayName = x?.display_name ? String(x.display_name) : (name || userid || '用户');
        const active = userid && selected && userid === selected ? 'transferItem transferItemActive' : 'transferItem';
        return (
          `<div class="${active}" data-userid="${escapeHtml(userid)}" data-name="${escapeHtml(name)}" data-display="${escapeHtml(displayName)}">` +
          `<div>` +
          `<div class="transferItemName">${escapeHtml(displayName)}</div>` +
          `<div class="transferItemMeta">${escapeHtml(userid)}</div>` +
          `</div>` +
          `<div class="pill pillOk">选择</div>` +
          `</div>`
        );
      })
      .join('');
  }

  function setTransferTarget(user) {
    state.transferTarget = user ? { ...user } : null;
    const targetBox = document.getElementById('transferTarget');
    if (!targetBox) return;
    if (!state.transferTarget) {
      targetBox.textContent = '未选择';
      return;
    }
    const displayName =
      state.transferTarget.display_name ||
      state.transferTarget.name ||
      state.transferTarget.userid ||
      '用户';
    targetBox.innerHTML =
      `<div class="transferTargetLines">` +
      `<div class="transferTargetName">收款人：${escapeHtml(displayName)}</div>` +
      `<div class="transferTargetMeta">用户UserID：${escapeHtml(state.transferTarget.userid || '-')}</div>` +
      `</div>`;
  }

  async function fetchTransferCandidates(keyword, seq) {
    const kw = String(keyword || '').trim();
    if (!kw) {
      state.transferCandidates = [];
      renderTransferList([]);
      setTransferListVisible(false);
      return;
    }
    setTransferListVisible(true);
    const resp = await safeFetchJson(`/mall/users?keyword=${encodeURIComponent(kw)}&limit=8`);
    if (seq && seq !== state.transferSearchSeq) return;
    if (resp?.data?.error) {
      renderTransferList([]);
      showNotice(resp.data.error, 'error');
      return;
    }
    const rows = Array.isArray(resp?.data?.data) ? resp.data.data : [];
    state.transferCandidates = rows;
    renderTransferList(rows);
  }

  function openTransferModal() {
    const keyword = document.getElementById('transferKeyword');
    const amount = document.getElementById('transferAmount');
    if (keyword) keyword.value = '';
    if (amount) amount.value = '';
    state.transferCandidates = [];
    state.transferTarget = null;
    renderTransferList([]);
    setTransferTarget(null);
    setTransferModalVisible(true);
    setTransferConfirmVisible(false);
    setTransferListVisible(false);
    if (keyword) {
      requestAnimationFrame(() => keyword.focus());
    }
  }

  function closeTransferModal() {
    setTransferModalVisible(false);
    setTransferConfirmVisible(false);
  }

  function mapTransferError(message) {
    const msg = String(message || '');
    if (msg === 'insufficient balance') return '余额不足';
    if (msg === 'cannot transfer to self') return '不能给自己转账';
    if (msg === 'missing to userid') return '缺少对方 userid';
    if (msg === 'amount must be positive integer') return '转账数量需为正整数';
    if (msg === 'transfer_not_allowed_between_sources') return '外部活动账号只能与外部活动账号互转';
    return msg || '转账失败';
  }

  function handleTransfer() {
    const me = state.me || {};
    const fromUserid = me?.userid ? String(me.userid) : '';
    if (!fromUserid) {
      showNotice('登录同步中，请稍后再试', 'info');
      reauthIfNeeded();
      return;
    }
    openTransferModal();
  }

  function openTransferConfirm() {
    const target = state.transferTarget;
    if (!target?.userid) {
      showNotice('请选择收款人', 'error');
      return;
    }
    const amountBox = document.getElementById('transferAmount');
    const amountRaw = amountBox ? amountBox.value : '';
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      showNotice('转账数量需为正整数', 'error');
      return;
    }
    const nameBox = document.getElementById('transferConfirmName');
    const useridBox = document.getElementById('transferConfirmUserid');
    const amountBoxShow = document.getElementById('transferConfirmAmount');
    const displayName = target.display_name || target.name || target.userid || '用户';
    if (nameBox) nameBox.textContent = displayName;
    if (useridBox) useridBox.textContent = target.userid || '-';
    if (amountBoxShow) amountBoxShow.textContent = `${amount} BOB 币`;
    setTransferConfirmVisible(true);
  }

  async function submitTransfer() {
    const target = state.transferTarget;
    if (!target?.userid) {
      showNotice('请选择收款人', 'error');
      return;
    }
    const amountBox = document.getElementById('transferAmount');
    const amountRaw = amountBox ? amountBox.value : '';
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      showNotice('转账数量需为正整数', 'error');
      return;
    }
    const resp = await postJson('/ledger/transfer', { to_userid: target.userid, amount });
    if (resp?.data?.error) {
      showNotice(mapTransferError(resp.data.error), 'error');
      return;
    }
    const displayName = target.display_name || target.name || target.userid || '用户';
    showNotice(`已向 ${displayName} 转账 ${amount} BOB 币`, 'success');
    closeTransferModal();
    await refreshBalanceAndLedger();
  }

  function renderProducts(rows) {
    const list = document.getElementById('products');
    if (!list) return;
    if (!rows || rows.length === 0) {
      list.innerHTML = '<div class="productEmpty">暂无商品，稍后再来看看吧</div>';
      return;
    }

    list.innerHTML = rows
      .map((p) => {
        const productId = p?.product_id ? String(p.product_id) : '';
        const name = p?.product_name ? String(p.product_name) : '';
        const amount = Number(p?.bob_amount);
        const amountText = Number.isFinite(amount) ? String(amount) : '-';

        const stockRaw = p?.stock;
        const stockNum = stockRaw === null || stockRaw === undefined ? null : Number(stockRaw);
        const stockText = stockNum === null ? '库存：无限' : (Number.isFinite(stockNum) ? `库存：${stockNum}` : '库存：-');

        const limit = getProductLimitInfo(p);
        const limitText = limit.enabled ? `已购：${limit.used}/${limit.total}` : '';

        const imageUrl = p?.image_url ? String(p.image_url) : '';
        // 渐变兜底垫底，图片盖在上面；加载失败时隐藏图片露出兜底，避免出现浏览器裂图图标
        const imgHtml = `<div class="productImgFallback"></div>` + (imageUrl
          ? `<img class="productImg" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('hidden')" />`
          : '');

        const soldOut = stockNum !== null && Number.isFinite(stockNum) && stockNum <= 0;
        const limitReached = limit.enabled && limit.remaining <= 0;
        const soldOutHtml = soldOut
          ? `<div class="soldOutCardOverlay">售罄</div>`
          : (limitReached ? `<div class="soldOutCardOverlay">已达限购</div>` : '');

        const remark = p?.remark ? String(p.remark) : '';
        const metaText = [stockText, limitText].filter((x) => x).join(' · ');

        const cardAttrs = soldOut ? '' : ` data-product-id="${escapeHtml(productId)}"`;

        return (
          `<div class="productCard${soldOut ? ' productSoldOut' : ' productClickable'}${limitReached ? ' productLimitReached' : ''}"${cardAttrs}>` +
          `<div class="productMedia">${imgHtml}</div>` +
          `<div class="productBody">` +
          `<div class="productTitle">${escapeHtml(name || productId || '-') }</div>` +
          `<div class="productMeta">${escapeHtml(metaText || stockText)}</div>` +
          (remark ? `<div class="productRemark">${escapeHtml(remark)}</div>` : '') +
          `<div class="productActions">` +
          `<div class="productPrice"><i class="miniCoin" aria-hidden="true"></i><span class="productPriceNum">${escapeHtml(amountText)}</span><span class="productPriceUnit srOnly">BOB 币</span></div>` +
          `</div>` +
          `</div>` +
          `${soldOutHtml}` +
          `</div>`
        );
      })
      .join('');
  }

  function renderProductsLoading() {
    const list = document.getElementById('products');
    if (!list) return;
    // 骨架卡片与真实卡片同结构，撑住列表高度，数据到达时不跳动
    const skeleton =
      '<div class="productSkeleton" aria-hidden="true">' +
      '<div class="skelMedia"></div>' +
      '<div class="skelBody">' +
      '<div class="skelLine w70"></div>' +
      '<div class="skelLine w45"></div>' +
      '<div class="skelLine w45"></div>' +
      '</div>' +
      '</div>';
    list.innerHTML = skeleton.repeat(4);
  }

  function renderProductsLoadingFailed() {
    const list = document.getElementById('products');
    if (!list) return;
    list.innerHTML = '<div class="productEmpty">商品加载失败，请点击左上角刷新重试</div>';
  }

  function renderProductsWithFilterAndOrder(allRows) {
    const rows = Array.isArray(allRows) ? allRows : [];
    applyShopFilterUi();

    // 稳定分区：有货在前、售罄在后（各自内部保持原排序）
    const inStock = [];
    const soldOut = [];
    for (const x of rows) {
      if (isProductInStock(x)) inStock.push(x);
      else soldOut.push(x);
    }

    const ordered = state.shopFilter === 'in_stock'
      ? inStock
      : (state.shopFilter === 'affordable' ? inStock.filter((x) => isProductAffordable(x)) : inStock.concat(soldOut));
    renderProducts(ordered);
  }

  // ===== 商品搜索 =====

  function getProductSearchMatches(keyword) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return [];
    const rows = Array.isArray(state.products) ? state.products : [];
    const hit = rows.filter((p) => {
      const name = String(p?.product_name || '').toLowerCase();
      const remark = String(p?.remark || '').toLowerCase();
      const pid = String(p?.product_id || '').toLowerCase();
      return name.includes(kw) || remark.includes(kw) || pid.includes(kw);
    });
    // 有货优先，售罄沉底
    const inStock = [];
    const soldOut = [];
    for (const x of hit) {
      if (isProductInStock(x)) inStock.push(x);
      else soldOut.push(x);
    }
    return inStock.concat(soldOut);
  }

  function getProductRecommendations(limit) {
    const max = Math.max(1, Math.floor(Number(limit) || 6));
    const rows = Array.isArray(state.products) ? state.products : [];
    const usable = rows.filter((p) => {
      if (!isProductInStock(p)) return false;
      if (getProductLimitInfo(p).reached) return false;
      return Number.isFinite(Number(p?.bob_amount));
    });
    const affordable = usable.filter((p) => isProductAffordable(p));
    const pool = affordable.length > 0 ? affordable : usable;
    // 价格从低到高，先把「马上就能换」的推给用户
    return pool
      .slice()
      .sort((a, b) => Number(a?.bob_amount ?? 0) - Number(b?.bob_amount ?? 0))
      .slice(0, max);
  }

  function renderProductSearchRow(p) {
    const productId = p?.product_id ? String(p.product_id) : '';
    const name = p?.product_name ? String(p.product_name) : productId;
    const amount = Number(p?.bob_amount);
    const amountText = Number.isFinite(amount) ? String(amount) : '-';
    const stockRaw = p?.stock;
    const stockNum = stockRaw === null || stockRaw === undefined ? null : Number(stockRaw);
    const soldOut = stockNum !== null && Number.isFinite(stockNum) && stockNum <= 0;
    const limit = getProductLimitInfo(p);
    const limitReached = limit.enabled && limit.remaining <= 0;
    const disabled = soldOut || limitReached;

    const imageUrl = p?.image_url ? String(p.image_url) : '';
    const imgHtml = '<div class="psRowFallback"></div>' + (imageUrl
      ? `<img class="psRowImg" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('hidden')" />`
      : '');

    const stockText = stockNum === null ? '库存：无限' : (Number.isFinite(stockNum) ? `库存：${stockNum}` : '库存：-');
    const limitText = limit.enabled ? `已购：${limit.used}/${limit.total}` : '';
    const metaText = [stockText, limitText].filter((x) => x).join(' · ');

    const tag = soldOut ? '售罄' : (limitReached ? '已达限购' : '');
    const attrs = disabled ? '' : ` data-search-product-id="${escapeHtml(productId)}"`;

    return (
      `<div class="psRow${disabled ? ' psRowDisabled' : ''}"${attrs}>` +
      `<div class="psRowMedia">${imgHtml}</div>` +
      '<div class="psRowBody">' +
      `<div class="psRowName">${escapeHtml(name || '-')}</div>` +
      `<div class="psRowMeta">${escapeHtml(metaText)}</div>` +
      '</div>' +
      (tag
        ? `<div class="psRowTag">${escapeHtml(tag)}</div>`
        : `<div class="psRowPrice"><span class="psRowPriceNum">${escapeHtml(amountText)}</span><span class="psRowPriceUnit">BOB</span></div>`) +
      '</div>'
    );
  }

  function renderProductSearchBody() {
    const box = document.getElementById('productSearchBody');
    if (!box) return;

    const clearBtn = document.getElementById('btnProductSearchClear');
    const keyword = String(state.productSearchKeyword || '');
    if (clearBtn) clearBtn.classList.toggle('hidden', keyword.trim().length === 0);

    const rows = Array.isArray(state.products) ? state.products : [];
    if (rows.length === 0) {
      box.innerHTML = '<div class="psEmpty">商品还没加载好，先回商城刷新一下</div>';
      return;
    }

    let html = '';
    const kw = keyword.trim();
    if (kw) {
      const matches = getProductSearchMatches(kw);
      html += '<div class="psSectionHead"><div class="psSectionTitle">搜索结果</div>'
        + `<div class="psSectionHint">${matches.length} 个</div></div>`;
      html += matches.length > 0
        ? `<div class="psList">${matches.map((p) => renderProductSearchRow(p)).join('')}</div>`
        : '<div class="psEmpty">没找到相关商品，换个关键词试试</div>';
    }

    const recs = getProductRecommendations(kw ? 3 : 6);
    if (recs.length > 0) {
      html += '<div class="psSectionHead"><div class="psSectionTitle">推荐下单</div>'
        + '<div class="psSectionHint">余额够 · 有货</div></div>';
      html += `<div class="psList">${recs.map((p) => renderProductSearchRow(p)).join('')}</div>`;
    } else if (!kw) {
      html += '<div class="psEmpty">暂时没有可推荐的商品</div>';
    }

    box.innerHTML = html;
  }

  function openProductSearchModal() {
    setProductSearchVisible(true);
    renderProductSearchBody();
    const input = document.getElementById('productSearchInput');
    if (input) {
      // 弹窗出现后再聚焦，避免移动端键盘顶掉动画
      setTimeout(() => {
        try { input.focus(); } catch (_e) { /* noop */ }
      }, 60);
    }
  }

  function closeProductSearchModal() {
    setProductSearchVisible(false);
  }

  function renderMarketListings(rows) {
    const list = document.getElementById('marketListings');
    if (!list) return;
    const data = Array.isArray(rows) ? rows : [];
    const marketOpen = marketIsOpen(state.marketMine);

    if (!data.length) {
      list.innerHTML = '<div class="marketEmpty">暂无在售商品</div>';
      return;
    }

    list.innerHTML = data
      .map((x) => {
        const listingId = x?.listing_id ? String(x.listing_id) : '';
        const productName = x?.product_name ? String(x.product_name) : '';
        const seller = x?.seller_display_name ? String(x.seller_display_name) : '匿名';
        const price = Number(x?.price);
        const amountText = Number.isFinite(price) ? `${price} BOB 币` : '-';
        const exchangeId = x?.exchange_id ? String(x.exchange_id) : '';
        const canBuy = x?.can_buy === true || x?.can_buy === 1;
        const disabled = !marketOpen || !canBuy;
        const actionText = !marketOpen ? '暂停中' : (canBuy ? '购买' : '我的');
        const imageUrl = x?.product_image_url || '';
        const note = x?.seller_note || '';
        return (
          `<article class="marketItem marketListingItem" data-market-listing="${escapeHtml(listingId)}">` +
          `  <div class="marketItemMedia"><div class="imgFallback"></div>${imageUrl ? `<img class="marketItemImage" src="${escapeHtml(imageUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.classList.add('hidden')" />` : ''}</div>` +
          `  <div class="marketItemMeta">` +
          `    <div class="marketName">${escapeHtml(productName || exchangeId || '商品')}</div>` +
          `    <div class="marketPrice">${escapeHtml(amountText)}</div>` +
          `    <div class="marketSeller">卖家：${escapeHtml(seller)}</div>` +
          (note ? `    <div class="marketItemNote">"${escapeHtml(note)}"</div>` : '') +
          `  </div>` +
          `  <button class="marketPrimary secondary" type="button" data-market-buy="${escapeHtml(listingId)}" ${disabled ? 'disabled' : ''}>${actionText}</button>` +
          `</article>`
        );
      })
      .join('');
  }

  function renderMarketMine(data) {
    const mine = data && typeof data === 'object' ? data : { sellable_orders: [], my_listings: [] };
    const listingRows = Array.isArray(mine.my_listings) ? mine.my_listings : [];
    const sellableRows = Array.isArray(mine.sellable_orders) ? mine.sellable_orders : [];
    const marketOpen = marketIsOpen(state.marketMine);

    // Update pick button text
    const pickBtn = document.getElementById('btnMarketPickSellable');
    if (pickBtn) {
      if (!sellableRows.length) {
        pickBtn.textContent = '暂无可上架商品';
        pickBtn.disabled = true;
      } else {
        pickBtn.textContent = `选择商品上架（${sellableRows.length}）`;
        pickBtn.disabled = !marketOpen;
      }
    }

    const myListingsNode = document.getElementById('marketMyListings');
    if (!myListingsNode) return;

    const activeRows = listingRows.filter((x) => String(x?.status || '') === 'active');
    const historyRows = listingRows.filter((x) => String(x?.status || '') !== 'active');
    setText('marketActiveTitle', `上架中（${activeRows.length}）`);

    function buildListingCard(x) {
      const listingId = x?.listing_id ? String(x.listing_id) : '';
      const productName = x?.product_name ? String(x.product_name) : '-';
      const price = Number(x?.price);
      const priceText = Number.isFinite(price) ? `${price} BOB` : '-';
      const createdAt = x?.created_at ? fmtTs(x.created_at) : '';
      const status = x?.status ? String(x.status) : 'unknown';
      const statusText = status === 'active'
        ? '上架中'
        : status === 'sold'
          ? '已成交'
          : status === 'cancelled'
            ? '已取消'
            : status;
      const canCancel = status === 'active';
      const cancelDisabled = !marketOpen;
      return (
        `<article class="marketItem marketMineItem" data-market-my-listing="${escapeHtml(listingId)}">` +
        `  <div class="marketMineInfo">` +
        `    <div class="marketName">${escapeHtml(productName)}</div>` +
        `    <div class="marketMineSub">` +
        (createdAt ? `      <span class="marketMineTime">${escapeHtml(createdAt)}</span>` : '') +
        `      <span class="marketState marketState-${escapeHtml(status)}">${escapeHtml(statusText)}</span>` +
        `    </div>` +
        `  </div>` +
        `  <div class="marketMineActions">` +
        `    <div class="marketMinePrice">${escapeHtml(priceText)}</div>` +
        (canCancel
          ? `    <div class="marketMineControls"><button class="marketPrimary secondary" type="button" data-market-edit="${escapeHtml(listingId)}" ${cancelDisabled ? 'disabled' : ''}>编辑</button><button class="marketPrimary secondary" type="button" data-market-cancel="${escapeHtml(listingId)}" ${cancelDisabled ? 'disabled' : ''}>${cancelDisabled ? '暂停中' : '取消'}</button></div>`
          : '') +
        `  </div>` +
        `</article>`
      );
    }

    const activeCards = activeRows.map(buildListingCard).join('');
    const historyCards = historyRows.map(buildListingCard).join('');

    let html = '';
    if (activeCards) {
      html += activeCards;
    }
    if (historyCards) {
      html += `<details class="marketHistoryFold"><summary class="marketHistorySummary">历史记录（${historyRows.length}）</summary>${historyCards}</details>`;
    }

    myListingsNode.innerHTML = html || '<div class="marketEmpty">暂无挂出的商品</div>';
  }

  function renderOrders(rows) {
    const list = document.getElementById('orders');
    if (!list) return;
    if (!rows || rows.length === 0) {
      list.innerHTML = '<div class="item muted">暂无订单</div>';
      return;
    }

    list.innerHTML = rows
      .map((x) => {
        const name = x?.product_name ? String(x.product_name) : '';
        const pid = x?.product_id ? String(x.product_id) : '';
        const ts = fmtDate(x?.created_at);
        const exchangeId = x?.exchange_id ? String(x.exchange_id) : '';
        const status = x?.status ? String(x.status) : '';
        const isListed = status === 'listed' || x?.is_listed === true || Number(x?.is_listed || 0) === 1;
        const isPending = status === 'pending' && !isListed;
        const pill = isListed
          ? '<span class="pill pillListed">挂单中</span>'
          : (isPending ? '<span class="pill pillOk">待核销</span>' : '<span class="pill pillBad">已核销</span>');
        const isAuction = String(x?.redeem_source || '') === 'auction';
        const auctionPill = isAuction ? ' <span class="pill pillAuction">竞拍竞得</span>' : '';
        const title = name || pid || '-';

        const clickableClass = isPending ? ' orderClickable' : '';
        const dataAttr = isPending ? ` data-show-qr="${escapeHtml(exchangeId)}"` : ` data-order-detail="${escapeHtml(exchangeId)}"`;
        return (
          `<div class="item${clickableClass}"${dataAttr}>` +
          `<div class="orderTop">` +
          `<div class="orderTitle">${pill}${auctionPill} <span style="margin-left:8px;">${escapeHtml(title)}</span></div>` +
          `<div class="orderMeta mono">${escapeHtml(ts)}</div>` +
          `</div>` +
          `</div>`
        );
      })
      .join('');
  }

  function renderOrdersWithFilter(allRows) {
    const rows = Array.isArray(allRows) ? allRows : [];
    if (!state.ordersFilter) {
      state.ordersFilter = getDefaultOrdersFilter(rows);
    }

    if (state.ordersFilter === 'pending') {
      const hasPending = rows.some((x) => String(x?.status || '') !== 'fulfilled');
      if (!hasPending) {
        state.ordersFilter = 'fulfilled';
      }
    }
    applyOrdersFilterUi();
    applyOrdersTimeFilterUi();

    const statusFiltered = rows.filter((x) => {
      const isPending = String(x?.status || '') !== 'fulfilled';
      return state.ordersFilter === 'pending' ? isPending : !isPending;
    });
    const now = Math.floor(Date.now() / 1000);
    const timeRangeSec = state.ordersTimeFilter === '7d'
      ? 7 * 86400
      : (state.ordersTimeFilter === '30d' ? 30 * 86400 : null);
    const timeFiltered = statusFiltered.filter((x) => {
      if (!timeRangeSec) return true;
      const ts = Number(x?.created_at || 0);
      if (!Number.isFinite(ts) || ts <= 0) return false;
      return ts >= now - timeRangeSec;
    });
    const keyword = (state.ordersSearchKeyword || '').trim().toLowerCase();
    const filtered = timeFiltered.filter((x) => {
      if (!keyword) return true;
      const text = [
        x?.product_name ? String(x.product_name) : '',
        x?.product_id ? String(x.product_id) : '',
        x?.exchange_id ? String(x.exchange_id) : '',
      ].join(' ').toLowerCase();
      return text.includes(keyword);
    });
    renderOrders(filtered);
    renderOrdersStats(rows, filtered.length);
  }

  function renderRichBoard(rows) {
    const list = document.getElementById('richBoardList');
    if (!list) return;
    if (!rows || rows.length === 0) {
      list.innerHTML = '<div class="item muted">暂无排行数据</div>';
      return;
    }
    const topMap = new Map();
    for (const x of rows) {
      const rank = Number(x?.rank || 0);
      if (rank >= 1 && rank <= 3) {
        topMap.set(rank, x);
      }
    }
    const podiumOrder = [2, 1, 3];
    const podiumHtml = podiumOrder
      .filter((rank) => topMap.has(rank))
      .map((rank) => {
        const row = topMap.get(rank);
        const name = row?.display_name ? String(row.display_name) : String(row?.userid || '用户');
        const balance = Number(row?.balance ?? 0);
        const balanceText = Number.isFinite(balance) ? `${balance}` : '0';
        const crown = rank === 1
          ? `<div class="richCrown" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 8.5L7 12L12 5L17 12L21 8.5L19.2 19H4.8L3 8.5Z" fill="#F59E0B" stroke="#B45309" stroke-width="1.2"/>
                <circle cx="7" cy="12" r="1.1" fill="#FDE68A"/>
                <circle cx="12" cy="5" r="1.1" fill="#FDE68A"/>
                <circle cx="17" cy="12" r="1.1" fill="#FDE68A"/>
              </svg>
            </div>`
          : '';
        return `<div class="podiumItem rank${rank}">
          ${crown}
          <div class="podiumTop">TOP ${rank}</div>
          <div class="podiumName">${escapeHtml(name)}</div>
          <div class="podiumValue">${escapeHtml(balanceText)} BOB</div>
        </div>`;
      })
      .join('');

    const restRows = rows.filter((x) => Number(x?.rank || 0) > 3);
    const restHtml = restRows
      .map((x, idx) => {
        const rank = Number(x?.rank ?? (idx + 4));
        const name = x?.display_name ? String(x.display_name) : String(x?.userid || '用户');
        const balance = Number(x?.balance ?? 0);
        const balanceText = Number.isFinite(balance) ? `${balance}` : '0';
        return `<div class="richRow">
          <div class="richLeft">
            <div class="richRank">${escapeHtml(String(rank))}</div>
            <div class="richName">${escapeHtml(name)}</div>
          </div>
          <div class="richRight">${escapeHtml(balanceText)} BOB</div>
        </div>`;
      })
      .join('');

    list.innerHTML = `
      <div class="richPodium">${podiumHtml || '<div class="item muted">暂无前三榜单</div>'}</div>
      <div class="richRest">${restHtml || ''}</div>
    `;
  }

  function renderMoreFaq(rows) {
    const box = document.getElementById('moreFaq');
    if (!box) return;
    if (!rows || rows.length === 0) {
      box.innerHTML = '<div class="item muted">暂无 FAQ</div>';
      return;
    }
    box.innerHTML = rows
      .map((x, idx) => {
        const q = x?.question ? String(x.question) : '-';
        const a = x?.answer ? String(x.answer) : '';
        return `<div class="moreFaqItem">
          <details ${idx === 0 ? 'open' : ''}>
            <summary>${escapeHtml(q)}</summary>
            <div class="moreItemText">${escapeHtml(a)}</div>
          </details>
        </div>`;
      })
      .join('');
  }

  function renderMoreAnnouncements(rows) {
    const box = document.getElementById('moreAnnouncements');
    if (!box) return;
    if (!rows || rows.length === 0) {
      box.innerHTML = '<div class="item muted">暂无公告</div>';
      return;
    }
    box.innerHTML = rows
      .map((x) => {
        const title = x?.title ? String(x.title) : '公告';
        const content = x?.content ? String(x.content) : '';
        const level = x?.level ? String(x.level) : 'info';
        const timeText = fmtTs(x?.publish_at || x?.updated_at || x?.created_at);
        return `<div class="moreItem">
          <div class="moreItemTitle">
            <span class="moreAnnouncementTag ${escapeHtml(level)}">${escapeHtml(humanizeAnnouncementLevel(level))}</span>
            ${escapeHtml(title)}
          </div>
          <div class="moreItemText">${escapeHtml(content)}</div>
          <div class="moreItemMeta">${escapeHtml(timeText || '')}</div>
        </div>`;
      })
      .join('');
  }

  function renderMoreStats(data) {
    const box = document.getElementById('moreStats');
    if (!box) return;
    if (!data || typeof data !== 'object') {
      box.innerHTML = '<div class="item muted">暂无数据</div>';
      return;
    }
    const items = [
      { label: '当前余额', value: `${Number(data.balance ?? 0)} BOB` },
      { label: '待核销订单', value: String(Number(data.pending_orders ?? 0)) },
      { label: '已核销订单', value: String(Number(data.fulfilled_orders ?? 0)) },
      { label: '排行榜名次', value: data.rich_rank ? `第 ${Number(data.rich_rank)} 名` : '-', hidden: isExternalUser() },
      { label: '累计反馈', value: String(Number(data.feedback_count ?? 0)) },
    ].filter((x) => !x.hidden);
    box.innerHTML = items
      .map((x) => `<div class="moreStatsItem"><div class="moreStatsLabel">${escapeHtml(x.label)}</div><div class="moreStatsValue">${escapeHtml(x.value)}</div></div>`)
      .join('');
  }

  function renderMoreVersion(rows) {
    const box = document.getElementById('moreVersion');
    if (!box) return;
    if (!rows || rows.length === 0) {
      box.innerHTML = '<div class="item muted">暂无版本信息</div>';
      return;
    }
    
    const latest = rows[0];
    const history = rows.slice(1);
    
    let html = `<div class="moreItem">
      <div class="moreItemTitle">${escapeHtml(latest?.version_name || '')} <span style="font-size:12px;color:#666;">(最新)</span></div>
      <div class="moreItemText">${escapeHtml(latest?.release_notes || '暂无更新说明')}</div>
      <div class="moreItemMeta">${escapeHtml(fmtTs(latest?.publish_at || latest?.updated_at || latest?.created_at))}</div>
    </div>`;
    
    if (history.length > 0) {
      html += `<div style="margin-top:16px;">
        <button class="btn secondary" id="toggleVersionHistory" style="font-size:14px;padding:6px 12px;">
          查看历史版本 (${history.length})
        </button>
        <div id="versionHistoryList" style="display:none;margin-top:12px;">
          ${history.map((row, idx) => `
            <div class="moreItem" style="border-left:3px solid #e5e7eb;padding-left:12px;margin-bottom:12px;">
              <div class="moreItemTitle">${escapeHtml(row?.version_name || '')}</div>
              <div class="moreItemText">${escapeHtml(row?.release_notes || '暂无更新说明')}</div>
              <div class="moreItemMeta">${escapeHtml(fmtTs(row?.publish_at || row?.updated_at || row?.created_at))}</div>
            </div>
          `).join('')}
        </div>
      </div>`;
    }
    
    box.innerHTML = html;
    
    // 绑定展开/收起事件
    const toggleBtn = document.getElementById('toggleVersionHistory');
    const historyList = document.getElementById('versionHistoryList');
    if (toggleBtn && historyList) {
      toggleBtn.addEventListener('click', () => {
        const isHidden = historyList.style.display === 'none';
        historyList.style.display = isHidden ? 'block' : 'none';
        toggleBtn.textContent = isHidden ? '收起历史版本' : `查看历史版本 (${history.length})`;
      });
    }
  }

  function renderMoreMyFeedback(rows) {
    const box = document.getElementById('moreMyFeedback');
    if (!box) return;
    if (!rows || rows.length === 0) {
      box.innerHTML = '<div class="item muted">还没有提交过反馈</div>';
      return;
    }
    box.innerHTML = rows
      .map((x) => {
        const category = humanizeFeedbackCategory(x?.category);
        const status = humanizeFeedbackStatus(x?.status);
        const content = x?.content ? String(x.content) : '';
        const reply = x?.reply ? String(x.reply) : '';
        const timeText = fmtTs(x?.created_at);
        const idText = x?.id ? `#${String(x.id)}` : '';
        const previewText = content.trim().replace(/\s+/g, ' ');
        const preview = previewText.slice(0, 56) || '暂无内容';
        const messages = Array.isArray(x?.messages) && x.messages.length
          ? x.messages
          : [
            ...(content ? [{ sender_type: 'user', sender_name: '我', content, created_at: x?.created_at }] : []),
            ...(reply ? [{ sender_type: 'admin', sender_name: '管理员', content: reply, created_at: x?.handled_at }] : []),
          ];
        const thread = messages.map((m) => `<div class="moreFeedbackMsg ${m?.sender_type === 'admin' ? 'isAdmin' : 'isUser'}">
          <div class="moreFeedbackMsgMeta">${m?.sender_type === 'admin' ? '管理员' : '我'} · ${escapeHtml(fmtTs(m?.created_at) || '')}</div>
          <div class="moreFeedbackMsgText">${escapeHtml(m?.content ? String(m.content) : '-')}</div>
        </div>`).join('');
        return `<details class="moreItem moreFeedbackItem">
          <summary class="moreFeedbackSummary">
            <div class="moreFeedbackSummaryMain">
              <div class="moreItemTitle">工单 ${escapeHtml(idText)} · ${escapeHtml(category)} · ${escapeHtml(status)}</div>
              <div class="moreFeedbackPreview">${escapeHtml(preview)}${previewText.length > 56 ? '…' : ''}</div>
            </div>
            <div class="moreFeedbackSummaryMeta">${escapeHtml(timeText || '')}</div>
          </summary>
          <div class="moreFeedbackBody">
            <div class="moreFeedbackThread">${thread}</div>
            <div class="moreFeedbackReply">
              <textarea data-feedback-reply-text="${escapeHtml(String(x?.id || ''))}" maxlength="2000" placeholder="继续补充这条反馈"></textarea>
              <button class="secondary" type="button" data-feedback-reply-submit="${escapeHtml(String(x?.id || ''))}">追加回复</button>
            </div>
          </div>
        </details>`;
      })
      .join('');
  }

  async function loadMe(seq) {
    const me = await safeFetchJson('/mall/me');
    if (seq && isStale(seq)) return null;
    if (isNetworkError(me)) {
      setText('balanceErr', '网络异常，正在重试…');
      return state.me;
    }
    if (isUnauthorized(me)) {
      setText('balanceErr', '请刷新页面重试或者重新进一次');
      reauthIfNeeded();
      return state.me;
    }
    if (me.data?.error) {
      setText('balanceErr', me.data.error);
      setText('balance', '--');
      return null;
    }
    setText('balanceErr', '');
    setText('balance', String(me.data.balance ?? '--'));
    return me.data;
  }

  async function loadMallOpening(seq) {
    const r = await fetchJson('/mall/opening');
    if (seq && isStale(seq)) return null;
    if (!r?.data?.ok) return null;
    const row = r.data.data || {};
    state.opening = row;
    applyMallOverlay(row);
    applyCloseCountdown(row);
    return row;
  }

  async function fetchProductsVersion(seq) {
    const versionResp = await safeFetchJson('/mall/products/version');
    if (seq && isStale(seq)) return null;
    if (isNetworkError(versionResp)) {
      setText('productsErr', '网络异常，正在重试…');
      return null;
    }
    if (isUnauthorized(versionResp)) {
      setText('productsErr', '请刷新页面重试或者重新进一次');
      reauthIfNeeded();
      return null;
    }
    if (versionResp.data?.error) {
      setText('productsErr', versionResp.data.error);
      return null;
    }
    return String(versionResp.data?.version || '');
  }

  async function loadProducts(seq, { force = false } = {}) {
    let nextVersion = '';
    if (!force) {
      nextVersion = await fetchProductsVersion(seq);
      if (seq && isStale(seq)) return state.products;
      if (!nextVersion) {
        return state.products;
      }
      if (nextVersion === state.productsVersion) {
        setText('productsErr', '');
        return state.products;
      }
    }

    state.productsLoading = true;
    if (!state.products || state.products.length === 0) {
      renderProductsLoading();
    }
    let products = await safeFetchJson('/mall/products', { timeoutMs: 7000 });
    if (isNetworkError(products)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      products = await safeFetchJson('/mall/products', { timeoutMs: 7000 });
    }
    state.productsLoading = false;
    if (seq && isStale(seq)) return state.products;
    if (isNetworkError(products)) {
      setText('productsErr', '网络异常，正在重试…');
      if (!state.products || state.products.length === 0) {
        renderProductsLoadingFailed();
      } else {
        renderProductsWithFilterAndOrder(state.products);
      }
      return state.products;
    }
    if (isUnauthorized(products)) {
      setText('productsErr', '请刷新页面重试或者重新进一次');
      reauthIfNeeded();
      if (!state.products || state.products.length === 0) {
        renderProductsLoadingFailed();
      }
      return state.products;
    }
    if (products.data?.error) {
      setText('productsErr', products.data.error);
      if (!state.products || state.products.length === 0) {
        renderProductsLoadingFailed();
      }
      return state.products;
    }
    setText('productsErr', '');
    const rows = Array.isArray(products.data.data) ? products.data.data : [];
    const serverVersion = String(products.data?.version || '');
    state.productsVersion = serverVersion || nextVersion || state.productsVersion || '';
    state.products = rows;
    renderProductsWithFilterAndOrder(rows);
    return rows;
  }

  async function loadMarketData(seq) {
    if (state.marketLoading) {
      if (seq && isStale(seq)) return;
    }

    if (seq && isStale(seq)) return;
    state.marketLoading = true;
    const errBox = document.getElementById('marketErr');
    if (errBox) errBox.textContent = '';

    const listingsBox = document.getElementById('marketListings');
    const myListingsBox = document.getElementById('marketMyListings');

    if ((!state.marketListings || state.marketListings.length === 0) && listingsBox) {
      listingsBox.innerHTML = '<div class="marketLoading">正在加载…</div>';
    }
    if ((!state.marketMine?.my_listings?.length) && myListingsBox) {
      myListingsBox.innerHTML = '<div class="marketLoading">正在加载…</div>';
    }

    try {
      const [listResp, mineResp] = await Promise.all([
        safeFetchJson('/mall/market/listings'),
        safeFetchJson('/mall/market/mine'),
      ]);

      if (seq && isStale(seq)) return;

      const isAuthError = isUnauthorized(listResp) || isUnauthorized(mineResp);
      if (isAuthError) {
        setText('marketErr', '请刷新页面重试或者重新进一次');
        reauthIfNeeded();
        return;
      }

      if (isNetworkError(listResp) || isNetworkError(mineResp)) {
        setText('marketErr', '网络异常，正在重试…');
        return;
      }

      if (!listResp?.data?.ok) {
        const listErr = humanizeMarketError(listResp?.data?.error || listResp?.status || '', listResp?.status);
        setText('marketErr', listErr);
        return;
      }

      if (!mineResp?.data?.ok) {
        const mineErr = humanizeMarketError(mineResp?.data?.error || mineResp?.status || '', mineResp?.status);
        setText('marketErr', mineErr);
        return;
      }

      const listingsData = Array.isArray(listResp.data?.data) ? listResp.data.data : [];
      const mineData = mineResp.data || {};

      state.marketListings = listingsData;
      state.marketMine = {
        ...mineData,
        market_open: mineData?.market_open ?? listResp.data?.market_open ?? false,
      };

      setText('marketErr', '');
      renderMarketListings(state.marketListings);
      renderMarketMine(state.marketMine);
    } finally {
      state.marketLoading = false;
    }
  }

  async function loadLedger(seq) {
    if (!state.ledger || state.ledger.length === 0) {
      const el = document.getElementById('ledger');
      if (el) el.innerHTML = '<div class="listLoading">正在加载流水…</div>';
    }
    const ledger = await safeFetchJson('/mall/ledger?page=1&pageSize=20');
    if (seq && isStale(seq)) return [];
    if (isNetworkError(ledger)) {
      setText('ledgerErr', '网络异常，正在重试…');
      return state.ledger;
    }
    if (isUnauthorized(ledger)) {
      setText('ledgerErr', '请刷新页面重试或者重新进一次');
      reauthIfNeeded();
      return state.ledger;
    }
    if (ledger.data?.error) {
      setText('ledgerErr', ledger.data.error);
      renderLedger([]);
      return [];
    }
    setText('ledgerErr', '');
    const rows = Array.isArray(ledger.data.data) ? ledger.data.data : [];
    renderLedger(rows);
    return rows;
  }

  async function loadOrders(seq) {
    if (!state.orders || state.orders.length === 0) {
      const el = document.getElementById('orders');
      if (el) el.innerHTML = '<div class="listLoading">正在加载订单…</div>';
    }
    const orders = await fetchJson('/mall/orders?limit=30');
    if (seq && isStale(seq)) return [];
    if (orders.data?.error) {
      setText('ordersErr', orders.data.error);
      renderOrders([]);
      return [];
    }
    setText('ordersErr', '');
    const rows = Array.isArray(orders.data.data) ? orders.data.data : [];
    state.orders = rows;
    renderOrdersWithFilter(rows);
    return rows;
  }

  async function loadRichBoard(seq) {
    if (isExternalUser()) return [];
    if (!state.richBoard || state.richBoard.length === 0) {
      const el = document.getElementById('richBoardList');
      if (el) el.innerHTML = '<div class="listLoading">正在加载排行榜…</div>';
    }
    const resp = await safeFetchJson('/mall/rich-board?limit=50');
    if (seq && isStale(seq)) return [];
    if (isNetworkError(resp)) {
      setText('richBoardErr', '网络异常，正在重试…');
      return state.richBoard;
    }
    if (isUnauthorized(resp)) {
      setText('richBoardErr', '请刷新页面重试或者重新进一次');
      reauthIfNeeded();
      return state.richBoard;
    }
    if (resp.data?.error) {
      setText('richBoardErr', resp.data.error);
      return state.richBoard;
    }
    setText('richBoardErr', '');
    const rows = Array.isArray(resp.data.data) ? resp.data.data : [];
    state.richBoard = rows;
    renderRichBoard(rows);
    return rows;
  }

  async function loadPopularProducts(seq) {
    if (!state.popularProducts || state.popularProducts.length === 0) {
      const el = document.getElementById('popularProductsList');
      if (el) el.innerHTML = '<div class="listLoading">正在加载热门商品榜…</div>';
    }
    const resp = await safeFetchJson('/mall/popular-products?limit=20');
    if (seq && isStale(seq)) return [];
    if (isNetworkError(resp)) {
      setText('popularProductsErr', '网络异常，正在重试…');
      return state.popularProducts;
    }
    if (isUnauthorized(resp)) {
      setText('popularProductsErr', '请刷新页面重试或者重新进一次');
      reauthIfNeeded();
      return state.popularProducts;
    }
    if (resp.data?.error) {
      setText('popularProductsErr', resp.data.error);
      return state.popularProducts;
    }
    setText('popularProductsErr', '');
    const rows = Array.isArray(resp.data.data) ? resp.data.data : [];
    state.popularProducts = rows;
    renderPopularProducts(rows);
    return rows;
  }

  function renderPopularProducts(rows) {
    const list = document.getElementById('popularProductsList');
    if (!list) return;
    if (!rows || rows.length === 0) {
      list.innerHTML = '<div class="item muted">暂无排行数据</div>';
      return;
    }

    const topOne = rows[0] || null;
    const topRest = rows.slice(1, 3);
    const rest = rows.slice(3);

    const renderImage = (name, imageUrl) => {
      const safeName = escapeHtml(name || '-');
      const safeImage = imageUrl ? escapeHtml(String(imageUrl)) : '';
      return '<div class="imgFallback"></div>' +
        (safeImage
          ? `<img src="${safeImage}" alt="${safeName}" referrerpolicy="no-referrer" onerror="this.classList.add('hidden')" />`
          : '');
    };

    let html = '<div class="popularBoard">';

    if (topOne) {
      const name = topOne?.product_name ? String(topOne.product_name) : '-';
      const count = Number(topOne?.order_count ?? 0);
      const amount = Number(topOne?.total_amount ?? 0);
      const productId = topOne?.product_id ? String(topOne.product_id) : '';
      const imageUrl = topOne?.image_url ? String(topOne.image_url) : '';
      html +=
        `<div class="popularHero popularProductItem" data-product-id="${escapeHtml(productId)}">` +
        '<div class="popularBadge">TOP 1</div>' +
        `<div class="popularHeroImage">${renderImage(name, imageUrl)}</div>` +
        '<div class="popularHeroBody">' +
        `<div class="popularName">${escapeHtml(name)}</div>` +
        `<div class="popularMeta">下单 ${count} 次 · 累计 ${amount} BOB</div>` +
        '<div class="popularHint">点击卡片，去商城加购同款</div>' +
        '</div>' +
        '</div>';
    }

    if (topRest.length > 0) {
      html += '<div class="popularTopGrid">';
      html += topRest.map((x) => {
        const rank = Number(x?.rank ?? 0);
        const name = x?.product_name ? String(x.product_name) : '-';
        const count = Number(x?.order_count ?? 0);
        const productId = x?.product_id ? String(x.product_id) : '';
        const imageUrl = x?.image_url ? String(x.image_url) : '';
        return (
          `<div class="popularMini popularProductItem" data-product-id="${escapeHtml(productId)}">` +
          `<div class="popularMiniRank">#${rank}</div>` +
          `<div class="popularMiniImage">${renderImage(name, imageUrl)}</div>` +
          `<div class="popularMiniName">${escapeHtml(name)}</div>` +
          `<div class="popularMiniMeta">下单 ${count} 次</div>` +
          '</div>'
        );
      }).join('');
      html += '</div>';
    }

    if (rest.length > 0) {
      html += '<div class="popularList">';
      html += rest.map((x) => {
        const rank = Number(x?.rank ?? 0);
        const name = x?.product_name ? String(x.product_name) : '-';
        const count = Number(x?.order_count ?? 0);
        const amount = Number(x?.total_amount ?? 0);
        const productId = x?.product_id ? String(x.product_id) : '';
        const imageUrl = x?.image_url ? String(x.image_url) : '';
        return (
          `<div class="popularRow popularProductItem" data-product-id="${escapeHtml(productId)}">` +
          `<div class="popularRowRank">#${rank}</div>` +
          `<div class="popularRowImage">${renderImage(name, imageUrl)}</div>` +
          '<div class="popularRowBody">' +
          `<div class="popularRowName">${escapeHtml(name)}</div>` +
          `<div class="popularRowMeta">下单 ${count} 次 · ${amount} BOB</div>` +
          '</div>' +
          '<div class="popularRowCta">点击加购</div>' +
          '</div>'
        );
      }).join('');
      html += '</div>';
    }

    html += '</div>';
    list.innerHTML = html;

    list.querySelectorAll('.popularProductItem').forEach((item) => {
      item.addEventListener('click', () => {
        const productId = item.getAttribute('data-product-id');
        if (!productId) return;
        handlePopularProductBuy(productId);
      });
    });
  }

  async function handlePopularProductBuy(productId) {
    const mallLocked = !isMallOpen(state.opening) && !isMallEasterUnlocked();
    if (mallLocked) {
      const nextOpenAt = Number(state.opening?.next_open_at);
      const nextHint = Number.isFinite(nextOpenAt) && nextOpenAt > 0
        ? `，预计 ${fmtTs(nextOpenAt)} 开启`
        : '';
      showNotice(`商城未开启，当前不可加购${nextHint}`, 'error');
      return;
    }

    let product = state.products.find((p) => String(p?.product_id || '') === String(productId));
    if (!product) {
      await loadProducts();
      product = state.products.find((p) => String(p?.product_id || '') === String(productId));
    }
    if (!product) {
      showNotice('商品信息未找到，请稍后重试', 'error');
      return;
    }

    switchTab('shop');
    setTimeout(() => {
      addToCart(productId);
    }, 200);
  }

  async function loadMoreData(seq) {
    if (!state.moreFaq || state.moreFaq.length === 0) {
      ['moreFaq', 'moreAnnouncements', 'moreStats', 'moreVersion', 'moreMyFeedback'].forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.innerHTML.trim() === '') el.innerHTML = '<div class="listLoading">正在加载…</div>';
      });
    }
    const [faqResp, announcementsResp, statsResp, versionResp, feedbackResp] = await Promise.all([
      safeFetchJson('/mall/more/faq?limit=50'),
      safeFetchJson('/mall/more/announcements?limit=20'),
      safeFetchJson('/mall/more/stats'),
      safeFetchJson('/mall/more/version'),
      safeFetchJson('/mall/more/feedback/mine?limit=20'),
    ]);
    if (seq && isStale(seq)) return null;

    const list = [
      { resp: faqResp, errId: 'moreFaqErr' },
      { resp: announcementsResp, errId: 'moreAnnouncementsErr' },
      { resp: statsResp, errId: 'moreStatsErr' },
      { resp: versionResp, errId: 'moreVersionErr' },
      { resp: feedbackResp, errId: 'moreFeedbackErr' },
    ];
    for (const item of list) {
      const resp = item.resp;
      if (isUnauthorized(resp)) {
        setText(item.errId, '请刷新页面重试或者重新进一次');
        reauthIfNeeded();
        return null;
      }
      if (isNetworkError(resp)) {
        setText(item.errId, '网络异常，正在重试…');
        return null;
      }
      setText(item.errId, '');
    }

    if (faqResp?.data?.error) {
      setText('moreFaqErr', String(faqResp.data.error));
    } else {
      state.moreFaq = Array.isArray(faqResp?.data?.data) ? faqResp.data.data : [];
      renderMoreFaq(state.moreFaq);
    }

    if (announcementsResp?.data?.error) {
      setText('moreAnnouncementsErr', String(announcementsResp.data.error));
    } else {
      state.moreAnnouncements = Array.isArray(announcementsResp?.data?.data) ? announcementsResp.data.data : [];
      renderMoreAnnouncements(state.moreAnnouncements);
    }

    if (statsResp?.data?.error) {
      setText('moreStatsErr', String(statsResp.data.error));
    } else {
      state.moreStats = statsResp?.data?.data || null;
      renderMoreStats(state.moreStats);
    }

    if (versionResp?.data?.error) {
      setText('moreVersionErr', String(versionResp.data.error));
    } else {
      state.moreVersion = Array.isArray(versionResp?.data?.data) ? versionResp.data.data : [];
      renderMoreVersion(state.moreVersion);
    }

    if (feedbackResp?.data?.error) {
      setText('moreFeedbackErr', String(feedbackResp.data.error));
    } else {
      state.moreMyFeedback = Array.isArray(feedbackResp?.data?.data) ? feedbackResp.data.data : [];
      renderMoreMyFeedback(state.moreMyFeedback);
    }

    return true;
  }

  async function submitMoreFeedback() {
    const categoryBox = document.getElementById('moreFeedbackCategory');
    const contactBox = document.getElementById('moreFeedbackContact');
    const contentBox = document.getElementById('moreFeedbackContent');
    if (!categoryBox || !contentBox) return;
    const category = categoryBox.value ? String(categoryBox.value) : 'suggestion';
    const contact = contactBox?.value ? String(contactBox.value).trim() : '';
    const content = contentBox.value ? String(contentBox.value).trim() : '';
    if (!content) {
      showNotice('请先填写反馈内容', 'error');
      return;
    }
    const btn = document.getElementById('btnMoreFeedbackSubmit');
    const prevDisabled = btn ? btn.disabled : false;
    if (btn) btn.disabled = true;
    try {
      const resp = await safeFetchJson('/mall/more/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, content, contact }),
      });
      if (!resp?.data?.ok) {
        const msg = resp?.data?.error ? String(resp.data.error) : '提交失败';
        showNotice(msg, 'error');
        return;
      }
      contentBox.value = '';
      if (contactBox) contactBox.value = '';
      showNotice('反馈已提交，感谢你的建议', 'success');
      await loadMoreData();
    } finally {
      if (btn) btn.disabled = prevDisabled;
    }
  }

  async function submitMoreFeedbackReply(id) {
    const feedbackId = Number(id);
    if (!Number.isFinite(feedbackId) || feedbackId <= 0) return;
    const box = document.querySelector(`[data-feedback-reply-text="${String(feedbackId)}"]`);
    const content = box?.value ? String(box.value).trim() : '';
    if (!content) {
      showNotice('请先填写补充内容', 'error');
      return;
    }
    const btn = document.querySelector(`[data-feedback-reply-submit="${String(feedbackId)}"]`);
    const prevDisabled = btn ? btn.disabled : false;
    if (btn) btn.disabled = true;
    try {
      const resp = await safeFetchJson(`/mall/more/feedback/${feedbackId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!resp?.data?.ok) {
        showNotice(resp?.data?.error ? String(resp.data.error) : '追加失败', 'error');
        return;
      }
      box.value = '';
      showNotice('已追加反馈', 'success');
      await loadMoreData();
    } finally {
      if (btn) btn.disabled = prevDisabled;
    }
  }

  async function refreshBalanceAndLedger() {
    const seq = ++state.reqSeq;
    const [me, ledger] = await Promise.all([
      loadMe(seq),
      loadLedger(seq),
    ]);

    if (isStale(seq)) return;

    state.me = me;
    state.ledger = ledger;
    renderLedger(state.ledger);
    if (state.activeTab === 'shop' || state.shopFilter === 'affordable') {
      renderProductsWithFilterAndOrder(state.products);
    }
    if (state.activeTab === 'balance') {
      await loadRedPacketStatus();
    }
  }

  async function refreshLightweightForCurrentTab() {
    if (state.activeTab === 'more') {
      // "更多"页面包含FAQ、公告等静态内容，不需要频繁刷新
      return;
    }
    if (state.activeTab === 'balance') {
      await refreshBalanceAndLedger();
      return;
    }
    if (state.activeTab === 'shop' && state.shopFilter === 'affordable') {
      const me = await loadMe();
      if (me) {
        state.me = me;
      }
      renderProductsWithFilterAndOrder(state.products);
    }
    if (state.activeTab === 'shop') {
      await loadCharityProjects();
    }
  }

  async function loadAll() {
    const seq = ++state.reqSeq;
    const [me, ledger, orders, opening, redPacket, charityProjects] = await Promise.all([
      loadMe(seq),
      loadLedger(seq),
      loadOrders(seq),
      loadMallOpening(seq),
      loadRedPacketStatus(),
      loadCharityProjects(seq),
    ]);

    if (isStale(seq)) return;
    state.me = me;
    state.ledger = ledger;
    state.orders = orders;
    state.opening = opening;
    state.redPacket = redPacket;
    state.charityProjects = charityProjects || state.charityProjects;

    // ledger 里的 mall_buy 显示要借助 orders 的 product_name
    renderLedger(state.ledger);

    // 仅在商城开放或 easter 解锁时才加载商品（节省流量）
    if (isMallOpen(state.opening) || isMallEasterUnlocked()) {
      const products = await loadProducts(seq, { force: true });
      if (isStale(seq)) return;
      state.products = products;
      renderProductsWithFilterAndOrder(state.products);
    }
  }

  function findMarketListing(listingId) {
    return (state.marketListings || []).find((item) => String(item?.listing_id || '') === String(listingId || '')) || null;
  }

  function findSellableOrder(exchangeId) {
    const mine = state.marketMine || {};
    return Array.isArray(mine.sellable_orders)
      ? mine.sellable_orders.find((item) => String(item?.exchange_id || '') === String(exchangeId || ''))
      : null;
  }

  async function buyMarketListing(listingId) {
    const row = findMarketListing(listingId);
    if (!row) {
      showNotice('挂单不存在，请刷新后重试', 'error');
      return;
    }
    if (!marketIsOpen(state.marketMine)) {
      showNotice('交易市场已暂停，当前不可购买', 'error');
      return;
    }
    if (row.can_buy === false || row.can_buy === 0) {
      showNotice('该挂单当前不能购买', 'error');
      return;
    }

    const productName = row?.product_name ? String(row.product_name) : '-';
    const seller = row?.seller_display_name ? String(row.seller_display_name) : '匿名用户';
    const price = Number(row?.price);
    const priceText = Number.isFinite(price) ? `${price}` : '-';
    const confirmed = await showConfirmDialog({
      title: '确认购买',
      message: `商品：${productName}\n售价：${priceText} BOB\n卖家：${seller}`,
      confirmText: '确认购买',
    });
    if (!confirmed) return;

    const resp = await postJson('/mall/market/buy', { listing_id: listingId });
    if (!resp?.data?.ok) {
      const msg = humanizeMarketError(resp?.data?.error || resp?.status || '', resp?.status);
      showNotice(msg, 'error');
      await loadMarketData();
      return;
    }

    showNotice('交易成功，已扣减余额', 'success');
    await Promise.all([
      refreshBalanceAndLedger(),
      loadOrders(),
      loadMarketData(),
    ]);
  }

  // ===== Market listing modal (multi-select + price) =====
  let _marketListStep = 'pick'; // 'pick' | 'price' | 'edit'
  let _marketListSelected = []; // exchange_id[]
  let _marketEditListingId = '';

  function openMarketPickModal() {
    if (!state.marketMine) {
      loadMarketData().then(openMarketPickModal);
      return;
    }
    if (!marketIsOpen(state.marketMine)) {
      showNotice('交易市场已暂停，当前不可上架', 'error');
      return;
    }
    const sellable = Array.isArray(state.marketMine?.sellable_orders) ? state.marketMine.sellable_orders : [];
    if (!sellable.length) {
      showNotice('你暂时没有可上架的商品', 'error');
      return;
    }

    _marketListStep = 'pick';
    _marketListSelected = [];
    setText('marketListModalTitle', '选择要上架的商品');
    setText('marketListModalSub', '可多选，选好后统一设定价格。');
    setText('marketListErr', '');
    setHidden('marketListPriceSection', true);
    document.getElementById('btnMarketListConfirm').textContent = '下一步';

    const list = document.getElementById('marketPickList');
    list.innerHTML = sellable.map((x) => {
      const exchangeId = x?.exchange_id || '';
      const name = x?.product_name || '商品';
      const imageUrl = x?.product_image_url || '';
      const remark = x?.product_remark || '';
      const amount = Number(x?.original_amount);
      const priceText = Number.isFinite(amount) && amount > 0 ? `商城价 ${amount} BOB 币` : '';
      const createdAt = fmtTs(x?.created_at);
      const timeText = createdAt ? `获得于 ${createdAt}` : '';
      return (
        `<div class="marketPickItem" data-pick-id="${escapeHtml(exchangeId)}">` +
        `  <div class="marketPickCheck"><svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M2 6l3 3 5-5"/></svg></div>` +
        `  <div class="marketPickMediaWrap"><div class="imgFallback"></div>${imageUrl ? `<img class="marketPickImage" src="${escapeHtml(imageUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.classList.add('hidden')" />` : ''}</div>` +
        `  <div class="marketPickInfo">` +
        `    <div class="marketPickName">${escapeHtml(name)}</div>` +
        (remark ? `    <div class="marketPickRemark">${escapeHtml(remark)}</div>` : '') +
        (priceText ? `    <div class="marketPickPrice">${escapeHtml(priceText)}</div>` : '') +
        (timeText ? `    <div class="marketPickPrice">${escapeHtml(timeText)}</div>` : '') +
        `  </div>` +
        `</div>`
      );
    }).join('');

    setHidden('marketPickList', false);
    setHidden('marketListModal', false);
  }

  function toggleMarketPickItem(el) {
    const id = el?.getAttribute('data-pick-id');
    if (!id) return;
    el.classList.toggle('selected');
    if (el.classList.contains('selected')) {
      if (!_marketListSelected.includes(id)) _marketListSelected.push(id);
    } else {
      _marketListSelected = _marketListSelected.filter((x) => x !== id);
    }
  }

  function closeMarketListModal() {
    setHidden('marketListModal', true);
    _marketListStep = 'pick';
    _marketListSelected = [];
    _marketEditListingId = '';
  }

  function openMarketEditModal(listingId) {
    const listings = Array.isArray(state.marketMine?.my_listings) ? state.marketMine.my_listings : [];
    const row = listings.find((x) => String(x?.listing_id || '') === String(listingId));
    if (!row || String(row?.status || '') !== 'active') {
      showNotice('该挂单当前不可编辑', 'error');
      return;
    }
    if (!marketIsOpen(state.marketMine)) {
      showNotice('交易市场已暂停，当前不可编辑', 'error');
      return;
    }

    _marketListStep = 'edit';
    _marketListSelected = [];
    _marketEditListingId = String(listingId);
    setText('marketListModalTitle', `编辑：${row?.product_name || '商品'}`);
    setText('marketListModalSub', '修改挂单价格或卖家说明。');
    setText('marketListErr', '');
    setHidden('marketPickList', true);
    setHidden('marketListPriceSection', false);
    const hintEl = document.getElementById('marketListPriceHint');
    if (hintEl) {
      hintEl.textContent = '保存后，在售商品会立即更新。';
      hintEl.style.display = '';
    }
    document.getElementById('marketListPrice').value = String(Number(row?.price) || '');
    document.getElementById('marketListNote').value = row?.seller_note ? String(row.seller_note) : '';
    document.getElementById('btnMarketListConfirm').textContent = '保存修改';
    setHidden('marketListModal', false);
  }

  async function handleMarketListConfirm() {
    if (_marketListStep === 'pick') {
      if (!_marketListSelected.length) {
        setText('marketListErr', '请至少选择一个商品');
        return;
      }
      setText('marketListErr', '');
      _marketListStep = 'price';
      setText('marketListModalTitle', `上架 ${_marketListSelected.length} 个商品`);
      setText('marketListModalSub', '为选中的商品设定统一价格。');
      setHidden('marketPickList', true);
      setHidden('marketListPriceSection', false);
      document.getElementById('marketListPrice').value = '';
      document.getElementById('marketListNote').value = '';
      document.getElementById('btnMarketListConfirm').textContent = '确认上架';

      // Build price hint from selected items (deduplicated by product name)
      const sellable = Array.isArray(state.marketMine?.sellable_orders) ? state.marketMine.sellable_orders : [];
      const selectedRows = _marketListSelected.map((id) => sellable.find((x) => String(x?.exchange_id || '') === id)).filter(Boolean);
      const seen = new Set();
      const hints = [];
      selectedRows.forEach((r) => {
        const pName = r?.product_name || '';
        if (seen.has(pName)) return;
        seen.add(pName);
        const amt = Number(r?.original_amount);
        const ref = fmtPriceRange(r?.price_min, r?.price_max);
        if (Number.isFinite(amt) && amt > 0) hints.push(`${pName}：商城价 ${amt} BOB 币${ref !== '-' ? `，参考价 ${ref}` : ''}`);
        else if (ref !== '-') hints.push(`${pName}：参考价 ${ref} BOB 币`);
      });
      const hintEl = document.getElementById('marketListPriceHint');
      if (hintEl) {
        hintEl.textContent = hints.length ? hints.join('；') : '';
        hintEl.style.display = hints.length ? '' : 'none';
      }
      return;
    }

    // step === 'price'
    const priceInput = document.getElementById('marketListPrice');
    const noteInput = document.getElementById('marketListNote');
    const price = Number(priceInput.value.trim());
    const note = noteInput.value.trim();

    if (!Number.isFinite(price) || !Number.isInteger(price) || price <= 0) {
      setText('marketListErr', '价格需为正整数');
      return;
    }
    setText('marketListErr', '');

    if (_marketListStep === 'edit') {
      const listingId = _marketEditListingId;
      const resp = await postJson('/mall/market/update', { listing_id: listingId, price, note: note || undefined });
      if (!resp?.data?.ok) {
        const msg = humanizeMarketError(resp?.data?.error || resp?.status || '', resp?.status);
        setText('marketListErr', msg);
        return;
      }
      closeMarketListModal();
      showNotice('挂单已更新', 'success');
      await loadMarketData();
      return;
    }

    let successCount = 0;
    let lastError = '';
    const selectedCount = _marketListSelected.length;
    for (const exchangeId of _marketListSelected) {
      const resp = await postJson('/mall/market/list', { exchange_id: exchangeId, price, note: note || undefined });
      if (resp?.data?.ok) {
        successCount++;
      } else {
        lastError = humanizeMarketError(resp?.data?.error || resp?.status || '', resp?.status);
      }
    }

    closeMarketListModal();
    if (successCount > 0) {
      showNotice(`已成功上架 ${successCount} 个商品`, 'success');
    }
    if (lastError && successCount < selectedCount) {
      showNotice(lastError, 'error');
    }
    await Promise.all([loadMarketData(), loadOrders(), loadMe()]);
  }

  // Single item listing (from QR modal)
  async function listMarketOrder(exchangeId) {
    if (!exchangeId) {
      showNotice('订单缺失，无法上架', 'error');
      return;
    }
    if (!state.marketMine) {
      await loadMarketData();
    }
    if (!marketIsOpen(state.marketMine)) {
      showNotice('交易市场已暂停，当前不可上架', 'error');
      return;
    }

    // Pre-select this one item and open the modal at price step
    const row = findSellableOrder(exchangeId);
    if (!row) {
      showNotice('该商品不可上架', 'error');
      return;
    }

    _marketListStep = 'price';
    _marketListSelected = [exchangeId];

    const name = row?.product_name || '商品';
    const amount = Number(row?.original_amount);
    const ref = fmtPriceRange(row?.price_min, row?.price_max);
    let hint = '';
    if (Number.isFinite(amount) && amount > 0) hint = `商城价 ${amount} BOB 币${ref !== '-' ? `，参考价 ${ref} BOB 币` : ''}`;
    else if (ref !== '-') hint = `参考价 ${ref} BOB 币`;

    setText('marketListModalTitle', `上架：${name}`);
    setText('marketListModalSub', '设定价格后其他用户可以购买。');
    setText('marketListErr', '');
    setHidden('marketPickList', true);
    setHidden('marketListPriceSection', false);
    const hintEl = document.getElementById('marketListPriceHint');
    if (hintEl) {
      hintEl.textContent = hint;
      hintEl.style.display = hint ? '' : 'none';
    }
    document.getElementById('marketListPrice').value = '';
    document.getElementById('marketListNote').value = '';
    document.getElementById('btnMarketListConfirm').textContent = '确认上架';
    setHidden('marketListModal', false);
  }

  async function cancelMarketListing(listingId) {
    if (!listingId) {
      showNotice('挂单缺失，无法取消', 'error');
      return;
    }
    const confirmed = await showConfirmDialog({
      title: '取消挂单',
      message: '确认取消该挂单吗？取消后商品将回到你的持有列表。',
      confirmText: '确认取消',
      danger: true,
    });
    if (!confirmed) return;

    const resp = await postJson('/mall/market/cancel', { listing_id: listingId });
    if (!resp?.data?.ok) {
      const msg = humanizeMarketError(resp?.data?.error || resp?.status || '', resp?.status);
      showNotice(msg, 'error');
      return;
    }

    showNotice('挂单已取消', 'success');
    await Promise.all([
      loadMarketData(),
      loadOrders(),
    ]);
  }

  async function buy(productId, { quiet = false, skipReload = false } = {}) {
    if (!productId) return;
    const row = getProductById(productId);
    const limit = getProductLimitInfo(row);
    if (limit.enabled && limit.remaining <= 0) {
      if (!quiet) showNotice('已达到该商品限购数量', 'error');
      return { ok: false, error: '已达到该商品限购数量' };
    }

    const silent = !isMallOpen(state.opening) && isMallEasterUnlocked();
    const r = await fetchJson('/mall/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: productId,
        easter_token: silent ? (state.mallEasterToken || '') : '',
        omit_qr: !silent,
      }),
    });

    if (!r?.data?.ok) {
      const errRaw = r?.data?.error === null || r?.data?.error === undefined ? '' : String(r.data.error);
      if (errRaw === 'mall_closed') {
        if (silent) {
          clearMallEasterUnlock();
        }
        await loadMallOpening();
        if (silent && state.opening) {
          applyMallOverlay(state.opening);
        }
      }
      const msg = humanizeBuyError(r?.data?.error, r?.status);
      if (!quiet) {
        showNotice(msg, 'error');
      }
      if (
        errRaw === 'out of stock' ||
        errRaw === 'product not on sale' ||
        errRaw === 'product not found' ||
        errRaw === 'purchase_limit_reached'
      ) {
        await loadProducts(undefined, { force: true });
      }
      return { ok: false, error: msg };
    }

    if (!quiet) {
      if (silent && r?.data?.qr_image_url && r?.data?.encoded) {
        showNotice('下单成功，请出示二维码给核销人员扫码', 'success');
        showQrModal({
          exchangeId: r?.data?.exchange_id ? String(r.data.exchange_id) : '',
          encoded: String(r.data.encoded || ''),
          qrImageUrl: String(r.data.qr_image_url || ''),
          hint: '内部模式：请出示给核销人员扫码',
          productTitle: '',
          amountText: '',
          balanceText: '',
          marketListAvailable: true,
        });
      } else {
        showNotice('下单成功，请到订单页查看并核销', 'success');
        switchTab('orders');
      }
    }
    if (!skipReload) {
      await loadAll();
    }
    return { ok: true, exchangeId: r?.data?.exchange_id ? String(r.data.exchange_id) : '' };
  }

  async function unlockMallEasterIfPossible() {
    if (state.mallEasterUnlockInFlight) return;
    if (isMallOpen(state.opening)) return;
    const overlay = document.getElementById('mallOverlay');
    if (!overlay || overlay.classList.contains('hidden')) return;

    state.mallEasterUnlockInFlight = true;
    try {
      const r = await fetchJson('/mall/easter/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r?.data?.ok) return;
      const until = Number(r.data?.expires_at);
      const token = r.data?.token ? String(r.data.token) : '';
      if (!token) return;
      state.mallEasterToken = token;
      state.mallEasterUnlockedUntil = (Number.isFinite(until) && until > nowSec()) ? until : (nowSec() + 600);
      if (state.opening) {
        applyMallOverlay(state.opening);
      }
      // 解锁后加载商品
      const products = await loadProducts(undefined, { force: true });
      state.products = products;
      renderProductsWithFilterAndOrder(state.products);
    } finally {
      state.mallEasterUnlockInFlight = false;
    }
  }

  function bumpMallEasterClicks() {
    if (isMallOpen(state.opening)) return;
    const overlay = document.getElementById('mallOverlay');
    if (!overlay || overlay.classList.contains('hidden')) return;
    if (isMallEasterUnlocked()) return;

    state.mallEasterClicks += 1;
    if (state.mallEasterClickTimer) {
      clearTimeout(state.mallEasterClickTimer);
    }
    state.mallEasterClickTimer = setTimeout(() => {
      state.mallEasterClicks = 0;
      state.mallEasterClickTimer = null;
    }, 1300);

    if (state.mallEasterClicks >= 5) {
      state.mallEasterClicks = 0;
      if (state.mallEasterClickTimer) {
        clearTimeout(state.mallEasterClickTimer);
        state.mallEasterClickTimer = null;
      }
      unlockMallEasterIfPossible();
    }
  }

  function applySiteGate(settings) {
    const gate = document.getElementById('siteGate');
    const enabled = settings?.enabled !== false;
    if (enabled) {
      document.body.classList.remove('siteDisabled');
      if (gate) gate.classList.add('hidden');
      return false;
    }

    const message = settings?.message ? String(settings.message).trim() : '系统维护中，请稍后再试。';
    setText('siteGateMessage', message || '系统维护中，请稍后再试。');
    document.body.classList.add('siteDisabled');
    if (gate) gate.classList.remove('hidden');
    return true;
  }

  async function shouldStopForSiteGate() {
    const resp = await safeFetchJson('/web/site-status');
    if (!resp?.data?.ok) return false;
    return applySiteGate(resp.data?.data || {});
  }

  // 余额页金币下拉刷新（mall_coin.js 派发）。与登录方式无关地注册一次；
  // 刷新按钮在登录并通过公告门禁后才启用，未启用时直接回失败，避免金币一直停在刷新中。
  window.addEventListener('bob:refresh-balance', async () => {
    let ok = false;
    if (!document.getElementById('btnRefresh')?.disabled) {
      ok = true;
      try {
        await refreshBalanceAndLedger();
      } catch (_) {
        ok = false;
      }
      if (document.getElementById('balanceErr')?.textContent) ok = false;
    }
    window.dispatchEvent(new CustomEvent('bob:balance-refreshed', { detail: { ok } }));
  });

  async function bootstrap() {
    if (await shouldStopForSiteGate()) {
      return;
    }
    const session = await safeFetchJson('/web/me');
    const hasSession = session?.status === 200 && Boolean(session?.data?.userid);
    const inDingtalk = /DingTalk/i.test(window.navigator.userAgent || '')
      && typeof window.dd !== 'undefined'
      && Boolean(window.dd?.runtime?.permission?.requestAuthCode);

    if (!inDingtalk && !hasSession) {
      // 浏览器/微信内打开：进入活动登录页（外部用户注册登录，员工可切钉钉登录）。
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      const params = new URLSearchParams({ redirect: returnTo });
      window.location.replace(`/login?${params.toString()}`);
      return;
    }

    let cfg;
    if (inDingtalk) {
      const cfgResp = await fetchJson(`/web/config?url=${encodeURIComponent(currentUrl)}`);
      if (cfgResp.data?.error) {
        setText('userHint', '配置获取失败：' + cfgResp.data.error);
        return;
      }
      cfg = cfgResp.data;
      state.cfg = cfg;
    } else {
      state.oauthSession = session.data;
      state.cfg = null;
      cfg = { agentId: '', corpId: '', timeStamp: 0, nonceStr: '', signature: '' };
      window.dd = {
        config() {},
        ready(callback) { callback(); },
        error() {},
        runtime: { permission: { requestAuthCode({ onSuccess }) { onSuccess({ code: '' }); } } },
      };
    }

    dd.config({
      agentId: cfg.agentId,
      corpId: cfg.corpId,
      timeStamp: cfg.timeStamp,
      nonceStr: cfg.nonceStr,
      signature: cfg.signature,
      jsApiList: ['runtime.permission.requestAuthCode'],
    });

    dd.ready(() => {
      dd.runtime.permission.requestAuthCode({
        corpId: cfg.corpId,
        onSuccess: async (info) => {
          const auth = state.oauthSession
            ? { data: state.oauthSession }
            : await fetchJson(`/web/auth?code=${encodeURIComponent(info.code)}`);
          state.oauthSession = null;
          const userid = auth.data?.userid;
          const name = auth.data?.name;
          if (!userid) {
            setText('userHint', '免登失败：' + (auth.data?.error || 'unknown'));
            return;
          }

          setUserIdentity(name, auth.data?.avatar);
          setUserSource(auth.data?.source);
          syncMeIdentity({ userid, name });
          bindAnnouncementGate();
          await waitForAnnouncementAccess();
          document.getElementById('btnRefresh').disabled = false;
          document.getElementById('btnRefresh').onclick = () => refreshBalanceAndLedger();
          const btnTransfer = document.getElementById('btnTransfer');
          if (btnTransfer) {
            btnTransfer.disabled = false;
            btnTransfer.onclick = () => handleTransfer();
          }
          const btnWithdraw = document.getElementById('btnWithdraw');
          if (btnWithdraw) {
            btnWithdraw.disabled = false;
            btnWithdraw.onclick = () => showNotice('不是，哥们，你还真敢想啊？', 'error');
          }
          if (!state.transferBound) {
            const keywordInput = document.getElementById('transferKeyword');
            const list = document.getElementById('transferList');
            const btnClose = document.getElementById('btnTransferClose');
            const btnCancel = document.getElementById('btnTransferCancel');
            const btnConfirm = document.getElementById('btnTransferConfirm');
            if (keywordInput) {
              keywordInput.addEventListener('input', () => {
                if (state.transferSearchTimer) {
                  clearTimeout(state.transferSearchTimer);
                  state.transferSearchTimer = null;
                }
                state.transferSearchTimer = setTimeout(() => {
                  if (state.transferTarget) {
                    const selectedName = state.transferTarget.display_name || state.transferTarget.name || '';
                    if (String(keywordInput.value || '').trim() !== String(selectedName || '').trim()) {
                      setTransferTarget(null);
                    }
                  }
                  state.transferSearchSeq += 1;
                  const seq = state.transferSearchSeq;
                  fetchTransferCandidates(keywordInput.value, seq);
                }, 240);
              });
            }
            if (list) {
              list.addEventListener('click', (evt) => {
                const node = evt.target?.closest?.('.transferItem');
                if (!node) return;
                const userid = node.getAttribute('data-userid') || '';
                const name = node.getAttribute('data-name') || '';
                const displayName = node.getAttribute('data-display') || '';
                if (!userid) return;
                const finalName = displayName || name || userid || '用户';
                setTransferTarget({ userid, name, display_name: finalName });
                if (keywordInput) keywordInput.value = finalName;
                setTransferListVisible(false);
              });
            }
            if (btnClose) btnClose.onclick = () => closeTransferModal();
            if (btnCancel) btnCancel.onclick = () => closeTransferModal();
            if (btnConfirm) btnConfirm.onclick = () => openTransferConfirm();
            const btnFinalClose = document.getElementById('btnTransferFinalClose');
            const btnFinalCancel = document.getElementById('btnTransferFinalCancel');
            const btnFinalConfirm = document.getElementById('btnTransferFinalConfirm');
            if (btnFinalClose) btnFinalClose.onclick = () => setTransferConfirmVisible(false);
            if (btnFinalCancel) btnFinalCancel.onclick = () => setTransferConfirmVisible(false);
            if (btnFinalConfirm) btnFinalConfirm.onclick = () => submitTransfer();
            state.transferBound = true;
          }
          const btnProductsRefresh = document.getElementById('btnProductsRefresh');
          if (btnProductsRefresh) {
            btnProductsRefresh.disabled = false;
            btnProductsRefresh.onclick = async () => {
              btnProductsRefresh.disabled = true;
              try {
                await loadProducts(undefined, { force: true });
                showNotice('商品已刷新', 'success');
              } finally {
                btnProductsRefresh.disabled = false;
              }
            };
          }
          const btnCartView = document.getElementById('btnCartView');
          if (btnCartView) {
            btnCartView.disabled = false;
            btnCartView.onclick = () => {
              if (isCartViewLocked()) {
                showNotice('商城未到下单时间', 'error');
                return;
              }
              openCartModal();
            };
          }
          const btnProductsSearch = document.getElementById('btnProductsSearch');
          if (btnProductsSearch) {
            btnProductsSearch.onclick = () => {
              openProductSearchModal();
            };
          }
          const productSearchModal = document.getElementById('productSearchModal');
          if (productSearchModal) {
            productSearchModal.addEventListener('click', (ev) => {
              if (ev?.target?.id === 'productSearchModal') {
                closeProductSearchModal();
              }
            });
          }
          const btnProductSearchClose = document.getElementById('btnProductSearchClose');
          if (btnProductSearchClose) btnProductSearchClose.addEventListener('click', closeProductSearchModal);
          const productSearchInput = document.getElementById('productSearchInput');
          if (productSearchInput) {
            productSearchInput.addEventListener('input', () => {
              state.productSearchKeyword = String(productSearchInput.value || '');
              renderProductSearchBody();
            });
          }
          const btnProductSearchClear = document.getElementById('btnProductSearchClear');
          if (btnProductSearchClear) {
            btnProductSearchClear.addEventListener('click', () => {
              state.productSearchKeyword = '';
              if (productSearchInput) {
                productSearchInput.value = '';
                try { productSearchInput.focus(); } catch (_e) { /* noop */ }
              }
              renderProductSearchBody();
            });
          }
          const productSearchBody = document.getElementById('productSearchBody');
          if (productSearchBody) {
            productSearchBody.addEventListener('click', (ev) => {
              const target = ev?.target;
              const row = target?.closest ? target.closest('[data-search-product-id]') : null;
              const pid = row?.getAttribute ? row.getAttribute('data-search-product-id') : '';
              if (!pid) return;
              if (isCartViewLocked()) {
                showNotice('商城未到下单时间', 'error');
                return;
              }
              const product = (state.products || []).find((x) => String(x?.product_id || '') === String(pid));
              if (!product) {
                showNotice('商品已不可购买', 'error');
                return;
              }
              closeProductSearchModal();
              openConfirmModal(product);
            });
          }

          updateCartViewButton();
          syncCartViewButtonState();

          document.querySelectorAll('.navBtn').forEach((btn) => {
            btn.addEventListener('click', () => {
              const t = btn.getAttribute('data-tab');
              switchTab(t);
            });
          });
          document.querySelectorAll('[data-more-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const t = btn.getAttribute('data-more-tab');
              switchMoreTab(t);
            });
          });

          document.querySelectorAll('[data-rich-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const t = btn.getAttribute('data-rich-tab');
              switchRichTab(t);
            });
          });

          const btnLogout = document.getElementById('btnLogout');
          if (btnLogout) btnLogout.addEventListener('click', () => handleLogout());

          startRedPacketTimer();
          startAuctionTimer();
          bindAuctionEvents();
          ensureMallRealtime(true);

          document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
              reviveMallRealtime();
              refreshAnnouncementAccessState();
            }
          });

          window.addEventListener('focus', () => {
            reviveMallRealtime();
            refreshAnnouncementAccessState();
          });

          window.addEventListener('online', () => reviveMallRealtime());
          window.addEventListener('pageshow', (ev) => {
            if (ev.persisted) reviveMallRealtime();
          });

          // 部分 WebView 解锁后不派发 visibilitychange / focus，靠定时巡检兜底发现失效连接
          setInterval(() => {
            if (!document.hidden) ensureMallRealtime();
          }, 10_000);

          window.addEventListener('pagehide', () => {
            closeMallRealtime({ keepNotice: true });
          });

          const qrModal = document.getElementById('qrModal');
          if (qrModal) {
            qrModal.addEventListener('click', (ev) => {
              if (ev?.target?.id === 'qrModal') {
                closeQrModal();
              }
            });
          }
          const btnQrClose = document.getElementById('btnQrClose');
          if (btnQrClose) btnQrClose.addEventListener('click', closeQrModal);
          const btnQrCdkInfo = document.getElementById('btnQrCdkInfo');
          if (btnQrCdkInfo) {
            btnQrCdkInfo.addEventListener('click', () => {
              const exchangeId = state.qrModalExchangeId ? String(state.qrModalExchangeId) : '';
              if (!exchangeId) return;
              const returnQrPayload = state.qrModalPayload && String(state.qrModalPayload.exchangeId || '') === exchangeId
                ? { ...state.qrModalPayload }
                : null;
              closeQrModal({ keepPayload: true });
              openCdkInfoModal(exchangeId, { source: 'qr', returnQrPayload });
            });
          }
          const btnQrListMarket = document.getElementById('btnQrListMarket');
          if (btnQrListMarket) {
            btnQrListMarket.addEventListener('click', () => {
              const exchangeId = state.qrModalExchangeId ? String(state.qrModalExchangeId) : '';
              if (exchangeId) listMarketOrder(exchangeId);
            });
          }
          const btnQrToOrders = document.getElementById('btnQrToOrders');
          if (btnQrToOrders) {
            btnQrToOrders.addEventListener('click', () => {
              closeQrModal();
              switchTab('orders');
            });
          }
          const btnQrRefund = document.getElementById('btnQrRefund');
          if (btnQrRefund) {
            btnQrRefund.addEventListener('click', () => {
              showNotice('不退，哈哈哈', 'info');
            });
          }

          const confirmModal = document.getElementById('confirmModal');
          if (confirmModal) {
            confirmModal.addEventListener('click', (ev) => {
              if (ev?.target?.id === 'confirmModal') {
                closeConfirmModal();
              }
            });
          }
          const btnConfirmClose = document.getElementById('btnConfirmClose');
          if (btnConfirmClose) btnConfirmClose.addEventListener('click', closeConfirmModal);
          const btnConfirmCancel = document.getElementById('btnConfirmCancel');
          if (btnConfirmCancel) btnConfirmCancel.addEventListener('click', closeConfirmModal);
          
          // 订单详情模态框关闭事件
          const btnOrderDetailClose = document.getElementById('btnOrderDetailClose');
          if (btnOrderDetailClose) btnOrderDetailClose.addEventListener('click', () => setOrderDetailVisible(false));
          const btnOrderDetailClose2 = document.getElementById('btnOrderDetailClose2');
          if (btnOrderDetailClose2) btnOrderDetailClose2.addEventListener('click', () => setOrderDetailVisible(false));
          const btnOrderDetailCdkInfo = document.getElementById('btnOrderDetailCdkInfo');
          if (btnOrderDetailCdkInfo) {
            btnOrderDetailCdkInfo.addEventListener('click', () => {
              const exchangeId = document.getElementById('orderDetailExchangeId')?.textContent || '';
              if (!exchangeId || exchangeId === '-') return;
              openCdkInfoModal(exchangeId, { source: 'order_detail' });
            });
          }

          const btnOrdersRedeemCdk = document.getElementById('btnOrdersRedeemCdk');
          if (btnOrdersRedeemCdk) btnOrdersRedeemCdk.addEventListener('click', openCdkRedeemModal);
          const btnCdkRedeemClose = document.getElementById('btnCdkRedeemClose');
          if (btnCdkRedeemClose) btnCdkRedeemClose.addEventListener('click', closeCdkRedeemModal);
          const btnCdkPreview = document.getElementById('btnCdkPreview');
          if (btnCdkPreview) btnCdkPreview.addEventListener('click', previewCdk);
          const btnCdkRedeemConfirm = document.getElementById('btnCdkRedeemConfirm');
          if (btnCdkRedeemConfirm) btnCdkRedeemConfirm.addEventListener('click', redeemCdkCode);
          const cdkInput = document.getElementById('cdkInput');
          if (cdkInput) {
            cdkInput.addEventListener('input', () => {
              cdkInput.value = String(cdkInput.value || '').toUpperCase().replace(/\s+/g, '');
              if (state.cdkPreview && state.cdkPreview.cdk !== cdkInput.value) {
                resetCdkPreview();
                setCdkRedeemError('');
                setText('cdkRedeemSub', '输入兑换码后预览兑换商品');
              }
            });
            cdkInput.addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                if (state.cdkPreview) redeemCdkCode();
                else previewCdk();
              }
            });
          }

          const cdkRedeemModal = document.getElementById('cdkRedeemModal');
          if (cdkRedeemModal) {
            cdkRedeemModal.addEventListener('click', (ev) => {
              if (ev?.target?.id === 'cdkRedeemModal') closeCdkRedeemModal();
            });
          }
          const btnCdkInfoClose = document.getElementById('btnCdkInfoClose');
          if (btnCdkInfoClose) btnCdkInfoClose.addEventListener('click', closeCdkInfoModal);
          const btnCdkInfoClose2 = document.getElementById('btnCdkInfoClose2');
          if (btnCdkInfoClose2) btnCdkInfoClose2.addEventListener('click', closeCdkInfoModal);
          const cdkInfoModal = document.getElementById('cdkInfoModal');
          if (cdkInfoModal) {
            cdkInfoModal.addEventListener('click', (ev) => {
              if (ev?.target?.id === 'cdkInfoModal') closeCdkInfoModal();
            });
          }
          const btnConfirmOk = document.getElementById('btnConfirmOk');
          if (btnConfirmOk) {
            btnConfirmOk.addEventListener('click', async () => {
              const pid = state.pendingBuyProductId;
              closeConfirmModal();
              buy(pid);
            });
          }
          const btnConfirmAddCart = document.getElementById('btnConfirmAddCart');
          if (btnConfirmAddCart) {
            btnConfirmAddCart.addEventListener('click', () => {
              const pid = state.pendingBuyProductId;
              if (pid) addToCart(pid);
              closeConfirmModal();
            });
          }

          const cartModal = document.getElementById('cartModal');
          if (cartModal) {
            cartModal.addEventListener('click', (ev) => {
              if (ev?.target?.id === 'cartModal') {
                closeCartModal();
              }
            });
          }
          const btnCartClose = document.getElementById('btnCartClose');
          if (btnCartClose) btnCartClose.addEventListener('click', closeCartModal);
          const btnCartClear = document.getElementById('btnCartClear');
          if (btnCartClear) {
            btnCartClear.addEventListener('click', () => {
              state.cartItems = [];
              saveCartToStorage();
              updateCartViewButton();
              renderCartModal();
            });
          }
          const btnCartCheckout = document.getElementById('btnCartCheckout');
          if (btnCartCheckout) btnCartCheckout.addEventListener('click', checkoutCart);
          const cartList = document.getElementById('cartList');
          if (cartList) {
            cartList.addEventListener('click', (ev) => {
              const target = ev?.target;
              const decId = target?.getAttribute ? target.getAttribute('data-cart-dec') : '';
              if (decId) {
                upsertCartItem(decId, -1);
                renderCartModal();
                return;
              }
              const incId = target?.getAttribute ? target.getAttribute('data-cart-inc') : '';
              if (incId) {
                const row = getProductById(incId);
                if (!row || !isProductInStock(row)) {
                  showNotice('商品已不可购买', 'error');
                  return;
                }
                if (!upsertCartItem(incId, 1)) {
                  showNotice('已达到该商品限购数量', 'error');
                }
                renderCartModal();
              }
            });
          }

          const redPacketBtn = document.getElementById('redPacketClaimBtn');
          if (redPacketBtn) {
            redPacketBtn.addEventListener('click', () => {
              claimRedPacket();
            });
          }

          document.getElementById('products').addEventListener('click', async (ev) => {
            const target = ev?.target;
            const card = target?.closest ? target.closest('[data-product-id]') : null;
            const pid = card?.getAttribute ? card.getAttribute('data-product-id') : '';
            if (!pid) return;
            const row = (state.products || []).find((x) => String(x?.product_id || '') === String(pid));
            if (!row) {
              await buy(pid);
              return;
            }
            openConfirmModal(row);
          });

          document.querySelectorAll('[data-orders-filter]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const v = btn.getAttribute('data-orders-filter');
              if (!v) return;
              state.ordersFilter = v;
              applyOrdersFilterUi();
              renderOrdersWithFilter(state.orders);
            });
          });
          document.querySelectorAll('[data-orders-time-filter]').forEach((btn) => {
            btn.addEventListener('click', () => {
              const v = btn.getAttribute('data-orders-time-filter');
              if (!v) return;
              state.ordersTimeFilter = v;
              applyOrdersTimeFilterUi();
              renderOrdersWithFilter(state.orders);
            });
          });
          const ordersSearchInput = document.getElementById('ordersSearchInput');
          if (ordersSearchInput) {
            ordersSearchInput.addEventListener('input', () => {
              state.ordersSearchKeyword = String(ordersSearchInput.value || '');
              renderOrdersWithFilter(state.orders);
            });
          }

          const shopFilterSelect = document.getElementById('shopFilterSelect');
          if (shopFilterSelect) {
            shopFilterSelect.addEventListener('change', () => {
              const v = shopFilterSelect.value ? String(shopFilterSelect.value) : 'all';
              if (v === 'affordable' && !Number.isFinite(Number(state.me?.balance ?? NaN))) {
                showNotice('余额同步中，请稍后再试', 'info');
              }
              state.shopFilter = v;
              applyShopFilterUi();
              renderProductsWithFilterAndOrder(state.products);
            });
          }
          const shopFilterTrigger = document.getElementById('shopFilterTrigger');
          if (shopFilterTrigger) {
            shopFilterTrigger.addEventListener('click', () => {
              bumpMallEasterClicks();
            });
          }

          const charitySubnav = document.getElementById('charitySubnav');
          if (charitySubnav) {
            charitySubnav.addEventListener('click', (ev) => {
              const target = ev?.target?.closest ? ev.target.closest('[data-charity-tab]') : null;
              const tab = target?.getAttribute ? target.getAttribute('data-charity-tab') : '';
              if (!tab) return;
              state.activeCharityTab = tab === 'leaderboard' || tab === 'recent' ? tab : 'intro';
              applyCharityTabUi();
            });
          }

          const charityProjectRail = document.getElementById('charityProjectRail');
          if (charityProjectRail) {
            charityProjectRail.addEventListener('click', async (ev) => {
              const target = ev?.target?.closest ? ev.target.closest('[data-charity-detail], [data-charity-project]') : null;
              const projectId = target?.getAttribute ? (target.getAttribute('data-charity-detail') || target.getAttribute('data-charity-project')) : '';
              if (!projectId) return;
              state.activeCharityProjectId = String(projectId);
              renderCharityProjects(state.charityProjects);
              await loadCharityProjectDetail(null, state.activeCharityProjectId);
              openCharityDetailModal();
            });
          }

          const btnCharityLoadMore = document.getElementById('btnCharityLoadMore');
          if (btnCharityLoadMore) {
            btnCharityLoadMore.addEventListener('click', () => {
              state.charityVisibleCount += 2;
              renderCharityProjects(state.charityProjects);
            });
          }

          const charityDetailModal = document.getElementById('charityDetailModal');
          if (charityDetailModal) {
            charityDetailModal.addEventListener('click', (ev) => {
              if (ev?.target?.id === 'charityDetailModal') closeCharityDetailModal();
            });
          }
          const btnCharityDetailClose = document.getElementById('btnCharityDetailClose');
          if (btnCharityDetailClose) btnCharityDetailClose.addEventListener('click', closeCharityDetailModal);

          const btnCharityContribute = document.getElementById('btnCharityContribute');
          if (btnCharityContribute) {
            btnCharityContribute.addEventListener('click', () => {
              const amount = document.getElementById('charityAmountSelect')?.value || '';
              if (!amount) {
                setText('charityContributeErr', '');
                showNotice('请先选择助力金额', 'error');
                return;
              }
              openCharityContributeConfirm(Number(amount));
            });
          }

          const charityConfirmModal = document.getElementById('charityConfirmModal');
          if (charityConfirmModal) {
            charityConfirmModal.addEventListener('click', (ev) => {
              if (ev?.target?.id === 'charityConfirmModal') closeCharityConfirmModal();
            });
          }
          const btnCharityConfirmClose = document.getElementById('btnCharityConfirmClose');
          if (btnCharityConfirmClose) btnCharityConfirmClose.addEventListener('click', closeCharityConfirmModal);
          const btnCharityConfirmCancel = document.getElementById('btnCharityConfirmCancel');
          if (btnCharityConfirmCancel) btnCharityConfirmCancel.addEventListener('click', closeCharityConfirmModal);
          const btnCharityConfirmOk = document.getElementById('btnCharityConfirmOk');
          if (btnCharityConfirmOk) {
            btnCharityConfirmOk.addEventListener('click', async () => {
              await contributeCharity(state.charityPendingAmount);
            });
          }

          const btnMoreFeedbackSubmit = document.getElementById('btnMoreFeedbackSubmit');
          if (btnMoreFeedbackSubmit) {
            btnMoreFeedbackSubmit.addEventListener('click', () => {
              submitMoreFeedback();
            });
          }
          const moreMyFeedback = document.getElementById('moreMyFeedback');
          if (moreMyFeedback) {
            moreMyFeedback.addEventListener('click', (ev) => {
              const target = ev?.target;
              const btn = target?.closest ? target.closest('[data-feedback-reply-submit]') : null;
              const id = btn?.getAttribute ? btn.getAttribute('data-feedback-reply-submit') : '';
              if (id) submitMoreFeedbackReply(id);
            });
          }

          const marketListings = document.getElementById('marketListings');
          if (marketListings) {
            marketListings.addEventListener('click', (ev) => {
              const btn = ev?.target?.closest ? ev.target.closest('[data-market-buy]') : null;
              const listingId = btn?.getAttribute ? btn.getAttribute('data-market-buy') : '';
              if (!listingId) return;
              ev.preventDefault();
              ev.stopPropagation();
              buyMarketListing(listingId);
            });
          }

          // "选择商品上架" button
          document.getElementById('btnMarketPickSellable')?.addEventListener('click', openMarketPickModal);

          // Pick list item click (toggle selection)
          document.getElementById('marketPickList')?.addEventListener('click', (ev) => {
            const item = ev?.target?.closest ? ev.target.closest('[data-pick-id]') : null;
            if (item) toggleMarketPickItem(item);
          });

          const marketMyListings = document.getElementById('marketMyListings');
          if (marketMyListings) {
            marketMyListings.addEventListener('click', (ev) => {
              const editBtn = ev?.target?.closest ? ev.target.closest('[data-market-edit]') : null;
              const editListingId = editBtn?.getAttribute ? editBtn.getAttribute('data-market-edit') : '';
              if (editListingId) {
                ev.preventDefault();
                ev.stopPropagation();
                openMarketEditModal(editListingId);
                return;
              }

              const cancelBtn = ev?.target?.closest ? ev.target.closest('[data-market-cancel]') : null;
              const listingId = cancelBtn?.getAttribute ? cancelBtn.getAttribute('data-market-cancel') : '';
              if (!listingId) return;
              ev.preventDefault();
              ev.stopPropagation();
              cancelMarketListing(listingId);
            });
          }

          // Market sub-tab 切换（在售/竞拍大厅/我的出售/我的竞拍）
          const marketSubnav = document.getElementById('marketSubnav');
          if (marketSubnav) {
            marketSubnav.addEventListener('click', (ev) => {
              const btn = ev?.target?.closest ? ev.target.closest('[data-market-tab]') : null;
              if (!btn) return;
              switchMarketTab(btn.getAttribute('data-market-tab'));
            });
          }

          // Market list modal events
          document.getElementById('btnMarketListClose')?.addEventListener('click', closeMarketListModal);
          document.getElementById('btnMarketListCancel')?.addEventListener('click', closeMarketListModal);
          document.getElementById('btnMarketListConfirm')?.addEventListener('click', handleMarketListConfirm);

          document.getElementById('orders').addEventListener('click', (ev) => {
            const target = ev?.target;

            // 处理QR码点击（未核销订单）
            const qrItem = target?.closest ? target.closest('[data-show-qr]') : null;
            const exchangeId = qrItem?.getAttribute ? qrItem.getAttribute('data-show-qr') : '';
            if (exchangeId) {
              const row = (state.orders || []).find((o) => String(o?.exchange_id || '') === String(exchangeId));
              if (!row) return;
              if (!row.qr_image_url || !row.encoded) {
                showNotice('二维码信息缺失，请刷新后再试', 'error');
                return;
              }
              showQrModal({
                exchangeId: row.exchange_id,
                encoded: row.encoded,
                qrImageUrl: row.qr_image_url,
                hint: '请出示给核销人员扫码',
                productTitle: row?.product_name ? String(row.product_name) : String(row?.product_id || ''),
                amountText: row?.redeem_source === 'cdk' ? '' : (row?.bob_amount !== null && row?.bob_amount !== undefined ? `${row.bob_amount} BOB 币` : ''),
                balanceText: '',
                createdAt: row?.created_at ?? null,
                cdkInfoAvailable: row?.cdk_info_available === true || Number(row?.cdk_info_available || 0) === 1,
                marketListAvailable: String(row?.redeem_source || '') !== 'auction',
                refundAvailable: row?.redeem_source !== 'cdk' && row?.redeem_source !== 'auction',
              });
              return;
            }
            
            // 处理已核销订单详情点击
            const detailItem = target?.closest ? target.closest('[data-order-detail]') : null;
            const detailExchangeId = detailItem?.getAttribute ? detailItem.getAttribute('data-order-detail') : '';
            if (detailExchangeId) {
              const row = (state.orders || []).find((o) => String(o?.exchange_id || '') === String(detailExchangeId));
              if (!row) return;
              showOrderDetailModal(row);
              return;
            }
          });

          const initialTab = getTabFromUrl();
          switchTab(initialTab || 'balance');

          await loadAll();
        },
        onFail: (err) => {
          setText('userHint', '免登失败：' + JSON.stringify(err));
        },
      });
    });

    dd.error((err) => {
      setText('userHint', 'dd.config 失败：' + JSON.stringify(err));
    });
  }

  bootstrap();
})();
