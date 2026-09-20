/**
 * dsh plugin: `dsh-helper-plugin-command-ask` — an `/ask` collaboration mode
 * modeled on `/plan`.
 *
 * ## What it is
 *
 * Cursor's Ask mode is a read-only Q&A stance: the agent answers questions about
 * the codebase, cites what it inspected, and does not change anything. DSH ships
 * that shape for planning (`/plan` + `exit_plan_mode`); this plugin adds the ask
 * shape, scoped to the turn the question belongs to:
 *
 * - `/ask <question>` answers that question read-only. The mode ends when the
 *   turn ends, so the next message without `/ask` is ordinary work again — no
 *   `/ask off` needed (config `scope`, default `turn`; `session` keeps the
 *   `/plan`-like sticky stance).
 * - While active, the deployment's guidance is rendered as the `ask:policy`
 *   prompt section on every request.
 * - An optional monotonic tool guard denies mutating tools, so the mode is
 *   enforced rather than merely requested (config `enforce`, default on).
 * - With `scope: session`, entering ask mode leaves plan mode, because the two
 *   standing stances contradict each other; the default one-turn mode leaves
 *   plan mode alone.
 * - State lives in the session log as whole-value `ask/mode` events folded by an
 *   `ask` projection unit, so resume, fork, and compaction recover it.
 *
 * ## Zero runtime dependencies
 *
 * The plugin imports nothing outside `node:` builtins and its own `lib/`. That
 * is not minimalism for its own sake: `dsh plugin --profile web add link:<dir>`
 * symlinks this directory into the profile, and Node resolves a linked package's
 * bare imports from its real path — outside the profile's `node_modules`. A
 * static `@deepseek-ai/...` or `zod` import would therefore work for a
 * `github:`/registry install and fail for a `link:` install. Everything the
 * plugin needs is reached through Cordis services on `ctx` instead.
 *
 * ## Mounting
 *
 * The bundle patch (`cordis.patch.yml`, declared as `dsh.bundle.patch`) inserts
 * one host row:
 *
 * ```sh
 * dsh plugin --profile web add link:/absolute/path/to/dsh-helper-plugin-command-ask
 * dsh plugin --profile web add github:<owner>/<repo>
 * ```
 *
 * The row targets the host plane on purpose: the command registry, the system
 * prompt, the projection registry, and the tool registry all live there, and a
 * global contribution is visible to every agent whatever preset it runs.
 *
 * @module dsh-helper-plugin-command-ask
 */

import { PLUGIN_NAME, resolveConfig } from './lib/config.js';
import { createModeController } from './lib/controller.js';
import { createReadOnlyGuard } from './lib/guard.js';
import { createUserMessage } from './lib/message.js';
import { ASK_PROJECTION_KEY, createAskProjection } from './lib/projection.js';

/** Stable Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = PLUGIN_NAME;

/**
 * Services required before the mode can be wired. `commands` is optional (a
 * UI-less profile composes no command surface) and is injected inside `apply`;
 * `sessions` provides the durability checkpoint that makes a mode switch durable
 * immediately instead of at the next ordinary checkpoint.
 */
export const inject = ['tools', 'systemPrompt', 'sessionProjections', 'sessions'];

/** The prompt section a deployment overrides with `config.section`. */
export const SECTION_NAME = 'ask:policy';

/** The slash command name. */
export const COMMAND_NAME = 'ask';

/**
 * Mount the plugin.
 *
 * @param {object} ctx - the Cordis context of the host row.
 * @param {object} [rawConfig] - the row's config; see `lib/config.js`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  const controller = createModeController({
    readProjection: (session, key) => ctx.sessionProjections.stateOf(session, key),
    append: (session, type, data) => session.append(type, data),
    narrate: config.narrate,
    supersedePlanMode: config.supersedePlanMode,
    plugin: PLUGIN_NAME,
    warn: (message) => ctx.logger.warn('%s: %s', PLUGIN_NAME, message),
  });

  // ── the switch notice ─────────────────────────────────────────────────────
  // `/ask` and `/ask off` change the mode as soon as their command record
  // settles; `turn/end` releases a one-turn mode. All of that lives in the log
  // fold, so the only work left at the step boundary is telling the model that
  // the mode it was last told about has changed (`scope: session`; off by
  // default in the one-turn scope, which has no standing stance to correct). A
  // rejected step or an aborted turn simply skips the notice.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted) return decision;
    const narration = controller.narrationFor(agent.session);
    return narration === undefined ? decision : { ...decision, messages: [...decision.messages, narration] };
  });

  // ── guidance ──────────────────────────────────────────────────────────────
  // The section is registered once, permanently, and renders '' while ask mode
  // is off: entering or leaving a mode changes prompt text only, never the tool
  // catalog, which keeps the request prefix cacheable.
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
    text: (context) => {
      const agent = context.agent;
      if (agent === undefined) return '';
      return controller.loggedActive(agent.session) ? config.section : '';
    },
  });

  // ── durable state ─────────────────────────────────────────────────────────
  // The `ask` unit folds `/ask` command records and turn ends out of the log, so
  // the plugin writes no session-event vocabulary of its own.
  ctx.sessionProjections.register(createAskProjection({ scope: config.scope }));

  // A mode switch is a human-visible control, so make it durable as soon as the
  // projection changes rather than at the next ordinary checkpoint: a `/ask`
  // followed by a hard stop would otherwise leave the switch only in memory.
  // `ctx.sessions.flush()` is the harness's own flush entry point (checkpoint
  // policy, goal driver, and message feedback all use it). The flush is deferred
  // out of the change notification, which runs inside the appending publication.
  ctx.sessionProjections.onChanged((session, key) => {
    if (key !== ASK_PROJECTION_KEY) return;
    queueMicrotask(() => {
      ctx.sessions.flush(session).catch((error) => {
        ctx.logger.warn('%s: could not checkpoint the ask-mode switch: %o', PLUGIN_NAME, error);
      });
    });
  });

  // ── enforcement ───────────────────────────────────────────────────────────
  if (config.enforce) {
    ctx.tools.guard(createReadOnlyGuard({
      effectiveActive: (session) => controller.loggedActive(session),
      blockedTools: config.blockedTools,
      allowedTools: config.allowedTools,
      plugin: PLUGIN_NAME,
    }));
  }

  // ── the human command ─────────────────────────────────────────────────────
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: COMMAND_NAME,
      description: 'Enter or leave ask mode (read-only Q&A)',
      input: {
        hint: '[off|message]',
        attachments: true,
      },
      handler: ({ agent, rawInput, attachments }) => handleAskCommand({ agent, rawInput, attachments, controller, config }),
    });
  });

  // ── programmatic control ──────────────────────────────────────────────────
  const commands = ctx.get('commands');
  try {
    ctx.provide('askMode', Object.freeze({
      /** Projection key holding the durable state. */
      projectionKey: ASK_PROJECTION_KEY,
      /** Logged state, plus `pending` while an invocation is in flight. */
      get: (agent) => controller.get(agent),
      /**
       * Select the mode by running the real command, so the switch is a durable
       * `/ask` record like any other and the log stays the single source of
       * truth. Requires a composed commands service.
       *
       * @param {object} agent - the agent to switch.
       * @param {boolean} active - the requested state.
       * @returns {Promise<object>} the settled command result.
       */
      set: async (agent, active) => {
        if (commands === undefined) throw new Error('ctx.askMode.set requires the commands service; a UI-less profile can still drive /ask through its own adapter');
        const settled = await commands.execute(agent, active ? '/ask' : '/ask off', [], new AbortController().signal);
        if (settled === undefined) throw new Error('the /ask command is not registered');
        return settled.result;
      },
      /** Whether ask mode is on for a session. */
      isActive: (session) => controller.loggedActive(session),
    }));
  } catch (error) {
    ctx.logger.warn('%s: ctx.askMode could not be provided (%s); the /ask command, guidance, and guard still work', PLUGIN_NAME, error instanceof Error ? error.message : String(error));
  }

  // One line at mount, so a profile log shows what the row decided.
  ctx.logger.info(
    '%s: /ask ready (scope=%s, %s, %d tool(s) blocked while the mode is on%s)',
    PLUGIN_NAME,
    config.scope,
    config.enforce ? 'enforcing read-only' : 'guidance only',
    config.enforce ? config.blockedTools.length : 0,
    config.supersedePlanMode ? '' : ', plan mode untouched',
  );
}

/**
 * Implement `/ask`, `/ask off`, and `/ask <message>`.
 *
 * The handler owns admission and the reply text; the durable state change is the
 * command record itself, which the `ask` projection folds once this returns. So
 * the outcome is computed from the state the invocation started in: an
 * invocation that does not change the mode is a no-op, and one that does is
 * committed by the registry's own `command/done`.
 *
 * @param {object} input - the invocation and its collaborators.
 * @returns {object} the command result rendered by the dispatching UI.
 */
function handleAskCommand({ agent, rawInput, attachments, controller, config }) {
  const message = typeof rawInput === 'string' ? rawInput.trim() : '';
  const turnScoped = config.scope === 'turn';

  if (message === 'off' && attachments.length > 0) {
    // Rejected before the mode changes, so the composer keeps its draft and cards.
    return { kind: 'error', text: 'Attachments cannot accompany /ask off.' };
  }

  const wanted = message !== 'off';
  const wasActive = controller.loggedActive(agent.session);

  if (message === 'off') {
    if (!wasActive) return { kind: 'success', text: 'Ask mode is already off.' };
    return { kind: 'success', text: 'Ask mode off.' };
  }

  const supersededPlan = wasActive ? false : controller.supersedePlan(agent.session);

  // The optional message becomes an ordinary logged user message under the mode
  // guidance; admitted attachments keep the user's selection order.
  if (message !== '' || attachments.length > 0) {
    agent.steer(createUserMessage({
      content: [
        ...attachments,
        ...message === '' ? [] : [{ type: 'text', text: message }],
      ],
      source: { kind: 'user' },
    }));
  }

  const planNote = supersededPlan ? ' Plan mode was switched off.' : '';
  if (wasActive) {
    return message === '' && attachments.length === 0
      ? { kind: 'success', text: `Ask mode is already on; ${turnScoped ? 'it ends with the current turn' : 'use /ask off to leave'}.${config.enforce ? '' : ' (enforcement is off)'}` }
      : { kind: 'success', text: `Ask mode is already on; answering your message read-only.${config.enforce ? '' : ' (enforcement is off)'}` };
  }
  if (turnScoped) {
    return {
      kind: 'success',
      text: `Ask mode on (read-only) for one turn. The answer comes back read-only; a later message without /ask runs normally.${planNote}`,
    };
  }
  return { kind: 'success', text: `Ask mode on (read-only). Use /ask off to leave.${planNote}` };
}
