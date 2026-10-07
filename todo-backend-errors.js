'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// Local retry metadata only. Do not log exception messages: filesystem and
// provider errors can contain the user's Todo, private paths or credentials.
class TodoBackendErrors {
  constructor({ file, log, deliver }) {
    this.file = file; this.log = log; this.deliver = deliver;
    this.state = { active: {}, pending: {} };
    try {
      if (fs.existsSync(file)) this.state = JSON.parse(fs.readFileSync(file, 'utf8'));
      const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
      if (!record(this.state.active) || !record(this.state.pending) ||
          Object.values(this.state.active).some((id) => typeof id !== 'string' || !/^todo-error-[a-f0-9]{64}$/.test(id)) ||
          Object.entries(this.state.pending).some(([id, item]) => !/^todo-error-[a-f0-9]{64}$/.test(id) ||
            !record(item) || item.id !== id || item.action !== 'main-todo-error' || item.nativeWeb !== true || typeof item.result !== 'string')) throw new Error('Invalid backend error queue.');
    } catch (error) {
      this.state = { active: {}, pending: {} };
      this.report('error-queue-read', error);
    }
  }
  persist() {
    const tmp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.log('Todo backend error queue write failed; code=' + this.code(error));
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
      catch (error) { this.log('Todo backend error queue cleanup failed; code=' + this.code(error)); }
    }
  }
  code(error) { return /^[A-Z0-9_]{1,50}$/.test(error?.code || '') ? error.code : 'ERROR'; }
  report(stage, error) {
    const code = this.code(error);
    this.log(`Todo backend ${stage} failed; code=${code}`);
    if (!this.state.active[stage]) {
      const id = 'todo-error-' + crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
      this.state.active[stage] = id;
      this.state.pending[id] = { id, action: 'main-todo-error', nativeWeb: true,
        result: `Todo 后台异常（${stage}，${code}）：本次操作未成功，已保留待办供重试。请检查本机 agentdeck-notify.log；不要把未投递当作已接手。` };
      this.persist();
    }
    this.flush();
  }
  run(stage, work) {
    try {
      const result = work();
      if (this.state.active[stage]) { delete this.state.active[stage]; this.persist(); }
      return result;
    } catch (error) { this.report(stage, error); }
  }
  flush() {
    for (const command of Object.values(this.state.pending)) {
      try { this.deliver(command); }
      catch (error) { this.log('Todo backend exception receipt delivery failed; code=' + this.code(error)); }
    }
  }
  acknowledge(id) {
    if (!this.state.pending[id]) return;
    delete this.state.pending[id]; this.persist();
  }
}
module.exports = { TodoBackendErrors };
