'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ChatCore = require('../chat-core');
const MainCore = require('../main-core');

// ChatUI.sendPrompt and sendLong, cut out of chat-ui.js and run against a stand-in terminal.
// A terminal without bracketed paste reads line by line; the tty drops what a line holds past ~1 KB.
const source = fs.readFileSync(path.join(__dirname, '../chat-ui.js'), 'utf8');
const body = source.slice(source.indexOf('  const PASTE_READ_MAX = 30_000;'), source.indexOf('  // A line submitted straight in the terminal'));

function harness({ bracketed }) {
  const typed = [];
  const saved = [];
  const entry = { alive: true, state: 'done', term: { modes: { bracketedPasteMode: bracketed } }, lastOutputAt: 0 };
  const host = {
    terms: new Map([['w', entry]]),
    dumpScreen: () => '❯ ',
    shellQuote: (p) => `'${p}'`, manualPromptSent() {}, userComposing: () => false, maybeAutoName() {}, showToast() {},
  };
  const context = vm.createContext({
    C: ChatCore, host, Date, setTimeout, Promise,
    window: {
      deck: {
        ptyInput: (id, data) => typed.push(data), notifyCancel() {},
        saveLongPrompt: async (text) => { saved.push(text); return '/tmp/long-prompts/prompt-1.txt'; },
      },
      MainSession: null, MainCore, BoardCore: { inferAgentType: () => 'Claude' },
    },
    beginTurn: (col, shown) => ({ id: 't', shown }),
  });
  vm.runInContext(body, context);
  return { context, typed, saved };
}
const col = { id: 'w', cmd: 'zsh' };
const lines = (data) => data.split('\r');

test('a long Chinese prompt in a line-mode terminal goes out as a file, never cut at the tty limit', async () => {
  const { context, typed, saved } = harness({ bracketed: false });
  const prompt = '把这件事做完，'.repeat(120); // 840 characters, 2520 bytes: well under LONG_PROMPT, well over one tty line
  assert.ok(prompt.length < MainCore.LONG_PROMPT && Buffer.byteLength(prompt) > 1024);
  const turn = await context.sendPrompt(col, prompt, null, {});
  assert.ok(turn);
  assert.deepEqual(saved, [prompt], 'the whole text is saved');
  const sent = typed.filter((d) => d !== '\r').join('');
  assert.ok(Buffer.byteLength(sent) <= ChatCore.LINE_MODE_BYTES, `typed line is ${Buffer.byteLength(sent)} bytes`);
  assert.ok(!/[\r\n]/.test(sent), 'one line, so one Enter submits it');
  assert.match(sent, /^把这件事做完，/);
  assert.match(sent, /（这条消息共 840 字，完整内容已存成文件，请先完整读取再照做：\/tmp\/long-prompts\/prompt-1\.txt）/);
  assert.equal(typed.filter((d) => d === '\r').length, 1);
  assert.equal(turn.shown.includes('见附件'), true, 'the bubble still shows the opening and the attachment note');
});

test('attachments and a suffix are counted in the line budget', async () => {
  const { context, typed } = harness({ bracketed: false });
  const att = '/Users/someone/Desktop/' + 'deep/'.repeat(30) + 'image.png';
  await context.sendPrompt(col, '长'.repeat(600), [att], { suffix: ' 请直接动手。' });
  const sent = typed.filter((d) => d !== '\r').join('');
  assert.ok(Buffer.byteLength(sent) <= ChatCore.LINE_MODE_BYTES, `typed line is ${Buffer.byteLength(sent)} bytes`);
  assert.ok(sent.includes(att) && sent.endsWith('请直接动手。'));
});

test('a long line among short ones is caught; short multi-line text is untouched', async () => {
  const a = harness({ bracketed: false });
  await a.context.sendPrompt(col, `第一行\n${'x'.repeat(1100)}\n第三行`, null, {});
  assert.equal(a.saved.length, 1);
  const b = harness({ bracketed: false });
  await b.context.sendPrompt(col, `第一行\n${'中'.repeat(300)}\n第三行`, null, {});
  assert.equal(b.saved.length, 0, 'every line fits: typed as before');
  assert.equal(lines(b.typed[0]).length, 3);
});

test('a prompt that fits one line is typed as it was', async () => {
  const { context, typed, saved } = harness({ bracketed: false });
  await context.sendPrompt(col, '中'.repeat(300), null, {});
  assert.equal(saved.length, 0);
  assert.equal(typed[0], '中'.repeat(300));
});

test('a bracketed-paste terminal still takes a long prompt inline', async () => {
  const { context, typed, saved } = harness({ bracketed: true });
  const prompt = '把这件事做完，'.repeat(120);
  await context.sendPrompt(col, prompt, null, {});
  assert.equal(saved.length, 0);
  assert.equal(typed[0], '\x1b[200~' + prompt + '\x1b[201~');
});

test('a prompt past LONG_PROMPT in a line-mode terminal also gets a one-line pointer', async () => {
  const { context, typed, saved } = harness({ bracketed: false });
  const prompt = '很长的任务。'.repeat(2000);
  await context.sendPrompt(col, prompt, null, {});
  assert.equal(saved.length, 1);
  const sent = typed.filter((d) => d !== '\r').join('');
  assert.ok(Buffer.byteLength(sent) <= ChatCore.LINE_MODE_BYTES && !/[\r\n]/.test(sent));
});

test('a failed save sends nothing', async () => {
  const { context, typed } = harness({ bracketed: false });
  context.window.deck.saveLongPrompt = async () => '';
  assert.equal(await context.sendPrompt(col, '长'.repeat(600), null, {}), false);
  assert.deepEqual(typed, []);
});

test('chat-core byte helpers count UTF-8 bytes and never split a character', () => {
  assert.equal(ChatCore.utf8Length('a中😀'), 1 + 3 + 4);
  assert.equal(ChatCore.longestLineBytes('ab\n中中中\r\nc'), 9);
  assert.equal(ChatCore.longestLineBytes(''), 0);
  assert.equal(ChatCore.clipBytes('中中中', 7), '中中');
  assert.equal(ChatCore.clipBytes('a😀b', 4), 'a');
  assert.equal(ChatCore.clipBytes('abc', 0), '');
});
