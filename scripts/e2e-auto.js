#!/usr/bin/env node
'use strict';

// Auto-route E2E specs: Windows by default if online, Mac queue if Windows offline or spec is Mac-only.
// Usage:
//   node scripts/e2e-auto.js tests/e2e/foo.spec.js [playwright args]
//   node scripts/e2e-auto.js --status
// Mac-only specs (marked with `skip: process.platform === 'win32'`) always run locally.
// Returns: exit code from the test run
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const say = (message) => console.log(`[e2e-auto] ${message}`);

// Check if Windows PC is reachable via SSH
function isWindowsOnline(host = 'winpc', timeoutSecs = 5) {
  try {
    execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeoutSecs}`, host, 'exit 0'], {
      stdio: 'ignore', timeout: (timeoutSecs + 1) * 1000,
    });
    return true;
  } catch {
    return false;
  }
}

// Check if a spec file is Mac-only (has `skip: process.platform === 'win32'` or test.skip(...'win32'...))
function isMacOnlySpec(specPath) {
  try {
    const content = fs.readFileSync(specPath, 'utf8');
    // Look for skip conditions that exclude Windows: test.skip(process.platform === 'win32') or skip: process.platform === 'win32'
    return /test\.skip\s*\(\s*process\.platform\s*===\s*['"]win32["']/.test(content) ||
           /skip:?\s*process\.platform\s*===\s*['"]win32["']/.test(content) ||
           /skip:?\s*!?\s*process\.platform\s*===\s*['"]darwin["']/.test(content);
  } catch {
    return false;
  }
}

// Parse arguments: return { status, specs, playwrightArgs }
function parseArgs(argv) {
  const args = { status: false, specs: [], playwrightArgs: [] };
  let dashdashIndex = argv.indexOf('--');
  if (dashdashIndex >= 0) {
    args.playwrightArgs = argv.slice(dashdashIndex + 1);
    argv = argv.slice(0, dashdashIndex);
  }
  for (const arg of argv) {
    if (arg === '--status') args.status = true;
    else if (arg.endsWith('.spec.js')) args.specs.push(arg);
  }
  return args;
}

// Run via local Mac queue
async function runLocal(specs, playwrightArgs) {
  const { main: queueMain } = require('./e2e-queue');
  const queueArgs = ['--', 'node', path.join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', ...specs, ...playwrightArgs];
  return queueMain(queueArgs, process.env);
}

// Run via Windows (one spec at a time)
async function runOnWindows(spec, playwrightArgs, host = 'winpc') {
  const { main: remoteMain } = require('./e2e-remote-win');
  const ref = 'HEAD'; // Run current commit
  const remoteArgs = [ref, spec, ...playwrightArgs, '--host', host];
  return remoteMain(remoteArgs);
}

// Check queue status (via local queue)
function showStatus() {
  const { main: queueMain } = require('./e2e-queue');
  queueMain(['--queue-status'], process.env);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.status) {
    showStatus();
    return 0;
  }
  if (!args.specs.length) {
    console.error('[e2e-auto] Usage: e2e-auto.js [--status] | tests/e2e/spec.js [spec.js...] [playwright args]');
    return 2;
  }

  // Separate Mac-only from cross-platform specs
  const macOnly = [];
  const crossPlatform = [];
  for (const spec of args.specs) {
    if (isMacOnlySpec(path.join(ROOT, spec))) {
      macOnly.push(spec);
    } else {
      crossPlatform.push(spec);
    }
  }

  if (macOnly.length > 0) {
    say(`${macOnly.length} Mac-only spec(s), running locally via queue`);
  }
  if (crossPlatform.length > 0 && !isWindowsOnline()) {
    say('Windows offline, routing all cross-platform specs to local Mac queue');
    crossPlatform.forEach((s) => macOnly.push(s));
    crossPlatform.length = 0;
  }

  let exitCode = 0;
  if (crossPlatform.length > 0) {
    say(`${crossPlatform.length} cross-platform spec(s), sending to Windows`);
    for (const spec of crossPlatform) {
      const code = await runOnWindows(spec, args.playwrightArgs);
      if (code !== 0) exitCode = code;
    }
  }
  if (macOnly.length > 0) {
    const code = await runLocal(macOnly, args.playwrightArgs);
    if (code !== 0) exitCode = code;
  }
  return exitCode;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => { console.error(`[e2e-auto] ${error.message}`); process.exit(2); });
}

module.exports = { parseArgs, isMacOnlySpec, isWindowsOnline };
