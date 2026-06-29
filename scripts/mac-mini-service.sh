#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${NANOCLAW_LAUNCHD_LABEL:-com.nanoclaw.mac-mini}"
TEMPLATE="$PROJECT_ROOT/launchd/com.nanoclaw.mac-mini.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ASSISTANT_NAME="${ASSISTANT_NAME:-Andrea}"
MAC_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
STATE_DIR="${ANDREA_STATE_DIR:-$HOME/.andrea}"
LOG_DIR="${ANDREA_LOG_DIR:-$HOME/Library/Logs/andrea}"

usage() {
  cat <<USAGE
Usage: scripts/mac-mini-service.sh <command>

Commands:
  render       Print the launchd plist to stdout
  install      Render, validate, and bootstrap the LaunchAgent
  uninstall    Boot out and remove the LaunchAgent plist
  start        Bootstrap the LaunchAgent if needed, then kickstart it
  stop         Stop the LaunchAgent
  restart      Stop then start the LaunchAgent
  status       Show launchd, process, build, and log status
  logs         Tail service stdout/stderr logs
  doctor       Run the Mac mini AGI doctor helper

Environment:
  NANOCLAW_LAUNCHD_LABEL overrides $LABEL
  ASSISTANT_NAME overrides $ASSISTANT_NAME
  ANDREA_STATE_DIR overrides $STATE_DIR
  ANDREA_LOG_DIR overrides $LOG_DIR
USAGE
}

escape_sed() {
  printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

render_plist() {
  local project home label path assistant state_dir log_dir
  project="$(escape_sed "$PROJECT_ROOT")"
  home="$(escape_sed "$HOME")"
  label="$(escape_sed "$LABEL")"
  path="$(escape_sed "$MAC_PATH")"
  assistant="$(escape_sed "$ASSISTANT_NAME")"
  state_dir="$(escape_sed "$STATE_DIR")"
  log_dir="$(escape_sed "$LOG_DIR")"
  sed \
    -e "s/{{PROJECT_ROOT}}/$project/g" \
    -e "s/{{HOME}}/$home/g" \
    -e "s/{{LABEL}}/$label/g" \
    -e "s/{{PATH}}/$path/g" \
    -e "s/{{ASSISTANT_NAME}}/$assistant/g" \
    -e "s/{{ANDREA_STATE_DIR}}/$state_dir/g" \
    -e "s/{{LOG_DIR}}/$log_dir/g" \
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

install_service() {
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$STATE_DIR" "$PROJECT_ROOT/data/run"
  render_plist > "$PLIST"
  plutil -lint "$PLIST" >/dev/null
  if is_bootstrapped; then
    launchctl bootout "$(domain)" "$PLIST" >/dev/null 2>&1 || true
  fi
  launchctl bootstrap "$(domain)" "$PLIST"
  launchctl enable "$(service_target)"
  launchctl kickstart -k "$(service_target)"
  echo "installed $LABEL at $PLIST"
}

uninstall_service() {
  if is_bootstrapped || [[ -f "$PLIST" ]]; then
    launchctl bootout "$(domain)" "$PLIST" >/dev/null 2>&1 || true
  fi
  rm -f "$PLIST"
  echo "removed $PLIST"
}

start_service() {
  if [[ ! -f "$PLIST" ]]; then
    install_service
    return
  fi
  if ! is_bootstrapped; then
    launchctl bootstrap "$(domain)" "$PLIST"
  fi
  launchctl enable "$(service_target)"
  launchctl kickstart -k "$(service_target)"
  echo "started $LABEL"
}

stop_service() {
  if is_bootstrapped; then
    launchctl disable "$(service_target)" >/dev/null 2>&1 || true
    launchctl bootout "$(domain)" "$PLIST" >/dev/null 2>&1 || true
    sleep 1
  fi
  echo "stopped $LABEL"
}

status_service() {
  echo "label=$LABEL"
  echo "plist=$PLIST"
  echo "project_root=$PROJECT_ROOT"
  echo "state_dir=$STATE_DIR"
  echo "log_dir=$LOG_DIR"
  echo "plist_installed=$([[ -f "$PLIST" ]] && echo yes || echo no)"
  echo "dist_index=$([[ -f "$PROJECT_ROOT/dist/index.js" ]] && echo present || echo missing)"
  echo "node=$(command -v node || true)"
  node --version 2>/dev/null || true
  if is_bootstrapped; then
    echo "launchd=bootstrapped"
    launchctl print "$(service_target)" 2>/dev/null | awk '/state =|pid =|last exit code =|program =/ { gsub(/^[[:space:]]+/, ""); print }'
  else
    echo "launchd=not_bootstrapped"
  fi
  if [[ -f "$PROJECT_ROOT/data/run/mac-mini-service.pid" ]]; then
    local pid
    pid="$(cat "$PROJECT_ROOT/data/run/mac-mini-service.pid")"
    if ps -p "$pid" >/dev/null 2>&1; then
      echo "pid_file=$pid running"
    else
      echo "pid_file=$pid stale"
    fi
  else
    echo "pid_file=missing"
  fi
  ls -lh "$LOG_DIR"/mac-mini-service.*.log 2>/dev/null || true
}

case "${1:-}" in
  render) render_plist ;;
  install) install_service ;;
  uninstall|remove) uninstall_service ;;
  start) start_service ;;
  stop) stop_service ;;
  restart)
    stop_service
    start_service
    ;;
  status) status_service ;;
  logs)
    mkdir -p "$LOG_DIR"
    touch "$LOG_DIR/mac-mini-service.out.log" "$LOG_DIR/mac-mini-service.err.log"
    tail -n "${2:-80}" -f "$LOG_DIR/mac-mini-service.out.log" "$LOG_DIR/mac-mini-service.err.log"
    ;;
  doctor) "$PROJECT_ROOT/scripts/agi-doctor.sh" ;;
  -h|--help|help|'') usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
