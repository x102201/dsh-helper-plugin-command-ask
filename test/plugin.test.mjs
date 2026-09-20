import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, COMMAND_NAME, inject, name, SECTION_NAME } from '../index.js';
import { DEFAULT_SECTION } from '../lib/config.js';
import { ASK_MODE_EVENT } from '../lib/projection.js';
import { createFakeAgent, createFakeCtx, createFakeSession, executeCommand } from '../test-support/harness.mjs';

/** Mount the plugin over a fresh fake tree. */
function mount(config, options) {
  const ctx = createFakeCtx(options);
  apply(ctx, config);
  const { session, control } = createFakeSession(ctx.projections);
  const agent = createFakeAgent(session);
  /** Tell the model `active` was the mode the last request described. */
  const told = (active) => {
    session.append(ASK_MODE_EVENT, { active });
    session.append('request/header', {});
  };
  return { ctx, session, agent, control, told };
}

test('the module exports the Cordis plugin shape', () => {
  assert.equal(name, 'dsh-helper-plugin-command-ask');
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'sessionProjections']);
  assert.equal(typeof apply, 'function');
  assert.equal(SECTION_NAME, 'ask:policy');
  assert.equal(COMMAND_NAME, 'ask');
});

test('apply registers the projection, the section, the guard, and the command', () => {
  const { ctx } = mount(undefined);
  assert.ok(ctx.projections.units.has('ask'), 'the ask projection unit is registered');
  assert.deepEqual(ctx.sections.map((section) => section.name), ['ask:policy']);
  assert.equal(ctx.sections[0].order, 500, 'the collaboration-policy slot, like plan mode');
  assert.equal(ctx.guards.length, 1);
  assert.deepEqual(ctx.commands.map((command) => command.name), ['ask']);
  assert.equal(ctx.commands[0].description, 'Enter or leave ask mode (read-only Q&A)');
  assert.deepEqual(ctx.commands[0].input, { hint: '[off|message]', attachments: true });
  assert.equal(typeof ctx.provided.askMode.set, 'function');
  assert.equal(ctx.provided.askMode.projectionKey, 'ask');
  assert.equal(ctx.warnings.length, 0);
});

test('the section renders the guidance only for an agent in ask mode', () => {
  const { ctx, agent, told } = mount(undefined);
  const section = ctx.sections[0];
  assert.equal(section.text({}), '', 'diagnostics with no agent get nothing');
  assert.equal(section.text({ agent }), '', 'ask mode is off');
  assert.equal(section.text({ agent }), '');

  ctx.provided.askMode.set(agent, true);
  assert.equal(section.text({ agent }), DEFAULT_SECTION);
  told(true);
  assert.equal(section.text({ agent }), DEFAULT_SECTION, 'a pending switch already guides the step');

  ctx.provided.askMode.set(agent, false);
  assert.equal(section.text({ agent }), '');
});

test('config.section replaces the guidance', () => {
  const { ctx, agent } = mount({ section: 'Be terse and read-only.' });
  ctx.provided.askMode.set(agent, true);
  assert.equal(ctx.sections[0].text({ agent }), 'Be terse and read-only.');
});

test('/ask turns the mode on and /ask off turns it off', async () => {
  const { ctx, agent, session } = mount({ scope: 'session' });

  const on = await executeCommand(ctx, agent, '/ask');
  assert.equal(on.kind, 'success');
  assert.match(on.text, /Ask mode on \(read-only\)/);
  assert.equal(ctx.provided.askMode.isActive(session), true);
  assert.deepEqual(ctx.projections.viewOf(session, 'ask'), { active: true, pending: false });
  assert.equal(agent.steered.length, 0, 'a bare /ask steers nothing');

  const again = await executeCommand(ctx, agent, '/ask');
  assert.match(again.text, /already on/);

  const off = await executeCommand(ctx, agent, '/ask off');
  assert.equal(off.kind, 'success');
  assert.match(off.text, /Ask mode off/);
  assert.equal(ctx.provided.askMode.isActive(session), false);
  assert.deepEqual(ctx.projections.viewOf(session, 'ask'), { active: false, pending: false });

  const offAgain = await executeCommand(ctx, agent, '/ask off');
  assert.match(offAgain.text, /already off/);
});

test('by default ask mode covers one turn and ends when that turn stops', async () => {
  const { ctx, agent, session } = mount(undefined);
  const [guard] = ctx.guards;

  const result = await executeCommand(ctx, agent, '/ask why is the retry budget 3?');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /for one turn/);
  assert.equal(ctx.provided.askMode.isActive(session), true);
  assert.ok(guard({ name: 'write', agent }), 'the ask turn is enforced read-only');
  assert.equal(agent.steered.length, 1, 'the question is steered as the turn’s message');

  // The loop dispatches `agent/turn-stopping` before the boundary commits.
  ctx.runTurnStopping(agent);
  assert.equal(ctx.provided.askMode.isActive(session), false, 'ask mode ends with the turn');
  assert.deepEqual(ctx.projections.viewOf(session, 'ask'), { active: false, pending: false });
  assert.equal(guard({ name: 'write', agent }), undefined, 'a later message is ordinary work again');
  assert.equal(ctx.sections[0].text({ agent }), '', 'and the guidance is gone');
  assert.equal(session.eventsOfType('ask/mode').map((event) => event.data.active).join(','), 'true,false');
});

test('several ask turns each end on their own boundary, with no /ask off', async () => {
  const { ctx, agent, session } = mount(undefined);
  for (let turn = 0; turn < 2; turn += 1) {
    await executeCommand(ctx, agent, `/ask question ${turn}`);
    assert.equal(ctx.provided.askMode.isActive(session), true);
    ctx.runTurnStopping(agent);
    assert.equal(ctx.provided.askMode.isActive(session), false);
  }
  assert.equal(session.eventsOfType('ask/mode').map((event) => event.data.active).join(','), 'true,false,true,false');
});

test('scope: session keeps the mode on across turns until /ask off', async () => {
  const { ctx, agent, session } = mount({ scope: 'session' });
  await executeCommand(ctx, agent, '/ask');
  ctx.runTurnStopping(agent);
  ctx.runTurnStopping(agent);
  assert.equal(ctx.provided.askMode.isActive(session), true, 'a standing mode ignores the turn boundary');
  assert.ok(ctx.guards[0]({ name: 'write', agent }));
});

test('/ask <message> enters the mode and steers the message under it', async () => {
  const { ctx, agent } = mount(undefined);
  const result = await executeCommand(ctx, agent, '/ask why is the retry budget 3?');
  assert.match(result.text, /Ask mode on/);
  assert.equal(agent.steered.length, 1);
  assert.deepEqual(agent.steered[0].content, [{ type: 'text', text: 'why is the retry budget 3?' }]);
  assert.equal(agent.steered[0].source.kind, 'user');
  assert.equal(agent.steered[0].role, 'user');
  assert.ok(agent.steered[0].id);
  assert.ok(Object.isFrozen(agent.steered[0]));
});

test('/ask off rejects attachments before any mode change', async () => {
  const { ctx, agent, session } = mount(undefined);
  await executeCommand(ctx, agent, '/ask'); // on first
  session.append('request/header', {});
  const result = await executeCommand(ctx, agent, '/ask off', [{ type: 'text', text: 'card' }]);
  assert.equal(result.kind, 'error');
  assert.match(result.text, /Attachments cannot accompany \/ask off/);
  assert.equal(ctx.provided.askMode.isActive(session), true, 'the mode did not change');
});

test('attachments keep their order ahead of the message text', async () => {
  const { ctx, agent } = mount(undefined);
  const image = { type: 'image', mediaType: 'image/png', data: 'AAAA' };
  await executeCommand(ctx, agent, '/ask look at this', [image]);
  assert.deepEqual(agent.steered[0].content, [image, { type: 'text', text: 'look at this' }]);
});

test('bare /ask with attachments steers only the attachments', async () => {
  const { ctx, agent } = mount(undefined);
  const image = { type: 'image', mediaType: 'image/png', data: 'AAAA' };
  await executeCommand(ctx, agent, '/ask', [image]);
  assert.deepEqual(agent.steered[0].content, [image]);
});

test('entering ask mode while plan mode is active reports the switch (scope: session)', async () => {
  const { ctx, agent, session } = mount({ scope: 'session' });
  session.append('plan/mode', { active: true });
  ctx.projections.setStatic('plan', { active: true });
  const result = await executeCommand(ctx, agent, '/ask');
  assert.match(result.text, /Plan mode was switched off/);
});

test('the default one-turn mode leaves plan mode alone', async () => {
  const { ctx, agent, session } = mount(undefined);
  session.append('plan/mode', { active: true });
  ctx.projections.setStatic('plan', { active: true });
  const result = await executeCommand(ctx, agent, '/ask');
  assert.doesNotMatch(result.text, /Plan mode/);
  assert.equal(session.eventsOfType('plan/mode').length, 1, 'only the seed event is there');
  await ctx.runTurnStopping(agent);
  assert.equal(session.eventsOfType('plan/mode').length, 1, 'and the turn boundary did not touch it either');
});

test('a selection made mid-turn stays pending until the step boundary', async () => {
  const { ctx, agent, session, told } = mount({ narrate: true });
  told(false);
  ctx.projections.setStatic('turnBoundary', { openTurnStartSeq: 0 });

  const result = await executeCommand(ctx, agent, '/ask answer me read-only');
  assert.match(result.text, /applies from the next step/);
  assert.deepEqual(ctx.projections.viewOf(session, 'ask'), { active: false, pending: true });
  assert.equal(session.eventsOfType(ASK_MODE_EVENT).length, 1, 'only the told(true/false) seed is logged');

  const decision = await ctx.runPreStep(agent);
  assert.equal(decision.kind, 'enter');
  assert.equal(session.eventsOfType(ASK_MODE_EVENT).length, 2, 'the boundary logged the switch');
  assert.deepEqual(ctx.projections.viewOf(session, 'ask'), { active: true, pending: false });
  assert.equal(decision.messages.length, 1, 'the switch is narrated into the admitted step');
  assert.equal(decision.messages[0].source.form, 'notice');
  assert.match(decision.messages[0].content[0].text, /switched this session to ask mode/);

  // The same turn stops: a queued selection still ends with its turn.
  ctx.runTurnStopping(agent);
  assert.equal(ctx.provided.askMode.isActive(session), false);
});

test('the pre-step listener leaves a rejected or aborted step alone', async () => {
  const rejected = mount(undefined);
  rejected.told(false);
  rejected.ctx.projections.setStatic('turnBoundary', { openTurnStartSeq: 0 });
  await executeCommand(rejected.ctx, rejected.agent, '/ask');
  const decision = await rejected.ctx.runPreStep(rejected.agent, { decision: { kind: 'reject' } });
  assert.equal(decision.kind, 'reject');
  assert.equal(rejected.session.eventsOfType(ASK_MODE_EVENT).length, 1, 'nothing was appended');

  const aborted = mount(undefined);
  aborted.told(false);
  aborted.ctx.projections.setStatic('turnBoundary', { openTurnStartSeq: 0 });
  await executeCommand(aborted.ctx, aborted.agent, '/ask');
  const controller = new AbortController();
  controller.abort();
  const kept = await aborted.ctx.runPreStep(aborted.agent, { signal: controller.signal });
  assert.equal(kept.messages.length, 0);
  assert.equal(aborted.session.eventsOfType(ASK_MODE_EVENT).length, 1);
});

test('the guard denies mutation only while the mode is on', async () => {
  const { ctx, agent, session, told } = mount(undefined);
  const [guard] = ctx.guards;
  const execution = (toolName, target = agent) => ({ name: toolName, agent: target });

  assert.equal(guard(execution('write')), undefined, 'ask mode is off');
  await executeCommand(ctx, agent, '/ask');
  assert.ok(guard(execution('write')), 'ask mode is on');
  assert.ok(guard(execution('pwsh')));
  assert.equal(guard(execution('read')), undefined);
  assert.equal(guard(execution('write', { session: createFakeSession(ctx.projections).session })), undefined, 'another session is unaffected');

  told(true);
  await executeCommand(ctx, agent, '/ask off');
  assert.equal(guard(execution('write')), undefined);
  assert.equal(ctx.provided.askMode.isActive(session), false);
});

test('a pending entry already enforces the mode in the same turn', async () => {
  const { ctx, agent } = mount(undefined);
  ctx.projections.setStatic('turnBoundary', { openTurnStartSeq: 0 });
  await executeCommand(ctx, agent, '/ask');
  assert.ok(ctx.guards[0]({ name: 'write', agent }), 'the switch cannot be raced by a tool call');
});

test('enforce: false leaves the tool catalog untouched', () => {
  const { ctx } = mount({ enforce: false });
  assert.equal(ctx.guards.length, 0);
});

test('blockedTools and allowedTools shape the guard', () => {
  const { ctx, agent } = mount({ blockedTools: ['custom_mutator'], allowedTools: [] });
  ctx.provided.askMode.set(agent, true);
  assert.ok(ctx.guards[0]({ name: 'custom_mutator', agent }));
  assert.equal(ctx.guards[0]({ name: 'write', agent }), undefined, 'the defaults were replaced');
});

test('a profile without a command surface still gets the mode', () => {
  const { ctx, agent, session } = mount(undefined, { withCommands: false });
  assert.equal(ctx.commands.length, 0);
  ctx.provided.askMode.set(agent, true);
  assert.equal(ctx.provided.askMode.isActive(session), true);
  assert.equal(ctx.sections[0].text({ agent }), DEFAULT_SECTION);
});

test('an already-provided service name degrades to a warning, not a failure', () => {
  const { ctx } = mount(undefined, { provideThrows: true });
  assert.equal(ctx.provided.askMode, undefined);
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /askMode/);
  // The rest of the plugin is unaffected.
  assert.equal(typeof ctx.commands[0].handler, 'function');
  assert.equal(ctx.guards.length, 1);
  assert.equal(ctx.sections.length, 1);
});

test('a session switching modes across a resume replays from the log', async () => {
  const { ctx, agent, session } = mount(undefined);
  await executeCommand(ctx, agent, '/ask');
  assert.equal(ctx.provided.askMode.isActive(session), true);

  // A resumed session folds the same events into a fresh projection cell.
  const resumed = createFakeSession(ctx.projections);
  for (const event of session.events) resumed.session.append(event.type, event.data);
  assert.equal(ctx.provided.askMode.isActive(resumed.session), true);
  assert.deepEqual(ctx.projections.viewOf(resumed.session, 'ask'), { active: true, pending: false });
});
