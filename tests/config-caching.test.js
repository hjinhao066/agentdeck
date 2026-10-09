const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Test the mtime-based caching pattern for config.json reads
test('mtime-based config caching avoids re-parsing unchanged files', () => {
  const testDir = fs.mkdtempSync(path.join(__dirname, 'tmp-config-cache-'));
  const configPath = path.join(testDir, 'test-config.json');
  const testData = { test: 'data', seats: ['a', 'b'] };

  // Write initial config
  fs.writeFileSync(configPath, JSON.stringify(testData));

  // Implement cached version
  let cachedData = null, cachedMtime = null;
  let parseCount = 0;
  const getCachedConfig = () => {
    try {
      const stat = fs.statSync(configPath);
      if (cachedData && cachedMtime === stat.mtimeMs) {
        return cachedData; // Return cached, don't re-parse
      }
      parseCount++;
      cachedData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cachedMtime = stat.mtimeMs;
      return cachedData;
    } catch (_) { return {}; }
  };

  // First read: should parse (parseCount = 1)
  const first = getCachedConfig();
  assert.deepStrictEqual(first, testData);
  assert.strictEqual(parseCount, 1, 'First read should parse');

  // Second read without file change: should use cache (parseCount still 1)
  const second = getCachedConfig();
  assert.deepStrictEqual(second, testData);
  assert.strictEqual(parseCount, 1, 'Second read of unchanged file should use cache');

  // Modify file (ensure different mtime)
  const newData = { test: 'data', seats: ['a', 'b', 'c'] };
  fs.writeFileSync(configPath, JSON.stringify(newData));

  // Third read after file change: should re-parse (parseCount = 2)
  const third = getCachedConfig();
  assert.deepStrictEqual(third, newData);
  assert.strictEqual(parseCount, 2, 'Read after file change should re-parse');

  // Fourth read without further change: should use new cache (parseCount still 2)
  const fourth = getCachedConfig();
  assert.deepStrictEqual(fourth, newData);
  assert.strictEqual(parseCount, 2, 'Read of unchanged modified file should use cache');

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('config caching handles missing files gracefully', () => {
  const missingPath = '/nonexistent/config.json';

  let cachedData = null, cachedMtime = null;
  const getCachedConfig = () => {
    try {
      const stat = fs.statSync(missingPath);
      if (cachedData && cachedMtime === stat.mtimeMs) return cachedData;
      cachedData = JSON.parse(fs.readFileSync(missingPath, 'utf8'));
      cachedMtime = stat.mtimeMs;
      return cachedData;
    } catch (_) { return {}; }
  };

  // Should return empty object without crashing
  const result = getCachedConfig();
  assert.deepStrictEqual(result, {});
});
