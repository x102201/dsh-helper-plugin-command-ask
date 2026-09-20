import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OUTCOME, PLAN_MODE_EVENT, createModeController } from '../lib/controller.js';
import { ASK_MODE_EVENT, askProjectionDefinition } from '../lib/projection.js';
import { createFakeAgent, createFakeProjections, createFakeSession } from '../test-support/harness.mjs';

/**
 * A controller over a fake session plus the projection keys the plugin reads.
 * `plan` is a real folding stub so supersession is observable end to end.
 */
function createFixture({ plan = false, openTurn = false, narrate = true, supersedePlanMode = true, turnBoundary = true } = {}) {
  const projections = createFakeProjections();
  projections.register(askProjectionDefinition);
  projections.register({
    key: 'plan',
    stateVersion: 1,
    init: () => ({ active: plan }),
    apply: (state, event) => (event.type === PLAN_MODE_EVENT ? { ...state, active: event.data.active === true } : state),
  });
  if (turnBoundary) projections.setStatic('turnBoundary', { openTurnStartSeq: openTurn ? 0 : null });

  const { session, control } = createFakeSession(projections);
  const agent = createFakeAgent(session);
  const warnings = [];
  const controller = createModeController({
    readProjection: (target, key) => projections.stateOf(target, key),
    append: (target, type, data) => target.append(type, data),
    narrate,
    supersedePlanMode,
    plugin: 'test-plugin',
    warn: (message) => warnings.push(message),
  });
  return { projections, session, agent, controller, control, warnings };
}

/** Mark the session as having been told `active` in the last request. */
function told(session, active) {
  session.append(ASK_MODE_EVENT, { active });
  session.append('request/header', {});
}

test('between turns a selection is logged immediately and narrated', () => {
  const { session, agent, controller } = createFixture();
  const { outcome } = controller.set(agent, true);
  assert.equal(outcome, OUTCOME.committed);
  assert.deepEqual(session.eventsOfType(ASK_MODE_EVENT).map((event) => event.data), [{ active: true }]);
  assert.equal(agent.injected.length, 0, 'nothing to narrate before the first request');
  assert.deepEqual(controller.get(agent), { active: true });
  assert.equal(controller.loggedActive(session), true);
});

test('a switch is narrated when the last request described the other mode', () => {
  const { session, agent, controller, projections } = createFixture();
  told(session, false);
  controller.set(agent, true);
  assert.equal(agent.injected.length, 1);
  const notice = agent.injected[0];
  assert.equal(notice.role, 'user');
  assert.equal(notice.source.kind, 'plugin');
  assert.equal(notice.source.form, 'notice');
  assert.ok(notice.source.summary.includes('ask mode'));
  assert.ok(notice.content[0].text.includes('ask mode'));
  assert.ok(Object.isFrozen(notice));
  assert.ok(Object.isFrozen(notice.content));
});

test('switching back is narrated too, and narrate: false silences it', () => {
  const { session, agent, controller, projections } = createFixture();
  told(session, true);
  controller.set(agent, false);
  assert.equal(agent.injected.length, 1);
  assert.ok(agent.injected[0].content[0].text.includes('default mode'));

  const quiet = createFixture({ narrate: false });
  told(quiet.session, false);
  quiet.controller.set(quiet.agent, true);
  assert.equal(quiet.agent.injected.length, 0);
});

test('re-selecting the current state is a no-op that appends nothing', () => {
  const { session, agent, controller } = createFixture();
  controller.set(agent, true);
  const before = session.events.length;
  assert.equal(controller.set(agent, true).outcome, OUTCOME.noop);
  assert.equal(session.events.length, before);
});

test('during an open turn a selection is queued, then committed at the boundary', () => {
  const { session, agent, controller } = createFixture({ openTurn: true });
  const queued = controller.set(agent, true);
  assert.equal(queued.outcome, OUTCOME.queued);
  assert.equal(session.eventsOfType(ASK_MODE_EVENT).length, 0, 'nothing is logged during the turn');
  assert.deepEqual(controller.get(agent), { active: false, pending: true });
  assert.deepEqual(controller.pendingOf(session), { active: true });

  const narration = controller.narrate(session, controller.pendingOf(session).active);
  controller.applyBoundary(session);
  assert.deepEqual(session.eventsOfType(ASK_MODE_EVENT).map((event) => event.data), [{ active: true }]);
  assert.equal(controller.pendingOf(session), undefined);
  assert.equal(controller.loggedActive(session), true);
  assert.equal(narration, undefined, 'nothing to narrate before the first request');
});

test('a pending selection that matches the logged state is dropped at the boundary', () => {
  const { session, agent, controller } = createFixture({ openTurn: true });
  controller.set(agent, true); // queued on
  const cancelled = controller.set(agent, false); // ... cancelled by an immediate off
  assert.equal(cancelled.outcome, OUTCOME.cancelled);
  // The surviving selection is "off", which is already the logged state: there
  // is nothing to append, and the effective value decides enforcement now.
  assert.deepEqual(controller.pendingOf(session), { active: false });
  assert.equal(controller.effectiveActive(session), false);
  controller.applyBoundary(session);
  assert.equal(session.eventsOfType(ASK_MODE_EVENT).length, 0);
  assert.equal(controller.pendingOf(session), undefined);
});

test('re-selecting the logged state mid-turn clears an opposite pending selection', () => {
  const { session, agent, controller, projections } = createFixture();
  controller.set(agent, true); // committed between turns
  // The turn opens: a selection is now deferred to the step boundary.
  projections.setStatic('turnBoundary', { openTurnStartSeq: 0 });
  assert.equal(controller.set(agent, false).outcome, OUTCOME.queued);
  const back = controller.set(agent, true);
  assert.equal(back.outcome, OUTCOME.cancelled);
  assert.deepEqual(controller.pendingOf(session), { active: true }, 'the off selection was cleared');
  assert.equal(controller.effectiveActive(session), true);
  controller.applyBoundary(session);
  assert.equal(session.eventsOfType(ASK_MODE_EVENT).length, 1, 'only the original commit was logged');
  assert.equal(controller.pendingOf(session), undefined);
});

test('applyBoundary without a pending selection changes nothing', () => {
  const { session, controller } = createFixture();
  controller.applyBoundary(session);
  assert.equal(session.events.length, 0);
});

test('a failed append keeps the pending selection for the next boundary', () => {
  const { session, agent, controller, control } = createFixture({ openTurn: true });
  controller.set(agent, true);
  control.throws = true;
  assert.throws(() => controller.applyBoundary(session), /append refused/);
  assert.deepEqual(controller.pendingOf(session), { active: true }, 'the selection survives');
  control.throws = false;
  controller.applyBoundary(session);
  assert.equal(controller.loggedActive(session), true);
});

test('entering ask mode leaves plan mode; leaving it does not touch plan mode', () => {
  const { session, agent, controller } = createFixture({ plan: true });
  const entered = controller.set(agent, true);
  assert.equal(entered.supersededPlan, true);
  assert.deepEqual(session.eventsOfType(PLAN_MODE_EVENT).map((event) => event.data), [{ active: false }]);
  assert.equal(controller.planActive(session), false);

  const off = controller.set(agent, false);
  assert.equal(off.supersededPlan, false);
  assert.equal(session.eventsOfType(PLAN_MODE_EVENT).length, 1);
});

test('a pending entry supersedes plan mode at the boundary, not before', () => {
  const { session, agent, controller } = createFixture({ plan: true, openTurn: true });
  controller.set(agent, true);
  assert.equal(session.eventsOfType(PLAN_MODE_EVENT).length, 0);
  controller.applyBoundary(session);
  assert.deepEqual(session.eventsOfType(PLAN_MODE_EVENT).map((event) => event.data), [{ active: false }]);
});

test('supersedePlanMode: false leaves plan mode alone', () => {
  const { session, agent, controller } = createFixture({ plan: true, supersedePlanMode: false });
  const entered = controller.set(agent, true);
  assert.equal(entered.supersededPlan, false);
  assert.equal(session.eventsOfType(PLAN_MODE_EVENT).length, 0);
  assert.equal(controller.planActive(session), true);
});

test('an absent turnBoundary projection commits immediately and warns once', () => {
  const { session, agent, controller, warnings } = createFixture({ turnBoundary: false });
  assert.equal(controller.hasOpenTurn(session), false);
  assert.equal(controller.set(agent, true).outcome, OUTCOME.committed);
  assert.equal(controller.hasOpenTurn(session), false);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('turnBoundary'));
});

test('an absent ask projection reads as inactive rather than throwing', () => {
  const projections = createFakeProjections();
  const { session } = createFakeSession(projections);
  const warnings = [];
  const controller = createModeController({
    readProjection: (target, key) => projections.stateOf(target, key),
    append: (target, type, data) => target.append(type, data),
    narrate: true,
    supersedePlanMode: true,
    plugin: 'test-plugin',
    warn: (message) => warnings.push(message),
  });
  assert.equal(controller.loggedActive(session), false);
  assert.equal(controller.effectiveActive(session), false);
  assert.equal(controller.planActive(session), false);
});

test('effectiveActive follows a pending selection so a mode change cannot be raced', () => {
  const { session, agent, controller } = createFixture({ openTurn: true });
  assert.equal(controller.effectiveActive(session), false);
  controller.set(agent, true);
  assert.equal(controller.effectiveActive(session), true);
  assert.equal(controller.loggedActive(session), false);
});

test('narrate() reports nothing before a request, and follows activeAtLastHeader after one', () => {
  const { session, controller, projections } = createFixture();
  assert.equal(controller.narrate(session, true), undefined);
  told(session, false);
  assert.ok(controller.narrate(session, true));
  assert.equal(controller.narrate(session, false), undefined, 'the last request already said default mode');
});

test('disarm ends a turn-scoped mode and reports whether it changed the log', () => {
  const { session, agent, controller } = createFixture();
  assert.equal(controller.disarm(session), false, 'nothing to do while ask mode is off');
  assert.equal(session.eventsOfType(ASK_MODE_EVENT).length, 0);

  controller.set(agent, true);
  assert.equal(controller.loggedActive(session), true);
  assert.equal(controller.disarm(session), true);
  assert.equal(controller.loggedActive(session), false);
  assert.deepEqual(session.eventsOfType(ASK_MODE_EVENT).map((event) => event.data), [{ active: true }, { active: false }]);
  assert.equal(controller.disarm(session), false, 'the second call is a no-op');
  assert.equal(session.eventsOfType(ASK_MODE_EVENT).length, 2);
});

test('disarm drops a mid-turn selection that never reached the boundary', () => {
  const { session, agent, controller } = createFixture({ openTurn: true });
  controller.set(agent, true); // queued: nothing logged yet
  assert.equal(controller.disarm(session), false, 'the logged state was already off');
  assert.equal(controller.pendingOf(session), undefined);
  assert.equal(session.eventsOfType(ASK_MODE_EVENT).length, 0);
  assert.equal(controller.effectiveActive(session), false);
});

test('disarm keeps a failed append visible to the caller', () => {
  const { session, agent, controller, control } = createFixture();
  controller.set(agent, true);
  control.throws = true;
  assert.throws(() => controller.disarm(session), /append refused/);
  control.throws = false;
  assert.equal(controller.loggedActive(session), true, 'the mode stays on until the append succeeds');
  assert.equal(controller.disarm(session), true);
});
