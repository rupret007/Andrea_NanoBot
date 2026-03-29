$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$entryPath = Join-Path $projectRoot 'dist\index.js'
$pidFile = Join-Path $projectRoot 'nanoclaw.pid'
$logDir = Join-Path $projectRoot 'logs'
$logPath = Join-Path $logDir 'nanoclaw.log'
$errLogPath = Join-Path $logDir 'nanoclaw.error.log'
$gatewayStartScript = Join-Path $projectRoot 'scripts\start-openai-gateway.ps1'

function Write-Step {
  param([string] $Message)
  Write-Output "SERVICES_START: $Message"
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

function Is-NanoClawProcessRunning {
  param(
    [int] $ProcessId,
    [string] $Root
  )

  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return $false }
    $cmd = [string]$proc.CommandLine
    $projectPattern = [Regex]::Escape($Root)
    if ($cmd -match $projectPattern -and $cmd -match 'dist[\\/]index\.js') {
      return $true
    }
  } catch {
    return $false
  }
  return $false
}

function Ensure-BuildArtifacts {
  param([string] $Root)
  if (Test-Path -LiteralPath $entryPath) { return }

  Write-Step 'dist/index.js missing, running TypeScript build'
  Push-Location $Root
  try {
    $useNode22Npx = $false
    try {
      $version = (& node --version 2>$null).Trim()
      if ($version -notmatch '^v22\.') {
        $useNode22Npx = $true
      }
    } catch {
      $useNode22Npx = $true
    }

    if ($useNode22Npx) {
      Write-Step 'node v22 not found on PATH, using npx node@22 build fallback'
      & 'npx.cmd' -y -p node@22 node .\node_modules\typescript\bin\tsc | Out-Host
    } else {
      & 'C:\Program Files\nodejs\npm.cmd' run build | Out-Host
    }

    if ($LASTEXITCODE -ne 0) {
      throw 'build failed'
    }
  } finally {
    Pop-Location
  }
}

function Start-Gateway {
  param([string] $ScriptPath)
  if (!(Test-Path -LiteralPath $ScriptPath)) {
    Write-Step 'gateway start script missing, skipping'
    return
  }

  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath
    if ($LASTEXITCODE -ne 0) {
      Write-Step 'gateway start returned non-zero, continuing'
    }
  } catch {
    Write-Step "gateway start warning: $($_.Exception.Message)"
  }
}

function Start-NanoClawFallback {
  param([string] $Root)

  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  Set-Location -LiteralPath $Root

  function Resolve-NodeExecutable {
    # Prefer an already-installed Node 22 on PATH
    try {
      $pathNode = Get-Command node -ErrorAction SilentlyContinue
      if ($pathNode) {
        $version = (& $pathNode.Source --version 2>$null).Trim()
        if ($version -match '^v22\.') {
          return $pathNode.Source
        }
      }
    } catch {
      # continue to fallback resolution
    }

    # Resolve a temporary Node 22 runtime path without keeping npx as the parent process.
    try {
      $resolved = (& 'npx.cmd' -y -p node@22 node -p "process.execPath" 2>$null | Select-Object -Last 1).Trim()
      if ($resolved -and (Test-Path -LiteralPath $resolved)) {
        return $resolved
      }
    } catch {
      # continue to final fallback
    }

    return $null
  }

  $nodeExe = Resolve-NodeExecutable
  if ($nodeExe) {
    $proc = Start-Process -FilePath $nodeExe -ArgumentList @($entryPath) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errLogPath -PassThru
  } else {
    # Last-resort fallback: long-running npx launcher.
    $proc = Start-Process -FilePath 'npx.cmd' -ArgumentList @('-y', '-p', 'node@22', 'node', $entryPath) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errLogPath -PassThru
  }

  Set-Content -LiteralPath $pidFile -Value $proc.Id -NoNewline
  return $proc.Id
}

Write-Step "projectRoot=$projectRoot"
Ensure-BuildArtifacts -Root $projectRoot
Start-Gateway -ScriptPath $gatewayStartScript

$existingPid = Read-Pid -Path $pidFile
if ($existingPid -and (Is-NanoClawProcessRunning -ProcessId $existingPid -Root $projectRoot)) {
  Write-Step "nanoclaw already running pid=$existingPid"
  exit 0
}

Write-Step 'launching NanoClaw via direct startup launcher'
$startedPid = Start-NanoClawFallback -Root $projectRoot
Write-Step "launcher pid=$startedPid"

Start-Sleep -Milliseconds 600
$newPid = Read-Pid -Path $pidFile
if ($newPid -and (Is-NanoClawProcessRunning -ProcessId $newPid -Root $projectRoot)) {
  Write-Step "nanoclaw running pid=$newPid"
  exit 0
}

throw 'NanoClaw did not reach running state after launch'
