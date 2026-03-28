$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot 'config\litellm-openai-anthropic.yaml'
$envPath = Join-Path $projectRoot '.env'
$runtimeDir = Join-Path $projectRoot 'data\runtime'
$statePath = Join-Path $runtimeDir 'openai-gateway-state.json'
$legacyPidFile = Join-Path $runtimeDir 'litellm.pid'

$containerName = 'litellm-gateway'
$legacyContainerNames = @('litellm-gateway', 'nanoclaw-litellm')
$networkName = 'nanoclaw-openai'
$image = 'docker.litellm.ai/berriai/litellm:main-latest'
$containerEndpoint = 'http://litellm-gateway:4000'
$hostHealthUrl = 'http://127.0.0.1:4000/health'

function Get-ParsedEnvFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $result = @{}
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

function Command-Exists {
  param([string] $Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Resolve-ContainerRuntime {
  param([hashtable] $EnvMap)

  $preferred = $null
  if ($EnvMap.ContainsKey('CONTAINER_RUNTIME')) {
    $candidate = $EnvMap['CONTAINER_RUNTIME']
    if ($candidate -eq 'docker' -or $candidate -eq 'podman') {
      $preferred = $candidate
    }
  }

  if ($preferred) {
    if (Command-Exists $preferred) {
      return $preferred
    }
    throw "Configured CONTAINER_RUNTIME '$preferred' is not installed."
  }

  if (Command-Exists 'docker') { return 'docker' }
  if (Command-Exists 'podman') { return 'podman' }
  throw 'No supported container runtime found for OpenAI gateway startup (need docker or podman).'
}

function Remove-GatewayStateFiles {
  if (Test-Path -LiteralPath $statePath) {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $legacyPidFile) {
    Remove-Item -LiteralPath $legacyPidFile -Force -ErrorAction SilentlyContinue
  }
}

if (!(Test-Path -LiteralPath $configPath)) {
  throw "LiteLLM config not found: $configPath"
}
if (!(Test-Path -LiteralPath $envPath)) {
  throw ".env not found: $envPath"
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

$envMap = Get-ParsedEnvFile -Path $envPath
$openAiApiKey = $envMap['OPENAI_API_KEY']
$anthropicBaseUrl = $envMap['ANTHROPIC_BASE_URL']
$openAiBaseUrl = $envMap['OPENAI_BASE_URL']
$anthropicDirectCredentialConfigured = (
  $envMap['CLAUDE_CODE_OAUTH_TOKEN'] -or
  $envMap['ANTHROPIC_API_KEY'] -or
  $envMap['ANTHROPIC_AUTH_TOKEN']
)

if ([string]::IsNullOrWhiteSpace($openAiApiKey)) {
  Remove-GatewayStateFiles
  Write-Output 'OPENAI_GATEWAY_SKIPPED reason=no_openai_api_key'
  exit 0
}

$openAiCompatEndpoint = $anthropicBaseUrl
if ([string]::IsNullOrWhiteSpace($openAiCompatEndpoint)) {
  $openAiCompatEndpoint = $openAiBaseUrl
}

# If Anthropic-native credentials are configured and no OpenAI-compatible
# endpoint is configured, do not force a local OpenAI gateway.
if ($anthropicDirectCredentialConfigured -and [string]::IsNullOrWhiteSpace($openAiCompatEndpoint)) {
  Remove-GatewayStateFiles
  Write-Output 'OPENAI_GATEWAY_SKIPPED reason=anthropic_direct_credentials'
  exit 0
}

$runtime = Resolve-ContainerRuntime -EnvMap $envMap

# Ensure the dedicated gateway network exists.
& $runtime 'network' 'inspect' $networkName *> $null
if ($LASTEXITCODE -ne 0) {
  & $runtime 'network' 'create' $networkName | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create network '$networkName' with runtime '$runtime'."
  }
}

# Recreate container on startup to apply fresh config and credentials.
# Also clean up legacy container naming from prior builds.
foreach ($candidate in $legacyContainerNames) {
  & $runtime 'rm' '-f' $candidate *> $null
}

$mountSpec = "type=bind,source=$configPath,target=/app/config.yaml,readonly"
$runArgs = @(
  'run', '-d',
  '--name', $containerName,
  '--network', $networkName,
  '--network-alias', $containerName,
  '--network-alias', 'nanoclaw-litellm',
  '-p', '4000:4000',
  '-e', "OPENAI_API_KEY=$openAiApiKey",
  '--mount', $mountSpec,
  $image,
  '--config', '/app/config.yaml',
  '--host', '0.0.0.0',
  '--port', '4000'
)

$containerId = (& $runtime @runArgs 2>&1 | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($containerId)) {
  throw "Failed to start OpenAI gateway container via $runtime. $containerId"
}

$healthy = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  try {
    $res = Invoke-WebRequest -UseBasicParsing -Uri $hostHealthUrl -TimeoutSec 2
    if ($res.StatusCode -ge 200 -and $res.StatusCode -lt 500) {
      $healthy = $true
      break
    }
  } catch {
    # keep retrying
  }
  Start-Sleep -Milliseconds 500
}

if (-not $healthy) {
  $logs = (& $runtime 'logs' '--tail' '80' $containerName 2>$null) -join "`n"
  throw "OpenAI gateway health check failed at $hostHealthUrl. Container logs: $logs"
}

$state = @{
  runtime        = $runtime
  container_name = $containerName
  network        = $networkName
  endpoint       = $containerEndpoint
  host_health    = $hostHealthUrl
  image          = $image
  updated_at     = (Get-Date).ToString('o')
}
$state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8

if (Test-Path -LiteralPath $legacyPidFile) {
  Remove-Item -LiteralPath $legacyPidFile -Force -ErrorAction SilentlyContinue
}

Write-Output "OPENAI_GATEWAY_READY runtime=$runtime container=$containerName endpoint=$containerEndpoint"
