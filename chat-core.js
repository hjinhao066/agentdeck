// Pure helpers behind the chat view: pulling the final reply out of a TUI
// screen, safe markdown/code rendering for the preview pane, and searching the
// saved prompts and replies. No DOM, no Electron: runs in the page and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Saved conversations keep every turn; the chat view renders a window of
  // them at a time and loads older ones on request.
  const RENDER_STEP = 150;
  const MAX_TEXT = 20000;

  // The global choice stays independent of per-column overrides.
  function normalizeViewMode(mode) { return mode === 'term' ? 'term' : 'chat'; }
  function toggleGlobalView(config, columns) {
    const mode = normalizeViewMode(config.globalViewMode) === 'chat' ? 'term' : 'chat';
    config.globalViewMode = mode;
    columns.forEach((col) => { col.view = mode; });
    return mode;
  }

  // ---- text helpers ----
  // Markdown, code colouring, file kinds and how broken lines join are the phone
  // hub's rules (mobile-web/hub/core.js, "Reading text"): one renderer for the
  // desktop and the phone. Looked up when called, so the load order of the two
  // files does not matter.
  const reading = () => (typeof module === 'object' && module.exports ? require('./mobile-web/hub/core.js') : globalThis.HubCore);
  const shared = (name) => (...args) => reading()[name](...args);
  const esc = shared('esc'), isWide = shared('isWide'), joinGap = shared('joinGap'), pipeTable = shared('pipeTable');
  const fileKind = shared('fileKind'), languageFor = shared('languageFor'), imageMime = shared('imageMime'), extOf = shared('extOf');
  const highlightCode = shared('highlightCode'), tidyReply = shared('tidyReply'), renderMarkdown = shared('renderMarkdown');
  function visibleWidth(s) {
    let w = 0;
    for (const ch of String(s)) w += isWide(ch) ? 2 : 1;
    return w;
  }
  const rtrim = (s) => s.replace(/\s+$/, '');
  // Old prompt recordings could treat xterm SGR mouse reports as typed text
  // after dropping ESC[. Only scrub runs of reports, so a quoted single
  // sequence in an actual prompt remains intact.
  const legacyMouseReport = /<\d{1,3};\d{1,5};\d{1,5}[Mm]/g;
  const legacyMouseRun = /(?:<\d{1,3};\d{1,5};\d{1,5}[Mm]){4,}/;
  function stripLegacyMouseReports(text) {
    if (!legacyMouseRun.test(text)) return text;
    // A PTY chunk could begin inside a mouse report, leaving its final two
    // coordinates before the repeated complete reports.
    return text.replace(legacyMouseReport, '').replace(/^\d{1,5};\d{1,5}[Mm]/, '');
  }

  // ---- pulling the final reply out of a terminal screen ----
  const BULLET = /^ {0,2}([⏺●•◆▪◦])\s+(.*)$/;
  const CHILD = /^\s*[⎿└├│]/;
  // Claude prints tools as "Bash(ls)"; Codex prints a few fixed verbs.
  const TOOL_HEAD = /^(?:[\w.:-]+\(|Explored\b|Edited \S+ \(\+|Added \S+ \(\+|Waited for\b|Working\()/;
  const FOOTER = /bypass permissions|shift\+tab|esc to (?:interrupt|cancel)|\? for shortcuts|for shortcuts|auto-accept|context left|ctrl\+[a-z] to|⏵⏵/i;
  const SPINNER = /^\s*[✻✽✢✶✳∴*·]\s+\S.*(?:…|\.\.\.|\bfor \d+[smh]|\(\d+s)/;

  function isChrome(line) {
    const t = line.trim();
    if (!t) return false;
    if (/^[\s─━═╌╍┄┈\-_=│┃╭╮╰╯┌┐└┘├┤┬┴┼]+$/.test(t)) return true;   // rules and empty boxes
    if (/^[│┃|]\s*[>❯›]\s*/.test(t)) return true;                    // the input box row
    if (/^[>❯›]\s*$/.test(t)) return true;
    if (t.length <= 140 && FOOTER.test(t)) return true;
    if (SPINNER.test(line) && t.length <= 140) return true;
    return false;
  }

  function promptGlyphs(s) { return s.replace(/^[\s│┃|>❯›$%#]+/, '').replace(/[\s│┃|]+$/, ''); }

  // Index of the last row of the echoed prompt, or -1 if it can't be found.
  function findPromptEcho(lines, userText) {
    const sent = String(userText).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const needle = (sent[0] || '').slice(0, 18);
    if (needle.length < 2) return -1;
    const flat = (l) => promptGlyphs(l).replace(/\s+/g, ' ');
    // the echo comes first: look at the first 12 lines that have text (blank
    // padding from redraws doesn't count), never deeper into the reply
    let seen = 0;
    for (let i = 0; i < lines.length && seen < 12; i++) {
      if (lines[i].trim()) seen++;
      if (!flat(lines[i]).includes(needle)) continue;
      let end = i;
      // the TUI wraps a long prompt onto indented continuation rows
      while (end + 1 < lines.length && end - i < 10 && /^ {2,}\S/.test(lines[end + 1]) && !BULLET.test(lines[end + 1])) end++;
      // a multi-line prompt echoes every line: run to the echo of its last one
      if (sent.length > 1) {
        const tail = sent[sent.length - 1].slice(0, 18);
        const limit = Math.min(lines.length, i + sent.length * 3 + 10);
        for (let j = i + 1; j < limit; j++) {
          if (BULLET.test(lines[j])) break;          // the reply has started
          if (tail.length >= 2 && flat(lines[j]).includes(tail)) end = Math.max(end, j);
        }
      }
      return end;
    }
    return -1;
  }

  function splitBlocks(lines) {
    const blocks = [];
    let cur = null;
    for (const line of lines) {
      if (!line.trim()) { if (cur) cur.lines.push(''); continue; }
      const m = BULLET.exec(line);
      if (m) {
        cur = { head: m[2], lines: [m[2]], tool: TOOL_HEAD.test(m[2]) };
        blocks.push(cur);
      } else if (cur && (/^\s{2,}/.test(line) || CHILD.test(line))) {
        if (CHILD.test(line)) cur.tool = true;
        cur.lines.push(line.replace(/^ {1,2}/, ''));
      } else {
        cur = { head: line, lines: [line], tool: false, loose: true };
        blocks.push(cur);
      }
    }
    return blocks;
  }

  const TABLE_ROW = /^\s*[|│]/;

  // Terminals hard-wrap long paragraphs; glue them back so the chat bubble can
  // wrap to its own width. Lists, headings, table rows and indented code stay as they are.
  function reflow(lines, cols) {
    const limit = Math.max(20, (cols || 80) * 0.7);
    const out = [];
    let prev = null;
    for (const line of lines) {
      if (!line.trim()) { out.push(''); prev = null; continue; }
      const special = /^\s*([-*•]|\d+[.)])\s+/.test(line) || /^#{1,6}\s/.test(line) || /^ {4,}\S/.test(line) || /^\s*(```|~~~)/.test(line) || TABLE_ROW.test(line);
      if (prev !== null && !special && !TABLE_ROW.test(prev) && visibleWidth(out[out.length - 1]) >= limit) {
        const last = out[out.length - 1];
        out[out.length - 1] = last + joinGap(last, line.trim()) + line.trim();
      } else {
        out.push(line);
      }
      prev = line;
    }
    return out;
  }

  // A table the TUI drew with box lines becomes a Markdown table while its row
  // rules can still be read: a cell wrapped over several rows is one cell again.
  // A table cut off by the screen edge is left as it is.
  const BOX_TOP = /^\s*┌[─┬]*┬[─┬]*┐\s*$/, BOX_MID = /^\s*├[─┼]+┤\s*$/, BOX_END = /^\s*└[─┴]+┘\s*$/, BOX_ROW = /^\s*│.*│\s*$/;
  function boxTables(lines) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!BOX_TOP.test(lines[i])) { out.push(lines[i]); continue; }
      const rows = [];
      let cur = null, j = i + 1, closed = false;
      for (; j < lines.length; j++) {
        if (BOX_ROW.test(lines[j])) {
          const cells = lines[j].trim().slice(1, -1).split('│').map((c) => c.trim());
          if (!cur) cur = cells.map(() => '');
          if (cells.length !== cur.length) break;
          cells.forEach((c, k) => { if (c) cur[k] += joinGap(cur[k], c) + c; });
        } else if (BOX_MID.test(lines[j]) || BOX_END.test(lines[j])) {
          if (cur) rows.push(cur);
          cur = null;
          if (BOX_END.test(lines[j])) { closed = true; break; }
        } else break;
      }
      if (!closed || !rows.length || rows.some((r) => r.length !== rows[0].length)) { out.push(lines[i]); continue; }
      out.push(...pipeTable(rows, /^\s*/.exec(lines[i])[0]));
      i = j;
    }
    return out;
  }

  // Agent TUIs draw their input box at the bottom (a rule, the prompt row, a
  // rule) with status lines under it: model, context, cost, limits. None of
  // that is the reply, so cut from the box's top rule down.
  const RULE = /^[╭╰┌└]?[─━]{6,}[╮╯┐┘]?$/;
  const PROMPT_ROW = /^[\s│┃|]*[>❯›](\s|$)/;
  function cutInputBox(lines) {
    // the screen below the box is usually blank rows; look near the last text
    let end = lines.length - 1;
    while (end >= 0 && !lines[end].trim()) end--;
    const floor = Math.max(0, end - 24);
    for (let i = end; i > floor; i--) {
      if (!RULE.test(lines[i].trim())) continue;
      for (let j = i - 1; j >= Math.max(floor, i - 10); j--) {
        if (!RULE.test(lines[j].trim())) continue;
        if (lines.slice(j + 1, i).some((l) => PROMPT_ROW.test(l))) return lines.slice(0, j);
        break;
      }
    }
    // TUIs without a ruled box (Codex, Grok…): a lone prompt row near the end
    // with only short status lines under it starts the input area
    for (let i = end; i >= Math.max(0, end - 6); i--) {
      if (!PROMPT_ROW.test(lines[i])) continue;
      const below = lines.slice(i + 1, end + 1).filter((l) => l.trim());
      // needs the agent's own footer under it, so a reply ending in "> quote" stays
      if (below.length && below.some(isChrome) && below.every((l) => isChrome(l) || l.trim().length <= 120)) return lines.slice(0, i);
      break;
    }
    return lines;
  }

  // The turn's own screen rows: after the echoed prompt, above the input box.
  function turnLines(screenLines, userText) {
    let lines = screenLines.map(rtrim);
    const echo = findPromptEcho(lines, userText);
    if (echo >= 0) lines = lines.slice(echo + 1);
    lines = boxTables(cutInputBox(lines));
    return lines.filter((l) => !isChrome(l));
  }
  function extractReply(screenLines, userText, cols) {
    let lines = turnLines(screenLines, userText);
    // a bare shell prompt left on the last row is not output
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length && /(?:@\S+.*|\S+)\s[%$#>]$/.test(lines[lines.length - 1].trim()) && lines[lines.length - 1].trim().length < 80) lines.pop();
    const hasBullets = lines.some((l) => BULLET.test(l));
    let kept;
    if (hasBullets) {
      const blocks = splitBlocks(lines);
      let lastTool = -1;
      blocks.forEach((b, i) => { if (b.tool) lastTool = i; });
      kept = [];
      blocks.slice(lastTool + 1).forEach((b) => { if (kept.length) kept.push(''); kept.push(...b.lines); });
    } else {
      kept = lines.slice(-80);
    }
    kept = reflow(kept, cols);
    const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  }

  // ---- the work before the final reply (tool calls, commands, notes) ----
  // Saved with the turn as `steps`: one short line each, newest kept.
  const MAX_STEPS = 40, MAX_STEP_BYTES = 8192, MAX_STEP_LINE = 300;
  const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, MAX_STEP_LINE);
  function utf8Bytes(s) {
    let n = 0;
    for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
    return n;
  }
  function capSteps(steps) {
    if (!Array.isArray(steps)) return [];
    const out = steps.filter((x) => typeof x === 'string').map(oneLine).filter(Boolean).slice(-MAX_STEPS);
    let bytes = out.reduce((n, x) => n + utf8Bytes(x), 0);
    while (out.length && bytes > MAX_STEP_BYTES) bytes -= utf8Bytes(out.shift());
    return out;
  }
  function extractSteps(screenLines, userText) {
    const lines = turnLines(screenLines, userText);
    if (!lines.some((l) => BULLET.test(l))) return [];
    const blocks = splitBlocks(lines);
    let lastTool = -1;
    blocks.forEach((b, i) => { if (b.tool) lastTool = i; });
    const steps = [];
    blocks.slice(0, lastTool + 1).forEach((b) => {
      if (b.loose) return;
      if (b.tool) {
        const child = b.lines.slice(1).map((l) => l.replace(/^\s*[⎿└├│]\s*/, '').trim()).find(Boolean);
        steps.push(oneLine(b.head) + (child ? ' ⎿ ' + oneLine(child) : ''));
      } else {
        steps.push(oneLine(b.lines.join(' ')));
      }
    });
    return capSteps(steps);
  }
  const isToolStep = (s) => TOOL_HEAD.test(s) || / ⎿ /.test(s);
  // Files a turn changed, from its steps: Claude's Update/Write/Edit(path) with
  // the "Added 3 lines, removed 1 line" child, Codex's "Edited path (+3 -1)".
  const CODEX_EDIT = /^(?:Edited|Added|Deleted|Created)\s+(.+?)\s+\(\+(\d+)\s+-(\d+)\)/;
  const CLAUDE_EDIT = /^(?:Update|Write|Edit|MultiEdit|Create)\((.+?)\)(?: ⎿ (.*))?$/;
  function editsFromSteps(steps) {
    const files = new Map();
    const add = (path, plus, minus) => {
      path = path.trim();
      if (!path || /^\d+ files?$/.test(path)) return;
      const f = files.get(path) || { path, add: 0, del: 0 };
      f.add += plus; f.del += minus;
      files.set(path, f);
    };
    for (const s of Array.isArray(steps) ? steps : []) {
      let m = CODEX_EDIT.exec(s);
      if (m) { add(m[1], +m[2], +m[3]); continue; }
      m = CLAUDE_EDIT.exec(s);
      if (!m) continue;
      const note = m[2] || '';
      const num = (re) => { const x = re.exec(note); return x ? +x[1] : 0; };
      add(m[1], num(/(\d+) additions?/) || num(/Added (\d+) lines?/i) || num(/Wrote (\d+) lines?/i),
        num(/(\d+) removals?/) || num(/removed (\d+) lines?/i));
    }
    return [...files.values()];
  }
  // "18分43秒": how long a turn worked.
  function fmtDuration(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return s + '秒';
    if (s < 3600) return Math.floor(s / 60) + '分' + String(s % 60).padStart(2, '0') + '秒';
    return Math.floor(s / 3600) + '小时' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + '分';
  }
  // The centered time over each turn: 今天 21:46 / 周五 21:46 / 10月4日 21:46.
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function turnTimeLabel(ts, now) {
    if (!ts) return '';
    const d = new Date(ts), n = new Date(now || Date.now());
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day(n) - day(d)) / 86400000);
    if (days === 0) return '今天 ' + hm;
    if (days === 1) return '昨天 ' + hm;
    if (days > 1 && days < 7) return WEEKDAYS[d.getDay()] + ' ' + hm;
    const md = (d.getMonth() + 1) + '月' + d.getDate() + '日 ';
    return (d.getFullYear() === n.getFullYear() ? '' : d.getFullYear() + '年') + md + hm;
  }

  // Claude Code reads a pasted image path (an attachment) before it takes Enter: while it does,
  // its footer says "Pasting…" and an Enter sent then is dropped, leaving the text unsent in the box.
  // It replaces the footer, which is the last row of the screen: nothing else counts.
  function pasteBusy(screen) {
    const rows = String(screen || '').split('\n').map((row) => row.trim()).filter(Boolean);
    return /^Pasting(?:…|\.{3})$/.test(rows.at(-1) || '');
  }

  // A terminal that has not asked for bracketed paste reads typed text a line at a time, and the
  // tty drops everything past its line limit (1024 bytes on macOS). Stay well under it.
  const LINE_MODE_BYTES = 1000;
  const utf8Length = (text) => new TextEncoder().encode(String(text)).length;
  // Bytes of the longest line once the text is typed (newlines become Enter).
  function longestLineBytes(text) {
    return String(text || '').split(/\r?\n|\r/).reduce((max, line) => Math.max(max, utf8Length(line)), 0);
  }
  // The start of text that fits maxBytes, never cutting a character in half.
  function clipBytes(text, maxBytes) {
    let used = 0;
    let out = '';
    for (const ch of String(text || '')) {
      used += utf8Length(ch);
      if (used > maxBytes) break;
      out += ch;
    }
    return out;
  }

  // Answers to a permission menu or y/n prompt are not new questions.
  function isPromptAnswer(line) {
    const t = String(line || '').trim();
    return !t || /^(\d{1,2}|y|n|yes|no|ok)$/i.test(t);
  }
  // A line typed at a password/passphrase prompt is not echoed and must never
  // be saved as a prompt. row: the terminal row the cursor is on.
  function isSecretPrompt(row) {
    return /(password|passphrase|passcode|密码|口令|\bPIN\b)[^\n]{0,80}[:：]\s*$/i.test(String(row || '').trimEnd() + ' ');
  }

  // ---- saved conversations ----
  function emptyChat(id) { return { v: 1, id, turns: [] }; }
  function normalizeChat(raw, id) {
    const chat = emptyChat(id);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.turns)) return chat;
    if (raw.captainArchive === true) chat.captainArchive = true;
    for (const t of raw.turns.filter((x) => x && typeof x.user === 'string')) {
      chat.turns.push({
        id: typeof t.id === 'string' ? t.id.slice(0, 40) : 'u' + chat.turns.length,
        ts: Number.isFinite(t.ts) ? t.ts : 0,
        user: stripLegacyMouseReports(t.user).slice(0, MAX_TEXT),
        reply: typeof t.reply === 'string' ? stripLegacyMouseReports(t.reply).slice(0, MAX_TEXT) : '',
        done: !!t.done,
        // the app closed (or the terminal was replaced) before this turn ended
        ...(t.interrupted === true ? { interrupted: true } : {}),
        // files and pasted images sent with the prompt (paths)
        atts: Array.isArray(t.atts) ? t.atts.filter((a) => typeof a === 'string' && a.length <= 2000).slice(0, 20) : [],
        // optional (older chats have neither): when the turn finished, and its work
        ...(Number.isFinite(t.end) && t.end > 0 ? { end: t.end } : {}),
        ...(Array.isArray(t.steps) && capSteps(t.steps).length ? { steps: capSteps(t.steps) } : {}),
        ...(t.kind === 'notice' ? { kind: 'notice' } : {}),
        ...(t.kind === 'task' && t.task && typeof t.task === 'object' ? { kind: 'task', task: normalizeTask(t.task) } : {}),
      });
    }
    return chat;
  }
  // A 主会话 card: work handed to another column and its short receipt.
  function normalizeTask(t) {
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const r = t.receipt && typeof t.receipt === 'object' ? t.receipt : null;
    const command = r && r.source === 'command';
    const list = (v) => (Array.isArray(v) ? (command ? v.filter((x) => typeof x === 'string') : v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 500)).slice(0, 10)) : []);
    return {
      colId: str(t.colId, 160), title: str(t.title, 120), status: str(t.status, 20), ...(typeof t.progress === 'string' ? { progress: t.progress } : {}),
      ...(t.webPhase === 'queued' || t.webPhase === 'running' ? { webPhase: t.webPhase } : {}),
      // optional: which project the work was for and when its receipt came in (Artifacts groups by them)
      ...(str(t.project, 120) ? { project: str(t.project, 120) } : {}), ...(Number.isFinite(t.doneAt) && t.doneAt > 0 ? { doneAt: t.doneAt } : {}),
      receipt: r ? { summary: str(r.summary, command ? Infinity : 400), failed: str(r.failed, command ? Infinity : 240), question: str(r.question, command ? Infinity : 400), files: list(r.files), images: list(r.images), explicit: !!r.explicit, ...(command ? { source: 'command' } : {}),
        ...(str(r.undeliveredTaskId, 160) ? { undeliveredTaskId: str(r.undeliveredTaskId, 160), undeliveredInstruction: str(r.undeliveredInstruction, Infinity) } : {}) } : null,
    };
  }
  function addTurn(chat, turn) {
    chat.turns.push(turn);
    return turn;
  }
  // A turn still open in a saved file can never get its reply now: keep what
  // was captured and mark it unfinished instead of passing it off as complete.
  function closeOpenTurns(chat) {
    for (const t of chat.turns) {
      if (t.done) continue;
      t.done = true;
      t.interrupted = true;
    }
    return chat;
  }
  // Turns recorded before the saved file was loaded go after the saved ones.
  function mergeChats(saved, mem) {
    if (!mem || mem === saved || !mem.turns.length) return saved;
    const ids = new Set(saved.turns.map((t) => t.id));
    saved.turns.push(...mem.turns.filter((t) => !ids.has(t.id)));
    return saved;
  }
  // First index of the turns a window of `shown` turns from the end starts at.
  function windowStart(total, shown) {
    return Math.max(0, total - Math.max(1, shown || RENDER_STEP));
  }

  // ---- search ----
  function snippet(text, at, len, radius = 34) {
    const from = Math.max(0, at - radius);
    const to = Math.min(text.length, at + len + radius);
    return {
      before: (from > 0 ? '…' : '') + text.slice(from, at).replace(/\s+/g, ' '),
      match: text.slice(at, at + len),
      after: text.slice(at + len, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : ''),
    };
  }
  function searchChats(chats, query, limit = 60) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return [];
    const hits = [];
    const find = (text) => {
      const low = text.toLowerCase();
      if (!words.every((w) => low.includes(w))) return -1;
      return low.indexOf(words[0]);
    };
    for (const chat of chats) {
      const titleAt = find(chat.title || '');
      if (titleAt >= 0) hits.push({ colId: chat.colId, title: chat.title, role: 'title', turnId: null, ts: Number.MAX_SAFE_INTEGER - 1, ...snippet(chat.title, titleAt, words[0].length, 60) });
      for (const turn of chat.turns) {
        for (const role of ['user', 'reply']) {
          const text = turn[role] || '';
          const at = find(text);
          if (at < 0) continue;
          hits.push({ colId: chat.colId, title: chat.title, role, turnId: turn.id, ts: turn.ts, ...snippet(text, at, words[0].length) });
        }
      }
    }
    hits.sort((a, b) => b.ts - a.ts);
    return hits.slice(0, limit);
  }

  // ---- files ----
  // ---- what a reply reads as in the chat view ----
  // A reply is read off the terminal screen and saved as it was read. What the
  // chat view shows is the agent's words only: `clean` is the phone hub's
  // cleanReply (mobile-web/hub/core.js), the one set of rules both ends use.
  // extractReply trims the reply, which takes the indent off the first row of a
  // file diff left at its top; that row gets its indent back so the shared
  // rules see the diff whole.
  const DIFF_ROW = /^ {2,}\d{1,6}(?: [+-]| {2}\S|\s*$)/;
  function shownReply(reply, said, clean, prompt) {
    let text = String(reply == null ? '' : reply).replace(/\r\n?/g, '\n');
    if (typeof clean !== 'function') return text;
    const head = text.split(/\n[ \t]*\n/)[0].split('\n');
    if (head.length > 1 && /^\S/.test(head[0]) && head.slice(1).some((l) => DIFF_ROW.test(l))) text = '    ' + text;
    return clean(text, said || '', prompt || '');
  }

  // ---- artifacts: files and links the agents mentioned in their replies ----
  // chats: [{ colId, title, archived, turns }]; findLinks(line) -> [{ kind, text }]
  function artifactName(kind, text) {
    if (kind === 'url') {
      const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(text);
      if (!m) return text;
      const tail = m[2].replace(/\/+$/, '').split('/').pop();
      return tail ? m[1] + ' · ' + decodeSafe(tail) : m[1];
    }
    const bare = text.replace(/^file:\/\//, '').replace(/:\d+(?::\d+)?$/, '').replace(/[\\/]+$/, '');
    return bare.split(/[\\/]/).pop() || bare;
  }
  function decodeSafe(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }
  function collectArtifacts(chats, findLinks, limit = 500) {
    const seen = new Map();
    for (const chat of chats) {
      for (const turn of chat.turns || []) {
        if (!turn.reply) continue;
        for (const line of turn.reply.split('\n')) {
          for (const found of findLinks(line)) {
            const m = { kind: found.kind, text: String(found.text).trim() };
            if (!m.text) continue;
            const key = m.kind + '\u0000' + m.text;
            const prev = seen.get(key);
            if (prev && prev.ts >= (turn.ts || 0)) continue;
            seen.set(key, {
              kind: m.kind, text: m.text, name: artifactName(m.kind, m.text),
              type: m.kind === 'url' ? 'web' : fileKind(artifactName('file', m.text)),
              colId: chat.colId, title: chat.title, archived: !!chat.archived, turnId: turn.id, ts: turn.ts || 0,
            });
          }
        }
      }
    }
    return [...seen.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  // ---- deliveries: the files the crew listed in their receipts, by project ----
  // One file per path. A Windows path ignores case and slash direction, "~" is
  // the home folder, and a trailing ":line" or slash does not make a new file.
  const WIN_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;
  const ABS_PATH = /^(?:file:\/\/)?(?:\/(?!\/)|~[\\/]|[A-Za-z]:[\\/]|\\\\)/;
  function pathKey(text, home) {
    let p = String(text == null ? '' : text).trim().replace(/^file:\/\//, '');
    if (home && /^~(?:[\\/]|$)/.test(p)) p = home + p.slice(1);
    p = p.replace(/:\d+(?::\d+)?$/, '');
    if (WIN_PATH.test(p)) return p.replace(/\//g, '\\').replace(/(?!^)\\+/g, '\\').replace(/\\$/, '').toLowerCase();
    return p.replace(/\/{2,}/g, '/').replace(/(?!^)\/$/, '');
  }
  // Every receipt that listed files, from the three places a receipt is kept:
  // the session it came from (what `ledger` prints), 队长's task list, and the
  // task cards in 队长's conversations (the only record once a session is gone).
  //   sessions: [{ id, title, project, archived, lastReceipt }]
  //   tasks:    config.mainSession.tasks
  //   chats:    [{ colId, turns }] holding task cards
  function deliveryReceipts({ sessions = [], tasks = [], chats = [] }) {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const out = [];
    const add = (colId, receipt, ts, task, project) => {
      // absolute paths only: receipts read off the screen by older versions also hold relative names and stray lines
      const files = receipt && Array.isArray(receipt.files) ? receipt.files.filter((f) => typeof f === 'string' && ABS_PATH.test(f.trim())) : [];
      if (!files.length) return;
      const session = byId.get(colId);
      out.push({
        colId: colId || '', session: session ? session.title : '', archived: !!(session && session.archived), gone: !session,
        project: String(project || (session && session.project) || '').replace(/\s+/g, ' ').trim(),
        ts: Number(ts) || 0, files, task: String(task || ''), summary: String(receipt.summary || ''), failed: String(receipt.failed || ''),
      });
    };
    for (const s of sessions) add(s.id, s.lastReceipt, s.lastReceipt && s.lastReceipt.ts, '', s.project);
    for (const t of tasks) add(t.colId, t.receipt, t.doneAt || t.sentAt, t.title, t.project);
    for (const chat of chats) {
      for (const turn of chat.turns || []) {
        if (turn.kind === 'task' && turn.task) add(turn.task.colId, turn.task.receipt, turn.task.doneAt || turn.ts, turn.task.title || turn.user, turn.task.project);
      }
    }
    return out;
  }
  // -> { total, groups: [{ key, name, ts, files: [{ key, path, name, type, colId,
  //      session, archived, gone, ts, task, summary, failed }] }] }, newest first;
  // files without a project come last as the group with key ''.
  function collectDeliveries(receipts, home) {
    const seen = new Map();
    for (const r of receipts) {
      for (const raw of r.files) {
        const path = raw.trim(), key = pathKey(path, home);
        if (!key) continue;
        const prev = seen.get(key);
        // the same receipt is kept in several places: the copy that knows more wins a tie
        if (prev && (prev.ts > r.ts || (prev.ts === r.ts && (prev.project || !r.project) && (!prev.gone || r.gone)))) continue;
        const name = artifactName('file', path);
        seen.set(key, {
          key, path, name, type: fileKind(name), colId: r.colId, session: r.session, archived: r.archived, gone: r.gone,
          project: r.project, ts: r.ts, task: r.task, summary: r.summary, failed: r.failed,
        });
      }
    }
    const groups = new Map();
    for (const f of [...seen.values()].sort((a, b) => b.ts - a.ts || a.name.localeCompare(b.name))) {
      const key = f.project.toLowerCase();
      if (!groups.has(key)) groups.set(key, { key, name: f.project, ts: f.ts, files: [] });
      groups.get(key).files.push(f);
    }
    const list = [...groups.values()].sort((a, b) => !a.key - !b.key || b.ts - a.ts);
    return { total: seen.size, groups: list };
  }

  return {
    normalizeViewMode, toggleGlobalView, RENDER_STEP, visibleWidth, collectArtifacts, artifactName, pathKey, deliveryReceipts, collectDeliveries, extractReply, cutInputBox, pasteBusy, LINE_MODE_BYTES, utf8Length, longestLineBytes, clipBytes, isPromptAnswer, isSecretPrompt, isChrome, reflow,
    emptyChat, normalizeChat, addTurn, closeOpenTurns, mergeChats, windowStart, searchChats,
    fileKind, languageFor, imageMime, extOf, highlightCode, renderMarkdown, esc,
    // the reply as the chat view shows it
    shownReply, tidyReply, joinGap,
    // a turn's work and timing in the chat view
    extractSteps, capSteps, isToolStep, editsFromSteps, fmtDuration, turnTimeLabel, MAX_STEPS, MAX_STEP_BYTES,
  };
});
