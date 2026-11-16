<#
  AICompany 托盘（零依赖：只用系统自带的 WinForms / Drawing）。
  绿点 = 看板在线；红点 = 挂了或被停。
  双击图标开看板；右键可启停、重启、看日志。
  用法（隐藏运行，不占任务栏）：
      powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\win\tray.ps1
  想让托盘自己也开机自启，见 install.ps1 末尾的说明。
#>
param(
  [int]$Port = 3100,
  [int]$IntervalSec = 10
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Url = "http://127.0.0.1:$Port"
$LogDir = Join-Path $Root 'work\logs'
$WinDir = Join-Path $Root 'scripts\win'

function New-DotIcon {
  param([System.Drawing.Color]$Color)
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $Color
  $g.FillEllipse($brush, 1, 1, 13, 13)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(60, 60, 60)), 1.2
  $g.DrawEllipse($pen, 1, 1, 13, 13)
  $g.Dispose()
  $hIcon = $bmp.GetHicon()
  return [System.Drawing.Icon]::FromHandle($hIcon)
}

function Test-Online {
  try {
    $r = Invoke-WebRequest -Uri "$Url/api/dashboard" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Invoke-WinScript {
  param([string]$Name)
  $file = Join-Path $WinDir $Name
  Start-Process -FilePath 'powershell.exe' -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$file`"" -WindowStyle Hidden
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemOpen = $menu.Items.Add('打开看板')
$itemOpen.add_Click({ Start-Process $Url })
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$itemStart = $menu.Items.Add('启动')
$itemStart.add_Click({ Invoke-WinScript 'start.ps1' })
$itemStop = $menu.Items.Add('停止')
$itemStop.add_Click({ Invoke-WinScript 'stop.ps1' })
$itemRestart = $menu.Items.Add('重启')
$itemRestart.add_Click({
  Invoke-WinScript 'stop.ps1'
  Start-Sleep -Seconds 2
  Invoke-WinScript 'start.ps1'
})
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$itemLog = $menu.Items.Add('看最新日志')
$itemLog.add_Click({
  $latest = Get-ChildItem $LogDir -Filter 'server-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) {
    Start-Process notepad.exe $latest.FullName
  } else {
    [System.Windows.Forms.MessageBox]::Show('还没有日志文件。', 'AICompany')
  }
})
$itemDir = $menu.Items.Add('打开数据目录')
$itemDir.add_Click({ Start-Process explorer.exe $Root })
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$itemQuit = $menu.Items.Add('退出托盘（不影响服务）')
$itemQuit.add_Click({
  $script:alive = $false
  $timer.Stop()
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$tray.ContextMenuStrip = $menu
$tray.add_DoubleClick({ Start-Process $Url })
$tray.Visible = $true

$script:lastOnline = $null
$script:alive = $true

function Update-State {
  $online = Test-Online
  if ($online) {
    if ($script:lastOnline -eq $false) {
      $tray.ShowBalloonTip(3000, 'AICompany', '控制面已恢复在线。', 'Info')
    }
    $tray.Icon = New-DotIcon ([System.Drawing.Color]::FromArgb(46, 160, 67))
    $tray.Text = "AICompany 运行中 · $Url"
    $itemStart.Enabled = $false
    $itemStop.Enabled = $true
    $itemRestart.Enabled = $true
  } else {
    if ($script:lastOnline -eq $true) {
      $tray.ShowBalloonTip(5000, 'AICompany 离线', '看板无响应，可能是被停止或崩溃次数达上限。右键可启动。', 'Warning')
    }
    $tray.Icon = New-DotIcon ([System.Drawing.Color]::FromArgb(203, 36, 49))
    $tray.Text = 'AICompany 已停止 · 右键启动'
    $itemStart.Enabled = $true
    $itemStop.Enabled = $false
    $itemRestart.Enabled = $false
  }
  $script:lastOnline = $online
}

Update-State
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(3, $IntervalSec) * 1000
$timer.add_Tick({ Update-State })
$timer.Start()

[System.Windows.Forms.Application]::Run()
