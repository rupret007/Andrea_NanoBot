#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${1:-}"
if [[ -z "$PROJECT_ROOT" ]]; then
  PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "$PROJECT_ROOT"
umask 077

export HOME="${HOME:-$(dscl . -read /Users/"$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

load_codex_config() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    local line key value first last
    line="${raw_line#"${raw_line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^ANDREA_CODEX_[A-Z0-9_]+= ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    first="${value:0:1}"
    last="${value: -1}"
    if [[ ${#value} -ge 2 && (( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" )) ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "$key=$value"
  done < "$env_file"
}

load_codex_config "$PROJECT_ROOT/.env"
export ANDREA_CODEX_SERVICE_STATE_DIR="${ANDREA_CODEX_SERVICE_STATE_DIR:-$HOME/.andrea/codex-local}"
LOG_DIR="${ANDREA_CODEX_SERVICE_LOG_DIR:-$HOME/Library/Logs/andrea/codex-local}"
mkdir -p -m 700 "$ANDREA_CODEX_SERVICE_STATE_DIR" "$LOG_DIR"
chmod 700 "$ANDREA_CODEX_SERVICE_STATE_DIR" "$LOG_DIR"

ENTRYPOINT="$PROJECT_ROOT/dist/codex-local-main.js"
if [[ ! -f "$ENTRYPOINT" ]]; then
  echo "$ENTRYPOINT is missing; run npm run build first" >&2
  exit 1
fi

PINNED_NODE_PATH="$(node "$PROJECT_ROOT/scripts/run-with-pinned-node.mjs" --print-node-path)"
if [[ -z "$PINNED_NODE_PATH" || ! -x "$PINNED_NODE_PATH" ]]; then
  echo "verified pinned Node executable is unavailable" >&2
  exit 1
fi
"$PINNED_NODE_PATH" "$PROJECT_ROOT/scripts/check-node-version.js"

CURRENT_GIT_COMMIT="$(git -C "$PROJECT_ROOT" rev-parse HEAD)" || {
  echo "current Git commit is unavailable for build verification" >&2
  exit 1
}
ANDREA_CODEX_BUILD_ID="$(
  "$PINNED_NODE_PATH" "$PROJECT_ROOT/scripts/verify-build-manifest-id.mjs" \
    "$PROJECT_ROOT/dist/build-provenance.json" "$CURRENT_GIT_COMMIT"
)" || {
  echo "exact clean build provenance is unavailable" >&2
  exit 1
}
export ANDREA_CODEX_BUILD_IDENTITY="$ANDREA_CODEX_BUILD_ID"

exec "$PINNED_NODE_PATH" "$ENTRYPOINT"
