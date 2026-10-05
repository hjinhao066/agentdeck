'use strict';
// Relay, restart and the handoff command through the real main-session.js (in a
// vm), the real task store and the real handoff writer. Stand-in deck, no PTY.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const B = require('../board-core');
const M = require('../main-core');
const AV = require('../auto-verify-core');
const R = require('../restart-resume');
const P = require('../perpetual-captain-core');
const Seats = require('../claude-seats-main');
const { TaskStore, localSessions } = require('../task-board');

const CODEX = 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox';
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };
const savedCap = M.MAX_ACTIVE;

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-relay-session-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); M.MAX_ACTIVE = savedCap; });
  const w = { root, dir: path.join(root, 'tasks'), home: path.join(root, 'home'), userData: path.join(root, 'deck'), skew: 0, ids: 0 };
  w.config = { folders: [], archived: [], captainHistory: [], mainSession: { colId: 'captain', tasks: [], pending: [], inflight: [], waitlist: [], gen: 1, cmd: 'claude' }, concurrencyCap: 5 };
  w.columns = [{ id: 'captain', isMain: true, cmd: 'claude' }];
  w.boot = () => boot(w);
  return w;
}
function boot(w, persisted) {
  if (persisted) { w.config = JSON.parse(persisted); w.columns = w.config.columns.map((c) => c); }
  w.config.columns = w.columns;
  const sent = [], chats = new Map();
  const store = new TaskStore(w.dir, { sessions: () => localSessions(w.config) });
  const entries = new Map(w.columns.map((c) => [c.id, { alive: true, state: 'done', lastScreen: '' }]));
  const options = { cards: () => store.list({ archived: true }), tasksDir: store.dir, machine: { platform: 'darwin', hostname: 'mac.test', appVersion: '1.1.11' } };
  // main-session.js reads the clock through Date.now(); the tests move it.
  class Clock extends Date { static now() { return Date.now() + w.skew; } }
  const window = {
    deck: {
      onTaskStart() {}, onTaskReview() {}, onTaskRework() {}, onTasksChanged() {},
      taskBoard: (op, input) => Promise.resolve().then(() => store[op](input)),
      memoryPressure: async () => ({ level: null }), saveLongPrompt: async () => '/tmp/long-task.txt', saveConfigSync() {},
      restartManifestLoad: () => null, restartManifestSave() {},
      captainHandoff: async (payload) => Seats.handoff(w.home, w.userData, payload, options),
      captainCheckpoint: async (payload) => Seats.checkpoint(w.home, w.userData, payload, options),
    },
    MainCore: M, BoardCore: B, AutoVerifyCore: AV, RestartResume: R, PerpetualCaptainCore: P,
    QuotaCore: { commandQuota: () => ({ out: false }), quotaFallback: (_s, cmd) => ({ action: 'open', cmd, note: '' }) },
    ChatUI: {
      hasDraft: () => false, turnsOf: (id) => chats.get(id) || [], updateCard() {}, addCard() {}, readFooter: () => null, captainArchives: () => [],
      snapshotForHandoff: (id) => ({ turns: chats.get(id) || [], captainArchive: true }),
      retireChat: (id) => ({ turns: (chats.get(id) || []).length, from: 1, to: 2 }),
    },
    Sidebar: { render() {} },
  };
  const context = vm.createContext({ window, document: { getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] }, console, Date: Clock, Intl });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../main-session.js'), 'utf8'), context);
  const host = {
    config: w.config, platform: 'darwin', terms: entries, userComposing: () => false, columnLabel: (c) => c.displayTitle || c.title || c.id,
    saveConfig() {}, flushConfig() {}, showToast() {}, columns: () => w.columns,
    createSession(meta) { const col = { ...meta, createdByRequestId: null }; w.columns.push(col); entries.set(col.id, { alive: true, state: 'working', lastScreen: '' }); return col; },
    // like the renderer: the same column object gets a new id, shell and token
    respawnColumn(col) { entries.delete(col.id); col.id = 'captain-' + (++w.ids); entries.set(col.id, { alive: true, state: 'done', lastScreen: '' }); return col; },
    sendWhenReady(col, text, opts) { sent.push({ id: col.id, text: typeof text === 'function' ? text() : text }); opts?.onSent?.({ id: 'turn-' + sent.length }); },
  };
  window.MainSession.init(host);
  const app = {
    w, store, window, host, sent, entries, chats, api: window.MainSession, s: () => w.config.mainSession,
    captain: () => w.columns.find((c) => c.isMain),
    card: (id) => store.list({ archived: true }).find((c) => c.id === id),
    persisted: () => JSON.stringify(w.config),
    handle: (message, caller = app.captain()) => app.api.handle(message, caller),
    async execute(card, id = 'exec-req', command = CODEX) {
      const reply = await app.handle({ action: 'main-new', id, title: '执行 ' + card.title, task: '做这件事', boardId: card.id, project: card.project, command });
      await tick();
      return { reply, col: w.columns.find((c) => c.boardAttempt === id) };
    },
    relay: async (seatId, message) => {
      const from = app.captain().id;
      const file = await app.api.checkpointForSeatSwitch({ colId: from, relayMessage: message }, { local: true });
      const fresh = app.api.clearContext({ seatId, checkpointPath: file, relayMessage: message, relayTargetId: seatId });
      return { from, file, fresh };
    },
    listen: (watcher, startedAt, caller) => app.handle({ action: 'main-receipts', wait: true, watcher, watcherStartedAt: startedAt }, caller),
    receipt: (summary) => app.s().pending.push({ taskId: 'task-' + summary, colId: 'worker', title: summary, ts: Date.now(), summary, files: [] }),
  };
  return app;
}
const newCard = async (app, extra = {}) => (await app.window.TaskBoard.add({ project: 'p', title: '修登录', detail: '把登录修好', ...extra })).card;

test('after a Relay the card that is out is named with its owner, cannot be handed out again, and only the newest Captain may dispatch', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app);
  const { col: worker } = await app.execute(card);
  assert.ok(worker); assert.equal(app.card(card.id).session_id, worker.id);
  const columns = () => w.columns.filter((c) => !c.isMain).length;
  assert.equal(columns(), 1);

  const first = await app.relay('us', 'Relay：CN → US；手动切换');
  const handoff = fs.readFileSync(first.file, 'utf8');
  assert.match(handoff, /触发：席位 Relay；Relay：CN → US；手动切换/);
  assert.match(handoff, new RegExp(`上任会话：${first.from}（read --id ${first.from} 按需读）`));
  assert.match(handoff, /快照版本：队长代次 gen 1 → 2/);
  assert.match(handoff, new RegExp(`【执行中】${card.id}｜p｜修登录\\n {2}会话：执行 ${worker.id}（运行中）`));
  assert.match(handoff, /摘要：未完成任务 1 条（返工 0｜待验收 0｜执行中 1｜暂停 0｜待执行 0）；在跑的队员会话 1 个/);
  assert.match(handoff, /启动方式：有已授权待办/);
  // the replacement is told who it is, where the state is, and not to redo what is out
  const note = app.sent.filter((m) => m.id === first.fresh.id).at(-1).text;
  assert.match(note, /^你是刚接任的队长：上一任已经 Relay 到这个席位/);
  assert.match(note, /已有会话在做，不要重派/);
  assert.match(note, /先运行 node "\$AGENTDECK_BOARD_CLI" handoff 取交接快照/);
  assert.match(note, /读看板继续/); assert.match(note, /上任终端的回执监听已被程序作废，现在重挂恰好一个后台 receipts --wait --timeout 300 监听/);
  assert.ok(!note.includes('先确认旧监听已退出'), 'the new Captain cannot look into the old terminal');

  // the new Captain forgets and sends the same card out again: the board refuses, nothing opens
  await assert.rejects(app.handle({ action: 'main-new', id: 'again', title: '再做一遍', task: '做这件事', boardId: card.id, project: 'p', command: CODEX }), /already has an active execution/);
  assert.equal(columns(), 1); assert.equal(app.card(card.id).session_id, worker.id); assert.equal(app.card(card.id).attempt_id, 'exec-req');
  assert.equal(app.s().waitlist.length, 0);
  // the Captain it replaced is no longer one: same commands, refused
  const old = { id: first.from, isMain: true, cmd: 'claude' };
  await assert.rejects(app.handle({ action: 'main-new', id: 'ghost', title: '旧队长派的', task: 'x', command: CODEX }, old), /只有队长可以用这个命令/);
  await assert.rejects(app.handle({ action: 'main-receipts', wait: true }, old), /只有队长可以用这个命令/);
  assert.equal(columns(), 1);

  // Relay again straight away: still one Captain, still one owner on the card
  const second = await app.relay('cn', 'Relay：US → CN；手动切换');
  assert.notEqual(second.fresh.id, first.fresh.id);
  assert.equal(w.columns.filter((c) => c.isMain).length, 1); assert.equal(app.s().colId, second.fresh.id); assert.equal(app.s().gen, 3);
  await assert.rejects(app.handle({ action: 'main-tell', to: worker.id, message: '改方向' }, { id: first.fresh.id, isMain: true, cmd: 'claude' }), /只有队长可以用这个命令/);
  await assert.rejects(app.handle({ action: 'main-new', id: 'third', title: '第三次', task: '做这件事', boardId: card.id, project: 'p', command: CODEX }), /already has an active execution/);
  assert.equal(columns(), 1);
  assert.match(fs.readFileSync(second.file, 'utf8'), new RegExp(`上任会话：${first.fresh.id}`));
  // the worker's receipt after two Relays still lands on the same card, once
  await app.api.submit({ action: 'complete', result: '修好了。' }, worker);
  assert.equal(app.card(card.id).status, 'done');
  assert.equal((await app.handle({ action: 'main-receipts' })).result.match(/修好了。/g).length, 1);
  assert.equal(app.s().pending.length, 0);
});

test('one receipt listener: a newer one in the same terminal takes over, the older one is told to leave, a dead one does not count', async (t) => {
  const w = world(t); const app = w.boot();
  assert.equal((await app.listen('a', 100)).result, '');
  assert.equal((await app.listen('b', 200)).result, '', 'hung again after /clear: the newer one becomes the listener');
  assert.equal((await app.listen('a', 100)).result, M.LISTENER_SUPERSEDED);
  assert.match(M.LISTENER_SUPERSEDED, /不要为它重挂/);
  app.receipt('only-once');
  // the superseded one never consumes, even with a receipt waiting
  assert.equal((await app.listen('a', 100)).result, M.LISTENER_SUPERSEDED);
  assert.equal(app.s().pending.length, 1);
  assert.match((await app.listen('b', 200)).result, /only-once/);
  assert.equal(app.s().pending.length, 0);
  assert.equal((await app.listen('b', 200)).result, '');
  // an older poll that arrives first does not lock a newer listener out
  assert.equal((await app.listen('c', 300)).result, '');
  assert.equal((await app.listen('b', 200)).result, M.LISTENER_SUPERSEDED);
  // the newest one died (its task was killed): after it stops polling, the survivor is the listener again
  w.skew += 20_000;
  app.receipt('after-the-newer-died');
  assert.match((await app.listen('b', 200)).result, /after-the-newer-died/);
  // plain reads and listeners that send no id (an older CLI) behave as before
  app.receipt('plain');
  assert.match((await app.handle({ action: 'main-receipts' })).result, /plain/);
  assert.equal((await app.handle({ action: 'main-receipts', wait: true })).result, '');
  // after a Relay the old terminal's listener is not the Captain's, and the new one starts clean
  const { from, fresh } = await app.relay('us', 'Relay：CN → US');
  await assert.rejects(app.listen('c', 300, { id: from, isMain: true, cmd: 'claude' }), /只有队长可以用这个命令/);
  app.receipt('for-the-new-captain');
  assert.match((await app.listen('n', 50, fresh)).result, /for-the-new-captain/, 'an old listener id from the previous Captain does not outrank it');
  // the briefing tells the Captain what the program does about duplicates
  assert.match(M.instructions('darwin'), /重复挂的旧监听会被程序请退，不用为它重挂/);
});

test('a command whose CLI already gave up is not run late, so retrying it cannot start the work twice', async (t) => {
  const w = world(t); const app = w.boot();
  const columns = () => w.columns.filter((c) => !c.isMain).length;
  const now = Date.now();
  const sendNew = (id, deadline) => app.handle({ action: 'main-new', id, title: '查日志', task: '把今天的错误日志整理出来', command: CODEX, deadline });
  // the request waited in the queue past its deadline: the CLI has reported a timeout
  await assert.rejects(sendNew('first', now - 1), /等到超时才轮到，没有执行。先用 ledger 确认现状/);
  assert.equal(columns(), 0); assert.equal(app.s().tasks.length, 0); assert.equal(app.s().waitlist.length, 0);
  // the Captain retries: exactly one session
  const reply = await sendNew('retry', now + 30_000);
  assert.match(reply.result, /已开新会话/);
  assert.equal(columns(), 1);
  const worker = w.columns.find((c) => !c.isMain);
  // the same holds for the other commands that change something
  for (const message of [{ action: 'main-tell', to: worker.id, message: '补充' }, { action: 'main-stop', to: worker.id }, { action: 'main-archive', to: worker.id }, { action: 'main-answer', to: worker.id, key: 'y' }]) {
    await assert.rejects(app.handle({ ...message, deadline: now - 1 }), /没有执行/, message.action);
  }
  assert.equal(app.s().tasks.filter((x) => x.colId === worker.id).length, 1); assert.equal(columns(), 1);
  // reading is never refused for being late, and a request without a deadline (older CLI) runs as before
  assert.match((await app.handle({ action: 'main-ledger', deadline: now - 1 })).result, /查日志/);
  assert.match((await app.handle({ action: 'main-tell', to: worker.id, message: '补充' })).result, /指令先放着|已发给/);
});

test('receipts the CLI took but the Captain never got to are named at the Relay, not delivered twice and not lost', async (t) => {
  const w = world(t); const app = w.boot();
  const captain = app.captain();
  const settle = () => { app.api.onTick(captain.id, { alive: true, state: 'working', lastScreen: '' }); w.skew += 2000; app.api.onTick(captain.id, { alive: true, state: 'done', lastScreen: '' }); };
  app.receipt('handled-by-the-old-captain');
  assert.match((await app.listen('a', 1)).result, /handled-by-the-old-captain/);
  w.skew += 1000; settle();   // the Captain worked after taking it and came to rest: dealt with
  assert.deepEqual([...app.api.handoffSnapshot('refresh').unconfirmed], []);
  // the next one is taken while the Captain is out of quota: nothing shows it was read by the model
  w.skew += 1000; app.receipt('taken-but-never-read');
  assert.match((await app.listen('a', 1)).result, /taken-but-never-read/);
  app.receipt('still-unread');
  const pending = app.api.handoffSnapshot('relay');
  assert.deepEqual(pending.unconfirmed.map((p) => p.summary), ['taken-but-never-read']);
  assert.deepEqual(pending.pending.map((p) => p.summary), ['still-unread']);

  const { file, fresh, from } = await app.relay('us', '永动机自动轮换：CN → US；当前席位额度用尽或限流');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /未读回执和提问 1 条（会经 receipts 通道送达，到时再处理，不要照这里重复派活）：\n {2}- 回执｜worker｜「still-unread」｜still-unread/);
  assert.match(text, /上任已取走、可能没处理完的回执 1 条（不会再经通道送达，逐条核对是否已处理）：\n {2}- 回执｜worker｜「taken-but-never-read」｜taken-but-never-read/);
  assert.ok(!text.includes('handled-by-the-old-captain'));
  assert.match(text, /已取走未确认 1 条/); assert.match(text, /启动方式：有已授权待办/);
  // the channel delivers the unread one once, and never the taken ones again
  assert.deepEqual(app.s().pending.map((p) => p.summary), ['still-unread']);
  assert.equal(app.s().handoffCarry.kind, 'relay'); assert.equal(app.s().handoffCarry.fromId, from);
  const next = await app.listen('n', 1, fresh);
  assert.match(next.result, /still-unread/); assert.doesNotMatch(next.result, /taken-but-never-read|handled-by/);
  // the new Captain asks again later: the taken one is still on the page, with when and from whom
  const later = await app.handle({ action: 'main-handoff' });
  assert.match(later.result, new RegExp(`上次 Relay（[^）]*，上任 ${from}）时已取走、可能没处理完的回执 1 条[^\\n]*\\n {2}- 回执｜worker｜「taken-but-never-read」`));
  assert.match(later.result, /触发：队长运行 handoff/);

  // a restart keeps the same promise: taken, unsettled receipts are carried instead of dropped silently
  w.skew += 5000; app.receipt('taken-right-before-quit');
  assert.match((await app.listen('n', 1, fresh)).result, /taken-right-before-quit/);
  const again = boot(w, app.persisted());
  assert.equal(again.s().inflight.length, 0); assert.equal(again.s().pending.length, 0);
  assert.equal(again.s().handoffCarry.kind, 'restart');
  assert.deepEqual(again.s().handoffCarry.items.map((p) => p.summary), ['taken-but-never-read', 'taken-right-before-quit']);
  assert.match((await again.handle({ action: 'main-handoff' })).result, /重启前（[^）]*）已取走、可能没处理完的回执 2 条/);
  assert.equal((await again.listen('z', 1)).result, '', 'and still not sent a second time');
});

test('the handoff command: live state on demand, the same text as the file, Captain only, nothing else touched', async (t) => {
  const w = world(t); const app = w.boot();
  const card = await newCard(app, { title: '在做的' });
  const { col: worker } = await app.execute(card);
  const idle = await newCard(app, { title: '没开始的' });
  app.chats.set('captain', [{ id: 't1', ts: Date.now(), user: '把登录修了，修完发 1.2', reply: '好', done: true }, { id: 'k1', kind: 'task', user: '执行', task: {} }]);
  const before = app.persisted();
  const out = await app.handle({ action: 'main-handoff' });
  const file = path.join(w.home, '.agents', 'boards', 'agentdeck-captain-handoff.md');
  assert.equal(out.result, fs.readFileSync(file, 'utf8'));
  assert.match(out.result, /触发：队长运行 handoff/);
  assert.match(out.result, new RegExp(`【执行中】${card.id}`)); assert.match(out.result, new RegExp(`【待执行】还没启动的 1 张[^\\n]*\\n {2}- ${idle.id}｜p｜没开始的`));
  assert.match(out.result, /「把登录修了，修完发 1\.2」｜read --id captain --find "把登录修了，修完发"/);
  assert.match(out.result, /本机：Mac mac\.test，正在运行 AgentDeck 1\.1\.11/);
  assert.match(out.result, /队长轮换：永动机自动轮换开，席位顺序 us2 → us → cn/);
  // it changes no session and no card; it only remembers where the file is for the next start
  const after = JSON.parse(app.persisted()); const was = JSON.parse(before);
  assert.equal(after.mainSession.seatCheckpoint, file); delete after.mainSession.seatCheckpoint;
  assert.deepEqual(after, was);
  await assert.rejects(app.handle({ action: 'main-handoff' }, worker), /只有队长可以用这个命令/);
  // the worker finishes; asking again shows the new state, from the board, not from memory
  await app.api.submit({ action: 'complete', result: '修好了。' }, worker);
  const next = await app.handle({ action: 'main-handoff' });
  assert.ok(!next.result.includes(`【执行中】${card.id}`)); assert.match(next.result, /未读回执和提问 1 条/);
  // a restart points the Captain back at it and warns that the crew is being continued by the app
  const again = boot(w, app.persisted());
  const note = again.sent.filter((m) => m.id === again.captain().id).at(-1).text;
  assert.equal(note, M.restartNote('darwin', file));
  assert.match(note, /在跑的队员由程序自动续接，不要重派；先运行 node "\$AGENTDECK_BOARD_CLI" handoff/); assert.match(note, /读看板继续/);
  // crew the app is continuing after a restart reads as such, not as work to hand out again
  const resumed = await newCard(again, { title: '重启时在跑的' });
  const { col } = await again.execute(resumed, 'resume-req');
  Object.assign(again.s().tasks.findLast((x) => x.colId === col.id), { status: 'paused', restartHold: true });
  const text = (await again.handle({ action: 'main-handoff' })).result;
  assert.match(text, new RegExp(`【执行中（重启后程序自动续接中）】${resumed.id}[^\\n]*\\n {2}会话：执行 ${col.id}（被中断·重启后程序自动续接中）`));
  assert.match(text, /程序正在自动续接（真续接或重发），约 1 分钟后用 ledger 确认；不要重派/);
});

test('a manual clear sends again what the old context never dealt with, and not what it already handled', async (t) => {
  const w = world(t); const app = w.boot();
  const captain = app.captain();
  app.receipt('handled-long-ago');
  assert.match((await app.listen('a', 1)).result, /handled-long-ago/);
  w.skew += 1000;
  app.api.onTick(captain.id, { alive: true, state: 'working', lastScreen: '' }); w.skew += 2000;
  app.api.onTick(captain.id, { alive: true, state: 'done', lastScreen: '' });
  w.skew += 1000; app.receipt('taken-not-handled');
  assert.match((await app.listen('a', 1)).result, /taken-not-handled/);
  // typed into the box by the legacy path, turn never finished: the channel has not marked it read
  app.s().inflight.push({ taskId: 'legacy', colId: 'worker', title: '注入', ts: 1, summary: 'typed-not-acked', files: [] });
  app.receipt('unread');
  const fresh = app.api.clearContext({ fromEdit: true });
  assert.notEqual(fresh.id, 'captain'); assert.equal(app.s().inflight.length, 0);
  assert.deepEqual(app.s().pending.map((p) => p.summary).sort(), ['taken-not-handled', 'typed-not-acked', 'unread']);
  const next = await app.listen('n', 1, fresh);
  assert.doesNotMatch(next.result, /handled-long-ago/);
  for (const summary of ['taken-not-handled', 'typed-not-acked', 'unread']) assert.match(next.result, new RegExp(summary));
  // the note is the plain one: nobody took over a seat
  assert.match(app.sent.filter((m) => m.id === fresh.id).at(-1).text, /^用户刚清空了你的模型上下文。/);
});
