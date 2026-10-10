'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATUSES = ['queued', 'working', 'needs_user', 'done', 'failed'];
const CARD = /^todo-[a-f0-9]{64}$/;
// A change to a 待办 (edit, tick, delete) reaches 队长 only while it is this recent.
const CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRANSITIONS = {
  queued: ['working', 'needs_user', 'done', 'failed'],
  working: ['needs_user', 'done', 'failed'],
  needs_user: ['working', 'done', 'failed'],
  done: [], failed: ['working', 'needs_user', 'done'],
};
// Literal opt-in, including Chinese full-width input. No intent classifier.
function isAi(text) {
  if (typeof text !== 'string') return false;
  for (const match of text.matchAll(/[@＠]\s*ai(?!_)(?=$|\s|\p{P}|\p{Script=Han})/giu)) {
    const before = text.slice(0, match.index), after = text.slice(match.index + match[0].length);
    // An ASCII mailbox/local-part or handle is not a mention. Chinese can
    // surround the marker without spaces, even before versions or URLs.
    if (/[A-Za-z0-9._%+@＠-]$/.test(before)) continue;
    // Also exclude ASCII mailboxes ending in quoted/local-part punctuation.
    if (/^[\p{L}\p{N}-]*\.[\p{L}\p{N}-]/u.test(after) && /[A-Za-z0-9][!#$&'*\/=?^`{|}~"]*$/.test(before)) continue;
    return true;
  }
  return false;
}
function revision(item) {
  return crypto.createHash('sha256').update(JSON.stringify([item.id, item.text, item.textUpdated || item.created])).digest('hex');
}
function taskId(item) { return 'todo-' + revision(item); }
function taskDetail(item, id) {
  return `来自 Todo 随手记的新任务。项目：todo；待办 id：${item.id}；任务卡 id：${id}。\n待办内容：${item.text}\n\n` +
    '由 AgentDeck 队长照常派活。办完的标准是拿到实物，不是写一份说明：搜资料要把资料本身搜全并保存，再附总结；找电子书要把 PDF/EPUB 文件本身找到并落盘。\n' +
    '缺用户才有的信息或材料（如病历、CT 报告）时：等用户提供，不要自己猜、不要瞎编。回填 needs_user（等你提供），说明具体缺什么；不得把缺材料当作已完成。\n' +
    '隐私：病历、CT、证件、财务等材料只在本机处理和存放，不得上传到任何在线服务（包括在线模型、网页工具或云盘）。待办原文的同步存储方式保持原样。\n' +
    '手机提醒默认一律不发，等材料和办完都不响铃；没办成/出错由 Todo 后端通过现有 notify-user 提醒一次，队长不要重复提醒。\n' +
    `队长回填（使用自己的控制终端）：node "$AGENTDECK_BOARD_CLI" todo status --id ${item.id} --task-id ${id} --status working\n` +
    '等你提供用 --status needs_user --message "缺什么材料"；办完用 --status done --files "绝对产物路径1,路径2"；没办成用 --status failed --message "原因"。不要直接改 todos/*.json。\n' +
    '回填后 AgentDeck 自动把结果登记到用户的「待我处理」（等你提供/没办成在「要你处理」，办完在「做完了你还没看」，附产物文件），不要再用 inbox 重复登记；用户在那里的回复会作为回执带着这张卡片 id 交给你。';
}

// What `todo list` gives 队长: only the 待办 handed to AI (an @ai mention) or that
// already carry an AI state. The user's other to-dos stay theirs: 队长 never reads them.
function forCaptain(items) {
  return (Array.isArray(items) ? items : []).filter((t) => t && (isAi(t.text) || (t.ai && typeof t.ai === 'object')));
}

class TodoAI {
  // hasCaptain: whether this computer has a 队长 to hand a 待办 to. Without one the
  // item says so (on both computers and the phone) and waits; nothing hands it to the
  // other computer's 队长. A 队长 starting here scans again and hands it over.
  // report: hands 队长 a change to a 待办 it was given (see reportChanges); false when
  // there is no 队长 to take it now (it is tried again on the next scan).
  constructor({ todos, tasks, deliver, notify, changed = () => {}, hasCaptain = () => true, platform = process.platform, report = null, now = () => Date.now() }) {
    this.todos = todos; this.tasks = tasks; this.deliver = deliver; this.notify = notify; this.changed = changed;
    this.hasCaptain = hasCaptain; this.platform = platform; this.report = report; this.now = now;
    this.reported = new Set();
  }
  // The computer that handed a 待办 to its 队长 tells that 队长 when the user edits it, or
  // ticks it off or deletes it before AI finished it. Each change goes once (by id; 队长's
  // side keeps the ids too, so a restart does not repeat one), and only for a change of the
  // last day: an old one found after an upgrade would only be noise. A notice 队长 has not
  // read yet is taken back there instead of being followed by a change (MainSession).
  reportChanges() {
    if (typeof this.report !== 'function') return;
    const me = this.todos.deviceId, now = this.now();
    const recent = (at) => typeof at === 'string' && now - Date.parse(at) < CHANGE_WINDOW_MS;
    for (const t of this.todos.all()) {
      const was = t.aiBefore;
      if (!t.deleted && was && was.ownerDevice === me && was.deliveredAt && CARD.test(was.taskId || '') && recent(was.editedAt)) {
        const again = was.status !== 'done' && isAi(t.text) && !t.done;
        const result = was.status === 'done'
          ? `用户改了一条你已经办完的待办：原来是「${was.text}」，现在是「${t.text}」。办完的待办改字后不会重新交给你，任务卡 ${was.taskId} 不用再动。`
          : `用户改了一条交给你的待办：原来是「${was.text}」，现在是「${t.text}」。任务卡 ${was.taskId} 不用再按原来的办了；` +
            (again ? '改后的内容会作为一条新的 Todo 任务交给你。' : '改后的内容不再交给 AI。');
        this.sendChange('edit', was.taskId, result);
      }
      const ai = t.ai;
      if (!ai || ai.ownerDevice !== me || !ai.deliveredAt || ai.status === 'done' || !CARD.test(ai.taskId || '')) continue;
      if (t.deleted && recent(t.deletedUpdated)) {
        this.sendChange('stop', ai.taskId, `用户删掉了这条交给你的待办：「${t.text || ai.taskId}」。任务卡 ${ai.taskId} 不用再办了。`);
      } else if (!t.deleted && t.done && recent(t.doneUpdated)) {
        this.sendChange('stop', ai.taskId, `用户自己勾掉了这条交给你的待办：「${t.text}」。任务卡 ${ai.taskId} 不用再办了；「待我处理」里它的那条也已关掉。`);
      }
    }
  }
  sendChange(kind, cardId, result) {
    const id = 'todo-change-' + crypto.createHash('sha256').update(kind + ':' + cardId).digest('hex');
    if (this.reported.has(id)) return;
    if (this.report({ id, kind, taskId: cardId, result }) === false) return;
    this.reported.add(id);
  }
  // A change 队长's side refused (it is tried again on the next scan).
  forgetChange(id) { this.reported.delete(id); }
  scan() {
    if (this.todos.readFiles().some((file) => file.own && !file.doc)) throw Object.assign(new Error('Todo store is damaged.'), { code: 'TODO_STORE_CORRUPT' });
    this.reportChanges();
    // One content revision has one writing device. Other computers display its
    // synced AI state but never wake a second Captain, even while Git is offline.
    for (const item of this.todos.list()) {
      if (item.done || item.awaitingOrigin === true || !isAi(item.text)) continue;
      const owner = item.textDevice || item.device;
      if (owner && owner !== this.todos.deviceId) continue;
      const rev = revision(item), id = taskId(item);
      // a 待办 AI had finished is not handed over again when its text is edited
      if (item.ai?.revision !== rev && item.aiBefore?.status === 'done') continue;
      let current = item;
      if (item.ai?.revision !== rev) current = this.todos.writeAi(item.id, () => ({
        revision: rev, taskId: id, ownerDevice: this.todos.deviceId, ownerPlatform: this.platform, status: 'queued',
        submittedAt: this.todos.stamp(), updated: this.todos.stamp(), deliveredAt: null,
        files: [], message: '', exceptionNotifiedAt: null,
      }));
      const ai = current.ai;
      if (ai.ownerDevice !== this.todos.deviceId) continue;
      let card = this.tasks.list({ archived: true }).find((c) => c.id === id);
      if (!card) {
        card = this.tasks.add({ id, project: 'todo', title: item.text, detail: taskDetail(item, id) }).card;
        this.changed();
      }
      if (ai.deliveredAt) continue;
      const here = this.hasCaptain();
      if (!here !== (ai.noCaptain === true)) {
        current = this.todos.writeAi(item.id, (t) => {
          if (t.ai?.revision !== rev) throw new Error('Todo delivery version changed.');
          const { noCaptain, ...rest } = t.ai;
          return { ...rest, ...(here ? {} : { noCaptain: true }), updated: this.todos.stamp(t.ai.updated) };
        });
        this.changed();
      }
      if (here) this.deliver({ item: current, card });
    }
  }
  acknowledge(id, cardId) {
    const item = this.todos.list().find((t) => t.id === id);
    if (!item || item.ai?.taskId !== cardId || item.ai.revision !== revision(item) || item.ai.deliveredAt) return;
    this.todos.writeAi(id, (t) => {
      if (t.ai?.taskId !== cardId || t.ai.revision !== revision(t)) throw new Error('Todo delivery version changed.');
      const at = this.todos.stamp(t.ai.updated);
      const { noCaptain, ...rest } = t.ai;
      return { ...rest, deliveredAt: at, updated: at };
    });
    this.changed();
  }
  async status({ id, taskId: cardId, status, message = '', files = [] }) {
    if (!STATUSES.includes(status) || status === 'queued') throw new Error('Invalid AI status.');
    if (typeof message !== 'string' || message.length > 4000) throw new Error('Invalid AI message.');
    if (!Array.isArray(files) || files.length > 50 || files.some((file) => typeof file !== 'string' || file.length > 4096 || !path.isAbsolute(file))) throw new Error('产物必须是本机绝对路径。');
    if (status === 'done' && (!files.length || files.some((file) => !fs.existsSync(file) || !fs.statSync(file).isFile()))) throw new Error('办完必须附已经落盘的产物文件。');
    if (['needs_user', 'failed'].includes(status) && !message.trim()) throw new Error('请说明缺什么材料或没办成的原因。');
    const item = this.todos.list().find((t) => t.id === id);
    if (!item || !isAi(item.text) || item.ai?.taskId !== cardId || item.ai.revision !== revision(item)) throw new Error('待办已编辑或任务版本过期，请重新读取 todo list。');
    if (item.ai.ownerDevice !== this.todos.deviceId) throw new Error('请在这条待办的投递设备上回填。');
    if (item.ai.status !== status && !TRANSITIONS[item.ai.status]?.includes(status)) throw new Error('Invalid AI status transition.');
    // notify durably enqueues, it does not ring the phone here. Only mark a
    // failure once that enqueue succeeds, so a repaired queue can retry it.
    const shouldNotify = status === 'failed' && !item.ai.exceptionNotifiedAt;
    const at = this.todos.stamp(item.updated);
    try { this.tasks.todoStatus({ id: cardId, status, message: message.trim() }); }
    catch (error) { error.code ||= 'TODO_BOARD_WRITE'; throw error; }
    const next = this.todos.writeAi(id, (t) => {
      if (t.ai?.taskId !== cardId || t.ai.revision !== revision(t)) throw new Error('待办已编辑或任务版本过期，请重新读取 todo list。');
      // `round` counts entries into a state: failed → working → failed again is a
      // new round (待我处理 files it again); a same-state retry is not.
      const round = (Number.isSafeInteger(t.ai.round) ? t.ai.round : 0) + (t.ai.status === status ? 0 : 1);
      return { ...t.ai, status, round, message: message.trim(), files: status === 'done' ? [...new Set(files)] : [], updated: at,
        exceptionNotifiedAt: t.ai.exceptionNotifiedAt };
    });
    this.changed();
    if (shouldNotify) {
      await this.notify({ id: 'todo-error-' + item.ai.revision, message: 'Todo AI 任务没办成或出错，请在 AgentDeck 查看详情。', urgent: true });
      const marked = this.todos.writeAi(id, (t) => {
        if (t.ai?.taskId !== cardId || t.ai.revision !== revision(t)) throw new Error('待办已编辑或任务版本过期，请重新读取 todo list。');
        const notifiedAt = this.todos.stamp(t.ai.updated);
        return { ...t.ai, updated: notifiedAt, exceptionNotifiedAt: notifiedAt };
      });
      this.changed(); return marked;
    }
    return next;
  }
}
module.exports = { TodoAI, isAi, forCaptain, revision, taskId, taskDetail, STATUSES, TRANSITIONS };
