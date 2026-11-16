<#
  AICompany 控制面 · Windows 开机自启安装
  用法（普通权限即可，不需要管理员）：
      powershell -ExecutionPolicy Bypass -File scripts\win\install.ps1                 # 默认装 prod
      powershell -ExecutionPolicy Bypass -File scripts\win\install.ps1 -Profile demo   # 另装演示实例
      powershell -ExecutionPolicy Bypass -File scripts\win\install.ps1 -Start
      powershell -ExecutionPolicy Bypass -File scripts\win\install.ps1 -Profile demo -Uninstall

  「档位」（profile）决定端口 / 配置 / 数据库 / 日志目录 / 产物目录 / 计划任务名，
  全部在 config\profiles.json 里，这里只负责按档位注册计划任务。

  三个设计决定，都是踩过坑的：
  1. 用「用户登录时」触发，不用 SYSTEM。SYSTEM 会话没有交互桌面，
     往 GUI 里注入按键必须能在当前桌面里操作。
  2. ExecutionTimeLimit 显式设为「无限制」。默认 72 小时，挂三天正好被杀。
  3. 用 wscript 跑 VBS 来隐藏窗口。直接注册 node.exe 会弹一个黑框。
#>
param(
  [string]$Profile = 'prod',
  [int]$Port = 0,
  [string]$TaskName = '',
  [switch]$Uninstall,
  [switch]$Start
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot '_profile.ps1')

function Assert-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'PATH 里找不到 node。请先安装 Node.js 并确认 `node -v` 可用。' }
  return $cmd.Source
}

try {
  $p = Get-ProfileInfo -Root $Root -Name $Profile
} catch {
  Write-Output $_.Exception.Message
  Write-Output '可用档位见 config\profiles.json。'
  exit 2
}

if ($Port -le 0) { $Port = [int]$p.port }
if ([string]::IsNullOrWhiteSpace($TaskName)) { $TaskName = [string]$p.taskName }

$RunDir = [string]$p.runDir
$LogDir = [string]$p.logDir
$VbsPath = Join-Path $RunDir "launch-hidden-$Profile.vbs"
$RunnerJs = Join-Path $Root 'src\runner.js'

function Remove-Task {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "已移除计划任务：$TaskName"
  } else {
    Write-Output "计划任务不存在：$TaskName"
  }
}

if ($Uninstall) {
  Remove-Task
  $status = & node $RunnerJs --profile $Profile --status 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Output "检测到实例仍在运行，正在停止…"
    & (Join-Path $PSScriptRoot 'stop.ps1') -Profile $Profile -TaskName $TaskName
  }
  if (Test-Path $VbsPath) { Remove-Item $VbsPath -Force }
  Write-Output '卸载完成（数据库、日志、产物一律保留，未删除任何数据文件）。'
  exit 0
}

$NodeExe = Assert-Node
New-Item -ItemType Directory -Force -Path $RunDir, $LogDir | Out-Null

# VBS 里写死绝对路径：计划任务的环境变量和 PATH 与终端不一定一致。
# 开头先查「这个档位的 runner 是不是已经在跑」，所以在跑时被定时触发会立刻退出，几乎零开销；
# 这也是第二层保险 —— runner 自己被系统杀掉时，下一次触发会把它重新拉起来。
# 匹配串必须带 --profile：不然装了演示实例就会把生产实例的启动请求也挡掉。
$vbs = @"
' 由 scripts\win\install.ps1 生成，请勿手改（重装会覆盖）。
' 0 = 隐藏窗口，False = 不等待。控制台完全不可见，日志见 $LogDir。
Set shell = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set alive = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='node.exe' AND CommandLine LIKE '%runner.js%--profile $Profile%'")
If alive.Count > 0 Then WScript.Quit 0
shell.Run """$NodeExe"" ""$RunnerJs"" --profile $Profile", 0, False
"@
# 必须 -Encoding Unicode（UTF-16 LE + BOM）：WSH 原生支持它，而 ASCII 会把
# 「D:\开源\...」里的中文写成问号，VBS 一跑就是「找不到路径」。
Set-Content -Path $VbsPath -Value $vbs -Encoding Unicode
Write-Output "已生成隐藏启动脚本：$VbsPath"

Remove-Task | Out-Null

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$VbsPath`"" -WorkingDirectory $Root
# 触发器一：登录时启动。
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# 触发器二：每 5 分钟巡检一次。配合 VBS 里的「已在跑就退出」，平时零成本，
# runner 被意外杀掉后最多 5 分钟自动复活。
$triggerWatch = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
# 默认值 72 小时会正好在第三天把常驻任务掐掉，必须清零。
$settings.ExecutionTimeLimit = 'PT0S'
$settings.DisallowStartIfOnBatteries = $false

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggerLogon, $triggerWatch `
  -Settings $settings -Description "AICompany 控制面常驻（档位 $Profile，端口 $Port）" `
  -RunLevel Limited | Out-Null

Write-Output "已注册计划任务：$TaskName（档位 $Profile / 端口 $Port / 用户 $env:USERNAME）"
Write-Output "  登录时启动 + 每 5 分钟巡检，不限运行时长"
Write-Output "  配置：$($p.config)"
Write-Output "  数据库：$($p.db)"

if ($Start) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  & (Join-Path $PSScriptRoot 'status.ps1') -Profile $Profile -TaskName $TaskName -Port $Port
} else {
  Write-Output ''
  Write-Output "下次登录会自动启动。想现在就起，执行："
  Write-Output "    powershell -ExecutionPolicy Bypass -File scripts\win\start.ps1 -Profile $Profile"
}
