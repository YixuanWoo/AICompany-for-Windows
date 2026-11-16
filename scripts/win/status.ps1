<#
  查常驻状态：计划任务 / 进程 / 端口 / GUI 席位闸门 / 最近日志。
  用法：
      powershell -ExecutionPolicy Bypass -File scripts\win\status.ps1
      powershell -ExecutionPolicy Bypass -File scripts\win\status.ps1 -Profile demo
#>
param(
  [string]$Profile = 'prod',
  [string]$TaskName = '',
  [int]$Port = 0,
  [int]$TailLines = 15
)

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot '_profile.ps1')
# 不加这句，Invoke-WebRequest 的进度条会插进输出中间，把状态信息搅成一团。
$ProgressPreference = 'SilentlyContinue'

try {
  $p = Get-ProfileInfo -Root $Root -Name $Profile
} catch {
  Write-Output $_.Exception.Message
  exit 2
}
if ([string]::IsNullOrWhiteSpace($TaskName)) { $TaskName = [string]$p.taskName }
if ($Port -le 0) { $Port = [int]$p.port }

$PidFile = Join-Path ([string]$p.runDir) 'aicompany.pid'
$LogDir = [string]$p.logDir

Write-Output "=== 档位：$Profile（端口 $Port） ==="
Write-Output "  配置：$($p.config)"
Write-Output "  数据库：$($p.db)"

Write-Output '=== 计划任务 ==='
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Output ("  {0} | 状态 {1} | 上次结果 {2} | 上次运行 {3}" -f $TaskName, $task.State, $info.LastTaskResult, $info.LastRunTime)
  $limit = $task.Settings.ExecutionTimeLimit
  Write-Output ("  运行时长上限：{0}" -f $(if ([string]::IsNullOrWhiteSpace($limit) -or $limit -eq 'PT0S') { '无限制（正确）' } else { "$limit（注意：非零会中途被杀）" }))
} else {
  Write-Output "  未注册（重启后不会自动启动）"
}

Write-Output '=== 进程 ==='
if (Test-Path $PidFile) {
  try {
    # 与 stop.ps1 同理：必须显式 UTF8，否则中文路径会把 JSON 解坏。
    $pidInfo = Get-Content $PidFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $proc = Get-Process -Id $pidInfo.pid -ErrorAction SilentlyContinue
    if ($proc) {
      $up = (Get-Date) - $proc.StartTime
      Write-Output ("  pid {0} 运行中，已跑 {1} 天 {2} 小时 {3} 分（启动原因 {4}）" -f $pidInfo.pid, $up.Days, $up.Hours, $up.Minutes, $pidInfo.reasonCode)
    } else {
      Write-Output ("  pid {0} 已不在（残留 pid 文件）" -f $pidInfo.pid)
    }
  } catch { Write-Output "  pid 文件读不出来：$_" }
} else {
  Write-Output '  没有 pid 文件，未在运行'
}

Write-Output '=== 端口 ==='
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/dashboard" -UseBasicParsing -TimeoutSec 3
  Write-Output ("  http://127.0.0.1:{0} 正常（HTTP {1}）" -f $Port, $r.StatusCode)
  try {
    $d = $r.Content | ConvertFrom-Json
    $taskTotal = 0
    if ($d.tasks) { foreach ($prop in $d.tasks.PSObject.Properties) { $taskTotal += [int]$prop.Value } }
    Write-Output ("  任务 {0} 张，唤醒 {1} 次" -f $taskTotal, $d.runs)
  } catch { }
} catch {
  Write-Output ("  端口 {0} 无响应" -f $Port)
}

Write-Output '=== GUI 席位 ==='
try {
  $g = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/gui/state" -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json
  if (-not $g.seats -or $g.seats.Count -eq 0) {
    Write-Output '  这个实例没有 GUI 席位（不会抢键鼠）'
  } else {
    foreach ($seat in $g.seats) {
      Write-Output ("  {0}（{1}）：闸门可配 {2} 项" -f $seat.agentId, $seat.displayName, ($seat.gate.PSObject.Properties | Measure-Object).Count)
    }
    if ($g.paused) { Write-Output ("  状态：已暂停（{0}）" -f $g.pauseReason) }
    else { Write-Output '  状态：正常（可抢键鼠）' }
    if ($g.seatClaim -and $g.seatClaim.held) {
      Write-Output ("  占位：被 pid {0} 占用" -f $g.seatClaim.state.pid)
    }
  }
} catch {
  Write-Output '  查不到 GUI 状态（端口没响应或旧版本）'
}

Write-Output '=== 重启次数（本次日志） ==='
if (Test-Path $LogDir) {
  $latest = Get-ChildItem $LogDir -Filter 'server-*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) {
    $restarts = (Select-String -Path $latest.FullName -Pattern '第 \d+ 次重启|控制面退出' -AllMatches -ErrorAction SilentlyContinue).Count
    Write-Output ("  {0}：崩溃重启记录 {1} 条" -f $latest.Name, $restarts)
    Write-Output '  --- 最近日志 ---'
    # 日志是 UTF-8；不写 -Encoding UTF8 会被按 GBK 读成乱码。
    Get-Content $latest.FullName -Tail $TailLines -Encoding UTF8 | ForEach-Object { Write-Output "  $_" }
  } else {
    Write-Output '  还没有日志文件'
  }
} else {
  Write-Output '  日志目录不存在'
}
