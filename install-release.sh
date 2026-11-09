#!/usr/bin/env bash
# Installe le binaire opencode-hub pour ce système depuis les releases GitHub, en remplaçant celui déjà en place.
# Installs the opencode-hub binary for this system from GitHub releases, replacing the one already in place.
#
#   install-release.sh                   # dernière version stable / latest stable version
#   install-release.sh --pre             # dernière version, pré-versions comprises / latest version, pre-releases included
#   install-release.sh --version 1.0.0   # une version précise / a specific version
#   install-release.sh --dir ~/bin       # dossier d'installation (défaut : /usr/local/bin) / install directory
#   install-release.sh --uninstall       # retire le binaire ; les données ne sont pas touchées / removes the binary, keeps data
set -euo pipefail

DEPOT="H082-ORION/opencode-hub"

case "${OPENCODE_HUB_LANG:-${LANG:-}}" in
  fr*) lang=fr ;;
  *) lang=en ;;
esac
t() { if [ "$lang" = fr ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
fail() { echo "$(t "erreur" "error") : $1" >&2; exit 1; }

version=""
pre=0
dir=/usr/local/bin
retirer=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:?--version}"; shift 2 ;;
    --version=*) version="${1#--version=}"; shift ;;
    --pre) pre=1; shift ;;
    --dir) dir="${2:?--dir}"; shift 2 ;;
    --dir=*) dir="${1#--dir=}"; shift ;;
    --uninstall) retirer=1; shift ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \?//'; exit 0 ;;
    *) fail "$(t "option inconnue" "unknown option") : $1" ;;
  esac
done
version="${version#v}"

# Écrit avec sudo seulement si le dossier n'est pas accessible à l'utilisateur.
mkdir -p "$dir" 2>/dev/null || true
if [ -w "$dir" ]; then
  en_root=()
else
  command -v sudo >/dev/null 2>&1 || fail "$(t "$dir n'est pas accessible en écriture, relancer en root" "$dir is not writable, run as root")"
  en_root=(sudo)
  sudo mkdir -p "$dir"
fi
cible="$dir/opencode"

if [ "$retirer" = 1 ]; then
  [ -e "$cible" ] || fail "$(t "aucun binaire dans" "no binary at") $cible"
  "${en_root[@]}" rm -f "$cible"
  echo "$(t "Binaire retiré" "Binary removed") : $cible"
  t "Les comptes, les machines et les données du hub sont conservés." "Hub accounts, machines and data are kept."; echo
  exit 0
fi

[ "$(uname -s)" = Linux ] || fail "$(t "seul Linux est pris en charge pour l'instant" "only Linux is supported for now") ($(uname -s))"
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "$(t "architecture non prise en charge" "unsupported architecture") : $(uname -m)" ;;
esac
if [ -f /etc/alpine-release ] || { ldd --version 2>&1 || true; } | grep -qi musl; then
  fail "$(t "les systèmes musl (Alpine) ne sont pas pris en charge" "musl systems (Alpine) are not supported")"
fi
for outil in curl tar sha256sum timeout; do
  command -v "$outil" >/dev/null 2>&1 || fail "$(t "outil manquant" "missing tool") : $outil"
done

if [ -z "$version" ]; then
  if [ "$pre" = 1 ]; then
    tag="$(curl -fsSL --connect-timeout 20 --max-time 60 "https://api.github.com/repos/$DEPOT/releases?per_page=1" |
      sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  else
    # La redirection de /releases/latest ne consomme pas le quota de l'API GitHub et ignore les pré-versions.
    url="$(curl -fsSL --connect-timeout 20 --max-time 60 -o /dev/null -w '%{url_effective}' "https://github.com/$DEPOT/releases/latest")"
    case "$url" in
      */releases/tag/*) tag="${url##*/}" ;;
      *) tag="" ;;
    esac
    [ -n "$tag" ] || fail "$(t "aucune version stable publiée : utiliser --pre ou --version" "no stable version published: use --pre or --version")"
  fi
  [ -n "$tag" ] || fail "$(t "aucune version publiée sur" "no version published on") $DEPOT"
  version="${tag#v}"
fi

archive="opencode-linux-$arch.tar.gz"
base="https://github.com/$DEPOT/releases/download/v$version"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "$(t "Téléchargement de" "Downloading") opencode-hub $version (linux-$arch)"
curl -fL --retry 3 --connect-timeout 20 --max-time 1800 --progress-bar -o "$tmp/$archive" "$base/$archive" ||
  fail "$(t "téléchargement impossible (cette version existe-t-elle ?)" "download failed (does this version exist?)") : $base/$archive"
curl -fsSL --retry 3 --connect-timeout 20 --max-time 60 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" ||
  fail "$(t "somme de contrôle introuvable" "checksum not found") : $base/SHA256SUMS"
(cd "$tmp" && grep "  $archive\$" SHA256SUMS | sha256sum --check --status) ||
  fail "$(t "somme de contrôle incorrecte : archive corrompue, rien n'a été installé" "checksum mismatch: corrupted archive, nothing was installed")"

tar -xzf "$tmp/$archive" -C "$tmp" opencode
annonce="$(timeout 30 "$tmp/opencode" --version 2>&1)" ||
  fail "$(t "le binaire téléchargé ne démarre pas, rien n'a été installé" "the downloaded binary does not start, nothing was installed") : $annonce"

avant=""
[ ! -x "$cible" ] || avant="$(timeout 30 "$cible" --version 2>/dev/null || true)"
# `mv` sur le même système de fichiers : les processus en cours gardent leur binaire jusqu'à leur redémarrage.
"${en_root[@]}" install -m 0755 "$tmp/opencode" "$cible.new"
"${en_root[@]}" mv -f "$cible.new" "$cible"

[ -z "$avant" ] || echo "$(t "Remplace" "Replaces") : $avant"
echo "$(t "Installé" "Installed") : $cible ($annonce)"
t "Les comptes, les machines et les données du hub sont conservés." "Hub accounts, machines and data are kept."; echo
t "Un hub ou un agent déjà lancé garde l'ancienne version jusqu'à son redémarrage." "A running hub or agent keeps the old version until it restarts."; echo

resolu="$(type -P opencode || true)"
if [ -n "$resolu" ] && [ "$(readlink -f "$resolu")" != "$(readlink -f "$cible")" ]; then
  echo "$(t "attention : « opencode » lance $resolu, pas $cible" "warning: \"opencode\" runs $resolu, not $cible")" >&2
fi
