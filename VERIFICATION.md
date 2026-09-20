# Verification results

English | [中文](VERIFICATION.zh.md)

What was actually run for this plugin, and what came out. Every command below was executed; the excerpts are verbatim (paths and ports elided only where noted).

## Environment

| | |
|---|---|
| dsh | `0.1.5-rc.2` (`C:\Users\Administrator\.dshHelper\environments\env_001ca237\dsh`) |
| node | `24.19.0` |
| pnpm | `12.5.1`, provided by `corepack` (`dsh plugin` forwards to pnpm, which must be on `PATH`) |
| OS | Windows (`10.0.26100`) |
| verification environment | `C:\Users\Administrator\.dshHelper\environments\env_001ca237` (instance "TEST 1") |
| plugin checkout | `C:\ProjectCode\20260917-dsh-helper-plugin-command-ask` |

The dsh instance serving the authoring session was **not** used for any of this: installation, booting, and live checks all ran in `env_001ca237`, and every boot that was not the `link:` install used a scratch `$DSH_HOME` under that environment.

## 1. Unit and integration suite — 82 tests

```sh
node --test
```

```text
ℹ tests 82
ℹ suites 0
ℹ pass 82
ℹ fail 0
```

These drive the real `index.js`/`lib/*.js` against a faithful stand-in for the Cordis seams (`test-support/harness.mjs`): config validation (including the `scope` defaults), the `ask` projection fold and its schemas, the mode state machine (commit / queue / cancel / no-op, boundary appends, failed appends, plan-mode supersession, narration, the turn-scoped `disarm`), the read-only guard, and the package's installability properties (no bare imports, no install-time scripts).

## 2. Install method `link:` — into the test environment's own `web` profile

```sh
DSH_HOME=<env_001ca237>/.dsh node <env>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile web add link:C:\ProjectCode\20260917-dsh-helper-plugin-command-ask
```

```text
Already up to date

dependencies:
+ dsh-helper-plugin-command-ask link:../../../../../../../../ProjectCode/20260917-dsh-helper-plugin-command-ask

Done in 39ms using pnpm v12.5.1
```

The reconciler appended the bundle to the profile manifest by itself — no hand editing:

```json
"dependencies": { "dsh-helper-plugin-command-ask": "link:C:/ProjectCode/20260917-dsh-helper-plugin-command-ask" },
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-helper-plugin-command-ask"
] } }
```

```sh
node <dsh>/lib/bin.js --profile web --dump-config | grep -A4 command-ask
```

```yaml
- id: command-ask
  name: >-
    file:///C:/Users/Administrator/.dshHelper/environments/env_001ca237/.dsh/profiles/web/node_modules/dsh-helper-plugin-command-ask/index.js
```

`--port 0 --no-open` then activated the whole tree and served the UI (`dsh web: http://127.0.0.1:53110/?token=…`). This is the state the test environment is left in.

## 3. Install method `github:` — reproduced with the same packing path

A real GitHub remote needs a published repository, so the two artifacts pnpm's git fetcher produces were reproduced locally **inside `env_001ca237`**:

**(a) a git remote** — `git clone --bare` of this repository, then

```sh
node <dsh>/lib/bin.js plugin --profile web add git+file:///C:/…/env_001ca237/.dsh-verify-git/ask.git
```

```text
dependencies:
+ dsh-helper-plugin-command-ask git+file:///C:/Users/…/env_001ca237/.dsh-verify-git/ask.git
```

profile manifest afterwards: `"dsh-helper-plugin-command-ask": "git+file:///…/ask.git"` plus the same `bundles` entry; composed row `id: command-ask` anchored inside the installed copy. This is pnpm's git fetcher — clone, honour `files`, install, reconcile — i.e. the `github:` code path with a local transport.

**(b) a packed tarball** — `pnpm pack` produced 24 files, 41.5 KB (`package/index.js`, `package/lib/*.js`, `package/cordis.patch.yml`, `package/package.json`, examples, docs — no `node_modules`, no `.git`), and installing it produced the same reconciliation and the same composed row.

Both scratch homes were deleted afterwards.

## 4. Activation inside a real tree

`scripts/verify-profile.ps1 -Probe` builds a scratch profile (inside `env_001ca237`, using that environment's dsh binary) that links this checkout the way the install command does, then prints markers from inside `apply()`:

```text
ok: profile composed over a directory link to …/env_001ca237/.dsh-probe/probe/dsh-helper-plugin-command-ask
ok: the bundle patch composed a command-ask row anchored inside the package
ok: the web profile activated and served http://127.0.0.1:50924
ok: apply() ran in the real tree with every service resolved, and the /ask registration path executed

all checks passed
```

dsh fails the boot loudly for any composed entry that does not reach the active state (`assertEntriesActivated`), so a successful boot plus the marker means the plugin body ran with `commands`, `tools`, `systemPrompt`, and `sessionProjections` resolved, and the `ctx.inject(['commands'], …)` callback that registers `/ask` executed.

## 5. Live verification against a running instance (turn-scoped default)

```sh
node scripts/verify-live.mjs --url "http://127.0.0.1:61371/?token=…" --workspace <env>/workspace --model-turns
```

```text
ok: exchanged the URL token for a browser-session cookie
ok: created a live session session-900a9133-0c64-45d7-8868-d572c73c6e08 (preset standard)
ok: /ask is registered among 7 commands: ask, compact, export, feedback, goal, permission, plan
   description: Enter or leave ask mode (read-only Q&A)
   input: {"hint":"[off|message]","attachments":true}
ok: the description advertises the read-only stance
ok: the input hint and attachment support are advertised
ok: the live ask projection starts at {"active":false,"pending":false}
ok: /ask → Ask mode on (read-only) for one turn. The answer comes back read-only; a later message without /ask runs normally.
ok: the projection now reports {"active":true,"pending":false}
ok: /ask twice → Ask mode is already on; it ends with the current turn.
ok: /ask off with an image → error: Attachments cannot accompany /ask off.
ok: the rejected /ask off left the mode on
ok: the session log holds one ask/mode event: [true]
ok: the session log recorded 3 /ask invocations
ok: /ask off → Ask mode off.
ok: the projection now reports {"active":false,"pending":false}
ok: durable state folded to [true,false]
ok: the ask turn’s system prompt carried the ask-mode guidance
ok: ask mode did not create ask-mode-probe-turn.txt
ok: ask mode ended with its turn, with no /ask off
ok: the durable state ends at [true,false,true,false]
ok: the next message without /ask created ask-mode-probe-turn.txt
ok: and its request carried no ask-mode guidance

22/22 checks passed
```

The command-level half of that run exercises `/ask`, `/ask` again, `/ask off` with an attachment (rejected before the mode changes), and `/ask off` on a session where no turn has run yet: the explicit exit still works, and `scope: session` is still available. The model-turn half is the turn-scoped behaviour: `/ask` arms the mode, the ask turn is guided and read-only, the turn boundary logs the mode off with no `/ask off`, and the very next ordinary message writes the file.

### The guard, live, inside a turn

A second live probe asked the same instance to run `git status` while `/ask` was armed. The model called `pwsh` three times, every call came back denied, and it then answered through `glob`/`read`:

```text
tool calls: ["pwsh","pwsh","pwsh","glob","glob","glob","read","read","read","read","read"]
ask/mode values: [true,false]
ask projection at the end: {"active":false,"pending":false}
guidance in a system prompt: true
guard denial: "Error: dsh-helper-plugin-command-ask: ask mode is read-only, so the \"pwsh\" tool is blocked for this turn. Answer from what you can inspect instead, and tell the user to send the change as a normal message (without /ask), or to run /ask off to leave ask mode early."
```

Two things are visible there: the deny list is what kept the model from inspecting through the shell — it tried repeatedly, and the guard is monotonic, so every attempt came back denied — and the read-only tools stayed available so the question could still be answered. The mode then ended with its turn.

### An earlier run under `scope: session`

The same script was first run with the standing-mode configuration, against the `link:` install and against a **git-installed** copy (both in `env_001ca237`, scratch `$DSH_HOME`s, `--probe-file ask-mode-probe-git.txt`), reporting 18/18 each. In that configuration an explicit `/ask off` followed the ask turn, the identical request then created the file, and the guard denial read `blocked for this session` — i.e. the two install paths behave identically, and both scopes work.

## 6. Not covered

- The browser composer round-trip: the plugin ships no client half, so feedback is the command result text (plus the switch notice under `scope: session`). The live script exercises the same RPC channel the composer uses.
- A published `github:` remote: the git transport was verified with a local bare repository, which exercises the same pnpm fetcher and `files`-based packing.
- Non-Windows hosts: `pwsh` is the shell the default deny list blocks; on Linux/macOS that is `bash` instead.
