import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_BLOCKED_TOOLS, DEFAULT_SECTION, PLUGIN_NAME, resolveConfig } from '../lib/config.js';

test('defaults describe a read-only, enforcing mode', () => {
  const config = resolveConfig(undefined);
  assert.equal(config.section, DEFAULT_SECTION);
  assert.equal(config.enforce, true);
  assert.equal(config.supersedePlanMode, true);
  assert.equal(config.narrate, true);
  assert.deepEqual(config.blockedTools, DEFAULT_BLOCKED_TOOLS);
  assert.deepEqual(config.allowedTools, []);
  assert.ok(Object.isFrozen(config));
});

test('the default deny list blocks every mutating shape and leaves readers alone', () => {
  const blocked = new Set(DEFAULT_BLOCKED_TOOLS);
  for (const name of ['write', 'edit', 'str_replace_editor', 'apply_patch', 'pwsh', 'bash', 'todo_write', 'create_goal', 'update_goal', 'subagent', 'subagent_fork', 'workflow', 'ralph', 'job_kill']) {
    assert.ok(blocked.has(name), `${name} should be blocked`);
  }
  for (const name of ['read', 'glob', 'grep', 'web_search', 'web_fetch', 'skill', 'ask_user_question', 'job_list', 'job_output', 'present', 'read_image', 'get_goal', 'list_agents']) {
    assert.ok(!blocked.has(name), `${name} should stay callable`);
  }
});

test('the guidance text carries the load-bearing ask-mode rules', () => {
  for (const phrase of ['ask mode', '/ask off', 'change nothing', 'read-only', 'tool catalog stays the same']) {
    assert.ok(DEFAULT_SECTION.includes(phrase), `guidance should mention ${JSON.stringify(phrase)}`);
  }
});

test('a bare row (no config) and an empty mapping are equivalent', () => {
  assert.deepEqual(resolveConfig(undefined), resolveConfig({}));
});

test('each key can be overridden', () => {
  const config = resolveConfig({
    section: 'custom guidance',
    enforce: false,
    blockedTools: ['write'],
    allowedTools: ['write', 'pwsh'],
    supersedePlanMode: false,
    narrate: false,
  });
  assert.equal(config.section, 'custom guidance');
  assert.equal(config.enforce, false);
  assert.deepEqual(config.blockedTools, ['write']);
  assert.deepEqual(config.allowedTools, ['write', 'pwsh']);
  assert.equal(config.supersedePlanMode, false);
  assert.equal(config.narrate, false);
});

test('blockedTools replaces the defaults instead of extending them', () => {
  const config = resolveConfig({ blockedTools: ['write'] });
  assert.deepEqual(config.blockedTools, ['write']);
  assert.ok(!config.blockedTools.includes('pwsh'));
});

test('unknown keys fail at load and name the offender', () => {
  assert.throws(() => resolveConfig({ enforced: true }), (error) => {
    assert.ok(error.message.includes(PLUGIN_NAME));
    assert.ok(error.message.includes('enforced'));
    assert.ok(error.message.includes('enforce'), 'the message should list the accepted keys');
    return true;
  });
});

test('wrong types fail at load', () => {
  assert.throws(() => resolveConfig('nope'), /config must be a mapping/);
  assert.throws(() => resolveConfig([]), /config must be a mapping/);
  assert.throws(() => resolveConfig(null), /config must be a mapping/);
  assert.throws(() => resolveConfig({ section: '' }), /config\.section/);
  assert.throws(() => resolveConfig({ section: '   ' }), /config\.section/);
  assert.throws(() => resolveConfig({ section: 42 }), /config\.section/);
  assert.throws(() => resolveConfig({ enforce: 'yes' }), /config\.enforce/);
  assert.throws(() => resolveConfig({ narrate: 1 }), /config\.narrate/);
  assert.throws(() => resolveConfig({ supersedePlanMode: null }), /config\.supersedePlanMode/);
  assert.throws(() => resolveConfig({ blockedTools: 'write' }), /config\.blockedTools/);
  assert.throws(() => resolveConfig({ blockedTools: ['write', ''] }), /config\.blockedTools/);
  assert.throws(() => resolveConfig({ allowedTools: [3] }), /config\.allowedTools/);
});
