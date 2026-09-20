import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASK_MODE_EVENT, askProjectionDefinition } from '../lib/projection.js';
import { askStateSchema, askViewSchema } from '../lib/schema.js';

const { init, apply, wire } = askProjectionDefinition;

/** Fold a list of events from the empty log. */
function fold(events) {
  return events.reduce((state, event) => apply(state, event), init());
}

/** One event with the fields the fold reads. */
function event(type, data) {
  return { type, seq: 0, time: 0, data };
}

test('the unit declares the key, a version, and both schemas', () => {
  assert.equal(askProjectionDefinition.key, 'ask');
  assert.equal(askProjectionDefinition.stateVersion, 1);
  assert.equal(askProjectionDefinition.stateSchema, askStateSchema);
  assert.equal(wire.viewSchema, askViewSchema);
  assert.ok(Object.isFrozen(askProjectionDefinition));
});

test('the empty log is inactive with no selection and no header yet', () => {
  assert.deepEqual(init(), { active: false, wanted: null, running: null, activeAtLastHeader: null });
});

test('unrelated events keep the state reference', () => {
  const state = init();
  for (const unrelated of ['tool/result', 'step/start', 'assistant/message']) {
    assert.equal(apply(state, event(unrelated, {})), state);
  }
  assert.equal(apply(state, event('command/run', { commandId: 'c1', name: 'goal', args: '' })), state);
});

test('ask/mode is a whole-value event that clears any selection', () => {
  const state = fold([
    event('command/run', { commandId: 'c1', name: 'ask', args: '' }),
    event('command/done', { commandId: 'c1', kind: 'success', text: 'on' }),
    event(ASK_MODE_EVENT, { active: true }),
  ]);
  assert.deepEqual(state, { active: true, wanted: null, running: null, activeAtLastHeader: null });
});

test('a settled /ask run folds into a pending selection only while it differs', () => {
  const turnedOn = fold([
    event('command/run', { commandId: 'c1', name: 'ask', args: '' }),
    event('command/done', { commandId: 'c1', kind: 'success' }),
  ]);
  assert.equal(turnedOn.wanted, true);
  assert.deepEqual(wire.view(turnedOn), { active: false, pending: true });

  const redundant = fold([
    event(ASK_MODE_EVENT, { active: true }),
    event('command/run', { commandId: 'c2', name: 'ask', args: '' }),
    event('command/done', { commandId: 'c2', kind: 'success' }),
  ]);
  assert.equal(redundant.wanted, null);
  assert.deepEqual(wire.view(redundant), { active: true, pending: false });
});

test('/ask off folds into a pending exit', () => {
  const state = fold([
    event(ASK_MODE_EVENT, { active: true }),
    event('command/run', { commandId: 'c1', name: 'ask', args: 'off' }),
    event('command/done', { commandId: 'c1', kind: 'success', text: 'Ask mode off.' }),
  ]);
  assert.equal(state.wanted, false);
  assert.deepEqual(wire.view(state), { active: true, pending: true });
});

test('a failed /ask run leaves the previous state alone', () => {
  const state = fold([
    event('command/run', { commandId: 'c1', name: 'ask', args: '' }),
    event('command/done', { commandId: 'c1', kind: 'error', text: 'boom' }),
  ]);
  assert.equal(state.wanted, null);
  assert.equal(state.running, null);
});

test('a mismatched command/done does not settle the run', () => {
  const state = fold([
    event('command/run', { commandId: 'c1', name: 'ask', args: '' }),
    event('command/done', { commandId: 'other', kind: 'success' }),
  ]);
  assert.deepEqual(state.running, { commandId: 'c1', wanted: true });
  assert.equal(state.wanted, null);
});

test('command/run without args (recordInput: false) is ignored', () => {
  const state = fold([event('command/run', { commandId: 'c1', name: 'ask' })]);
  assert.equal(state.running, null);
});

test('request/header records what the model was last told', () => {
  const on = fold([
    event(ASK_MODE_EVENT, { active: true }),
    event('request/header', {}),
  ]);
  assert.equal(on.activeAtLastHeader, true);
  let after = apply(on, event(ASK_MODE_EVENT, { active: false }));
  after = apply(after, event('request/header', {}));
  assert.equal(after.activeAtLastHeader, false);
});

test('the view reference is stable while the wire value is unchanged', () => {
  const on = fold([event(ASK_MODE_EVENT, { active: true })]);
  const first = wire.view(on);
  const afterHeader = apply(on, event('request/header', {}));
  assert.notEqual(afterHeader, on, 'the header changes the state reference');
  assert.equal(wire.view(afterHeader), first, 'but not the published value');
  assert.ok(Object.isFrozen(first));
});

test('the host-only state schema is strict', () => {
  assert.deepEqual(askStateSchema.parse(init()), init());
  assert.equal(askStateSchema.safeParse({ ...init(), extra: 1 }).success, false);
  assert.equal(askStateSchema.safeParse({ active: 'yes', wanted: null, running: null, activeAtLastHeader: null }).success, false);
  assert.equal(askStateSchema.safeParse({ active: false, wanted: 'yes', running: null, activeAtLastHeader: null }).success, false);
  assert.equal(askStateSchema.safeParse(null).success, false);
  assert.equal(askStateSchema.safeParse([]).success, false);
  const ok = askStateSchema.safeParse({ active: true, wanted: null, running: { commandId: 'c', wanted: false }, activeAtLastHeader: null });
  assert.equal(ok.success, true);
  assert.equal(askStateSchema.safeParse({ active: true, wanted: null, running: { commandId: 'c' }, activeAtLastHeader: null }).success, false);
});

test('the wire schema accepts exactly the view value', () => {
  assert.deepEqual(askViewSchema.parse({ active: true, pending: false }), { active: true, pending: false });
  assert.equal(askViewSchema.safeParse({ active: true }).success, false);
  assert.equal(askViewSchema.safeParse({ active: true, pending: false, extra: 1 }).success, false);
  assert.equal(askViewSchema.safeParse('on').success, false);
});

test('schema violations name the expected shape', () => {
  assert.throws(() => askStateSchema.parse({}), /expected "active" to be a boolean/);
  assert.throws(() => askViewSchema.parse({ active: true, pending: false, oops: 1 }), /no key other than/);
});
