'use strict';

// 每日进展 page, the same on the desktop and in the phone hub (styles in
// progress.css, colours from each page's own tokens). On top one overview card
// for the chosen day: how many things were finished, the last days as columns
// to pick another day, the day's highlights, each project's progress and what
// was delivered. Below it, one card per thing the day touched, grouped by
// project. Builds DOM only from cleaned data (HubCore.progressDays); all text
// goes in as text.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DailyProgressView = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const EMPTY = {
    loading: ['正在读取每日进展…', ''],
    none: ['还没有每日进展', '每天 0 点自动统计前一天，明早再来看。'],
    old: ['Mac 上的 AgentDeck 还是旧版', '升级到 2.1 以后，这里会显示每天推进了多少。'],
    offline: ['每日进展暂时看不到', '每日进展在 Mac 上统计，Mac 现在连不上。连上后自动出现。'],
    error: ['没读到每日进展', '点刷新再试一次。'],
  };
  const STATE = { done: '完成', review: '待验收', doing: '进行中', needs_user: '等你决定' };
  const ORDER = ['done', 'review', 'doing', 'needs_user'];
  const PROJECTS_SHOWN = 8;

  function render(box, o) {
    const H = o.core, doc = box.ownerDocument;
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const iconButton = (name, label, cls) => {
      const b = el('button', o.buttonClass + ' ' + cls); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.innerHTML = o.icon(name);
      return b;
    };
    const p = o.progress, days = p.days || [];
    if (!days.length) {
      const [title, text] = EMPTY[p.state] || EMPTY.none;
      const empty = el('section', 'dpv dpv-card dpv-blank');
      empty.append(el('p', 'dpv-empty-title', title));
      if (text) empty.appendChild(el('p', 'dpv-empty', text));
      box.replaceChildren(empty);
      return;
    }
    const i = Math.min(Math.max(o.dayIndex || 0, 0), days.length - 1), day = days[i];
    const page = el('div', 'dpv');
    page.append(overview(), things());
    box.replaceChildren(page);
    if (o.focus) box.querySelector(`[data-focus="${o.focus}"]`)?.focus({ preventScroll: true });

    function overview() {
      const s = day.summary;
      const card = el('section', 'dpv-card dpv-overview');
      card.setAttribute('aria-label', `${H.progressLabel(day.date, o.now)} 总览`);

      // The day and its arrows; older is to the left, as on the columns.
      const head = el('div', 'dpv-head');
      const nav = el('div', 'dpv-nav');
      const older = iconButton('left', '前一天', 'dpv-step'); older.dataset.focus = 'older';
      const newer = iconButton('right', '后一天', 'dpv-step'); newer.dataset.focus = 'newer';
      older.disabled = i >= days.length - 1; newer.disabled = i === 0;
      older.addEventListener('click', () => o.setDay(i + 1, 'older'));
      newer.addEventListener('click', () => o.setDay(i - 1, 'newer'));
      const label = el('time', 'dpv-day', H.progressLabel(day.date, o.now)); label.dateTime = day.date;
      nav.append(older, label, newer);
      head.appendChild(nav);
      if (day.partial) head.appendChild(el('span', 'dpv-partial', '统计未完'));
      if (p.source) head.appendChild(el('span', 'dpv-source', `来自 ${p.source}`));
      card.appendChild(head);

      const top = el('div', 'dpv-top');
      const hero = el('div', 'dpv-hero');
      const big = el('div', 'dpv-bigline');
      big.append(el('b', 'dpv-big', String(s.done)), el('span', 'dpv-unit', '件完成'));
      hero.append(big, el('p', 'dpv-line', `推进 ${s.projects} 个项目 · 派出 ${s.sessions} 个会话 · 新建 ${s.created} 张卡`));
      // 交付 counts the lines listed below (the log also counts entries it wrote no words for).
      const stats = el('ul', 'dpv-stats');
      [['交付', day.delivered.length || s.deliveries, 'ship'], ['等你决定', s.needsUser, s.needsUser ? 'need' : ''], ['返工', s.rework, ''], ['审查不通过', s.reject, '']].forEach(([name, n, cls]) => {
        const li = el('li', cls);
        li.append(el('b', null, String(n)), el('span', null, name));
        stats.appendChild(li);
      });
      hero.appendChild(stats);
      top.appendChild(hero);
      if (days.length > 1) top.appendChild(chart());
      card.appendChild(top);

      const marks = H.progressHighlights(days, i);
      if (marks.length) {
        const list = el('ul', 'dpv-highlights');
        list.setAttribute('aria-label', '亮点');
        marks.forEach((m) => { const li = el('li', null, m.text); li.dataset.kind = m.kind; list.appendChild(li); });
        card.appendChild(list);
      }

      const split = el('div', 'dpv-split');
      split.append(projects(), delivered());
      card.appendChild(split);
      return card;
    }

    // One column per day, at most a week, always with the chosen day; a column picks its day.
    function chart() {
      const box = el('div', 'dpv-chart');
      box.setAttribute('role', 'group'); box.setAttribute('aria-label', '最近几天完成的件数，点一天看那天');
      const start = Math.max(0, Math.min(i - 3, days.length - 7)), week = days.slice(start, start + 7);
      const most = Math.max(1, ...week.map((d) => d.summary.done));
      [...week].reverse().forEach((d) => {
        const k = days.indexOf(d);
        const col = el('button', 'dpv-col' + (k === i ? ' on' : '')); col.type = 'button'; col.dataset.focus = 'day-' + d.date;
        const words = `${H.progressLabel(d.date, o.now)}：完成 ${d.summary.done} 件`;
        col.title = words; col.setAttribute('aria-label', words); col.setAttribute('aria-pressed', String(k === i));
        const bar = el('span', 'dpv-bar'); bar.style.height = Math.max(3, Math.round(d.summary.done / most * 100)) + '%';
        const track = el('span', 'dpv-track'); track.appendChild(bar);
        col.append(el('span', 'dpv-val', String(d.summary.done)), track, el('span', 'dpv-date', d.date.slice(5)));
        col.addEventListener('click', () => o.setDay(k, 'day-' + d.date));
        box.appendChild(col);
      });
      return box;
    }

    function projects() {
      const section = el('section', 'dpv-block');
      section.appendChild(el('h3', 'dpv-sub', '各项目推进'));
      const moved = day.projects.filter((x) => x.done || x.sessions || x.doing || x.needsUser);
      if (!moved.length) { section.appendChild(el('p', 'dpv-none', '这一天没有项目动过。')); return section; }
      const shown = moved.slice(0, PROJECTS_SHOWN), most = Math.max(1, ...shown.map((x) => x.done));
      const list = el('ul', 'dpv-projects');
      shown.forEach((x) => {
        const li = el('li');
        li.title = `${x.name}：完成 ${x.done}，新建 ${x.created}，会话 ${x.sessions}，返工 ${x.rework}`;
        const track = el('span', 'dpv-ptrack'), bar = el('span', 'dpv-pbar');
        bar.style.width = (x.done ? Math.max(4, Math.round(x.done / most * 100)) : 0) + '%';
        track.appendChild(bar);
        li.append(el('span', 'dpv-pname', x.name), track, el('span', 'dpv-pnum', String(x.done)));
        list.appendChild(li);
      });
      section.appendChild(list);
      if (moved.length > shown.length) section.appendChild(el('p', 'dpv-more', `另有 ${moved.length - shown.length} 个项目`));
      return section;
    }

    function delivered() {
      const section = el('section', 'dpv-block');
      section.appendChild(el('h3', 'dpv-sub', '交付了什么'));
      if (!day.delivered.length) { section.appendChild(el('p', 'dpv-none', '这一天没有记下交付。')); return section; }
      const list = el('ol', 'dpv-delivered');
      day.delivered.forEach((d) => {
        const li = el('li');
        const t = el('time', 'dpv-time', d.time || '—'); if (d.time) t.dateTime = d.time;
        li.append(t, el('span', 'dpv-what', d.text));
        list.appendChild(li);
      });
      section.appendChild(list);
      return section;
    }

    // Every card the day touched, grouped by project in the overview's order.
    function things() {
      const section = el('section', 'dpv-things');
      section.setAttribute('aria-label', '当天每件事');
      const head = el('div', 'dpv-things-head');
      head.appendChild(el('h2', 'dpv-title', '当天每件事'));
      const items = day.items;
      if (items) head.appendChild(el('span', 'dpv-count', `${items.length} 件`));
      section.appendChild(head);
      if (!items) { section.appendChild(el('p', 'dpv-none', '这台电脑上的 AgentDeck 没传每件事的明细，升级到 2.1 后会显示。')); return section; }
      if (!items.length) { section.appendChild(el('p', 'dpv-none', '这一天没有完成或推进中的卡。')); return section; }
      const rank = new Map(day.projects.map((x, k) => [x.name, k]));
      const names = [...new Set(items.map((x) => x.project))].sort((a, b) => (rank.has(a) ? rank.get(a) : 1e9) - (rank.has(b) ? rank.get(b) : 1e9) || a.localeCompare(b));
      names.forEach((name) => {
        const mine = items.filter((x) => x.project === name).sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
        const group = el('section', 'dpv-group');
        group.setAttribute('aria-label', `${name}，${mine.length} 件`);
        const h = el('h3', 'dpv-group-head');
        h.append(el('span', 'dpv-group-name', name), el('span', 'dpv-group-count', String(mine.length)));
        const grid = el('ul', 'dpv-grid');
        mine.forEach((x) => grid.appendChild(thing(x)));
        group.append(h, grid);
        section.appendChild(group);
      });
      return section;
    }
    function thing(x) {
      const li = el('li', 'dpv-thing');
      li.dataset.state = x.state;
      const badge = el('span', 'dpv-state');
      if (x.state === 'done') { const tick = el('span', 'dpv-tick'); tick.innerHTML = o.icon('check'); badge.appendChild(tick); }
      else badge.appendChild(el('i', 'dpv-dot'));
      badge.appendChild(el('span', null, STATE[x.state]));
      li.append(badge, el('p', 'dpv-thing-title', x.title));
      if (x.result) li.appendChild(el('p', 'dpv-result', x.result));
      return li;
    }
  }

  return { render, EMPTY };
});
