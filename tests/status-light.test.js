'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MainCore = require('../main-core');
const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
const context = vm.createContext({ MainCore });
vm.runInContext(source.slice(source.indexOf('const WORKING_RE'), source.indexOf('function setDot')) +
  source.slice(source.indexOf('function statusScreen'), source.indexOf('// Format elapsed ms')), context);
const { classify, statusScreen } = context;
const cursorCmd = 'cursor-agent --force --model grok-4.7-high-fast';
// Status/footer tails of the three 1.1.3 live captures (2026-10-04):
// muu4l1ja3s6j5n = updating, muu4nwrxhvh0tp = waiting-shell, muu4opao63zjp4 = thinking.
// Unrelated tool output is omitted and the working directory is replaced by ~.
const cursorSamples = ['updating', 'waiting-shell', 'thinking'];
for (const name of cursorSamples) {
  test(`real Cursor Grok screen: ${name} stays working at different column widths`, () => {
    const screen = fs.readFileSync(path.join(__dirname, 'fixtures/cursor-live', `${name}.txt`), 'utf8');
    assert.equal(MainCore.terminalActivity(screen, cursorCmd), 'working');
    // xterm hard-wraps at cell boundaries; these samples contain no wide cells.
    for (const width of [26, 30, 45, 80]) {
      const rows = screen.split('\n').flatMap((line) => {
        const chunks = line.match(new RegExp(`.{1,${width}}`, 'gu')) || [''];
        return chunks.map((text, i) => i ? { text } : text);
      });
      const live = statusScreen(terminal(rows));
      assert.equal(MainCore.cursorActivity(live), 'working', `width=${width}`);
      for (const state of ['done', 'working']) {
        assert.equal(classify(live, { state, hasWorked: true, lastOutputAt: 1 }, cursorCmd), 'working');
      }
    }
  });
}

const busy = [
  '◦ Working (11m 27s • esc to interrupt) · 1 background terminal',
  '✻ Contemplating… (11m 27s · esc to interrupt · ↓ 1.2k tokens)',
  '✻ 思考中…',
  'Thinking... (31s)',
  'Searching… (31s · esc to cancel)',
  '⠋ Reading files...',
  'ctrl+c to stop',
  'Responding…',
];
function terminal(lines, baseY = 0, rows = lines.length - baseY) {
  return { rows, buffer: { active: { baseY, viewportY: 0, getLine: (y) => {
    const line = lines[y];
    return line === undefined ? undefined : { isWrapped: typeof line === 'object',
      translateToString: () => typeof line === 'object' ? line.text : line };
  } } } };
}

test('quiet Codex, Claude, Gemini/agy and Cursor busy rows stay working above a tall footer', () => {
  for (const marker of busy) {
    const term = terminal([marker, ...Array(45).fill(''), '❯', 'Claude Code']);
    const entry = { hasWorked: true, lastOutputAt: Date.now() - 15 * 60000 };
    for (let tick = 0; tick < 5; tick++) assert.equal(classify(statusScreen(term), entry), 'working', marker);
  }
});

test('live screen reads off-screen/unfocused columns and joins hard-wrapped busy hints', () => {
  const term = terminal(['old row', '◦ Work', { text: 'ing (11m 27s • esc to inter' },
    { text: 'rupt) · 1 background terminal' }, '❯'], 1);
  term.focused = false;
  term.visible = false;
  assert.equal(classify(statusScreen(term), { hasWorked: true }), 'working');
  assert.equal(term.buffer.active.viewportY, 0, 'does not scroll the reader to the bottom');
});

test('completed/idle screens exclude stale scrollback and replayed busy rows', () => {
  const term = terminal([busy[0], 'Done. Working status was checked.', '❯', 'Thinking: high'], 1);
  assert.equal(classify(statusScreen(term), { hasWorked: true }), 'done');
  assert.equal(classify(statusScreen(term), { hasWorked: false }), 'plain');
  for (const separator of ['── 以上为上次会话的输出 ──',
    '── 上次输出回放，进程已结束（模型上下文将通过 CLI 恢复）──',
    '── 上次输出回放；此栏未绑定模型会话，本次将新开对话 ──']) {
    const replay = terminal([busy[0], separator, '❯', 'Claude Code']);
    assert.equal(classify(statusScreen(replay), { hasWorked: true }), 'done');
  }
  for (const text of ['The Working indicator is now gone.', 'Thinking: xhigh', '✻ Baked for 31s',
    'Enter to send · Esc to cancel', '↑↓ to select · Enter to confirm · Esc to cancel', '⠀']) {
    assert.notEqual(classify(text + '\n❯', { hasWorked: true }), 'working', text);
  }
});

test('quota and confirmation states remain distinct from busy spinners', () => {
  assert.equal(classify("You've hit your usage limit\nContinuing at 5pm · esc to cancel", { hasWorked: true }), 'quota');
  assert.equal(classify('Proceed? (y/n)\n❯', { hasWorked: true }), 'input');
  assert.equal(classify(busy[0] + '\nwaiting for user confirmation', { hasWorked: true }), 'working');
});

test('Cursor uses the live stop hint on its input row, including wrapped multi-character spinners', () => {
  const term = terminal(['⠰⠳ Grepping  32.91k tokens', '',
    '  → Add a follow-up              ctrl+c to ', { text: 'stop' }]);
  const screen = statusScreen(term);
  assert.equal(MainCore.terminalActivity(screen), 'working');
  assert.equal(classify(screen, { hasWorked: true }, 'cursor-agent --force'), 'working');
  assert.equal(classify('→ my queued follow-up   ctrl+c to stop', { hasWorked: true }), 'working');
  assert.notEqual(classify('The docs say ctrl+c to stop.\n❯', { hasWorked: true }), 'working');
});

test('Cursor startup silence stays busy after submission and an idle prompt clears old tool indicators', () => {
  assert.equal(classify('', { hasWorked: true }, 'cursor-agent --model grok-4.7-high-fast'), 'working');
  assert.equal(classify('Initializing\nComposer', { hasWorked: true }, 'cursor-agent'), 'working');
  assert.equal(classify('', { hasWorked: false }, 'cursor-agent'), 'plain');
  const idle = '⠋ Thinking…\n⠰⠳ Grepping  32.91k tokens\n\n→ Add a follow-up';
  assert.equal(MainCore.terminalActivity(idle, 'cursor-agent'), '');
  assert.equal(classify(idle, { hasWorked: true }, 'cursor-agent'), 'done');
  assert.equal(classify('→ Plan, search, build anything', { hasWorked: false }, 'cursor-agent'), 'plain');
  assert.equal(classify('✻ Doing…\n→ Add a follow-up', { hasWorked: true }, 'claude'), 'working');
  assert.equal(classify('Usage limit reached\n→ Add a follow-up  ctrl+c to stop', { hasWorked: true }, 'cursor-agent'), 'working');
  assert.equal(classify('→ Add a follow-up  ctrl+c to stop\nUsage limit reached', { hasWorked: true }, 'cursor-agent'), 'quota');
});

test('archive rechecks the live terminal and open turns instead of trusting a stale green dot', () => {
  const col = { id: 'worker', cmd: 'cursor-agent' }, child = { id: 'child', cmd: 'agy' };
  let now = 1_000_000, detached = 0, open = false, composing = false, draft = false;
  const entry = { alive: true, state: 'done', hasWorked: true, lastOutputAt: 1,
    term: terminal(['→ Add a follow-up              ctrl+c to stop']) };
  const terms = new Map([[col.id, entry]]);
  const columns = [col];
  const ctx = vm.createContext({ MainCore, terms, columns, config: {}, Date: { now: () => now },
    managedSubtree: () => terms.has(child.id) ? [child] : [], showToast() {}, columnLabel: () => 'worker',
    userComposing: () => composing, ChatUI: { hasDraft: () => draft,
      turnsOf: () => open ? [{ kind: 'turn', done: false }] : [], onColumnArchived() {} },
    cancelManagedRequests() {}, releaseManagedSubtree() {}, detachColumn: () => detached++,
    saveConfig() {}, renderColNav() {}, renderBoardGraph() {} });
  vm.runInContext(source.slice(source.indexOf('const WORKING_RE'), source.indexOf('function setDot')) +
    source.slice(source.indexOf('function statusScreen'), source.indexOf('// Format elapsed ms')) +
    source.slice(source.indexOf('function archiveColumn'), source.indexOf('// quiet: 队长 bringing back')), ctx);
  const archive = () => ctx.archiveColumn(col, { quiet: true });
  archive(); assert.equal(detached, 0, 'live stop footer protects a quiet green terminal');
  entry.term = terminal(['→ Add a follow-up']);
  for (const flag of ['sendingPrompt', 'injecting']) {
    entry[flag] = true; archive(); assert.equal(detached, 0); entry[flag] = false;
  }
  for (const state of ['working', 'input', 'quota']) {
    entry.state = state; archive(); assert.equal(detached, 0);
  }
  entry.state = 'done';
  open = true; archive(); assert.equal(detached, 0); open = false;
  composing = true; archive(); assert.equal(detached, 0); composing = false;
  draft = true; archive(); assert.equal(detached, 0); draft = false;
  entry.lastOutputAt = now - 1000; archive(); assert.equal(detached, 0);
  entry.lastOutputAt = 1;
  terms.set(child.id, { ...entry, term: terminal(['Searching… (20s · esc to cancel)']) });
  archive(); assert.equal(detached, 0, 'busy descendant is protected');
  terms.delete(child.id);
  archive(); assert.equal(detached, 1, 'only a genuinely idle terminal is archived');
  entry.term = terminal(['→ Add a follow-up              ctrl+c to stop']);
  ctx.archiveColumn(col, { captain: true, quiet: true });
  assert.equal(detached, 2, 'explicit Captain archive remains authorized');
});

test('the whole "→ … ctrl+c to stop" row counts as busy for every provider, not only Cursor', () => {
  const row = '→ Add a follow-up              ctrl+c to stop';
  for (const cmd of ['', 'claude', 'codex', 'agy', 'cursor-agent', 'gemini']) {
    assert.equal(MainCore.terminalActivity(row, cmd), 'working', cmd || '(no command)');
    assert.equal(MainCore.terminalActivity('│ ' + row + ' │', cmd), 'working', cmd + ' boxed');
  }
  assert.equal(MainCore.terminalActivity('The docs say ctrl+c to stop.', 'claude'), '');
});

test('a narrow Cursor screen: wrapped idle prompt reads idle, a busy one reads working', () => {
  const wrapped = ['', '  → Plan, search, build', '    anything', '', '  Claude      Run Everything', '  Opus 5.5', '  ~'];
  const cmd = 'cursor-agent --force --model claude-opus-5-5-high';
  assert.equal(classify(wrapped.join('\n'), { hasWorked: false }, cmd), 'plain');
  assert.equal(classify(wrapped.join('\n'), { hasWorked: true }, cmd), 'done');
  for (const row of ['  ⠋ Reading…', '  ⠰⠳ Grepping  32.91k tokens', '  Running…', '  Editing...']) {
    const screen = [row, ...wrapped].join('\n');
    assert.equal(classify(screen, { hasWorked: true }, cmd), 'working', row);
    assert.equal(classify(screen, { hasWorked: false }, cmd), 'working', row);
  }
  assert.equal(classify('  → Add a follow-up   ctrl+c to\n    stop', { hasWorked: true }, cmd), 'working');
  // unwrapped behaviour of the accepted Cursor status work is unchanged
  assert.equal(classify('⠋ Thinking…\n\n→ Add a follow-up', { hasWorked: true }, cmd), 'done');
});
