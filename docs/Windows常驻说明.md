# Windows 常驻说明

> 目标：让控制面（看板 + 调度器）在你关上终端、锁屏、重启之后都还在跑，出问题能自己活过来，且随时能查、能停、能卸。
> 本文所有命令都在项目根目录 `D:\开源\AICompany` 下执行。**不需要管理员权限。**

## 一、一条命令装好

```bash
npm run win:install
```

它就是 `install.ps1`（**默认 `-Profile prod`**），会做三件事：

1. 生成隐藏启动脚本 `work\run\launch-hidden-<档位>.vbs`（把 node 的绝对路径写死，避免计划任务里 PATH 不一样）；
2. 注册计划任务 `AICompany-ControlPlane`（`prod` 档）：**你登录时启动** + **每 5 分钟巡检一次**；
3. 显式把「运行时长上限」设为**无限制**。

装完想立刻起：

```bash
npm run win:start
```

### 档位（profile）：装两套互不干扰

| 档位 | 端口 | 配置 | 数据 / 日志 | 计划任务 |
|---|---|---|---|---|
| `prod`（默认） | 3100 | `config/company.prod.yaml` | `work-prod\` | `AICompany-ControlPlane` |
| `demo` | 3199 | `config/company.example.yaml` | `work\` | `AICompany-Demo` |

npm 脚本默认都走 `prod`；要动 `demo` 就直接调 PowerShell（**同一台机器不要两个档位都配 GUI 席位**，键鼠只有一副）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\win\install.ps1 -Profile demo
powershell -ExecutionPolicy Bypass -File scripts\win\status.ps1  -Profile demo
powershell -ExecutionPolicy Bypass -File scripts\win\stop.ps1    -Profile demo
```

档位定义在 `config\profiles.json`，解析由 node 统一做（`src\runner.js --profile demo --print-profile`），PowerShell 侧不自己拼路径。

## 二、日常就三条命令

| 想干什么 | 命令 |
|---|---|
| 看它活着没、跑多久了、日志最后几条 | `npm run win:status` |
| 停（服务和你开着的活会中断，重启后补偿扫描会把卡重投） | `npm run win:stop` |
| 起 | `npm run win:start` |
| 想有个托盘图标点着用 | `npm run win:tray` |
| 彻底卸掉自启（**不删任何数据**） | `npm run win:uninstall` |

看板地址：<http://127.0.0.1:3100>

`status` 现在多打一段 **GUI 席位**信息：谁占着席位、占位 pid、闸门配了哪几道（暂停 / 时段 / 静置 / 锁屏）。

## 三、它怎么保证「挂了能自己活」

三层，各管一段：

```
第 1 层  server 进程崩溃        → runner 立刻重启它（1s 起，指数退避，最长 60s）
第 2 层  runner 自己被系统杀掉  → 计划任务每 5 分钟巡检，发现没人就把 runner 拉起来
第 3 层  runner 活着但 server 成了孤儿 → 新 runner 识别出来，先送走孤儿再接管
```

第 2 层的巡检很轻：VBS 先查「有没有 node 在跑 runner.js」，**有就直接退出**，不会叠出第二个实例。所以平时几乎零开销。

## 四、日志在哪

`work-prod\logs\server-2026-11-15.log` —— 按天一个新文件，单日超过 8MB 自动换分片（`.2.log`、`.3.log`）。（`demo` 档在 `work\logs\`。）

**程序不删日志。** 清理请你自己做，或看清空规则后再动手。

日志里能看到的典型行：

```
[时间] [info] 控制面已启动 pid=27360（首次启动）
[时间] [error] 控制面退出 code=1 signal=-，已活 18 秒
[时间] [info] 1000ms 后第 1 次重启
[时间] [warn] 发现孤儿控制面（pid 27360，其守护 30104 已不在），先结束它再接管。
[时间] [error] 控制面拒绝启动（code=5）：GUI 席位已被另一个控制面占用。不再重试……
```

最后那条是新加的：**`exit 5`（席位被占）不再当崩溃重试**。以前会连着重启 20 次把日志刷满，真原因反而被埋掉；现在说一句就收摊，让你去停那个占位实例。

## 五、故障对照表

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `status` 说「没有 pid 文件」 | 没起过，或被 stop 过 | `npm run win:start` |
| `status` 说「pid xxx 已不在（残留 pid）」 | 进程崩了但没清 pid | 等巡检（≤5 分钟）或手动 start |
| `status` 说「计划任务：未注册」 | 换过机器 / 卸过 | `npm run win:install` |
| 日志里连续「第 N 次重启」 | 有东西让它一直崩 | 看日志最后一条错误；连续崩 20 次会主动放弃并写日志 |
| 日志说「GUI 席位已被另一个控制面占用」 | 起了第二份带同一个 GUI 席位的实例 | 先停掉那份（`status` 会给出占位 pid）；**不要靠重试解决**，重试一定会再被拒 |
| 端口被占用 | 有别的进程占了 3100 | 改 `config\profiles.json` 里 `prod.port`，或在 `demo` 档（3199）上试 |

## 六、必须知道的边界（别拿它当服务器）

- **电脑休眠 / 睡眠时进程会被冻结**：期间定时任务不跑，唤醒后一次性补齐。如果靠它跑「连续 3 天」，请在电源设置里关掉睡眠，或至少知道这三天中间有断档。
- **锁屏不影响运行**，注销会（任务会随会话结束）。
- **不监听外网**：默认只绑 `127.0.0.1`，别的机器访问不到，这是故意的。
- **托盘只验证到「能起、不崩、消息循环在跑」**：图标颜色、右键菜单、气泡通知**没有在真实托盘区点过**（我做验证的环境不允许截屏）。你打开看到不对，告诉我。
- 计划任务跑在**你登录的用户会话**里，不是 SYSTEM —— 这是为了以后能往豆包工作这类 GUI 里注入按键。代价是：没人登录时它不会跑。

## 七、文件清单

| 文件 | 作用 |
|---|---|
| `src/runner.js` | 守护本体：日志重定向、崩溃重启、pid 管理、孤儿接管、**致命退出码（5＝席位被占）不重试** |
| `config/profiles.json` | 档位定义：端口 / 配置 / 数据目录 / 日志目录 / 计划任务名 / 维护心跳 / 席位占用文件 |
| `scripts/win/_profile.ps1` | 四个脚本共用的档位解析（唯一真相在 `profiles.json`，交给 node 解析） |
| `scripts/win/install.ps1` | 装自启 + 生成隐藏启动脚本；`-Uninstall` 卸载；`-Profile` 选档位 |
| `scripts/win/start.ps1` / `stop.ps1` | 起 / 停 |
| `scripts/win/status.ps1` | 查状态（含 GUI 席位段） |
| `scripts/win/tray.ps1` | 托盘（绿点在线 / 红点离线） |
| `work\run\launch-hidden-<档位>.vbs` | 安装时生成，隐藏窗口启动 runner |
| `work-prod\run\aicompany.pid`（demo 档在 `work\run\`） | 谁在跑。**内容全是 ASCII**，因为 PowerShell 5.1 默认按 GBK 读文件，中文会把 JSON 解坏 |
| `work\gui-seat.json` | GUI 席位占位（谁占了键鼠 / pid / 端口 / 配置路径），**跨档位共享**——键鼠只有一副 |
