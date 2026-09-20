import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_MODE_EVENT, createModeController } from '../lib/controller.js';
import { createAskProjection } from '../lib/projection.js';
import { createFakeAgent, createFakeProjections, createFakeSession } from '../test-support/harness.mjs';

/**
 * A controller over a fake session plus the projection keys the plugin reads.
 * `plan` is a real folding stub so supersession is observable end to end.
 */
function createFixture({ plan = false, withPlan = true, openTurn = false, narrate = true, supersedePlanMode = true, turnBoundary = true, scope = 'session' } = {}) {
  const projections = createFakeProjections();
  projections.register(createAskProjection({ scope }));
  if (withPlan) {
    projections.register({
      key: 'plan',
      stateVersion: 1,
      init: () => ({ active: plan }),
      apply: (state, event) => (event.type === PLAN_MODE_EVENT ? { ...state, active: event.data.active === true } : state),
    });
  }
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

/** Replay one settled `/ask` invocation into the log, as the registry does. */
function runAsk(session, { id = 'c1', args = '', kind = 'success' } = {}) {
  session.append('command/run', { commandId: id, name: 'ask', args, source: { kind: 'user' } });
  session.append('command/done', { commandId: id, kind, text: 'ok' });
}

test('the controller only reads: ask state comes from the command records', () => {
  const { session, agent, controller } = createFixture();
  assert.equal(controller.loggedActive(session), false);
  assert.deepEqual(controller.get(agent), { active: false });

  runAsk(session);
  assert.equal(controller.loggedActive(session), true);
  assert.deepEqual(controller.get(agent), { active: true });

  runAsk(session, { id: 'c2', args: 'off' });
  assert.equal(controller.loggedActive(session), false);
  assert.deepEqual(controller.get(agent), { active: false });
});

test('get reports a pending invocation while one is in flight', () => {
  const { session, agent, controller } = createFixture();
  session.append('command/run', { commandId: 'c1', name: 'ask', args: '', source: { kind: 'user' } });
  assert.deepEqual(controller.get(agent), { active: false, pending: true });
  assert.equal(controller.loggedActive(session), false, 'an in-flight run has not changed the mode yet');
});

test('the one-turn scope reads the mode as off once its turn ends', () => {
  const { session, agent, controller } = createFixture({ scope: 'turn' });
  runAsk(session);
  assert.equal(controller.loggedActive(session), true);
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(controller.loggedActive(session), false);
  assert.deepEqual(controller.get(agent), { active: false });
});

test('loggedActiveAtLastHeader tracks what the last request was told', () => {
  const { session, controller } = createFixture({ scope: 'turn' });
  assert.equal(controller.loggedActiveAtLastHeader(session), undefined);
  runAsk(session);
  session.append('request/header', { header: {} });
  assert.equal(controller.loggedActiveAtLastHeader(session), true);
  session.append('turn/end', {});
  session.append('request/header', { header: {} });
  assert.equal(controller.loggedActiveAtLastHeader(session), false);
});

test('narrationFor speaks only when the last request was told the other mode', () => {
  const { session, agent, controller } = createFixture();
  assert.equal(controller.narrationFor(session), undefined, 'nothing was told yet');

  session.append('request/header', { header: {} }); // told: off
  runAsk(session);
  const notice = controller.narrationFor(session);
  assert.ok(notice, 'entering ask mode after a request is announced');
  assert.equal(notice.role, 'user');
  assert.equal(notice.source.kind, 'plugin');
  assert.equal(notice.source.form, 'notice');
  assert.ok(notice.content[0].text.includes('ask mode'));
  assert.ok(Object.isFrozen(notice));

  session.append('request/header', { header: {} }); // told: on
  assert.equal(controller.narrationFor(session), undefined, 'the request already described ask mode');

  runAsk(session, { id: 'c2', args: 'off' });
  const back = controller.narrationFor(session);
  assert.ok(back, 'leaving is announced too');
  assert.ok(back.content[0].text.includes('default mode'));
  void agent;
});

test('narrate: false silences the switch notice', () => {
  const { session, controller } = createFixture({ narrate: false });
  session.append('request/header', { header: {} });
  runAsk(session);
  assert.equal(controller.narrationFor(session), undefined);
});

test('planActive reads the plan projection, false when plan mode is absent', () => {
  const withoutPlan = createFixture({ withPlan: false });
  assert.equal(withoutPlan.controller.planActive(withoutPlan.session), false, 'no plan unit registered');

  const { session, controller } = createFixture({ plan: true });
  assert.equal(controller.planActive(session), true);
});

test('supersedePlan leaves plan mode and reports it, once', () => {
  const { session, controller } = createFixture({ plan: true });
  assert.equal(controller.supersedePlan(session), true);
  assert.deepEqual(session.eventsOfType(PLAN_MODE_EVENT).map((event) => event.data), [{ active: false }]);
  assert.equal(controller.planActive(session), false);
  assert.equal(controller.supersedePlan(session), false, 'already off');
  assert.equal(session.eventsOfType(PLAN_MODE_EVENT).length, 1);
});

test('supersedePlan does nothing when disabled or when plan mode is off', () => {
  const disabled = createFixture({ plan: true, supersedePlanMode: false });
  assert.equal(disabled.controller.supersedePlan(disabled.session), false);
  assert.equal(disabled.session.eventsOfType(PLAN_MODE_EVENT).length, 0);

  const planOff = createFixture({ plan: false });
  assert.equal(planOff.controller.supersedePlan(planOff.session), false);
  assert.equal(planOff.session.eventsOfType(PLAN_MODE_EVENT).length, 0);
});

test('an absent turnBoundary projection reads as no open turn and warns once', () => {
  const { session, controller, warnings } = createFixture({ turnBoundary: false });
  assert.equal(controller.hasOpenTurn(session), false);
  assert.equal(controller.hasOpenTurn(session), false);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('turnBoundary'));
});

test('hasOpenTurn follows the agent-loop projection', () => {
  assert.equal(createFixture({ openTurn: true }).controller.hasOpenTurn(createFakeSession(createFakeProjections()).session), true);
  const open = createFixture({ openTurn: true });
  assert.equal(open.controller.hasOpenTurn(open.session), true);
  const idle = createFixture({ openTurn: false });
  assert.equal(idle.controller.hasOpenTurn(idle.session), false);
});

test('an absent ask projection reads as inactive rather than throwing', () => {
  const projections = createFakeProjections();
  const { session } = createFakeSession(projections);
  const controller = createModeController({
    readProjection: (target, key) => projections.stateOf(target, key),
    append: (target, type, data) => target.append(type, data),
    narrate: true,
    supersedePlanMode: true,
    plugin: 'test-plugin',
    warn: () => {},
  });
  assert.equal(controller.loggedActive(session), false);
  assert.equal(controller.planActive(session), false);
  assert.equal(controller.loggedActiveAtLastHeader(session), undefined);
});
