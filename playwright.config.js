const { defineConfig } = require('@playwright/test');
// Release smoke is the existing tests tagged @smoke (`npm run test:smoke`).
// Do not add a second project for them: `npm run test:e2e` must still run each test once.
// Windows: every new column starts PowerShell in its own ConPTY, synchronously in the main
// process, and every board command is a fresh node process. Measured on a Windows 11 desktop,
// a worker reached "working" 2.6–4.3s after `new`, so the default 5s left no headroom and a
// different test failed on each run. Waiting longer never lets a wrong value pass.
module.exports = defineConfig({ testDir: './tests/e2e', timeout: 60000,
  expect: { timeout: process.platform === 'win32' ? 15000 : 5000 },
  workers: 1, reporter: 'list', use: { trace: 'retain-on-failure' } });
