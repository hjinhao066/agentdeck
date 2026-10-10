'use strict';
// Claude Code 2.1.29x asks once per seat, right after it starts: "Make auto mode your default
// permission mode?" Its default row is "Yes, set auto mode as my default permission mode". On
// 2026-10-09 an AgentDeck dispatch pressed its Enter into that menu: ~/.claude/settings.json got
// permissions.defaultMode "auto" and the new bypass sessions ran in auto mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const M = require('../claude-seats-main');
const ChatCore = require('../chat-core');
const MainCore = require('../main-core');

const SEATS = [
  { id: 'cn', configDir: '~/.claude' },
  { id: 'us', configDir: '~/.claude-us' },
  { id: 'us2', configDir: '~/.claude-us2' },
];
function seatHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-nudge-'));
  for (const dir of ['.claude', '.claude-us', '.claude-us2']) fs.mkdirSync(path.join(home, dir));
  const account = (email) => ({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: email }, projects: { 'C:/repo': { hasTrustDialogAccepted: true } } });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(account('cn@example.test')));
  fs.writeFileSync(path.join(home, '.claude-us', '.claude.json'), JSON.stringify(account('us@example.test')));
  fs.writeFileSync(path.join(home, '.claude-us2', '.claude.json'), JSON.stringify(account('us2@example.test')));
  for (const dir of ['.claude', '.claude-us', '.claude-us2']) fs.writeFileSync(path.join(home, dir, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }));
  return home;
}
// Stand-in for Claude's startup: the nudge shows unless the seat's global file says it was seen
// (the same condition Claude checks); an Enter on it takes the default row and writes "auto".
function launchClaudeAndPressEnter(seat, home) {
  const loc = M.credentialLocation(seat, home);
  const global = JSON.parse(fs.readFileSync(loc.metadataPath, 'utf8'));
  if (global.hasSeenAutoDefaultNudge === true) return 'prompt';
  const settingsFile = path.join(loc.dir, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, permissions: { defaultMode: 'auto' } }));
  fs.writeFileSync(loc.metadataPath, JSON.stringify({ ...global, hasSeenAutoDefaultNudge: true }));
  return 'nudge answered Yes';
}

test('without the fix, the stand-in shows the nudge on every seat that has not seen it and Enter switches it to auto', () => {
  const home = seatHome();
  for (const seat of SEATS) {
    assert.equal(launchClaudeAndPressEnter(seat, home), 'nudge answered Yes');
    const settings = JSON.parse(fs.readFileSync(path.join(M.credentialLocation(seat, home).dir, 'settings.json'), 'utf8'));
    assert.equal(settings.permissions.defaultMode, 'auto');
  }
});

test('declining before launch keeps all three seats (CN, US, US2) in their own mode', async () => {
  const home = seatHome();
  for (const seat of SEATS) {
    const before = JSON.parse(fs.readFileSync(M.credentialLocation(seat, home).metadataPath, 'utf8'));
    assert.deepEqual(await M.declineAutoModeNudge(seat, home), { ok: true, changed: true });
    const after = JSON.parse(fs.readFileSync(M.credentialLocation(seat, home).metadataPath, 'utf8'));
    // only the "seen" answer is added; the account, onboarding and trusted folders stay as they were
    assert.deepEqual(after, { ...before, hasSeenAutoDefaultNudge: true });
    assert.equal(launchClaudeAndPressEnter(seat, home), 'prompt');
    const settings = JSON.parse(fs.readFileSync(path.join(M.credentialLocation(seat, home).dir, 'settings.json'), 'utf8'));
    assert.equal(settings.permissions, undefined, `${seat.id} settings.json must not get a defaultMode`);
  }
  // the default seat's answer goes in ~/.claude.json, the others in <configDir>/.claude.json
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).hasSeenAutoDefaultNudge, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude-us2', '.claude.json'), 'utf8')).hasSeenAutoDefaultNudge, true);
});

test('an answer already recorded is not rewritten; a missing or damaged seat file is never created or replaced', async () => {
  const home = seatHome();
  const file = path.join(home, '.claude-us', '.claude.json');
  await M.declineAutoModeNudge(SEATS[1], home);
  const stamp = fs.statSync(file).mtimeMs, text = fs.readFileSync(file, 'utf8');
  assert.deepEqual(await M.declineAutoModeNudge(SEATS[1], home), { ok: true, changed: false });
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.statSync(file).mtimeMs, stamp);

  fs.writeFileSync(path.join(home, '.claude-us2', '.claude.json'), '{"oauthAccount": ');
  const damaged = await M.declineAutoModeNudge(SEATS[2], home);
  assert.equal(damaged.ok, false);
  assert.equal(fs.readFileSync(path.join(home, '.claude-us2', '.claude.json'), 'utf8'), '{"oauthAccount": ');

  const fresh = { id: 'kr', configDir: '~/.claude-kr' };
  fs.mkdirSync(path.join(home, '.claude-kr'));
  assert.equal((await M.declineAutoModeNudge(fresh, home)).ok, false);
  assert.equal(fs.existsSync(path.join(home, '.claude-kr', '.claude.json')), false);
  assert.equal(fs.readdirSync(path.join(home, '.claude-kr')).length, 0, 'no lock or temp file left behind');
});

test('every Claude launch goes through the decline, for the seat its terminal was started with', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const handler = main.slice(main.indexOf("handleMain('pty:prepare-launch'"), main.indexOf('const ptySeats = new Map();'));
  assert.match(handler, /ClaudeSeatsCore\.claudeLaunch\(command\) && ptySeatDefs\.has\(id\)[\s\S]*await declineAutoModeNudge\(ptySeatDefs\.get\(id\), trustHome\)/);
  assert.ok(handler.indexOf('declineAutoModeNudge') < handler.indexOf('prepareWorkspaceTrust('), 'answered before the command is handed back to be typed');
  assert.match(main, /ptySeats\.set\(id, binding\);\n\s*ptySeatDefs\.set\(id, selectedSeat\);/);
});

// ---- the screen: the nudge is a menu, never an idle prompt ----
const renderer = fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8');
const rctx = vm.createContext({ MainCore, env: { platform: 'win32' } });
vm.runInContext(renderer.slice(renderer.indexOf('const WORKING_RE'), renderer.indexOf('function setDot')) +
  renderer.slice(renderer.indexOf('function statusScreen'), renderer.indexOf('// Format elapsed ms')), rctx);
const NUDGE = [
  '╭──────────────────────────────────────────╮',
  '│ Make auto mode your default permission   │',
  '│ mode?                                    │',
  '│                                          │',
  '│ Auto mode lets Claude handle permission  │',
  '│ prompts automatically.                   │',
  '│                                          │',
  '│ ❯ Yes, set auto mode as my default       │',
  '│   permission mode                        │',
  '│   No, keep bypass permissions            │',
  '╰──────────────────────────────────────────╯',
];
test('Claude\'s auto mode nudge reads as a menu (with or without row numbers), so nothing is typed into it', () => {
  for (const screen of [NUDGE, NUDGE.map((l) => l.replace('❯ Yes', '❯ 1. Yes').replace('  No, keep', '  2. No, keep'))]) {
    const text = screen.join('\n');
    assert.equal(rctx.classify(text, { state: 'plain', hasWorked: false }, 'claude --dangerously-skip-permissions'), 'input');
    assert.equal(rctx.terminalIdle({ cmd: 'claude' }, { alive: true, state: 'input', lastScreen: text }), false);
  }
  // its "No, keep bypass permissions" row alone used to satisfy the idle-prompt pattern
  assert.equal(vm.runInContext('AGENT_IDLE_RE', rctx).test(NUDGE.join('\n')), true);
  // an ordinary idle Claude prompt is still idle
  const idle = ['⏺ Done.', '', '────────', '❯ ', '────────', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
  assert.equal(rctx.classify(idle, { state: 'done', hasWorked: true }, 'claude'), 'done');
});

// ---- the Enter: a menu that comes up between the paste and the Enter is not answered ----
const chatUi = fs.readFileSync(path.join(__dirname, '../chat-ui.js'), 'utf8');
const body = chatUi.slice(chatUi.indexOf('  const PASTE_READ_MAX = 30_000;'), chatUi.indexOf('  // Resolves to the turn (or true) once the file is written'));
const lines = (rows) => ({ rows: rows.length, cols: 44, buffer: { active: { baseY: 0, getLine: (y) => rows[y] === undefined ? undefined : { isWrapped: false, translateToString: () => rows[y] } } } });
function sender(menuAfterPaste, echoed) {
  const sent = [], toasts = [], pending = new Map();
  const prompt = ['────────', '❯ ', '────────', '  ⏵⏵ bypass permissions on'];
  const entry = { alive: true, state: 'plain', term: lines(prompt), lastOutputAt: 0 };
  entry.term.modes = { bracketedPasteMode: true };
  const host = {
    terms: new Map([['w', entry]]), platform: 'win32',
    dumpScreen: () => prompt.join('\n'), shellQuote: (p) => p, manualPromptSent() {}, userComposing: () => false, maybeAutoName() {},
    showToast: (t) => toasts.push(t), columnLabel: () => '会话',
    menuOnScreen: (term, sent) => rctx.menuOnScreen(term, sent),
  };
  const turn = { id: 't', done: false };
  const context = vm.createContext({
    C: ChatCore, host, Date, setTimeout, Promise, pending, refreshTurn() {}, scheduleSave() {},
    window: { deck: { ptyInput: (id, data) => {
      sent.push(data);
      // Claude mounts its startup question after the prompt was drawn: the paste lands, then the menu replaces the box
      if (data.startsWith('\x1b[200~')) {
        entry.lastOutputAt = Date.now();
        // Claude shows a short paste in its input box
        if (echoed) entry.term = Object.assign(lines(['────────', ...echoed, '────────', '  ⏵⏵ bypass permissions on']), { modes: entry.term.modes });
        if (menuAfterPaste) entry.term = Object.assign(lines(NUDGE), { modes: entry.term.modes }); }
    }, notifyCancel() {} }, MainSession: null, MainCore, BoardCore: { inferAgentType: () => 'Claude' } },
    beginTurn: () => { pending.set('w', { turn }); return turn; },
  });
  vm.runInContext(body, context);
  return { context, sent, toasts, turn, pending };
}
test('the Enter is not pressed when Claude\'s auto mode menu came up after the readiness check', async () => {
  const { context, sent, toasts, turn, pending } = sender(true);
  const result = await context.sendPrompt({ id: 'w', cmd: 'claude' }, '任务正文', null, {});
  assert.equal(result, false);
  assert.equal(sent.filter((d) => d === '\r').length, 0, 'no Enter goes into the menu (its default row is Yes)');
  assert.equal(turn.interrupted, true);
  assert.equal(pending.has('w'), false);
  assert.match(toasts[0], /确认菜单/);
});
test('with no menu the prompt is submitted as before', async () => {
  const { context, sent } = sender(false);
  assert.ok(await context.sendPrompt({ id: 'w', cmd: 'claude' }, '任务正文', null, {}));
  assert.equal(sent.filter((d) => d === '\r').length, 1);
});
test('a task whose own text looks like a menu (shown in the input box) is still submitted', async () => {
  const task = ['照下面做：', '1. Yes, I accept 的框不要点', '2. 碰到 (y/n) 一律答 n'].join('\n');
  const { context, sent } = sender(false, ['❯ 照下面做：', '  1. Yes, I accept 的框不要点', '  2. 碰到 (y/n) 一律答 n']);
  assert.ok(await context.sendPrompt({ id: 'w', cmd: 'claude' }, task, null, {}));
  assert.equal(sent.filter((d) => d === '\r').length, 1);
});

// Review 2026-10-09: the first version matched the menu's words anywhere, so an idle Claude whose reply
// talked about this very menu read as 停在确认 and a tell's Enter was refused. Only the menu's own row
// shape counts: the ❯ cursor on a row that is nothing but one of its options.
const REPLY_ABOUT_IT = [
  '⏺ Found it. Claude asks "Make auto mode your default permission mode?" once per seat, and Enter picks',
  '  "Yes, set auto mode as my default permission mode"; declining means "No, keep bypass permissions".',
  '  The menu rows were:',
  '  Make auto mode your default permission mode?',
  '  No, keep bypass permissions',
  '  2. Yes, I accept',
  '  No, exit',
  '',
  '────────', '❯ ', '────────', '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
];
test('a reply that talks about the menu, even quoting its rows, is not the menu', async () => {
  const text = REPLY_ABOUT_IT.join('\n');
  assert.equal(rctx.classify(text, { state: 'done', hasWorked: true }, 'claude'), 'done');
  assert.equal(rctx.menuOnScreen(lines(REPLY_ABOUT_IT), '下一步'), false);
  // and a tell still goes in
  const { context, sent } = sender(false, [...REPLY_ABOUT_IT.slice(0, -4), '────────', '❯ 下一步', '────────', '  ⏵⏵ bypass permissions on']);
  assert.ok(await context.sendPrompt({ id: 'w', cmd: 'claude' }, '下一步', null, {}));
  assert.equal(sent.filter((d) => d === '\r').length, 1);
});
test('the real menus still read as menus: cursor on either row, with or without numbers or a box', () => {
  const nudge = (cursorOnNo) => ['Make auto mode your default permission mode?', '',
    (cursorOnNo ? '  ' : '❯ ') + 'Yes, set auto mode as my default permission mode', (cursorOnNo ? '❯ ' : '  ') + 'No, keep bypass permissions'];
  for (const screen of [nudge(false), nudge(true), NUDGE, ['WARNING: Claude Code running in Bypass Permissions mode', '❯ No, exit', '  Yes, I accept'],
    ['WARNING: Claude Code running in Bypass Permissions mode', '❯ 1. No, exit', '  2. Yes, I accept']]) {
    assert.equal(rctx.classify(screen.join('\n'), { state: 'plain', hasWorked: false }, 'claude'), 'input', screen.join(' / '));
    assert.equal(rctx.menuOnScreen(lines(screen), '任务正文'), true);
  }
});
