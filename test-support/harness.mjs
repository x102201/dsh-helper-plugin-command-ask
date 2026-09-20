/**
 * Test harness: a minimal stand-in for the Cordis tree the plugin mounts into.
 *
 * The real seams used by the plugin are small and synchronous — the command
 * registry, the system-prompt section registry, the session-projection registry,
 * the tool guard, and the agent pre-step waterfall — so reproducing them here
 * lets the tests drive the real plugin code (index.js and lib/) without booting
 * dsh. What is deliberately faithful:
 *
 * - `session.append()` publishes to the projection registry, which is how the
 *   real `Session` drives every unit's fold.
 * - The projection registry folds lazily over the log, like the real one.
 * - `executeCommand()` appends `command/run` and `command/done` around the
 *   handler, exactly as `ctx.commands.execute()` does, so the `wanted`/`pending`
 *   fold is exercised for real.
 *
 * @module test/support/harness
 */

/** Deep clone through JSON, matching the log's lossless-JSON discipline. */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * A projection registry with the real read/fold contract.
 *
 * Static keys (`setStatic`) stand in for projections another plugin owns
 * (`turnBoundary` from the agent loop). Real stub units can be registered too
 * (the tests register a folding `plan` unit to exercise plan-mode supersession).
 */
export function createFakeProjections() {
  const units = new Map();
  const statics = new Map();
  const cells = new WeakMap();
  const changeListeners = new Set();

  function cellFor(session, unit) {
    let perSession = cells.get(session);
    if (perSession === undefined) {
      perSession = new Map();
      cells.set(session, perSession);
    }
    let cell = perSession.get(unit.key);
    if (cell === undefined) {
      let state = unit.init(session.header ?? {}, 0);
      for (const event of session.snapshotEvents()) state = unit.apply(state, event);
      cell = { state };
      perSession.set(unit.key, cell);
    }
    return cell;
  }

  return {
    register(definition) {
      units.set(definition.key, definition);
      return () => units.delete(definition.key);
    },
    stateOf(session, key) {
      const unit = units.get(key);
      if (unit === undefined) return statics.get(key);
      return cellFor(session, unit).state;
    },
    /** The client-visible value, as the real registry's `viewCell` produces it. */
    viewOf(session, key) {
      const unit = units.get(key);
      if (unit?.wire === undefined) return undefined;
      return unit.wire.viewSchema.parse(unit.wire.view(cellFor(session, unit).state));
    },
    /** Set a stand-in state for a key no unit owns. */
    setStatic(key, state) {
      statics.set(key, state);
    },
    /** Fold one committed event through every registered unit, then notify. */
    drive(session, event) {
      for (const unit of units.values()) {
        const cell = cellFor(session, unit);
        const before = unit.wire === undefined ? undefined : unit.wire.view(cell.state);
        cell.state = unit.apply(cell.state, event);
        if (unit.wire === undefined) continue;
        const after = unit.wire.view(cell.state);
        // The real registry publishes only when the raw view changes by identity.
        if (Object.is(before, after)) continue;
        for (const listener of changeListeners) listener(session, unit.key, after, event.seq);
      }
    },
    /** The registry's change feed, as `ctx.sessionProjections.onChanged`. */
    onChanged(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    get units() {
      return units;
    },
  };
}

/**
 * One fake session whose appends drive the projection registry.
 *
 * @param {object} projections - the registry to drive.
 * @returns {object} the session.
 */
export function createFakeSession(projections) {
  const log = [];
  const appends = { throws: false };
  const session = {
    header: { id: 'session-test' },
    snapshotEvents: () => log,
    seq: () => log.length - 1,
    append(type, data) {
      // A refused append commits nothing, like the real acceptance boundary.
      if (appends.throws === true) throw new Error('append refused');
      const event = { type, seq: log.length, time: 1_700_000_000_000 + log.length, data: clone(data) };
      log.push(event);
      projections.drive(session, event);
      return event;
    },
    get events() {
      return log;
    },
    eventsOfType(type) {
      return log.filter((event) => event.type === type);
    },
  };
  return { session, control: appends };
}

/** One fake agent over a session. */
export function createFakeAgent(session) {
  return {
    session,
    steered: [],
    injected: [],
    steer(message) {
      this.steered.push(message);
    },
    inject(message) {
      this.injected.push(message);
    },
  };
}

/**
 * The fake Cordis context: records every registration the plugin makes and can
 * drive the recorded command handler and pre-step listener.
 *
 * @param {object} [options] - harness options.
 * @param {boolean} [options.withCommands] - compose a `commands` service.
 * @param {boolean} [options.provideThrows] - make `ctx.provide` fail.
 * @returns {object} the context.
 */
export function createFakeCtx(options = {}) {
  const { withCommands = true, provideThrows = false } = options;
  const projections = createFakeProjections();
  const sections = [];
  const commands = [];
  const guards = [];
  const listeners = new Map();
  const warnings = [];
  const provided = {};
  const effects = [];
  const flushes = [];

  /** The composed commands service: registration plus the real dispatch shape. */
  const commandsService = {
    register: (definition) => commands.push(definition),
    /**
     * The real dispatcher settles a `CommandExecution` (`{commandId, result}`)
     * after appending the same lifecycle events around the handler.
     */
    execute: async (agent, line, attachments = [], signal = new AbortController().signal) => {
      const result = await executeCommand(ctx, agent, line, attachments, signal);
      const done = agent.session.eventsOfType('command/done').at(-1);
      return { commandId: done?.data.commandId, result };
    },
  };

  const ctx = {
    projections,
    sections,
    commands,
    guards,
    warnings,
    provided,
    effects,
    flushes,
    logger: {
      info: () => {},
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      error: (...args) => warnings.push(args.map(String).join(' ')),
    },
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
    /** Faithful in result, simplified in timing: the real one settles a tick later. */
    inject(names, callback) {
      const wanted = Array.isArray(names) ? names : [names];
      if (wanted.includes('commands') && withCommands) callback({ commands: commandsService });
      return () => {};
    },
    /** Service lookup, as `ctx.get(name)` on the real context. */
    get(name) {
      if (name === 'commands') return withCommands ? commandsService : undefined;
      if (name === 'tools') return ctx.tools;
      if (name === 'systemPrompt') return ctx.systemPrompt;
      if (name === 'sessionProjections') return ctx.sessionProjections;
      if (name === 'sessions') return ctx.sessions;
      return undefined;
    },
    effect(callback) {
      effects.push(callback);
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    provide(serviceName, value) {
      if (provideThrows) throw new Error(`service "${serviceName}" has been registered`);
      provided[serviceName] = value;
      return () => {
        delete provided[serviceName];
      };
    },
    systemPrompt: {
      section: (definition) => sections.push(definition),
      getSectionOrder: (orderName) => (orderName === 'PLAN_POLICY' ? 500 : -1),
    },
    tools: {
      guard: (guard) => guards.push(guard),
    },
    sessionProjections: {
      register: (definition) => projections.register(definition),
      stateOf: (session, key) => projections.stateOf(session, key),
      /** The registry's change feed: one call per changed client-visible unit. */
      onChanged: (listener) => projections.onChanged(listener),
    },
    /** The session store: `flush` is the durability checkpoint the plugin uses. */
    sessions: {
      flush: async (session) => {
        flushes.push(session);
        return true;
      },
    },
    /** Run every recorded `agent/pre-step` listener as the loop's waterfall does. */
    async runPreStep(agent, { decision = { kind: 'enter', messages: [] }, signal = new AbortController().signal } = {}) {
      const chain = listeners.get('agent/pre-step') ?? [];
      let index = 0;
      const next = async () => {
        const handler = chain[index];
        index += 1;
        if (handler === undefined) return decision;
        return handler({ agent, messages: [], turn: 1, step: 1, signal }, next);
      };
      return next();
    },
    /**
     * Close a turn the way the agent loop does: append `turn/end`. Ask mode's
     * one-turn scope is released by that event, not by a plugin listener.
     */
    runTurnEnd(agent, reason = { kind: 'completed' }) {
      agent.session.append('turn/end', { turn: 1, reason });
    },
    /** The registered `/ask` definition, when the commands service was composed. */
    command(name) {
      return commands.find((definition) => definition.name === name);
    },
  };
  return ctx;
}

/**
 * Execute one command line through the recorded definition, appending the same
 * lifecycle events the real registry appends.
 *
 * @param {object} ctx - the fake context.
 * @param {object} agent - the receiving agent.
 * @param {string} line - the full command line, e.g. `/ask off`.
 * @param {object[]} [attachments] - admitted attachment blocks.
 * @param {AbortSignal} [signal] - the dispatching caller's signal.
 * @returns {Promise<object>} the settled result.
 */
export async function executeCommand(ctx, agent, line, attachments = [], signal = new AbortController().signal) {
  const space = line.indexOf(' ');
  const name = space === -1 ? line.slice(1) : line.slice(1, space);
  const rawInput = space === -1 ? '' : line.slice(space + 1);
  const definition = ctx.command(name);
  if (definition === undefined) throw new Error(`no command registered named ${name}`);
  const commandId = `cmd-${agent.session.events.length + 1}`;
  agent.session.append('command/run', { commandId, name, args: rawInput, source: { kind: 'user' } });
  let result;
  try {
    result = await definition.handler({ commandId, agent, rawInput, attachments, signal });
  } catch (error) {
    result = { kind: 'error', text: String(error) };
  }
  agent.session.append('command/done', { commandId, kind: result.kind, text: result.text });
  return result;
}
