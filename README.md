# dsh-helper-plugin-command-ask

English | [中文](README.zh.md)

An **`/ask` collaboration mode** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), modeled on the shipped `/plan` mode and on Cursor's **Ask** mode: a read-only Q&A answer for the turn the question belongs to.

`/ask <question>` answers that one question read-only — the agent cites what it inspected and changes nothing — and an optional tool guard *enforces* that instead of merely asking for it. **The mode ends with its turn**, so a later message without `/ask` is ordinary work again: ask something, then just say "do it". `/ask off` only cancels the mode early.

```text
/ask why is the retry budget 3?    answer this read-only, then back to normal
/ask                              arm ask mode for the next turn
/ask off                          cancel early (never required)
```

---

## What it does

| Piece | Behavior |
|---|---|
| `/ask` command | Arms ask mode, optionally with the trailing question (images/files allowed). `<scope: turn>` covers one turn; `session` (config) keeps the `/plan`-like standing stance until `/ask off`. |
| Turn boundary | A turn-scoped mode is released by the harness's own `turn/end` event, so the next request is assembled without it — no `/ask off` needed. |
| `ask:policy` prompt section | Renders the deployment's guidance on every request while the mode is active, and nothing while it is off. |
| Durable state | The `ask` projection folds the `/ask` `command/run`/`command/done` records and `turn/end` out of the session log. The plugin writes **no session-event vocabulary of its own**, and each switch is checkpointed through `ctx.sessions.flush()` so it survives a restart. |
| Read-only guard | On by default: a monotonic `ctx.tools.guard()` denies the configured mutating tools while ask mode is active, and tells the model to answer from what it can inspect. |
| Plan-mode handoff | Only with `scope: session`: entering a standing ask mode leaves plan mode, so two contradictory stances are never active at once. |
| Programmatic control | Provides `ctx.askMode` with `get(agent)`, `set(agent, active)` (dispatches the real command), `isActive(session)`. |

Each ask turn is a fresh, self-contained stance: the guidance is present exactly in the requests it governs, and the log records every switch as an ordinary `/ask` command record.

> ### Upgrading from 0.1.x
>
> 0.1.x persisted the mode as its own session event type, `ask/mode`. An
> out-of-tree plugin cannot add to the harness vocabulary — `Session.append()`
> cannot set the envelope's `ignorable` marker, so the persistence reader refuses
> a log containing such an event (*"unknown to this harness and not marked
> ignorable; refusing to interpret the log"*) and **every session that had ever
> run `/ask` became unloadable**. 0.2.0 writes no such event, and
> [`scripts/repair-ask-mode-logs.mjs`](scripts/repair-ask-mode-logs.mjs) marks the
> leftover records ignorable in place (dropping them would break the log's
> required dense seq numbering):
>
> ```sh
> node scripts/repair-ask-mode-logs.mjs --sessions <DSH_HOME>/sessions                # dry run
> node scripts/repair-ask-mode-logs.mjs --sessions <DSH_HOME>/sessions --apply --backup <dir>
> ```
>
> The projection's `stateVersion` moved to 2, so a cached row from 0.1.x is
> discarded and the state is refolded from the command records — no further
> migration is needed.

## Install

Both installation styles are supported. The package ships plain ESM (no build step, no runtime dependencies), so nothing has to be compiled or allowlisted by pnpm at install time.

> **Prerequisite:** `dsh plugin` forwards its arguments to `pnpm`, so pnpm must be on `PATH` (`corepack enable pnpm` provides it). Without it the CLI prints `pnpm not found on PATH` and exits 127.

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

### Try it without installing

[`examples/standalone.patch.yml`](examples/standalone.patch.yml) anchors `../index.js` to the patch file, so a bare checkout runs as-is:

```sh
dsh --profile web --patch <checkout>/examples/standalone.patch.yml
```

That is the fastest loop while editing `index.js`/`lib/*.js`; no install and no profile edit.

### Verify the install

```sh
# The composed tree should list a command-ask row:
dsh --profile web --dump-config | grep -A2 command-ask
```

Then, in the Web UI composer, type `/ask` — the slash menu lists **`/ask` Enter or leave ask mode (read-only Q&A)**, and the command result says `Ask mode on (read-only). Use /ask off to leave.` Ask a question, and try asking for an edit: the model should explain the change instead of making it, and a denied tool call reports `ask mode is read-only`.

To check a running instance without a browser, point the live script at the URL `dsh web` printed:

```sh
node scripts/verify-live.mjs --url "http://127.0.0.1:PORT/?token=TOKEN" --workspace <dir>
node scripts/verify-live.mjs --url "..." --workspace <dir> --model-turns
```

It drives the same HTTP RPC the browser uses (a live session is created, then commanded), asserting the `/ask` registration, the command results, the live `ask` projection value, and the durable `ask/mode` events. `--model-turns` adds two real turns — one in ask mode asking for a file to be created, one after `/ask off` — and asserts the file appears only in the second.

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
    scope: turn          # one turn per /ask (default) …
    enforce: false
    blockedTools: [write, edit, pwsh]
# … or scope: session for the /plan-like standing mode
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `scope` | `turn` \| `session` | `turn` | `turn`: ask mode covers the turn it was entered for and is logged off at that turn's boundary. `session`: it stands until `/ask off`, like `/plan`. |
| `section` | string | built-in guidance for the chosen scope (see `lib/config.js`) | Text rendered as the `ask:policy` prompt section while the mode is active. |
| `enforce` | boolean | `true` | Register the read-only tool guard. `false` keeps the mode advisory: guidance only. |
| `blockedTools` | string[] | the 22 mutating tools listed below | Tool names denied while ask mode is active. **Replaces** the default list. |
| `allowedTools` | string[] | `[]` | Names that always pass, checked before `blockedTools`. |
| `supersedePlanMode` | boolean | `false` for `scope: turn`, `true` for `session` | Log plan mode off when ask mode is entered. A one-turn mode leaves the modes around it alone. |
| `narrate` | boolean | `false` for `scope: turn`, `true` for `session` | Inject a one-line "the user switched this session to ask mode" notice when the switch happens between turns. A one-turn mode has nothing to narrate: the guidance is simply present in the turn it governs and gone afterwards. |

Explicit values always win: `scope: turn` with `narrate: true` is a legal (if chatty) combination.

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
/ask ──► ctx.commands.register('ask')  ──► session.append('command/run' | 'command/done')
                                                        │
                                                        ▼
                                    ctx.sessionProjections unit 'ask'
                                    folds /ask records + turn/end  ──►  view { active, pending }
                                                        │
                          ┌─────────────────────────────┴──────────────────────────┐
                          ▼                                                        ▼
       ctx.systemPrompt.section('ask:policy')                  ctx.tools.guard(read-only)
       (guidance on every request while active)                (deny mutating tools while active)
```

- **The durable state is the command record.** `/ask` is a command, and the command registry already logs `command/run` + `command/done` for it — the mode is a pure fold over those records plus the harness's `turn/end` and `request/header` events. Resume, fork, and compaction recover the mode by replaying the log, and there is no live mirror to keep in sync.
- **No vocabulary of its own.** A plugin outside the harness repository cannot add a session event type: `Session.append()` cannot set the envelope's `ignorable` marker, and the persistence read path refuses an unknown type that lacks it. Everything here is expressed in events the harness already knows, so a session log stays readable by any harness — with or without this plugin loaded. `test/plugin.test.mjs` asserts the log holds nothing else.
- **Immediate durability.** The projection's change feed calls `ctx.sessions.flush(session)` (the harness's own checkpoint entry point) so a switch reaches disk in well under a second instead of waiting for the next model request.
- **Turn-scoped release.** With the default `scope: turn`, the harness's own `turn/end` record ends the mode; the next request is assembled with no `ask:policy` section and no guard. That is what makes "ask a question, then say 'do it'" work without `/ask off`.
- **Prompt stability.** The section is registered once and returns `''` while the mode is off, so entering or leaving a mode never changes the request's tool catalog. This is why the mode can be enforced by a guard instead of by hiding tools.
- **Narration** (`scope: session` only). When the last `request/header` described a different mode than the one now in effect, one plugin-sourced notice rides the next admitted step, so the model is not left reasoning under the old stance. A one-turn mode needs none: the guidance is present exactly in the turn it governs.
- **Enforcement seam.** `ctx.tools.guard()` is monotonic and runs after the `tools/pre-execute` waterfall: a denial cannot be overridden by another listener, and it covers nested `run_code` sub-dispatches too (the tool registry propagates the calling agent into sub-dispatches).
- **Plan-mode handoff** (`scope: session` only): a standing ask mode is strictly narrower than plan mode, so entering one leaves the other. The plugin writes plan mode's own known `plan/mode` event rather than calling a service: no realm crossing, and the fold recovers the result like any other switch. With plan mode not composed, the check reads an absent projection and does nothing.

### Differences from `/plan`

| | `/plan` | `/ask` (default) | `/ask` (`scope: session`) |
|---|---|---|---|
| Purpose | design, then execute after approval | answer this question, change nothing | answer, change nothing, until asked otherwise |
| Lifetime | until `exit_plan_mode`/`/plan off` | one turn | until `/ask off` |
| Exit | `exit_plan_mode` with a user review, or `/plan off` | automatic at the turn boundary | `/ask off` |
| Enforcement | guidance only (deployment owns sandbox/approval) | guidance **plus** a deny-list tool guard (`enforce`) | same |
| Other modes | owns the session stance | leaves plan mode alone | logs plan mode off |
| Browser UI | composer "Plan" chip over the `plan` projection | none — command result text | none — plus the switch notice |
| Mount plane | per agent preset, in an entry-local realm | one host row, global for every agent | same |

## Where ask mode is *not* a boundary

- The guard is a **deny list**, so a mutating tool whose name the plugin does not know (a deployment-specific tool) stays callable. Add it to `blockedTools`.
- The hard boundary stays where it belongs: DSH's sandbox mode and approval policy. Ask mode narrows what the agent *may* do by tool name; it does not change filesystem or process permissions. A read-only deployment is `sandbox: read-only`, independent of this plugin.
- The model can still answer incorrectly. The guidance demands cited evidence and explicit uncertainty, and nothing more than that.
- With `scope: turn`, everything the user sends *while that turn runs* is inside the turn and therefore still read-only; the mode is released when the turn ends, not per message. Queue a new message to get ordinary work back.
- A pending selection is process-local until its boundary append. If the process exits before the next accepted pre-step, that in-flight selection is lost and the UI must reapply it — the same property `/plan` has.

## Compatibility

Written against **dsh `0.1.5-rc.2`**. Services and seams used, all host-plane:

| Seam | Purpose |
|---|---|
| `ctx.commands.register()` (optional injection — a UI-less profile still gets the mode) | the `/ask` command, whose records are the durable state |
| `ctx.systemPrompt.section()` + `getSectionOrder('PLAN_POLICY')` | the `ask:policy` section |
| `ctx.sessionProjections.register()` / `stateOf()` / `onChanged()` | the `ask` unit, the `plan`/`turnBoundary` reads, and the checkpoint trigger |
| `ctx.sessions.flush()` | making a switch durable immediately |
| `ctx.tools.guard()` | the read-only denial |
| `ctx.on('agent/pre-step')`, `agent.steer()` | the `scope: session` switch notice, and steering the trailing question |
| `session.append()` (only `plan/mode`), `ctx.provide('askMode')` | the plan handoff and programmatic control |
| projection `stateSchema`/`viewSchema` | a tiny `parse`-compatible validator, not `zod` |

Two deliberate soft spots, so that a missing shoulder does not break a boot: an absent `ask`/`plan` projection reads as "off", and an absent `turnBoundary` projection means "no open turn" (with one warning). The plugin also imports **no bare specifier at all** — that is what makes `link:` and `github:` installs behave identically (Node resolves a linked package's imports from its real path, outside the profile's `node_modules`). `test/package.test.mjs` enforces that property.

Mounting the plugin inside an agent preset instead of the host plane is possible; see [`examples/agent-preset-mount.yml`](examples/agent-preset-mount.yml).

## Tests

```sh
npm test              # node --test
npm run test:direct   # one process instead (for sandboxes that block the runner's child processes)
```

82 tests cover the config validation (including the `scope` defaults), the projection fold and its schemas, the read-side mode helpers and the plan handoff, the guard, the package's installability properties, and the plugin's wiring over a fake Cordis tree — including ask turns that end on their own, several in a row, the immediate checkpoint on a switch, the `ctx.askMode.set` path through the real command, and a replay of the mode after a resume.

### Verification status

Every layer below was run; the live ones used a scratch `$DSH_HOME` and an isolated dsh environment (`env_001ca237`), never the profile serving the authoring session. Full command transcripts and raw output: [`VERIFICATION.md`](VERIFICATION.md).

1. **Behavior** — 82 unit/integration tests drive the real `index.js`/`lib/*.js` against a faithful stand-in for the Cordis seams (`test-support/harness.mjs`).
2. **Package shape** — static tests pin the property both install methods depend on: the runtime imports no bare specifier (a `link:` install cannot resolve one, because Node resolves a linked package's imports from its real path) and the package ships no install-time script pnpm would have to allowlist.
3. **The install commands** — against scratch profiles, with dsh `0.1.5-rc.2` and pnpm 12.5.1:
   - `dsh plugin --profile web add link:<absolute checkout>` → initialized the profile, linked the checkout, and the reconciler appended `dsh-helper-plugin-command-ask` to `dsh.profile.bundles` on its own.
   - `pnpm pack` → 24 files, then `dsh plugin --profile web add <tarball>` → the same reconciliation and the same composed row.
   - `git clone --bare` of this repository, then `dsh plugin --profile web add git+file://<bare repo>` → same reconciliation, same row. This is pnpm's git fetcher, i.e. the `github:` code path with a local transport.
   In every case `--dump-config` composed `id: command-ask` with the name anchored inside the installed copy, and `--port 0 --no-open` activated and served the UI.
4. **Activation in a real tree** — `scripts/verify-profile.ps1 -Probe` prints markers from inside `apply()`: the row reached the active state (dsh fails loudly on any entry that does not), and `apply()` ran with `commands`, `tools`, `systemPrompt`, `sessionProjections`, and `sessions` all resolved, so the `ctx.inject(['commands'], …)` callback that registers `/ask` executed.
5. **Live behavior, including real model turns** — `scripts/verify-live.mjs --model-turns` against a running web instance, on the turn-scoped default: **22/22 checks passed**, including *"every event in the log belongs to the harness vocabulary (no plugin-defined types)"*, *"ask mode ended with its turn, with no /ask off"* and *"the next message without /ask created the file"*.
6. **Restart and resume** — the same environment was restarted (hard kill included) with sessions that had run `/ask`: they load again (`session/page` returns their records) and the mode is recovered from the log. An armed-but-unrun `/ask` also survives a hard restart, because the switch is checkpointed on the spot:

   ```text
   session-8d4ba696 … : 6 renderable records after the restart
     seq 3 command/run name=ask args=""
     seq 4 command/done kind=success
   ask before paging : {"active":true,"pending":false}
   ```

Not covered: the Web composer round-trip through a browser (there is no client half — feedback is the command result text and, for `scope: session`, the switch notice). Everything the command surface can reach is covered above.

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
scripts/verify-profile.ps1   scratch-profile verification against a real dsh (--dump-config + boot + -Probe)
scripts/verify-live.mjs      live verification against a running instance (HTTP RPC; --model-turns)
scripts/repair-ask-mode-logs.mjs    repairs logs written by 0.1.x (marks the stray records ignorable)
test/                        the suite (config, projection, controller, guard, wiring, package shape)
test-support/harness.mjs     the fake-Cordis tree the wiring tests drive
README.md / README.zh.md     the reference in English and Chinese
VERIFICATION.md / .zh.md     what was actually run, with raw output
```

## License

MIT.
