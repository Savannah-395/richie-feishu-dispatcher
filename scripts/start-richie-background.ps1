param(
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $ProjectRoot "logs"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Stdout = Join-Path $LogDir "richie.$Stamp.stdout.log"
$Stderr = Join-Path $LogDir "richie.$Stamp.stderr.log"
$Entry = Join-Path $ProjectRoot "src\index.js"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

try {
  chcp.com 65001 | Out-Null
} catch {
  Write-Warning "Failed to set console code page to UTF-8: $($_.Exception.Message)"
}

$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

if ($Restart) {
  Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*$Entry*" } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force
    }
}

$Node = (Get-Command node).Source
$Process = Start-Process `
  -FilePath $Node `
  -ArgumentList @("`"$Entry`"") `
  -WorkingDirectory $ProjectRoot `
  -RedirectStandardOutput $Stdout `
  -RedirectStandardError $Stderr `
  -WindowStyle Hidden `
  -PassThru

Write-Host "richie bot started. pid=$($Process.Id)"
Write-Host "stdout=$Stdout"
Write-Host "stderr=$Stderr"
