#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

load_bridge_config() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0
  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    local line key value first last
    line="${raw_line#"${raw_line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^CURSOR_DESKTOP_[A-Z0-9_]+= ]] || continue
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

load_bridge_config "$PROJECT_ROOT/.env"
LABEL="com.nanoclaw.cursor-desktop-bridge"
TEMPLATE="$PROJECT_ROOT/launchd/$LABEL.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MAC_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
STATE_FILE="${CURSOR_DESKTOP_BRIDGE_STATE_FILE:-$HOME/.cursor-desktop-bridge/state.json}"
LOG_DIR="${CURSOR_DESKTOP_BRIDGE_LOG_DIR:-$HOME/Library/Logs/andrea/cursor-desktop-bridge}"
ENTRYPOINT="$PROJECT_ROOT/dist/cursor-desktop-bridge-main.js"
READY_TIMEOUT_SECONDS=45

usage() {
  cat <<USAGE
Usage: scripts/cursor-desktop-bridge-service.sh <command>

Commands: dry-run, install, status, restart, stop, uninstall

The bridge is loopback-only. Cursor desktop terminal/session support and
standalone agent execution remain separate capabilities. No GUI automation is used.
USAGE
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }
escape_sed_replacement() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
render_value() { escape_sed_replacement "$(xml_escape "$1")"; }
render_plist() {
  sed \
    -e "s|{{PROJECT_ROOT}}|$(render_value "$PROJECT_ROOT")|g" \
    -e "s|{{HOME}}|$(render_value "$HOME")|g" \
    -e "s|{{PATH}}|$(render_value "$MAC_PATH")|g" \
    -e "s|{{STATE_FILE}}|$(render_value "$STATE_FILE")|g" \
    -e "s|{{LOG_DIR}}|$(render_value "$LOG_DIR")|g" \
    "$TEMPLATE"
}
domain() { printf 'gui/%s' "$(id -u)"; }
service_target() { printf '%s/%s' "$(domain)" "$LABEL"; }
is_bootstrapped() { launchctl print "$(service_target)" >/dev/null 2>&1; }
launchd_pid() { launchctl print "$(service_target)" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/ { print $3; exit }'; }
resolve_pinned_node() {
  local pinned_node
  pinned_node="$(node "$PROJECT_ROOT/scripts/run-with-pinned-node.mjs" --print-node-path)"
  [[ -n "$pinned_node" && -x "$pinned_node" ]] || { echo "verified pinned Node executable is unavailable" >&2; return 1; }
  printf '%s' "$pinned_node"
}
validate_rendered_plist() {
  render_plist | plutil -lint - >/dev/null
  if render_plist | grep -q '{{[A-Z_]'; then echo "rendered bridge plist contains an unresolved placeholder" >&2; return 1; fi
}
preflight() {
  local pinned_node
  [[ -f "$TEMPLATE" ]] || { echo "missing template: $TEMPLATE" >&2; return 1; }
  [[ -x "$PROJECT_ROOT/scripts/cursor-desktop-bridge-runner.sh" ]] || { echo "bridge runner is not executable" >&2; return 1; }
  [[ -f "$ENTRYPOINT" ]] || { echo "$ENTRYPOINT is missing; run npm run build first" >&2; return 1; }
  validate_rendered_plist
  pinned_node="$(resolve_pinned_node)"
  "$pinned_node" "$PROJECT_ROOT/scripts/check-node-version.js"
  "$pinned_node" "$ENTRYPOINT" --check-config
}
prepare_private_paths() {
  local pinned_node
  umask 077
  mkdir -p "$HOME/Library/LaunchAgents"
  mkdir -p -m 700 "$(dirname "$STATE_FILE")" "$LOG_DIR"
  chmod 700 "$(dirname "$STATE_FILE")" "$LOG_DIR"
  touch "$LOG_DIR/stdout.log" "$LOG_DIR/stderr.log"
  chmod 600 "$LOG_DIR/stdout.log" "$LOG_DIR/stderr.log"
  pinned_node="$(resolve_pinned_node)"
  "$pinned_node" "$ENTRYPOINT" --prepare-storage
}
wait_for_ready() {
  local expected_pid pinned_node started_at
  pinned_node="$(resolve_pinned_node)"
  started_at=$SECONDS
  while (( SECONDS - started_at < READY_TIMEOUT_SECONDS )); do
    expected_pid="$(launchd_pid || true)"
    if [[ -n "$expected_pid" ]] && "$pinned_node" "$ENTRYPOINT" --check-health "--expected-pid=$expected_pid" >/dev/null 2>&1; then
      "$pinned_node" "$ENTRYPOINT" --check-health "--expected-pid=$expected_pid"; return 0
    fi
    sleep 1
  done
  echo "Cursor desktop bridge did not become ready" >&2; return 1
}
dry_run() { preflight; echo "label=$LABEL"; echo "plist=$PLIST"; echo "state_file=$STATE_FILE"; echo "log_dir=$LOG_DIR"; echo "dry_run=valid (no files written and no service changed)"; }
install_service() {
  local temporary_plist
  preflight; prepare_private_paths
  temporary_plist="$(mktemp "$PLIST.tmp.XXXXXX")"; trap 'rm -f -- "$temporary_plist"' EXIT
  render_plist > "$temporary_plist"; chmod 600 "$temporary_plist"; plutil -lint "$temporary_plist" >/dev/null; mv -f "$temporary_plist" "$PLIST"; trap - EXIT
  if is_bootstrapped; then launchctl bootout "$(service_target)" >/dev/null 2>&1 || true; fi
  launchctl enable "$(service_target)"; launchctl bootstrap "$(domain)" "$PLIST"; wait_for_ready
  echo "installed $LABEL at $PLIST"
}
restart_service() {
  [[ -f "$PLIST" ]] || { echo "$PLIST is not installed; run install first" >&2; return 1; }
  preflight; prepare_private_paths; launchctl enable "$(service_target)"
  if is_bootstrapped; then launchctl kickstart -k "$(service_target)"; else launchctl bootstrap "$(domain)" "$PLIST"; fi
  wait_for_ready; echo "restarted $LABEL"
}
stop_service() { launchctl disable "$(service_target)" >/dev/null 2>&1 || true; if is_bootstrapped; then launchctl bootout "$(service_target)" >/dev/null; fi; echo "stopped $LABEL"; }
status_service() {
  local expected_pid pinned_node
  echo "label=$LABEL"; echo "plist=$PLIST"; echo "state_file=$STATE_FILE"; echo "log_dir=$LOG_DIR"; echo "plist_installed=$([[ -f "$PLIST" ]] && echo yes || echo no)"
  if is_bootstrapped; then echo "launchd=bootstrapped"; launchctl print "$(service_target)" 2>/dev/null | awk '/state =|pid =|last exit code =|program =/ { gsub(/^[[:space:]]+/, ""); print }'; else echo "launchd=not_bootstrapped"; fi
  if [[ -f "$ENTRYPOINT" ]]; then pinned_node="$(resolve_pinned_node)"; "$pinned_node" "$ENTRYPOINT" --check-config || true; expected_pid="$(launchd_pid || true)"; if [[ -n "$expected_pid" ]]; then "$pinned_node" "$ENTRYPOINT" --check-health "--expected-pid=$expected_pid" || true; fi; fi
  [[ -d "$(dirname "$STATE_FILE")" ]] && stat -f 'state_permissions=%Lp path=%N' "$(dirname "$STATE_FILE")" 2>/dev/null || true
  [[ -d "$LOG_DIR" ]] && stat -f 'log_permissions=%Lp path=%N' "$LOG_DIR" 2>/dev/null || true
}
uninstall_service() { if is_bootstrapped; then launchctl bootout "$(service_target)" >/dev/null 2>&1 || true; fi; rm -f "$PLIST"; echo "removed $PLIST; bridge state and logs were preserved"; }

case "${1:-}" in
  dry-run) dry_run ;; install) install_service ;; status) status_service ;; restart) restart_service ;; stop) stop_service ;; uninstall) uninstall_service ;; *) usage; exit 2 ;;
esac
