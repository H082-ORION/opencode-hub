#!/usr/bin/env bash
# Install an opencode hub behind Caddy on a Debian/Ubuntu VPS. Safe to re-run.
#
#   sudo ./install.sh --domain hub.example.com --email you@example.com \
#     [--binary /path/to/opencode] [--port 4800] [--user opencode]
set -euo pipefail

DOMAIN=""
EMAIL=""
BINARY=""
PORT="4800"
SERVICE_USER="opencode"
DATA_DIR="/var/lib/opencode-hub"
# Held the single hub password of earlier versions; no longer created, removed when found.
OLD_ENV_FILE="/etc/opencode-hub.env"
UNIT_FILE="/etc/systemd/system/opencode-hub.service"
CADDYFILE="/etc/caddy/Caddyfile"
INVITATION=""

usage() {
  cat <<EOF
Usage: sudo $0 --domain <hub.example.com> --email <you@example.com> [options]

Options:
  --domain <host>    Public hub hostname. Machines are served at <id>.<host>. (required)
  --email <address>  ACME account email used by Caddy for certificates. (required)
  --binary <path>    opencode binary to install to /usr/local/bin/opencode.
                     Without it, an opencode already on PATH is used.
  --port <port>      Local port the hub listens on (default: 4800).
  --user <name>      System user running the hub (default: opencode).
  -h, --help         Show this help.
EOF
}

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

need_value() {
  [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 requires a value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) need_value "$@"; DOMAIN="$2"; shift 2 ;;
    --email) need_value "$@"; EMAIL="$2"; shift 2 ;;
    --binary) need_value "$@"; BINARY="$2"; shift 2 ;;
    --port) need_value "$@"; PORT="$2"; shift 2 ;;
    --user) need_value "$@"; SERVICE_USER="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root (sudo $0 ...)"
[[ -n "$DOMAIN" ]] || { usage >&2; die "--domain is required"; }
[[ -n "$EMAIL" ]] || { usage >&2; die "--email is required"; }

DOMAIN="${DOMAIN,,}"
DOMAIN="${DOMAIN%.}"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] ||
  die "--domain must be a bare hostname such as hub.example.com (got: $DOMAIN)"
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "--email looks invalid: $EMAIL"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  die "--port must be 1-65535 (got: $PORT)"
fi
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "--user must be a valid user name (got: $SERVICE_USER)"
if [[ -n "$BINARY" ]]; then
  [[ -f "$BINARY" ]] || die "--binary not found: $BINARY"
fi

command -v apt-get >/dev/null || die "this installer supports Debian/Ubuntu (apt-get) only"
command -v systemctl >/dev/null || die "systemd is required"

export DEBIAN_FRONTEND=noninteractive

# --- Base tools ----------------------------------------------------------------------------------------------------

missing=()
for tool in curl gpg openssl; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if ((${#missing[@]})); then
  log "Installing base tools"
  apt-get update -q
  apt-get install -y -q curl gnupg openssl ca-certificates
fi

# --- DNS check (warn only) -----------------------------------------------------------------------------------------

public_ip() {
  local url ip
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]')" || continue
    [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && { echo "$ip"; return 0; }
  done
  return 1
}

resolve_v4() {
  { getent ahostsv4 "$1" 2>/dev/null || true; } | awk '{ print $1 }' | sort -u
}

check_dns() {
  local ip label host resolved
  if ! ip="$(public_ip)"; then
    warn "could not determine this server's public IPv4 address; skipping the DNS check"
    return
  fi
  log "Public IPv4: $ip"
  label="dnscheck-$(openssl rand -hex 4)"
  for host in "$DOMAIN" "$label.$DOMAIN"; do
    resolved="$(resolve_v4 "$host" | tr '\n' ' ')"
    if [[ -z "$resolved" ]]; then
      warn "$host does not resolve. Add an A record for $( [[ $host == "$DOMAIN" ]] && echo "$DOMAIN" || echo "*.$DOMAIN" ) -> $ip"
    elif ! grep -qwF -- "$ip" <<<"$resolved"; then
      warn "$host resolves to $resolved, not to this server ($ip). Certificates will fail until DNS points here."
    else
      log "DNS ok: $host -> $ip"
    fi
  done
}

check_dns

# --- Caddy ---------------------------------------------------------------------------------------------------------

if command -v caddy >/dev/null; then
  log "Caddy already installed ($(caddy version | head -n1))"
else
  log "Installing Caddy from the official apt repository"
  apt-get update -q
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
    gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

# --- User and binary -----------------------------------------------------------------------------------------------

if id "$SERVICE_USER" >/dev/null 2>&1; then
  log "User $SERVICE_USER already exists"
else
  log "Creating system user $SERVICE_USER"
  useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
# Accounts, OPAQUE records and the OPAQUE server key: readable by the hub user only.
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
# Without a database the hub has no account yet; an administrator invitation follows its start.
FIRST_INSTALL=""
[[ -f "$DATA_DIR/hub.db" ]] || FIRST_INSTALL=1

if [[ -n "$BINARY" ]]; then
  log "Installing $BINARY to /usr/local/bin/opencode"
  install -m 0755 "$BINARY" /usr/local/bin/opencode.new
  mv -f /usr/local/bin/opencode.new /usr/local/bin/opencode
fi
OPENCODE_BIN="$(command -v opencode || true)"
[[ -n "$OPENCODE_BIN" ]] || die "opencode is not on PATH; pass --binary /path/to/opencode"
OPENCODE_BIN="$(readlink -f "$OPENCODE_BIN")"
# The service user must be able to execute it, so binaries under /root or /home will not work.
runuser -u "$SERVICE_USER" -- test -x "$OPENCODE_BIN" ||
  die "$SERVICE_USER cannot execute $OPENCODE_BIN; pass --binary to install it to /usr/local/bin"
log "Using $OPENCODE_BIN ($("$OPENCODE_BIN" --version 2>/dev/null || echo "unknown version"))"

# --- Caddyfile -----------------------------------------------------------------------------------------------------

caddyfile_content() {
  cat <<EOF
# Managed by opencode script/hub/install.sh
{
	email $EMAIL
	on_demand_tls {
		ask http://127.0.0.1:$PORT/hub/tls-allowed
	}
}

$DOMAIN, *.$DOMAIN {
	tls {
		on_demand
	}
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
}

new_caddyfile="$(mktemp)"
trap 'rm -f "$new_caddyfile"' EXIT
caddyfile_content >"$new_caddyfile"
caddy fmt --overwrite "$new_caddyfile" >/dev/null 2>&1 || true
log "Validating Caddyfile"
caddy validate --adapter caddyfile --config "$new_caddyfile" >/dev/null 2>&1 ||
  { caddy validate --adapter caddyfile --config "$new_caddyfile" || true; die "generated Caddyfile is invalid"; }

mkdir -p /etc/caddy
if [[ -f "$CADDYFILE" ]] && cmp -s "$new_caddyfile" "$CADDYFILE"; then
  log "Caddyfile unchanged"
else
  if [[ -f "$CADDYFILE" ]]; then
    backup="$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$CADDYFILE" "$backup"
    log "Backed up existing Caddyfile to $backup"
  fi
  install -m 0644 "$new_caddyfile" "$CADDYFILE"
  log "Wrote $CADDYFILE"
fi
caddy validate --adapter caddyfile --config "$CADDYFILE" >/dev/null

# --- Systemd unit --------------------------------------------------------------------------------------------------

if [[ -f "$OLD_ENV_FILE" ]]; then
  rm -f "$OLD_ENV_FILE"
  log "Removed $OLD_ENV_FILE: accounts replace the old hub password"
fi

log "Writing $UNIT_FILE"
cat >"$UNIT_FILE" <<EOF
# Managed by opencode script/hub/install.sh
[Unit]
Description=opencode hub
Documentation=https://opencode.ai
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
Environment=HOME=$DATA_DIR
Environment=XDG_DATA_HOME=$DATA_DIR/.local/share
Environment=XDG_CONFIG_HOME=$DATA_DIR/.config
Environment=XDG_CACHE_HOME=$DATA_DIR/.cache
Environment=XDG_STATE_HOME=$DATA_DIR/.local/state
WorkingDirectory=$DATA_DIR
ExecStart=$OPENCODE_BIN hub --hostname 127.0.0.1 --port $PORT --url https://$DOMAIN --data $DATA_DIR
Restart=on-failure
RestartSec=2

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF

# --- Firewall ------------------------------------------------------------------------------------------------------

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  log "Opening ports 80 and 443 in ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

# --- Services ------------------------------------------------------------------------------------------------------

log "Starting services"
systemctl daemon-reload
systemctl enable opencode-hub >/dev/null 2>&1
systemctl restart opencode-hub
systemctl enable caddy >/dev/null 2>&1
if systemctl is-active --quiet caddy; then
  systemctl reload caddy || systemctl restart caddy
else
  systemctl restart caddy
fi

healthy=""
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/hub/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 0.5
done
[[ -n "$healthy" ]] || warn "the hub did not answer on 127.0.0.1:$PORT yet; check: journalctl -u opencode-hub -e"

# The first account comes from an invitation, created as the hub user with the service's environment.
INVITE_COMMAND=(runuser -u "$SERVICE_USER" -- env HOME="$DATA_DIR" XDG_DATA_HOME="$DATA_DIR/.local/share"
  XDG_CONFIG_HOME="$DATA_DIR/.config" XDG_CACHE_HOME="$DATA_DIR/.cache" XDG_STATE_HOME="$DATA_DIR/.local/state"
  "$OPENCODE_BIN" hub invite --admin --data "$DATA_DIR")
if [[ -n "$healthy" && -n "$FIRST_INSTALL" ]]; then
  output="$("${INVITE_COMMAND[@]}" 2>&1)" || warn "could not create the administrator invitation: $output"
  INVITATION="$(grep -oE 'https?://[^[:space:]]+/register\?invite=[^[:space:]]+' <<<"$output" | tail -n1 || true)"
fi

# --- Summary -------------------------------------------------------------------------------------------------------

cat <<EOF

opencode hub installed.

  Dashboard:   https://$DOMAIN
  Machines:    https://<machine-id>.$DOMAIN
  Hub logs:    journalctl -u opencode-hub -f
  Caddy logs:  journalctl -u caddy -f
  Invitation:  sudo -u $SERVICE_USER env HOME=$DATA_DIR $OPENCODE_BIN hub invite --admin --data $DATA_DIR

Enroll a machine: open the dashboard, click "add machine", then on the machine run
  opencode agent join https://$DOMAIN --code <code>
  opencode agent run
EOF

if [[ -n "$INVITATION" ]]; then
  cat <<EOF

Administrator invitation (one-time link, valid for 7 days, shown only once):

  $INVITATION

EOF
fi
