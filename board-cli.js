#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveBoardAuth, controllingTerminal } = require('./board-credentials');

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
  const auth = resolveBoardAuth({
    env: process.env, tty: controllingTerminal(), filename: __filename, action: command.action,
  });
  const controlDir = auth.controlDir;
  const token = auth.token;
  if (!controlDir || !token) {
    fail('This terminal is independent. Only conductor-managed terminals can use the board control channel.');
  }
  const id = `${Date.now()}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const requestFile = path.join(controlDir, 'requests', `${id}.json`);
  const responseFile = path.join(controlDir, 'responses', `${id}.json`);
  atomicJson(requestFile, { id, token, createdAt: Date.now(), ...command });
  // The launch wrapper can run while Electron is quitting. Its exit status is
  // already durably queued; never keep the shell alive waiting for a renderer
  // that is shutting down. User complete/ask/progress still wait for acceptance.
  if (command.action === 'session-exit') return { done: true };

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
    '  complete --result "One to three sentences" [--files path1,path2] [--failed "Reason"]\n' +
    '  ask --question "Decision needed from the Captain"\n' +
    '  status\n\n' +
    'Captain only (队长, the main session):\n' +
    '  notify-user --message "User action needed" [--urgent]   local alert; urgent also sends Bark\n' +
    '  notify-user --test                        Bark 【测试】 notification, critical / volume 3\n' +
    '  task add --project "Project" --title "Task" [--detail "Description"] [--depends id,id] [--verify]\n' +
    '  task list [--project "Project"] [--status todo|doing|review|needs_user|done]\n' +
    '  task move --id <card-id> --status todo|doing|review|needs_user|done\n' +
    '  task archive --done [--project "Project"]\n' +
    '  ledger                                   every session: id, title, state, last receipt\n' +
    '  quota                                    passive subscription status, one provider per line\n' +
    '  briefing                                 current Captain instructions, read-only\n' +
    '  new --title "One line" --task "Task" [--project "Project"] [--reviews id[,id]] [--task-id <card-id>] [--cwd path] [--agent claude|agy|cursor|grok|codex | --command "launch"]\n' +
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

  if (action === 'notify-user') {
    const testing = args.test === true;
    if ((args.test !== undefined && !testing) ||
        (testing ? args.message !== undefined || args.urgent !== undefined :
          typeof args.message !== 'string' || !args.message.trim() || args.message.length > 4000 ||
          (args.urgent !== undefined && args.urgent !== true))) {
      fail('notify-user requires --message (1–4000 characters) and optional --urgent, or --test alone.');
    }
    const response = await request({ action: 'main-notify-user',
      message: testing ? '【测试】AgentDeck Bark 通知（critical，音量 3）。' : args.message,
      urgent: testing || args.urgent === true, test: testing }, false);
    process.stdout.write(`${response.result || ''}\n`);
    return;
  }

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
    const message = typeof args.message === 'string' ? args.message : args._.slice(1).join(' ');
    if (!message.trim()) fail('progress requires --message.');
    await request({ action, message }, false);
    process.stdout.write('Progress recorded.\n');
    return;
  }

  if (action === 'complete') {
    const result = typeof args.result === 'string' ? args.result : args._.slice(1).join(' ');
    if (!result.trim()) fail('complete requires --result.');
    if (args.files !== undefined && typeof args.files !== 'string') fail('complete --files requires comma-separated paths.');
    if (args.failed !== undefined && (typeof args.failed !== 'string' || !args.failed.trim())) fail('complete --failed requires a reason.');
    await request({ action, result, files: args.files ? args.files.split(',').map((p) => p.trim()).filter(Boolean) : [], failed: args.failed || '' }, false);
    process.stdout.write('Result delivered to the parent task.\n');
    return;
  }

  if (action === 'ask') {
    if (typeof args.question !== 'string' || !args.question.trim()) fail('ask requires --question.');
    await request({ action, question: args.question }, false);
    process.stdout.write('Question delivered to the Captain.\n');
    return;
  }

  // App launch wrappers report the actual agent exit status, even though its
  // parent interactive shell remains alive. Not a worker completion command.
  if (action === 'session-exit') {
    const code = typeof args.code === 'string' ? Number(args.code) : NaN;
    if (!Number.isInteger(code)) fail('session-exit requires an integer --code.');
    await request({ action, code }, false);
    return;
  }

  // ---- main session ----
  if (action === 'task') {
    const op = args._[1];
    if (!['add', 'list', 'move', 'archive'].includes(op)) fail('task requires add, list, move or archive.');
    const input = {};
    for (const key of ['project', 'title', 'detail', 'id', 'status']) {
      if (args[key] !== undefined) {
        if (typeof args[key] !== 'string' || key !== 'detail' && !args[key].trim()) fail(`task --${key} requires a value.`);
        input[key] = args[key];
      }
    }
    if (args.depends !== undefined) {
      if (typeof args.depends !== 'string') fail('--depends requires comma-separated ids.');
      input.depends_on = args.depends.split(',').map((v) => v.trim()).filter(Boolean);
    }
    if (args.verify !== undefined && args.verify !== true) fail('--verify is a boolean flag.');
    input.verify = args.verify === true;
    input.done = args.done === true;
    const response = await request({ action: 'main-task', op, input }, false);
    process.stdout.write(`${response.result}\n`);
    return;
  }
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
    for (const key of ['project', 'task-id']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) fail(`new --${key} requires a value.`);
    if (args.reviews !== undefined && (typeof args.reviews !== 'string' || !args.reviews.split(',').every((id) => /^[A-Za-z0-9_-]{1,160}$/.test(id.trim())))) fail('new --reviews requires session ids separated by commas.');
    const response = await request({
      action: 'main-new', title, task,
      project: typeof args.project === 'string' ? args.project.trim() : '',
      reviews: typeof args.reviews === 'string' ? [...new Set(args.reviews.split(',').map((id) => id.trim()))] : [],
      agent: typeof args.agent === 'string' ? args.agent : '',
      command: typeof args.command === 'string' ? args.command : '',
      cwd: typeof args.cwd === 'string' ? args.cwd : '',
      boardId: typeof args['task-id'] === 'string' ? args['task-id'] : '',
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

  if (action === 'quota' || action === 'briefing') {
    const response = await request({ action: 'main-' + action }, false);
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
