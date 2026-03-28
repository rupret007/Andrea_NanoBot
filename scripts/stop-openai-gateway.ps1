$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'data\runtime'
$statePath = Join-Path $runtimeDir 'openai-gateway-state.json'
$legacyPidFile = Join-Path $runtimeDir 'litellm.pid'
$defaultContainerName = 'litellm-gateway'
$legacyContainerNames = @('litellm-gateway', 'nanoclaw-litellm')

function Command-Exists {
  param([string] $Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Resolve-RuntimeFromState {
  param([hashtable] $State)
  if ($State.runtime -and (Command-Exists $State.runtime)) {
    return [string]$State.runtime
  }
  if (Command-Exists 'docker') { return 'docker' }
  if (Command-Exists 'podman') { return 'podman' }
  return $null
}

$state = @{}
if (Test-Path -LiteralPath $statePath) {
  try {
    $parsed = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($parsed) {
      $state.runtime = $parsed.runtime
      $state.container_name = $parsed.container_name
    }
  } catch {
    # ignore malformed state and continue with defaults
  }
}

$runtime = Resolve-RuntimeFromState -State $state
$containerName = if ($state.container_name) { [string]$state.container_name } else { $defaultContainerName }

if ($runtime) {
  foreach ($candidate in ($legacyContainerNames + $containerName | Select-Object -Unique)) {
    & $runtime 'rm' '-f' $candidate *> $null
  }
}

if (Test-Path -LiteralPath $statePath) {
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $legacyPidFile) {
  Remove-Item -LiteralPath $legacyPidFile -Force -ErrorAction SilentlyContinue
}

if ($runtime) {
  Write-Output "OPENAI_GATEWAY_STOPPED runtime=$runtime container=$containerName"
} else {
  Write-Output 'OPENAI_GATEWAY_STOPPED no_runtime_detected'
}
