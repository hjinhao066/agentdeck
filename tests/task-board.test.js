'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore, newCard, projectName } = require('../task-board');
const { TaskHeartbeat } = require('../task-heartbeat');
const { initialCards, migrate } = require('../scripts/migrate-task-boards');
const M = require('../main-core');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-tasks-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new TaskStore(path.join(root, 'tasks'));
  const add = (extra = {}) => store.add({ project: '测试项目', title: 'Test', detail: 'Precise instructions.', ...extra }).card;
  const bind = (id, attempt = 'a1', session = 'worker') => store.bind({ id, attempt_id: attempt, session_id: session, assignee: { agent: 'codex', model: 'gpt-6-luna' } });
  const event = (id, type, message = '', attempt = 'a1', session = 'worker', source = 'command') => store.event({ id, type, message, attempt_id: attempt, session_id: session, source });
  return { root, store, add, bind, event };
}
test('portable project JSON has all card fields, deterministic order, filters and archive', (t) => {
  const { store, add, root } = fixture(t);
  const one = add(), two = add({ project: 'other' });
  for (const field of ['id', 'project', 'title', 'detail', 'status', 'flag', 'order', 'depends_on', 'assignee', 'session_id', 'latest_receipt', 'verify', 'rework_count', 'created', 'updated', 'archived']) assert.ok(field in one);
  assert.equal(store.list({ project: 'other' })[0].id, two.id);
  store.move({ id: one.id, status: 'done' });
  assert.equal(store.list({ status: 'done' }).length, 1);
  store.archive({ done: true, project: '测试项目' });
  assert.equal(store.list().length, 1); assert.equal(store.list({ archived: true }).length, 2);
  assert.deepEqual(fs.readdirSync(path.join(root, 'tasks')).sort(), ['other.json', '测试项目.json'].sort());
  for (const invalid of ['../escape', 'C:evil', 'nul', 'COM1', 'bad.', 'a/b', '\\server', '', ' x']) assert.throws(() => projectName(invalid));
  assert.throws(() => add({ project: 'OTHER' }), /filename conflicts/);
  assert.throws(() => store.archive({ done: false }));
});
test('dependencies block starts, unlock across projects and reject missing/cyclic edits', (t) => {
  const { store, add, bind } = fixture(t);
  const a = add(), b = add({ project: 'other', depends_on: [a.id] });
  assert.equal(store.list({ project: 'other' })[0].flag, 'blocked');
  assert.throws(() => bind(b.id), /Predecessor/);
  assert.throws(() => add({ depends_on: ['missing'] }), /Unknown dependency/);
  assert.throws(() => store.update({ id: a.id, updated: a.updated, patch: { depends_on: [b.id] } }), /cycle/);
  store.move({ id: a.id, status: 'done' });
  assert.equal(store.list({ project: 'other' })[0].flag, null);
  bind(b.id);
  assert.throws(() => bind(b.id, 'a2'), /active execution/);
});
test('execution, question, completion and successful verification flow without AI', (t) => {
  const { store, add, bind, event } = fixture(t);
  const card = add({ verify: true }); bind(card.id);
  assert.equal(event(card.id, 'started').card.status, 'doing');
  assert.equal(event(card.id, 'ask', '选哪种格式？\n第二行').card.status, 'needs_user');
  assert.equal(event(card.id, 'complete', '修好了🙂。 第二句完整存在会话里。').card.status, 'review');
  assert.equal(store.list()[0].latest_receipt, '修好了🙂。');
  bind(card.id, 'review1', 'reviewer');
  assert.throws(() => bind(card.id, 'review2', 'other-reviewer'), /active execution or verification/);
  assert.equal(event(card.id, 'started', '', 'review1', 'reviewer').card.status, 'review');
  assert.equal(event(card.id, 'ask', 'How should I verify?', 'review1', 'reviewer').card.status, 'needs_user');
  assert.equal(event(card.id, 'started', '', 'review1', 'reviewer').card.status, 'review');
  assert.equal(event(card.id, 'complete', '验收通过。', 'review1', 'reviewer').card.status, 'done');
  const ordinary = add(); bind(ordinary.id, 'ordinary');
  assert.equal(event(ordinary.id, 'complete', 'Done', 'ordinary').card.status, 'done');
});
test('two rejected reviews increment rework twice and hold, even after passing execution between them', (t) => {
  const { store, add, bind, event } = fixture(t); const card = add({ verify: true });
  bind(card.id); event(card.id, 'complete', 'executed');
  bind(card.id, 'r1', 'reviewer');
  let failed = event(card.id, 'failed', 'test did not pass', 'r1', 'reviewer');
  assert.equal(failed.card.status, 'doing'); assert.equal(failed.card.rework_count, 1); assert.equal(failed.card.flag, 'failed');
  assert.equal(event(card.id, 'failed', 'test did not pass', 'r1', 'reviewer').ignored, true);
  bind(card.id, 'work2'); event(card.id, 'complete', 'fixed', 'work2');
  bind(card.id, 'r2', 'reviewer'); failed = event(card.id, 'failed', 'still broken', 'r2', 'reviewer');
  assert.equal(failed.card.rework_count, 2); assert.equal(failed.card.flag, 'held'); assert.match(failed.notices[0], /不再自动重试/);
  assert.throws(() => bind(card.id, 'work3'), /held/); assert.throws(() => store.claim({ id: card.id }), /held/);
  store.move({ id: card.id, status: 'todo' }); bind(card.id, 'approved-restart');
});
test('Captain rejection, process failure and quota failure deduplicate attempts and reject stale workers', (t) => {
  const { store, add, bind, event } = fixture(t); const card = add({ verify: true });
  bind(card.id); event(card.id, 'complete', 'executed');
  assert.equal(store.move({ id: card.id, status: 'doing' }).card.rework_count, 1);
  assert.equal(event(card.id, 'complete', 'late old reply').ignored, true);
  bind(card.id, 'work2');
  const failed = event(card.id, 'failed', 'exit 7', 'work2', 'worker', 'process');
  assert.equal(failed.card.flag, 'held'); assert.equal(failed.card.rework_count, 1);
  const q = add(); bind(q.id, 'quota'); event(q.id, 'failed', 'RESOURCE_EXHAUSTED', 'quota', 'worker', 'quota');
  const repeated = event(q.id, 'failed', 'usage limit', 'quota', 'worker', 'process');
  assert.equal(repeated.card.consecutive_failures, 1);
  bind(q.id, 'retry'); assert.equal(event(q.id, 'complete', 'late', 'quota').ignored, true);
  assert.equal(event(q.id, 'failed', 'failed again', 'retry').card.flag, 'held');
});
test('fallback never declares success and an authoritative late completion wins', (t) => {
  const { add, bind, event } = fixture(t); const c = add(); bind(c.id);
  assert.equal(event(c.id, 'fallback').card.status, 'needs_user');
  assert.equal(event(c.id, 'complete', 'actual result').card.status, 'done');
});
test('runtime model identity fills default models without allowing a stale session to change the reviewer', (t) => {
  const { store, add, bind, event } = fixture(t); const c = add({ verify: true }); bind(c.id);
  store.identity({ id: c.id, session_id: 'worker', attempt_id: 'a1', agent: 'codex', model: 'gpt-6.1-sol' });
  assert.equal(store.list()[0].assignee.model, 'gpt-6.1-sol');
  event(c.id, 'complete', 'done'); bind(c.id, 'review', 'reviewer');
  assert.equal(store.identity({ id: c.id, session_id: 'worker', attempt_id: 'a1', agent: 'codex', model: 'old' }).ignored, true);
  assert.equal(store.list()[0].assignee.model, 'gpt-6-luna');
});
test('fresh reads preserve sync-added cards and unknown fields; stale edits and invalid JSON never overwrite', (t) => {
  const { store, add, root } = fixture(t); const a = add();
  const file = path.join(root, 'tasks', '测试项目.json'); const doc = JSON.parse(fs.readFileSync(file));
  doc.remote_metadata = 'preserved'; doc.cards[0].title = 'Windows edit'; doc.cards[0].updated = 'remote-update';
  doc.cards.push(newCard({ project: '测试项目', title: 'remote card' })); fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => store.update({ id: a.id, updated: a.updated, patch: { title: 'overwrite' } }), /Reload/);
  store.move({ id: a.id, status: 'done' });
  const after = JSON.parse(fs.readFileSync(file)); assert.equal(after.remote_metadata, 'preserved'); assert.equal(after.cards.length, 2); assert.equal(after.cards[0].title, 'Windows edit');
  fs.writeFileSync(file, '<<<<<<< git conflict'); assert.throws(() => add(), /sync conflict/); assert.equal(fs.readFileSync(file, 'utf8'), '<<<<<<< git conflict');
});
test('optimistic retry rebases an operation over an incoming sync edit; local writer lock is respected', (t) => {
  const { store, add, root } = fixture(t); const a = add();
  const original = store.write.bind(store); let first = true;
  store.write = (project, doc, raw) => {
    if (first) { first = false; const remote = JSON.parse(raw); remote.cards[0].detail = 'Changed on Windows'; fs.writeFileSync(path.join(root, 'tasks', project + '.json'), JSON.stringify(remote)); }
    return original(project, doc, raw);
  };
  store.move({ id: a.id, status: 'done' }); assert.equal(store.list()[0].detail, 'Changed on Windows');
  fs.mkdirSync(store.lock); t.after(() => fs.rmSync(store.lock, { recursive: true, force: true }));
  assert.throws(() => add(), /another local process/);
});
test('heartbeat claims external start edges exactly once, ignores ordinary edits and resumes pending local claims', (t) => {
  const { store, add, root } = fixture(t); const a = add(); const starts = [], logs = []; let changes = 0;
  const heartbeat = new TaskHeartbeat(store, { onStart: (input) => starts.push(input), log: (line) => logs.push(line), onChange: () => changes++ });
  heartbeat.scan(); heartbeat.scan(); assert.equal(starts.length, 0); assert.equal(changes, 1);
  const file = path.join(root, 'tasks', '测试项目.json'); const doc = JSON.parse(fs.readFileSync(file));
  doc.cards[0].status = 'doing'; doc.cards[0].updated = 'remote-start'; fs.writeFileSync(file, JSON.stringify(doc));
  heartbeat.scan(); heartbeat.scan(); assert.equal(starts.length, 1); assert.equal(logs.length, 1);
  const key = starts[0].key;
  const recovered = [];
  new TaskHeartbeat(store, { onStart: (input) => recovered.push(input) }).scan(); assert.equal(recovered[0].key, key);
  store.dispatched({ id: a.id, key });
  const restarted = []; new TaskHeartbeat(store, { onStart: (input) => restarted.push(input) }).scan(); assert.equal(restarted.length, 0);
  store.update({ id: a.id, updated: store.list()[0].updated, patch: { detail: 'only changed text' } }); heartbeat.scan(); assert.equal(starts.length, 1);
  store.move({ id: a.id, status: 'todo' }); heartbeat.scan(); store.move({ id: a.id, status: 'doing' }); heartbeat.scan(); assert.equal(starts.length, 2);
  const manual = add({ title: 'Started directly by the UI' }); heartbeat.scan();
  const manualKey = store.claim({ id: manual.id }).card.dispatch_claim.key;
  store.dispatched({ id: manual.id, key: manualKey }); heartbeat.scan();
  assert.equal(starts.length, 2); assert.equal(store.list().find((c) => c.id === manual.id).dispatch_claim.key, manualKey);
});
test('external completion persists dependent unlocks in the shared JSON without starting those cards', (t) => {
  const { store, add, root } = fixture(t); const a = add(), b = add({ project: 'dependent', depends_on: [a.id] });
  const file = path.join(root, 'tasks', '测试项目.json'); const doc = JSON.parse(fs.readFileSync(file));
  doc.cards[0].status = 'done'; fs.writeFileSync(file, JSON.stringify(doc));
  const starts = []; const heartbeat = new TaskHeartbeat(store, { onStart: (input) => starts.push(input) });
  heartbeat.scan();
  const dependent = JSON.parse(fs.readFileSync(path.join(root, 'tasks', 'dependent.json'))).cards.find((c) => c.id === b.id);
  assert.equal(dependent.flag, null); assert.equal(dependent.status, 'todo'); assert.equal(starts.length, 0);
  const raw = fs.readFileSync(path.join(root, 'tasks', 'dependent.json'), 'utf8'); heartbeat.scan();
  assert.equal(fs.readFileSync(path.join(root, 'tasks', 'dependent.json'), 'utf8'), raw);
});
test('watcher detects atomic rename and polling catches edits when watcher is unavailable', async (t) => {
  const { store, add, root } = fixture(t); const a = add(); const starts = [];
  const heartbeat = new TaskHeartbeat(store, { onStart: (input) => { starts.push(input); store.dispatched(input); } });
  heartbeat.start(); t.after(() => heartbeat.close());
  const file = path.join(root, 'tasks', '测试项目.json');
  const change = () => { const doc = JSON.parse(fs.readFileSync(file)); doc.cards[0].status = 'doing'; doc.cards[0].updated = new Date().toISOString(); fs.writeFileSync(file + '.tmp', JSON.stringify(doc)); fs.renameSync(file + '.tmp', file); };
  change();
  const noise = setInterval(() => fs.writeFileSync(file + '.unrelated.tmp', 'sync in progress'), 20);
  try { for (let i = 0; i < 30 && starts.length < 1; i++) await new Promise((r) => setTimeout(r, 20)); }
  finally { clearInterval(noise); }
  assert.equal(starts.length, 1);
  store.move({ id: a.id, status: 'todo' }); heartbeat.scan(); heartbeat.watch.close();
  clearInterval(heartbeat.timer); heartbeat.timer = setInterval(() => heartbeat.scan(), 100);
  change();
  for (let i = 0; i < 30 && starts.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(starts.length, 2);
});
test('dispatcher uses Captain model routing, portable CLI and important/unclear fallback', (t) => {
  const { store, add } = fixture(t);
  const c = add(); assert.equal(store.dispatch({ id: c.id }).captain, false);
  assert.equal(store.dispatch({ id: add({ important: true }).id }).captain, true);
  assert.equal(store.dispatch({ id: add({ detail: '' }).id }).captain, true);
  for (const platform of ['darwin', 'win32']) {
    const prompt = M.dispatcherInstructions(platform, c);
    assert.ok(prompt.includes(M.boardCli(platform))); assert.ok(prompt.includes('--task-id ' + c.id));
    for (const model of ['gpt-6-luna', 'Gemini 3.8 Flash', 'GPT-6.1 Sol', 'Sonnet 5.5', 'Opus 5.5', 'grok-4.7-high-fast']) assert.ok(prompt.includes(model));
  }
});
test('dispatcher question/crash update the card; a delegated worker is never changed by its dispatcher receipt', (t) => {
  const { store, add, bind } = fixture(t); const c = add();
  store.dispatch({ id: c.id, session_id: 'dispatcher-1' });
  assert.equal(store.dispatcherReceipt({ id: c.id, session_id: 'dispatcher-1', question: 'Needs clarification?' }).card.status, 'needs_user');
  store.dispatch({ id: c.id, session_id: 'dispatcher-2' });
  const failed = store.dispatcherReceipt({ id: c.id, session_id: 'dispatcher-2', failed: 'quota exhausted' });
  assert.equal(failed.card.flag, null);
  assert.equal(failed.card.consecutive_failures, 0);
  assert.match(failed.notices[0], /未计入连续失败/);
  store.dispatch({ id: c.id, session_id: 'dispatcher-4' });
  const again = store.dispatcherReceipt({ id: c.id, session_id: 'dispatcher-4', failed: 'quota exhausted again' });
  assert.equal(again.card.flag, null);
  assert.notEqual(again.card.flag, 'held');
  assert.equal(again.card.consecutive_failures, 0);
  store.dispatch({ id: c.id, session_id: 'dispatcher-3' }); bind(c.id);
  assert.equal(store.dispatcherReceipt({ id: c.id, session_id: 'dispatcher-3', failed: 'old dispatcher quit' }).ignored, true);
  assert.equal(store.list()[0].session_id, 'worker');
});
test('moving a finished or held card back to doing keeps the worker and does not dispatch', (t) => {
  const { store, add, bind, event } = fixture(t);
  const done = add(); bind(done.id); event(done.id, 'complete', '停在安全点');
  const starts = [];
  const heartbeat = new TaskHeartbeat(store, { onStart: (input) => starts.push(input) });
  heartbeat.scan();
  const moved = store.move({ id: done.id, status: 'doing' });
  assert.equal(moved.card.status, 'doing');
  assert.equal(moved.card.session_id, 'worker');
  assert.equal(moved.card.flag, null);
  assert.equal(moved.card.attempt_closed, true);
  heartbeat.scan();
  assert.equal(starts.length, 0);
  assert.equal(store.claim({ id: done.id }).ignored, true);
  const held = add();
  bind(held.id, 'a1'); event(held.id, 'failed', 'one', 'a1');
  bind(held.id, 'a2'); event(held.id, 'failed', 'two', 'a2');
  assert.equal(store.list().find((c) => c.id === held.id).flag, 'held');
  const resumed = store.move({ id: held.id, status: 'doing', resume_session_id: 'worker-2' });
  assert.equal(resumed.card.flag, null);
  assert.equal(resumed.card.status, 'doing');
  assert.equal(resumed.card.session_id, 'worker');
  heartbeat.scan();
  assert.equal(starts.length, 0);
});
test('migration reads only the three requested Markdown sources, preserves originals and skips existing JSON', (t) => {
  const { root } = fixture(t);
  const sources = {
    agentdeck: '- 同一会话（c1791071297267380）接着做任务看板数据+流转层\n- **任务看板**：以看为主；数据+流转层给 Codex，界面给 Opus\n- 架构图：派 Claude Opus 重做排版\n- 谁在做：Codex，feat/claude-seats\n- 拟拆任务：T1 Windows升级\n',
    'hermes-savings-v2': '1. Gmail 连接器过期\n2. G8 **完成**。待验证：明早自动上站还没被真实证明。待办（未派）：重复新闻改链接\n3. VPS 提醒已恢复\n4. 卡诗规格待用户补\n',
    'type4me-windows': '| 设置界面落地 + 输入统计 | Codex | 取证中 |\n',
  };
  for (const [p, md] of Object.entries(sources)) fs.writeFileSync(path.join(root, p + '.md'), md);
  fs.writeFileSync(path.join(root, 'unrelated.md'), 'must not import');
  const result = migrate(root); assert.equal(result.length, 3); assert.ok(result.every((r) => r.imported > 0));
  for (const [p, md] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(root, p + '.md'), 'utf8'), md);
  assert.ok(migrate(root).every((r) => r.skipped));
  assert.deepEqual(initialCards('hermes-savings-v2', sources['hermes-savings-v2']).map((c) => c.id), initialCards('hermes-savings-v2', sources['hermes-savings-v2']).map((c) => c.id));
  assert.equal(new TaskStore(path.join(root, 'tasks')).list().some((c) => /VPS/.test(c.title)), false);
});
