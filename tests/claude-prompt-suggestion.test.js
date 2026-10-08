'use strict';
// 10-08: a Claude worker that finished its turn showed Claude Code's gray
// "next step" suggestion in its prompt ("等接电后跑全量 E2E") and, under the status
// row, "1 shell still running". The 队长's tell sat as 待补充 for 30 minutes.
// Two screens, two rules:
//   - the suggestion is dim text on the prompt row, never a draft; text a person
//     typed (default colour) still is, and is never typed over;
//   - a shell or monitor that is the only thing running does not make the prompt
//     busy for a tell (the status light and the receipt clocks still wait for it).
// The row layouts below were read off a real 120x50 xterm replay of that day's
// session log: status row, rule, "❯ " + dim suggestion, rule, status line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../main-core');
const AgentSessions = require('../agent-sessions');

const source = fs.readFileSync(path.resolve(__dirname, '../renderer.js'), 'utf8');
const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/;

// A screen row is [text, styles]; styles has one letter per character:
// '.' default, 'd' dim, 'c' coloured foreground, 'i' inverse.
function fakeTerm(rows) {
  const lines = rows.map(([text, styles = '']) => {
    const cells = [];
    [...text].forEach((ch, i) => {
      const style = styles[i] || '.';
      const base = {
        isDim: () => (style === 'd' ? 1 : 0), isInverse: () => (style === 'i' ? 1 : 0), isFgDefault: () => style !== 'c',
      };
      if (wide.test(ch)) {
        cells.push({ ...base, getChars: () => ch, getWidth: () => 2 });
        cells.push({ ...base, getChars: () => '', getWidth: () => 0 });
      } else cells.push({ ...base, getChars: () => ch, getWidth: () => 1 });
    });
    return { length: Math.max(cells.length, 120), getCell: (x) => cells[x] || { getChars: () => '', getWidth: () => 1, isDim: () => 0, isInverse: () => 0, isFgDefault: () => true } };
  });
  return { rows: lines.length, buffer: { active: { baseY: 0, getLine: (y) => lines[y] } } };
}
const dim = (text) => [text, 'd'.repeat([...text].length)];
const plain = (text) => [text];

function composing(rows, typing = {}) {
  const entry = { term: fakeTerm(rows), typing: { draft: '', unknown: false, lastKeyAt: 0, ...typing } };
  const context = vm.createContext({ MainCore: M, ChatUI: { hasDraft: () => false }, terms: new Map([['w', entry]]), Date });
  vm.runInContext(source.slice(source.indexOf('const INPUT_QUIET'), source.indexOf('// ---- Terminals ----')), context);
  return { box: context.visibleInputBox(entry), composing: context.userComposing('w'), entry };
}

const RULE = plain('─'.repeat(69));
const STATUS_LINE = [plain('  Sonnet 5.5  5h 93% ↻15:00 · 7d 98%'), plain('  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents')];
const SUGGESTION = '等接电后跑全量 E2E';
const workerScreen = (statusRow, promptRow) => [plain('  ⏺ 我没跑 E2E，也没跑单测。'), plain(''), plain(statusRow), RULE, promptRow, RULE, ...STATUS_LINE];
const DONE_ROW = '✻ Brewed for 1m 50s · done 12:05 PM';
const SHELL_ROW = DONE_ROW + ' · 1 shell still running';

test('Claude Code\'s dim suggestion on the prompt row is not a draft, with or without a running shell', () => {
  for (const row of [DONE_ROW, SHELL_ROW]) {
    const r = composing(workerScreen(row, ['❯ ' + SUGGESTION, '..' + 'd'.repeat([...SUGGESTION].length)]));
    assert.equal(r.box, '', row);
    assert.equal(r.composing, false, row);
  }
});

test('an earlier "cannot tell" (Tab, arrow keys) is cleared once the box on screen shows only the suggestion', () => {
  const r = composing(workerScreen(DONE_ROW, ['❯ ' + SUGGESTION, '..' + 'd'.repeat([...SUGGESTION].length)]), { unknown: true });
  assert.equal(r.composing, false);
  assert.equal(r.entry.typing.unknown, false);
});

test('a suggestion drawn in a gray colour, or with the caret inverse on its first letter, is not a draft either', () => {
  const gray = composing(workerScreen(DONE_ROW, ['❯ ' + SUGGESTION, '..' + 'c'.repeat([...SUGGESTION].length)]));
  assert.equal(gray.composing, false);
  const caret = composing(workerScreen(DONE_ROW, ['❯ ' + SUGGESTION, '..i' + 'd'.repeat([...SUGGESTION].length - 1)]));
  assert.equal(caret.composing, false);
});

test('a narrow column wraps the suggestion onto a second row inside the box; still no draft', () => {
  const rows = [plain('  ⏺ 好了。'), plain(''), plain(DONE_ROW), RULE,
    ['❯ 等接电后跑全量 E2E，然后', '..' + 'd'.repeat(14)], ['  再跑相关的定向用例', '  ' + 'd'.repeat(9)], RULE, ...STATUS_LINE];
  const r = composing(rows);
  assert.equal(r.box, '');
  assert.equal(r.composing, false);
});

test('the Captain\'s layout (no rules, count under the prompt) with a suggestion is not a draft', () => {
  const rows = [plain('  ⏺ 现在只有这一个会话在干活。'), plain(''), plain('❯ ' + SUGGESTION), plain('✻ Cogitated for 27s · done 12:06 PM · 3 shells still running')];
  rows[2] = ['❯ ' + SUGGESTION, '..' + 'd'.repeat([...SUGGESTION].length)];
  const r = composing(rows);
  assert.equal(r.box, '');
  assert.equal(r.composing, false);
});

test('text a person typed is a draft: the tell waits and never types over it', () => {
  const typed = '我先写一半';
  for (const rows of [
    workerScreen(SHELL_ROW, ['❯ ' + typed]),
    workerScreen(DONE_ROW, ['❯ ' + typed + SUGGESTION, '..' + '.'.repeat(typed.length) + 'd'.repeat([...SUGGESTION].length)]),
    [plain('  ⏺ 好了。'), plain('❯ ' + typed), plain(SHELL_ROW)],
  ]) {
    const r = composing(rows);
    assert.equal(r.box, typed);
    assert.equal(r.composing, true);
  }
});

test('keys the user pressed a moment ago, or a tracked unsent line, still count while the box shows a suggestion', () => {
  const rows = workerScreen(DONE_ROW, ['❯ ' + SUGGESTION, '..' + 'd'.repeat([...SUGGESTION].length)]);
  assert.equal(composing(rows, { lastKeyAt: Date.now() }).composing, true);
  assert.equal(composing(rows, { draft: '半句话' }).composing, true);
});

// ---- a shell that is the only thing running ----
const classifyContext = vm.createContext({ MainCore: M });
vm.runInContext(source.slice(source.indexOf('const WORKING_RE'), source.indexOf('function setDot')) +
  source.slice(source.indexOf('function statusScreen'), source.indexOf('// Format elapsed ms')), classifyContext);
const { classify, backgroundOnlyState } = classifyContext;
const screenOf = (rows) => rows.map(([text]) => text).join('\n');
const cmd = 'claude --dangerously-skip-permissions';
const SUGGESTED = ['❯ ' + SUGGESTION];
const finished = { alive: true, state: 'done', hasWorked: true, lastOutputAt: 1 };

test('a finished turn with a background shell stays yellow for the light, but the prompt is free for a tell', () => {
  const shell = screenOf(workerScreen(SHELL_ROW, SUGGESTED));
  assert.equal(M.claudeBackgroundTasks(shell, cmd), true);
  assert.equal(classify(shell, finished, cmd, false), 'working', 'the status light and receipt clocks keep waiting');
  assert.equal(classify(shell, finished, cmd, false, true), 'done', 'read without the count, the turn is over');
  assert.equal(backgroundOnlyState('working', false, shell, finished, cmd), true);
  const tell = { ...finished, state: 'working', backgroundOnly: true, lastScreen: shell };
  assert.equal(M.workingForSend(tell), false);
  assert.equal(M.tellWaitReason({ entry: tell, composing: false, screen: shell, cmd }), '');
});

test('a shell and a monitor, or a wrapped status row, are the same: free for a tell', () => {
  for (const row of [DONE_ROW + ' · 1 shell, 1 monitor still running', '✻ Baked for 40s · done 8:27 AM · 1\nshell, 1 monitor still running']) {
    const screen = screenOf(workerScreen(row, SUGGESTED));
    assert.equal(backgroundOnlyState('working', false, screen, finished, cmd), true, row);
  }
});

test('real work is still busy: a spinner, a permission question, a quota wait', () => {
  const spinner = screenOf([plain('✻ Philosophizing… (4m 10s · esc to interrupt)'), plain(''), RULE, plain('❯ '), RULE, ...STATUS_LINE]);
  assert.equal(backgroundOnlyState('working', false, spinner, finished, cmd), false);
  // the same count with a live spinner above the prompt is a running turn, not an idle prompt
  const both = screenOf([plain('✻ Philosophizing… (4m 10s · esc to interrupt)'), plain(SHELL_ROW), RULE, plain('❯ '), RULE, ...STATUS_LINE]);
  assert.equal(backgroundOnlyState('working', false, both, finished, cmd), false);
  const busy = { ...finished, state: 'working', lastScreen: spinner };
  assert.match(M.tellWaitReason({ entry: busy, composing: false, screen: spinner, cmd }), /干活/);
  const staleFlag = { ...busy, backgroundOnly: false };
  assert.match(M.tellWaitReason({ entry: staleFlag, composing: false, screen: spinner, cmd }), /干活/);
  const quota = { ...finished, state: 'quota', backgroundOnly: true };
  assert.match(M.tellWaitReason({ entry: quota, composing: false, screen: '', cmd }), /额度/);
});

test('the Captain and sessions with nothing running never get the background-only mark', () => {
  const shell = screenOf(workerScreen(SHELL_ROW, SUGGESTED));
  assert.equal(backgroundOnlyState('working', true, shell, finished, cmd), false);
  const none = screenOf(workerScreen(DONE_ROW, SUGGESTED));
  assert.equal(backgroundOnlyState('done', false, none, finished, cmd), false);
  assert.equal(backgroundOnlyState('working', false, none, finished, cmd), false, 'working for another reason');
});

test('a real draft still blocks a tell while the shell runs', () => {
  const shell = screenOf(workerScreen(SHELL_ROW, ['❯ 半句话']));
  const entry = { ...finished, state: 'working', backgroundOnly: true, lastScreen: shell };
  assert.equal(M.tellWaitReason({ entry, composing: true, screen: shell, cmd }), '输入框里有未发送的草稿');
});

// ---- Claude Code's own switch, set only for sessions the 队长 opened ----
test('sessions the 队长 opened start Claude Code with prompt suggestions off; others keep the user\'s setting', () => {
  const env = { PATH: '/bin', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '1' };
  assert.equal(AgentSessions.crewEnvironment(env, true).CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, '0');
  assert.equal(AgentSessions.crewEnvironment(env, true).PATH, '/bin');
  assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, '1', 'the input is not changed');
  assert.deepEqual(AgentSessions.crewEnvironment({ PATH: '/bin' }, false), { PATH: '/bin' });
  assert.deepEqual(AgentSessions.crewEnvironment({ PATH: '/bin' }, undefined), { PATH: '/bin' });
});

test('the crew flag travels renderer -> preload -> main and only a literal true counts', () => {
  const preload = fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8');
  const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  assert.match(source, /boundSeat\.configDir, !!col\.captainCrew && !col\.isMain\)/);
  assert.match(preload, /ptySpawn: \(id, cwd, cols, rows, managed, seatId, configDir, crew\) => ipcRenderer\.send\('pty:spawn', \{[^}]*\bcrew\b/);
  assert.match(main, /spawnPty\(id, cwd, cols, rows, !!managed, seatId, configDir, crew === true\)/);
  assert.match(main, /AgentSessions\.crewEnvironment\(\{ \.\.\.AgentSessions\.clearInheritedSessionIds\(ENV\)/);
});
