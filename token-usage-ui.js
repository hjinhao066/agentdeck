// Token 用量 view, inside the 任务看板 page (its fourth tab): how many tokens
// this machine's agents burned each day, per model. Laid out like OpenRouter's
// usage page: the range total on top with the split by provider, then one
// stacked column per day (the day's biggest model on top, as the legend and
// the tooltip list it first, smaller ones below, the day's total on the cap), a legend, and the chosen day's table
// with every model's input / output / cache numbers. Hovering a column shows
// that day's models; a click (or ←/→ on the chart) picks the day for the
// table. Numbers come from window.deck.tokenUsage (token-usage-main.js); all
// the arithmetic is TokenUsageCore. Every word on the chart is horizontal
// (charts.md): crowded totals step up over their neighbours, and a chart too
// narrow for its days scrolls sideways inside its own box, opened at today.
// The Token / 金额 switch redraws everything in dollars at each vendor's official
// API price (token-prices.json, priced by the scanner); a model without one says
// 无官方价 and is never drawn as $0. The 订阅值不值 card (in both units) weighs each
// Claude account's dollars this billing cycle against its plan's price; the
// dearest subscription leads, large, the others follow small to compare.
(function () {
  'use strict';
  const C = window.TokenUsageCore;
  const RANGES = [7, 30];
  const REFRESH_EVERY = 2 * 60 * 1000;
  const MIN_COL = 22;         // px per day before the chart scrolls
  const LINE = 14;            // a total label's line height
  const GAP = 2;              // surface gap between stacked segments
  const AXIS = 26;            // room under the baseline for the dates
  const svgIcon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    check: svgIcon('<path d="m5 12 5 5 9-10"/>'),
    minus: svgIcon('<path d="M6 12h12"/>'),
    download: svgIcon('<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>'),
    alert: svgIcon('<path d="M12 8v5M12 16.5v.01"/><circle cx="12" cy="12" r="9"/>'),
    pencil: svgIcon('<path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>'),
  };
  const UNITS = [['tokens', 'Token'], ['usd', '金额']];
  const NO_PRICE = '无官方价';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let host = null;
  let root, heroEl, heroCapEl, heroSubEl, providersEl, legendEl, wrapEl, svgEl, tipEl, tableEl, sourcesEl, statusEl, emptyEl, rangeEl, unitEl, valueEl, updatedEl, refreshBtn;
  let open = false;
  let data = null;
  let error = '';
  let loading = false;
  let seq = 0;
  let timer = null;
  let range = 7;
  let unit = 'tokens';        // tokens | usd
  let starts = {};            // 订阅值不值: a cycle start the user set, by row key
  let seats = null;           // seats:list rows, for the 订阅值不值 accounts
  let editing = null;         // the row whose cycle start is being typed
  let selected = null;        // the day the table shows
  let hover = null;           // the column under the pointer (or keyboard)
  let focusKey = null;        // a legend entry under the pointer
  let model = null;           // what the last render drew: { days, colors, labels, cols, ... }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const sv = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  };

  // ---- what the numbers say for the chosen range ----
  function derive() {
    const today = data.today;
    const days = C.dayRange(today, range);
    const tokenDays = data.days || {};
    // 金额: each day's priced models read like a token day; the rest are 无官方价.
    const money = unit === 'usd';
    const costDays = data.costs || {};
    const byDay = money ? Object.fromEntries(Object.keys(costDays).map((d) => [d, C.pricedDay(costDays[d])])) : tokenDays;
    const unpriced = new Set();
    if (money) for (const d of days) for (const k of C.unpricedKeys(costDays[d])) unpriced.add(k);
    // Colours follow a model, never its rank: they are picked from the last
    // 30 days of tokens whatever range or unit is shown, so 7 ↔ 30 and
    // Token ↔ 金额 never repaint a model.
    const month = {};
    for (const d of C.dayRange(today, 30)) for (const m of C.dayModels(tokenDays[d])) month[m.key] = (month[m.key] || 0) + m.total;
    const colors = C.assignColors(month);
    const series = {};
    let total = 0;
    const providers = { anthropic: 0, openai: 0, google: 0, other: 0 };
    for (const d of days) {
      for (const m of C.dayModels(byDay[d])) {
        series[m.key] = (series[m.key] || 0) + m.total;
        total += m.total;
        providers[C.providerOf(m.key.split(':')[0])] += m.total;
      }
    }
    // A name shown twice (one model through two CLIs) carries its CLI's name.
    const labels = {};
    const seen = {};
    const keys = [...new Set([...Object.keys(month), ...Object.keys(series), ...unpriced])];
    for (const key of keys) { const l = C.modelLabel(key.slice(key.indexOf(':') + 1)); seen[l] = (seen[l] || 0) + 1; }
    for (const key of keys) {
      const src = key.split(':')[0];
      const l = C.modelLabel(key.slice(key.indexOf(':') + 1));
      labels[key] = seen[l] > 1 ? `${l} · ${C.sourceName(src)}` : l;
    }
    const active = days.filter((d) => C.dayTotal(byDay[d]) > 0).length;
    return { today, days, byDay, costDays, money, unpriced, colors, series, total, providers, labels, active };
  }
  // Numbers in the unit shown: 1.24B / 1,234,567 tokens, or $1,234.56 either way.
  const short = (m, v) => (m.money ? C.formatUsd(v) : C.formatShort(v));
  const full = (m, v) => (m.money ? C.formatUsd(v) : C.formatFull(v) + ' tokens');
  const labelOf = (key) => (key === C.OTHER ? '其他模型' : (model && model.labels[key]) || C.modelLabel(key.slice(key.indexOf(':') + 1)));

  // ---- the parts ----
  function renderHero(m) {
    heroCapEl.textContent = m.money ? '按官方 API 价折算' : 'Token 合计';
    heroEl.textContent = short(m, m.total);
    heroEl.title = full(m, m.total) + (m.money ? `\n各家官方 API 标准价（查价 ${data.pricesChecked || ''}）${m.unpriced.size ? `；${m.unpriced.size} 个模型无官方价，没算进来` : ''}` : '');
    const todayTotal = C.dayTotal(m.byDay[m.today]);
    heroSubEl.textContent = `近 ${range} 天 · 日均 ${short(m, m.active ? m.total / m.active : 0)} · 今天 ${short(m, todayTotal)}`;
    providersEl.replaceChildren(...C.PROVIDERS.map((p) => {
      const v = m.providers[p.key];
      const tile = el('div', 'tu-provider' + (v ? '' : ' none'));
      tile.dataset.provider = p.key;
      tile.title = `${p.label}：${full(m, v)}`;
      const bar = el('i', 'tu-provider-bar');
      bar.style.setProperty('--share', m.total ? (v / m.total).toFixed(4) : '0');
      tile.append(el('span', 'tu-provider-name', p.label), el('b', 'tu-provider-num', short(m, v)), el('span', 'tu-provider-pct', C.formatPct(v, m.total)), bar);
      return tile;
    }));
  }

  function legendEntries(m) {
    const own = [], other = { key: C.OTHER, total: 0, members: [] };
    for (const [key, v] of Object.entries(m.series).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
      if (!v) continue;
      if ((m.colors[key] || C.OTHER) === C.OTHER) { other.total += v; other.members.push(key); } else own.push({ key, slot: m.colors[key], total: v });
    }
    // 金额: a model without an official price keeps its place in the legend, after the priced ones
    for (const key of [...m.unpriced].sort()) {
      if ((m.colors[key] || C.OTHER) === C.OTHER) other.members.push(key); else own.push({ key, slot: m.colors[key], total: null });
    }
    if (other.members.length) own.push({ key: C.OTHER, slot: C.OTHER, total: other.total, members: other.members });
    return own;
  }
  const valueText = (m, key) => (m.money && m.unpriced.has(key) && !(m.series[key] > 0) ? NO_PRICE : short(m, m.series[key] || 0));
  function renderLegend(m) {
    legendEl.replaceChildren(...legendEntries(m).map((e) => {
      const item = el('li', 'tu-legend-item');
      item.dataset.key = e.key;
      const sw = el('i', 'tu-swatch'); sw.dataset.slot = e.slot;
      const num = e.total == null ? NO_PRICE : e.members && !e.total ? NO_PRICE : short(m, e.total);
      item.append(sw, el('span', 'tu-legend-name', labelOf(e.key)), el('span', 'tu-legend-num', num));
      item.title = e.members ? e.members.map((k) => `${labelOf(k)}  ${valueText(m, k)}`).join('\n') : `${labelOf(e.key)}：${e.total == null ? NO_PRICE : full(m, e.total)}（${C.sourceName(e.key.split(':')[0])}）`;
      item.addEventListener('pointerenter', () => setFocus(e.key));
      item.addEventListener('pointerleave', () => setFocus(null));
      return item;
    }));
  }
  function setFocus(key) {
    focusKey = key;
    svgEl.classList.toggle('has-focus', !!key);
    svgEl.querySelectorAll('.tu-seg').forEach((s) => s.classList.toggle('on', s.dataset.key === key));
  }

  // A rect whose top corners are rounded (the cap of a column).
  function capPath(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h));
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  let measureCtx = null;
  function textWidth(text, font) {
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  function renderChart(m) {
    const n = m.days.length;
    const boxW = Math.max(200, wrapEl.clientWidth);
    const height = wrapEl.clientHeight > 120 ? wrapEl.clientHeight : 300;
    const side = 6;
    const colW = Math.max(MIN_COL, (boxW - side * 2) / n);
    const width = Math.round(colW * n + side * 2);
    const base = height - AXIS;
    const barW = Math.max(6, Math.min(colW * 0.62, 46));
    const family = getComputedStyle(wrapEl).fontFamily || 'sans-serif';
    const labelFont = `600 11.5px ${family}`;
    const totals = m.days.map((d) => C.dayTotal(m.byDay[d]));
    const max = Math.max(0, ...totals);
    const texts = totals.map((t) => (t > 0 ? short(m, t) : ''));
    // the labels draw tabular digits (every digit as wide as 0), so they are measured that way
    const widths = texts.map((t) => (t ? Math.ceil(textWidth(t.replace(/\d/g, '0'), labelFont)) + 2 : 0));
    const x = (i) => side + colW * i + colW / 2;
    // A label wider than its column (a dollar amount) is pulled in at the chart's two ends, never cut.
    const lx = (i) => Math.max(widths[i] / 2, Math.min(width - widths[i] / 2, x(i)));
    // Room above the tallest column for its label, more when labels had to step up.
    let reserve = LINE + 8, tops = [], placed = null;
    for (let pass = 0; pass < 4; pass++) {
      const plotH = base - reserve;
      const scale = max > 0 ? plotH / max : 0;
      tops = totals.map((t) => base - t * scale);
      placed = C.placeLabels(totals.map((t, i) => (t > 0 ? { x: x(i), lx: lx(i), top: tops[i], w: widths[i] } : null)), { barWidth: barW, base, lineHeight: LINE, pad: 3, gap: 3 });
      const need = (placed.rows + 1) * LINE + 8;
      if (need <= reserve) break;
      reserve = need;
    }
    const scale = max > 0 ? (base - reserve) / max : 0;

    svgEl.replaceChildren();
    svgEl.setAttribute('width', width);
    svgEl.setAttribute('height', height);
    svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const cols = [];
    const tick = C.axisTicks(m.days, m.today, 40, colW);
    m.days.forEach((day, i) => {
      const g = sv('g', { class: 'tu-col' + (day === m.today ? ' today' : '') + (day === selected ? ' sel' : ''), 'data-day': day });
      g.append(sv('rect', { class: 'tu-hit', x: side + colW * i, y: 0, width: colW, height: base + AXIS, rx: 8 }));
      const left = x(i) - barW / 2;
      if (totals[i] > 0) {
        let y = base;
        const segs = C.stack(m.byDay[day], m.colors);
        segs.forEach((s, k) => {
          const h = s.total * scale;
          const last = k === segs.length - 1;
          const bottom = k > 0 ? y - GAP : y;
          const top = y - h;
          y = top;
          if (bottom - top < 0.75) return; // thinner than a line: the tooltip and table still list it
          const attrs = { class: 'tu-seg', 'data-key': s.key, 'data-slot': s.slot };
          g.append(last ? sv('path', { ...attrs, d: capPath(left, top, barW, bottom - top, 4) }) : sv('rect', { ...attrs, x: left, y: top, width: barW, height: bottom - top }));
        });
        const t = sv('text', { class: 'tu-total', x: lx(i), y: placed.bottoms[i] - 3, 'text-anchor': 'middle' });
        t.textContent = texts[i];
        g.append(t);
      } else {
        // a day without records keeps its place: a faint stub, no number
        const h = Math.max(3, (base - reserve) * 0.025);
        g.append(sv('path', { class: 'tu-stub', d: capPath(left, base - h, barW, h, 3) }));
      }
      if (tick[i]) {
        const a = sv('text', { class: 'tu-axis' + (day === m.today ? ' today' : ''), x: x(i), y: base + 17, 'text-anchor': 'middle' });
        a.textContent = C.axisLabel(day, m.today);
        g.append(a);
      }
      svgEl.append(g);
      cols.push({ day, x: x(i), left: side + colW * i });
    });
    svgEl.prepend(sv('line', { class: 'tu-base', x1: side, x2: width - side, y1: base + 0.5, y2: base + 0.5 }));
    model.cols = cols; model.colW = colW; model.side = side; model.base = base; model.width = width;
    const scrolls = width > boxW + 1;
    wrapEl.classList.toggle('scrolls', scrolls);
    if (scrolls && !wrapEl.dataset.scrolled) { wrapEl.scrollLeft = width; wrapEl.dataset.scrolled = '1'; }
    if (focusKey) setFocus(focusKey);
    if (hover) showTip(hover);
  }

  // ---- hover ----
  function colAt(clientX) {
    if (!model || !model.cols) return null;
    const r = svgEl.getBoundingClientRect();
    const i = Math.floor((clientX - r.left - model.side) / model.colW);
    return model.cols[i] ? model.cols[i].day : null;
  }
  function setHover(day) {
    if (day === hover) return;
    hover = day;
    svgEl.classList.toggle('has-hover', !!day);
    svgEl.querySelectorAll('.tu-col').forEach((g) => g.classList.toggle('hot', g.dataset.day === day));
    if (day) showTip(day); else tipEl.hidden = true;
  }
  function showTip(day) {
    const col = model.cols && model.cols.find((c) => c.day === day);
    if (!col) { tipEl.hidden = true; return; }
    const dayMap = model.byDay[day];
    const total = C.dayTotal(dayMap);
    tipEl.replaceChildren();
    const head = el('div', 'tu-tip-head');
    const unpriced = model.money ? C.unpricedKeys(model.costDays[day]) : [];
    head.append(el('span', 'tu-tip-day', C.dayTitle(day, model.today)), el('b', 'tu-tip-total', short(model, total)));
    tipEl.append(head);
    if (!total && !unpriced.length) tipEl.append(el('div', 'tu-tip-empty', '这天没有用量记录'));
    else {
      const list = el('ul', 'tu-tip-list');
      const row = (key, num, pct) => {
        const li = el('li');
        const sw = el('i', 'tu-swatch'); sw.dataset.slot = model.colors[key] || C.OTHER;
        li.append(sw, el('span', 'tu-tip-name', labelOf(key)), el('span', 'tu-tip-num', num), el('span', 'tu-tip-pct', pct));
        list.append(li);
      };
      for (const mm of C.dayModels(dayMap)) row(mm.key, short(model, mm.total), C.formatPct(mm.total, total));
      for (const key of unpriced) row(key, NO_PRICE, '');
      tipEl.append(list);
      const b = C.dayBuckets(dayMap);
      const foot = el('div', 'tu-tip-foot');
      for (const k of C.BUCKETS) foot.append(el('span', null, `${C.BUCKET_LABELS[k]} ${short(model, b[k])}`));
      tipEl.append(foot);
    }
    tipEl.hidden = false;
    // beside the column, on the side with more room, never outside the chart box
    const box = wrapEl.getBoundingClientRect();
    const svgBox = svgEl.getBoundingClientRect();
    const cx = svgBox.left - box.left + col.x;
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    const gapX = model.colW / 2 + 6;
    let left = cx < box.width / 2 ? cx + gapX : cx - gapX - w;
    left = Math.max(4, Math.min(left, box.width - w - 4));
    const top = Math.max(4, Math.min(model.base - h - 8, 12));
    tipEl.style.transform = `translate(${Math.round(left + wrapEl.scrollLeft)}px, ${Math.round(top)}px)`;
  }

  // ---- the chosen day's table ----
  function renderTable(m) {
    const day = selected && m.days.includes(selected) ? selected : m.today;
    const dayMap = m.byDay[day];
    const total = C.dayTotal(dayMap);
    const unpriced = m.money ? C.unpricedKeys(m.costDays[day]) : [];
    const n = (v) => (m.money ? C.formatUsd(v) : C.formatFull(v));
    tableEl.replaceChildren();
    const cap = el('div', 'tu-table-cap');
    cap.append(el('span', 'tu-table-day', C.dayTitle(day, m.today)), el('span', 'tu-table-total', total ? `合计 ${n(total)}` : ''));
    tableEl.append(cap);
    if (!total && !unpriced.length) { tableEl.append(el('div', 'tu-table-empty', '这天没有用量记录。')); return; }
    const t = el('table', 'tu-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const [h, cls] of [['模型', ''], ['来源', ''], ['输入', 'n'], ['输出', 'n'], ['缓存读', 'n'], ['缓存写', 'n'], ['合计', 'n'], ['占比', 'n']]) hr.append(el('th', cls || null, h));
    thead.append(hr);
    const tbody = el('tbody');
    const row = (key, cells) => {
      const tr = el('tr');
      const name = el('td', 'tu-td-model');
      const sw = el('i', 'tu-swatch'); sw.dataset.slot = m.colors[key] || C.OTHER;
      const inner = el('span');
      inner.append(sw, el('span', null, labelOf(key)));
      name.append(inner);
      tr.append(name, el('td', 'tu-td-src', C.sourceName(key.split(':')[0])), ...cells);
      tbody.append(tr);
    };
    for (const mm of C.dayModels(dayMap)) {
      row(mm.key, [...C.BUCKETS.map((k) => el('td', 'n', n(mm.buckets[k]))), el('td', 'n strong', n(mm.total)), el('td', 'n', C.formatPct(mm.total, total))]);
    }
    // 金额: a model without an official price is listed, never priced at $0
    for (const key of unpriced) row(key, [...C.BUCKETS.map(() => el('td', 'n dim', '—')), el('td', 'n strong', NO_PRICE), el('td', 'n dim', '—')]);
    t.append(thead, tbody);
    const scroll = el('div', 'tu-table-scroll');
    scroll.append(t);
    tableEl.append(scroll);
  }

  // ---- where the numbers come from ----
  const SOURCE_NOTE = {
    cursor: '从 Cursor 网站导出用量表（usage-events…csv）放进「下载」文件夹就能算上',
    'gemini-cli': 'Gemini CLI 的日志里没有用量数字',
    'chatgpt-web': '网页版 ChatGPT 不提供用量数字',
  };
  function renderSources() {
    sourcesEl.replaceChildren(...(data.sources || []).map((s) => {
      const item = el('li', 'tu-source ' + s.state);
      item.dataset.source = s.id;
      const icon = el('i', 'tu-source-icon');
      icon.innerHTML = s.state === 'ok' ? ICON.check : s.state === 'error' ? ICON.alert : s.export ? ICON.download : ICON.minus;
      icon.setAttribute('aria-hidden', 'true');
      let text = '无数据';
      if (s.state === 'ok') text = s.lastDay ? `最近 ${C.axisLabel(s.lastDay, data.today)}` : '有数据';
      else if (s.state === 'error') text = '读取出错';
      item.append(icon, el('span', 'tu-source-name', s.name), el('span', 'tu-source-state', text));
      const tips = [];
      if (s.state === 'ok') tips.push(`${s.records.toLocaleString('en-US')} 次模型调用`);
      if (s.missing) tips.push(`另有 ${s.missing} 条账单没写 token 数`);
      if (s.state !== 'ok' && SOURCE_NOTE[s.id]) tips.push(SOURCE_NOTE[s.id]);
      if (s.state === 'error') tips.push(`${s.errors} 个日志文件读不出来`);
      item.title = `${s.name}：${tips.join('；') || text}`;
      return item;
    }));
  }

  // ---- 订阅值不值: each Claude account's dollars this billing cycle against its plan ----
  const dayName = (day) => { const p = C.dayParts(day); return `${p.m}月${p.d}日`; };
  function renderValue(m) {
    const rows = seats && data.seatCosts ? C.valueRows({ seatCosts: data.seatCosts, infos: seats, plans: data.plans || {}, starts, today: data.today, now: Date.now() }) : [];
    valueEl.hidden = !rows.length;
    if (!rows.length) { valueEl.replaceChildren(); return; }
    const head = el('div', 'tu-value-head');
    head.append(el('h2', 'tu-value-title', '订阅值不值'), el('span', 'tu-value-note', '按 API 标价折算 · 只算本机日志'));
    const list = el('div', 'tu-value-list');
    const names = (ids) => ids.map((id) => { const s = seats.find((x) => x.id === id); return (s && s.name) || id; }).join('、');
    rows.forEach((r, i) => {
      const v = r.value;
      const item = el('div', 'tu-value-row' + (i === 0 && rows.length > 1 ? ' lead' : ''));
      item.dataset.key = r.key;
      const who = el('div', 'tu-value-who');
      const name = el('span', 'tu-value-name', r.names.join(' / ') || '未登录');
      who.title = `${r.names.join(' / ') || '未登录'} · 席位 ${names(r.seats)}${r.seats.length > 1 ? '（这几个席位共用一个日志目录，分不开）' : ''}`;
      who.append(name);
      if (r.plan) who.append(el('span', 'tu-value-plan', r.plan));
      const times = el('b', 'tu-value-times', v.times == null ? '—' : C.formatTimes(v.times));
      times.title = r.price ? `本周期已值 ${C.formatUsd(v.spent)}，是订阅价 ${C.formatUsd(r.price)} 的 ${C.formatTimes(v.times)}` : '这个套餐没有公开价，算不出倍数';
      const nums = el('div', 'tu-value-nums');
      const spent = el('span', 'tu-value-spent');
      spent.append('已值 ', el('b', null, C.formatUsd(v.spent)), r.price ? ` · 订阅 ${C.formatUsd(r.price)}` : '');
      const pace = el('span', 'tu-value-pace', `日均 ${C.formatUsd(v.perDay)} · 整周期约 ${C.formatUsd(v.projected)}${v.projectedTimes == null ? '' : `（${C.formatTimes(v.projectedTimes)}）`}`);
      pace.title = `按本周期到现在的速度，一直用到 ${dayName(r.cycle.end)} 前`;
      nums.append(spent, pace);
      const cycle = el('div', 'tu-value-cycle');
      if (editing === r.key) {
        const input = el('input', 'tu-value-date');
        input.type = 'date'; input.value = r.cycle.start; input.max = data.today;
        input.setAttribute('aria-label', '周期起点');
        input.title = '回车或点别处确定，Esc 取消；清空回到订阅日';
        const close = () => { editing = null; renderValue(model); };
        // an unchanged date only closes the editor; a date picked from the calendar, then a click elsewhere, is kept too
        const done = () => { if (input.value === r.cycle.start) close(); else setStart(r.key, input.value); };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }   // the page's own Esc closes the board
        });
        input.addEventListener('blur', () => { if (editing === r.key) done(); });
        cycle.append(input);
        requestAnimationFrame(() => input.focus());
      } else {
        const day = Math.min(r.cycle.days, Math.floor((Date.now() - C.dayStart(r.cycle.start)) / 86400000) + 1);
        const when = el('span', 'tu-value-range', `${dayName(r.cycle.start)}起 · 第 ${day} / ${r.cycle.days} 天`);
        when.title = `本周期 ${dayName(r.cycle.start)} – ${dayName(r.cycle.end)}${r.custom ? '（你设的起点）' : '（按订阅日每月一期）'}`;
        const edit = el('button', 'tbv-icon tu-value-edit');
        edit.type = 'button'; edit.title = '改周期起点'; edit.setAttribute('aria-label', '改周期起点');
        edit.innerHTML = ICON.pencil;
        edit.onclick = () => { editing = r.key; renderValue(model); };
        cycle.append(when, edit);
      }
      item.append(who, times, nums, cycle);
      list.append(item);
    });
    valueEl.replaceChildren(head, list);
  }
  function setStart(key, value) {
    editing = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value) && value <= data.today) starts = { ...starts, [key]: value };
    else if (!value) { starts = { ...starts }; delete starts[key]; }
    savePrefs();
    renderValue(model);
    host.announce('周期起点已更新');
  }
  function loadSeats() {
    if (!window.deck || !window.deck.claudeSeats) return;
    window.deck.claudeSeats(false).then((list) => {
      if (!open || !Array.isArray(list)) return;
      seats = list;
      if (data && model && !editing) renderValue(model);
    }).catch(() => {});
  }

  const savePrefs = () => host.savePrefs({ days: range, unit, starts });
  function renderRange() {
    rangeEl.querySelectorAll('button').forEach((b) => {
      const on = Number(b.dataset.days) === range;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    unitEl.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.unit === unit;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  function renderUpdated() {
    if (!data) { updatedEl.textContent = loading ? '正在读取本机日志…' : ''; return; }
    const t = new Date(data.generatedAt);
    updatedEl.textContent = `更新于 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  }

  function render() {
    if (!root) return;
    refreshBtn.classList.toggle('busy', loading);
    refreshBtn.disabled = loading;
    renderRange();
    renderUpdated();
    statusEl.hidden = !error;
    statusEl.textContent = error ? (data ? `刷新没成功（${error}），下面是上次的数字。` : `读不到用量：${error}。点右上角刷新再试一次。`) : '';
    root.classList.toggle('loading', !data && loading);
    root.classList.toggle('ready', !!data);
    if (!data) return;
    model = derive();
    root.classList.toggle('money', model.money);
    emptyEl.hidden = model.total > 0 || model.unpriced.size > 0;
    renderHero(model);
    if (!editing) renderValue(model);   // a refresh never wipes a date being typed
    renderLegend(model);
    renderChart(model);
    renderTable(model);
    renderSources();
  }

  function load(fresh) {
    if (!open || !window.deck || !window.deck.tokenUsage) return;
    const mine = ++seq;
    loading = true;
    render();
    window.deck.tokenUsage(fresh).then((r) => {
      if (mine !== seq) return;
      data = r; error = '';
    }).catch((e) => {
      if (mine !== seq) return;
      error = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }).finally(() => {
      if (mine !== seq) return;
      loading = false;
      render();
      host.announce(error ? '刷新没成功' : 'Token 用量已更新');
    });
  }

  function setRange(n) {
    if (!RANGES.includes(n) || n === range) return;
    range = n;
    delete wrapEl.dataset.scrolled;
    savePrefs();
    render();
  }
  function setUnit(u) {
    if (u === unit || !UNITS.some(([k]) => k === u)) return;
    unit = u;
    editing = null;
    savePrefs();
    render();
    if (unit === 'usd' && !seats) loadSeats();
  }
  function pick(day) {
    selected = day;
    svgEl.querySelectorAll('.tu-col').forEach((g) => g.classList.toggle('sel', g.dataset.day === day));
    if (model) renderTable(model);
  }

  function build() {
    root.innerHTML = `
      <div class="tu-bar">
        <div class="tu-switches">
          <div class="tu-range" role="group" aria-label="时间范围">${RANGES.map((n) => `<button type="button" data-days="${n}">近 ${n} 天</button>`).join('')}</div>
          <div class="tu-range tu-unit" role="group" aria-label="单位">${UNITS.map(([k, label]) => `<button type="button" data-unit="${k}">${label}</button>`).join('')}</div>
        </div>
        <div class="tu-tools">
          <span class="tu-updated" aria-live="polite"></span>
          <button type="button" class="tbv-icon tu-refresh" title="重新读取用量" aria-label="重新读取用量">${svgIcon('<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>')}</button>
        </div>
      </div>
      <div class="tu-status" role="status" hidden></div>
      <div class="tu-scroll">
        <div class="tu-loading" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div class="tu-content">
          <section class="tu-summary" aria-label="合计">
            <div class="tu-hero"><span class="tu-hero-cap">Token 合计</span><b class="tu-hero-num">0</b><span class="tu-hero-sub"></span></div>
            <div class="tu-providers"></div>
          </section>
          <section class="tu-value" aria-label="订阅值不值" hidden></section>
          <section class="tu-chart-card" aria-label="每天各模型用量">
            <ul class="tu-legend" aria-label="图例"></ul>
            <div class="tu-chart" tabindex="0" role="group" aria-label="每天的用量柱状图：左右方向键换一天">
              <svg class="tu-svg" aria-hidden="true"></svg>
              <div class="tu-tip" role="tooltip" hidden></div>
              <div class="tu-empty" hidden>这段时间本机没有用量记录，队长和队员干过活后会按天出现在这里</div>
            </div>
          </section>
          <section class="tu-day" aria-label="当天明细"></section>
          <ul class="tu-sources" aria-label="数据来源"></ul>
        </div>
      </div>`;
    heroEl = root.querySelector('.tu-hero-num');
    heroCapEl = root.querySelector('.tu-hero-cap');
    valueEl = root.querySelector('.tu-value');
    unitEl = root.querySelector('.tu-unit');
    heroSubEl = root.querySelector('.tu-hero-sub');
    providersEl = root.querySelector('.tu-providers');
    legendEl = root.querySelector('.tu-legend');
    wrapEl = root.querySelector('.tu-chart');
    svgEl = root.querySelector('.tu-svg');
    tipEl = root.querySelector('.tu-tip');
    emptyEl = root.querySelector('.tu-empty');
    tableEl = root.querySelector('.tu-day');
    sourcesEl = root.querySelector('.tu-sources');
    statusEl = root.querySelector('.tu-status');
    rangeEl = root.querySelector('.tu-range:not(.tu-unit)');
    updatedEl = root.querySelector('.tu-updated');
    refreshBtn = root.querySelector('.tu-refresh');
    refreshBtn.onclick = () => { load(true); loadSeats(); };
    rangeEl.querySelectorAll('button').forEach((b) => { b.onclick = () => setRange(Number(b.dataset.days)); });
    unitEl.querySelectorAll('button').forEach((b) => { b.onclick = () => setUnit(b.dataset.unit); });
    wrapEl.addEventListener('pointermove', (e) => setHover(colAt(e.clientX)));
    wrapEl.addEventListener('pointerleave', () => setHover(null));
    wrapEl.addEventListener('click', (e) => { const d = colAt(e.clientX); if (d) pick(d); });
    wrapEl.addEventListener('keydown', (e) => {
      if (!model || !model.cols) return;
      const days = model.days;
      let i = days.indexOf(selected && days.includes(selected) ? selected : model.today);
      if (e.key === 'ArrowLeft') i--; else if (e.key === 'ArrowRight') i++;
      else if (e.key === 'Home') i = 0; else if (e.key === 'End') i = days.length - 1;
      else return;
      e.preventDefault();
      i = Math.max(0, Math.min(days.length - 1, i));
      pick(days[i]);
      setHover(days[i]);
      host.announce(`${C.dayTitle(days[i], model.today)}，${full(model, C.dayTotal(model.byDay[days[i]]))}`);
    });
    wrapEl.addEventListener('blur', () => setHover(null));
    new ResizeObserver(() => { if (open && data) { model = derive(); renderChart(model); } }).observe(wrapEl);
  }

  function init(h) {
    host = h;
    root = document.querySelector('#taskBoardView .tu-view');
    build();
  }
  function show() {
    if (open) return;
    open = true;
    root.hidden = false;
    const saved = C.viewPrefs(host.prefs());
    range = saved.days; unit = saved.unit; starts = saved.starts;
    selected = null; hover = null; editing = null;
    delete wrapEl.dataset.scrolled;
    render();
    load(false);
    loadSeats();
    timer = setInterval(() => { if (!document.hidden) load(false); }, REFRESH_EVERY);
  }
  function hide() {
    if (!open) return;
    open = false;
    root.hidden = true;
    seq++;
    loading = false;
    clearInterval(timer); timer = null;
    setHover(null);
  }

  window.TokenUsageUI = { init, show, hide, isOpen: () => open, refresh: () => load(true) };
})();
