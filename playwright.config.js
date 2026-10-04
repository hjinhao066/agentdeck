const { defineConfig } = require('@playwright/test');
const workers = Number(process.env.AGENTDECK_E2E_WORKERS || 2);
if (!Number.isInteger(workers) || workers < 1) throw new Error('AGENTDECK_E2E_WORKERS must be a positive integer');
module.exports = defineConfig({ testDir: './tests/e2e', timeout: 60000,
  workers, globalSetup: require.resolve('./scripts/e2e-global-setup'),
  reporter: 'list', use: { trace: 'retain-on-failure' } });
