// Skills page: every SKILL.md the agent CLIs on this machine can see, the
// shared originals in ~/.agents/skills next to each tool's own skills. Pick one
// to read it rendered or edit its full Markdown and save it back. The page only
// holds opaque keys from the listing; the main process finds the file.
(function () {
  'use strict';
  const C = window.ChatCore;
  const CATS = ['shared', 'claude', 'codex', 'gemini', 'antigravity', 'cursor', 'grok'];
  const LABEL = { shared: '共享正本', claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', cursor: 'Cursor', grok: 'Grok' };
  const KIND = { builtin: '内置', plugin: '插件' };
  const st = {
    loaded: false, loading: false, error: '', skills: [], truncated: false,
    cat: 'all', q: '', sel: null, doc: null, draft: null, mode: 'preview', status: null, saving: false,
  };
  let host = null;
  let ui = null;                     // live nodes of the rendered page, or null

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(label, onClick, cls) {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  const visible = () => window.Pages.current() === 'skills';
  const refresh = () => { if (visible()) window.Pages.render(); };
  const selected = () => st.skills.find((s) => s.key === st.sel) || null;
  const dirty = () => !!(st.doc && st.draft != null && st.draft !== st.doc.lf);
  const usersText = (s) => s.users.map((p) => LABEL[p] || p).join('、');

  function load(quiet) {
    if (st.loading) return;
    st.loading = true;
    if (quiet !== true) refresh();
    window.deck.skillsList().then((r) => {
      st.loading = false;
      if (!r || !r.ok) { st.error = (r && r.error) || '读取技能列表失败'; refresh(); return; }
      st.loaded = true; st.error = '';
      st.skills = r.skills; st.truncated = !!r.truncated;
      if (st.sel && !selected() && !dirty()) { st.sel = null; st.doc = null; st.draft = null; st.status = null; }
      refresh();
    }).catch((e) => { st.loading = false; st.error = String(e && e.message || e); refresh(); });
  }

  function select(s, force) {
    if (!force && st.sel === s.key) return;
    if (!force && dirty() && !confirm('当前技能有未保存的修改，放弃这些修改？')) return;
    st.sel = s.key; st.doc = null; st.draft = null; st.saving = false;
    st.status = s.blocked ? null : { kind: 'info', text: '读取中…' };
    refresh();
    if (s.blocked) return;
    const key = s.key;
    window.deck.skillsRead(key).then((r) => {
      if (st.sel !== key) return;
      if (!r || !r.ok) {
        st.status = { kind: 'error', text: '读取失败：' + ((r && r.error) || '未知错误') };
      } else {
        // a textarea hands back \n only; CRLF files get their line endings back on save
        const lf = r.text.replace(/\r\n?/g, '\n');
        st.doc = { key, text: r.text, lf, hash: r.hash, editable: r.editable, reason: r.reason, eol: r.text.includes('\r\n') ? '\r\n' : '\n' };
        st.draft = lf;
        st.status = r.editable ? null : { kind: 'error', text: r.reason };
      }
      refresh();
    }).catch((e) => { if (st.sel === key) { st.status = { kind: 'error', text: '读取失败：' + (e && e.message || e) }; refresh(); } });
  }
  function reload() {
    const s = selected();
    if (!s) return;
    if (dirty() && !confirm('放弃未保存的修改，重新载入文件？')) return;
    st.draft = null;
    select(s, true);
  }

  function save() {
    const s = selected();
    const doc = st.doc;
    if (!s || !doc || !doc.editable || st.saving || !dirty()) return;
    const sent = st.draft;
    const text = doc.eol === '\r\n' ? sent.replace(/\n/g, '\r\n') : sent;
    st.saving = true;
    setStatus({ kind: 'info', text: '保存中…' });
    window.deck.skillsSave(doc.key, text, doc.hash).then((r) => {
      st.saving = false;
      if (st.doc !== doc) return;
      if (r && r.ok) {
        st.doc = { ...doc, text, lf: sent, hash: r.hash };
        s.size = r.size; s.mtime = r.mtime;
        setStatus({ kind: 'ok', text: '已保存 · ' + new Date().toLocaleTimeString() });
        host.showToast('已保存「' + s.name + '」');
      } else if (r && r.conflict) {
        setStatus({ kind: 'error', text: '没有保存：文件在你打开之后被别处改过。你的修改还在编辑框里，可以先复制出来，再点「重新载入」。' });
      } else {
        setStatus({ kind: 'error', text: '保存失败：' + ((r && r.error) || '未知错误') });
      }
    }).catch((e) => {
      st.saving = false;
      setStatus({ kind: 'error', text: '保存失败：' + (e && e.message || e) });
    });
  }
  function setStatus(status) {
    st.status = status;
    syncToolbar();
  }
  function syncToolbar() {
    if (!ui || !ui.save) return;
    const doc = st.doc;
    ui.save.disabled = !doc || !doc.editable || st.saving || !dirty();
    ui.save.textContent = st.saving ? '保存中…' : '保存';
    ui.dirty.hidden = !dirty();
    ui.status.textContent = st.status ? st.status.text : '';
    ui.status.className = 'sk-status' + (st.status ? ' ' + st.status.kind : '');
  }

  // ---- page ----
  function render(frame, h) {
    host = h;
    if (!st.loaded && !st.loading && !st.error) load(true);
    const reload = btn('', load, 'tool-action');
    reload.title = st.loading ? '刷新中…' : '刷新'; reload.setAttribute('aria-label', reload.title); reload.innerHTML = host.ICONS.reset;
    const body = frame('Skills', '本机各个 agent 的技能。共享正本在 ~/.agents/skills，各工具通过链接使用它；编辑共享正本，所有链接到它的工具都会看到修改。',
      [reload]);
    body.parentElement.classList.add('page-wide');
    ui = {};
    if (!st.loaded) {
      const empty = el('div', 'page-empty');
      empty.append(el('strong', null, st.error ? '读取技能失败' : '正在查找技能…'), el('span', null, st.error || '会查看 ~/.agents、~/.claude、~/.codex、~/.gemini、~/.cursor、~/.grok 下的技能目录。'));
      if (st.error) empty.appendChild(btn('重试', load, 'primary'));
      body.appendChild(empty);
      return;
    }

    const bar = el('div', 'art-bar sk-bar');
    const count = (cat) => (cat === 'all' ? st.skills.length : st.skills.filter((s) => s.category === cat).length);
    ['all', ...CATS].forEach((cat) => {
      const b = el('button', 'seg-btn' + (st.cat === cat ? ' active' : ''));
      b.type = 'button';
      b.title = cat === 'shared' ? '~/.agents/skills 里的正本' : cat === 'all' ? '' : LABEL[cat] + ' 独有的技能（不含链接到共享正本的）';
      b.append(el('span', null, cat === 'all' ? '全部' : LABEL[cat]), el('span', 'seg-count', String(count(cat))));
      b.addEventListener('click', () => { st.cat = cat; refresh(); });
      bar.appendChild(b);
    });
    bar.appendChild(el('span', 'tb-spacer'));
    const search = el('input', 'art-search');
    search.type = 'text'; search.placeholder = '筛选名称、描述、路径或工具'; search.value = st.q; search.spellcheck = false;
    search.addEventListener('input', () => { st.q = search.value; fillList(); });
    search.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
    bar.appendChild(search);
    body.appendChild(bar);
    if (st.truncated) body.appendChild(el('div', 'sk-note warn', '技能太多，只列出了前一部分。'));

    const split = el('div', 'sk-split');
    ui.list = el('div', 'sk-list');
    ui.detail = el('div', 'sk-detail');
    split.append(ui.list, ui.detail);
    body.appendChild(split);
    fillList();
    fillDetail();
  }

  function matches(s, q) {
    if (st.cat !== 'all' && s.category !== st.cat) return false;
    if (!q) return true;
    return [s.name, s.description, s.relDir, s.path, s.source, ...s.users.map((p) => LABEL[p] || p)].join(' ').toLowerCase().includes(q);
  }
  function fillList() {
    const list = ui.list;
    list.textContent = '';
    const q = st.q.trim().toLowerCase();
    const shown = st.skills.filter((s) => matches(s, q));
    if (!shown.length) {
      list.appendChild(el('div', 'sk-empty', st.skills.length ? '没有匹配的技能' : '没有找到技能'));
      return;
    }
    shown.forEach((s) => {
      const row = el('button', 'sk-row' + (s.key === st.sel ? ' active' : ''));
      row.type = 'button';
      row.title = s.path;
      const top = el('div', 'sk-row-top');
      top.appendChild(el('span', 'sk-row-name', s.name));
      if (s.nested) top.appendChild(el('span', 'sk-badge', '嵌套'));
      if (KIND[s.kind]) top.appendChild(el('span', 'sk-badge', KIND[s.kind]));
      if (s.blocked) top.appendChild(el('span', 'sk-badge warn', '目录外'));
      row.appendChild(top);
      if (s.description) row.appendChild(el('div', 'sk-row-desc', s.description));
      row.appendChild(el('div', 'sk-row-meta', s.category === 'shared'
        ? (s.users.length ? '共享 → ' + usersText(s) : '共享正本 · 暂无工具链接')
        : s.source + (s.nested ? ' · ' + s.relDir : '')));
      row.addEventListener('click', () => select(s));
      list.appendChild(row);
    });
  }

  function infoRow(label, value, cls) {
    const row = el('div', 'sk-info-row');
    row.append(el('span', 'sk-info-label', label), el('span', 'sk-info-value' + (cls ? ' ' + cls : ''), value));
    return row;
  }
  function noteFor(s) {
    if (s.blocked) return { cls: 'warn', text: s.blocked + '。' };
    if (s.category === 'shared') {
      return s.users.length
        ? { cls: '', text: '这是共享正本，' + usersText(s) + ' 通过链接使用它。保存只写这一份文件，各工具的链接保持不变，都会看到修改。' }
        : { cls: '', text: '这是共享正本，目前没有工具链接到它。' };
    }
    if (s.kind === 'plugin') return { cls: 'warn', text: '这是插件缓存里的技能，插件更新时可能覆盖你的修改。' };
    if (s.kind === 'builtin') return { cls: 'warn', text: '这是工具自带的技能，工具更新时可能覆盖你的修改。' };
    return { cls: '', text: '这是 ' + (LABEL[s.category] || s.category) + ' 独有的技能，只影响它自己。' };
  }

  function fillDetail() {
    const box = ui.detail;
    box.textContent = '';
    const s = selected();
    if (!s) {
      box.appendChild(el('div', 'sk-empty', '在左边选一个技能，查看渲染后的内容或直接编辑 Markdown。'));
      return;
    }
    const head = el('div', 'sk-head');
    head.append(el('h2', 'sk-title', s.name));
    const chips = el('div', 'sk-chips');
    chips.appendChild(el('span', 'chip', s.source));
    if (s.nested) chips.appendChild(el('span', 'chip', '嵌套 · ' + s.relDir));
    head.appendChild(chips);
    box.appendChild(head);

    const info = el('div', 'sk-info');
    info.appendChild(infoRow('文件', s.path, 'mono'));
    info.appendChild(infoRow('使用方', s.users.length ? usersText(s) : '无'));
    if (s.links.length) {
      const det = el('details', 'sk-links');
      det.appendChild(el('summary', null, '经由 ' + s.links.length + ' 个链接'));
      s.links.forEach((l) => det.appendChild(el('div', 'sk-link mono', (LABEL[l.provider] || l.provider) + '  ' + l.path)));
      info.appendChild(det);
    }
    box.appendChild(info);
    const note = noteFor(s);
    box.appendChild(el('div', 'sk-note' + (note.cls ? ' ' + note.cls : ''), note.text));
    if (s.blocked) { ui.save = null; return; }

    const tools = el('div', 'sk-toolbar');
    [['preview', '预览'], ['edit', '编辑']].forEach(([mode, label]) => {
      const b = el('button', 'seg-btn' + (st.mode === mode ? ' active' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => { if (st.mode !== mode) { st.mode = mode; fillDetail(); } });
      tools.appendChild(b);
    });
    ui.dirty = el('span', 'sk-dirty', '未保存');
    ui.status = el('span', 'sk-status');
    tools.append(ui.dirty, ui.status, el('span', 'tb-spacer'), btn('重新载入', reload));
    ui.save = btn('保存', save, 'primary');
    ui.save.title = `保存 (${window.AppShortcutsCore.mod(host.platform === 'darwin')}S)`;
    tools.appendChild(ui.save);
    box.appendChild(tools);

    const content = el('div', 'sk-content');
    if (st.doc && st.mode === 'edit') {
      const ta = el('textarea', 'sk-editor');
      ta.value = st.draft;
      ta.spellcheck = false;
      ta.readOnly = !st.doc.editable;
      ta.addEventListener('input', () => { st.draft = ta.value; syncToolbar(); });
      ta.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); e.stopPropagation(); save(); return; }
        if (e.key === 'Escape' && !e.isComposing) return;
        e.stopPropagation();
      });
      content.appendChild(ta);
    } else if (st.doc) {
      content.appendChild(preview(st.draft));
    }
    box.appendChild(content);
    syncToolbar();
  }

  // Rendered for reading only: links open in the side browser, nothing runs.
  function preview(text) {
    const wrap = el('div', 'sk-preview');
    const fm = /^\uFEFF?---\n[\s\S]*?\n---(?:\n|$)/.exec(text);
    if (fm) wrap.appendChild(el('pre', 'sk-fm', fm[0].trim()));
    const md = el('div', 'pv-md');
    md.innerHTML = C.renderMarkdown(fm ? text.slice(fm[0].length) : text);
    md.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      if (a.hasAttribute('data-ext')) window.SidePane.openLink({ kind: 'url', text: a.getAttribute('href') }, e);
    });
    wrap.appendChild(md);
    return wrap;
  }

  window.SkillsPage = { render, isDirty: dirty };
})();
