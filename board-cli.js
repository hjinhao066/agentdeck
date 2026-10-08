#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Worktree = require('./worktree-core');
const { resolveBoardAuth, controllingTerminal } = require('./board-credentials');
const ReceiptListener = require('./receipt-listener-core');
let receiptListener = null;


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
      const key = value.slice(2, eq);
      const item = value.slice(eq + 1);
      if (key === 'path') {
        if (!Array.isArray(out.path)) out.path = [];
        out.path.push(item);
      } else out[key] = item;
      continue;
    }
    const key = value.slice(2);
    let next;
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) next = argv[++i];
    else next = true;
    if (key === 'path') {
      if (!Array.isArray(out.path)) out.path = [];
      out.path.push(next);
      continue;
    }
    out[key] = next;
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

function listenerStopped() {
  // Superseded and expired say why on stdout. The app restarting or the Captain's
  // terminal ending leave quietly: nobody is left to read a reason.
  const result = receiptListener?.superseded() ? ReceiptListener.SUPERSEDED_NOTICE
    : receiptListener?.expired() ? ReceiptListener.EXPIRED_NOTICE : '';
  return { done: true, result, listenerStopped: true };
}

async function request(command, waitForCompletion, authOverride) {
  if (receiptListener && !receiptListener.valid()) return listenerStopped();
  const auth = authOverride || resolveBoardAuth({
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
  const timeoutMs = Math.max(5000, Number(authOverride?.timeoutMs || command.timeoutMs) || (waitForCompletion ? 6 * 60 * 60 * 1000 : 30000));
  const deadline = command.expiresAt === undefined ? Date.now() + timeoutMs : Math.min(Date.now() + timeoutMs, command.expiresAt);
  // CLI shell tools inject their current conversation id. Attach it only to
  // authenticated worker submissions; the receiver binds its own provider.
  const modelSessionIds = {};
  if (['complete', 'ask', 'progress'].includes(command.action)) {
    for (const [provider, key] of [['Codex', 'CODEX_THREAD_ID'], ['Cursor', 'CURSOR_CONVERSATION_ID'], ['Antigravity', 'ANTIGRAVITY_CONVERSATION_ID']]) {
      const value = process.env[key];
      if (typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) modelSessionIds[provider] = value;
    }
  }
  // The app reads `deadline`: a Captain command that changes something is not
  // run once this process has stopped waiting for it.
  atomicJson(requestFile, { id, token, createdAt: Date.now(), ...(LATE_GUARDED.includes(command.action) ? { deadline } : {}), ...command,
    ...(Object.keys(modelSessionIds).length ? { modelSessionIds } : {}) });
  // The launch wrapper can run while Electron is quitting. Its exit status is
  // already durably queued; never keep the shell alive waiting for a renderer
  // that is shutting down. User complete/ask/progress still wait for acceptance.
  if (command.action === 'session-exit') return { done: true };

  let announcedChild = false;
  while (true) {
    if (receiptListener && !receiptListener.valid()) {
      try { fs.unlinkSync(requestFile); } catch (_) {}
      try { fs.unlinkSync(responseFile); } catch (_) {}
      return listenerStopped();
    }
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
  // The request may still be in the app's queue; it will not be run past its
  // deadline. Rarely it took effect just before, so look before sending it again.
  if (authOverride) {
    // An automatic task is not worth a late, surprise delivery: it falls back by itself.
    try { fs.unlinkSync(requestFile); } catch (_) {}
    fail('AgentDeck 没有回应自动回执（没在运行，或版本太旧）。', 2);
  }
  if (LATE_GUARDED.includes(command.action)) fail(`Timed out waiting for board request ${id}. 这条命令过期后不会再被执行；重发前先用 ledger 确认它是否刚好已经生效。`, 2);
  fail(`Timed out waiting for board request ${id}.`, 2);
}

const LATE_GUARDED = ['main-new', 'main-tell', 'main-stop', 'main-archive', 'main-answer', 'main-todo'];

// 待我处理: what the user should come back to. Plain words for 队长, who files the items.
const INBOX_HELP = [
  'inbox：用户的「待我处理」页（桌面侧边栏和手机总台都有），用户不在电脑前时，回来一条条看、就地回复。',
  '  inbox need --title "一句话说明" --ask "一句明确的问题" [--options "回答1|回答2|回答3"] [--type decide|login|pay|question|review|other] [--urgent]',
  '      要用户介入的事：等用户拍板、登录或授权、付款、回答问题、验收卡住。同时发本机提醒和手机提醒：手机上标题是 --title，正文是 --ask 和可选回答，不含队员回执；--urgent 让手机提醒走紧急通道，仅需用户登录/授权或付款时用。',
  '      --ask 写成用户一眼知道要答什么的一句问题；--options 是页面上的快捷回复按钮（最多 6 个，每个最多 24 字，用 | 分隔），用户点一下就回复你，也能自己写。',
  '      看板卡片停在「需要你」或连续失败挂起时，程序不会替你问用户：你先判断是否真要用户定，要的话这样登记并带 --card；不要把队员回执原文当问题贴给用户，原文放 --detail。',
  '  inbox report --title "一句话结论"',
  '      结果汇报：你在对话里告诉用户的那种短结论（含你没认的结论、你替队员做的决定）。用户回来能回头看、逐条回复。',
  '      汇报自动挂到你这一轮回复：用户在对话里看过这轮回复就算已读，不进「做完了你还没看」；所以结论也要在这轮回复里说。',
  '  共用可选：--detail "展开后看的细节和证据" --files 路径1,路径2 --project 项目 --card 卡片id --session 会话id',
  '      --card：need 在这张卡完成时自动打勾；--session：登记时这个会话正停在提问或确认上，答完后自动打勾。',
  '  inbox list [--all]                          未解决的条目和 id；--all 再列最近解决的',
  '  inbox resolve --id 条目id [--note "怎么解决的"]   你替用户办了、用户口头答了、事情过时了，都要 resolve',
  '用户在页面上回复某条，会作为回执交给你，带着原条目；那条随即打勾。用户把要处理的事勾成「已处理」也会告诉你。',
  '标题和要求写用户看得懂的大白话中文，一句话说清；内部 id 放 --card/--session，不要当主要信息。',
  '',
].join('\n');

// 自动回执入口: for scheduled scripts (launchd, Task Scheduler, cron) that run in no
// AgentDeck terminal. Its own token, read from AgentDeck's config folder; it can only do
// the three things below, each marked as coming from a named automatic task.
const AUTOMATION_HELP = [
  'automation：本机定时脚本的「自动回执」入口（不属于任何 AgentDeck 终端，不用终端令牌）。',
  '  automation receipt --source 脚本名 --message "要告诉队长的话"',
  '      给队长一条自动回执，队长看到的是「自动任务：脚本名」，不是用户的话。',
  '  automation task-add --source 脚本名 --project 项目 --title "标题" [--detail "说明"]',
  '      建一张待办卡片（只是记下来，不会自动开始做）。',
  '  automation inbox-report --source 脚本名 --title "一句话结论" [--detail "细节"] [--files 路径1,路径2] [--project 项目]',
  '      在用户的「待我处理」页登记一条结果汇报，标明来自哪个自动任务。',
  '  automation status                          这个入口现在能不能用',
  '--source 是脚本名字：1–40 个字，字母、数字、空格和 . _ - 。',
  '它不能派活、不能 tell、不能读对话、不能改设置；每分钟条数有限（同一个脚本名每分钟 6 条）。',
  '令牌由 AgentDeck 自己生成，存在它的配置目录里（权限 600）；在 AgentDeck 设置的「自动回执」可以停用或重置。',
  '旧版 AgentDeck 没有这个入口，命令会报错，脚本应改成只写报告加本机通知。',
  '',
].join('\n');

const AUTOMATION_FLAGS = {
  status: [], receipt: ['source', 'message'], 'task-add': ['source', 'project', 'title', 'detail'],
  'inbox-report': ['source', 'title', 'detail', 'files', 'project'],
};

async function automationCommand(args) {
  const Automation = require('./automation-core'); // loaded only here: every other command runs without it
  const op = args._[1];
  if (!op || op === 'help' || args.help) { process.stdout.write(AUTOMATION_HELP); return; }
  const flags = AUTOMATION_FLAGS[op];
  if (!flags) fail('automation takes receipt, task-add, inbox-report or status. Run automation help.');
  if (args._.length > 2) fail(`automation ${op}: put text in --flags "..." (quote it).`);
  const extra = Object.keys(args).find((key) => key !== '_' && !flags.includes(key));
  if (extra) fail(`automation ${op} does not take --${extra}. Run automation help.`);
  const input = {};
  for (const key of flags) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== 'string') fail(`automation ${op} --${key} requires a value.`);
    input[key] = key === 'files' ? args.files.split(',').map((p) => p.trim()).filter(Boolean) : args[key];
  }
  const action = 'automation-' + op;
  try { Automation.validate(action, input); } catch (error) { fail(error.message); }
  // The door's own token, never a terminal's: only the config folder says where it is.
  const controlDir = resolveBoardAuth({ env: process.env, tty: '', filename: __filename, action: 'main-ledger' }).controlDir;
  const credentials = Automation.readCredentials(controlDir);
  if (!credentials) fail('这个 AgentDeck 没有自动回执入口（没有找到令牌）：AgentDeck 没启动过，或版本太旧。');
  if (!credentials.enabled) fail('自动回执入口已在 AgentDeck 设置里停用。');
  const response = await request({ action, ...input }, false, { controlDir, token: credentials.token, timeoutMs: op === 'status' ? 8000 : 20000 });
  process.stdout.write(`${response.result || ''}\n`);
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
    'Scheduled scripts on this computer (no terminal needed; automation help for details):\n' +
    '  automation receipt --source name --message "text"        a receipt for the Captain, shown as 自动任务：name\n' +
    '  automation task-add --source name --project P --title T [--detail D]   a 待办 card; starts nothing\n' +
    '  automation inbox-report --source name --title T [--detail D] [--files a,b] [--project P]   a 结果汇报 for the user\n' +
    '  automation status                                        whether the entry is open\n\n' +
    'Captain only (队长, the main session):\n' +
    '  discuss start --topic "题目" [--gemini] [--participants-file path] [--summarizer id]\n' +
    '  discuss status [--id id] | wait --id id | resume --id id [--retry job-id] | cancel --id id\n' +
    '  todo list                                personal Todo items and AI state\n' +
    '  todo status --id td-… --task-id todo-… --status working|needs_user|done|failed [--message "Reason"] [--files path1,path2]\n' +
    '  notify-user --message "User action needed" [--urgent]   local alert; urgent also sends Bark\n' +
    '  notify-user --test                        Bark 【测试】 notification, shared volume setting (default 4)\n' +
    '  inbox need|report|list|resolve            the user\'s 待我处理 page; inbox help for details\n' +
    '  task add --project "Project" --title "Task" [--detail "Description"] [--depends id,id] [--verify] [--priority high]\n' +
    '  task list [--project "Project"] [--status todo|doing|review|needs_user|done] [--priority high|normal]\n' +
    '  task move --id <card-id> --status todo|doing|review|needs_user|done\n' +
    '  task priority --id <card-or-session-id> --level high|normal\n' +
    '                                           高优先级: the user named it urgent. Shown on the board, sidebar and map,\n' +
    '                                           listed first, and started before ordinary work waiting for a slot\n' +
    '  task archive --done [--project "Project"]\n' +
    '  ledger                                   every session: id, title, state, 高优先级 mark, last receipt\n' +
    '  queue list                               unsent new-session requests, ids, commands and reasons\n' +
    '  queue cancel --task-id <card-or-queue-id> cancel an unsent request\n' +
    '                                           new on a queued card replaces a changed command/model; task move to done/todo cancels it\n' +
    '  quota                                    passive subscription status, one Claude seat/provider per line\n' +
    '  settings battery [--boost on|off [--for 90m|2h | --until 23:59]] [--mode off|auto] [--cap 1-10]\n' +
    '                                           电池模式: no flags = read only; flags take effect at once and are saved.\n' +
    '                                           --boost on = 临时拉满: on battery, open sessions up to the normal limit instead of the battery cap\n' +
    '                                           (用户说「强度拉满」); ends at --for/--until, when plugged in, or --boost off. The battery mode itself stays on.\n' +
    '                                           --mode off = 不限制 for good, auto = 没插电时按 --cap 限制同时干活的会话数\n' +
    '  briefing                                 current Captain instructions, read-only\n' +
    '  handoff                                  current Relay handoff from live state; also refreshes the handoff file\n' +
    '  new --title "One line" --task "Task" [--project "Project"] [--reviews id[,id]] [--task-id <card-id>] [--cwd path] [--worktree repo] [--base ref] [--branch name] [--priority high] [--seat cn|us|us2] [--agent claude|agy|cursor|grok|codex|chatgpt-web | --command "launch"] [--web-mode chat|deep-research]\n' +
    '  worktree clean [--apply --path copy]      list copies a person may remove; deletion needs --apply and each --path\n' +
    '  tell --to <session-id> --message "Instruction" [--replace] [--now]\n' +
    '  stop --id <session-id>                    interrupt the current operation (Esc)\n' +
    '  archive --id <session-id>                 end the terminal and archive, without confirmation\n' +
    '  read --id <session-id> [--turns 3] [--find "words"]   saved prompts and final replies, cut short;\n' +
    '                                           also a 队长 conversation from before a clear (ids in ledger)\n' +
    '  read --id captain-history --find "words"   search across all old 队长 conversations\n' +
    '  peek --id <session-id> [--lines 40]       live terminal output, plain text (1–1000 rows)\n' +
    '  receipts                                 receipts not yet seen\n' +
    '  receipts --wait [--timeout seconds]       block for unread receipts/questions; empty on timeout\n' +
    '  receipts --snapshot                      native host: non-consuming JSON batch with stable ids\n' +
    '  receipts --ack \'["receipt-id"]\'           native host: acknowledge only successfully handled ids\n' +
    '  answer --to <session-id> --key y|n|1-9|enter|esc|up|down|tab|space   answer a confirmation prompt;\n' +
    '                                           a comma list presses several keys, e.g. --key down,enter or down:2,enter\n'
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args._[0];
  if (!action || action === 'help' || args.help) { usage(); return; }

  if (action === 'automation') { await automationCommand(args); return; }

  if (action === 'discuss') {
    // The existing read-only action authenticates the Captain even when this
    // source CLI is used alongside an older installed application.
    await request({ action: 'main-ledger' }, false);
    const auth = resolveBoardAuth({ env: process.env, tty: controllingTerminal(), filename: __filename, action: 'main-ledger' });
    const result = await require('./discussion-command').command(args, auth);
    process.stdout.write(typeof result === 'string' ? result + '\n' : JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (action === 'notify-user') {
    const testing = args.test === true;
    if ((args.test !== undefined && !testing) ||
        (testing ? args.message !== undefined || args.urgent !== undefined :
          typeof args.message !== 'string' || !args.message.trim() || args.message.length > 4000 ||
          (args.urgent !== undefined && args.urgent !== true))) {
      fail('notify-user requires --message (1–4000 characters) and optional --urgent, or --test alone.');
    }
    const response = await request({ action: 'main-notify-user',
      message: testing ? 'AgentDeck 加急通知测试' : args.message,
      urgent: testing || args.urgent === true, test: testing }, false);
    process.stdout.write(`${response.result || ''}\n`);
    return;
  }

  if (action === 'inbox') {
    const op = args._[1];
    if (!op || op === 'help') { process.stdout.write(INBOX_HELP); return; }
    if (!['need', 'report', 'list', 'resolve'].includes(op)) fail('inbox takes need, report, list or resolve. Run inbox help.');
    const allowed = { need: ['title', 'ask', 'options', 'type', 'detail', 'files', 'project', 'card', 'session', 'urgent'],
      report: ['title', 'detail', 'files', 'project', 'card', 'session'], list: ['all'], resolve: ['id', 'note'] }[op];
    const extra = Object.keys(args).find((key) => key !== '_' && !allowed.includes(key));
    if (extra) fail(`inbox ${op} does not take --${extra}. Run inbox help.`);
    if (args._.length > 2) fail('inbox: put text in --title "..." (quote it).');
    const input = {};
    for (const key of allowed) {
      if (args[key] === undefined) continue;
      if (key === 'urgent' || key === 'all') {
        if (args[key] !== true) fail(`--${key} takes no value.`);
        input[key] = true;
      } else if (typeof args[key] !== 'string' || !args[key].trim()) fail(`inbox ${op} --${key} requires a value.`);
      else input[key] = key === 'files' ? args.files.split(',').map((p) => p.trim()).filter(Boolean)
        : key === 'options' ? args.options.split(/[|｜]/).map((o) => o.trim()).filter(Boolean) : args[key];
    }
    if (input.options && !input.ask) fail('inbox need --options requires --ask "一句明确的问题".');
    if ((op === 'need' || op === 'report') && !input.title) fail(`inbox ${op} requires --title "一句话结论".`);
    if (op === 'resolve' && !input.id) fail('inbox resolve requires --id <条目id> (see inbox list).');
    const response = await request({ action: 'main-inbox', op, input }, false);
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
    const installId = args['install-id'], targetVersion = args['target-version'];
    if (installId !== undefined && (typeof installId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(installId) || typeof targetVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(targetVersion))) fail('Installation progress requires --install-id and --target-version.');
    const response = await request({ action, message, ...(installId ? { installId, targetVersion } : {}) }, false);
    process.stdout.write(installId ? response.result + '\n' : 'Progress recorded.\n');
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
  if (action === 'todo') {
    const op = args._[1];
    if (!['list', 'status'].includes(op)) fail('todo requires list or status.');
    if (op === 'status' && (typeof args.id !== 'string' || typeof args['task-id'] !== 'string' || !['working', 'needs_user', 'done', 'failed'].includes(args.status) ||
        (args.message !== undefined && typeof args.message !== 'string') || (args.files !== undefined && typeof args.files !== 'string'))) fail('todo status requires --id, --task-id and a valid --status.');
    const response = await request({ action: 'main-todo', op, ...(op === 'status' ? { input: {
      id: args.id, taskId: args['task-id'], status: args.status, message: args.message || '',
      files: args.files ? args.files.split(',').map((file) => file.trim()).filter(Boolean) : [],
    } } : {}) }, false);
    process.stdout.write(`${response.result || ''}\n`);
    return;
  }
  if (action === 'queue') {
    const op = args._[1];
    if (!['list', 'cancel'].includes(op)) fail('queue requires list or cancel.');
    const taskId = args['task-id'];
    if (op === 'cancel' && (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(taskId))) fail('queue cancel requires --task-id <card-or-queue-id>.');
    if (op === 'list' && taskId !== undefined) fail('queue list takes no --task-id.');
    const response = await request({ action: 'main-queue', op, ...(op === 'cancel' ? { taskId } : {}) }, false);
    process.stdout.write(`${response.result}\n`);
    return;
  }
  if (action === 'task') {
    const op = args._[1];
    if (!['add', 'list', 'move', 'archive', 'priority'].includes(op)) fail('task requires add, list, move, priority or archive.');
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
    if (op === 'priority') {
      if (typeof input.id !== 'string' || !['high', 'normal'].includes(args.level)) fail('task priority requires --id <card-or-session-id> and --level high|normal.');
      const response = await request({ action: 'main-task', op, input: { id: input.id, level: args.level } }, false);
      process.stdout.write(`${response.result}\n`);
      return;
    }
    if (args.priority !== undefined) {
      if (!['add', 'list'].includes(op) || !['high', 'normal'].includes(args.priority)) fail('--priority is high or normal, on task add and task list. Change a card with task priority --id <id> --level high|normal.');
      input.priority = args.priority;
    }
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
    if (action === 'receipts' && (args.snapshot !== undefined || args.ack !== undefined)) {
      if (args.wait !== undefined || args.timeout !== undefined || args.snapshot !== undefined && args.ack !== undefined) fail('Native receipt snapshot/ack cannot be combined with wait.');
      let receiptIds;
      if (args.ack !== undefined) {
        try { receiptIds = JSON.parse(args.ack); } catch (_) { fail('receipts --ack requires a JSON array of receipt ids.'); }
        if (!Array.isArray(receiptIds) || receiptIds.length > 50 || receiptIds.some((id) => typeof id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(id))) fail('Invalid receipt ids.');
      } else if (args.snapshot !== true) fail('receipts --snapshot takes no value.');
      const response = await request({ action: receiptIds ? 'main-receipts-ack' : 'main-receipts-snapshot', receiptIds }, false);
      process.stdout.write(`${response.result || ''}\n`);
      return;
    }
    if (action === 'receipts' && args.wait === true) {
      const seconds = args.timeout === undefined ? undefined : (typeof args.timeout === 'string' && args.timeout.trim() ? Number(args.timeout) : NaN);
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0 || seconds > Number.MAX_SAFE_INTEGER / 1000)) fail('receipts --timeout must be a non-negative number of seconds.');
      const auth = resolveBoardAuth({ env: process.env, tty: controllingTerminal(), filename: __filename, action: 'main-receipts' });
      if (!auth.controlDir || !auth.token) fail('This terminal is independent. Only conductor-managed terminals can use the board control channel.');
      try {
        const ownerPid = ReceiptListener.agentOwnerPid();
        receiptListener = ReceiptListener.claim(auth.controlDir, auth.token, ownerPid);
      }
      catch (error) { fail(error.message); }
      // Count --timeout from here: on Windows the owner lookup above starts PowerShell
      // and can take seconds, which must not be taken out of the wait.
      const expiresAt = seconds === undefined ? undefined : Date.now() + seconds * 1000;
      const release = () => receiptListener?.release();
      process.once('exit', release);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => {
        release();
        try { process.stdout.write(`【AgentDeck 监听】收到 ${signal}，监听已退出（不是 AgentDeck 的原因）。需要的话重新挂一个 receipts --wait。\n`); } catch (_) {}
        process.exit(0);
      });
      // Tells the app which listener this is: a newer one in the same terminal takes over.
      const watcher = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`, watcherStartedAt = Date.now();
      // One background CLI process, short authenticated reads: a cancelled
      // watcher leaves no long-lived request that could eat a later receipt.
      do {
        const pollExpiresAt = Math.min(Date.now() + 5000, expiresAt === undefined ? Infinity : expiresAt);
        const response = await request({ action: 'main-receipts', wait: true, expiresAt: pollExpiresAt, listener: receiptListener.lease, watcher, watcherStartedAt }, false);
        if (response.listenerStopped) {
          const stopped = listenerStopped();
          if (stopped.result) process.stdout.write(`${stopped.result}\n`);
          return;
        }
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
    if (String(args.agent).toLowerCase() === 'chatgpt-web') {
      const { validatePublicTask } = require('./chatgpt-web-core');
      try { validatePublicTask(task); validatePublicTask(title); } catch (error) { fail(error.message); }
    }
    for (const key of ['project', 'task-id']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) fail(`new --${key} requires a value.`);
    if (args.reviews !== undefined && (typeof args.reviews !== 'string' || !args.reviews.split(',').every((id) => /^[A-Za-z0-9_-]{1,160}$/.test(id.trim())))) fail('new --reviews requires session ids separated by commas.');
    if (args.seat !== undefined && (typeof args.seat !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(args.seat))) fail('new --seat requires a seat id.');
    if (args['web-mode'] !== undefined && (!['chat', 'deep-research'].includes(args['web-mode']) || args.agent !== 'chatgpt-web')) fail('new --web-mode requires --agent chatgpt-web and chat or deep-research.');
    if (args.priority !== undefined && !['high', 'normal'].includes(args.priority)) fail('new --priority is high or normal.');
    const worktree = args.worktree !== undefined;
    if (worktree && (typeof args.worktree !== 'string' || !args.worktree.trim())) fail('new --worktree requires a repository path.');
    if (!worktree && (args.base !== undefined || args.branch !== undefined)) fail('new --base and --branch require --worktree.');
    if (worktree && typeof args.cwd === 'string' && args.cwd.trim()) fail('new --worktree sets the working directory; do not also pass --cwd.');
    if (worktree && args.branch !== undefined && (typeof args.branch !== 'string' || !args.branch.trim())) fail('new --branch requires a branch name.');
    if (worktree && args.base !== undefined && (typeof args.base !== 'string' || !args.base.trim())) fail('new --base requires a branch or commit.');
    let repo = '';
    if (worktree) {
      let raw = args.worktree.trim();
      if (raw === '~') raw = os.homedir();
      else if (raw.startsWith('~/') || raw.startsWith('~\\')) raw = path.join(os.homedir(), raw.slice(2));
      repo = path.resolve(raw);
      if (args.branch) { try { Worktree.assertBranch(args.branch.trim()); } catch (error) { fail(error.message); } }
    }
    const response = await request({
      action: 'main-new', title, task,
      ...(args['web-mode'] !== undefined ? { webMode: args['web-mode'] } : {}),
      ...(args.seat !== undefined ? { seatId: args.seat } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(worktree ? { worktree: repo, base: typeof args.base === 'string' ? args.base.trim() : '', branch: typeof args.branch === 'string' ? args.branch.trim() : '' } : {}),
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

  if (action === 'settings') {
    if (args._[1] !== 'battery' || args._.length > 2) fail('settings only has battery: settings battery [--mode off|auto] [--cap 1-10].');
    const extra = Object.keys(args).find((key) => !['_', 'mode', 'cap', 'boost', 'for', 'until'].includes(key));
    if (extra) fail(`settings battery does not take --${extra}. Use --boost on|off, --mode off|auto and/or --cap 1-10.`);
    const input = {};
    if (args.boost !== undefined) {
      if (args.boost !== 'on' && args.boost !== 'off') fail('settings battery --boost is on or off.');
      input.boost = args.boost === 'on';
    }
    if (args.for !== undefined || args.until !== undefined) {
      if (input.boost !== true) fail('settings battery --for / --until only go with --boost on.');
      if (args.for !== undefined && args.until !== undefined) fail('settings battery: give --for or --until, not both.');
      if (args.for !== undefined) {
        const m = typeof args.for === 'string' ? /^(\d{1,4})([mh])$/.exec(args.for) : null;
        const minutes = m ? Number(m[1]) * (m[2] === 'h' ? 60 : 1) : 0;
        if (!m || minutes < 1 || minutes > 2880) fail('settings battery --for is a length like 90m or 2h (up to 48h).');
        input.boostMinutes = minutes;
      } else {
        const m = typeof args.until === 'string' ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(args.until) : null;
        if (!m) fail('settings battery --until is a clock time today like 23:59 (the next one if it has passed).');
        const now = new Date(), end = new Date(now);
        end.setHours(Number(m[1]), Number(m[2]), 0, 0);
        if (end <= now) end.setDate(end.getDate() + 1);
        input.boostMinutes = Math.max(1, Math.ceil((end - now) / 60000));
      }
    }
    if (args.mode !== undefined) {
      if (args.mode !== 'off' && args.mode !== 'auto') fail('settings battery --mode is off or auto.');
      input.mode = args.mode;
    }
    if (args.cap !== undefined) {
      if (typeof args.cap !== 'string' || !/^\d{1,3}$/.test(args.cap) || Number(args.cap) < 1 || Number(args.cap) > 10) fail('settings battery --cap is a whole number from 1 to 10.');
      input.cap = Number(args.cap);
    }
    const response = await request({ action: 'main-settings', op: 'battery', input }, false);
    process.stdout.write(`${response.result || ''}\n`);
    return;
  }
  if (action === 'quota' || action === 'briefing' || action === 'handoff') {
    const response = await request({ action: 'main-' + action }, false);
    process.stdout.write(`${response.result || ''}\n`);
    return;
  }
  if (action === 'worktree') {
    if (args._[1] !== 'clean') fail('worktree clean lists copies a person may remove. Deletion needs --apply and one --path per copy.');
    if (args.apply !== undefined && args.apply !== true) fail('worktree clean --apply takes no value.');
    let root;
    if (args.root !== undefined) {
      if (typeof args.root !== 'string' || !args.root.trim()) fail('worktree clean --root requires a path.');
      root = path.resolve(args.root);
      const rel = path.relative(path.resolve(os.tmpdir()), root);
      if (rel.startsWith('..') || path.isAbsolute(rel)) fail('worktree clean --root must stay inside the temp directory.');
    }
    const listed = args.path === undefined ? [] : (Array.isArray(args.path) ? args.path : [args.path]);
    const paths = [];
    for (const item of listed) {
      if (typeof item !== 'string' || !item.trim()) fail('worktree clean --path requires a copy path.');
      paths.push(path.resolve(item));
    }
    const result = Worktree.clean({ root, apply: args.apply === true, paths });
    process.stdout.write(Worktree.formatClean(result) + '\n');
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
