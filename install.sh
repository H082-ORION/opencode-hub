#!/usr/bin/env bash
# install.sh — installation et mise en place d'opencode-hub sur une machine Linux (systemd).
#
# Propose trois composants, à cocher dans un menu ou à passer en options :
#   - Caddy  : proxy HTTPS devant le hub (certificats à la demande pour le hub et chaque machine) ;
#   - Hub    : le tableau de bord qui donne accès aux machines enrôlées ;
#   - Client : l'agent qui relie cette machine à un hub (opencode agent join / run).
# Le hub et le client peuvent être installés en service systemd avec démarrage automatique.
#
#   sudo ./install.sh                                    # menu interactif
#   sudo ./install.sh --caddy --hub --domain hub.example.com --email vous@example.com --service
#   sudo ./install.sh --client --hub-url https://hub.example.com --code <code> --service
#
#   ./install.sh --status                                # état des services
#   sudo ./install.sh --uninstall                        # désinstallation (menu)
#
# Le script est autonome (un seul fichier, aucune dépendance à un autre dépôt) et peut être relancé sans risque.
# Réglages : NO_COLOR=1, OPENCODE_HUB_ASCII=1 (sans Unicode), OPENCODE_HUB_VITESSE=0 (sans pauses),
# OPENCODE_HUB_SANS_BANNIERE=1.

set -euo pipefail

ARGS_ORIGINAUX=("$@")
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ================================================================== Affichage

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  bold=$'\e[1m'; dim=$'\e[2m'; red=$'\e[31m'; green=$'\e[32m'; yellow=$'\e[33m'; cyan=$'\e[36m'
  gris=$'\e[38;5;245m'; reset=$'\e[0m'
else
  bold=''; dim=''; red=''; green=''; yellow=''; cyan=''; gris=''; reset=''
fi
TTY=0; [[ -t 1 ]] && TTY=1
UTF8=0
if [[ "${OPENCODE_HUB_ASCII:-0}" != 1 && "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" == *[Uu][Tt][Ff]*8* ]]; then UTF8=1; fi

if ((UTF8)); then
  S_INFO='▸'; S_OK='✓'; S_WARN='!'; S_ERR='✗'; S_ASK='?'; H='─'; V='│'
  C_HG='╭'; C_HD='╮'; C_BG='╰'; C_BD='╯'; S_PTR='❯'; S_ON='●'; S_OFF='○'; S_COCHE='◉'; S_VIDE='○'; S_ELLIPSE='…'; S_SEP='·'
  SPIN=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
else
  S_INFO='>'; S_OK='OK'; S_WARN='!'; S_ERR='x'; S_ASK='?'; H='-'; V='|'
  C_HG='+'; C_HD='+'; C_BG='+'; C_BD='+'; S_PTR='>'; S_ON='*'; S_OFF='o'; S_COCHE='[x]'; S_VIDE='[ ]'; S_ELLIPSE='...'; S_SEP='-'
  SPIN=('|' '/' '-' '\')
fi
LARGEUR="${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}"
((LARGEUR > 100)) && LARGEUR=100
((LARGEUR < 50)) && LARGEUR=50
VITESSE="${OPENCODE_HUB_VITESSE:-1}"
OUI=0

pause() { [[ "$VITESSE" == 0 ]] || sleep "$1"; }
cacher() { if ((TTY)); then printf '\e[?25l'; fi; }
montrer() { if ((TTY)); then printf '\e[?25h'; fi; }
trap montrer EXIT
trap 'montrer; echo; exit 130' INT

# Saisie possible : entrée standard sur un terminal, et pas de --yes.
interactif() { [[ -t 0 && "$OUI" != 1 ]]; }

info() { printf '%s%s%s %s\n' "$gris" "$S_INFO" "$reset" "$*"; }
ok()   { printf '%s%s%s %s\n' "$green" "$S_OK" "$reset" "$*"; }
warn() { printf '%s%s%s %s\n' "$yellow" "$S_WARN" "$reset" "$*" >&2; }
err()  { printf '%s%s %s%s\n' "$red" "$S_ERR" "$*" "$reset" >&2; }
die()  { err "$*"; exit 1; }
etape() { printf '\n%s%s== %s%s\n' "$gris" "$bold" "$*" "$reset"; }

# Longueur visible : sans séquences de couleur ni liens.
vlen() {
  local t
  t="$(sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g; s/\x1b\]8;;[^\x1b]*\x1b\\//g' <<<"$1")"
  printf '%d' "${#t}"
}
pad() { local n; n="$(vlen "$1")"; printf '%s%*s' "$1" $((n < $2 ? $2 - n : 0)) ''; }
rep() { local i out=''; for ((i = 0; i < $2; i++)); do out+="$1"; done; printf '%s' "$out"; }
tronque() {
  local n="$2"; ((n < 1)) && n=1
  if ((${#1} > n)); then printf '%s%s' "${1:0:n-1}" "$S_ELLIPSE"; else printf '%s' "$1"; fi
}
trait() { printf '%s%s%s\n' "$dim" "$(rep "$H" "$LARGEUR")" "$reset"; }
lien() { if ((TTY)); then printf '\e]8;;%s\e\\%s%s%s\e]8;;\e\\' "$1" "$cyan" "${2:-$1}" "$reset"; else printf '%s' "${2:-$1}"; fi; }
titre_onglet() { if ((TTY)); then printf '\e]0;%s\a' "$1"; fi; }

# cadre COULEUR TITRE LIGNE… — encart à bordure arrondie.
cadre() {
  local c="$1" titre="$2" l n w
  shift 2
  w=$(($(vlen "$titre") + 6))
  for l in "$@"; do n="$(vlen "$l")"; if ((n + 4 > w)); then w=$((n + 4)); fi; done
  if ((w > LARGEUR)); then w=$LARGEUR; fi
  printf '%s%s%s %s%s%s %s%s%s\n' "$c" "$C_HG" "$H" "$bold" "$titre" "$reset$c" "$(rep "$H" $((w - $(vlen "$titre") - 5)))" "$C_HD" "$reset"
  for l in "$@"; do
    printf '%s%s%s %s %s%s%s\n' "$c" "$V" "$reset" "$(pad "$l" $((w - 4)))" "$c" "$V" "$reset"
  done
  printf '%s%s%s%s%s\n' "$c" "$C_BG" "$(rep "$H" $((w - 2)))" "$C_BD" "$reset"
}

# banniere [TITRE] [SOUS-TITRE] — dégradé du noir (en haut) au blanc (en bas), en passant par le gris.
banniere() {
  [[ "${OPENCODE_HUB_SANS_BANNIERE:-0}" != 1 ]] || return 0
  local titre="${1:-opencode-hub}" sous="${2:-installation}"
  local -a art=(
    ' ██████╗ ██████╗ ███████╗███╗   ██╗ ██████╗ ██████╗ ██████╗ ███████╗'
    '██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝'
    '██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║     ██║   ██║██║  ██║█████╗'
    '██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║     ██║   ██║██║  ██║██╔══╝'
    '╚██████╔╝██║     ███████╗██║ ╚████║╚██████╗╚██████╔╝██████╔╝███████╗'
    ' ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝'
    '                     ██╗  ██╗██╗   ██╗██████╗'
    '                     ██║  ██║██║   ██║██╔══██╗'
    '                     ███████║██║   ██║██████╔╝'
    '                     ██╔══██║██║   ██║██╔══██╗'
    '                     ██║  ██║╚██████╔╝██████╔╝'
    '                     ╚═╝  ╚═╝ ╚═════╝ ╚═════╝'
  )
  # Palette 256 couleurs, rampe des gris : 233 (presque noir) → 255 (blanc).
  local -a teinte=(233 235 237 239 241 243 245 247 249 251 253 255)
  local i
  echo
  if ((UTF8 && LARGEUR >= 72)); then
    for i in "${!art[@]}"; do
      if [[ -n "$reset" ]]; then printf '  \e[38;5;%sm%s%s\n' "${teinte[$i]}" "${art[$i]}" "$reset"; else printf '  %s\n' "${art[$i]}"; fi
      pause 0.03
    done
  else
    printf '  %s%sO P E N C O D E   H U B%s\n' "$gris" "$bold" "$reset"
  fi
  printf '\n  %s%s%s  %s%s %s%s\n\n' "$bold" "$titre" "$reset" "$dim" "$S_SEP" "$sous" "$reset"
  trait
}

# suivre "titre" commande [args…] — lance la commande en silence avec une attente animée et sa dernière ligne ;
# au bout, ✓ et la durée, ou ✗ et les dernières lignes du journal. Renvoie le code de la commande.
suivre() {
  local titre="$1"; shift
  local jr pid rc=0 debut=$SECONDS i=0 der l
  jr="$(mktemp /tmp/opencode-hub-install.XXXXXX)"
  # Toujours en arrière-plan : la commande garde `set -e` (il serait ignoré dans un « cmd || rc=$? »).
  ("$@") >"$jr" 2>&1 &
  pid=$!
  if ((TTY)); then
    cacher
    while kill -0 "$pid" 2>/dev/null; do
      der="$(tail -c 2000 "$jr" 2>/dev/null | tr '\r' '\n' | sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g; /^[[:space:]]*$/d' | tail -n1)" || true
      printf '\r\e[K%s%s%s %s %s%s%s' "$gris" "${SPIN[i % ${#SPIN[@]}]}" "$reset" "$titre" "$dim" \
        "$(tronque "$der" $((LARGEUR - $(vlen "$titre") - 6)))" "$reset"
      sleep 0.1; i=$((i + 1))
    done
  else
    info "$titre…"
  fi
  wait "$pid" || rc=$?
  if ((TTY)); then printf '\r\e[K'; montrer; fi
  if ((rc == 0)); then
    ok "$titre ${dim}($((SECONDS - debut)) s)${reset}"
    rm -f "$jr"
  else
    err "$titre : échec (code $rc)."
    local -a ex=()
    while IFS= read -r l; do ex+=("$dim$(tronque "$l" $((LARGEUR - 6)))$reset"); done \
      < <(tr '\r' '\n' <"$jr" | sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g' | grep -v '^[[:space:]]*$' | tail -n 20)
    ((${#ex[@]})) || ex=("${dim}(aucune sortie)${reset}")
    cadre "$red" "Dernières lignes" "${ex[@]}" >&2
    echo "Journal complet : $jr" >&2
  fi
  return "$rc"
}

# menu "titre" option… — choix (index à partir de 0) dans MENU_CHOIX ; renvoie 1 si abandon.
menu() {
  local titre="$1"; shift
  local -a opts=("$@"); local n=${#opts[@]} sel=0 i k r
  MENU_CHOIX=-1
  printf '\n%s%s%s\n' "$bold" "$titre" "$reset"
  if ((!TTY)) || ! interactif; then
    for i in "${!opts[@]}"; do printf '  %d. %s\n' "$((i + 1))" "${opts[$i]}"; done
    if ! interactif; then info "Non interactif : choix par défaut (1)."; MENU_CHOIX=0; return 0; fi
    printf 'Votre choix (1-%d) : ' "$n"; read -r r || return 1
    [[ "$r" =~ ^[0-9]+$ ]] && ((r >= 1 && r <= n)) || return 1
    MENU_CHOIX=$((r - 1)); return 0
  fi
  printf '%s↑↓ ou chiffre · Entrée valide · q quitte%s\n' "$dim" "$reset"
  cacher
  while :; do
    for i in "${!opts[@]}"; do
      if ((i == sel)); then printf '\r\e[K  %s%s %s%s\n' "$gris$bold" "$S_PTR" "${opts[$i]}" "$reset"
      else printf '\r\e[K    %s\n' "${opts[$i]}"; fi
    done
    IFS= read -rsn1 k || { montrer; return 1; }
    if [[ "$k" == $'\e' ]]; then
      read -rsn2 -t 0.1 r || true
      case "$r" in '[A') ((sel = (sel + n - 1) % n)) || true ;; '[B') ((sel = (sel + 1) % n)) || true ;; esac
    elif [[ "$k" == '' ]]; then MENU_CHOIX=$sel; montrer; printf '\e[%dA\e[J' "$n"; ok "${opts[$sel]}"; return 0
    elif [[ "$k" == q ]]; then montrer; printf '\e[%dA\e[J' "$n"; return 1
    elif [[ "$k" =~ ^[1-9]$ ]] && ((k <= n)); then sel=$((k - 1)); fi
    printf '\e[%dA' "$n"
  done
}

# cocher "titre" option… — cases à cocher (flèches, espace, Entrée) ; indices cochés dans COCHES.
cocher() {
  local titre="$1"; shift
  local -a opts=("$@") etat=(); local n=${#opts[@]} sel=0 i k r case_
  COCHES=()
  for i in "${!opts[@]}"; do etat[i]=0; done
  printf '\n%s%s%s\n' "$bold" "$titre" "$reset"
  if ((!TTY)); then
    for i in "${!opts[@]}"; do printf '  %d. %s\n' "$((i + 1))" "${opts[$i]}"; done
    printf 'Numéros séparés par des espaces : '; read -r r || return 1
    for k in $r; do [[ "$k" =~ ^[0-9]+$ ]] && ((k >= 1 && k <= n)) && COCHES+=("$((k - 1))"); done
    return 0
  fi
  printf '%s↑↓ déplace · espace coche · Entrée valide · q quitte%s\n' "$dim" "$reset"
  cacher
  while :; do
    for i in "${!opts[@]}"; do
      case_="$S_VIDE"; ((etat[i])) && case_="$green$S_COCHE$reset"
      if ((i == sel)); then printf '\r\e[K  %s%s%s %s %s\n' "$gris$bold" "$S_PTR" "$reset" "$case_" "${opts[$i]}"
      else printf '\r\e[K    %s %s\n' "$case_" "${opts[$i]}"; fi
    done
    IFS= read -rsn1 k || { montrer; return 1; }
    if [[ "$k" == $'\e' ]]; then
      read -rsn2 -t 0.1 r || true
      case "$r" in '[A') ((sel = (sel + n - 1) % n)) || true ;; '[B') ((sel = (sel + 1) % n)) || true ;; esac
    elif [[ "$k" == ' ' ]]; then etat[sel]=$((1 - etat[sel]))
    elif [[ "$k" == '' ]]; then
      for i in "${!opts[@]}"; do if ((etat[i])); then COCHES+=("$i"); fi; done
      montrer; printf '\e[%dA\e[J' "$n"; return 0
    elif [[ "$k" == q ]]; then montrer; printf '\e[%dA\e[J' "$n"; return 1; fi
    printf '\e[%dA' "$n"
  done
}

# demander VARIABLE "question" [défaut] [regex] [message d'erreur]
# La valeur déjà donnée en option sert de défaut ; hors interactif, elle est prise telle quelle.
demander() {
  local var="$1" question="$2" defaut="${!1:-${3:-}}" regex="${4:-}" msg="${5:-valeur invalide}" r
  local invite="$gris$S_ASK$reset $question"
  [[ -z "$defaut" ]] || invite+=" ${dim}[$defaut]${reset}"
  if ! interactif; then
    [[ -n "$defaut" ]] || { err "$question : valeur obligatoire en mode non interactif."; return 1; }
    [[ -z "$regex" || "$defaut" =~ $regex ]] || { err "$question : $msg"; return 1; }
    printf -v "$var" '%s' "$defaut"; info "$question : ${bold}$defaut${reset}"; return 0
  fi
  while :; do
    read -r -p "$invite " r || return 1
    r="${r:-$defaut}"
    if [[ -z "$r" ]]; then err "valeur obligatoire."; continue; fi
    if [[ -n "$regex" && ! "$r" =~ $regex ]]; then err "$msg"; continue; fi
    printf -v "$var" '%s' "$r"; return 0
  done
}

# oui_non "question" [o|n] — renvoie 0 pour oui ; hors interactif, le défaut.
oui_non() {
  local q="$1" def="${2:-o}" r sfx='[O/n]'
  [[ "$def" == n ]] && sfx='[o/N]'
  if ! interactif; then [[ "$def" == o ]]; return; fi
  while :; do
    read -r -p "$gris$S_ASK$reset $q ${dim}$sfx${reset} " r || return 1
    r="${r:-$def}"
    case "${r,,}" in o|oui|y|yes) return 0 ;; n|non|no) return 1 ;; *) err "répondre par o ou n." ;; esac
  done
}

# confirmer_grave "ce qui sera perdu" MOT — encart rouge ; il faut retaper MOT. Avec --yes : accepté.
confirmer_grave() {
  local quoi="$1" mot="$2" r
  cadre "$red" "Action irréversible" "$quoi" "" "Pour confirmer, tapez : ${bold}$mot${reset}"
  [[ "$OUI" == 1 ]] && return 0
  interactif || { err "confirmation impossible hors terminal (--yes pour passer outre)."; return 1; }
  read -r -p "$red$S_ASK$reset " r || return 1
  [[ "$r" == "$mot" ]] || { err "mot différent : rien n'a été effacé."; return 1; }
}

aide_titre() { printf '\n%s%s%s\n' "$gris$bold" "$1" "$reset"; }
aide_opt() { printf '  %s%s%s %s%s%s\n' "$bold" "$(pad "$1" 24)" "$reset" "$dim" "$2" "$reset"; }

# ================================================================== Réglages

INSTALLER_CADDY=0
INSTALLER_HUB=0
INSTALLER_CLIENT=0
SERVICE_HUB=""
SERVICE_CLIENT=""
DOMAIN=""
EMAIL=""
PORT="4800"
HUB_HOTE="127.0.0.1"
HUB_URL=""
HUB_UTILISATEUR="opencode"
CLIENT_URL=""
CODE=""
NOM_MACHINE=""
CLIENT_UTILISATEUR=""
BINARY=""
CONSTRUIRE=0
MODE=installer
PURGER=0

DATA_DIR="/var/lib/opencode-hub"
ENV_FILE="/etc/opencode-hub.env"
UNIT_HUB="/etc/systemd/system/opencode-hub.service"
UNIT_CLIENT="/etc/systemd/system/opencode-agent.service"
CADDYFILE="/etc/caddy/Caddyfile"
BIN_CIBLE="/usr/local/bin/opencode"
# Marque reconnue par script/hub/uninstall.sh : la garder identique.
MARQUE="# Managed by opencode script/hub/install.sh"
MOT_DE_PASSE_GENERE=""

aide() {
  banniere "opencode-hub" "aide de l'installateur"
  echo "Installe Caddy, le hub et/ou le client opencode-hub, avec un service systemd à démarrage automatique."
  echo "Sans option, un menu propose les composants et chaque réglage."
  aide_titre "Utilisation"
  echo "  sudo ./install.sh [composants] [options]"
  aide_titre "Composants"
  aide_opt "--caddy" "proxy HTTPS devant le hub (certificats à la demande)"
  aide_opt "--hub" "tableau de bord qui donne accès aux machines"
  aide_opt "--client" "relie cette machine à un hub (agent)"
  aide_titre "Caddy et hub"
  aide_opt "--domain <hôte>" "nom public du hub ; les machines sont sur <id>.<hôte>"
  aide_opt "--email <adresse>" "compte ACME de Caddy pour les certificats"
  aide_opt "--port <port>" "port local du hub (défaut : 4800)"
  aide_opt "--hub-url <url>" "URL publique du hub (sans Caddy ; défaut : http://localhost:<port>)"
  aide_opt "--hub-user <nom>" "utilisateur système du hub (défaut : opencode)"
  aide_titre "Client"
  aide_opt "--client-url <url>" "URL du hub à rejoindre"
  aide_opt "--code <code>" "code d'enrôlement à usage unique (tableau de bord, « add machine »)"
  aide_opt "--name <nom>" "nom de la machine (défaut : nom d'hôte)"
  aide_opt "--client-user <nom>" "utilisateur qui fait tourner l'agent (défaut : celui qui lance sudo)"
  aide_titre "Binaire et services"
  aide_opt "--binary <chemin>" "binaire opencode à installer dans $BIN_CIBLE"
  aide_opt "--build" "construire le binaire depuis ce dépôt (./build.sh)"
  aide_opt "--service" "installer les services systemd (démarrage automatique)"
  aide_opt "--no-service" "ne pas installer de service systemd"
  aide_opt "-y, --yes" "aucune question : options et valeurs par défaut"
  aide_opt "-h, --help" "cette aide"
  aide_titre "Maintenance"
  aide_opt "--status" "état de Caddy, du hub, de l'agent et du binaire"
  aide_opt "--uninstall" "désinstaller (les composants cochés, ou ceux passés en options)"
  aide_opt "--purge" "avec --uninstall : données du hub, enrôlement, paquet Caddy, binaire"
  aide_titre "Exemples"
  echo "  sudo ./install.sh"
  echo "  sudo ./install.sh --caddy --hub --domain hub.example.com --email vous@example.com --service --yes"
  echo "  sudo ./install.sh --client --client-url https://hub.example.com --code <code> --service"
  echo "  ./install.sh --status"
  echo "  sudo ./install.sh --uninstall --hub --client"
  echo
}

valeur() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 attend une valeur"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --caddy) INSTALLER_CADDY=1; shift ;;
    --hub) INSTALLER_HUB=1; shift ;;
    --client) INSTALLER_CLIENT=1; shift ;;
    --domain) valeur "$@"; DOMAIN="$2"; shift 2 ;;
    --email) valeur "$@"; EMAIL="$2"; shift 2 ;;
    --port) valeur "$@"; PORT="$2"; shift 2 ;;
    --hub-url) valeur "$@"; HUB_URL="$2"; shift 2 ;;
    --hub-user) valeur "$@"; HUB_UTILISATEUR="$2"; shift 2 ;;
    --client-url) valeur "$@"; CLIENT_URL="$2"; shift 2 ;;
    --code) valeur "$@"; CODE="$2"; shift 2 ;;
    --name) valeur "$@"; NOM_MACHINE="$2"; shift 2 ;;
    --client-user) valeur "$@"; CLIENT_UTILISATEUR="$2"; shift 2 ;;
    --binary) valeur "$@"; BINARY="$2"; shift 2 ;;
    --build) CONSTRUIRE=1; shift ;;
    --service) SERVICE_HUB=1; SERVICE_CLIENT=1; shift ;;
    --no-service) SERVICE_HUB=0; SERVICE_CLIENT=0; shift ;;
    -y | --yes) OUI=1; shift ;;
    --status) MODE=etat; shift ;;
    --uninstall) MODE=desinstaller; shift ;;
    --purge) PURGER=1; shift ;;
    -h | --help) aide; exit 0 ;;
    *) aide >&2; die "option inconnue : $1" ;;
  esac
done

RE_DOMAINE='^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'
RE_EMAIL='^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
RE_PORT='^[0-9]{1,5}$'
RE_URL='^https?://[^[:space:]/]+(/[^[:space:]]*)?$'
RE_UTILISATEUR='^[a-z_][a-z0-9_-]*$'

# ================================================================== Outils

# Dossier personnel d'un utilisateur.
dossier_de() { getent passwd "$1" | cut -d: -f6; }

# en_tant_que UTILISATEUR commande… — lance la commande sous cet utilisateur, avec son propre environnement.
en_tant_que() {
  local u="$1" h; shift
  h="$(dossier_de "$u")"
  local -a env_u=(env HOME="$h" USER="$u" LOGNAME="$u"
    PATH="$h/.opencode/bin:$h/.bun/bin:$h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
  if [[ "$u" == root ]]; then "${env_u[@]}" "$@"; else runuser -u "$u" -- "${env_u[@]}" "$@"; fi
}

version_de() { local v; v="$("$1" --version 2>/dev/null | head -n1)" || true; printf '%s\n' "${v:-version inconnue}"; }

apt_installer() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q "$@"
}

# ================================================================== État et désinstallation

# etat_unite NOM — absent, actif ou inactif.
etat_unite() {
  systemctl list-unit-files "$1.service" --no-legend 2>/dev/null | grep -q . || { echo absent; return; }
  if systemctl is-active --quiet "$1"; then echo actif; else echo inactif; fi
}
auto_unite() { [[ "$(systemctl is-enabled "$1" 2>/dev/null || true)" == enabled ]]; }

pastille() {
  case "$1" in
    actif) printf '%s%s%s en marche' "$green" "$S_ON" "$reset" ;;
    inactif) printf '%s%s%s arrêté' "$yellow" "$S_ON" "$reset" ;;
    installe) printf '%s%s%s installé' "$green" "$S_ON" "$reset" ;;
    *) printf '%s%s absent%s' "$dim" "$S_OFF" "$reset" ;;
  esac
}

# Valeur d'une clé (User=, …) ou d'une option de ExecStart (--port, --url) dans un fichier de service.
cle_unite() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n1 || true; }
option_unite() { grep -m1 '^ExecStart=' "$1" 2>/dev/null | grep -oE -- "$2 [^ ]+" | cut -d' ' -f2 || true; }

# Domaine configuré dans le Caddyfile géré par ce script.
domaine_caddy() {
  grep -qF "$MARQUE" "$CADDYFILE" 2>/dev/null || return 0
  grep -m1 -oE '^[a-z0-9.-]+, \*\.' "$CADDYFILE" | cut -d, -f1 || true
}

ligne_etat() {
  local nom="$1" etat="$2" auto="$3" detail="$4" a=''
  case "$auto" in
    1) a="${green}auto${reset}" ;;
    0) a="${dim}manuel${reset}" ;;
  esac
  printf '%s %s %s %s' "$(pad "${bold}$nom${reset}" 8)" "$(pad "$(pastille "$etat")" 12)" "$(pad "$a" 7)" "$dim$detail$reset"
}

afficher_etat() {
  local -a l=()
  local e d port url u dom sante etat_agent

  # Caddy
  if command -v caddy >/dev/null; then
    e="$(etat_unite caddy)"; [[ "$e" == absent ]] && e=installe
    d="$(caddy version 2>/dev/null | awk '{print $1}')"
    dom="$(domaine_caddy)"
    [[ -n "$dom" ]] && d+=" $S_SEP $dom et *.$dom"
    l+=("$(ligne_etat Caddy "$e" "$(auto_unite caddy && echo 1 || echo 0)" "$d")")
  else
    l+=("$(ligne_etat Caddy absent - "")")
  fi

  # Hub
  e="$(etat_unite opencode-hub)"
  if [[ "$e" == absent ]]; then
    l+=("$(ligne_etat Hub absent - "")")
  else
    port="$(option_unite "$UNIT_HUB" --port)"; url="$(option_unite "$UNIT_HUB" --url)"
    d="${url:-?} $S_SEP port ${port:-?}"
    if [[ "$e" == actif && -n "$port" ]] && command -v curl >/dev/null; then
      if curl -fsS --max-time 2 "http://127.0.0.1:$port/hub/health" >/dev/null 2>&1; then sante="${green}répond${reset}"
      else sante="${red}ne répond pas${reset}"; fi
      d+=" $S_SEP $sante$dim"
    fi
    l+=("$(ligne_etat Hub "$e" "$(auto_unite opencode-hub && echo 1 || echo 0)" "$d")")
  fi

  # Agent
  e="$(etat_unite opencode-agent)"
  if [[ "$e" == absent ]]; then
    l+=("$(ligne_etat Client absent - "")")
  else
    u="$(cle_unite "$UNIT_CLIENT" User)"
    d="utilisateur ${u:-?}"
    if [[ $EUID -eq 0 && -n "$u" && -x "$BIN_CIBLE" ]]; then
      etat_agent="$(en_tant_que "$u" "$BIN_CIBLE" agent status 2>/dev/null || true)"
      if grep -q '^hub ' <<<"$etat_agent"; then
        d+=" $S_SEP $(sed -n 's/^hub *//p' <<<"$etat_agent" | head -n1)"
      else
        d+=" $S_SEP ${red}non enrôlé${reset}$dim"
      fi
    fi
    l+=("$(ligne_etat Client "$e" "$(auto_unite opencode-agent && echo 1 || echo 0)" "$d")")
  fi

  # Binaire
  if [[ -x "$BIN_CIBLE" ]]; then
    l+=("$(ligne_etat Binaire installe - "$BIN_CIBLE $S_SEP $(version_de "$BIN_CIBLE")")")
  else
    l+=("$(ligne_etat Binaire absent - "$BIN_CIBLE")")
  fi

  cadre "$gris" "État des services" "${l[@]}"
  [[ $EUID -eq 0 ]] || info "${dim}Lancer avec sudo pour voir aussi l'enrôlement de l'agent.${reset}"
  echo
  info "Journaux : ${dim}journalctl -u opencode-hub -f · journalctl -u opencode-agent -f · journalctl -u caddy -f${reset}"
  echo
}

desinstaller() {
  local present_caddy=0 present_hub=0 present_client=0 i u h dom sauvegarde
  [[ -f "$CADDYFILE" ]] && grep -qF "$MARQUE" "$CADDYFILE" && present_caddy=1
  command -v caddy >/dev/null && present_caddy=1
  [[ -f "$UNIT_HUB" || -f "$ENV_FILE" ]] && present_hub=1
  [[ -f "$UNIT_CLIENT" ]] && present_client=1

  if ((!INSTALLER_CADDY && !INSTALLER_HUB && !INSTALLER_CLIENT)); then
    local -a opts=() codes=()
    ((present_caddy)) && { opts+=("Caddy   ${dim}configuration du hub, paquet en option${reset}"); codes+=(caddy); }
    ((present_hub)) && { opts+=("Hub     ${dim}service opencode-hub, données en option${reset}"); codes+=(hub); }
    ((present_client)) && { opts+=("Client  ${dim}service opencode-agent, enrôlement en option${reset}"); codes+=(client); }
    ((${#opts[@]})) || { ok "Rien à désinstaller : ni Caddy, ni hub, ni agent installés."; return 0; }
    interactif || die "préciser les composants à retirer : --caddy, --hub ou --client (voir --help)."
    cocher "Que faut-il désinstaller ?" "${opts[@]}" || die "abandon."
    for i in "${COCHES[@]}"; do
      case "${codes[$i]}" in caddy) INSTALLER_CADDY=1 ;; hub) INSTALLER_HUB=1 ;; client) INSTALLER_CLIENT=1 ;; esac
    done
    ((INSTALLER_CADDY || INSTALLER_HUB || INSTALLER_CLIENT)) || die "aucun composant coché : rien à faire."
  fi

  # Questions avant d'agir ; --purge répond oui à tout.
  local oublier=0 effacer_donnees=0 retirer_caddy=0 retirer_binaire=0
  local -a recap=()
  if ((INSTALLER_CLIENT)); then
    if ((PURGER)) || oui_non "Oublier aussi l'enrôlement de cette machine auprès du hub ?" n; then oublier=1; fi
    recap+=("${bold}Client${reset}  service opencode-agent arrêté et retiré$( ((oublier)) && echo ", enrôlement oublié" || true)")
  fi
  if ((INSTALLER_HUB)); then
    if ((PURGER)) || oui_non "Supprimer aussi les données du hub ($DATA_DIR) ?" n; then effacer_donnees=1; fi
    recap+=("${bold}Hub${reset}     service opencode-hub et $ENV_FILE retirés$( ((effacer_donnees)) && echo ", ${red}données effacées${reset}" || true)")
  fi
  if ((INSTALLER_CADDY)); then
    if command -v caddy >/dev/null && { ((PURGER)) || oui_non "Désinstaller aussi le paquet Caddy ?" n; }; then retirer_caddy=1; fi
    if ((retirer_caddy)); then recap+=("${bold}Caddy${reset}   paquet désinstallé, configuration du hub retirée")
    else recap+=("${bold}Caddy${reset}   configuration du hub retirée (ancien Caddyfile restauré s'il existe)"); fi
  fi
  # Le binaire ne part que si plus rien ne s'en sert.
  local hub_reste=$((present_hub && !INSTALLER_HUB)) client_reste=$((present_client && !INSTALLER_CLIENT))
  if [[ -x "$BIN_CIBLE" ]] && ((!hub_reste && !client_reste)) && ((INSTALLER_HUB || INSTALLER_CLIENT)); then
    if ((PURGER)) || oui_non "Supprimer aussi le binaire $BIN_CIBLE ?" n; then retirer_binaire=1; fi
  fi
  ((retirer_binaire)) && recap+=("${bold}Binaire${reset} $BIN_CIBLE supprimé")

  echo
  cadre "$gris" "Désinstallation" "${recap[@]}"
  if [[ "$OUI" != 1 ]]; then
    interactif || die "confirmation impossible hors terminal : ajouter --yes."
    oui_non "Lancer la désinstallation ?" n || die "abandon : rien n'a été modifié."
  fi
  if ((effacer_donnees)); then
    confirmer_grave "Les données du hub ($DATA_DIR : machines, fournisseurs, réglages) seront effacées." SUPPRIMER ||
      die "abandon : rien n'a été modifié."
  fi

  # Client
  if ((INSTALLER_CLIENT)); then
    etape "Client"
    u="$(cle_unite "$UNIT_CLIENT" User)"
    if ((oublier)) && [[ -n "$u" && -x "$BIN_CIBLE" ]]; then
      if en_tant_que "$u" "$BIN_CIBLE" agent leave >/dev/null 2>&1; then ok "Enrôlement oublié ($u)"
      else warn "impossible d'oublier l'enrôlement : $BIN_CIBLE agent leave (en tant que $u)"; fi
    fi
    systemctl disable --now opencode-agent >/dev/null 2>&1 || true
    rm -f "$UNIT_CLIENT"
    systemctl daemon-reload
    systemctl reset-failed opencode-agent >/dev/null 2>&1 || true
    ok "Service opencode-agent arrêté et retiré"
  fi

  # Hub
  if ((INSTALLER_HUB)); then
    etape "Hub"
    u="$(cle_unite "$UNIT_HUB" User)"
    systemctl disable --now opencode-hub >/dev/null 2>&1 || true
    rm -f "$UNIT_HUB" "$ENV_FILE"
    systemctl daemon-reload
    systemctl reset-failed opencode-hub >/dev/null 2>&1 || true
    ok "Service opencode-hub et $ENV_FILE retirés"
    if ((effacer_donnees)); then
      rm -rf "$DATA_DIR"
      ok "Données effacées : $DATA_DIR"
      # L'utilisateur système part avec ses données, s'il a été créé par ce script (dossier personnel = données).
      if [[ -n "$u" && "$u" != root ]] && id "$u" >/dev/null 2>&1 && [[ "$(dossier_de "$u")" == "$DATA_DIR" ]]; then
        userdel "$u" >/dev/null 2>&1 && ok "Utilisateur système supprimé : $u" || warn "impossible de supprimer l'utilisateur $u"
      fi
    else
      info "Données conservées : $DATA_DIR ${dim}(--purge pour les effacer)${reset}"
    fi
  fi

  # Caddy
  if ((INSTALLER_CADDY)); then
    etape "Caddy"
    if [[ -f "$CADDYFILE" ]] && grep -qF "$MARQUE" "$CADDYFILE"; then
      sauvegarde="$(find "$(dirname "$CADDYFILE")" -maxdepth 1 -name 'Caddyfile.bak.*' -type f 2>/dev/null | sort | tail -n1 || true)"
      if [[ -n "$sauvegarde" ]]; then
        cp -p "$sauvegarde" "$CADDYFILE"
        ok "Caddyfile restauré depuis $sauvegarde"
      elif ((retirer_caddy)); then
        rm -f "$CADDYFILE"
      else
        warn "aucune sauvegarde : $CADDYFILE renvoie toujours vers le hub ; le modifier puis : systemctl reload caddy"
      fi
    fi
    if ((retirer_caddy)); then
      suivre "Désinstallation du paquet Caddy" env DEBIAN_FRONTEND=noninteractive apt-get purge -y -q caddy
      rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      ok "Dépôt apt de Caddy retiré"
    elif command -v caddy >/dev/null && systemctl is-active --quiet caddy; then
      systemctl reload caddy >/dev/null 2>&1 && ok "Caddy rechargé" || warn "rechargement de Caddy impossible : journalctl -u caddy -e"
    fi
  fi

  # Binaire
  if ((retirer_binaire)); then
    rm -f "$BIN_CIBLE"
    ok "Binaire supprimé : $BIN_CIBLE"
  fi

  echo
  cadre "$green" "Désinstallation terminée" "État actuel : ${dim}./install.sh --status${reset}"
  echo
}

# ================================================================== Démarrage

command -v systemctl >/dev/null || die "systemd est nécessaire (systemctl introuvable)."
case "$MODE" in
  etat) titre_onglet "opencode-hub · état"; banniere "opencode-hub" "état des services"; afficher_etat; exit 0 ;;
  desinstaller) titre_onglet "opencode-hub · désinstallation"; banniere "opencode-hub" "désinstallation" ;;
  *) titre_onglet "opencode-hub · installation"; banniere "opencode-hub" "installation" ;;
esac

# Droits administrateur : on propose de relancer avec sudo.
if [[ $EUID -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1 && interactif && oui_non "Cette opération demande les droits administrateur. Relancer avec sudo ?"; then
    exec sudo env OPENCODE_HUB_SANS_BANNIERE=1 bash "$0" "${ARGS_ORIGINAUX[@]}"
  fi
  die "lancer en administrateur : sudo $0 ${ARGS_ORIGINAUX[*]}"
fi

APPELANT="${SUDO_USER:-root}"

if [[ "$MODE" == desinstaller ]]; then desinstaller; exit 0; fi

# ------------------------------------------------------------------ Choix des composants

if ((!INSTALLER_CADDY && !INSTALLER_HUB && !INSTALLER_CLIENT)); then
  interactif || die "préciser au moins un composant : --caddy, --hub ou --client (voir --help)."
  cocher "Que faut-il installer ?" \
    "Caddy   ${dim}proxy HTTPS et certificats automatiques${reset}" \
    "Hub     ${dim}tableau de bord des machines${reset}" \
    "Client  ${dim}relie cette machine à un hub${reset}" || die "abandon."
  for i in "${COCHES[@]}"; do
    case "$i" in 0) INSTALLER_CADDY=1 ;; 1) INSTALLER_HUB=1 ;; 2) INSTALLER_CLIENT=1 ;; esac
  done
  ((INSTALLER_CADDY || INSTALLER_HUB || INSTALLER_CLIENT)) || die "aucun composant coché : rien à faire."
fi
choix=()
((INSTALLER_CADDY)) && choix+=("Caddy")
((INSTALLER_HUB)) && choix+=("Hub")
((INSTALLER_CLIENT)) && choix+=("Client")
ok "Composants : ${bold}${choix[*]}${reset}"

if ((INSTALLER_CADDY)); then
  command -v apt-get >/dev/null || die "l'installation de Caddy demande Debian ou Ubuntu (apt-get)."
fi

# ------------------------------------------------------------------ Réglages de Caddy et du hub

if ((INSTALLER_CADDY || INSTALLER_HUB)); then
  etape "Réglages du hub"
  demander PORT "Port local du hub" "4800" "$RE_PORT" "un nombre entre 1 et 65535"
  ((PORT >= 1 && PORT <= 65535)) || die "port hors limites : $PORT"
fi

if ((INSTALLER_CADDY)); then
  demander DOMAIN "Nom de domaine public du hub (ex. hub.example.com)" "" "$RE_DOMAINE" \
    "un nom d'hôte nu, sans http:// ni chemin, par exemple hub.example.com"
  DOMAIN="${DOMAIN,,}"; DOMAIN="${DOMAIN%.}"
  demander EMAIL "Adresse e-mail pour les certificats (ACME)" "" "$RE_EMAIL" "adresse e-mail invalide"
  HUB_URL="https://$DOMAIN"
fi

if ((INSTALLER_HUB)); then
  if ((!INSTALLER_CADDY)); then
    if [[ -z "$HUB_URL" && -n "$DOMAIN" ]]; then HUB_URL="https://$DOMAIN"; fi
    demander HUB_URL "URL publique du hub" "http://localhost:$PORT" "$RE_URL" "une URL du type https://hub.example.com"
    HUB_URL="${HUB_URL%/}"
    demander HUB_HOTE "Adresse d'écoute du hub" "127.0.0.1"
  fi
  demander HUB_UTILISATEUR "Utilisateur système du hub" "opencode" "$RE_UTILISATEUR" "nom d'utilisateur invalide"
  if [[ -z "$SERVICE_HUB" ]]; then
    if oui_non "Installer le service systemd ${bold}opencode-hub${reset} avec démarrage automatique ?"; then SERVICE_HUB=1; else SERVICE_HUB=0; fi
  fi
fi

# ------------------------------------------------------------------ Réglages du client

if ((INSTALLER_CLIENT)); then
  etape "Réglages du client"
  [[ -n "$CLIENT_URL" ]] || CLIENT_URL="$HUB_URL"
  demander CLIENT_URL "URL du hub à rejoindre" "" "$RE_URL" "une URL du type https://hub.example.com"
  CLIENT_URL="${CLIENT_URL%/}"
  demander CLIENT_UTILISATEUR "Utilisateur qui fait tourner l'agent" "$APPELANT" "$RE_UTILISATEUR" "nom d'utilisateur invalide"
  id "$CLIENT_UTILISATEUR" >/dev/null 2>&1 || die "l'utilisateur $CLIENT_UTILISATEUR n'existe pas."
  demander NOM_MACHINE "Nom de cette machine" "$(hostname)"
  if [[ -z "$SERVICE_CLIENT" ]]; then
    if oui_non "Installer le service systemd ${bold}opencode-agent${reset} avec démarrage automatique ?"; then SERVICE_CLIENT=1; else SERVICE_CLIENT=0; fi
  fi
fi

# ------------------------------------------------------------------ Binaire opencode

OPENCODE_BIN=""
if ((INSTALLER_HUB || INSTALLER_CLIENT)); then
  etape "Binaire opencode"
  if [[ -n "$BINARY" ]]; then
    [[ -f "$BINARY" ]] || die "--binary introuvable : $BINARY"
    BINARY="$(readlink -f "$BINARY")"
  elif ((!CONSTRUIRE)); then
    candidats=()
    for c in "$BIN_CIBLE" "$(command -v opencode 2>/dev/null || true)" "$(dossier_de "$APPELANT")/.opencode/bin/opencode"; do
      [[ -n "$c" && -x "$c" ]] || continue
      c="$(readlink -f "$c")"
      [[ " ${candidats[*]} " == *" $c "* ]] || candidats+=("$c")
    done
    options=()
    for c in "${candidats[@]}"; do options+=("Utiliser $c ${dim}($(version_de "$c"))${reset}"); done
    [[ -x "$REPO/build.sh" ]] && options+=("Construire depuis ce dépôt ${dim}(./build.sh, bun requis)${reset}")
    options+=("Indiquer le chemin d'un binaire")
    if ! interactif && ((${#candidats[@]} == 0)); then
      [[ -x "$REPO/build.sh" ]] || die "aucun binaire opencode : passer --binary <chemin> ou --build."
      CONSTRUIRE=1
    else
      menu "Quel binaire opencode installer ?" "${options[@]}" || die "abandon."
      if ((MENU_CHOIX < ${#candidats[@]})); then
        BINARY="${candidats[$MENU_CHOIX]}"
      elif [[ -x "$REPO/build.sh" ]] && ((MENU_CHOIX == ${#candidats[@]})); then
        CONSTRUIRE=1
      else
        demander BINARY "Chemin du binaire opencode"
        [[ -f "$BINARY" ]] || die "binaire introuvable : $BINARY"
        BINARY="$(readlink -f "$BINARY")"
      fi
    fi
  fi
  if ((CONSTRUIRE)); then
    [[ -x "$REPO/build.sh" ]] || die "build.sh introuvable dans $REPO."
  fi
fi

# ------------------------------------------------------------------ Récapitulatif

SERVICE_HUB="${SERVICE_HUB:-0}"
SERVICE_CLIENT="${SERVICE_CLIENT:-0}"

oui_txt() { if [[ "$1" == 1 ]]; then printf '%soui%s' "$green" "$reset"; else printf '%snon%s' "$dim" "$reset"; fi; }
recap=()
if ((INSTALLER_CADDY)); then
  recap+=("${bold}Caddy${reset}   $DOMAIN et *.$DOMAIN ${dim}$S_SEP $EMAIL${reset}")
fi
if ((INSTALLER_HUB)); then
  recap+=("${bold}Hub${reset}     $HUB_URL ${dim}$S_SEP écoute $HUB_HOTE:$PORT $S_SEP utilisateur $HUB_UTILISATEUR${reset}")
  recap+=("        service systemd : $(oui_txt "$SERVICE_HUB")")
fi
if ((INSTALLER_CLIENT)); then
  recap+=("${bold}Client${reset}  $CLIENT_URL ${dim}$S_SEP machine $NOM_MACHINE $S_SEP utilisateur $CLIENT_UTILISATEUR${reset}")
  recap+=("        service systemd : $(oui_txt "$SERVICE_CLIENT")")
fi
if ((INSTALLER_HUB || INSTALLER_CLIENT)); then
  if ((CONSTRUIRE)); then recap+=("${bold}Binaire${reset} construit depuis $REPO, installé dans $BIN_CIBLE")
  else recap+=("${bold}Binaire${reset} $BINARY"); fi
fi
echo
cadre "$gris" "Récapitulatif" "${recap[@]}"
oui_non "Lancer l'installation ?" || die "abandon : rien n'a été modifié."

# ================================================================== Installation

# ------------------------------------------------------------------ Outils de base

if ((INSTALLER_CADDY || INSTALLER_HUB)) && command -v apt-get >/dev/null; then
  manque=0
  for outil in curl gpg openssl; do command -v "$outil" >/dev/null || manque=1; done
  if ((manque)); then
    etape "Outils de base"
    suivre "Installation de curl, gnupg et openssl" apt_installer curl gnupg openssl ca-certificates
  fi
fi

# ------------------------------------------------------------------ Binaire

if ((INSTALLER_HUB || INSTALLER_CLIENT)); then
  etape "Binaire opencode"
  if ((CONSTRUIRE)); then
    construire() { en_tant_que "$APPELANT" bash -c 'cd "$1" && ./build.sh --skip-tests' _ "$REPO"; }
    suivre "Construction d'opencode (./build.sh)" construire
    BINARY="$(ls -t "$REPO"/packages/cli/dist/*/bin/opencode 2>/dev/null | head -n1 || true)"
    [[ -n "$BINARY" ]] || die "binaire introuvable après la construction (packages/cli/dist/*/bin/opencode)."
  fi
  if [[ "$BINARY" != "$BIN_CIBLE" ]]; then
    install -m 0755 "$BINARY" "$BIN_CIBLE.new"
    mv -f "$BIN_CIBLE.new" "$BIN_CIBLE"
    ok "Binaire installé : $BIN_CIBLE"
  else
    ok "Binaire déjà en place : $BIN_CIBLE"
  fi
  OPENCODE_BIN="$BIN_CIBLE"
  info "Version : $(version_de "$OPENCODE_BIN")"
fi

# ------------------------------------------------------------------ Caddy

ip_publique() {
  local url ip
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]')" || continue
    [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && { echo "$ip"; return 0; }
  done
  return 1
}

verifier_dns() {
  local ip hote resolu
  if ! ip="$(ip_publique)"; then
    warn "adresse IPv4 publique inconnue : vérification DNS ignorée."
    return
  fi
  info "IPv4 publique : $ip"
  for hote in "$DOMAIN" "dnscheck-$(openssl rand -hex 4).$DOMAIN"; do
    resolu="$({ getent ahostsv4 "$hote" 2>/dev/null || true; } | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
    if [[ -z "$resolu" ]]; then
      if [[ "$hote" == "$DOMAIN" ]]; then warn "$DOMAIN ne se résout pas : ajouter un enregistrement A $DOMAIN → $ip"
      else warn "*.$DOMAIN ne se résout pas : ajouter un enregistrement A *.$DOMAIN → $ip"; fi
    elif ! grep -qwF -- "$ip" <<<"$resolu"; then
      warn "$hote pointe vers $resolu, pas vers ce serveur ($ip) : les certificats échoueront."
    else
      ok "DNS : $hote → $ip"
    fi
  done
}

installer_caddy() {
  apt_installer debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
    gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt_installer caddy
}

if ((INSTALLER_CADDY)); then
  etape "Caddy"
  verifier_dns
  if command -v caddy >/dev/null; then
    ok "Caddy déjà installé ${dim}($(caddy version | head -n1))${reset}"
  else
    suivre "Installation de Caddy (dépôt apt officiel)" installer_caddy
  fi

  nouveau="$(mktemp)"
  cat >"$nouveau" <<EOF
$MARQUE
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
  caddy fmt --overwrite "$nouveau" >/dev/null 2>&1 || true
  if ! caddy validate --adapter caddyfile --config "$nouveau" >/dev/null 2>&1; then
    caddy validate --adapter caddyfile --config "$nouveau" || true
    rm -f "$nouveau"
    die "le Caddyfile produit est invalide."
  fi
  mkdir -p /etc/caddy
  if [[ -f "$CADDYFILE" ]] && cmp -s "$nouveau" "$CADDYFILE"; then
    ok "Caddyfile inchangé"
  else
    if [[ -f "$CADDYFILE" ]]; then
      sauvegarde="$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
      cp -p "$CADDYFILE" "$sauvegarde"
      info "Ancien Caddyfile sauvegardé : $sauvegarde"
    fi
    install -m 0644 "$nouveau" "$CADDYFILE"
    ok "Caddyfile écrit : $CADDYFILE"
  fi
  rm -f "$nouveau"

  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ok "Ports 80 et 443 ouverts dans ufw"
  fi

  systemctl enable caddy >/dev/null 2>&1
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy || systemctl restart caddy
  else
    systemctl restart caddy
  fi
  ok "Caddy démarré, démarrage automatique activé"
fi

# ------------------------------------------------------------------ Hub

attendre_hub() {
  local _
  command -v curl >/dev/null || return 0
  for _ in $(seq 1 40); do
    curl -fsS --max-time 2 "http://127.0.0.1:$PORT/hub/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

if ((INSTALLER_HUB)); then
  etape "Hub"
  if ((SERVICE_HUB)); then
    if id "$HUB_UTILISATEUR" >/dev/null 2>&1; then
      ok "Utilisateur $HUB_UTILISATEUR déjà présent"
    else
      useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$HUB_UTILISATEUR"
      ok "Utilisateur système créé : $HUB_UTILISATEUR"
    fi
    install -d -m 0750 -o "$HUB_UTILISATEUR" -g "$HUB_UTILISATEUR" "$DATA_DIR"
    runuser -u "$HUB_UTILISATEUR" -- test -x "$OPENCODE_BIN" || die "$HUB_UTILISATEUR ne peut pas exécuter $OPENCODE_BIN."

    if [[ -f "$ENV_FILE" ]]; then
      ok "$ENV_FILE conservé (mot de passe inchangé)"
    else
      MOT_DE_PASSE_GENERE="$(openssl rand -base64 24 2>/dev/null || head -c 24 /dev/urandom | base64)"
      (umask 077; printf 'OPENCODE_HUB_PASSWORD=%s\n' "$MOT_DE_PASSE_GENERE" >"$ENV_FILE")
      ok "Mot de passe du hub créé dans $ENV_FILE"
    fi
    chown root:root "$ENV_FILE"
    chmod 0600 "$ENV_FILE"

    cat >"$UNIT_HUB" <<EOF
$MARQUE
[Unit]
Description=opencode hub
Documentation=https://opencode.ai
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$HUB_UTILISATEUR
Group=$HUB_UTILISATEUR
EnvironmentFile=-$ENV_FILE
Environment=HOME=$DATA_DIR
Environment=XDG_DATA_HOME=$DATA_DIR/.local/share
Environment=XDG_CONFIG_HOME=$DATA_DIR/.config
Environment=XDG_CACHE_HOME=$DATA_DIR/.cache
Environment=XDG_STATE_HOME=$DATA_DIR/.local/state
WorkingDirectory=$DATA_DIR
ExecStart=$OPENCODE_BIN hub --hostname $HUB_HOTE --port $PORT --url $HUB_URL --data $DATA_DIR
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
    ok "Service écrit : $UNIT_HUB"
    systemctl daemon-reload
    systemctl enable opencode-hub >/dev/null 2>&1
    systemctl restart opencode-hub
    if suivre "Démarrage du hub" attendre_hub; then
      ok "Hub en marche, démarrage automatique activé"
    else
      warn "le hub ne répond pas encore sur 127.0.0.1:$PORT : journalctl -u opencode-hub -e"
    fi
    if [[ -n "$MOT_DE_PASSE_GENERE" ]]; then
      echo
      cadre "$yellow" "Mot de passe du hub" "" "${bold}$MOT_DE_PASSE_GENERE${reset}" "" \
        "Affiché une seule fois. Il reste dans $ENV_FILE (OPENCODE_HUB_PASSWORD)."
    fi
  else
    info "Sans service : lancer le hub à la main avec"
    echo "  $OPENCODE_BIN hub --hostname $HUB_HOTE --port $PORT --url $HUB_URL"
    info "${dim}Le mot de passe est affiché au premier démarrage.${reset}"
  fi
fi

# ------------------------------------------------------------------ Client

if ((INSTALLER_CLIENT)); then
  etape "Client"
  CLIENT_HOME="$(dossier_de "$CLIENT_UTILISATEUR")"
  etat="$(en_tant_que "$CLIENT_UTILISATEUR" "$OPENCODE_BIN" agent status 2>/dev/null || true)"
  enroler=1
  if grep -q '^hub ' <<<"$etat"; then
    info "Machine déjà enrôlée :"
    sed 's/^/    /' <<<"$etat"
    if [[ -z "$CODE" ]] && ! oui_non "L'enrôler de nouveau ?" n; then enroler=0; fi
  fi
  if ((enroler)); then
    if [[ -z "$CODE" ]]; then
      info "Code d'enrôlement : tableau de bord $(lien "$CLIENT_URL"), bouton ${bold}add machine${reset}."
      demander CODE "Code d'enrôlement"
    fi
    suivre "Enrôlement auprès de $CLIENT_URL" \
      en_tant_que "$CLIENT_UTILISATEUR" "$OPENCODE_BIN" agent join "$CLIENT_URL" --code "$CODE" --name "$NOM_MACHINE" ||
      die "enrôlement refusé : vérifier l'URL et le code (un code ne sert qu'une fois)."
  fi

  if ((SERVICE_CLIENT)); then
    cat >"$UNIT_CLIENT" <<EOF
$MARQUE
[Unit]
Description=opencode agent ($CLIENT_UTILISATEUR)
Documentation=https://opencode.ai
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CLIENT_UTILISATEUR
Environment=HOME=$CLIENT_HOME
Environment=PATH=$CLIENT_HOME/.opencode/bin:$CLIENT_HOME/.bun/bin:$CLIENT_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WorkingDirectory=$CLIENT_HOME
ExecStart=$OPENCODE_BIN agent run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    ok "Service écrit : $UNIT_CLIENT"
    systemctl daemon-reload
    systemctl enable opencode-agent >/dev/null 2>&1
    systemctl restart opencode-agent
    sleep 1
    if systemctl is-active --quiet opencode-agent; then
      ok "Agent en marche, démarrage automatique activé"
    else
      warn "l'agent ne tourne pas : journalctl -u opencode-agent -e"
    fi
  else
    info "Sans service : garder la machine reliée avec"
    echo "  $OPENCODE_BIN agent run"
  fi
fi

# ================================================================== Résumé

fin=()
if ((INSTALLER_HUB || INSTALLER_CADDY)); then
  [[ -n "$HUB_URL" ]] && fin+=("Tableau de bord  $(lien "$HUB_URL")")
  [[ -n "$DOMAIN" ]] && fin+=("Machines         https://<id>.$DOMAIN")
fi
((INSTALLER_HUB && SERVICE_HUB)) && fin+=("Journal du hub   ${dim}journalctl -u opencode-hub -f${reset}")
((INSTALLER_CADDY)) && fin+=("Journal Caddy    ${dim}journalctl -u caddy -f${reset}")
((INSTALLER_CLIENT && SERVICE_CLIENT)) && fin+=("Journal agent    ${dim}journalctl -u opencode-agent -f${reset}")
((INSTALLER_HUB && SERVICE_HUB)) && fin+=("Mot de passe     ${dim}$ENV_FILE${reset}")
if ((INSTALLER_HUB && !INSTALLER_CLIENT)); then
  fin+=("" "Relier une machine : sur celle-ci,")
  fin+=("  ${dim}sudo ./install.sh --client --client-url ${HUB_URL:-<url>} --code <code>${reset}")
fi
echo
((${#fin[@]})) || fin=("Rien d'autre à faire.")
cadre "$green" "Installation terminée" "${fin[@]}"
echo
