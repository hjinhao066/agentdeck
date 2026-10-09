#!/usr/bin/env node
'use strict';

// Auto-route E2E specs: cross-platform specs go to the Windows PC (one group, in the
// background over ssh), Mac-only specs and everything when Windows is not usable go to the
// local Mac queue.
//   node scripts/e2e-auto.js tests/e2e/a.spec.js [tests/e2e/b.spec.js ...] [--host winpc] [-- playwright args]
//   node scripts/e2e-auto.js --status
// What Windows tests is the working tree as it is now (committed or not): a dirty tree is
// snapshotted into a temporary commit, so Windows never runs older code than the Mac would.
// Returns the exit code of the test run.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const defaultSay = (message) => console.log(`[e2e-auto] ${message}`);

// Exit codes of e2e-remote-win that mean "Windows could not run it", not "a test failed":
// 255 ssh lost, 75 queue wait timed out, 10-15 setup (git init/fetch/checkout, npm ci, job file,
// waiting for another job's dependency install).
const INFRA_EXIT_CODES = new Set([255, 75, 10, 11, 12, 13, 14, 15]);

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

// ---- Mac-only detection -----------------------------------------------------------------
// A spec is Mac-only when it carries a platform skip that is true on Windows:
// test.skip / test.fixme / test.describe.skip(<cond>) or a `skip: <cond>` option, where
// <cond> uses only the platform, string literals, ! && || == != === !== and constants like
// `const isWin = process.platform === 'win32'`. The condition is evaluated for win32.
// A skip that also depends on something else (a loop variable, an env var) is not counted:
// those specs still run on Windows. A skip inside one test also counts (the whole file goes
// to the Mac: the safe side, never a wasted failing Windows run).

// Comments blanked out; `inString[i]` is 1 where position i is inside a string/template literal.
function scan(source) {
  const clean = source.split('');
  const inString = new Uint8Array(source.length);
  for (let i = 0; i < source.length;) {
    const c = source[i], n = source[i + 1];
    if (c === '/' && n === '/') { while (i < source.length && source[i] !== '\n') clean[i++] = ' '; }
    else if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2), stop = end < 0 ? source.length : end + 2;
      for (; i < stop; i++) if (source[i] !== '\n') clean[i] = ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c && !(c !== '`' && source[j] === '\n')) j += source[j] === '\\' ? 2 : 1;
      for (let k = i + 1; k < Math.min(j, source.length); k++) inString[k] = 1;
      i = j + 1;
    } else i++;
  }
  return { text: clean.join(''), inString };
}

// The first argument / option value starting at `from`: up to a top-level , ) or }.
function expressionAt(text, from) {
  let depth = 0, quote = null, i = from;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return text.slice(from, i).trim();
}

const PLATFORM_REFS = [
  /\brequire\s*\(\s*['"](?:node:)?os['"]\s*\)\s*\.\s*platform\s*\(\s*\)/g,
  /\bprocess\s*\.\s*platform\b/g,
  /\b[A-Za-z_$][\w$]*\s*\.\s*platform\s*\(\s*\)/g, // os.platform(), nodeOs.platform()
];
const SAFE_TOKENS = /^(?:\s+|true\b|false\b|'[^'\\]*'|"[^"\\]*"|===|!==|==|!=|&&|\|\||!|\(|\))*$/;

// true/false when `expr` is a pure platform condition (evaluated for win32), else null.
function onWindows(expr, aliases) {
  let text = expr, uses = false;
  for (const ref of PLATFORM_REFS) text = text.replace(ref, () => { uses = true; return "'win32'"; });
  text = text.replace(/\b[A-Za-z_$][\w$]*\b/g, (word) => {
    if (word === 'true' || word === 'false') return word;
    if (aliases.has(word)) { uses = true; return String(aliases.get(word)); }
    return word;
  });
  if (!uses || !SAFE_TOKENS.test(text)) return null;
  try { return Boolean(Function(`"use strict"; return (${text});`)()); } catch { return null; }
}

function isMacOnlySource(source) {
  const { text, inString } = scan(String(source));
  const aliases = new Map();
  for (const m of text.matchAll(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+?)\s*;?[ \t]*$/gm)) {
    if (inString[m.index]) continue;
    const value = onWindows(m[2], aliases);
    if (value !== null) aliases.set(m[1], value);
  }
  const calls = /\b(?:test|it)\s*(?:\.\s*describe\s*)?(?:\.\s*(?:serial|parallel)\s*)?\.\s*(?:skip|fixme)\s*\(|\bskip\s*:/g;
  for (const m of text.matchAll(calls)) {
    if (inString[m.index]) continue;
    if (onWindows(expressionAt(text, m.index + m[0].length), aliases) === true) return true;
  }
  return false;
}

function isMacOnlySpec(specPath) {
  try { return isMacOnlySource(fs.readFileSync(specPath, 'utf8')); } catch { return false; }
}

// ---- arguments -------------------------------------------------------------------------
// Returns { status, host, specs, playwrightArgs }. Anything else before `--` is an error:
// silently dropping e.g. --grep would run a whole file when one test was meant.
function parseArgs(argv) {
  const args = { status: false, host: 'winpc', specs: [], playwrightArgs: [] };
  const dashdash = argv.indexOf('--');
  if (dashdash >= 0) { args.playwrightArgs = argv.slice(dashdash + 1); argv = argv.slice(0, dashdash); }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--status') args.status = true;
    else if (arg === '--host') { if (!argv[i + 1]) throw new Error('--host needs a value'); args.host = argv[++i]; }
    else if (arg.endsWith('.spec.js')) args.specs.push(arg);
    else throw new Error(`Unrecognized argument "${arg}". Spec files end in .spec.js; Playwright options go after --`);
  }
  return args;
}

// ---- running ---------------------------------------------------------------------------
// The commit Windows should test: HEAD when the tree is clean, otherwise a throw-away commit
// of the working tree (tracked changes and new, non-ignored files). HEAD, the index, the
// branch and the stash are left alone.
function snapshotCommit(cwd = ROOT) {
  const git = (args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const head = git(['rev-parse', 'HEAD']);
  if (!git(['status', '--porcelain'])) return head;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-auto-index-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    git(['read-tree', 'HEAD'], env);
    git(['add', '-A'], env);
    const who = { GIT_AUTHOR_NAME: 'e2e-auto', GIT_AUTHOR_EMAIL: 'e2e-auto@localhost', GIT_COMMITTER_NAME: 'e2e-auto', GIT_COMMITTER_EMAIL: 'e2e-auto@localhost' };
    return git(['commit-tree', git(['write-tree'], env), '-p', head, '-m', 'e2e-auto snapshot of the working tree'], who);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function runLocal(specs, playwrightArgs) {
  const { main: queueMain } = require('./e2e-queue');
  return queueMain(['--', process.execPath, path.join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', ...specs, ...playwrightArgs], process.env);
}

// All specs in ONE group: one bundle, one queue slot on Windows, one Electron start-up each.
async function runOnWindows(specs, playwrightArgs, host) {
  const { main: remoteMain } = require('./e2e-remote-win');
  return remoteMain([snapshotCommit(), ...specs, '--host', host, ...(playwrightArgs.length ? ['--', ...playwrightArgs] : [])]);
}

const realDeps = { say: defaultSay, isMacOnlySpec, isWindowsOnline, runOnWindows, runLocal };

async function main(argv = process.argv.slice(2), overrides = {}) {
  const deps = { ...realDeps, ...overrides };
  const say = deps.say;
  const args = parseArgs(argv);
  if (args.status) { const { main: queueMain } = require('./e2e-queue'); return queueMain(['--queue-status'], process.env); }
  if (!args.specs.length) {
    console.error('[e2e-auto] Usage: e2e-auto.js [--status] | tests/e2e/spec.js [spec.js...] [--host H] [-- playwright args]');
    return 2;
  }

  const local = args.specs.filter((spec) => deps.isMacOnlySpec(path.join(ROOT, spec)));
  let windows = args.specs.filter((spec) => !local.includes(spec));
  if (local.length) say(`${local.length} Mac-only spec(s), running locally via queue`);
  if (windows.length && !deps.isWindowsOnline(args.host)) {
    say('Windows offline, routing all cross-platform specs to local Mac queue');
    local.push(...windows); windows = [];
  }

  let exitCode = 0;
  if (windows.length) {
    say(`${windows.length} cross-platform spec(s), sending to Windows`);
    let code;
    try { code = await deps.runOnWindows(windows, args.playwrightArgs, args.host); }
    catch (error) { say(`Windows run could not be completed (${error.message})`); code = 255; }
    if (INFRA_EXIT_CODES.has(code)) {
      say(`Windows could not run the specs (exit ${code}), falling back to the local Mac queue`);
      local.push(...windows);
    } else if (code !== 0) {
      exitCode = code;
      say(`Windows run failed (exit ${code}). If a spec only works on macOS/POSIX, mark it with test.skip(process.platform === 'win32', 'reason') so it routes to the Mac`);
    }
  }
  if (local.length) {
    const code = await deps.runLocal(local, args.playwrightArgs);
    if (code !== 0) exitCode = code;
  }
  return exitCode;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (error) => { console.error(`[e2e-auto] ${error.message}`); process.exit(2); });
}

module.exports = { parseArgs, isMacOnlySource, isMacOnlySpec, isWindowsOnline, snapshotCommit, main, INFRA_EXIT_CODES };
