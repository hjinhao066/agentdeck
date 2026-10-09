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

// The real gate: renderer.js userComposing reads the visible input box, and AgentDeck's own text
// stuck there looks exactly like typing. The harness above stubs it; this runs the real one (cut from
// renderer.js) on an xterm stand-in of the same stuck screen, its rules and footer dim as Claude Code
// draws them.
const rendererSource = fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8');
const composingBody = rendererSource.slice(rendererSource.indexOf('const INPUT_QUIET = 5000;'), rendererSource.indexOf('// ---- Terminals ----'));
const STUCK_ROWS = [{ text: '⏺ 上次的回复' }, { text: '' }, { text: RULE, dim: true }, ...stuck.split('\n').slice(3, 7).map((text) => ({ text })),
  { text: RULE, dim: true }, { text: FOOTER[0], dim: true }];
function xterm(rows) {
  const line = ({ text, dim }) => {
    const chars = Array.from(text);
    return { length: chars.length, translateToString: () => text,
      getCell: (x) => ({ getWidth: () => 1, getChars: () => chars[x], isDim: () => !!dim, isInverse: () => false, isFgDefault: () => !dim }) };
  };
  return { rows: rows.length, modes: { bracketedPasteMode: true }, buffer: { active: { baseY: 0, length: rows.length, getLine: (y) => rows[y] && line(rows[y]) } } };
}
function realUserComposing(terms) {
  const context = vm.createContext({ terms, MainCore, ChatUI: { hasDraft: () => false }, Date });
  vm.runInContext(composingBody + '\nthis.userComposing = userComposing;', context);
  return context.userComposing;
}

test('the real userComposing: AgentDeck\'s own instruction left in the box is not the user typing; other text is', () => {
  const entry = { alive: true, term: xterm(STUCK_ROWS), typing: { draft: '', unknown: false, lastKeyAt: 0 } };
  const userComposing = realUserComposing(new Map([['w', entry]]));
  assert.equal(ChatCore.promptLeftInBox(STUCK_ROWS.map((r) => r.text).join('\n'), INSTRUCTION), true);
  assert.equal(userComposing('w', INSTRUCTION), false, 'the instruction AgentDeck typed reads as the user typing');
  assert.equal(userComposing('w', '别的指令，和框里的字不一样，长度也够长'), true);
  assert.equal(userComposing('w'), true, 'without the text it typed, anything in the box is the user\'s');
  // Keys the user pressed a moment ago, or a draft it is typing, are the user's whatever the box shows.
  entry.typing.lastKeyAt = Date.now();
  assert.equal(userComposing('w', INSTRUCTION), true);
  entry.typing.lastKeyAt = 0; entry.typing.draft = '我在打字';
  assert.equal(userComposing('w', INSTRUCTION), true);
});

test('with the real composing check, an instruction stuck in the box gets its one more Enter', async () => {
  const sent = [], logs = [];
  const entry = { alive: true, state: 'done', term: xterm(STUCK_ROWS), lastOutputAt: 0, typing: { draft: '', unknown: false, lastKeyAt: 0 } };
  const terms = new Map([['w', entry]]);
  const host = { terms, dumpScreen: () => STUCK_ROWS.map((r) => r.text).join('\n'), shellQuote: (p) => p, manualPromptSent() {}, userComposing: realUserComposing(terms), maybeAutoName() {}, showToast() {} };
  const context = vm.createContext({
    C: ChatCore, host, Date, setTimeout, clearTimeout, Promise,
    window: { deck: { ptyInput: (id, data) => sent.push(data), notifyCancel() {}, stateDebug: (p) => logs.push(p) }, MainSession: null, MainCore, BoardCore: { inferAgentType: () => 'Claude' } },
    beginTurn: () => ({ id: 't' }),
  });
  vm.runInContext(body, context);
  assert.ok(await context.sendPrompt({ id: 'w', cmd: 'claude' }, INSTRUCTION, null, {}));
  await settle(4500);
  assert.equal(sent.filter((d) => d === '\r').length, 2, 'the instruction stays in the box: no second Enter went out');
  assert.equal(logs.length, 1);
});

// An idle Claude Code (2.1.295) still writes a cursor-position query (ESC[?6n) about every 200 ms:
// lastOutputAt never ages, while the screen does not change at all. Quiet is the screen standing
// still; a working TUI's spinner and timer keep changing it.
test('an idle TUI that keeps writing terminal queries is quiet once its screen stands still; a changing screen is not', async () => {
  for (const [label, frames, wanted] of [['idle, queries only', [stuck], 2], ['working, the screen keeps changing', null, 1]]) {
    const h = harness({ screens: [stuck] });
    let frame = 0;
    if (!frames) h.context.host.dumpScreen = () => stuck + `\n✻ Thinking… (${frame++}s)`;
    // The queries, and the renderer's status tick reading the screen: an idle prompt is done, a spinner working.
    const queries = setInterval(() => { h.entry.lastOutputAt = Date.now(); h.entry.state = frames ? 'done' : 'working'; }, 200);
    try {
      assert.ok(await h.context.sendPrompt({ id: 'w', cmd: 'claude' }, INSTRUCTION, null, {}));
      await settle(9000); // the paste waits up to 3 s for output to pause, then 2.5 s, then 1.5 s standing still
    } finally { clearInterval(queries); }
    assert.equal(h.enters().length, wanted, label);
  }
});
