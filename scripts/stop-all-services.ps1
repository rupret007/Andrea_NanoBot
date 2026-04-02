$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$hostScript = Join-Path $projectRoot 'scripts\nanoclaw-host.ps1'

if (!(Test-Path -LiteralPath $hostScript)) {
  throw "Missing host control script: $hostScript"
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $hostScript stop
exit $LASTEXITCODE
