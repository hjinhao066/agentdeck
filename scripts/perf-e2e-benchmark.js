#!/usr/bin/env node
'use strict';

// Performance benchmark: compare E2E test execution on Mac (queue) vs Windows (background)
// Usage: node scripts/perf-e2e-benchmark.js <spec> [<spec>...]
// Runs each spec on both platforms and reports wall-clock time, then concurrent Windows tests

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const say = (message) => console.log(`[benchmark] ${message}`);

function parseArgs(argv) {
  const specs = [];
  for (const arg of argv) {
    if (arg.endsWith('.spec.js')) specs.push(arg);
  }
  return specs;
}

// Run a spec via e2e-queue (Mac)
async function runOnMac(spec, timeoutSec = 300) {
  return new Promise((resolve) => {
    say(`Starting Mac test: ${spec}`);
    const start = Date.now();
    const proc = spawn('node', ['scripts/e2e-queue.js', '--queue-run-timeout', Math.ceil(timeoutSec / 60), '--', 'node', 'node_modules/@playwright/test/cli.js', 'test', spec, '--workers=1'], {
      cwd: process.cwd(), stdio: 'inherit',
    });
    proc.on('close', (code) => {
      const elapsed = (Date.now() - start) / 1000;
      say(`Mac test ${spec} completed in ${elapsed.toFixed(1)} seconds (exit ${code})`);
      resolve({ platform: 'Mac', spec, seconds: elapsed, exitCode: code });
    });
  });
}

// Run a spec via e2e-remote-win (Windows)
async function runOnWindows(spec, timeoutSec = 300) {
  return new Promise((resolve) => {
    say(`Starting Windows test: ${spec}`);
    const start = Date.now();
    const proc = spawn('node', ['scripts/e2e-remote-win.js', 'HEAD', spec, '--queue-run-timeout', Math.ceil(timeoutSec / 60)], {
      cwd: process.cwd(), stdio: 'inherit',
    });
    proc.on('close', (code) => {
      const elapsed = (Date.now() - start) / 1000;
      say(`Windows test ${spec} completed in ${elapsed.toFixed(1)} seconds (exit ${code})`);
      resolve({ platform: 'Windows', spec, seconds: elapsed, exitCode: code });
    });
  });
}

// Format results as table
function formatResults(results) {
  const macResults = results.filter(r => r.platform === 'Mac' && r.exitCode === 0);
  const winResults = results.filter(r => r.platform === 'Windows' && r.exitCode === 0);

  say('\n=== Performance Comparison (wall-clock time) ===');
  console.log('Spec,Mac (s),Windows (s),Speedup Factor');

  const macMap = new Map(macResults.map(r => [r.spec, r.seconds]));
  const winMap = new Map(winResults.map(r => [r.spec, r.seconds]));

  let totalMac = 0, totalWin = 0;
  for (const spec of macMap.keys()) {
    if (winMap.has(spec)) {
      const mac = macMap.get(spec);
      const win = winMap.get(spec);
      const speedup = (mac / win).toFixed(2);
      console.log(`${path.basename(spec)},${mac.toFixed(1)},${win.toFixed(1)},${speedup}x`);
      totalMac += mac;
      totalWin += win;
    }
  }

  if (totalMac > 0 && totalWin > 0) {
    const totalSpeedup = (totalMac / totalWin).toFixed(2);
    say(`\nSequential total: Mac ${totalMac.toFixed(1)}s, Windows ${totalWin.toFixed(1)}s (${totalSpeedup}x faster)`);
  }

  if (totalWin > 0) {
    const concurrentSpeedup2 = (totalMac / (totalWin * 1.2)).toFixed(2); // Rough estimate: 20% overhead per concurrent
    const concurrentSpeedup3 = (totalMac / (totalWin * 1.4)).toFixed(2);
    say(`Estimated throughput with concurrent Windows:`);
    say(`  2 groups: ${concurrentSpeedup2}x faster than sequential Mac`);
    say(`  3 groups: ${concurrentSpeedup3}x faster than sequential Mac`);
  }

  return { macMap, winMap };
}

async function main(argv = process.argv.slice(2)) {
  const specs = parseArgs(argv);

  if (!specs.length) {
    console.error('Usage: perf-e2e-benchmark.js <spec.js> [<spec.js>...]');
    console.error('Example: node scripts/perf-e2e-benchmark.js tests/e2e/chat.spec.js tests/e2e/quota-warmup.spec.js');
    process.exit(2);
  }

  say(`Benchmarking ${specs.length} spec(s)...`);
  say('Note: This will run each spec on both Mac and Windows. Total time: ~30-60 minutes.');
  say('');

  const results = [];

  // Run each spec on Mac first (queue might have wait time)
  say('Phase 1: Running specs on Mac (via e2e-queue)');
  for (const spec of specs) {
    const result = await runOnMac(spec);
    results.push(result);
  }

  say('\nPhase 2: Running specs on Windows (via e2e-remote-win)');
  // Run each spec on Windows
  for (const spec of specs) {
    const result = await runOnWindows(spec);
    results.push(result);
  }

  formatResults(results);
}

if (require.main === module) {
  main().catch((error) => { console.error(`[benchmark] ${error.message}`); process.exit(2); });
}

module.exports = { parseArgs };
