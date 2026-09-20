/**
 * The read-only tool guard.
 *
 * Guidance alone cannot make a mode read-only: the model can still call a
 * mutating tool by mistake, and a retry loop turns one mistake into a mess. The
 * tool registry exposes a monotonic guard seam that runs after the extensible
 * `tools/pre-execute` waterfall and can deny a call by returning a reason
 * (`ctx.tools.guard()`), which is exactly the hook a read-only mode needs:
 * synchronous, per-call, and impossible to force-allow past.
 *
 * The guard is a deny list, checked only while ask mode is effectively active
 * (a settled selection counts, so a mode switch that is still waiting for its
 * step boundary cannot be raced by a tool call in the same turn).
 *
 * @module dsh-helper-plugin-command-ask/lib/guard
 */

/**
 * Build the guard function.
 *
 * @param {object} options - the guard's policy.
 * @param {(session: object) => boolean} options.effectiveActive - whether the
 *   session is in ask mode (logged or pending).
 * @param {readonly string[]} options.blockedTools - names denied in ask mode.
 * @param {readonly string[]} options.allowedTools - names that always pass.
 * @param {string} options.plugin - the plugin name used in the denial text.
 * @returns {(execution: object) => string | undefined} the guard; a returned
 *   string denies the call with that reason.
 */
export function createReadOnlyGuard({ effectiveActive, blockedTools, allowedTools, plugin }) {
  const blocked = new Set(blockedTools);
  const allowed = new Set(allowedTools);

  return function askModeReadOnlyGuard(execution) {
    const session = execution?.agent?.session;
    if (session === undefined || session === null) return undefined;
    const name = execution.name;
    if (typeof name !== 'string' || name === '') return undefined;
    if (allowed.has(name)) return undefined;
    if (!blocked.has(name)) return undefined;
    if (!effectiveActive(session)) return undefined;
    return `${plugin}: ask mode is read-only, so the "${name}" tool is blocked for this session. `
      + 'Answer from what you can inspect instead, and tell the user to run /ask off (or start a new message outside ask mode) when the change is actually wanted.';
  };
}
