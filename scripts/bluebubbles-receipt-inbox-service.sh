#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
LABEL="com.nanoclaw.bluebubbles-receipt-inbox"
TEMPLATE="$PROJECT_ROOT/launchd/com.nanoclaw.bluebubbles-receipt-inbox.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MAC_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
READY_TIMEOUT_SECONDS=45

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
ENTRYPOINT="$PROJECT_ROOT/dist/bluebubbles-receipt-inbox-main.js"

usage() {
  cat <<USAGE
Usage: scripts/bluebubbles-receipt-inbox-service.sh <command>

Commands:
  dry-run     Validate config, build output, runner, and rendered plist only
  install     Install and bootstrap the dedicated LaunchAgent
  status      Show dedicated LaunchAgent, health, state, and log status
  restart     Restart only the receipt-inbox LaunchAgent
  stop        Disable and stop only the receipt-inbox LaunchAgent
  uninstall   Stop and remove the receipt-inbox LaunchAgent plist

This manager never starts, stops, or restarts the main NanoClaw service.
USAGE
}

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

render_value() {
  escape_sed_replacement "$(xml_escape "$1")"
}

render_plist() {
  local project home path_value state_dir log_root sidecar_log_dir
  project="$(render_value "$PROJECT_ROOT")"
  home="$(render_value "$HOME")"
  path_value="$(render_value "$MAC_PATH")"
  state_dir="$(render_value "$ANDREA_STATE_DIR")"
  log_root="$(render_value "$ANDREA_LOG_DIR")"
  sidecar_log_dir="$(render_value "$SIDECAR_LOG_DIR")"
  sed \
    -e "s|{{PROJECT_ROOT}}|$project|g" \
    -e "s|{{HOME}}|$home|g" \
    -e "s|{{PATH}}|$path_value|g" \
    -e "s|{{ANDREA_STATE_DIR}}|$state_dir|g" \
    -e "s|{{ANDREA_LOG_ROOT}}|$log_root|g" \
    -e "s|{{SIDECAR_LOG_DIR}}|$sidecar_log_dir|g" \
    "$TEMPLATE"
}

domain() {
  printf 'gui/%s' "$(id -u)"
}

service_target() {
  printf '%s/%s' "$(domain)" "$LABEL"
}

is_bootstrapped() {
  launchctl print "$(service_target)" >/dev/null 2>&1
}

launchd_pid() {
  launchctl print "$(service_target)" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/ { print $3; exit }'
}

resolve_pinned_node() {
  local pinned_node
  pinned_node="$(node "$PROJECT_ROOT/scripts/run-with-pinned-node.mjs" --print-node-path)"
  if [[ -z "$pinned_node" || ! -x "$pinned_node" ]]; then
    echo "verified pinned Node executable is unavailable" >&2
    return 1
  fi
  printf '%s' "$pinned_node"
}

validate_rendered_plist() {
  render_plist | plutil -lint - >/dev/null
  if render_plist | grep -q '{{[A-Z_]'; then
    echo "rendered receipt-inbox plist contains an unresolved placeholder" >&2
    return 1
  fi
}

preflight() {
  local pinned_node
  [[ -f "$TEMPLATE" ]] || {
    echo "missing LaunchAgent template: $TEMPLATE" >&2
    return 1
  }
  [[ -x "$PROJECT_ROOT/scripts/bluebubbles-receipt-inbox-runner.sh" ]] || {
    echo "receipt-inbox runner is not executable" >&2
    return 1
  }
  [[ -f "$ENTRYPOINT" ]] || {
    echo "$ENTRYPOINT is missing; run npm run build first" >&2
    return 1
  }
  validate_rendered_plist
  pinned_node="$(resolve_pinned_node)"
  "$pinned_node" "$PROJECT_ROOT/scripts/check-node-version.js"
  "$pinned_node" "$ENTRYPOINT" --check-config
}

prepare_private_paths() {
  local pinned_node
  umask 077
  mkdir -p "$HOME/Library/LaunchAgents" "$ANDREA_STATE_DIR" "$ANDREA_LOG_DIR"
  mkdir -p -m 700 "$SIDECAR_STATE_DIR" "$SIDECAR_LOG_DIR"
  chmod 700 "$SIDECAR_STATE_DIR" "$SIDECAR_LOG_DIR"
  touch "$SIDECAR_LOG_DIR/stdout.log" "$SIDECAR_LOG_DIR/stderr.log"
  chmod 600 "$SIDECAR_LOG_DIR/stdout.log" "$SIDECAR_LOG_DIR/stderr.log"
  pinned_node="$(resolve_pinned_node)"
  "$pinned_node" "$ENTRYPOINT" --prepare-storage
}

wait_for_ready() {
  local expected_pid pinned_node started_at
  pinned_node="$(resolve_pinned_node)"
  started_at=$SECONDS
  while (( SECONDS - started_at < READY_TIMEOUT_SECONDS )); do
    expected_pid="$(launchd_pid || true)"
    if [[ -n "$expected_pid" ]] &&
      "$pinned_node" "$ENTRYPOINT" --check-health "--expected-pid=$expected_pid" >/dev/null 2>&1; then
      "$pinned_node" "$ENTRYPOINT" --check-health "--expected-pid=$expected_pid"
      return 0
    fi
    sleep 1
  done
  echo "receipt-inbox health check did not become ready within ${READY_TIMEOUT_SECONDS}s" >&2
  status_service >&2 || true
  return 1
}

dry_run() {
  preflight
  echo "label=$LABEL"
  echo "plist=$PLIST"
  echo "state_dir=$SIDECAR_STATE_DIR"
  echo "log_dir=$SIDECAR_LOG_DIR"
  echo "dry_run=valid (no files written and no service changed)"
}

install_service() {
  local temporary_plist
  preflight
  prepare_private_paths
  temporary_plist="$(mktemp "$PLIST.tmp.XXXXXX")"
  trap "rm -f -- $(printf '%q' "$temporary_plist")" EXIT
  render_plist > "$temporary_plist"
  chmod 600 "$temporary_plist"
  plutil -lint "$temporary_plist" >/dev/null
  mv -f "$temporary_plist" "$PLIST"
  trap - EXIT
  if is_bootstrapped; then
    launchctl bootout "$(service_target)" >/dev/null 2>&1 || true
  fi
  launchctl enable "$(service_target)"
  launchctl bootstrap "$(domain)" "$PLIST"
  wait_for_ready
  echo "installed $LABEL at $PLIST"
}

restart_service() {
  [[ -f "$PLIST" ]] || {
    echo "$PLIST is not installed; run the install command first" >&2
    return 1
  }
  preflight
  prepare_private_paths
  launchctl enable "$(service_target)"
  if is_bootstrapped; then
    launchctl kickstart -k "$(service_target)"
  else
    launchctl bootstrap "$(domain)" "$PLIST"
  fi
  wait_for_ready
  echo "restarted $LABEL"
}

stop_service() {
  launchctl disable "$(service_target)" >/dev/null 2>&1 || true
  if is_bootstrapped; then
    launchctl bootout "$(service_target)" >/dev/null
  fi
  echo "stopped $LABEL"
}

status_service() {
  local expected_pid pinned_node
  echo "label=$LABEL"
  echo "plist=$PLIST"
  echo "project_root=$PROJECT_ROOT"
  echo "state_dir=$SIDECAR_STATE_DIR"
  echo "log_dir=$SIDECAR_LOG_DIR"
  echo "plist_installed=$([[ -f "$PLIST" ]] && echo yes || echo no)"
  echo "dist_entry=$([[ -f "$ENTRYPOINT" ]] && echo present || echo missing)"
  if is_bootstrapped; then
    echo "launchd=bootstrapped"
    launchctl print "$(service_target)" 2>/dev/null | awk '/state =|pid =|last exit code =|program =/ { gsub(/^[[:space:]]+/, ""); print }'
  else
    echo "launchd=not_bootstrapped"
  fi
  if [[ -f "$ENTRYPOINT" ]]; then
    pinned_node="$(resolve_pinned_node)"
    "$pinned_node" "$ENTRYPOINT" --check-config || true
    if is_bootstrapped; then
      expected_pid="$(launchd_pid || true)"
      if [[ -n "$expected_pid" ]]; then
        "$pinned_node" "$ENTRYPOINT" --check-health "--expected-pid=$expected_pid" || true
      else
        echo "health=unverified (launchd PID unavailable)"
      fi
    fi
  fi
  if [[ -d "$SIDECAR_STATE_DIR" ]]; then
    stat -f 'state_permissions=%Lp path=%N' "$SIDECAR_STATE_DIR" 2>/dev/null || true
  fi
  if [[ -d "$SIDECAR_LOG_DIR" ]]; then
    stat -f 'log_permissions=%Lp path=%N' "$SIDECAR_LOG_DIR" 2>/dev/null || true
    ls -l "$SIDECAR_LOG_DIR"/stdout.log "$SIDECAR_LOG_DIR"/stderr.log 2>/dev/null || true
  fi
}

uninstall_service() {
  if is_bootstrapped; then
    launchctl bootout "$(service_target)" >/dev/null 2>&1 || true
  fi
  rm -f "$PLIST"
  echo "removed $PLIST; receipt database and logs were preserved"
}

case "${1:-}" in
  dry-run) dry_run ;;
  install) install_service ;;
  status) status_service ;;
  restart) restart_service ;;
  stop) stop_service ;;
  uninstall|remove) uninstall_service ;;
  -h|--help|help|'') usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
