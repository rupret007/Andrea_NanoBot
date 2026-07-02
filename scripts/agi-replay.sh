#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPLAY_ROOT="$PROJECT_ROOT/data/replays"

usage() {
  cat <<USAGE
Usage: scripts/agi-replay.sh <command>

Commands:
  capture      Create a redacted replay packet from current host evidence
  list         List captured replay packets
  show <id>    Show a packet manifest and key summaries

Replay packets are local diagnostic evidence, not live execution. They avoid
raw secret values and stay under data/replays, which is ignored by git.
USAGE
}

redact_file() {
  sed -E \
    -e 's/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/\1...REDACTED/g' \
    -e 's/([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^[:space:]]+/\1REDACTED/g' \
    -e 's/([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*=)[^[:space:]]+/\1REDACTED/g' \
    -e 's/([A-Za-z0-9_]*API_KEY[A-Za-z0-9_]*=)[^[:space:]]+/\1REDACTED/g'
}

capture() {
  cd "$PROJECT_ROOT"
  local id packet
  id="$(date -u '+%Y%m%dT%H%M%SZ')"
  packet="$REPLAY_ROOT/$id"
  mkdir -p "$packet"

  {
    echo "id=$id"
    echo "created_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "project_root=$PROJECT_ROOT"
    echo "branch=$(git branch --show-current 2>/dev/null || true)"
    echo "commit=$(git rev-parse HEAD 2>/dev/null || true)"
    echo "node=$(node --version 2>/dev/null || true)"
  } > "$packet/manifest.txt"

  git status --short 2>/dev/null | redact_file > "$packet/git-status.txt" || true
  "$PROJECT_ROOT/scripts/agi-doctor.sh" --quiet 2>&1 | redact_file > "$packet/doctor.txt" || true
  "$PROJECT_ROOT/scripts/mac-mini-service.sh" status 2>&1 | redact_file > "$packet/service-status.txt" || true

  mkdir -p "$packet/logs"
  for log in logs/mac-mini-service.out.log logs/mac-mini-service.err.log logs/nanoclaw.log logs/nanoclaw.error.log; do
    if [[ -f "$log" ]]; then
      tail -n 300 "$log" | redact_file > "$packet/logs/$(basename "$log").tail"
    fi
  done

  if command -v sqlite3 >/dev/null 2>&1 && [[ -f store/messages.db ]]; then
    {
      echo "PRAGMA quick_check;"
      sqlite3 store/messages.db 'PRAGMA quick_check;' 2>/dev/null || true
      echo
      echo "tables:"
      sqlite3 store/messages.db ".tables" 2>/dev/null || true
    } > "$packet/sqlite-summary.txt"
  fi

  find "$packet" -type f -print | sort > "$packet/files.txt"
  echo "$packet"
}

show_packet() {
  local id="${1:-}"
  [[ -n "$id" ]] || { usage >&2; exit 2; }
  local packet="$REPLAY_ROOT/$id"
  [[ -d "$packet" ]] || { echo "Replay packet not found: $id" >&2; exit 1; }
  cat "$packet/manifest.txt"
  echo
  echo "-- service-status.txt"
  sed -n '1,120p' "$packet/service-status.txt" 2>/dev/null || true
  echo
  echo "-- files.txt"
  sed -n '1,120p' "$packet/files.txt" 2>/dev/null || true
}

case "${1:-}" in
  capture) capture ;;
  list)
    mkdir -p "$REPLAY_ROOT"
    for packet in "$REPLAY_ROOT"/*; do
      [[ -d "$packet" ]] || continue
      basename "$packet"
    done | sort
    ;;
  show)
    shift
    show_packet "${1:-}"
    ;;
  -h|--help|help|'') usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
