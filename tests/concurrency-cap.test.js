'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const M = require('../main-core');
const { CACHE_MS, parseLevel, createMemoryPressure } = require('../memory-pressure');

test('concurrency cap reads the setting, defaults to 30, and stays inside 5–50', () => {
  assert.equal(M.concurrencyCap(), 30);
  assert.equal(M.concurrencyCap(undefined), 30);
  assert.equal(M.concurrencyCap(null), 30);
  assert.equal(M.concurrencyCap(''), 30);
  assert.equal(M.concurrencyCap(30), 30);
  assert.equal(M.concurrencyCap('42'), 42);
  assert.equal(M.concurrencyCap(5), 5);
  assert.equal(M.concurrencyCap(50), 50);
  assert.equal(M.concurrencyCap(4), 5);
  assert.equal(M.concurrencyCap(0), 5);
  assert.equal(M.concurrencyCap(80), 50);
  assert.equal(M.concurrencyCap(15.5), 30);
  assert.equal(M.MAX_ACTIVE, 30);
  const custom = M.instructions('darwin', undefined, false, 42);
  assert.match(custom, /11\. [^\n]*最多 42 个会话在干活[^\n]*自动排队/);
  assert.match(custom, /14\. [^\n]*并发上限 42[^\n]*内存压力等级[^\n]*kern\.memorystatus_vm_pressure_level/);
  assert.match(custom, /不要因为 swap 用了几个 G 就少开/);
  assert.match(custom, /全量 E2E/);
  assert.ok(!custom.includes('vm.swapusage'));
  assert.match(M.instructions(), /最多 30 个会话在干活/);
  assert.match(M.instructions('win32'), /Windows 没有这个指标/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="concurrencyCap"[^>]*min="5"[^>]*max="50"/);
  assert.match(html, /同时最多几个会话干活，超出的自动排队/);
});

test('raising the cap admits queued work on the next fill', async () => {
  const waitlist = ['a', 'b', 'c'];
  const opened = [];
  let active = 5;
  const open = async (item) => { opened.push(item); active += 1; };
  const blocked = await M.fillQueue({
    cap: 5, active, waiting: waitlist.length, level: 1,
    take: () => waitlist.shift(), open,
  });
  assert.equal(blocked.start, 0);
  assert.equal(blocked.paused, false);
  assert.deepEqual(waitlist, ['a', 'b', 'c']);
  const next = await M.fillQueue({
    cap: 7, active, waiting: waitlist.length, level: 1,
    take: () => waitlist.shift(), open,
  });
  assert.equal(next.start, 2);
  assert.deepEqual(opened, ['a', 'b']);
  assert.deepEqual(waitlist, ['c']);
  assert.equal(M.queueNote(7, false), '同时最多 7 个会话干活，前面有空位就自动开会话开始做。');
  assert.equal(M.queueTitle(7, false), '同时最多 7 个会话干活，有空位就自动开');
});

test('critical memory pauses auto-start and warning or normal pressure resumes it', async () => {
  const waitlist = ['a', 'b'];
  const opened = [];
  const open = async (item) => opened.push(item);
  const held = await M.fillQueue({
    cap: 30, active: 0, waiting: waitlist.length, level: 4,
    take: () => waitlist.shift(), open,
  });
  assert.equal(held.paused, true);
  assert.equal(held.start, 0);
  assert.deepEqual(opened, []);
  assert.deepEqual(waitlist, ['a', 'b']);
  assert.equal(M.queueNote(30, true), '内存吃紧，稍后自动开');
  const warning = await M.fillQueue({
    cap: 30, active: 0, waiting: waitlist.length, level: 2,
    take: () => waitlist.shift(), open,
  });
  assert.equal(warning.paused, false);
  assert.deepEqual(opened, ['a', 'b']);
  assert.deepEqual(waitlist, []);
  const again = ['c'];
  const resumed = await M.fillQueue({
    cap: 30, active: 0, waiting: 1, level: 1,
    take: () => again.shift(), open,
  });
  assert.equal(resumed.paused, false);
  assert.deepEqual(opened, ['a', 'b', 'c']);
  const windows = await M.fillQueue({
    cap: 2, active: 0, waiting: 1, level: null,
    take: () => 'w', open: async () => {},
  });
  assert.equal(windows.paused, false);
  assert.equal(windows.start, 1);
});

test('memory pressure is cached, warning is not critical, and non-macOS skips the command', async () => {
  assert.equal(CACHE_MS >= 3000 && CACHE_MS <= 10000, true);
  assert.equal(parseLevel('1\n'), 1);
  assert.equal(parseLevel('2'), 2);
  assert.equal(parseLevel('4'), 4);
  assert.equal(parseLevel('kern.memorystatus_vm_pressure_level: 4'), 4);
  assert.equal(parseLevel('3'), null);
  assert.equal(parseLevel(''), null);
  let now = 1_000;
  const calls = [];
  let pending = null;
  const probe = createMemoryPressure({
    platform: 'darwin',
    now: () => now,
    cacheMs: 5000,
    execFile: (file, args, opts, cb) => {
      calls.push([file, args]);
      const done = () => cb(null, calls.length === 1 ? '4\n' : '1\n');
      if (calls.length === 1) pending = done;
      else done();
    },
  });
  const first = probe.read();
  const second = probe.read();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['-n', 'kern.memorystatus_vm_pressure_level']);
  pending();
  assert.deepEqual(await first, { level: 4, critical: true });
  assert.equal(await second, await first);
  now += 4999;
  assert.deepEqual(await probe.read(), { level: 4, critical: true });
  assert.equal(calls.length, 1);
  now += 1;
  assert.deepEqual(await probe.read(), { level: 1, critical: false });
  assert.equal(calls.length, 2);
  const warned = createMemoryPressure({
    platform: 'darwin', now: () => 0, cacheMs: 5000,
    execFile: (_f, _a, _o, cb) => cb(null, '2\n'),
  });
  assert.deepEqual(await warned.read(), { level: 2, critical: false });
  let ran = false;
  const windows = createMemoryPressure({
    platform: 'win32', execFile: () => { ran = true; },
  });
  assert.deepEqual(await windows.read(), { level: null, critical: false });
  assert.equal(ran, false);
  const broken = createMemoryPressure({
    platform: 'darwin', now: () => 0, cacheMs: 5000,
    execFile: (_f, _a, _o, cb) => cb(new Error('sysctl failed')),
  });
  assert.deepEqual(await broken.read(), { level: null, critical: false });
});

test('queued-card rendering does not probe memory; admission does', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main-session.js'), 'utf8');
  const render = src.slice(src.indexOf('function renderCard'), src.indexOf('function init('));
  assert.equal(render.includes('memoryPressure'), false);
  assert.equal(render.includes('sysctl'), false);
  assert.match(src, /M\.fillQueue\(/);
  assert.match(src, /deck\.memoryPressure\(\)/);
  assert.match(src, /M\.queueNote\(M\.MAX_ACTIVE, memoryHold, capInfo\(\)\.limited\)/);
});


test('the packaged runtime includes the memory-pressure module imported by main', () => {
  const manifest = require('../package.json');
  assert.ok(manifest.build.files.includes('memory-pressure.js'));
});
