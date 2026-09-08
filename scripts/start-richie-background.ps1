param(
  [switch]$Restart,
  [switch]$SkipSync
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

$Existing = @(
  Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*$Entry*" }
)

if ($Existing.Count -gt 0 -and -not $Restart) {
  Write-Host "richie bot is already running. pid=$($Existing[0].ProcessId)"
  Write-Host "Use -Restart to deploy and restart without creating a duplicate process."
  exit 0
}

if (-not $SkipSync) {
  $GitStatus = & git -C $ProjectRoot status --porcelain
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect dispatcher git status."
  }
  if ($GitStatus) {
    throw "Dispatcher working tree is dirty; refusing to pull and launch an ambiguous version."
  }

  $Before = (& git -C $ProjectRoot rev-parse HEAD).Trim()
  & git -C $ProjectRoot pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    throw "Dispatcher git pull failed; existing process was left running."
  }
  $After = (& git -C $ProjectRoot rev-parse HEAD).Trim()
  if ($Before -ne $After -or -not (Test-Path (Join-Path $ProjectRoot "node_modules"))) {
    & npm --prefix $ProjectRoot ci
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed; existing process was left running."
    }
  }
}

if ($Restart) {
  $Existing | ForEach-Object {
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
