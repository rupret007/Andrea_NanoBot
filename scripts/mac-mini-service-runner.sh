#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${1:-}"
if [[ -z "$PROJECT_ROOT" ]]; then
  PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

cd "$PROJECT_ROOT"

mkdir -p logs data/run
umask 077

export HOME="${HOME:-$(dscl . -read /Users/"$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export NANOCLAW_SERVICE_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
export NANOCLAW_SERVICE_PROJECT_ROOT="$PROJECT_ROOT"

load_dotenv() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0

  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    local line key value first last
    line="${raw_line#"${raw_line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue

    key="${line%%=*}"
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"

    first="${value:0:1}"
    last="${value: -1}"
    if [[ ${#value} -ge 2 && ( ( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" ) ) ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
  done < "$env_file"
}

load_dotenv "$PROJECT_ROOT/.env"

export ANDREA_STATE_DIR="${ANDREA_STATE_DIR:-$HOME/.andrea}"
export ANDREA_LOG_DIR="${ANDREA_LOG_DIR:-$HOME/Library/Logs/andrea}"
mkdir -p "$ANDREA_STATE_DIR" "$ANDREA_LOG_DIR"

if [[ ! -f dist/index.js ]]; then
  echo "dist/index.js missing; building before service start" >&2
  npm run build
fi

PINNED_NODE_PATH="$(node scripts/run-with-pinned-node.mjs --print-node-path)"
if [[ -z "$PINNED_NODE_PATH" || ! -x "$PINNED_NODE_PATH" ]]; then
  echo "verified pinned Node executable is unavailable" >&2
  exit 1
fi

echo "$$" > data/run/mac-mini-service.pid
exec "$PINNED_NODE_PATH" dist/index.js
