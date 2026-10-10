// 2.0.5: the free canvas (自由画布) is gone and 架构图 is called 队伍. Both tab rows (the board view's
// and the task board's) hold exactly 队伍 / 任务看板 / Token 用量, and a profile saved on the canvas opens on 队伍.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CrewMapCore = require('../crew-map-core');
const Shortcuts = require('../app-shortcuts-core');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');

function tabs(sectionId) {
  const start = html.indexOf(`<section id="${sectionId}"`);
  const group = html.slice(start).match(/<div class="board-mode"[^>]*>([\s\S]*?)<\/div>/)[1];
  return [...group.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
}

test('the board view and the task board each show 队伍, 任务看板, Token 用量 and nothing else', () => {
  assert.deepEqual(tabs('boardView'), ['队伍', '任务看板', 'Token 用量']);
  assert.deepEqual(tabs('taskBoardView'), ['队伍', '任务看板', 'Token 用量']);
});

test('the free canvas left no page, dialog or button behind', () => {
  for (const id of ['boardScroller', 'boardInspector', 'boardConnectNotice', 'boardLinkDialog', 'taskDialog', 'boardAutoArrange', 'boardNewTask', 'boardNewTerminal']) {
    assert.ok(!html.includes(`id="${id}"`), id);
  }
  for (const f of ['index.html', 'renderer.js', 'crew-map.js', 'task-board-ui.js', 'style.css', 'README.md']) {
    assert.ok(!/自由画布|free canvas/i.test(read(f)), f);
  }
});

test('a profile saved on the canvas opens on 队伍', () => {
  assert.equal(CrewMapCore.normalizeSaved({ mode: 'canvas' }).mode, undefined);
});

test('the page is called 队伍 wherever the user reads its name', () => {
  assert.equal(Shortcuts.ACTIONS.crewMap.name, '队伍');
  const board = html.slice(html.indexOf('<section id="boardView"'));
  assert.match(board, /<h1>队伍<\/h1>/);
  assert.ok(!/架构图/.test(html), 'index.html');
  assert.ok(!/架构图/.test(read('todo-shortcut-core.js')), 'todo-shortcut-core.js');
});
