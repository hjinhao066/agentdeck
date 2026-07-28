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
  const deadline = Date.now() + timeoutMs;
  let announcedChild = false;
  while (Date.now() < deadline) {
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
    await sleep(250);
  }
  fail(`Timed out waiting for board request ${id}.`, 2);
}

function usage() {
  process.stdout.write(
    'AgentDeck managed-terminal bridge\n\n' +
    '  create-child --title "Task" --task "Instructions" [--agent claude|agy|grok] [--cwd path]\n' +
    '  spawn-child --title "Task" --task "Instructions" [--agent claude|agy|grok]\n' +
    '  wait --task <task-id>\n' +
    '  send --task <task-id> --message "Follow-up or answer"\n' +
    '  progress --message "Current progress"\n' +
    '  complete --result "Useful final result"\n' +
    '  status\n'
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

  if (action === 'status') {
    const response = await request({ action }, false);
    process.stdout.write(`${JSON.stringify(response.snapshot || {}, null, 2)}\n`);
    return;
  }

  fail(`Unknown action: ${action}`);
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
