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
$backendStatePath = Join-Path $runtimeDir 'andrea-openai-backend-state.json'
$ngrokStatePath = Join-Path $runtimeDir 'ngrok-state.json'
$gatewayStartScript = Join-Path $projectRoot 'scripts\start-openai-gateway.ps1'
$gatewayStopScript = Join-Path $projectRoot 'scripts\stop-openai-gateway.ps1'
$pinnedNodeLauncher = Join-Path $projectRoot 'scripts\run-with-pinned-node.mjs'
$compatibilityShimPath = Join-Path $projectRoot 'start-nanoclaw.ps1'
$envPath = Join-Path $projectRoot '.env'
$startupFolderScriptPath = if ($env:APPDATA) {
  Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\nanoclaw-start.cmd'
} else {
  $null
}
$defaultBackendProjectRoot = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Andrea_OpenAI_Bot'

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
  $json = $Value | ConvertTo-Json -Depth 10
  Set-Content -LiteralPath $Path -Value $json -NoNewline
}

function Get-ParsedEnvFile {
  param([string] $Path)

  $result = @{}
  if (!(Test-Path -LiteralPath $Path)) {
    return $result
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { return }
    $parts = $line.Split('=', 2)
    if ($parts.Length -ne 2) { return }
    $key = $parts[0].Trim()
    $value = $parts[1].Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"') -and $value.Length -ge 2) {
      $value = $value.Substring(1, $value.Length - 2)
    } elseif ($value.StartsWith("'") -and $value.EndsWith("'") -and $value.Length -ge 2) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $result[$key] = $value
  }

  return $result
}

function Get-EnvConfig {
  return Get-ParsedEnvFile -Path $envPath
}

function Command-Exists {
  param([string] $Name)

  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
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
    $isLegacy = [string] $currentStartup -match 'Desktop\\ANDREA\\nanoclaw' -or [string] $currentStartup -match 'start-nanoclaw\.ps1'
    if ($isLegacy -or ($currentStartup -replace "`r", '').TrimEnd() -ne ($canonicalStartup -replace "`r", '').TrimEnd()) {
      Set-Content -LiteralPath $startupFolderScriptPath -Value ($canonicalStartup + "`r`n")
      Write-HostStep ("Repaired startup-folder script at {0}" -f $startupFolderScriptPath)
    }
  }
}

function Read-PidFromFile {
  param([string] $Path)
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  try {
    $raw = (Get-Content -LiteralPath $Path -ErrorAction Stop | Select-Object -First 1).Trim()
    if ($raw -match '^[0-9]+$') { return [int] $raw }
  } catch {
    return $null
  }
  return $null
}

function Read-Pid {
  return Read-PidFromFile -Path $pidFile
}

function Remove-FileIfExists {
  param([string] $Path)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  }
}

function Test-RepoProcess {
  param(
    [int] $ProcessId,
    [string] $Root = $projectRoot
  )

  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return $false }
    $cmd = [string] $proc.CommandLine
    $projectPattern = [Regex]::Escape($Root)
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
  param(
    [string] $Root = $projectRoot,
    [string] $EntryPath = $entryPath,
    [string] $NodeExe
  )

  if (Test-Path -LiteralPath $EntryPath) { return }

  $tscPath = Join-Path $Root 'node_modules\typescript\bin\tsc'
  if (!(Test-Path -LiteralPath $tscPath)) {
    throw "TypeScript compiler not found at $tscPath"
  }

  Write-HostStep ("Building TypeScript artifacts in {0}" -f $Root)
  Push-Location $Root
  try {
    & $NodeExe $tscPath
    if ($LASTEXITCODE -ne 0) {
      throw 'TypeScript build failed.'
    }
  } finally {
    Pop-Location
  }

  if (!(Test-Path -LiteralPath $EntryPath)) {
    throw "Expected build artifact missing after compilation: $EntryPath"
  }
}

function Get-ScheduledTaskInstalled {
  try {
    & schtasks.exe /Query /TN 'NanoClaw' *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Get-StartupFallbackInstalled {
  return $startupFolderScriptPath -and (Test-Path -LiteralPath $startupFolderScriptPath)
}

function Test-HealthJson {
  param(
    [string] $Url,
    [int] $TimeoutSec = 4
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
      return [pscustomobject]@{
        ok = $false
        status = $response.StatusCode
        detail = "HTTP $($response.StatusCode)"
        body = $null
      }
    }

    $body = $null
    if (-not [string]::IsNullOrWhiteSpace([string] $response.Content)) {
      try {
        $body = $response.Content | ConvertFrom-Json -ErrorAction Stop
      } catch {
        $body = $response.Content
      }
    }

    return [pscustomobject]@{
      ok = $true
      status = $response.StatusCode
      detail = 'ok'
      body = $body
    }
  } catch {
    return [pscustomobject]@{
      ok = $false
      status = 0
      detail = $_.Exception.Message
      body = $null
    }
  }
}

function Get-AlexaConfig {
  param([hashtable] $EnvMap)

  $path = [string] ($EnvMap['ALEXA_PATH'])
  if ([string]::IsNullOrWhiteSpace($path)) {
    $path = '/alexa'
  }
  if (-not $path.StartsWith('/')) {
    $path = "/$path"
  }

  $alexaHost = [string] ($EnvMap['ALEXA_HOST'])
  if ([string]::IsNullOrWhiteSpace($alexaHost)) {
    $alexaHost = '127.0.0.1'
  }

  $port = [string] ($EnvMap['ALEXA_PORT'])
  if ([string]::IsNullOrWhiteSpace($port)) {
    $port = '4300'
  }

  $configured = -not [string]::IsNullOrWhiteSpace([string] $EnvMap['ALEXA_SKILL_ID'])
  $baseUrl = "http://$alexaHost`:$port$path"

  return [pscustomobject]@{
    configured = $configured
    host = $alexaHost
    port = $port
    path = $path
    baseUrl = $baseUrl
    healthUrl = "$baseUrl/health"
    oauthHealthUrl = "$baseUrl/oauth/health"
  }
}

function Get-AlexaHealth {
  param([hashtable] $EnvMap)

  $config = Get-AlexaConfig -EnvMap $EnvMap
  if (-not $config.configured) {
    return [pscustomobject]@{
      configured = $false
      local = 'skipped'
      oauth = 'skipped'
      detail = 'Alexa not configured in local env.'
    }
  }

  $health = Test-HealthJson -Url $config.healthUrl
  $oauth = Test-HealthJson -Url $config.oauthHealthUrl
  $detail = if ($health.ok -and $oauth.ok) {
    'ok'
  } else {
    "local=$($health.detail); oauth=$($oauth.detail)"
  }

  return [pscustomobject]@{
    configured = $true
    local = if ($health.ok) { 'ok' } else { 'failed' }
    oauth = if ($oauth.ok) { 'ok' } else { 'failed' }
    detail = $detail
    healthUrl = $config.healthUrl
    oauthHealthUrl = $config.oauthHealthUrl
  }
}

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath,

    [string[]] $Arguments = @()
  )

  $output = ''
  $exitCode = 0

  try {
    $result = & $FilePath @Arguments 2>&1
    $exitCode = if ($null -ne $LASTEXITCODE) { [int] $LASTEXITCODE } else { 0 }
    $output = ($result | Out-String).Trim()
  } catch {
    $exitCode = if ($null -ne $LASTEXITCODE -and [int] $LASTEXITCODE -ne 0) {
      [int] $LASTEXITCODE
    } else {
      1
    }
    $output = $_.Exception.Message
  }

  return [pscustomobject]@{
    exitCode = $exitCode
    output = $output
  }
}

function Get-GatewayRequirement {
  param([hashtable] $EnvMap)

  $openAiApiKey = [string] ($EnvMap['OPENAI_API_KEY'])
  $anthropicBaseUrl = [string] ($EnvMap['ANTHROPIC_BASE_URL'])
  $openAiBaseUrl = [string] ($EnvMap['OPENAI_BASE_URL'])
  $anthropicDirectCredentialConfigured = (
    $EnvMap['CLAUDE_CODE_OAUTH_TOKEN'] -or
    $EnvMap['ANTHROPIC_API_KEY'] -or
    $EnvMap['ANTHROPIC_AUTH_TOKEN']
  )

  $openAiCompatEndpoint = $anthropicBaseUrl
  if ([string]::IsNullOrWhiteSpace($openAiCompatEndpoint)) {
    $openAiCompatEndpoint = $openAiBaseUrl
  }

  if ([string]::IsNullOrWhiteSpace($openAiApiKey)) {
    return [pscustomobject]@{
      required = $false
      reason = 'no_openai_api_key'
      detail = 'OpenAI gateway is not required because OPENAI_API_KEY is not configured.'
    }
  }

  if ($anthropicDirectCredentialConfigured -and [string]::IsNullOrWhiteSpace($openAiCompatEndpoint)) {
    return [pscustomobject]@{
      required = $false
      reason = 'anthropic_direct_credentials'
      detail = 'OpenAI gateway is not required because Anthropic-direct credentials are configured.'
    }
  }

  return [pscustomobject]@{
    required = $true
    reason = 'openai_gateway_required'
    detail = 'OpenAI gateway is required for the current model runtime configuration.'
  }
}

function Get-PreferredContainerRuntime {
  param([hashtable] $EnvMap)

  $preferred = [string] ($EnvMap['CONTAINER_RUNTIME'])
  if ($preferred -eq 'docker' -or $preferred -eq 'podman') {
    return [pscustomobject]@{
      engine = $preferred
      configured = $true
      cliExists = [bool] (Command-Exists $preferred)
    }
  }

  if (Command-Exists 'docker') {
    return [pscustomobject]@{
      engine = 'docker'
      configured = $false
      cliExists = $true
    }
  }

  if (Command-Exists 'podman') {
    return [pscustomobject]@{
      engine = 'podman'
      configured = $false
      cliExists = $true
    }
  }

  return [pscustomobject]@{
    engine = 'none'
    configured = $false
    cliExists = $false
  }
}

function Ensure-ContainerRuntimeReady {
  param(
    [hashtable] $EnvMap,
    [bool] $Required,
    [bool] $AutoStartIfRequired = $false
  )

  $runtime = Get-PreferredContainerRuntime -EnvMap $EnvMap
  if (-not $Required) {
    return [pscustomobject]@{
      engine = [string] $runtime.engine
      status = 'skipped_not_required'
      detail = 'Container runtime is not required for the current Andrea configuration.'
      autoStarted = $false
    }
  }

  if ($runtime.engine -eq 'none') {
    return [pscustomobject]@{
      engine = 'none'
      status = 'failed'
      detail = 'No supported container runtime is installed.'
      autoStarted = $false
    }
  }

  if (-not $runtime.cliExists) {
    return [pscustomobject]@{
      engine = [string] $runtime.engine
      status = 'failed'
      detail = ("Configured container runtime '{0}' is not installed." -f $runtime.engine)
      autoStarted = $false
    }
  }

  $probeArgs = if ($runtime.engine -eq 'podman') {
    @('info', '--format', 'json')
  } else {
    @('info')
  }

  $probe = Invoke-NativeCommand -FilePath $runtime.engine -Arguments $probeArgs
  if ($probe.exitCode -eq 0) {
    return [pscustomobject]@{
      engine = [string] $runtime.engine
      status = 'ready'
      detail = ("{0} runtime is ready." -f $runtime.engine)
      autoStarted = $false
    }
  }

  if (
    $AutoStartIfRequired -and
    $runtime.engine -eq 'podman' -and
    $IsWindows
  ) {
    $startAttempt = Invoke-NativeCommand -FilePath $runtime.engine -Arguments @('machine', 'start')
    $retry = Invoke-NativeCommand -FilePath $runtime.engine -Arguments $probeArgs
    if ($retry.exitCode -eq 0) {
      return [pscustomobject]@{
        engine = [string] $runtime.engine
        status = 'ready'
        detail = 'podman runtime was started automatically and is now ready.'
        autoStarted = $true
      }
    }

    return [pscustomobject]@{
      engine = [string] $runtime.engine
      status = 'failed'
      detail = ("podman runtime is not ready. start_attempt={0}; probe={1}" -f $startAttempt.output, $retry.output)
      autoStarted = $true
    }
  }

  return [pscustomobject]@{
    engine = [string] $runtime.engine
    status = 'failed'
    detail = ("{0} runtime is not ready. {1}" -f $runtime.engine, $probe.output)
    autoStarted = $false
  }
}

function Start-Gateway {
  param([hashtable] $EnvMap)

  $requirement = Get-GatewayRequirement -EnvMap $EnvMap
  $runtimeStatus = Ensure-ContainerRuntimeReady -EnvMap $EnvMap -Required:$requirement.required -AutoStartIfRequired:$true

  if (-not $requirement.required) {
    return [pscustomobject]@{
      status = 'skipped'
      detail = $requirement.detail
      reason = $requirement.reason
      engine = [string] $runtimeStatus.engine
      engineStatus = [string] $runtimeStatus.status
    }
  }

  if ($runtimeStatus.status -ne 'ready') {
    return [pscustomobject]@{
      status = 'failed'
      detail = ("Container runtime not ready for OpenAI gateway startup. {0}" -f $runtimeStatus.detail)
      engine = [string] $runtimeStatus.engine
      engineStatus = [string] $runtimeStatus.status
    }
  }

  if (!(Test-Path -LiteralPath $gatewayStartScript)) {
    return [pscustomobject]@{
      status = 'skipped'
      detail = 'OpenAI gateway start script not present.'
      engine = [string] $runtimeStatus.engine
      engineStatus = [string] $runtimeStatus.status
    }
  }

  try {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $gatewayStartScript 2>&1
    if ($LASTEXITCODE -ne 0) {
      return [pscustomobject]@{
        status = 'failed'
        detail = (($output | Out-String).Trim())
        engine = [string] $runtimeStatus.engine
        engineStatus = [string] $runtimeStatus.status
      }
    }

    $detail = (($output | Out-String).Trim())
    if ($detail -match '^OPENAI_GATEWAY_SKIPPED\b') {
      return [pscustomobject]@{
        status = 'skipped'
        detail = $detail
        engine = [string] $runtimeStatus.engine
        engineStatus = [string] $runtimeStatus.status
      }
    }

    return [pscustomobject]@{
      status = 'ok'
      detail = $detail
      engine = [string] $runtimeStatus.engine
      engineStatus = [string] $runtimeStatus.status
    }
  } catch {
    return [pscustomobject]@{
      status = 'failed'
      detail = $_.Exception.Message
      engine = [string] $runtimeStatus.engine
      engineStatus = [string] $runtimeStatus.status
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

  $probe = Test-HealthJson -Url ([string] $gatewayState.host_health) -TimeoutSec 5
  if ($probe.ok) {
    return $null
  }

  return ("Local gateway health probe failed: {0}" -f $probe.detail)
}

function Get-BackendConfig {
  param([hashtable] $EnvMap)

  $enabled = [string] ($EnvMap['ANDREA_OPENAI_BACKEND_ENABLED']) -eq 'true'
  $backendRoot = [string] ($EnvMap['ANDREA_OPENAI_BACKEND_PROJECT_ROOT'])
  if ([string]::IsNullOrWhiteSpace($backendRoot)) {
    $backendRoot = $defaultBackendProjectRoot
  }

  return [pscustomobject]@{
    enabled = $enabled
    projectRoot = $backendRoot
    baseUrl = [string] ($EnvMap['ANDREA_OPENAI_BACKEND_URL'])
    timeoutMs = [string] ($EnvMap['ANDREA_OPENAI_BACKEND_TIMEOUT_MS'])
  }
}

function Get-BackendPaths {
  param([string] $BackendProjectRoot)

  return [pscustomobject]@{
    projectRoot = $BackendProjectRoot
    entryPath = Join-Path $BackendProjectRoot 'dist\index.js'
    pidFile = Join-Path $BackendProjectRoot 'andrea-openai-bot.pid'
    logDir = Join-Path $BackendProjectRoot 'logs'
    logPath = Join-Path $BackendProjectRoot 'logs\andrea-openai-bot.log'
    errLogPath = Join-Path $BackendProjectRoot 'logs\andrea-openai-bot.error.log'
    launchScriptPath = Join-Path $runtimeDir 'andrea-openai-backend-launch.ps1'
  }
}

function Get-BackendHealth {
  param([hashtable] $EnvMap)

  $backend = Get-BackendConfig -EnvMap $EnvMap
  if (-not $backend.enabled) {
    return [pscustomobject]@{
      configured = $false
      status = 'skipped'
      detail = 'Andrea_OpenAI_Bot loopback backend is not enabled.'
    }
  }

  $baseUrl = if ([string]::IsNullOrWhiteSpace($backend.baseUrl)) {
    'http://127.0.0.1:3210'
  } else {
    [string] $backend.baseUrl
  }

  $probe = Test-HealthJson -Url "$baseUrl/meta" -TimeoutSec 5
  if (-not $probe.ok) {
    return [pscustomobject]@{
      configured = $true
      status = 'failed'
      detail = $probe.detail
      baseUrl = $baseUrl
    }
  }

  return [pscustomobject]@{
    configured = $true
    status = 'ok'
    detail = 'ok'
    baseUrl = $baseUrl
    meta = $probe.body
  }
}

function Stop-Backend {
  $state = Read-JsonFile $backendStatePath
  if ($state -and $state.launcherPid -and "$($state.launcherPid)" -match '^[0-9]+$') {
    Stop-ProcessIfRunning -ProcessId ([int] $state.launcherPid) | Out-Null
  }

  $backendRoot = if ($state -and $state.projectRoot) {
    [string] $state.projectRoot
  } else {
    $defaultBackendProjectRoot
  }

  if (Test-Path -LiteralPath $backendRoot) {
    try {
      $projectPattern = [Regex]::Escape($backendRoot)
      $backendProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $cmd = [string] $_.CommandLine
        $cmd -match $projectPattern -and $cmd -match 'dist[\\/]index\.js'
      }
      foreach ($proc in $backendProcs) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
      }
    } catch {
      Write-HostStep ("Backend stop warning: {0}" -f $_.Exception.Message)
    }
  }

  Remove-FileIfExists $backendStatePath
}

function Start-Backend {
  param(
    [hashtable] $EnvMap,
    [string] $NodeExe
  )

  $backend = Get-BackendConfig -EnvMap $EnvMap
  if (-not $backend.enabled) {
    return [pscustomobject]@{
      status = 'skipped'
      detail = 'Andrea_OpenAI_Bot loopback backend is not enabled.'
    }
  }

  if (!(Test-Path -LiteralPath $backend.projectRoot)) {
    return [pscustomobject]@{
      status = 'failed'
      detail = "Andrea_OpenAI_Bot repo not found at $($backend.projectRoot)."
    }
  }

  $healthBefore = Get-BackendHealth -EnvMap $EnvMap
  if ($healthBefore.status -eq 'ok') {
    return [pscustomobject]@{
      status = 'ok'
      detail = 'Andrea_OpenAI_Bot backend already healthy.'
      baseUrl = $healthBefore.baseUrl
      existing = $true
    }
  }

  $paths = Get-BackendPaths -BackendProjectRoot $backend.projectRoot
  New-Item -ItemType Directory -Path $paths.logDir -Force | Out-Null
  Ensure-BuildArtifacts -Root $paths.projectRoot -EntryPath $paths.entryPath -NodeExe $NodeExe

  $baseUrl = if ([string]::IsNullOrWhiteSpace($backend.baseUrl)) {
    'http://127.0.0.1:3210'
  } else {
    [string] $backend.baseUrl
  }
  $baseUri = [Uri] $baseUrl
  $launchScript = @(
    '$ErrorActionPreference = ''Stop'''
    ('$env:ORCHESTRATION_HTTP_ENABLED = ''true''')
    ("`$env:ORCHESTRATION_HTTP_HOST = '{0}'" -f $baseUri.Host)
    ("`$env:ORCHESTRATION_HTTP_PORT = '{0}'" -f $baseUri.Port)
    ("Set-Location -LiteralPath '{0}'" -f $paths.projectRoot.Replace("'", "''"))
    ("& '{0}' '{1}' 1>> '{2}' 2>> '{3}'" -f $NodeExe.Replace("'", "''"), $paths.entryPath.Replace("'", "''"), $paths.logPath.Replace("'", "''"), $paths.errLogPath.Replace("'", "''"))
    'exit $LASTEXITCODE'
  ) -join "`n"
  Set-Content -LiteralPath $paths.launchScriptPath -Value ($launchScript + "`n")

  $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $paths.launchScriptPath) -WorkingDirectory $paths.projectRoot -WindowStyle Hidden -PassThru
  Write-JsonFile $backendStatePath ([pscustomobject]@{
      launcherPid = $proc.Id
      projectRoot = $paths.projectRoot
      baseUrl = $baseUrl
      logPath = $paths.logPath
      errLogPath = $paths.errLogPath
      updatedAt = [DateTime]::UtcNow.ToString('o')
    })

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    $health = Get-BackendHealth -EnvMap $EnvMap
    if ($health.status -eq 'ok') {
      return [pscustomobject]@{
        status = 'ok'
        detail = 'Andrea_OpenAI_Bot backend is healthy.'
        baseUrl = $baseUrl
        launcherPid = $proc.Id
      }
    }
  }

  return [pscustomobject]@{
    status = 'failed'
    detail = 'Andrea_OpenAI_Bot backend did not become healthy on loopback.'
    baseUrl = $baseUrl
    launcherPid = $proc.Id
  }
}

function Resolve-NgrokExecutable {
  $cmd = Get-Command ngrok.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  return $null
}

function Resolve-NgrokConfigPath {
  $paths = @(
    (Join-Path $env:USERPROFILE '.config\ngrok\ngrok.yml'),
    (Join-Path $env:LOCALAPPDATA 'ngrok\ngrok.yml'),
    (Join-Path $env:LOCALAPPDATA 'Packages\ngrok.ngrok_1g87z0zv29zzc\LocalCache\Local\ngrok\ngrok.yml')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  return ($paths | Select-Object -First 1)
}

function Get-NgrokCommandConfigPath {
  param([string] $NgrokExe)

  $probe = Invoke-NativeCommand -FilePath $NgrokExe -Arguments @('config', 'upgrade', '--dry-run')
  if ($probe.exitCode -eq 0 -and $probe.output -match "config file:\s*'([^']+)'") {
    return $matches[1]
  }

  return Resolve-NgrokConfigPath
}

function Repair-NgrokConfigBestEffort {
  param([string] $NgrokExe)

  $configPath = Get-NgrokCommandConfigPath -NgrokExe $NgrokExe
  if ([string]::IsNullOrWhiteSpace($configPath) -or !(Test-Path -LiteralPath $configPath)) {
    return [pscustomobject]@{
      configPath = $configPath
      repaired = $false
      detail = 'No writable ngrok config file was discovered for best-effort repair.'
    }
  }

  $raw = Get-Content -LiteralPath $configPath -Raw -ErrorAction SilentlyContinue
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return [pscustomobject]@{
      configPath = $configPath
      repaired = $false
      detail = 'ngrok config file is empty or unreadable.'
    }
  }

  if ($raw -match '(?im)^\s*update_channel\s*:\s*$') {
    $normalized = [Regex]::Replace($raw, '(?im)^\s*update_channel\s*:\s*$', 'update_channel: stable')
    Set-Content -LiteralPath $configPath -Value $normalized
    return [pscustomobject]@{
      configPath = $configPath
      repaired = $true
      detail = 'ngrok config repaired by normalizing an empty update_channel value to stable.'
    }
  }

  return [pscustomobject]@{
    configPath = $configPath
    repaired = $false
    detail = 'ngrok config did not contain an empty update_channel entry.'
  }
}

function Get-NgrokTunnelInfo {
  $probe = Test-HealthJson -Url 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 4
  if (-not $probe.ok -or $null -eq $probe.body -or -not $probe.body.tunnels) {
    return $null
  }

  return @($probe.body.tunnels)
}

function Find-NgrokTunnelForPort {
  param([string] $Port)

  $tunnels = Get-NgrokTunnelInfo
  if ($null -eq $tunnels) { return $null }

  foreach ($tunnel in $tunnels) {
    $addr = [string] $tunnel.config.addr
    if (
      $addr -eq "http://localhost:$Port" -or
      $addr -eq "localhost:$Port" -or
      $addr -eq "http://127.0.0.1:$Port" -or
      $addr -eq "127.0.0.1:$Port"
    ) {
      return $tunnel
    }
  }

  return $null
}

function Stop-ManagedNgrok {
  $state = Read-JsonFile $ngrokStatePath
  if ($state -and $state.pid -and "$($state.pid)" -match '^[0-9]+$') {
    Stop-ProcessIfRunning -ProcessId ([int] $state.pid) | Out-Null
  }
  Remove-FileIfExists $ngrokStatePath
}

function Start-NgrokProcessAndWait {
  param(
    [string] $NgrokExe,
    [string] $Port,
    [string] $PublicHint = ''
  )

  $ngrokLogPath = Join-Path $logsDir 'ngrok.log'
  $ngrokErrLogPath = Join-Path $logsDir 'ngrok.error.log'
  $proc = Start-Process -FilePath $NgrokExe -ArgumentList @('http', "localhost:$Port", '--log', 'stdout') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $ngrokLogPath -RedirectStandardError $ngrokErrLogPath -PassThru

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    $tunnel = Find-NgrokTunnelForPort -Port $Port
    if ($tunnel) {
      return [pscustomobject]@{
        ok = $true
        proc = $proc
        tunnel = $tunnel
        detail = if ([string]::IsNullOrWhiteSpace($PublicHint)) { 'ngrok tunnel is ready.' } else { "ngrok tunnel is ready. $PublicHint" }
      }
    }
  }

  $logOutput = if (Test-Path -LiteralPath $ngrokErrLogPath) {
    (Get-Content -LiteralPath $ngrokErrLogPath -Tail 20 -ErrorAction SilentlyContinue | Out-String).Trim()
  } else {
    ''
  }
  if ([string]::IsNullOrWhiteSpace($logOutput) -and (Test-Path -LiteralPath $ngrokLogPath)) {
    $logOutput = (Get-Content -LiteralPath $ngrokLogPath -Tail 20 -ErrorAction SilentlyContinue | Out-String).Trim()
  }

  return [pscustomobject]@{
    ok = $false
    proc = $proc
    logOutput = $logOutput
    detail = if ([string]::IsNullOrWhiteSpace($logOutput)) {
      'ngrok did not expose the Andrea Alexa port within the expected startup window.'
    } else {
      "ngrok did not expose the Andrea Alexa port within the expected startup window. $logOutput"
    }
  }
}

function Start-Ngrok {
  param([hashtable] $EnvMap)

  $alexa = Get-AlexaConfig -EnvMap $EnvMap
  if (-not $alexa.configured) {
    return [pscustomobject]@{
      status = 'skipped'
      detail = 'Alexa is not configured, so ngrok startup is skipped.'
    }
  }

  $ngrokExe = Resolve-NgrokExecutable
  if ([string]::IsNullOrWhiteSpace($ngrokExe)) {
    return [pscustomobject]@{
      status = 'failed'
      detail = 'ngrok.exe was not found on PATH.'
    }
  }

  $existing = Find-NgrokTunnelForPort -Port $alexa.port
  if ($existing) {
    Write-JsonFile $ngrokStatePath ([pscustomobject]@{
        pid = $null
        publicUrl = [string] $existing.public_url
        localAddr = [string] $existing.config.addr
        configPath = $null
        managed = $false
        updatedAt = [DateTime]::UtcNow.ToString('o')
      })
    return [pscustomobject]@{
      status = 'reused'
      detail = 'Reusing an existing ngrok tunnel.'
      publicUrl = [string] $existing.public_url
    }
  }

  try {
    $firstAttempt = Start-NgrokProcessAndWait -NgrokExe $ngrokExe -Port $alexa.port
  } catch {
    $firstAttempt = [pscustomobject]@{
      ok = $false
      proc = $null
      logOutput = ''
      detail = ("ngrok failed to start. {0}" -f $_.Exception.Message)
    }
  }

  if ($firstAttempt.ok) {
    Write-JsonFile $ngrokStatePath ([pscustomobject]@{
        pid = $firstAttempt.proc.Id
        publicUrl = [string] $firstAttempt.tunnel.public_url
        localAddr = [string] $firstAttempt.tunnel.config.addr
        configPath = Get-NgrokCommandConfigPath -NgrokExe $ngrokExe
        managed = $true
        updatedAt = [DateTime]::UtcNow.ToString('o')
      })
    return [pscustomobject]@{
      status = 'ok'
      detail = $firstAttempt.detail
      publicUrl = [string] $firstAttempt.tunnel.public_url
    }
  }

  if ($firstAttempt.proc -and $firstAttempt.proc.Id) {
    Stop-ProcessIfRunning -ProcessId $firstAttempt.proc.Id | Out-Null
  }

  if ($firstAttempt.detail -match 'update_channel' -or [string] $firstAttempt.logOutput -match 'update_channel') {
    $repair = Repair-NgrokConfigBestEffort -NgrokExe $ngrokExe
    if ($repair.repaired) {
      try {
        $secondAttempt = Start-NgrokProcessAndWait -NgrokExe $ngrokExe -Port $alexa.port -PublicHint $repair.detail
      } catch {
        return [pscustomobject]@{
          status = 'failed'
          detail = ("ngrok failed to start after config repair. {0}" -f $_.Exception.Message)
        }
      }

      if ($secondAttempt.ok) {
        Write-JsonFile $ngrokStatePath ([pscustomobject]@{
            pid = $secondAttempt.proc.Id
            publicUrl = [string] $secondAttempt.tunnel.public_url
            localAddr = [string] $secondAttempt.tunnel.config.addr
            configPath = $repair.configPath
            managed = $true
            updatedAt = [DateTime]::UtcNow.ToString('o')
          })
        return [pscustomobject]@{
          status = 'ok'
          detail = $secondAttempt.detail
          publicUrl = [string] $secondAttempt.tunnel.public_url
        }
      }

      if ($secondAttempt.proc -and $secondAttempt.proc.Id) {
        Stop-ProcessIfRunning -ProcessId $secondAttempt.proc.Id | Out-Null
      }

      return [pscustomobject]@{
        status = 'failed'
        detail = $secondAttempt.detail
      }
    }
  }

  return [pscustomobject]@{
    status = 'failed'
    detail = $firstAttempt.detail
  }
}

function Get-GatewayStatus {
  param(
    [hashtable] $EnvMap,
    [object] $RuntimeStatus,
    [object] $HostState = $null
  )

  $requirement = Get-GatewayRequirement -EnvMap $EnvMap
  if (-not $requirement.required) {
    return [pscustomobject]@{
      status = 'skipped'
      detail = $requirement.detail
    }
  }

  $gatewayState = Read-JsonFile $gatewayStatePath
  if ($gatewayState -and -not [string]::IsNullOrWhiteSpace([string] $gatewayState.host_health)) {
    $probe = Test-HealthJson -Url ([string] $gatewayState.host_health) -TimeoutSec 5
    if ($probe.ok) {
      return [pscustomobject]@{
        status = 'ready'
        detail = 'Local OpenAI gateway is healthy.'
      }
    }

    return [pscustomobject]@{
      status = 'failed'
      detail = ("Local OpenAI gateway health probe failed: {0}" -f $probe.detail)
    }
  }

  if ($HostState -and $HostState.companions -and $HostState.companions.gateway) {
    $status = [string] $HostState.companions.gateway.status
    $detail = [string] $HostState.companions.gateway.detail
    if ($status -eq 'ok') {
      return [pscustomobject]@{
        status = 'ready'
        detail = if ([string]::IsNullOrWhiteSpace($detail)) { 'Local OpenAI gateway is ready.' } else { $detail }
      }
    }
    if ($status -eq 'skipped') {
      return [pscustomobject]@{
        status = 'skipped'
        detail = $detail
      }
    }
    if ($status -eq 'failed') {
      return [pscustomobject]@{
        status = 'failed'
        detail = $detail
      }
    }
  }

  if ($RuntimeStatus.status -ne 'ready') {
    return [pscustomobject]@{
      status = 'failed'
      detail = ("Container runtime not ready for OpenAI gateway use. {0}" -f $RuntimeStatus.detail)
    }
  }

  return [pscustomobject]@{
    status = 'failed'
    detail = 'OpenAI gateway is required but not running.'
  }
}

function Get-NgrokStatus {
  param(
    [hashtable] $EnvMap,
    [object] $HostState = $null
  )

  $alexaConfig = Get-AlexaConfig -EnvMap $EnvMap
  if (-not $alexaConfig.configured) {
    return [pscustomobject]@{
      status = 'skipped'
      detail = 'Alexa is not configured, so public ngrok exposure is skipped.'
      publicUrl = 'none'
    }
  }

  $ngrokState = Read-JsonFile $ngrokStatePath
  $liveTunnel = Find-NgrokTunnelForPort -Port $alexaConfig.port
  if ($liveTunnel) {
    $status = 'ready'
    if (($ngrokState -and $ngrokState.managed -eq $false) -or ($HostState -and $HostState.companions -and [string] $HostState.companions.ngrok.status -eq 'reused')) {
      $status = 'reused'
    }

    return [pscustomobject]@{
      status = $status
      detail = if ($status -eq 'reused') { 'Reusing an existing ngrok tunnel.' } else { 'ngrok tunnel is ready.' }
      publicUrl = [string] $liveTunnel.public_url
    }
  }

  if ($HostState -and $HostState.companions -and $HostState.companions.ngrok) {
    return [pscustomobject]@{
      status = [string] $HostState.companions.ngrok.status
      detail = [string] $HostState.companions.ngrok.detail
      publicUrl = if ($ngrokState -and $ngrokState.publicUrl) { [string] $ngrokState.publicUrl } else { 'none' }
    }
  }

  return [pscustomobject]@{
    status = 'failed'
    detail = 'ngrok is not running for the Andrea Alexa port.'
    publicUrl = 'none'
  }
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

function Write-ReadyState {
  param(
    [string] $BootId,
    [int] $ProcessId,
    [string] $NodePath,
    [string] $NodeVersion,
    [object] $AlexaHealth
  )

  Write-JsonFile $readyStatePath ([pscustomobject]@{
      bootId = $BootId
      pid = $ProcessId
      readyAt = [DateTime]::UtcNow.ToString('o')
      nodePath = $NodePath
      nodeVersion = $NodeVersion
      alexa = $AlexaHealth
    })
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
    [object] $Companions = $null,
    [string] $InstallModeValue = $InstallMode
  )

  $state = [pscustomobject]@{
    bootId = $BootId
    phase = $Phase
    pid = if ($null -ne $ProcessId -and "$ProcessId" -match '^[0-9]+$') { [int] $ProcessId } else { $null }
    installMode = $InstallModeValue
    projectRoot = $projectRoot
    nodePath = $NodePath
    nodeVersion = $NodeVersion
    startedAt = $StartedAt
    readyAt = if ([string]::IsNullOrWhiteSpace($ReadyAt)) { $null } else { $ReadyAt }
    lastError = $LastError
    companions = $Companions
    stdoutLogPath = $stdoutLogPath
    stderrLogPath = $stderrLogPath
    hostLogPath = $hostLogPath
  }
  Write-JsonFile $hostStatePath $state
}

function Wait-ForCoreReady {
  param(
    [int] $ProcessId,
    [hashtable] $EnvMap,
    [int] $TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $stableSince = $null

  while ((Get-Date) -lt $deadline) {
    if (-not (Test-RepoProcess -ProcessId $ProcessId)) {
      return [pscustomobject]@{
        ok = $false
        detail = 'Andrea exited before it reached a stable running state.'
        alexa = Get-AlexaHealth -EnvMap $EnvMap
      }
    }

    $alexaHealth = Get-AlexaHealth -EnvMap $EnvMap
    if ($alexaHealth.configured) {
      if ($alexaHealth.local -eq 'ok' -and $alexaHealth.oauth -eq 'ok') {
        return [pscustomobject]@{
          ok = $true
          detail = 'Andrea process and Alexa health are ready.'
          alexa = $alexaHealth
        }
      }
    } else {
      if ($null -eq $stableSince) {
        $stableSince = Get-Date
      }
      if (((Get-Date) - $stableSince).TotalSeconds -ge 2) {
        return [pscustomobject]@{
          ok = $true
          detail = 'Andrea process has stayed alive long enough to be considered ready.'
          alexa = $alexaHealth
        }
      }
    }

    Start-Sleep -Milliseconds 500
  }

  return [pscustomobject]@{
    ok = $false
    detail = 'Andrea did not reach its ready state within 30 seconds.'
    alexa = Get-AlexaHealth -EnvMap $EnvMap
  }
}

function Get-HealthyRunningSnapshot {
  $hostState = Read-JsonFile $hostStatePath
  $readyState = Read-JsonFile $readyStatePath
  $runtimePid = Read-Pid

  if ($null -eq $hostState -or $null -eq $readyState -or $null -eq $runtimePid) {
    return $null
  }
  if ([string] $hostState.phase -ne 'running_ready' -and [string] $hostState.phase -ne 'degraded_companion') {
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

function Start-NanoClaw {
  $healthy = Get-HealthyRunningSnapshot
  if ($healthy) {
    Write-HostStep ("NanoClaw already running and healthy (pid={0})" -f $healthy.pid)
    return
  }

  Ensure-HostDirectories
  Repair-StartupArtifacts
  $envMap = Get-EnvConfig
  $nodeExe = Resolve-PinnedNodeExecutable
  $nodeVersion = Resolve-PinnedNodeVersion
  Ensure-BuildArtifacts -NodeExe $nodeExe

  $bootId = [guid]::NewGuid().ToString()
  $startedAt = [DateTime]::UtcNow.ToString('o')

  Stop-OrphanedRepoProcesses | Out-Null
  Stop-Gateway
  Stop-Backend
  Stop-ManagedNgrok
  Remove-FileIfExists $readyStatePath
  Remove-FileIfExists $pidFile

  $gatewayStart = Start-Gateway -EnvMap $envMap
  $backendStart = Start-Backend -EnvMap $envMap -NodeExe $nodeExe

  $companions = [ordered]@{
    gateway = $gatewayStart
    backend = $backendStart
    ngrok = [pscustomobject]@{ status = 'pending'; detail = 'Waiting for Andrea core readiness.' }
    alexa = [pscustomobject]@{ configured = ([bool] (Get-AlexaConfig -EnvMap $envMap).configured); local = 'pending'; oauth = 'pending'; detail = 'Waiting for Andrea core readiness.' }
  }
  Write-HostState -Phase 'starting' -BootId $bootId -NodePath $nodeExe -NodeVersion $nodeVersion -StartedAt $startedAt -Companions $companions
  Write-HostStep ("Starting NanoClaw with pinned Node {0}" -f $nodeVersion)

  $proc = Start-Process -FilePath $nodeExe -ArgumentList @($entryPath) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutLogPath -RedirectStandardError $stderrLogPath -PassThru
  Set-Content -LiteralPath $pidFile -Value $proc.Id -NoNewline

  $coreReady = Wait-ForCoreReady -ProcessId $proc.Id -EnvMap $envMap -TimeoutSeconds 30
  if (-not $coreReady.ok) {
    $lastError = $coreReady.detail
    Write-HostState -Phase 'startup_failed' -BootId $bootId -ProcessId $proc.Id -NodePath $nodeExe -NodeVersion $nodeVersion -StartedAt $startedAt -LastError $lastError -Companions $companions
    Stop-ProcessIfRunning -ProcessId $proc.Id | Out-Null
    Stop-Gateway
    Stop-Backend
    Stop-ManagedNgrok
    Remove-FileIfExists $pidFile
    Remove-FileIfExists $readyStatePath
    throw $lastError
  }

  try {
    $ngrokStart = Start-Ngrok -EnvMap $envMap
  } catch {
    $ngrokStart = [pscustomobject]@{
      status = 'failed'
      detail = $_.Exception.Message
    }
  }
  $gatewayHealthError = Get-LocalGatewayHealthError
  if ($gatewayStart.status -eq 'ok' -and -not $gatewayHealthError) {
    $gatewayStart = [pscustomobject]@{
      status = 'ok'
      detail = 'Local OpenAI gateway is healthy.'
      engine = $gatewayStart.engine
      engineStatus = $gatewayStart.engineStatus
    }
  } elseif ($gatewayHealthError) {
    $gatewayStart = [pscustomobject]@{
      status = 'failed'
      detail = $gatewayHealthError
      engine = $gatewayStart.engine
      engineStatus = $gatewayStart.engineStatus
    }
  }

  $companions = [ordered]@{
    gateway = $gatewayStart
    backend = $backendStart
    ngrok = $ngrokStart
    alexa = $coreReady.alexa
  }

  $degradedReasons = @()
  foreach ($name in @('gateway', 'backend', 'ngrok')) {
    $status = [string] $companions[$name].status
    if ($status -eq 'failed') {
      $degradedReasons += ("{0}: {1}" -f $name, [string] $companions[$name].detail)
    }
  }
  if ($coreReady.alexa.configured -and ($coreReady.alexa.local -ne 'ok' -or $coreReady.alexa.oauth -ne 'ok')) {
    $degradedReasons += ("alexa: {0}" -f $coreReady.alexa.detail)
  }

  $readyAt = [DateTime]::UtcNow.ToString('o')
  Write-ReadyState -BootId $bootId -ProcessId $proc.Id -NodePath $nodeExe -NodeVersion $nodeVersion -AlexaHealth $coreReady.alexa

  if ($degradedReasons.Count -gt 0) {
    $detail = ($degradedReasons -join ' | ')
    Write-HostState -Phase 'degraded_companion' -BootId $bootId -ProcessId $proc.Id -NodePath $nodeExe -NodeVersion $nodeVersion -StartedAt $startedAt -ReadyAt $readyAt -LastError $detail -Companions $companions
    Write-HostStep ("NanoClaw reached degraded_companion (pid={0}): {1}" -f $proc.Id, $detail)
    return
  }

  Write-HostState -Phase 'running_ready' -BootId $bootId -ProcessId $proc.Id -NodePath $nodeExe -NodeVersion $nodeVersion -StartedAt $startedAt -ReadyAt $readyAt -Companions $companions
  Write-HostStep ("NanoClaw reached running_ready (pid={0})" -f $proc.Id)
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

  Stop-ManagedNgrok
  Stop-Backend
  Stop-Gateway

  Remove-FileIfExists $pidFile
  Remove-FileIfExists $readyStatePath
  Write-HostState -Phase 'stopped' -BootId '' -NodePath '' -NodeVersion '' -StartedAt '' -Companions $null -InstallModeValue $InstallMode
}

function Show-Status {
  $envMap = Get-EnvConfig
  $hostState = Read-JsonFile $hostStatePath
  $readyState = Read-JsonFile $readyStatePath
  $runtimeMetadata = Read-JsonFile $nodeRuntimeMetadataPath
  $runtimePid = Read-Pid
  $processRunning = $false
  if ($runtimePid) {
    $processRunning = Test-RepoProcess -ProcessId $runtimePid
  }

  $runtimeStatus = Ensure-ContainerRuntimeReady -EnvMap $envMap -Required:(Get-GatewayRequirement -EnvMap $envMap).required -AutoStartIfRequired:$false
  $gatewayStatus = Get-GatewayStatus -EnvMap $envMap -RuntimeStatus $runtimeStatus -HostState $hostState
  $ngrokStatus = Get-NgrokStatus -EnvMap $envMap -HostState $hostState
  $phase = 'stopped'
  if (
    $hostState -and
    $processRunning -and
    $readyState -and
    [string] $hostState.bootId -eq [string] $readyState.bootId -and
    [int] $readyState.pid -eq $runtimePid
  ) {
    $phase = [string] $hostState.phase
  } elseif ($hostState -and $hostState.phase -eq 'starting' -and $processRunning) {
    $phase = 'starting'
  } elseif ($hostState -and $hostState.phase -eq 'startup_failed') {
    $phase = 'startup_failed'
  } elseif ($processRunning) {
    $phase = 'process_stale'
  }

  $alexaHealth = Get-AlexaHealth -EnvMap $envMap
  $backendHealth = Get-BackendHealth -EnvMap $envMap

  Write-Output ("HOST_STATUS: phase={0}" -f $phase)
  Write-Output ("HOST_STATUS: process_running={0}" -f $processRunning.ToString().ToLowerInvariant())
  Write-Output ("HOST_STATUS: pid={0}" -f ($(if ($runtimePid) { $runtimePid } else { 'none' })))
  Write-Output ("HOST_STATUS: install_mode={0}" -f $(if ($hostState -and $hostState.installMode) { [string] $hostState.installMode } else { $InstallMode }))
  Write-Output ("HOST_STATUS: project_root={0}" -f $projectRoot)
  Write-Output ("HOST_STATUS: node_version={0}" -f ($(if ($runtimeMetadata) { [string] $runtimeMetadata.version } else { 'unknown' })))
  Write-Output ("HOST_STATUS: node_path={0}" -f ($(if ($runtimeMetadata) { [string] $runtimeMetadata.nodePath } else { 'unknown' })))
  Write-Output ("HOST_STATUS: scheduled_task_installed={0}" -f (Get-ScheduledTaskInstalled).ToString().ToLowerInvariant())
  Write-Output ("HOST_STATUS: startup_fallback_installed={0}" -f (Get-StartupFallbackInstalled).ToString().ToLowerInvariant())
  Write-Output ("HOST_STATUS: alexa_local={0}" -f $alexaHealth.local)
  Write-Output ("HOST_STATUS: alexa_oauth={0}" -f $alexaHealth.oauth)
  Write-Output ("HOST_STATUS: runtime_engine={0}" -f $runtimeStatus.engine)
  Write-Output ("HOST_STATUS: runtime_engine_status={0}" -f $runtimeStatus.status)
  Write-Output ("HOST_STATUS: runtime_engine_detail={0}" -f $runtimeStatus.detail)
  Write-Output ("HOST_STATUS: gateway={0}" -f $gatewayStatus.status)
  Write-Output ("HOST_STATUS: gateway_detail={0}" -f $gatewayStatus.detail)
  Write-Output ("HOST_STATUS: backend={0}" -f $backendHealth.status)
  Write-Output ("HOST_STATUS: backend_detail={0}" -f $backendHealth.detail)
  Write-Output ("HOST_STATUS: ngrok={0}" -f $ngrokStatus.status)
  Write-Output ("HOST_STATUS: ngrok_detail={0}" -f $ngrokStatus.detail)
  Write-Output ("HOST_STATUS: ngrok_public_url={0}" -f $ngrokStatus.publicUrl)
  Write-Output ("HOST_STATUS: last_error={0}" -f ($(if ($hostState -and $hostState.lastError) { [string] $hostState.lastError } else { 'none' })))
  Write-Output ("HOST_STATUS: host_log={0}" -f $hostLogPath)
}

Ensure-HostDirectories
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
    Write-HostState -Phase 'startup_failed' -BootId '' -NodePath '' -NodeVersion '' -StartedAt '' -LastError $message -Companions $null -InstallModeValue $InstallMode
    Write-HostStep ("Host control failure: {0}" -f $message)
  }
  throw
} finally {
  Release-HostLock
}
