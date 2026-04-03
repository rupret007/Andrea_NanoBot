$ErrorActionPreference = 'Stop'

$hostScript = Join-Path $PSScriptRoot 'nanoclaw-host.ps1'
if (!(Test-Path -LiteralPath $hostScript)) {
  throw "Missing host script: $hostScript"
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $hostScript stop -InstallMode manual_host_control
exit $LASTEXITCODE
