'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { id } = require('./discussion-core');

const DEFAULT_ROOT = path.join(os.homedir(), '.agents-state', 'agentdeck', 'discussions');
function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Discussion directories cannot be symlinks.');
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}
function atomicWrite(file, text) {
  privateDirectory(path.dirname(file));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Discussion files cannot be symlinks.');
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function immutableWrite(file, text) {
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink() || fs.readFileSync(file, 'utf8') !== text) throw new Error('Frozen discussion artifact cannot be overwritten.');
    return;
  }
  atomicWrite(file, text);
}
function json(value) { return JSON.stringify(value, null, 2) + '\n'; }
function createStore(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  function dir(discussionId) { return path.join(root, id(discussionId)); }
  function save(run) {
    const destination = dir(run.id);
    privateDirectory(root); privateDirectory(destination);
    // Artifacts precede the durable state. A crash can leave extra artifacts but
    // never a state claiming that missing drafts or packets were archived.
    immutableWrite(path.join(destination, 'question.md'), run.question);
    immutableWrite(path.join(destination, 'public-question.md'), run.publicQuestion);
    atomicWrite(path.join(destination, 'private', 'author-map.json'), json(run.authorMap));
    atomicWrite(path.join(destination, 'private', 'redaction-map.json'), json(run.privacy.mapping));
    for (const job of run.jobs) {
      id(job.id); id(job.attemptId);
      const phase = job.phase === 'summary' ? 'summary' : `round-${String(job.round).padStart(2, '0')}`;
      const base = path.join(destination, phase);
      const name = `${job.id}-${job.attemptId}`;
      immutableWrite(path.join(base, 'input', `${name}.md`), job.input);
      immutableWrite(path.join(base, 'input', `${name}.meta.json`), json({ jobId: job.id, attemptId: job.attemptId, inputHash: job.inputHash, participantId: job.participantId }));
      if (job.rejectedOutput) {
        const rejectedHash = crypto.createHash('sha256').update(job.rejectedOutput).digest('hex');
        immutableWrite(path.join(base, 'rejected', `${name}-${rejectedHash}.md`), job.rejectedOutput);
      }
      if (job.output !== undefined) {
        immutableWrite(path.join(base, 'output', `${name}.md`), job.rawOutput || job.output);
        immutableWrite(path.join(base, 'output', `${name}.meta.json`), json({ jobId: job.id, attemptId: job.attemptId,
          outputHash: job.outputHash, actualModel: job.actualModel, actualTier: job.actualTier, actualEffort: job.actualEffort,
          observedModel: job.observedModel, verificationSource: job.verificationSource, completedAt: job.completedAt }));
      }
    }
    for (const round of run.rounds) immutableWrite(path.join(destination, `round-${String(round.number).padStart(2, '0')}`, 'frozen-manifest.json'), json(round));
    atomicWrite(path.join(destination, 'disagreements.md'), run.disagreements.map((value) => `- ${value}`).join('\n'));
    atomicWrite(path.join(destination, 'events.jsonl'), run.events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    if (run.status === 'complete') {
      immutableWrite(path.join(destination, 'final.md'), run.finalAnswer);
      immutableWrite(path.join(destination, 'final-meta.json'), json({ id: run.id, status: run.status, model: run.finalModel,
        summary: run.summary, faithful: run.faithful, finalHash: run.finalHash, rounds: run.rounds.length,
        disagreements: run.disagreements, minority: run.minority, participants: run.participants,
        actualModels: run.jobs.map((j) => ({ jobId: j.id, actualModel: j.actualModel, actualTier: j.actualTier,
          actualEffort: j.actualEffort, observedModel: j.observedModel, verificationSource: j.verificationSource })) }));
    }
    const serialized = json(run);
    if (Buffer.byteLength(serialized) > 32_000_000) throw new Error('Discussion state is too large; drafts were kept without trimming.');
    atomicWrite(path.join(destination, 'run.json'), serialized);
    return destination;
  }
  function create(run) {
    privateDirectory(root);
    fs.mkdirSync(dir(run.id), { mode: 0o700 });
    return save(run);
  }
  function load(discussionId) {
    const destination = dir(discussionId);
    const file = path.join(destination, 'run.json');
    if (fs.lstatSync(destination).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Discussion state cannot be a symlink.');
    if (fs.statSync(file).size > 32_000_000) throw new Error('Discussion state is too large.');
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (run.version !== 1 || run.id !== discussionId || !Array.isArray(run.jobs) || !Array.isArray(run.rounds)) throw new Error('Invalid discussion state; it was left untouched.');
    return run;
  }
  function list() {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]{1,160}$/.test(entry.name))
      .map((entry) => { try { const run = load(entry.name); return { id: run.id, status: run.status, phase: run.phase, round: run.round, createdAt: run.createdAt }; }
      catch { return { id: entry.name, status: 'invalid' }; } });
  }
  return { root, dir, create, save, load, list };
}
module.exports = { DEFAULT_ROOT, createStore };
