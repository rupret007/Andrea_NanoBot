param(
  [Parameter()]
  [int] $IntervalSeconds = 120
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'data\runtime'
$statePath = Join-Path $runtimeDir 'nanoclaw-watchdog-state.json'
$hostScriptPath = Join-Path $projectRoot 'scripts\nanoclaw-host.ps1'

function Ensure-WatchdogDirectories {
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
}

function Write-WatchdogState {
  param(
    [string] $Status,
    [string] $Detail = ''
  )

  Ensure-WatchdogDirectories
  $payload = [pscustomobject]@{
    pid = $PID
    status = $Status
    detail = $Detail
    intervalSeconds = $IntervalSeconds
    updatedAt = [DateTime]::UtcNow.ToString('o')
  }
  $json = $payload | ConvertTo-Json -Depth 4
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($statePath, $json, $utf8NoBom)
}

Ensure-WatchdogDirectories
Write-WatchdogState -Status 'running' -Detail 'NanoClaw watchdog started.'

while ($true) {
  try {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $hostScriptPath ensure 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
      throw ("Host ensure exited with code {0}. {1}" -f $LASTEXITCODE, $output.Trim())
    }
    Write-WatchdogState -Status 'running' -Detail ($output.Trim())
  } catch {
    Write-WatchdogState -Status 'degraded' -Detail $_.Exception.Message
  }

  Start-Sleep -Seconds $IntervalSeconds
}
