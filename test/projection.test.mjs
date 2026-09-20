import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASK_PROJECTION_KEY, ASK_PROJECTION_STATE_VERSION, createAskProjection } from '../lib/projection.js';
import { askStateSchema, askViewSchema } from '../lib/schema.js';

const turnUnit = createAskProjection({ scope: 'turn' });
const sessionUnit = createAskProjection({ scope: 'session' });

/** Fold a list of events from the empty log. */
function fold(unit, events) {
  return events.reduce((state, event) => unit.apply(state, event), unit.init());
}

/** One event with the fields the fold reads. */
function event(type, data) {
  return { type, seq: 0, time: 0, data };
}

/** The command record pair the registry appends around one `/ask` run. */
function askRun({ id = 'c1', args = '', kind = 'success' } = {}) {
  return [
    event('command/run', { commandId: id, name: 'ask', args }),
    event('command/done', { commandId: id, kind, text: kind === 'success' ? 'ok' : 'boom' }),
  ];
}

test('the unit declares the key, the bumped version, and both schemas', () => {
  assert.equal(turnUnit.key, 'ask');
  assert.equal(ASK_PROJECTION_KEY, 'ask');
  assert.equal(turnUnit.stateVersion, 2);
  assert.equal(ASK_PROJECTION_STATE_VERSION, 2, 'the fold changed, so cached v1 rows must be discarded');
  assert.equal(turnUnit.stateSchema, askStateSchema);
  assert.equal(turnUnit.wire.viewSchema, askViewSchema);
  assert.ok(Object.isFrozen(turnUnit));
});

test('the empty log is inactive with no invocation and no header yet', () => {
  assert.deepEqual(turnUnit.init(), { active: false, running: null, activeAtLastHeader: null });
});

test('unrelated events keep the state reference', () => {
  const state = turnUnit.init();
  for (const unrelated of ['tool/result', 'step/start', 'assistant/message', 'plan/mode']) {
    assert.equal(turnUnit.apply(state, event(unrelated, {})), state);
  }
  assert.equal(turnUnit.apply(state, event('command/run', { commandId: 'c', name: 'goal', args: '' })), state);
});

test('a settled /ask run turns the mode on, and /ask off turns it off', () => {
  const on = fold(turnUnit, askRun());
  assert.equal(on.active, true);
  assert.equal(on.running, null);
  assert.deepEqual(turnUnit.wire.view(on), { active: true, pending: false });

  const off = fold(turnUnit, [...askRun(), ...askRun({ id: 'c2', args: 'off' })]);
  assert.equal(off.active, false);
  assert.deepEqual(turnUnit.wire.view(off), { active: false, pending: false });
});

test('an invocation in flight is visible as pending and changes nothing yet', () => {
  const state = fold(turnUnit, [event('command/run', { commandId: 'c1', name: 'ask', args: '' })]);
  assert.deepEqual(state.running, { commandId: 'c1', wanted: true });
  assert.equal(state.active, false);
  assert.deepEqual(turnUnit.wire.view(state), { active: false, pending: true });
});

test('a failed invocation leaves the mode alone', () => {
  const state = fold(turnUnit, [
    ...askRun(),
    ...askRun({ id: 'c2', args: 'off', kind: 'error' }),
  ]);
  assert.equal(state.active, true, 'the refused /ask off did not switch the mode');
  assert.equal(state.running, null);
});

test('a mismatched command/done does not settle the invocation', () => {
  const state = fold(turnUnit, [
    event('command/run', { commandId: 'c1', name: 'ask', args: '' }),
    event('command/done', { commandId: 'other', kind: 'success' }),
  ]);
  assert.deepEqual(state.running, { commandId: 'c1', wanted: true });
  assert.equal(state.active, false);
});

test('command/run without args (recordInput: false) is ignored', () => {
  assert.equal(fold(turnUnit, [event('command/run', { commandId: 'c1', name: 'ask' })]).running, null);
});

test('turn/end releases a one-turn mode only', () => {
  const events = [...askRun(), event('turn/end', { turn: 1, reason: { kind: 'completed' } })];
  assert.equal(fold(turnUnit, events).active, false, 'scope: turn ends with the turn');
  assert.equal(fold(sessionUnit, events).active, true, 'scope: session stands until /ask off');
});

test('turn/end leaves an inactive state untouched (same reference)', () => {
  const off = turnUnit.init();
  assert.equal(turnUnit.apply(off, event('turn/end', {})), off);
});

test('turn/end between turns is what lets a new /ask arm the next turn', () => {
  const state = fold(turnUnit, [
    ...askRun(),
    event('turn/end', {}),
    ...askRun({ id: 'c2' }),
  ]);
  assert.equal(state.active, true, 'the second ask armed a fresh turn');
});

test('request/header records what the model was last told', () => {
  const told = fold(turnUnit, [...askRun(), event('request/header', {})]);
  assert.equal(told.activeAtLastHeader, true);
  const after = fold(turnUnit, [...askRun(), event('request/header', {}), event('turn/end', {})]);
  assert.equal(after.activeAtLastHeader, true, 'the header is history, not the current mode');
  assert.equal(after.active, false);
});

test('the view reference is stable while the wire value is unchanged', () => {
  const on = fold(turnUnit, askRun());
  const first = turnUnit.wire.view(on);
  const afterHeader = turnUnit.apply(on, event('request/header', {}));
  assert.notEqual(afterHeader, on, 'the header changes the state reference');
  assert.equal(turnUnit.wire.view(afterHeader), first, 'but not the published value');
  assert.ok(Object.isFrozen(first));
});

test('the host-only state schema is strict and matches the fold', () => {
  assert.deepEqual(askStateSchema.parse(turnUnit.init()), turnUnit.init());
  assert.equal(askStateSchema.safeParse({ ...turnUnit.init(), extra: 1 }).success, false);
  assert.equal(askStateSchema.safeParse({ active: 'yes', running: null, activeAtLastHeader: null }).success, false);
  assert.equal(askStateSchema.safeParse({ active: false, running: null }).success, false, 'every key is required');
  assert.equal(askStateSchema.safeParse(null).success, false);
  assert.equal(askStateSchema.safeParse([]).success, false);
  const ok = askStateSchema.safeParse({ active: true, running: { commandId: 'c', wanted: false }, activeAtLastHeader: null });
  assert.equal(ok.success, true);
  assert.equal(askStateSchema.safeParse({ active: true, running: { commandId: 'c' }, activeAtLastHeader: null }).success, false);
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
