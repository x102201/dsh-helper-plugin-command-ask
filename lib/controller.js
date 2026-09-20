/**
 * Read-side helpers for the ask mode, plus the one log write the plugin still
 * makes: the plan-mode handoff.
 *
 * Ask mode's own state is not written by this module — it is folded from the
 * `/ask` command records by the `ask` projection unit (see `projection.js`).
 * What remains here is the small amount of deployment policy around that state:
 * reading it, deciding whether entering the mode should leave plan mode, and
 * building the user-switch notice.
 *
 * @module dsh-helper-plugin-command-ask/lib/controller
 */

import { ASK_PROJECTION_KEY } from './projection.js';
import { noticeMessage } from './message.js';

/** The plan-mode projection key read for `supersedePlanMode`. */
export const PLAN_PROJECTION_KEY = 'plan';

/** The plan-mode durable event appended when ask mode supersedes it. */
export const PLAN_MODE_EVENT = 'plan/mode';

/** The agent-loop projection that says whether a turn is currently open. */
export const TURN_BOUNDARY_PROJECTION_KEY = 'turnBoundary';

/**
 * Create the read-side controller.
 *
 * @param {object} deps - the controller's seams.
 * @param {(session: object, key: string) => object | undefined} deps.readProjection -
 *   read one registered projection state (`undefined` when the key is absent).
 * @param {(session: object, type: string, data: object) => void} deps.append -
 *   append one log event (used only for `plan/mode`).
 * @param {boolean} deps.supersedePlanMode - leave plan mode when ask mode is entered.
 * @param {boolean} deps.narrate - inject a user-switch notice on a logged switch.
 * @param {string} deps.plugin - the plugin name carried by notice messages.
 * @param {(message: string, error?: unknown) => void} deps.warn - degraded-path diagnostics.
 * @returns {object} the controller surface.
 */
export function createModeController(deps) {
  /** Diagnostics that must not repeat once per event. */
  const warned = new Set();

  /** Warn once per distinct degraded condition. */
  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    deps.warn(message);
  }

  /**
   * Read the durable ask state. A missing projection reads as inactive: ask mode
   * is a convenience mode, and failing prompt assembly or tool dispatch because
   * a projection registry lost its unit would be worse than reporting "off".
   */
  function askState(session) {
    return deps.readProjection(session, ASK_PROJECTION_KEY);
  }

  /** Whether ask mode is on for the session. */
  function loggedActive(session) {
    return askState(session)?.active === true;
  }

  /** `active` as of the last request header, or `undefined` when none was logged. */
  function loggedActiveAtLastHeader(session) {
    return askState(session)?.activeAtLastHeader ?? undefined;
  }

  /** Plan mode's logged state, `false` when plan mode is not composed. */
  function planActive(session) {
    return deps.readProjection(session, PLAN_PROJECTION_KEY)?.active === true;
  }

  /**
   * Whether a turn is currently open. `turnBoundary` is registered by the agent
   * loop; without it there is no turn to ask about, so callers treat the session
   * as idle (a profile composing this plugin without an agent loop has no turns).
   */
  function hasOpenTurn(session) {
    const state = deps.readProjection(session, TURN_BOUNDARY_PROJECTION_KEY);
    if (state === undefined) {
      warnOnce('turnBoundary', 'the turnBoundary session projection is absent; ask mode reports no open turn');
      return false;
    }
    return state.openTurnStartSeq !== null;
  }

  /**
   * Leave plan mode because a standing ask mode supersedes it. No-ops in the
   * default one-turn scope: that mode must not disturb the modes around it.
   *
   * @param {object} session - the session entering ask mode.
   * @returns {boolean} whether plan mode was switched off.
   */
  function supersedePlan(session) {
    if (!deps.supersedePlanMode) return false;
    if (!planActive(session)) return false;
    // Ask mode is strictly narrower than plan mode (no plan to approve), so the
    // two standing stances are never meant to be on at once. Writing plan mode's
    // own durable event keeps the two plugins decoupled: no service handle, no
    // realm crossing, and the fold recovers the result like any other switch.
    deps.append(session, PLAN_MODE_EVENT, { active: false });
    return true;
  }

  /**
   * Read the logged state and whether an `/ask` invocation is in flight.
   *
   * @param {object} agent - the agent to read.
   * @returns {{ active: boolean, pending?: boolean }} the current state.
   */
  function get(agent) {
    const state = askState(agent.session);
    const active = state?.active === true;
    return state?.running == null ? { active } : { active, pending: true };
  }

  /**
   * Build the user-switch notice for a target mode, or `undefined` when the last
   * request already described that mode (or no request was made yet).
   *
   * @param {object} session - the session switching.
   * @param {boolean} target - the mode now in effect.
   * @returns {object | undefined} the notice message.
   */
  function narrate(session, target) {
    if (!deps.narrate) return undefined;
    const told = loggedActiveAtLastHeader(session);
    if (told === undefined || told === target) return undefined;
    const text = target
      ? 'The user switched this session to ask mode: answer questions, change nothing.'
      : 'The user switched this session back to the default mode.';
    return noticeMessage(text, deps.plugin);
  }

  /** Whether the last request was told a mode other than the current one. */
  function narrationFor(session) {
    const now = loggedActive(session);
    return narrate(session, now);
  }

  return Object.freeze({
    get,
    narrate,
    narrationFor,
    loggedActive,
    loggedActiveAtLastHeader,
    planActive,
    supersedePlan,
    hasOpenTurn,
  });
}
