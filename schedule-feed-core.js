// Pure helpers behind the tasks Schedule only watches: jobs another scheduler
// runs (a Hermes cron on another machine, say) that leave dated reports behind.
// A report may carry numbered suggestions the user answers 做 / 不做.
// What a watched task is, how its report is cut up, which suggestions are still
// open and what 队长 is told about a decision. No DOM, no Node: runs in the
// page, in the main process and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScheduleFeedCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const FEED_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
  const ITEM_ID_RE = /^[A-Z][A-Z0-9]{0,11}-\d{1,8}$/;
  const SSH_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,119}$/;   // an alias or user@host, never an option
  const DECISIONS = ['accepted', 'rejected'];
  const MAX_REASON = 300;

  const clean = (value, max) => String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  function expandHome(value, home) {
    const p = String(value == null ? '' : value).trim();
    return home && /^~(?=$|[\\/])/.test(p) ? home + p.slice(1) : p;
  }
  function validZone(zone) {
    if (!zone) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch (_) { return false; }
  }

  // One watched task, as its JSON file describes it. `platforms.<platform>`
  // overrides the top level, so one synced file serves both machines.
  function normalizeFeed(raw, platform, home) {
    if (!isObj(raw)) return null;
    const own = isObj(raw.platforms) && isObj(raw.platforms[platform]) ? raw.platforms[platform] : {};
    const f = { ...raw, ...own };
    const id = String(f.id || '');
    const name = clean(f.name, 80);
    const src = isObj(f.source) ? f.source : {};
    const root = expandHome(clean(src.root, 1000), home);
    const ssh = clean(src.ssh, 120);
    if (!FEED_ID_RE.test(id) || !name || !root || (ssh && !SSH_HOST_RE.test(ssh))) return null;
    const time = isObj(f.when) && /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(f.when.time || '')) ? String(f.when.time).padStart(5, '0') : '';
    const zone = isObj(f.when) && validZone(f.when.timeZone) ? String(f.when.timeZone) : '';
    const job = isObj(f.job) && clean(f.job.file, 1000) && /^[A-Za-z0-9_-]{1,80}$/.test(String(f.job.id || ''))
      ? { file: expandHome(clean(f.job.file, 1000), home), id: String(f.job.id) } : null;
    const decide = Array.isArray(f.decide) && f.decide.length && f.decide.length <= 40 &&
      f.decide.every((a) => typeof a === 'string' && a && a.length <= 1000)
      ? f.decide.map((a) => expandHome(a, home)) : null;
    return {
      id, name,
      label: clean(f.label, 12) || name.slice(0, 12),   // 「雷达审核：…」
      about: clean(f.about, 400),
      runner: clean(f.runner, 60),
      when: time ? { time, timeZone: zone } : null,
      source: { root, ssh },
      mirror: expandHome(clean(f.mirror, 1000), home),
      job, decide,
    };
  }

  // ---- when it runs ----
  function zoneParts(ts, zone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ts));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
  }
  // The instant a wall-clock time happens in a zone.
  function zonedTime(y, m, d, h, min, zone) {
    const wall = Date.UTC(y, m - 1, d, h, min);
    let ts = wall;
    for (let i = 0; i < 2; i++) {
      const p = zoneParts(ts, zone);
      ts -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - wall;
    }
    return ts;
  }
  // First daily run strictly after `now`; no zone means this machine's clock.
  function nextRun(when, now) {
    if (!when || !when.time) return null;
    const [h, min] = when.time.split(':').map(Number);
    if (!when.timeZone) {
      const n = new Date(now);
      const today = new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, min).getTime();
      return today > now ? today : new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, h, min).getTime();
    }
    const p = zoneParts(now, when.timeZone);
    for (let add = 0; add <= 2; add++) {
      const ts = zonedTime(p.y, p.m, p.d + add, h, min, when.timeZone);
      if (ts > now) return ts;
    }
    return null;
  }
  function whenLabel(when, localZone) {
    if (!when) return '';
    const here = localZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!when.timeZone || when.timeZone === here) return '每天 ' + when.time;
    return `每天 ${when.time}（${when.timeZone.split('/').pop().replace(/_/g, ' ')} 时间）`;
  }

  // ---- the scheduler's own record of the job (Hermes cron/jobs.json) ----
  function pickJob(doc, id) {
    const jobs = Array.isArray(doc) ? doc : isObj(doc) && Array.isArray(doc.jobs) ? doc.jobs : [];
    return jobs.find((j) => isObj(j) && j.id === id) || null;
  }
  function jobStatus(job) {
    if (!isObj(job)) return null;
    const time = (v) => { const n = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(n) ? n : null; };
    return {
      lastRunAt: time(job.last_run_at),
      nextRunAt: time(job.next_run_at),
      lastStatus: job.last_status === 'ok' ? 'ok' : job.last_status ? 'error' : '',
      lastError: clean(job.last_error || job.last_delivery_error, 300),
      enabled: job.enabled !== false && !job.paused_at && job.state !== 'paused',
    };
  }
  // What the page shows. A next run read from an old copy has passed: count on from now.
  function runStatus(feed, job, now) {
    const s = jobStatus(job) || { lastRunAt: null, nextRunAt: null, lastStatus: '', lastError: '', enabled: true };
    const next = s.nextRunAt && s.nextRunAt > now ? s.nextRunAt : nextRun(feed.when, now);
    return { ...s, nextRunAt: s.enabled ? next : null };
  }

  // ---- a report ----
  // md: the report as written. json: its structured twin, when there is one
  // ({ recommendations: [{ id, title, change, benefit, effort, stance, reason, project_url }], projects }).
  // The suggestions come out as items; the rest stays Markdown: the lead
  // paragraphs (the suggestions sit right under them), the named sections, and
  // whatever long list followed the lead.
  function parseReport(md, json) {
    const lines = String(md || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    const out = { title: '', lead: '', itemsHeading: '', items: [], rest: '', detail: '' };
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    const h1 = /^#\s+(.*)$/.exec(lines[i] || '');
    if (h1) { out.title = h1[1].trim(); i++; }
    const sections = [{ heading: '', lines: [] }];
    for (; i < lines.length; i++) {
      const h2 = /^##\s+(.*)$/.exec(lines[i]);
      if (h2) sections.push({ heading: h2[1].trim(), lines: [] });
      else sections[sections.length - 1].lines.push(lines[i]);
    }
    const itemStart = (line) => /^###\s+([A-Z][A-Z0-9]{0,11}-\d{1,8})\s*[·:：-]?\s*(.*)$/.exec(line);
    const intro = sections[0].lines;
    let cut = 0;
    while (cut < intro.length && !/^\s*([-*+]|\d+[.)])\s/.test(intro[cut]) && !/^\s*\|/.test(intro[cut]) && !/^#{1,6}\s/.test(intro[cut])) cut++;
    out.lead = intro.slice(0, cut).join('\n').trim();
    out.detail = intro.slice(cut).join('\n').trim();   // the long list under the lead: shown last
    const rest = [];
    for (const sec of sections.slice(1)) {
      if (!out.items.length && sec.lines.some((l) => itemStart(l))) {
        out.itemsHeading = sec.heading;
        let item = null;
        for (const line of sec.lines) {
          const m = itemStart(line);
          if (m) { item = { id: m[1], title: m[2].trim(), body: [] }; out.items.push(item); }
          else if (item) item.body.push(line);
        }
        continue;
      }
      rest.push('## ' + sec.heading + '\n\n' + sec.lines.join('\n').trim());
    }
    out.rest = rest.filter((s) => s.trim()).join('\n\n');

    const recs = isObj(json) && Array.isArray(json.recommendations) ? json.recommendations.filter((r) => isObj(r) && ITEM_ID_RE.test(String(r.id || ''))) : [];
    const projects = isObj(json) && Array.isArray(json.projects) ? json.projects.filter(isObj) : [];
    const known = new Map(out.items.map((it) => [it.id, it]));
    for (const r of recs) {
      if (!known.has(r.id)) { const it = { id: r.id, title: '', body: [] }; out.items.push(it); known.set(r.id, it); }
    }
    out.items = out.items.map((it) => {
      const body = it.body.join('\n').trim();
      const r = recs.find((x) => x.id === it.id) || {};
      const link = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/.exec(body);
      const url = clean(r.project_url, 500) || (link ? link[2] : '');
      const project = projects.find((p) => p.url === r.project_url || p.normalized_url === r.project_url);
      const text = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 2000);
      return {
        id: it.id,
        title: it.title || text(r.title),
        source: /^https?:\/\//i.test(url) ? { name: clean((project && project.name) || (link && link[1]) || url.replace(/^https?:\/\/(www\.)?/, ''), 80), url } : null,
        change: text(r.change), benefit: text(r.benefit), effort: text(r.effort), stance: text(r.stance), reason: text(r.reason),
        body,
      };
    });
    return out;
  }

  // ---- decisions ----
  // doc: the task's decisions.json ({ decisions: [{ id, decision, reason, at }] }).
  // journal: what was decided on this machine ([{ itemId, decision, reason, at, synced }]),
  // some of it not written to the task's own file yet. The latest word on an item wins.
  function decisionMap(doc, journal) {
    const map = new Map();
    const put = (id, d) => { const prev = map.get(id); if (!prev || d.at >= prev.at) map.set(id, d); };
    for (const d of isObj(doc) && Array.isArray(doc.decisions) ? doc.decisions : []) {
      if (!isObj(d) || !ITEM_ID_RE.test(String(d.id || '')) || !DECISIONS.includes(d.decision)) continue;
      const at = typeof d.at === 'string' ? Date.parse(d.at) : Number(d.at);
      put(d.id, { decision: d.decision, reason: clean(d.reason, MAX_REASON), at: Number.isFinite(at) ? at : 0, synced: true });
    }
    for (const e of Array.isArray(journal) ? journal : []) {
      if (!isObj(e) || !ITEM_ID_RE.test(String(e.itemId || '')) || !DECISIONS.includes(e.decision)) continue;
      put(e.itemId, { decision: e.decision, reason: clean(e.reason, MAX_REASON), at: Number(e.at) || 0, synced: !!e.synced });
    }
    return map;
  }
  const openCount = (items, map) => (Array.isArray(items) ? items : []).filter((it) => !map.has(it.id)).length;

  // The line 队长 gets. A decision is a direction on record, never an order to start work.
  function captainMessage(feed, entry) {
    const verb = entry.decision === 'accepted' ? '做' : '不做';
    const head = `${feed.label}审核：${entry.previous && entry.previous !== entry.decision ? '改为' : ''}${verb} ${entry.itemId}` +
      (entry.title ? `「${entry.title}」` : '') + (entry.reason ? `，理由：${entry.reason}` : '，没写理由') + '。';
    const where = entry.synced
      ? `这个决定已经写进「${feed.name}」的决定文件。`
      : `「${feed.name}」的正本现在连不上，决定先记在这台电脑上，连上后 AgentDeck 会自动写进去，不用你补记。`;
    return `${head}（用户在 Schedule 里点的${entry.date ? '，' + entry.date + ' 期' : ''}。${where}这只是登记方向：不要因此自动开卡或开工，等用户另外发话。）`;
  }

  return {
    DATE_RE, FEED_ID_RE, ITEM_ID_RE, DECISIONS, MAX_REASON,
    clean, expandHome, normalizeFeed, nextRun, whenLabel, pickJob, jobStatus, runStatus,
    parseReport, decisionMap, openCount, captainMessage,
  };
});
