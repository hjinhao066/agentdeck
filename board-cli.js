#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fail(message, code = 1) {
  process.stderr.write(`[AgentDeck Board] ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { out._.push(value); continue; }
    const eq = value.indexOf('=');
    if (eq > 2) {
      out[value.slice(2, eq)] = value.slice(eq + 1);
      continue;
    }
    const key = value.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(command, waitForCompletion) {
  const controlDir = process.env.AGENTDECK_CONTROL_DIR;
  const token = process.env.AGENTDECK_CONTROL_TOKEN;
  if (!controlDir || !token) {
    fail('This terminal is independent. Only conductor-managed terminals can use the board control channel.');
  }
  const id = `${Date.now()}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const requestFile = path.join(controlDir, 'requests', `${id}.json`);
  const responseFile = path.join(controlDir, 'responses', `${id}.json`);
  atomicJson(requestFile, { id, token, createdAt: Date.now(), ...command });

  const timeoutMs = Math.max(5000, Number(command.timeoutMs) || (waitForCompletion ? 6 * 60 * 60 * 1000 : 30000));
  const deadline = command.expiresAt === undefined ? Date.now() + timeoutMs : Math.min(Date.now() + timeoutMs, command.expiresAt);
  let announcedChild = false;
  while (true) {
    try {
      const response = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
      if (response.error) {
        try { fs.unlinkSync(responseFile); } catch (_) {}
        fail(response.error);
      }
      if (!response.done && response.childId && !announcedChild) {
        announcedChild = true;
        process.stderr.write(`[AgentDeck Board] Worker created: ${response.childId}. Waiting for its result...\n`);
      }
      if (response.done) {
        try { fs.unlinkSync(responseFile); } catch (_) {}
        return response;
      }
    } catch (_) {}
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  if (command.expiresAt !== undefined && Date.now() >= command.expiresAt) {
    try { fs.unlinkSync(requestFile); } catch (_) {}
    try { fs.unlinkSync(responseFile); } catch (_) {}
    return { done: true, result: '' };
  }
  fail(`Timed out waiting for board request ${id}.`, 2);
}

function usage() {
  process.stdout.write(
    'AgentDeck managed-terminal bridge\n\n' +
    '  create-child --title "Task" --task "Instructions" [--agent claude|agy|cursor|grok] [--cwd path]\n' +
    '  spawn-child --title "Task" --task "Instructions" [--agent claude|agy|cursor|grok]\n' +
    '  wait --task <task-id>\n' +
    '  send --task <task-id> --message "Follow-up or answer"\n' +
    '  progress --message "Current progress"\n' +
    '  complete --result "Useful final result"\n' +
    '  status\n\n' +
    'Captain only (队长, the main session):\n' +
    '  ledger                                   every session: id, title, state, last receipt\n' +
    '  quota                                    passive subscription status, one provider per line\n' +
    '  new --title "One line" --task "Task" [--cwd path] [--agent claude|agy|cursor|grok | --command "launch"]\n' +
    '  tell --to <session-id> --message "Instruction" [--replace] [--now]\n' +
    '  stop --id <session-id>                    interrupt the current operation (Esc)\n' +
    '  archive --id <session-id>                 end the terminal and archive, without confirmation\n' +
    '  read --id <session-id> [--turns 3] [--find "words"]   saved prompts and final replies, cut short;\n' +
    '                                           also a 队长 conversation from before a clear (ids in ledger)\n' +
    '  read --id captain-history --find "words"   search across all old 队长 conversations\n' +
    '  peek --id <session-id> [--lines 40]       live terminal output, plain text (1–1000 rows)\n' +
    '  receipts                                 receipts not yet seen\n' +
    '  receipts --wait [--timeout seconds]       block for unread receipts/questions; empty on timeout\n' +
    '  answer --to <session-id> --key y|n|1-9|enter|esc   answer a confirmation prompt\n'
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args._[0];
  if (!action || action === 'help' || args.help) { usage(); return; }

  if (action === 'create-child' || action === 'spawn-child') {
    const title = String(args.title || '').trim();
    const task = String(args.task || args._.slice(1).join(' ')).trim();
    if (!title || !task) fail('create-child requires --title and --task.');
    const response = await request({
      action,
      title,
      task,
      agent: String(args.agent || 'claude'),
      command: typeof args.command === 'string' ? args.command : '',
      cwd: typeof args.cwd === 'string' ? args.cwd : '',
      relationship: typeof args.relationship === 'string' ? args.relationship : 'Delegated by parent',
      timeoutMs: Number(args.timeout) || undefined,
    }, action === 'create-child');
    if (action === 'spawn-child') {
      process.stdout.write(`${response.childId}\n`);
    } else {
      process.stdout.write(`${response.result || 'Worker completed without a written result.'}\n`);
    }
    return;
  }

  if (action === 'wait') {
    const taskId = String(args.task || args._[1] || '').trim();
    if (!taskId) fail('wait requires --task.');
    const response = await request({ action, taskId, timeoutMs: Number(args.timeout) || undefined }, true);
    process.stdout.write(`${response.result || 'Worker completed without a written result.'}\n`);
    return;
  }

  if (action === 'send') {
    const taskId = String(args.task || '').trim();
    const message = String(args.message || args._.slice(1).join(' ')).trim();
    if (!taskId || !message) fail('send requires --task and --message.');
    await request({ action, taskId, message }, false);
    process.stdout.write('Message sent.\n');
    return;
  }

  if (action === 'progress') {
    const message = String(args.message || args._.slice(1).join(' ')).trim();
    if (!message) fail('progress requires --message.');
    await request({ action, message }, false);
    process.stdout.write('Progress recorded.\n');
    return;
  }

  if (action === 'complete') {
    const result = String(args.result || args._.slice(1).join(' ')).trim();
    if (!result) fail('complete requires --result.');
    await request({ action, result }, false);
    process.stdout.write('Result delivered to the parent task.\n');
    return;
  }

  // ---- main session ----
  if (action === 'stop' || action === 'archive') {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) fail(`${action} requires --id.`);
    const response = await request({ action: 'main-' + action, to: id }, false);
    process.stdout.write(`${response.result}\n`);
    return;
  }
  if (action === 'ledger' || action === 'receipts') {
    if (action === 'receipts' && args.wait === true) {
      const seconds = args.timeout === undefined ? undefined : (typeof args.timeout === 'string' && args.timeout.trim() ? Number(args.timeout) : NaN);
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0 || seconds > Number.MAX_SAFE_INTEGER / 1000)) fail('receipts --timeout must be a non-negative number of seconds.');
      const expiresAt = seconds === undefined ? undefined : Date.now() + seconds * 1000;
      // One background CLI process, short authenticated reads: a cancelled
      // watcher leaves no long-lived request that could eat a later receipt.
      do {
        const pollExpiresAt = Math.min(Date.now() + 5000, expiresAt === undefined ? Infinity : expiresAt);
        const response = await request({ action: 'main-receipts', wait: true, expiresAt: pollExpiresAt }, false);
        if (response.result) { process.stdout.write(`${response.result}\n`); return; }
        if (expiresAt !== undefined && Date.now() >= expiresAt) return;
        await sleep(Math.min(1000, expiresAt === undefined ? 1000 : Math.max(0, expiresAt - Date.now())));
      } while (expiresAt === undefined || Date.now() < expiresAt);
      return;
    }
    const response = await request({ action: 'main-' + action }, false);
    process.stdout.write(`${response.result || ''}\n`);
    return;
  }
  if (action === 'new') {
    const title = String(args.title || '').trim();
    const task = String(args.task || args._.slice(1).join(' ')).trim();
    if (!title || !task) fail('new requires --title and --task.');
    const response = await request({
      action: 'main-new', title, task,
      agent: typeof args.agent === 'string' ? args.agent : '',
      command: typeof args.command === 'string' ? args.command : '',
      cwd: typeof args.cwd === 'string' ? args.cwd : '',
    }, false);
    process.stdout.write(`${response.result}\n`);
    return;
  }
  if (action === 'tell') {
    const to = String(args.to || '').trim();
    const message = String(args.message || args._.slice(1).join(' ')).trim();
    if (!to || !message) fail('tell requires --to and --message.');
    const response = await request({ action: 'main-tell', to, message, replace: args.replace === true, now: args.now === true }, false);
    process.stdout.write(`${response.result}\n`);
    return;
  }
  if (action === 'answer') {
    const to = String(args.to || '').trim();
    const key = String(args.key || args._[1] || '').trim();
    if (!to || !key) fail('answer requires --to and --key.');
    const response = await request({ action: 'main-answer', to, key }, false);
    process.stdout.write(`${response.result}\n`);
    return;
  }
  if (action === 'peek') {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) fail('peek requires --id.');
    const lines = args.lines === undefined ? 40 : (typeof args.lines === 'string' ? Number(args.lines) : NaN);
    if (!Number.isInteger(lines) || lines < 1 || lines > 1000) fail('peek --lines must be an integer from 1 to 1000.');
    const response = await request({ action: 'main-peek', to: id, lines }, false);
    process.stdout.write(`${response.result || ''}\n`);
    return;
  }
  if (action === 'read') {
    const id = String(args.id || args._[1] || '').trim();
    if (!id) fail('read requires --id.');
    const response = await request({
      action: 'main-read', to: id, turns: Number(args.turns) || 3,
      find: typeof args.find === 'string' ? args.find : '',
    }, false);
    process.stdout.write(`${response.result}\n`);
    return;
  }

  if (action === 'quota') {
    const response = await request({ action: 'main-quota' }, false);
    process.stdout.write(`${response.result || ''}\n`);
    return;
  }
  if (action === 'status') {
    const response = await request({ action }, false);
    process.stdout.write(`${JSON.stringify(response.snapshot || {}, null, 2)}\n`);
    return;
  }

  fail(`Unknown action: ${action}`);
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
