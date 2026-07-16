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

expand_home() {
  local value="$1"
  if [[ "$value" == "~" ]]; then
    printf '%s' "$HOME"
  elif [[ "$value" == "~/"* ]]; then
    printf '%s/%s' "$HOME" "${value:2}"
  else
    printf '%s' "$value"
  fi
}

export ANDREA_STATE_DIR="$(expand_home "${ANDREA_STATE_DIR:-$HOME/.andrea}")"
export ANDREA_LOG_DIR="$(expand_home "${ANDREA_LOG_DIR:-$HOME/Library/Logs/andrea}")"

SIDECAR_STATE_DIR="$ANDREA_STATE_DIR/bluebubbles"
SIDECAR_LOG_DIR="$ANDREA_LOG_DIR/bluebubbles-receipt-inbox"
mkdir -p -m 700 "$SIDECAR_STATE_DIR" "$SIDECAR_LOG_DIR"
chmod 700 "$SIDECAR_STATE_DIR" "$SIDECAR_LOG_DIR"
touch "$SIDECAR_LOG_DIR/stdout.log" "$SIDECAR_LOG_DIR/stderr.log"
chmod 600 "$SIDECAR_LOG_DIR/stdout.log" "$SIDECAR_LOG_DIR/stderr.log"

ENTRYPOINT="$PROJECT_ROOT/dist/bluebubbles-receipt-inbox-main.js"
if [[ ! -f "$ENTRYPOINT" ]]; then
  echo "$ENTRYPOINT is missing; run npm run build before installing or restarting the receipt inbox" >&2
  exit 1
fi

PINNED_NODE_PATH="$(node scripts/run-with-pinned-node.mjs --print-node-path)"
if [[ -z "$PINNED_NODE_PATH" || ! -x "$PINNED_NODE_PATH" ]]; then
  echo "verified pinned Node executable is unavailable" >&2
  exit 1
fi
"$PINNED_NODE_PATH" scripts/check-node-version.js

BUILD_PROVENANCE_PATH="$PROJECT_ROOT/dist/build-provenance.json"
CURRENT_GIT_COMMIT="$(git -C "$PROJECT_ROOT" rev-parse HEAD)" || {
  echo "current Git commit is unavailable for build verification" >&2
  exit 1
}
ANDREA_BUILD_ID="$(
  "$PINNED_NODE_PATH" scripts/verify-build-manifest-id.mjs \
    "$BUILD_PROVENANCE_PATH" "$CURRENT_GIT_COMMIT"
)" || {
  echo "exact clean build provenance is unavailable at $BUILD_PROVENANCE_PATH" >&2
  exit 1
}
export ANDREA_BUILD_ID

exec "$PINNED_NODE_PATH" "$ENTRYPOINT"
