param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'ensure')]
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
$assistantHealthPath = Join-Path $runtimeDir 'assistant-health.json'
$telegramRoundtripPath = Join-Path $runtimeDir 'telegram-roundtrip-health.json'
$telegramTransportPath = Join-Path $runtimeDir 'telegram-transport-health.json'
$runtimeAuditPath = Join-Path $runtimeDir 'runtime-audit.json'
$lockPath = Join-Path $runtimeDir 'nanoclaw-host.lock'
$nodeRuntimeMetadataPath = Join-Path $runtimeDir 'node-runtime.json'
$watchdogPidPath = Join-Path $runtimeDir 'nanoclaw-watchdog.pid'
$watchdogStatePath = Join-Path $runtimeDir 'nanoclaw-watchdog-state.json'
$gatewayStatePath = Join-Path $runtimeDir 'openai-gateway-state.json'
$gatewayStartScript = Join-Path $projectRoot 'scripts\start-openai-gateway.ps1'
$gatewayStopScript = Join-Path $projectRoot 'scripts\stop-openai-gateway.ps1'
$watchdogScriptPath = Join-Path $projectRoot 'scripts\nanoclaw-watchdog.ps1'
$pinnedNodeLauncher = Join-Path $projectRoot 'scripts\run-with-pinned-node.mjs'
$watchdogLogPath = Join-Path $logsDir 'nanoclaw.watchdog.log'
$watchdogErrorLogPath = Join-Path $logsDir 'nanoclaw.watchdog.error.log'
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

function Read-DotEnv {
  $result = @{}
  $envPath = Join-Path $projectRoot '.env'
  if (!(Test-Path -LiteralPath $envPath)) {
    return $result
  }

  foreach ($line in Get-Content -LiteralPath $envPath -ErrorAction SilentlyContinue) {
    $trimmed = [string] $line
    if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
    if ($trimmed.TrimStart().StartsWith('#')) { continue }
    $parts = $trimmed -split '=', 2
    if ($parts.Count -lt 2) { continue }
    $key = $parts[0].Trim()
    if ([string]::IsNullOrWhiteSpace($key)) { continue }
    $value = $parts[1].Trim().Trim('"').Trim("'")
    $result[$key] = $value
  }

  return $result
}

function Get-EnvValue {
  param(
    [hashtable] $DotEnv,
    [string] $Key
  )

  $fromProcess = [Environment]::GetEnvironmentVariable($Key)
  if (-not [string]::IsNullOrWhiteSpace($fromProcess)) {
    return $fromProcess.Trim()
  }
  if ($DotEnv.ContainsKey($Key) -and -not [string]::IsNullOrWhiteSpace([string] $DotEnv[$Key])) {
    return ([string] $DotEnv[$Key]).Trim()
  }
  return ''
}

function Normalize-RoutePath {
  param(
    [string] $Value,
    [string] $Fallback
  )

  $raw = if ([string]::IsNullOrWhiteSpace($Value)) {
    $Fallback
  } else {
    $Value.Trim()
  }

  if ($raw.StartsWith('/')) {
    return $raw
  }

  return "/$raw"
}

function Join-RoutePath {
  param(
    [string] $BasePath,
    [string] $Suffix
  )

  if ($BasePath.EndsWith('/')) {
    return "$BasePath$Suffix"
  }

  return "$BasePath/$Suffix"
}

function Get-LocalProbeHost {
  param([string] $ConfiguredHost)

  if ([string]::IsNullOrWhiteSpace($ConfiguredHost)) {
    return '127.0.0.1'
  }

  $resolvedHost = $ConfiguredHost.Trim()
  if ($resolvedHost -eq '0.0.0.0' -or $resolvedHost -eq '::' -or $resolvedHost -eq '[::]') {
    return '127.0.0.1'
  }

  return $resolvedHost
}

function Invoke-LocalHealthProbe {
  param([string] $Url)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3 -ErrorAction Stop
    return [pscustomobject]@{
      status = 'healthy'
      detail = ("HTTP {0}" -f [int] $response.StatusCode)
      body = if ($response.Content) { [string] $response.Content } else { '' }
    }
  } catch {
    return [pscustomobject]@{
      status = 'unreachable'
      detail = $_.Exception.Message
      body = ''
    }
  }
}

function Get-AlexaLocalStatus {
  param([hashtable] $DotEnv)

  $skillId = Get-EnvValue -DotEnv $DotEnv -Key 'ALEXA_SKILL_ID'
  if ([string]::IsNullOrWhiteSpace($skillId)) {
    return [pscustomobject]@{
      configured = $false
      bind = 'none'
      healthPath = 'none'
      oauthHealthPath = 'none'
      listenerHealth = 'disabled'
      listenerDetail = 'ALEXA_SKILL_ID is not set.'
      oauthHealth = 'disabled'
      oauthDetail = 'Alexa OAuth is unavailable until Alexa is configured.'
    }
  }

  $configuredHost = Get-EnvValue -DotEnv $DotEnv -Key 'ALEXA_HOST'
  if ([string]::IsNullOrWhiteSpace($configuredHost)) {
    $configuredHost = '127.0.0.1'
  }
  $probeHost = Get-LocalProbeHost -ConfiguredHost $configuredHost
  $configuredPort = Get-EnvValue -DotEnv $DotEnv -Key 'ALEXA_PORT'
  if ([string]::IsNullOrWhiteSpace($configuredPort)) {
    $configuredPort = '4300'
  }
  $pathValue = Normalize-RoutePath -Value (Get-EnvValue -DotEnv $DotEnv -Key 'ALEXA_PATH') -Fallback '/alexa'
  $healthPath = Join-RoutePath -BasePath $pathValue -Suffix 'health'
  $oauthHealthPath = Join-RoutePath -BasePath $pathValue -Suffix 'oauth/health'

  $listenerUrl = "http://$probeHost`:$configuredPort$healthPath"
  $oauthUrl = "http://$probeHost`:$configuredPort$oauthHealthPath"
  $listenerProbe = Invoke-LocalHealthProbe -Url $listenerUrl
  $oauthProbe = Invoke-LocalHealthProbe -Url $oauthUrl

  return [pscustomobject]@{
    configured = $true
    bind = "$configuredHost`:$configuredPort$pathValue"
    healthPath = $healthPath
    oauthHealthPath = $oauthHealthPath
    listenerHealth = $listenerProbe.status
    listenerDetail = $listenerProbe.detail
    oauthHealth = $oauthProbe.status
    oauthDetail = $oauthProbe.detail
  }
}

function Normalize-BaseUrl {
  param([string] $Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  return ([string] $Value).Trim().TrimEnd('/')
}

function Invoke-PublicHealthProbe {
  param(
    [string] $Url,
    [hashtable] $Headers
  )

  try {
    $params = @{
      UseBasicParsing = $true
      Uri = $Url
      TimeoutSec = 6
    }
    if ($Headers -and $Headers.Count -gt 0) {
      $params.Headers = $Headers
    }

    $response = Invoke-WebRequest @params
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
      return [pscustomobject]@{
        status = 'degraded'
        detail = "HTTP $($response.StatusCode)"
      }
    }

    return [pscustomobject]@{
      status = 'healthy'
      detail = "HTTP $($response.StatusCode)"
    }
  } catch {
    $detail = [string] $_.Exception.Message
    if ($detail -match 'ERR_NGROK_6024') {
      $detail = 'ngrok browser warning page intercepted the request. Use the ngrok-skip-browser-warning header for browser-style checks.'
    }
    return [pscustomobject]@{
      status = 'degraded'
      detail = $detail
    }
  }
}

function Get-AlexaPublicStatus {
  param(
    [hashtable] $DotEnv,
    [pscustomobject] $LocalStatus
  )

  $publicBaseUrl = Normalize-BaseUrl -Value (Get-EnvValue -DotEnv $DotEnv -Key 'ALEXA_PUBLIC_BASE_URL')
  if ([string]::IsNullOrWhiteSpace($publicBaseUrl)) {
    return [pscustomobject]@{
      configured = $false
      baseUrl = 'none'
      endpointUrl = 'none'
      healthUrl = 'none'
      oauthHealthUrl = 'none'
      ingressKind = 'unknown'
      certificateHint = 'Set ALEXA_PUBLIC_BASE_URL after you choose the live HTTPS ingress.'
      browserHint = 'none'
      listenerHealth = 'unconfigured'
      listenerDetail = 'ALEXA_PUBLIC_BASE_URL is not set.'
      oauthHealth = 'unconfigured'
      oauthDetail = 'ALEXA_PUBLIC_BASE_URL is not set.'
    }
  }

  $headers = @{}
  $ingressKind = 'standard_certificate_domain'
  $certificateHint = 'Make sure the Alexa Developer Console SSL certificate type matches the public endpoint certificate.'
  $browserHint = 'none'

  try {
    $publicUri = [Uri] $publicBaseUrl
    $publicHost = ([string] $publicUri.Host).ToLowerInvariant()
    if ($publicHost.EndsWith('.ngrok-free.dev')) {
      $ingressKind = 'wildcard_certificate_domain'
      $certificateHint = 'Alexa Developer Console endpoint SSL type must be set to the wildcard certificate option for *.ngrok-free.dev.'
      $browserHint = 'ngrok free tunnels can show a browser warning page unless the request sends the ngrok-skip-browser-warning header.'
      $headers['ngrok-skip-browser-warning'] = '1'
    }
  } catch {
  }

  $endpointUrl = 'none'
  $healthUrl = 'none'
  $oauthHealthUrl = 'none'
  if ($LocalStatus -and $LocalStatus.configured) {
    $basePath = [string] $LocalStatus.bind
    $routePath = $null
    if (-not [string]::IsNullOrWhiteSpace($basePath)) {
      $lastSlash = $basePath.IndexOf('/')
      if ($lastSlash -ge 0) {
        $routePath = $basePath.Substring($lastSlash)
      }
    }
    if ([string]::IsNullOrWhiteSpace($routePath)) {
      $routePath = '/alexa'
    }
    $endpointUrl = "$publicBaseUrl$routePath"
    $healthUrl = "$publicBaseUrl$($LocalStatus.healthPath)"
    $oauthHealthUrl = "$publicBaseUrl$($LocalStatus.oauthHealthPath)"
  }

  $listenerProbe = if ($healthUrl -ne 'none') {
    Invoke-PublicHealthProbe -Url $healthUrl -Headers $headers
  } else {
    [pscustomobject]@{
      status = 'unconfigured'
      detail = 'Alexa is not configured locally.'
    }
  }

  $oauthProbe = if ($oauthHealthUrl -ne 'none') {
    Invoke-PublicHealthProbe -Url $oauthHealthUrl -Headers $headers
  } else {
    [pscustomobject]@{
      status = 'unconfigured'
      detail = 'Alexa is not configured locally.'
    }
  }

  return [pscustomobject]@{
    configured = $true
    baseUrl = $publicBaseUrl
    endpointUrl = $endpointUrl
    healthUrl = $healthUrl
    oauthHealthUrl = $oauthHealthUrl
    ingressKind = $ingressKind
    certificateHint = $certificateHint
    browserHint = $browserHint
    listenerHealth = $listenerProbe.status
    listenerDetail = $listenerProbe.detail
    oauthHealth = $oauthProbe.status
    oauthDetail = $oauthProbe.detail
  }
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

function Read-WatchdogPid {
  if (!(Test-Path -LiteralPath $watchdogPidPath)) { return $null }
  try {
    $raw = (Get-Content -LiteralPath $watchdogPidPath -ErrorAction Stop | Select-Object -First 1).Trim()
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
    if ($null -eq $proc) {
      return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
    }
    $cmd = [string] $proc.CommandLine
    $projectPattern = [Regex]::Escape($projectRoot)
    return $cmd -match $projectPattern -and $cmd -match 'dist[\\/]index\.js'
  } catch {
    try {
      return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
    } catch {
      return $false
    }
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

function Test-WatchdogProcess {
  param([int] $ProcessId)

  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
      return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
    }
    $cmd = [string] $proc.CommandLine
    $projectPattern = [Regex]::Escape($projectRoot)
    return $cmd -match $projectPattern -and $cmd -match 'nanoclaw-watchdog\.ps1'
  } catch {
    try {
      return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
    } catch {
      return $false
    }
  }
}

function Get-WatchdogSnapshot {
  $watchdogPid = Read-WatchdogPid
  $watchdogRunning = $false
  if ($watchdogPid) {
    $watchdogRunning = Test-WatchdogProcess -ProcessId $watchdogPid
  }

  return [pscustomobject]@{
    pid = $watchdogPid
    running = $watchdogRunning
    state = Read-JsonFile $watchdogStatePath
  }
}

function Start-Watchdog {
  if (!(Test-Path -LiteralPath $watchdogScriptPath)) {
    Write-HostStep ("Watchdog script missing at {0}" -f $watchdogScriptPath)
    return
  }

  $watchdog = Get-WatchdogSnapshot
  if ($watchdog.running) {
    return
  }

  if ($watchdog.pid) {
    Stop-ProcessIfRunning -ProcessId $watchdog.pid | Out-Null
  }
  Remove-FileIfExists $watchdogPidPath

  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      $watchdogScriptPath,
      '-IntervalSeconds',
      '120'
    ) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $watchdogLogPath -RedirectStandardError $watchdogErrorLogPath -PassThru
  Set-Content -LiteralPath $watchdogPidPath -Value $proc.Id -NoNewline
  Write-HostStep ("Started NanoClaw watchdog (pid={0})" -f $proc.Id)
}

function Stop-Watchdog {
  $watchdogPid = Read-WatchdogPid
  if ($watchdogPid) {
    Stop-ProcessIfRunning -ProcessId $watchdogPid | Out-Null
    Write-HostStep ("Stopped NanoClaw watchdog (pid={0})" -f $watchdogPid)
  }
  Remove-FileIfExists $watchdogPidPath
  Remove-FileIfExists $watchdogStatePath
}

function Get-AssistantHealthStatus {
  param(
    [object] $HostState = $null,
    [object] $ReadyState = $null,
    [object] $RuntimePid = $null,
    [int] $MaxAgeSeconds = 180
  )

  $health = Read-JsonFile $assistantHealthPath
  if ($null -eq $health) {
    return [pscustomobject]@{
      status = 'missing'
      detail = 'Assistant health marker is missing.'
      updatedAt = $null
    }
  }

  $updatedAtText = [string] $health.updatedAt
  $updatedAt = [DateTime]::MinValue
  if ([string]::IsNullOrWhiteSpace($updatedAtText) -or -not [DateTime]::TryParse($updatedAtText, [ref] $updatedAt)) {
    return [pscustomobject]@{
      status = 'stale'
      detail = 'Assistant health marker has an invalid timestamp.'
      updatedAt = $updatedAtText
    }
  }

  if ($RuntimePid -and [string] $health.pid -match '^[0-9]+$' -and [int] $health.pid -ne [int] $RuntimePid) {
    return [pscustomobject]@{
      status = 'degraded'
      detail = 'Assistant health marker is reporting a different process id.'
      updatedAt = $updatedAtText
    }
  }

  if (
    $HostState -and
    -not [string]::IsNullOrWhiteSpace([string] $HostState.bootId) -and
    -not [string]::IsNullOrWhiteSpace([string] $health.bootId) -and
    [string] $health.bootId -ne [string] $HostState.bootId
  ) {
    return [pscustomobject]@{
      status = 'degraded'
      detail = 'Assistant health marker boot id does not match host state.'
      updatedAt = $updatedAtText
    }
  }

  if (
    $ReadyState -and
    -not [string]::IsNullOrWhiteSpace([string] $ReadyState.bootId) -and
    -not [string]::IsNullOrWhiteSpace([string] $health.bootId) -and
    [string] $health.bootId -ne [string] $ReadyState.bootId
  ) {
    return [pscustomobject]@{
      status = 'degraded'
      detail = 'Assistant health marker boot id does not match ready state.'
      updatedAt = $updatedAtText
    }
  }

  $ageSeconds = ([DateTime]::UtcNow - $updatedAt.ToUniversalTime()).TotalSeconds
  if ($ageSeconds -gt $MaxAgeSeconds) {
    return [pscustomobject]@{
      status = 'stale'
      detail = ("Assistant health marker is stale ({0:N0}s old)." -f $ageSeconds)
      updatedAt = $updatedAtText
    }
  }

  $channelIssues = @()
  foreach ($channel in @($health.channels)) {
    if ($null -eq $channel) { continue }
    $configured = $true
    if ($channel.PSObject.Properties.Name -contains 'configured') {
      $configured = [bool] $channel.configured
    }
    $state = [string] $channel.state
    if ($configured -and $state -ne 'ready') {
      $reason = [string] $channel.lastError
      if ([string]::IsNullOrWhiteSpace($reason)) {
        $reason = [string] $channel.detail
      }
      if ([string]::IsNullOrWhiteSpace($reason)) {
        $reason = $state
      }
      $channelIssues += ('{0}: {1}' -f [string] $channel.name, $reason)
    }
  }

  if ($channelIssues.Count -gt 0) {
    return [pscustomobject]@{
      status = 'degraded'
      detail = ($channelIssues -join '; ')
      updatedAt = $updatedAtText
    }
  }

  return [pscustomobject]@{
    status = 'healthy'
    detail = 'Assistant health marker is current.'
    updatedAt = $updatedAtText
  }
}

function Get-TelegramRoundtripStatus {
  param(
    [object] $AssistantHealthMarker = $null,
    [object] $HostState = $null,
    [object] $ReadyState = $null,
    [int] $ProbeIntervalSeconds = 1800,
    [int] $StartupGraceSeconds = 300
  )

  $state = Read-JsonFile $telegramRoundtripPath
  $lastOkAt = if ($state -and $state.lastSuccessAt) { [string] $state.lastSuccessAt } else { $null }
  $lastProbeAt = if ($state -and $state.lastProbeAt) { [string] $state.lastProbeAt } else { $null }
  $nextDueAt = if ($state -and $state.nextDueAt) { [string] $state.nextDueAt } else { $null }
  $telegramChannel = $null
  if ($AssistantHealthMarker -and $AssistantHealthMarker.channels) {
    foreach ($channel in @($AssistantHealthMarker.channels)) {
      if ($null -eq $channel) { continue }
      if ([string] $channel.name -ne 'telegram') { continue }
      $configured = $false
      if ($channel.PSObject.Properties.Name -contains 'configured') {
        $configured = [bool] $channel.configured
      }
      if ($configured) {
        $telegramChannel = $channel
        break
      }
    }
  }

  if ($null -eq $telegramChannel) {
    return [pscustomobject]@{
      status = 'unconfigured'
      detail = 'Telegram roundtrip checks are not configured for this runtime.'
      updatedAt = if ($state) { [string] $state.updatedAt } else { $null }
      lastOkAt = $lastOkAt
      lastProbeAt = $lastProbeAt
      nextDueAt = $nextDueAt
      due = $false
    }
  }

  $now = [DateTime]::UtcNow
  $readyAtText = if ($ReadyState -and $ReadyState.readyAt) {
    [string] $ReadyState.readyAt
  } elseif ($HostState -and $HostState.readyAt) {
    [string] $HostState.readyAt
  } else {
    ''
  }
  $readyAt = [DateTime]::MinValue
  $hasReadyAt = -not [string]::IsNullOrWhiteSpace($readyAtText) -and [DateTime]::TryParse($readyAtText, [ref] $readyAt)
  $inStartupGrace = $hasReadyAt -and (($now - $readyAt.ToUniversalTime()).TotalSeconds -lt $StartupGraceSeconds)

  if ($null -eq $state) {
    return [pscustomobject]@{
      status = if ($inStartupGrace) { 'pending' } else { 'missing' }
      detail = if ($inStartupGrace) {
        'Waiting for the first Telegram roundtrip confirmation after startup.'
      } else {
        'Telegram roundtrip health marker is missing.'
      }
      updatedAt = $null
      lastOkAt = $null
      lastProbeAt = $null
      nextDueAt = $null
      due = -not $inStartupGrace
    }
  }

  if ([string] $state.status -eq 'unconfigured') {
    return [pscustomobject]@{
      status = 'unconfigured'
      detail = if ([string]::IsNullOrWhiteSpace([string] $state.detail)) {
        'Telegram user-session probe is not configured on this machine.'
      } else {
        [string] $state.detail
      }
      updatedAt = [string] $state.updatedAt
      lastOkAt = $lastOkAt
      lastProbeAt = $lastProbeAt
      nextDueAt = $nextDueAt
      due = $false
    }
  }

  if (
    $HostState -and
    -not [string]::IsNullOrWhiteSpace([string] $HostState.bootId) -and
    -not [string]::IsNullOrWhiteSpace([string] $state.bootId) -and
    [string] $state.bootId -ne [string] $HostState.bootId
  ) {
    return [pscustomobject]@{
      status = if ($inStartupGrace) { 'pending' } else { 'degraded' }
      detail = if ($inStartupGrace) {
        'Telegram roundtrip is waiting for post-restart confirmation.'
      } else {
        'Telegram roundtrip health is from an older assistant boot.'
      }
      updatedAt = [string] $state.updatedAt
      lastOkAt = $lastOkAt
      lastProbeAt = $lastProbeAt
      nextDueAt = $nextDueAt
      due = -not $inStartupGrace
    }
  }

  $computedNextDue = [DateTime]::MinValue
  $hasComputedNextDue = $false
  if (-not [string]::IsNullOrWhiteSpace($nextDueAt) -and [DateTime]::TryParse($nextDueAt, [ref] $computedNextDue)) {
    $hasComputedNextDue = $true
  } elseif (-not [string]::IsNullOrWhiteSpace($lastOkAt)) {
    $lastSuccess = [DateTime]::MinValue
    if ([DateTime]::TryParse($lastOkAt, [ref] $lastSuccess)) {
      $computedNextDue = $lastSuccess.ToUniversalTime().AddSeconds($ProbeIntervalSeconds)
      $hasComputedNextDue = $true
      $nextDueAt = $computedNextDue.ToString('o')
    }
  }

  $due = $true
  if ($hasComputedNextDue) {
    $due = $now -ge $computedNextDue.ToUniversalTime()
  }

  if ([string] $state.status -eq 'healthy' -and -not $due) {
    return [pscustomobject]@{
      status = 'healthy'
      detail = if ([string]::IsNullOrWhiteSpace([string] $state.detail)) {
        'Telegram roundtrip is healthy and within cadence.'
      } else {
        [string] $state.detail
      }
      updatedAt = [string] $state.updatedAt
      lastOkAt = $lastOkAt
      lastProbeAt = $lastProbeAt
      nextDueAt = $nextDueAt
      due = $false
    }
  }

  if ([string] $state.status -eq 'pending' -and $inStartupGrace) {
    return [pscustomobject]@{
      status = 'pending'
      detail = if ([string]::IsNullOrWhiteSpace([string] $state.detail)) {
        'Telegram roundtrip is pending during the startup grace window.'
      } else {
        [string] $state.detail
      }
      updatedAt = [string] $state.updatedAt
      lastOkAt = $lastOkAt
      lastProbeAt = $lastProbeAt
      nextDueAt = $nextDueAt
      due = $false
    }
  }

  return [pscustomobject]@{
    status = 'degraded'
    detail = if ([string]::IsNullOrWhiteSpace([string] $state.detail)) {
      'Telegram roundtrip has not succeeded recently enough to trust Telegram responsiveness.'
    } else {
      [string] $state.detail
    }
    updatedAt = [string] $state.updatedAt
    lastOkAt = $lastOkAt
    lastProbeAt = $lastProbeAt
    nextDueAt = $nextDueAt
    due = $due
  }
}

function Get-TelegramTransportStatus {
  param([object] $AssistantHealthMarker = $null)

  $telegramChannel = $null
  if ($AssistantHealthMarker -and $AssistantHealthMarker.channels) {
    foreach ($channel in @($AssistantHealthMarker.channels)) {
      if ($null -eq $channel) { continue }
      if ([string] $channel.name -ne 'telegram') { continue }
      $configured = $false
      if ($channel.PSObject.Properties.Name -contains 'configured') {
        $configured = [bool] $channel.configured
      }
      if ($configured) {
        $telegramChannel = $channel
        break
      }
    }
  }

  if ($null -eq $telegramChannel) {
    return [pscustomobject]@{
      mode = 'long_polling'
      status = 'unconfigured'
      detail = 'Telegram channel is not configured in this runtime.'
      updatedAt = $null
      lastError = $null
      lastErrorClass = 'none'
      webhookPresent = $false
      webhookUrl = $null
      lastWebhookCheckAt = $null
      lastPollConflictAt = $null
      externalConsumerSuspected = $false
      tokenRotationRequired = $false
      externalBlocker = 'none'
    }
  }

  $state = Read-JsonFile $telegramTransportPath
  if ($null -eq $state) {
    return [pscustomobject]@{
      mode = 'long_polling'
      status = 'degraded'
      detail = 'Telegram transport state marker is missing.'
      updatedAt = $null
      lastError = $null
      lastErrorClass = 'none'
      webhookPresent = $false
      webhookUrl = $null
      lastWebhookCheckAt = $null
      lastPollConflictAt = $null
      externalConsumerSuspected = $false
      tokenRotationRequired = $false
      externalBlocker = 'none'
    }
  }

  $externalBlocker = 'none'
  if ([bool] $state.tokenRotationRequired) {
    $externalBlocker = 'rotate_bot_token_and_retire_competing_consumer'
  } elseif ([bool] $state.externalConsumerSuspected) {
    $externalBlocker = 'competing_consumer_suspected'
  } elseif ([bool] $state.webhookPresent) {
    $externalBlocker = 'active_webhook_present'
  }

  return [pscustomobject]@{
    mode = if ([string]::IsNullOrWhiteSpace([string] $state.mode)) { 'long_polling' } else { [string] $state.mode }
    status = if ([string]::IsNullOrWhiteSpace([string] $state.status)) { 'degraded' } else { [string] $state.status }
    detail = if ([string]::IsNullOrWhiteSpace([string] $state.detail)) { 'Telegram transport state is missing detail.' } else { [string] $state.detail }
    updatedAt = if ($state.updatedAt) { [string] $state.updatedAt } else { $null }
    lastError = if ($state.lastError) { [string] $state.lastError } else { $null }
    lastErrorClass = if ($state.lastErrorClass) { [string] $state.lastErrorClass } else { 'none' }
    webhookPresent = [bool] $state.webhookPresent
    webhookUrl = if ($state.webhookUrl) { [string] $state.webhookUrl } else { $null }
    lastWebhookCheckAt = if ($state.lastWebhookCheckAt) { [string] $state.lastWebhookCheckAt } else { $null }
    lastPollConflictAt = if ($state.lastPollConflictAt) { [string] $state.lastPollConflictAt } else { $null }
    externalConsumerSuspected = [bool] $state.externalConsumerSuspected
    tokenRotationRequired = [bool] $state.tokenRotationRequired
    externalBlocker = $externalBlocker
  }
}

function Get-TelegramLiveProbeConfigStatus {
  $dotEnv = Read-DotEnv
  $apiId = Get-EnvValue -DotEnv $dotEnv -Key 'TELEGRAM_USER_API_ID'
  $apiHash = Get-EnvValue -DotEnv $dotEnv -Key 'TELEGRAM_USER_API_HASH'
  $session = Get-EnvValue -DotEnv $dotEnv -Key 'TELEGRAM_USER_SESSION'
  $sessionFile = Get-EnvValue -DotEnv $dotEnv -Key 'TELEGRAM_USER_SESSION_FILE'
  if ([string]::IsNullOrWhiteSpace($sessionFile)) {
    $sessionFile = Join-Path $projectRoot 'store\telegram-user.session'
  }
  $testTarget = Get-EnvValue -DotEnv $dotEnv -Key 'TELEGRAM_TEST_TARGET'
  $testChatId = Get-EnvValue -DotEnv $dotEnv -Key 'TELEGRAM_TEST_CHAT_ID'
  $botUsername = Get-EnvValue -DotEnv $dotEnv -Key 'TELEGRAM_BOT_USERNAME'
  $sessionPresent = -not [string]::IsNullOrWhiteSpace($session)
  if (-not $sessionPresent -and (Test-Path -LiteralPath $sessionFile)) {
    try {
      $sessionPresent = -not [string]::IsNullOrWhiteSpace((Get-Content -LiteralPath $sessionFile -Raw -ErrorAction Stop).Trim())
    } catch {
      $sessionPresent = $false
    }
  }
  $targetPresent = -not [string]::IsNullOrWhiteSpace($testTarget) -or -not [string]::IsNullOrWhiteSpace($testChatId) -or -not [string]::IsNullOrWhiteSpace($botUsername)

  if ([string]::IsNullOrWhiteSpace($apiId) -or [string]::IsNullOrWhiteSpace($apiHash)) {
    return [pscustomobject]@{
      configured = $false
      detail = 'Telegram user-session credentials are missing. Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH first.'
    }
  }

  if (-not $sessionPresent) {
    return [pscustomobject]@{
      configured = $false
      detail = ("Telegram user-session is missing. Run `npm run telegram:user:auth` and complete the login flow. Session file: {0}" -f $sessionFile)
    }
  }

  if (-not $targetPresent) {
    return [pscustomobject]@{
      configured = $false
      detail = 'Telegram test target is not configured. Set TELEGRAM_TEST_TARGET, TELEGRAM_TEST_CHAT_ID, or TELEGRAM_BOT_USERNAME.'
    }
  }

  return [pscustomobject]@{
    configured = $true
    detail = 'Telegram live /ping probe credentials are configured.'
  }
}

function Invoke-TelegramRoundtripProbe {
  param([switch] $Force)

  $nodeExe = Resolve-PinnedNodeExecutable
  $args = @(
    '.\node_modules\tsx\dist\cli.mjs',
    'src\telegram-user-session.ts',
    'probe'
  )
  if ($Force) {
    $args += '--force'
  }

  $output = & $nodeExe @args 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  $assistantHealthMarker = Read-JsonFile $assistantHealthPath
  $assessment = Get-TelegramRoundtripStatus -AssistantHealthMarker $assistantHealthMarker -HostState (Read-JsonFile $hostStatePath) -ReadyState (Read-JsonFile $readyStatePath)

  return [pscustomobject]@{
    exitCode = $exitCode
    output = $output.Trim()
    assessment = $assessment
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
    Start-Watchdog
    return
  }

  Ensure-HostDirectories
  Ensure-BuildArtifacts
  $nodeExe = Resolve-PinnedNodeExecutable
  $nodeVersion = Resolve-PinnedNodeVersion
  $bootId = [guid]::NewGuid().ToString()
  $startedAt = [DateTime]::UtcNow.ToString('o')

  Remove-FileIfExists $readyStatePath
  Remove-FileIfExists $assistantHealthPath
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
    Start-Watchdog
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
  Remove-FileIfExists $assistantHealthPath
  throw $lastError
}

function Stop-NanoClaw {
  Stop-Watchdog

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
  Remove-FileIfExists $assistantHealthPath
  Remove-FileIfExists $telegramTransportPath
  Write-HostState -Phase 'stopped' -BootId '' -NodePath '' -NodeVersion '' -StartedAt '' -InstallModeValue $InstallMode
}

function Ensure-NanoClaw {
  $hostState = Read-JsonFile $hostStatePath
  $readyState = Read-JsonFile $readyStatePath
  $assistantHealthMarker = Read-JsonFile $assistantHealthPath
  $runtimePid = Read-Pid
  $processRunning = $false

  if ($runtimePid) {
    $processRunning = Test-RepoProcess -ProcessId $runtimePid
  }

  if (-not $processRunning) {
    Write-HostStep 'Periodic ensure check detected no healthy NanoClaw process; starting a fresh instance'
    Start-NanoClaw
    return
  }

  if (
    $null -eq $hostState -or
    $null -eq $readyState -or
    [string] $hostState.bootId -ne [string] $readyState.bootId -or
    [int] $readyState.pid -ne [int] $runtimePid
  ) {
    Write-HostStep 'Periodic ensure check found a stale ready marker or host state; restarting NanoClaw'
    Stop-NanoClaw
    Start-Sleep -Milliseconds 700
    Start-NanoClaw
    return
  }

  $assistantHealth = Get-AssistantHealthStatus -HostState $hostState -ReadyState $readyState -RuntimePid $runtimePid
  $telegramTransport = Get-TelegramTransportStatus -AssistantHealthMarker $assistantHealthMarker
  $telegramRoundtrip = Get-TelegramRoundtripStatus -AssistantHealthMarker $assistantHealthMarker -HostState $hostState -ReadyState $readyState
  $telegramProbeConfig = Get-TelegramLiveProbeConfigStatus

  if ([string] $telegramTransport.status -eq 'blocked') {
    Write-HostStep ("Periodic ensure check detected an external Telegram blocker and will not restart blindly: {0}" -f ([string] $telegramTransport.detail))
    Start-Watchdog
    Write-Output ("HOST_ENSURE: status=degraded pid={0} telegram_transport={1} telegram_roundtrip={2} blocker={3}" -f $runtimePid, ([string] $telegramTransport.status), ([string] $telegramRoundtrip.status), ([string] $telegramTransport.externalBlocker))
    return
  }

  if ([string] $assistantHealth.status -eq 'healthy') {
    if ($telegramRoundtrip.due) {
      $probe = Invoke-TelegramRoundtripProbe
      $telegramRoundtrip = $probe.assessment
      if ([string] $telegramRoundtrip.status -eq 'degraded') {
        Start-Sleep -Seconds 15
        $retryProbe = Invoke-TelegramRoundtripProbe -Force
        $telegramRoundtrip = $retryProbe.assessment
        if ([string] $telegramRoundtrip.status -eq 'degraded') {
          Write-HostStep ("Periodic ensure check detected Telegram roundtrip failure after retry: {0}" -f ([string] $telegramRoundtrip.detail))
          Stop-NanoClaw
          Start-Sleep -Milliseconds 700
          Start-NanoClaw
          Start-Sleep -Seconds 10
          $confirmProbe = Invoke-TelegramRoundtripProbe -Force
          $telegramRoundtrip = $confirmProbe.assessment
        }
      }
    }

    Start-Watchdog
    $ensureStatus = if (
      [string] $telegramTransport.status -eq 'ready' -and
      ([string] $telegramRoundtrip.status -eq 'healthy' -or -not [bool] $telegramProbeConfig.configured)
    ) {
      'healthy'
    } else {
      'degraded'
    }
    Write-Output ("HOST_ENSURE: status={0} pid={1} telegram_transport={2} telegram_roundtrip={3}" -f $ensureStatus, $runtimePid, ([string] $telegramTransport.status), ([string] $telegramRoundtrip.status))
    return
  }

  $assistantHealthDetail = [string] $assistantHealth.detail
  $telegramOnlyIssue =
    [string] $assistantHealth.status -eq 'degraded' -and
    -not [string]::IsNullOrWhiteSpace($assistantHealthDetail) -and
    $assistantHealthDetail.StartsWith('telegram:', [System.StringComparison]::OrdinalIgnoreCase)

  if ($telegramOnlyIssue -and [string] $telegramRoundtrip.status -eq 'unconfigured') {
    Write-HostStep 'Periodic ensure check detected Telegram degradation, but live roundtrip probing is unconfigured; leaving the current process running and reporting degraded truthfully'
    Start-Watchdog
    Write-Output ("HOST_ENSURE: status=degraded pid={0} telegram_transport={1} telegram_roundtrip={2}" -f $runtimePid, ([string] $telegramTransport.status), ([string] $telegramRoundtrip.status))
    return
  }

  if ($telegramOnlyIssue -and [string] $telegramTransport.status -eq 'blocked') {
    Write-HostStep ("Periodic ensure check detected Telegram degradation caused by an external consumer; leaving the current process running. {0}" -f ([string] $telegramTransport.detail))
    Start-Watchdog
    Write-Output ("HOST_ENSURE: status=degraded pid={0} telegram_transport={1} telegram_roundtrip={2} blocker={3}" -f $runtimePid, ([string] $telegramTransport.status), ([string] $telegramRoundtrip.status), ([string] $telegramTransport.externalBlocker))
    return
  }

  Write-HostStep ("Periodic ensure check detected assistant health {0}: {1}" -f ([string] $assistantHealth.status), ([string] $assistantHealth.detail))
  Stop-NanoClaw
  Start-Sleep -Milliseconds 700
  Start-NanoClaw
}

function Show-Status {
  $hostState = Read-JsonFile $hostStatePath
  $readyState = Read-JsonFile $readyStatePath
  $assistantHealthMarker = Read-JsonFile $assistantHealthPath
  $runtimeAudit = Read-JsonFile $runtimeAuditPath
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
  $assistantHealth = Get-AssistantHealthStatus -HostState $hostState -ReadyState $readyState -RuntimePid $runtimePid
  $telegramTransport = Get-TelegramTransportStatus -AssistantHealthMarker $assistantHealthMarker
  $telegramRoundtrip = Get-TelegramRoundtripStatus -AssistantHealthMarker $assistantHealthMarker -HostState $hostState -ReadyState $readyState
  $telegramProbeConfig = Get-TelegramLiveProbeConfigStatus
  $alexaLocal = Get-AlexaLocalStatus -DotEnv (Read-DotEnv)
  $alexaPublic = Get-AlexaPublicStatus -DotEnv (Read-DotEnv) -LocalStatus $alexaLocal
  $watchdog = Get-WatchdogSnapshot
  $activeRepoRoot = if ($runtimeAudit -and $runtimeAudit.activeRepoRoot) { [string] $runtimeAudit.activeRepoRoot } else { $projectRoot }
  $activeGitBranch = if ($runtimeAudit -and $runtimeAudit.activeGitBranch) { [string] $runtimeAudit.activeGitBranch } else { 'unknown' }
  $activeGitCommit = if ($runtimeAudit -and $runtimeAudit.activeGitCommit) { [string] $runtimeAudit.activeGitCommit } else { 'unknown' }
  $activeEntryPath = if ($runtimeAudit -and $runtimeAudit.activeEntryPath) { [string] $runtimeAudit.activeEntryPath } else { $entryPath }
  $activeEnvPath = if ($runtimeAudit -and $runtimeAudit.activeEnvPath) { [string] $runtimeAudit.activeEnvPath } else { (Join-Path $projectRoot '.env') }
  $activeStoreDbPath = if ($runtimeAudit -and $runtimeAudit.activeStoreDbPath) { [string] $runtimeAudit.activeStoreDbPath } else { (Join-Path $projectRoot 'store\\messages.db') }
  $activeRuntimeStateDir = if ($runtimeAudit -and $runtimeAudit.activeRuntimeStateDir) { [string] $runtimeAudit.activeRuntimeStateDir } else { $runtimeDir }
  $assistantName = if ($runtimeAudit -and $runtimeAudit.assistantName) { [string] $runtimeAudit.assistantName } else { 'unknown' }
  $assistantNameSource = if ($runtimeAudit -and $runtimeAudit.assistantNameSource) { [string] $runtimeAudit.assistantNameSource } else { 'unknown' }
  $registeredMainChatJid = if ($runtimeAudit -and $runtimeAudit.registeredMainChatJid) { [string] $runtimeAudit.registeredMainChatJid } else { 'none' }
  $registeredMainChatName = if ($runtimeAudit -and $runtimeAudit.registeredMainChatName) { [string] $runtimeAudit.registeredMainChatName } else { 'none' }
  $registeredMainChatFolder = if ($runtimeAudit -and $runtimeAudit.registeredMainChatFolder) { [string] $runtimeAudit.registeredMainChatFolder } else { 'none' }
  $registeredMainChatPresentInChats = if ($runtimeAudit) { [string] [bool] $runtimeAudit.registeredMainChatPresentInChats } else { 'false' }
  $latestTelegramChatJid = if ($runtimeAudit -and $runtimeAudit.latestTelegramChatJid) { [string] $runtimeAudit.latestTelegramChatJid } else { 'none' }
  $latestTelegramChatName = if ($runtimeAudit -and $runtimeAudit.latestTelegramChatName) { [string] $runtimeAudit.latestTelegramChatName } else { 'none' }
  $mainChatAuditWarning = if ($runtimeAudit -and $runtimeAudit.mainChatAuditWarning) { [string] $runtimeAudit.mainChatAuditWarning } else { 'none' }

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
  Write-Output ("HOST_STATUS: assistant_health={0}" -f ([string] $assistantHealth.status))
  Write-Output ("HOST_STATUS: assistant_health_detail={0}" -f ([string] $assistantHealth.detail))
  Write-Output ("HOST_STATUS: assistant_health_updated_at={0}" -f ($(if ($assistantHealth.updatedAt) { [string] $assistantHealth.updatedAt } else { 'none' })))
  Write-Output ("HOST_STATUS: alexa_configured={0}" -f ([string] $alexaLocal.configured).ToLowerInvariant())
  Write-Output ("HOST_STATUS: alexa_bind={0}" -f ([string] $alexaLocal.bind))
  Write-Output ("HOST_STATUS: alexa_health_path={0}" -f ([string] $alexaLocal.healthPath))
  Write-Output ("HOST_STATUS: alexa_listener_health={0}" -f ([string] $alexaLocal.listenerHealth))
  Write-Output ("HOST_STATUS: alexa_listener_detail={0}" -f ([string] $alexaLocal.listenerDetail))
  Write-Output ("HOST_STATUS: alexa_oauth_health_path={0}" -f ([string] $alexaLocal.oauthHealthPath))
  Write-Output ("HOST_STATUS: alexa_oauth_health={0}" -f ([string] $alexaLocal.oauthHealth))
  Write-Output ("HOST_STATUS: alexa_oauth_detail={0}" -f ([string] $alexaLocal.oauthDetail))
  Write-Output ("HOST_STATUS: alexa_public_base_url={0}" -f ([string] $alexaPublic.baseUrl))
  Write-Output ("HOST_STATUS: alexa_public_endpoint_url={0}" -f ([string] $alexaPublic.endpointUrl))
  Write-Output ("HOST_STATUS: alexa_public_health_url={0}" -f ([string] $alexaPublic.healthUrl))
  Write-Output ("HOST_STATUS: alexa_public_oauth_health_url={0}" -f ([string] $alexaPublic.oauthHealthUrl))
  Write-Output ("HOST_STATUS: alexa_public_ingress_kind={0}" -f ([string] $alexaPublic.ingressKind))
  Write-Output ("HOST_STATUS: alexa_public_certificate_hint={0}" -f ([string] $alexaPublic.certificateHint))
  Write-Output ("HOST_STATUS: alexa_public_browser_hint={0}" -f ([string] $alexaPublic.browserHint))
  Write-Output ("HOST_STATUS: alexa_public_listener_health={0}" -f ([string] $alexaPublic.listenerHealth))
  Write-Output ("HOST_STATUS: alexa_public_listener_detail={0}" -f ([string] $alexaPublic.listenerDetail))
  Write-Output ("HOST_STATUS: alexa_public_oauth_health={0}" -f ([string] $alexaPublic.oauthHealth))
  Write-Output ("HOST_STATUS: alexa_public_oauth_detail={0}" -f ([string] $alexaPublic.oauthDetail))
  Write-Output ("HOST_STATUS: telegram_transport_mode={0}" -f ([string] $telegramTransport.mode))
  Write-Output ("HOST_STATUS: telegram_transport_health={0}" -f ([string] $telegramTransport.status))
  Write-Output ("HOST_STATUS: telegram_transport_detail={0}" -f ([string] $telegramTransport.detail))
  Write-Output ("HOST_STATUS: telegram_external_blocker={0}" -f ([string] $telegramTransport.externalBlocker))
  Write-Output ("HOST_STATUS: telegram_token_rotation_required={0}" -f ([string] $telegramTransport.tokenRotationRequired).ToLowerInvariant())
  Write-Output ("HOST_STATUS: telegram_last_error={0}" -f ($(if ($telegramTransport.lastError) { [string] $telegramTransport.lastError } else { 'none' })))
  Write-Output ("HOST_STATUS: telegram_last_error_class={0}" -f ([string] $telegramTransport.lastErrorClass))
  Write-Output ("HOST_STATUS: telegram_transport_updated_at={0}" -f ($(if ($telegramTransport.updatedAt) { [string] $telegramTransport.updatedAt } else { 'none' })))
  Write-Output ("HOST_STATUS: telegram_webhook_present={0}" -f ([string] $telegramTransport.webhookPresent).ToLowerInvariant())
  Write-Output ("HOST_STATUS: telegram_webhook_url={0}" -f ($(if ($telegramTransport.webhookUrl) { [string] $telegramTransport.webhookUrl } else { 'none' })))
  Write-Output ("HOST_STATUS: telegram_roundtrip_health={0}" -f ([string] $telegramRoundtrip.status))
  Write-Output ("HOST_STATUS: telegram_roundtrip_detail={0}" -f ([string] $telegramRoundtrip.detail))
  Write-Output ("HOST_STATUS: telegram_live_probe_configured={0}" -f ([string] $telegramProbeConfig.configured).ToLowerInvariant())
  Write-Output ("HOST_STATUS: telegram_live_probe_detail={0}" -f ([string] $telegramProbeConfig.detail))
  Write-Output ("HOST_STATUS: telegram_roundtrip_last_ok_at={0}" -f ($(if ($telegramRoundtrip.lastOkAt) { [string] $telegramRoundtrip.lastOkAt } else { 'none' })))
  Write-Output ("HOST_STATUS: telegram_roundtrip_last_probe_at={0}" -f ($(if ($telegramRoundtrip.lastProbeAt) { [string] $telegramRoundtrip.lastProbeAt } else { 'none' })))
  Write-Output ("HOST_STATUS: telegram_roundtrip_next_due_at={0}" -f ($(if ($telegramRoundtrip.nextDueAt) { [string] $telegramRoundtrip.nextDueAt } else { 'none' })))
  Write-Output ("HOST_STATUS: active_repo_root={0}" -f $activeRepoRoot)
  Write-Output ("HOST_STATUS: active_git_branch={0}" -f $activeGitBranch)
  Write-Output ("HOST_STATUS: active_git_commit={0}" -f $activeGitCommit)
  Write-Output ("HOST_STATUS: active_entry_path={0}" -f $activeEntryPath)
  Write-Output ("HOST_STATUS: active_env_path={0}" -f $activeEnvPath)
  Write-Output ("HOST_STATUS: active_store_db_path={0}" -f $activeStoreDbPath)
  Write-Output ("HOST_STATUS: active_runtime_state_dir={0}" -f $activeRuntimeStateDir)
  Write-Output ("HOST_STATUS: assistant_name={0}" -f $assistantName)
  Write-Output ("HOST_STATUS: assistant_name_source={0}" -f $assistantNameSource)
  Write-Output ("HOST_STATUS: registered_main_chat_jid={0}" -f $registeredMainChatJid)
  Write-Output ("HOST_STATUS: registered_main_chat_name={0}" -f $registeredMainChatName)
  Write-Output ("HOST_STATUS: registered_main_chat_folder={0}" -f $registeredMainChatFolder)
  Write-Output ("HOST_STATUS: registered_main_chat_present_in_chats={0}" -f $registeredMainChatPresentInChats.ToLowerInvariant())
  Write-Output ("HOST_STATUS: latest_telegram_chat_jid={0}" -f $latestTelegramChatJid)
  Write-Output ("HOST_STATUS: latest_telegram_chat_name={0}" -f $latestTelegramChatName)
  Write-Output ("HOST_STATUS: main_chat_audit_warning={0}" -f $mainChatAuditWarning)
  Write-Output ("HOST_STATUS: watchdog_running={0}" -f ([string] $watchdog.running).ToLowerInvariant())
  Write-Output ("HOST_STATUS: watchdog_pid={0}" -f ($(if ($watchdog.pid) { [string] $watchdog.pid } else { 'none' })))
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
    'ensure' {
      Ensure-NanoClaw
      break
    }
    'status' {
      Show-Status
      break
    }
  }
} catch {
  if ($Command -eq 'start' -or $Command -eq 'restart' -or $Command -eq 'ensure') {
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
