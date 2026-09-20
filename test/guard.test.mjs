import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReadOnlyGuard } from '../lib/guard.js';
import { DEFAULT_BLOCKED_TOOLS } from '../lib/config.js';

/** A guard over a session whose ask-mode state is decided by `active`. */
function guardFor(state, options = {}) {
  const session = state.session ?? { id: 'session-test' };
  const guard = createReadOnlyGuard({
    effectiveActive: () => state.active,
    blockedTools: options.blockedTools ?? DEFAULT_BLOCKED_TOOLS,
    allowedTools: options.allowedTools ?? [],
    plugin: 'dsh-helper-plugin-command-ask',
  });
  return { guard, session, agent: { session } };
}

test('a mutating tool is denied while ask mode is active', () => {
  const { guard, agent } = guardFor({ active: true });
  const reason = guard({ name: 'write', agent });
  assert.equal(typeof reason, 'string');
  assert.ok(reason.includes('"write"'));
  assert.ok(reason.includes('read-only'));
  assert.ok(reason.includes('/ask off'));
});

test('every defaulted tool is denied and every reader passes', () => {
  const { guard, agent } = guardFor({ active: true });
  for (const name of DEFAULT_BLOCKED_TOOLS) {
    assert.ok(guard({ name, agent }), `${name} should be denied`);
  }
  for (const name of ['read', 'glob', 'grep', 'web_search', 'web_fetch', 'skill', 'ask_user_question', 'job_list', 'job_output', 'present', 'list_agents']) {
    assert.equal(guard({ name, agent }), undefined, `${name} should pass`);
  }
});

test('nothing is denied outside ask mode', () => {
  const { guard, agent } = guardFor({ active: false });
  assert.equal(guard({ name: 'write', agent }), undefined);
  assert.equal(guard({ name: 'pwsh', agent }), undefined);
});

test('a settled pending selection already enforces the mode', () => {
  // `effectiveActive` is what the plugin passes in; this pins the contract that
  // a pending switch counts, so a tool call in the same turn cannot race it.
  const session = { id: 's' };
  const guard = createReadOnlyGuard({
    effectiveActive: (target) => target.pending === true,
    blockedTools: ['write'],
    allowedTools: [],
    plugin: 'p',
  });
  assert.ok(guard({ name: 'write', agent: { session: { ...session, pending: true } } }));
  assert.equal(guard({ name: 'write', agent: { session: { ...session, pending: false } } }), undefined);
});

test('allowedTools wins over blockedTools', () => {
  const { guard, agent } = guardFor({ active: true }, { blockedTools: ['write'], allowedTools: ['write'] });
  assert.equal(guard({ name: 'write', agent }), undefined);
});

test('calls with no agent, no session, or no name pass through', () => {
  const { guard } = guardFor({ active: true });
  assert.equal(guard({ name: 'write' }), undefined);
  assert.equal(guard({ name: 'write', agent: {} }), undefined);
  assert.equal(guard({ name: 'write', agent: { session: null } }), undefined);
  assert.equal(guard({ agent: { session: {} } }), undefined);
  assert.equal(guard({ name: '', agent: { session: {} } }), undefined);
  assert.equal(guard(undefined), undefined);
});

test('a tool absent from the deny list stays callable even in ask mode', () => {
  const { guard, agent } = guardFor({ active: true });
  assert.equal(guard({ name: 'deployment_specific_reader', agent }), undefined);
});
