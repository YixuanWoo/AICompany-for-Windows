<#
  停止控制面。先礼后兵：温柔 kill 不成就强制结束进程树。
  用法：
      powershell -ExecutionPolicy Bypass -File scripts\win\stop.ps1
      powershell -ExecutionPolicy Bypass -File scripts\win\stop.ps1 -Profile demo
#>
param(
  [string]$Profile = 'prod',
  [string]$TaskName = ''
)

$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot '_profile.ps1')

try {
  $p = Get-ProfileInfo -Root $Root -Name $Profile
} catch {
  Write-Output $_.Exception.Message
  exit 2
}
if ([string]::IsNullOrWhiteSpace($TaskName)) { $TaskName = [string]$p.taskName }

$PidFile = Join-Path ([string]$p.runDir) 'aicompany.pid'

$pidInfo = $null
$parseError = $null
if (Test-Path $PidFile) {
  try {
    # 必须显式 -Encoding UTF8：PowerShell 5.1 默认按 GBK 读，遇到 UTF-8 内容会解坏并吞字节。
    $pidInfo = Get-Content $PidFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    $parseError = $_.Exception.Message
    $pidInfo = $null
  }
}

if (-not $pidInfo -or -not $pidInfo.pid) {
  if ($parseError) { Write-Output "pid 文件读不出来：$parseError" }
  else { Write-Output "没有 pid 文件（档位 $Profile），控制面可能没在跑。" }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  exit 0
}

# 必须从 runner 那一层收：只杀 pid 文件里的子进程，runner 会在一秒内把它重新拉起来。
# 先用 runnerPid（有就优先），再退回子进程 pid，都套 /T 带走整棵进程树。
$rootPid = $null
if ($pidInfo.runnerPid -and (Get-Process -Id $pidInfo.runnerPid -ErrorAction SilentlyContinue)) {
  $rootPid = $pidInfo.runnerPid
} elseif (Get-Process -Id $pidInfo.pid -ErrorAction SilentlyContinue) {
  $rootPid = $pidInfo.pid
}

if (-not $rootPid) {
  Write-Output "pid $($pidInfo.pid) 与 runner 都已经不在（残留 pid 文件）。"
} else {
  # 强杀会中断正在执行的 Run；重启后维护心跳 / 补偿扫描会把它们重投，不会丢卡。
  & taskkill.exe /PID $rootPid /T /F | Out-Null
  Start-Sleep -Milliseconds 500
  Write-Output "已停止 pid $rootPid 及其子进程（档位 $Profile）。"
  if ($rootPid -ne $pidInfo.pid) { Write-Output "  顺带收掉了控制面子进程 pid $($pidInfo.pid)。" }
}

$stillPid = Get-Process -Id $pidInfo.pid -ErrorAction SilentlyContinue
if ($stillPid) {
  & taskkill.exe /PID $pidInfo.pid /T /F 2>$null | Out-Null
  Write-Output "子进程 pid $($pidInfo.pid) 仍在，已再次强制结束。"
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Output '计划任务实例也已停止。'
}
exit 0
