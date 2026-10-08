'use strict';

// 版本更新 panel, the same on the desktop and in the phone hub (each page brings
// its own styles): first 每日进展, one day's counts from the nightly statistics
// with the last days as columns to pick another day; then every version, planned
// and released, newest first on one line. Builds DOM only from cleaned data
// (HubCore.releaseNotes / progressDays); all text goes in as text.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReleasesView = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // What the progress card says when it has no day to show.
  const PROGRESS_EMPTY = {
    loading: ['正在读取每日进展…', ''],
    none: ['还没有每日进展', '每天 0 点自动统计前一天，明早再来看。'],
    old: ['Mac 上的 AgentDeck 还是旧版', '升级到 2.0 以后，这里会显示每天推进了多少。'],
    offline: ['每日进展暂时看不到', '每日进展在 Mac 上统计，Mac 现在连不上。连上后自动出现。'],
    error: ['没读到每日进展', '点刷新再试一次。'],
  };

  function render(box, o) {
    const H = o.core, doc = box.ownerDocument;
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const iconButton = (name, label, cls) => {
      const b = el('button', cls); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.innerHTML = o.icon(name);
      return b;
    };
    const copyButton = (entry, label) => {
      const b = iconButton('copy', label, o.buttonClass + ' rn-copy');
      b.addEventListener('click', () => o.copy(H.releaseText(entry), b, label));
      return b;
    };
    box.replaceChildren(progressCard(), timeline());
    if (o.focus) box.querySelector(`[data-focus="${o.focus}"]`)?.focus({ preventScroll: true });

    function progressCard() {
      const card = el('section', 'dp');
      card.setAttribute('aria-label', '每日进展');
      const head = el('div', 'dp-head');
      head.appendChild(el('h3', 'dp-title', '每日进展'));
      const p = o.progress, days = p.days || [];
      if (!days.length) {
        const [title, text] = PROGRESS_EMPTY[p.state] || PROGRESS_EMPTY.none;
        card.append(head, el('p', 'dp-empty-title', title));
        if (text) card.appendChild(el('p', 'dp-empty', text));
        return card;
      }
      const i = Math.min(Math.max(o.dayIndex || 0, 0), days.length - 1), day = days[i], s = day.summary;
      // Older is to the left, as on the columns below.
      const nav = el('div', 'dp-nav');
      const older = iconButton('left', '前一天', o.buttonClass + ' dp-step'); older.dataset.focus = 'older';
      const newer = iconButton('right', '后一天', o.buttonClass + ' dp-step'); newer.dataset.focus = 'newer';
      older.disabled = i >= days.length - 1; newer.disabled = i === 0;
      older.addEventListener('click', () => o.setDay(i + 1, 'older'));
      newer.addEventListener('click', () => o.setDay(i - 1, 'newer'));
      const label = el('time', 'dp-day', H.progressLabel(day.date, o.now)); label.dateTime = day.date;
      nav.append(older, label, newer);
      head.appendChild(nav);
      card.appendChild(head);

      const hero = el('div', 'dp-hero');
      hero.append(el('b', 'dp-big', String(s.done)), el('span', 'dp-unit', '张卡完成'));
      if (day.partial) hero.appendChild(el('span', 'dp-partial', '统计未完'));
      card.appendChild(hero);
      card.appendChild(el('p', 'dp-line', `推进 ${s.projects} 个项目 · 派出 ${s.sessions} 个会话 · 新建 ${s.created} 张卡`));

      // One column per day (single series: the selected day is the strong one); a column picks its day.
      if (days.length > 1) {
        const chart = el('div', 'dp-chart');
        chart.setAttribute('role', 'group'); chart.setAttribute('aria-label', '最近几天完成的卡，点一天看那天');
        // At most a week of columns, always including the chosen day.
        const start = Math.max(0, Math.min(i - 3, days.length - 7)), week = days.slice(start, start + 7);
        const most = Math.max(1, ...week.map((d) => d.summary.done));
        [...week].reverse().forEach((d) => {
          const k = days.indexOf(d);
          const col = el('button', 'dp-col' + (k === i ? ' on' : '')); col.type = 'button'; col.dataset.focus = 'day-' + d.date;
          const words = `${H.progressLabel(d.date, o.now)}：完成 ${d.summary.done} 张卡，派出 ${d.summary.sessions} 个会话`;
          col.title = words; col.setAttribute('aria-label', words); col.setAttribute('aria-pressed', String(k === i));
          const bar = el('span', 'dp-bar'); bar.style.height = Math.max(3, Math.round(d.summary.done / most * 100)) + '%';
          const track = el('span', 'dp-track'); track.appendChild(bar);
          col.append(el('span', 'dp-val', String(d.summary.done)), track, el('span', 'dp-date', d.date.slice(5)));
          col.addEventListener('click', () => o.setDay(k, 'day-' + d.date));
          chart.appendChild(col);
        });
        card.appendChild(chart);
      }

      const stats = el('ul', 'dp-stats');
      [['返工', s.rework, ''], ['审查不通过', s.reject, ''], ['等你决定', s.needsUser, s.needsUser ? 'need' : ''], ['交付', s.deliveries, '']].forEach(([name, n, cls]) => {
        const li = el('li', cls);
        li.append(el('b', null, String(n)), el('span', null, name));
        stats.appendChild(li);
      });
      card.appendChild(stats);

      const shown = day.projects.filter((x) => x.done || x.sessions).slice(0, 5), rest = day.projects.length - shown.length;
      if (shown.length) {
        const list = el('ul', 'dp-projects');
        list.setAttribute('aria-label', '各项目完成的卡');
        const top = Math.max(1, ...shown.map((x) => x.done));
        shown.forEach((x) => {
          const li = el('li');
          li.title = `${x.name}：完成 ${x.done}，新建 ${x.created}，会话 ${x.sessions}，返工 ${x.rework}`;
          const track = el('span', 'dp-ptrack'), bar = el('span', 'dp-pbar');
          bar.style.width = (x.done ? Math.max(4, Math.round(x.done / top * 100)) : 0) + '%';
          track.appendChild(bar);
          li.append(el('span', 'dp-pname', x.name), track, el('span', 'dp-pnum', String(x.done)));
          list.appendChild(li);
        });
        card.appendChild(list);
        if (rest > 0) card.appendChild(el('p', 'dp-more', `另有 ${rest} 个项目`));
      }
      if (day.deliveries.length) {
        const list = el('ul', 'dp-deliveries');
        list.setAttribute('aria-label', '交付');
        day.deliveries.slice(0, 3).forEach((t) => list.appendChild(el('li', null, t)));
        card.appendChild(list);
      }
      if (p.source) card.appendChild(el('p', 'dp-source', `来自 ${p.source}`));
      return card;
    }

    function timeline() {
      const section = el('section', 'rn-all');
      section.setAttribute('aria-label', '版本');
      const notes = o.notes;
      if (!notes) {
        const [title, text] = notes === undefined ? ['正在读取…', ''] : o.notesMissing;
        section.append(el('p', 'dp-empty-title', title), el('p', 'dp-empty', text));
        return section;
      }
      const list = el('ol', 'rn-line');
      const group = (name) => { const li = el('li', 'rn-group', name); list.appendChild(li); };
      // Newest first: what is furthest out comes first, then down to the oldest release.
      const planned = [...notes.upcoming].reverse();
      if (planned.length) group('计划中');
      planned.forEach((entry) => list.appendChild(plan(entry)));
      group('已发布');
      notes.released.forEach((entry, k) => list.appendChild(release(entry, k === 0)));
      section.appendChild(list);
      if (notes.updated) section.appendChild(el('p', 'dp-source', `计划 ${notes.updated.slice(5)} 更新`));
      return section;
    }
    function when(version, date) {
      const w = el('div', 'rn-when');
      w.appendChild(el('span', 'rn-num', version || '以后'));
      if (date) { const t = el('time', 'rn-date', H.shortDate(date)); t.dateTime = date; w.appendChild(t); }
      return w;
    }
    function release(entry, latest) {
      const li = el('li', 'rn-ver' + (latest ? ' latest' : ''));
      const body = el('div', 'rn-body'), head = el('div', 'rn-head');
      head.appendChild(el('h4', 'rn-title', entry.title));
      const using = o.using(entry.version);
      if (using) head.appendChild(el('span', 'rn-mine', using));
      head.appendChild(copyButton(entry, `复制 ${entry.version} 的更新内容`));
      const items = el('ul', 'rn-items');
      entry.items.forEach((t) => items.appendChild(el('li', null, t)));
      body.append(head, items);
      li.append(when(entry.version, entry.date), el('span', 'rn-node'), body);
      return li;
    }
    function plan(entry) {
      const li = el('li', 'rn-ver rn-plan');
      li.dataset.status = entry.status;
      const body = el('div', 'rn-body'), head = el('div', 'rn-head');
      head.append(el('h4', 'rn-title', entry.title), el('span', 'rn-status', H.PLAN_STATES[entry.status]));
      head.appendChild(copyButton(entry, entry.version ? `复制 ${entry.version} 的计划` : '复制这几件的清单'));
      body.appendChild(head);
      if (entry.note) body.appendChild(el('p', 'rn-note', entry.note));
      const rows = el('ul', 'rn-tasks');
      entry.items.forEach((item) => {
        const row = el('li', 'rn-task'); row.dataset.state = item.state;
        const state = el('span', 'rn-state');
        state.append(el('i', 'rn-dot'), el('span', null, H.ITEM_STATES[item.state]));
        const what = el('span', 'rn-what', item.text);
        if (item.suggestion) what.appendChild(el('small', 'rn-suggest', item.suggestion));
        row.append(state, what);
        rows.appendChild(row);
      });
      body.appendChild(rows);
      li.append(when(entry.version, ''), el('span', 'rn-node'), body);
      return li;
    }
  }
  return { render, PROGRESS_EMPTY };
});
