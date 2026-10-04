// Pure helpers behind the 当前版本进度 panel: which version is being worked
// toward and which task cards belong to it. A card belongs to a version when
// its optional `version` field equals it, or its title or detail mentions it
// ("1.1.3 发版", "…。1.1.3"). The version is the smallest one mentioned on an
// active AgentDeck card that is newer than the running app; with nothing
// newer it is the app's own version. No DOM, no Electron: runs in the page and tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VersionProgressCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROJECT = 'agentdeck';
  // 1.1.3 but not 1.1.30, 1.1.3.4 or 21.1.3; a trailing sentence period is fine.
  const VERSION_RE = /(?<![\d.])v?(\d+\.\d+\.\d+)(?!\.?\d)/gi;
  const STATUS_LABEL = { todo: '待办', doing: '进行中', review: '待验收', needs_user: '等你', done: '完成' };

  function parse(v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/i.exec(String(v || '').trim());
    return m ? m.slice(1).map(Number) : null;
  }
  function compare(a, b) {
    const x = parse(a), y = parse(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  }
  function versionsIn(text) {
    return [...String(text || '').matchAll(VERSION_RE)].map((m) => m[1]);
  }
  function versionsOf(card) {
    const own = parse(card.version) ? [parse(card.version).join('.')] : [];
    return [...new Set([...own, ...versionsIn(card.title), ...versionsIn(card.detail)])];
  }
  const ownCards = (cards) => (cards || []).filter((c) => String(c.project || '').toLowerCase() === PROJECT);

  function targetVersion(cards, appVersion) {
    const active = ownCards(cards).filter((c) => !c.archived);
    const all = [...new Set(active.flatMap(versionsOf))].sort(compare);
    if (parse(appVersion)) return all.find((v) => compare(v, appVersion) > 0) || parse(appVersion).join('.');
    // No app version: the oldest version that still has unfinished work.
    return all.find((v) => active.some((c) => c.status !== 'done' && versionsOf(c).includes(v))) || all[all.length - 1] || null;
  }

  function progress(cards, appVersion) {
    const version = targetVersion(cards, appVersion);
    const items = !version ? [] : ownCards(cards)
      .filter((c) => (!c.archived || c.status === 'done') && versionsOf(c).includes(version))
      .map((c) => ({ id: c.id, title: c.title, status: c.status, flag: c.flag || null, done: c.status === 'done',
        label: c.flag === 'failed' ? '失败' : c.flag === 'held' ? '挂起' : STATUS_LABEL[c.status] || c.status }));
    const done = items.filter((i) => i.done).length;
    return { version, items, done, total: items.length, percent: items.length ? Math.round(done * 100 / items.length) : 0 };
  }

  return { PROJECT, parse, compare, versionsIn, versionsOf, targetVersion, progress };
});
