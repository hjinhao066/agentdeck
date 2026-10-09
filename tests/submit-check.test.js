'use strict';
// An instruction AgentDeck types must really be submitted. 10-08 18:19: a session restored with a
// 12.6 MB conversation kept the 队长's instruction in its input box; its Enter was lost while the
// TUI redrew, and three minutes later the task read 已结束，未提交回执. After the Enter, AgentDeck
// looks once more: its own text still in the box means one more Enter, logged without the text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ChatCore = require('../chat-core');
const MainCore = require('../main-core');

const source = fs.readFileSync(path.join(__dirname, '../chat-ui.js'), 'utf8');
const body = source.slice(source.indexOf('  const PASTE_READ_MAX = 30_000;'), source.indexOf('  // Resolves to the turn (or true) once the file is written'));
const RULE = '────────────────────────────────────';
const FOOTER = ['  ⏵⏵ bypass permissions on'];
const INSTRUCTION = '接着做，把原任务做完。跑 E2E 用全机排队锁：node /Users/example/scripts/e2e-queue.js -- tests/e2e/<spec>.js。';
// Claude Code wraps the text in a narrow column; the whole box is still there.
const stuck = ['⏺ 上次的回复', '', RULE, '❯ 接着做，把原任务做完。跑 E2E 用全', '  机排队锁：node /Users/example/scr', '  ipts/e2e-queue.js -- tests/e2e/<s', '  pec>.js。', RULE, ...FOOTER].join('\n');
// A box taller than the screen: its top rule has scrolled away.
const stuckTall = ['  机排队锁：node /Users/example/scr', '  ipts/e2e-queue.js -- tests/e2e/<s', '  pec>.js。', RULE, ...FOOTER].join('\n');
const submitted = ['> 接着做，把原任务做完。跑 E2E 用全机排队锁：node /Users/example/scripts/e2e-queue.js -- tests/e2e/<spec>.js。', '', '✻ Thinking…', '', RULE, '❯ ', RULE, ...FOOTER].join('\n');
const menu = ['⏺ Bash(rm -rf build)', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', RULE, ...FOOTER].join('\n');

function harness({ screens, composing = false }) {
  const sent = [], logs = [];
  const t0 = Date.now();
  const entry = { alive: true, state: 'done', term: { modes: { bracketedPasteMode: true } }, lastOutputAt: 0 };
  let enters = 0;
  const host = {
    terms: new Map([['w', entry]]),
    dumpScreen: () => screens[Math.min(enters, screens.length - 1)],
    shellQuote: (p) => p, manualPromptSent() {}, userComposing: () => composing, maybeAutoName() {}, showToast() {},
  };
  const context = vm.createContext({
    C: ChatCore, host, Date, setTimeout, clearTimeout, Promise,
    window: { deck: { ptyInput: (id, data) => { sent.push({ data, at: Date.now() - t0 }); if (data === '\r') enters++; }, notifyCancel() {},
      stateDebug: (p) => logs.push(p) }, MainSession: null, MainCore, BoardCore: { inferAgentType: () => 'Claude' } },
    beginTurn: () => ({ id: 't' }),
  });
  vm.runInContext(body, context);
  return { context, sent, logs, entry, enters: () => sent.filter((s) => s.data === '\r') };
}
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('an instruction left in the input box after its Enter gets one more Enter, logged without its text', async () => {
  for (const screen of [stuck, stuckTall]) {
    const h = harness({ screens: [screen, screen, submitted] });
    assert.ok(await h.context.sendPrompt({ id: 'w', cmd: 'claude' }, INSTRUCTION, null, {}));
    await settle(5000);
    const enters = h.enters();
    assert.equal(enters.length, 2, 'one more Enter, not more');
    assert.ok(enters[1].at - enters[0].at >= 2500, `second Enter ${enters[1].at - enters[0].at}ms after the first`);
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0].id, 'w');
    assert.ok(!JSON.stringify(h.logs[0]).includes('排队锁'), 'the log never carries the instruction');
  }
});

test('a submitted instruction, a menu on screen, or the user typing gets no extra Enter', async () => {
  for (const [screens, composing] of [[[stuck, submitted], false], [[stuck, menu], false], [[stuck, stuck], true]]) {
    const h = harness({ screens, composing });
    await h.context.sendPrompt({ id: 'w', cmd: 'claude' }, INSTRUCTION, null, {});
    await settle(4000);
    assert.equal(h.enters().length, 1);
    assert.equal(h.logs.length, 0);
  }
});

test('ChatCore.promptLeftInBox only sees the text it was given, inside the box', () => {
  assert.equal(ChatCore.promptLeftInBox(stuck, INSTRUCTION), true);
  assert.equal(ChatCore.promptLeftInBox(stuckTall, INSTRUCTION), true);
  assert.equal(ChatCore.promptLeftInBox(submitted, INSTRUCTION), false);
  assert.equal(ChatCore.promptLeftInBox(menu, INSTRUCTION), false);
  assert.equal(ChatCore.promptLeftInBox(stuck, '别的指令'), false);
  assert.equal(ChatCore.promptLeftInBox('', INSTRUCTION), false);
  // a long paste is shown collapsed; still ours when we typed something long or multi-line
  const collapsed = ['⏺ 上次的回复', RULE, '❯ [Pasted text #1 +32 lines]', RULE, ...FOOTER].join('\n');
  assert.equal(ChatCore.promptLeftInBox(collapsed, INSTRUCTION + '\n（AgentDeck 约定）做完运行 complete'), true);
  assert.equal(ChatCore.promptLeftInBox(collapsed, '短的一句话指令'), false);
});
