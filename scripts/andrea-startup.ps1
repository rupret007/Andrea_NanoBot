param(
  [Parameter(Position = 0)]
  [ValidateSet('boot', 'install', 'remove', 'status', 'verify')]
  [string] $Command = 'status',

  [Parameter()]
  [switch] $LiveProbe,

  [Parameter()]
  [switch] $ForceAlert
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$platformRoot = Join-Path $workspaceRoot 'andrea_platform'
$taskName = 'Andrea-All-Services'
$legacyTaskName = 'NanoClaw'
$hostScript = Join-Path $projectRoot 'scripts\nanoclaw-host.ps1'
$nodeLauncher = Join-Path $projectRoot 'scripts\run-with-pinned-node.mjs'
$runtimeDir = Join-Path $projectRoot 'data\runtime'
$logsDir = Join-Path $projectRoot 'logs'
$startupLogPath = Join-Path $logsDir 'andrea-startup.log'
$verificationPath = Join-Path $runtimeDir 'andrea-startup-verification.json'
$pendingAlertPath = Join-Path $runtimeDir 'andrea-boot-alert-pending.json'
$startupScriptPath = Join-Path $projectRoot 'scripts\andrea-startup.ps1'
$startupFolderScriptPath = if ($env:APPDATA) {
  Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\nanoclaw-start.cmd'
} else {
  $null
}

function Ensure-StartupDirectories {
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

function Write-StartupLog {
  param([string] $Message)

  Ensure-StartupDirectories
  $line = "[{0}] STARTUP: {1}" -f ([DateTime]::UtcNow.ToString('o')), $Message
  Add-Content -LiteralPath $startupLogPath -Value $line
  Write-Output $line
}

function Write-JsonFile {
  param(
    [string] $Path,
    [object] $Value
  )

  Ensure-StartupDirectories
  $json = $Value | ConvertTo-Json -Depth 16
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Protect-StartupText {
  param([string] $Text)

  if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
  $output = $Text
  $output = $output -replace 'sk-(proj|api|ant|cp)?-[A-Za-z0-9_-]{12,}', '***'
  $output = $output -replace 'ghp_[A-Za-z0-9_]{12,}', '***'
  $output = $output -replace 'crsr_[A-Za-z0-9_]{12,}', '***'
  $output = $output -replace 'AIza[0-9A-Za-z_-]{20,}', '***'
  $output = $output -replace 'BSA-[A-Za-z0-9_-]{8,}', '***'
  $output = $output -replace '\b\d{7,}:[A-Za-z0-9_-]{20,}\b', '***'
  $output = $output -replace '([?&](secret|password|token|key)=)[^&\s]+', '$1***'
  $output = $output -replace '(?i)\b(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s|]+', '$1=***'
  return $output
}

function Limit-StartupAlertText {
  param(
    [string] $Text,
    [int] $MaxLength = 240
  )

  $redacted = (Protect-StartupText $Text) -replace '\s+', ' '
  $redacted = $redacted.Trim()
  if ($redacted.Length -le $MaxLength) { return $redacted }
  return ($redacted.Substring(0, [Math]::Max(0, $MaxLength - 3)).TrimEnd() + '...')
}

function Invoke-CapturedCommand {
  param(
    [string] $FilePath,
    [string[]] $Arguments,
    [string] $WorkingDirectory = $projectRoot
  )

  $output = ''
  $exitCode = 0
  try {
    Push-Location $WorkingDirectory
    $raw = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $output = (($raw | Out-String).Trim())
  } catch {
    $exitCode = 1
    $output = $_.Exception.Message
  } finally {
    Pop-Location
  }

  return [pscustomobject]@{
    exitCode = $exitCode
    output = Protect-StartupText $output
  }
}

function Convert-HostStatusLines {
  param([string] $Output)

  $map = @{}
  foreach ($line in ($Output -split "`r?`n")) {
    if ($line -match '^HOST_STATUS:\s*([^=]+)=(.*)$') {
      $map[$matches[1].Trim()] = $matches[2].Trim()
    }
  }
  return $map
}

function Get-ScheduledTaskPresence {
  param([string] $Name)

  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    try {
      $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
      $info = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction SilentlyContinue
      return [pscustomobject]@{
        exists = $true
        state = [string] $task.State
        lastRunTime = if ($info) { [string] $info.LastRunTime } else { '' }
        lastTaskResult = if ($info) { [string] $info.LastTaskResult } else { '' }
      }
    } catch {
      return [pscustomobject]@{
        exists = $false
        state = 'missing'
        lastRunTime = ''
        lastTaskResult = ''
      }
    }
  }

  try {
    & schtasks.exe /Query /TN $Name *> $null
    return [pscustomobject]@{
      exists = $LASTEXITCODE -eq 0
      state = if ($LASTEXITCODE -eq 0) { 'unknown' } else { 'missing' }
      lastRunTime = ''
      lastTaskResult = ''
    }
  } catch {
    return [pscustomobject]@{
      exists = $false
      state = 'missing'
      lastRunTime = ''
      lastTaskResult = ''
    }
  }
}

function Register-AndreaStartupTask {
  $argument = ('-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "{0}" boot' -f $startupScriptPath)

  if (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) {
    try {
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
      $trigger = New-ScheduledTaskTrigger -AtLogOn
      $trigger.Delay = 'PT1M'
      $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
      $principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Starts Andrea platform, NanoBot, runtime, proof checks, and boot alerts at Windows logon.' -Force | Out-Null
      return
    } catch {
      Write-StartupLog ("Register-ScheduledTask failed, falling back to schtasks.exe: {0}" -f $_.Exception.Message)
    }
  }

  $taskRun = ('powershell.exe {0}' -f $argument)
  & schtasks.exe /Create /TN $taskName /SC ONLOGON /DELAY 0001:00 /TR $taskRun /F | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to create Andrea startup scheduled task.'
  }
}

function Unregister-StartupTaskIfPresent {
  param([string] $Name)

  if (Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue) {
    try {
      Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction Stop
      return $true
    } catch {
      return $false
    }
  }

  try {
    & schtasks.exe /Delete /TN $Name /F *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Disable-StartupFolderLauncher {
  if (-not $startupFolderScriptPath) { return 'unavailable' }
  if (-not (Test-Path -LiteralPath $startupFolderScriptPath)) { return 'already_retired' }

  $disabledPath = "$startupFolderScriptPath.disabled"
  if (Test-Path -LiteralPath $disabledPath) {
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
    $disabledPath = "$startupFolderScriptPath.$stamp.disabled"
  }
  Move-Item -LiteralPath $startupFolderScriptPath -Destination $disabledPath
  return ("retired_to={0}" -f $disabledPath)
}

function Get-CanonicalStartupFolderScriptContent {
  return @(
    '@echo off'
    ('"powershell.exe" "-NoProfile" "-ExecutionPolicy" "Bypass" "-WindowStyle" "Hidden" "-File" "{0}" "boot"' -f $startupScriptPath)
  ) -join "`r`n"
}

function Ensure-StartupFolderBootLauncher {
  if (-not $startupFolderScriptPath) { return 'unavailable' }
  $startupFolder = Split-Path -Parent $startupFolderScriptPath
  New-Item -ItemType Directory -Path $startupFolder -Force | Out-Null
  Set-Content -LiteralPath $startupFolderScriptPath -Value ((Get-CanonicalStartupFolderScriptContent) + "`r`n")
  return ("boot_orchestrator={0}" -f $startupFolderScriptPath)
}

function Get-StartupFolderMode {
  if (-not $startupFolderScriptPath) { return 'unavailable' }
  if (-not (Test-Path -LiteralPath $startupFolderScriptPath)) { return 'missing' }
  $content = Get-Content -LiteralPath $startupFolderScriptPath -Raw -ErrorAction SilentlyContinue
  if ([string]$content -match 'andrea-startup\.ps1"\s+"boot"') { return 'boot_orchestrator' }
  if ([string]$content -match 'nanoclaw-host\.ps1"\s+"start"') { return 'legacy_nanoclaw_start' }
  if ([string]$content -match 'start-nanoclaw\.ps1') { return 'legacy_start_nanoclaw_shim' }
  return 'custom'
}

function Convert-IntegrationStateToStatus {
  param([string] $State)

  switch ($State) {
    'healthy' { return 'healthy' }
    'degraded_but_usable' { return 'degraded' }
    'near_live_only' { return 'degraded' }
    'needs_proof' { return 'degraded' }
    'manual_action_required' { return 'degraded' }
    'externally_blocked' { return 'degraded' }
    'needs_auth' { return 'degraded' }
    'repo_fix_available' { return 'degraded' }
    default { return 'degraded' }
  }
}

function Add-Component {
  param(
    [System.Collections.Generic.List[object]] $Components,
    [string] $Id,
    [string] $Label,
    [ValidateSet('healthy', 'degraded', 'failed')]
    [string] $Status,
    [string] $Detail = '',
    [string] $NextAction = ''
  )

  $Components.Add([pscustomobject]@{
    id = $Id
    label = $Label
    status = $Status
    detail = Protect-StartupText $Detail
    nextAction = Protect-StartupText $NextAction
  })
}

function Build-BootAlertMessage {
  param([object] $Report)

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('Andrea boot summary')
  $lines.Add(("Status: {0}" -f [string] $Report.status))
  $lines.Add(("Checked: {0}" -f [string] $Report.generatedAt))
  foreach ($component in @($Report.components)) {
    $shortDetail = Limit-StartupAlertText ([string] $component.detail)
    $detail = if ([string]::IsNullOrWhiteSpace($shortDetail)) { '' } else { " - $shortDetail" }
    $lines.Add(("{0}: {1}{2}" -f [string] $component.label, [string] $component.status, $detail))
  }
  $blockers = @($Report.components | Where-Object { [string] $_.status -ne 'healthy' })
  if ($blockers.Count -gt 0) {
    $lines.Add('Next actions:')
    foreach ($blocker in @($blockers | Select-Object -First 5)) {
      $next = if (-not [string]::IsNullOrWhiteSpace([string] $blocker.nextAction)) {
        [string] $blocker.nextAction
      } elseif (-not [string]::IsNullOrWhiteSpace([string] $blocker.detail)) {
        [string] $blocker.detail
      } else {
        'Review startup status.'
      }
      $next = Limit-StartupAlertText $next
      $lines.Add(("- {0}: {1}" -f [string] $blocker.label, $next))
    }
  } else {
    $lines.Add('Next actions: none')
  }
  return Protect-StartupText ([string]::Join("`n", $lines))
}

function Invoke-StartupVerification {
  param([switch] $WritePendingAlert)

  Ensure-StartupDirectories
  $generatedAt = [DateTime]::UtcNow.ToString('o')
  $components = New-Object System.Collections.Generic.List[object]
  $commands = @{}

  $hostResult = Invoke-CapturedCommand -FilePath 'powershell.exe' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $hostScript, 'status') -WorkingDirectory $projectRoot
  $commands.hostStatusExitCode = $hostResult.exitCode
  $hostMap = Convert-HostStatusLines $hostResult.output
  $hostPhase = if ($hostMap.phase) { [string] $hostMap.phase } else { 'unknown' }
  $dependencyState = if ($hostMap.dependency_state) { [string] $hostMap.dependency_state } else { 'unknown' }
  $dependencyError = if ($hostMap.dependency_error) { [string] $hostMap.dependency_error } else { '' }
  if ($hostResult.exitCode -ne 0 -or $hostPhase -ne 'running_ready') {
    Add-Component $components 'nanobot_host' 'NanoBot host' 'failed' ("phase={0}; {1}" -f $hostPhase, $hostResult.output) 'Run npm run services:restart, then npm run startup:verify.'
  } elseif ($dependencyState -eq 'ok') {
    Add-Component $components 'nanobot_host' 'NanoBot host' 'healthy' 'running_ready with dependencies ok' ''
  } else {
    Add-Component $components 'nanobot_host' 'NanoBot host' 'degraded' ("dependency_state={0}; {1}" -f $dependencyState, $dependencyError) 'Review the degraded dependency, then rerun npm run startup:verify.'
  }

  $platformScript = Join-Path $platformRoot 'scripts\platform_operator.py'
  $platformPython = Join-Path $platformRoot '.venv\Scripts\python.exe'
  if (Test-Path -LiteralPath $platformPython) {
    $platformResult = Invoke-CapturedCommand -FilePath $platformPython -Arguments @($platformScript, 'status', '--json') -WorkingDirectory $platformRoot
    $commands.platformStatusExitCode = $platformResult.exitCode
    try {
      $platform = $platformResult.output | ConvertFrom-Json -ErrorAction Stop
      $lifecycle = [string] $platform.authoritative_lifecycle
      $reason = [string] $platform.authoritative_reason
      if ($lifecycle -eq 'READY') {
        Add-Component $components 'andrea_platform' 'Andrea platform' 'healthy' 'READY' ''
      } else {
        Add-Component $components 'andrea_platform' 'Andrea platform' 'degraded' ("lifecycle={0}; {1}" -f $lifecycle, $reason) 'Run platform status/transport reports and repair the listed component.'
      }
    } catch {
      Add-Component $components 'andrea_platform' 'Andrea platform' 'failed' $platformResult.output 'Run .venv\Scripts\python.exe scripts\platform_operator.py status --json.'
    }
  } else {
    Add-Component $components 'andrea_platform' 'Andrea platform' 'failed' 'Platform virtualenv python is missing.' 'Rebuild or bootstrap andrea_platform.'
  }

  $integrationResult = Invoke-CapturedCommand -FilePath 'node' -Arguments @($nodeLauncher, '.\node_modules\tsx\dist\cli.mjs', 'scripts\integrations.ts', 'doctor', '--json') -WorkingDirectory $projectRoot
  $commands.integrationsDoctorExitCode = $integrationResult.exitCode
  try {
    $integrationReport = $integrationResult.output | ConvertFrom-Json -ErrorAction Stop
    foreach ($integration in @($integrationReport.statuses)) {
      $state = [string] $integration.state
      $status = Convert-IntegrationStateToStatus $state
      Add-Component $components ("integration:{0}" -f [string] $integration.integrationId) ([string] $integration.label) $status ([string] $integration.detail) ([string] $integration.nextAction)
    }
  } catch {
    Add-Component $components 'integrations' 'Integration doctor' 'failed' $integrationResult.output 'Run npm run integrations:doctor -- --json.'
  }

  if ($LiveProbe) {
    $telegramSmoke = Invoke-CapturedCommand -FilePath 'node' -Arguments @($nodeLauncher, '.\node_modules\tsx\dist\cli.mjs', 'src\telegram-user-session.ts', 'smoke') -WorkingDirectory $projectRoot
    $commands.telegramSmokeExitCode = $telegramSmoke.exitCode
    if ($telegramSmoke.exitCode -eq 0) {
      Add-Component $components 'telegram_live_smoke' 'Telegram live smoke' 'healthy' 'live smoke passed' ''
    } else {
      Add-Component $components 'telegram_live_smoke' 'Telegram live smoke' 'degraded' $telegramSmoke.output 'Repair Telegram live proof, then rerun npm run telegram:user:smoke.'
    }
  }

  $status = 'healthy'
  if (@($components | Where-Object { [string] $_.status -eq 'failed' }).Count -gt 0) {
    $status = 'failed'
  } elseif (@($components | Where-Object { [string] $_.status -eq 'degraded' }).Count -gt 0) {
    $status = 'degraded'
  }

  $task = Get-ScheduledTaskPresence $taskName
  $legacyTask = Get-ScheduledTaskPresence $legacyTaskName
  $startupFolder = [pscustomobject]@{
    path = $startupFolderScriptPath
    present = [bool] ($startupFolderScriptPath -and (Test-Path -LiteralPath $startupFolderScriptPath))
  }
  $report = [pscustomobject]@{
    generatedAt = $generatedAt
    status = $status
    taskName = $taskName
    scheduledTask = $task
    legacyScheduledTask = $legacyTask
    startupFolder = $startupFolder
    hostBootId = if ($hostMap.ready_boot_id) { [string] $hostMap.ready_boot_id } else { '' }
    installMode = if ($hostMap.install_mode) { [string] $hostMap.install_mode } else { '' }
    currentLaunchMode = if ($hostMap.current_launch_mode) { [string] $hostMap.current_launch_mode } else { '' }
    components = @($components.ToArray())
    commands = $commands
    secretsRedacted = $true
  }
  Write-JsonFile -Path $verificationPath -Value $report

  if ($WritePendingAlert -and ($ForceAlert -or $status -ne 'healthy')) {
    $bootKey = if (-not [string]::IsNullOrWhiteSpace([string] $report.hostBootId)) { [string] $report.hostBootId } else { [DateTime]::UtcNow.ToString('yyyyMMddHH') }
    $alert = [pscustomobject]@{
      alertId = [guid]::NewGuid().ToString()
      createdAt = $generatedAt
      status = $status
      dedupeKey = ("startup:boot:{0}:{1}" -f $status, $bootKey)
      message = Build-BootAlertMessage $report
    }
    Write-JsonFile -Path $pendingAlertPath -Value $alert
  }

  return $report
}

function Show-StartupStatus {
  $task = Get-ScheduledTaskPresence $taskName
  $legacyTask = Get-ScheduledTaskPresence $legacyTaskName
  $startupFolderPresent = [bool] ($startupFolderScriptPath -and (Test-Path -LiteralPath $startupFolderScriptPath))
  $startupFolderMode = Get-StartupFolderMode
  Write-Output ("STARTUP_STATUS: task_name={0}" -f $taskName)
  Write-Output ("STARTUP_STATUS: scheduled_task_present={0}" -f ([string] $task.exists).ToLowerInvariant())
  Write-Output ("STARTUP_STATUS: scheduled_task_state={0}" -f [string] $task.state)
  Write-Output ("STARTUP_STATUS: scheduled_task_last_run_time={0}" -f ($(if ($task.lastRunTime) { [string] $task.lastRunTime } else { 'none' })))
  Write-Output ("STARTUP_STATUS: scheduled_task_last_result={0}" -f ($(if ($task.lastTaskResult) { [string] $task.lastTaskResult } else { 'none' })))
  Write-Output ("STARTUP_STATUS: legacy_nanoclaw_task_present={0}" -f ([string] $legacyTask.exists).ToLowerInvariant())
  Write-Output ("STARTUP_STATUS: startup_folder_script_present={0}" -f ([string] $startupFolderPresent).ToLowerInvariant())
  Write-Output ("STARTUP_STATUS: startup_folder_mode={0}" -f $startupFolderMode)
  Write-Output ("STARTUP_STATUS: startup_folder_script_path={0}" -f ($(if ($startupFolderScriptPath) { $startupFolderScriptPath } else { 'none' })))
  Write-Output ("STARTUP_STATUS: verification_report={0}" -f $verificationPath)
  Write-Output ("STARTUP_STATUS: pending_alert={0}" -f ($(if (Test-Path -LiteralPath $pendingAlertPath) { $pendingAlertPath } else { 'none' })))
}

Ensure-StartupDirectories

switch ($Command) {
  'boot' {
    Write-StartupLog 'Boot command starting: launching Andrea host stack.'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $hostScript start -InstallMode scheduled_task
    $hostExit = $LASTEXITCODE
    if ($hostExit -ne 0) {
      Write-StartupLog ("Host start exited with code {0}; verification will record failure." -f $hostExit)
    }
    $report = Invoke-StartupVerification -WritePendingAlert
    Write-StartupLog ("Boot verification completed with status {0}." -f [string] $report.status)
    exit $hostExit
  }
  'install' {
    Write-StartupLog 'Installing Andrea all-services scheduled task.'
    try {
      Register-AndreaStartupTask
    } catch {
      $fallbackResult = Ensure-StartupFolderBootLauncher
      Write-StartupLog ("Scheduled task install failed; refreshed Startup-folder boot fallback ({0}). Error: {1}" -f $fallbackResult, $_.Exception.Message)
      Show-StartupStatus
      throw
    }
    $legacyRemoved = Unregister-StartupTaskIfPresent $legacyTaskName
    $startupFolderResult = Disable-StartupFolderLauncher
    $task = Get-ScheduledTaskPresence $taskName
    if (-not $task.exists) {
      throw 'Andrea startup scheduled task was not present after install.'
    }
    Write-StartupLog ("Installed {0}; legacy_task_removed={1}; startup_folder={2}" -f $taskName, ([string] $legacyRemoved).ToLowerInvariant(), $startupFolderResult)
    Show-StartupStatus
  }
  'remove' {
    Write-StartupLog 'Removing Andrea all-services scheduled task.'
    $removed = Unregister-StartupTaskIfPresent $taskName
    Write-StartupLog ("Removed {0}: {1}" -f $taskName, ([string] $removed).ToLowerInvariant())
    Show-StartupStatus
  }
  'status' {
    Show-StartupStatus
  }
  'verify' {
    $report = Invoke-StartupVerification -WritePendingAlert
    Write-Output ("STARTUP_VERIFY: status={0}" -f [string] $report.status)
    Write-Output ("STARTUP_VERIFY: report={0}" -f $verificationPath)
    foreach ($component in @($report.components | Where-Object { [string] $_.status -ne 'healthy' } | Select-Object -First 10)) {
      Write-Output ("STARTUP_VERIFY: blocker={0}:{1}:{2}" -f [string] $component.id, [string] $component.status, [string] $component.nextAction)
    }
  }
}
