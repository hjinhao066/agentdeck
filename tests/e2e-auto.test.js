const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { isMacOnlySpec, parseArgs, isWindowsOnline } = require('../scripts/e2e-auto');

const FIXTURES = path.join(__dirname, 'fixtures');

// Create a temporary spec file for testing
function createTempSpec(isMacOnly) {
  const dir = fs.mkdtempSync(path.join(__dirname, 'tmp-e2e-auto-'));
  const spec = path.join(dir, 'test.spec.js');
  const content = isMacOnly
    ? "const test = require('@playwright/test').test;\ntest('mac only', { skip: process.platform === 'win32' }, async () => {});"
    : "const test = require('@playwright/test').test;\ntest('cross platform', async () => {});";
  fs.writeFileSync(spec, content);
  return { spec, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('isMacOnlySpec detects skip: process.platform === "win32"', () => {
  const { spec, cleanup } = createTempSpec(true);
  try {
    assert.ok(isMacOnlySpec(spec), 'Should detect Mac-only spec');
  } finally {
    cleanup();
  }
});

test('isMacOnlySpec returns false for cross-platform specs', () => {
  const { spec, cleanup } = createTempSpec(false);
  try {
    assert.ok(!isMacOnlySpec(spec), 'Should return false for cross-platform spec');
  } finally {
    cleanup();
  }
});

test('isMacOnlySpec returns false for missing files', () => {
  assert.ok(!isMacOnlySpec('/nonexistent/path/test.spec.js'), 'Should handle missing files gracefully');
});

test('parseArgs extracts specs and playwright args', () => {
  const result = parseArgs(['tests/e2e/foo.spec.js', 'tests/e2e/bar.spec.js', '--', '--headed', '--debug']);
  assert.deepStrictEqual(result.specs, ['tests/e2e/foo.spec.js', 'tests/e2e/bar.spec.js']);
  assert.deepStrictEqual(result.playwrightArgs, ['--headed', '--debug']);
  assert.strictEqual(result.status, false);
});

test('parseArgs recognizes --status', () => {
  const result = parseArgs(['--status']);
  assert.strictEqual(result.status, true);
  assert.strictEqual(result.specs.length, 0);
});

test('parseArgs ignores non-spec arguments', () => {
  const result = parseArgs(['--host', 'winpc', 'tests/e2e/foo.spec.js']);
  assert.deepStrictEqual(result.specs, ['tests/e2e/foo.spec.js']);
});

test('Windows connectivity check (timeout check)', async () => {
  // This test just verifies the function doesn't crash; actual online status depends on network
  const result = isWindowsOnline('winpc', 1); // 1 second timeout
  assert.strictEqual(typeof result, 'boolean');
});
