#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_SCRIPT="$PROJECT_ROOT/scripts/mac-mini-service.sh"
QUIET=0

if [[ "${1:-}" == "--quiet" ]]; then
  QUIET=1
fi

section() {
  [[ "$QUIET" -eq 1 ]] && return 0
  printf '\n== %s ==\n' "$1"
}

ok() { printf 'ok: %s\n' "$1"; }
warn() { printf 'warn: %s\n' "$1"; }
fail() { printf 'fail: %s\n' "$1"; }

redact() {
  sed -E \
    -e 's/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/\1...REDACTED/g' \
    -e 's/([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^[:space:]]+/\1REDACTED/g' \
    -e 's/([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*=)[^[:space:]]+/\1REDACTED/g' \
    -e 's/([A-Za-z0-9_]*API_KEY[A-Za-z0-9_]*=)[^[:space:]]+/\1REDACTED/g'
}

cd "$PROJECT_ROOT"

section "Host"
ok "root=$PROJECT_ROOT"
ok "date_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
ok "macos=$(sw_vers -productVersion 2>/dev/null || echo unknown)"
ok "arch=$(uname -m)"

section "Git"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  ok "branch=$(git branch --show-current 2>/dev/null || echo detached)"
  ok "commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  changes="$(git status --short | wc -l | tr -d ' ')"
  if [[ "$changes" == "0" ]]; then
    ok "worktree_clean=yes"
  else
    warn "worktree_clean=no changed_entries=$changes"
    git status --short | redact | sed 's/^/  /'
  fi
else
  warn "not a git worktree"
fi

section "Runtime"
if [[ -f .nvmrc ]]; then
  ok "nvmrc=$(cat .nvmrc)"
else
  fail "missing .nvmrc"
fi
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version)"
  case "$node_version" in
    v22.*) ok "node=$node_version" ;;
    *) warn "node=$node_version expected v22.x" ;;
  esac
else
  fail "node not found in PATH"
fi
if [[ -d node_modules ]]; then
  ok "node_modules=present"
else
  warn "node_modules=missing; run npm ci"
fi
if [[ -f dist/index.js ]]; then
  ok "dist=present"
else
  warn "dist/index.js missing; service runner will try npm run build"
fi
if node scripts/run-with-pinned-node.mjs --verify-only >/dev/null 2>&1; then
  ok "pinned_node=verified"
else
  fail "pinned_node=failed"
fi

section "Config"
if [[ -f .env ]]; then
  ok ".env=present"
  for key in ASSISTANT_NAME TELEGRAM_BOT_TOKEN OPENAI_API_KEY ANTHROPIC_API_KEY ANDREA_OPENAI_BACKEND_ENABLED ALEXA_PORT BLUEBUBBLES_PORT; do
    if grep -Eq "^[[:space:]]*$key=" .env; then
      ok "$key=configured"
    else
      warn "$key=missing"
    fi
  done
else
  warn ".env=missing"
fi

section "State"
for path in store/messages.db data groups logs; do
  if [[ -e "$path" ]]; then
    ok "$path=present"
  else
    warn "$path=missing"
  fi
done
if command -v sqlite3 >/dev/null 2>&1 && [[ -f store/messages.db ]]; then
  if sqlite3 store/messages.db 'PRAGMA quick_check;' 2>/dev/null | grep -qx ok; then
    ok "sqlite_quick_check=ok"
  else
    warn "sqlite_quick_check=failed"
  fi
fi

section "Launchd"
if [[ -x "$SERVICE_SCRIPT" ]]; then
  "$SERVICE_SCRIPT" status | redact | sed 's/^/  /'
else
  warn "service script is not executable"
fi

section "Recent Logs"
for log in logs/mac-mini-service.err.log logs/mac-mini-service.out.log logs/nanoclaw.error.log logs/nanoclaw.log; do
  if [[ -f "$log" ]]; then
    echo "-- $log"
    tail -n 20 "$log" | redact | sed 's/^/  /'
  fi
done
