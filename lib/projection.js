/**
 * The `ask` session-projection unit.
 *
 * The session log is the durable state: `/ask`, `/ask off`, and every settled
 * command run fold into one value, so resume, fork, and compaction recover ask
 * mode by replaying the log — there is no live mirror to keep in sync. The
 * shape mirrors `@deepseek-ai/dsh-plan-mode`'s `plan` unit (whole-value
 * `ask/mode` events, a `wanted` selection awaiting the next step boundary, and
 * `activeAtLastHeader` for narration), which is what lets an `ask` unit be folded
 * by the same registry with the same guarantees.
 *
 * @module dsh-helper-plugin-command-ask/lib/projection
 */

import { askStateSchema, askViewSchema } from './schema.js';

/** The projection key this unit owns. */
export const ASK_PROJECTION_KEY = 'ask';

/** The durable event carrying the whole ask-mode state. */
export const ASK_MODE_EVENT = 'ask/mode';

/** The command name whose runs mark a settled selection. */
export const ASK_COMMAND_NAME = 'ask';

/** The exact empty-log state. */
function init() {
  return {
    active: false,
    wanted: null,
    running: null,
    activeAtLastHeader: null,
  };
}

/**
 * Pure transition over one committed session event.
 *
 * @param {object} state - state covering every prior event.
 * @param {object} event - the committed event.
 * @returns {object} the next state, or the same reference when unrelated.
 */
function apply(state, event) {
  if (event.type === 'command/run' && event.data?.name === ASK_COMMAND_NAME) {
    // `args` is absent when the definition sets `recordInput: false`; the plugin
    // keeps the default so a `/ask off` is visible in the log.
    if (event.data.args === undefined) return state;
    const wanted = event.data.args.trim() !== 'off';
    return { ...state, running: { commandId: event.data.commandId, wanted } };
  }
  if (event.type === 'command/done' && event.data?.commandId === state.running?.commandId) {
    const wanted = event.data.kind === 'success' && state.running.wanted !== state.active ? state.running.wanted : null;
    return { ...state, wanted, running: null };
  }
  if (event.type === ASK_MODE_EVENT) {
    return { ...state, active: event.data?.active === true, wanted: null };
  }
  if (event.type === 'request/header') {
    return { ...state, activeAtLastHeader: state.active };
  }
  return state;
}

/**
 * Reference-stable client view.
 *
 * The registry publishes a change only when the raw view result changes by
 * `Object.is`, and the state reference changes on every `request/header` (and
 * every running-command record) even when `{ active, pending }` does not. The
 * view therefore interns the four possible values instead of building a new
 * object per state, so an unchanged chip is never republished to clients.
 */
const views = new Map();

/**
 * The client-visible value: which mode the log holds, and whether a settled
 * selection still awaits its step boundary.
 *
 * @param {object} state - the projection state.
 * @returns {{ active: boolean, pending: boolean }} the wire value.
 */
function view(state) {
  const wanted = state.running?.wanted ?? state.wanted;
  const pending = wanted !== null && wanted !== state.active;
  const key = `${state.active}|${pending}`;
  const cached = views.get(key);
  if (cached !== undefined) return cached;
  const value = Object.freeze({ active: state.active, pending });
  views.set(key, value);
  return value;
}

/** The registrable unit, passed to `ctx.sessionProjections.register()`. */
export const askProjectionDefinition = Object.freeze({
  key: ASK_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: askStateSchema,
  init,
  apply,
  wire: {
    viewSchema: askViewSchema,
    view,
  },
});
