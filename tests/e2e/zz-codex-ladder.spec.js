const { test, expect, _electron: electron } = require('@playwright/test');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../../main-core');
const mockApi = require('./fixtures/mock-model-api');

// Throwaway diagnostic (ci-probe branch only): which prompt lengths does the real
// CLI submit whole on this machine? One column per length, each its own CLI.
const CLI = process.env.AGENTDECK_REAL_CLI || 'codex';
const ROOT = path.resolve(__dirname, '../..');
const old = fs.readFileSync(path.join(__dirname, 'fixtures', 'old-briefing-win32.txt'), 'utf8');
const filler = (n) => { let s = ''; while (s.length < n) s += '这是一行测试文字，用来凑长度。'.repeat(10) + '\n'; return s.slice(0, n - 1) + '。'; };
const CASES = [['short', filler(200)], ['4000', filler(4000)], ['old-7990', old], ['new-8427', M.instructions('win32')], ['10000', filler(10000)]];
let application, page, profile, api;
test.afterEach(async () => { if (application) await application.close(); if (api) await api.close(); });

test(`${CLI} ladder`, async () => {
  test.setTimeout(900000);
  api = await mockApi.start();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ladder-'));
  const columns = CASES.map(([name], i) => ({ id: 'lad-' + i, title: name, role: 'manual', cwd: profile,
    cmd: `node "${path.join(__dirname, 'fixtures', 'real-cli.js')}" ${CLI} ${api.port} "${path.join(profile, 'cfg-' + i)}"` }));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ perpetualCaptain: { enabled: false }, theme: 'dark', fitWindow: true, fitCols: 5, columns }));
  const env = { ...process.env, ZDOTDIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [ROOT, `--test-user-data=${profile}`], env });
  page = await application.firstWindow();
  await page.waitForFunction((ids) => typeof terms !== 'undefined' && ids.every((id) => terms.get(id)?.alive), columns.map((c) => c.id));
  let version = CLI; try { version = execSync(`${CLI} --version`, { encoding: 'utf8' }).trim(); } catch (_) {}
  for (let i = 0; i < CASES.length; i++) {
    const [name, text] = CASES[i], id = 'lad-' + i;
    await page.waitForTimeout(8000);   // let the CLI finish starting
    const way = await page.evaluate((c) => (terms.get(c)?.term?.modes?.bracketedPasteMode ? 'bracketed paste' : 'typed keys'), id);
    const t0 = Date.now();
    await page.evaluate(([c, t]) => sendWhenReady(columns.find((x) => x.id === c), t, { silent: true, guardUserInput: true, inlineLimit: MainCore.BRIEFING_LIMIT }), [id, text]);
    const ok = await expect.poll(() => api.userTexts().some((u) => u === text), { timeout: 60000 }).toBe(true).then(() => true, () => false);
    let note = ok ? `submitted whole after ${Date.now() - t0} ms` : 'NOT submitted within 60 s';
    if (!ok) {
      const screen = await page.evaluate((c) => dumpScreen(terms.get(c).term, 12), id);
      console.log(`[ladder-screen] ${name}:\n${screen}`);
      await page.evaluate((c) => window.deck.ptyInput(c, '\r'), id);
      const second = await expect.poll(() => api.userTexts().some((u) => u === text), { timeout: 30000 }).toBe(true).then(() => true, () => false);
      const partial = api.userTexts().filter((u) => u.includes(text.slice(0, 30))).map((u) => u.length);
      note += second ? '; a second Enter then submitted it whole' : `; a second Enter did not help (texts like it: ${JSON.stringify(partial)})`;
    }
    console.log(`[ladder] ${process.platform} ${os.release()} ${version} ${name} (${text.length} chars) via ${way}: ${note}`);
    // How a near miss differs: every place the received text departs from what was sent.
    for (const got of api.userTexts().filter((u) => u !== text && u.includes(text.slice(0, 30)))) {
      const diffs = []; let a = 0, b = 0;
      while ((a < text.length || b < got.length) && diffs.length < 12) {
        if (text[a] === got[b]) { a++; b++; continue; }
        // find the shortest resync: a dropped char in got, an extra char in got, or a substitution
        if (text[a + 1] === got[b]) { diffs.push(`dropped ${JSON.stringify(text[a])} at ${a} after ${JSON.stringify(text.slice(Math.max(0, a - 12), a))}`); a++; continue; }
        if (text[a] === got[b + 1]) { diffs.push(`extra ${JSON.stringify(got[b])} at ${a} after ${JSON.stringify(text.slice(Math.max(0, a - 12), a))}`); b++; continue; }
        diffs.push(`changed ${JSON.stringify(text[a])}->${JSON.stringify(got[b])} at ${a} after ${JSON.stringify(text.slice(Math.max(0, a - 12), a))}`); a++; b++;
      }
      console.log(`[ladder-diff] ${name}: received ${got.length} of ${text.length}: ${diffs.join(' | ')}`);
    }
  }
});
