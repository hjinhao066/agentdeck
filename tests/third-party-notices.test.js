const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

test('THIRD_PARTY_NOTICES.md is matched by the packaged files list', () => {
  assert.ok(fs.existsSync(path.join(root, 'THIRD_PARTY_NOTICES.md')));
  // electron-builder reads build.files as globs relative to the app root.
  assert.ok(pkg.build.files.some((glob) => path.matchesGlob('THIRD_PARTY_NOTICES.md', glob)));
});
