#!/usr/bin/env node
'use strict';
// Isolated, repeatable transport smoke. No installed app, shared boards, or live
// credentials are read. Usage: node scripts/fleet-two-machine-smoke.js --ssh winpc
// Add --report /absolute/report.md; omit --ssh for a local transport rehearsal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');
const assert = require('assert/strict');
const { SharedStore } = require('../shared-store');
const { startSyncServer } = require('../sync-server');
const { FleetClient, SYNC_MS } = require('../sync-client');
const { TaskStore } = require('../task-board');
const MODULES = ['shared-store.js', 'sync-server.js', 'sync-client.js', 'task-board.js', 'main-core.js', 'quota-core.js', 'claude-seats-core.js', 'auto-verify-core.js'];
function sourceHash(base) {
  const hash = crypto.createHash('sha256');
  for (const file of [...MODULES, 'scripts/fleet-two-machine-smoke.js']) hash.update(file).update(fs.readFileSync(path.join(base, file)));
  return hash.digest('hex');
}

const args = process.argv.slice(2);
const opt = (name) => args[args.indexOf('--' + name) + 1];
const has = (name) => args.includes('--' + name);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTDECK_')));

function machine(config) {
  const tasks = new TaskStore(path.join(config.data, 'tasks'), { deviceId: config.id });
  const client = new FleetClient({
    baseUrl: config.url, tokenFile: config.tokenFile, device: { id: config.id, name: config.name, platform: process.platform },
    taskStore: tasks, historyDir: path.join(config.data, 'history'), stateFile: path.join(config.data, 'state.json'),
    sessions: () => [{ id: config.id + '-captain', role: 'captain', title: config.name + ' captain' }],
    version: 'smoke', syncMs: config.syncMs,
  });
  return {
    async call(action, input = {}) {
      if (action === 'info') return { platform: process.platform, node: process.version, data: config.data, sourceHash: sourceHash(path.resolve(__dirname, '..')) };
      if (action === 'start') { await client.start(); return client.snapshot(); }
      if (action === 'stop') { client.stop(); await client.tail; return true; }
      if (action === 'sync') return client.syncOnce();
      if (action === 'read') return { cards: tasks.list({ archived: true }), status: client.snapshot(), pending: [...client.taskOutbox.values()] };
      if (action === 'add') { const result = tasks.add(input); client.noteResult(result); return result.card; }
      if (action === 'edit') {
        const card = tasks.list({ archived: true }).find((item) => item.id === input.id);
        assert.ok(card, 'card exists before editing');
        const result = tasks.update({ id: card.id, updated: card.updated, patch: input.patch });
        client.noteResult(result); return result.card;
      }
      if (action === 'history') { client.noteCaptain(config.id + '-captain', { turns: input.turns }); return true; }
      if (action === 'files') {
        const state = fs.readFileSync(config.data + '/state.json', 'utf8');
        const historyDir = path.join(config.data, 'history');
        return { state, boards: tasks.list({ archived: true }), history: fs.existsSync(historyDir) ? fs.readdirSync(historyDir).map((file) => JSON.parse(fs.readFileSync(path.join(historyDir, file), 'utf8'))) : [] };
      }
      throw new Error('Unknown smoke action');
    },
  };
}

async function worker(file) {
  const peer = machine(JSON.parse(fs.readFileSync(file, 'utf8')));
  const lines = readline.createInterface({ input: process.stdin });
  let tail = Promise.resolve();
  lines.on('line', (line) => {
    tail = tail.then(async () => {
      const request = JSON.parse(line);
      try { process.stdout.write(JSON.stringify({ id: request.id, result: await peer.call(request.action, request.input) }) + '\n'); }
      catch (error) { process.stdout.write(JSON.stringify({ id: request.id, error: error.message }) + '\n'); }
    });
  });
  lines.on('close', () => { tail.finally(async () => { await peer.call('stop'); process.exit(0); }); });
}

function rpc(child) {
  let next = 0;
  let diagnostics = '';
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let response;
    try { response = JSON.parse(line); } catch (_) { return; }
    const item = pending.get(response.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(response.id);
    response.error ? item.reject(new Error(response.error)) : item.resolve(response.result);
  });
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
  child.on('exit', (code) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Peer exited: ' + code + (diagnostics ? '; ' + diagnostics.trim() : ''))); }
    pending.clear();
  });
  return {
    call(action, input = {}) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Peer request timed out: ' + action)); }, 90_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, action, input }) + '\n');
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      const timer = setTimeout(() => child.kill(), 5000);
      try { await this.call('stop'); } finally { child.stdin.end(); await exited; clearTimeout(timer); }
    },
  };
}

function remote(host, script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', host, 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env: cleanEnv(), encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function run() {
  const host = has('ssh') ? opt('ssh') : null;
  if (host && has('quick')) throw new Error('Real-machine verification uses the production 10-second interval; omit --quick.');
  const syncMs = has('quick') ? 100 : SYNC_MS;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-fleet-smoke-'));
  const token = crypto.randomBytes(32).toString('hex');
  const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const evidence = [];
  const staged = path.join(root, 'source');
  fs.mkdirSync(path.join(staged, 'scripts'), { recursive: true });
  for (const file of [...MODULES, 'scripts/fleet-two-machine-smoke.js']) fs.copyFileSync(path.resolve(__dirname, '..', file), path.join(staged, file));
  const bundleHash = sourceHash(staged);
  let hub, peer, winDir;
  const logs = [];
  const store = new SharedStore({ file: path.join(root, 'hub', 'store.json'), ...(has('quick') ? { leaseMs: 10_000 } : {}) });
  const startHub = (port = 0) => startSyncServer({ store, token, port, log: (line) => logs.push(line) });
  const mark = (text) => { evidence.push(text); console.log(text); };
  const waitFor = async (check, label) => {
    const start = performance.now();
    while (performance.now() - start < 60_000) {
      if (await check()) {
        const elapsed = Math.round(performance.now() - start);
        assert.ok(elapsed < 60_000, label + ' converged after the 60-second limit');
        return elapsed;
      }
      await delay(has('quick') ? 40 : 400);
    }
    throw new Error(label + ' did not converge within 60 seconds');
  };
  let mac;
  try {
    hub = await startHub();
    const hubPort = hub.port;
    const peerConfig = { id: 'dev-smoke-windows', name: host ? 'Windows smoke' : 'Local peer smoke', url: hub.url, tokenFile, data: path.join(root, 'peer'), syncMs };
    if (host) {
      const runId = path.basename(root);
      winDir = remote(host, `$d = Join-Path $env:TEMP '${runId}'; New-Item -ItemType Directory -Path ($d + '\\scripts') -Force | Out-Null; $d.Replace('\\', '/')`);
      assert.match(winDir, /^[A-Za-z]:\/[^\r\n]+$/);
      execFileSync('scp', [...MODULES.map((file) => path.join(staged, file)), `${host}:${winDir}/`], { env: cleanEnv(), timeout: 120_000, stdio: 'pipe' });
      execFileSync('scp', [path.join(staged, 'scripts', 'fleet-two-machine-smoke.js'), `${host}:${winDir}/scripts/`], { env: cleanEnv(), timeout: 120_000, stdio: 'pipe' });
      peerConfig.data = winDir + '/data';
      peerConfig.tokenFile = winDir + '/token';
      const remotePort = 40000 + crypto.randomInt(18000);
      peerConfig.url = 'http://127.0.0.1:' + remotePort;
      const configFile = path.join(root, 'peer-config.json');
      fs.writeFileSync(configFile, JSON.stringify(peerConfig), { mode: 0o600 });
      execFileSync('scp', [tokenFile, configFile, `${host}:${winDir}/`], { env: cleanEnv(), timeout: 120_000, stdio: 'pipe' });
      peerConfig.spawn = () => rpc(spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-R', `${remotePort}:127.0.0.1:${hubPort}`, host, `node "${winDir}/scripts/fleet-two-machine-smoke.js" --worker "${winDir}/peer-config.json"`], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] }));
    } else {
      const configFile = path.join(root, 'peer-config.json');
      fs.writeFileSync(configFile, JSON.stringify(peerConfig), { mode: 0o600 });
      peerConfig.spawn = () => rpc(spawn(process.execPath, [__filename, '--worker', configFile], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] }));
    }
    peer = peerConfig.spawn();
    const info = await peer.call('info');
    if (host) assert.equal(info.platform, 'win32');
    assert.equal(info.sourceHash, bundleHash, 'peer has identical staged test source');
    mark(`Environment: Mac ${process.version}/${process.platform}; peer ${info.node}/${info.platform}; ${host ? 'real SSH reverse forwarding' : 'local rehearsal'}; interval ${syncMs} ms.`);
    mark('Identical source bundle SHA-256: ' + bundleHash + '.');
    mac = machine({ id: 'dev-smoke-mac', name: 'Mac smoke', url: hub.url, tokenFile, data: path.join(root, 'mac'), syncMs });
    await mac.call('start'); await peer.call('start');
    const card = await mac.call('add', { project: 'fleet-smoke', title: 'Mac initial title', detail: 'Initial detail' });
    const latency = await waitFor(async () => (await peer.call('read')).cards.some((item) => item.id === card.id), 'Mac-to-peer card');
    assert.ok(latency < 60_000);
    mark(`Automatic Mac-to-peer card propagation: ${latency} ms, below 60 seconds.`);
    await peer.call('edit', { id: card.id, patch: { detail: 'Windows automatic detail' } });
    const reverseLatency = await waitFor(async () => (await mac.call('read')).cards.find((item) => item.id === card.id)?.detail === 'Windows automatic detail', 'peer-to-Mac edit');
    mark(`Automatic peer-to-Mac edit propagation: ${reverseLatency} ms, below 60 seconds.`);
    await mac.call('stop'); await peer.call('stop');
    await mac.call('sync'); await peer.call('sync');
    assert.equal((await peer.call('read')).status.devices.find((item) => item.id === 'dev-smoke-mac').online, true);
    mark('Both native peers are online and retain device-scoped captain/session identities.');

    await mac.call('edit', { id: card.id, patch: { title: 'Mac conflicting title' } });
    await peer.call('edit', { id: card.id, patch: { title: 'Windows conflicting title' } });
    const operation = (await peer.call('read')).pending.find((item) => item.cardId === card.id);
    await mac.call('sync');
    const priorOps = new Set(Object.keys(store.data.ops));
    await peer.call('sync'); await mac.call('sync');
    // The client can reseed an unattempted operation before sending. Replay the
    // identifier actually acknowledged by the hub, rather than the queued one.
    operation.opId = Object.keys(store.data.ops).find((id) => !priorOps.has(id) && store.data.ops[id].status === 409 && store.data.ops[id].body.card.id === card.id);
    assert.ok(operation.opId, 'hub retained the applied conflict operation');
    for (const side of [mac, peer]) {
      const current = (await side.call('read')).cards.find((item) => item.id === card.id);
      assert.equal(current.title, 'Mac conflicting title');
      assert.ok(current.conflicts.some((item) => item.fields.title.kept === 'Mac conflicting title' && item.fields.title.other === 'Windows conflicting title'));
    }
    const before = store.snapshot().cards.find((item) => item.id === card.id);
    for (let i = 0; i < 2; i++) {
      const response = await fetch(hub.url + '/v1/tasks', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ ...operation, deviceId: 'dev-smoke-windows' }) });
      assert.equal(response.status, 409);
    }
    const after = store.snapshot().cards.find((item) => item.id === card.id);
    assert.deepEqual(after, before);
    mark('Same-field conflict preserves both titles on both disks; repeated identical operations leave revision and conflict count unchanged.');

    await hub.close(); hub = null;
    await peer.call('edit', { id: card.id, patch: { detail: 'Offline Windows durable edit' } });
    const offline = await peer.call('sync');
    assert.match(offline.error, /连不上/);
    assert.equal((await peer.call('read')).pending.length, 1);
    await peer.close(); peer = null;
    hub = await startHub(hubPort);
    peer = peerConfig.spawn();
    assert.equal((await peer.call('read')).pending.length, 1);
    await peer.call('sync'); await mac.call('sync');
    assert.equal((await mac.call('read')).cards.find((item) => item.id === card.id).detail, 'Offline Windows durable edit');
    assert.equal((await peer.call('read')).pending.length, 0);
    mark(`Actual hub outage, ${host ? 'Windows process exit and SSH reconnect' : 'peer process restart'}, and disk outbox replay preserve the offline edit and clear its pending operation.`);

    await mac.call('history', { turns: [{ prompt: 'Mac captain history', ts: new Date().toISOString(), token }] });
    await peer.call('history', { turns: [{ prompt: 'Windows captain history', ts: new Date().toISOString(), password: token }] });
    await mac.call('sync'); await peer.call('sync'); await mac.call('sync');
    for (const side of [mac, peer]) {
      const disk = await side.call('files');
      assert.equal(disk.history.length, 2);
      assert.ok(disk.history.some((item) => item.turns[0].prompt === 'Mac captain history'));
      assert.ok(disk.history.some((item) => item.turns[0].prompt === 'Windows captain history'));
      assert.equal(JSON.stringify(disk).includes(token), false);
    }
    assert.equal(logs.join('\n').includes(token), false);
    mark('Bidirectional captain history is durable on both disks; credential-shaped fields and test token are absent from state, task/history files, and server logs.');
    await peer.close(); peer = null;
    mark(`Peer disconnected; waiting for the ${store.leaseMs} ms heartbeat lease to expire.`);
    await delay(store.leaseMs + 150);
    await mac.call('sync');
    const quiet = (await mac.call('read')).status.devices.find((item) => item.id === 'dev-smoke-windows');
    assert.equal(quiet.online, false);
    assert.ok(Number.isFinite(Date.parse(quiet.lastSeenAt)));
    assert.equal((await mac.call('read')).status.devices.find((item) => item.id === 'dev-smoke-mac').online, true);
    mark('Disconnected peer becomes offline after the real heartbeat lease and retains its last-seen timestamp; the active Mac remains online.');
    mark('PASS: isolated fleet transport smoke completed. Installed apps, login state, persistent tunnels, and shared task data were not changed.');
  } catch (error) {
    mark('FAIL: ' + error.message.split(token).join('[redacted]'));
    throw error;
  } finally {
    if (mac) await mac.call('stop').catch(() => {});
    if (peer) await peer.close().catch(() => {});
    if (hub) await hub.close();
    if (winDir) {
      try { remote(host, `Remove-Item -LiteralPath '${winDir}' -Recurse -Force`); evidence.push('Windows temporary directory and test token removed.'); }
      catch (_) { evidence.push('Windows cleanup failed; remove temporary directory: ' + winDir); }
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (has('report')) {
      const report = path.resolve(opt('report'));
      fs.mkdirSync(path.dirname(report), { recursive: true });
      fs.writeFileSync(report, '# Fleet isolated transport verification\n\n' + new Date().toISOString() + '\n\n' + evidence.map((line) => '- ' + line).join('\n') + '\n');
    }
  }
}

if (has('worker')) worker(opt('worker')).catch(() => { console.error('Smoke worker failed.'); process.exitCode = 1; });
else run().catch(() => { process.exitCode = 1; });
