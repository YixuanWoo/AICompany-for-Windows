# 重启后收尸：僵死的 running run（及由此引出的「待验收」卡死）

## 二次事故：一次僵尸 run 把验收吞了，卡停在「待验收」28 分钟

现象：`T-7a284ca4`（接管自媒体工作台）看板一直显示**待验收**，但代码早就交完了。

时间线（全部有审计/事件可查）：

| 时间 | 发生了什么 |
|---|---|
| 10:34:35 | 工程岗被「你刚动过键鼠」闸拦下，4 秒后重投 → run `R-613847b3` 开跑 |
| 10:34:39 | 同一个任务又被 `gate_retry` 叫了一次，`R-613847b3` **一直没结束**（进程后来被收掉，账没结） |
| 10:45:44 | 另一条 `bridge_checkout` run 交完活 → 卡转 `in_review`，引擎发出 `review_requested` 事件 |
| 10:45:44 | 泵消费这条事件 → `wake(ceo, review_requested)` 被「**同一张卡已有 Run 在跑，不重复派**」挡下，**且这处 skip 完全静默（不写审计）** |
| 10:45 → 11:15 | 事件已被标 `processed`，不会再重放；CEO 从没被叫过 → 卡永远停在待验收 |

三个设计缺陷叠在一起才出事：

1. **同卡 run 让路是静默的**：跳过时一行账都不记，事后只能靠对时间戳猜；
2. **`review_requested` 是一次性事件**：泵先标 `processed` 再处理，处理时一 `return` 就永久丢失；
3. **`running` 没有上限**：进程被 kill / 适配器卡死时，`maxRunHours`（默认 2h）只被 `observe.js` 当成「体检项」报警，没人真去收账。

### 修了什么

- `wake()`：同卡 run 让路补审计 `wake_deferred`（`agentId|same_run|runId`）；
- `handleEvent` 的 `review_requested`：被挡下补审计 `review_deferred`（带 code / reason），不再静默；
- `reconcile`（每分钟心跳）新增两步：
  - **① 超时 run 收尸**：`running` 超过 `runPolicy.maxRunHours`（默认 2h）→ 标 `interrupted` + 补 `finishedAt` + 审计 `run_timeout`；
  - **② 验收补审**：`in_review` 但既没有 Run 在跑、也没有排队中的 `review_requested` → 补发一条（按分钟去重），审计 `review_requeued`；
    补满 5 次还走不完就停手、审计 `review_stuck` 并推气泡给董事会（不再自动烧 CEO 额度）。
- 启动时仍然先做一次全量收尸（`recoverOrphanRuns`，见下文）。

### 生产实测（2026-11-17 19:06–19:18）

- 重启后心跳第一次补审：审计 `review_requeued 第 1 次补审：待验收但没人被叫起来过`（11:15:29）；
- CEO run `R-2f5266e2` 被真叫起来（11:15:29 → 11:16:34 success），**打回**：卡目录缺 `completion.json`、
  报告引用与日志对不上、自认 901 行超出「单点小改」尺度；
- 引擎按既有规则把卡退回 `in_progress` 并派返工（`wakeReason=rework`，run `R-14b46e07` 正在跑）。

结论：这张卡不是「莫名卡在待验收」，是**验收事件被吞**；现在吞事件的三个口都被堵住，最慢 1 分钟就会自动补审。

## 启动收尸（本轮前半段）

- 新增 `src/engine.js` `recoverOrphanRuns()`：把库里所有 `status='running'` 的 run 改成 `interrupted`、
  补 `finishedAt`、写审计 `run_orphaned`（记 runId / 席位 / 起始时间），并返回收掉几条。
  只动 run 的账，**不动任务卡状态**——卡该怎么等还怎么等，交给 `reconcile` 补投。
- `src/server.js` 启动时（`createServer` 之后、`scheduler.start()` 之前）调用它，
  有收尸就打印一行：`[启动] 收掉 N 条上次进程遗留的 running run（按中断记账，不动任务卡状态）`。
- 看板 `STATUS_LABELS` 加 `interrupted: '被重启打断'`，不再显示英文生词。

## 为什么放在启动时而不是心跳里

进程刚起来的那一刻，「running」必然是上一个进程的尸体（GUI 席位进程是控制面的子进程，
`win:stop` 会一起收掉）。放在心跳里反而危险：真在跑的长任务会被误判成僵尸。

## 验证

- 新增 `tests/orphan-run.test.js`：僵尸 run → `interrupted` + `finishedAt` 补齐 + 审计留痕 + 幂等（再跑一次返回 0），
  且任务卡状态原地不动。
- `node --test` → **396/396 通过**（`orphan-run` 1 条 + `review-recovery` 2 条）。
- 新增 `tests/review-recovery.test.js`：3 小时前开跑的僵尸 run → 心跳收尸 + 补审 → mock CEO 给 pass 后卡真的 `done`；
  补审满 5 次 → 停手 + `review_stuck` + 不再发事件（不烧额度）。
- 生产实测：重启后日志出现 `[启动] 收掉 1 条上次进程遗留的 running run`，
  库里 `running runs = 0`、`R-613847b3` 变 `interrupted`，看板 HTTP 200，2 条循环任务仍在。

## 顺带的使用提醒

- 看到看板「干活中」但任务卡其实没动，先查 `runs` 里有没有僵尸 run；
  现在心跳会给超过 `maxRunHours` 的 run 自动收尸，不用非得重启。
- 看到「待验收」但活早交完了：心跳 1 分钟内会自动补审；连着补 5 次还不成会推气泡报给你，不再静静挂着。
- 收尸只按「重启 / 超时」两个信号触发，不会清掉正在跑的真实 run。
