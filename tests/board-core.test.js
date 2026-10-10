'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BoardCore = require('../board-core');

test('normalizes manual terminals as isolated', () => {
  const column = BoardCore.normalizeColumn({ id: 'm1', title: 'Scratch', role: 'something', parentId: 'c1' });
  assert.equal(column.role, 'manual');
  assert.equal(column.managed, false);
  assert.equal(column.parentTaskId, null);
  assert.equal(column.relationship, 'Independent manual terminal');
});

test('infers known agents and resolves commands', () => {
  assert.equal(BoardCore.inferAgentType('claude --continue'), 'Claude');
  assert.equal(BoardCore.inferAgentType('agy'), 'Antigravity');
  assert.equal(BoardCore.inferAgentType('grok -i'), 'Grok');
  assert.equal(BoardCore.inferAgentType('cursor-agent --force'), 'Cursor');
  assert.equal(BoardCore.inferAgentType('codex --dangerously-bypass-approvals-and-sandbox'), 'Codex');
  assert.equal(BoardCore.inferAgentType('gemini --yolo'), 'Antigravity');
  assert.equal(BoardCore.commandForAgent('claude'), 'claude --dangerously-skip-permissions --effort high');
  assert.equal(BoardCore.commandForAgent('agy'), 'agy --dangerously-skip-permissions --model gemini-3.8-flash-high');
  assert.equal(BoardCore.commandForAgent('grok'), 'grok --permission-mode bypassPermissions');
  assert.equal(BoardCore.commandForAgent('cursor'), 'cursor-agent --force --model claude-opus-5-5-high');
  assert.equal(BoardCore.commandForAgent('codex'), 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox');
  assert.equal(BoardCore.commandForAgent('gemini'), 'gemini --yolo');
  assert.equal(BoardCore.commandForAgent('grok', 'custom-agent'), 'custom-agent');
});

test('upgrades legacy default commands while preserving custom commands and configurations', () => {
  // exact legacy presets
  assert.equal(
    BoardCore.upgradeLegacyCommand('agy --model gemini-3.8-flash-high --effort high'),
    'agy --dangerously-skip-permissions --model gemini-3.8-flash-high'
  );
  // the old Antigravity preset passed --effort, which makes agy switch models
  assert.equal(
    BoardCore.upgradeLegacyCommand('agy --dangerously-skip-permissions --model gemini-3.8-flash-high --effort high'),
    'agy --dangerously-skip-permissions --model gemini-3.8-flash-high'
  );
  assert.equal(
    BoardCore.upgradeLegacyCommand('cursor-agent --model claude-opus-5-5-high'),
    'cursor-agent --force --model claude-opus-5-5-high'
  );
  assert.equal(
    BoardCore.upgradeLegacyCommand('claude --dangerously-skip-permissions'),
    'claude --dangerously-skip-permissions --effort high'
  );
  // plain legacy aliases
  assert.equal(BoardCore.upgradeLegacyCommand('agy'), 'agy --dangerously-skip-permissions --model gemini-3.8-flash-high');
  assert.equal(BoardCore.upgradeLegacyCommand('grok'), 'grok --permission-mode bypassPermissions');
  assert.equal(BoardCore.upgradeLegacyCommand('cursor'), 'cursor-agent --force --model claude-opus-5-5-high');
  assert.equal(BoardCore.upgradeLegacyCommand('cursor-agent'), 'cursor-agent --force --model claude-opus-5-5-high');
  assert.equal(BoardCore.upgradeLegacyCommand('claude'), 'claude --dangerously-skip-permissions --effort high');
  assert.equal(BoardCore.upgradeLegacyCommand('codex'), 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox');
  assert.equal(BoardCore.upgradeLegacyCommand('codex --dangerously-bypass-approvals-and-sandbox'), 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox');

  assert.equal(BoardCore.upgradeLegacyCommand('gemini'), 'gemini --yolo');

  // custom commands remain completely untouched
  assert.equal(BoardCore.upgradeLegacyCommand('cursor-agent --model claude-sonnet-5-5-xhigh'), 'cursor-agent --model claude-sonnet-5-5-xhigh');
  assert.equal(BoardCore.upgradeLegacyCommand('agy --model gemini-3.1-pro-high --effort high'), 'agy --model gemini-3.1-pro-high --effort high');
  assert.equal(BoardCore.upgradeLegacyCommand('claude --effort low'), 'claude --effort low');
  assert.equal(BoardCore.upgradeLegacyCommand('./run-custom-worker.sh'), './run-custom-worker.sh');
  assert.equal(BoardCore.upgradeLegacyCommand('python test.py'), 'python test.py');
  assert.equal(BoardCore.upgradeLegacyCommand(''), '');
});

test('managed ownership permits descendants but never manual or sibling roots', () => {
  const columns = [
    { id: 'c1', taskId: 'root-1', role: 'conductor' },
    { id: 'w1', taskId: 'worker-1', role: 'worker', parentTaskId: 'root-1' },
    { id: 'w2', taskId: 'worker-2', role: 'worker', parentTaskId: 'worker-1' },
    { id: 'c2', taskId: 'root-2', role: 'conductor' },
    { id: 'm1', taskId: 'manual-1', role: 'manual' },
  ];
  assert.equal(BoardCore.isManagedDescendant(columns, columns[0], columns[2]), true);
  assert.equal(BoardCore.isManagedDescendant(columns, columns[0], columns[3]), false);
  assert.equal(BoardCore.isManagedDescendant(columns, columns[0], columns[4]), false);
  assert.equal(BoardCore.taskDepth(columns, columns[2]), 2);
});

test('relationship types never grant implicit control', () => {
  const columns = [
    { id: 'a', taskId: 'a', role: 'manual', title: 'A' },
    { id: 'b', taskId: 'b', role: 'manual', title: 'B' },
  ];
  const dependency = BoardCore.normalizeLink({ id: 'l1', fromTaskId: 'a', toTaskId: 'b', type: 'dependency', grantedControl: true });
  assert.equal(dependency.grantedControl, false);
  const handoff = BoardCore.normalizeLink({ id: 'l2', fromTaskId: 'a', toTaskId: 'b', type: 'handoff', grantedControl: true });
  assert.equal(handoff.grantedControl, false);
  assert.equal(BoardCore.isManagedDescendant(columns, columns[0], columns[1]), false);
});

test('display titles remain separate from internal titles and duplicates get a clear suffix', () => {
  const columns = [
    { id: 'a', taskId: 'a', role: 'manual', title: 'auto-1', displayTitle: 'API worker' },
    { id: 'b', taskId: 'b', role: 'manual', title: 'auto-2' },
  ];
  assert.equal(BoardCore.uniqueDisplayTitle('API worker', columns, 'b'), 'API worker (2)');
  const normalized = BoardCore.normalizeColumn(columns[0]);
  assert.equal(normalized.title, 'auto-1');
  assert.equal(normalized.displayTitle, 'API worker');
});

test('managed request ownership persists while manual terminals discard it', () => {
  const managed = BoardCore.normalizeColumn({
    id: 'w',
    taskId: 'w',
    role: 'worker',
    parentTaskId: 'root',
    requestId: 'create-1',
    waitRequestIds: ['wait-1', 'wait-1', 'wait-2'],
    createdByRequestId: 'spawn-1',
  });
  assert.equal(managed.requestId, 'create-1');
  assert.deepEqual(managed.waitRequestIds, ['wait-1', 'wait-2']);
  assert.equal(managed.createdByRequestId, 'spawn-1');
  const manual = BoardCore.normalizeColumn({ ...managed, role: 'manual' });
  assert.equal(manual.requestId, null);
  assert.deepEqual(manual.waitRequestIds, []);
  assert.equal(manual.createdByRequestId, null);
});

test('session project and review metadata normalize without losing independent terminal roles', () => {
  const normalized = BoardCore.normalizeColumn({ id: 'r', role: 'manual', project: ' 项目\n一 ', reviews: ['a', 'a', 'b', '../bad', null] });
  assert.equal(normalized.project, '项目 一');
  assert.deepEqual(normalized.reviews, ['a', 'b']);
  assert.equal(normalized.managed, false);
});
