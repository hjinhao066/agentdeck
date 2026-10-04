'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const B = require('../board-core');

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const chatUiSrc = fs.readFileSync(path.join(__dirname, '..', 'chat-ui.js'), 'utf8');

// Extract WORKING_RE and AGENT_IDLE_RE directly from renderer.js source
const workingMatch = rendererSrc.match(/const WORKING_RE = (\/.*\/[a-z]*);/);
assert.ok(workingMatch, 'renderer.js must define WORKING_RE');
const WORKING_RE = eval(workingMatch[1]);

const agentIdleMatch = rendererSrc.match(/const AGENT_IDLE_RE = (\/.*\/[a-z]*);/);
assert.ok(agentIdleMatch, 'renderer.js must define AGENT_IDLE_RE');
const AGENT_IDLE_RE = eval(agentIdleMatch[1]);

test('WORKING_RE matches Cursor Agent working indicators', () => {
  // Cursor shows "Working", "ctrl+c to stop", and braille spinners
  assert.match('Working (4s • esc to interrupt)', WORKING_RE);
  assert.match('ctrl+c to stop', WORKING_RE);
  assert.match('Working...', WORKING_RE);
  assert.match('Working', WORKING_RE);

  // Cursor uses unicode braille symbols across U+2800 to U+28FF
  const brailleChars = ['⠋', '⠙', '⠠', '⠛', '⠘', '⠤', '⠣', '⠰', '⠳', '⠀', '⠞', '⠜'];
  for (const ch of brailleChars) {
    assert.match(`  ${ch} Reading files...`, WORKING_RE);
  }

  // Classic indicators continue to work
  assert.match('esc to interrupt', WORKING_RE);
  assert.match('Running…', WORKING_RE);
  assert.match('Running...', WORKING_RE);
  assert.match('⎿  Running', WORKING_RE);
  assert.match('↑ 1.2k tokens', WORKING_RE);
});

test('AGENT_IDLE_RE matches Cursor Agent idle placeholder prompts', () => {
  assert.match('Plan, search, build anything', AGENT_IDLE_RE);
  assert.match('Add a follow-up', AGENT_IDLE_RE);
  assert.match('Build anything', AGENT_IDLE_RE);
  assert.match('bypass permissions', AGENT_IDLE_RE);
  assert.match('❯ ', AGENT_IDLE_RE);
});

test('Cursor readiness requires bracketedPasteMode and prompt match, rejecting premature quiet fallback', () => {
  // Emulate the sendWhenReady logic from renderer.js
  function checkReady(col, entry, started, quiet) {
    const isCursor = (B.inferAgentType(col.cmd) === 'Cursor') || /cursor-agent\b/i.test(col.cmd || '');
    const cursorReady = isCursor && AGENT_IDLE_RE.test(entry.lastScreen || '') && !!(entry.term && entry.term.modes && entry.term.modes.bracketedPasteMode);
    return isCursor ? cursorReady : (!col.cmd || AGENT_IDLE_RE.test(entry.lastScreen || '') || (Date.now() - started > 15000 && quiet > 3000));
  }

  const cursorCol = { cmd: 'cursor-agent --force --model grok-4.7-high-fast' };

  // Case 1: Cursor starting up, screen quiet >3s after 16s, but TUI not yet bracketed
  const entryUnbracketed = {
    lastScreen: 'Starting cursor-agent...',
    term: { modes: { bracketedPasteMode: false } }
  };
  assert.equal(checkReady(cursorCol, entryUnbracketed, Date.now() - 20000, 4000), false,
    'Cursor must not be marked ready before bracketedPasteMode is enabled');

  // Case 2: Cursor bracketed mode active, but prompt not rendered yet
  const entryBracketedNoPrompt = {
    lastScreen: 'Initializing model...',
    term: { modes: { bracketedPasteMode: true } }
  };
  assert.equal(checkReady(cursorCol, entryBracketedNoPrompt, Date.now() - 5000, 500), false,
    'Cursor must not be marked ready before idle prompt matches');

  // Case 3: Cursor bracketed mode active and prompt displayed
  const entryReady = {
    lastScreen: 'Plan, search, build anything\nModel: Grok',
    term: { modes: { bracketedPasteMode: true } }
  };
  assert.equal(checkReady(cursorCol, entryReady, Date.now() - 5000, 500), true,
    'Cursor is ready once bracketedPasteMode is active and idle prompt matches');

  // Case 4: Non-cursor unknown command still falls back to quiet timeout
  const unknownCol = { cmd: 'custom-tool' };
  const entryUnknown = { lastScreen: 'some output', term: { modes: {} } };
  assert.equal(checkReady(unknownCol, entryUnknown, Date.now() - 20000, 4000), true,
    'Non-cursor commands retain quiet-fallback readiness');
});

test('ChatUI enforces minWait >= 700ms for Cursor Agent paste settling', () => {
  // Verify chatUiSrc contains Cursor-specific paste delay and follow-up enter safeguard
  assert.match(chatUiSrc, /const isCursor = .*inferAgentType.*cursor-agent/);
  assert.match(chatUiSrc, /const minWait = isCursor \? 700 :/);
  assert.match(chatUiSrc, /if \(isCursor\) \{[\s\S]*?setTimeout\([\s\S]*?window\.deck\.ptyInput\(col\.id, '\\r'\);[\s\S]*?600\);/);
});

// ---- narrow columns: a wrapped Cursor prompt is still idle, a busy one never is ----
const vm = require('vm');
const M = require('../main-core');
const ctx = vm.createContext({ MainCore: M });
vm.runInContext(rendererSrc.slice(rendererSrc.indexOf('const WORKING_RE'), rendererSrc.indexOf('const DOT_TIP')), ctx);
const CURSOR = 'cursor-agent --force --model claude-opus-5-5-high';
const idle = (screen, cmd = CURSOR, state = 'plain') => ctx.terminalIdle({ cmd }, { alive: true, state, lastScreen: screen });

// Real cursor-agent screens captured at 30 columns (a 260px column, the minimum width).
const NARROW = {
  'claude-opus-5-5-high': ['  Cursor Agent', '  v2026.10.01-e373342', '  Tip: Use subagents to', '  parallelize work and', '  preserve context.', '', '  → Plan, search, build', '    anything', '', '  Claude      Run Everything', '  Opus 5.5', '  300K High', '  ~'],
  'grok-4.7-high-fast': ['  Cursor Agent', '  v2026.10.01-e373342', '  Tip: Use /debug to', '  instrument and debug', '  complex problems.', '', '  → Plan, search, build', '    anything', '', '  Grok 4.7    Run Everything', '  256K High', '  Fast', '  ~'],
};

test('a Cursor prompt wrapped by a narrow column is idle, for every model', () => {
  for (const [model, rows] of Object.entries(NARROW)) {
    const screen = rows.join('\n');
    assert.equal(AGENT_IDLE_RE.test(screen), false, `${model}: no whole marker on the raw wrapped screen`);
    assert.equal(M.cursorActivity(screen), 'idle', model);
    assert.equal(idle(screen), true, model);
  }
  assert.equal(idle('  → Plan, search,\n    build\n    anything\n\n  Run Everything'), true, 'wrapped over three rows');
  assert.equal(idle('  → Add a follow-up\n\n  Claude Opus 5.5 300K High   Run Everything'), true, 'unwrapped is unchanged');
});

test('a busy narrow Cursor screen with a wrapped prompt is never idle and gets nothing injected', () => {
  const prompt = ['', '  → Plan, search, build', '    anything', '', '  Claude      Run Everything', '  Opus 5.5', '  ~'];
  for (const busyRow of ['  ⠋ Reading…', '  ⠰⠳ Grepping  32.91k tokens', '  ✻ Thinking… (4s)', '  Running…', '  Editing...', '  Working (4s • esc to interrupt)', '  ctrl+c to stop']) {
    const screen = [busyRow, ...prompt].join('\n');
    assert.equal(M.cursorActivity(screen) === 'idle', false, busyRow);
    assert.equal(idle(screen), false, busyRow);
  }
  // the stop hint wraps with the prompt, or states already say so
  assert.equal(idle('  → Add a follow-up   ctrl+c to\n    stop\n\n  Run Everything'), false);
  assert.equal(M.cursorActivity('  → Add a follow-up   ctrl+c to\n    stop'), 'working');
  assert.equal(idle(NARROW['claude-opus-5-5-high'].join('\n'), CURSOR, 'working'), false);
  assert.equal(idle(NARROW['claude-opus-5-5-high'].join('\n'), CURSOR, 'input'), false);
  assert.equal(idle(NARROW['claude-opus-5-5-high'].join('\n'), CURSOR, 'quota'), false);
});

test('only the rows right after the prompt are joined, and the words need boundaries', () => {
  // footer rows are not continuation: "Plan, search, build" + a footer row is no prompt
  assert.equal(M.cursorActivity('  → Plan, search, build\n  anything else\n  ~'), '');
  assert.equal(M.cursorActivity('  → Rebuild anything'), '');
  assert.equal(M.cursorActivity('  → Plan, search, build anything now'), '');
  assert.equal(AGENT_IDLE_RE.test('Rebuild anything'), false);
  assert.equal(AGENT_IDLE_RE.test('Plan, search, build anything'), true);
  assert.equal(AGENT_IDLE_RE.test('Build anything'), true);
  assert.equal(AGENT_IDLE_RE.test('Add a follow-up'), true);
  assert.equal(M.cursorActivity('Starting cursor-agent...\n  Cursor Agent\n  v2026.10.01'), '');
});

test('a Cursor screen whose footer matches the idle marker is still not idle while a busy row is on it', () => {
  const busyWrapped = '  ⠋ Reading…\n\n  → Plan, search, build\n    anything\n\n  Composer 2   Run Everything';
  assert.equal(AGENT_IDLE_RE.test(busyWrapped), true, 'the footer alone would pass the marker');
  assert.equal(idle(busyWrapped), false);
  assert.equal(idle('Status stand-in ready\n❯\nClaude Code'), true, 'a Cursor screen without an arrow row keeps the marker rule');
  assert.equal(idle('Editing...\n❯\nClaude Code'), false);
});

test('first-task delivery (whenTerminalReady) and sendWhenReady share the busy-aware check', () => {
  assert.match(rendererSrc, /const ready = entry && entry\.alive && \(!col\.cmd \|\| terminalIdle\(col, entry\)\);/);
  assert.match(rendererSrc, /const cursorReady = isCursor && terminalIdle\(col, entry\) && /);
  const claude = '✻ Contemplating… (11m 27s · esc to interrupt)\n❯';
  assert.equal(idle(claude, 'claude', 'working'), false, 'working state blocks any agent');
  assert.equal(idle('Working… (4s • esc to interrupt)\nClaude Code', 'claude'), false, 'busy rows block even before the state catches up');
  assert.equal(idle('bypass permissions on\n❯', 'claude'), true);
});
