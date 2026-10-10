// The 队伍 map's moving light (3.1, 星河流光), drawn off the page's main thread. crew-fx.js lays two canvases into
// the map — the sky, fixed behind it, and the light layer, in the map's own coordinates over the cards — and hands
// both to this worker, which draws at most cfg.fps frames a second (the sky at cfg.skyFps, faster only while meteors
// cross). Nothing is drawn while the map is out of sight; the motion switch and prefers-reduced-motion leave one still
// frame.
// - Stars wander: each drifts on its own slow, irregular path (two sways of its own reach and period a axis), with
//   only a faint uneven shimmer; no breathing. A few bright glints flare at random moments.
// - Meteors come at random: one now and then, sometimes a shower of several within a second or two; direction,
//   angle, length, speed and brightness all random.
// - The artery: from 队长 a beat (a strong pulse and a weaker one just after it) pushes a wave of light out along
//   the trunk, the bus and every working line to each working card, every front at the same distance down the wiring
//   from 队长, so the wave spreads through the network; where it reaches a card, the card's stop flares. A stretch two
//   lines share is drawn once.
// - The spinner of a working card turns (slowly), a card that asks pings, 队长's hub rings with each beat.
// Why a worker: any CSS animation keeps Chrome compositing at the screen's rate (120 Hz on a ProMotion Mac), about
// 4% of the renderer before a single star moves, and the SVG ones (a line's stroke-dashoffset, a turning <svg> icon)
// cost a style recalculation, layout and paint on the main thread every frame (the map was at ~40%). Here the page's
// main thread and compositor stay idle; the worker draws ≤16 frames a second.
// Loaded in Node (tests), it only exports the parts that decide what is drawn.
(function (scope) {
  'use strict';
  const TAU = Math.PI * 2;
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  const lerp = (a, b, t) => a + (b - a) * t;
  const span = (r, [a, b]) => lerp(a, b, r());
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // ---- stars: where each one is set, its own way of drifting, its faint shimmer ----
  function makeStars(vw, vh, S, seed) {
    const r = rng(seed || 7), M = 80, out = [];
    const n = Math.round((vw + 2 * M) * (vh + 2 * M) * S.density);
    const ms = (p) => TAU / (p * 1000);   // a period in seconds as an angular speed per ms
    for (let i = 0; i < n; i++) {
      const big = r() < S.bigShare;
      out.push({
        x: r() * (vw + 2 * M) - M, y: r() * (vh + 2 * M) - M,
        size: big ? span(r, S.big) : span(r, S.small), big,
        color: S.colors[Math.floor(r() * S.colors.length)], base: span(r, S.alpha),
        ax: [span(r, S.wander.amp), span(r, S.wander.amp) * 0.5], ay: [span(r, S.wander.amp), span(r, S.wander.amp) * 0.5],
        wx: [ms(span(r, S.wander.period)), ms(span(r, S.wander.period) * 0.43)], wy: [ms(span(r, S.wander.period)), ms(span(r, S.wander.period) * 0.37)],
        px: [r() * TAU, r() * TAU], py: [r() * TAU, r() * TAU],
        tw: span(r, S.twinkle), wt: [ms(span(r, [2.1, 4.7])), ms(span(r, [5.3, 11]))], pt: [r() * TAU, r() * TAU],
      });
    }
    return out;
  }
  const starAt = (s, t) => [
    s.x + s.ax[0] * Math.sin(s.wx[0] * t + s.px[0]) + s.ax[1] * Math.sin(s.wx[1] * t + s.px[1]),
    s.y + s.ay[0] * Math.sin(s.wy[0] * t + s.py[0]) + s.ay[1] * Math.sin(s.wy[1] * t + s.py[1]),
  ];
  // 1 at most; at least 1 - tw (two incommensurate sways, never a full breath)
  const shimmer = (s, t) => 1 - s.tw * (0.5 - 0.3 * Math.sin(s.wt[0] * t + s.pt[0]) - 0.2 * Math.sin(s.wt[1] * t + s.pt[1]));

  // ---- meteors: the next event (one, or a shower of several), and when the one after it comes ----
  function meteorsFor(t, M, vw, vh, rnd) {
    const shower = rnd() < M.showerChance, n = shower ? Math.round(span(rnd, M.showerSize)) : 1;
    const right = rnd() < 0.5, base = right ? span(rnd, M.angleRight) : span(rnd, M.angleLeft), out = [];
    let delay = 0;
    for (let i = 0; i < n; i++) {
      const deg = shower ? base + (rnd() - 0.5) * 10 : base, a = (deg * Math.PI) / 180, len = span(rnd, M.len);
      const cx = lerp(0.06, 0.94, rnd()) * vw, cy = lerp(0.04, 0.62, rnd()) * vh;
      const x0 = cx - Math.cos(a) * len * 0.45, y0 = cy - Math.sin(a) * len * 0.45;
      out.push({ t0: t + delay, dur: span(rnd, M.dur) * 1000, x0, y0, x1: x0 + Math.cos(a) * len, y1: y0 + Math.sin(a) * len,
        tail: len * span(rnd, [0.28, 0.42]), width: span(rnd, [1.1, 2.1]), bright: span(rnd, [0.6, 1]), color: M.colors[Math.floor(rnd() * M.colors.length)] });
      if (shower && i < n - 1) delay += span(rnd, [90, 420]);
    }
    return { meteors: out, next: t + delay + span(rnd, M.every) * 1000 };
  }

  // ---- the artery: how far down the wiring from 队长 each line starts (d0) and from where on it is its own ----
  // paths: [{ pts: [x0, y0, …], core }] (core: 队长's trunk and bus). Sets cum, L, box, d0, from on each; returns the
  // farthest reach (the largest d0 + L).
  function wire(paths) {
    paths.forEach((p) => {
      const cum = [0];
      for (let i = 2; i < p.pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(p.pts[i] - p.pts[i - 2], p.pts[i + 1] - p.pts[i - 1]));
      p.cum = cum; p.L = cum[cum.length - 1];
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (let i = 0; i < p.pts.length; i += 2) { a = Math.min(a, p.pts[i]); c = Math.max(c, p.pts[i]); b = Math.min(b, p.pts[i + 1]); d = Math.max(d, p.pts[i + 1]); }
      p.box = [a, b, c, d]; p.d0 = null; p.from = 0;
    });
    // the trunk starts at 队长 (the highest start of the core lines); everything else hangs off what is placed already
    const cores = paths.filter((p) => p.core);
    const root = (cores.length ? cores : paths).slice().sort((p, q) => p.pts[1] - q.pts[1])[0];
    if (!root) return 0;
    root.d0 = 0;
    const near = (x, y, placed) => {
      let best = null;
      for (const q of placed) for (let i = 0; i < q.pts.length; i += 2) {
        const dd = Math.hypot(q.pts[i] - x, q.pts[i + 1] - y);
        if (!best || dd < best.dd) best = { dd, d: q.d0 + q.cum[i / 2] };
      }
      return best;
    };
    let left = paths.filter((p) => p !== root);
    for (let pass = 0; pass < 6 && left.length; pass++) {
      const placed = paths.filter((p) => p.d0 != null);
      left = left.filter((p) => { const b = near(p.pts[0], p.pts[1], placed); if (b && b.dd < 10) { p.d0 = b.d + b.dd; return false; } return true; });
    }
    // still unattached (a line whose start sits off the wiring): the nearest point anywhere, plus the gap
    left.forEach((p) => { const b = near(p.pts[0], p.pts[1], paths.filter((q) => q.d0 != null)); p.d0 = b ? b.d + b.dd : 0; });
    // stretches two lines share: a grid of what earlier lines cover; a later line is its own from where it leaves them
    const cell = 4, grid = new Set();
    const covered = (x, y) => { const gx = Math.round(x / cell), gy = Math.round(y / cell); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (grid.has((gx + i) + ',' + (gy + j))) return true; return false; };
    paths.slice().sort((p, q) => p.d0 - q.d0 || q.L - p.L).forEach((p) => {
      let k = 0;
      while (k < p.cum.length && covered(p.pts[k * 2], p.pts[k * 2 + 1])) k++;
      p.from = k >= p.cum.length ? p.L : p.cum[Math.max(0, k - 1)];
      for (let i = 0; i < p.pts.length; i += 2) grid.add(Math.round(p.pts[i] / cell) + ',' + Math.round(p.pts[i + 1] / cell));
    });
    return Math.max(0, ...paths.map((p) => p.d0 + p.L));
  }
  // the beats in flight at t (ms on the worker's clock, from 0): [emitted at, strength], oldest first
  function beatsAt(t, P, maxD) {
    const per = P.period * 1000, out = [], reach = ((maxD + P.tail + P.landing) / P.speed) * 1000;
    for (let k = Math.max(0, Math.floor((t - reach) / per)); k <= Math.floor(t / per); k++) {
      for (const [dt, a] of P.beats) { const te = k * per + dt * 1000; if (te >= 0 && te <= t && t - te <= reach) out.push([te, a]); }
    }
    return out;
  }

  const helpers = { makeStars, starAt, shimmer, meteorsFor, wire, beatsAt };
  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  // ======================= the worker =======================
  let cfg = null;
  let sky = null, sg = null, lay = null, lg = null;
  let vw = 0, vh = 0, sdpr = 1;
  let geo = { w: 0, h: 0, scale: 1, paths: [], spins: [], pings: [], hub: null };
  let stars = [], glints = [], meteors = [], nextShower = 0, maxD = 0;
  let running = false, timer = 0, lastSky = -1e9, dirty = [], slowDirty = [], tick = 0, view = null, frames = 0;
  const sprites = new Map();
  const now = () => performance.now();
  // on screen? (a box in light-layer coordinates against the part of the map the window shows, with a margin)
  const seen = (x0, y0, x1, y1) => !view || (x1 > view[0] - 60 && x0 < view[0] + view[2] + 60 && y1 > view[1] - 60 && y0 < view[1] + view[3] + 60);
  function rgba(hex, a) {
    const h = String(hex).replace('#', ''), n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  // a soft round light: white core, the colour round it, fading out (drawn once per colour and size)
  function glow(color, size, core) {
    const key = color + size + (core || 0);
    if (sprites.has(key)) return sprites.get(key);
    const c = new OffscreenCanvas(size, size), g = c.getContext('2d'), r = size / 2;
    const gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, cfg.light ? rgba(color, 1) : 'rgba(255,255,255,1)');
    gr.addColorStop(core || 0.12, cfg.light ? rgba(color, 0.95) : 'rgba(255,255,255,.95)');
    gr.addColorStop(Math.min(0.9, (core || 0.12) + 0.16), rgba(color, 0.75));
    gr.addColorStop(0.55, rgba(color, 0.18));
    gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, size, size);
    sprites.set(key, c);
    return c;
  }

  // ---------------- the sky ----------------
  function makeSky() {
    const S = cfg.sky;
    stars = makeStars(vw, vh, S, cfg.seed);
    const r = rng((cfg.seed || 7) * 13 + 1);
    glints = [];
    for (let i = 0; i < S.glints; i++) glints.push({ x: lerp(0.05, 0.95, r()) * vw, y: lerp(0.04, 0.8, r()) * vh, size: lerp(18, 30, r()), color: S.glintColor, next: now() + span(Math.random, S.glint) * 1000 });
  }
  function drawSky(t, still) {
    if (!sg) return;
    sg.setTransform(sdpr, 0, 0, sdpr, 0, 0);
    sg.clearRect(0, 0, vw, vh);
    if (cfg.light) return;   // a light page has no night sky
    sg.globalCompositeOperation = 'lighter';
    const S = cfg.sky;
    for (const s of stars) {
      const [x, y] = still ? [s.x, s.y] : starAt(s, t);
      if (x < -12 || y < -12 || x > vw + 12 || y > vh + 12) continue;
      const a = s.base * (still ? 1 : shimmer(s, t)), d = s.size * (s.big ? 7 : 5);
      sg.globalAlpha = a;
      sg.drawImage(glow(s.color, 32, s.big ? 0.1 : 0.16), x - d / 2, y - d / 2, d, d);
      if (s.big && S.spikes) {
        const L = s.size * 4.5, w = 0.8;
        sg.globalAlpha = a * 0.35;
        sg.fillStyle = rgba(s.color, 1);
        sg.fillRect(x - L, y - w / 2, L * 2, w);
        sg.fillRect(x - w / 2, y - L, w, L * 2);
      }
    }
    if (!still) {
      for (const g of glints) {
        // a four-point flare at a random moment: up in ~0.35 s, down in ~0.6 s, then a random wait
        const p = t - g.next;
        if (p < 0) continue;
        if (p > 950) { g.next = t + span(Math.random, S.glint) * 1000; continue; }
        const k = p < 350 ? smooth(0, 350, p) : 1 - smooth(350, 950, p), L = g.size * (0.4 + 0.6 * k);
        sg.save();
        sg.translate(g.x, g.y); sg.rotate((p / 950) * 0.6);
        sg.globalAlpha = k;
        const bar = (len, wid) => { const gr = sg.createLinearGradient(-len, 0, len, 0); gr.addColorStop(0, rgba(g.color, 0)); gr.addColorStop(0.5, 'rgba(255,255,255,1)'); gr.addColorStop(1, rgba(g.color, 0)); sg.fillStyle = gr; sg.fillRect(-len, -wid / 2, len * 2, wid); };
        bar(L, 1.3); sg.rotate(Math.PI / 2); bar(L, 1.3);
        sg.drawImage(glow(g.color, 24, 0.14), -6, -6, 12, 12);
        sg.restore();
      }
      meteors = meteors.filter((m) => t - m.t0 < m.dur);
      for (const m of meteors) {
        const u = (t - m.t0) / m.dur;
        if (u < 0) continue;
        const e = 1 - Math.pow(1 - u, 1.5), hx = lerp(m.x0, m.x1, e), hy = lerp(m.y0, m.y1, e);
        const ang = Math.atan2(m.y1 - m.y0, m.x1 - m.x0), tl = m.tail * (0.3 + 0.7 * Math.min(1, u * 3));
        const tx = hx - Math.cos(ang) * tl, ty = hy - Math.sin(ang) * tl;
        const fade = Math.min(1, u * 6) * (1 - smooth(0.68, 1, u)) * m.bright;
        const gr = sg.createLinearGradient(tx, ty, hx, hy);
        gr.addColorStop(0, rgba(m.color, 0)); gr.addColorStop(0.72, rgba(m.color, 0.45 * fade)); gr.addColorStop(1, `rgba(255,255,255,${(0.95 * fade).toFixed(3)})`);
        sg.globalAlpha = 1; sg.strokeStyle = gr; sg.lineCap = 'round';
        sg.lineWidth = m.width; sg.beginPath(); sg.moveTo(tx, ty); sg.lineTo(hx, hy); sg.stroke();
        sg.lineWidth = m.width * 3.2; sg.globalAlpha = 0.22; sg.stroke();
        sg.globalAlpha = fade;
        sg.drawImage(glow(m.color, 32, 0.12), hx - 8, hy - 8, 16, 16);
      }
    }
    sg.globalAlpha = 1;
    sg.globalCompositeOperation = 'source-over';
  }

  // ---------------- the light layer (map coordinates) ----------------
  function at(p, s) {
    const cum = p.cum, pts = p.pts;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const seg = cum[hi] - cum[lo] || 1, k = (s - cum[lo]) / seg;
    return [lerp(pts[lo * 2], pts[hi * 2], k), lerp(pts[lo * 2 + 1], pts[hi * 2 + 1], k)];
  }
  function stretch(p, s0, s1, step) {
    const out = [];
    for (let s = Math.max(0, s0); s < s1; s += step) { const q = at(p, s); out.push(q[0], q[1]); }
    const q = at(p, s1); out.push(q[0], q[1]);
    return out;
  }
  function strokePts(g, pts) { g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.stroke(); }
  function mark(x0, y0, x1, y1, pad) { dirty.push([Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.abs(x1 - x0) + pad * 2, Math.abs(y1 - y0) + pad * 2]); }
  function markPts(pts, pad) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let i = 0; i < pts.length; i += 2) { a = Math.min(a, pts[i]); c = Math.max(c, pts[i]); b = Math.min(b, pts[i + 1]); d = Math.max(d, pts[i + 1]); }
    mark(a, b, c, d, pad);
  }
  function drawPulses(t) {
    const P = cfg.pulse, white = cfg.light ? null : 'rgba(255,255,255,';
    for (const [te, a0] of beatsAt(t, P, maxD)) {
      const d = ((t - te) / 1000) * P.speed, a = a0 * (1 - P.fade * Math.min(1, d / Math.max(600, maxD)));
      for (const p of geo.paths) {
        if (!seen(...p.box)) continue;
        const s = d - p.d0;
        // the wave reaching the end of a line to a card: the card's stop flares as it lands
        if (!p.core && s > p.L && s < p.L + P.landing) {
          const u = (s - p.L) / P.landing, q = p.pts.slice(-2), r = lerp(3, 13, u);
          lg.globalAlpha = a * (1 - u) * 0.9;
          lg.drawImage(glow(p.color, 40, 0.1), q[0] - r * 1.6, q[1] - r * 1.6, r * 3.2, r * 3.2);
          mark(q[0], q[1], q[0], q[1], r * 1.6 + 2);
        }
        const s0 = Math.max(p.from, s - P.tail), s1 = Math.min(p.L, s);
        if (s1 <= s0 + 0.5) continue;
        const pts = stretch(p, s0, s1, P.step), head = at(p, s1), tail = at(p, s0);
        const front = s <= p.L, k0 = (s0 - (s - P.tail)) / P.tail;
        // the trail in the line's own colour, deepening towards the front, which is white-hot (on a dark page)
        const gr = lg.createLinearGradient(tail[0], tail[1], head[0], head[1]);
        gr.addColorStop(0, rgba(p.color, 0.6 * a * k0 * k0));
        gr.addColorStop(front && white ? 0.78 : 1, rgba(p.color, 0.95 * a));
        if (front && white) gr.addColorStop(1, white + a.toFixed(3) + ')');
        lg.strokeStyle = gr; lg.lineCap = 'round'; lg.lineJoin = 'round';
        lg.globalAlpha = P.glowAlpha; lg.lineWidth = P.glow; strokePts(lg, pts);
        lg.globalAlpha = 1; lg.lineWidth = P.width; strokePts(lg, pts);
        if (front) { lg.globalAlpha = a; lg.drawImage(glow(p.color, 40, 0.1), head[0] - P.head / 2, head[1] - P.head / 2, P.head, P.head); }
        markPts(pts, P.glow / 2 + P.head / 2 + 2);
      }
    }
  }
  function drawSpin(sp, t) {
    const S = cfg.spin, a = ((t + sp.off) / (S.period * 1000)) * TAU;
    lg.globalAlpha = 1; lg.strokeStyle = S.color; lg.lineWidth = S.width; lg.lineCap = 'round';
    lg.beginPath(); lg.arc(sp.x, sp.y, S.r, a, a + TAU * 0.72); lg.stroke();
    lg.globalAlpha = 0.28; lg.beginPath(); lg.arc(sp.x, sp.y, S.r, a + TAU * 0.72, a + TAU); lg.stroke();
    mark(sp.x, sp.y, sp.x, sp.y, S.r + S.width + 1);
  }
  function drawRing(p, u, color, r0, r1, alpha) {
    const r = lerp(r0, r1, smooth(0, 1, u));
    lg.globalAlpha = alpha * (1 - u); lg.strokeStyle = color; lg.lineWidth = 1.4;
    lg.beginPath(); lg.arc(p.x, p.y, r, 0, TAU); lg.stroke();
    mark(p.x, p.y, p.x, p.y, r1 + 2);
  }
  // Each frame clears only where it drew the last time; the pulses move every frame, the small marks (spinners,
  // pings) every other frame.
  function clear(list) {
    const k = geo.scale;
    for (const r of list) lg.clearRect(Math.floor(r[0] * k) - 1, Math.floor(r[1] * k) - 1, Math.ceil(r[2] * k) + 3, Math.ceil(r[3] * k) + 3);
  }
  const hits = (list, p) => list.some((r) => p.x + 9 > r[0] && p.x - 9 < r[0] + r[2] && p.y + 9 > r[1] && p.y - 9 < r[1] + r[3]);
  function drawLayer(t) {
    if (!lg) return;
    const k = geo.scale, slow = tick++ % 2 === 0;
    lg.setTransform(1, 0, 0, 1, 0, 0);
    clear(dirty); dirty = [];
    if (slow) { clear(slowDirty); slowDirty = []; }
    lg.setTransform(k, 0, 0, k, 0, 0);
    lg.globalCompositeOperation = cfg.light ? 'source-over' : 'lighter';
    if (geo.paths.length) {
      drawPulses(t);
      // 队长's hub rings with every beat
      if (geo.hub) { const per = cfg.pulse.period * 1000; for (const [dt, a] of cfg.pulse.beats) { const u = ((((t - dt * 1000) % per) + per) % per) / 900; if (u < 1) drawRing(geo.hub, u, cfg.hubColor, 8, 28, 0.75 * a); } }
    }
    lg.globalCompositeOperation = 'source-over';
    if (slow) {
      const fast = dirty; dirty = slowDirty;
      for (const s of geo.spins) if (seen(s.x, s.y, s.x, s.y)) drawSpin(s, t);
      for (const p of geo.pings) if (seen(p.x, p.y, p.x, p.y)) drawRing(p, (t % 1800) / 1800, cfg.pingColor, 4, 12, 0.6);
      slowDirty = dirty; dirty = fast;
    } else {
      // what the pulses cleared this frame may have cut into a spinner: draw it again where it stands
      const fast = dirty; dirty = [];
      for (const s of geo.spins) if (hits(fast, s)) drawSpin(s, t - 1000 / cfg.fps);
      dirty = fast;
    }
    lg.globalAlpha = 1;
  }

  // ---------------- the clock ----------------
  function frame() {
    timer = 0;
    if (!running) return;
    const t = now();
    frames++;
    drawLayer(t);
    if (!cfg.light && t >= nextShower) { const ev = meteorsFor(t, cfg.meteor, vw, vh, Math.random); meteors.push(...ev.meteors); nextShower = ev.next; }
    if (meteors.length || t - lastSky >= 1000 / cfg.skyFps - 4) { drawSky(t); lastSky = t; }
    timer = setTimeout(frame, Math.max(4, 1000 / cfg.fps - (now() - t)));
  }
  function start() { if (running) return; running = true; lastSky = -1e9; frame(); }
  function stop() { running = false; clearTimeout(timer); timer = 0; }
  // the motion switch off, or reduced motion: one still frame (the stars where they rest, no pulses, spinners at rest)
  function still() {
    stop();
    meteors = [];
    drawSky(0, true);
    if (lg) {
      lg.setTransform(1, 0, 0, 1, 0, 0); lg.clearRect(0, 0, lay.width, lay.height); dirty = []; slowDirty = [];
      lg.setTransform(geo.scale, 0, 0, geo.scale, 0, 0);
      for (const s of geo.spins) drawSpin(s, 0);
    }
  }

  scope.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') {
      cfg = m.cfg; sky = m.sky; lay = m.layer;
      sg = sky.getContext('2d'); lg = lay.getContext('2d');
      nextShower = now() + span(Math.random, [1.2, 3.5]) * 1000;
    } else if (m.type === 'theme') {
      // the page turned light or dark: the colours change, the sprites with them
      Object.assign(cfg, m.cfg); sprites.clear(); lastSky = -1e9;
      if (!running) still();
    } else if (m.type === 'sky') {
      vw = m.w; vh = m.h; sdpr = m.dpr;
      sky.width = Math.max(1, Math.round(vw * sdpr)); sky.height = Math.max(1, Math.round(vh * sdpr));
      makeSky(); lastSky = -1e9;
      if (!running && m.still) still();
    } else if (m.type === 'geo') {
      geo = m.geo;
      maxD = wire(geo.paths);
      lay.width = Math.max(1, Math.round(geo.w * geo.scale)); lay.height = Math.max(1, Math.round(geo.h * geo.scale));
      dirty = []; slowDirty = [];
      if (!running && m.still) still();
    } else if (m.type === 'run') {
      if (m.run) start(); else if (m.still) still(); else stop();
    } else if (m.type === 'view') {
      // the map was panned or zoomed: clear what was drawn, then draw only what shows
      view = m.rect;
      if (lg) { lg.setTransform(1, 0, 0, 1, 0, 0); lg.clearRect(0, 0, lay.width, lay.height); dirty = []; slowDirty = []; tick = 0; if (!running && m.still) still(); }
    } else if (m.type === 'stats') {
      scope.postMessage({ type: 'stats', frames, running, paths: geo.paths.length, spins: geo.spins.length, maxD: Math.round(maxD) });
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);
