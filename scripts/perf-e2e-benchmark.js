#!/usr/bin/env node
'use strict';

// Measured (never estimated) wall-clock comparison of the same commit on the Windows PC and
// the Mac queue.
//   node scripts/perf-e2e-benchmark.js --mode win --groups 2 --sha <commit> --out DIR <spec> [<spec>...]
//   node scripts/perf-e2e-benchmark.js --mode mac --sha <commit> --out DIR <spec> [<spec>...]
// win: starts N groups at the same moment (each group = all the specs, workers=1, through
//      e2e-remote-win), while a sampler on Windows records total CPU and Defender (MsMpEng)
//      every few seconds, and the desktop session is compared before/after.
// mac: one group through the local e2e-queue; records the queue wait apart from the run
//      time, and the machine load average while it runs. Needs a clean checkout at <commit>.
// Writes DIR/<mode>-<groups>.json and prints a markdown block for benchmark.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const say = (message) => console.log(`[benchmark] ${message}`);
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const round = (n, d = 1) => n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d;

// CSV from verify-windows-background.ps1 -Mode sample -> averages and peaks.
function summarizeSamples(lines) {
  const rows = lines.map((l) => l.trim().split(',')).filter((r) => r.length === 5 && !Number.isNaN(Date.parse(r[0])))
    .map((r) => ({ total: Number(r[1]), defender: Number(r[2]), e2eProcs: Number(r[3]), sessions: r[4] ? r[4].split('+') : [] }));
  const col = (key) => rows.map((r) => r[key]).filter((n) => Number.isFinite(n));
  const sessions = [...new Set(rows.flatMap((r) => r.sessions))].sort();
  return { samples: rows.length,
    totalCpuAvg: round(mean(col('total'))), totalCpuPeak: Math.max(0, ...col('total')),
    defenderAvg: round(mean(col('defender'))), defenderPeak: Math.max(0, ...col('defender')),
    maxE2eProcs: Math.max(0, ...col('e2eProcs')), e2eSessions: sessions };
}

// "P|id|created|name" lines from -Mode snapshot -> the processes that appeared in between.
function newProcesses(beforeLines, afterLines) {
  const parse = (lines) => new Map(lines.filter((l) => l.startsWith('P|')).map((l) => { const [, id, created, name] = l.trim().split('|'); return [`${id}|${created}`, name]; }));
  const before = parse(beforeLines);
  return [...parse(afterLines)].filter(([key]) => !before.has(key)).map(([key, name]) => `${name}(${key.split('|')[0]})`);
}
const snapshotField = (lines, name) => (lines.find((l) => l.startsWith(`${name}=`)) || '').trim().slice(name.length + 1);

// Throughput: how much one-group work gets done per second, relative to one group alone.
const throughputFactor = (singleGroupSec, groups, totalSec) => round((groups * singleGroupSec) / totalSec, 2);

const queueWait = (text) => { const m = /等了\s*(\d+)\s*秒/.exec(text); return m ? Number(m[1]) : 0; };

function parseArgs(argv) {
  const o = { mode: null, groups: 1, sha: null, out: null, host: 'winpc', specs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--mode') o.mode = next(); else if (a === '--groups') o.groups = Number(next());
    else if (a === '--sha') o.sha = next(); else if (a === '--out') o.out = path.resolve(next()); else if (a === '--host') o.host = next();
    else if (a.endsWith('.spec.js')) o.specs.push(a);
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!['win', 'mac'].includes(o.mode)) throw new Error('--mode win|mac is required');
  if (!(o.groups >= 1) || !Number.isInteger(o.groups)) throw new Error('--groups must be a whole number >= 1');
  if (!/^[0-9a-f]{40}$/.test(o.sha || '')) throw new Error('--sha must be a full commit id');
  if (!o.out || !o.specs.length) throw new Error('--out and at least one spec are required');
  return o;
}

const ssh = (host, command, options = {}) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, command], { encoding: 'utf8', ...options });
const REMOTE_DIR = 'agentdeck-bench'; // under the Windows home, outside agentdeck-e2e-win so the sampler is not counted as an E2E process
const PS = (file, args) => `powershell -NoProfile -ExecutionPolicy Bypass -File ${REMOTE_DIR}\\${file} ${args}`;

function resultsOf(dir) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const summary = read('summary.json'), results = read('results.json');
  const stats = results?.stats || {};
  return { playwrightSec: summary?.seconds ?? null, playwrightExit: summary?.exitCode ?? null,
    passed: stats.expected ?? null, failed: (stats.unexpected ?? 0) + (stats.flaky ?? 0), skipped: stats.skipped ?? null };
}

async function runWindows(o) {
  ssh(o.host, `mkdir ${REMOTE_DIR} 2>nul & exit /b 0`);
  execFileSync('scp', ['-q', '-o', 'BatchMode=yes', path.join(__dirname, 'verify-windows-background.ps1'), `${o.host}:${REMOTE_DIR}/verify-windows-background.ps1`]);
  const snap = () => ssh(o.host, PS('verify-windows-background.ps1', '-Mode snapshot')).split(/\r?\n/);
  const before = snap();
  // Idle load of the machine right now (the user is using it), 15 s.
  const baseline = summarizeSamples(ssh(o.host, PS('verify-windows-background.ps1', '-Mode sample -Seconds 15 -Interval 3')).split(/\r?\n/));
  say(`Windows baseline before the run: CPU avg ${baseline.totalCpuAvg}% peak ${baseline.totalCpuPeak}%, Defender avg ${baseline.defenderAvg}%`);

  const sampleLines = [];
  const sampler = spawn('ssh', ['-o', 'BatchMode=yes', o.host, PS('verify-windows-background.ps1', '-Mode sample -Seconds 3000 -Interval 3')], { stdio: ['ignore', 'pipe', 'ignore'] });
  let pending = '';
  sampler.stdout.on('data', (d) => { pending += d; const parts = pending.split(/\r?\n/); pending = parts.pop(); sampleLines.push(...parts); });

  fs.mkdirSync(o.out, { recursive: true });
  const started = Date.now();
  const groups = await Promise.all(Array.from({ length: o.groups }, (_, i) => new Promise((resolve) => {
    const dir = path.join(o.out, `win-${o.groups}-g${i + 1}`);
    const t0 = Date.now();
    const log = fs.createWriteStream(path.join(o.out, `win-${o.groups}-g${i + 1}.console.log`));
    const child = spawn(process.execPath, [path.join(__dirname, 'e2e-remote-win.js'), o.sha, ...o.specs, '--host', o.host, '--out', dir,
      '--queue-wait-timeout', '60', '--queue-run-timeout', '45', '--', '--workers=1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    for (const s of [child.stdout, child.stderr]) s.on('data', (c) => { log.write(c); text += c; });
    child.on('close', (code) => { log.end(); resolve({ group: i + 1, exit: code, wallSec: round((Date.now() - t0) / 1000), queueWaitSec: queueWait(text), ...resultsOf(dir) }); });
  })));
  const totalSec = round((Date.now() - started) / 1000);
  sampler.kill('SIGTERM');
  const after = snap();
  const samples = summarizeSamples(sampleLines);
  const fresh = newProcesses(before, after);
  const check = {
    desktopSession: Number(snapshotField(after, 'desktopSession')),
    e2eSessionsSeenDuringRun: samples.e2eSessions,
    e2eInDesktopSessionAfter: Number(snapshotField(after, 'e2eInDesktopSession')),
    newDesktopProcessesAfter: fresh,
  };
  return { mode: 'win', groups: o.groups, sha: o.sha, specs: o.specs, totalSec, perGroup: groups, baseline, during: samples, windowCheck: check };
}

async function runMac(o) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (head !== o.sha) throw new Error(`This checkout is at ${head.slice(0, 8)}, not ${o.sha.slice(0, 8)}`);
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim()) throw new Error('Tracked files are modified: the Mac run must be the same commit');
  const load = () => { const m = /\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(spawnSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).stdout); return m ? { m1: +m[1], m5: +m[2], m15: +m[3] } : null; };
  const uptimeBefore = spawnSync('uptime', { encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(o.out, { recursive: true });
  const jsonOut = path.join(o.out, 'mac-1.results.json');
  const loads = [load()?.m1].filter(Number.isFinite);
  const t0 = Date.now();
  const log = fs.createWriteStream(path.join(o.out, 'mac-1.console.log'));
  let text = '';
  const child = spawn(process.execPath, [path.join(__dirname, 'e2e-queue.js'), '--queue-wait-timeout', '120', '--queue-run-timeout', '45', '--', process.execPath,
    path.join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', ...o.specs, '--workers=1', '--reporter=list,json'],
  { cwd: ROOT, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [child.stdout, child.stderr]) s.on('data', (c) => { log.write(c); text += c; });
  const timer = setInterval(() => { const l = load()?.m1; if (Number.isFinite(l)) loads.push(l); }, 5000);
  const exit = await new Promise((resolve) => child.on('close', resolve));
  clearInterval(timer); log.end();
  const totalSec = round((Date.now() - t0) / 1000), waited = queueWait(text);
  let stats = {};
  try { stats = JSON.parse(fs.readFileSync(jsonOut, 'utf8')).stats || {}; } catch {}
  return { mode: 'mac', groups: 1, sha: o.sha, specs: o.specs, totalSec, queueWaitSec: waited, runSec: round(totalSec - waited), exit,
    passed: stats.expected ?? null, failed: (stats.unexpected ?? 0) + (stats.flaky ?? 0), skipped: stats.skipped ?? null,
    uptimeBefore, uptimeAfter: spawnSync('uptime', { encoding: 'utf8' }).stdout.trim(), loadAvg1m: { avg: round(mean(loads)), peak: Math.max(...loads) },
    cpus: os.cpus().length };
}

async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  say(`${o.mode} x${o.groups} on ${o.sha.slice(0, 8)}: ${o.specs.join(' ')}`);
  const result = o.mode === 'win' ? await runWindows(o) : await runMac(o);
  const file = path.join(o.out, `${o.mode}-${o.groups}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  say(`saved ${file}`);
  console.log(JSON.stringify(result, null, 2));
  return result.mode === 'win' ? (result.perGroup.every((g) => g.exit === 0) ? 0 : 1) : result.exit;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => { console.error(`[benchmark] ${error.message}`); process.exit(2); });
}

module.exports = { parseArgs, summarizeSamples, newProcesses, snapshotField, throughputFactor, queueWait };
