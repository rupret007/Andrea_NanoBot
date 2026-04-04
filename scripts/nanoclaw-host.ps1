param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string] $Command = 'status',

  [Parameter()]
  [ValidateSet('manual_host_control', 'scheduled_task', 'startup_folder')]
  [string] $InstallMode = 'manual_host_control'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $projectRoot 'logs'
$runtimeDir = Join-Path $projectRoot 'data\runtime'
$pidFile = Join-Path $projectRoot 'nanoclaw.pid'
$entryPath = Join-Path $projectRoot 'dist\index.js'
$hostLogPath = Join-Path $logsDir 'nanoclaw.host.log'
$stdoutLogPath = Join-Path $logsDir 'nanoclaw.log'
$stderrLogPath = Join-Path $logsDir 'nanoclaw.error.log'
$hostStatePath = Join-Path $runtimeDir 'nanoclaw-host-state.json'
$readyStatePath = Join-Path $runtimeDir 'nanoclaw-ready.json'
$lockPath = Join-Path $runtimeDir 'nanoclaw-host.lock'
$nodeRuntimeMetadataPath = Join-Path $runtimeDir 'node-runtime.json'
$gatewayStatePath = Join-Path $runtimeDir 'openai-gateway-state.json'
$gatewayStartScript = Join-Path $projectRoot 'scripts\start-openai-gateway.ps1'
$gatewayStopScript = Join-Path $projectRoot 'scripts\stop-openai-gateway.ps1'
$pinnedNodeLauncher = Join-Path $projectRoot 'scripts\run-with-pinned-node.mjs'
$compatibilityShimPath = Join-Path $projectRoot 'start-nanoclaw.ps1'
$startupFolderScriptPath = if ($env:APPDATA) {
  Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\nanoclaw-start.cmd'
} else {
  $null
}

function Ensure-HostDirectories {
  New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
}

function Write-HostStep {
  param([string] $Message)

  Ensure-HostDirectories
  $line = "[{0}] HOST: {1}" -f ([DateTime]::UtcNow.ToString('o')), $Message
  Add-Content -LiteralPath $hostLogPath -Value $line
  Write-Output $line
}

function Read-JsonFile {
  param([string] $Path)

  if (!(Test-Path -LiteralPath $Path)) { return $null }
  try {
    return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
}

function Write-JsonFile {
  param(
    [string] $Path,
    [object] $Value
  )

  Ensure-HostDirectories
  $json = $Value | ConvertTo-Json -Depth 8
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Get-CanonicalCompatibilityShimContent {
  return @(
    '$ErrorActionPreference = ''Stop'''
    '$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path'
    '$hostScriptPath = Join-Path $projectRoot ''scripts\nanoclaw-host.ps1'''
    '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $hostScriptPath start'
    'exit $LASTEXITCODE'
  ) -join "`n"
}

function Get-CanonicalStartupFolderScriptContent {
  return @(
    '@echo off'
    ('"powershell.exe" "-NoProfile" "-ExecutionPolicy" "Bypass" "-File" "{0}" "start" "-InstallMode" "startup_folder"' -f (Join-Path $projectRoot 'scripts\nanoclaw-host.ps1'))
  ) -join "`r`n"
}

function Repair-StartupArtifacts {
  $compatibilityContent = Get-CanonicalCompatibilityShimContent
  $currentCompatibility = if (Test-Path -LiteralPath $compatibilityShimPath) {
    Get-Content -LiteralPath $compatibilityShimPath -Raw -ErrorAction SilentlyContinue
  } else {
    ''
  }
  if (($currentCompatibility -replace "`r", '').TrimEnd() -ne $compatibilityContent.TrimEnd()) {
    Set-Content -LiteralPath $compatibilityShimPath -Value ($compatibilityContent + "`n")
    Write-HostStep ("Repaired compatibility shim at {0}" -f $compatibilityShimPath)
  }

  if ($startupFolderScriptPath -and (Test-Path -LiteralPath $startupFolderScriptPath)) {
    $canonicalStartup = Get-CanonicalStartupFolderScriptContent
    $currentStartup = Get-Content -LiteralPath $startupFolderScriptPath -Raw -ErrorAction SilentlyContinue
    $isLegacy = [string]$currentStartup -match 'start-nanoclaw\.ps1'
    if ($isLegacy -or ($currentStartup -replace "`r", '').TrimEnd() -ne ($canonicalStartup -replace "`r", '').TrimEnd()) {
      Set-Content -LiteralPath $startupFolderScriptPath -Value ($canonicalStartup + "`r`n")
      Write-HostStep ("Repaired startup-folder script at {0}" -f $startupFolderScriptPath)
    }
  }
}

function Read-Pid {
  if (!(Test-Path -LiteralPath $pidFile)) { return $null }
  try {
    $raw = (Get-Content -LiteralPath $pidFile -ErrorAction Stop | Select-Object -First 1).Trim()
    if ($raw -match '^[0-9]+$') { return [int] $raw }
  } catch {
    return $null
  }
  return $null
}

function Remove-FileIfExists {
  param([string] $Path)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  }
}

function Test-RepoProcess {
  param([int] $ProcessId)

  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return $false }
    $cmd = [string] $proc.CommandLine
    $projectPattern = [Regex]::Escape($projectRoot)
    return $cmd -match $projectPattern -and $cmd -match 'dist[\\/]index\.js'
  } catch {
    return $false
  }
}

function Stop-ProcessIfRunning {
  param([int] $ProcessId)
  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    return $false
  }
}

function Get-HealthyRunningSnapshot {
  $hostState = Read-JsonFile $hostStatePath
  $readyState = Read-JsonFile $readyStatePath
  $runtimePid = Read-Pid

  if ($null -eq $hostState -or $null -eq $readyState -or $null -eq $runtimePid) {
    return $null
  }
  if ([string] $hostState.phase -ne 'running_ready' -and [string] $hostState.phase -ne 'config_failed') {
    return $null
  }
  if (-not (Test-RepoProcess -ProcessId $runtimePid)) {
    return $null
  }
  if ([string] $hostState.bootId -ne [string] $readyState.bootId) {
    return $null
  }
  if ([int] $readyState.pid -ne $runtimePid) {
    return $null
  }

  return [pscustomobject]@{
    hostState = $hostState
    readyState = $readyState
    pid = $runtimePid
  }
}

function Resolve-HostNodeCommand {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    throw 'node.exe was not found on PATH.'
  }
  return $nodeCommand.Source
}

function Resolve-PinnedNodeExecutable {
  $hostNode = Resolve-HostNodeCommand
  $resolved = & $hostNode $pinnedNodeLauncher --print-node-path 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolved)) {
    throw 'Unable to resolve the pinned Node runtime.'
  }
  return ($resolved | Select-Object -Last 1).Trim()
}

function Resolve-PinnedNodeVersion {
  $metadata = Read-JsonFile $nodeRuntimeMetadataPath
  if ($metadata -and $metadata.version) {
    return [string] $metadata.version
  }

  $nodeExe = Resolve-PinnedNodeExecutable
  $version = (& $nodeExe --version 2>$null | Select-Object -Last 1).Trim()
  return $version.TrimStart('v')
}

function Ensure-BuildArtifacts {
  if (Test-Path -LiteralPath $entryPath) { return }

  Write-HostStep 'dist/index.js missing, building with pinned Node runtime'
  $hostNode = Resolve-HostNodeCommand
  & $hostNode $pinnedNodeLauncher .\node_modules\typescript\bin\tsc
  if ($LASTEXITCODE -ne 0) {
    throw 'TypeScript build failed while preparing NanoClaw startup.'
  }
}

function Start-Gateway {
  if (!(Test-Path -LiteralPath $gatewayStartScript)) {
    return [pscustomobject]@{
      status = 'skipped'
      detail = 'OpenAI gateway start script not present.'
    }
  }
  try {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $gatewayStartScript 2>&1
    if ($LASTEXITCODE -ne 0) {
      return [pscustomobject]@{
        status = 'failed'
        detail = (($output | Out-String).Trim())
      }
    }
    return [pscustomobject]@{
      status = 'ok'
      detail = (($output | Out-String).Trim())
    }
  } catch {
    return [pscustomobject]@{
      status = 'failed'
      detail = $_.Exception.Message
    }
  }
}

function Stop-Gateway {
  if (!(Test-Path -LiteralPath $gatewayStopScript)) { return }
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $gatewayStopScript | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-HostStep 'OpenAI gateway stop returned non-zero; continuing'
    }
  } catch {
    Write-HostStep ("OpenAI gateway stop warning: {0}" -f $_.Exception.Message)
  }
}

function Get-LocalGatewayHealthError {
  $gatewayState = Read-JsonFile $gatewayStatePath
  if ($null -eq $gatewayState -or [string]::IsNullOrWhiteSpace([string] $gatewayState.host_health)) {
    return $null
  }

  $lastProbeError = $null
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    try {
      $content = $null
      if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        $content = & curl.exe -fsS --max-time 5 ([string] $gatewayState.host_health) 2>$null
      } else {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ([string] $gatewayState.host_health) -TimeoutSec 5
        if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
          $lastProbeError = "Local gateway health check returned HTTP $($response.StatusCode)."
          throw [System.Exception]::new($lastProbeError)
        }
        $content = $response.Content
      }

      if ([string]::IsNullOrWhiteSpace([string] $content)) {
        $lastProbeError = 'Local gateway health returned an empty response.'
      } else {
        $payload = $content | ConvertFrom-Json -ErrorAction Stop
        $healthyCount = 0
        if ($payload.PSObject.Properties.Name -contains 'healthy_count' -and $payload.healthy_count -is [ValueType]) {
          $healthyCount = [int] $payload.healthy_count
        } elseif ($payload.PSObject.Properties.Name -contains 'healthy_endpoints' -and $payload.healthy_endpoints) {
          $healthyCount = @($payload.healthy_endpoints).Count
        }
        if ($healthyCount -gt 0) {
          return $null
        }

        $firstError = $null
        if ($payload.PSObject.Properties.Name -contains 'unhealthy_endpoints' -and $payload.unhealthy_endpoints) {
          foreach ($entry in @($payload.unhealthy_endpoints)) {
            $candidate = [string] $entry.error
            if (-not [string]::IsNullOrWhiteSpace($candidate)) {
              $firstError = $candidate.Trim()
              break
            }
          }
        }
        if ($firstError) {
          if ($firstError -match 'insufficient_quota') {
            return 'Local gateway is unhealthy: OpenAI key is out of quota/billing.'
          }
          if ($firstError -match 'invalid_api_key|unauthorized|authentication') {
            return 'Local gateway is unhealthy: upstream authentication failed.'
          }
          return ("Local gateway is unhealthy: {0}" -f $firstError)
        }

        $lastProbeError = 'Local gateway is running but has no healthy upstream endpoints.'
      }
    } catch {
      if (-not $lastProbeError) {
        $lastProbeError = ("Local gateway health probe failed: {0}" -f $_.Exception.Message)
      }
    }

    if ($attempt -lt 6) {
      Start-Sleep -Milliseconds 1000
    }
  }

  return $lastProbeError
}

function Stop-OrphanedRepoProcesses {
  $projectPattern = [Regex]::Escape($projectRoot)
  $stopped = 0

  try {
    $nodeProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $cmd = [string] $_.CommandLine
      $cmd -match $projectPattern -and $cmd -match 'dist[\\/]index\.js'
    }
    foreach ($proc in $nodeProcs) {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      $stopped++
    }

    $launcherProcs = Get-CimInstance Win32_Process | Where-Object {
      $cmd = [string] $_.CommandLine
      $cmd -match $projectPattern -and (
        $cmd -match 'nanoclaw-host\.ps1' -or
        $cmd -match 'start-nanoclaw\.ps1' -or
        $cmd -match 'run-with-pinned-node\.mjs'
      )
    }
    foreach ($proc in $launcherProcs) {
      if ($proc.ProcessId -eq $PID) { continue }
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      $stopped++
    }
  } catch {
    Write-HostStep ("orphaned process cleanup warning: {0}" -f $_.Exception.Message)
  }

  return $stopped
}

function Acquire-HostLock {
  $deadline = (Get-Date).AddSeconds(15)

  while (Test-Path -LiteralPath $lockPath) {
    $lockState = Read-JsonFile $lockPath
    $ownerPid = $null
    if ($lockState -and $lockState.pid -and "$($lockState.pid)" -match '^[0-9]+$') {
      $ownerPid = [int] $lockState.pid
    }
    if ($ownerPid -and (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
      if ((Get-Date) -gt $deadline) {
        throw 'Timed out waiting for another NanoClaw host-control operation to finish.'
      }
      Start-Sleep -Milliseconds 500
      continue
    }

    Remove-FileIfExists $lockPath
  }

  Write-JsonFile $lockPath ([pscustomobject]@{
      pid = $PID
      command = $Command
      acquiredAt = [DateTime]::UtcNow.ToString('o')
    })
}

function Release-HostLock {
  $lockState = Read-JsonFile $lockPath
  if ($lockState -and [string] $lockState.pid -eq [string] $PID) {
    Remove-FileIfExists $lockPath
    return
  }
  if ($null -eq $lockState) {
    Remove-FileIfExists $lockPath
  }
}

function Write-HostState {
  param(
    [string] $Phase,
    [string] $BootId,
    [object] $ProcessId = $null,
    [string] $NodePath = '',
    [string] $NodeVersion = '',
    [string] $StartedAt = '',
    [string] $ReadyAt = '',
    [string] $LastError = '',
    [ValidateSet('ok', 'degraded', 'unknown')]
    [string] $DependencyState = 'unknown',
    [string] $DependencyError = '',
    [string] $InstallModeValue = $InstallMode
  )

  $state = [pscustomobject]@{
    bootId = $BootId
    phase = $Phase
    pid = if ($null -ne $ProcessId -and "$ProcessId" -match '^[0-9]+$') { [int] $ProcessId } else { $null }
    installMode = $InstallModeValue
    nodePath = $NodePath
    nodeVersion = $NodeVersion
    startedAt = $StartedAt
    readyAt = if ([string]::IsNullOrWhiteSpace($ReadyAt)) { $null } else { $ReadyAt }
    lastError = $LastError
    dependencyState = $DependencyState
    dependencyError = $DependencyError
    stdoutLogPath = $stdoutLogPath
    stderrLogPath = $stderrLogPath
    hostLogPath = $hostLogPath
  }
  Write-JsonFile $hostStatePath $state
}

function Wait-ForReadyState {
  param(
    [string] $BootId,
    [int] $ProcessId,
    [int] $TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-RepoProcess -ProcessId $ProcessId)) {
      return $null
    }

    $readyState = Read-JsonFile $readyStatePath
    if (
      $readyState -and
      [string] $readyState.bootId -eq $BootId -and
      [int] $readyState.pid -eq $ProcessId -and
      -not [string]::IsNullOrWhiteSpace([string] $readyState.readyAt)
    ) {
      return $readyState
    }

    Start-Sleep -Milliseconds 500
  }

  return $null
}

function Start-NanoClaw {
  $healthy = Get-HealthyRunningSnapshot
  if ($healthy) {
    Write-HostStep ("NanoClaw already running and ready (pid={0})" -f $healthy.pid)
    return
  }

  Ensure-HostDirectories
  Ensure-BuildArtifacts
  $nodeExe = Resolve-PinnedNodeExecutable
  $nodeVersion = Resolve-PinnedNodeVersion
  $bootId = [guid]::NewGuid().ToString()
  $startedAt = [DateTime]::UtcNow.ToString('o')

  Remove-FileIfExists $readyStatePath
  Stop-OrphanedRepoProcesses | Out-Null
  Stop-Gateway
  $gatewayStart = Start-Gateway
  if ($gatewayStart.status -eq 'failed') {
    Write-HostStep ("OpenAI gateway start warning: {0}" -f $gatewayStart.detail)
  }

  Write-HostState -Phase 'starting' -BootId $bootId -NodePath $nodeExe -NodeVersion $nodeVersion -StartedAt $startedAt
  Write-HostStep ("Starting NanoClaw with pinned Node {0}" -f $nodeVersion)

  if (Test-Path -LiteralPath $pidFile) {
    Remove-FileIfExists $pidFile
  }

  $proc = Start-Process -FilePath $nodeExe -ArgumentList @($entryPath) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLogPath -RedirectStandardError $stderrLogPath -PassThru
  Set-Content -LiteralPath $pidFile -Value $proc.Id -NoNewline
  Write-HostState -Phase 'starting' -BootId $bootId -ProcessId $proc.Id -NodePath $nodeExe -NodeVersion $nodeVersion -StartedAt $startedAt

  $readyState = Wait-ForReadyState -BootId $bootId -ProcessId $proc.Id -TimeoutSeconds 30
  if ($readyState) {
    Start-Sleep -Milliseconds 3000
    $gatewayState = Read-JsonFile $gatewayStatePath
    $gatewayConfigError = Get-LocalGatewayHealthError
    if ($gatewayStart.status -eq 'failed' -and -not $gatewayConfigError) {
      $gatewayConfigError = [string] $gatewayStart.detail
    }

    $dependencyState = 'unknown'
    $dependencyError = ''
    if (-not [string]::IsNullOrWhiteSpace([string] $gatewayConfigError)) {
      $dependencyState = 'degraded'
      $dependencyError = $gatewayConfigError
    } elseif ($gatewayState -and -not [string]::IsNullOrWhiteSpace([string] $gatewayState.host_health)) {
      $dependencyState = 'ok'
    }

    Write-HostState -Phase 'running_ready' -BootId $bootId -ProcessId $proc.Id -NodePath $nodeExe -NodeVersion $nodeVersion -StartedAt $startedAt -ReadyAt ([string] $readyState.readyAt) -DependencyState $dependencyState -DependencyError $dependencyError
    if ($dependencyState -eq 'degraded') {
      Write-HostStep ("NanoClaw reached running_ready with degraded dependency (pid={0}): {1}" -f $proc.Id, $dependencyError)
    } else {
      Write-HostStep ("NanoClaw reached running_ready (pid={0})" -f $proc.Id)
    }
    return
  }

  $lastError = 'NanoClaw did not reach running_ready within 30 seconds.'
  if (-not (Test-RepoProcess -ProcessId $proc.Id)) {
    $lastError = 'NanoClaw exited before writing its readiness marker.'
  }
  Write-HostState -Phase 'launcher_failed' -BootId $bootId -ProcessId $proc.Id -NodePath $nodeExe -NodeVersion $nodeVersion -StartedAt $startedAt -LastError $lastError
  Stop-ProcessIfRunning -ProcessId $proc.Id | Out-Null
  Remove-FileIfExists $pidFile
  Remove-FileIfExists $readyStatePath
  throw $lastError
}

function Stop-NanoClaw {
  if (Get-Command schtasks.exe -ErrorAction SilentlyContinue) {
    try {
      & schtasks.exe /End /TN 'NanoClaw' *> $null
    } catch {
      # ignore missing task
    }
  }

  $runtimePid = Read-Pid
  if ($runtimePid) {
    Stop-ProcessIfRunning -ProcessId $runtimePid | Out-Null
    Write-HostStep ("Stopped pid from nanoclaw.pid ({0})" -f $runtimePid)
  }

  $orphanedStopped = Stop-OrphanedRepoProcesses
  if ($orphanedStopped -gt 0) {
    Write-HostStep ("Stopped orphaned repo-owned processes: {0}" -f $orphanedStopped)
  }

  Stop-Gateway
  Remove-FileIfExists $pidFile
  Remove-FileIfExists $readyStatePath
  Write-HostState -Phase 'stopped' -BootId '' -NodePath '' -NodeVersion '' -StartedAt '' -InstallModeValue $InstallMode
}

function Show-Status {
  $hostState = Read-JsonFile $hostStatePath
  $readyState = Read-JsonFile $readyStatePath
  $runtimeMetadata = Read-JsonFile $nodeRuntimeMetadataPath
  $runtimePid = Read-Pid
  $processRunning = $false
  if ($runtimePid) {
    $processRunning = Test-RepoProcess -ProcessId $runtimePid
  }

  $phase = 'stopped'
  if (
    $hostState -and
    $processRunning -and
    $readyState -and
    [string] $hostState.bootId -eq [string] $readyState.bootId -and
    [int] $readyState.pid -eq $runtimePid
  ) {
    $phase = 'running_ready'
  } elseif ($hostState -and $hostState.phase -eq 'starting' -and $processRunning) {
    $phase = 'starting'
  } elseif ($hostState -and ($hostState.phase -eq 'launcher_failed' -or $hostState.phase -eq 'config_failed')) {
    $phase = [string] $hostState.phase
  } elseif (
    $processRunning -or
    ($hostState -and ($hostState.phase -eq 'running_ready' -or $hostState.phase -eq 'starting')) -or
    $readyState
  ) {
    $phase = 'process_stale'
  }

  $install = if ($hostState -and $hostState.installMode) {
    [string] $hostState.installMode
  } else {
    $InstallMode
  }

  Write-Output ("HOST_STATUS: phase={0}" -f $phase)
  Write-Output ("HOST_STATUS: process_running={0}" -f $processRunning.ToString().ToLowerInvariant())
  Write-Output ("HOST_STATUS: pid={0}" -f ($(if ($runtimePid) { $runtimePid } else { 'none' })))
  Write-Output ("HOST_STATUS: install_mode={0}" -f $install)
  Write-Output ("HOST_STATUS: ready_boot_id={0}" -f ($(if ($readyState) { [string] $readyState.bootId } else { 'none' })))
  Write-Output ("HOST_STATUS: node_version={0}" -f ($(if ($runtimeMetadata) { [string] $runtimeMetadata.version } else { 'unknown' })))
  Write-Output ("HOST_STATUS: node_path={0}" -f ($(if ($runtimeMetadata) { [string] $runtimeMetadata.nodePath } else { 'unknown' })))
  Write-Output ("HOST_STATUS: last_error={0}" -f ($(if ($hostState -and $hostState.lastError) { [string] $hostState.lastError } else { 'none' })))
  Write-Output ("HOST_STATUS: dependency_state={0}" -f ($(if ($hostState -and $hostState.dependencyState) { [string] $hostState.dependencyState } else { 'unknown' })))
  Write-Output ("HOST_STATUS: dependency_error={0}" -f ($(if ($hostState -and $hostState.dependencyError) { [string] $hostState.dependencyError } else { 'none' })))
  Write-Output ("HOST_STATUS: host_log={0}" -f $hostLogPath)
}

Ensure-HostDirectories
Repair-StartupArtifacts
Acquire-HostLock

try {
  switch ($Command) {
    'start' {
      Start-NanoClaw
      break
    }
    'stop' {
      Stop-NanoClaw
      break
    }
    'restart' {
      Stop-NanoClaw
      Start-Sleep -Milliseconds 700
      Start-NanoClaw
      break
    }
    'status' {
      Show-Status
      break
    }
  }
} catch {
  if ($Command -eq 'start' -or $Command -eq 'restart') {
    $message = $_.Exception.Message
    $phase = if (
      $message -match 'pinned Node runtime' -or
      $message -match 'node\.exe was not found' -or
      $message -match 'TypeScript build failed'
    ) {
      'config_failed'
    } else {
      'launcher_failed'
    }
    Write-HostState -Phase $phase -BootId '' -NodePath '' -NodeVersion '' -StartedAt '' -LastError $message -InstallModeValue $InstallMode
    Write-HostStep ("Host control failure: {0}" -f $message)
  }
  throw
} finally {
  Release-HostLock
}
