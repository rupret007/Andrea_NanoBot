#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/data/backups"
STATE_DIR="${ANDREA_STATE_DIR:-$HOME/.andrea}"
DRY_RUN=0

usage() {
  cat <<USAGE
Usage: scripts/agi-backup.sh [--dry-run] [--output-dir <dir>]

Creates a local tar.gz backup under data/backups by default. Includes the
project runtime state plus ANDREA_STATE_DIR (default ~/.andrea) when present.
The archive may include secrets from .env and local auth/session state; keep it private.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --output-dir)
      OUTPUT_DIR="${2:?missing output dir}"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

cd "$PROJECT_ROOT"
timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
name="andrea-nanobot-mac-mini-backup-$timestamp"
archive="$OUTPUT_DIR/$name.tar.gz"
manifest_parent="$(mktemp -d "${TMPDIR:-/tmp}/andrea-backup-manifest.XXXXXX")"
manifest_dir="$manifest_parent/$name"
trap 'rm -rf "$manifest_parent"' EXIT

include_paths=()
for path in .env .env.example package.json package-lock.json .nvmrc launchd scripts docs store data groups logs; do
  [[ -e "$path" ]] && include_paths+=("$path")
done
if [[ -e "$STATE_DIR" ]]; then
  include_paths+=("$STATE_DIR")
fi

if [[ "${#include_paths[@]}" -eq 0 ]]; then
  echo "No backup paths found" >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'Would create %s with:\n' "$archive"
  printf '  %s\n' "${include_paths[@]}"
  exit 0
fi

mkdir -p "$OUTPUT_DIR" "$manifest_dir"
{
  echo "created_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "project_root=$PROJECT_ROOT"
  echo "andrea_state_dir=$STATE_DIR"
  echo "git_branch=$(git branch --show-current 2>/dev/null || true)"
  echo "git_commit=$(git rev-parse HEAD 2>/dev/null || true)"
  echo "paths=${include_paths[*]}"
} > "$manifest_dir/manifest.txt"

tar \
  --exclude 'data/backups' \
  --exclude 'data/replays' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  -czf "$archive" "${include_paths[@]}" -C "$manifest_parent" "$name/manifest.txt"
chmod 600 "$archive"
echo "$archive"
