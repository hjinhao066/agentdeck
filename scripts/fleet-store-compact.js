#!/usr/bin/env node
'use strict';
// Compact a fleet hub file too large for the hub to load (Node reads at most
// 0x1fffffe8 characters into one string; the live hub reached 608 MB on
// 2026-10-09). The file is read as bytes and walked entry by entry, so no part
// of it has to fit in one string. Each receipt that copied a whole transcript or
// card becomes one naming it, transcript copies kept only because a
// dispatch card's state moved are dropped, and a version a later save rewrote keeps
// only the turns rewritten: the same rules the hub applies when it loads a file it
// can read (shared-store.js). Cards, devices and transcripts are kept as they are.
// The input is only read, and an existing output file is never replaced.
//
//   node scripts/fleet-store-compact.js <old store.json> <new store.json>
const fs = require('fs');
const path = require('path');
const { SharedStore, compactReceipt, compactHistory } = require('../shared-store');

const QUOTE = 0x22, SLASH = 0x5c, OPEN = 0x7b, CLOSE = 0x7d, LIST = 0x5b, LIST_END = 0x5d, COLON = 0x3a, COMMA = 0x2c;
const space = (byte) => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;

function skipSpace(buf, pos) {
  while (pos < buf.length && space(buf[pos])) pos++;
  return pos;
}
// The end (exclusive) of the string starting at pos. UTF-8 continuation bytes are
// all >= 0x80, so a quote or backslash byte is always that character.
function stringEnd(buf, pos) {
  for (let i = pos + 1; i < buf.length; i++) {
    if (buf[i] === SLASH) i++;
    else if (buf[i] === QUOTE) return i + 1;
  }
  throw new Error('Unterminated string at byte ' + pos);
}
// The end (exclusive) of the JSON value starting at pos.
function valueEnd(buf, pos) {
  const first = buf[pos];
  if (first === QUOTE) return stringEnd(buf, pos);
  if (first === OPEN || first === LIST) {
    let depth = 0;
    for (let i = pos; i < buf.length; i++) {
      const byte = buf[i];
      if (byte === QUOTE) i = stringEnd(buf, i) - 1;
      else if (byte === OPEN || byte === LIST) depth++;
      else if (byte === CLOSE || byte === LIST_END) { if (--depth === 0) return i + 1; }
    }
    throw new Error('Unterminated value at byte ' + pos);
  }
  let i = pos;
  while (i < buf.length && buf[i] !== COMMA && buf[i] !== CLOSE && buf[i] !== LIST_END && !space(buf[i])) i++;
  return i;
}
// [key, start, end] of each member of the object at buf[start..end).
function* members(buf, start, end) {
  if (buf[start] !== OPEN) throw new Error('Expected an object at byte ' + start);
  let pos = skipSpace(buf, start + 1);
  if (buf[pos] === CLOSE) return;
  while (pos < end) {
    if (buf[pos] !== QUOTE) throw new Error('Expected a key at byte ' + pos);
    const keyEnd = stringEnd(buf, pos);
    const key = JSON.parse(buf.toString('utf8', pos, keyEnd));
    pos = skipSpace(buf, keyEnd);
    if (buf[pos] !== COLON) throw new Error('Expected ":" at byte ' + pos);
    const from = skipSpace(buf, pos + 1);
    const to = valueEnd(buf, from);
    yield [key, from, to];
    pos = skipSpace(buf, to);
    if (buf[pos] === CLOSE) return;
    if (buf[pos] !== COMMA) throw new Error('Expected "," at byte ' + pos);
    pos = skipSpace(buf, pos + 1);
  }
  throw new Error('Unterminated object at byte ' + start);
}
const parse = (buf, from, to) => JSON.parse(buf.toString('utf8', from, to));

function compact(buf, now = Date.now()) {
  const start = skipSpace(buf, 0);
  const data = {};
  const stats = { ops: 0, receiptsShrunk: 0, history: 0, copiesBefore: 0, copiesAfter: 0 };
  const at = new Date(now).toISOString();
  for (const [key, from, to] of members(buf, start, valueEnd(buf, start))) {
    if (key === 'ops') {
      const ops = Object.create(null);
      for (const [id, a, b] of members(buf, from, to)) {
        const saved = parse(buf, a, b);
        stats.ops++;
        const body = saved && saved.body;
        if (body && (body.record || body.card)) stats.receiptsShrunk++;
        ops[id] = compactReceipt(saved, at);
      }
      data.ops = ops;
    } else if (key === 'history') {
      const history = Object.create(null);
      for (const [id, a, b] of members(buf, from, to)) {
        const record = parse(buf, a, b);
        stats.history++;
        const kept = record && typeof record === 'object' ? compactHistory(record) : record;
        stats.copiesBefore += Array.isArray(record && record.alternatives) ? record.alternatives.length : 0;
        stats.copiesAfter += Array.isArray(kept && kept.alternatives) ? kept.alternatives.length : 0;
        history[id] = kept;
      }
      data.history = history;
    } else {
      data[key] = parse(buf, from, to);
    }
  }
  if (data.version !== 1 || !data.devices || !data.cards || !data.history) throw new Error('Not a version 1 fleet hub file.');
  stats.cards = Object.keys(data.cards).length;
  stats.devices = Object.keys(data.devices).length;
  return { data, stats };
}

function main(args) {
  const [input, output] = args;
  if (!input || !output) {
    console.error('Usage: node scripts/fleet-store-compact.js <old store.json> <new store.json>');
    return 2;
  }
  if (path.resolve(input) === path.resolve(output)) { console.error('The new file must be a different file.'); return 2; }
  const buf = fs.readFileSync(input);
  const { data, stats } = compact(buf);
  const text = JSON.stringify(data);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, text, { flag: 'wx', mode: 0o600 });
  // The hub must load what was written, with nothing left for it to change.
  const check = new SharedStore({ file: output });
  if (Object.keys(check.data.cards).length !== stats.cards || Object.keys(check.data.history).length !== stats.history) {
    throw new Error('The new file does not load with the same cards and transcripts.');
  }
  console.log(JSON.stringify({ input: path.resolve(input), output: path.resolve(output), bytesBefore: buf.length, bytesAfter: Buffer.byteLength(text), ...stats }));
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error('fleet-store-compact: ' + error.message); process.exitCode = 1; }
}

module.exports = { compact, members, main };
