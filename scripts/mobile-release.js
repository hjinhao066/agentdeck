#!/usr/bin/env node
'use strict';

// Static hub only. Does not change Caddy, tunnels, or the installed desktop app.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PUBLIC_ORIGIN = 'https://agentdeck.18-139-28-180.sslip.io';
// gate/ is the entrance's login page; the entrance serves it without a login (see deploy/vps/Caddyfile.agentdeck).
const FILES = ['index.html', 'core.js', 'app.js', 'style.css', 'machines.json', 'gate/index.html', 'gate/gate.js', 'gate/gate.css'];
function privateJSON(file) {
  try { return readJSON(file); }
  catch { throw new Error('Cannot read private mobile configuration/credentials'); }
}

function configuration(home = os.homedir()) {
  const privateFile = path.join(home, '.config/agentdeck-remote/mobile-deploy.json');
  const overrides = fs.existsSync(privateFile) ? privateJSON(privateFile) : {};
  if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object' ||
      Object.entries(overrides).some(([key, value]) => !['target', 'origin', 'identityFile', 'authFile', 'hostKeyAlias'].includes(key) || typeof value !== 'string')) {
    throw new Error('Invalid private mobile deployment configuration');
  }
  return { target: 'ubuntu@18-139-28-180.sslip.io:/srv', origin: PUBLIC_ORIGIN,
    hostKeyAlias: '18.139.28.180',
    identityFile: path.join(home, 'portfolio-tracker/binance-proxy.pem'),
    authFile: path.join(home, '.config/agentdeck-remote/vps-access.json'), ...overrides };
}

function build(repo, directory, expected = {}) {
  if (!expected.ref && git(repo, 'status', '--porcelain')) throw new Error('Mobile build requires a clean committed checkout');
  const ref = expected.ref || 'HEAD';
  if (ref.startsWith('-') || /[\s\x00-\x1f]/.test(ref)) throw new Error('Invalid mobile source ref');
  const commit = git(repo, 'rev-parse', '--verify', `${ref}^{commit}`);
  const version = JSON.parse(git(repo, 'show', `${commit}:package.json`)).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid source version');
  if ((expected.version && expected.version !== version) || (expected.commit && expected.commit !== commit)) {
    throw new Error('Mobile source version/commit differs from the release');
  }
  const metadata = { version, commit, builtAt: new Date().toISOString() };
  fs.mkdirSync(directory, { recursive: true });
  for (const name of FILES) {
    let bytes = execFileSync('git', ['show', `${commit}:mobile-web/hub/${name}`], { cwd: repo });
    if (name === 'index.html') {
      let html = bytes.toString('utf8');
      if (!html.includes('</head>')) throw new Error('Hub index is missing </head>');
      if ([...html.matchAll(/<script\b([^>]*)>/gi)].some((match) => !/\bsrc\s*=/i.test(match[1])) ||
          /<style[\s>]|\sstyle\s*=|\son[a-z]+\s*=/i.test(html)) throw new Error('Hub CSP lint failed: inline scripts/styles/event handlers');
      const tags = Object.entries(metadata).map(([key, value]) => `  <meta name="agentdeck-${key}" content="${value}">`).join('\n');
      // A refreshed phone cannot reuse JS/CSS cached from another release.
      html = html.replace(/((?:src|href)="(?:core\.js|app\.js|style\.css))"/g, `$1?v=${commit}"`);
      bytes = Buffer.from(html.replace('</head>', `${tags}\n</head>`));
    }
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), bytes);
  }
  const files = Object.fromEntries(FILES.map((name) => [name, digest(fs.readFileSync(path.join(directory, name)))]));
  const manifest = { ...metadata, files };
  save(path.join(directory, 'release.json'), manifest);
  return manifest;
}

function pageMetadata(html) {
  const result = {};
  for (const key of ['version', 'commit', 'builtAt']) {
    const match = html.match(new RegExp(`<meta name="agentdeck-${key}" content="([^"]+)">`));
    if (!match) throw new Error(`Mobile page has no ${key} stamp (legacy or not deployed)`);
    result[key] = match[1];
  }
  if (!/^\d+\.\d+\.\d+$/.test(result.version) || !/^[a-f0-9]{40}$/.test(result.commit) || !Number.isFinite(Date.parse(result.builtAt))) {
    throw new Error('Invalid mobile page release stamp');
  }
  return result;
}

function reader(config) {
  const origin = new URL(config.origin);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid public mobile origin');
  const local = origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (origin.origin !== PUBLIC_ORIGIN && !local) throw new Error('Mobile verification must use the public sslip HTTPS origin or a loopback fixture');
  const headers = { 'Cache-Control': 'no-cache' };
  if (!local) {
    const auth = privateJSON(config.authFile);
    if (typeof auth.username !== 'string' || typeof auth.password !== 'string') throw new Error('Missing entrance credentials');
    headers.Authorization = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
  }
  return async (name) => {
    const url = new URL(name, origin);
    url.searchParams.set('verify', crypto.randomUUID());
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (response.status !== 200) throw new Error(`Public mobile ${name}: HTTP ${response.status}`);
    if (!/\bno-store\b/i.test(response.headers.get('cache-control') || '')) throw new Error('Public mobile response must use Cache-Control no-store');
    return Buffer.from(await response.arrayBuffer());
  };
}

async function verify(read, expected) {
  const html = await read('/');
  const actual = pageMetadata(html.toString('utf8'));
  for (const key of ['version', 'commit', 'builtAt']) {
    if (expected[key] && actual[key] !== expected[key]) throw new Error(`Mobile ${key} mismatch: online=${actual[key]}, expected=${expected[key]}`);
  }
  if (expected.files) {
    for (const [name, hash] of Object.entries(expected.files)) {
      const bytes = name === 'index.html' ? html : await read('/' + name);
      if (digest(bytes) !== hash) throw new Error(`Public mobile asset mismatch: ${name}`);
    }
    const manifest = JSON.parse((await read('/release.json')).toString('utf8'));
    if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw new Error('Public mobile manifest mismatch');
  }
  return actual;
}

function transport(config) {
  const match = /^([^:]+):(.+)$/.exec(config.target);
  const host = match ? match[1] : null;
  const parent = match ? match[2] : config.target;
  if (!path.posix.isAbsolute(parent) || /[\r\n\x00]/.test(parent) || (host && !/^[\w.@-]+$/.test(host))) throw new Error('Invalid mobile deploy target');
  const shell = (script, args = [], input, raw = false) => {
    const options = { input, encoding: raw ? null : 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };
    let result;
    if (!host) result = execFileSync('bash', ['-euc', script, 'bash', parent, ...args], options);
    else {
      const command = `sudo -n bash -euc ${quote(script)} bash ${[parent, ...args].map(quote).join(' ')}`;
      const alias = config.hostKeyAlias ? ['-o', `HostKeyAlias=${config.hostKeyAlias}`] : [];
      result = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', ...alias, '-i', config.identityFile, host, command], options);
    }
    return raw ? result : result.trim();
  };
  const switchLink = 'ln -s "$2" "$1/agentdeck-hub.next"; mv -Tf "$1/agentdeck-hub.next" "$1/agentdeck-hub" 2>/dev/null || mv -fh "$1/agentdeck-hub.next" "$1/agentdeck-hub"';
  return {
    checkpoint() {
      return shell('cd "$1"; mkdir .agentdeck-mobile-deploy.lock; if [ ! -L agentdeck-hub ] || [ ! -f agentdeck-hub/index.html ]; then rmdir .agentdeck-mobile-deploy.lock; echo "Existing hub with rollback point required" >&2; exit 1; fi; readlink agentdeck-hub');
    },
    pageHash() { return digest(shell('cat "$1/agentdeck-hub/index.html"', [], undefined, true)); },
    upload(directory, release) {
      const tar = execFileSync('tar', ['-C', directory, '-cf', '-', ...FILES, 'release.json'], { maxBuffer: 16 * 1024 * 1024 });
      shell('mkdir -p "$1/$2"; tar -C "$1/$2" -xf -; chmod -R a+rX,go-w "$1/$2"; test -f "$1/$2/index.html"', [release], tar);
    },
    activate(release) { shell(switchLink, [release]); },
    restore(previous) { shell('case "$2" in /*) test -f "$2/index.html" ;; *) test -f "$1/$2/index.html" ;; esac; rm -f "$1/agentdeck-hub.next"; ' + switchLink + '; test "$(readlink "$1/agentdeck-hub")" = "$2"', [previous]); },
    unlock() { shell('rmdir "$1/.agentdeck-mobile-deploy.lock"'); },
  };
}

async function deploy(repo, output, config, expected = {}) {
  const source = fs.realpathSync(repo);
  const destination = path.resolve(output);
  if (destination === source || destination.startsWith(source + path.sep)) throw new Error('Mobile output must be outside the source checkout');
  fs.mkdirSync(output, { recursive: true });
  const report = { status: 'failed', target: config.target, attempts: [], rollback: 'not-needed' };
  let remote, previous;
  let canceled = false;
  const cancel = () => { canceled = true; };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const directory = fs.mkdtempSync(path.join(output, 'mobile-build-'));
    report.release = build(repo, directory, expected);
    const read = reader(config); // Fail before changing the remote if credentials are missing.
    remote = transport(config);
    previous = remote.checkpoint();
    report.previous = previous;
    report.previousPageSha256 = remote.pageHash();
    const release = `agentdeck-hub-releases/${new Date().toISOString().replace(/[-:.]/g, '')}-${crypto.randomUUID()}`;
    report.remoteRelease = release;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (canceled) throw new Error('Mobile deployment canceled');
      try {
        remote.upload(directory, release);
        remote.activate(release);
        report.online = await verify(read, report.release);
        if (canceled) throw new Error('Mobile deployment canceled');
        report.attempts.push({ attempt, status: 'passed' });
        report.status = 'passed';
        break;
      } catch (error) {
        report.attempts.push({ attempt, status: 'failed', error: safeError(error) });
      }
    }
    if (report.status === 'passed') {
      // A full disk/missing output directory is a deployment failure too.
      save(path.join(output, 'mobile-deploy-result.json'), report);
      remote.unlock();
      previous = undefined;
      return report;
    }
    throw new Error('Mobile deployment failed after 3 attempts; stopped');
  } catch (error) {
    report.status = 'failed';
    report.error = safeError(error);
    if (previous) {
      try { remote.restore(previous); report.rollback = 'restored'; }
      catch (rollbackError) { report.rollback = 'failed'; report.rollbackError = safeError(rollbackError); }
    }
    throw new Error(`${report.error}; rollback=${report.rollback}. See ${path.join(output, 'mobile-deploy-result.json')}`);
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    if (previous) {
      try { remote.unlock(); }
      catch (error) { report.status = 'failed'; report.unlockError = safeError(error); }
    }
    if (report.status !== 'passed') {
      try { save(path.join(output, 'mobile-deploy-result.json'), report); }
      catch { throw new Error(`${report.error || 'Cannot save mobile receipt'}; rollback=${report.rollback}; cannot write deployment report`); }
    }
    if (report.unlockError) throw new Error(`Mobile deployment lock release failed; see ${path.join(output, 'mobile-deploy-result.json')}`);
  }
}

// Never echo command stderr, HTTP headers, auth JSON or private shell arguments.
function safeError(error) {
  if (error instanceof SyntaxError) return 'Invalid mobile JSON data';
  if (error.code && /^(E\w+|ERR_\w+)$/.test(error.code)) return `Mobile transport error: ${error.code}`;
  if (error.cmd || error.stderr) return `Mobile transport command failed (exit ${error.status ?? 'unknown'})`;
  return error.message;
}

function activeVersion() {
  if (process.platform === 'darwin') {
    return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '/Applications/AgentDeck.app/Contents/Info.plist'], { encoding: 'utf8' }).trim();
  }
  if (process.platform === 'win32') {
    const asar = require('@electron/asar');
    return JSON.parse(asar.extractFile(path.join(process.env.LOCALAPPDATA, 'Programs/agentdeck/resources/app.asar'), 'package.json')).version;
  }
  throw new Error('Cannot read installed AgentDeck version on this platform; pass --version');
}

function parseArgs(argv) {
  const options = { command: argv[0] };
  if (!['deploy', 'check', 'rollback'].includes(options.command)) throw new Error('Usage: mobile-release.js deploy --output DIR [--ref REF] | check [--version V --commit SHA] | rollback --receipt FILE');
  for (let i = 1; i < argv.length; i++) {
    if (!['--output', '--version', '--commit', '--ref', '--receipt'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid mobile release arguments');
    options[argv[i].slice(2)] = argv[++i];
  }
  if (options.version && !/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error('Invalid version');
  if (options.commit && !/^[a-f0-9]{40}$/.test(options.commit)) throw new Error('Invalid commit');
  if (options.command === 'deploy' && !options.output) throw new Error('Deployment requires --output');
  if (options.command === 'rollback' && !options.receipt) throw new Error('Rollback requires --receipt');
  if (options.ref && options.command !== 'deploy') throw new Error('--ref is only supported for deployment');
  return options;
}

async function rollback(receiptFile, config) {
  const receipt = readJSON(receiptFile);
  if (!receipt.previous || !receipt.remoteRelease || !/^[a-f0-9]{64}$/.test(receipt.previousPageSha256 || '')) throw new Error('Receipt has no exact rollback point');
  if (receipt.target !== config.target) throw new Error('Rollback receipt target differs from configuration');
  const remote = transport(config), read = reader(config);
  const current = remote.checkpoint();
  const result = { status: 'failed', previous: receipt.previous, attempts: [] };
  try {
    if (current !== receipt.remoteRelease) throw new Error('Rollback refused: another release is now current');
    remote.restore(receipt.previous);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (digest(await read('/')) !== receipt.previousPageSha256) throw new Error('Public rollback page does not match the saved rollback point');
        result.attempts.push({ attempt, status: 'passed' }); result.status = 'passed';
        return result;
      } catch (error) { result.attempts.push({ attempt, status: 'failed', error: safeError(error) }); }
    }
    throw new Error('Rollback public verification failed after 3 attempts; stopped');
  } catch (error) { result.error = safeError(error); throw new Error(result.error); }
  finally {
    try { remote.unlock(); }
    catch (error) { result.status = 'failed'; result.unlockError = safeError(error); }
    save(path.join(path.dirname(receiptFile), 'mobile-rollback-result.json'), result);
    if (result.unlockError) throw new Error('Mobile rollback lock release failed');
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  const config = configuration();
  if (options.command === 'check') {
    const version = options.version || activeVersion();
    const online = await verify(reader(config), { version, commit: options.commit });
    console.log(`Mobile OK: online=${online.version}; installed=${version}; commit=${online.commit}; built=${online.builtAt}`);
  } else if (options.command === 'rollback') {
    const result = await rollback(path.resolve(options.receipt), config);
    console.log(`Mobile rolled back to ${result.previous}; public page verified`);
  } else {
    const report = await deploy(git(process.cwd(), 'rev-parse', '--show-toplevel'), path.resolve(options.output), config, options);
    console.log(`Mobile deployed: ${report.release.version} ${report.release.commit}; ${report.attempts.length}/3 attempts; rollback point=${report.previous}`);
  }
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(`\x1b[31mMOBILE FAILED: ${safeError(error)}\x1b[0m`); process.exitCode = 1; });
module.exports = { configuration, build, pageMetadata, reader, verify, transport, deploy, rollback, activeVersion, parseArgs, main };
