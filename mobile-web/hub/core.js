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

  // ---- outbox --------------------------------------------------------------
  // A message the phone sent stays in the conversation from the tap until the
  // computer's own record of it arrives. The computer types a message into the
  // Captain only once the Captain is idle, so that record can be minutes away.
  // A very long message is recorded clipped, ending in this note.
  const CLIPPED = /…?（全文 \d+ 字，见附件）$/;
  const isUserTurn = (turn) => !!turn && typeof turn === 'object' && !turn.kind && !!(typeof turn.user === 'string' && turn.user || Array.isArray(turn.images) && turn.images.length);
  function sameMessage(turn, item) {
    const said = typeof turn.user === 'string' ? turn.user : '', sent = squash(item.text || '');
    const images = (list) => (Array.isArray(list) ? list : []).join('|');
    if (images(item.images) && images(item.images) !== images(turn.images)) return false;
    if (squash(said) === sent) return true;
    const head = squash(said.replace(CLIPPED, ''));
    return CLIPPED.test(said) && head.length >= 20 && sent.startsWith(head);
  }
  const userTurnIds = (turns) => (Array.isArray(turns) ? turns : []).filter(isUserTurn).map((turn) => turn.id);
  // The sent messages the conversation does not show yet. `known` holds the
  // turns that were there when a message went out, so an older message with the
  // same words is never taken for it; a turn stands for one sent message only.
  // A failed message stays unless nobody knows whether it arrived (`unsure`).
  function settleOutbox(items, turns) {
    const users = (Array.isArray(turns) ? turns : []).filter(isUserTurn);
    return items.filter((item) => {
      if (item.state === 'failed' && !item.unsure) return true;
      const turn = users.find((t) => !item.known.includes(t.id) && sameMessage(t, item));
      if (!turn) return true;
      for (const other of items) other.known.push(turn.id);
      return false;
    });
  }
  // The same words again right after they went out is nearly always a second
  // tap on a message that looked lost. True while the first one is still on its
  // way to the Captain, or went out less than a minute ago.
  const REPEAT_MS = 60000;
  function repeatedSend(items, text, now) {
    const words = squash(text || '');
    return !!words && items.some((item) => item.state !== 'failed' && squash(item.text || '') === words && !(item.images && item.images.length) && (!item.arrived || now - item.at < REPEAT_MS));
  }
  // Whether a vertical drag would move the page instead of a list: nothing
  // under the finger scrolls, or the list is already at the end the finger pulls from.
  function dragMovesPage(scroller, dy) {
    if (!scroller) return true;
    return dy > 0 ? scroller.scrollTop <= 0 : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
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
  // The desktop reads a reply off the terminal screen, so terminal residue can
  // ride along with it: the echo of a typed prompt, collapsed tool summaries,
  // background-command notices, the tail of a file diff, update banners, logo
  // art. The phone shows the Captain's words only. When in doubt a line stays:
  // a stray terminal line is better than a missing sentence.
  const TOOL_CLAUSE = '(?:(?:ran|read|searched for|listed|edited|wrote|updated|fetched|created|deleted) \\d+ [a-z]+(?: [a-z]+)?|called [\\w .-]+?)';
  const TERMINAL_LINES = [
    new RegExp(`^${TOOL_CLAUSE}(?:, ${TOOL_CLAUSE})*$`, 'i'),      // Read 1 file, ran 3 shell commands
    /^Running \d+ shell commands?…$/, /^⎿/,
    /^Update available! Run: /, /^Welcome to Claude Code\b/,
    /^Worked for (?:\d+[hms] ?)+(?:•.*)?$/,
    /^Resume this session with:$/, /^claude --resume [\w-]+$/,
    /^› Ask Codex to do anything$/,
    /^How is Claude doing this session\? \(optional\)$/, /^1: Bad\s+2: Fine\s+3: Good\s+0: Dismiss$/,
    /^You've used \d+% of your \w+ limit\b/,
    /^[▐▛▜▝▘▗▖▞▚▙▟]/,                                               // the Claude Code logo and its caption
    /^[*.█▓▒░▀▄\s]*[█▓▒░][*.█▓▒░▀▄\s]*$/,                           // shaded banner art
  ];
  // The scroll hint is drawn over a row of text, which may then be joined with the next row.
  const OVERLAY = /\s*(?:\d+ new messages?|Jump to bottom) \(click\) ↓\s*/g;
  const PROMPT_ECHO = /^[❯›]\s+\S/;
  // Prompts AgentDeck itself types into the Captain: the whole block is the echo.
  const INJECTED = /^[❯›]\s+(?:【AgentDeck |用户刚清空了你的模型上下文|读看板继续|永动机自动轮换)/;
  const NOTICE = /^Background command "/, NOTICE_END = /(?:code \d+\)|^\d+\)|still running|completed|failed|killed|stopped)$/;
  // A numbered row of a file diff: "    146 +", "    147  ## heading".
  const DIFF_ROW = /^ {2,}\d{1,6}(?: [+-]| {2}\S|\s*$)/;
  const squash = (text) => String(text).replace(/\s+/g, '');
  // A message sent while the agent is still busy is echoed above the row its turn
  // is read from: the reply then opens with the end of that echo, with no ❯ before
  // it. `prompt` is the turn's own message. Only opening rows that run to its very
  // end go, and a few characters are not enough: a reply may begin with your words.
  const ECHO_TAIL_MIN = 8;
  function echoTail(rows, prompt) {
    const own = squash(prompt);
    let run = '', drop = 0;
    for (let i = 0; i < rows.length; i++) {
      const next = run + squash(rows[i]);
      if (!own.includes(next)) break;
      run = next;
      if (run.length >= ECHO_TAIL_MIN && own.endsWith(run)) drop = i + 1;
    }
    return drop;
  }
  // `said` is everything the user wrote in this conversation: a wrapped echo is
  // recognised by its lines being part of it.
  function cleanReply(text, said = '', prompt = '') {
    const known = squash(said);
    const rows = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const blocks = rows.slice(prompt ? echoTail(rows, prompt) : 0).join('\n').split(/\n[ \t]*(?:\n[ \t]*)+/);
    // A notice cut by the screen edge ends on the next row, sometimes after an empty one.
    let notice = false;
    return blocks.map((block) => {
      const lines = block.split('\n'), diff = lines.some((line) => DIFF_ROW.test(line)), kept = [];
      let echo = false, injected = false;
      for (const raw of lines) {
        const line = raw.replace(OVERLAY, ''), t = line.trim(), tail = notice && NOTICE_END.test(t);
        notice = false;
        if (tail || !t) continue;
        if (PROMPT_ECHO.test(t)) { echo = true; injected = INJECTED.test(t); continue; }
        if (echo && (injected || known.includes(squash(t)))) continue;
        echo = false;
        if (NOTICE.test(t)) { notice = !NOTICE_END.test(t); continue; }
        if (diff && (DIFF_ROW.test(line) || /^ {4,}|^\s*\+/.test(line))) continue;
        if (TERMINAL_LINES.some((pattern) => pattern.test(t))) continue;
        kept.push(line);
      }
      return kept.join('\n');
    }).filter((block) => block.trim()).join('\n\n').replace(/^\n+|\s+$/g, '');
  }
  // The desktop saves one "turn" per injected prompt: the user's message, every
  // dispatch card, every automatic receipt delivery. They are folded back into
  // what was said: the message, then one reply from the Captain. Dispatch cards,
  // notices and tool steps are process, and are not shown. Same rules as the
  // single-machine page, so both ends read the same.
  const SAME_ROUND_MS = 30 * 60 * 1000;
  function groupTurns(turns) {
    const groups = [], list = (Array.isArray(turns) ? turns : []).filter((turn) => turn && typeof turn === 'object');
    const said = list.map((turn) => typeof turn.user === 'string' ? turn.user : '').join('\n');
    let group = null, last = 0;
    const open = (turn, user, images) => { group = { id: turn.id, user, images, replies: [], pending: false, interrupted: false }; groups.push(group); };
    for (const turn of list) {
      const isUser = !turn.kind && (typeof turn.user === 'string' && turn.user || Array.isArray(turn.images) && turn.images.length);
      if (isUser) open(turn, typeof turn.user === 'string' ? turn.user : '', Array.isArray(turn.images) ? turn.images.filter((id) => typeof id === 'string') : []);
      else if (!group || (turn.ts && last && turn.ts - last > SAME_ROUND_MS)) open(turn, '', []);
      if (turn.ts) last = turn.ts;
      if (turn.kind) continue;
      const reply = cleanReply(turn.reply, said, typeof turn.user === 'string' ? turn.user : '');
      if (reply) group.replies.push(reply);
      group.pending = !turn.done && !turn.interrupted;
      group.interrupted = !!turn.interrupted;
    }
    // A round with nothing to read (only dispatching happened) leaves no trace.
    return groups.filter((g) => g.user || g.images.length || g.replies.length || g.pending || g.interrupted)
      .map((g) => ({ id: g.id, user: g.user, images: g.images, reply: g.replies.join('\n\n'), pending: g.pending, interrupted: g.interrupted }));
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

  // ---- moving the Captain to another account ---------------------------------
  // Each computer has its own Captain and its own accounts; everything here is
  // about one computer's answer and is never mixed with the other's.
  const SEAT_ID = /^[a-zA-Z0-9_-]{1,40}$/;
  const RELAY_REASONS = ['', 'current', 'login', 'onboarding', 'exhausted', 'low', 'unknown'];
  function cleanRelay(data) {
    const text = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
    const time = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
    const id = (value) => typeof value === 'string' && SEAT_ID.test(value) ? value : '';
    const seats = (data && Array.isArray(data.seats) ? data.seats : []).slice(0, 12).filter((seat) => seat && id(seat.id)).map((seat) => {
      const known = RELAY_REASONS.includes(seat.reason);
      return { id: seat.id, name: text(seat.name, 80), provider: seat.provider === 'Codex' ? 'Codex' : 'Claude', account: text(seat.account, 80), current: seat.current === true,
        // A seat is only offered when the computer says so in words this page understands.
        selectable: seat.selectable === true && seat.current !== true && known && (seat.reason === '' || seat.reason === 'unknown'),
        reason: known ? seat.reason : 'unknown', weekly: seat.weekly === true, recoveryAt: time(seat.recoveryAt),
        cells: (Array.isArray(seat.cells) ? seat.cells : []).filter((cell) => cell && ['5h', '7d'].includes(cell.key) && Number.isFinite(cell.remaining)).slice(0, 2)
          .map((cell) => ({ key: cell.key, remaining: Math.max(0, Math.min(100, cell.remaining)), out: cell.out === true, resetAt: time(cell.resetAt) })) };
    });
    const raw = data && data.job;
    const job = raw && typeof raw === 'object' && /^[a-z0-9]{1,40}$/.test(raw.id || '') && ['switching', 'done', 'failed'].includes(raw.status)
      ? { id: raw.id, status: raw.status, fromId: id(raw.fromId), fromName: text(raw.fromName, 80), targetId: id(raw.targetId), targetName: text(raw.targetName, 80),
        startedAt: time(raw.startedAt), finishedAt: time(raw.finishedAt), error: text(raw.error, 200) } : null;
    return { captainId: text(data && data.captainId, 256), currentId: id(data && data.currentId), switching: !!(data && data.switching === true) || !!(job && job.status === 'switching'), seats, job };
  }
  // "Claude US", "ChatGPT": the name people know the account by.
  const seatLabel = (seat) => !seat ? '' : seat.provider === 'Codex' ? seat.name || 'ChatGPT' : /^claude\b/i.test(seat.name) ? seat.name : 'Claude ' + (seat.name || seat.id);
  const currentSeat = (relay) => relay ? relay.seats.find((seat) => seat.current) || null : null;
  // "5 小时剩 72% · 每周剩 41%"; '' when the computer has no number for it.
  function seatQuotaText(seat) {
    return (seat ? seat.cells : []).map((cell) => (cell.key === '5h' ? '5 小时' : '每周') + (cell.out ? '已用完' : '剩 ' + percentText(cell))).join(' · ');
  }
  // Why an account cannot be picked, or what to know before picking it.
  function seatReason(seat, now) {
    const back = seat.recoveryAt > now ? '，' + longReset(seat.recoveryAt, now) + '恢复' : '，恢复时间还不知道';
    return { current: '队长现在就在用这个账号', login: '还没登录。要回到电脑上登录后才能用',
      onboarding: '还停在第一次启动的引导页。要回到电脑上处理', exhausted: (seat.weekly ? '每周额度用完了' : '额度用完了') + back,
      low: (seat.weekly ? '每周额度快用完了' : '额度快用完了') + back, unknown: '额度还不清楚，可以换过去试试' }[seat.reason] || '';
  }
  function seatSpoken(seat, now) {
    return [seatLabel(seat), seat.account, seatQuotaText(seat), seatReason(seat, now), seat.selectable ? '点一下选它' : seat.current ? '' : '现在不能选'].filter(Boolean).join('；');
  }
  // What became of a switch this phone started. `relay` is the computer's
  // latest answer (null when it could not be read: still unknown, keep waiting).
  function relayOutcome(job, relay) {
    if (!job || !relay) return { phase: 'switching', error: '' };
    if (relay.job && relay.job.id === job.id) return { phase: relay.job.status, error: relay.job.status === 'failed' ? relay.job.error || '电脑没有完成切换。' : '' };
    if (!job.id) return { phase: 'switching', error: '' };
    // The computer no longer knows this switch: AgentDeck restarted on the way. The account the Captain is on now is the outcome.
    if (relay.currentId && relay.currentId === job.targetId) return { phase: 'done', error: '' };
    return { phase: 'failed', error: '电脑上的 AgentDeck 中途重启了，切换没有完成。' };
  }
  // Why the computer did not start a switch. The Captain is unchanged in every case but a timeout.
  function relayRefusal(result, name) {
    if (!result || result.failed) return '手机连不上入口，切换的请求没有发出去。';
    if (result.timedOut) return `没有收到 ${name} 的确认。先看一眼下面的最新状态，不要连着再点。`;
    if (result.status === 409 && result.body && typeof result.body.error === 'string' && result.body.error) return result.body.error.slice(0, 200);
    if (result.status === 502) return `${name} 离线，没有切换。`;
    if (result.status === 401) return `${name} 的登录已失效，没有切换。`;
    if (result.status === 403) return `${name} 的安全校验已过期，没有切换。刷新后再试。`;
    if (result.status === 404) return `${name} 的 AgentDeck 版本太旧，还不能在手机上切换队长。`;
    return `${name} 没有接受这次切换（HTTP ${result.status}）。`;
  }
  const elapsedText = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + pad(s % 60); };

  // ---- 随手记待办 ----------------------------------------------------------
  // Each computer answers api/todos with the list as it sees it (its own file
  // merged with what git brought from the other one). The same id can come from
  // both: the copy updated last wins, and a deletion mark hides the item.
  const TODO_ID = /^td-[A-Za-z0-9-]{8,64}$/;
  const time = (value) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
  function cleanTodos(body) {
    const items = body && Array.isArray(body.items) ? body.items : [];
    const out = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !TODO_ID.test(item.id) || !time(item.updated)) continue;
      if (item.deleted === true) { out.push({ id: item.id, deleted: true, updated: item.updated }); continue; }
      if (typeof item.text !== 'string' || !item.text.trim()) continue;
      out.push({ id: item.id, text: item.text.slice(0, 500), done: item.done === true, doneAt: item.done === true && time(item.doneAt) ? item.doneAt : null,
        created: time(item.created) ? item.created : item.updated, updated: item.updated });
    }
    return out;
  }
  function mergeTodos(sources) {
    const merged = new Map();
    for (const source of sources) for (const item of source.todos || []) {
      const kept = merged.get(item.id);
      if (!kept || Date.parse(item.updated) > Date.parse(kept.item.updated)) merged.set(item.id, { item, from: source.id });
    }
    const live = [...merged.values()].filter(({ item }) => !item.deleted).map(({ item, from }) => ({ ...item, seenOn: from }));
    const open = live.filter((t) => !t.done).sort((a, b) => Date.parse(b.created) - Date.parse(a.created) || a.id.localeCompare(b.id));
    const done = live.filter((t) => t.done).sort((a, b) => Date.parse(b.doneAt || b.updated) - Date.parse(a.doneAt || a.updated) || a.id.localeCompare(b.id));
    return { open, done };
  }
  // Where a new to-do or a tick goes: the computer the user picked, else the
  // default one (Mac), else any other that is online and has to-dos. Both
  // computers keep the same list, so the choice only decides who writes first.
  function todoWriter(machines, preferId) {
    const ready = machines.filter((m) => m.state === 'online' && m.todosReady && m.csrf);
    return ready.find((m) => m.id === preferId) || ready.find((m) => m.default) || ready[0] || null;
  }
  // Why nothing can be recorded right now ('' when something can).
  function todoBlock(machines) {
    if (todoWriter(machines, '')) return '';
    const online = machines.filter((m) => m.state === 'online');
    if (online.length && online.every((m) => m.todosReady === false)) return '这台电脑上的 AgentDeck 版本还没有待办，升级后就能在手机上记。';
    if (machines.some((m) => m.state === 'login')) return '先在「总览」登录一台电脑，才能记待办。';
    return '两台电脑现在都连不上，等它们上线后再记。';
  }
  function todoFailure(result, name) {
    if (!result || result.failed) return `没连上 ${name}，这条没有记下。`;
    if (result.timedOut) return `${name} 没有响应，这条可能没记下，刷新看看。`;
    if (result.status === 401) return `${name} 需要重新登录，这条没有记下。`;
    if (result.status === 403) return `${name} 的安全校验已过期，刷新后再记。`;
    if (result.status === 400 && result.body && typeof result.body.error === 'string' && /[\u4e00-\u9fff]/.test(result.body.error)) return result.body.error.slice(0, 120);
    return `${name} 没有记下这条（HTTP ${result.status}）。`;
  }

  return { cleanTodos, mergeTodos, todoWriter, todoBlock, todoFailure, cleanRelay, seatLabel, currentSeat, seatQuotaText, seatReason, seatSpoken, relayOutcome, relayRefusal, elapsedText, TIMEOUT, STATES, machineList, classify, classifyInfo, pollInterval, sendBlock, sendFailure, userTurnIds, settleOutbox, repeatedSend, dragMovesPage, ago, metaOf, cleanMeta, mergeCards, ownerLabel,
    groupTurns, cleanReply, cleanQuota, shortReset, longReset, sampledText, percentText, cellLevel, dimmed, windowName, emptyText, quotaCells, quotaNote, cellSpoken, quotaLabel, quotaState };
});

// 待我处理 on the phone: each computer's list, cleaned field by field again
// (a computer's answer is data, not trusted markup), then merged into one page:
// 要你处理 first, then 结果汇报, newest first; 已完成 by when it was finished.
// Each item keeps the computer it came from: a reply goes to that computer only.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) Object.assign(module.exports, api);
  else Object.assign(root.HubCore, api);
})(typeof self !== 'undefined' ? self : this, () => {
  const ID = /^at-[a-z0-9-]{4,40}$/;
  const time = (value) => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const text = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, max) : '';
  const line = (value, max) => text(value, max).replace(/\s+/g, ' ').trim();
  function cleanAttention(body) {
    const items = (body && Array.isArray(body.items) ? body.items : []).slice(0, 300)
      .filter((item) => item && typeof item.id === 'string' && ID.test(item.id) && (item.kind === 'need' || item.kind === 'report') && line(item.title, 300))
      .map((item) => ({
        id: item.id, kind: item.kind, label: line(item.label, 20) || (item.kind === 'need' ? '要你处理' : '结果汇报'),
        title: line(item.title, 300), ask: line(item.ask, 1000), detail: text(item.detail, 4000),
        files: (Array.isArray(item.files) ? item.files : []).map((f) => line(f, 1024)).filter(Boolean).slice(0, 10),
        project: line(item.project, 120), cardTitle: line(item.cardTitle, 300), sessionTitle: line(item.sessionTitle, 300),
        source: item.source === 'card' ? 'card' : 'captain', created: time(item.created), readAt: time(item.readAt),
        done: item.done === true, doneAt: item.done === true ? time(item.doneAt) : 0, doneText: item.done === true ? line(item.doneText, 200) : '',
        replies: (Array.isArray(item.replies) ? item.replies : []).slice(-3).filter((r) => r && typeof r.text === 'string')
          .map((r) => ({ text: text(r.text, 1000), at: time(r.at), from: r.from === 'phone' ? 'phone' : 'desktop', seen: r.seen === true })),
      }));
    return items;
  }
  // sources: [{ id, label, items }] for the computers that answered.
  function mergeAttention(sources) {
    const all = [];
    for (const m of sources || []) for (const item of m.items || []) all.push({ ...item, machineId: m.id, machineLabel: m.label, key: m.id + ':' + item.id });
    const open = all.filter((i) => !i.done);
    const byNew = (a, b) => b.created - a.created || (a.key < b.key ? -1 : 1);
    const needs = open.filter((i) => i.kind === 'need').sort(byNew);
    const reports = open.filter((i) => i.kind === 'report').sort(byNew);
    const done = all.filter((i) => i.done).sort((a, b) => b.doneAt - a.doneAt || (a.key < b.key ? -1 : 1));
    const unreadReports = reports.filter((i) => !i.readAt).length;
    return { needs, reports, done, counts: { need: needs.length, reports: reports.length, unreadReports, badge: needs.length + unreadReports } };
  }
  // Why a reply or tick did not go through, in words.
  function attentionFailure(result, name) {
    if (!result || result.failed) return `手机连不上 ${name}，这条没有发出去。草稿还在。`;
    if (result.timedOut) return `${name} 没有回应（可能在睡眠），这条没有发出去。草稿还在。`;
    if (result.status === 409 && result.body && typeof result.body.error === 'string' && result.body.error) {
      // The computer's own words point at its sidebar, which the phone does not have.
      if (result.body.error.startsWith('还没有队长')) return `${name} 上还没有队长。先到那台电脑的 AgentDeck 里创建队长，再回来回复。草稿还在。`;
      return result.body.error.slice(0, 200);
    }
    if (result.status === 401) return `${name} 的登录已失效，先在总览里重新登录。`;
    if (result.status === 403) return `${name} 的安全校验已过期，刷新页面后再试。`;
    if (result.status === 404) return `${name} 的 AgentDeck 版本太旧，还没有「待我处理」。`;
    if (result.status === 502) return `${name} 离线，这条没有发出去。`;
    return `${name} 没有接受（HTTP ${result.status}）。`;
  }
  return { cleanAttention, mergeAttention, attentionFailure };
});

// Reading text, for the desktop and the phone alike: the one Markdown renderer
// (Captain replies, receipts, 待我处理 details and previewed .md files), code
// colouring, what kind of file a name is, and the file paths and web links a
// text names. Everything that goes out as HTML is escaped here first; no tag
// or attribute in the output comes from the text itself.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) Object.assign(module.exports, api);
  else Object.assign(root.HubCore, api);
})(typeof self !== 'undefined' ? self : this, () => {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const isWide = (ch) => /[ᄀ-ᅟ⺀-鿿가-힣豈-﫿＀-｠￠-￦]/.test(ch);
  // What goes between two pieces of a line the terminal broke. It breaks at a
  // space when it can, so the space comes back unless both sides are Chinese
  // (a run cut at the right edge) or one of them is punctuation that sits tight.
  const TIGHT = /[\u2018-\u201f\u2026\u3000-\u303f\uff00-\uffef]/;
  function joinGap(before, after) {
    const a = String(before).slice(-1), b = String(after)[0] || '';
    return !a || !b || /\s/.test(a) || (isWide(a) && isWide(b)) || TIGHT.test(a) || TIGHT.test(b) ? '' : ' ';
  }
  const pipeRow = (cells) => '| ' + cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ') + ' |';
  const pipeTable = (rows, indent = '') => [pipeRow(rows[0]), '|' + rows[0].map(() => ' --- ').join('|') + '|', ...rows.slice(1).map(pipeRow)].map((l) => indent + l);

  // ---- what kind of file a name is ----
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
  function sizeText(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // ---- file paths and web links in a text ----
  // A path is taken only when it starts where files live (~/, /Users/, /tmp/,
  // C:\ …), so "/mac/api/relay" or "和/或" never turn into links. It ends at
  // white space, quotes, brackets and Chinese punctuation; a sentence's own
  // full stop or comma right after it is not part of it. "a.md:12" keeps its line.
  const STOP = '\\s\\u0000<>"\'`|*?，。；：、！？（）【】「」『』《》…';
  const URL_AT = new RegExp('https?://[^' + STOP.replace('?', '').replace('*', '') + ']+', 'gi');
  const PATH_AT = new RegExp('(?:~/|/(?:Users|home|tmp|private|var|opt|Volumes|Applications|Library|etc|usr|mnt|srv)/|[A-Za-z]:[\\\\/])[^' + STOP + ']*', 'g');
  const TAIL = /[.,;:!?)\]}>'"\\]+$/;
  function trimLink(text, url) {
    let out = text.replace(TAIL, (tail) => {
      // a closing bracket that pairs with one inside the link belongs to it
      const open = (text.match(/\(/g) || []).length, close = (text.match(/\)/g) || []).length;
      return url && tail[0] === ')' && close <= open ? tail[0] : '';
    });
    // "…/a.md里面写了": the name ends with its extension
    const glued = /^(.*?\.[A-Za-z0-9]{1,8})(?=[\u3400-\u9fff])/.exec(url ? '' : out);
    if (glued && !/[\\/]/.test(out.slice(glued[1].length))) out = glued[1];
    return out;
  }
  function findLinks(text) {
    const source = String(text == null ? '' : text), found = [];
    for (const m of source.matchAll(URL_AT)) {
      const value = trimLink(m[0], true);
      if (value.length > 10) found.push({ kind: 'url', text: value, start: m.index, end: m.index + value.length });
    }
    for (const m of source.matchAll(PATH_AT)) {
      const before = source[m.index - 1] || '';
      // in the middle of a word, a URL or a longer path: not the start of a path
      if (/[\w/.~:\\-]/.test(before) || found.some((f) => m.index >= f.start && m.index < f.end)) continue;
      const value = trimLink(m[0], false);
      const line = /:(\d+)(?::\d+)?$/.exec(value);
      const path = line ? value.slice(0, line.index) : value;
      // the root alone ("~/", "/tmp/", "C:\") names no file
      if (path.replace(/^(?:~|\/[A-Za-z]+|[A-Za-z]:)[\\/]?/, '').replace(/[\\/]+$/, '').length < 1 || path.length > 1024) continue;
      found.push({ kind: 'file', text: value, path, line: line ? Number(line[1]) : 0, start: m.index, end: m.index + value.length });
    }
    return found.sort((a, b) => a.start - b.start);
  }
  // Folder and name of a path as the page shows them; either slash.
  function splitPath(value) {
    const clean = String(value).replace(/[\\/]+$/, ''), cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    return { dir: cut > 0 ? clean.slice(0, cut) : clean.slice(0, cut + 1), name: clean.slice(cut + 1) || clean };
  }
  // A long path as a link shows its end: "…/agentdeck-1.8/review.md". The whole path stays in the tooltip.
  function shortPath(value, max = 40) {
    const text = String(value || '');
    if ([...text].length <= max) return text;
    const parts = text.split(/(?<=[\\/])/);
    let tail = parts.pop();
    while (parts.length && [...(parts[parts.length - 1] + tail)].length <= max - 2) tail = parts.pop() + tail;
    return '…/' + tail.replace(/^[\\/]+/, '');
  }
  // A link inside a previewed file, read against that file's folder: "../a.md", "shots/1.png".
  function resolvePath(base, target) {
    const value = String(target || '').trim().replace(/^file:\/\//i, '').replace(/[#?].*$/, '');
    if (!value) return '';
    if (/^(?:~[\\/]|\/|[A-Za-z]:[\\/])/.test(value)) return value;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
    const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
    const parts = base.split(/[\\/]/);
    for (const part of value.split(/[\\/]/)) {
      if (!part || part === '.') continue;
      if (part === '..') { if (parts.length > 1) parts.pop(); } else parts.push(part);
    }
    return parts.join(sep);
  }

  // ---- code colouring (small, generic, always escaped) ----
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

  // ---- a reply read off a terminal, as Markdown ----
  // The TUI already drew the agent's Markdown as plain rows, so the structure
  // is read back from their shape: a short line standing alone or right above a
  // list is a section title, rows of │ cells are a table, and "key: value"
  // records repeating the same keys (how the TUI draws a table too wide for it)
  // are a table again.
  const BOX_ROW = /^\s*│.*│\s*$/;
  const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const leading = (l) => /^ */.exec(l)[0].length;
  // A reply drawn two columns in keeps that indent on every row except the first
  // row of each paragraph (the shared rules trim it): take it off the rest too.
  function dedent(lines) {
    const inner = lines.filter((l, i) => l.trim() && i > 0 && lines[i - 1].trim());
    const cut = inner.length ? Math.min(...inner.map(leading)) : 0;
    return cut ? lines.map((l) => l.slice(Math.min(cut, leading(l)))) : lines;
  }
  const NOT_TITLE_END = /[。．.！!？?；;，,、：:…~～]$/;
  // opening: the reply's first line, where a short one is more often "好的" than a title
  function titleLike(line, aboveList, opening) {
    const t = line.trim(), n = [...t].length;
    if (n < (opening && !aboveList ? 4 : 2) || n > (aboveList ? 48 : 32)) return false;
    if (/^(?:[-*+•>|#│]|\d+[.)]\s|```|~~~)/.test(t) || NOT_TITLE_END.test(t)) return false;
    if (!/[A-Za-z一-鿿]/.test(t) || /^[^\s:：]{1,12}: \S/.test(t)) return false;
    if (/https?:\/\/|\w\/\w|[~.]?\/[\w.-]+\/|\.[A-Za-z]{1,5}(?:\s|$)|\\|`|\*\*/.test(t)) return false;   // a path, a file, code, or already styled
    if (/^[\x20-\x7e]+$/.test(t) && (!/^[A-Z0-9]/.test(t) || /[=$<>{}[\];|&]|--|\.\w{1,5}$/.test(t))) return false;   // a command, a file name
    return true;
  }
  // "│ a │ b │ │ c │ d │": rows the terminal drew, possibly glued onto one line.
  function boxRows(lines) {
    const rows = lines.flatMap((l) => l.trim().split('│ │')).map((r) => r.replace(/^\s*│?|│?\s*$/g, '').split('│').map((c) => c.trim()));
    return rows.length && rows[0].length > 1 && rows.every((r) => r.length === rows[0].length) ? pipeTable(rows) : null;
  }
  // "版本: 1.2.0 / Mac: 已装 / 版本: 1.2.1 / Mac: …": the first key repeats, every
  // record holds the same keys in the same order. A key is what the records
  // share right before each colon, so records glued together by reflow still split.
  function recordRows(lines) {
    const text = lines.join('\n');
    const lead = /^([^\s:：]{1,12}): /.exec(text);
    if (!lead) return null;
    const records = text.split(lead[1] + ': ').slice(1);
    if (records.length < 2) return null;
    const parts = records.map((r) => r.split(/: /));
    const count = parts[0].length;
    if (count < 2 || count > 8 || parts.some((p) => p.length !== count)) return null;
    const keys = [lead[1]];
    for (let k = 0; k < count - 1; k++) {
      // the longest ending the records share, without spaces
      const ends = parts.map((p) => /[^\s:：]{0,12}$/.exec(p[k])[0]);
      let key = ends[0];
      for (const e of ends) while (key && !e.endsWith(key)) key = key.slice(1);
      if (!key) return null;
      keys.push(key);
    }
    const rows = parts.map((p) => p.map((v, k) => (k < count - 1 ? v.slice(0, v.length - keys[k + 1].length) : v).replace(/\s+/g, ' ').trim()));
    return pipeTable([keys, ...rows]);
  }
  function tidyReply(text) {
    const lines = dedent(String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n'));
    const blocks = [];          // { lines, code } split on empty lines; a fenced block stays whole
    let cur = null, fence = false;
    for (const line of lines) {
      const mark = /^\s*(```|~~~)/.test(line);
      if (fence || mark) {
        if (!cur || !cur.code) blocks.push((cur = { lines: [], code: true }));
        cur.lines.push(line);
        if (mark) { fence = !fence; if (!fence) cur = null; }
      } else if (!line.trim()) cur = null;
      else { if (!cur) blocks.push((cur = { lines: [] })); cur.lines.push(line); }
    }
    return blocks.map((b, at) => {
      if (b.code) return b.lines.join('\n');
      const table = b.lines.every((l) => BOX_ROW.test(l)) ? boxRows(b.lines) : recordRows(b.lines);
      if (table) return table.join('\n');
      const aboveList = b.lines.length > 1 && LIST_ITEM.test(b.lines[1]);
      // right above a sentence too: the terminal only breaks a line that is full, so a short first line was meant as one
      const aboveText = b.lines.length > 1 && !aboveList && (NOT_TITLE_END.test(b.lines[1].trim()) || [...b.lines[1].trim()].length > 32);
      const title = (b.lines.length === 1 ? at < blocks.length - 1 : aboveList || aboveText) && titleLike(b.lines[0], aboveList, at === 0);
      return (title ? ['### ' + b.lines[0].trim(), ...b.lines.slice(1)] : b.lines).join('\n');
    }).join('\n\n');
  }

  // ---- Markdown ----
  // Text is escaped first and every tag is written here, so nothing in the
  // source can become markup. Pieces that must not be styled again (code, links,
  // escaped punctuation) are set aside behind a NUL-marked number and put back last.
  const SAFE_URL = /^(https?:\/\/|mailto:)/i;
  // next to Chinese text a star needs no space around it: "这是*重点*内容"
  const EM_BEFORE = '(^|[\\s(（“"「【：，。、\\u3400-\\u9fff])', EM_AFTER = '(?=[\\s).,;:!?，。；：、）”"」】\\u3400-\\u9fff]|$)';
  const EM_STAR = new RegExp(EM_BEFORE + '\\*([^*\\s][^*\\n]*)\\*' + EM_AFTER, 'g'), EM_BAR = new RegExp(EM_BEFORE + '_([^_\\s][^_\\n]*)_' + EM_AFTER, 'g');
  function inline(src, opts) {
    const held = [], links = !!(opts && opts.links);
    const hold = (html) => '\u0000' + (held.push(html) - 1) + '\u0000';
    let s = String(src).replace(/\u0000/g, '');
    s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
    s = s.replace(/\\([\\`*_{}[\]()#+.!|~>-])/g, (_, c) => hold(esc(c)));
    // a picture is named, not loaded: the page decides what opening it means
    s = s.replace(/!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g, (all, text, url) => {
      const label = text || url;
      if (SAFE_URL.test(url)) return hold(`<a href="${esc(url)}" data-ext="1">`) + label + hold('</a>');
      if (links && !/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^#/.test(url)) return hold(`<a data-file="${esc(url)}" data-rel="1">`) + label + hold('</a>');
      return label;
    });
    if (links) {
      // bare web links and file paths, as they stand in the text
      let out = '', last = 0;
      for (const link of findLinks(s)) {
        if (link.start < last) continue;
        const shown = esc(link.text);
        out += s.slice(last, link.start) + hold(link.kind === 'url' ? `<a href="${esc(link.text)}" data-ext="1">${shown}</a>`
          : `<a data-file="${esc(link.path)}"${link.line ? ` data-line="${link.line}"` : ''}>${shown}</a>`);
        last = link.end;
      }
      s = out + s.slice(last);
    }
    s = esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w\\])__([^_\n]+)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>').replace(EM_STAR, '$1<em>$2</em>').replace(EM_BAR, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
  }
  const TABLE_ROW = /^\s*\|.*\|\s*$/;
  const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
  // A header row and its |---| rule. While a reply is still being written the
  // rule may be half there, or not there yet: a row of cells that ends the text
  // is already drawn as a table, so it never shows as bars and dashes.
  function tableAt(lines, i) {
    if (!TABLE_ROW.test(lines[i])) return false;
    const next = lines[i + 1];
    if (next === undefined) return i === lines.length - 1 && lines[i].split('|').length > 3 && !TABLE_RULE.test(lines[i]);
    if (TABLE_RULE.test(next) && next.includes('|')) return true;
    return i + 1 === lines.length - 1 && /^\s*\|[\s:|-]*$/.test(next);
  }
  // A list from line `start`: items nest by their indent, an indented line that
  // is not an item continues the one above it (a terminal wraps long items that
  // way), and one empty line between two items does not end the list.
  function listAt(lines, start, opts) {
    const root = { lists: [] };
    const open = [];                 // lists being filled, outermost first
    const item = () => { const l = open[open.length - 1]; return l.items[l.items.length - 1]; };
    let i = start;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        if (LIST_ITEM.test(lines[i + 1] || '')) continue;
        break;
      }
      const m = LIST_ITEM.exec(line);
      const indent = /^\s*/.exec(line)[0].length;
      if (!m) {
        if (indent < 2 || /^\s*(#{1,6}\s|```|~~~|>)/.test(line) || tableAt(lines, i)) break;
        while (open.length && open[open.length - 1].indent >= indent) open.pop();
        if (!open.length) break;
        item().text.push(line.trim());
        continue;
      }
      const ordered = /\d/.test(m[2]);
      while (open.length && open[open.length - 1].indent > indent) open.pop();
      let list = open[open.length - 1];
      if (!list || list.indent < indent || list.ordered !== ordered) {
        if (list && list.indent === indent) open.pop();       // bullets turning into numbers start a list of their own
        list = { indent, ordered, first: ordered ? parseInt(m[2], 10) : 1, items: [] };
        (open.length ? item() : root).lists.push(list);
        open.push(list);
      }
      list.items.push({ text: [m[3].trim()], lists: [] });
    }
    // "- [ ] 待办" and "- [x] 做完的" keep their box as a mark in front
    const boxed = (text) => text.replace(/^\[( |x|X)\]\s+/, (_, mark) => (mark === ' ' ? '☐ ' : '☑ '));
    const render = (list) => {
      const tag = list.ordered ? 'ol' : 'ul';
      return `<${tag}${list.ordered && list.first !== 1 ? ` start="${list.first}"` : ''}>` + list.items.map((it) =>
        `<li>${inline(boxed(it.text.reduce((a, b) => a + joinGap(a, b) + b)), opts)}${it.lists.map(render).join('')}</li>`).join('') + `</${tag}>`;
    };
    return { html: root.lists.map(render).join('\n'), next: i };
  }
  // breaks: keep single newlines inside a paragraph (agent replies come from a
  // terminal, where a line break is usually meant).
  // links: web links and file paths in the text become links too (data-file
  // carries the path; the page decides what opening one means).
  function renderMarkdown(src, opts) {
    const breaks = !!(opts && opts.breaks);
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
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
        html.push(`<pre class="md-code"><code data-lang="${esc(fence[2])}">${highlightCode(body.join('\n'), lang)}</code></pre>`);
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { html.push(`<h${h[1].length}>${inline(h[2].replace(/\s+#+\s*$/, ''), opts)}</h${h[1].length}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        // a quote holding a list, a table or several paragraphs is laid out like any other text
        const plain = q.every((l) => l.trim() && !/^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|```|~~~|>|\|)/.test(l));
        html.push(`<blockquote>${plain ? (breaks ? q.map((l) => inline(l, opts)).join('<br>') : inline(q.join(' '), opts)) : renderMarkdown(q.join('\n'), opts)}</blockquote>`);
        continue;
      }
      if (tableAt(lines, i)) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
        const head = cells(line);
        const rule = TABLE_RULE.test(lines[i + 1] || '') ? cells(lines[i + 1]) : [];
        const side = head.map((_, k) => { const r = rule[k] || ''; return /^:-+:$/.test(r) ? ' class="al-c"' : /-:$/.test(r) ? ' class="al-r"' : ''; });
        i += lines[i + 1] === undefined ? 1 : 2;
        const rows = [];
        // the last row may still be on its way: it needs no closing bar
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        // wrapped so a wide table scrolls inside the text instead of stretching it
        html.push('<div class="md-table"><table><thead><tr>' + head.map((c, k) => `<th${side[k]}>${inline(c, opts)}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_, k) => `<td${side[k]}>${inline(r[k] || '', opts)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }
      if (LIST_ITEM.test(line)) {
        const list = listAt(lines, i, opts);
        html.push(list.html);
        i = list.next;
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !tableAt(lines, i)) para.push(lines[i++].trim());
      if (!para.length) { para.push(lines[i++]); }
      html.push(`<p>${breaks ? para.map((l) => inline(l, opts)).join('<br>') : inline(para.join(' '), opts)}</p>`);
    }
    return html.join('\n');
  }

  return { esc, isWide, joinGap, pipeTable, extOf, fileKind, languageFor, imageMime, sizeText, findLinks, splitPath, resolvePath, shortPath, highlightCode, tidyReply, renderMarkdown, BOX_ROW };
});

// 版本更新: release-notes.json at the repository root is the one file a release
// edits (what each version changed, what comes next). The desktop page and the
// phone hub read it through releaseNotes(), which keeps only well-formed
// entries, so a damaged file shows less instead of breaking the page.
// releaseProblems() names every rule a file breaks, for the unit test and the
// release script; releaseGap() is the release script's question: is the
// version being released written down as the newest one?
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) Object.assign(module.exports, api);
  else Object.assign(root.HubCore, api);
})(typeof self !== 'undefined' ? self : this, () => {
  const VERSION = /^[1-9]\d*\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
  const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
  // Each state is one of the shared status colours: green done, yellow at work, grey not started, orange needs the user.
  const ITEM_STATES = { done: '做完了', doing: '在做', planned: '计划', pending: '待你定' };
  const PLAN_STATES = { doing: '正在做', planned: '计划', later: '待排' };
  const LIMITS = { title: 30, item: 60, note: 120, suggestion: 40, released: [3, 6], upcoming: [1, 12] };
  const parts = (v) => typeof v === 'string' && VERSION.test(v) ? v.split('.').map(Number).concat(0).slice(0, 3) : null;
  function compareVersions(a, b) {
    const x = parts(a), y = parts(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  }
  const sameVersion = (a, b) => !!parts(a) && !!parts(b) && compareVersions(a, b) === 0;
  // How a release is named to people: 1.9.0 is 1.9, a patch keeps its third number.
  const versionLabel = (v) => { const p = parts(v); return p ? (p[2] ? p.join('.') : p[0] + '.' + p[1]) : ''; };
  const realDay = (s) => {
    const m = DAY.exec(typeof s === 'string' ? s : '');
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  };
  const shortDate = (s) => realDay(s) ? s.slice(5) : '';
  const text = (value, max) => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value) && value.trim() && value.trim().length <= max ? value.trim() : '';
  const list = (value) => Array.isArray(value) ? value : [];

  function releasedEntry(entry) {
    if (!entry || !parts(entry.version) || !realDay(entry.date) || !text(entry.title, LIMITS.title)) return null;
    const items = list(entry.items).map((item) => text(item, LIMITS.item)).filter(Boolean);
    return items.length ? { version: entry.version, date: entry.date, title: text(entry.title, LIMITS.title), items } : null;
  }
  function upcomingEntry(entry) {
    if (!entry || (entry.version !== '' && !parts(entry.version)) || !PLAN_STATES[entry.status] || !text(entry.title, LIMITS.title)) return null;
    const items = list(entry.items).filter((item) => item && ITEM_STATES[item.state] && text(item.text, LIMITS.item))
      .map((item) => ({ text: text(item.text, LIMITS.item), state: item.state, suggestion: text(item.suggestion, LIMITS.suggestion) }));
    return items.length ? { version: entry.version, status: entry.status, title: text(entry.title, LIMITS.title), note: text(entry.note, LIMITS.note), items } : null;
  }
  function releaseNotes(value) {
    if (!value || value.schema !== 1) return null;
    const released = list(value.released).map(releasedEntry).filter(Boolean);
    const upcoming = list(value.upcoming).map(upcomingEntry).filter(Boolean);
    return released.length || upcoming.length ? { updated: realDay(value.updated) ? value.updated : '', released, upcoming } : null;
  }

  function releaseProblems(value) {
    const problems = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ['不是一个 JSON 对象'];
    if (value.schema !== 1) problems.push('schema 必须是 1');
    if (!realDay(value.updated)) problems.push('updated 要写成 YYYY-MM-DD');
    const released = list(value.released), upcoming = list(value.upcoming);
    if (!released.length) problems.push('released 至少要有一版');
    released.forEach((entry, i) => {
      const name = `released[${i}]${entry && entry.version ? ' ' + entry.version : ''}`;
      if (!entry || !parts(entry.version)) { problems.push(`${name}：version 要写成 1.9 或 1.2.4`); return; }
      if (!realDay(entry.date)) problems.push(`${name}：date 要写成 YYYY-MM-DD`);
      if (!text(entry.title, LIMITS.title)) problems.push(`${name}：title 要有，最多 ${LIMITS.title} 字`);
      const items = list(entry.items);
      if (items.length < LIMITS.released[0] || items.length > LIMITS.released[1]) problems.push(`${name}：要写 ${LIMITS.released[0]}–${LIMITS.released[1]} 条`);
      items.forEach((item, k) => { if (!text(item, LIMITS.item)) problems.push(`${name} 第 ${k + 1} 条：一句话，最多 ${LIMITS.item} 字`); });
      const prev = released[i - 1];
      if (prev && parts(prev.version)) {
        if (compareVersions(entry.version, prev.version) >= 0) problems.push(`${name}：版本要从新到旧排，比上一条 ${prev.version} 旧`);
        if (realDay(prev.date) && realDay(entry.date) && entry.date > prev.date) problems.push(`${name}：日期不能比更新的 ${prev.version} 晚`);
      }
    });
    const latest = released.find((entry) => entry && parts(entry.version));
    let lastNumbered = latest ? latest.version : null, unnumbered = false;
    upcoming.forEach((entry, i) => {
      const name = `upcoming[${i}]${entry && entry.version ? ' ' + entry.version : ''}`;
      if (!entry || (entry.version !== '' && !parts(entry.version))) { problems.push(`${name}：version 写版本号，还没排进版本的写空字符串`); return; }
      if (entry.version) {
        if (unnumbered) problems.push(`${name}：有版本号的排在「还没排进哪一版」前面`);
        if (latest && compareVersions(entry.version, latest.version) <= 0) problems.push(`${name}：${entry.version} 已经发布了，从 upcoming 里删掉`);
        else if (lastNumbered && compareVersions(entry.version, lastNumbered) <= 0) problems.push(`${name}：接下来的版本要从近到远排`);
        lastNumbered = entry.version;
      } else unnumbered = true;
      if (!PLAN_STATES[entry.status]) problems.push(`${name}：status 只能是 ${Object.keys(PLAN_STATES).join(' / ')}`);
      if (!text(entry.title, LIMITS.title)) problems.push(`${name}：title 要有，最多 ${LIMITS.title} 字`);
      if (entry.note !== undefined && !text(entry.note, LIMITS.note)) problems.push(`${name}：note 最多 ${LIMITS.note} 字`);
      const items = list(entry.items);
      if (items.length < LIMITS.upcoming[0] || items.length > LIMITS.upcoming[1]) problems.push(`${name}：要写 ${LIMITS.upcoming[0]}–${LIMITS.upcoming[1]} 条`);
      items.forEach((item, k) => {
        const where = `${name} 第 ${k + 1} 条`;
        if (!item || !text(item.text, LIMITS.item)) problems.push(`${where}：text 一句话，最多 ${LIMITS.item} 字`);
        if (!item || !ITEM_STATES[item.state]) problems.push(`${where}：state 只能是 ${Object.keys(ITEM_STATES).join(' / ')}（用户还没拍板的写 pending）`);
        if (item && item.suggestion !== undefined && !text(item.suggestion, LIMITS.suggestion)) problems.push(`${where}：suggestion 最多 ${LIMITS.suggestion} 字`);
      });
    });
    return problems;
  }
  // The release script stops on any answer: the file must be valid and its newest release must be this one.
  function releaseGap(value, version) {
    const problems = releaseProblems(value);
    if (problems.length) return `release-notes.json 有问题：${problems.slice(0, 5).join('；')}`;
    const latest = value.released[0];
    if (!sameVersion(latest.version, version)) {
      return `release-notes.json 最新一版是 ${latest.version}，还没写 ${versionLabel(version)} 的更新内容：先在 released 最前面加上这一版（日期、标题、3–6 条大白话），并把它从 upcoming 里拿掉，再发版`;
    }
    return '';
  }
  // What a copy button puts on the clipboard: plain text anyone can paste anywhere.
  function releaseText(entry) {
    if (!entry) return '';
    if (entry.date) return [`AgentDeck ${entry.version}（${entry.date}）${entry.title}`, ...entry.items.map((item) => '- ' + item)].join('\n');
    const head = entry.version ? `AgentDeck ${entry.version}（${PLAN_STATES[entry.status]}）${entry.title}` : entry.title;
    return [head, ...(entry.note ? [entry.note] : []), ...entry.items.map((item) => `- [${ITEM_STATES[item.state]}] ${item.text}${item.suggestion ? `（${item.suggestion}）` : ''}`)].join('\n');
  }
  const pendingCount = (notes) => notes ? notes.upcoming.reduce((n, entry) => n + entry.items.filter((item) => item.state === 'pending').length, 0) : 0;

  return { ITEM_STATES, PLAN_STATES, compareVersions, sameVersion, versionLabel, shortDate, releaseNotes, releaseProblems, releaseGap, releaseText, pendingCount };
});
