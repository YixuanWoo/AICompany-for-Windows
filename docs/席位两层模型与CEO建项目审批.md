# 席位两层模型 + 总经理自主建项目审批

2026-11-16 晚 · 董事会四点要求落地

## 一、这步是咋回事

上一轮我把"岗位"和"人"写在同一行，虽然加了 `post` / `holder` 两个字段，但结构上还是一个数组——**没法表达"同一个 agent 同时担任两个岗位"**，因为 adapter（怎么调用这个 agent）挂在席位上，等于一个席位自带一个 agent。

这一轮把它彻底拆成两层：

- **holders（担任者）**：真的是一个 agent，写 `name` 和 `adapter`（怎么调用它）。
- **posts（岗位）**：席位的名字，写 `title`（一看干啥）和 `heldBy`（谁担任）。

一个 holder 可以被任意多个 post 引用；每个岗位还能用 `adapterConfig` 覆盖参数（比如同一个 agent 在"总经理"岗走 `mode: ceo`，在别的岗走普通模式）。

## 二、为什么改

你的原话：席位名称必须是具体岗位，担任者必须是 agent 名称，并且**两个不同岗位由一个 agent 担任时，都要能调用同一个 agent**。

旧的写法做不到第三点：想复用同一个 agent，只能复制一份配置，改一处要改两处，迟早不一致。

## 三、现在的写法（生产配置）

```yaml
holders:                     # 担任者：真的 agent
  - id: dsh-planner
    name: dsh 规划 agent     # 一看就知道谁干
    kind: external-agent
    adapter:
      type: webhook-exec
      config: { baseUrl: http://127.0.0.1:8080, ... }
  - id: doubao-work
    name: 豆包工作
    kind: gui-app
    adapter:
      type: gui-template
      config: { windowTitle: 豆包工作, ... }

posts:                       # 岗位：席位的名字
  - id: ceo
    title: 总经理            # 一看就知道干啥
    heldBy: dsh-planner
    adapterConfig: { mode: ceo }   # 同一 agent 在这个岗按 CEO 契约输出
    isCEO: true
  - id: doubao
    title: 执行
    heldBy: doubao-work
```

要复用同一个 agent，只需再加一个 post、`heldBy` 写同一个 id，adapter 完全共用。测试 `配置：两个岗位可以由同一个 agent 担任` 已经把这个场景钉住：两个岗位 → 同一个 adapter 类型、同一条命令、各自的 `adapterConfig` 互不污染。

看板会在兼任时标出「同一 agent 兼任 N 岗」，避免误以为多买了一份。

## 四、总经理自主建项目：只审不填

之前的毛病：CEO 只能"建议"，然后**董事会要自己在表单里填 id、路径、验收条件**——你说这太麻烦。

现在流程反过来：

1. CEO 在拆活时认为该单开项目 → 输出完整申请单（id、中文名、落盘目录、交付子目录、为什么建、**验收条件**、**固定规矩**）。
2. 引擎出一张「新建项目申请」卡到「席位与审批」页，结构化展示上面全部信息。
3. 董事会只有两个按钮：**通过并创建** / **拒绝**，下面一个意见输入框（可留空）。
4. 通过 → 引擎建目录、按 CEO 拟的验收条件和规矩写 `project.yaml`、注册进配置、立刻生效。
5. CEO 如果填的落盘目录不存在 → 建失败，**审批单回滚成待办**并把原因原样告诉你，不会留下"批了但没建成"的脏状态。

原来那张手填表单没删，收进了「手工兜底」折叠区（比如你想先建项目再下单），正常用不到。

## 五、具体改了什么

| 文件 | 改了什么 |
|---|---|
| `src/config.js` | 新增 `expandPostsAndHolders()`：把 posts + holders 合成引擎用的 agents；缺 name / title / heldBy 直接报错；体检新增"担任者复用"项 |
| `config/company.schema.json` | 新增 `holders` / `posts` 两段 schema |
| `config/company.prod.yaml` | 改成两层写法，岗位与担任者彻底分开 |
| `src/core.js` | agents 表加 `holderId`（老库自动补列），名册与配置同步 |
| `src/engine.js` | 名册返回兼任数；新建项目申请单带 acceptance / rules；审批通过建失败时回滚审批单 |
| `src/projects.js` | `createProject` 支持用 CEO 拟的 acceptance / rules 写规范（没给才用空白模板） |
| `src/adapter-webhook-exec.js` | CEO 提示词：申请单要填完整规范，董事会只审不填；名册按「岗位 / 担任者」给 |
| `src/web/board.html` | 新建项目申请专用卡片（结构化 + 意见框 + 通过/拒绝）；去掉 `window.prompt`；手填表单折叠 |
| 测试 | 新增"一 agent 兼两岗"、"按 CEO 草案写规范"，全量 **282/282** |

## 六、dsh 测试口径（按你说的改了）

- 允许用 dsh 做真机测试，**但只在非高峰期**。
- 高峰期（08:30–24:00）不跑真机测试；需要验证就写成定时任务排到夜里。
- 已建定时任务「AICompany 非高峰质量检查」：**每天 03:00**，跑全量离线测试 + dsh 健康检查 + 席位名册核对（**只查 health，不投任务、不花钱**），结果追加到 `work-prod/nightly-check.log`。
- 真机冒烟（会烧 token）仍按需执行，且只在 00:30–08:30 窗口内做。

## 七、还剩的边界

1. **额度按岗位算，不按 agent 算**：两个岗位共用一个 agent 时，看板上是两份额度，实际烧的是同一个账号。要不要合并成一个池子，你定，我再改。
2. **执行岗还是豆包工作**，抢键鼠、一次一件。真机测试夜里跑的话，它会动键鼠——所以我没把"真机冒烟"放进定时任务，只放了不花钱的检查。
3. 总经理申请建项目仍然需要你点通过（这是你定的"特殊审批"），它不能绕开董事会直接建。
