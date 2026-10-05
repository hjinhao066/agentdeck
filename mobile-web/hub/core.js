'use strict';

// Pure rules for the phone hub. Loaded by the page as window.HubCore and by
// node unit tests; nothing here touches the DOM, the network or storage.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HubCore = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const TIMEOUT = 8000;
  const STATES = {
    unknown: { label: '连接中', short: '连接中', tone: 'off' },
    online: { label: '在线', short: '在线', tone: 'ok' },
    login: { label: '需要登录', short: '需登录', tone: 'warn' },
    offline: { label: '离线', short: '离线', tone: 'off' },
    unresponsive: { label: '无响应（可能在睡眠）', short: '无响应', tone: 'warn' },
    upgrade: { label: '需要升级 AgentDeck', short: '需升级', tone: 'warn' },
    error: { label: '连接异常', short: '异常', tone: 'bad' },
  };

  function machineList(value) {
    const list = value && Array.isArray(value.machines) ? value.machines : [];
    const seen = new Set();
    const machines = list.filter((m) => m && /^[a-z0-9]{1,16}$/.test(m.id) && m.basePath === `/${m.id}/` && typeof m.label === 'string' && m.label.trim() && !seen.has(m.id) && seen.add(m.id))
      .map((m) => ({ id: m.id, label: m.label.trim().slice(0, 24), basePath: m.basePath, platform: typeof m.platform === 'string' ? m.platform : '', default: m.default === true }));
    return machines;
  }

  // result: { status, body, retryAfter } | { timedOut: true } | { failed: true }
  function classify(result) {
    if (!result || result.failed) return { state: 'error', detail: '手机连不上入口，请检查手机网络。' };
    if (result.timedOut) return { state: 'unresponsive' };
    const { status, body } = result;
    if (status === 200) {
      if (body && body.apiVersion >= 2 && body.machine && Array.isArray(body.sessions)) return { state: 'online' };
      if (body && typeof body === 'object') return { state: 'upgrade' };
      return { state: 'error', detail: '入口返回了看不懂的内容。' };
    }
    if (status === 401) return { state: 'login' };
    if (status === 429) return { state: 'login', retryAfter: result.retryAfter > 0 ? result.retryAfter : 900 };
    if (status === 404) return { state: 'upgrade' };
    if (status === 502 && body && body.offline === true) return { state: 'offline' };
    return { state: 'error', detail: `入口返回了 HTTP ${status}。` };
  }

  // Unauthenticated capability probe (GET api/info), asked before the snapshot.
  // Old builds answer 401 to every prefixed path (or 404 once logged in), so a
  // 401 here means "upgrade", never "log in". Returns { current: true } for a
  // build that has the snapshot API, otherwise the machine state to show.
  function classifyInfo(result) {
    if (!result || result.failed || result.timedOut) return classify(result);
    const { status, body } = result;
    if (status === 200) {
      if (body && body.app === 'agentdeck' && body.apiVersion >= 2 && Array.isArray(body.capabilities) && body.capabilities.includes('snapshot')) return { current: true };
      if (body && typeof body === 'object') return { state: 'upgrade' };
      return { state: 'error', detail: '入口返回了看不懂的内容。' };
    }
    if (status === 401 || status === 404) return { state: 'upgrade' };
    return classify(result);
  }

  // Selected machines refresh fastest; anything that is not answering backs off.
  function pollInterval(state, selected) {
    if (state === 'online') return selected ? 5000 : 15000;
    if (state === 'login' || state === 'unknown') return 15000;
    return 30000;
  }

  // Why a message cannot be sent to this machine right now ('' when it can).
  // The hub never falls back to another machine, so every reason says so.
  function sendBlock(machine) {
    if (!machine) return '请先选择要发给哪台电脑。';
    const name = machine.label;
    const stay = '不会自动转给另一台电脑。';
    if (machine.state === 'offline') return `${name} 离线，现在发不出去，${stay}`;
    if (machine.state === 'unresponsive') return `${name} 无响应（可能在睡眠），现在发不出去，${stay}`;
    if (machine.state === 'login') return `${name} 还没登录，先到总览登录，${stay}`;
    if (machine.state === 'upgrade') return `${name} 的 AgentDeck 需要升级后才能派活，${stay}`;
    if (machine.state !== 'online') return `${name} 还没连上，现在发不出去，${stay}`;
    const captain = machine.snap && machine.snap.captain;
    if (!captain || !captain.id || captain.status === 'unavailable') return `${name} 的队长还没启动，先在那台电脑上创建队长，${stay}`;
    if (!machine.csrf) return `${name} 的安全校验还没就绪，刷新后再试。`;
    return '';
  }

  function sendFailure(result, name) {
    if (!result || result.failed) return '手机连不上入口，消息没有发出。';
    if (result.timedOut) return `没有收到 ${name} 的确认，消息可能已经排队，也可能没有。先看一眼 ${name} 队长的对话，再决定要不要重发。`;
    if (result.status === 502) return `${name} 离线，消息没有发出，也没有转给另一台电脑。`;
    if (result.status === 401) return `${name} 的登录已失效，消息没有发出。`;
    if (result.status === 403) return `${name} 的安全校验已过期，消息没有发出。刷新后再试。`;
    return `${name} 没有接收这条消息（HTTP ${result.status}）。`;
  }

  function ago(then, now) {
    if (!Number.isFinite(then) || then <= 0) return '';
    const minutes = Math.floor(Math.max(0, now - then) / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时前`;
    return `${Math.floor(minutes / 1440)} 天前`;
  }

  // The only per-machine data the phone may keep after the tab closes:
  // counts and coarse status, never titles, receipts, turns or output.
  function metaOf(snapshot, now) {
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const captain = snapshot.captain && snapshot.captain.id ? String(snapshot.captain.status || 'idle').slice(0, 16) : 'unavailable';
    return { lastOnline: now, sessionCount: sessions.length, workingCount: sessions.filter((s) => s && s.status === 'working').length,
      captainStatus: captain, hostname: String(snapshot.machine.hostname || '').slice(0, 64), appVersion: String(snapshot.machine.appVersion || '').slice(0, 16) };
  }
  function cleanMeta(value) {
    if (!value || typeof value !== 'object') return {};
    const count = (n) => Number.isInteger(n) && n >= 0 && n < 10000 ? n : 0;
    return { lastOnline: Number.isFinite(value.lastOnline) ? value.lastOnline : 0, sessionCount: count(value.sessionCount), workingCount: count(value.workingCount),
      captainStatus: /^[a-z_]{1,16}$/.test(value.captainStatus || '') ? value.captainStatus : 'unavailable',
      hostname: typeof value.hostname === 'string' ? value.hostname.slice(0, 64) : '', appVersion: typeof value.appVersion === 'string' ? value.appVersion.slice(0, 16) : '' };
  }

  // Both machines sync the same board through git, so the same card id can
  // arrive twice. Keep whichever copy was updated last.
  function mergeCards(sources) {
    const merged = new Map();
    for (const source of sources) for (const card of source.cards || []) {
      if (!card || typeof card.id !== 'string') continue;
      const key = `${card.project}\n${card.id}`;
      const kept = merged.get(key);
      if (!kept || (Date.parse(card.updated) || 0) > (Date.parse(kept.card.updated) || 0)) merged.set(key, { card, from: source.id });
    }
    return [...merged.values()].map(({ card, from }) => ({ ...card, seenOn: from }));
  }

  const host = (name) => String(name || '').trim().toLowerCase().replace(/\.(local|lan)$/, '');
  // dispatch_claim.owner is os.hostname() of the machine that claimed the card.
  function ownerLabel(card, machines) {
    const owner = card && card.dispatch_claim && card.dispatch_claim.owner;
    if (!owner) return '';
    const match = machines.find((m) => m.hostname && host(m.hostname) === host(owner));
    return match ? match.label : String(owner).slice(0, 40);
  }

  // ---- conversation --------------------------------------------------------
  // The desktop saves one "turn" per injected prompt: the user's message, every
  // dispatch card, every automatic receipt delivery. They are folded back into
  // what happened: the message, then one reply block from the Captain. Same
  // rules as the single-machine page, so both ends read the same.
  const SAME_ROUND_MS = 30 * 60 * 1000;
  function groupTurns(turns) {
    const groups = [];
    let group = null, last = 0;
    const open = (turn, user, images) => { group = { id: turn.id, user, images, replies: [], tasks: [], notices: 0, steps: [], pending: false, interrupted: false }; groups.push(group); };
    for (const turn of Array.isArray(turns) ? turns : []) {
      if (!turn || typeof turn !== 'object') continue;
      const isUser = !turn.kind && (typeof turn.user === 'string' && turn.user || Array.isArray(turn.images) && turn.images.length);
      if (isUser) open(turn, typeof turn.user === 'string' ? turn.user : '', Array.isArray(turn.images) ? turn.images.filter((id) => typeof id === 'string') : []);
      else if (!group || (turn.ts && last && turn.ts - last > SAME_ROUND_MS)) open(turn, '', []);
      if (turn.ts) last = turn.ts;
      if (turn.kind === 'task') { group.tasks.push(turn.task && typeof turn.task === 'object' ? turn.task : {}); continue; }
      if (turn.kind === 'notice') { group.notices += 1; if (turn.reply) group.steps.push(String(turn.reply)); continue; }
      if (turn.reply) group.replies.push(String(turn.reply));
      for (const step of Array.isArray(turn.steps) ? turn.steps : []) group.steps.push(String(step));
      group.pending = !turn.done && !turn.interrupted;
      group.interrupted = !!turn.interrupted;
    }
    return groups;
  }
  function processSummary(group) {
    const parts = [];
    if (group.tasks.length) parts.push(`派了 ${group.tasks.length} 件活`);
    const receipts = group.tasks.filter((task) => task.summary).length;
    if (receipts) parts.push(`收到 ${receipts} 份回执`);
    if (group.steps.length) parts.push(`${group.steps.length} 步操作`);
    return parts.length ? '过程：' + parts.join('，') : '';
  }

  // ---- quota ---------------------------------------------------------------
  // Display rows only; the machine already masked the account. Anything that
  // is not the expected shape is dropped so a odd answer never reads as usable.
  const QUOTA_STATUS = ['out', 'stale', 'normal', 'warning', 'danger', 'nodigits', 'expired', 'unknown'];
  function cleanQuota(data) {
    const text = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
    const time = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
    const rows = (data && Array.isArray(data.rows) ? data.rows : []).slice(0, 16).filter((row) => row && typeof row === 'object').map((row) => ({
      key: text(row.key, 60), provider: text(row.provider, 20), name: text(row.name, 100), short: text(row.short, 40), flag: text(row.flag, 8),
      captain: row.captain === true, status: QUOTA_STATUS.includes(row.status) ? row.status : 'unknown', failed: row.failed === true,
      cells: (Array.isArray(row.cells) ? row.cells : []).filter((cell) => cell && ['5h', '7d'].includes(cell.key) && Number.isFinite(cell.remaining)).slice(0, 2)
        .map((cell) => ({ key: cell.key, remaining: Math.max(0, Math.min(100, cell.remaining)), out: cell.out === true, resetAt: time(cell.resetAt) })),
      recoveryAt: time(row.recoveryAt), sampledAt: time(row.sampledAt), account: text(row.account, 80), source: text(row.source, 60),
    }));
    return { rows, version: /^\d+\.\d+\.\d+[\w.-]{0,20}$/.test(data && data.version || '') ? data.version : '' };
  }
  const pad = (value) => String(value).padStart(2, '0');
  const hm = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const monthDay = (t) => { const d = new Date(t); return pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const weekday = (t) => '周' + '日一二三四五六'[new Date(t).getDay()];
  // Same wording as the desktop rows: a clock inside 24 hours, then the weekday, then the date.
  function shortReset(t, now) { const gap = t - now; return gap <= 86400000 ? hm(t) : gap < 6 * 86400000 ? weekday(t) : monthDay(t); }
  function longReset(t, now) {
    const mins = Math.max(1, Math.round((t - now) / 60000));
    const left = mins < 60 ? mins + ' 分钟' : mins < 1440 ? Math.floor(mins / 60) + ' 小时' + (mins % 60 ? ' ' + mins % 60 + ' 分' : '') : Math.floor(mins / 1440) + ' 天';
    return (t - now <= 86400000 ? '' : monthDay(t) + ' ') + hm(t) + '（' + left + '后）';
  }
  function sampledText(row, now) { return row.sampledAt ? '采样 ' + (Math.abs(now - row.sampledAt) > 86400000 ? monthDay(row.sampledAt) + ' ' : '') + hm(row.sampledAt) : '暂无采样'; }
  // Old, missing or unreadable numbers are grey: they never read as usable.
  const dimmed = (row, failed) => !!failed || ['stale', 'expired', 'unknown', 'nodigits'].includes(row.status);
  const percentText = (cell) => cell.out ? '用尽' : cell.remaining < 1 ? '<1%' : Math.round(cell.remaining) + '%';
  const cellLevel = (row, cell, failed) => cell.out ? 'out' : dimmed(row, failed) ? 'none' : cell.remaining <= 10 ? 'danger' : cell.remaining <= 20 ? 'low' : 'ok';
  const windowName = (key) => key === '5h' ? '5 小时' : '每周';
  const emptyText = (row) => row.status === 'nodigits' ? '未见用尽' : '未知';
  // Always the two columns of the header. An account that only reported "used up" shows that under 5h.
  function quotaCells(row) {
    const blockedOnly = row.status === 'out' && !row.cells.length;
    return ['5h', '7d'].map((key) => row.cells.find((cell) => cell.key === key) || (blockedOnly && key === '5h' ? { key, out: true, resetAt: row.recoveryAt } : { key, missing: true }));
  }
  // The line under a row is kept for what the cells cannot say: the numbers are old or the last read failed.
  function quotaNote(row, now) {
    const parts = [];
    if (row.failed) parts.push('查询失败');
    if (row.status === 'stale' || row.status === 'expired') parts.push('数据已旧');
    return parts.length ? [...parts, sampledText(row, now)].join(' · ') : '';
  }
  function cellSpoken(cell, now) {
    return windowName(cell.key) + (cell.missing ? '未知' : (cell.out ? '已用尽' : '剩余 ' + percentText(cell)) + (cell.resetAt > now ? '，' + longReset(cell.resetAt, now) + (cell.out ? '恢复' : '重置') : ''));
  }
  function quotaLabel(row, now) {
    const windows = row.cells.length || row.status === 'out' ? quotaCells(row).filter((cell) => !cell.missing).map((cell) => cellSpoken(cell, now)) : [emptyText(row)];
    return [row.name + (row.captain ? '（队长在用）' : ''), ...windows, quotaNote(row, now)].filter(Boolean).join('；');
  }
  // The "state" line of the details: why the numbers may not be trusted.
  function quotaState(row, failed) {
    return [row.status === 'nodigits' ? '未见用尽报错，此来源不提供百分比' : row.status === 'unknown' ? '暂无额度数据，等待桌面端下次采样' : '',
      row.status === 'stale' || row.status === 'expired' ? '数据已旧，数字仅供参考' : '', row.failed ? '最近一次查询失败' : '', failed ? '手机暂时连不上这台电脑' : ''].filter(Boolean).join('；');
  }

  return { TIMEOUT, STATES, machineList, classify, classifyInfo, pollInterval, sendBlock, sendFailure, ago, metaOf, cleanMeta, mergeCards, ownerLabel,
    groupTurns, processSummary, cleanQuota, shortReset, longReset, sampledText, percentText, cellLevel, dimmed, windowName, emptyText, quotaCells, quotaNote, cellSpoken, quotaLabel, quotaState };
});
