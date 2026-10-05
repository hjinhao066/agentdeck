#!/usr/bin/env node
'use strict';

// One detached process owns one installation. No launchd/KeepAlive supervisor.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { createBarkSender } = require('../notify-user');
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function requireFile(file) { if (!fs.existsSync(file)) throw new Error(`Missing prerequisite: ${file}`); }
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function defaults(env = process.env) {
  return { appPath: env.AGENTDECK_APP || '/Applications/AgentDeck.app',
    data: env.AGENTDECK_DATA || path.join(os.homedir(), 'Library/Application Support/agentdeck'),
    backups: env.AGENTDECK_BACKUPS || path.join(os.homedir(), 'Library/Caches/AgentDeck-install-backups'),
    log: env.AGENTDECK_LOG || path.join(os.homedir(), 'Library/Logs/AgentDeck-restart.log'),
    taskId: env.AGENTDECK_TASK_ID, columnId: env.AGENTDECK_COLUMN_ID };
}
function parseArgs(args) {
  const out = defaults();
  const values = { '--dmg': 'dmg', '--sha256': 'sha256', '--asar-sha256': 'asarSha256', '--version': 'targetVersion', '--backup': 'backup', '--task-id': 'taskId', '--column-id': 'columnId', '--request': 'request' };
  for (let i = 0; i < args.length; i++) {
    if (['--go', '--child', '--rollback', '--with-data'].includes(args[i])) out[args[i].slice(2)] = true;
    else if (values[args[i]] && args[i + 1] && !args[i + 1].startsWith('--')) out[values[args[i]]] = args[++i];
    else throw new Error(`Unknown option or missing value: ${args[i]}`);
  }
  return out;
}
function macOperations(options) {
  const startedAt = Date.now();
  let deadline = startedAt + 20 * 60 * 1000;
  const run = (command, args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Installation exceeded 20 minute deadline');
    return execFileSync(command, args, { encoding: 'utf8', timeout: Math.min(120000, remaining), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  };
  const version = (app) => { requireFile(path.join(app, 'Contents/Info.plist')); return run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents/Info.plist')]); };
  const running = () => {
    const executable = path.join(options.appPath, 'Contents/MacOS/AgentDeck');
    return run('/bin/ps', ['-axo', 'command=']).split('\n').some((line) => line === executable || line.startsWith(executable + ' '));
  };
  const stop = async () => {
    if (!running()) return;
    run('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(options.appPath)} to quit`]);
    for (let i = 0; i < 60; i++) { if (!running()) return; await sleep(1000); }
    throw new Error('Application did not quit within 60s; no processes killed');
  };
  return { version, running, stop,
    recoveryBudget() { deadline = startedAt + 25 * 60 * 1000; },
    verify(app) { requireFile(path.join(app, 'Contents/MacOS/AgentDeck')); requireFile(path.join(app, 'Contents/Resources/app.asar')); version(app); run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]); },
    copy(from, to) { requireFile(from); run('/usr/bin/ditto', [from, to]); },
    async start() { requireFile(options.appPath); run('/usr/bin/open', [options.appPath]); },
    async healthy() { for (let i = 0; i < 30; i++) { if (running()) { await sleep(10000); return running(); } await sleep(1000); } return false; },
    async source() {
      if (options.rollback) { requireFile(path.join(options.backup, 'AgentDeck.app')); return { app: path.join(options.backup, 'AgentDeck.app'), cleanup() {} }; }
      requireFile(options.dmg);
      if (!/^[a-f0-9]{64}$/i.test(options.sha256 || '') || crypto.createHash('sha256').update(fs.readFileSync(options.dmg)).digest('hex') !== options.sha256.toLowerCase()) throw new Error('DMG checksum does not match');
      const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-install-'));
      const cleanup = () => { try { run('/usr/bin/hdiutil', ['detach', mount]); } catch (_) {} try { fs.rmdirSync(mount); } catch (_) {} };
      try { run('/usr/bin/hdiutil', ['attach', options.dmg, '-verify', '-noignorebadchecksums', '-readonly', '-nobrowse', '-mountpoint', mount]); }
      catch (error) { cleanup(); throw error; }
      return { app: path.join(mount, 'AgentDeck.app'), cleanup };
    },
    async notify(result) {
      // Same urgent Bark transport as notify-user, available while Electron is down.
      const message = `AgentDeck ${result.targetVersion} ${result.operation === 'rollback' ? '回滚' : '安装失败'}：${result.reason.slice(0, 500)}；现役 ${result.activeVersion || '未知'}${result.running ? '，已启动' : '，未运行'}`;
      let config = {};
      try { config = JSON.parse(fs.readFileSync(path.join(options.data, 'config.json'), 'utf8')); } catch (_) {}
      const response = await createBarkSender({ getConfig: () => config })({ message, level: 'critical' });
      return response.ok;
    },
  };
}
async function install(options, ops = macOperations(options)) {
  const resultFile = path.join(options.data, 'install-result.json');
  const result = { id: options.id || crypto.randomUUID(), status: 'pending', targetVersion: options.targetVersion || 'unknown',
    activeVersion: null, reason: '', appPath: options.appPath, attempts: 0, createdAt: new Date().toISOString(),
    operation: options.rollback ? 'rollback' : 'install', taskId: options.taskId, columnId: options.columnId, running: false, notificationSent: false };
  const lock = path.join(options.data, 'install.lock');
  fs.mkdirSync(options.data, { recursive: true });
  // Never break another installer's lock, even after a crash: manual investigation
  // must precede a new install, rather than another retry cycle.
  fs.mkdirSync(lock);
  const claim = path.join(options.data, 'install-claims', result.id);
  try {
    fs.mkdirSync(path.dirname(claim), { recursive: true });
    fs.writeFileSync(claim, result.createdAt, { flag: 'wx', mode: 0o600 });
  } catch (error) { fs.rmdirSync(lock); throw new Error(`Installation already claimed: ${result.id}`); }
  let source, backup, replaced = false;
  const stage = options.appPath + `.stage-${result.id}`;
  const displaced = options.appPath + `.previous-${result.id}`;
  const active = () => { try { result.activeVersion = ops.version(options.appPath); } catch (_) { result.activeVersion = null; } try { result.running = ops.running(); } catch (_) { result.running = false; } };
  const restore = async () => {
    if (!replaced) return;
    requireFile(backup);
    if (ops.recoveryBudget) ops.recoveryBudget();
    await ops.stop();
    fs.rmSync(stage, { recursive: true, force: true });
    ops.copy(backup, stage); ops.verify(stage);
    fs.rmSync(options.appPath, { recursive: true, force: true });
    fs.renameSync(stage, options.appPath);
    replaced = false;
    fs.rmSync(displaced, { recursive: true, force: true });
    await ops.start();
    if (!await ops.healthy()) throw new Error('Restored old application did not stay running');
  };
  try {
    active(); atomicJson(resultFile, result);
    source = await ops.source(); ops.verify(source.app);
    const sourceVersion = ops.version(source.app);
    if (options.targetVersion && sourceVersion !== options.targetVersion) throw new Error(`Source version ${sourceVersion} differs from target ${options.targetVersion}`);
    result.targetVersion = sourceVersion;
    if (options.asarSha256 && crypto.createHash('sha256').update(fs.readFileSync(path.join(source.app, 'Contents/Resources/app.asar'))).digest('hex') !== options.asarSha256) throw new Error('Source asar checksum does not match');
    ops.verify(options.appPath);
    const backupDir = path.join(options.backups, `${Date.now()}-${result.id}`);
    fs.mkdirSync(backupDir, { recursive: true });
    backup = path.join(backupDir, 'AgentDeck.app');
    await ops.stop();
    ops.copy(options.appPath, backup); ops.verify(backup);
    for (const item of ['config.json', 'chats', 'sessions', 'long-prompts', 'board-control']) {
      const from = path.join(options.data, item);
      if (fs.existsSync(from)) ops.copy(from, path.join(backupDir, 'userData', item));
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      result.attempts = attempt; atomicJson(resultFile, result);
      try {
        await ops.stop();
        fs.rmSync(stage, { recursive: true, force: true });
        requireFile(source.app); ops.copy(source.app, stage); ops.verify(stage);
        if (ops.version(stage) !== result.targetVersion) throw new Error('Staged version mismatch');
        fs.renameSync(options.appPath, displaced); replaced = true;
        fs.renameSync(stage, options.appPath);
        fs.rmSync(displaced, { recursive: true, force: true });
        ops.verify(options.appPath);
        if (options['with-data']) {
          const dataBackup = path.join(options.backup, 'userData'); requireFile(dataBackup);
          for (const item of ['config.json', 'chats', 'sessions', 'long-prompts', 'board-control']) {
            const from = path.join(dataBackup, item);
            if (fs.existsSync(from)) ops.copy(from, path.join(options.data, item));
          }
        }
        await ops.start();
        if (!await ops.healthy()) throw new Error('Target application did not stay running');
        active();
        if (result.activeVersion !== result.targetVersion || !result.running) throw new Error('Active version/process verification failed');
        result.status = 'success'; result.reason = options.rollback ? 'Requested rollback verified' : 'Target version and running process verified';
        break;
      } catch (error) {
        result.reason = error.message;
        await restore();
        if (attempt === MAX_ATTEMPTS) throw error;
      }
    }
  } catch (error) {
    result.status = 'failed'; result.reason = error.message;
    if (ops.recoveryBudget) ops.recoveryBudget();
    try { await restore(); } catch (restoreError) { result.reason += `; rollback failed: ${restoreError.message}`; }
    // A failure before replacement can still follow a graceful stop.
    if (!replaced) { try { if (!ops.running()) { await ops.start(); await ops.healthy(); } } catch (_) {} }
    active();
  } finally {
    if (source) { try { source.cleanup(); } catch (_) {} }
    fs.rmSync(stage, { recursive: true, force: true });
    result.finishedAt = new Date().toISOString(); active(); atomicJson(resultFile, result);
    if (result.status === 'failed' || options.rollback) {
      try { result.notificationSent = await ops.notify(result); } catch (_) { result.notificationSent = false; }
      atomicJson(resultFile, result);
    }
    fs.rmdirSync(lock);
    if (options.entryLock) fs.rmdirSync(options.entryLock);
  }
  return result;
}
async function main(argv) {
  const options = parseArgs(argv);
  if (options.child) {
    requireFile(options.request);
    const request = JSON.parse(fs.readFileSync(options.request, 'utf8'));
    fs.unlinkSync(options.request);
    try {
      const result = await install(request);
      console.log(JSON.stringify(result));
      process.exitCode = result.status === 'success' ? 0 : 1;
    } catch (error) {
      const ops = macOperations(request);
      const failure = { id: request.id, status: 'failed', targetVersion: request.targetVersion, appPath: request.appPath, taskId: request.taskId, columnId: request.columnId, createdAt: new Date().toISOString(), attempts: 0, running: false, activeVersion: null, notificationSent: false, reason: error.message };
      try { failure.activeVersion = ops.version(request.appPath); failure.running = ops.running(); } catch (_) {}
      atomicJson(path.join(request.data, 'install-result.json'), failure);
      try { failure.notificationSent = await ops.notify(failure); atomicJson(path.join(request.data, 'install-result.json'), failure); } catch (_) {}
      try { fs.rmdirSync(request.entryLock); } catch (_) {}
      throw error;
    }
    return;
  }
  if (options.rollback && !options.backup) {
    requireFile(options.backups);
    const entries = fs.readdirSync(options.backups).sort().reverse();
    options.backup = entries.map((name) => path.join(options.backups, name)).find((dir) => fs.existsSync(path.join(dir, 'AgentDeck.app')));
    if (!options.backup) throw new Error('No app backup found');
  }
  if (!options.go) { console.log('Plan only. Add --go to run the one-shot installer (maximum 3 attempts).', JSON.stringify(options)); return; }
  for (const key of ['appPath', 'data', 'backups', 'log', 'dmg', 'backup']) {
    if (options[key]) options[key] = path.resolve(options[key]);
  }
  if (options['with-data'] && process.env.AGENTDECK_BOARD_CLI) throw new Error('--with-data requires an unmanaged terminal so task/control state is not overwritten');
  fs.mkdirSync(options.data, { recursive: true });
  options.entryLock = path.join(options.data, 'install-entry.lock');
  fs.mkdirSync(options.entryLock);
  let handedOff = false, registered = false;
  try {
  const existingResult = path.join(options.data, 'install-result.json');
  if (fs.existsSync(existingResult)) {
    const previous = JSON.parse(fs.readFileSync(existingResult, 'utf8'));
    if (previous.status === 'pending') throw new Error('Previous installation is pending; inspect its result before starting another');
    if (previous.taskId) {
      let ack = {};
      try { ack = JSON.parse(fs.readFileSync(existingResult + '.ack.json', 'utf8')); } catch (_) {}
      if (ack.id !== previous.id || ack.receipt !== true) throw new Error('Previous installation result has not been acknowledged');
    }
  }
  options.id = crypto.createHash('sha256').update(JSON.stringify([options.appPath, options.dmg || options.backup, options.sha256 || '', options.targetVersion || '', options.rollback || false])).digest('hex');
  if (fs.existsSync(path.join(options.data, 'install-claims', options.id))) throw new Error('This artifact installation was already attempted; inspect the saved result before manually clearing its claim');
  if (!options.targetVersion && options.rollback) options.targetVersion = macOperations(options).version(path.join(options.backup, 'AgentDeck.app'));
  if (!options.targetVersion) throw new Error('--version is required');
  if (process.env.AGENTDECK_BOARD_CLI) {
    requireFile(process.env.AGENTDECK_BOARD_CLI);
    const receipt = JSON.parse(run(process.execPath, [process.env.AGENTDECK_BOARD_CLI, 'progress', '--message', '安装待核对', '--install-id', options.id, '--target-version', options.targetVersion]));
    if (!receipt.taskId || !receipt.columnId) throw new Error('Install registration did not return task identity');
    options.taskId = receipt.taskId; options.columnId = receipt.columnId;
  }
  registered = true;
  const request = path.join(options.data, `install-request-${options.id}.json`);
  atomicJson(request, options);
  atomicJson(path.join(options.data, 'install-result.json'), { id: options.id, status: 'pending', targetVersion: options.targetVersion, appPath: options.appPath, taskId: options.taskId, columnId: options.columnId, createdAt: new Date().toISOString(), attempts: 0, running: false, notificationSent: false });
  fs.mkdirSync(path.dirname(options.log), { recursive: true });
  const fd = fs.openSync(options.log, 'a');
  const child = spawn(process.execPath, [__filename, '--child', '--request', request], { detached: true, stdio: ['ignore', fd, fd] });
  child.on('error', async (error) => {
    const failure = { id: options.id, status: 'failed', targetVersion: options.targetVersion, appPath: options.appPath, taskId: options.taskId, columnId: options.columnId, createdAt: new Date().toISOString(), attempts: 0, running: false, notificationSent: false, reason: `Installer could not start: ${error.message}` };
    atomicJson(path.join(options.data, 'install-result.json'), failure);
    try { failure.notificationSent = await macOperations(options).notify(failure); atomicJson(path.join(options.data, 'install-result.json'), failure); } catch (_) {}
    try { fs.rmdirSync(options.entryLock); } catch (_) {}
    process.exitCode = 1;
  });
  handedOff = true;
  child.unref(); fs.closeSync(fd);
  console.log(`Installation pending verification (${options.id}), pid ${child.pid}; result: ${path.join(options.data, 'install-result.json')}. Do not complete the task before the final result.`);
  } catch (error) {
    if (registered && !handedOff) {
      const ops = macOperations(options);
      const failure = { id: options.id, status: 'failed', targetVersion: options.targetVersion, appPath: options.appPath, taskId: options.taskId, columnId: options.columnId, createdAt: new Date().toISOString(), attempts: 0, running: false, activeVersion: null, notificationSent: false, reason: `Installer launch preparation failed: ${error.message}` };
      try { failure.activeVersion = ops.version(options.appPath); failure.running = ops.running(); } catch (_) {}
      try { atomicJson(path.join(options.data, 'install-result.json'), failure); } catch (_) {}
      try { failure.notificationSent = await ops.notify(failure); atomicJson(path.join(options.data, 'install-result.json'), failure); } catch (_) {}
    }
    throw error;
  } finally { if (!handedOff) fs.rmdirSync(options.entryLock); }
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { MAX_ATTEMPTS, defaults, parseArgs, atomicJson, macOperations, install, main };
