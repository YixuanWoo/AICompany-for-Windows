# AICompany

**中文** | [English](#english)

一套**不绑定任何具体 AI 产品**的公司制度引擎：任务状态机、循环任务、调度、配额、审批、审计，加上**双帽协作**与**执行中改道**。岗位编制、汇报线、每个员工用什么方式干活，全部写在 `company.yaml` 里——**换一份配置就是另一家公司，源码一行不用改**。

> A protocol-first, zero-dependency "company" engine for AI agents. Agents are pluggable seats described in YAML; the engine only knows capabilities and a unified `execute()` interface, never product names.

- 默认入口是内置 Web Board：`npm start` 后打开 `http://127.0.0.1:3100`，下任务、审批、验收、看 Run 全在浏览器里，**不需要 IM 账号、不需要云服务器、不配任何环境变量也能跑**。
- 技术栈只有 Node 22 + 内置 `node:sqlite` + 内置单页看板，**零外部依赖**，不装 Docker / Redis / pm2。

The default entry point is the built-in Web Board: run `npm start`, then open `http://127.0.0.1:3100` to create tasks, approve, accept deliverables and inspect runs — all in the browser. **No IM account, no cloud server, no environment variables required.** The stack is just Node 22 + built-in `node:sqlite` + a built-in single-page board — **zero runtime dependencies**, no Docker / Redis / pm2.

## 它想解决的三件事 / Three problems it solves

| 问题 Problem | 做法 Approach |
|---|---|
| 「agent 说做完了，其实没做」"The agent says done, but it isn't" | **证据层**：完成必须带磁盘产物（公司任务目录或项目交付目录），引擎按文件时间戳 / 进程 / 日志三层判定，没证据不认完成，超时判死前先附现场。**Evidence layer**: completion requires an on-disk artifact (task or project delivery directory); the engine judges by file timestamps / process / logs. No evidence, no completion. |
| 「任务卡住了，没人管」"A task is stuck and nobody notices" | **升级与巡检**：执行人连续失败或超时 → 自动升级到上级卡；上级接手前先判断下级**还在不在动**，在动就让它继续，而不是重做。**Escalation & patrol**: repeated failures or timeouts escalate to the boss's card; before taking over, check whether the subordinate is **still making progress** — if so, let it continue instead of redoing the work. |
| 「agent 之间互相甩锅 / 重复领活」"Agents blame each other or claim the same task" | **控制面单一事实源**：所有派活、状态、审计走同一套 API 与 SQLite，幂等键、租约互斥、汇报线拦截都在引擎里，不在提示词里。**Single source of truth**: all dispatch, state and audit go through one API and SQLite; idempotency keys, lease exclusion and reporting-line checks live in the engine, not in prompts. |

## 快速开始 / Quick start

```bash
# 需要 Node >= 22 / Requires Node >= 22
npm start                      # 控制面 + Web Board，默认 3100 / control plane + board, port 3100 by default
```

打开 `http://127.0.0.1:3100`，在顶部「提需求」提交第一条任务。默认示例配置会用本地假 agent 跑通闭环，不联网、不烧额度。
Open `http://127.0.0.1:3100` and submit your first task via "提需求" (Submit request) at the top. The default example config runs the full loop with a local dummy agent — no network, no token cost.

```bash
npm run doctor -- config/company.example.yaml   # 体检：配置 / 席位 / 路径 / 凭据 / health check: config, seats, paths, credentials
npm test                                       # 全量测试（node --test，400+ 条）/ full suite (node --test, 400+ cases)
```

Windows 上想常驻（开机自启、崩溃重启、托盘）：
To run as a Windows background service (start on login, restart on crash, tray icon):

```bash
npm run win:install    # 装计划任务，隐藏运行 / register scheduled task, run hidden
npm run win:start
npm run win:status
```

## 接自己的 agent：三步 / Bring your own agent in 3 steps

1. **选触发形态**：有命令行 → `process` / `cli-acp`；有 HTTP 接口 → `http`；只有图形界面 → `gui-template`；封闭到只能被轮询 → `polling`。都不合适就写一个 adapter 包（见 `docs/开发任务书.md` §6B.7）。
   **Pick a trigger shape**: CLI → `process` / `cli-acp`; HTTP endpoint → `http`; GUI only → `gui-template`; poll-only → `polling`. If none fit, write an adapter package (see `docs/开发任务书.md` §6B.7).
2. **写配置**：从 `config/company.example.yaml` 复制一份，列岗位、`reportsTo`、`capabilities`、每岗用哪个 `adapter` 与参数、额度。命令和凭据一律写 `${ENV_VAR}`。
   **Write the config**: copy `config/company.example.yaml`, list posts, `reportsTo`, `capabilities`, the `adapter` and params per post, and quotas. Put all commands and credentials in `${ENV_VAR}`.
3. **跑起来**：`npm run doctor -- <你的配置>` → `npm start` → 浏览器提需求。
   **Run it**: `npm run doctor -- <your config>` → `npm start` → submit a request in the browser.

adapter 只有五种通用形态，引擎**不认识任何产品名和岗位名**：
There are only five generic adapter shapes; the engine **knows no product names or job titles**:

| `type` | 触发形态 Trigger shape |
|---|---|
| `process` | spawn 任意命令，收 stdout / 退出码 / spawn any command, collect stdout / exit code |
| `http` | POST webhook，外部服务回调写结果 / POST webhook, external service calls back with the result |
| `cli-acp` | spawn CLI 并解析 JSONL / ACP 事件流 / spawn CLI and parse JSONL / ACP event stream |
| `gui-template` | 激活窗口 → 快捷键 → 输入 → 轮询报告文件 → 截图留证（Windows）/ focus window → hotkey → paste → poll report file → screenshot (Windows) |
| `polling` | 不推送；外部脚本自己拉 inbox、领活、回写 / no push; external script pulls inbox, claims tasks, writes back |

## 核心概念 / Core concepts

- **任务卡 Task card**：`T-xxxx`，带验收标准、难度、预算，状态机从 `pending` 到 `done` 全程有审计。/ `T-xxxx`, with acceptance criteria, difficulty and budget; the state machine audits every step from `pending` to `done`.
- **席位 Seat**：一个岗位的担任者，一个 agent 一份配置；同一个人可以既当 CEO 又当执行（**双帽**），但提交时必须显式选模式：`delegate`（走汇报线）/ `direct`（点名直投）/ `cowork` / `meeting`（后两者不建卡，走 WorkThread）。/ A post's occupant, one config per agent; the same agent can be both CEO and executor (**dual hat**), but submission must pick a mode explicitly: `delegate` (via reporting line) / `direct` (addressed) / `cowork` / `meeting` (the latter two create no card, use WorkThread).
- **Run**：席位的一次执行尝试，独立目录、独立日志；失败会打出 `reason`，报告不合格会被整份打回重跑。/ One execution attempt by a seat, with its own directory and log; failures record a `reason`, and a rejected report is sent back whole for a rerun.
- **升级 Escalation**：同一张卡连续 2 次返工 → 转上级；上级卡只做「接管 / 改派 / 上报」，不默认重做。/ Two consecutive reworks on one card → escalate to the boss; the boss card only "take over / reassign / escalate up", never redo by default.
- **项目 Project**：任务可以挂到项目上，`rootDir` + 可选 `deliverSubdir` 决定产物落到哪，验收通过后自动复制落盘并记校验和。/ Tasks can attach to projects; `rootDir` + optional `deliverSubdir` decide where artifacts land; after acceptance they are copied to disk with a checksum recorded.
- **门禁 Gate**：试运行指标（活动时长、任务数、异常率、脏状态）由控制面每 60 秒采样，达标自动钉住，看板「观测与运维」可见。/ Pilot metrics (active time, task count, error rate, dirty state) are sampled every 60s by the control plane and pinned automatically once thresholds are met; visible in the board's "Observability & Ops".

## 架构 / Architecture

四层，越往上越可换：/ Four layers, more replaceable as you go up:

```
用户接入层   Web Board（内置）/ 可选 IM Channel / CLI
     │  统一 REST + SSE API（契约）
引擎层       状态机 · 调度 · 循环 · 配额 · 审批 · 审计 · 证据 · 升级
     │  统一 adapter.execute()
适配层       process / http / cli-acp / gui-template / polling（可插拔）
     │
配置层       company.yaml（岗位、汇报线、能力、额度、路径）

Access layer   Web Board (built-in) / optional IM Channel / CLI
     │  unified REST + SSE API (contract)
Engine layer   state machine · scheduling · recurring · quota · approval · audit · evidence · escalation
     │  unified adapter.execute()
Adapter layer  process / http / cli-acp / gui-template / polling (pluggable)
     │
Config layer   company.yaml (posts, reporting lines, capabilities, quotas, paths)
```

三个通信方向严格分开：入站 `Channel`、出站 `Notifier`、机机唤醒 `adapter`。控制面是唯一事实源，IM 只是可选前端，删掉它公司照常运转。
Three communication directions are strictly separated: inbound `Channel`, outbound `Notifier`, machine-to-machine wake-up `adapter`. The control plane is the single source of truth; IM is only an optional front end — remove it and the company still runs.

## 目录结构 / Directory layout

```
src/            引擎（状态机、调度、证据、升级、gate-watch、看板）/ engine (state machine, scheduling, evidence, escalation, gate-watch, board)
src/web/        board.html 单页看板 / board.html single-page board
src/adapters.js 五种通用 adapter / five generic adapters
tests/          node --test 测试 / node --test suite
scripts/        下单、巡检、常驻安装、桥接等脚本 / task submit, patrol, service install, bridge scripts
config/         company.example.yaml 示例配置 + schema / example config + schema
docs/           设计文档与交付说明 / design docs and delivery notes
work/           运行产物（已 gitignore）/ runtime artifacts (gitignored)
```

## 文档 / Documentation

- `docs/开发任务书.md` — 唯一技术文档（协议、配置、架构、门禁、边界）/ the single technical spec (protocol, config, architecture, gates, boundaries)
- `docs/证据层-有证据的running-20261118.md` — 完成判定为什么必须有磁盘证据 / why completion must have on-disk evidence
- `docs/升级去向-巡检而非重做-20261124.md` — 卡住了怎么升级，上级接手先看什么 / how to escalate when stuck, what the boss checks first
- `docs/开发清单.md` / `docs/下一步计划.md` — 实现进度与剩余工作 / implementation progress and remaining work
- `docs/Windows常驻说明.md` — 计划任务、自愈、日志位置 / scheduled task, self-healing, log locations

## 边界，先说清楚 / Boundaries, up front

- **不判断质量**。引擎保证流程和证据，产物好不好得人来验收。/ **No quality judgement.** The engine guarantees process and evidence; a human must accept whether the artifact is any good.
- **GUI 席位会抢键鼠**。`gui-template` 必须在真实前台窗口操作，同一台机器同时只允许一个 GUI 席位干活（引擎有全局互斥），并建议配合暂停 / 时段 / 静置 / 锁屏四道闸。/ **GUI seats take over keyboard and mouse.** `gui-template` operates a real foreground window; only one GUI seat may work at a time per machine (global mutex in the engine). Pair it with the four gates: pause / allowed hours / idle / screen lock.
- **不是沙箱**。第三方 adapter 以控制面进程权限运行，审批管不到它，来源和版本自己审。/ **Not a sandbox.** Third-party adapters run with the control plane's process privileges; approval does not constrain them — review their origin and version yourself.
- **强依赖 Windows 的部分**（计划任务、托盘、GUI 自动化）在 Linux / macOS 只能跑 `process` / `http` / `cli-acp` / `polling`。/ **Windows-dependent features** (scheduled tasks, tray, GUI automation) — on Linux / macOS only `process` / `http` / `cli-acp` / `polling` work.
- 任务卡、报告、审计里的时间一律 UTC，看板按本地时区显示。/ Timestamps in cards, reports and audit are always UTC; the board displays in local time.

---

<a id="english"></a>

## English

A protocol-first, zero-dependency "company" engine for AI agents: task state machine, recurring tasks, scheduling, quotas, approvals and audit, plus **dual-hat collaboration** and **mid-execution redirection**. The org chart, reporting lines and how each employee works are all described in `company.yaml` — **swap the config and it is a different company, without touching a line of source code**.

- Default entry point: the built-in Web Board. Run `npm start` and open `http://127.0.0.1:3100` to submit tasks, approve, accept deliverables and inspect runs in the browser. No IM account, no cloud server, no env vars needed.
- Stack: Node 22 + built-in `node:sqlite` + a built-in single-page board. Zero external dependencies — no Docker, Redis or pm2.

### Quick start

```bash
npm start                                              # control plane + board on port 3100
npm run doctor -- config/company.example.yaml          # health check: config, seats, paths, credentials
npm test                                               # full node --test suite (400+ cases)
```

On Windows, to run as a background service (start on login, restart on crash, tray icon): `npm run win:install`, `npm run win:start`, `npm run win:status`.

### Three problems it solves

1. **"The agent says done, but it isn't"** — an evidence layer requires an on-disk artifact and judges by timestamps / process / logs; no evidence means no completion.
2. **"A task is stuck and nobody notices"** — repeated failures or timeouts escalate to the boss's card, which first checks whether the subordinate is still making progress before taking over.
3. **"Agents blame each other or claim the same task"** — one API and SQLite are the single source of truth; idempotency keys, lease exclusion and reporting-line checks are enforced in the engine.

### Bring your own agent

Pick a trigger shape (`process`, `cli-acp`, `http`, `gui-template`, `polling`), copy `config/company.example.yaml` to define posts, reporting lines, capabilities, adapters and quotas (keep commands and credentials in `${ENV_VAR}`), then run `npm run doctor -- <your config>` and `npm start`. The engine never knows product names or job titles — it only sees capabilities and `adapter.execute()`.

### Concepts

A **task card** (`T-xxxx`) carries acceptance criteria, difficulty and budget, audited from `pending` to `done`. A **seat** is a post's occupant; one agent may hold both CEO and executor hats (**dual hat**) but must choose a mode on submission: `delegate`, `direct`, `cowork` or `meeting` (the last two use WorkThread, no card). A **run** is one execution attempt with its own directory and log. **Escalation** moves a twice-reworked card to the boss, who may take over, reassign or escalate — never redo by default. A **project** binds tasks to a `rootDir` (+ optional `deliverSubdir`) for artifact delivery with checksums. **Gates** sample pilot metrics every 60 seconds and pin them once thresholds are met.

### Boundaries

The engine does not judge quality — a human accepts deliverables. GUI seats take over keyboard and mouse, so only one may run per machine (global mutex), with pause / hours / idle / lock gates recommended. Third-party adapters are not sandboxed and run at the control plane's privilege level. Windows-only features (scheduled tasks, tray, GUI automation) are unavailable on Linux / macOS. All timestamps are UTC; the board displays local time.

## License

MIT — see [LICENSE](LICENSE).
