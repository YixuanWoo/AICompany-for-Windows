<#
  窗口探测：把当前所有可见窗口列出来，标出「像 agent 工作台」的候选。
  用途：配 gui-template 时 windowTitle 必须是确切字符串，不能猜。

  用法：powershell -ExecutionPolicy Bypass -File scripts\win\probe-window.ps1
        powershell ... -File scripts\win\probe-window.ps1 -Keyword 豆包

  注意：本脚本只读（EnumWindows + GetWindowText），不激活、不点、不按键，
        不会打扰你正在用的任何窗口。
#>
param(
  [string]$Keyword = '',
  [switch]$All
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WinProbe {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  private static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  public class Info {
    public long Handle;
    public string Title;
    public uint Pid;
    public int Width;
    public int Height;
    public int Left;
    public int Top;
  }

  public static List<Info> List() {
    var result = new List<Info>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      int len = GetWindowTextLength(hWnd);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 2);
      GetWindowText(hWnd, sb, sb.Capacity);
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      RECT r;
      GetWindowRect(hWnd, out r);
      result.Add(new Info {
        Handle = hWnd.ToInt64(),
        Title = sb.ToString(),
        Pid = pid,
        Width = r.Right - r.Left,
        Height = r.Bottom - r.Top,
        Left = r.Left,
        Top = r.Top
      });
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@

$screen = $null
try {
  Add-Type -AssemblyName System.Windows.Forms
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen
} catch {
  throw "加载 System.Windows.Forms 失败：$($_.Exception.Message)"
}
$sw = $screen.Bounds.Width
$sh = $screen.Bounds.Height

$rows = @()
foreach ($w in [WinProbe]::List()) {
  $proc = Get-Process -Id $w.Pid -ErrorAction SilentlyContinue
  $procName = if ($proc) { $proc.ProcessName } else { '?' }
  $exePath = ''
  try { $exePath = (Get-CimInstance Win32_Process -Filter "ProcessId = $($w.Pid)" -ErrorAction SilentlyContinue).ExecutablePath } catch { }

  # 全屏判定：宽高接近屏幕尺寸（允许 2px 误差）
  $fullscreen = ($w.Width -ge ($sw - 2)) -and ($w.Height -ge ($sh - 2))

  $rows += [pscustomobject]@{
    进程     = $procName
    PID      = $w.Pid
    窗口标题 = $w.Title
    尺寸     = "$($w.Width)x$($w.Height)"
    全屏     = if ($fullscreen) { '是' } else { '' }
    位置     = "$($w.Left),$($w.Top)"
    路径     = $exePath
  }
}

$shown = $rows
if (-not $All) {
  $filter = $Keyword
  if ([string]::IsNullOrWhiteSpace($filter)) {
    # 默认只看「像 agent / 浏览器 / 终端」的窗口，避免把系统窗口全刷出来
    $filter = '豆包|doubao|chat|hermes|agent|term|code|work|浏览器|edge|chrome'
  }
  $shown = $rows | Where-Object { $_.窗口标题 -match $filter -or $_.进程 -match $filter }
}

Write-Output "屏幕：$sw x $sh；可见窗口共 $($rows.Count) 个"
Write-Output ''
if (-not $shown -or $shown.Count -eq 0) {
  Write-Output "没有匹配「$filter」的窗口。"
  Write-Output '把豆包工作打开、切成你要操作的那个状态，再跑一次；或用 -All 看全部。'
  exit 0
}

# 逐行输出，不用 Format-Table：中文标题一长就被挤成两行，反而看不清。
foreach ($r in $shown) {
  $flag = if ($r.全屏 -eq '是') { ' [全屏]' } else { '' }
  Write-Output ("  {0,-16} pid={1,-7} {2}{3}" -f $r.进程, $r.PID, $r.窗口标题, $flag)
  Write-Output ("  {0,-16} {1}  位置 {2}" -f '', $r.尺寸, $r.位置)
}

Write-Output ''
Write-Output '=== 复制下面这段到 company.yaml（把 windowTitle 换成你要接的那一行）==='
# 优先挑名字里带「豆包 / doubao」的那个 —— 全屏窗口不止一个，第一个全屏未必是目标。
$pick = $shown | Where-Object { $_.窗口标题 -match '豆包|doubao' -or $_.进程 -match 'doubao' } | Select-Object -First 1
if (-not $pick) { $pick = $shown | Where-Object { $_.全屏 -eq '是' } | Select-Object -First 1 }
if (-not $pick) { $pick = $shown | Select-Object -First 1 }
$title = $pick.窗口标题 -replace '"', '\"'
Write-Output @"
  - id: doubao
    displayName: 豆包工作
    capabilities: [execute]
    adapter:
      type: gui-template
      config:
        windowTitle: "$title"
        driver: command
        commands:
          activate: 'powershell -ExecutionPolicy Bypass -File scripts/win/kb.ps1 -Action activate -WindowTitle "{{windowTitle}}"'
          hotkey: 'powershell -ExecutionPolicy Bypass -File scripts/win/kb.ps1 -Action hotkey -Keys "{{keys}}"'
          setClipboard: 'powershell -ExecutionPolicy Bypass -File scripts/win/kb.ps1 -Action setclip -TextFile "{{textFile}}"'
          paste: 'powershell -ExecutionPolicy Bypass -File scripts/win/kb.ps1 -Action paste'
          press: 'powershell -ExecutionPolicy Bypass -File scripts/win/kb.ps1 -Action press -Key "{{key}}"'
          foregroundTitle: 'powershell -ExecutionPolicy Bypass -File scripts/win/kb.ps1 -Action foreground'
          screenshot: 'powershell -ExecutionPolicy Bypass -File scripts/win/kb.ps1 -Action shot -OutputFile "{{outputFile}}"'
        pollIntervalMs: 5000
        maxMinutes: 30
"@
