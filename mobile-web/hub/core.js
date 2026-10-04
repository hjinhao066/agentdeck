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

  return { TIMEOUT, STATES, machineList, classify, pollInterval, sendBlock, sendFailure, ago, metaOf, cleanMeta, mergeCards, ownerLabel };
});
