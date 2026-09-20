/**
 * Message helpers for the `/ask` mode plugin.
 *
 * `@deepseek-ai/dsh-llm`'s `createUserMessage` is what the shipped plugins use,
 * but importing that package statically would break `link:` installs (Node
 * resolves a linked package's bare imports from its real path, outside the
 * profile's `node_modules`). The helper below reproduces the same contract with
 * no dependency: a user-role message with a fresh identity, deep-frozen before
 * publication. `agent.steer()`/`agent.inject()` only read `id`, `role`,
 * `content`, and `source`, so the shape is the entire interface.
 *
 * @module dsh-helper-plugin-command-ask/lib/message
 */

import { randomUUID } from 'node:crypto';

/** Bound for a `notice` form's one-line account, matching the harness constant. */
export const CONTEXT_SUMMARY_MAX_CHARS = 120;

/**
 * Freeze a value graph in place.
 *
 * @template T
 * @param {T} value - the value to freeze.
 * @returns {T} the same value, deeply frozen.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Build one immutable, identified user message.
 *
 * @param {{ content: readonly object[], source: object }} input - message content
 *   blocks and their source.
 * @returns {object} the frozen user message.
 */
export function createUserMessage(input) {
  return deepFreeze({
    ...input,
    role: 'user',
    id: randomUUID(),
  });
}

/**
 * Build a plugin-sourced notice: context the model sees as a user message, with
 * the collapsed-transcript summary a UI renders.
 *
 * @param {string} text - the model-facing account.
 * @param {string} plugin - the producing plugin's name.
 * @returns {object} the frozen user message.
 */
export function noticeMessage(text, plugin) {
  const summary = text.length > CONTEXT_SUMMARY_MAX_CHARS ? `${text.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…` : text;
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin,
      form: 'notice',
      summary,
    },
  });
}
