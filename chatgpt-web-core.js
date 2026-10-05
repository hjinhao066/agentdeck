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
  return { validatePublicTask, summary };
});
