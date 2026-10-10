'use strict';
// How a pasted line is cut into arguments, for the two shells the Captain's terminal can be: enough of the quoting
// rules to tell whether a command line is ONE statement whose arguments are exactly what was meant (used by the
// tests of the commands AgentDeck hands the Captain). Nothing is run.

// POSIX sh: '…' is literal, "…" is literal here (only constants use it), a backslash outside quotes takes the next char.
function splitPosix(line) {
  const words = [];
  let word = null, i = 0;
  const unquoted = [];
  const text = String(line);
  while (i < text.length) {
    const c = text[i];
    if (word === null && /\s/.test(c)) { i++; continue; }
    if (/\s/.test(c)) { words.push(word); word = null; i++; continue; }
    if (word === null) word = '';
    if (c === "'") { const end = text.indexOf("'", i + 1); if (end < 0) throw new Error('unterminated single quote'); word += text.slice(i + 1, end); i = end + 1; continue; }
    if (c === '"') { const end = text.indexOf('"', i + 1); if (end < 0) throw new Error('unterminated double quote'); word += text.slice(i + 1, end); i = end + 1; continue; }
    if (c === '\\') { word += text[i + 1] || ''; i += 2; continue; }
    if (/[;|&<>()`$#]/.test(c)) unquoted.push(c);
    word += c; i++;
  }
  if (word !== null) words.push(word);
  return { words, unquoted };
}

// PowerShell: '…' ends at the first single-quote character (' ‘ ’ ‚ ‛) that is not doubled; "…" is literal here (constants only).
const PS_SINGLE = /['‘’‚‛]/;
function splitPowerShell(line) {
  const words = [];
  let word = null, i = 0;
  const unquoted = [];
  const text = String(line);
  while (i < text.length) {
    const c = text[i];
    if (word === null && /\s/.test(c)) { i++; continue; }
    if (/\s/.test(c)) { words.push(word); word = null; i++; continue; }
    if (word === null) word = '';
    if (PS_SINGLE.test(c)) {
      i++;
      for (;;) {
        if (i >= text.length) throw new Error('unterminated single quote');
        if (PS_SINGLE.test(text[i])) {
          if (PS_SINGLE.test(text[i + 1] || '')) { word += text[i]; i += 2; continue; }   // a doubled quote character is itself
          i++; break;
        }
        word += text[i++];
      }
      continue;
    }
    if (c === '"') { const end = text.indexOf('"', i + 1); if (end < 0) throw new Error('unterminated double quote'); word += text.slice(i + 1, end); i = end + 1; continue; }
    if (/[;|&<>(){}`#“”„]/.test(c)) unquoted.push(c);
    word += c; i++;
  }
  if (word !== null) words.push(word);
  return { words, unquoted };
}

// The `new` command's flags as board-cli would read them: { 'task-id': …, title: …, … } and the words before `new`.
function flagsOfNew(words) {
  const at = words.indexOf('new');
  if (at < 0) throw new Error('no new command');
  const flags = {};
  for (let i = at + 1; i < words.length; i += 2) {
    if (!/^--[a-z-]+$/.test(words[i])) throw new Error('not a flag: ' + words[i]);
    flags[words[i].slice(2)] = words[i + 1];
  }
  return { before: words.slice(0, at), flags };
}

module.exports = { splitPosix, splitPowerShell, flagsOfNew };
