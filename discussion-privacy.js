'use strict';
const os = require('os');
const crypto = require('crypto');

function hash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function escape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Every outbound packet (including new model prose) passes here. Mappings stay
// in the private run, never in the outbound text or the event log.
function redact(text, options = {}) {
  if (typeof text !== 'string') throw new Error('Discussion input must be text.');
  const mapping = options.mapping || {};
  const findings = [];
  function replace(pattern, category) {
    text = text.replace(pattern, (value) => {
      const key = `${category}:${value}`;
      if (!mapping[key]) mapping[key] = `[${category}-${Object.keys(mapping).filter((k) => k.startsWith(`${category}:`)).length + 1}]`;
      findings.push(category);
      return mapping[key];
    });
  }
  replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/g, '凭据');
  replace(/^.*(?:authorization[\"']?\s*:|cookie[\"']?\s*:|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|client[_-]?secret)[\"']?\s*[:=]).*$/gim, '凭据');
  replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/g, '凭据');
  replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, '凭据');
  replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '凭据');
  replace(/https?:\/\/[^\s<>()"']*[?&](?:token|key|secret|password|auth)=[^\s<>()"']*/gi, '凭据');
  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '邮箱');
  replace(/(?:\/(?:Users|home)\/[^\s/\\]+|[A-Z]:[\\/]Users[\\/][^\s/\\]+)/gi, '用户目录');
  replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, 'IP');
  replace(/\b(?:[a-f\d]{1,4}:){2,}[a-f\d:]*\b/gi, 'IP');
  replace(/(?<![\w:])::(?:[a-f\d]{1,4}:)*[a-f\d]{0,4}(?![\w:])/gi, 'IP');
  replace(/https?:\/\/[^\s<>()"']+/gi, '网址');
  replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?!(?:md|js|ts|json|txt|yaml|yml|py|cpp|css|html|sh)\b)[a-z]{2,63}(?::\d+)?\b/gi, '域名');
  replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '会话');
  replace(/\b(?:session[ _-]?id|conversation[ _-]?id|thread[ _-]?id|会话\s*id)\s*["']?\s*[:=]\s*["']?[^\s,"';，；。]+/gi, '会话');
  replace(/(?:\b(?:user[ _-]?name|login[ _-]?name)|用户名)\s*["']?\s*[:=：]\s*["']?[^\s,"';，；。]+/gi, '身份');
  for (const value of [...new Set([os.userInfo().username, ...(options.usernames || []), ...(options.sessionIds || [])])]) {
    if (typeof value === 'string' && value.length >= 2) replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escape(value)}(?![\\p{L}\\p{N}_])`, 'giu'), '身份');
  }
  return { text, hash: hash(text), mapping, findings: [...new Set(findings)] };
}
function anonymize(text) {
  return text.replace(/^\s*(?:>\s*)?(?:实际模型\/档位|模型|Model|作者|Author|Provider)\s*[:：].*\r?\n/gim, '')
    .replace(/(?:我是|我作为|I am|As)\s*(?:Claude(?:\s+Opus)?|ChatGPT|Gemini|Codex|OpenAI|Anthropic)(?:\s+\d[\w. -]*)?[,，。:]?/gi, '作为参与者');
}
module.exports = { redact, anonymize, hash };
