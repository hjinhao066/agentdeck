'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const cli = require.resolve('@playwright/test/cli');
// Electron loads these in a child process, outside Playwright's import graph.
const groups = {
  quota: ['quota', 'quota-seats'],
  'crew-map': ['crew-map'],
  skills: ['skills'],
  schedule: ['workspace'],
  notifications: ['notifications'],
  'notification-policy': ['notifications'],
  'side-pane': ['workspace', 'global-view'],
  'side-main': ['workspace', 'global-view'],
};
function runtimeSpecs(changes, specs) {
  const selected = new Set();
  for (const file of changes) {
    if (['package.json', 'package-lock.json', 'playwright.config.js', 'index.html', 'style.css', 'tests/e2e/electron-helper.js'].includes(file) || file.startsWith('vendor/')) return specs;
    if (!/^[^/]+\.js$/.test(file)) continue;
    const group = Object.keys(groups).find((key) => file === `${key}.js` || file === `${key}-core.js` || file.startsWith(`${key}-`));
    if (!group) return specs; // Shared main/preload/renderer/chat/board code.
    for (const name of groups[group]) selected.add(`tests/e2e/${name}.spec.js`);
  }
  return [...selected];
}

function main() {
  const base = process.env.AGENTDECK_E2E_BASE || 'origin/main';
  const changes = new Set([
    ...execFileSync('git', ['diff', '--name-only', base, '--'], { cwd: root, encoding: 'utf8' }).trim().split('\n'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n'),
  ]);
  const listed = spawnSync(process.execPath, [cli, 'test', `--only-changed=${base}`, '--list', '--reporter=json'], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) { process.stderr.write(listed.stderr || listed.stdout); process.exitCode = listed.status || 1; return; }
  const report = JSON.parse(listed.stdout);
  const specs = fs.readdirSync(path.join(root, 'tests/e2e')).filter((name) => name.endsWith('.spec.js')).map((name) => `tests/e2e/${name}`);
  const selected = new Set(runtimeSpecs(changes, specs));
  const collect = (suites) => {
    for (const suite of suites || []) {
      for (const spec of suite.specs || []) selected.add(`tests/e2e/${spec.file}`);
      collect(suite.suites);
    }
  };
  collect(report.suites);
  if (!selected.size) { console.log(`No affected E2E specs relative to ${base}.`); return; }
  console.log(`Affected E2E: ${[...selected].sort().join(', ')}`);
  // A change to shared infrastructure really affects all specs: keep the lock.
  const filters = specs.every((file) => selected.has(file)) ? [] : [...selected].sort();
  const result = spawnSync(process.execPath, [cli, 'test', ...filters, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  process.exitCode = result.status === null ? 1 : result.status;
}

if (require.main === module) main();
module.exports = { runtimeSpecs };
