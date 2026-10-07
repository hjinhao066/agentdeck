'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Core = require('./discussion-core');
const { createStore } = require('./discussion-store');
const Runner = require('./discussion-runner');

function settings(auth) {
  const profile = process.env.AGENTDECK_DISCUSS_TEST_PROFILE;
  if (profile) {
    if (!path.isAbsolute(profile) || !path.basename(profile).startsWith('agentdeck-discuss-test-') ||
        !fs.existsSync(path.join(profile, 'test-profile.json')) || path.resolve(auth.controlDir) !== path.join(path.resolve(profile), 'board-control')) throw new Error('Invalid isolated discussion test profile.');
  }
  return { root: profile ? path.join(profile, 'discussions') : undefined,
    configFile: path.join(path.dirname(auth.controlDir), 'config.json') };
}
function readFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('文件参数必须是完整绝对路径。');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 2_000_000) throw new Error('文件必须是 2 MB 以内的普通文件。');
  return fs.readFileSync(file, 'utf8');
}
async function startRunner(store, id, auth, configFile) {
  const child = spawn(process.execPath, [path.join(__dirname, 'discussion-runner.js'), store.root, id, configFile], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTDECK_CONTROL_DIR: auth.controlDir, AGENTDECK_CONTROL_TOKEN: auth.token },
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => {
      const run = store.load(id); run.status = 'paused'; run.pauseReason = 'RUNNER_SPAWN_FAILED'; store.save(run);
      reject(new Error('讨论执行器无法启动；产物已保存，可用 resume 续跑。'));
    });
  });
  child.unref();
  return child.pid;
}
function summary(run, store) {
  const dir = store.dir(run.id), current = Runner.owner(dir);
  let note;
  try { note = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8')); } catch {}
  return { id: run.id, question: run.publicQuestion, status: run.status, pauseReason: run.pauseReason, phase: run.phase, round: run.round,
    resumeBlocked: run.resumeBlocked || [], resumedJobs: run.resumedJobs || [], completedRounds: run.rounds.length, plannedRounds: run.plannedRounds, directory: dir,
    runnerActive: Runner.active(current, { dir }), participants: run.participants,
    jobs: run.jobs.map((j) => ({ id: j.id, participantId: j.participantId, round: j.round, phase: j.phase,
      status: j.status, attemptId: j.attemptId, actualModel: j.actualModel, actualTier: j.actualTier,
      actualEffort: j.actualEffort, progress: j.progress, failure: j.failure, mayHaveSent: j.mayHaveSent, metadataNeeded: j.status === 'metadata-needed', answerSaved: j.answerSaved })),
    summary: run.summary, disagreements: run.disagreements, minority: run.minority,
    ...(run.status === 'complete' ? { final: path.join(dir, 'final.md') } : {}),
    ...(note ? { receipt: note.text, receiptDelivered: note.delivered } : {}) };
}
async function command(args, auth) {
  const config = settings(auth), store = createStore({ root: config.root });
  const op = args._[1];
  if (!['start', 'status', 'wait', 'resume', 'cancel', 'help'].includes(op)) throw new Error('discuss requires start, status, wait, resume or cancel.');
  if (op === 'help') { const file = fs.existsSync(path.join(__dirname, 'discuss.md')) ? path.join(__dirname, 'discuss.md') : path.join(__dirname, 'docs', 'discuss.md'); return fs.readFileSync(file, 'utf8'); }
  if (op === 'start') {
    if (args.topic !== undefined && args['topic-file'] !== undefined) throw new Error('只用 --topic 或 --topic-file 其中一个。');
    const question = args['topic-file'] ? readFile(args['topic-file']) : args.topic;
    let chosen = args['participants-file'] ? JSON.parse(readFile(args['participants-file'])) : Core.DEFAULT_PARTICIPANTS.map((p) => ({ ...p }));
    if (args.gemini === true) chosen = chosen.concat({ ...Core.GEMINI_PARTICIPANT });
    const run = Core.createDiscussion({ question, participants: chosen, summarizer: args.summarizer,
      maxRounds: args['max-rounds'] === undefined ? 3 : Number(args['max-rounds']),
      privacy: { usernames: [os.userInfo().username], sessionIds: [process.env.AGENTDECK_TERMINAL_ID, process.env.CODEX_THREAD_ID].filter(Boolean) } });
    store.create(run);
    const pid = await startRunner(store, run.id, auth, config.configFile);
    return { id: run.id, status: run.status, directory: store.dir(run.id), pid };
  }
  if (op === 'status' && !args.id) return store.list();
  Core.id(args.id);
  const dir = store.dir(args.id);
  if (op === 'status') return summary(store.load(args.id), store);
  if (op === 'wait') {
    const timeout = args.timeout === undefined ? 3600 : Number(args.timeout);
    if (!Number.isFinite(timeout) || timeout < 0) throw new Error('--timeout 必须是非负秒数。');
    const until = Date.now() + timeout * 1000;
    while (true) {
      const run = store.load(args.id);
      if (['complete', 'paused', 'cancelled'].includes(run.status)) {
        await Runner.deliver(run, dir, auth);
        return Runner.receipt(run, dir).text;
      }
      if (Date.now() >= until) return summary(run, store);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const current = Runner.owner(dir);
  if (Runner.active(current, { dir })) {
    if (op === 'resume') throw new Error('讨论执行器仍在运行；用 status 或 wait 等候，不能重复续跑。');
    fs.writeFileSync(path.join(dir, 'cancel.request'), 'cancel', { mode: 0o600 });
    return { id: args.id, status: 'cancelling', directory: dir };
  }
  const release = Runner.lock(dir);
  let run;
  try {
    run = store.load(args.id);
    if (op === 'cancel') {
      Core.cancel(run); store.save(run);
    } else {
      let application = {};
      try { application = JSON.parse(fs.readFileSync(config.configFile, 'utf8')); } catch {}
      const adapter = Runner.adapters({ getConfig: () => application });
      try { await Runner.recoverResults(run, adapter, dir, { allowForegroundRecovery: args['accept-saved'] === true }); } finally { adapter.dispose?.(); }
      store.save(run);
      if (args['metadata-file']) {
        Core.supplyMetadata(run, args.job, JSON.parse(readFile(args['metadata-file']))); store.save(run);
      }
      if (args['result-file']) {
        const job = run.jobs.find((j) => j.id === args.job);
        if (!job) throw new Error('--result-file requires --job from discuss status.');
        const accepted = Core.acceptResult(run, job.id, { text: readFile(args['result-file']), attemptId: job.attemptId,
          actualModel: args.model, actualTier: args.tier, actualEffort: args.effort, verificationSource: 'manual-import' });
        store.save(run);
        if (accepted.invalid) throw new Error(accepted.reason);
      }
      if (run.status !== 'complete') Core.resume(run, {
        ...(args.retry ? { retryIds: String(args.retry).split(',') } : {}),
        confirmedNotSent: args['confirmed-ended'] ? String(args['confirmed-ended']).split(',') : [],
      });
      store.save(run);
      try { fs.unlinkSync(path.join(dir, 'cancel.request')); } catch {}
    }
  } finally { release(); }
  if (run.status === 'running') await startRunner(store, run.id, auth, config.configFile);
  else await Runner.deliver(run, dir, auth);
  return summary(run, store);
}
module.exports = { command, settings, summary };
