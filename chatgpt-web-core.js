(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatGPTWebCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Same credential guard as the existing skill, before tasks enter config/chat.
  // The Captain must still review questions for personal information.
  const CREDENTIAL = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bBearer\s+[A-Za-z0-9._~-]{20,}|(?:api[_ -]?key|password|secret|密码|密钥|cookie|session[_ -]?token|access[_ -]?token)\s*[:=]\s*["']?\S{8,})/i;
  function validatePublicTask(task) {
    if (typeof task !== 'string' || !task.trim() || task.length > 2_000_000) throw new Error('网页调研问题为空或过长。');
    if (CREDENTIAL.test(task)) throw new Error('问题疑似含凭据，已阻止保存和发送；请队长去掉敏感内容，只派公开调研。');
    return task;
  }
  function summary(markdown) {
    if (CREDENTIAL.test(String(markdown))) throw new Error('报告疑似含凭据，未写入回执；请本地检查报告。');
    const body = String(markdown);
    const conclusion = body.match(/^#{1,6}[^\n]*(?:结论|总结|核心发现|要点|conclusion|summary|key findings)[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im);
    const text = (conclusion?.[1] || body).replace(/^> 实际(?:模型\/档位|模式)：.*\n/gm, '')
      .replace(/^#{1,6}\s+.*$/gm, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*`_]/g, '').trim();
    if (!text || CREDENTIAL.test(text)) throw new Error('报告摘要为空或疑似含凭据，未写入回执；请本地检查报告。');
    return '结论摘要（报告摘录）：' + text.slice(0, 900);
  }
  // ---- what the dispatch picker in 队长's composer shows ----
  const MODES = Object.freeze([
    Object.freeze({ id: 'chat', label: '普通', detail: '6 Pro，最多等 30 分钟' }),
    Object.freeze({ id: 'deep-research', label: 'Deep Research', detail: '深度研究，最多等 60 分钟' }),
  ]);
  const LABEL = '网页版 ChatGPT';
  const PUBLIC_NOTICE = '仅用于公开调研：任务内容会发到 ChatGPT 网页，不要包含密钥、隐私或内部信息。';
  const NO_SEAT_NOTE = '走本机已登录的 ChatGPT 网页，不占 Claude 席位，也不能改启动命令。';
  const modeLabel = (mode) => (MODES.find((m) => m.id === mode) || MODES[0]).label;
  // The card title is the question's first line, cut to fit a card.
  function titleFor(text) {
    const line = String(text || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    return line.length > 40 ? line.slice(0, 39) + '…' : line;
  }
  // Web requests run one at a time on this machine: how many are already out.
  function busyCount(tasks, columns) {
    const web = new Set((columns || []).filter((c) => c && c.executor === 'chatgpt-web').map((c) => c.id));
    return (tasks || []).filter((t) => t && web.has(t.colId) && t.status === 'working').length;
  }
  // A web task is 'working' from the moment it is handed to the executor; the
  // executor's phase says whether the page has actually been opened for it.
  const isQueued = (task) => !!task && task.status === 'working' && task.webPhase === 'queued';
  function dispatchResult(busy) {
    return busy > 0 ? `排队中：前面还有 ${busy} 件网页调研，轮到它才会发到 ChatGPT 网页。` : `已派给${LABEL}。`;
  }
  return { validatePublicTask, summary, MODES, LABEL, PUBLIC_NOTICE, NO_SEAT_NOTE, modeLabel, titleFor, busyCount, isQueued, dispatchResult };
});
