// The Captain's crew list (and its per-model groups) opens by default: at every launch
// and again the first time the window is used on a new day. A fold the user makes in
// between holds for the rest of that run.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SC = require('../sidebar-core');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

test('localDay is the local calendar date and rolls over at local midnight', () => {
  assert.equal(SC.localDay(new Date(2026, 9, 8, 23, 59, 59)), '2026-10-08');
  assert.equal(SC.localDay(new Date(2026, 9, 9, 0, 0, 1)), '2026-10-09');
  assert.equal(SC.localDay(new Date(2026, 0, 2, 3).getTime()), '2026-01-02');
  assert.equal(SC.localDay(NaN), '');
  assert.equal(SC.localDay('not a date'), '');
});

test('config starts with the crew list open and never restores a saved fold', () => {
  assert.match(renderer, /crewOpen: true, crewModelsCollapsed: \[\]/);
  assert.doesNotMatch(renderer, /saved\??\.crewOpen/);
  assert.doesNotMatch(renderer, /saved\??\.crewModelsCollapsed/);
});

// Run the renderer's own day-change code against stand-ins.
function launch(day) {
  const start = renderer.indexOf('let crewFoldDay');
  const end = renderer.indexOf("document.addEventListener('visibilitychange', () => { if (!document.hidden) openCrewOnNewDay(); });");
  assert.ok(start > 0 && end > start, 'day-change block not found in renderer.js');
  const events = {};
  const env = {
    now: new Date(...day).getTime(),
    renders: 0,
    config: { crewOpen: true, crewModelsCollapsed: [] },
    visible: true,
  };
  const ctx = vm.createContext({
    SidebarCore: SC,
    config: env.config,
    Sidebar: { render: () => { env.renders++; } },
    Date: { now: () => env.now },
    window: { addEventListener: (type, fn) => { events[type] = fn; } },
    document: { get hidden() { return !env.visible; }, addEventListener: (type, fn) => { events[type] = fn; } },
  });
  vm.runInContext(renderer.slice(start, end) + "document.addEventListener('visibilitychange', () => { if (!document.hidden) openCrewOnNewDay(); });", ctx);
  return { env, events };
}

test('a fold made today holds through focus and visibility events on the same day', () => {
  const { env, events } = launch([2026, 9, 8, 9]);
  env.config.crewOpen = false;
  env.config.crewModelsCollapsed = ['Opus 5.5\u001fus'];
  env.now = new Date(2026, 9, 8, 23, 59).getTime();
  events.focus();
  events.visibilitychange();
  assert.equal(env.config.crewOpen, false);
  assert.deepEqual(env.config.crewModelsCollapsed, ['Opus 5.5\u001fus']);
  assert.equal(env.renders, 0);
});

test('the first focus on a new day opens the list and every model group again', () => {
  const { env, events } = launch([2026, 9, 8, 9]);
  env.config.crewOpen = false;
  env.config.crewModelsCollapsed = ['Opus 5.5\u001fus', 'Grok 4.7\u001f'];
  env.now = new Date(2026, 9, 9, 8).getTime();
  events.focus();
  assert.equal(env.config.crewOpen, true);
  assert.equal(env.config.crewModelsCollapsed.length, 0);
  assert.equal(env.renders, 1);
  // a fold after that holds for the rest of the new day
  env.config.crewOpen = false;
  events.focus();
  assert.equal(env.config.crewOpen, false);
  assert.equal(env.renders, 1);
});

test('a day change while only a model group is folded still reopens it; nothing folded means no redraw', () => {
  const { env, events } = launch([2026, 9, 8, 9]);
  env.config.crewModelsCollapsed = ['Opus 5.5\u001fus'];
  env.now = new Date(2026, 9, 9, 8).getTime();
  events.visibilitychange();
  assert.equal(env.config.crewModelsCollapsed.length, 0);
  assert.equal(env.renders, 1);
  env.now = new Date(2026, 9, 10, 8).getTime();
  events.visibilitychange();
  assert.equal(env.renders, 1);
});

test('a hidden window does not use up the new day', () => {
  const { env, events } = launch([2026, 9, 8, 9]);
  env.config.crewOpen = false;
  env.now = new Date(2026, 9, 9, 8).getTime();
  env.visible = false;
  events.visibilitychange();
  assert.equal(env.config.crewOpen, false);
  env.visible = true;
  events.visibilitychange();
  assert.equal(env.config.crewOpen, true);
});
