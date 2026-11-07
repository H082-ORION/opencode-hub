#!/usr/bin/env bash
# Remove the opencode hub service installed by install.sh. Caddy stays installed.
#
#   sudo ./uninstall.sh [--purge] [--yes]
set -euo pipefail

DATA_DIR="/var/lib/opencode-hub"
# Only an install from before accounts has it; removed when found.
OLD_ENV_FILE="/etc/opencode-hub.env"
UNIT_FILE="/etc/systemd/system/opencode-hub.service"
CADDYFILE="/etc/caddy/Caddyfile"
PURGE=""
YES=""

usage() {
  cat <<EOF
Usage: sudo $0 [--purge] [--yes]

  --purge   Also delete $DATA_DIR (hub database: machines, providers, settings).
  --yes     Do not ask for confirmation.
EOF
}

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    -y | --yes) YES=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root (sudo $0 ...)"

if [[ -z "$YES" ]]; then
  [[ -t 0 ]] || die "not a terminal; pass --yes to confirm"
  prompt="Remove the opencode hub service"
  [[ -n "$PURGE" ]] && prompt+=" AND delete $DATA_DIR"
  read -r -p "$prompt? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || die "aborted"
fi

if systemctl list-unit-files opencode-hub.service >/dev/null 2>&1; then
  log "Stopping opencode-hub"
  systemctl disable --now opencode-hub >/dev/null 2>&1 || true
fi
rm -f "$UNIT_FILE"
systemctl daemon-reload
systemctl reset-failed opencode-hub >/dev/null 2>&1 || true
rm -f "$OLD_ENV_FILE"
log "Removed $UNIT_FILE"

if [[ -n "$PURGE" ]]; then
  rm -rf "$DATA_DIR"
  log "Deleted $DATA_DIR"
else
  log "Kept $DATA_DIR (use --purge to delete it)"
fi

latest_backup="$(find /etc/caddy -maxdepth 1 -name 'Caddyfile.bak.*' -type f 2>/dev/null | sort | tail -n1 || true)"
if [[ -n "$latest_backup" ]]; then
  cp -p "$latest_backup" "$CADDYFILE"
  log "Restored $CADDYFILE from $latest_backup"
  if command -v caddy >/dev/null && systemctl is-active --quiet caddy; then
    systemctl reload caddy || log "caddy reload failed; check: journalctl -u caddy -e"
  fi
elif [[ -f "$CADDYFILE" ]] && grep -q 'Managed by opencode script/hub/install.sh' "$CADDYFILE"; then
  log "No Caddyfile backup found; $CADDYFILE still proxies to the removed hub. Edit it, then: systemctl reload caddy"
fi

log "Done. Caddy is still installed; the system user and the opencode binary were left in place."
