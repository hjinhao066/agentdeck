// 版本更新 panel: opened from the version at the foot of the sidebar, it rises
// beside the sidebar over the deck. 每日进展 on top (this machine's nightly
// statistics, read only), then every version, planned and released, newest
// first. The content is built by ReleasesView, the same as in the phone hub.
(function () {
  'use strict';
  const H = window.HubCore;
  const st = { notes: undefined, progress: { state: 'loading', days: [] }, day: 0 };
  let host = null, panel = null, body = null, opener = null;

  const isOpen = () => !!panel && !panel.hidden;

  function build() {
    panel = document.createElement('aside');
    panel.id = 'releasePanel';
    panel.className = 'rp';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'rpTitle');
    panel.tabIndex = -1;
    const head = document.createElement('header');
    head.className = 'rp-head';
    const title = document.createElement('h2');
    title.id = 'rpTitle'; title.textContent = '版本更新';
    const sub = document.createElement('span');
    sub.className = 'rp-sub';
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'icon-btn rp-close';
    close.title = '关闭 (Esc)'; close.setAttribute('aria-label', '关闭版本更新');
    close.innerHTML = host.ICONS.close;
    close.addEventListener('click', () => toggle(false));
    head.append(title, sub, close);
    body = document.createElement('div');
    body.className = 'rp-body';
    panel.append(head, body);
    document.body.appendChild(panel);
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      toggle(false);
    });
    // A click anywhere outside closes it (the version button toggles it itself).
    document.addEventListener('mousedown', (e) => {
      if (isOpen() && !panel.contains(e.target) && !e.target.closest('#releaseNotesBtn')) toggle(false);
    }, true);
    window.addEventListener('resize', place);
  }

  // Beside the sidebar, from under the top bar to the bottom of the window.
  function place() {
    if (!isOpen()) return;
    const nav = document.getElementById('colNav').getBoundingClientRect();
    const left = Math.round(nav.right) + 8;
    panel.style.left = left + 'px';
    panel.style.width = Math.max(300, Math.min(460, window.innerWidth - left - 12)) + 'px';
  }

  function load() {
    window.deck.releaseNotes().then((value) => { st.notes = H.releaseNotes(value); })
      .catch(() => { st.notes = null; }).finally(() => draw());
    window.deck.dailyProgress().then((value) => {
      const days = H.progressDays(value && value.days);
      st.progress = { state: days.length ? 'ready' : 'none', days };
    }).catch(() => { st.progress = { state: 'error', days: [] }; }).finally(() => draw());
  }

  function copy(text, button, label) {
    try { host.clipboardWrite(text); } catch (_) { host.showToast('没能复制，请再试一次'); return; }
    button.innerHTML = host.ICONS.check; button.classList.add('done');
    button.title = '已复制'; button.setAttribute('aria-label', '已复制');
    clearTimeout(button.copyTimer);
    button.copyTimer = setTimeout(() => {
      button.innerHTML = host.ICONS.copy; button.classList.remove('done');
      button.title = label; button.setAttribute('aria-label', label);
    }, 1600);
  }

  function draw(focus) {
    if (!isOpen()) return;
    const latest = st.notes && st.notes.released.find((e) => H.sameVersion(e.version, host.version));
    panel.querySelector('.rp-sub').textContent = `你在用 ${H.versionLabel(host.version) || host.version}` + (latest ? ` · ${H.shortDate(latest.date)} 发布` : '');
    window.ReleasesView.render(body, {
      core: H, notes: st.notes, progress: st.progress, dayIndex: st.day, now: new Date(), focus: focus || '',
      buttonClass: 'icon-btn',
      icon: (name) => host.ICONS[name] || '',
      copy,
      using: (version) => (H.sameVersion(version, host.version) ? '你在用' : ''),
      setDay: (i, key) => { st.day = i; draw(key); },
      notesMissing: ['没读到版本更新内容', '这一版的安装包里缺少更新说明。重新安装 AgentDeck 后再打开。'],
    });
  }

  function toggle(open) {
    const show = open ?? !isOpen();
    if (show === isOpen()) return;
    if (!panel) build();
    const button = document.getElementById('releaseNotesBtn');
    if (show) {
      opener = document.activeElement;
      st.day = 0;
      panel.hidden = false;
      place();
      draw();
      load();
      panel.focus({ preventScroll: true });
    } else {
      panel.hidden = true;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    }
    if (button) { button.classList.toggle('active', show); button.setAttribute('aria-expanded', String(show)); }
  }

  window.ReleaseNotesUI = { init: (h) => { host = h; }, toggle, isOpen };
})();
