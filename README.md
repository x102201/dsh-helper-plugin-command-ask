# dsh-helper-plugin-command-ask

English | [中文](README.zh.md)

An **`/ask` collaboration mode** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), modeled on the shipped `/plan` mode and on Cursor's **Ask** mode: a persistent, read-only Q&A stance for the current session.

While ask mode is active the agent answers questions about the workspace, cites what it inspected, and changes nothing — and an optional tool guard *enforces* that instead of merely asking for it. `/ask off` returns the session to normal work.

```text
/ask                          enter ask mode
/ask why is the retry budget 3?    enter and send that question under ask guidance
/ask off                      leave ask mode
```

---

## What it does

| Piece | Behavior |
|---|---|
| `/ask` command | Enters ask mode, or enters it and submits the trailing message (images/files allowed). `/ask off` leaves. |
| `ask:policy` prompt section | Renders the deployment's guidance on every request while the mode is active, and nothing while it is off. |
| Durable state | One whole-value `ask/mode` event in the session log, folded by an `ask` session-projection unit: resume, fork, and compaction recover the mode. |
| Read-only guard | On by default: a monotonic `ctx.tools.guard()` denies the configured mutating tools while ask mode is active, and tells the model to answer from what it can inspect. |
| Plan-mode handoff | Entering ask mode leaves plan mode, so two contradictory stances are never active at once. |
| Programmatic control | Provides `ctx.askMode` with `get(agent)`, `set(agent, active)`, `isActive(session)`. |

Modes are sticky, exactly like `/plan`: the stance lasts until the user leaves it, not until the next message.

## Install

Both installation styles are supported. The package ships plain ESM (no build step, no runtime dependencies), so nothing has to be compiled or allowlisted by pnpm at install time.

### 1. From a local checkout (`link:`)

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-helper-plugin-command-ask
```

- The path must be absolute, or relative to the directory you run the command from (the CLI anchors relative `link:`/`file:` specs to your invoking directory, not to the profile).
- `link:` symlinks the checkout, so **edits to `index.js`/`lib/*.js` take effect on the next `dsh web` restart** with no reinstall.

### 2. From a Git host (`github:`)

```sh
dsh plugin --profile web add github:<owner>/<repo>
```

- The repository root must be this package (the directory holding `package.json` and `cordis.patch.yml`).
- Pin a revision when you want reproducibility: `github:<owner>/<repo>#<tag-or-commit>`.
- Because there is no `prepare`/`postinstall` script, pnpm never asks you to allowlist a build.

### What happens underneath

`dsh plugin ... add` forwards to `pnpm` inside `$DSH_HOME/profiles/web`, then reconciles the profile manifest: because this package declares `dsh.bundle.patch`, its name is appended to `dsh.profile.bundles` automatically. On the next boot that bundle's patch layer adds one host row:

```yaml
- insert:
    - id: command-ask
      name: ./index.js      # anchored to the patch file, so any install layout works
```

Restart the profile to mount it:

```sh
dsh web            # alias of: dsh --profile web
```

### Verify the install

```sh
# The composed tree should list a command-ask row:
dsh --profile web --dump-config | grep -A2 command-ask
```

Then, in the Web UI composer, type `/ask` — the slash menu lists **`/ask` Enter or leave ask mode (read-only Q&A)**, and the command result says `Ask mode on (read-only). Use /ask off to leave.` Ask a question, and try asking for an edit: the model should explain the change instead of making it, and a denied tool call reports `ask mode is read-only`.

### Uninstall

```sh
dsh plugin --profile web remove dsh-helper-plugin-command-ask
```

The reconciler drops the bundle from `dsh.profile.bundles` when the dependency is gone. The session log keeps the `ask/mode` events it already recorded; they simply have no reader afterwards.

## Configuration

Every key is optional; a bare row gets the defaults. Config is validated at load — an unknown key, a wrong type, or a blank `section` fails the boot instead of silently doing nothing.

```yaml
- id: command-ask
  config:
    enforce: false
    blockedTools: [write, edit, pwsh]
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `section` | string | built-in guidance (see `lib/config.js`) | Text rendered as the `ask:policy` prompt section while the mode is active. |
| `enforce` | boolean | `true` | Register the read-only tool guard. `false` keeps the mode advisory: guidance only. |
| `blockedTools` | string[] | the 22 mutating tools listed below | Tool names denied while ask mode is active. **Replaces** the default list. |
| `allowedTools` | string[] | `[]` | Names that always pass, checked before `blockedTools`. |
| `supersedePlanMode` | boolean | `true` | Log plan mode off when ask mode is entered. |
| `narrate` | boolean | `true` | Inject a one-line "the user switched this session to ask mode" notice when the switch happens between turns. |

Where to put an override: the profile's own `cordis.patch.yml` (`$DSH_HOME/profiles/web/cordis.patch.yml`), a `--patch` overlay applied after the bundle, or [`examples/profile-patch.yml`](examples/profile-patch.yml) as a starting point. A patch replaces the targeted row's whole `config`, and every omitted key falls back to the plugin default, so restate only what you change.

The default deny list, by intent:

- **File mutation** — `write`, `edit`, `str_replace_editor`, `apply_patch`, `multi_edit`, `notebook_edit`
- **Shells** (dual-use, but anything can be written through them) — `pwsh`, `bash`, `terminal`, `shell`
- **Work tracking and objectives** — `todo_write`, `create_goal`, `update_goal`
- **Delegation and orchestration** (children do not inherit the mode's promise) — `subagent`, `subagent_fork`, `subagent_codex`, `subagent_claude_code`, `workflow`, `ralph`, `send_message`, `interrupt_agent`
- **Background-work control** — `job_kill`

It is a **deny** list on purpose: an unknown tool — a deployment's MCP tool, another plugin's tool — stays callable rather than being blocked by an allowlist this plugin cannot know about. Readers (`read`, `glob`, `grep`, `job_list`, `job_output`, `web_search`, `web_fetch`, `skill`, `ask_user_question`, `present`, …) are untouched.

## How it works

```text
/ask ──► ctx.commands.register('ask')  ─┐
                                        ├──► session.append('ask/mode', { active })
agent/pre-step waterfall ───────────────┘         │
                                                  ▼
                              ctx.sessionProjections unit 'ask'  ──►  view { active, pending }
                                                  │
                          ┌───────────────────────┴────────────────────────┐
                          ▼                                                ▼
       ctx.systemPrompt.section('ask:policy')              ctx.tools.guard(read-only)
       (guidance on every request while active)            (deny mutating tools while active)
```

- **Durable state is the log.** `ask/mode` is a whole-value event; the `ask` projection folds it (it also folds `/ask` `command/run`/`command/done` pairs into a `pending` flag). State therefore survives resume, fork, and compaction with no live mirror to keep in sync. Projection `stateVersion: 1`.
- **Step-boundary appends.** Between turns a selection is appended immediately. During an open turn it stays pending until the next accepted in-turn `agent/pre-step` — the only append point while an agent runs — so a switch is never logged in the middle of a step it does not apply to. A rejected step, an aborted turn, or a failed append leaves the selection pending.
- **Prompt stability.** The section is registered once and returns `''` while the mode is off, so entering or leaving a mode never changes the request's tool catalog. This is why the mode can be enforced by a guard instead of by hiding tools.
- **Narration.** When a logged switch changes what the last `request/header` described, one plugin-sourced notice is injected (`agent.inject` between turns, the admitted step's messages mid-turn), so the model is not left reasoning under the old stance.
- **Enforcement seam.** `ctx.tools.guard()` is monotonic and runs after the `tools/pre-execute` waterfall: a denial cannot be overridden by another listener, and it covers nested `run_code` sub-dispatches too (the tool registry propagates the calling agent into sub-dispatches).
- **Plan-mode handoff.** Ask mode is strictly narrower than plan mode, so entering one leaves the other. The plugin writes plan mode's own durable `plan/mode` event rather than calling a service: no realm crossing, and the fold recovers the result like any other mode change. With plan mode not composed, the check reads an absent projection and does nothing.

### Differences from `/plan`

| | `/plan` | `/ask` |
|---|---|---|
| Purpose | design, then execute after approval | answer, change nothing |
| Exit | `exit_plan_mode` with a user review, or `/plan off` | `/ask off` |
| Enforcement | guidance only (deployment owns sandbox/approval) | guidance **plus** a deny-list tool guard (`enforce`) |
| Browser UI | composer "Plan" chip over the `plan` projection | none — command result text and the narration notice |
| Mount plane | per agent preset, in an entry-local realm | one host row, global for every agent |

## Where ask mode is *not* a boundary

- The guard is a **deny list**, so a mutating tool whose name the plugin does not know (a deployment-specific tool) stays callable. Add it to `blockedTools`.
- The hard boundary stays where it belongs: DSH's sandbox mode and approval policy. Ask mode narrows what the agent *may* do by tool name; it does not change filesystem or process permissions. A read-only deployment is `sandbox: read-only`, independent of this plugin.
- The model can still answer incorrectly. The guidance demands cited evidence and explicit uncertainty, and nothing more than that.
- A pending selection is process-local until its boundary append. If the process exits before the next accepted pre-step, that in-flight selection is lost and the UI must reapply it — the same property `/plan` has.

## Compatibility

Written against **dsh `0.1.5-rc.2`**. Services and seams used, all host-plane:

| Seam | Purpose |
|---|---|
| `ctx.commands.register()` (optional injection — a UI-less profile still gets the mode) | the `/ask` command |
| `ctx.systemPrompt.section()` + `getSectionOrder('PLAN_POLICY')` | the `ask:policy` section |
| `ctx.sessionProjections.register()` / `stateOf()` | the `ask` unit and the `plan`/`turnBoundary` reads |
| `ctx.tools.guard()` | the read-only denial |
| `ctx.on('agent/pre-step')`, `agent.steer()`, `agent.inject()` | boundary commits and narration |
| `session.append()`, `ctx.provide('askMode')` | durable state and programmatic control |
| projection `stateSchema`/`viewSchema` | a tiny `parse`-compatible validator, not `zod` |

Two deliberate soft spots, so that a missing shoulder does not break a boot: an absent `ask`/`plan` projection reads as "off", and an absent `turnBoundary` projection means "no open turn" (with one warning). The plugin also imports **no bare specifier at all** — that is what makes `link:` and `github:` installs behave identically (Node resolves a linked package's imports from its real path, outside the profile's `node_modules`). `test/package.test.mjs` enforces that property.

Mounting the plugin inside an agent preset instead of the host plane is possible; see [`examples/agent-preset-mount.yml`](examples/agent-preset-mount.yml).

## Tests

```sh
npm test              # node --test
npm run test:direct   # one process instead (for sandboxes that block the runner's child processes)
```

72 tests cover the config validation, the projection fold and its schemas, the mode state machine (commit / queue / cancel / no-op, boundary appends, failed appends, plan-mode supersession, narration), the guard, the package's installability properties, and the plugin's wiring over a fake Cordis tree — including the full `/ask` → guard blocks `write` → `/ask off` → guard allows `write` path and a log replay after resume.

### Verification status

Three layers, each reproducible from this checkout:

1. **Behavior** — the suite above drives the real `index.js`/`lib/*.js` against a faithful stand-in for the Cordis seams (`test/support/harness.mjs`).
2. **Package shape** — static tests pin the property both install methods depend on: the runtime imports no bare specifier (a `link:` install cannot resolve one, because Node resolves a linked package's imports from its real path) and the package ships no install-time script pnpm would have to allowlist.
3. **A real dsh profile** — [`scripts/verify-profile.ps1`](scripts/verify-profile.ps1) builds a scratch `$DSH_HOME` whose `web` profile links this checkout exactly the way `dsh plugin --profile web add link:<dir>` does, then runs `--dump-config` and a real `--port 0 --no-open` boot.

Layer 3 was run against **dsh `0.1.5-rc.2`** with `-Probe`, and reported:

```text
ok: the bundle patch composed a command-ask row anchored inside the package
ok: the web profile activated and served http://127.0.0.1:55789
ok: apply() ran in the real tree with every service resolved, and the /ask registration path executed
```

i.e. the scratch profile composed the bundle row, the whole tree reached the active state (dsh fails loudly on any entry that does not), `apply()` executed with `commands`, `tools`, `systemPrompt`, and `sessionProjections` resolved, and the `ctx.inject(['commands'], …)` callback that registers `/ask` ran.

Not covered by that check: a real model turn under the mode, and the Web composer round-trip. There is no client half to test, so typing `/ask` in a live session is the one step only a human session can confirm.

## Layout

```text
index.js                     Cordis plugin: wiring, the /ask command handler
cordis.patch.yml             the bundle patch (dsh.bundle.patch): one host row
lib/config.js                config schema, defaults, the built-in guidance text
lib/controller.js            mode state machine (commit / queue / cancel, narration, plan handoff)
lib/projection.js            the `ask` session-projection unit
lib/guard.js                 the read-only tool guard
lib/message.js               dependency-free createUserMessage / notice
lib/schema.js                tiny parse-compatible schemas (no zod)
examples/                    profile patch, portable --patch overlay, agent-preset mount
scripts/run-tests.mjs        single-process test runner
scripts/verify-profile.ps1   scratch-profile verification against a real dsh
test/                        the suite (config, projection, controller, guard, wiring, package shape)
test-support/harness.mjs     the fake-Cordis tree the wiring tests drive
```

## License

MIT.
