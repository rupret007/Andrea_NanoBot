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

function Ensure-NgrokConfigHealthy {
  param([string] $NgrokExe)

  $configPath = Resolve-NgrokConfigPath
  $args = @('config', 'check')
  if ($configPath) {
    $args += @('--config', $configPath)
  }

  $output = & $NgrokExe @args 2>&1
  if ($LASTEXITCODE -eq 0) {
    return [pscustomobject]@{
      ok = $true
      configPath = $configPath
      detail = (($output | Out-String).Trim())
    }
  }

  $raw = if ($configPath) {
    Get-Content -LiteralPath $configPath -Raw -ErrorAction SilentlyContinue
  } else {
    ''
  }
  if ($configPath -and (($output | Out-String) -match 'update_channel')) {
    $normalized = if ([string]::IsNullOrWhiteSpace($raw)) {
      "version: `"3`"`r`nupdate_channel: stable`r`n"
    } elseif ($raw -match '(?im)^\s*update_channel\s*:') {
      [Regex]::Replace($raw, '(?im)^\s*update_channel\s*:.*$', 'update_channel: stable')
    } else {
      ($raw.TrimEnd() + "`r`nupdate_channel: stable`r`n")
    }

    Set-Content -LiteralPath $configPath -Value $normalized
    $retry = & $NgrokExe @args 2>&1
    if ($LASTEXITCODE -eq 0) {
      return [pscustomobject]@{
        ok = $true
        configPath = $configPath
        detail = 'ngrok config repaired by normalizing update_channel to stable.'
      }
    }

    return [pscustomobject]@{
      ok = $false
      configPath = $configPath
      detail = (($retry | Out-String).Trim())
    }
  }

  return [pscustomobject]@{
    ok = $false
    configPath = $configPath
    detail = (($output | Out-String).Trim())
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
      status = 'ok'
      detail = 'Reusing an existing ngrok tunnel.'
      publicUrl = [string] $existing.public_url
    }
  }

  $config = Ensure-NgrokConfigHealthy -NgrokExe $ngrokExe
  $configWarning = if (-not $config.ok) {
    "ngrok config check warning: $($config.detail)"
  } else {
    ''
  }

  $allTunnels = Get-NgrokTunnelInfo
  if ($allTunnels) {
    return [pscustomobject]@{
      status = 'failed'
      detail = 'ngrok is already running, but not for the Andrea Alexa port.'
    }
  }

  $ngrokLogPath = Join-Path $logsDir 'ngrok.log'
  $ngrokErrLogPath = Join-Path $logsDir 'ngrok.error.log'
  $proc = Start-Process -FilePath $ngrokExe -ArgumentList @('http', "localhost:$($alexa.port)", '--log', 'stdout') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $ngrokLogPath -RedirectStandardError $ngrokErrLogPath -PassThru

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    $tunnel = Find-NgrokTunnelForPort -Port $alexa.port
    if ($tunnel) {
      Write-JsonFile $ngrokStatePath ([pscustomobject]@{
          pid = $proc.Id
          publicUrl = [string] $tunnel.public_url
          localAddr = [string] $tunnel.config.addr
          configPath = $config.configPath
          managed = $true
          updatedAt = [DateTime]::UtcNow.ToString('o')
        })
      return [pscustomobject]@{
        status = 'ok'
        detail = if ([string]::IsNullOrWhiteSpace($configWarning)) { 'ngrok tunnel is ready.' } else { "ngrok tunnel is ready. $configWarning" }
        publicUrl = [string] $tunnel.public_url
      }
    }
  }

  return [pscustomobject]@{
    status = 'failed'
    detail = if ([string]::IsNullOrWhiteSpace($configWarning)) { 'ngrok did not expose the Andrea Alexa port within the expected startup window.' } else { "ngrok did not expose the Andrea Alexa port within the expected startup window. $configWarning" }
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

  $gatewayStart = Start-Gateway
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

  $ngrokStart = Start-Ngrok -EnvMap $envMap
  $gatewayHealthError = Get-LocalGatewayHealthError
  if ($gatewayStart.status -eq 'ok' -and -not $gatewayHealthError) {
    $gatewayStart = [pscustomobject]@{
      status = 'ok'
      detail = 'Local OpenAI gateway is healthy.'
    }
  } elseif ($gatewayHealthError) {
    $gatewayStart = [pscustomobject]@{
      status = 'failed'
      detail = $gatewayHealthError
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
  $ngrokState = Read-JsonFile $ngrokStatePath
  $alexaConfig = Get-AlexaConfig -EnvMap $envMap
  $liveTunnel = if ($alexaConfig.configured) {
    Find-NgrokTunnelForPort -Port $alexaConfig.port
  } else {
    $null
  }
  $ngrokPublicUrl = if ($liveTunnel) {
    [string] $liveTunnel.public_url
  } elseif ($ngrokState -and $ngrokState.publicUrl) {
    [string] $ngrokState.publicUrl
  } else {
    'none'
  }

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
  Write-Output ("HOST_STATUS: backend={0}" -f $backendHealth.status)
  Write-Output ("HOST_STATUS: ngrok={0}" -f $(if ($liveTunnel -or $ngrokState) { 'configured' } else { 'not_running' }))
  Write-Output ("HOST_STATUS: ngrok_public_url={0}" -f $ngrokPublicUrl)
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
