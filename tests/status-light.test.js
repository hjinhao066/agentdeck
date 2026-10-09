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
const codexIdle = ['─ Worked for 34m 29s • 12:52 ─', '› Ask Codex to do anything',
  'GPT-6.1-Sol high · ~ · 修复僵尸调度会话派卡', '? for shortcuts  ⚠ 3 · f2'].join('\n');
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

// 10-04 saved done turns: muu3iprlq3aw40, muu3gnm794q3aw,
// mutgiolujzsm2d. Only their status/footer rows are retained.
// The spinner stays in the band above the prompt; a tall footer sits below it.
for (const name of ['done-thinking', 'done-grepping', 'done-running']) {
  test(`real done Cursor snapshot: ${name} remains working with ready prompts and tall footers`, () => {
    const screen = fs.readFileSync(path.join(__dirname, 'fixtures/cursor-live', `${name}.txt`), 'utf8');
    const body = 'Working on the parser.\nSearching for the call site.\nReading 3 files.\n';
    for (const prompt of ['', '\n→ Add a follow-up', '\n  → Plan, search, build\n    anything']) {
      const live = body + screen + prompt + (prompt ? '\n' + Array(20).fill('  footer').join('\n') : '');
      assert.equal(MainCore.cursorActivity(live), 'working');
      assert.equal(MainCore.terminalActivity(live, cursorCmd), 'working');
      assert.equal(classify(live, { state: 'done', hasWorked: true, lastOutputAt: 1 }, cursorCmd), 'working');
      assert.equal(context.terminalIdle({ cmd: cursorCmd }, { alive: true, state: 'done', lastScreen: live }), false);
    }
  });
}

test('Cursor reply prose above an idle prompt is finished once the quiet grace ends', () => {
  const prose = [
    'Working on the status detector.',
    'Searching for cursorActivity in main-core.js',
    'Reading 3 files showed the spinner.',
    'Waiting for the test run to finish.',
    'Thinking… the three cases are covered.',
    'Planning',
    '• Working on the parser',
    'Running 12 tests next.',
  ].join('\n');
  const screen = prose + '\n→ Add a follow-up';
  assert.equal(MainCore.cursorBusy(screen), false);
  assert.equal(MainCore.cursorActivity(screen), 'idle');
  assert.equal(MainCore.terminalActivity(screen, cursorCmd), '');
  assert.equal(classify(screen, { state: 'done', hasWorked: true, lastOutputAt: 1 }, cursorCmd), 'done');
  assert.equal(classify(screen, { state: 'working', hasWorked: true, lastOutputAt: Date.now() - 11000 }, cursorCmd), 'done');
  assert.equal(classify(screen, { state: 'working', hasWorked: true, lastOutputAt: Date.now() - 2000 }, cursorCmd), 'working');
  const stale = '  ⠠⠛ Running  94.91k tokens\n' + Array(30).fill('The reply continues.').join('\n') + '\n→ Add a follow-up';
  assert.equal(MainCore.cursorActivity(stale), 'idle');
  assert.equal(classify(stale, { state: 'working', hasWorked: true, lastOutputAt: Date.now() - 11000 }, cursorCmd), 'done');
});

test('Claude, Codex and agy status ignores Cursor reply wording', () => {
  const prose = 'Working on the fix.\nSearching for the call site.\nReading 3 files.\n';
  assert.equal(classify(prose + '✻ Doing…\n→ Add a follow-up', { hasWorked: true }, 'claude'), 'working');
  assert.equal(classify(prose + '❯\nClaude Code', { hasWorked: true, lastOutputAt: 1 }, 'claude'), 'done');
  assert.equal(classify(prose + '→ see the note\n❯\nClaude Code', { hasWorked: true, lastOutputAt: 1 }, 'claude'), 'done');
  assert.equal(classify(prose + '\n' + codexIdle, { state: 'working', hasWorked: true }, 'codex'), 'done');
  assert.equal(classify(codexIdle + '\n' + '◦ Working (11m 27s • esc to interrupt) · 1 background terminal', { hasWorked: true }, 'codex'), 'working');
  assert.equal(classify(prose + 'Searching… (11m 27s · esc to cancel)\n❯', { hasWorked: true }, 'agy'), 'working');
  assert.equal(classify(prose + '❯\nAntigravity', { hasWorked: true, lastOutputAt: 1 }, 'agy'), 'done');
});

test('Codex "Waiting for background terminal" keeps the column working, and leaving it lets the dot go green', () => {
  const rows = ['◦ Waiting for background terminal (5m 12s • esc to interrupt) · sleep 300',
    '◦ Waiting for background terminal · sleep 300', '◦ Waiting for agents (2m 3s • esc to interrupt)'];
  for (const row of rows) {
    assert.equal(classify(`• Ran sleep 300\n\n${row}\n\n› Ask Codex to do anything\n? for shortcuts`, { hasWorked: true }, 'codex'), 'working', row);
    assert.equal(classify(`${row}\n${codexIdle}`, { hasWorked: true, lastOutputAt: 1 }, 'codex'), 'done', row);
  }
});

test('Cursor waiting commands, soft-wrapped stop hints and short idle gaps never complete a running turn', () => {
  for (const marker of ['Waiting 2m 38s for shell', 'Waiting for shell', '  ⠀⠞ Thinking  27.62k tokens', '  ⠠⠛ Working  3k tokens', '正在运行命令 gh run watch']) {
    const screen = '$ gh run watch 123 --exit-status\n' + marker + '\n→ Add a follow-up';
    assert.equal(classify(screen, { state: 'done', hasWorked: true }, cursorCmd), 'working', marker);
  }
  for (const hint of ['ctrl+c to\nstop', 'ctrl+\nc to stop', 'ct\nrl+c to stop']) {
    assert.equal(classify('→ Add a follow-up ' + hint, { hasWorked: true }, cursorCmd), 'working', hint);
  }
  assert.equal(classify('→ Add a follow-up', { state: 'working', hasWorked: true, lastOutputAt: Date.now() - 2000 }, cursorCmd), 'working');
  assert.equal(classify('→ Add a follow-up', { state: 'working', hasWorked: true, lastOutputAt: Date.now() - 11000 }, cursorCmd), 'done');
  assert.equal(classify('⏺ Finished.\n• Tests passed.\n→ Add a follow-up', { hasWorked: true }, cursorCmd), 'done');
  for (const prose of ['The docs say ctrl+c to stop.', 'Read tool metadata: AwaitShell', 'Enter to send · Esc to cancel']) {
    assert.equal(classify(prose + '\n→ Add a follow-up', { hasWorked: true }, cursorCmd), 'done', prose);
  }
});

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
  const cursor = terminal(['→ Add a follow-up ctrl+c to stop', '⏺ Finished.', '→ Add a follow-up'], 1);
  const live = statusScreen(cursor);
  assert.equal(MainCore.terminalActivity(live, cursorCmd), '');
  assert.equal(classify(live, { hasWorked: true }, cursorCmd), 'done', 'historical stop hints must not hold a live idle Cursor');
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

test('Cursor startup silence and visible activity stay busy even with a ready-looking prompt', () => {
  assert.equal(classify('', { hasWorked: true }, 'cursor-agent --model grok-4.7-high-fast'), 'working');
  assert.equal(classify('Initializing\nComposer', { hasWorked: true }, 'cursor-agent'), 'working');
  assert.equal(classify('', { hasWorked: false }, 'cursor-agent'), 'plain');
  const idle = '⠋ Thinking…\n⠰⠳ Grepping  32.91k tokens\n\n→ Add a follow-up';
  assert.equal(MainCore.terminalActivity(idle, 'cursor-agent'), 'working');
  assert.equal(classify(idle, { hasWorked: true }, 'cursor-agent'), 'working');
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
  for (const row of ['  ⠋ Reading…', '  ⠰⠳ Grepping  32.91k tokens', '  ⠠⠛ Running  94.91k tokens', '  ⠋ Editing...']) {
    const screen = [row, ...wrapped].join('\n');
    assert.equal(classify(screen, { hasWorked: true }, cmd), 'working', row);
    assert.equal(classify(screen, { hasWorked: false }, cmd), 'working', row);
  }
  assert.equal(classify('  → Add a follow-up   ctrl+c to\n    stop', { hasWorked: true }, cmd), 'working');
  // An unwrapped prompt cannot override an activity row either.
  assert.equal(classify('⠋ Thinking…\n\n→ Add a follow-up', { hasWorked: true }, cmd), 'working');
});

test('Codex completed divider excludes historical busy evidence from status and delivery readiness', () => {
  for (const stale of ['◦ Working (11m 27s • esc to interrupt)', '✻ Doing…', 'press up to edit queued messages',
    'API Error: 401 Unauthorized', 'Proceed? (y/n)', '• Thinking…']) {
    const screen = stale + '\n' + codexIdle;
    assert.equal(classify(screen, { state: 'working', hasWorked: true }, 'codex'), 'done', stale);
    assert.equal(MainCore.terminalActivity(screen, 'codex'), '', stale);
    assert.equal(MainCore.resourceReceipt(screen, 'codex'), null, stale);
    assert.equal(context.terminalIdle({ cmd: 'codex' }, { alive: true, state: 'done', lastScreen: screen }), true, stale);
    for (const width of [26, 45, 80]) {
      const rows = screen.split('\n').flatMap((line) => (line.match(new RegExp(`.{1,${width}}`, 'gu')) || [''])
        .map((text, i) => i ? { text } : text));
      assert.equal(classify(statusScreen(terminal(rows)), { hasWorked: true }, 'codex'), 'done', `${stale} width=${width}`);
    }
  }
  assert.equal(classify(codexIdle, { hasWorked: true }, 'codex'), 'done');
  for (const live of busy) {
    assert.equal(classify(codexIdle + '\n' + live, { hasWorked: true }, 'codex'), 'working', live);
  }
  assert.equal(classify(codexIdle + '\nAPI Error: 401 Unauthorized', { hasWorked: true }, 'codex'), 'quota');
  assert.equal(classify(codexIdle + '\nProceed? (y/n)', { hasWorked: true }, 'codex'), 'input');
  assert.equal(classify(busy[0] + '\n› Ask Codex to do anything\n? for shortcuts', { hasWorked: true }, 'codex'), 'working');
});

test('Claude background tools keep workers busy while the Captain can keep its permanent receipt listener', () => {
  const screen = '❯ \n⏵⏵ bypass permissions on · 1 shell, 1 monitor still running';
  assert.equal(classify(screen, { hasWorked: true }, 'claude'), 'working');
  assert.equal(classify(screen, { hasWorked: true }, 'claude', true), 'done');
  assert.equal(classify('1 shell, 1 monitor still running\n❯ \nbypass permissions on', { hasWorked: true }, 'claude'), 'done');
});

// 10-08 Windows Captain c1791498056671206, 49 columns: ConPTY leaves full rows to
// autowrap, so the finished-turn row, prompt and footer read as one wrapped line
// that starts with ✻ and ends in the footer's "…". It was 'working' for good and
// held every phone message. The suggestion and the reply prose are shortened.
test('Windows Captain: finished turn, wrapped into its truncated footer, is done', () => {
  const rows = [
    '  2. Reply prose ends here.                      ',
    '                                                 ',
    { text: '✻ Cooked for 1m 4s · done 3:22 PM · 1 shell still' },
    { text: '  running                                        ' },
    { text: '                                                 ' },
    { text: '─'.repeat(49) },
    { text: '❯ suggestion                                     ' },
    { text: '─'.repeat(49) },
    { text: '  Context: [█░░░░░░░░░░░░░░░] 87k/1.0M (9%) | …  ' },
    '  Model: Sonnet 5.5 | Thinking: high | Session…  ',
    '  ⏵⏵ bypass permissions on · 1 shell · ← 1 age…  ',
  ];
  const live = statusScreen(terminal(rows));
  assert.equal(classify(live, { state: 'working', hasWorked: true }, 'claude', true), 'done');
  // 17:14 on 2.0: the same row wrapped without the wrap flag, so "running" stood alone.
  const unflagged = statusScreen(terminal(['  Reply prose ends here.', '✻ Cooked for 7s · done 5:14 PM · 1 shell still', '  running', '', '─'.repeat(49), '❯ suggestion', '  ⏵⏵ bypass permissions on · 1 shell · ← 1 age…']));
  assert.equal(classify(unflagged, { state: 'working', hasWorked: true }, 'claude', true), 'done');
  assert.equal(classify('⠋ Running…\n❯ ', { hasWorked: true }, 'agy'), 'working');
  for (const marker of ['✻ Cooking… (3s · ↓ 1.2k tokens · esc to interrupt)', '✻ Cooking (3s · esc to interrupt)']) {
    assert.equal(classify(statusScreen(terminal([...rows.slice(0, 2), { text: marker }, ...rows.slice(4)])), { hasWorked: true }, 'claude', true), 'working', marker);
  }
});
