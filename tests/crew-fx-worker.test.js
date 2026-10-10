'use strict';

// The 队伍 map's moving light (crew-fx-worker.js): the parts that decide what is drawn, apart from the drawing.
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../crew-fx-worker');

// a path as the page hands it over: flat points [x0, y0, x1, y1, …], a colour, core = 队长's trunk and bus
const path = (pts, core, color = '#19e3ff') => ({ pts: pts.flat(), core: !!core, color });
const line = (a, b, step = 5) => { const out = []; const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); for (let i = 0; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]); return out; };
const run = (...corners) => corners.slice(1).reduce((acc, c, i) => acc.concat(line(corners[i], c).slice(i ? 1 : 0)), []);

test('the artery: every line knows how far down the wiring from 队长 it starts, and shared stretches are drawn once', () => {
  const trunk = path(run([0, 0], [0, 50]), true), arm = path(run([0, 50], [400, 50]), true);
  const one = path(run([100, 50], [100, 300])), two = path(run([100, 50], [100, 150], [160, 150])), three = path(run([300, 50], [300, 200]));
  // handed over in any order
  const maxD = W.wire([three, two, arm, one, trunk]);
  assert.equal(trunk.d0, 0);
  assert.ok(Math.abs(arm.d0 - 50) < 1);
  assert.ok(Math.abs(one.d0 - 150) < 1 && Math.abs(two.d0 - 150) < 1, 'both leave the bus 100 px from the hub');
  assert.ok(Math.abs(three.d0 - 350) < 1);
  assert.ok(Math.abs(maxD - 500) < 2, 'the farthest end: 350 + 150');
  // the two lines down one rail share their first 100 px: the longer one draws it, the other starts where it turns off
  // (a line's first few px lie on the bus it leaves, which is drawn already)
  assert.ok(one.from <= 8, `the first is its own from the bus (${one.from})`);
  assert.ok(two.from > 85 && two.from < 106, `the second starts where it leaves the first (${two.from})`);
  assert.ok(three.from <= 8);
});

test('a line whose start sits off the wiring still gets a distance: the nearest point plus the gap', () => {
  const trunk = path(run([0, 0], [0, 50]), true), stray = path(run([30, 80], [30, 180]));
  W.wire([trunk, stray]);
  assert.ok(stray.d0 > 50 && stray.d0 < 50 + 45);
});

test('the beat: a strong pulse and a weaker one just after it, every period, each in flight until it has crossed the farthest line', () => {
  const P = { period: 1.7, beats: [[0, 1], [0.24, 0.5]], speed: 380, tail: 210, landing: 140 };
  // reach: (500 + 210 + 140) / 380 s ≈ 2237 ms
  assert.deepEqual(W.beatsAt(1700 * 5 + 100, P, 500), [[6800, 1], [7040, 0.5], [8500, 1]]);
  assert.deepEqual(W.beatsAt(1700 * 5 + 300, P, 500).map(([te]) => te), [6800, 7040, 8500, 8740]);
  // nothing before the first beat of the clock
  assert.deepEqual(W.beatsAt(0, P, 500), [[0, 1]]);
});

test('meteors: one at a time or a shower of several, each with its own direction, angle, length and speed, the next at a random wait', () => {
  const M = { every: [2.5, 11], showerChance: 0.2, showerSize: [3, 6], dur: [0.6, 1.5], len: [220, 680], angleLeft: [118, 162], angleRight: [18, 62], colors: ['#9fc0ff'] };
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let showers = 0, singles = 0;
  for (let i = 0; i < 200; i++) {
    const { meteors, next } = W.meteorsFor(1000, M, 1440, 900, rnd);
    if (meteors.length > 1) showers++; else singles++;
    assert.ok(meteors.length === 1 || (meteors.length >= 3 && meteors.length <= 6));
    meteors.forEach((m, k) => {
      const deg = (Math.atan2(m.y1 - m.y0, m.x1 - m.x0) * 180) / Math.PI;
      assert.ok((deg >= 18 - 6 && deg <= 62 + 6) || (deg >= 118 - 6 && deg <= 162 + 6), `heading ${deg}`);
      const len = Math.hypot(m.x1 - m.x0, m.y1 - m.y0);
      assert.ok(len >= 219 && len <= 681);
      assert.ok(m.dur >= 600 && m.dur <= 1500);
      if (k) assert.ok(m.t0 > meteors[k - 1].t0, 'a shower comes one after another');
    });
    assert.ok(next >= meteors.at(-1).t0 + 2500 && next <= meteors.at(-1).t0 + 11000);
  }
  assert.ok(showers > 15 && showers < 70, `about one in five a shower (${showers} of 200)`);
});

test('stars wander: each stays near where it was set, on its own path, and never two the same', () => {
  const S = { density: 1 / 9000, bigShare: 0.13, small: [0.7, 1.3], big: [1.5, 2.3], colors: ['#ffffff'], alpha: [0.35, 0.95], twinkle: [0.08, 0.24], wander: { amp: [14, 60], period: [40, 150] } };
  const stars = W.makeStars(1440, 900, S, 11);
  assert.ok(stars.length > 100);
  for (const s of stars.slice(0, 50)) {
    for (const t of [0, 20000, 77777, 300000]) {
      const [x, y] = W.starAt(s, t);
      assert.ok(Math.abs(x - s.x) <= s.ax[0] + s.ax[1] + 1e-9 && Math.abs(y - s.y) <= s.ay[0] + s.ay[1] + 1e-9);
    }
  }
  const moves = stars.slice(0, 20).map((s) => { const [x0, y0] = W.starAt(s, 0), [x1, y1] = W.starAt(s, 10000); return [Math.round((x1 - x0) * 100), Math.round((y1 - y0) * 100)].join(','); });
  assert.equal(new Set(moves).size, moves.length, 'every star its own way');
  // a faint, uneven shimmer: never dimmer than (1 - its twinkle) of its brightness, never a full breath
  for (const s of stars.slice(0, 50)) for (let t = 0; t < 20000; t += 937) { const k = W.shimmer(s, t); assert.ok(k <= 1 + 1e-9 && k >= 1 - s.tw - 1e-9); }
});
