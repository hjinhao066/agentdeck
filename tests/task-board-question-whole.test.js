// A worker's ask was kept on the card as its first two sentences (task-board.js brief(),
// a rule left over from the removed 需要你 push), so an ask whose question came third
// reached 「需要你决定」 without the question, and the phone card showed only its first line.
// The user's call: both ends show the whole question.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore } = require('../task-board');
const U = require('../task-board-ui-core');
const { openHub, nav } = require('./fixtures/hub-page');

const ASK = '已核对三个候选方案。\n方案 A 和 C 都和现有的锁冲突。\n要不要只合方案 B？';

function store(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-question-whole-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new TaskStore(path.join(root, 'tasks'));
}
function asked(t) {
  const s = store(t);
  const card = s.add({ project: '门户', title: '合并方案', detail: '三选一。' }).card;
  s.bind({ id: card.id, attempt_id: 'a1', session_id: 'worker', assignee: { agent: 'claude', model: 'opus' } });
  s.event({ id: card.id, type: 'ask', message: ASK, attempt_id: 'a1', session_id: 'worker', source: 'command' });
  return s.list()[0];
}

test('a worker\'s question reaches 需要你决定 whole', (t) => {
  assert.equal(U.userQuestion(asked(t)), ASK);
});

test('a dispatcher\'s question reaches 需要你决定 whole', (t) => {
  const s = store(t);
  const card = s.add({ project: '报表', title: '对账', detail: '选月份。' }).card;
  s.dispatch({ id: card.id, session_id: 'dispatcher-1' });
  s.dispatcherReceipt({ id: card.id, session_id: 'dispatcher-1', question: ASK });
  assert.equal(U.userQuestion(s.list()[0]), ASK);
});

// Headless Chromium: run through scripts/e2e-queue.js.
test('the phone board card shows the same whole question', { timeout: 120000 }, async (t) => {
  const card = asked(t);
  const opened = await openHub(t, { machines: [{ id: 'mac', label: 'Mac', platform: 'darwin', hostname: 'Mac.local', cards: [card] }], login: ['mac'] });
  if (!opened) return;
  const { page, errors } = opened;
  await nav(page, '看板');
  const shown = await page.locator('.task-card .task-receipt').first().innerText();
  assert.deepEqual(errors, []);
  assert.equal(shown.replace(/\s+/g, ''), ASK.replace(/\s+/g, ''));
});
