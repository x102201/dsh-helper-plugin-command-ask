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

## 1. 单元与集成测试 —— 73 个

```sh
node --test
```

```text
ℹ tests 73
ℹ suites 0
ℹ pass 73
ℹ fail 0
```

这些测试跑真实的 `index.js`/`lib/*.js`，对接忠实的 Cordis 接缝替身（`test-support/harness.mjs`）：配置校验、`ask` 投影折叠与 schema、模式状态机（commit / queue / cancel / no-op、边界落盘、写入失败、plan 模式接力、切换提示）、只读守卫，以及包的可安装性性质（无裸模块 import、无安装期脚本）。

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

`scripts/verify-profile.ps1 -Probe` 会搭一个按安装命令同样方式链接本目录的临时 profile，并从 `apply()` 内部打印标记：

```text
ok: the bundle patch composed a command-ask row anchored inside the package
ok: the web profile activated and served http://127.0.0.1:55789
ok: apply() ran in the real tree with every service resolved, and the /ask registration path executed
```

dsh 对任何未达到 active 状态的条目都会让启动响亮失败（`assertEntriesActivated`），所以「启动成功 + 标记出现」意味着插件主体确实执行了、`commands`/`tools`/`systemPrompt`/`sessionProjections` 全部解析成功、注册 `/ask` 的 `ctx.inject(['commands'], …)` 回调也跑了。

## 5. 针对运行中实例的实时验证

```sh
node scripts/verify-live.mjs --url "http://127.0.0.1:53110/?token=…" --workspace <env>/workspace --model-turns
```

```text
ok: exchanged the URL token for a browser-session cookie
ok: created a live session session-3f1af379-501d-4660-96b7-4cfaacda8989 (preset standard)
ok: /ask is registered among 7 commands: ask, compact, export, feedback, goal, permission, plan
   description: Enter or leave ask mode (read-only Q&A)
   input: {"hint":"[off|message]","attachments":true}
ok: the description advertises the read-only stance
ok: the input hint and attachment support are advertised
ok: the live ask projection starts at {"active":false,"pending":false}
ok: /ask → Ask mode on (read-only). Use /ask off to leave.
ok: the projection now reports {"active":true,"pending":false}
ok: /ask twice → Ask mode is already on. Use /ask off to leave.
ok: /ask off with an image → error: Attachments cannot accompany /ask off.
ok: the rejected /ask off left the mode on
ok: the session log holds one ask/mode event: [true]
ok: the session log recorded 3 /ask invocations
ok: /ask off → Ask mode off.
ok: the projection now reports {"active":false,"pending":false}
ok: durable state folded to [true,false]
ok: ask mode did not create ask-mode-probe.txt (the guard denied the write)
ok: outside ask mode the same request created ask-mode-probe.txt

18/18 checks passed
```

同一个脚本也对 **git 安装**的那份副本跑过（`env_001ca237` 下的临时 `$DSH_HOME`，`--probe-file ask-mode-probe-git.txt`），同样 **18/18 全部通过**，说明两种安装路径行为一致。

### 模型实际看到了什么、做了什么

取自上文中那个会话的日志（第一轮模型回合：ask 模式下要求创建文件）：

- 部署引导文本确实进入了请求的 system prompt —— 日志里有完整的 `You are in ask mode: answer the user's questions…`；
- 模型在正文里拒绝动手：*"I can't create that file — I'm in ask mode, which is read-only…"*，并让用户去跑 `/ask off`；
- 但它仍试图查看工作区时，守卫拒绝了调用：

```text
Error: dsh-helper-plugin-command-ask: ask mode is read-only, so the "pwsh" tool is blocked for
this session. Answer from what you can inspect instead, and tell the user to run /ask off (or
start a new message outside ask mode) when the change is actually wanted.
```

- 模型接受了拒绝，没有绕路：*"Even read-only shell commands are blocked in this session — the `pwsh` tool itself is denied by the ask-mode policy… I won't retry it or route around it."*；
- `/ask off` 之后，同一个请求经 `write` 工具成功创建文件，并读回验证（`1: hello`）。

也就是说：改变结果的是模式，而真正拦下工具调用的是**强制**（不只是引导文本）。

## 6. 未覆盖的部分

- 浏览器输入框的往返：插件没有客户端半边，反馈来自命令结果文本与切换 notice。实时脚本走的是与输入框相同的 RPC 通道。
- 真实的 `github:` 远端：git 传输用本地 bare 仓库验证，走的是同一个 pnpm fetcher 与同一套 `files` 打包规则。
- 非 Windows 主机：那里默认被拦的 shell 是 `bash`（`bash` 已在默认黑名单里），`pwsh` 不是。
