// 每日进展 page: opened from the sidebar, it slides over the deck like the other
// pages. It reads this machine's nightly statistics (read only, through
// window.deck.dailyProgress) and draws them with DailyProgressView, the same
// as the phone hub. The chosen day stays while the app runs; refresh reads the
// files again.
(function () {
  'use strict';
  const H = window.HubCore;
  const st = { progress: { state: 'loading', days: [] }, day: 0, loaded: false };
  let host = null, box = null, seq = 0;

  function load(refreshBtn) {
    const mine = ++seq;
    if (refreshBtn) refreshBtn.classList.add('busy');
    window.deck.dailyProgress().then((value) => {
      if (mine !== seq) return;
      const days = H.progressDays(value && value.days);
      // A newer file may have arrived: stay on the same date when it is still there.
      const date = st.loaded && st.progress.days[st.day] && st.progress.days[st.day].date;
      st.progress = { state: days.length ? 'ready' : 'none', days };
      st.day = Math.max(0, days.findIndex((d) => d.date === date));
    }).catch(() => { if (mine === seq) st.progress = { state: 'error', days: [] }; }).finally(() => {
      if (mine !== seq) return;
      st.loaded = true;
      if (refreshBtn) refreshBtn.classList.remove('busy');
      draw();
    });
  }

  function draw(focus) {
    if (!box || !box.isConnected) return;
    window.DailyProgressView.render(box, {
      core: H, progress: st.progress, dayIndex: st.day, now: new Date(), focus: focus || '',
      buttonClass: 'icon-btn',
      icon: (name) => host.ICONS[name] || '',
      setDay: (i, key) => { st.day = i; draw(key); },
    });
  }

  function render(frame, h) {
    host = h || host;
    const refresh = document.createElement('button');
    refresh.type = 'button'; refresh.className = 'page-close dpv-refresh';
    refresh.title = '刷新'; refresh.setAttribute('aria-label', '刷新每日进展');
    refresh.innerHTML = host.ICONS.refresh;
    refresh.addEventListener('click', () => load(refresh));
    const body = frame('每日进展', '每天 0 点自动统计前一天：完成了几件、各项目推进到哪、交付了什么。只读本机的统计文件。', [refresh]);
    body.parentElement.classList.add('page-progress');
    box = document.createElement('div');
    box.className = 'dpv-host';
    body.appendChild(box);
    draw();
    load(refresh);
  }

  window.DailyProgressPage = { render };
})();
