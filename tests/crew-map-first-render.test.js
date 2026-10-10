'use strict';
// 2.0.2 任务看板打不开: started on 架构图, the map's first drawing (inside CrewMap.init, made
// while renderer.js is still setting the page up) threw, and the page script stopped there:
// TaskBoardUI.init, the map's 任务看板 / 用量 tabs and the saved view were never set up, so
// 任务看板 opened from nowhere. ac3fa75 fixed that throw; whatever else the first drawing
// throws must not stop the rest of the page again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
// From the crew map's set-up to the end of the page script.
const begin = source.indexOf('\n// The board view opens on the 终端架构图');
assert.ok(begin >= 0, 'renderer.js still sets the crew map up');
const tail = source.slice(begin);
assert.ok(tail.includes('TaskBoardUI.init(') && tail.includes('showView(config.activeView);'), 'the task board and the saved view are set up after it');

function start(initMap) {
  const done = { taskBoard: false, tabs: [], view: null, logged: [] };
  const context = vm.createContext({
    config: { activeView: 'board', archived: [] }, terms: new Map(), columns: [], activeView: 'board', env: { platform: 'win32' },
    columnLabel: (c) => c.id, lastActivityLine: () => '', saveConfig() {}, renderBoardGraph() {}, restoreBoardTerminal() {},
    restoreArchived() {}, whenMounted() {}, jumpToColumn() {}, showToast() {}, syncChromeState() {},
    MainSession: {}, ClaudeSeats: { described: () => [] }, Pages: { hide() {} }, Sidebar: { markPage() {} },
    window: { AgentInfo: {}, deck: {} },
    CrewMap: { init: initMap, mode: () => 'crew', setMode() {} },
    TaskBoardUI: { init() { done.taskBoard = true; }, open() {}, close() {} },
    document: { getElementById: (id) => ({ addEventListener: (type) => done.tabs.push(`${id}:${type}`), focus() {} }) },
    showView: (view) => { done.view = view; },
    console: { error: (...args) => done.logged.push(args.map(String).join(' ')), log() {}, warn() {} },
  });
  vm.runInContext(tail, context);
  return done;
}

test('a crew map whose first drawing throws does not stop 任务看板 and the saved view from being set up', () => {
  const done = start(() => { throw new TypeError("Cannot read properties of undefined (reading 'plan')"); });
  assert.equal(done.taskBoard, true, 'TaskBoardUI.init ran');
  assert.deepEqual(done.tabs, ['boardTasksTab:click', 'boardTokensTab:click'], 'the map\'s 任务看板 and 用量 tabs open the board');
  assert.equal(done.view, 'board', 'the saved view is shown');
  assert.equal(done.logged.length, 1);
  assert.match(done.logged[0], /reading 'plan'/, 'the error is still reported');
});

test('a crew map that draws normally: the page is set up the same way, nothing reported', () => {
  let host = null;
  const done = start((h) => { host = h; });
  assert.equal(typeof host.visible, 'function');
  assert.equal(done.taskBoard, true);
  assert.equal(done.view, 'board');
  assert.deepEqual(done.logged, []);
});
