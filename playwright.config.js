const { defineConfig } = require('@playwright/test');
// Release smoke is the existing tests tagged @smoke (`npm run test:smoke`).
// Do not add a second project for them: `npm run test:e2e` must still run each test once.
module.exports = defineConfig({ testDir: './tests/e2e', timeout: 60000,
  workers: 1, reporter: 'list', use: { trace: 'retain-on-failure' } });
