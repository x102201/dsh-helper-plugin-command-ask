/**
 * dsh plugin: `dsh-helper-plugin-command-ask` — an `/ask` collaboration mode
 * modeled on `/plan`.
 *
 * ## What it is
 *
 * Cursor's Ask mode is a persistent read-only Q&A stance: the agent answers
 * questions about the codebase, cites what it inspected, and does not change
 * anything until the user switches modes. DSH ships that shape for planning
 * (`/plan` + `exit_plan_mode`); this plugin adds the ask shape:
 *
 * - `/ask`, `/ask <message>`, and `/ask off` drive one durable per-session mode.
 * - While active, the deployment's guidance is rendered as the `ask:policy`
 *   prompt section on every request.
 * - An optional monotonic tool guard denies mutating tools, so the mode is
 *   enforced rather than merely requested (config `enforce`, default on).
 * - Entering ask mode leaves plan mode, because the two stances contradict each
 *   other.
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
import { ASK_PROJECTION_KEY, askProjectionDefinition } from './lib/projection.js';

/** Stable Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = PLUGIN_NAME;

/**
 * Services required before the mode can be wired. `commands` is optional (a
 * UI-less profile composes no command surface) and is injected inside `apply`.
 */
export const inject = ['tools', 'systemPrompt', 'sessionProjections'];

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

  // ── step boundary ─────────────────────────────────────────────────────────
  // A selection made mid-turn is appended here, at the only append point while
  // an agent runs. The notice is built before the append because the append is
  // what clears the selection, and it rides the admitted step's messages so the
  // model sees the switch in the request it applies to. A rejected step or an
  // aborted turn leaves the selection pending for the next boundary.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    const pending = controller.pendingOf(agent.session);
    if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision;
    const narration = controller.narrate(agent.session, pending.active);
    try {
      controller.applyBoundary(agent.session);
    } catch (error) {
      // A failed append must never block the turn; the selection stays pending.
      ctx.logger.warn('%s: failed to append the selected ask mode at the step boundary: %o', PLUGIN_NAME, error);
      return decision;
    }
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
      return controller.effectiveActive(agent.session) ? config.section : '';
    },
  });

  // ── durable state ─────────────────────────────────────────────────────────
  ctx.sessionProjections.register(askProjectionDefinition);

  // ── enforcement ───────────────────────────────────────────────────────────
  if (config.enforce) {
    ctx.tools.guard(createReadOnlyGuard({
      effectiveActive: (session) => controller.effectiveActive(session),
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
  try {
    ctx.provide('askMode', Object.freeze({
      /** Projection key holding the durable state. */
      projectionKey: ASK_PROJECTION_KEY,
      /** Logged state plus any pending selection. */
      get: (agent) => controller.get(agent),
      /** Select the mode; see `lib/controller.js` for the outcomes. */
      set: (agent, active) => controller.set(agent, active),
      /** Whether ask mode is logged on for a session. */
      isActive: (session) => controller.loggedActive(session),
    }));
  } catch (error) {
    ctx.logger.warn('%s: ctx.askMode could not be provided (%s); the /ask command, guidance, and guard still work', PLUGIN_NAME, error instanceof Error ? error.message : String(error));
  }

  // One line at mount, so a profile log shows what the row decided.
  ctx.logger.info(
    '%s: /ask ready (%s, %d tool(s) blocked while the mode is on%s)',
    PLUGIN_NAME,
    config.enforce ? 'enforcing read-only' : 'guidance only',
    config.enforce ? config.blockedTools.length : 0,
    config.supersedePlanMode ? '' : ', plan mode untouched',
  );
}

/**
 * Implement `/ask`, `/ask off`, and `/ask <message>`.
 *
 * @param {object} input - the invocation and its collaborators.
 * @returns {object} the command result rendered by the dispatching UI.
 */
function handleAskCommand({ agent, rawInput, attachments, controller, config }) {
  const message = typeof rawInput === 'string' ? rawInput.trim() : '';

  if (message === 'off' && attachments.length > 0) {
    // Rejected before the mode changes, so the composer keeps its draft and cards.
    return { kind: 'error', text: 'Attachments cannot accompany /ask off.' };
  }

  if (message === 'off') {
    const { outcome } = controller.set(agent, false);
    if (outcome === 'committed') return { kind: 'success', text: 'Ask mode off.' };
    if (outcome === 'queued') return { kind: 'success', text: 'Leaving ask mode (applies from the next step).' };
    if (outcome === 'cancelled') return { kind: 'success', text: 'Ask mode entry cancelled.' };
    return controller.loggedActive(agent.session)
      ? { kind: 'success', text: 'Leaving ask mode (applies from the next step).' }
      : { kind: 'success', text: 'Ask mode is already off.' };
  }

  const { outcome, supersededPlan } = controller.set(agent, true);

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
  if (outcome === 'committed') return { kind: 'success', text: `Ask mode on (read-only). Use /ask off to leave.${planNote}` };
  if (outcome === 'queued') return { kind: 'success', text: 'Entering ask mode (applies from the next step). Use /ask off to leave.' };
  if (outcome === 'cancelled') return { kind: 'success', text: 'Ask mode stays on.' };
  return message === '' && attachments.length === 0
    ? { kind: 'success', text: `Ask mode is already on. Use /ask off to leave.${config.enforce ? '' : ' (enforcement is off)'}` }
    : { kind: 'success', text: 'Ask mode is already on; sending your message under ask mode.' };
}
