'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore, newCard, projectName, localSessions } = require('../task-board');
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
  assert.equal(repeated.card.consecutive_failures, 0);
  bind(q.id, 'retry'); assert.equal(event(q.id, 'complete', 'late', 'quota').ignored, true);
  assert.equal(event(q.id, 'failed', 'failed again', 'retry').card.flag, 'failed');
});
test('fallback never declares success and an authoritative late completion wins', (t) => {
  const { add, bind, event } = fixture(t); const c = add(); bind(c.id);
  assert.equal(event(c.id, 'fallback').card.status, 'needs_user');
  assert.equal(event(c.id, 'complete', 'actual result').card.status, 'done');
});
test('restarting after a fallback clears latest_receipt, while command receipts survive', (t) => {
  const { store, add, bind, event } = fixture(t);
  const card = add(); bind(card.id); event(card.id, 'started'); event(card.id, 'fallback');
  assert.equal(event(card.id, 'started', '', 'a1', 'worker', 'resume-1').card.latest_receipt, '');
  assert.equal(store.list()[0].status, 'doing');
  // A pre-fix app could already have written started while retaining the notice.
  store.mutate((docs) => { store.find(docs, card.id).latest_receipt = '已结束，未提交回执'; return {}; });
  assert.equal(event(card.id, 'started', '', 'a1', 'worker', 'resume-fallback-2').card.latest_receipt, '');
  event(card.id, 'fallback');
  bind(card.id, 'a2');
  assert.equal(event(card.id, 'started', '', 'a2').card.latest_receipt, '');
  for (const result of ['实际完成了修改。', '已结束，未提交回执']) {
    const real = add({ verify: true }); bind(real.id); event(real.id, 'complete', result);
    bind(real.id, 'review', 'reviewer');
    assert.equal(event(real.id, 'started', '', 'review', 'reviewer').card.latest_receipt, result);
  }
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
  assert.equal(store.dispatcherReceipt({ id: c.id, session_id: 'dispatcher-2', failed: 'quota exhausted', source: 'automatic' }).card.flag, 'quota');
  store.dispatch({ id: c.id, session_id: 'dispatcher-3' }); bind(c.id);
  assert.equal(store.dispatcherReceipt({ id: c.id, session_id: 'dispatcher-3', failed: 'old dispatcher quit' }).ignored, true);
  assert.equal(store.list()[0].session_id, 'worker');
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
test('reorder places a card before/after a sibling, persists, and leaves other cards untouched', (t) => {
  const { store, add } = fixture(t);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => add({ id, title: id }));
  const order = () => store.list({ project: '测试项目' }).map((x) => x.id);
  assert.deepEqual(order(), ['a', 'b', 'c', 'd']);
  store.reorder({ id: 'd', before: 'b' });
  assert.deepEqual(order(), ['a', 'd', 'b', 'c']);
  const after = store.list();
  for (const x of [a, b, c]) assert.equal(after.find((y) => y.id === x.id).updated, x.updated, 'neighbours are not rewritten');
  assert.notEqual(after.find((y) => y.id === 'd').updated, d.updated);
  store.reorder({ id: 'a', after: 'c' });
  assert.deepEqual(order(), ['d', 'b', 'c', 'a']);
  store.reorder({ id: 'c', before: 'd' });
  assert.deepEqual(order(), ['c', 'd', 'b', 'a']);
  store.reorder({ id: 'c' });
  assert.deepEqual(order(), ['d', 'b', 'a', 'c'], 'no anchor = end of the project');
  assert.deepEqual(new TaskStore(store.dir).list().map((x) => x.id), ['d', 'b', 'a', 'c'], 'order survives a fresh read');
  // already in place: nothing is written
  const before = store.list().find((x) => x.id === 'b').updated;
  store.reorder({ id: 'b', after: 'd' });
  assert.equal(store.list().find((x) => x.id === 'b').updated, before);
  // status and session binding are not touched by a reorder
  store.move({ id: 'b', status: 'doing' });
  store.reorder({ id: 'b' });
  assert.equal(store.list().find((x) => x.id === 'b').status, 'doing');
});
test('reorder renumbers when no number fits between neighbours and rejects other projects', (t) => {
  const { store, add } = fixture(t);
  ['a', 'b', 'c'].forEach((id) => add({ id, title: id }));
  const other = add({ id: 'x', project: 'other' });
  // equal orders (as hand-written or migrated boards may have): ids break the tie
  for (const id of ['a', 'b', 'c']) { const card = store.list().find((x) => x.id === id); store.update({ id, updated: card.updated, patch: { order: 0 } }); }
  store.reorder({ id: 'c', before: 'b' });
  const cards = store.list({ project: '测试项目' });
  assert.deepEqual(cards.map((x) => x.id), ['a', 'c', 'b']);
  assert.deepEqual(cards.map((x) => x.order), [0, 1, 2]);
  store.reorder({ id: 'b', before: 'a' });
  assert.deepEqual(store.list({ project: '测试项目' }).map((x) => x.id), ['b', 'a', 'c']);
  assert.ok(store.list().every((x) => Number.isFinite(x.order) && x.order >= 0));
  assert.throws(() => store.reorder({ id: 'a', before: other.id }), /own project/);
  assert.throws(() => store.reorder({ id: 'a', before: 'a' }), /own project/);
  assert.throws(() => store.reorder({ id: 'a', before: 'b', after: 'c' }), /either/);
  assert.throws(() => store.reorder({ id: 'missing' }), /Unknown task/);
});

test('move preserves live execution/review/dispatcher fences and heartbeat never re-dispatches them', (t) => {
  const { store, add, bind, event } = fixture(t);
  for (const state of ['working', 'done', 'held', 'review', 'dispatcher']) {
    const c = add({ verify: state === 'review' });
    if (state === 'dispatcher') store.dispatch({ id: c.id, session_id: 'dispatch-' + state });
    else {
      bind(c.id, state, 'worker-' + state); event(c.id, 'started', '', state, 'worker-' + state);
      if (state === 'done' || state === 'review') event(c.id, 'complete', 'Done', state, 'worker-' + state);
      if (state === 'held') {
        event(c.id, 'failed', 'Broken', state, 'worker-' + state);
        bind(c.id, 'held2', 'worker-held2'); event(c.id, 'failed', 'Still broken', 'held2', 'worker-held2');
      }
    }
    store.sessions = () => [{ id: 'worker-' + state }, { id: 'worker-held2' }, { id: 'dispatch-' + state }];
    const before = store.list().find((x) => x.id === c.id);
    const moved = store.move({ id: c.id, status: 'doing' }).card;
    assert.equal(moved.session_id, before.session_id); assert.equal(moved.dispatch_session_id, before.dispatch_session_id);
    const starts = []; new TaskHeartbeat(store, { onStart: (i) => starts.push(i) }).scan();
    assert.equal(starts.length, 0, state); assert.equal(store.claim({ id: c.id }).ignored, true);
    assert.equal(store.dispatch({ id: c.id, session_id: 'duplicate' }).ignored, true);
    if (state === 'working') assert.throws(() => bind(c.id, 'replacement'), /active execution/);
    if (['done', 'held', 'review'].includes(state)) assert.equal(bind(c.id, 'replacement-' + state).card.session_id, 'worker');
  }
});

test('Captain move consumes start edge before a subsequent new, even without a session', (t) => {
  const { store, add, bind } = fixture(t); const c = add();
  store.move({ id: c.id, status: 'done' });
  const moved = store.move({ id: c.id, status: 'doing', suppressDispatch: true }).card;
  assert.equal(moved.dispatch_claim.delivered, true);
  const starts = []; new TaskHeartbeat(store, { onStart: (i) => starts.push(i) }).scan();
  assert.equal(starts.length, 0); assert.equal(bind(c.id).card.session_id, 'worker');
  const unbound = add(); store.move({ id: unbound.id, status: 'doing' });
  new TaskHeartbeat(store, { onStart: (i) => starts.push(i) }).scan();
  assert.equal(starts.length, 1, 'ordinary external starts still dispatch');
});

test('archived and failed legacy attempts can bind anew; live reviewers and just-created associated workers cannot', (t) => {
  const { store, add, bind, event, root } = fixture(t);
  const archived = add(); bind(archived.id); event(archived.id, 'started');
  store.sessions = () => [{ id: 'worker', archived: true }];
  assert.equal(bind(archived.id, 'fresh', 'fresh-worker').card.attempt_id, 'fresh');
  store.sessions = () => [];
  const failed = add(); bind(failed.id); event(failed.id, 'failed', 'Broken');
  // Old board versions sometimes failed to close the attempt.
  const file = path.join(root, 'tasks', '测试项目.json'), doc = JSON.parse(fs.readFileSync(file));
  doc.cards.find((c) => c.id === failed.id).attempt_closed = false; fs.writeFileSync(file, JSON.stringify(doc));
  assert.equal(bind(failed.id, 'retry').card.attempt_id, 'retry');
  const failedSession = add(); bind(failedSession.id, 'legacy-session');
  store.sessions = () => [{ id: 'worker', lastReceipt: { failed: 'quota exhausted' } }];
  assert.equal(bind(failedSession.id, 'new-session-attempt').card.attempt_id, 'new-session-attempt');
  store.sessions = () => [{ id: 'worker', active: true, boardId: failedSession.id, lastReceipt: { failed: 'old quota error' } }];
  assert.throws(() => bind(failedSession.id, 'duplicate-new-session'), /active execution/);
  const orphan = add(); store.sessions = () => [{ id: 'just-created', boardId: orphan.id, active: true }];
  assert.equal(store.claim({ id: orphan.id }).ignored, true);
  assert.throws(() => bind(orphan.id), /active execution/);
  store.sessions = () => [{ id: 'just-created', boardId: orphan.id, active: true, archived: true }];
  assert.equal(bind(orphan.id).card.session_id, 'worker');
});

test('resource failures in execution and review preserve the failure streak and never hold or count rework', (t) => {
  const { store, add, bind, event } = fixture(t);
  for (const [reason, source, kind] of [['RESOURCE_EXHAUSTED: quota exhausted', 'quota', 'quota'], ['API Error: 401 Unauthorized', 'process', 'auth'], ['Not logged in. Please run /login', 'automatic', 'auth'], ['429 Too many requests', 'process', 'rate_limit']]) {
    const c = add({ verify: true }); bind(c.id); event(c.id, 'failed', 'Real defect');
    bind(c.id, 'execution2'); event(c.id, 'complete', 'Fixed', 'execution2');
    for (let i = 0; i < 2; i++) {
      const attempt = 'resource-' + i; bind(c.id, attempt, 'reviewer');
      const failed = event(c.id, 'failed', reason, attempt, 'reviewer', source).card;
      assert.equal(failed.flag, 'quota'); assert.equal(failed.resource_failure, kind);
      assert.equal(failed.consecutive_failures, 1); assert.equal(failed.rework_count, 0);
      assert.equal(event(c.id, 'failed', 'process exited', attempt, 'reviewer', 'process').card.consecutive_failures, 1);
    }
    bind(c.id, 'real-defect'); assert.equal(event(c.id, 'failed', 'Assertion failed', 'real-defect').card.flag, 'held');
  }
});

test('dispatcher resource receipts do not hold; real dispatcher crashes do, and pending quota claims are durable', (t) => {
  const { store, add } = fixture(t); const c = add(); const key = store.claim({ id: c.id }).card.dispatch_claim.key;
  store.dispatchWait({ id: c.id, key, message: '额度用尽，稍后自动开' });
  assert.equal(store.list()[0].dispatch_claim.delivered, false);
  const starts = []; new TaskHeartbeat(store, { onStart: (i) => starts.push(i) }).scan(); assert.equal(starts[0].key, key);
  for (let i = 0; i < 2; i++) {
    store.dispatch({ id: c.id, session_id: 'quota-' + i });
    const failed = store.dispatcherReceipt({ id: c.id, session_id: 'quota-' + i, failed: 'Not logged in', source: 'quota' }).card;
    assert.equal(failed.flag, 'quota'); assert.equal(failed.consecutive_failures, 0);
  }
  for (let i = 0; i < 2; i++) {
    store.dispatch({ id: c.id, session_id: 'crash-' + i });
    store.dispatcherReceipt({ id: c.id, session_id: 'crash-' + i, failed: 'exit 7', source: 'process' });
  }
  assert.equal(store.list()[0].flag, 'held');
});

test('a pending heartbeat claim loses to a manual binding or a newer claim', (t) => {
  const { store, add, bind } = fixture(t); const c = add(); const starts = [];
  store.move({ id: c.id, status: 'doing' });
  const h = new TaskHeartbeat(store, { onStart: (i) => { starts.push(i); return false; } }); h.scan();
  bind(c.id); h.scan(); assert.equal(starts.length, 1);
  assert.equal(store.list()[0].dispatch_claim.delivered, true);
});

for (const reason of ['Rate limit handling test fails in api.js', 'Unauthorized access test still failing',
  'Limit reached check broken', 'npm test 失败\n401 Unauthorized']) {
  test(`command failure counts toward held without resource classification: ${reason}`, (t) => {
    const { store, add, bind, event } = fixture(t); const c = add({ verify: true });
    bind(c.id); event(c.id, 'complete', 'Ready for review');
    for (let i = 1; i <= 2; i++) {
      if (i === 2) { bind(c.id, 'repair'); event(c.id, 'complete', 'Reworked', 'repair'); }
      bind(c.id, 'review-' + i, 'reviewer');
      const failed = event(c.id, 'failed', reason, 'review-' + i, 'reviewer').card;
      assert.equal(failed.resource_failure, null);
      assert.equal(failed.consecutive_failures, i); assert.equal(failed.rework_count, i);
      assert.equal(failed.flag, i === 2 ? 'held' : 'failed');
    }
    assert.throws(() => store.claim({ id: c.id }), /held/);
  });
}

test('closed missing workers release occupancy on done to doing; foreign open attempts stay fenced', (t) => {
  const { store, add, bind, event } = fixture(t); const c = add();
  bind(c.id); event(c.id, 'complete', 'Done on another machine');
  assert.equal(store.occupied(store.list()[0]), false);
  const moved = store.move({ id: c.id, status: 'doing' }).card;
  assert.equal(moved.session_id, null); assert.equal(moved.attempt_id, null);
  const starts = []; new TaskHeartbeat(store, { onStart: (input) => starts.push(input) }).scan();
  assert.equal(starts.length, 1);
  const open = add(); bind(open.id, 'open', 'remote-worker');
  const file = path.join(store.dir, '测试项目.json'), doc = JSON.parse(fs.readFileSync(file));
  doc.cards.find((card) => card.id === open.id).session_host = os.hostname() + '-other-machine';
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.equal(store.occupied(store.list().find((card) => card.id === open.id)), true);
  assert.equal(store.move({ id: open.id, status: 'doing' }).card.session_id, 'remote-worker');
});

test('heartbeat reads session config once per scan and refreshes it on the next scan', (t) => {
  const { store, add } = fixture(t); const starts = []; let reads = 0;
  const cards = [add(), add(), add()];
  cards.forEach((c) => store.move({ id: c.id, status: 'doing' }));
  store.sessions = () => { reads++; return reads === 1 ? [] : [{ id: 'new-worker', boardId: cards[0].id }]; };
  const h = new TaskHeartbeat(store, { onStart: (input) => { starts.push(input); return false; } });
  h.scan(); assert.equal(reads, 1); assert.equal(starts.length, 3);
  h.scan(); assert.equal(reads, 2); assert.equal(starts.length, 5);
  assert.equal(h.pending.has(cards[0].id), false);
});

test('a finished unarchived worker reports occupancy rather than active execution', (t) => {
  const { store, add, bind, event } = fixture(t); const c = add();
  bind(c.id); event(c.id, 'complete', 'Done');
  store.sessions = () => [{ id: 'worker', boardId: c.id, active: false }];
  store.move({ id: c.id, status: 'todo' });
  assert.equal(store.activeAttempt(store.list()[0]), false);
  assert.equal(store.claim({ id: c.id, newEntry: true }).occupied, true);
});

test('missing local open workers in doing or needs_user can bind directly without a move', (t) => {
  const { store, add, bind, event } = fixture(t);
  for (const status of ['doing', 'needs_user']) {
    const c = add(); bind(c.id, 'old-' + status, 'gone-' + status);
    event(c.id, status === 'doing' ? 'started' : 'ask', 'Need an answer', 'old-' + status, 'gone-' + status);
    assert.equal(bind(c.id, 'new-' + status, 'replacement-' + status).card.session_host, os.hostname());
    assert.equal(event(c.id, 'complete', 'late old reply', 'old-' + status, 'gone-' + status).ignored, true);
  }
});

test('legacy missing local workers are identified by local task history, not remote absence', (t) => {
  const { store, add, bind, event, root } = fixture(t); const c = add();
  bind(c.id, 'legacy', 'old-local'); event(c.id, 'started', '', 'legacy', 'old-local');
  const file = path.join(root, 'tasks', '测试项目.json'), doc = JSON.parse(fs.readFileSync(file));
  delete doc.cards[0].session_host; fs.writeFileSync(file, JSON.stringify(doc));
  store.sessions = () => localSessions({ columns: [{ id: 'live' }], archived: [{ id: 'archived' }],
    mainSession: { tasks: [{ colId: 'old-local', status: 'working' }, { colId: 'old-local' }, { colId: 'live', status: 'working' }] } });
  assert.deepEqual(store.sessions().map((s) => s.id), ['live', 'archived', 'old-local']);
  assert.equal(bind(c.id, 'fresh', 'new-local').card.session_id, 'new-local');
  // No owner and no local history is not proof that a legacy remote worker ended.
  const after = JSON.parse(fs.readFileSync(file)); delete after.cards[0].session_host;
  fs.writeFileSync(file, JSON.stringify(after));
  assert.throws(() => bind(c.id, 'unsafe-takeover', 'other'), /active execution/);
});

test('foreign-machine open workers remain fenced even though absent from local sessions', (t) => {
  const { store, add, bind, event, root } = fixture(t); const c = add();
  bind(c.id, 'remote', 'remote-worker'); event(c.id, 'started', '', 'remote', 'remote-worker');
  const file = path.join(root, 'tasks', '测试项目.json'), doc = JSON.parse(fs.readFileSync(file));
  doc.cards[0].session_host = os.hostname() + '-other-machine'; fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => bind(c.id, 'duplicate', 'local-worker'), /active execution/);
  assert.equal(store.move({ id: c.id, status: 'doing' }).card.session_id, 'remote-worker');
  assert.equal(store.claim({ id: c.id }).ignored, true);
});

test('a bind reservation fences startup but expires if the local session was never created', (t) => {
  const { store, add, bind, root } = fixture(t); const c = add(); bind(c.id);
  assert.throws(() => bind(c.id, 'race', 'duplicate'), /active execution/);
  const file = path.join(root, 'tasks', '测试项目.json'), doc = JSON.parse(fs.readFileSync(file));
  doc.cards[0].session_bound_at = Date.now() - 15_001; fs.writeFileSync(file, JSON.stringify(doc));
  assert.equal(bind(c.id, 'recover', 'replacement').card.session_id, 'replacement');
});
test('project matching ignores case for list, archive and bind, and never rewrites the stored name', (t) => {
  const { store, add, bind } = fixture(t);
  const card = add({ project: 'AgentDeck' }), other = add({ project: 'Hermes' });
  assert.deepEqual(store.list({ project: 'agentdeck' }).map((c) => c.id), [card.id]);
  assert.deepEqual(store.list({ project: 'AGENTDECK' }).map((c) => c.id), [card.id]);
  assert.deepEqual(store.list({ project: 'agentdeck2' }), [], 'a different name is a different project');
  assert.throws(() => store.bind({ id: card.id, project: 'hermes', attempt_id: 'a1', session_id: 'w', assignee: { agent: 'codex', model: 'm' } }), /differs from the card project/);
  assert.equal(store.bind({ id: card.id, project: 'agentdeck', attempt_id: 'a1', session_id: 'w', assignee: { agent: 'codex', model: 'm' } }).card.id, card.id);
  store.move({ id: other.id, status: 'done' });
  store.archive({ done: true, project: 'HERMES' });
  assert.equal(store.list({ archived: true }).find((c) => c.id === other.id).archived, true);
  assert.equal(store.list({ archived: true }).find((c) => c.id === card.id).project, 'AgentDeck');
  assert.equal(store.list({ archived: true }).find((c) => c.id === other.id).project, 'Hermes');
});

test('dispatch reservations ignore consumed or replaced start claims before validating readiness', (t) => {
  const { store, add, bind } = fixture(t);
  for (const status of ['todo', 'done']) {
    const card = add();
    const key = store.claim({ id: card.id }).card.dispatch_claim.key;
    store.move({ id: card.id, status });
    assert.equal(store.dispatch({ id: card.id, key, session_id: 'stale-' + status }).ignored, true);
    assert.equal(store.list().find((c) => c.id === card.id).status, status);
    assert.equal(store.list().find((c) => c.id === card.id).dispatch_session_id, null);
  }
  const card = add();
  const old = store.claim({ id: card.id }).card.dispatch_claim.key;
  store.move({ id: card.id, status: 'todo' });
  const key = store.claim({ id: card.id }).card.dispatch_claim.key;
  assert.equal(store.dispatch({ id: card.id, key: old }).ignored, true);
  assert.equal(store.dispatch({ id: card.id, key }).ignored, undefined);
  bind(card.id);
  assert.equal(store.dispatch({ id: card.id, key, session_id: 'stale-after-bind' }).ignored, true);
});
