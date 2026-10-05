const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fake = `node "${path.join(__dirname, 'fixtures/fake-agent.js')}" --screen-only`;
let app, page, profile, prompts;

function column(id, title, extra = {}) {
  return { id, title, displayTitle: title, manualTitle: true, cmd: fake, cwd: profile, width: 460, role: 'manual', captainCrew: true, ...extra };
}
function crewTask(id, colId, title, status, summary, boardId) {
  return {
    id, colId, title, gen: 1, status, sentAt: Date.now(), turnId: '',
    receipt: summary ? { summary, files: [], failed: '', explicit: true, source: 'command' } : null,
    boardId: boardId || '', boardAttempt: boardId ? 'attempt-1' : '',
  };
}

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-restart-resume-v2-'));
  prompts = path.join(profile, 'prompts.jsonl');
  fs.mkdirSync(path.join(profile, 'tasks'), { recursive: true });
  const card = {
    id: 't-live', project: 'agentdeck', title: '重启后续上', detail: '接着干原来的卡片', status: 'doing', flag: null,
    order: 0, depends_on: [], assignee: { agent: 'cursor', model: 'grok-4.7' }, session_id: 'worker-live',
    latest_receipt: '上次写到一半', verify: false, rework_count: 0,
    created: '2026-10-04T06:00:00.000Z', updated: '2026-10-04T06:00:00.000Z', archived: false,
    consecutive_failures: 0, important: false, attempt_id: 'attempt-1', review_session: false, attempt_closed: false,
  };
  const closedCard = { ...card, id: 't-closed', title: '在别处已完成', status: 'done', session_id: 'worker-closed', attempt_closed: true, latest_receipt: '另一处已经完成' };
  fs.writeFileSync(path.join(profile, 'tasks', 'agentdeck.json'), JSON.stringify({ version: 1, project: 'agentdeck', cards: [card, closedCard] }));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    resumeOnRestart: true,
    taskBoard: { dispatcher: 'captain' },
    columns: [
      { ...column('cap', '队长'), isMain: true, captainCrew: false },
      column('worker-live', '永动机', { boardId: 't-live', boardAttempt: 'attempt-1' }),
      column('worker-done', '已做完'),
      column('worker-closed', '卡片已关闭', { boardId: 't-closed', boardAttempt: 'attempt-1' }),
      column('worker-exit', '送达后异常退出', { cmd: fake + ' --exit-after-task' }),
    ],
    mainSession: {
      colId: 'cap', cmd: fake, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: [
        crewTask('k-live', 'worker-live', '永动机', 'working', '上次写到一半', 't-live'),
        crewTask('k-done', 'worker-done', '已做完', 'done', '功能已做完并推送。等待队长验收。'),
        crewTask('k-closed', 'worker-closed', '卡片已关闭', 'paused', '停在安全点', 't-closed'),
        crewTask('k-exit', 'worker-exit', '送达后异常退出', 'working', '原任务仍在进行'),
      ],
    },
  }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  env.AGENTDECK_TEST_PROMPT_COLUMNS_FILE = prompts;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [path.resolve(__dirname, '../..'), `--test-user-data=${profile}`],
    env,
  });
  page = await app.firstWindow();
  await expect.poll(() => page.evaluate(() => typeof window.MainSession === 'object' && !!window.MainSession.mainCol()).catch(() => false), { timeout: 20000 }).toBe(true);
});

test.afterAll(async () => {
  if (app) await app.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

function delivered() {
  if (!fs.existsSync(prompts)) return [];
  return fs.readFileSync(prompts, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('a cold start resends an in-flight card into a new session and leaves finished work alone', async () => {
  await expect.poll(() => delivered().some((row) => row.colId === 'worker-live' && row.text.includes('重发') && row.text.includes('接着干原来的卡片') && row.text.includes('上次写到一半')), { timeout: 30000 }).toBe(true);
  expect(delivered().filter((row) => row.colId === 'worker-live' && row.text.includes('重发'))).toHaveLength(1);
  expect(delivered().some((row) => row.colId === 'worker-done' && (row.text.includes('重发') || row.text.includes('真续接')))).toBe(false);
  await expect.poll(async () => page.evaluate(() => window.TaskBoard.list({ archived: true }).then((cards) => {
    const card = cards.find((item) => item.id === 't-live');
    return card && [card.status, card.attempt_closed, card.session_id, card.latest_receipt].join('|');
  })), { timeout: 20000 }).toBe('doing|false|worker-live|重发：未知 无法续上原对话，这是新会话。');
  const ledger = await page.evaluate(() => window.MainSession.handle({ action: 'main-ledger' }, window.MainSession.mainCol()).then((result) => result.result));
  const live = ledger.split('\n').find((line) => line.startsWith('worker-live'));
  expect(live).toContain('干活中');
  expect(live).toMatch(/^worker-live\s+「永动机」\s+干活中(?:\s|$)/); // release ledger also exposes the terminal's idle state
});

test('a closed card stops the stale local task and gives the captain a specific receipt', async () => {
  await expect.poll(() => page.evaluate(() => window.MainSession.state().tasks.find((t) => t.id === 'k-closed')?.status)).toBe('stopped');
  const task = await page.evaluate(() => window.MainSession.state().tasks.find((t) => t.id === 'k-closed'));
  expect(task.receipt.summary).toContain('卡片 t-closed 核验处');
  expect(task.receipt.summary).toContain('卡片本轮任务已关闭');
  expect(task.restartHold).toBeUndefined();
  const receipts = await page.evaluate(() => {
    const s = window.MainSession.state();
    return [...s.pending, ...s.inflight].filter((r) => r.taskId === 'k-closed');
  });
  expect(receipts).toHaveLength(1);
  expect(receipts[0].summary).toBe(task.receipt.summary);
  expect(delivered().some((row) => row.colId === 'worker-closed' && row.text.includes('刚重启'))).toBe(false);
  const card = await page.evaluate(() => window.TaskBoard.list({ archived: true }).then((cards) => cards.find((c) => c.id === 't-closed')));
  expect(card.status).toBe('done');
  expect(card.latest_receipt).toBe('另一处已经完成');
});


test('a second application restart resumes the unfinished card once again', async () => {
  const before = delivered().filter((row) => row.colId === 'worker-live' && row.text.includes('重发')).length;
  await app.close();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  env.AGENTDECK_TEST_PROMPT_COLUMNS_FILE = prompts;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve(__dirname, '../..'), `--test-user-data=${profile}`], env });
  page = await app.firstWindow();
  await expect.poll(() => delivered().filter((row) => row.colId === 'worker-live' && row.text.includes('重发')).length, { timeout: 30000 }).toBe(before + 1);
  expect(delivered().some((row) => row.colId === 'worker-done' && row.text.includes('刚重启'))).toBe(false);
  const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'restart-resume.json'), 'utf8'));
  expect(manifest.claims['worker-live'].taskId).toBe('k-live');
  expect(manifest.claims['worker-live'].phase).toBe('sent');
  expect(delivered().some((row) => row.colId === 'worker-closed' && row.text.includes('刚重启'))).toBe(false);
});

test('a worker terminal exit after resume delivery is recorded as ordinary task failure', async () => {
  await expect.poll(() => page.evaluate(() => window.MainSession.state().tasks.find((t) => t.id === 'k-exit')?.status), { timeout: 20000 }).toBe('failed');
  const task = await page.evaluate(() => window.MainSession.state().tasks.find((t) => t.id === 'k-exit'));
  expect(task.receipt.source).toBe('process');
  expect(task.receipt.failed).not.toContain('续接失败');
  expect(task.receipt.failed).toContain('exit 7');
  expect(delivered().filter((row) => row.colId === 'worker-exit' && row.text.includes('重发'))).toHaveLength(1);
});

test('a rejected resume launches a new CLI in the same column and its complete closes the same card', async ({}, testInfo) => {
  const profile2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-resume-fallback-'));
  const captured = path.join(profile2, 'prompts.jsonl');
  const launches = path.join(profile2, 'launches.jsonl');
  const script = path.join(profile2, 'stand-in.cjs');
  const executable = path.join(profile2, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(launches)}, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));
if (process.argv.includes('--resume')) process.exit(7);
require(${JSON.stringify(path.join(__dirname, 'fixtures/fake-agent.js'))});`);
  fs.writeFileSync(executable, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o700 });
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const cmd = `"${executable}"`;
  fs.mkdirSync(path.join(profile2, 'tasks'));
  fs.writeFileSync(path.join(profile2, 'tasks', 'fallback.json'), JSON.stringify({ version: 1, project: 'fallback', cards: [{
    id: 'fallback-card', project: 'fallback', title: 'fallback probe', detail: 'EXACT ORIGINAL CARD TASK', status: 'doing', flag: null,
    session_id: 'fallback-worker', attempt_id: 'fallback-attempt', attempt_closed: false, archived: false, verify: false,
    order: 0, depends_on: [], rework_count: 0, latest_receipt: 'EXACT LAST RECEIPT', consecutive_failures: 0,
    created: '2026-10-04T00:00:00.000Z', updated: '2026-10-04T00:00:00.000Z',
  }] }));
  fs.writeFileSync(path.join(profile2, 'config.json'), JSON.stringify({ resumeOnRestart: true, taskBoard: { dispatcher: 'captain' },
    columns: [{ id: 'cap2', title: '队长', cmd: fake, cwd: profile2, isMain: true },
      { id: 'fallback-worker', title: 'fallback probe', cmd, cwd: profile2, captainCrew: true, role: 'manual',
        modelSessionId: sessionId, modelSessionOwner: 'fallback-worker', modelSessionCwd: profile2,
        boardId: 'fallback-card', boardAttempt: 'fallback-attempt' }],
    mainSession: { colId: 'cap2', cmd: fake, gen: 1, fresh: false, crewMarked: true, pending: [], inflight: [], waitlist: [],
      tasks: [{ id: 'fallback-task', colId: 'fallback-worker', title: 'fallback probe', gen: 1, status: 'queued',
        instruction: 'EXACT UNSENT SUPPLEMENT', boardId: 'fallback-card', boardAttempt: 'fallback-attempt' }] } }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENTDECK_')) delete env[key];
  env.AGENTDECK_TEST_PROMPT_COLUMNS_FILE = captured;
  delete env.ELECTRON_RUN_AS_NODE;
  let application, window;
  try {
    application = await electron.launch({ args: [path.resolve(__dirname, '../..'), `--test-user-data=${profile2}`], env });
    window = await application.firstWindow();
    await expect.poll(() => window.evaluate(() => MainSession.state()?.tasks.at(-1)?.status).catch(() => ''), { timeout: 30000 }).toBe('done');
    const calls = fs.readFileSync(launches, 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--resume');
    expect(calls[1]).toContain('--session-id');
    expect(calls[1]).not.toContain(sessionId);
    const texts = fs.readFileSync(captured, 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.colId === 'fallback-worker');
    expect(texts).toHaveLength(1);
    for (const part of ['重发：Claude', 'EXACT ORIGINAL CARD TASK', 'EXACT LAST RECEIPT', 'EXACT UNSENT SUPPLEMENT']) expect(texts[0].text).toContain(part);
    const card = await window.evaluate(() => TaskBoard.list({ archived: true }).then((rows) => rows.find((r) => r.id === 'fallback-card')));
    expect(card.status).toBe('done'); expect(card.attempt_closed).toBe(true); expect(card.session_id).toBe('fallback-worker');
  } catch (error) {
    const state = window && !window.isClosed() ? await window.evaluate(() => ({ task: MainSession.state()?.tasks.at(-1), col: columns.find((c) => c.id === 'fallback-worker'), screen: terms.get('fallback-worker')?.lastScreen })) : null;
    await testInfo.attach('fallback-state', { body: JSON.stringify({ state, calls: fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8') : null, prompts: fs.existsSync(captured) ? fs.readFileSync(captured, 'utf8') : null }, null, 2), contentType: 'application/json' });
    throw error;
  } finally {
    if (application) await application.close();
    fs.rmSync(profile2, { recursive: true, force: true });
  }
});
