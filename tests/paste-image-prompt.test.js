'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ChatCore = require('../chat-core');
const MainCore = require('../main-core');

// ChatUI.sendPrompt, cut out of chat-ui.js and run against a stand-in terminal.
const source = fs.readFileSync(path.join(__dirname, '../chat-ui.js'), 'utf8');
const body = source.slice(source.indexOf('  const PASTE_READ_MAX = 30_000;'), source.indexOf('  // Resolves to the turn (or true) once the file is written'));

function harness({ footerAt }) {
  const sent = [];
  const t0 = Date.now();
  const entry = { alive: true, state: 'done', term: { modes: { bracketedPasteMode: true } }, lastOutputAt: 0 };
  const host = {
    terms: new Map([['w', entry]]),
    // the footer row says "Pasting…" until footerAt ms after the paste, as Claude Code does while it reads an image
    dumpScreen: () => (Date.now() - t0 < footerAt ? '❯ \n────────\nPasting…' : '❯ [Image #1]看图\n────────\n  ⏵⏵ auto mode on'),
    shellQuote: (p) => p, manualPromptSent() {}, userComposing: () => false, maybeAutoName() {}, showToast() {},
  };
  const context = vm.createContext({
    C: ChatCore, host, Date, setTimeout, Promise,
    window: { deck: { ptyInput: (id, data) => sent.push({ data, at: Date.now() - t0 }), notifyCancel() {} }, MainSession: null, MainCore, BoardCore: { inferAgentType: () => 'Claude' } },
    beginTurn: () => ({ id: 't' }),
  });
  vm.runInContext(body, context);
  return { context, sent, entry };
}

test('Enter waits while Claude Code is still reading a pasted image, then submits once', async () => {
  const { context, sent } = harness({ footerAt: 1400 });
  const result = await context.sendPrompt({ id: 'w', cmd: 'claude' }, '看图 /tmp/big.png', null, {});
  assert.ok(result);
  const enters = sent.filter((s) => s.data === '\r');
  assert.equal(enters.length, 1, 'exactly one Enter');
  assert.ok(enters[0].at >= 1400, `Enter at ${enters[0].at}ms came before the paste was read`);
  assert.ok(sent[0].data.startsWith('\x1b[200~') && sent[0].data.includes('/tmp/big.png'), 'the whole text goes in as one paste');
  assert.ok(enters[0].at < 3000, 'and it does not wait longer than needed');
});
test('an ordinary prompt still submits after the usual short settle', async () => {
  const { context, sent } = harness({ footerAt: 0 });
  await context.sendPrompt({ id: 'w', cmd: 'claude' }, '普通任务', null, {});
  const enters = sent.filter((s) => s.data === '\r');
  assert.equal(enters.length, 1);
  assert.ok(enters[0].at >= 450 && enters[0].at < 900, `Enter at ${enters[0].at}ms`);
});
test('the wait for a pasted image is bounded', () => {
  assert.match(source, /const PASTE_READ_MAX = 30_000;/);
});
