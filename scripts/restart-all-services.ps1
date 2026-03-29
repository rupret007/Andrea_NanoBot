$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$stopScript = Join-Path $projectRoot 'scripts\stop-all-services.ps1'
$startScript = Join-Path $projectRoot 'scripts\start-all-services.ps1'

if (!(Test-Path -LiteralPath $stopScript)) {
  throw "Missing stop script: $stopScript"
}
if (!(Test-Path -LiteralPath $startScript)) {
  throw "Missing start script: $startScript"
}

Write-Output 'SERVICES_RESTART: stopping all services'
& $stopScript

Start-Sleep -Milliseconds 700

Write-Output 'SERVICES_RESTART: starting all services'
& $startScript

Write-Output 'SERVICES_RESTART: complete'
