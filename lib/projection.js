/**
 * The `ask` session-projection unit.
 *
 * The session log is the durable state, and the mode is folded from events the
 * harness already knows — never from a vocabulary this plugin invents:
 *
 * | Event | Meaning for ask mode |
 * |---|---|
 * | `command/run` (`name: 'ask'`) | the user (or `ctx.askMode.set`) invoked `/ask`, listing `off` or not |
 * | `command/done` (matching id, `kind: 'success'`) | the invocation settled: that is the state change |
 * | `turn/end` | a turn closed; with `scope: turn` the mode it covered is over |
 * | `request/header` | what the last model request was told, for the switch notice |
 *
 * Why not a dedicated `ask/mode` event: `Session.append()` cannot set the
 * envelope's `ignorable` marker, and `@deepseek-ai/dsh-session`'s
 * `KNOWN_SESSION_EVENT_TYPES` is a generated in-repo inventory ("downstream
 * (out-of-repo) plugin events are outside this list by construction"). The
 * persistence read path therefore refuses a log containing such an event —
 * *"unknown to this harness and not marked ignorable; refusing to interpret the
 * log"* — which makes every session that ever ran `/ask` unloadable. Deriving the
 * mode from known events keeps the log readable by any harness, and
 * `scripts/repair-ask-mode-logs.mjs` repairs logs an earlier version wrote.
 *
 * Resume, fork, and compaction recover the mode by replaying those events, so
 * there is still no live mirror to keep in sync.
 *
 * @module dsh-helper-plugin-command-ask/lib/projection
 */

import { askStateSchema, askViewSchema } from './schema.js';

/** The projection key this unit owns. */
export const ASK_PROJECTION_KEY = 'ask';

/** The command name whose runs drive the mode. */
export const ASK_COMMAND_NAME = 'ask';

/**
 * Persisted-cache invalidation version. 2 replaced the `ask/mode` fold with the
 * known-event fold, so rows written by version 1 must be discarded.
 */
export const ASK_PROJECTION_STATE_VERSION = 2;

/** The exact empty-log state. */
function init() {
  return {
    active: false,
    running: null,
    activeAtLastHeader: null,
  };
}

/**
 * Build the projection unit for one deployment's scope.
 *
 * @param {object} [options] - deployment options.
 * @param {'turn'|'session'} [options.scope] - whether a closed turn ends the mode.
 * @returns {object} the registrable definition.
 */
export function createAskProjection({ scope = 'turn' } = {}) {
  const oneTurn = scope !== 'session';

  /**
   * Pure transition over one committed session event.
   *
   * @param {object} state - state covering every prior event.
   * @param {object} event - the committed event.
   * @returns {object} the next state, or the same reference when unrelated.
   */
  function apply(state, event) {
    if (event.type === 'command/run' && event.data?.name === ASK_COMMAND_NAME) {
      // `args` is absent when the definition sets `recordInput: false`; the
      // plugin keeps the default so `/ask off` is distinguishable in the log.
      if (event.data.args === undefined) return state;
      const wanted = event.data.args.trim() !== 'off';
      return { ...state, running: { commandId: event.data.commandId, wanted } };
    }
    if (event.type === 'command/done' && event.data?.commandId === state.running?.commandId) {
      // A failed invocation changes nothing: the handler owns admission (an
      // `/ask off` carrying attachments is rejected before any state change).
      const active = event.data.kind === 'success' ? state.running.wanted : state.active;
      return { ...state, active, running: null };
    }
    if (event.type === 'turn/end' && oneTurn && state.active) {
      return { ...state, active: false };
    }
    if (event.type === 'request/header') {
      return { ...state, activeAtLastHeader: state.active };
    }
    return state;
  }

  /**
   * Reference-stable client view: the registry publishes a change only when the
   * raw view result changes by `Object.is`, so the four possible values are
   * interned instead of rebuilt per state.
   */
  const views = new Map();

  /**
   * @param {object} state - the projection state.
   * @returns {{ active: boolean, pending: boolean }} the wire value; `pending`
   *   is true while an `/ask` invocation is in flight.
   */
  function view(state) {
    const pending = state.running !== null;
    const key = `${state.active}|${pending}`;
    const cached = views.get(key);
    if (cached !== undefined) return cached;
    const value = Object.freeze({ active: state.active, pending });
    views.set(key, value);
    return value;
  }

  return Object.freeze({
    key: ASK_PROJECTION_KEY,
    stateVersion: ASK_PROJECTION_STATE_VERSION,
    stateSchema: askStateSchema,
    init,
    apply,
    wire: {
      viewSchema: askViewSchema,
      view,
    },
  });
}

/** The unit for the default `scope: turn` deployment. */
export const askProjectionDefinition = createAskProjection({ scope: 'turn' });
