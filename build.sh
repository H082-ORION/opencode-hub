#!/usr/bin/env bash
# Builds everything needed to run the hub and agents from this checkout:
# dependencies, the web UI (main app and hub dashboard), the relay/agent tests, and an opencode binary.
#
#   ./build.sh                    # binary for this machine
#   ./build.sh --target linux-x64 # binary for another platform, e.g. the VPS (linux-arm64, darwin-arm64, ...)
#   ./build.sh --ui-only          # only rebuild packages/app/dist, for `bun run dev hub` / `bun run dev agent run`
#   ./build.sh --skip-tests
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

target=""
ui_only=0
tests=1
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="${2:?--target needs a value such as linux-x64}"; shift 2 ;;
    --target=*) target="${1#--target=}"; shift ;;
    --ui-only) ui_only=1; shift ;;
    --skip-tests) tests=0; shift ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if ! command -v bun >/dev/null 2>&1; then
  [ -x "$HOME/.bun/bin/bun" ] && export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || { echo "bun is required: https://bun.sh" >&2; exit 1; }
expected="$(sed -n 's/.*"packageManager": "bun@\([^"]*\)".*/\1/p' package.json)"
actual="$(bun --version)"
[ "$expected" = "$actual" ] || echo "warning: this repo expects bun $expected, found $actual" >&2

step "Installing dependencies"
bun install

if [ "$tests" = 1 ]; then
  step "Testing the hub and agent"
  (cd packages/relay && bun test)
  (cd packages/cli && bun test --timeout 30000 test/relay-agent.test.ts)
fi

if [ "$ui_only" = 1 ]; then
  step "Building the web UI"
  (cd packages/app && VITE_OPENCODE_SERVER_MODE=origin bun run build)
  [ -f packages/app/dist/hub.html ] || { echo "packages/app/dist/hub.html is missing" >&2; exit 1; }
  step "Done"
  echo "Web UI built in packages/app/dist."
  echo "Restart running dev processes so they load it: bun run dev service restart, then restart bun run dev hub."
  exit 0
fi

# The CLI build also builds the web UI (packages/app/dist) and embeds it in the binary.
step "Building the opencode binary${target:+ for $target}"
if [ -n "$target" ]; then
  (cd packages/cli && OPENCODE_TARGET="$target" bun run build)
  name="cli-$target"
else
  # `bun install` above already fetched this platform's native packages; the CLI build would otherwise download
  # every platform's (only cross builds need them), which dominates the build time.
  (cd packages/cli && bun run build --single --skip-install)
  name="$(ls packages/cli/dist | head -n 1)"
fi
[ -f packages/app/dist/hub.html ] || { echo "packages/app/dist/hub.html is missing" >&2; exit 1; }

binary="$(find "packages/cli/dist/$name/bin" -maxdepth 1 -type f -name 'opencode*' | head -n 1)"
[ -n "$binary" ] || { echo "No binary found in packages/cli/dist/$name/bin" >&2; exit 1; }

step "Done"
echo "Binary: $root/$binary"
[ -z "$target" ] && "$binary" --version 2>/dev/null | sed 's/^/Version: /' || true
cat <<EOF

Next steps:
  Local hub:      $binary hub
  On the VPS:     sudo script/hub/install.sh --domain hub.example.com --email you@example.com --binary <path to binary>
  On a machine:   $binary agent join <hub url> --code <code> && $binary agent run
EOF
