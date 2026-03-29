$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot 'nanoclaw.pid'
$gatewayStopScript = Join-Path $projectRoot 'scripts\stop-openai-gateway.ps1'

function Write-Step {
  param([string] $Message)
  Write-Output "SERVICES_STOP: $Message"
}

function Read-Pid {
  param([string] $Path)
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  try {
    $raw = (Get-Content -LiteralPath $Path -ErrorAction Stop | Select-Object -First 1).Trim()
    if ($raw -match '^[0-9]+$') { return [int]$raw }
  } catch {
    return $null
  }
  return $null
}

function Stop-Pid {
  param([int] $ProcessId)
  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    return $false
  }
}

function Stop-OrphanedNanoclawProcesses {
  param([string] $Root)
  $stopped = 0
  $projectPattern = [Regex]::Escape($Root)
  $orphaned = @()
  try {
    $orphaned = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $cmd = [string]$_.CommandLine
      $cmd -match $projectPattern -and $cmd -match 'dist[\\/]index\.js'
    }
  } catch {
    return 0
  }

  foreach ($proc in $orphaned) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      $stopped++
    } catch {
      # continue stopping others
    }
  }
  return $stopped
}

Write-Step "projectRoot=$projectRoot"

if (Get-Command schtasks.exe -ErrorAction SilentlyContinue) {
  try {
    & schtasks.exe /End /TN 'NanoClaw' *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Step 'ended scheduled task NanoClaw'
    }
  } catch {
    # task may not exist
  }
}

$runtimePid = Read-Pid -Path $pidFile
$pidStopped = $false
if ($runtimePid) {
  $pidStopped = Stop-Pid -ProcessId $runtimePid
  Write-Step "pidFile stop attempted pid=$runtimePid stopped=$pidStopped"
}

$orphanedStopped = Stop-OrphanedNanoclawProcesses -Root $projectRoot
Write-Step "orphaned process cleanup stopped=$orphanedStopped"

if (Test-Path -LiteralPath $pidFile) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $gatewayStopScript) {
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $gatewayStopScript
    if ($LASTEXITCODE -ne 0) {
      Write-Step 'gateway stop returned non-zero'
    }
  } catch {
    Write-Step "gateway stop warning: $($_.Exception.Message)"
  }
}

Write-Step 'complete'
