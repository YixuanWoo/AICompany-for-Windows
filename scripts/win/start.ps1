<#
  启动控制面（隐藏窗口）。优先走计划任务，没有注册就直接跑 VBS。
  用法：
      powershell -ExecutionPolicy Bypass -File scripts\win\start.ps1
      powershell -ExecutionPolicy Bypass -File scripts\win\start.ps1 -Profile demo
#>
param(
  [string]$Profile = 'prod',
  [string]$TaskName = '',
  [int]$Port = 0,
  [int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Stop'
# 抑制 Invoke-WebRequest 的进度条，否则它会插进输出把结果搅乱。
$ProgressPreference = 'SilentlyContinue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot '_profile.ps1')

try {
  $p = Get-ProfileInfo -Root $Root -Name $Profile
} catch {
  Write-Output $_.Exception.Message
  exit 2
}
if ([string]::IsNullOrWhiteSpace($TaskName)) { $TaskName = [string]$p.taskName }
if ($Port -le 0) { $Port = [int]$p.port }

$VbsPath = Join-Path ([string]$p.runDir) "launch-hidden-$Profile.vbs"

$status = & node (Join-Path $Root 'src\runner.js') --profile $Profile --status 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Output "已经在跑：$status"
  exit 0
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "已通过计划任务启动：$TaskName（档位 $Profile）"
} elseif (Test-Path $VbsPath) {
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$VbsPath`"" -WindowStyle Hidden
  Write-Output '已通过隐藏启动脚本启动（未注册计划任务，重启后不会自动起来）'
} else {
  throw "既没有计划任务 $TaskName，也没有 $VbsPath。请先运行 install.ps1 -Profile $Profile。"
}

for ($i = 1; $i -le $WaitSeconds; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/dashboard" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) {
      Write-Output "看板已就绪：http://127.0.0.1:$Port（等待 $i 秒）"
      exit 0
    }
  } catch { }
}
Write-Warning "等了 $WaitSeconds 秒看板还没响应，用 status.ps1 -Profile $Profile 看日志。"
exit 1
