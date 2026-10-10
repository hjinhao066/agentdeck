// CrewFx: the page side of the 队伍 map's moving light (3.1, 星河流光). It lays two canvases into the map — the sky,
// fixed behind it, and the light layer, in the map's own coordinates over the cards — and hands both to a worker
// (crew-fx-worker.js) that draws all the motion at ≤16 frames a second: stars drifting each its own way, meteors at
// random, the artery (beats of light pushed out from 队长 along every working line), the spinner of a working card,
// the ping of a card that asks, 队长's hub ringing with each beat. Nothing on the page itself animates — no CSS
// animation, no requestAnimationFrame loop — so between the worker's frames the main thread and the compositor rest.
// What stays on the page costs nothing at rest: a faint dust of stars drawn once per window size, and a spotlight
// under the pointer (a repaint of the one card it moves over).
// It stops: the map out of sight (another view, the window minimised, covered or on another desktop) stops the
// worker's clock; the motion switch (data-motion="off" on <html>) and prefers-reduced-motion leave one still frame.
// crew-map.js tells it what to draw: attach() once, update() after each redraw (and while a card is dragged),
// view() whenever the map is panned or zoomed.
(function () {
  'use strict';
  const root = document.documentElement;
  const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const CFG = {
    seed: 11, fps: 16, skyFps: 8,
    // stars drift each its own way (14–60 px, sways of 40–150 s), a faint uneven shimmer, a few glints at random
    sky: { density: 1 / 9000, bigShare: 0.13, small: [0.7, 1.3], big: [1.5, 2.3], colors: ['#ffffff', '#dfe6ff', '#bcd0ff', '#ffe2b8'],
      alpha: [0.35, 0.95], twinkle: [0.08, 0.24], wander: { amp: [14, 60], period: [40, 150] }, spikes: true, glints: 3, glint: [8, 22], glintColor: '#dfe8ff' },
    // meteors every 2.5–11 s, about one time in five a shower of 3–6; any of two families of directions
    meteor: { every: [2.5, 11], showerChance: 0.2, showerSize: [3, 6], dur: [0.6, 1.5], len: [220, 680], angleLeft: [118, 162], angleRight: [18, 62], colors: ['#9fc0ff', '#c9d6ff', '#a9e6ff'] },
    // the artery: a strong beat and a weaker one just after it, every 1.7 s, out from 队长 at 380 px/s
    pulse: { period: 1.7, beats: [[0, 1], [0.24, 0.5]], speed: 380, tail: 210, width: 4.2, glow: 20, glowAlpha: 0.42, head: 34, step: 7, landing: 140, fade: 0.3 },
    spin: { r: 5.3, width: 1.7, period: 2.2 },
  };
  let mapEl = null, vp = null, canvasEl = null, sky = null, dust = null, layer = null, worker = null, source = null;
  let shown = false, lastRun = '', origin = null, updT = 0, viewT = 0, dustT = 0, lastView = null, failed = false;

  const motionOn = () => root.dataset.motion !== 'off' && !reduceMq.matches;
  const light = () => root.dataset.theme === 'light';
  const el = (tag, cls) => { const n = document.createElement(tag); n.className = cls; return n; };
  const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  // a colour the stylesheet names (a token, or a var() of one), as the worker needs it: a plain #rrggbb
  function colour(value) {
    const v = String(value || '').trim(), m = /^var\((--[\w-]+)\)$/.exec(v);
    const raw = (m ? getComputedStyle(mapEl).getPropertyValue(m[1]) : v).trim();
    if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw.length === 4 ? '#' + raw.slice(1).split('').map((c) => c + c).join('') : raw.slice(0, 7);
    const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(raw);
    return rgb ? '#' + rgb.slice(1, 4).map((x) => Math.round(+x).toString(16).padStart(2, '0')).join('') : '#9fb2ff';
  }
  // by day the waves are drawn thinner and fainter: a glow that reads as light by night is a smudge on white
  const themeCfg = () => ({ light: light(), pulse: light() ? { ...CFG.pulse, width: 3.4, glow: 9, glowAlpha: 0.16, head: 20 } : CFG.pulse,
    spin: { ...CFG.spin, color: colour('var(--fx-spin)') }, pingColor: colour('var(--fx-ping)'), hubColor: colour('var(--fx-hub)') });

  // the faint dust: drawn once into a canvas the size of the window (again only when the window changes size)
  function paintDust() {
    const w = vp.clientWidth, h = vp.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!w || !h) return;
    dust.width = Math.round(w * dpr); dust.height = Math.round(h * dpr);
    const g = dust.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const r = rng(CFG.seed * 31 + 5), n = Math.round((w * h) / 1700), tint = ['255,255,255', '205,215,255', '255,236,210'];
    for (let i = 0; i < n; i++) {
      const x = r() * w, y = r() * h, rad = r() < 0.06 ? 0.8 + r() * 0.5 : 0.3 + r() * 0.4;
      g.fillStyle = `rgba(${tint[Math.floor(r() * tint.length)]},${(0.1 + 0.4 * r() * r()).toFixed(3)})`;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
  }
  function sendSky() { if (worker) worker.postMessage({ type: 'sky', w: vp.clientWidth, h: vp.clientHeight, dpr: Math.min(2, window.devicePixelRatio || 1), still: !motionOn() }); }

  // a card's spinner or ping, where it stands in the map: the card's own place plus the icon's offset in it, read
  // from the layout (a card gliding to a new place by transform does not move this)
  function iconAt(icon, card) {
    let x = icon.offsetWidth / 2, y = icon.offsetHeight / 2;
    for (let n = icon; n && n !== card; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
    return { x: card.offsetLeft + x, y: card.offsetTop + y };
  }
  // What the light layer draws, in map coordinates, from the map as it was just drawn.
  function collect() {
    const src = source();
    if (!src) return null;
    const w = src.width + 80, h = src.height + 80, x0 = -40, y0 = -40, dpr = Math.min(2, window.devicePixelRatio || 1);
    // sharp enough at 140%, never more than ~8 million pixels
    const scale = Math.max(0.75, Math.min(dpr * 1.25, Math.sqrt(8e6 / (w * h))));
    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const paths = src.lines.map((l) => {
      probe.setAttribute('d', l.d);
      const L = probe.getTotalLength(), n = Math.max(2, Math.ceil(L / 6)), pts = [];
      for (let k = 0; k <= n; k++) { const q = probe.getPointAtLength((L * k) / n); pts.push(+(q.x - x0).toFixed(1), +(q.y - y0).toFixed(1)); }
      return { pts, core: !!l.core, color: colour(l.core ? 'var(--fx-core)' : l.color) };
    });
    const cards = [...canvasEl.querySelectorAll('.cm-nodes .cm-node:not(.archived)')];
    const at = (sel) => cards.map((n) => { const ic = n.querySelector(sel); if (!ic) return null; const p = iconAt(ic, n); return { x: p.x - x0, y: p.y - y0, off: hash(n.dataset.nodeId || '') % 1500 }; }).filter(Boolean);
    const spins = at('.cm-status > .cm-ico.st-working'), pings = at('.cm-status > .cm-ico.st-input');
    const hub = src.hub ? { x: src.hub[0] - x0, y: src.hub[1] - y0 } : null;
    Object.assign(layer.style, { left: x0 + 'px', top: y0 + 'px', width: w + 'px', height: h + 'px' });
    origin = { x: x0, y: y0 };
    return { w, h, scale, paths, spins, pings, hub };
  }
  function update() {
    if (!worker) return;
    clearTimeout(updT); updT = 0;
    const geo = collect();
    if (geo) { worker.postMessage({ type: 'geo', geo, still: !motionOn() }); if (lastView) view(lastView); }
  }
  // while a card is dragged the map redraws its lines at every move: follow it at most every 60 ms
  function updateSoon() { if (!updT) updT = setTimeout(update, 60); }
  // the part of the map on screen, in the light layer's coordinates: what is off screen is not drawn
  function view(v) {
    lastView = v;
    if (!worker || !origin || !v || viewT) return;
    viewT = setTimeout(() => {
      viewT = 0;
      const k = lastView.scale || 1;
      worker.postMessage({ type: 'view', rect: [-lastView.x / k - origin.x, -lastView.y / k - origin.y, vp.clientWidth / k, vp.clientHeight / k], still: !motionOn() });
    }, 120);
  }

  function sync() {
    if (!worker) return;
    const run = shown && motionOn() && document.visibilityState === 'visible';
    mapEl.classList.toggle('fx-still', !motionOn());
    const key = run + '/' + motionOn();
    if (key === lastRun) return;
    lastRun = key;
    worker.postMessage({ type: 'run', run, still: !motionOn() });
  }

  // a spotlight where the pointer is: two custom properties on the card under it, written at most once a frame
  function bindSpotlight() {
    let raf = 0, last = null;
    canvasEl.querySelector('.cm-nodes').addEventListener('pointermove', (e) => {
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const n = last.target.closest && last.target.closest('.cm-node');
        if (!n) return;
        const r = n.getBoundingClientRect(), s = n.offsetWidth / r.width || 1;
        n.style.setProperty('--mx', ((last.clientX - r.left) * s).toFixed(1) + 'px');
        n.style.setProperty('--my', ((last.clientY - r.top) * s).toFixed(1) + 'px');
      });
    });
  }

  // root: #crewMap; lines(): { width, height, lines: [{ d, color, core }], hub: [x, y] } of the map as drawn
  function attach(opts) {
    if (worker || failed) return api;
    mapEl = opts.root; vp = opts.viewport; canvasEl = opts.canvas; source = opts.source;
    try {
      sky = el('div', 'fx-sky');
      sky.setAttribute('aria-hidden', 'true');
      dust = el('canvas', 'fx-dust');
      const skyCv = el('canvas', 'fx-skycv');
      sky.append(dust, skyCv);
      vp.prepend(sky);
      layer = el('canvas', 'fx-layer');
      layer.setAttribute('aria-hidden', 'true');
      canvasEl.appendChild(layer);
      worker = new Worker('crew-fx-worker.js');
      const a = skyCv.transferControlToOffscreen(), b = layer.transferControlToOffscreen();
      worker.postMessage({ type: 'init', cfg: { ...CFG, ...themeCfg() }, sky: a, layer: b }, [a, b]);
    } catch (e) {
      // no worker or no OffscreenCanvas: the map stands still, as with the motion switch off
      failed = true; worker = null;
      if (sky) sky.remove();
      if (layer) layer.remove();
      mapEl.classList.add('fx-still');
      return api;
    }
    mapEl.classList.add('fx-on');
    paintDust();
    sendSky();
    window.addEventListener('resize', () => { clearTimeout(dustT); dustT = setTimeout(() => { paintDust(); sendSky(); if (lastView) view(lastView); }, 200); });
    document.addEventListener('visibilitychange', sync);
    reduceMq.addEventListener('change', sync);
    // the map out of sight (another view, the board closed): the clock stops
    new IntersectionObserver((list) => { shown = list.some((x) => x.isIntersecting); sync(); }).observe(vp);
    new MutationObserver((list) => {
      if (list.some((m) => m.attributeName === 'data-theme')) worker.postMessage({ type: 'theme', cfg: themeCfg() });
      sync();
    }).observe(root, { attributes: true, attributeFilter: ['data-motion', 'data-theme'] });
    bindSpotlight();
    sync();
    return api;
  }
  // what the worker has done (frames drawn, lines wired), for the checks
  const stats = () => new Promise((resolve) => {
    if (!worker) { resolve({ frames: 0, running: false, paths: 0, spins: 0, failed }); return; }
    const on = (e) => { if (e.data && e.data.type === 'stats') { worker.removeEventListener('message', on); resolve(e.data); } };
    worker.addEventListener('message', on);
    worker.postMessage({ type: 'stats' });
  });
  const api = { attach, update, updateSoon, view, stats };
  window.CrewFx = api;
})();
