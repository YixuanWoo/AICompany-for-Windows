# dsh-ceo-webhook（DSH 插件）

> ⚠️ **这是一个 DeepSeek Harness（dsh）插件，不是 AICompany 核心代码。**
> 只用 AICompany、不用 dsh 的人可以完全忽略本目录。它不会被 `npm test`、`npm start`
> 或任何 AICompany 运行时加载——只是一个独立的、可选的安装包。

## 它解决什么问题

AICompany 里有个"CEO"角色，负责把任务拆给员工。但它需要一个**能真正读文件、能执行工具**
的 agent 来驱动——一个纯语言模型做不到这一点。

这个插件在 dsh 的 8080 Web 服务上开一个 HTTP 接口：外部编排器（AICompany，跑在
`127.0.0.1:3100`）POST 一个任务进来，插件就用 dsh 的 `agents` + `agentPresets` 服务
拉起一个**真的、带工具的 agent**（和飞书插件 `dsh-lark-channel` 用的是同一套服务），
在 profile 的沙箱策略（`danger-full-access`）下干活，再把结果通过 HTTP 回出去。

## 它是"哪一类"插件

| 项 | 说明 |
|---|---|
| 飞书插件 `dsh-lark-channel` | 现成的第三方开源插件（GitHub `omdsh-dev/dsh-lark`，BSD-3），你机器上早已装好——**不是本目录** |
| 本插件 `dsh-ceo-webhook` | **自己写的**，接口写法参考了飞书插件（`inject` 服务、`agents.create` / `agent.followup` / `session/event` 这套模式），但代码完全独立、重新实现，不 import、不修改飞书插件 |
| 依赖 | 零运行时依赖，只用 Node 内置模块；ESM，与 dsh 插件形态一致 |

## 接口

挂载在 dsh Web 服务的 `/aiceo/api` 前缀下（8080）：

- `POST /aiceo/api/task` — body `{ "taskId": "T-xxx", "prompt": "...", "cwd": "可选工作目录" }`
  → 返回 `{ ok:true, value:{ taskId, sessionId, reused } }`
- `GET` 用 `POST /aiceo/api/result`（body `{ "taskId": "T-xxx" }`）查询
  → `{ ok:true, value:{ status:"running|done|error", text, turn, error? } }`
- `POST /aiceo/api/health`（body `{}`）→ 服务健康与配置状态

安全：仅本机回环地址可调用；如在局域网用，需设置环境变量 `AICEO_TOKEN`，并在请求头带
`x-aiceo-token: <token>`（或 `Authorization: Bearer <token>`）。同时受 dsh 自带
`connection` 服务的跨站请求围栏保护。

## 配置（环境变量，可选）

| 变量 | 作用 | 默认 |
|---|---|---|
| `AICEO_TOKEN` | 共享令牌；设置后强制校验，并允许非回环调用 | 空（仅本机、不校验） |
| `AICEO_PROVIDER` | agent 的 provider | profile 的 `agentDefaultModel` |
| `AICEO_MODEL` | agent 的 model id | profile 的 `agentDefaultModel` |

provider/model 不设也没关系——web profile 的 `cordis.patch.yml` 已配好
`deepseek-account` / `deepseek-flash` / `danger-full-access`，agent 会自动继承，天然带执行能力。

## 安装 / 卸载（在 web profile）

安装（本机，Profile 名为 `web`）：

```bash
dsh plugin --profile web add "file:D:/开源/AICompany/integrations/dsh/ceo-webhook"
```

本质做了两件事：① 把本包作为依赖加入 `~/.dsh/profiles/web/package.json`；② 在
`bundles` 数组加入 `dsh-ceo-webhook`。本包自带的 `cordis.patch.yml` 会完成插件行的挂载。

卸载：

```bash
dsh plugin --profile web remove dsh-ceo-webhook
```

然后从 `~/.dsh/profiles/web/cordis.patch.yml` 的 `bundles` 里删掉 `dsh-ceo-webhook` 一行。
**卸载后飞书插件完全不受影响**——两者是互不依赖的独立插件行。

## 与 AICompany 的连接点（2026-11-16 已接通）

- AICompany 侧**不 import** 本插件；它只通过 `http://127.0.0.1:8080/aiceo/api/task`
  发任务（8080 就是 dsh Web 服务本身，插件把路由挂在它的 `/aiceo/api` 前缀下）。
- AICompany 侧的连接器是一个**通用 HTTP adapter**（`src/adapter-webhook-exec.js`，类型名
  `webhook-exec`，零产品名、零第三方依赖）。生产配置 `config/company.prod.yaml` 里新增了
  席位 `ceo-agent` 用它，指向 8080。看板下单选「总经理(真agent)」即可驱动本插件。
- 真机已验证：看板下单 → ceo-agent → 本插件拉起带工具的 agent → 执行 → 回执 → 任务 done。
  详见 `docs/真agent接入与循环任务-交付报告.md`。

## 测试

```bash
node --test integrations/dsh/ceo-webhook/lib/index.test.js
```

离线 fixture 测试，用假 ctx 驱动插件，不需要真的 dsh 运行时、不碰 8080。
