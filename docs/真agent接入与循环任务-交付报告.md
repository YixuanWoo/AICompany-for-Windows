# 真 agent 接入下单链路 + 循环任务说明（2026-11-16）

> 通俗报告：讲清这次干了啥、为啥、怎么改的、结果如何，以及你问的「循环任务」。

---

## 一、这步到底是咋回事

上一轮我们把 CEO 做成了一个**真 agent**：装了 dsh webhook 插件，8080 上能拉起一个会读盘、会执行、还会自己验证的 AI。

但那时候它在"另起炉灶"——你得手动发个 HTTP 请求才叫得动它，**AICompany 看板下单并不会自动叫它**。这步要做的就是把这个缺口补上：让你在看板写一句话下单，AICompany 自动把任务递给真 agent，它干完活、结果回到看板。

打个比方：上一轮是"装好了电话"，这步是"把电话线接到前台下单台上"。

---

## 二、为啥要改

- 你的目标很明确：挂上 dsh，开始实际使用，而不是干等 72 小时烤机。
- 烤机（soak）是后台自己模拟下单做压力测试；真实用起来才有意义。你拍板"挂上开始使用"，所以先停了烤机，腾出手接线。
- 不停烤机也能接，但改代码会让烤机数据失真（它测的是旧代码）——所以停掉更干净。

---

## 三、打算怎么改（为啥选这个方案）

引擎（AICompany 核心）里，席位分两种：

| 席位类型 | 谁干 | 输出啥 |
|---|---|---|
| CEO（总经理） | 只拆解 / 验收 | 固定的四类「派单卡 / 验收卡」 |
| 执行席位 | 真正干活的 | 完成报告（completion report） |

**关键决定**：不能把真 agent 直接安到"CEO"头上——因为 CEO 席位有死规矩，只能输出那四类卡，真 agent 干活写的是报告，会被判违规。所以正确做法是**新增一个执行席位**，让真 agent 当"执行手"。

具体接法（挑改动最小、最不碰核心的）：

1. 加一个通用 adapter 类型 `webhook-exec`（就是个 HTTP 客户端，把任务 POST 给 8080，等 agent 干完，把它的回复包装成完成报告）。**零第三方依赖、零产品名**——不懂 dsh 的用户根本不会启用它。
2. 生产配置里加一个席位 `ceo-agent（总经理·真agent）`，用这个 adapter，指向 `http://127.0.0.1:8080`。
3. 排在执行席位第一位，所以以后走 delegate 模式（CEO 派单）时也会优先派给它。
4. 为了让引擎支持"发网络探针的环境检查"，改了一行引擎代码（给 `testEnvironment` 加了 `await`），向后兼容，269 个测试全过。

**源码零产品名纪律**：引擎核心（`src/`）不许出现任何具体产品名（dsh / 豆包 / 飞书等）。所以 adapter 在核心里叫通用的 `webhook-exec`，"接的是 dsh"这件事只写在配置和 `integrations/dsh/` 目录里——换别的服务也能用，核心一行不用改。

---

## 四、我具体改了什么

| 文件 | 改动 |
|---|---|
| `src/adapter-webhook-exec.js` | 新增：通用 webhook 执行 adapter（POST task + 轮询 result + 合成完成报告） |
| `src/adapters.js` | 注册 `webhook-exec` 类型 |
| `src/enums.js` / `config/company.schema.json` | 白名单加 `webhook-exec` |
| `src/engine.js` | `testEnvironment` 调用加 `await`（支持异步环境探针） |
| `config/company.prod.yaml` | 新增 `ceo-agent` 席位，指向 8080 |
| `tests/webhook-exec-adapter.test.js` | 新增 9 个离线单测 |
| `tests/contracts.test.js` | 更新枚举断言 |

核心引擎源码零产品名，插件本体仍在独立的 `integrations/dsh/ceo-webhook/`。

---

## 五、修复结果如何（真机证据）

**测试**：全量 269/269 通过（从 251 涨到 269，新增 18 个）。

**生产实单**（http://127.0.0.1:3100/ 下单，任务 T-285fb0a3）：
- 下单 → 生产 server 自动唤醒 `ceo-agent` → 真 agent 执行 → 任务 `done`
- agent 回执：`2+3 = 5`，而且它**真的用工具写了产物、跑了 schema 校验 + checksum 校验**，还自己发现并规避了一个"done 但没落报告文件"的脏状态风险
- 简报正常生成，飞书秘书不受影响

**生产 server 已重启加载新配置**，看板「交付给」下拉框里现在有「总经理(真agent)」这个选项。

**烤机状态**：已停，日志快照留在 `work/soak/g-p5-20261116-142104/_stopped-snapshot/`（跑了约 83 次采样 / 1 小时 20 分）。生产 server（3100）和 dsh web（8080）都没停。

**已知小改进点**（不阻塞，本次没做）：webhook-exec adapter 合成的完成报告 artifacts 为空、控制面不预建任务目录——这次靠 agent 自觉补了落盘报告。以后可以在 adapter 里统一补上，避免依赖 agent 自觉。

---

## 六、你问的：引擎有"循环任务"吗？有，而且很完整

**一句话**：有。定期维护、定期收集信息、定期开发这种"始终要循环"的活，正是它的强项。

### 三种触发方式

| 类型 | 啥意思 | 适合 |
|---|---|---|
| **cron（定时）** | 按日历定时跑：每小时 / 每天 / 每周 / 每月，可指定几点几分、周几 | 定期维护、定期收集信息、周报 |
| **event（事件）** | 外部事件来了才跑 | 收到某类消息时触发 |
| **onCompletion（完成即触发）** | 上一轮干完，立刻派生下一轮 | 持续开发、连续推进的活（刚做过，G2） |

### 它已经帮你处理好的"麻烦事"

- **漏跑了怎么办**（misfire）：错过时间点时，只补最近一次 / 跳过 / 最多补三次，可配。
- **上一轮没干完又到点了**（overlap）：跳过 / 排队 / 并行，可配。
- **别重复建卡**（dedupe）：同一时间点只建一张卡， cron 和补偿扫描双触发也不会重复。
- **终止条件**（termination）：跑满 N 轮 / 到某日期 / 烧够额度 / 连续失败 N 次，自动暂停并通知人（不会自己无限跑下去）。
- **改频率 / 改模板要走人审**（P4-9 L3）：批准后只影响新轮次，历史轮次原样保留。
- **跨轮记忆**（carryOver）：上一轮没解决的问题会挂到下一轮，不会每轮从零开始——正好适合"定期开发"这种连续推进的活。

### 频率支持

`FREQ=HOURLY / DAILY / WEEKLY / MONTHLY` + `INTERVAL / BYHOUR / BYMINUTE / BYDAY / BYMONTHDAY`。（暂不支持 YEARLY。）

### 一个真实例子（定期维护）

```yaml
jobId: weekly-maintenance
trigger:
  type: cron
  rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"   # 每周一早上9点
  timezone: Asia/Shanghai
termination:
  pauseOnConsecutiveFailures: 3
taskTemplate:
  instructions: "检查项目目录、清理临时文件、汇总本周状态"
  acceptance: ["输出维护报告"]
```

循环任务定义在数据库 `recurring_jobs` 表里，由引擎的调度 tick 驱动；配置 / API 入口在 `src/recurring.js`。你想给哪个项目配定期任务，我可以照这个格式帮你建。
