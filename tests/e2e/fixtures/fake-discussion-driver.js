'use strict';

// This module is used only by the discussion runner's isolated test profile.
// No provider executable, webpage or network connection is opened.
const fs = require('fs');
const path = require('path');

function answer(job, scenario) {
  const summary = job.phase === 'summary';
  const disagreement = scenario === 'disagree' && job.phase === 'review';
  const text = summary
    ? '建议先验证约束再选择方案。共识是先用证据核实，少数派认为高风险时应分阶段实施；适用条件是影响范围尚不明确。忠实性核对：各方主张均保留，措辞未改变结论。'
    : `这是第 ${job.round} 轮完整回答。建议先验证约束，再依据证据决定；重要假设是没有额外限制。最强反对意见是信息不足，新增反例会让我改口。`;
  return { text, complete: true, actualModel: scenario === 'mismatch' ? 'weaker-model' : job.participant.model,
    actualTier: job.participant.tier, actualEffort: job.participant.provider === 'chatgpt-web' ? 'Pro' : (job.participant.effort || 'high'),
    materialDisagreement: disagreement, faithful: summary,
    summary: summary ? '先验证约束。证据不足时不要立即全量实施。保留高风险时分阶段实施的少数派条件。' : '',
    disagreements: summary ? ['影响范围未知时，立即实施还是分阶段实施。'] : disagreement ? ['风险约束尚未核实，需要第三轮讨论其验证条件。'] : [],
    minority: summary ? ['高风险时分阶段实施。'] : [], receiptId: 'fake-' + job.attemptId };
}
function cachedFile(profile, job) { return path.join(profile, 'fake-result-' + job.attemptId + '.json'); }

function createParticipants() {
  return {
    async recover(job) {
      const file = cachedFile(process.env.AGENTDECK_DISCUSS_TEST_PROFILE, job);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    },
    async execute(job, { runDir, signal }) {
      const profile = process.env.AGENTDECK_DISCUSS_TEST_PROFILE;
      const controlFile = path.join(profile, 'fake-discussion-controls.json');
      const controls = fs.existsSync(controlFile) ? JSON.parse(fs.readFileSync(controlFile, 'utf8')) : {};
      const scenario = controls[job.participantId] || 'normal';
      const log = path.join(profile, 'fake-discussion-events.jsonl');
      fs.appendFileSync(log, JSON.stringify({ event: 'execute', jobId: job.id, participantId: job.participantId,
        phase: job.phase, round: job.round, attemptId: job.attemptId, input: job.input, runDir }) + '\n');
      if (scenario === 'recover-in-flight') fs.writeFileSync(cachedFile(profile, job), JSON.stringify(answer(job, 'normal')));
      if (scenario === 'hold' || scenario === 'recover-in-flight') await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (fs.existsSync(path.join(profile, 'release-' + job.participantId))) {
            clearInterval(timer); signal?.removeEventListener('abort', aborted); resolve();
          }
        }, 30);
        function aborted() { clearInterval(timer); reject(new Error('Cancelled fake participant.')); }
        if (signal?.aborted) aborted();
        else signal?.addEventListener('abort', aborted, { once: true });
      });
      if (scenario === 'timeout') {
        const error = new Error('TIMEOUT: fake participant timed out after sending.');
        error.code = 'TIMEOUT';
        error.mayHaveSent = true;
        error.uncertain = true;
        throw error;
      }
      if (scenario === 'quota') {
        const error = new Error('Subscription quota exhausted.');
        error.code = 'QUOTA_EXHAUSTED';
        error.mayHaveSent = false;
        error.quota = true;
        throw error;
      }
      return answer(job, scenario);
    },
  };
}

module.exports = { createParticipants };
