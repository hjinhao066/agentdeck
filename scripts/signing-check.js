#!/usr/bin/env node
'use strict';

// macOS privacy grants (screen recording, accessibility, ...) are matched by the app's
// designated requirement (DR). An ad-hoc build has `cdhash H"..."` as its DR, which is
// different for every build, so every upgrade looks like a new app. A build signed with the
// fixed certificate has `identifier "<id>" and certificate leaf = H"<sha1>"`, identical for
// every version. This gate fails any build that does not carry the pinned DR.
// See docs/macos-signing-and-permissions.md.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PINNED_FILE = path.join(__dirname, '..', 'build', 'signing-identity.json');

function loadPinned(file = PINNED_FILE) {
  const pinned = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pinned.identifier || !/^[0-9a-f]{40}$/i.test(pinned.leafSha1 || '')) throw new Error(`Invalid signing identity file: ${file}`);
  return { ...pinned, leafSha1: pinned.leafSha1.toLowerCase() };
}

// The one DR string a correctly signed AgentDeck build must have.
function expectedRequirement(pinned) {
  return `identifier "${pinned.identifier}" and certificate leaf = H"${pinned.leafSha1}"`;
}

// `codesign -d -r-` prints `designated => <requirement>` (plus other lines) on stdout/stderr;
// code without an explicit DR (ad-hoc) prints the implied one as `# designated => cdhash H"..."`.
function parseDesignatedRequirement(output) {
  const line = String(output).split('\n').map((text) => text.replace(/^#\s*/, '')).find((text) => text.startsWith('designated => '));
  return line ? line.slice('designated => '.length).trim().replace(/H"([0-9A-Fa-f]+)"/g, (_, hex) => `H"${hex.toLowerCase()}"`) : null;
}

function readRequirement(app, spawn = spawnSync) {
  const result = spawn('/usr/bin/codesign', ['-d', '-r-', app], { encoding: 'utf8' });
  if (result.error) throw result.error;
  const requirement = parseDesignatedRequirement(`${result.stdout}\n${result.stderr}`);
  if (!requirement) throw new Error(`No designated requirement for ${app} (unsigned?): ${String(result.stderr).trim().slice(0, 300)}`);
  return requirement;
}

// → { ok, requirement, reason? }. A `cdhash` requirement is called out because it is the
// ad-hoc fallback electron-builder produces silently when the signing identity is missing.
function checkRequirement(requirement, pinned) {
  if (requirement === expectedRequirement(pinned)) return { ok: true, requirement };
  const reason = /\bcdhash\b/.test(requirement)
    ? 'ad-hoc signature (requirement is a per-build cdhash); the AgentDeck Dev identity was not used'
    : `requirement differs from the pinned identity ${expectedRequirement(pinned)}`;
  return { ok: false, requirement, reason };
}

function checkApps(apps, pinned, spawn = spawnSync) {
  const results = apps.map((app) => ({ app, ...checkRequirement(readRequirement(app, spawn), pinned) }));
  return { ok: results.every((entry) => entry.ok), results };
}

// Is the pinned certificate (with its private key) a valid code-signing identity here?
function identityAvailable(pinned, spawn = spawnSync) {
  const result = spawn('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return new RegExp(`^\\s*\\d+\\)\\s+${pinned.leafSha1}\\b`, 'im').test(result.stdout);
}

function main(argv, out = console) {
  const pinned = loadPinned();
  if (argv[0] === '--identity') {
    if (identityAvailable(pinned)) { out.log(`signing identity ${pinned.name} (${pinned.leafSha1}) is available`); return 0; }
    out.error(`Signing identity "${pinned.name}" (${pinned.leafSha1}) is not a valid code-signing identity in this keychain. `
      + 'Without it electron-builder silently produces an ad-hoc build and every macOS privacy grant is lost on upgrade. '
      + 'Unlock the login keychain or restore the identity; do not create a new certificate.');
    return 1;
  }
  const apps = argv.filter((arg) => !arg.startsWith('--'));
  if (!apps.length) { out.error('usage: signing-check.js --identity | <App.app> [<App2.app> ...]'); return 2; }
  const { ok, results } = checkApps(apps, pinned);
  for (const entry of results) (entry.ok ? out.log : out.error)(`${entry.ok ? 'OK  ' : 'FAIL'} ${entry.app}\n     ${entry.requirement}${entry.reason ? `\n     ${entry.reason}` : ''}`);
  return ok ? 0 : 1;
}

module.exports = { loadPinned, expectedRequirement, parseDesignatedRequirement, readRequirement, checkRequirement, checkApps, identityAvailable, main };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
