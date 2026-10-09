// Standalone probe (no Electron, no AgentDeck window): types prompts into a real
// Codex through a real PTY (ConPTY on Windows) the way AgentDeck does, and compares
// each with what Codex then asks its model. Codex talks only to a local stand-in API.
//   node scripts/probe-codex-input.js <strategies> <lengths> [--keep-screen]
//   e.g. node scripts/probe-codex-input.js legacy,win32 200,8000
// "legacy" is the old single bracketed-paste write; "win32" is MainCore.winCodexKeys, what
// AgentDeck now writes to Codex on Windows. One Codex serves all cases.
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const mockApi = require('../tests/e2e/fixtures/mock-model-api');
const M = require('../main-core');

const strategies = (process.argv[2] || 'win32').split(',');
const lengths = (process.argv[3] || '200').split(',').map(Number);

// A prompt of `n` characters with the troublesome parts: blank lines, CJK, long dashes, curly quotes.
function sample(n) {
  const rows = [`[probe-${Math.random().toString(36).slice(2, 8)}]`, '第一行：开头——测试 AgentDeck 发给 Codex 的多行文字', '', '## 标题——带长破折号', '- 条目 A — 英文短破折号', '- 条目 B ——— 三连', ''];
  let i = 0;
  let text = rows.join('\n');
  while (text.length < n) text += `\n第 ${++i} 段——这一行用来凑长度，包含 “引号”、（括号）和 emoji 🙂。`;
  return [...(text + '\n最后一行：完。')].slice(0, n).join('');
}
const ascii = (v) => JSON.stringify(v).replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const api = await mockApi.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-codex-'));
  const real = path.resolve(__dirname, '../tests/e2e/fixtures/real-cli.js');
  const term = pty.spawn(process.execPath, [real, 'codex', String(api.port), path.join(dir, 'home')], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: dir, env: process.env,
    ...(process.platform === 'win32' ? { useConpty: true } : {}),
  });
  let screen = '';
  let lastOut = Date.now();
  term.onData((d) => { screen += d; lastOut = Date.now(); if (screen.length > 400000) screen = screen.slice(-200000); });
  const quiet = async (ms, max) => { const t0 = Date.now(); while (Date.now() - t0 < max && Date.now() - lastOut < ms) await sleep(50); };
  const waitStart = Date.now();
  while (!/OpenAI Codex|›/.test(screen) && Date.now() - waitStart < 30000) await sleep(200);
  await quiet(1500, 15000);

  let failures = 0;
  for (const strategy of strategies) {
    for (const length of lengths) {
      const text = sample(length);
      const writes = strategy === 'legacy' ? [{ data: '\x1b[200~' + text + '\x1b[201~' }] : M.winCodexKeys(text).map((data) => ({ data, delay: M.WIN_CODEX_KEY_DELAY }));
      for (const w of writes) { if (w.delay) await sleep(w.delay); term.write(w.data); }
      const t0 = Date.now();
      await quiet(700, 90000);
      const settled = Date.now() - t0;
      term.write('\r');
      const head = text.slice(0, 14);
      const sent = () => api.userTexts().filter((t) => t.startsWith(head));
      let enters = 1;
      for (let i = 0; i < 360 && !sent().length; i++) {
        await sleep(250);
        if (i === 100 || i === 200) { term.write('\r'); enters++; }
      }
      const got = sent().sort((a, b) => b.length - a.length)[0] || '';
      const identical = got === text;
      let at = -1;
      if (!identical) { at = 0; while (at < got.length && at < text.length && got[at] === text[at]) at++; failures++; }
      console.log(ascii({
        platform: process.platform, strategy, sentChars: text.length, receivedChars: got.length, identical, enters, settledMs: settled,
        firstDiffAt: at, expectedAround: at < 0 ? '' : text.slice(Math.max(0, at - 10), at + 12), gotAround: at < 0 ? '' : got.slice(Math.max(0, at - 10), at + 12),
      }));
      if (!identical && process.argv.includes('--keep-screen')) console.log(ascii({ gotText: got.slice(0, 500), screenTail: screen.slice(-600) }));
      await quiet(2500, 15000);
    }
  }
  try { term.kill(); } catch (_) {}
  await sleep(1500);
  try { await api.close(); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch (_) {}
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
