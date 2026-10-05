'use strict';
// Main-process half of the tasks Schedule only watches (see schedule-feed-core.js).
// Each task is one JSON file in ~/.agents/schedules. Its data is a folder in the
// feed layout: reports/YYYY-MM-DD.md (+ .json) and decisions.json.
// - The folder is read where it lives: on this disk, or on a Windows machine over
//   ssh. A copy of what was read is kept under userData, so when that machine is
//   off the page still has the last report and says how old it is. A read-only
//   mirror folder, if the task names one, is the other fallback.
// - A decision is written to this machine's journal first and only then handed
//   to the task's own `decide` command, which is retried until it goes through.
//   Nothing here ever writes into the task's folder or its mirror directly.
// Every answer is plain JSON, so a phone page can be served from the same calls.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const Core = require('./schedule-feed-core');

const MAX_FEEDS = 20;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_REPORTS = 60;            // reports looked at for open suggestions
const PULL_NEW = 10;               // missing reports fetched per pull
const PULL_TIMEOUT = 30_000;
const DECIDE_TIMEOUT = 100_000;
const LIVE_FOR = 60_000;           // a pull this fresh is not repeated
const RETRY_PULL = 30_000;         // a failed pull is not repeated sooner, unless asked for
const RETRY_EVERY = 5 * 60_000;
const RETRY_ALONE = 12;            // after this many failures only a visit retries
const KEEP_JOURNAL = 200;
const REL_RE = /^(?:reports\/\d{4}-\d{2}-\d{2}\.(?:md|json)|decisions\.json|@job)$/;

function readText(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size <= MAX_FILE ? fs.readFileSync(file, 'utf8') : null;
  } catch (_) { return null; }
}
function readJson(file) {
  const text = readText(file);
  if (text == null) return null;
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (_) { return null; }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function mtime(file) { try { return fs.statSync(file).mtimeMs; } catch (_) { return 0; } }
// Report dates in a folder, oldest first; null when the folder itself is not there.
function storeDates(dir) {
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch (_) { return null; }
  let names;
  try { names = fs.readdirSync(path.join(dir, 'reports')); } catch (_) { return []; }
  return names.map((n) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(n)).filter(Boolean).map((m) => m[1]).sort();
}

function defaultRun(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 48 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? String(error.message || error) : '' });
    });
  });
}

const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
// One round trip: the report dates, the reports this machine lacks (and always
// the newest), decisions.json and the scheduler's job file. Everything comes
// back base64, so no code page on the way can touch the text.
function pullScript(feed, have, want) {
  const dates = (list) => '@(' + list.filter((d) => Core.DATE_RE.test(d)).map(psQuote).join(',') + ')';
  return [
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'",
    `$root=${psQuote(feed.source.root)}`,
    'function B($s){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))}',
    "function F($rel,$p){ if(Test-Path -LiteralPath $p -PathType Leaf){ 'F '+(B $rel)+' '+[Convert]::ToBase64String([IO.File]::ReadAllBytes($p)) } }",
    "if(-not (Test-Path -LiteralPath $root -PathType Container)){ 'E root'; exit 3 }",
    "$dir=Join-Path $root 'reports'",
    "$names=@(); if(Test-Path -LiteralPath $dir -PathType Container){ $names=@(Get-ChildItem -LiteralPath $dir -Filter '*.md' -File | Sort-Object Name | ForEach-Object { $_.BaseName }) }",
    "'D '+(B ($names -join ','))",
    `$have=${dates(have)}; $want=${dates(want)}`,
    `$get=@($names | Where-Object { $have -notcontains $_ } | Select-Object -Last ${PULL_NEW})`,
    'if($names.Count){ $get+=$names[-1] }',
    '$get+=@($want | Where-Object { $names -contains $_ })',
    "$get | Select-Object -Unique | ForEach-Object { F ('reports/'+$_+'.md') (Join-Path $dir ($_+'.md')); F ('reports/'+$_+'.json') (Join-Path $dir ($_+'.json')) }",
    "F 'decisions.json' (Join-Path $root 'decisions.json')",
    feed.job ? `F '@job' ${psQuote(feed.job.file)}` : '',
    "'OK'",
  ].filter(Boolean).join('\n');
}
function parsePull(stdout) {
  const out = { dates: null, files: new Map(), complete: false };
  const text = (b64) => Buffer.from(b64 || '', 'base64').toString('utf8');
  for (const line of String(stdout).split(/\r?\n/)) {
    const [kind, a, b] = line.trim().split(' ');
    if (kind === 'D') out.dates = text(a).split(',').filter((d) => Core.DATE_RE.test(d)).sort();
    else if (kind === 'F' && REL_RE.test(text(a))) out.files.set(text(a), text(b));
    else if (kind === 'OK') out.complete = true;
  }
  return out;
}

function createScheduleFeeds(options) {
  const { dir, home, userData } = options;
  const platform = options.platform || process.platform;
  const run = options.run || defaultRun;
  const now = options.now || Date.now;
  const env = options.env || process.env;
  const cacheRoot = path.join(userData, 'schedule-feeds');
  const cacheOf = (id) => path.join(cacheRoot, id);
  const pulls = new Map();       // feed id -> pull in flight
  const pulledAt = new Map();    // feed id -> when the last pull came back good
  const failedAt = new Map();    // feed id -> when the last pull failed (cleared by a good one)
  const flushes = new Map();     // feed id -> journal sync in flight
  const parsed = new Map();      // report file -> { stamp, value }
  let timer = null;

  function feeds() {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')).sort(); } catch (_) { return []; }
    const seen = new Set();
    const out = [];
    for (const name of names) {
      const feed = Core.normalizeFeed(readJson(path.join(dir, name)), platform, home);
      if (!feed || seen.has(feed.id) || out.length >= MAX_FEEDS) continue;
      seen.add(feed.id);
      out.push(feed);
    }
    return out;
  }
  const find = (id) => (typeof id === 'string' && Core.FEED_ID_RE.test(id) ? feeds().find((f) => f.id === id) || null : null);

  // ---- this machine's journal of decisions ----
  const journalFile = (id) => path.join(cacheOf(id), 'journal.json');
  function loadJournal(id) {
    const j = readJson(journalFile(id));
    const entries = j && Array.isArray(j.entries) ? j.entries.filter((e) => e && Core.ITEM_ID_RE.test(String(e.itemId || '')) && Core.DECISIONS.includes(e.decision)) : [];
    return { seq: Number.isSafeInteger(j && j.seq) ? j.seq : entries.reduce((n, e) => Math.max(n, Number(e.seq) || 0), 0), entries, error: (j && typeof j.error === 'string' && j.error) || '', attempts: Number(j && j.attempts) || 0 };
  }
  function saveJournal(id, journal) {
    // what is waiting to be written or told is never dropped to make room
    const open = journal.entries.filter((e) => !e.synced || !e.notified);
    const closed = journal.entries.filter((e) => e.synced && e.notified).slice(-KEEP_JOURNAL);
    journal.entries = [...closed, ...open].sort((a, b) => a.seq - b.seq);
    writeAtomic(journalFile(id), JSON.stringify(journal, null, 1));
  }

  // ---- reading a folder in the feed layout ----
  function reportOf(store, date) {
    const md = path.join(store, 'reports', date + '.md');
    const stamp = mtime(md) + ':' + mtime(path.join(store, 'reports', date + '.json'));
    const hit = parsed.get(md);
    if (hit && hit.stamp === stamp) return hit.value;
    const text = readText(md);
    const value = text == null ? null : Core.parseReport(text, readJson(path.join(store, 'reports', date + '.json')));
    parsed.set(md, { stamp, value });
    return value;
  }
  // kind: live (the task's own folder, or a copy pulled just now), cache (an older copy), mirror.
  function view(feed, store, kind, asOf, want) {
    const journal = loadJournal(feed.id);
    const dates = store ? storeDates(store.dir) || [] : [];
    const decisions = Core.decisionMap(store ? readJson(path.join(store.dir, 'decisions.json')) : null, journal.entries);
    const open = {};
    let openTotal = 0;
    for (const date of dates.slice(-MAX_REPORTS)) {
      const r = reportOf(store.dir, date);
      const n = r ? Core.openCount(r.items, decisions) : 0;
      if (n) { open[date] = n; openTotal += n; }
    }
    const job = !store ? null : store.job !== undefined ? store.job : readJson(path.join(store.dir, 'job.json'));
    const date = want && dates.includes(want) ? want : dates[dates.length - 1] || '';
    const report = date ? reportOf(store.dir, date) : null;
    const unsynced = journal.entries.filter((e) => !e.synced);
    return {
      ok: true,
      id: feed.id, name: feed.name, label: feed.label, about: feed.about, runner: feed.runner,
      when: Core.whenLabel(feed.when), canDecide: !!feed.decide,
      status: Core.runStatus(feed, job, now()),
      source: kind, offline: kind !== 'live', asOf: asOf || 0,
      dates, open, openCount: feed.decide ? openTotal : 0,
      unsynced: unsynced.length, syncError: unsynced.length ? journal.error : '',
      // decisions 队长 has not been told about yet, oldest first
      notes: journal.entries.filter((e) => !e.notified).map((e) => ({ seq: e.seq, itemId: e.itemId, decision: e.decision, reason: e.reason, at: e.at, synced: !!e.synced, title: e.title || '', date: e.date || '', previous: e.previous || '' })),
      missing: want && !dates.includes(want) ? want : '',
      report: report ? {
        date, title: report.title, lead: report.lead, itemsHeading: report.itemsHeading, rest: report.rest, detail: report.detail,
        items: report.items.map((it) => ({ ...it, decided: decisions.get(it.id) || null })),
      } : null,
    };
  }

  // The newest copy this machine holds while the task's own folder is out of reach.
  function fallback(feed) {
    const cache = cacheOf(feed.id);
    const meta = readJson(path.join(cache, 'meta.json'));
    const cached = meta ? storeDates(cache) : null;
    const mirrored = feed.mirror ? storeDates(feed.mirror) : null;
    const last = (list) => (list && list.length ? list[list.length - 1] : '');
    if (cached && (!mirrored || last(cached) >= last(mirrored))) return { store: { dir: cache }, kind: 'cache', asOf: Number(meta.fetchedAt) || 0 };
    if (mirrored) {
      const newest = last(mirrored);
      const asOf = Math.max(newest ? mtime(path.join(feed.mirror, 'reports', newest + '.md')) : 0, mtime(path.join(feed.mirror, 'decisions.json')));
      return { store: { dir: feed.mirror, job: null }, kind: 'mirror', asOf };
    }
    return { store: null, kind: 'none', asOf: 0 };
  }

  function pull(feed, want) {
    const key = feed.id + '\u0000' + (want || '');
    if (pulls.has(key)) return pulls.get(key);
    const cache = cacheOf(feed.id);
    const job = (async () => {
      const script = pullScript(feed, storeDates(cache) || [], want ? [want] : []);
      const r = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', feed.source.ssh,
        'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: PULL_TIMEOUT, env });
      const got = parsePull(r.stdout);
      if (!r.ok || !got.complete || !got.dates) { failedAt.set(feed.id, now()); return false; }
      for (const [rel, text] of got.files) {
        if (rel === '@job') {
          let doc = null;
          try { doc = JSON.parse(text.replace(/^﻿/, '')); } catch (_) {}
          writeAtomic(path.join(cache, 'job.json'), JSON.stringify(feed.job ? Core.pickJob(doc, feed.job.id) : null));
        } else writeAtomic(path.join(cache, ...rel.split('/')), text);
      }
      writeAtomic(path.join(cache, 'meta.json'), JSON.stringify({ fetchedAt: now(), dates: got.dates }));
      pulledAt.set(feed.id, now());
      failedAt.delete(feed.id);
      return true;
    })().catch(() => { failedAt.set(feed.id, now()); return false; }).finally(() => pulls.delete(key));
    pulls.set(key, job);
    return job;
  }

  // fresh: ask the task's own folder now (a remote one can take seconds).
  // Without it the answer is whatever this machine already holds, at once.
  async function load(feed, { date, fresh, force } = {}) {
    const want = typeof date === 'string' && Core.DATE_RE.test(date) ? date : '';
    if (!feed.source.ssh) {
      if (storeDates(feed.source.root)) {
        const job = feed.job ? Core.pickJob(readJson(feed.job.file), feed.job.id) : null;
        return view(feed, { dir: feed.source.root, job }, 'live', now(), want);
      }
      const fb = fallback(feed);
      return view(feed, fb.store, fb.kind, fb.asOf, want);
    }
    const cache = cacheOf(feed.id);
    const held = () => (storeDates(cache) || []).includes(want);
    if (fresh) {
      const recent = !force && now() - (pulledAt.get(feed.id) || 0) < LIVE_FOR && (!want || held());
      // a machine that did not answer a moment ago is not asked again on every glance
      const down = !force && failedAt.has(feed.id) && now() - failedAt.get(feed.id) < RETRY_PULL;
      if (recent || (!down && await pull(feed, want && !held() ? want : ''))) return view(feed, { dir: cache }, 'live', pulledAt.get(feed.id), want);
      const fb = fallback(feed);
      return view(feed, fb.store, fb.kind, fb.asOf, want);
    }
    // not asked yet: reachable unless the last try said otherwise
    const fb = fallback(feed);
    return { ...view(feed, fb.store, fb.kind, fb.asOf, want), offline: failedAt.has(feed.id), checking: true };
  }

  // ---- handing journal entries to the task's own decide command ----
  // One write at a time per task. A request that arrives during one gets a
  // run of its own afterwards, so it never rides on an attempt that started
  // before its decision existed.
  function flush(feed, visit) {
    const running = flushes.get(feed.id);
    if (running) {
      if (!running.next) running.next = running.then(() => flush(feed, visit));
      return running.next;
    }
    const job = (async () => {
      let journal = loadJournal(feed.id);
      if (!feed.decide || (!visit && journal.attempts >= RETRY_ALONE)) return;
      for (const entry of journal.entries.filter((e) => !e.synced)) {
        const fill = (arg) => arg.split('{id}').join(entry.itemId).split('{decision}').join(entry.decision).split('{reason}').join(entry.reason || '');
        const [file, ...args] = feed.decide.map(fill);
        const r = await run(file, args, { timeout: DECIDE_TIMEOUT, env });
        journal = loadJournal(feed.id);   // a decision may have been added meanwhile
        const mine = journal.entries.find((e) => e.seq === entry.seq);
        if (!mine) continue;
        if (!r.ok) {
          journal.error = Core.clean(r.stderr.split('\n').filter((l) => l.trim()).pop() || r.error, 200) || '没能写入';
          journal.attempts += 1;
          saveJournal(feed.id, journal);
          return;   // keep the order: later decisions wait behind this one
        }
        mine.synced = true; mine.syncedAt = now();
        journal.error = ''; journal.attempts = 0;
        saveJournal(feed.id, journal);
        pulledAt.delete(feed.id);   // the next visit re-reads decisions.json
      }
    })().catch(() => {}).finally(() => flushes.delete(feed.id));
    flushes.set(feed.id, job);
    return job;
  }
  const hasUnsynced = (feed) => loadJournal(feed.id).entries.some((e) => !e.synced);
  function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => {
      const waiting = feeds().filter((f) => f.decide && hasUnsynced(f));
      if (!waiting.length) { clearInterval(timer); timer = null; return; }
      waiting.forEach((f) => flush(f, false));
    }, options.retryEvery || RETRY_EVERY);
    if (timer.unref) timer.unref();
  }

  // ---- what the page (or a phone) calls ----
  async function list(input) {
    const fresh = !!(input && input.fresh);
    const out = [];
    for (const feed of feeds()) {
      if (feed.decide && hasUnsynced(feed)) { if (fresh) flush(feed, true); ensureTimer(); }
      const { report, ...summary } = await load(feed, { fresh });
      out.push({ ...summary, latest: report ? report.date : '' });
    }
    return { ok: true, feeds: out };
  }
  async function detail(id, input) {
    const feed = find(id);
    if (!feed) return { ok: false, error: '没有这个任务' };
    const o = input && typeof input === 'object' ? input : {};
    if (o.fresh && feed.decide && hasUnsynced(feed)) { flush(feed, true); ensureTimer(); }
    return load(feed, { date: o.date, fresh: !!o.fresh, force: !!o.force });
  }
  // Recorded on this machine before anything else, so it cannot be lost; the
  // write to the task's own file follows in the background.
  async function decide(id, input) {
    const feed = find(id);
    const o = input && typeof input === 'object' ? input : {};
    if (!feed) return { ok: false, error: '没有这个任务' };
    if (!feed.decide) return { ok: false, error: '这个任务不收审核决定' };
    if (typeof o.itemId !== 'string' || !Core.ITEM_ID_RE.test(o.itemId) || !Core.DECISIONS.includes(o.decision)) return { ok: false, error: '无效的决定' };
    const held = await load(feed, { date: o.date });
    const item = held.report && held.report.items.find((it) => it.id === o.itemId);
    if (!item) return { ok: false, error: '在这一期里找不到这条建议' };
    const journal = loadJournal(feed.id);
    const entry = {
      seq: journal.seq + 1, itemId: item.id, decision: o.decision, reason: Core.clean(o.reason, Core.MAX_REASON), at: now(),
      synced: false, notified: false, title: Core.clean(item.title, 120), date: held.report.date,
      previous: item.decided ? item.decided.decision : '',
    };
    journal.seq = entry.seq;
    journal.attempts = 0;
    journal.entries.push(entry);
    try { saveJournal(feed.id, journal); } catch (error) { return { ok: false, error: '没能把决定记到这台电脑上：' + error.message }; }
    flush(feed, true);
    ensureTimer();
    return { ok: true, entry };
  }
  // Tries the waiting writes (after the one in flight, if any) and says what is left.
  async function settle(id) {
    const feed = find(id);
    if (!feed) return { ok: false, error: '没有这个任务' };
    await flush(feed, true);
    const journal = loadJournal(feed.id);
    return { ok: true, unsynced: journal.entries.filter((e) => !e.synced).length, syncError: journal.error };
  }
  function notified(id, seqs) {
    const feed = find(id);
    if (!feed || !Array.isArray(seqs)) return { ok: false };
    const journal = loadJournal(feed.id);
    const told = new Set(seqs.filter(Number.isSafeInteger));
    journal.entries.forEach((e) => { if (told.has(e.seq)) e.notified = true; });
    try { saveJournal(feed.id, journal); } catch (_) { return { ok: false }; }
    return { ok: true };
  }
  function dispose() { if (timer) clearInterval(timer); timer = null; }

  return { feeds, list, detail, decide, settle, notified, dispose };
}

function registerScheduleFeedIpc({ handleMain, ...options }) {
  const feeds = createScheduleFeeds(options);
  const safe = (work) => Promise.resolve().then(work).catch((error) => ({ ok: false, error: String(error && error.message || error) }));
  handleMain('schedule-feed:list', (_e, msg) => safe(() => feeds.list(msg)));
  handleMain('schedule-feed:detail', (_e, msg) => safe(() => feeds.detail(msg && msg.id, msg)));
  handleMain('schedule-feed:decide', (_e, msg) => safe(() => feeds.decide(msg && msg.id, msg)));
  handleMain('schedule-feed:settle', (_e, msg) => safe(() => feeds.settle(msg && msg.id)));
  handleMain('schedule-feed:notified', (_e, msg) => safe(() => feeds.notified(msg && msg.id, msg && msg.seqs)));
  return feeds;
}

module.exports = { createScheduleFeeds, registerScheduleFeedIpc, pullScript, parsePull, storeDates };
