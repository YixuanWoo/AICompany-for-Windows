<#
  键鼠助手：给 gui-template adapter 当 commands.* 的落点。
  八个动作，对应 adapter 的驱动方法：

    activate        激活并前置窗口（-WindowTitle 支持部分匹配；会顺手记住之前的窗口，供 restorefocus 还原）
    hotkey          发组合键（-Keys "ctrl+n"）
    setclip         从 UTF-8 文件读文本进剪贴板（-TextFile 路径）
    getclip         把当前剪贴板文本写到 -OutputFile（发提示词前先存一份，发完还回去）
    preflight       一次给齐三件事：idle=秒;session=locked|unlocked;clip=字数（顺带把剪贴板存到 -OutputFile）
    paste           发 Ctrl+V
    press           发单键（-Key "enter"）
    foreground      打印当前前台窗口标题（只读）
    restorefocus    把焦点还给 activate 之前那个窗口（操控完立刻把电脑还给你）
    idle            打印键鼠静置了多少秒（只读，用来判断你正在不在用电脑）
    session         打印 locked / unlocked（只读，锁屏时不要瞎按键）
    shot            全屏截图到 -OutputFile
    info            打印屏幕尺寸 + 目标窗口矩形，配坐标点击时用来算点位（只读）
    click           鼠标左键点击：-X/-Y 绝对坐标，或 -RelX/-RelY 相对窗口左上角

  为什么文本走文件而不走命令行：提示词是几百字带换行的中文，
  塞进命令行会被引号、换行、长度三重坑死。文件最稳。

  中文一律走「剪贴板 + 粘贴」，绝不用 SendKeys 逐字打 ——
  SendKeys 送中文会变成乱码或直接丢字。

  用法示例：
    powershell -ExecutionPolicy Bypass -File scripts\win\kb.ps1 -Action foreground
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('activate', 'find', 'hotkey', 'setclip', 'getclip', 'preflight', 'paste', 'press', 'foreground', 'restorefocus', 'idle', 'session', 'shot', 'info', 'click')]
  [string]$Action,

  [string]$WindowTitle = '',
  [string]$Keys = '',
  [string]$Key = '',
  [string]$TextFile = '',
  [string]$OutputFile = '',
  [int]$X = -1,
  [int]$Y = -1,
  [int]$RelX = -1,
  [int]$RelY = -1
)

$ErrorActionPreference = 'Stop'

# 输出编码必须钉成 UTF-8：Node 通过管道读本脚本的 stdout，默认按控制台代码页(GBK)
# 输出、被当成 UTF-8 解码后，中文窗口标题会变成乱码，contains 匹配永远失败。
# （真实接入时踩过：窗口明明激活了，控制面却报「前台窗口不是目标窗口」。）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# activate 记下「抢焦点前你在哪个窗口」，restorefocus 读它还原。
# 放 TEMP 里而不是项目目录：这是每次运行都会被覆盖的临时状态，不是数据。
$PrevFocusFile = Join-Path $env:TEMP 'aicompany-prevfocus.txt'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinKb {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  // 真实键盘按键都带扫描码。keybd_event 传 bScan=0 时，Chromium / Electron 系应用
  // 拿到的 keydown 可能 Mapping 不出来（DomCode 为空），菜单快捷键（如 Ctrl+N）就
  // 当没按过——而粘贴、回车这类走输入框的反而正常。所以一律用 MapVirtualKey 补上扫描码。
  [DllImport("user32.dll")]
  public static extern uint MapVirtualKey(uint uCode, uint uMapType);

  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT p);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

  public static void ClickAt(int x, int y) {
    POINT old;
    GetCursorPos(out old);
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);   // LEFTDOWN
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);   // LEFTUP
    System.Threading.Thread.Sleep(80);
    // 点完把鼠标放回去，少一点打扰
    SetCursorPos(old.X, old.Y);
  }

  public static string TitleOf(IntPtr hWnd) {
    int len = GetWindowTextLength(hWnd);
    if (len == 0) return "";
    var sb = new StringBuilder(len + 2);
    GetWindowText(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  // 按「包含该子串」找窗口；优先可见窗口。
  public static IntPtr Find(string part) {
    IntPtr found = IntPtr.Zero;
    string lower = part.ToLowerInvariant();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      string t = TitleOf(hWnd);
      if (t.Length == 0) return true;
      if (t.ToLowerInvariant().Contains(lower)) { found = hWnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // 直接 SetForegroundWindow 常被 Windows 的前台锁定挡住；
  // 把自己的线程挂到当前前台线程上再调，成功率明显高。
  public static bool ForceForeground(IntPtr hWnd) {
    ShowWindow(hWnd, 9);          // SW_RESTORE：最小化也能拉回来
    BringWindowToTop(hWnd);
    IntPtr fg = GetForegroundWindow();
    uint fgPid;                   // 不能写 out uint _：PS 5.1 的 C# 编译器是旧版，不认丢弃符
    uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
    uint myThread = GetCurrentThreadId();
    if (fgThread != myThread) AttachThreadInput(myThread, fgThread, true);
    bool ok = SetForegroundWindow(hWnd);
    if (fgThread != myThread) AttachThreadInput(myThread, fgThread, false);
    return ok;
  }

  public static void KeyDown(byte vk) { keybd_event(vk, (byte)MapVirtualKey(vk, 0), 0, UIntPtr.Zero); }
  public static void KeyUp(byte vk) { keybd_event(vk, (byte)MapVirtualKey(vk, 0), 2, UIntPtr.Zero); }

  public static string RectOf(IntPtr hWnd) {
    RECT r;
    if (!GetWindowRect(hWnd, out r)) return "";
    return string.Format("{0},{1},{2},{3}", r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
  }

  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);

  // ---- 空闲时长 / 锁屏判定：决定「现在该不该抢键鼠」 ----
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr hDesktop);

  public static int IdleSeconds() {
    LASTINPUTINFO lii = new LASTINPUTINFO();
    lii.cbSize = (uint)Marshal.SizeOf(lii);
    if (!GetLastInputInfo(ref lii)) return -1;
    uint now = unchecked((uint)Environment.TickCount);
    uint idleMs = unchecked(now - lii.dwTime);
    return (int)(idleMs / 1000);
  }

  // 桌面被锁（Win+L / 屏保）时打不开输入桌面；这时按键会落到登录界面或别的窗口。
  public static bool IsLocked() {
    IntPtr d = OpenInputDesktop(0, false, 0x0100); // DESKTOP_READOBJECTS
    if (d == IntPtr.Zero) return true;
    CloseDesktop(d);
    return false;
  }
}
"@

# 坐标口径必须跟截图一致：截图是物理像素，SetCursorPos 也按物理像素算。
# 不做这一步，缩放 125%/150% 的机器上点击会整体偏掉。
try { [WinKb]::SetProcessDPIAware() | Out-Null } catch { }

# 只认常用键：够配 Ctrl+N / Ctrl+V / Enter / Tab / Esc 这些流程，
# 不做全键盘映射 —— 少写一行就少一个出错点。
function Get-Vk {
  param([string]$Name)
  $n = $Name.Trim().ToLowerInvariant()
  switch ($n) {
    'ctrl' { return 0x11 }
    'control' { return 0x11 }
    'shift' { return 0x10 }
    'alt' { return 0x12 }
    'win' { return 0x5B }
    'enter' { return 0x0D }
    'return' { return 0x0D }
    'tab' { return 0x09 }
    'esc' { return 0x1B }
    'escape' { return 0x1B }
    'space' { return 0x20 }
    'backspace' { return 0x08 }
    'up' { return 0x26 }
    'down' { return 0x28 }
    'left' { return 0x25 }
    'right' { return 0x27 }
    default {
      if ($n.Length -eq 1) {
        $code = [int][char]$n.ToUpperInvariant()
        if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) { return $code }
      }
      throw "不认识的按键：$Name（只支持 ctrl/shift/alt/enter/tab/esc/space/方向键/单字母数字）"
    }
  }
}

function Send-Combo {
  param([string]$Spec)
  $parts = $Spec -split '\+'
  if ($parts.Count -eq 0) { throw '组合键为空' }
  $codes = @()
  foreach ($p in $parts) { if ($p.Trim()) { $codes += (Get-Vk $p) } }
  if ($codes.Count -eq 0) { throw "组合键解析后为空：$Spec" }
  foreach ($c in $codes) { [WinKb]::KeyDown([byte]$c); Start-Sleep -Milliseconds 40 }
  Start-Sleep -Milliseconds 60
  # 逆序弹起，和真实按键一致
  for ($i = $codes.Count - 1; $i -ge 0; $i--) { [WinKb]::KeyUp([byte]$codes[$i]); Start-Sleep -Milliseconds 30 }
}

switch ($Action) {
  'foreground' {
    $h = [WinKb]::GetForegroundWindow()
    Write-Output ([WinKb]::TitleOf($h))
  }

  'find' {
    # 只找不激活：用于配 windowTitle 时确认匹配串对不对，不会抢你的焦点。
    if ([string]::IsNullOrWhiteSpace($WindowTitle)) { throw 'find 需要 -WindowTitle' }
    $h = [WinKb]::Find($WindowTitle)
    if ($h -eq [IntPtr]::Zero) { throw "找不到标题含「$WindowTitle」的可见窗口" }
    Write-Output ([WinKb]::TitleOf($h))
  }

  'activate' {
    if ([string]::IsNullOrWhiteSpace($WindowTitle)) { throw 'activate 需要 -WindowTitle' }
    $h = [WinKb]::Find($WindowTitle)
    if ($h -eq [IntPtr]::Zero) { throw "找不到标题含「$WindowTitle」的可见窗口" }
    # 记下「抢之前你在哪个窗口」，restorefocus 用它把焦点还给你。
    $prev = [WinKb]::GetForegroundWindow()
    if ($prev -ne [IntPtr]::Zero -and $prev -ne $h) {
      [System.IO.File]::WriteAllText($PrevFocusFile, [string]$prev.ToInt64(), (New-Object System.Text.UTF8Encoding $false))
    }
    # Windows 的前台锁：不是前台进程时 SetForegroundWindow 会被静默拒绝。
    # 破解办法是「先轻敲一下 Alt」拿到前台权限再 set —— 这是系统行为，不是运气。
    # 三次尝试，每次都核对标题；还是不行就明确报错（上层会当成「稍后再试」而不是失败）。
    $fg = ''
    for ($try = 1; $try -le 3; $try++) {
      [void][WinKb]::ForceForeground($h)
      Start-Sleep -Milliseconds 180
      $fg = [WinKb]::TitleOf([WinKb]::GetForegroundWindow())
      if ($fg -like "*$WindowTitle*") { break }
      if ($try -lt 3) {
        [WinKb]::KeyDown(0x12)   # Alt
        Start-Sleep -Milliseconds 25
        [WinKb]::KeyUp(0x12)
        Start-Sleep -Milliseconds 120
      }
    }
    if ($fg -notlike "*$WindowTitle*") {
      throw "激活后前台窗口是「$fg」，不是目标「$WindowTitle」（可能被弹窗遮挡或前台锁占用，稍后重试）"
    }
    Write-Output "activated: $fg"
  }

  'restorefocus' {
    # 把焦点还给 activate 之前那个窗口。没有记录、窗口已关、或本来就没换过，就直说不做。
    if (-not (Test-Path $PrevFocusFile)) { Write-Output 'no-prev'; break }
    $raw = ''
    try { $raw = ([System.IO.File]::ReadAllText($PrevFocusFile)).Trim() } catch { $raw = '' }
    $num = [int64]0
    if (-not [int64]::TryParse($raw, [ref]$num)) { Write-Output 'no-prev'; break }
    if ($num -eq 0) { Write-Output 'no-prev'; break }
    $h = [IntPtr]$num
    if (-not [WinKb]::IsWindow($h)) { Write-Output 'gone'; break }
    $want = [WinKb]::TitleOf($h)
    # 和 activate 同样的前台锁问题：还原也可能被系统挡住，试三次 + 轻敲 Alt 解锁。
    $fg = ''
    for ($try = 1; $try -le 3; $try++) {
      [void][WinKb]::ForceForeground($h)
      Start-Sleep -Milliseconds 160
      $fg = [WinKb]::TitleOf([WinKb]::GetForegroundWindow())
      if ($fg -eq $want -and $fg -ne '') { break }
      if ($try -lt 3) {
        [WinKb]::KeyDown(0x12)
        Start-Sleep -Milliseconds 25
        [WinKb]::KeyUp(0x12)
        Start-Sleep -Milliseconds 110
      }
    }
    if ($fg -eq $want -and $fg -ne '') { Write-Output ("restored: " + $fg) }
    else { Write-Output ("restore-failed: 想还「$want」，当前是「$fg」") }
  }

  'getclip' {
    if ([string]::IsNullOrWhiteSpace($OutputFile)) { throw 'getclip 需要 -OutputFile' }
    $text = ''
    try { $text = Get-Clipboard -Raw -ErrorAction Stop } catch { $text = '' }
    if ($null -eq $text) { $text = '' }
    $dir = Split-Path $OutputFile -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($OutputFile, [string]$text, (New-Object System.Text.UTF8Encoding $false))
    Write-Output ("clipboard-chars: " + ([string]$text).Length)
  }

  'preflight' {
    # 一次调用给齐三件事，省两次 PowerShell 启动（每次约 0.8 秒）。
    $idleSec = [WinKb]::IdleSeconds()
    $sess = if ([WinKb]::IsLocked()) { 'locked' } else { 'unlocked' }
    $chars = -1
    if (-not [string]::IsNullOrWhiteSpace($OutputFile)) {
      $text = ''
      try { $text = Get-Clipboard -Raw -ErrorAction Stop } catch { $text = '' }
      if ($null -eq $text) { $text = '' }
      $dir = Split-Path $OutputFile -Parent
      if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
      [System.IO.File]::WriteAllText($OutputFile, [string]$text, (New-Object System.Text.UTF8Encoding $false))
      $chars = ([string]$text).Length
    }
    Write-Output ("idle={0};session={1};clip={2}" -f $idleSec, $sess, $chars)
  }

  'idle' {
    Write-Output ([WinKb]::IdleSeconds())
  }

  'session' {
    if ([WinKb]::IsLocked()) { Write-Output 'locked' } else { Write-Output 'unlocked' }
  }

  'hotkey' {
    if ([string]::IsNullOrWhiteSpace($Keys)) { throw 'hotkey 需要 -Keys' }
    Send-Combo -Spec $Keys
    Write-Output "hotkey: $Keys"
  }

  'setclip' {
    if ([string]::IsNullOrWhiteSpace($TextFile)) { throw 'setclip 需要 -TextFile' }
    if (-not (Test-Path $TextFile)) { throw "文本文件不存在：$TextFile" }
    $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
    Set-Clipboard -Value $text
    Write-Output "clipboard: $($text.Length) 字符"
  }

  'paste' {
    Send-Combo -Spec 'ctrl+v'
    Write-Output 'pasted'
  }

  'press' {
    if ([string]::IsNullOrWhiteSpace($Key)) { throw 'press 需要 -Key' }
    $vk = Get-Vk $Key
    [WinKb]::KeyDown([byte]$vk)
    Start-Sleep -Milliseconds 50
    [WinKb]::KeyUp([byte]$vk)
    Write-Output "press: $Key"
  }

  'shot' {
    if ([string]::IsNullOrWhiteSpace($OutputFile)) { throw 'shot 需要 -OutputFile' }
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $dir = Split-Path $OutputFile -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($OutputFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output $OutputFile
  }

  'info' {
    # 只读：屏幕尺寸 + 目标窗口标题与矩形（left,top,w,h）。配坐标点击时拿它算点位。
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    Write-Output ("screen: {0}x{1}" -f $b.Width, $b.Height)
    $h = if ([string]::IsNullOrWhiteSpace($WindowTitle)) { [WinKb]::GetForegroundWindow() } else { [WinKb]::Find($WindowTitle) }
    if ($h -eq [IntPtr]::Zero) { throw "找不到标题含「$WindowTitle」的可见窗口" }
    Write-Output ("title: " + [WinKb]::TitleOf($h))
    Write-Output ("rect: " + [WinKb]::RectOf($h))
  }

  'click' {
    # 两种给法：-X/-Y 绝对坐标；-RelX/-RelY 相对窗口左上角（窗口移动也能点准）。
    $px = $X; $py = $Y
    if ($RelX -ge 0 -and $RelY -ge 0) {
      if ([string]::IsNullOrWhiteSpace($WindowTitle)) { throw 'click 用 -RelX/-RelY 时必须给 -WindowTitle' }
      $h = [WinKb]::Find($WindowTitle)
      if ($h -eq [IntPtr]::Zero) { throw "找不到标题含「$WindowTitle」的可见窗口" }
      $r = [WinKb]::RectOf($h) -split ','
      $px = [int]$r[0] + $RelX
      $py = [int]$r[1] + $RelY
    }
    if ($px -lt 0 -or $py -lt 0) { throw 'click 需要 -X/-Y（绝对坐标）或 -RelX/-RelY（相对窗口）' }
    [WinKb]::ClickAt($px, $py)
    Write-Output "click: $px,$py"
  }
}
