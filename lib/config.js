/**
 * Configuration for the `/ask` mode plugin: the guidance text, the tool guard
 * policy, and the mode-interaction switches.
 *
 * Config is validated at plugin load. Unknown keys, wrong types, and blank
 * strings throw, because a typo in a patch layer should fail loudly at boot
 * instead of silently leaving the plugin on its defaults.
 *
 * @module dsh-helper-plugin-command-ask/lib/config
 */

/** The plugin name used in diagnostics. */
export const PLUGIN_NAME = 'dsh-helper-plugin-command-ask';

/**
 * The default `ask:policy` guidance for the turn-scoped mode.
 *
 * Ask mode is Cursor's "Ask" collaboration stance: a read-only Q&A turn. The
 * text is deliberately imperative and explicit about the two things models get
 * wrong — treating the mode as a standing restriction after its turn is over,
 * and "working around" a denied tool.
 */
export const TURN_SECTION = `You are in ask mode for this turn: answer the user's question about this workspace, the code in it, and the running session, and change nothing.

The mode covers the turn it was entered for. It ends when this turn ends, so a later message without /ask is ordinary work again: do not ask the user to run /ask off to get something done, and do not treat an earlier ask-mode turn as a standing restriction. /ask off only cancels the mode early within this turn.

Investigate read-only: read files, search, list directories, inspect history and configuration, and run read-only inspection commands. Do not edit or write files, install dependencies, change configuration or settings, run formatters or code generation that rewrites tracked files, commit, or otherwise carry work out. Do not create goals, todos, or background jobs, and do not delegate to subagents or workflows.

The tool catalog stays the same across modes for request-cache stability. These ask-mode rules override any later tool description or guidance that suggests mutation, and a blocked tool returns an error you must not retry or work around: report the block instead. When the user does ask for a change, answer the question, state exactly what would change and where, and tell them to send it again as a normal message (without /ask) to have it applied.

Ground every answer in what you actually inspected: cite file paths and line numbers, quote the relevant code, and say plainly what you could not confirm. Lead with the direct answer, then the evidence. Use ask_user_question only for user-owned choices or material ambiguity no amount of inspection can settle.

Answer at the depth the question deserves: a factual question gets a short answer, an investigative one gets findings, evidence, and the alternatives you ruled out.`;

/** Guidance variant for `scope: session`, where the mode persists until `/ask off`. */
export const SESSION_SECTION = `You are in ask mode: answer the user's questions about this workspace, the code in it, and the running session, and change nothing.

Stay in ask mode until the user leaves it (/ask off) or explicitly asks for the change while outside ask mode. Imperative language to change something means explain how it would be done, not do it. A user's conversational agreement — including an answer confirming something you asked — approves nothing; it is context for the answer, not permission to act.

Investigate read-only: read files, search, list directories, inspect history and configuration, and run read-only inspection commands. Do not edit or write files, install dependencies, change configuration or settings, run formatters or code generation that rewrites tracked files, commit, or otherwise carry work out. Do not create goals, todos, or background jobs, and do not delegate to subagents or workflows.

The tool catalog stays the same across modes for request-cache stability. These ask-mode rules override any later tool description or guidance that suggests mutation, and a blocked tool returns an error you must not retry or work around: report the block instead. When the user does ask for a change, answer the question, state exactly what would change and where, and tell them to run /ask off to have it applied.

Ground every answer in what you actually inspected: cite file paths and line numbers, quote the relevant code, and say plainly what you could not confirm. Lead with the direct answer, then the evidence. Use ask_user_question only for user-owned choices or material ambiguity no amount of inspection can settle.

Answer at the depth the question deserves: a factual question gets a short answer, an investigative one gets findings, evidence, and the alternatives you ruled out.`;

/** The guidance the default configuration renders (the turn-scoped variant). */
export const DEFAULT_SECTION = TURN_SECTION;

/**
 * Tools denied while ask mode is active when `enforce` is on.
 *
 * The list is a deny list on purpose: an unknown tool (a deployment's MCP tool,
 * a plugin's own tool) stays callable rather than being blocked by an allowlist
 * the plugin cannot know. Names cover the shipped presets (`standard`, `ptc`,
 * `minimal`) and the common aliases other profiles mount.
 */
export const DEFAULT_BLOCKED_TOOLS = Object.freeze([
  // File mutation.
  'write',
  'edit',
  'str_replace_editor',
  'apply_patch',
  'multi_edit',
  'notebook_edit',
  // Shells: dual-use, but anything can be written through them.
  'pwsh',
  'bash',
  'terminal',
  'shell',
  // Work tracking and durable objectives.
  'todo_write',
  'create_goal',
  'update_goal',
  // Delegation and orchestration: children do not inherit the mode's promise.
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'workflow',
  'ralph',
  'send_message',
  'interrupt_agent',
  // Background-work control.
  'job_kill',
]);

/** Every accepted config key, for the unknown-key diagnostic. */
const KNOWN_KEYS = Object.freeze([
  'scope',
  'section',
  'enforce',
  'blockedTools',
  'allowedTools',
  'supersedePlanMode',
  'narrate',
]);

/** Describe a rejected value for a diagnostic. */
function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`;
  return JSON.stringify(value) ?? String(value);
}

/** Read an optional boolean field. */
function readBoolean(config, key, fallback) {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${PLUGIN_NAME}: config.${key} must be a boolean, got ${describe(value)}`);
  return value;
}

/** Read an optional array-of-strings field. */
function readStringList(config, key, fallback) {
  const value = config[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new Error(`${PLUGIN_NAME}: config.${key} must be an array of tool names, got ${describe(value)}`);
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${PLUGIN_NAME}: config.${key} must contain non-empty strings, got ${describe(entry)}`);
    }
  }
  return Object.freeze([...value]);
}

/** The scope values `config.scope` accepts. */
export const SCOPES = Object.freeze(['turn', 'session']);

/**
 * Validate one deployment's config.
 *
 * @param {unknown} raw - the row's `config` value (absent for a bare insert).
 * @returns {Readonly<object>} the resolved config.
 * @throws when a key is unknown or a value has the wrong type, so a misconfigured
 *   profile fails at load rather than behaving unexpectedly.
 */
export function resolveConfig(raw) {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`${PLUGIN_NAME}: config must be a mapping, got ${describe(raw)}`);
  }
  const config = raw ?? {};
  const unknown = Object.keys(config).filter((key) => !KNOWN_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${PLUGIN_NAME}: config has unknown key(s) ${unknown.join(', ')} — config is { ${KNOWN_KEYS.join(', ')} }`);
  }

  const section = config.section;
  if (section !== undefined && (typeof section !== 'string' || section.trim() === '')) {
    throw new Error(`${PLUGIN_NAME}: config.section must be a non-empty string, got ${describe(section)}`);
  }

  const scope = config.scope ?? 'turn';
  if (!SCOPES.includes(scope)) {
    throw new Error(`${PLUGIN_NAME}: config.scope must be one of ${SCOPES.map((entry) => JSON.stringify(entry)).join(', ')}, got ${describe(scope)}`);
  }

  // A one-turn mode must not disturb the modes around it: `narrate` and
  // `supersedePlanMode` default on only for the standing `session` scope, where
  // a stale stance would otherwise go uncorrected. Explicit values always win.
  const standing = scope === 'session';

  return Object.freeze({
    /** Whether ask mode covers one turn (`turn`) or stands until `/ask off` (`session`). */
    scope,
    /** Guidance rendered as the `ask:policy` prompt section while ask mode is active. */
    section: section === undefined ? (standing ? SESSION_SECTION : TURN_SECTION) : section,
    /** Deny the configured tools while ask mode is active. */
    enforce: readBoolean(config, 'enforce', true),
    /** Tool names denied while ask mode is active (replaces the defaults). */
    blockedTools: readStringList(config, 'blockedTools', DEFAULT_BLOCKED_TOOLS),
    /** Tool names that always pass, checked before `blockedTools`. */
    allowedTools: readStringList(config, 'allowedTools', []),
    /** Leave plan mode when ask mode is entered (defaults on for `scope: session`). */
    supersedePlanMode: readBoolean(config, 'supersedePlanMode', standing),
    /** Inject a user-switch notice when the mode changes between turns (defaults on for `scope: session`). */
    narrate: readBoolean(config, 'narrate', standing),
  });
}
