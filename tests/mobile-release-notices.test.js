'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { build } = require('../scripts/mobile-release');

// Runs on Windows too: no symlinks, only a fixture git repo and the static build.
const ROOT = path.join(__dirname, '..');
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const lf = (text) => text.replace(/\r\n/g, '\n');

test('the static hub package ships the pdf.js and core-js license notices', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-hub-notices-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), output = path.join(root, 'output');
  fs.mkdirSync(repo);
  fs.cpSync(path.join(ROOT, 'mobile-web/hub'), path.join(repo, 'mobile-web/hub'), { recursive: true });
  for (const name of ['THIRD_PARTY_NOTICES.md', 'release-notes.json']) fs.copyFileSync(path.join(ROOT, name), path.join(repo, name));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '1.2.0' }));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'core.hooksPath', path.join(root, 'no-hooks')); git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'hub with notices');

  const manifest = build(repo, output);

  const notices = fs.readFileSync(path.join(output, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.equal(lf(notices), lf(fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')));
  // Each embedded project's section must carry its own license text, not just a mention of it.
  const pdfjs = notices.match(/^## 3\. pdf\.js$[\s\S]*?(?=^## 4\. )/m)?.[0] ?? '';
  assert.match(pdfjs, /Apache License\n\s+Version 2\.0, January 2004/);
  const coreJs = notices.match(/^## 4\. core-js$[\s\S]*?(?=^## 5\. )/m)?.[0] ?? '';
  assert.match(coreJs, /Permission is hereby granted, free of charge/);
  // The public check compares every served file, so the notices must be in the manifest with the bytes it wrote.
  assert.equal(manifest.files['THIRD_PARTY_NOTICES.md'], sha256(notices));
  const written = JSON.parse(fs.readFileSync(path.join(output, 'release.json'), 'utf8'));
  assert.equal(written.files['THIRD_PARTY_NOTICES.md'], manifest.files['THIRD_PARTY_NOTICES.md']);
  assert.ok(fs.existsSync(path.join(output, 'pdf.min.js')) && fs.existsSync(path.join(output, 'pdf.worker.min.js')));
});
