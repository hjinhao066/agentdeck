// Pure helpers behind 队长 (Captain), the main session: the instructions it starts
// with, the receipt contract appended to work it hands out, reading a receipt
// back out of a finished reply, and the short ledger it sees. No DOM, no
// Electron: runs in the page and in tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MainCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SUMMARY = 400;
  const MAX_FAILURE = 240;
  const MAX_FILES = 10;
  const MAX_PATH = 500;
  const STATUS = { plain: '未开始', working: '干活中', input: '等你回复', done: '已完成', exited: '已退出' };
  const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

  const oneLine = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

  // Appended by the app to every instruction 队长 hands out. Workers do the
  // work without waiting on the user; a question goes to 队长, not the user.
  const RECEIPT_CONTRACT = [
    '',
    '---',
    '（AgentDeck 约定）这是队长派给你的活：直接干完，不要停下来等用户确认。',
    '拿不准、需要别人拍板时，在最终回复的最后单独写下面两行，然后停下，队长会回复你：',
    '【提问】',
    '问题：一两句话说清要队长决定什么',
    '做完或做不下去时，在最终回复的最后单独写：',
    '【回执】',
    '摘要：一到三句话说清结果',
    '文件：每行一个落盘文件的完整路径，没有就写 无',
    '失败：没做成时写一两句原因，做成了就不写这一行',
    '回执里不要贴文件正文。',
  ].join('\n');

  function instructions() {
    const cli = 'node "$AGENTDECK_BOARD_CLI"';
    return [
      '你是 AgentDeck 的「队长」：常驻的总负责人。你听懂用户要什么，把活派给各个会话（deck 里的列，也就是你的队员），再把简短回执告诉用户。',
      '',
      '规则：',
      '1. 不要在这一列里改文件、跑任务或写实现过程。实际工作都交给别的会话。',
      '2. 只用下面这些终端命令和别的会话打交道：',
      `   ${cli} ledger                          列出全部会话：id、标题、状态、最近回执`,
      `   ${cli} new --title "一句话标题" --task "任务正文" [--cwd 目录] [--agent claude|agy|grok]   新开一个会话并把任务作为它的第一条消息；不写 --agent 就用和你一样的 agent`,
      `   ${cli} tell --to 会话id --message "指令"   把指令发进已有的会话`,
      `   ${cli} read --id 会话id [--turns 3]       读某个会话已保存的对话，只在用户追问细节时用`,
      `   ${cli} receipts                        取回还没看过的回执`,
      `   ${cli} answer --to 会话id --key y|n|1|2|3|enter|esc   回答停在确认或权限提示上的会话`,
      '3. 一件新事用 new。交给已有的会话、或者同一件活的补充和修改，用 tell 发回正在做这件事的那个会话，只转发新指令，不要把文件正文再贴一遍。',
      '4. 用户一条消息里有几件互不依赖的事，拆开，分别交给不同的会话。',
      '5. 用户没点名目录时不要传 --cwd；点名了就传那个目录。',
      '6. 派完马上用一两句话告诉用户交给了哪个会话，不要等结果；用户可以接着派活。',
      '7. 队员的回执和提问会自动发给你（以【AgentDeck 新回执】开头）。看完用一两句话告诉用户结果；需要接着做的，直接派下去。回答用几句话，不要把别的会话的全文、长日志或文件正文搬进来。',
      '8. 队员向你提问、或停在确认/权限提示时，你来拿主意：有把握就用 tell 或 answer 回复它，让它接着干；没把握，或者涉及删除数据、花钱、对外发布这类不可逆的事，再请用户决定，并说清要用户决定什么。',
      '',
      '现在只回复一句「队长已就绪」，然后等用户的指令。',
    ].join('\n');
  }

  // Reads the 【回执】 block the worker wrote at the end of its reply. Without
  // one, falls back to the reply's last lines and any file paths in it, and
  // says so: a quiet screen is not proof the task succeeded.
  function parseReceipt(reply, findFiles) {
    // a reply is reflowed for the bubble, which can glue 摘要 and 文件 onto
    // one line: put every field label back at the start of its own line
    const text = String(reply || '').replace(/\r\n?/g, '\n')
      .replace(/([^\n])\s*(摘要|文件|失败)\s*[:：]/g, '$1\n$2：');
    const at = Math.max(text.lastIndexOf('【回执】'), text.lastIndexOf('[回执]'));
    const out = { summary: '', files: [], images: [], failed: '', question: '', explicit: at >= 0 };
    // 【提问】 after the last 【回执】 (or with none): the worker is waiting on 队长
    const ask = Math.max(text.lastIndexOf('【提问】'), text.lastIndexOf('[提问]'));
    if (ask > at) {
      const q = /(?:问题|question)\s*[:：]\s*([\s\S]*)$/i.exec(text.slice(ask));
      out.question = oneLine(q ? q[1] : text.slice(ask + 4), MAX_SUMMARY);
      out.explicit = true;
    }
    const addFile = (p) => {
      const f = String(p || '').trim().replace(/^[`'"]+|[`'"，。,;；]+$/g, '').slice(0, MAX_PATH);
      if (!f || f === '无' || /^(none|n\/a|-)$/i.test(f) || out.files.includes(f) || out.files.length >= MAX_FILES) return;
      out.files.push(f);
    };
    if (at >= 0) {
      let field = '';
      for (const raw of text.slice(at).split('\n').slice(1)) {
        const line = raw.trim();
        if (!line) continue;
        const m = /^(摘要|文件|失败|summary|files?|failed|failure)\s*[:：]\s*(.*)$/i.exec(line);
        if (m) {
          field = /^(摘要|summary)$/i.test(m[1]) ? 'summary' : /^(失败|failed|failure)$/i.test(m[1]) ? 'failed' : 'files';
          if (field === 'files') m[2].split(/[,，;；\s]+(?=~?[\\/]|[A-Za-z]:[\\/])/).forEach(addFile);
          else out[field] = (out[field] ? out[field] + ' ' : '') + m[2];
          continue;
        }
        if (field === 'files') addFile(line.replace(/^[-*•]\s*/, ''));
        else if (field) out[field] += ' ' + line;
      }
    } else {
      const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      out.summary = paras.slice(-2).join(' ');
      if (findFiles) findFiles(text).forEach(addFile);
    }
    out.summary = oneLine(out.summary, MAX_SUMMARY);
    out.failed = oneLine(out.failed, MAX_FAILURE);
    // the contract's own placeholder lines, if the prompt echo slipped through
    if (out.summary === '一到三句话说清结果') { out.summary = ''; out.explicit = false; }
    if (out.question === '一两句话说清要队长决定什么') out.question = '';
    if (/^没做成时写/.test(out.failed)) out.failed = '';
    out.images = out.files.filter((f) => IMAGE.test(f.replace(/:\d+(?::\d+)?$/, '')));
    return out;
  }

  // What the model sees about new receipts, prepended to the user's next message.
  function receiptsForModel(items) {
    if (!items.length) return '';
    const lines = items.map((r) => {
      if (r.question) return `- 「${oneLine(r.title, 60)}」(${r.colId}) 向你提问：${r.question}`;
      if (r.waiting) return `- 「${oneLine(r.title, 60)}」(${r.colId}) 停在确认提示上：\n${r.waiting.split('\n').map((l) => '    ' + l).join('\n')}`;
      const parts = [`- 「${oneLine(r.title, 60)}」(${r.colId})：${r.failed ? '没做成，' + r.failed : r.summary || '已停下，没有写回执'}`];
      if (r.files && r.files.length) parts.push(`  文件：${r.files.join('；')}`);
      return parts.join('\n');
    });
    return '【AgentDeck 新回执】\n' + lines.join('\n') + '\n\n';
  }

  function statusLabel(state) { return STATUS[state] || STATUS.plain; }

  // node-pty reports the foreground process as a bare name ("zsh", "-zsh")
  // on macOS but can fall back to the shell's full path ("/bin/zsh").
  const SHELL_NAMES = /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|csh|nu|pwsh|powershell|cmd)(\.exe)?$/i;
  function isShellProcess(name) {
    const base = String(name || '').trim().replace(/^.*[\\/]/, '');
    return !base || SHELL_NAMES.test(base);
  }

  // One compact line per session for `ledger`.
  function ledgerText(rows) {
    if (!rows.length) return '还没有别的会话。';
    return rows.map((r) => {
      let line = `${r.id}  「${oneLine(r.title, 60)}」  ${statusLabel(r.state)}`;
      if (r.folder) line += `  文件夹:${oneLine(r.folder, 30)}`;
      if (r.receipt) line += `\n    回执：${r.receipt.failed ? '没做成，' + r.receipt.failed : r.receipt.summary || '已停下，没有写回执'}` +
        (r.receipt.files && r.receipt.files.length ? `\n    文件：${r.receipt.files.join('；')}` : '');
      return line;
    }).join('\n');
  }

  // A session's saved turns for `read`, newest last, each cut short.
  function readText(title, turns, n) {
    const count = Math.max(1, Math.min(10, Math.round(Number(n) || 3)));
    const picked = turns.filter((t) => t.kind !== 'task').slice(-count);
    if (!picked.length) return `「${title}」还没有保存的对话。`;
    return picked.map((t) => `用户：${oneLine(t.user, 600)}\n回复：${oneLine(t.reply, 800) || '（没有文字回复）'}`).join('\n\n');
  }

  return { RECEIPT_CONTRACT, STATUS, isShellProcess, instructions, parseReceipt, receiptsForModel, statusLabel, ledgerText, readText, MAX_SUMMARY };
});
