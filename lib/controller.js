/**
 * The ask-mode state machine: durable selection, step-boundary commit, and
 * narration.
 *
 * The controller is a plain closure over two seams — read a projection, append a
 * log event — so the whole mode lifecycle is testable without booting a Cordis
 * tree. The semantics are the ones `@deepseek-ai/dsh-plan-mode` establishes for a
 * logged collaboration mode:
 *
 * - Between turns a selection is logged immediately; during an open turn it
 *   stays pending until the next accepted in-turn pre-step, which is the only
 *   append point while an agent runs.
 * - Re-selecting the current or already-pending state is a no-op.
 * - A logged switch that changes what the last request was told injects one
 *   user-switch notice, so the model is not left reasoning under the old
 *   stance.
 *
 * @module dsh-helper-plugin-command-ask/lib/controller
 */

import { ASK_MODE_EVENT, ASK_PROJECTION_KEY } from './projection.js';
import { noticeMessage } from './message.js';

/** The plan-mode projection key read for `supersedePlanMode`. */
export const PLAN_PROJECTION_KEY = 'plan';

/** The plan-mode durable event appended when ask mode supersedes it. */
export const PLAN_MODE_EVENT = 'plan/mode';

/** The agent-loop projection that says whether a turn is currently open. */
export const TURN_BOUNDARY_PROJECTION_KEY = 'turnBoundary';

/** What a selection did. */
export const OUTCOME = Object.freeze({
  /** Logged now. */
  committed: 'committed',
  /** Awaiting the next accepted in-turn pre-step. */
  queued: 'queued',
  /** An opposite pending selection was cleared; the logged state already matched. */
  cancelled: 'cancelled',
  /** Already in that state. */
  noop: 'noop',
});

/**
 * Create the controller.
 *
 * @param {object} deps - the controller's seams.
 * @param {(session: object, key: string) => object | undefined} deps.readProjection -
 *   read one registered projection state (`undefined` when the key is absent).
 * @param {(session: object, type: string, data: object) => void} deps.append -
 *   append one log event.
 * @param {boolean} deps.narrate - inject a user-switch notice on a logged switch.
 * @param {boolean} deps.supersedePlanMode - leave plan mode when ask mode is entered.
 * @param {string} deps.plugin - the plugin name carried by notice messages.
 * @param {(message: string, error?: unknown) => void} deps.warn - degraded-path diagnostics.
 * @returns {object} the controller surface.
 */
export function createModeController(deps) {
  /** Latest selection per session awaiting the next accepted in-turn pre-step. */
  const pendingIntents = new WeakMap();
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

  /** Whether the logged state has ask mode on. */
  function loggedActive(session) {
    return askState(session)?.active === true;
  }

  /** `active` as of the last request header, or `undefined` when none was logged. */
  function loggedActiveAtLastHeader(session) {
    return askState(session)?.activeAtLastHeader ?? undefined;
  }

  /** The logged state plus any selection still awaiting its boundary. */
  function effectiveActive(session) {
    const pending = pendingIntents.get(session);
    return pending === undefined ? loggedActive(session) : pending;
  }

  /** Plan mode's logged state, `false` when plan mode is not composed. */
  function planActive(session) {
    return deps.readProjection(session, PLAN_PROJECTION_KEY)?.active === true;
  }

  /**
   * Whether a turn is currently open. `turnBoundary` is registered by the agent
   * loop; without it there is no turn to defer to, so a selection commits
   * immediately (a profile composing this plugin without an agent loop has no
   * turns at all).
   */
  function hasOpenTurn(session) {
    const state = deps.readProjection(session, TURN_BOUNDARY_PROJECTION_KEY);
    if (state === undefined) {
      warnOnce('turnBoundary', 'the turnBoundary session projection is absent; ask-mode selections commit immediately instead of at the next step boundary');
      return false;
    }
    return state.openTurnStartSeq !== null;
  }

  /** Append one ask-mode value, and leave plan mode when entering ask mode. */
  function commit(session, active) {
    deps.append(session, ASK_MODE_EVENT, { active });
    if (!active || !deps.supersedePlanMode) return false;
    if (!planActive(session)) return false;
    // Ask mode is strictly narrower than plan mode (no plan to approve), so the
    // two are never meant to be on at once. Writing plan mode's own durable
    // event keeps the two plugins decoupled: no service handle, no realm
    // crossing, and the fold recovers the result like any other mode change.
    deps.append(session, PLAN_MODE_EVENT, { active: false });
    return true;
  }

  /**
   * Read the logged state and any pending selection.
   *
   * @param {object} agent - the agent to read.
   * @returns {{ active: boolean, pending?: boolean }} the current state.
   */
  function get(agent) {
    const active = loggedActive(agent.session);
    const pending = pendingIntents.get(agent.session);
    return pending === undefined ? { active } : { active, pending };
  }

  /**
   * Select whether ask mode should be active.
   *
   * @param {object} agent - the agent to switch.
   * @param {boolean} active - the requested state.
   * @returns {{ outcome: string, supersededPlan: boolean }} what happened; see
   *   {@link OUTCOME}.
   */
  function set(agent, active) {
    const session = agent.session;
    const current = pendingIntents.get(session) ?? loggedActive(session);
    if (active === current) return { outcome: OUTCOME.noop, supersededPlan: false };

    if (hasOpenTurn(session)) {
      pendingIntents.set(session, active);
      return {
        outcome: loggedActive(session) === active ? OUTCOME.cancelled : OUTCOME.queued,
        supersededPlan: false,
      };
    }

    if (active === loggedActive(session)) {
      pendingIntents.delete(session);
      return { outcome: OUTCOME.cancelled, supersededPlan: false };
    }

    const supersededPlan = commit(session, active);
    pendingIntents.delete(session);
    const narration = narrate(session, active);
    if (narration !== undefined) agent.inject(narration);
    return { outcome: OUTCOME.committed, supersededPlan };
  }

  /**
   * End ask mode for a finished turn: the turn-scoped half of the mode.
   *
   * `/ask <question>` means "answer this read-only", not "put this session in a
   * read-only stance", so the mode is logged off when the turn that consumed it
   * stops. The `agent/turn-stopping` listener calls this; it never throws into
   * the turn-closing path and never narrates, because the next request simply
   * arrives without the `ask:policy` section.
   *
   * @param {object} session - the session whose turn just stopped.
   * @returns {boolean} whether the logged state changed.
   */
  function disarm(session) {
    pendingIntents.delete(session);
    if (!loggedActive(session)) return false;
    deps.append(session, ASK_MODE_EVENT, { active: false });
    return true;
  }

  /** The pending selection for a session, or `undefined`. */
  function pendingOf(session) {
    const pending = pendingIntents.get(session);
    return pending === undefined ? undefined : { active: pending };
  }

  /**
   * Append one pending selection before the next request assembly. The pending
   * entry is only cleared after a successful append, so a failed append leaves
   * the selection in place for the next boundary.
   *
   * @param {object} session - the session whose pending selection to apply.
   */
  function applyBoundary(session) {
    const target = pendingIntents.get(session);
    if (target === undefined) return;
    if (target === loggedActive(session)) {
      pendingIntents.delete(session);
      return;
    }
    commit(session, target);
    pendingIntents.delete(session);
  }

  /**
   * Build the user-switch notice for a target mode, or `undefined` when the last
   * request already described that mode (or no request was made yet).
   *
   * @param {object} session - the session switching.
   * @param {boolean} target - the mode being selected.
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

  return Object.freeze({
    get,
    set,
    disarm,
    narrate,
    pendingOf,
    applyBoundary,
    loggedActive,
    loggedActiveAtLastHeader,
    effectiveActive,
    planActive,
    hasOpenTurn,
  });
}
