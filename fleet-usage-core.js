// Token 用量 across the two machines (the chart's Mac | Windows switch). Each
// AgentDeck sends the hub a small summary of its own scan: tokens and official-
// price dollars per local day and model, the last KEEP_DAYS days only, never a
// log line, path, seat or account. It travels as one 队长记录 per machine
// (sessionId USAGE_SESSION) so the hub needs no upgrade: the record holds a
// single turn whose only field is `task`, which every hub since 2.0.4 updates
// in place (turnExtends treats a changed `task` as the same turn moving on), so
// a new summary replaces the old one and never piles up as a kept copy.
// No DOM, no fs: runs in the page, in the main process and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FleetUsageCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const USAGE_SESSION = 'agentdeck-token-usage';
  const VERSION = 1;
  // The chart shows 7 or 30 days; one more covers a machine whose day starts earlier.
  const KEEP_DAYS = 31;
  // Each day keeps its biggest models one by one; the rest of a source fold into one row.
  const MAX_MODELS = 20;
  const MORE = '其他模型';
  // The whole summary, as JSON. Over this, the oldest days go first.
  const MAX_BYTES = 64 * 1024;
  const KEY_MAX = 100;
  // The first build that uploads its usage: an older machine is told apart from one
  // whose upload has not arrived yet.
  const FIRST_VERSION = '2.0.7';
  // The label an older client shows if it lists this record among its 队长记录, and
  // a time that sorts it after every real one there.
  const LABEL = 'Token 用量汇总（两机同步的数据，不是对话）';
  const EPOCH = '1970-01-01T00:00:00.000Z';
  const PLATFORMS = [{ key: 'darwin', label: 'Mac' }, { key: 'win32', label: 'Windows' }];

  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const KEY = /^[a-z0-9_-]{1,32}:[^\u0000-\u001f]{1,100}$/;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const count = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const dollars = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v * 1e6) / 1e6 : 0);
  const sum = (v) => v[0] + v[1] + v[2] + v[3];

  function addDays(day, n) {
    const [y, m, d] = day.split('-').map(Number);
    const t = new Date(y, m - 1, d + n, 12);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  }
  const bucketsOf = (v, cents) => (Array.isArray(v) && v.length === 4 ? v.map(cents ? dollars : count) : null);

  // One day: tokens [input, output, cacheRead, cacheWrite] and dollars (null: no
  // official price) per `source:model`. The biggest MAX_MODELS by tokens stay; the
  // others of each source become `<source>:其他模型`.
  function foldDay(tokens, costs) {
    const rows = [];
    for (const [key, v] of Object.entries(isObject(tokens) ? tokens : {})) {
      const t = bucketsOf(v, false);
      if (!t || !sum(t) || !KEY.test(key) || key.length > KEY_MAX) continue;
      const c = isObject(costs) && own(costs, key) ? costs[key] : null;
      rows.push({ key, t, c: c === null ? null : bucketsOf(c, true) });
    }
    rows.sort((a, b) => sum(b.t) - sum(a.t) || (a.key < b.key ? -1 : 1));
    const days = {}, money = {};
    for (const r of rows.slice(0, MAX_MODELS)) { days[r.key] = r.t; money[r.key] = r.c; }
    for (const r of rows.slice(MAX_MODELS)) {
      const key = r.key.slice(0, r.key.indexOf(':')) + ':' + MORE;
      const t = days[key] || (days[key] = [0, 0, 0, 0]);
      for (let i = 0; i < 4; i++) t[i] += r.t[i];
      // a fold with any priced model is priced; one with none says 无官方价
      if (r.c) {
        const c = money[key] || (money[key] = [0, 0, 0, 0]);
        for (let i = 0; i < 4; i++) c[i] = dollars(c[i] + r.c[i]);
      } else if (!own(money, key)) money[key] = null;
    }
    return { days, money };
  }

  // The summary a machine sends, from its own scan (token-usage-scan.js). Only the
  // last KEEP_DAYS days up to the scan's today, within MAX_BYTES.
  function summarize(scan, { keepDays = KEEP_DAYS, maxBytes = MAX_BYTES } = {}) {
    if (!scan || !DAY.test(scan.today || '')) return null;
    const from = addDays(scan.today, -(keepDays - 1));
    const days = {}, costs = {};
    for (const day of Object.keys(isObject(scan.days) ? scan.days : {}).sort()) {
      if (!DAY.test(day) || day < from || day > scan.today) continue;
      const f = foldDay(scan.days[day], isObject(scan.costs) ? scan.costs[day] : null);
      if (!Object.keys(f.days).length) continue;
      days[day] = f.days; costs[day] = f.money;
    }
    const out = {
      v: VERSION, today: scan.today,
      generatedAt: Number.isFinite(scan.generatedAt) ? Math.round(scan.generatedAt) : 0,
      pricesChecked: typeof scan.pricesChecked === 'string' ? scan.pricesChecked.slice(0, 20) : '',
      days, costs,
    };
    for (const day of Object.keys(days).sort()) {
      if (byteSize(out) <= maxBytes) break;
      delete days[day]; delete costs[day];
    }
    return out;
  }
  function byteSize(value) {
    const text = JSON.stringify(value);
    return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : Buffer.byteLength(text);
  }

  // A summary read back from the hub (another machine wrote it): every shape and
  // limit checked again; null when it is not one.
  function clean(input) {
    if (!isObject(input) || input.v !== VERSION || !DAY.test(input.today || '')) return null;
    return summarize({ today: input.today, generatedAt: input.generatedAt, pricesChecked: input.pricesChecked, days: input.days, costs: input.costs });
  }
  // The record's single turn, and the summary out of a record.
  const turnsOf = (summary) => [{ task: summary }];
  const taskOf = (record) => {
    const turn = record && Array.isArray(record.turns) && record.turns.length === 1 ? record.turns[0] : null;
    return turn && isObject(turn) ? turn.task : null;
  };
  const fromRecord = (record) => clean(taskOf(record));
  // A summary in a format newer than this build reads (a later AgentDeck on the other
  // machine): its version, else 0. The page says to update this machine, never "wait".
  function newerOf(record) {
    const task = taskOf(record);
    return isObject(task) && Number.isInteger(task.v) && task.v > VERSION && task.v < 1000 ? task.v : 0;
  }

  // '2.0.10' >= '2.0.7'; an unreadable version is not.
  function versionAtLeast(version, min = FIRST_VERSION) {
    const a = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
    if (!a) return false;
    const b = min.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (Number(a[i + 1]) !== b[i]) return Number(a[i + 1]) > b[i];
    return true;
  }
  const platformLabel = (p) => (PLATFORMS.find((x) => x.key === p) || { label: p }).label;

  // What the chart shows for `platform`: this machine's own scan, or the other
  // machine's summary, or why there is none. `fleet` is the sync client's usage
  // state: { configured, selfId, error, lastSyncAt, devices, usage: { deviceId: { summary, updatedAt } } }.
  // A usage entry may instead be { newer: v }: the other machine sends a format this build cannot read.
  // state: self | ok | newer | unconfigured | connecting | error | missing | old | waiting | offline
  function machine({ platform, selfPlatform, fleet }) {
    const label = platformLabel(platform);
    if (platform === selfPlatform) return { state: 'self', platform, label };
    const f = fleet || {};
    if (!f.configured) return { state: 'unconfigured', platform, label, title: `这台电脑没开两机同步，看不到 ${label} 的用量`, detail: '两机同步配置好以后，两台电脑会互相传每天的用量汇总' };
    const usage = isObject(f.usage) ? f.usage : {};
    const devices = (Array.isArray(f.devices) ? f.devices : []).filter((d) => d && d.platform === platform && d.id !== f.selfId);
    const known = new Map(devices.map((d) => [d.id, d]));
    // the machine whose summary is newest; without one, the one seen last
    const withData = Object.entries(usage)
      .map(([id, u]) => ({ id, u, device: known.get(id) }))
      .filter((x) => x.device && x.u && x.u.summary)
      .sort((a, b) => (b.u.summary.generatedAt || 0) - (a.u.summary.generatedAt || 0));
    const seen = (d) => Date.parse(d.lastSeenAt || '') || 0;
    // a machine sending a newer format, seen at least as late as the newest one with numbers
    const newer = Object.entries(usage)
      .map(([id, u]) => ({ id, u, device: known.get(id) }))
      .filter((x) => x.device && x.u && Number.isInteger(x.u.newer) && x.u.newer > VERSION)
      .sort((a, b) => seen(b.device) - seen(a.device))[0];
    const showNewer = !!newer && (!withData.length || seen(newer.device) >= seen(withData[0].device));
    const device = showNewer ? newer.device : withData.length ? withData[0].device : devices.slice().sort((a, b) => seen(b) - seen(a))[0] || null;
    const base = { platform, label, device: device ? { name: device.name, version: device.version || '', online: !!device.online, lastSeenAt: device.lastSeenAt || null } : null };
    const syncError = f.error ? String(f.error) : '';
    if (showNewer) {
      const v = device.version ? ` ${device.version}` : '';
      return { ...base, state: 'newer', title: '那台的 AgentDeck 比本机新，本机升级后才能看', detail: `${label} 上的 AgentDeck${v} 传来的用量是新格式（第 ${newer.u.newer} 版），这台只认得第 ${VERSION} 版；把这台升级到最新版就能看到` };
    }
    if (withData.length) {
      const u = withData[0].u;
      return { ...base, state: 'ok', summary: u.summary, updatedAt: u.updatedAt || null, stale: !device.online, syncError };
    }
    if (syncError) return { ...base, state: 'error', title: `同步出了问题，还没收到 ${label} 的用量`, detail: syncError };
    if (!f.lastSyncAt && !devices.length) return { ...base, state: 'connecting', title: '正在连接两机同步…', detail: `连上以后会显示 ${label} 的用量` };
    if (!device) return { ...base, state: 'missing', title: `两机同步里还没有 ${label}`, detail: `${label} 上的 AgentDeck 配好两机同步、开着以后，这里会显示它的用量` };
    const v = device.version ? ` ${device.version}` : '';
    if (!versionAtLeast(device.version)) return { ...base, state: 'old', title: `${label} 上的 AgentDeck${v} 还不会上传用量`, detail: `${label} 装上 ${FIRST_VERSION} 或更新的版本后，开着 AgentDeck 几分钟内就会传上来` };
    if (!device.online) return { ...base, state: 'offline', title: `${label} 离线，还没有收到过它的用量`, detail: `${label} 开着 AgentDeck 并连上两机同步后会自动上传` };
    return { ...base, state: 'waiting', title: `${label} 还没传上用量`, detail: '它开着 AgentDeck，几分钟内会传上来' };
  }

  // What the page does with a machine (token-usage-ui.js applies it):
  // the notice in the chart's place when there are no numbers, keyed by what it says so the
  // status region is rebuilt (and read out) only when that changes; its icon; what is said
  // on a switch (nothing for a notice: the status region reads it, once); and whether the
  // 数据来源 row shows (it lists this machine's logs, so only for this machine).
  const ICONS = { offline: 'clock', waiting: 'clock', connecting: 'clock', unconfigured: 'unlinked' };
  function notice(m) {
    if (!m || m.state === 'self' || m.state === 'ok') return null;
    return { key: JSON.stringify([m.state, m.title, m.detail]), state: m.state, icon: ICONS[m.state] || 'alert', title: m.title, detail: m.detail };
  }
  function announcement(m) {
    if (!m) return '';
    if (m.state === 'self') return `${m.label}（本机）的用量`;
    return m.state === 'ok' ? `${m.label} 的用量` : '';
  }
  const showsSources = (m) => !m || m.state === 'self';

  return {
    USAGE_SESSION, VERSION, KEEP_DAYS, MAX_MODELS, MAX_BYTES, MORE, FIRST_VERSION, LABEL, EPOCH, PLATFORMS,
    summarize, clean, turnsOf, fromRecord, newerOf, byteSize, versionAtLeast, platformLabel, machine, notice, announcement, showsSources,
  };
});
