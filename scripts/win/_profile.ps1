<#
  实例档位解析（install / start / stop / status 四个脚本共用）。
  唯一真相在 config\profiles.json，解析交给 node —— 两边各写一套拼路径逻辑迟早对不上。

  用法：
      . (Join-Path $PSScriptRoot '_profile.ps1')
      $p = Get-ProfileInfo -Root $Root -Name 'prod'
      $p.runDir / $p.logDir / $p.port / $p.taskName / $p.config / $p.db

  说明：node 那边输出的是纯 ASCII（中文转成 \uXXXX），所以这里不用担心中文路径被
  控制台代码页解坏。
#>

function Get-ProfileInfo {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$Name = 'prod'
  )
  $runner = Join-Path $Root 'src\runner.js'
  if (-not (Test-Path $runner)) { throw "找不到 $runner，先确认这是项目根目录。" }
  $raw = & node $runner --profile $Name --print-profile 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($raw -join ''))) {
    throw "解析实例档位失败：$Name。先确认 node 可用、config\profiles.json 存在且档位名正确。"
  }
  return (($raw -join "`n") | ConvertFrom-Json)
}
