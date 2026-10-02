// Pure helpers behind the chat view: pulling the final reply out of a TUI
// screen, safe markdown/code rendering for the preview pane, and searching the
// saved prompts and replies. No DOM, no Electron: runs in the page and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TURNS = 400;
  const MAX_TEXT = 20000;

  // ---- text helpers ----
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const isWide = (ch) => /[ᄀ-ᅟ⺀-鿿가-힣豈-﫿＀-｠￠-￦]/.test(ch);
  function visibleWidth(s) {
    let w = 0;
    for (const ch of String(s)) w += isWide(ch) ? 2 : 1;
    return w;
  }
  const rtrim = (s) => s.replace(/\s+$/, '');

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
    const first = (String(userText).split('\n')[0] || '').replace(/\s+/g, ' ').trim();
    const needle = first.slice(0, 18);
    if (needle.length < 2) return -1;
    for (let i = 0; i < Math.min(lines.length, 12); i++) {
      const flat = promptGlyphs(lines[i]).replace(/\s+/g, ' ');
      if (!flat.includes(needle)) continue;
      let end = i;
      // the TUI wraps a long prompt onto indented continuation rows
      while (end + 1 < lines.length && end - i < 10 && /^ {2,}\S/.test(lines[end + 1]) && !BULLET.test(lines[end + 1])) end++;
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

  // Terminals hard-wrap long paragraphs; glue them back so the chat bubble can
  // wrap to its own width. Lists, headings and indented code stay as they are.
  function reflow(lines, cols) {
    const limit = Math.max(20, (cols || 80) * 0.7);
    const out = [];
    let prev = null;
    for (const line of lines) {
      if (!line.trim()) { out.push(''); prev = null; continue; }
      const special = /^\s*([-*•]|\d+[.)])\s+/.test(line) || /^#{1,6}\s/.test(line) || /^ {4,}\S/.test(line) || /^\s*(```|~~~)/.test(line);
      if (prev !== null && !special && visibleWidth(out[out.length - 1]) >= limit) {
        const last = out[out.length - 1];
        const gap = isWide(last.slice(-1)) || isWide(line.trim()[0]) ? '' : ' ';
        out[out.length - 1] = last + gap + line.trim();
      } else {
        out.push(line);
      }
      prev = line;
    }
    return out;
  }

  function extractReply(screenLines, userText, cols) {
    let lines = screenLines.map(rtrim);
    const echo = findPromptEcho(lines, userText);
    if (echo >= 0) lines = lines.slice(echo + 1);
    lines = lines.filter((l) => !isChrome(l));
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

  // Answers to a permission menu or y/n prompt are not new questions.
  function isPromptAnswer(line) {
    const t = String(line || '').trim();
    return !t || /^(\d{1,2}|y|n|yes|no|ok)$/i.test(t);
  }

  // ---- saved conversations ----
  function emptyChat(id) { return { v: 1, id, turns: [] }; }
  function normalizeChat(raw, id) {
    const chat = emptyChat(id);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.turns)) return chat;
    for (const t of raw.turns.filter((x) => x && typeof x.user === 'string').slice(-MAX_TURNS)) {
      chat.turns.push({
        id: typeof t.id === 'string' ? t.id.slice(0, 40) : 'u' + chat.turns.length,
        ts: Number.isFinite(t.ts) ? t.ts : 0,
        user: t.user.slice(0, MAX_TEXT),
        reply: typeof t.reply === 'string' ? t.reply.slice(0, MAX_TEXT) : '',
        done: !!t.done,
      });
    }
    return chat;
  }
  function addTurn(chat, turn) {
    chat.turns.push(turn);
    if (chat.turns.length > MAX_TURNS) chat.turns.splice(0, chat.turns.length - MAX_TURNS);
    return turn;
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
  const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
  const LANG = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', json: 'json', css: 'css', html: 'html', htm: 'html',
    py: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', rb: 'py', yml: 'py', yaml: 'py', toml: 'py', ini: 'py', conf: 'py',
    go: 'js', rs: 'js', java: 'js', c: 'js', h: 'js', cpp: 'js', swift: 'js', kt: 'js', php: 'js', sql: 'sql', lua: 'sql',
  };
  function extOf(name) { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name)); return m ? m[1].toLowerCase() : ''; }
  function fileKind(name) {
    const ext = extOf(name);
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    if (ext === 'pdf') return 'pdf';
    if (IMAGE_EXT.has(ext)) return 'image';
    return 'text';
  }
  function languageFor(name) { return LANG[extOf(name)] || 'plain'; }
  const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif' };
  function imageMime(name) { return IMAGE_MIME[extOf(name)] || null; }

  // ---- code highlighting (small, generic, always escaped) ----
  const KEYWORDS = new Set(('function const let var return if else for while switch case break continue class new import from export default async await try catch finally throw typeof in of ' +
    'def lambda None True False self elif with as pass raise yield fn pub struct impl enum match use mod func type interface package null undefined true false nil void int string bool ' +
    'select insert update delete create table where join group order by limit and or not then end').split(' '));
  function highlightCode(code, lang) {
    if (lang === 'plain') return esc(code);
    const hashComment = lang === 'py' || lang === 'sh';
    const lineComment = lang === 'sql' ? '--' : '//';
    const parts = [
      '/\\*[\\s\\S]*?\\*/',
      hashComment ? '#[^\\n]*' : (lang === 'plain' || lang === 'json' || lang === 'html' ? '(?!)' : lineComment.replace(/[/-]/g, '\\$&') + '[^\\n]*'),
      '"(?:\\\\.|[^"\\\\\\n])*"', "'(?:\\\\.|[^'\\\\\\n])*'", '`(?:\\\\.|[^`\\\\])*`',
      '\\b\\d[\\d_.]*\\b', '[A-Za-z_][A-Za-z0-9_]*',
    ];
    const re = new RegExp(parts.map((p) => '(' + p + ')').join('|'), 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      const t = m[0];
      let cls = null;
      if (m[1] || m[2]) cls = 'c';
      else if (m[3] || m[4] || m[5]) cls = 's';
      else if (m[6]) cls = 'n';
      else if (KEYWORDS.has(t)) cls = 'k';
      out += cls ? `<span class="tok-${cls}">${esc(t)}</span>` : esc(t);
      last = m.index + t.length;
      if (t.length === 0) re.lastIndex++;
    }
    return out + esc(code.slice(last));
  }

  // ---- markdown (for previewing .md files) ----
  const SAFE_URL = /^(https?:\/\/|mailto:)/i;
  function inline(src) {
    let s = esc(String(src).replace(/\u0000/g, ''));
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, text, url) => {
      const raw = url.replace(/&amp;/g, '&');
      return SAFE_URL.test(raw) ? `<a href="${esc(raw)}" data-ext="1">${text}</a>` : text;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }
  function renderMarkdown(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i])) body.push(lines[i++]);
        i++;
        const lang = LANG[fence[2]] || 'plain';
        html.push(`<pre class="md-code"><code>${highlightCode(body.join('\n'), lang)}</code></pre>`);
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        html.push(`<blockquote>${inline(q.join(' '))}</blockquote>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        html.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
        continue;
      }
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m) break;
          items.push(`<li style="margin-left:${Math.min(m[1].length, 8) * 4}px">${inline(m[3])}</li>`);
          i++;
        }
        html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++].trim());
      if (!para.length) { para.push(lines[i++]); }
      html.push(`<p>${inline(para.join(' '))}</p>`);
    }
    return html.join('\n');
  }

  return {
    MAX_TURNS, visibleWidth, extractReply, isPromptAnswer, isChrome, reflow,
    emptyChat, normalizeChat, addTurn, searchChats,
    fileKind, languageFor, imageMime, extOf, highlightCode, renderMarkdown, esc,
  };
});
