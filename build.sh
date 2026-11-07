#!/usr/bin/env bash
# Construit tout ce qu'il faut pour faire tourner le hub et les agents depuis ce dépôt :
# dépendances, interface web (application principale et tableau de bord du hub), tests du relais et de l'agent,
# et un binaire opencode.
# Builds everything needed to run the hub and agents from this checkout: dependencies, the web UI (main app and
# hub dashboard), the relay/agent tests, and an opencode binary.
#
#   ./build.sh                    # binaire pour cette machine / binary for this machine
#   ./build.sh --target linux-x64 # binaire pour une autre plateforme / for another platform (linux-arm64, darwin-arm64, ...)
#   ./build.sh --ui-only          # seulement packages/app/dist / only packages/app/dist
#   ./build.sh --skip-tests
#   ./build.sh --lang en          # langue des messages / message language (fr par défaut, ou OPENCODE_HUB_LANG)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

target=""
ui_only=0
tests=1
lang="${OPENCODE_HUB_LANG:-}"
aide=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="${2:?--target needs a value such as linux-x64}"; shift 2 ;;
    --target=*) target="${1#--target=}"; shift ;;
    --ui-only) ui_only=1; shift ;;
    --skip-tests) tests=0; shift ;;
    --lang) lang="${2:?--lang: fr | en}"; shift 2 ;;
    --lang=*) lang="${1#--lang=}"; shift ;;
    -h|--help) aide=1; shift ;;
    *) echo "Option inconnue / unknown option: $1" >&2; exit 2 ;;
  esac
done

# Langue : --lang, OPENCODE_HUB_LANG, sinon la question sur un terminal ; français par défaut.
if [ -z "$lang" ] && [ "$aide" = 0 ] && [ -t 0 ] && [ -t 1 ]; then
  printf 'Langue / Language : [1] Français  [2] English  (1) ? '
  read -r reponse || reponse=1
  [ "$reponse" = 2 ] && lang=en
fi
case "${lang,,}" in
  en*) lang=en ;;
  fr* | '') lang=fr ;;
  *) echo "--lang : fr ou en / fr or en (reçu / got: $lang)" >&2; exit 2 ;;
esac

# t "texte français" "english text"
t() { if [ "$lang" = en ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { echo "$1" >&2; exit 1; }

if [ "$aide" = 1 ]; then
  if [ "$lang" = en ]; then
    cat <<'EOF'
Builds everything needed to run the hub and agents from this checkout:
dependencies, the web UI (main app and hub dashboard), the relay/agent tests, and an opencode binary.

  ./build.sh                    # binary for this machine
  ./build.sh --target linux-x64 # binary for another platform, e.g. the VPS (linux-arm64, darwin-arm64, ...)
  ./build.sh --ui-only          # only rebuild packages/app/dist, for `bun run dev hub` / `bun run dev agent run`
  ./build.sh --skip-tests
  ./build.sh --lang fr|en       # message language (or OPENCODE_HUB_LANG; French by default)
EOF
  else
    cat <<'EOF'
Construit tout ce qu'il faut pour faire tourner le hub et les agents depuis ce dépôt :
dépendances, interface web (application et tableau de bord du hub), tests du relais et de l'agent, binaire opencode.

  ./build.sh                    # binaire pour cette machine
  ./build.sh --target linux-x64 # binaire pour une autre plateforme, par ex. le VPS (linux-arm64, darwin-arm64, ...)
  ./build.sh --ui-only          # seulement packages/app/dist, pour `bun run dev hub` / `bun run dev agent run`
  ./build.sh --skip-tests
  ./build.sh --lang fr|en       # langue des messages (ou OPENCODE_HUB_LANG ; français par défaut)
EOF
  fi
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  [ -x "$HOME/.bun/bin/bun" ] && export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || fail "$(t "bun est nécessaire : https://bun.sh" "bun is required: https://bun.sh")"
expected="$(sed -n 's/.*"packageManager": "bun@\([^"]*\)".*/\1/p' package.json)"
actual="$(bun --version)"
[ "$expected" = "$actual" ] || echo "$(t "attention : ce dépôt attend bun $expected, trouvé $actual" "warning: this repo expects bun $expected, found $actual")" >&2

step "$(t "Installation des dépendances" "Installing dependencies")"
bun install

if [ "$tests" = 1 ]; then
  step "$(t "Tests du hub et de l'agent" "Testing the hub and agent")"
  (cd packages/relay && bun test)
  (cd packages/cli && bun test --timeout 30000 test/relay-agent.test.ts)
fi

if [ "$ui_only" = 1 ]; then
  step "$(t "Construction de l'interface web" "Building the web UI")"
  (cd packages/app && VITE_OPENCODE_SERVER_MODE=origin bun run build)
  [ -f packages/app/dist/hub.html ] || fail "$(t "packages/app/dist/hub.html est absent" "packages/app/dist/hub.html is missing")"
  step "$(t "Terminé" "Done")"
  t "Interface web construite dans packages/app/dist." "Web UI built in packages/app/dist."; echo
  t "Redémarrer les processus de développement pour qu'ils la chargent : bun run dev service restart, puis relancer bun run dev hub." \
    "Restart running dev processes so they load it: bun run dev service restart, then restart bun run dev hub."; echo
  exit 0
fi

# La construction de la CLI construit aussi l'interface web (packages/app/dist) et l'embarque dans le binaire.
# The CLI build also builds the web UI (packages/app/dist) and embeds it in the binary.
step "$(t "Construction du binaire opencode" "Building the opencode binary")${target:+ $(t "pour" "for") $target}"
if [ -n "$target" ]; then
  (cd packages/cli && OPENCODE_TARGET="$target" bun run build)
  name="cli-$target"
else
  # `bun install` a déjà récupéré les paquets natifs de cette plateforme ; sans --skip-install, la construction
  # téléchargerait ceux de toutes les plateformes (utile seulement en compilation croisée), ce qui domine sa durée.
  (cd packages/cli && bun run build --single --skip-install)
  name="$(ls packages/cli/dist | head -n 1)"
fi
[ -f packages/app/dist/hub.html ] || fail "$(t "packages/app/dist/hub.html est absent" "packages/app/dist/hub.html is missing")"

binary="$(find "packages/cli/dist/$name/bin" -maxdepth 1 -type f -name 'opencode*' | head -n 1)"
[ -n "$binary" ] || fail "$(t "Aucun binaire dans" "No binary found in") packages/cli/dist/$name/bin"

step "$(t "Terminé" "Done")"
echo "$(t "Binaire" "Binary") : $root/$binary"
[ -z "$target" ] && "$binary" --version 2>/dev/null | sed "s/^/Version : /" || true
if [ "$lang" = en ]; then
  cat <<EOF

Next steps:
  Install (Caddy, hub, client, systemd services):  sudo ./install.sh --binary $binary
  Local hub:      $binary hub
  On a machine:   $binary agent join <hub url> --code <code> && $binary agent run
EOF
else
  cat <<EOF

Suite :
  Installer (Caddy, hub, client, services systemd) :  sudo ./install.sh --binary $binary
  Hub local :          $binary hub
  Sur une machine :    $binary agent join <url du hub> --code <code> && $binary agent run
EOF
fi
