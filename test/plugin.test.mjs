import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, COMMAND_NAME, inject, name, SECTION_NAME } from '../index.js';
import { DEFAULT_SECTION } from '../lib/config.js';
import { createFakeAgent, createFakeCtx, createFakeSession, executeCommand } from '../test-support/harness.mjs';

/** Mount the plugin over a fresh fake tree. */
function mount(config, options) {
  const ctx = createFakeCtx(options);
  apply(ctx, config);
  const { session, control } = createFakeSession(ctx.projections);
  const agent = createFakeAgent(session);
  /**
   * Simulate "the last request was told ask mode is `active`": run `/ask` when
   * needed (that is what the mode is derived from), then log the request header.
   */
  const told = async (active) => {
    if (active !== await askActive(ctx, session, active)) throw new Error('unreachable');
    session.append('request/header', { header: {} });
  };
  return { ctx, session, agent, control, told };
}

/** Bring the session's mode to `active` through the real command path if needed. */
async function askActive(ctx, session, active) {
  const current = ctx.provided.askMode?.isActive(session) ?? false;
  if (current !== active) {
    const command = ctx.command('ask');
    const commandId = `seed-${session.events.length}`;
    session.append('command/run', { commandId, name: 'ask', args: active ? '' : 'off', source: { kind: 'user' } });
    const result = await command.handler({
      commandId,
      agent: { session, steer: () => {}, inject: () => {} },
      rawInput: active ? '' : 'off',
      attachments: [],
      signal: new AbortController().signal,
    });
    session.append('command/done', { commandId, kind: result.kind, text: result.text });
  }
  return active;
}

test('the module exports the Cordis plugin shape', () => {
  assert.equal(name, 'dsh-helper-plugin-command-ask');
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'sessionProjections', 'sessions']);
  assert.equal(typeof apply, 'function');
  assert.equal(SECTION_NAME, 'ask:policy');
  assert.equal(COMMAND_NAME, 'ask');
});

test('a mode switch is checkpointed instead of waiting for the next checkpoint', async () => {
  const { ctx, agent, session } = mount(undefined);
  const flushes = ctx.flushes;
  assert.equal(flushes.length, 0);

  await executeCommand(ctx, agent, '/ask');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(flushes.length >= 1, 'the switch asked for a durability checkpoint');
  assert.equal(flushes.at(-1), session, 'and it targeted the switching session');

  const before = flushes.length;
  ctx.runTurnEnd(agent);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(flushes.length > before, 'the turn-scoped release is checkpointed too');
});

test('apply registers the projection, the section, the guard, and the command', () => {
  const { ctx } = mount(undefined);
  const unit = ctx.projections.units.get('ask');
  assert.ok(unit, 'the ask projection unit is registered');
  assert.equal(unit.stateVersion, 2);
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

test('the plugin writes no session-event vocabulary of its own', async () => {
  const { ctx, agent, session } = mount(undefined);
  await executeCommand(ctx, agent, '/ask why?');
  ctx.runTurnEnd(agent);
  await ctx.provided.askMode.set(agent, false);
  const types = new Set(session.events.map((event) => event.type));
  const allowed = new Set(['command/run', 'command/done', 'request/header', 'turn/end', 'plan/mode']);
  const unknown = [...types].filter((type) => !allowed.has(type));
  assert.deepEqual(unknown, [], `the log must hold only harness-known events, saw ${[...types].join(', ')}`);
});

test('the section renders the guidance only for an agent in ask mode', async () => {
  const { ctx, agent } = mount(undefined);
  const section = ctx.sections[0];
  assert.equal(section.text({}), '', 'diagnostics with no agent get nothing');
  assert.equal(section.text({ agent }), '', 'ask mode is off');

  await ctx.provided.askMode.set(agent, true);
  assert.equal(section.text({ agent }), DEFAULT_SECTION);

  await ctx.provided.askMode.set(agent, false);
  assert.equal(section.text({ agent }), '');
});

test('config.section replaces the guidance', async () => {
  const { ctx, agent } = mount({ section: 'Be terse and read-only.' });
  await ctx.provided.askMode.set(agent, true);
  assert.equal(ctx.sections[0].text({ agent }), 'Be terse and read-only.');
});

test('/ask turns the mode on and /ask off turns it off (scope: session)', async () => {
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

test('by default ask mode covers one turn and ends when that turn ends', async () => {
  const { ctx, agent, session } = mount(undefined);
  const [guard] = ctx.guards;

  const result = await executeCommand(ctx, agent, '/ask why is the retry budget 3?');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /for one turn/);
  assert.equal(ctx.provided.askMode.isActive(session), true);
  assert.ok(guard({ name: 'write', agent }), 'the ask turn is enforced read-only');
  assert.equal(agent.steered.length, 1, 'the question is steered as the turn’s message');

  ctx.runTurnEnd(agent);
  assert.equal(ctx.provided.askMode.isActive(session), false, 'ask mode ends with the turn');
  assert.deepEqual(ctx.projections.viewOf(session, 'ask'), { active: false, pending: false });
  assert.equal(guard({ name: 'write', agent }), undefined, 'a later message is ordinary work again');
  assert.equal(ctx.sections[0].text({ agent }), '', 'and the guidance is gone');
});

test('several ask turns each end on their own turn, with no /ask off', async () => {
  const { ctx, agent, session } = mount(undefined);
  for (let turn = 0; turn < 2; turn += 1) {
    await executeCommand(ctx, agent, `/ask question ${turn}`);
    assert.equal(ctx.provided.askMode.isActive(session), true);
    ctx.runTurnEnd(agent);
    assert.equal(ctx.provided.askMode.isActive(session), false);
  }
  const runs = session.eventsOfType('command/run').filter((event) => event.data.name === 'ask');
  assert.equal(runs.length, 2, 'each turn left its own /ask record');
});

test('an /ask typed mid-turn is already in effect for the rest of that turn', async () => {
  const { ctx, agent, session } = mount(undefined);
  ctx.projections.setStatic('turnBoundary', { openTurnStartSeq: 0 });

  await executeCommand(ctx, agent, '/ask answer me read-only');
  assert.equal(ctx.provided.askMode.isActive(session), true, 'the command record settles the switch');
  assert.ok(ctx.guards[0]({ name: 'write', agent }), 'the guard closes for the rest of the turn');

  ctx.runTurnEnd(agent);
  assert.equal(ctx.provided.askMode.isActive(session), false);
});

test('scope: session keeps the mode on across turns until /ask off', async () => {
  const { ctx, agent, session } = mount({ scope: 'session' });
  await executeCommand(ctx, agent, '/ask');
  ctx.runTurnEnd(agent);
  ctx.runTurnEnd(agent);
  assert.equal(ctx.provided.askMode.isActive(session), true, 'a standing mode ignores the turn end');
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
  assert.deepEqual(session.eventsOfType('plan/mode').map((event) => event.data), [{ active: true }, { active: false }]);
});

test('the default one-turn mode leaves plan mode alone', async () => {
  const { ctx, agent, session } = mount(undefined);
  session.append('plan/mode', { active: true });
  ctx.projections.setStatic('plan', { active: true });
  const result = await executeCommand(ctx, agent, '/ask');
  assert.doesNotMatch(result.text, /Plan mode/);
  ctx.runTurnEnd(agent);
  assert.deepEqual(session.eventsOfType('plan/mode').map((event) => event.data), [{ active: true }], 'only the seed event is there');
});

test('the switch is narrated into the next admitted step (scope: session)', async () => {
  const { ctx, agent, session, told } = mount({ scope: 'session' });
  await told(false); // the last request was told ask mode is off

  await executeCommand(ctx, agent, '/ask answer me read-only');
  assert.equal(session.eventsOfType('request/header').length, 1);

  const decision = await ctx.runPreStep(agent);
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 1, 'the switch is narrated into the admitted step');
  assert.equal(decision.messages[0].source.form, 'notice');
  assert.match(decision.messages[0].content[0].text, /switched this session to ask mode/);

  // A second step of the same request series is not told again.
  session.append('request/header', { header: {} });
  const second = await ctx.runPreStep(agent);
  assert.equal(second.messages.length, 0);
});

test('the one-turn scope does not narrate by default', async () => {
  const { ctx, agent, told } = mount(undefined);
  await told(false);
  await executeCommand(ctx, agent, '/ask');
  const decision = await ctx.runPreStep(agent);
  assert.equal(decision.messages.length, 0);
});

test('the pre-step listener leaves a rejected or aborted step alone', async () => {
  const rejected = mount({ scope: 'session' });
  await rejected.told(false);
  await executeCommand(rejected.ctx, rejected.agent, '/ask');
  const decision = await rejected.ctx.runPreStep(rejected.agent, { decision: { kind: 'reject' } });
  assert.equal(decision.kind, 'reject');
  assert.deepEqual(decision, { kind: 'reject' }, 'no notice rides a rejected step');

  const aborted = mount({ scope: 'session' });
  await aborted.told(false);
  await executeCommand(aborted.ctx, aborted.agent, '/ask');
  const controller = new AbortController();
  controller.abort();
  const kept = await aborted.ctx.runPreStep(aborted.agent, { signal: controller.signal });
  assert.equal(kept.messages.length, 0);
});

test('the guard denies mutation only while the mode is on', async () => {
  const { ctx, agent, session } = mount(undefined);
  const [guard] = ctx.guards;
  const execution = (toolName, target = agent) => ({ name: toolName, agent: target });

  assert.equal(guard(execution('write')), undefined, 'ask mode is off');
  await executeCommand(ctx, agent, '/ask');
  assert.ok(guard(execution('write')), 'ask mode is on');
  assert.ok(guard(execution('pwsh')));
  assert.equal(guard(execution('read')), undefined);
  assert.equal(guard(execution('write', { session: createFakeSession(ctx.projections).session })), undefined, 'another session is unaffected');

  ctx.runTurnEnd(agent);
  assert.equal(guard(execution('write')), undefined, 'the turn released it');
  assert.equal(ctx.provided.askMode.isActive(session), false);
});

test('enforce: false leaves the tool catalog untouched', () => {
  const { ctx } = mount({ enforce: false });
  assert.equal(ctx.guards.length, 0);
});

test('blockedTools and allowedTools shape the guard', async () => {
  const { ctx, agent } = mount({ blockedTools: ['custom_mutator'], allowedTools: [] });
  await ctx.provided.askMode.set(agent, true);
  assert.ok(ctx.guards[0]({ name: 'custom_mutator', agent }));
  assert.equal(ctx.guards[0]({ name: 'write', agent }), undefined, 'the defaults were replaced');
});

test('ctx.askMode.set drives the real command, so the switch is a durable record', async () => {
  const { ctx, agent, session } = mount(undefined);
  const result = await ctx.provided.askMode.set(agent, true);
  assert.equal(result.kind, 'success');
  assert.equal(ctx.provided.askMode.isActive(session), true);
  const runs = session.eventsOfType('command/run').filter((event) => event.data.name === 'ask');
  assert.equal(runs.length, 1);
  assert.equal(session.eventsOfType('command/done').length, 1);
});

test('ctx.askMode.set reports a missing command surface instead of failing silently', async () => {
  const { ctx, agent } = mount(undefined, { withCommands: false });
  assert.equal(ctx.commands.length, 0);
  await assert.rejects(() => ctx.provided.askMode.set(agent, true), /requires the commands service/);
});

test('a profile without a command surface still gets the guidance and guard', () => {
  const { ctx, agent } = mount(undefined, { withCommands: false });
  assert.equal(ctx.commands.length, 0);
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.guards.length, 1);
  assert.equal(ctx.sections[0].text({ agent }), '');
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

test('a resumed session replays the mode out of the log', async () => {
  const { ctx, agent, session } = mount(undefined);
  await executeCommand(ctx, agent, '/ask');
  assert.equal(ctx.provided.askMode.isActive(session), true);

  // A resumed session folds the same records into a fresh projection cell.
  const resumed = createFakeSession(ctx.projections);
  for (const event of session.events) resumed.session.append(event.type, event.data);
  assert.equal(ctx.provided.askMode.isActive(resumed.session), true);
  assert.deepEqual(ctx.projections.viewOf(resumed.session, 'ask'), { active: true, pending: false });

  // ... and a turn that had already ended does not come back to life.
  const resumedAfterTurn = createFakeSession(ctx.projections);
  const events = [...session.events, { type: 'turn/end', seq: session.events.length, time: 1, data: { turn: 1, reason: { kind: 'completed' } } }];
  for (const event of events) resumedAfterTurn.session.append(event.type, event.data);
  assert.equal(ctx.provided.askMode.isActive(resumedAfterTurn.session), false);
});
