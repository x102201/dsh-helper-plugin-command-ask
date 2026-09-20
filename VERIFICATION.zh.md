# 验证结果

[English](VERIFICATION.md) | 中文

下面是这个插件**实际跑过**的验证，以及结果。所有命令都真实执行过，代码块里的输出是原文（只在个别地方省略了路径与端口）。

## 环境

| | |
|---|---|
| dsh | `0.1.5-rc.2`（`C:\Users\Administrator\.dshHelper\environments\env_001ca237\dsh`） |
| node | `24.19.0` |
| pnpm | `12.5.1`，由 `corepack` 提供（`dsh plugin` 会转发给 pnpm，所以 pnpm 必须在 `PATH` 上） |
| 系统 | Windows（`10.0.26100`） |
| 验证环境 | `C:\Users\Administrator\.dshHelper\environments\env_001ca237`（实例名 "TEST 1"） |
| 插件仓库 | `C:\ProjectCode\20260917-dsh-helper-plugin-command-ask` |

承载本次对话的那个 dsh 实例**没有**参与下列任何验证：安装、启动、实时检查全部在 `env_001ca237` 内完成；除 `link:` 安装本身，每次启动都用该环境下的临时 `$DSH_HOME`。

## 1. 单元与集成测试 —— 82 个

```sh
node --test
```

```text
ℹ tests 82
ℹ suites 0
ℹ pass 82
ℹ fail 0
```

这些测试跑真实的 `index.js`/`lib/*.js`，对接忠实的 Cordis 接缝替身（`test-support/harness.mjs`）：配置校验（含 `scope` 的默认值耦合）、`ask` 投影折叠与 schema、模式状态机（commit / queue / cancel / no-op、边界落盘、写入失败、plan 模式接力、切换提示、逐轮的 `disarm`）、只读守卫，以及包的可安装性性质（无裸模块 import、无安装期脚本）。

## 2. 安装方式 `link:` —— 装进测试环境自己的 `web` profile

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

对齐逻辑**自己**把 bundle 追加进了 profile 清单，无需手工编辑：

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

随后 `--port 0 --no-open` 让整棵树激活并对外服务（`dsh web: http://127.0.0.1:53110/?token=…`）。测试环境现在就停在这个状态。

## 3. 安装方式 `github:` —— 用同一条打包路径复现

真正的 GitHub 远端需要一个已发布的仓库，所以在 `env_001ca237` 内本地复现了 pnpm git fetcher 会产出的两种产物：

**(a) git 远端** —— 对本仓库 `git clone --bare`，然后

```sh
node <dsh>/lib/bin.js plugin --profile web add git+file:///C:/…/env_001ca237/.dsh-verify-git/ask.git
```

```text
dependencies:
+ dsh-helper-plugin-command-ask git+file:///C:/Users/…/env_001ca237/.dsh-verify-git/ask.git
```

之后的 profile 清单里是 `"dsh-helper-plugin-command-ask": "git+file:///…/ask.git"`，`bundles` 同样被追加；`--dump-config` 组合出 `id: command-ask`，且名字锚定在已安装副本内部。这条就是 pnpm 的 git fetcher：clone → 按 `files` 打包 → 安装 → 对齐，也就是 `github:` 的代码路径，只是换了本地传输。

**(b) 打包 tarball** —— `pnpm pack` 产出 24 个文件、41.5 KB（`package/index.js`、`package/lib/*.js`、`package/cordis.patch.yml`、`package/package.json`，以及 examples 与文档；不含 `node_modules`、不含 `.git`），安装它得到完全相同的对齐结果与组合行。

两个临时 home 事后都已删除。

## 4. 真实树内的激活

`scripts/verify-profile.ps1 -Probe` 会在 `env_001ca237` 内（用该环境的 dsh 二进制）搭一个按安装命令同样方式链接本目录的临时 profile，并从 `apply()` 内部打印标记：

```text
ok: profile composed over a directory link to …/env_001ca237/.dsh-probe/probe/dsh-helper-plugin-command-ask
ok: the bundle patch composed a command-ask row anchored inside the package
ok: the web profile activated and served http://127.0.0.1:50924
ok: apply() ran in the real tree with every service resolved, and the /ask registration path executed

all checks passed
```

dsh 对任何未达到 active 状态的条目都会让启动响亮失败（`assertEntriesActivated`），所以「启动成功 + 标记出现」意味着插件主体确实执行了、`commands`/`tools`/`systemPrompt`/`sessionProjections` 全部解析成功、注册 `/ask` 的 `ctx.inject(['commands'], …)` 回调也跑了。

## 5. 针对运行中实例的实时验证（逐轮默认语义）

```sh
node scripts/verify-live.mjs --url "http://127.0.0.1:53489/?token=…" --workspace <env>/workspace --model-turns
```

```text
ok: exchanged the URL token for a browser-session cookie
ok: created a live session session-f09d0baf-fb46-4291-b48c-f9c60b346e63 (preset standard)
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
ok: the session log recorded 3 /ask invocations
ok: every event in the log belongs to the harness vocabulary (no plugin-defined types)
ok: /ask off → Ask mode off.
ok: the projection now reports {"active":false,"pending":false}
ok: the log holds 4 /ask records, and the state is derived from them
ok: the ask turn’s system prompt carried the ask-mode guidance
ok: ask mode did not create ask-mode-probe-turn.txt
ok: ask mode ended with its turn, with no /ask off
ok: the release is the turn/end event the harness itself logged
ok: the next message without /ask created ask-mode-probe-turn.txt
ok: and its request carried no ask-mode guidance

22/22 checks passed
```

这次运行的命令层部分覆盖了：`/ask`、再一次 `/ask`、`/ask off` 带附件（在模式变化前被拒绝）、以及在还没跑过任何轮次的会话上 `/ask off`——也就是说显式退出仍然可用，`scope: session` 也仍然可用，而且日志里只有 harness 自己的事件类型。模型回合部分验证的正是逐轮语义：`/ask` 预置模式 → ask 轮受引导且只读 → harness 自己的 `turn/end` 释放它（没有 `/ask off`）→ 紧接着的普通消息成功写入文件。

### 守卫在轮内的实测

另做了一次实时探针：ask 预置后让它执行 `git status`。模型连续三次调用 `pwsh`，每次都被拒绝，随后改用 `glob`/`read` 完成回答：

```text
tool calls: ["pwsh","pwsh","pwsh","glob","glob","glob","read","read","read","read","read"]
ask projection at the end: {"active":false,"pending":false}
guidance in a system prompt: true
guard denial: "Error: dsh-helper-plugin-command-ask: ask mode is read-only, so the \"pwsh\" tool is blocked for this turn. Answer from what you can inspect instead, and tell the user to send the change as a normal message (without /ask), or to run /ask off to leave ask mode early."
```

黑名单确实拦住了它借 shell 查看工作区的念头（它反复尝试，而守卫是单调的，每次都拒绝）；只读工具始终可用，所以问题仍然能被回答。之后模式随该轮结束自行关闭。

## 6. 0.1.x 的会话加载缺陷与修复

0.1.x 把模式持久化成了自己的会话事件类型 `ask/mode`。仓库外插件无法扩充 harness 的事件词汇表——`Session.append()` 设置不了信封上的 `ignorable` 标记，而持久化读取路径会拒绝缺少该标记的未知类型——于是**所有跑过 `/ask` 的会话都无法再加载**：

```text
failed to observe session "session-abed8fee-…": session "session-abed8fee-…" contains event
type "ask/mode" (seq 5) unknown to this harness and not marked ignorable; refusing to
interpret the log — it was likely written by a newer harness
  (raw log: …\.dsh\sessions\--C-Users-Administrator-Desktop-TEST1--\session-abed8fee-…\session.v3.jsonl.zstd)
```

先用界面同款 RPC 复现（对该会话 `session/page` 返回的就是这条 `gateway/internal`），随后就地修复：

```sh
node scripts/repair-ask-mode-logs.mjs --sessions <env>/.dsh/sessions                    # 干跑：8 个文件 19 条记录
node scripts/repair-ask-mode-logs.mjs --sessions <env>/.dsh/sessions --apply --backup <env>/backup-askrepair
```

```text
-> --C-Users-Administrator-Desktop-TEST1--\session-abed8fee-…\session.v3.jsonl.zstd: mark 1 ask/mode record(s) ignorable
…
scanned 9 artifact(s); 19 record(s) in 8 file(s) rewritten
```

是**标记**而不是删除：日志要求 seq 稠密（"format v2 event N is not dense"、"not contiguous; expected N"）。修复后所有可修会话都能重新加载——上面那条 `session/page` 返回 54 条记录——并且保持了「首帧恰好是一行 header」的容器约束（`assertIndependentHeaderFrame`）。

0.2.0 则直接消除根因：模式改为从注册表本来就写的 `/ask` **命令记录**加上 `turn/end`、`request/header` 折叠得到，插件不再贡献任何词汇。`test/plugin.test.mjs` 断言日志里只有这些类型，`verify-live.mjs` 每次实跑也会对运行中的实例做同样断言。

## 7. 重启与恢复

这正是当初漏掉、如今纳入常规的检查：用一次 `/ask`，重启环境（含硬杀），再把这些会话读一遍。

```text
=== resume check: the session that ran /ask turns, after a restart ===
session: session-f09d0baf-fb46-4291-b48c-f9c60b346e63
ask before paging     : {"active":false,"pending":false}
log records           : 53
ask command records   : 5
foreign event types   : []
ask after paging      : {"active":false,"pending":false}
```

「已预置但尚未使用」的 `/ask` 也能挺过硬杀，因为投影一变插件就通过 `ctx.sessions.flush()` 检查点落盘（远不到一秒就写到磁盘）：

```text
session-8d4ba696-1c35-4c5d-bcd0-53fbff87e6aa : 6 records after the restart
  seq 3 command/run name=ask args=""
  seq 4 command/done kind=success
ask before paging : {"active":true,"pending":false}
ask after paging  : {"active":true,"pending":false}
```

## 8. 未覆盖的部分

- 浏览器输入框的往返：插件没有客户端半边，反馈来自命令结果文本（`scope: session` 下另有切换 notice）。实时脚本走的是与输入框相同的 RPC 通道。
- 真实的 `github:` 远端：git 传输用本地 bare 仓库验证，走的是同一个 pnpm fetcher 与同一套 `files` 打包规则。
- 非 Windows 主机：那里默认被拦的 shell 是 `bash`（`bash` 已在默认黑名单里），`pwsh` 不是。
