const test = require('node:test');
const assert = require('node:assert/strict');
const AgentInfo = require('../agent-info.js');
const firstId = '11111111-1111-4111-8111-111111111111';
const nextId = '22222222-2222-4222-8222-222222222222';

test('prepareAgentCommand: Claude and Grok session binding', () => {
  // First launch
  assert.equal(AgentInfo.prepareAgentCommand('claude', 'Claude', 'uuid-1', false), 'claude --session-id uuid-1');
  assert.equal(AgentInfo.prepareAgentCommand('claude -p', 'Claude', 'uuid-2', false), 'claude --session-id uuid-2 -p');
  
  // Grok first launch
  assert.equal(AgentInfo.prepareAgentCommand('grok', 'Grok', 'uuid-g1', false), 'grok -s uuid-g1');
  assert.equal(AgentInfo.prepareAgentCommand('grok --temp 0', 'Grok', 'uuid-g2', false), 'grok -s uuid-g2 --temp 0');

  // Resume (cold restart)
  assert.equal(AgentInfo.prepareAgentCommand('claude', 'Claude', 'uuid-1', true), 'claude --resume uuid-1');
  assert.equal(AgentInfo.prepareAgentCommand('claude -p', 'Claude', 'uuid-2', true), 'claude --resume uuid-2 -p');
  
  assert.equal(AgentInfo.prepareAgentCommand('grok', 'Grok', 'uuid-g1', true), 'grok -r uuid-g1');
  
  // Non-matching providers shouldn't be altered
  assert.equal(AgentInfo.prepareAgentCommand('cursor-agent', 'Cursor', 'uuid-3', false), 'cursor-agent');
  assert.equal(AgentInfo.prepareAgentCommand('agy', 'Antigravity', 'uuid-4', true), 'agy');

  // If user already specified session args, it shouldn't inject duplicate
  assert.equal(AgentInfo.prepareAgentCommand('claude --session-id my-id', 'Claude', 'uuid-5', false), 'claude --session-id my-id');
  assert.equal(AgentInfo.prepareAgentCommand('claude -s my-id', 'Claude', 'uuid-5', false), 'claude -s my-id');
  assert.equal(AgentInfo.prepareAgentCommand('claude --resume my-id', 'Claude', 'uuid-5', true), 'claude --resume my-id');
  assert.equal(AgentInfo.prepareAgentCommand('claude -r my-id', 'Claude', 'uuid-5', true), 'claude -r my-id');
  assert.equal(AgentInfo.prepareAgentCommand('claude --continue', 'Claude', 'uuid-5', true), 'claude --continue');
  assert.equal(AgentInfo.prepareAgentCommand('claude -c', 'Claude', 'uuid-5', true), 'claude -c');

  assert.equal(AgentInfo.prepareAgentCommand('grok -s my-id', 'Grok', 'uuid-g3', false), 'grok -s my-id');
  assert.equal(AgentInfo.prepareAgentCommand('grok -r my-id', 'Grok', 'uuid-g3', true), 'grok -r my-id');
  assert.equal(AgentInfo.prepareAgentCommand('grok --session-id my-id', 'Grok', 'uuid-g3', false), 'grok --session-id my-id');
  assert.equal(AgentInfo.prepareAgentCommand('grok --resume my-id', 'Grok', 'uuid-g3', true), 'grok --resume my-id');

  // Provider detection already accepts executable paths; injection must too.
  assert.equal(AgentInfo.prepareAgentCommand('"C:\\Tools\\claude.exe" --model opus', 'Claude', firstId, false), `"C:\\Tools\\claude.exe" --session-id ${firstId} --model opus`);
  assert.equal(AgentInfo.prepareAgentCommand('/opt/bin/grok --temp 0', 'Grok', firstId, true), `/opt/bin/grok -r ${firstId} --temp 0`);
});

test('planAgentLaunch binds fresh columns and resumes only their saved ID', () => {
  const fresh = AgentInfo.planAgentLaunch('claude --effort high', null, true, false, () => firstId);
  assert.deepEqual(fresh, { launch: `claude --session-id ${firstId} --effort high`, sessionId: firstId, resumedAgent: false, showLegacyWarning: false });

  const restored = AgentInfo.planAgentLaunch('claude --effort high', firstId, false, false, () => { throw new Error('must not generate a new ID'); });
  assert.deepEqual(restored, { launch: `claude --resume ${firstId} --effort high`, sessionId: firstId, resumedAgent: true, showLegacyWarning: false });

  const respawned = AgentInfo.planAgentLaunch('grok', firstId, true, false, () => nextId);
  assert.deepEqual(respawned, { launch: `grok -s ${nextId}`, sessionId: nextId, resumedAgent: false, showLegacyWarning: false });

  const skipped = AgentInfo.planAgentLaunch('claude', firstId, false, true, () => nextId);
  assert.deepEqual(skipped, { launch: `claude --session-id ${nextId}`, sessionId: nextId, resumedAgent: false, showLegacyWarning: false });
});

test('planAgentLaunch never claims an unbound or user-selected session was resumed', () => {
  assert.deepEqual(AgentInfo.planAgentLaunch('grok', null, false, false, () => nextId),
    { launch: 'grok', sessionId: null, resumedAgent: false, showLegacyWarning: true });
  assert.deepEqual(AgentInfo.planAgentLaunch('claude', 'malformed-id', false, false, () => nextId),
    { launch: 'claude', sessionId: null, resumedAgent: false, showLegacyWarning: true });
  for (const cmd of ['claude --resume other-id', 'claude --continue', 'grok -r other-id', 'grok -s other-id']) {
    assert.deepEqual(AgentInfo.planAgentLaunch(cmd, firstId, false, false, () => nextId),
      { launch: cmd, sessionId: null, resumedAgent: false, showLegacyWarning: false });
  }
  assert.deepEqual(AgentInfo.planAgentLaunch('codex', firstId, false, false, () => nextId),
    { launch: 'codex', sessionId: null, resumedAgent: false, showLegacyWarning: false });
});
