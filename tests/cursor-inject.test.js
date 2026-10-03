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
