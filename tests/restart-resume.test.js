'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../restart-resume');

const id = '11111111-1111-4111-8111-111111111111';
const crew = (colId, extra = {}) => ({ id: colId, title: colId, captainCrew: true, coldSpawned: true, cmd: extra.cmd || 'cursor-agent', ...extra });
const task = (colId, status, summary, extra = {}) => ({ colId, id: 'k-' + colId, title: colId, status, receipt: summary ? { summary, files: [], failed: '' } : null, ...extra });

test('only the explicit checkpoint token is a safe stop', () => {
  assert.equal(R.isSafetyCheckpoint('AGENTDECK-CHECKPOINT 重启前停在安全点，重启后会自动续上。'), true);
  assert.equal(R.isSafetyCheckpoint('功能已做完并推送。等待队长验收。'), false);
  assert.equal(R.isSafetyCheckpoint('已停在安全点并推送，等待续派'), false);
  assert.equal(R.isSafetyCheckpoint('停下等待，重启后继续'), false);
  assert.equal(R.isSafetyCheckpoint('waiting for the captain'), false);
  assert.equal(R.isCheckpointClosure(task('a', 'done', '功能已做完并推送。等待队长验收。')), false);
  assert.equal(R.isCheckpointClosure({ status: 'paused', receipt: { checkpoint: true, summary: R.checkpointSummary(), failed: '' } }), true);
});

test('resume covers the same open statuses after a crash or a clean quit, and not a finished card', () => {
  for (const status of ['queued', 'working', 'paused', 'quota', 'input', 'asking']) assert.equal(R.shouldResume(task('a', status, '')), true, status);
  assert.equal(R.shouldResume(task('a', 'done', '功能已做完并推送')), false);
  assert.equal(R.shouldResume(task('a', 'done', 'AGENTDECK-CHECKPOINT 重启前停在安全点。')), true);
  assert.equal(R.shouldResume(task('a', 'stopped', '队长已请求中断当前操作。')), false);
  assert.equal(R.shouldResume(task('a', 'failed', '')), false);
  assert.deepEqual(R.planPark([crew('live'), crew('done'), crew('ask'), { id: 'cap', isMain: true }], [
    task('live', 'working'), task('done', 'done', '功能已做完并推送'), task('ask', 'asking'), task('cap', 'working'),
  ]).map((p) => p.id), ['live', 'ask']);
  const columns = [crew('live'), crew('quota'), crew('done'), crew('hot', { coldSpawned: false }), crew('manual', { captainCrew: false })];
  const tasks = [task('live', 'working'), task('quota', 'quota'), task('done', 'done', '功能已做完并推送。等待队长验收。'), task('hot', 'working'), task('manual', 'working')];
  assert.deepEqual(R.planResume(columns, tasks, {}).map((p) => p.id), ['live', 'quota']);
});

test('each CLI resumes only with its own id, otherwise the launch is a new session', () => {
  const claude = R.launchChoice({ cmd: 'claude --effort high', sessionId: id, task: task('a', 'working') });
  assert.equal(claude.mode, 'resume');
  assert.equal(claude.launch, `claude --resume ${id} --effort high`);
  assert.match(claude.note, /真续接：Claude/);

  const grok = R.launchChoice({ cmd: 'grok --temp 0', sessionId: id, task: task('a', 'working') });
  assert.equal(grok.launch, `grok -r ${id} --temp 0`);

  const cursor = R.launchChoice({ cmd: 'cursor-agent --force --model grok-4.7-high-fast', sessionId: id, task: task('a', 'working') });
  assert.equal(cursor.mode, 'resume');
  assert.equal(cursor.launch, `cursor-agent --resume ${id} --force --model grok-4.7-high-fast`);
  assert.match(cursor.note, /真续接：Cursor/);

  const codex = R.launchChoice({ cmd: 'codex --dangerously-bypass-approvals-and-sandbox', sessionId: id, task: task('a', 'quota') });
  assert.equal(codex.launch, `codex resume ${id} --dangerously-bypass-approvals-and-sandbox`);
  assert.match(codex.note, /真续接：Codex/);

  const agy = R.launchChoice({ cmd: 'agy --dangerously-skip-permissions --model gemini-3.8-flash-high', sessionId: id, task: task('a', 'working') });
  assert.equal(agy.launch, `agy --conversation ${id} --dangerously-skip-permissions --model gemini-3.8-flash-high`);
  assert.match(agy.note, /真续接：Antigravity/);

  const quoted = R.launchChoice({ cmd: '"C:\\Tools\\claude.exe" --model opus', sessionId: id, task: task('a', 'working') });
  assert.equal(quoted.launch, `"C:\\Tools\\claude.exe" --resume ${id} --model opus`);
});

test('without a session id the restart opens a new session and the message carries the card and the last receipt', () => {
  for (const cmd of ['claude', 'cursor-agent --force', 'codex resume --last --yolo', 'agy -c --model gemini-3.8-flash-high', 'node fake-agent.js']) {
    const choice = R.launchChoice({ cmd, sessionId: '', task: task('a', 'working') });
    assert.equal(choice.mode, 'resend', cmd);
    assert.equal(choice.resumedAgent, false);
    assert.doesNotMatch(choice.launch, /resume|conversation|--last|(?:^|\s)-r(?:\s|$)|(?:^|\s)-c(?:\s|$)/);
  }
  assert.equal(R.launchChoice({ cmd: 'agy -c conf.toml --model gemini-3.8-flash-high', sessionId: '', task: task('a', 'working') }).launch,
    'agy conf.toml --model gemini-3.8-flash-high');
  const text = R.resumeMessage({ mode: 'resend', provider: 'Codex', title: '永动机', task: '把续接做完', receipt: '上次停在测试', pendingText: '再补一句' });
  assert.match(text, /重发：Codex/);
  assert.match(text, /把续接做完/);
  assert.match(text, /上次停在测试/);
  assert.match(text, /再补一句/);
  assert.doesNotMatch(text, /真续接/);
  const again = R.resumeMessage({ mode: 'resume', provider: 'Claude', title: '永动机', retry: true });
  assert.match(again, /真续接：Claude/);
  assert.match(again, /再次送达/);
  assert.equal(R.launchChoice({ cmd: 'claude', sessionId: id, task: task('a', 'done', '功能已做完并推送'), enabled: true }).mode, 'leave');
  assert.equal(R.launchChoice({ cmd: 'claude', sessionId: id, task: task('a', 'working'), enabled: false }).mode, 'leave');
});

test('fresh and resume commands clear stale provider resume and creation selectors', () => {
  const old = '22222222-2222-4222-8222-222222222222';
  const cases = [
    [`claude --session-id ${old} -r ${old} --model opus`, 'claude --model opus', `claude --resume ${id} --model opus`],
    [`claude --session-id=${old} --resume=${old} -c --model opus`, 'claude --model opus', `claude --resume ${id} --model opus`],
    [`grok -s ${old} -r ${old} --temp 0`, 'grok --temp 0', `grok -r ${id} --temp 0`],
    [`grok --session-id=${old} --resume=${old}`, 'grok', `grok -r ${id}`],
    [`cursor-agent --resume ${old} --force`, 'cursor-agent --force', `cursor-agent --resume ${id} --force`],
    [`codex resume ${old} --yolo`, 'codex --yolo', `codex resume ${id} --yolo`],
    [`codex resume --model gpt-5 ${old} --yolo`, 'codex --model gpt-5 --yolo', `codex resume ${id} --model gpt-5 --yolo`],
    [`codex --yolo resume ${old}`, 'codex --yolo', `codex resume ${id} --yolo`],
    [`codex -c 'model=\"gpt-5\"' resume ${old}`, `codex -c 'model=\"gpt-5\"'`, `codex resume ${id} -c 'model=\"gpt-5\"'`],
    ['codex resume --last --all --yolo', 'codex --yolo', `codex resume ${id} --yolo`],
    [`agy --conversation=${old} -c --model flash`, 'agy --model flash', `agy --conversation ${id} --model flash`],
    [`gemini -r ${old} --model flash`, 'gemini --model flash', `gemini --resume ${id} --model flash`],
  ];
  for (const [cmd, fresh, resume] of cases) {
    assert.equal(R.freshCommand(cmd), fresh, cmd);
    assert.equal(R.resumeCommand(cmd, id), resume, cmd);
    assert.equal(R.launchChoice({ cmd, task: task('a', 'working') }).launch, fresh, cmd);
  }
  assert.equal(R.providerOf('gemini'), 'Gemini');
  assert.equal(R.freshCommand('codex -c model="gpt-5" --model resume'), 'codex -c model="gpt-5" --model resume');
});

test('a claim is sent once, retried once, then failed closed so it cannot be dispatched again', () => {
  assert.equal(R.claimDisposition(null), 'send');
  assert.equal(R.claimDisposition({ phase: 'armed' }), 'retry');
  assert.equal(R.claimDisposition({ phase: 'retrying' }), 'fail');
  assert.equal(R.claimDisposition({ phase: 'sent' }), 'skip');
  assert.equal(R.claimDisposition({ phase: 'failed' }), 'skip');
  const columns = [crew('live'), crew('done-claim')];
  const tasks = [task('live', 'paused'), task('done-claim', 'paused')];
  assert.deepEqual(R.planResume(columns, tasks, { 'done-claim': { phase: 'sent', taskId: 'k-done-claim', runId: 'run' } }, 'run').map((p) => p.id), ['live']);
  assert.deepEqual(R.nextBatch(['a', 'b', 'c'], 0, 2), ['a', 'b']);
  assert.deepEqual(R.nextBatch(['a', 'b', 'c'], 1, 2), ['a']);
  assert.deepEqual(R.nextBatch(['a'], 2, 2), []);
});

test('manifest damage is an empty plan, and a quota grace is not a new quota failure', () => {
  assert.deepEqual(R.parseManifest('{'), R.emptyManifest());
  assert.deepEqual(R.parseManifest('{"version":2}'), R.emptyManifest());
  const parsed = R.parseManifest(JSON.stringify({ version: 1, claims: { a: { phase: 'sent' } }, entries: [{ colId: 'a' }, { no: 1 }] }));
  assert.equal(parsed.claims.a.phase, 'sent');
  assert.deepEqual(parsed.entries.map((e) => e.colId), ['a']);
  const entry = R.manifestEntry({ colId: 'c', cmd: 'cursor-agent --force', cwd: '/tmp/work', sessionId: id, title: '卡', detail: '正文', receipt: '回执', pendingText: '', task: task('c', 'working') });
  assert.equal(entry.mode, 'resume');
  assert.equal(entry.sessionId, id);
  assert.equal(entry.task, '正文');
  assert.equal(R.ledgerState('done', true, { status: 'working' }), 'working');
  assert.equal(R.ledgerState('done', true, { status: 'paused' }), 'paused');
  assert.equal(R.ledgerState('done', true, { status: 'done' }), 'done');
  assert.equal(R.ignoreQuota({ resumeGraceUntil: 100 }, 50), true);
  assert.equal(R.ignoreQuota({ resumeGraceUntil: 100 }, 100), false);
  assert.equal(R.resumeEnabled({}), true);
  assert.equal(R.resumeEnabled({ resumeOnRestart: false }), false);
});

test('quit ack and the timeout both leave the current turn before quitting, and neither can cancel the other', () => {
  const later = [];
  const quits = [];
  let scheduled = null;
  const gate = R.createQuitGate({
    timeoutMs: 1500,
    schedule: (fn) => { scheduled = fn; return () => { scheduled = null; }; },
    later: (fn) => later.push(fn),
    quit: () => quits.push('quit'),
    onPark: () => gate.acked(),
  });
  const event = { preventDefault() { event.prevented = true; } };
  assert.equal(gate.beforeQuit(event, true), 'parking');
  assert.equal(event.prevented, true);
  assert.equal(quits.length, 0);
  assert.equal(scheduled, null);
  assert.equal(later.length, 1);
  later[0]();
  assert.deepEqual(quits, ['quit']);
  const again = { preventDefault() { again.prevented = true; } };
  assert.equal(gate.beforeQuit(again, true), 'cleanup');
  assert.equal(again.prevented, undefined);

  const later2 = [];
  const quits2 = [];
  let fire = null;
  let cancelled = false;
  const slow = R.createQuitGate({
    timeoutMs: 1500,
    schedule: (fn) => { fire = fn; return () => { cancelled = true; }; },
    later: (fn) => later2.push(fn),
    quit: () => quits2.push('quit'),
  });
  assert.equal(slow.beforeQuit({ preventDefault() {} }, true), 'parking');
  assert.equal(slow.beforeQuit({ preventDefault() {} }, true), 'waiting');
  fire();
  fire();
  assert.equal(cancelled, true);
  assert.equal(later2.length, 1);
  later2[0]();
  assert.deepEqual(quits2, ['quit']);
  assert.equal(R.createQuitGate({ schedule() {}, later() {}, quit() {} }).beforeQuit({ preventDefault() {} }, false), 'cleanup');
});


test('authenticated shell-tool identity binds only its column provider, not other candidates', () => {
  const candidates = { Codex: id, Cursor: '22222222-2222-4222-8222-222222222222', Antigravity: '33333333-3333-4333-8333-333333333333' };
  for (const [cmd, provider] of [['codex', 'Codex'], ['cursor-agent', 'Cursor'], ['agy', 'Antigravity']]) {
    const col = { id: 'worker', cmd, cwd: '/work' };
    assert.equal(R.bindSessionIdentity(col, candidates, [col]), true);
    assert.equal(col.modelSessionId, candidates[provider]);
    assert.equal(col.modelSessionOwner, col.id);
    assert.equal(col.modelSessionCwd, col.cwd);
    assert.equal(col.modelSessionSource, 'agent-env');
    assert.equal(R.bindSessionIdentity(col, candidates, [col]), false);
    const choice = R.launchChoice({ cmd, sessionId: col.modelSessionId, task: task('worker', 'working') });
    assert.equal(choice.mode, 'resume');
    assert.ok(choice.launch.includes(candidates[provider]));
  }
});

test('wrong provider, malformed id and duplicate column identity cannot certify ownership', () => {
  for (const candidates of [null, {}, { Cursor: id }, { Codex: 'malformed' }]) {
    const col = { id: 'worker', cmd: 'codex', cwd: '/work' };
    assert.equal(R.bindSessionIdentity(col, candidates, [col]), false);
    assert.equal(col.modelSessionId, undefined);
  }
  const col = { id: 'worker', cmd: 'codex', cwd: '/work' };
  assert.equal(R.bindSessionIdentity(col, { Codex: id }, [col, { id: 'other', cmd: 'codex', modelSessionId: id.toUpperCase() }]), false);
  assert.equal(R.bindSessionIdentity({ id: 'claude', cmd: 'claude' }, { Codex: id }, []), false);
});

// 10-10 00:51: the session that ran the 2.0.6 install was closed with the app and, with an install pending,
// was left out of the restart's continue list; its post-install check then had no owner until the Captain woke it.
// It is continued like any open task. It is still not parked (nothing to ask of it: the installer ends the app).
test('a session whose installation is awaiting verification is continued after the restart, though never checkpointed', () => {
  const pending = task('installer', 'working', '', { pendingInstall: { id: 'install-1', targetVersion: '2.0.6' } });
  assert.equal(R.shouldResume(pending), true);
  assert.equal(R.holdsAcrossRestart(pending), true);
  assert.equal(R.shouldPark(pending), false);
  assert.deepEqual(R.planResume([crew('installer')], [pending], {}, 'reboot').map((p) => p.id), ['installer']);
  assert.deepEqual(R.planPark([crew('installer')], [pending]), []);
  // other sessions' rules are unchanged
  assert.equal(R.shouldResume(task('done', 'done', '做完了')), false);
  assert.equal(R.shouldResume(task('live', 'working')), true);
});

test('the continue message tells an installer not to install again and what the install came to', () => {
  const plain = R.resumeMessage({ mode: 'resume', provider: 'Claude' });
  assert.doesNotMatch(plain, /安装/);
  const waiting = R.resumeMessage({ mode: 'resume', provider: 'Claude', install: { targetVersion: '2.0.6' } });
  assert.match(waiting, /2\.0\.6/);
  assert.match(waiting, /不要重新安装/);
  const done = R.resumeMessage({ mode: 'resend', provider: 'Claude', title: '装机', install: { targetVersion: '2.0.6', summary: 'AgentDeck 安装 2.0.6 成功；现在运行 2.0.6。' } });
  assert.match(done, /AgentDeck 安装 2\.0\.6 成功/);
  assert.match(done, /不要重新安装/);
});

// 10-09 12:10–12:15: before installing 2.0.3 the Captain told nine sessions to stop at a safe point. Five
// wrote their progress and ended the turn; three minutes later each read 已结束，未提交回执 (the provisional
// no-receipt fallback, status stopped), the quit did not park them and the restart left them alone.
const fallbackStop = (colId, extra = {}) => task(colId, 'stopped', '已结束，未提交回执', {
  receipt: { summary: '已结束，未提交回执', files: [], images: [], failed: '', explicit: false, source: 'fallback' }, ...extra });

test('a task closed only by the three-minute no-receipt fallback is parked for a restart like an open one', () => {
  assert.equal(R.shouldPark(fallbackStop('safe')), true);
  assert.equal(R.shouldPark(task('stop', 'stopped', '队长已请求中断当前操作。', { receipt: { summary: '队长已请求中断当前操作。', failed: '', source: 'captain-stop' } })), false);
  assert.equal(R.shouldPark(task('done', 'done', '功能已做完并推送')), false);
  assert.equal(R.shouldPark(task('fail', 'failed', '', { receipt: { summary: '', failed: '额度用尽', source: 'quota' } })), false);
  assert.equal(R.shouldPark(fallbackStop('install', { pendingInstall: { id: 'i' } })), false);
  assert.deepEqual(R.planPark([crew('safe'), crew('done'), crew('live'), crew('stop')], [
    fallbackStop('safe'), task('done', 'done', '功能已做完'), task('live', 'working'),
    task('stop', 'stopped', '队长已请求中断当前操作。', { receipt: { summary: '队长已请求中断当前操作。', failed: '', source: 'captain-stop' } }),
  ]).map((p) => [p.id, p.idle === true]), [['safe', true], ['live', false]]);
});

// 10-09 20:26 (2.0.4 installed) and 21:04 (the user restarted by hand): the same five sessions, closed by
// 已结束，未提交回执 between 18:59 and 20:18, were again not continued, and the Captain woke each one with tell.
// However the app went down (a clean quit, a force quit, a crash), a task closed only by that fallback is
// continued at the next start like an open one.
test('a task closed only by the no-receipt fallback is continued at the next start, without a park', () => {
  assert.equal(R.shouldResume(fallbackStop('safe')), true);
  assert.equal(R.holdsAcrossRestart(fallbackStop('safe')), true);
  assert.equal(R.shouldResume(fallbackStop('failed', { receipt: { summary: '', failed: '进程退出', source: 'fallback' } })), false);
  assert.equal(R.shouldResume(task('stop', 'stopped', '队长已请求中断当前操作。', { receipt: { summary: '队长已请求中断当前操作。', failed: '', source: 'captain-stop' } })), false);
  assert.deepEqual(R.planResume([crew('safe'), crew('done')], [fallbackStop('safe'), task('done', 'done', '功能已做完')], {}).map((p) => p.id), ['safe']);
});

// After a restart the Captain is back only when it does something itself (works, or runs a command) after its
// notice went in: on 10-09 the notice was typed into its terminal and sat unsent for four hours.
test('the restart watch reports a Captain not back within a minute, once, and its recovery', () => {
  const w = R.createRestartWatch({ startedAt: 1000 });
  w.expect('cap', 'captain', '队长', 1000);
  w.sent('cap', 3000);
  assert.deepEqual(w.due(60_000), []);
  const due = w.due(61_000);
  assert.deepEqual(due.map((d) => [d.id, d.kind, d.sentAt]), [['cap', 'captain', 3000]]);
  assert.deepEqual(w.due(70_000), [], 'alarmed once');
  assert.deepEqual(w.recovered(), []);
  w.confirm('cap', 80_000);
  assert.deepEqual(w.recovered().map((d) => d.id), ['cap']);
  assert.deepEqual(w.recovered(), [], 'recovery is reported once');
});

test('a Captain that works within the minute is never reported; work before its notice went in does not count', () => {
  const w = R.createRestartWatch({ startedAt: 0 });
  w.expect('cap', 'captain', '队长', 0);
  w.confirm('cap', 2000);
  assert.equal(w.pending('cap'), true, 'nothing went in yet');
  w.sent('cap', 5000);
  w.confirm('cap', 4000);
  assert.equal(w.pending('cap'), true, 'an observation older than the send is no proof');
  w.confirm('cap', 7000);
  assert.equal(w.pending('cap'), false);
  assert.deepEqual(w.due(10 * 60_000), []);
});

test('the restart watch reports crew whose continue message never went in, went in without effect, or failed', () => {
  const w = R.createRestartWatch({ startedAt: 0 });
  for (const id of ['quiet', 'late', 'failed', 'fine', 'dropped']) w.expect(id, 'crew', id, 0);
  w.sent('quiet', 10_000); w.sent('fine', 10_000); w.sent('failed', 10_000);
  w.confirm('fine', 15_000);
  w.fail('failed', '新会话的重发指令也未能送达');
  w.drop('dropped');
  assert.deepEqual(w.due(20_000).map((d) => [d.id, d.reason]), [['failed', '新会话的重发指令也未能送达']]);
  assert.deepEqual(w.due(99_000).map((d) => d.id), [], 'a sent message has 90 s');
  assert.deepEqual(w.due(100_000).map((d) => d.id), ['quiet']);
  assert.deepEqual(w.due(179_000).map((d) => d.id), []);
  assert.deepEqual(w.due(180_000).map((d) => d.id), ['late'], 'a message that never went in has three minutes');
  assert.equal(w.pending('dropped'), false);
});
