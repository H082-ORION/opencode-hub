# opencode hub on a VPS

These scripts install an opencode hub behind [Caddy](https://caddyserver.com) on a Debian or Ubuntu server. The hub
serves the dashboard at `https://hub.example.com` and each enrolled machine at `https://<machine-id>.hub.example.com`.
See `specs/remote-machines.md` for the design.

## Prerequisites

- A VPS running Debian or Ubuntu with systemd, reachable on ports 80 and 443.
- A domain with DNS records pointing at the VPS for both the hub and its wildcard:
  - `hub.example.com` A (and AAAA if the VPS has IPv6)
  - `*.hub.example.com` A (and AAAA)
- An `opencode` binary for the server's architecture.

No DNS provider credentials are needed. Caddy issues one certificate per hostname on demand (HTTP-01 or TLS-ALPN), and
asks the hub (`/hub/tls-allowed`) first, so only the hub host and enrolled machines get certificates.

## Install

The interactive installer at the repository root, `sudo ./install.sh`, first asks for the language (French or
English, or `--lang fr|en`), then offers Caddy, the hub and the client (agent), each with an optional systemd
service started at boot. `./install.sh --help` lists the options for unattended installs. `./install.sh --status` shows the state of Caddy, the hub, the agent and the binary, and
`sudo ./install.sh --uninstall` removes the chosen components (`--purge` also deletes the hub data, the enrollment,
the Caddy package and the binary). The script below installs Caddy and the hub only.

```sh
sudo ./install.sh --domain hub.example.com --email you@example.com --binary ./opencode
```

Options: `--port` (default `4800`, the hub listens on `127.0.0.1` only), `--user` (default `opencode`). Without
`--binary`, an `opencode` already on `PATH` is used.

The installer is idempotent. It checks DNS (warnings only), installs Caddy from its official apt repository, creates
the system user with data in `/var/lib/opencode-hub`, writes `/etc/caddy/Caddyfile` (backing up any existing file),
writes `/etc/systemd/system/opencode-hub.service`, opens 80/443 if `ufw` is active and starts both services.

The hub has accounts instead of a password. On the first install the installer prints a one-time administrator
invitation link (valid 7 days): open it to choose a login and a password. Sign-in uses OPAQUE, so the password never
reaches the hub. Administrators invite other users from the dashboard. To create another administrator invitation, for
example after losing access, run as the hub user:

```sh
sudo -u opencode env HOME=/var/lib/opencode-hub opencode hub invite --admin --data /var/lib/opencode-hub
```

`/var/lib/opencode-hub` is owner-only (`0700`); `hub.db` and `opaque-server-setup` (the OPAQUE server key, kept out of
the database) are `0600`. An install from before accounts had `/etc/opencode-hub.env`; the installer removes it.

## Update

With the hub service installed by the root `install.sh`, administrators can update the hub from the dashboard
(Settings, Updates). The hub runs unprivileged, so it only drops a request in `/var/lib/opencode-hub/update/request`
(`{"version":"1.0.0"}`); the root unit `opencode-hub-update.path` notices it and runs
`/usr/local/lib/opencode-hub/update.sh` through `opencode-hub-update.service`. The script reads and removes the request
as the hub user, accepts only a release version (`X.Y.Z` or `X.Y.Z-pre.N`), downloads it from the
`H082-ORION/opencode-hub` releases, checks `SHA256SUMS` and `opencode --version`, replaces the binary of the hub
service atomically (the old one stays as `opencode.previous`), restarts the hub and, if running, `opencode-agent`. If
the hub does not come back, the previous binary is restored. Progress and result go to
`/var/lib/opencode-hub-update/status.json` and to `journalctl -u opencode-hub-update`. `./install.sh --status` shows
the updater and its last result; `--uninstall --hub` removes it.

To update by hand instead:

```sh
sudo install -m 0755 ./opencode /usr/local/bin/opencode
sudo systemctl restart opencode-hub
```

Re-running `install.sh --binary ./opencode` with the same options does the same.

## Uninstall

```sh
sudo ./uninstall.sh            # stop and remove the service
sudo ./uninstall.sh --purge    # also delete /var/lib/opencode-hub
```

Caddy stays installed. The most recent `Caddyfile.bak.*` backup is restored if there is one.

## Enroll a machine

In the dashboard, click "add machine" to get a one-time code, then on the machine:

```sh
opencode agent join https://hub.example.com       # asks for the code without echo
opencode agent run
```

`opencode agent run` must keep running for the machine to stay reachable. On Linux, run it as a systemd user service so
it reconnects after a reboot. Create `~/.config/systemd/user/opencode-agent.service`:

```ini
[Unit]
Description=opencode agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%h/.opencode/bin/opencode agent run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Adjust `ExecStart` to the output of `command -v opencode`. Then enable it, and enable lingering so it starts at boot
without a login session:

```sh
systemctl --user daemon-reload
systemctl --user enable --now opencode-agent
sudo loginctl enable-linger "$USER"
journalctl --user -u opencode-agent -f
```

## Local testing without Caddy

```sh
opencode hub
```

The dashboard is at `http://localhost:4800`, and machines are at `http://<machine-id>.localhost:4800` (browsers resolve
`*.localhost` to loopback). Enroll a local machine with `opencode agent join http://localhost:4800 --code <code>`.

From a source checkout (`bun run dev hub`, `bun run dev agent run`), the machine's server reads the web UI from
`packages/app/dist`, which release builds embed instead. Build it once with `bun run --cwd packages/app build`, then
`bun run dev service restart`; without it the machine answers `/` with an empty 500 (Firefox shows
`NS_ERROR_NET_ERROR_RESPONSE`) while the API still works.

## Troubleshooting

- Hub logs: `journalctl -u opencode-hub -f`. Health check: `curl http://127.0.0.1:4800/hub/health`.
- Certificates: `journalctl -u caddy -f`. Certificates are requested on the first HTTPS request to each host, so the
  first visit to a new machine can take a few seconds.
- The on-demand ask endpoint must answer 200 for hosts that should get a certificate:
  `curl -i "http://127.0.0.1:4800/hub/tls-allowed?domain=hub.example.com"`. A 404 for a machine host means that machine
  is not enrolled; Caddy then refuses the TLS handshake.
- Certificate errors that mention DNS or a timeout usually mean `*.hub.example.com` does not point at this server, or
  ports 80/443 are blocked by a cloud firewall.
- Validate the Caddy config with `caddy validate --config /etc/caddy/Caddyfile`.
