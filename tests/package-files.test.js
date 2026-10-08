'use strict';
// Every module the packaged app loads must itself be in package.json build.files:
// a file left out only shows up as MODULE_NOT_FOUND in the installed app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const patterns = require('../package.json').build.files;
// electron-builder always packs package.json itself.
const packed = (file) => file === 'package.json' || patterns.some((p) => p.endsWith('/**') ? file.startsWith(p.slice(0, -2)) : p === file);
function listed() {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(child); else out.push(child);
    }
  };
  for (const p of patterns) {
    if (p.endsWith('/**')) { if (fs.existsSync(path.join(root, p.slice(0, -3)))) walk(p.slice(0, -3)); }
    else out.push(p);
  }
  return out.filter((file) => file.endsWith('.js') && !/\.min\.js$/.test(file));
}

test('every relative require inside the packaged files points at a packaged file', () => {
  const missing = [];
  for (const file of listed()) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, spec] of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!path.posix.extname(target)) target += '.js';
      // Only files that exist in the source tree; generated or optional paths are someone else's business.
      if (fs.existsSync(path.join(root, target)) && !packed(target)) missing.push(`${file} → ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the phone page preview modules are packaged', () => {
  for (const file of ['file-preview-core.js', 'mobile-web.js', 'mobile-web/hub/core.js', 'mobile-web/hub/pdf.min.js', 'mobile-web/hub/pdf.worker.min.js']) assert.ok(packed(file), file);
});
