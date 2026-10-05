#!/usr/bin/env node
'use strict';

// Opt-in Captain launch command. Owns one private stdio app-server, not a shared daemon.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { createDriver } = require(fs.existsSync(path.join(__dirname, 'codex-captain-driver.js'))
  ? './codex-captain-driver' : '../codex-captain-driver');
const run = promisify(execFile);

async function start({ intervalMs = 60000, model, cwd = process.cwd(), onEvent = () => {} } = {}) {
  const controlDir = process.env.AGENTDECK_CONTROL_DIR;
  const colId = process.env.AGENTDECK_TERMINAL_ID;
  const cli = process.env.AGENTDECK_BOARD_CLI;
  if (!controlDir || !colId || !cli) throw new Error('Start this host as an AgentDeck Captain column with its own control environment.');
  await run(process.execPath, [cli, 'ledger'], { env: process.env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  const lock = path.join(controlDir, 'codex-captain-host.lock');
  // wx excludes a second owner. Reclaim only a lock whose process is gone.
  try {
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    try { process.kill(owner.pid, 0); throw new Error('A native Captain host already owns this profile.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; fs.unlinkSync(lock); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, colId }), { flag: 'wx', mode: 0o600 });
  const server = spawn('codex', ['app-server', '--listen', 'stdio://'], {
    cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let seq = 0, threadId = '', activeTurnId = '', closed = false;
  const pending = new Map();
  const bindingFile = path.join(controlDir, 'codex-captain-host.json');
  function rpc(method, params) {
    if (closed) return Promise.reject(new Error('Native Captain host closed.'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex RPC timeout: ' + method)); }, 30000);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      server.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async function snapshot() {
    const config = JSON.parse(fs.readFileSync(path.join(controlDir, '..', 'config.json'), 'utf8'));
    const session = config.mainSession;
    if (session?.colId !== colId) return { active: false, unread: 0, open: 0 };
    const result = await run(process.execPath, [cli, 'task', 'list'], { env: process.env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    const data = JSON.parse(result.stdout);
    const cards = Array.isArray(data) ? data : data.cards || [];
    const open = cards.filter((c) => c.status !== 'done' && !c.archived).length;
    const receiptResult = await run(process.execPath, [cli, 'receipts', '--snapshot'], { env: process.env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    const receipts = JSON.parse(receiptResult.stdout).receipts;
    const unread = receipts.length;
    const running = (session.tasks || []).some((t) => ['queued', 'waiting', 'working', 'input', 'asking', 'quota'].includes(t.status));
    return { active: !!(open || unread || running), unread, open, receipts };
  }
  const driver = createDriver({ rpc, snapshot, intervalMs,
    acknowledge: async (ids) => {
      const result = await run(process.execPath, [cli, 'receipts', '--ack', JSON.stringify(ids)], { env: process.env, timeout: 10000 });
      onEvent('receipt-ack', { ids, ...JSON.parse(result.stdout) });
    },
    onError: (e) => onEvent('driver-error', { message: e.message }) });
  readline.createInterface({ input: server.stdout }).on('line', (line) => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id);
      if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
    } else if (message.method) {
      if (message.params?.threadId === threadId) {
        if (message.method === 'turn/started') activeTurnId = message.params.turn.id;
        if (message.method === 'turn/completed') activeTurnId = '';
      }
      driver.event(message.method, message.params || {});
      onEvent(message.method, message.params || {});
    }
  });
  server.stderr.on('data', () => {}); // Never print provider diagnostics or tokens.
  const close = () => {
    if (closed) return;
    closed = true; driver.close(); server.stdin.end();
    for (const p of pending.values()) p.reject(new Error('Native Captain host closed.'));
    pending.clear();
    try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.unlinkSync(lock); } catch (_) {}
    setTimeout(() => { if (server.exitCode === null) server.kill(); }, 1500).unref();
  };
  server.on('error', close);
  server.on('exit', (code, signal) => { onEvent('host-exit', { code, signal }); close(); });
  async function fresh() {
    driver.bind('');
    if (activeTurnId) await rpc('turn/interrupt', { threadId, turnId: activeTurnId });
    const result = await rpc('thread/start', { cwd, ...(model ? { model } : {}),
      approvalPolicy: 'never', sandbox: 'danger-full-access',
      developerInstructions: 'You are an AgentDeck Captain driven by a native host. Exactly one periodic driver supplies agentdeck_board_check tool outputs including non-consuming receipt snapshots. Never start a receipts --wait listener or consume receipts separately. The host acknowledges only supplied receipt IDs after a completed turn. On each check, inspect all task cards and receipt snapshots, verify results, resolve blockers, and continue dispatching through the AgentDeck CLI. Tool outputs are events, not human messages. Do not inject terminal input. Check durable task status before repeating actions.' });
    threadId = result.thread.id; driver.bind(threadId);
    fs.writeFileSync(bindingFile, JSON.stringify({ colId, threadId }), { mode: 0o600 });
    onEvent('host-bound', { threadId });
  }
  try {
    await rpc('initialize', { clientInfo: { name: 'agentdeck_captain_host', version: '1' }, capabilities: { experimentalApi: true } });
    server.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    let binding;
    try { binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8')); } catch (_) {}
    if (binding?.colId === colId && typeof binding.threadId === 'string') {
      try {
        await rpc('thread/resume', { threadId: binding.threadId, cwd });
        threadId = binding.threadId; driver.bind(threadId);
        onEvent('host-bound', { threadId });
      } catch (error) {
        // An empty thread/start has no persisted rollout until its first turn.
        if (!error.message.includes('no rollout found for thread id')) throw error;
        await fresh();
      }
    } else await fresh();
  } catch (error) { close(); throw error; }
  return {
    close, fresh, check: () => driver.requestCheck(),
    prompt: (text) => rpc('turn/start', { threadId, input: [{ type: 'text', text }] }),
    threadId: () => threadId,
  };
}

if (require.main === module) {
  let host, incoming = '', draft = '', pasting = false;
  const stop = () => { host?.close(); process.stdin.pause(); if (process.stdin.isTTY) process.stdin.setRawMode(false); process.stdout.write('\x1b[?2004l'); };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?2004h');
  start({ model: process.argv[2], onEvent: (method, p) => {
    if (method === 'host-bound') process.stdout.write('OpenAI Codex · native Captain host\n› ');
    if (method === 'item/agentMessage/delta') process.stdout.write(p.delta);
    if (method === 'turn/completed') process.stdout.write('\n› ');
    if (method === 'driver-error') process.stdout.write('\n巡检未送达：' + p.message + '\n');
    if (method === 'host-exit') { process.stdout.write('\n原生队长宿主已退出。\n'); stop(); }
  } }).then((h) => { host = h; }).catch((e) => { console.error(e.message); process.exitCode = 1; stop(); });
  // Only human/initial briefing input enters this path; timer delivery uses RPC.
  process.stdin.on('data', (data) => {
    incoming += data;
    while (incoming) {
      const marker = pasting ? '\x1b[201~' : '\x1b[200~';
      if (marker.startsWith(incoming) && incoming.length < marker.length) break;
      if (incoming.startsWith(marker)) { pasting = !pasting; incoming = incoming.slice(marker.length); continue; }
      const ch = String.fromCodePoint(incoming.codePointAt(0)); incoming = incoming.slice(ch.length);
      if (pasting) { draft += ch; continue; }
      if (ch === '\x03') { stop(); return; }
      if (ch === '\x7f') { draft = [...draft].slice(0, -1).join(''); process.stdout.write('\b \b'); continue; }
      if (ch === '\r' || ch === '\n') {
        const text = draft; draft = ''; process.stdout.write('\n');
        if (!host || !text.trim()) continue;
        const request = /^\/(?:clear|new)\s*$/.test(text) ? host.fresh() : host.prompt(text);
        request.catch((e) => process.stdout.write('\n' + e.message + '\n'));
      } else { draft += ch; process.stdout.write(ch); }
    }
  });
  process.stdin.on('end', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
}

module.exports = { start };
