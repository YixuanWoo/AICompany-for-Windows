# DSH CEO Webhook 插件 — 交付报告

日期：2026-11-16
对应决策：用户拍板"走自己写插件这条路 + 重启 8080 + 代码独立出来并标注DSH插件"

## 一句话结论

CEO 从"只会说话的大模型"变成了**能读文件、能跑工具的真 agent**：AICompany 通过 HTTP 把任务递给 8080 上的新插件，插件用 dsh 自己的 agents 服务拉起一个带全部工具的 agent 干活，再把结果回出来。飞书秘书没受影响，长连接已恢复。

## ① 这步到底是咋回事

之前 CEO 只是个语言模型，不能读盘、不能执行。原因是 dsh 里真正"能干活"的能力在 `agents` 服务 + 登录态 + 完全访问权限上，飞书插件（`dsh-lark-channel`）就是靠这个让机器人能干活的。我们要给 AICompany 也弄一条这样的入口。

## ② 为什么要这么做

- 用户明确：CEO 必须能读盘、能执行，纯 LLM 的方案（A方案）被否。
- 飞书那条线证明 dsh 有现成的"消息进来 → 拉起真 agent"的机制，照它做一个 HTTP 版即可。
- 用户要求：插件代码独立、标注清楚是 DSH 插件（因为不是所有人都用 dsh）。

## ③ 打算怎么改 / 怎么做的

**没碰 AICompany 核心代码**（`src/` 一行没动，72h soak 冻结没破坏）。全部新增内容在一个独立目录：

```
integrations/dsh/ceo-webhook/     ← 独立 DSH 插件目录
├── package.json                  ← 标注 "DSH Plugin (NOT part of AICompany core)"
├── cordis.patch.yml              ← dsh bundle 挂载声明
├── README.md                     ← 说明这是DSH插件、装/卸/调参方法
└── lib/
    ├── index.js                  ← 插件主体
    └── index.test.js             ← 9 条离线测试
```

插件做的事：
1. 挂在 dsh 8080 的 `/aiceo/api` 路径上（复用 dsh 自带的 webServer，不开新端口）。
2. `POST /task` 收任务 → 用 `agents.create()` 建一个带 `deepseek-account`+`deepseek-flash` 的 agent，`setup` 里 `agentPresets.mount()` 把工具装上 → `agent.followup()` 把任务递进去。
3. 监听 `session/event`，把 agent 的助手输出收集起来，`POST /result` 可查状态（running/done/error）和文本。
4. 安全：仅本机 + Host/Origin 围栏 + 可选共享令牌；session id 用 `aiceo-ceo-` 前缀，绝不和飞书/GUI 的会话撞。

**和飞书插件的关系**：接口写法参考了飞书插件（inject 服务、create/followup/session-event 这套模式），但代码是独立重写的，不 import、不修改飞书插件。飞书插件本身是现成的第三方开源插件，不是我写的——这点用户已问清。

**安装方式**：因为 pnpm 联网拉依赖失败（GitHub 的 dsh-delete-chat 包 ECONNRESET，与本插件无关），改用离线方式——`package.json` 加依赖 + bundle 条目，`node_modules` 里用目录联接(junction)指向插件目录。等价于正常安装，零运行时依赖。

## ④ 我具体验证了什么（真机证据）

| 验证项 | 结果 |
|---|---|
| 离线单测 | 9/9 通过 |
| 插件被 dsh 配置树识别 | `--dump-config` 出现 `ceo-webhook` 行，无加载错误 |
| health 端点 | 200，`agents:true, presets:true, provider/model 正确` |
| **真任务：列目录** | status=done，agent 真的调用工具列出了工作区的真实文件名（10个文件夹+48个文件），并回执"只列目录、未改动" |
| **真任务：1+1** | status=done，text="2" |
| 飞书秘书 | 启动日志有 `ws client ready` / `client ready`，长连接正常 |
| 进程持久化 | 8080 现由独立 powershell 父进程启动（非本会话），回合结束不受影响 |

踩过的两个坑（都已修）：
1. 一开始用 `connection.requestRejection` 做围栏 → 它额外要求浏览器会话认证，webhook 没有会话 → 403。改成只做 Host/Origin 围栏 + 自己的令牌。
2. `agents.create()` 不会自动继承 profile 里的默认模型 → 报"no provider/model"。改成显式传 `deepseek-account`/`deepseek-flash`。

## ⑤ 修复结果 / 当前状态

- CEO 真 agent：**可用**（已真机验证两次）。
- 飞书秘书：**正常**（长连接已恢复）。
- 8080：**独立持久进程**，不是会话内进程。
- AICompany `src/`：**未改动**，72h soak（runId `g-p5-20261116-142104`）不受影响。

## 还没做 / 下一步

- **AICompany 侧接线**（下单时自动 POST 到 `/aiceo/api/task`）：属于"接模型/接 agent 调度"，留到 72h soak 冻结结束后做。现在 API 这头已经就绪，随时可接。
- 调用示例：
  ```bash
  curl -s -X POST http://127.0.0.1:8080/aiceo/api/task \
    -H "content-type: application/json" \
    -d '{"taskId":"T-xxx","prompt":"...","cwd":"可选"}'
  curl -s -X POST http://127.0.0.1:8080/aiceo/api/result \
    -H "content-type: application/json" -d '{"taskId":"T-xxx"}'
  ```
- 回滚：删掉 web profile `package.json` 里的 `dsh-ceo-webhook` 依赖和 bundle 条目、删掉 node_modules 里的 junction、重启 8080 即可。备份在 `work/dsh-ceo-webhook-backup/`。飞书完全不受影响。
