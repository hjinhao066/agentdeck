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
  fs.writeFileSync(path.join(profile, 'tasks', 'agentdeck.json'), JSON.stringify({ version: 1, project: 'agentdeck', cards: [card] }));
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    resumeOnRestart: true,
    taskBoard: { dispatcher: 'captain' },
    columns: [
      { ...column('cap', '队长'), isMain: true, captainCrew: false },
      column('worker-live', '永动机', { boardId: 't-live', boardAttempt: 'attempt-1' }),
      column('worker-done', '已做完'),
    ],
    mainSession: {
      colId: 'cap', cmd: fake, gen: 1, pending: [], inflight: [], fresh: false, crewMarked: true, waitlist: [],
      tasks: [
        crewTask('k-live', 'worker-live', '永动机', 'working', '上次写到一半', 't-live'),
        crewTask('k-done', 'worker-done', '已做完', 'done', '功能已做完并推送。等待队长验收。'),
      ],
    },
  }));
  const env = { ...process.env, AGENTDECK_TEST_PROMPT_COLUMNS_FILE: prompts };
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
  expect(live).not.toContain('已完成');
});
