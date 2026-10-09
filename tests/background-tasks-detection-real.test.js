'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../main-core');

test('claudeBackgroundTasks detects truncated shell indicator in narrow columns', () => {
  // Real case: narrow column cuts off the footer, leaving "1 she" instead of "1 shells"
  const screen1 = '❯ \n────────\n  ⏵⏵ bypass permissions on · 1 she';
  // Currently fails because regex requires complete word, should pass after fix
  assert.ok(M.claudeBackgroundTasks(screen1, 'claude'), 'should detect truncated "1 she" as background task');
});

test('claudeBackgroundTasks detects "Waiting for N background agent(s)" pattern', () => {
  // Real case: status line shows agents waiting without "still running"
  const screen1 = '❯ previous output\n✻ Waiting for 1 background agent to finish';
  assert.ok(M.claudeBackgroundTasks(screen1, 'claude'), 'should detect "Waiting for 1 background agent"');

  const screen2 = '❯ \n────────\n✻ Waiting for 2 background agents to finish';
  assert.ok(M.claudeBackgroundTasks(screen2, 'claude'), 'should detect "Waiting for 2 background agents"');
});

test('claudeBackgroundTasks detects truncated monitor indicator', () => {
  // Similar truncation for monitors
  const screen = '❯ \n  some output\n  2 mon';
  assert.ok(M.claudeBackgroundTasks(screen, 'claude'), 'should detect truncated "2 mon"');
});

test('claudeBackgroundTasks still rejects non-Claude terminals', () => {
  const screen = '❯ \n────────\n  ⏵⏵ some task · 1 mon';
  assert.ok(!M.claudeBackgroundTasks(screen, 'bash'), 'non-claude command should return false');
});
