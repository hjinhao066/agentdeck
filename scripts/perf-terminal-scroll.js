#!/usr/bin/env node
'use strict';

// Measure how a deck of busy terminals feels: an isolated AgentDeck (--test-user-data, its
// window never takes the focus) opens N columns of the flood stand-in, each printing
// thousands of lines and then ticking a status line like a working agent. Then it times,
// from the input event to the frame that shows it: wheel scrolling and Shift+PageUp in one
// terminal, paging the deck sideways, switching terminals from the sidebar, and moving the
// mouse over terminal rows; with frame gaps and main/renderer CPU for each.
//   node scripts/perf-terminal-scroll.js [--app <source dir>] [--cols 12] [--lines 30000]
//     [--view term|chat] [--layout crew|deck] [--profile <dir>] [--out <file.json>]
// --layout crew (default): one 队长 column and the rest its background sessions, opened from the
// sidebar one at a time; --layout deck: every column side by side in the deck.
// --replica <userData dir>: instead of the flood columns, a copy of a real profile's layout,
// conversations and saved terminal output (sessions/) in a throw-away profile, every command
// replaced by the Claude-like stand-in (--working N of them working, the rest idle) and
// everything that reaches outside switched off (seats, notifications, Bark, phone page,
// schedules, warm-up, relay, shortcut). Nothing of the copy is printed or kept.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const appDir = path.resolve(arg('app', path.join(__dirname, '..')));
const COLS = Number(arg('cols', 12));
const LINES = Number(arg('lines', 30000));
const VIEW = arg('view', 'term');
const LAYOUT = arg('layout', 'crew');
const profileDir = arg('profile', '');
const REPLICA = arg('replica', '');
const WORKING = Number(arg('working', 11));
const out = arg('out', '');
const say = (message) => console.log(`[perf] ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agent = path.join(__dirname, '..', 'tests', 'e2e', 'fixtures', 'flood-agent.js');

const pct = (list, p) => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
const sum = (list) => list.reduce((a, b) => a + b, 0);
function frameStats(frames) {
  const gaps = frames.slice(1).map((t, i) => t - frames[i]);
  // frames a 60 Hz display should have shown but did not
  const dropped = sum(gaps.map((g) => Math.max(0, Math.round(g / 16.7) - 1)));
  return { frames: frames.length, gapP50: pct(gaps, 0.5), gapP95: pct(gaps, 0.95), gapMax: gaps.length ? +Math.max(...gaps).toFixed(1) : null, longFrames: gaps.filter((g) => g > 50).length, dropped };
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-perf-scroll-'));
  const cmd = `node "${agent}"`;
  if (REPLICA) writeReplica(REPLICA, profile);
  else fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    perpetualCaptain: { enabled: false }, theme: 'dark', fitWindow: true, fitCols: 3, globalViewMode: VIEW, crewOpen: true,
    columns: Array.from({ length: COLS }, (_, i) => ({ id: `flood-${i}`, title: `Flood ${i + 1}`, cmd, cwd: profile, role: 'manual', view: VIEW,
      ...(LAYOUT === 'crew' ? (i ? { captainCrew: true } : { isMain: true }) : {}) })),
    ...(LAYOUT === 'crew' ? { mainSession: { colId: 'flood-0', cmd, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [], tasks: [] } } : {}),
  }));
  const ncols = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8')).columns.length;
  const env = { ...process.env, FLOOD_LINES: String(LINES) };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (k.startsWith('AGENTDECK_')) delete env[k];
  const app = await electron.launch({ args: [appDir, `--test-user-data=${profile}`], env, cwd: appDir });
  const result = { app: appDir, cols: ncols, lines: LINES, view: VIEW, layout: REPLICA ? 'replica' : LAYOUT, working: REPLICA ? WORKING : undefined, platform: process.platform, cpus: os.cpus().length, load: os.loadavg()[0] };
  try {
    const page = await app.firstWindow();
    await page.waitForFunction((n) => typeof terms !== 'undefined' && terms.size === n, ncols, { timeout: 60000 });
    const metrics = () => app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, cpu: m.cpu.percentCPUUsage, idle: m.cpu.idleWakeupsPerSecond })));
    // percentCPUUsage covers the time since the previous call: call once to open a window.
    const cpuWindow = async (fn) => {
      await metrics();
      const t0 = Date.now();
      const extra = await fn();
      const m = await metrics();
      const by = (t) => +sum(m.filter((x) => x.type === t).map((x) => x.cpu)).toFixed(1);
      return { ms: Date.now() - t0, cpuMain: by('Browser'), cpuRenderer: by('Tab'), cpuGpu: by('GPU'), ...extra };
    };
    await page.evaluate(() => {
      const P = window.__perf = { frames: [], on: false, ipc: 0, ipcBytes: 0, renders: new Map() };
      const loop = (t) => { if (P.on) P.frames.push(t); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      const write = window.writePtyData;
      P.writes = null; P.resizes = 0;
      window.writePtyData = function (id, t, data, at) { P.ipc++; P.ipcBytes += data.length; if (P.writes) P.writes.push([performance.now(), id, data.length]); return write.apply(this, arguments); };
      P.hook = (id) => {
        const t = terms.get(id);
        if (t.__perfHooked) return;
        t.__perfHooked = true;
        t.term.onRender(() => { const l = P.renders.get(id) || []; l.push(performance.now()); P.renders.set(id, l); });
        t.term.onResize(() => { P.resizes++; });
      };
      terms.forEach((_, id) => P.hook(id));
    });
    // 1) Flood: every column prints LINES lines at once (replica: start-up until the replays
    //    and transcripts are in, then 5 s).
    if (REPLICA) result.startup = await cpuWindow(async () => {
      await page.evaluate(() => { __perf.ipc = 0; __perf.ipcBytes = 0; });
      await page.waitForFunction(() => [...terms.values()].every((t) => !t.pendingPtyData && t.term.buffer.active.type === 'alternate'), null, { timeout: 120000, polling: 250 });
      await sleep(5000);
      return page.evaluate(() => ({ ipc: __perf.ipc, ipcBytes: __perf.ipcBytes }));
    });
    else result.flood = await cpuWindow(async () => {
      await page.evaluate(() => { __perf.ipc = 0; __perf.ipcBytes = 0; });
      const t0 = Date.now();
      await page.waitForFunction(() => [...terms.values()].every((t) => {
        const b = t.term.buffer.active;
        for (let y = b.length - 1; y >= Math.max(0, b.length - t.term.rows - 2); y--) if ((b.getLine(y)?.translateToString(true) || '').includes('FLOOD_DONE')) return true;
        return false;
      }), null, { timeout: 600000, polling: 250 });
      const ipc = await page.evaluate(() => ({ ipc: __perf.ipc, ipcBytes: __perf.ipcBytes }));
      return { drainMs: Date.now() - t0, ...ipc };
    });
    say(`start ${JSON.stringify(result.flood || result.startup)}`);
    if (VIEW !== 'term') await page.evaluate(() => terms.forEach((_, id) => ChatUI.setMode(id, 'term')));
    await sleep(1500);
    // 2) Steady: every column is "working" (status line ticks), nobody touches anything.
    result.steady = await cpuWindow(async () => {
      await page.evaluate(() => { __perf.frames = []; __perf.ipc = 0; __perf.on = true; });
      await sleep(5000);
      const r = await page.evaluate(() => { __perf.on = false; return { frames: __perf.frames, ipc: __perf.ipc }; });
      return { ...frameStats(r.frames), ipcPerSec: Math.round(r.ipc / 5) };
    });
    say(`steady ${JSON.stringify(result.steady)}`);

    const ids = await page.evaluate(() => ({ all: columns.map((c) => c.id), deck: deckColumns().map((c) => c.id), crew: columns.filter((c) => c.captainCrew && !c.isMain).map((c) => c.id) }));
    const first = ids.deck[0];
    const targets = (ids.crew.length ? ids.crew : ids.all.slice(1));
    const picks = [7, 2, 10, 5, 11, 0].map((n) => n === 0 ? first : targets[n % targets.length]);
    const termBox = async (id) => page.locator(`.column[data-col-id="${id}"] .xterm-screen`).boundingBox();
    // Time from each input event (its own timestamp, so main-thread queueing counts) to
    // the render of the terminal it was aimed at.
    const timedInputs = async (id, count, send, gapMs) => {
      await page.evaluate((id) => {
        __perf.inputs = []; __perf.frames = []; __perf.renders.set(id, []); __perf.on = true;
        const rec = (e) => { if (e.type === 'wheel' || /^Page/.test(e.key)) __perf.inputs.push(e.timeStamp); };
        __perf.rec = rec;
        document.addEventListener('wheel', rec, { capture: true, passive: true });
        document.addEventListener('keydown', rec, { capture: true });
      }, id);
      for (let i = 0; i < count; i++) { await send(i); await sleep(gapMs); }
      await sleep(600);
      const r = await page.evaluate((id) => {
        __perf.on = false;
        document.removeEventListener('wheel', __perf.rec, { capture: true });
        document.removeEventListener('keydown', __perf.rec, { capture: true });
        return { inputs: __perf.inputs, renders: __perf.renders.get(id) || [], frames: __perf.frames };
      }, id);
      const lat = r.inputs.map((t, i) => {
        const next = r.renders.find((x) => x >= t);
        const limit = r.inputs[i + 1] ?? Infinity;
        return next !== undefined && next < limit + 2000 ? next - t : null;
      });
      const got = lat.filter((x) => x !== null);
      return { events: r.inputs.length, painted: got.length, latP50: pct(got, 0.5), latP95: pct(got, 0.95), latMax: got.length ? +Math.max(...got).toFixed(1) : null, ...frameStats(r.frames) };
    };
    await page.evaluate((id) => jumpToColumn(columns.find((c) => c.id === id)), first);
    await sleep(800);
    let box = await termBox(first);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // 3) Wheel scrolling up through the scrollback, other columns still working.
    if (profileDir) await startProfile(page);
    result.wheel = await cpuWindow(() => timedInputs(first, 60, () => page.mouse.wheel(0, -120), 16));
    if (profileDir) await stopProfile(page, path.join(profileDir, 'wheel.cpuprofile'));
    say(`wheel ${JSON.stringify(result.wheel)}`);
    // 3b) Wheel in a terminal whose program took the mouse (a full-screen agent such as
    //     Claude Code 2.1): each tick goes to the program, which scrolls and redraws. Time
    //     from the wheel event to the frame that shows the new position (row 1 "VIEW_TOP n"),
    //     once with nothing else going on and once while AgentDeck types an automatic
    //     delivery into that terminal (guardUserInput, as receipts and 队长 tasks do).
    const wheelLog = () => { const f = path.join(profile, 'wheel-' + first + '.log'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => / wheel$/.test(l)).length : 0; };
    const appWheel = async (duringSend) => cpuWindow(async () => {
      await page.waitForFunction((id) => !terms.get(id).injecting && !userComposing(id), first, { timeout: 60000, polling: 100 });
      const received0 = wheelLog();
      await page.evaluate(([id, duringSend]) => {
        const t = terms.get(id), P = __perf;
        const topOf = () => { const m = /VIEW_TOP (\d+)/.exec(t.term.buffer.active.getLine(t.term.buffer.active.viewportY)?.translateToString(true) || ''); return m ? +m[1] : null; };
        P.tops = [[performance.now(), topOf()]]; P.wheels = []; P.frames = []; P.on = true; P.held = 0; P.holdMs = 0;
        if (!t.__topHooked) { t.__topHooked = true; t.term.onRender(() => { if (!P.tops) return; const v = topOf(); if (v !== P.tops[P.tops.length - 1][1]) P.tops.push([performance.now(), v]); }); }
        P.wrec = (e) => P.wheels.push(e.timeStamp);
        document.addEventListener('wheel', P.wrec, { capture: true, passive: true });
        if (duringSend) {
          const t0 = performance.now();
          P.send = Promise.resolve(ChatUI.sendPrompt(columns.find((c) => c.id === id), 'perf probe delivery', null, { silent: true, guardUserInput: true })).then(() => { P.holdMs = performance.now() - t0; });
        }
      }, [first, duringSend]);
      for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, -120); await sleep(50); }
      await sleep(duringSend ? 3500 : 1500);
      const r = await page.evaluate(() => { __perf.on = false; document.removeEventListener('wheel', __perf.wrec, { capture: true }); const x = { tops: __perf.tops, wheels: __perf.wheels, frames: __perf.frames, holdMs: __perf.holdMs }; __perf.tops = null; return x; });
      const top0 = r.tops[0][1];
      const lat = r.wheels.map((t, i) => { const want = Math.max(1, top0 - 3 * (i + 1)); const hit = r.tops.find(([at, v]) => at >= t && v !== null && v <= want); return hit ? hit[0] - t : null; });
      const got = lat.filter((x) => x !== null);
      return { mouseMode: top0 !== null, events: r.wheels.length, agentReceived: wheelLog() - received0, answered: got.length, latP50: pct(got, 0.5), latP95: pct(got, 0.95), latMax: got.length ? +Math.max(...got).toFixed(1) : null,
        ...(duringSend ? { sendHoldMs: Math.round(r.holdMs) } : {}), ...frameStats(r.frames) };
    });
    if (REPLICA) {
      result.appWheel = await appWheel(false);
      say(`appWheel ${JSON.stringify(result.appWheel)}`);
      result.appWheelDuringSend = await appWheel(true);
      say(`appWheelDuringSend ${JSON.stringify(result.appWheelDuringSend)}`);
    }
    // 4) Shift+PageUp / PageDown paging.
    result.page = await cpuWindow(() => timedInputs(first, 30, (i) => page.keyboard.press(i < 20 ? 'Shift+PageUp' : 'Shift+PageDown'), 60));
    say(`page ${JSON.stringify(result.page)}`);
    // 5) Paging the deck sideways (two-finger swipe): time to the first render of every
    //    terminal that came into view.
    const flips = [];
    if (profileDir) await startProfile(page);
    result.deck = await cpuWindow(async () => {
      await page.evaluate(() => { __perf.frames = []; __perf.on = true; });
      const deck = await page.locator('#deck').boundingBox();
      for (let i = 0; i < 8; i++) {
        const dir = i < 4 ? 1 : -1;
        const r = await page.evaluate(async (dir) => {
          const before = new Set(deckColumns().map((c) => c.id).filter((id) => { const r = terms.get(id).wrap.getBoundingClientRect(), d = deckEl.getBoundingClientRect(); return r.right > d.left + 4 && r.left < d.right - 4; }));
          terms.forEach((_, id) => __perf.renders.set(id, []));
          const t0 = performance.now();
          deckEl.dispatchEvent(new WheelEvent('wheel', { deltaX: dir * deckEl.clientWidth, deltaY: 0, bubbles: true, cancelable: true }));
          await new Promise((res) => setTimeout(res, 1200));
          const d = deckEl.getBoundingClientRect();
          const shown = deckColumns().map((c) => c.id).filter((id) => { const r = terms.get(id).wrap.getBoundingClientRect(); return r.right > d.left + 4 && r.left < d.right - 4; }).filter((id) => !before.has(id));
          const firsts = shown.map((id) => (__perf.renders.get(id) || []).find((x) => x >= t0)).map((x) => x === undefined ? null : x - t0);
          return { shown: shown.length, firsts };
        }, dir);
        flips.push(r);
      }
      await page.evaluate(() => { __perf.on = false; });
      const all = flips.flatMap((f) => f.firsts).filter((x) => x !== null);
      const frames = await page.evaluate(() => __perf.frames);
      return { flips: flips.length, revealed: sum(flips.map((f) => f.shown)), painted: all.length, latP50: pct(all, 0.5), latP95: pct(all, 0.95), latMax: all.length ? +Math.max(...all).toFixed(1) : null, ...frameStats(frames) };
    });
    if (profileDir) await stopProfile(page, path.join(profileDir, 'deck.cpuprofile'));
    say(`deck ${JSON.stringify(result.deck)}`);
    // 6) Switching terminals from the sidebar: click a row; time to the target's first render,
    //    terminals resized by the switch, bytes the agents printed again because of it, and
    //    time until the target is quiet again (its ticking status line aside): "loaded".
    result.switch = await cpuWindow(async () => {
      const each = [];
      await page.evaluate(() => { __perf.frames = []; __perf.on = true; });
      for (const id of picks) {
        const row = page.locator(`.colnav-item[data-col-id="${id}"]`).first();
        if (!(await row.count())) continue;
        await page.evaluate((id) => {
          __perf.renders.set(id, []); __perf.writes = []; __perf.resizes = 0;
          document.addEventListener('mousedown', (e) => { __perf.clickAt = e.timeStamp; }, { capture: true, once: true });
        }, id);
        await row.click();
        // settle: no write over 200 bytes to any terminal for 1.5 s (or 30 s at most)
        const t0 = Date.now();
        while (Date.now() - t0 < 30000) {
          await sleep(250);
          const quiet = await page.evaluate(() => { const w = __perf.writes.filter((x) => x[2] > 200); return !w.length ? performance.now() - __perf.clickAt : performance.now() - w[w.length - 1][0]; });
          if (quiet > 1500) break;
        }
        each.push(await page.evaluate((id) => {
          const c = __perf.clickAt, big = __perf.writes.filter((x) => x[2] > 200);
          const mine = big.filter((x) => x[1] === id);
          const r = (__perf.renders.get(id) || []).find((x) => x >= c);
          return { firstPaint: r === undefined ? null : r - c, resizes: __perf.resizes, reprintKB: Math.round(big.reduce((a, x) => a + x[2], 0) / 1024),
            loaded: mine.length ? mine[mine.length - 1][0] - c : (r === undefined ? null : r - c) };
        }, id));
        await page.evaluate(() => { __perf.writes = null; });
      }
      await page.evaluate(() => { __perf.on = false; });
      const f = (k) => each.map((e) => e[k]).filter((x) => x !== null);
      return { switches: each.length, firstPaintP50: pct(f('firstPaint'), 0.5), firstPaintMax: f('firstPaint').length ? +Math.max(...f('firstPaint')).toFixed(1) : null,
        loadedP50: pct(f('loaded'), 0.5), loadedMax: f('loaded').length ? +Math.max(...f('loaded')).toFixed(1) : null,
        resizesPerSwitch: +(sum(f('resizes')) / Math.max(1, each.length)).toFixed(1), reprintKBPerSwitch: Math.round(sum(f('reprintKB')) / Math.max(1, each.length)),
        ...frameStats(await page.evaluate(() => __perf.frames)) };
    });
    say(`switch ${JSON.stringify(result.switch)}`);
    // 7) Hover: sweep the mouse over a scrolled-back terminal (link lookup on every row).
    await page.evaluate((id) => jumpToColumn(columns.find((c) => c.id === id)), first);
    await sleep(800);
    box = await termBox(first);
    await page.evaluate((id) => terms.get(id).term.scrollLines(-2000), first);
    result.hover = await cpuWindow(async () => {
      await page.evaluate(() => { __perf.frames = []; __perf.on = true; __perf.moves = []; __perf.mrec = (e) => __perf.moves.push(performance.now() - e.timeStamp); document.addEventListener('mousemove', __perf.mrec, true); });
      for (let i = 0; i < 80; i++) await page.mouse.move(box.x + 20 + (i % 10) * 30, box.y + 10 + (i * 37) % Math.max(20, box.height - 20));
      await sleep(300);
      const r = await page.evaluate(() => { __perf.on = false; document.removeEventListener('mousemove', __perf.mrec, true); return { frames: __perf.frames, moves: __perf.moves }; });
      return { moves: r.moves.length, queueP95: pct(r.moves, 0.95), ...frameStats(r.frames) };
    });
    say(`hover ${JSON.stringify(result.hover)}`);
    result.psCpu = await psCpu(app, 5000);
    say(`ps ${JSON.stringify(result.psCpu)}`);
    result.memory = await app.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.type === 'Tab' || m.type === 'Browser').map((m) => ({ type: m.type, workingSetMB: Math.round(m.memory.workingSetSize / 1024) })));
  } finally {
    await app.evaluate(({ app }) => { setImmediate(() => app.quit()); }).catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
  say(JSON.stringify(result));
}

// CPU as `ps` shows it (percent of one core), averaged over ms, idle hands
async function psCpu(app, ms) {
  const pids = await app.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.type === 'Browser' || m.type === 'Tab').map((m) => [m.type, m.pid]));
  const read = () => Object.fromEntries(pids.map(([type, pid]) => {
    try { return [type, require('node:child_process').execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' }).trim()]; } catch (_) { return [type, null]; }
  }));
  const secs = (t) => { if (!t) return 0; const p = t.split(':').map(Number); return p.reduce((a, x) => a * 60 + x, 0); };
  const a = read(); await sleep(ms); const b = read();
  return Object.fromEntries(Object.keys(a).map((k) => [k === 'Browser' ? 'main%' : 'renderer%', Math.round((secs(b[k]) - secs(a[k])) / (ms / 1000) * 100)]));
}

// A throw-away copy of a real profile: layout, conversations and saved output only.
function writeReplica(src, profile) {
  const cfg = JSON.parse(fs.readFileSync(path.join(src, 'config.json'), 'utf8'));
  const keep = ['theme', 'fitWindow', 'fitCols', 'navWidth', 'navCollapsed', 'fontSize', 'columns', 'links', 'boardResponses', 'boardPositions', 'globalViewMode', 'folders', 'archived',
    'navArchivedOpen', 'crewOpen', 'crewModelsCollapsed', 'artifactsCollapsed', 'sidebarFontSize', 'quotas', 'calmMotion', 'releaseNotesSeen', 'mainSession', 'captainHistory',
    'attention', 'taskBoardView', 'chatDeliverables', 'side', 'crewMap'];
  const out = Object.fromEntries(keep.filter((k) => k in cfg).map((k) => [k, cfg[k]]));
  Object.assign(out, { activeView: 'terminals', resumeOnRestart: false, perpetualCaptain: { enabled: false }, quotaWarmup: { enabled: false }, captainNotifications: { enabled: false } });
  let w = 0;
  const main = cfg.mainSession?.colId;
  out.columns = (cfg.columns || []).map((c) => {
    const busy = c.id === main || w++ < WORKING - 1;
    const { seatId, configDir, ...rest } = c;
    return { ...rest, cwd: profile, cmd: `CLAUDE_LIKE_WORK=${busy ? 1 : 0} CLAUDE_LIKE_LOG="${path.join(profile, 'wheel-' + c.id + '.log')}" node "${path.join(__dirname, '..', 'tests', 'e2e', 'fixtures', 'claude-like-agent.js')}"` };
  });
  if (out.mainSession) out.mainSession = { ...out.mainSession, cmd: out.columns.find((c) => c.id === main)?.cmd, pending: [], inflight: [], waitlist: [] };
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify(out));
  for (const dir of ['chats', 'sessions']) {
    fs.mkdirSync(path.join(profile, dir), { recursive: true, mode: 0o700 });
    const ids = new Set(out.columns.map((c) => c.id));
    for (const f of fs.readdirSync(path.join(src, dir)).filter((f) => dir === 'chats' || ids.has(f.replace(/\.txt$/, '')))) {
      fs.copyFileSync(path.join(src, dir, f), path.join(profile, dir, f));
    }
  }
}

let cdp;
async function startProfile(page) {
  cdp = cdp || await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
}
async function stopProfile(page, file) {
  const { profile } = await cdp.send('Profiler.stop');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(profile));
}

main().catch((e) => { console.error(e); process.exit(1); });
