#!/usr/bin/env bash
# Construit les binaires Linux et publie une version numérotée sur les releases GitHub de ce dépôt.
#
#   ./release.sh 1.0.0-pre.1 --notes notes.md   # pré-version
#   ./release.sh 1.0.0                          # version stable, marquée « latest » sur GitHub
#   ./release.sh 1.0.0-pre.2 --dry-run          # construit et vérifie sans rien publier
#   ./release.sh 1.0.0 --skip-tests
#
# Sans --notes, les notes reprennent les commits depuis la version précédente.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

CIBLES=(linux-x64 linux-arm64)
# Canal gardé d'une version à l'autre : il nomme la base locale et le service. Jamais `latest` : le binaire
# interrogerait les mises à jour d'opencode.ai et pourrait être remplacé par OpenCode officiel.
CANAL=remote-machines

fail() { echo "erreur : $1" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

version=""
notes=""
dry_run=0
tests=1
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) notes="${2:?--notes attend un fichier}"; shift 2 ;;
    --notes=*) notes="${1#--notes=}"; shift ;;
    --dry-run) dry_run=1; shift ;;
    --skip-tests) tests=0; shift ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    -*) fail "option inconnue : $1" ;;
    *) [ -z "$version" ] || fail "une seule version attendue"; version="$1"; shift ;;
  esac
done

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-pre\.[0-9]+)?$ ]] || fail "version attendue : X.Y.Z (stable) ou X.Y.Z-pre.N (pré-version), reçu : '$version'"
[ -z "$notes" ] || [ -f "$notes" ] || fail "fichier de notes introuvable : $notes"
tag="v$version"

# Tout ce qui peut empêcher la publication est vérifié avant plusieurs minutes de construction.
[ "$(git branch --show-current)" != dev ] || fail "la branche dev suit OpenCode officiel : publier depuis la branche du hub"
[ -z "$(git status --porcelain)" ] || fail "des modifications ne sont pas commitées : le binaire ne correspondrait pas au commit publié"
command -v gh >/dev/null 2>&1 || fail "gh est nécessaire : https://cli.github.com"
gh auth status >/dev/null 2>&1 || fail "gh n'est pas connecté : lancer gh auth login"
# Toujours explicite : dans un fork, gh pourrait sinon viser le dépôt parent.
depot="$(git remote get-url origin | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
[[ "$depot" =~ ^[^/]+/[^/]+$ ]] || fail "origin n'est pas un dépôt GitHub : $depot"
git fetch --quiet --tags origin
commit="$(git rev-parse HEAD)"
[ -n "$(git branch -r --contains "$commit")" ] || fail "le commit $commit n'est pas poussé sur origin"
! git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null || fail "le tag $tag existe déjà"

precedente="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD 2>/dev/null || true)"
[ -n "$notes" ] || [ -n "$precedente" ] || fail "première version : indiquer ses notes avec --notes"

sortie="$root/packages/cli/.cache/release/$version"
rm -rf "$sortie"
mkdir -p "$sortie"

case "$(uname -m)" in
  x86_64) hote=linux-x64 ;;
  aarch64) hote=linux-arm64 ;;
  *) hote="" ;;
esac

options_tests=()
[ "$tests" = 1 ] || options_tests=(--skip-tests)
for cible in "${CIBLES[@]}"; do
  step "Construction de $version pour $cible"
  OPENCODE_VERSION="$version" OPENCODE_CHANNEL="$CANAL" ./build.sh --target "$cible" --lang fr "${options_tests[@]}"
  # Les tests ne dépendent pas de la cible : une seule passe suffit.
  options_tests=(--skip-tests)
  bin="packages/cli/dist/cli-$cible/bin"
  if [ "$cible" = "$hote" ]; then
    annonce="$(timeout 30 "$bin/opencode" --version 2>&1)" || fail "le binaire $cible ne démarre pas : $annonce"
    [ "$annonce" = "opencode v$version" ] || fail "le binaire $cible annonce « $annonce » au lieu de $version"
  fi
  tar -czf "$sortie/opencode-$cible.tar.gz" -C "$bin" opencode
done

cp install-release.sh "$sortie/install-release.sh"
(cd "$sortie" && sha256sum opencode-*.tar.gz install-release.sh > SHA256SUMS)

{
  if [ -n "$notes" ]; then
    cat "$notes"
  else
    echo "## Changements depuis $precedente"
    echo
    git log --no-merges --format='- %s' "$precedente..$commit"
  fi
  cat <<EOF

## Installation (Linux x64 et arm64)

\`\`\`bash
curl -fsSL https://github.com/$depot/releases/download/$tag/install-release.sh | bash -s -- --version $version
\`\`\`

Remplace le binaire déjà installé. Les comptes et les données du hub ne sont pas touchés.
EOF
} > "$sortie/NOTES.md"

if [ "$dry_run" = 1 ]; then
  step "Essai terminé, rien n'a été publié"
  ls -la "$sortie"
  exit 0
fi

step "Publication de $tag sur $depot"
# D'abord en brouillon : personne ne voit une version dont l'envoi des binaires aurait échoué.
creation=()
edition=(--draft=false)
case "$version" in
  *-*) creation=(--prerelease) ;;
  *) edition+=(--latest) ;;
esac
timeout 3600 gh release create "$tag" "$sortie"/opencode-*.tar.gz "$sortie/install-release.sh" "$sortie/SHA256SUMS" \
  --repo "$depot" --target "$commit" --title "opencode-hub $version" --notes-file "$sortie/NOTES.md" --draft "${creation[@]}" ||
  fail "envoi échoué : un brouillon peut rester sur https://github.com/$depot/releases, à supprimer avant de relancer"
timeout 120 gh release edit "$tag" --repo "$depot" "${edition[@]}" ||
  fail "le brouillon $tag est complet mais pas publié : gh release edit $tag --repo $depot --draft=false"

step "Publié"
echo "https://github.com/$depot/releases/tag/$tag"
