// 版本更新 page: what each released version changed (newest first) and what
// comes next, read from this build's release-notes.json. The data is cleaned by
// HubCore.releaseNotes, the same rules the phone hub uses. Wide windows show
// both lists side by side; narrow ones switch between them.
(function () {
  'use strict';
  const H = window.HubCore;
  const st = { notes: undefined, loading: false, tab: 'released' };
  let host = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const visible = () => window.Pages.current() === 'releases';

  function load() {
    if (st.loading) return;
    st.loading = true;
    window.deck.releaseNotes().then((value) => { st.notes = H.releaseNotes(value); })
      .catch(() => { st.notes = null; })
      .finally(() => { st.loading = false; if (visible()) window.Pages.render(); });
  }

  function copyButton(entry, label) {
    const b = el('button', 'icon-btn rn-copy');
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
    b.innerHTML = host.ICONS.copy;
    let timer = 0;
    b.addEventListener('click', () => {
      try { host.clipboardWrite(H.releaseText(entry)); } catch (_) { host.showToast('没能复制，请再试一次'); return; }
      b.innerHTML = host.ICONS.check; b.classList.add('done'); b.title = '已复制'; b.setAttribute('aria-label', '已复制');
      clearTimeout(timer);
      timer = setTimeout(() => { b.innerHTML = host.ICONS.copy; b.classList.remove('done'); b.title = label; b.setAttribute('aria-label', label); }, 1600);
    });
    return b;
  }

  function releasedList(notes) {
    const list = el('ol', 'rn-line');
    notes.released.forEach((entry, i) => {
      const mine = H.sameVersion(entry.version, host.version);
      const li = el('li', 'rn-ver' + (i === 0 ? ' latest' : '') + (mine ? ' mine' : ''));
      const when = el('div', 'rn-when');
      when.append(el('span', 'rn-num', entry.version), el('time', 'rn-date', H.shortDate(entry.date)));
      when.lastChild.dateTime = entry.date;
      const body = el('div', 'rn-body');
      const head = el('div', 'rn-head');
      head.appendChild(el('h3', 'rn-title', entry.title));
      if (mine) head.appendChild(el('span', 'rn-mine', '你在用'));
      head.appendChild(copyButton(entry, `复制 ${entry.version} 的更新内容`));
      const items = el('ul', 'rn-items');
      entry.items.forEach((t) => items.appendChild(el('li', null, t)));
      body.append(head, items);
      li.append(when, el('span', 'rn-node'), body);
      list.appendChild(li);
    });
    return list;
  }

  function upcomingList(notes) {
    const box = el('div', 'rn-plans');
    notes.upcoming.forEach((entry) => {
      const plan = el('article', 'rn-plan');
      plan.dataset.status = entry.status;
      const head = el('div', 'rn-head');
      if (entry.version) head.appendChild(el('span', 'rn-num', entry.version));
      head.appendChild(el('h3', 'rn-title', entry.title));
      head.appendChild(el('span', 'rn-status', H.PLAN_STATES[entry.status]));
      head.appendChild(copyButton(entry, entry.version ? `复制 ${entry.version} 的计划` : '复制这几件的清单'));
      plan.appendChild(head);
      if (entry.note) plan.appendChild(el('p', 'rn-note', entry.note));
      const rows = el('ul', 'rn-tasks');
      entry.items.forEach((item) => {
        const row = el('li', 'rn-task');
        row.dataset.state = item.state;
        const state = el('span', 'rn-state');
        state.append(el('i', 'rn-dot'), el('span', null, H.ITEM_STATES[item.state]));
        const what = el('span', 'rn-what', item.text);
        if (item.suggestion) what.appendChild(el('small', 'rn-suggest', item.suggestion));
        row.append(state, what);
        rows.appendChild(row);
      });
      plan.appendChild(rows);
      box.appendChild(plan);
    });
    return box;
  }

  function render(frame, h) {
    host = h;
    if (st.notes === undefined) load();
    const notes = st.notes;
    const current = notes && notes.released.find((e) => H.sameVersion(e.version, host.version));
    const subtitle = `你在用 ${H.versionLabel(host.version) || host.version}` + (current ? ` · ${H.shortDate(current.date)} 发布` : '');
    const body = frame('版本更新', subtitle);
    body.closest('.page').classList.add('page-releases');
    if (!notes) {
      const empty = el('div', 'page-empty');
      empty.append(el('strong', null, st.notes === undefined ? '正在读取…' : '没读到版本更新内容'),
        el('span', null, st.notes === undefined ? '' : '这一版的安装包里缺少更新说明。重新安装 AgentDeck 后再打开这一页。'));
      body.appendChild(empty);
      return;
    }
    const pending = H.pendingCount(notes);
    const wrap = el('div', 'rn');
    wrap.dataset.tab = st.tab;
    // Shown only when the page is too narrow for two columns.
    const tabs = el('div', 'rn-tabs');
    tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '看哪一部分');
    [['released', '已发布'], ['upcoming', '接下来']].forEach(([key, label]) => {
      const b = el('button', null, label);
      b.type = 'button'; b.id = 'rn-tab-' + key;
      b.setAttribute('aria-controls', 'rn-' + key);
      b.setAttribute('aria-pressed', String(st.tab === key));
      b.classList.toggle('active', st.tab === key);
      if (key === 'upcoming' && pending) {
        b.appendChild(el('span', 'rn-badge', String(pending)));
        b.setAttribute('aria-label', `接下来，${pending} 件待你定`);
      }
      b.addEventListener('click', () => { st.tab = key; window.Pages.render(); document.getElementById('rn-tab-' + key)?.focus(); });
      tabs.appendChild(b);
    });
    const released = el('section', 'rn-released');
    released.id = 'rn-released'; released.setAttribute('aria-labelledby', 'rn-h-released');
    const rh = el('h2', 'rn-h', '已发布');
    rh.id = 'rn-h-released';
    released.append(rh, releasedList(notes));
    const upcoming = el('section', 'rn-upcoming');
    upcoming.id = 'rn-upcoming'; upcoming.setAttribute('aria-labelledby', 'rn-h-upcoming');
    const uh = el('h2', 'rn-h');
    uh.id = 'rn-h-upcoming';
    uh.append(el('span', null, '接下来'));
    if (pending) uh.appendChild(el('span', 'rn-pending', `${pending} 件待你定`));
    if (notes.updated) uh.appendChild(el('span', 'rn-updated', `${H.shortDate(notes.updated)} 更新`));
    upcoming.append(uh, upcomingList(notes));
    wrap.append(tabs, released, upcoming);
    body.appendChild(wrap);
  }

  window.ReleaseNotesUI = { render };
})();
