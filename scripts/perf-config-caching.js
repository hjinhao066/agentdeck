#!/usr/bin/env node
'use strict';

// Measure config.json read cost with and without the cache main.js uses (config-cache.js)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const say = (message) => console.log(`[perf] ${message}`);

// Create test config file
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-config-'));
const configPath = path.join(testDir, 'config.json');
const testData = {
  mainSession: { colId: 'captain-123' },
  claudeSeats: [{ id: 'seat-1', name: 'Claude' }],
  columns: Array.from({ length: 50 }, (_, i) => ({ id: `col-${i}`, title: `Column ${i}` })),
  tasks: Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}`, title: `Task ${i}` })),
};
fs.writeFileSync(configPath, JSON.stringify(testData));

// Uncached version (every read parses)
const readUncached = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Cached version: the same module main.js uses
const readCached = require('../config-cache').createJsonFileCache(configPath);

// Benchmark: 1000 reads of the same unchanged file
const iterations = 1000;

say(`Testing with ${iterations} reads of ${JSON.stringify(testData).length} byte config...`);

// Warmup
for (let i = 0; i < 10; i++) readUncached();
for (let i = 0; i < 10; i++) readCached();

// Measure uncached
const t1 = process.hrtime.bigint();
for (let i = 0; i < iterations; i++) readUncached();
const t2 = process.hrtime.bigint();
const uncachedMs = Number(t2 - t1) / 1_000_000;

// Measure cached
const t3 = process.hrtime.bigint();
for (let i = 0; i < iterations; i++) readCached();
const t4 = process.hrtime.bigint();
const cachedMs = Number(t4 - t3) / 1_000_000;

const savedMs = uncachedMs - cachedMs;
const savedPct = (savedMs / uncachedMs * 100).toFixed(1);

say(`Uncached (parse every time): ${uncachedMs.toFixed(2)} ms`);
say(`Cached: ${cachedMs.toFixed(2)} ms`);
say(`Improvement: ${savedMs.toFixed(2)} ms (${savedPct}% faster)`);

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });
