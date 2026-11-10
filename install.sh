#!/usr/bin/env bash
# install.sh — installation et mise en place d'opencode-hub sur une machine Linux (systemd).
# install.sh — install and set up opencode-hub on a Linux machine (systemd).
#
# Propose trois composants, à cocher dans un menu ou à passer en options :
#   - Caddy  : proxy HTTPS devant le hub (certificats à la demande pour le hub et chaque machine) ;
#   - Hub    : le tableau de bord qui donne accès aux machines enrôlées ;
#   - Client : l'agent qui relie cette machine à un hub (opencode agent join / run).
# Le hub et le client peuvent être installés en service systemd avec démarrage automatique.
#
#   curl -fsSL https://raw.githubusercontent.com/H082-ORION/opencode-hub/remote-machines/install.sh | bash
#                                                        # tout-en-un : choix des composants, dernière version / all-in-one
#   sudo ./install.sh                                    # menu interactif / interactive menu
#   sudo ./install.sh --caddy --hub --domain hub.example.com --email vous@example.com --service
#   sudo ./install.sh --client --client-url https://hub.example.com --code <code> --service
#   ./install.sh --status                                # état des services / service status
#   sudo ./install.sh --uninstall                        # désinstallation / uninstall
#
# Langue / language : un menu la demande au lancement (français par défaut) ; --lang fr|en ou OPENCODE_HUB_LANG la fixent.
# Le script est autonome (un seul fichier, aucune dépendance à un autre dépôt) et peut être relancé sans risque.
# Réglages : NO_COLOR=1, OPENCODE_HUB_ASCII=1 (sans Unicode), OPENCODE_HUB_VITESSE=0 (sans pauses),
# OPENCODE_HUB_SANS_BANNIERE=1.

set -euo pipefail

# `curl … | bash` : le script arrive par l'entrée standard, qui est prise par curl et dont les menus ont besoin. Il se
# relance donc depuis une copie, avec le terminal en entrée.
SCRIPT_URL="${OPENCODE_HUB_SCRIPT_URL:-https://raw.githubusercontent.com/H082-ORION/opencode-hub/remote-machines/install.sh}"
if [[ ! -f "${BASH_SOURCE[0]:-}" ]]; then
  copie="$(mktemp /tmp/opencode-hub-installer.XXXXXX)"
  if ! curl -fsSL --retry 3 --connect-timeout 20 --max-time 120 -o "$copie" "$SCRIPT_URL"; then
    rm -f "$copie"
    echo "✗ téléchargement impossible / download failed: $SCRIPT_URL" >&2
    exit 1
  fi
  export OPENCODE_HUB_COPIE="$copie"
  # Le reste du script est lu jusqu'au bout, sans quoi curl signale une écriture interrompue.
  cat >/dev/null
  if (: </dev/tty) 2>/dev/null; then exec bash "$copie" "$@" </dev/tty; fi
  exec bash "$copie" "$@" </dev/null
fi

ARGS_ORIGINAUX=("$@")
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ================================================================== Langue

# Lue avant tout le reste : les messages d'erreur des options en dépendent.
LANGUE="${OPENCODE_HUB_LANG:-}"
_args=("$@")
for ((_i = 0; _i < ${#_args[@]}; _i++)); do
  case "${_args[_i]}" in
    --lang=*) LANGUE="${_args[_i]#--lang=}" ;;
    --lang) LANGUE="${_args[_i + 1]:-}" ;;
  esac
done
LANGUE_CHOISIE=0
[[ -n "$LANGUE" ]] && LANGUE_CHOISIE=1
case "${LANGUE,,}" in
  en*) LANGUE=en ;;
  fr* | '') LANGUE=fr ;;
  *) echo "✗ --lang : fr ou en / fr or en (reçu / got : $LANGUE)" >&2; exit 1 ;;
esac

# t "texte français" "english text" — le texte dans la langue choisie.
# DP : les deux-points, précédés d'une espace en français seulement (à recalculer si la langue change).
t() { if [[ "$LANGUE" == en ]]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
DP="$(t ' : ' ': ')"

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
MENU_AIDE=""

pause() { [[ "$VITESSE" == 0 ]] || sleep "$1"; }
cacher() { if ((TTY)); then printf '\e[?25l'; fi; }
montrer() { if ((TTY)); then printf '\e[?25h'; fi; }
DOSSIER_DL=""
nettoyer() {
  montrer
  [[ -z "$DOSSIER_DL" ]] || rm -rf "$DOSSIER_DL"
  [[ -z "${OPENCODE_HUB_COPIE:-}" ]] || rm -f "$OPENCODE_HUB_COPIE"
}
trap nettoyer EXIT
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
  local s
  s="$(sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g; s/\x1b\]8;;[^\x1b]*\x1b\\//g' <<<"$1")"
  printf '%d' "${#s}"
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
    err "$titre${DP}$(t "échec (code $rc)." "failed (code $rc).")"
    local -a ex=()
    while IFS= read -r l; do ex+=("$dim$(tronque "$l" $((LARGEUR - 6)))$reset"); done \
      < <(tr '\r' '\n' <"$jr" | sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g' | grep -v '^[[:space:]]*$' | tail -n 20)
    ((${#ex[@]})) || ex=("${dim}$(t "(aucune sortie)" "(no output)")${reset}")
    cadre "$red" "$(t "Dernières lignes" "Last lines")" "${ex[@]}" >&2
    echo "$(t "Journal complet" "Full log")${DP}$jr" >&2
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
    if ! interactif; then info "$(t "Non interactif : choix par défaut (1)." "Non-interactive: default choice (1).")"; MENU_CHOIX=0; return 0; fi
    printf '%s (1-%d)%s' "$(t "Votre choix" "Your choice")" "$n" "$DP"; read -r r || return 1
    [[ "$r" =~ ^[0-9]+$ ]] && ((r >= 1 && r <= n)) || return 1
    MENU_CHOIX=$((r - 1)); return 0
  fi
  printf '%s%s%s\n' "$dim" "${MENU_AIDE:-$(t "↑↓ ou chiffre · Entrée valide · q quitte" "↑↓ or number · Enter selects · q quits")}" "$reset"
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
    printf '%s : ' "$(t "Numéros séparés par des espaces" "Numbers separated by spaces")"; read -r r || return 1
    for k in $r; do [[ "$k" =~ ^[0-9]+$ ]] && ((k >= 1 && k <= n)) && COCHES+=("$((k - 1))"); done
    return 0
  fi
  printf '%s%s%s\n' "$dim" "$(t "↑↓ déplace · espace coche · Entrée valide · q quitte" "↑↓ moves · space toggles · Enter confirms · q quits")" "$reset"
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
  local var="$1" question="$2" defaut="${!1:-${3:-}}" regex="${4:-}" msg="${5:-$(t "valeur invalide" "invalid value")}" r
  local invite="$gris$S_ASK$reset $question"
  [[ -z "$defaut" ]] || invite+=" ${dim}[$defaut]${reset}"
  if ! interactif; then
    [[ -n "$defaut" ]] || { err "$question${DP}$(t "valeur obligatoire en mode non interactif." "a value is required in non-interactive mode.")"; return 1; }
    [[ -z "$regex" || "$defaut" =~ $regex ]] || { err "$question${DP}$msg"; return 1; }
    printf -v "$var" '%s' "$defaut"; info "$question${DP}${bold}$defaut${reset}"; return 0
  fi
  while :; do
    read -r -p "$invite " r || return 1
    r="${r:-$defaut}"
    if [[ -z "$r" ]]; then err "$(t "valeur obligatoire." "a value is required.")"; continue; fi
    if [[ -n "$regex" && ! "$r" =~ $regex ]]; then err "$msg"; continue; fi
    printf -v "$var" '%s' "$r"; return 0
  done
}

# demander_secret VARIABLE "question" — saisie sans écho ; hors interactif, la valeur déjà donnée en option.
demander_secret() {
  local var="$1" question="$2" r
  if ! interactif; then
    [[ -n "${!var:-}" ]] || { err "$question${DP}$(t "valeur obligatoire en mode non interactif." "a value is required in non-interactive mode.")"; return 1; }
    return 0
  fi
  while :; do
    read -rs -p "$gris$S_ASK$reset $question ${dim}$(t "(non affiché)" "(hidden)")${reset} " r || return 1
    echo
    if [[ -n "$r" ]]; then printf -v "$var" '%s' "$r"; return 0; fi
    err "$(t "valeur obligatoire." "a value is required.")"
  done
}

# url_sure URL — HTTPS, ou HTTP vers cette machine seulement (même règle que « opencode agent join »).
url_sure() {
  local hote
  [[ "$1" == https://* ]] && return 0
  [[ "$1" == http://* ]] || return 1
  hote="${1#http://}"; hote="${hote%%/*}"
  if [[ "$hote" == \[* ]]; then hote="${hote%%]*}]"; else hote="${hote%%:*}"; fi
  hote="${hote,,}"
  [[ "$hote" == localhost || "$hote" == *.localhost || "$hote" == "[::1]" || "$hote" =~ ^127(\.[0-9]{1,3}){3}$ ]]
}

# oui_non "question" [o|n] — renvoie 0 pour oui ; hors interactif, le défaut.
oui_non() {
  local q="$1" def="${2:-o}" r sfx
  if [[ "$def" == n ]]; then sfx="$(t '[o/N]' '[y/N]')"; else sfx="$(t '[O/n]' '[Y/n]')"; fi
  if ! interactif; then [[ "$def" == o ]]; return; fi
  while :; do
    read -r -p "$gris$S_ASK$reset $q ${dim}$sfx${reset} " r || return 1
    r="${r:-$def}"
    case "${r,,}" in o|oui|y|yes) return 0 ;; n|non|no) return 1 ;; *) err "$(t "répondre par o ou n." "answer y or n.")" ;; esac
  done
}

# confirmer_grave "ce qui sera perdu" MOT — encart rouge ; il faut retaper MOT. Avec --yes : accepté.
confirmer_grave() {
  local quoi="$1" mot="$2" r
  cadre "$red" "$(t "Action irréversible" "Irreversible action")" "$quoi" "" "$(t "Pour confirmer, tapez" "To confirm, type")${DP}${bold}$mot${reset}"
  [[ "$OUI" == 1 ]] && return 0
  interactif || { err "$(t "confirmation impossible hors terminal (--yes pour passer outre)." "cannot confirm without a terminal (--yes to override).")"; return 1; }
  read -r -p "$red$S_ASK$reset " r || return 1
  [[ "$r" == "$mot" ]] || { err "$(t "mot différent : rien n'a été effacé." "different word: nothing was deleted.")"; return 1; }
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
PORT_DONNE=0
HUB_HOTE="127.0.0.1"
HUB_URL=""
HUB_UTILISATEUR="opencode"
CLIENT_URL=""
CODE=""
INSECURE=0
NOM_MACHINE=""
CLIENT_UTILISATEUR=""
BINARY=""
CONSTRUIRE=0
TELECHARGER=0
VERSION_VOULUE=""
DEPOT="H082-ORION/opencode-hub"
TAG=""
MODE=installer
PURGER=0

DATA_DIR="/var/lib/opencode-hub"
# Mot de passe unique des anciennes versions du hub : plus créé, retiré s'il reste.
ANCIEN_ENV_FILE="/etc/opencode-hub.env"
UNIT_HUB="/etc/systemd/system/opencode-hub.service"
UNIT_CLIENT="/etc/systemd/system/opencode-agent.service"
CADDYFILE="/etc/caddy/Caddyfile"
BIN_CIBLE="/usr/local/bin/opencode"
# Marque reconnue par script/hub/uninstall.sh : la garder identique.
MARQUE="# Managed by opencode script/hub/install.sh"

aide() {
  t "Installe Caddy, le hub et/ou le client opencode-hub, avec un service systemd à démarrage automatique." \
    "Installs Caddy, the opencode-hub hub and/or client, with a systemd service started at boot."
  echo
  t "Sans option, un menu propose les composants et chaque réglage." \
    "Without options, a menu offers the components and each setting."
  echo
  aide_titre "$(t "Utilisation" "Usage")"
  echo "  sudo ./install.sh $(t "[composants] [options]" "[components] [options]")"
  aide_titre "$(t "Composants" "Components")"
  aide_opt "--caddy" "$(t "proxy HTTPS devant le hub (certificats à la demande)" "HTTPS proxy in front of the hub (on-demand certificates)")"
  aide_opt "--hub" "$(t "tableau de bord qui donne accès aux machines" "dashboard that gives access to the machines")"
  aide_opt "--client" "$(t "relie cette machine à un hub (agent)" "connects this machine to a hub (agent)")"
  aide_titre "$(t "Caddy et hub" "Caddy and hub")"
  aide_opt "--domain $(t "<hôte>" "<host>")" "$(t "nom public du hub ; les machines sont sur <id>.<hôte>" "public hub hostname; machines are served at <id>.<host>")"
  aide_opt "--email $(t "<adresse>" "<address>")" "$(t "compte ACME de Caddy pour les certificats" "Caddy ACME account for certificates")"
  aide_opt "--port <port>" "$(t "port local du hub (défaut : 4800)" "local hub port (default: 4800)")"
  aide_opt "--hub-url <url>" "$(t "URL publique du hub (sans Caddy ; défaut : http://localhost:<port>)" "public hub URL (without Caddy; default: http://localhost:<port>)")"
  aide_opt "--hub-user $(t "<nom>" "<name>")" "$(t "utilisateur système du hub (défaut : opencode)" "system user running the hub (default: opencode)")"
  aide_titre "Client"
  aide_opt "--client-url <url>" "$(t "URL du hub à rejoindre" "URL of the hub to join")"
  aide_opt "--code <code>" "$(t "code d'enrôlement à usage unique (sinon demandé sans affichage)" "one-time enrollment code (otherwise asked without echo)")"
  aide_opt "--name $(t "<nom>" "<name>")" "$(t "nom de la machine (défaut : nom d'hôte)" "machine name (default: hostname)")"
  aide_opt "--client-user $(t "<nom>" "<name>")" "$(t "utilisateur qui fait tourner l'agent (défaut : celui qui lance sudo)" "user running the agent (default: the one running sudo)")"
  aide_opt "--insecure" "$(t "accepter un hub en http:// sur une autre machine (code et jetons en clair)" "accept a plain http:// hub on another machine (code and tokens in clear text)")"
  aide_titre "$(t "Binaire et services" "Binary and services")"
  aide_opt "--binary $(t "<chemin>" "<path>")" "$(t "binaire opencode à installer dans $BIN_CIBLE" "opencode binary to install to $BIN_CIBLE")"
  aide_opt "--download" "$(t "télécharger la dernière version depuis GitHub, pré-versions comprises" "download the latest version from GitHub, pre-releases included")"
  aide_opt "--version $(t "<version>" "<version>")" "$(t "télécharger cette version (ex. 1.0.0-pre.3)" "download this version (e.g. 1.0.0-pre.3)")"
  aide_opt "--build" "$(t "construire le binaire depuis ce dépôt (./build.sh)" "build the binary from this repository (./build.sh)")"
  aide_opt "--service" "$(t "installer les services systemd (démarrage automatique)" "install the systemd services (start at boot)")"
  aide_opt "--no-service" "$(t "ne pas installer de service systemd" "do not install systemd services")"
  aide_titre "Maintenance"
  aide_opt "--status" "$(t "état de Caddy, du hub, de l'agent et du binaire" "status of Caddy, the hub, the agent and the binary")"
  aide_opt "--uninstall" "$(t "désinstaller (les composants cochés, ou ceux passés en options)" "uninstall (the checked components, or those given as options)")"
  aide_opt "--purge" "$(t "avec --uninstall : données du hub, enrôlement, paquet Caddy, binaire" "with --uninstall: hub data, enrollment, Caddy package, binary")"
  aide_titre "$(t "Général" "General")"
  aide_opt "--lang fr|en" "$(t "langue sans passer par le menu du lancement (ou OPENCODE_HUB_LANG)" "language without the startup menu (or OPENCODE_HUB_LANG)")"
  aide_opt "-y, --yes" "$(t "aucune question : options et valeurs par défaut" "no questions: options and default values")"
  aide_opt "-h, --help" "$(t "cette aide" "this help")"
  aide_titre "$(t "Exemples" "Examples")"
  echo "  sudo ./install.sh"
  echo "  sudo ./install.sh --caddy --hub --domain hub.example.com --email $(t "vous" "you")@example.com --service --yes"
  echo "  sudo ./install.sh --client --client-url https://hub.example.com --code <code> --service"
  echo "  ./install.sh --status"
  echo "  sudo ./install.sh --uninstall --hub --client"
  echo "  sudo ./install.sh --lang en"
  echo
}

valeur() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 $(t "attend une valeur" "requires a value")"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --caddy) INSTALLER_CADDY=1; shift ;;
    --hub) INSTALLER_HUB=1; shift ;;
    --client) INSTALLER_CLIENT=1; shift ;;
    --domain) valeur "$@"; DOMAIN="$2"; shift 2 ;;
    --email) valeur "$@"; EMAIL="$2"; shift 2 ;;
    --port) valeur "$@"; PORT="$2"; PORT_DONNE=1; shift 2 ;;
    --hub-url) valeur "$@"; HUB_URL="$2"; shift 2 ;;
    --hub-user) valeur "$@"; HUB_UTILISATEUR="$2"; shift 2 ;;
    --client-url) valeur "$@"; CLIENT_URL="$2"; shift 2 ;;
    --code) valeur "$@"; CODE="$2"; shift 2 ;;
    --insecure) INSECURE=1; shift ;;
    --name) valeur "$@"; NOM_MACHINE="$2"; shift 2 ;;
    --client-user) valeur "$@"; CLIENT_UTILISATEUR="$2"; shift 2 ;;
    --binary) valeur "$@"; BINARY="$2"; shift 2 ;;
    --build) CONSTRUIRE=1; shift ;;
    --download) TELECHARGER=1; shift ;;
    --version) valeur "$@"; TELECHARGER=1; VERSION_VOULUE="${2#v}"; shift 2 ;;
    --service) SERVICE_HUB=1; SERVICE_CLIENT=1; shift ;;
    --no-service) SERVICE_HUB=0; SERVICE_CLIENT=0; shift ;;
    --lang) valeur "$@"; shift 2 ;;
    --lang=*) shift ;;
    -y | --yes) OUI=1; shift ;;
    --status) MODE=etat; shift ;;
    --uninstall) MODE=desinstaller; shift ;;
    --purge) PURGER=1; shift ;;
    -h | --help) MODE=aide; shift ;;
    *) aide >&2; die "$(t "option inconnue" "unknown option")${DP}$1" ;;
  esac
done

# Bannière, puis choix de la langue par un menu dès le lancement (sauf si --lang ou OPENCODE_HUB_LANG l'ont fixée).
case "$MODE" in
  aide) sous_fr="aide de l'installateur"; sous_en="installer help" ;;
  etat) sous_fr="état des services"; sous_en="service status" ;;
  desinstaller) sous_fr="désinstallation"; sous_en="uninstall" ;;
  *) sous_fr="installation"; sous_en="installation" ;;
esac
titre_onglet "opencode-hub · $(t "$sous_fr" "$sous_en")"
if ((!LANGUE_CHOISIE)) && interactif && ((TTY)); then
  if [[ "$sous_fr" == "$sous_en" ]]; then banniere "opencode-hub" "$sous_fr"; else banniere "opencode-hub" "$sous_fr / $sous_en"; fi
  MENU_AIDE="↑↓ · Entrée / Enter · q"
  menu "Langue / Language" "Français" "English" || die "abandon / aborted."
  MENU_AIDE=""
  if ((MENU_CHOIX == 1)); then LANGUE=en; DP=': '; fi
  titre_onglet "opencode-hub · $(t "$sous_fr" "$sous_en")"
else
  banniere "opencode-hub" "$(t "$sous_fr" "$sous_en")"
fi

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
  local -a env_u=(env HOME="$h" USER="$u" LOGNAME="$u" OPENCODE_HUB_LANG="$LANGUE"
    PATH="$h/.opencode/bin:$h/.bun/bin:$h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
  if [[ "$u" == root ]]; then "${env_u[@]}" "$@"; else runuser -u "$u" -- "${env_u[@]}" "$@"; fi
}

# Le tag de la dernière version publiée, pré-versions comprises ; vide si GitHub ne répond pas.
derniere_version() {
  { curl -fsSL --connect-timeout 15 --max-time 30 "https://api.github.com/repos/$DEPOT/releases?per_page=1" 2>/dev/null || true; } |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1
}

# Télécharge l'archive de $TAG pour cette architecture dans $DOSSIER_DL, la vérifie et l'extrait.
telecharger_binaire() {
  local arch archive base
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "$(t "architecture non prise en charge" "unsupported architecture")${DP}$(uname -m)" >&2; return 1 ;;
  esac
  archive="opencode-linux-$arch.tar.gz"
  base="https://github.com/$DEPOT/releases/download/$TAG"
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 1800 -o "$DOSSIER_DL/$archive" "$base/$archive"
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 60 -o "$DOSSIER_DL/SHA256SUMS" "$base/SHA256SUMS"
  (cd "$DOSSIER_DL" && grep "  $archive\$" SHA256SUMS | sha256sum --check --status) ||
    { echo "$(t "somme de contrôle incorrecte : archive corrompue" "checksum mismatch: corrupted archive")" >&2; return 1; }
  tar -xzf "$DOSSIER_DL/$archive" -C "$DOSSIER_DL" opencode
  timeout 30 "$DOSSIER_DL/opencode" --version
}

version_de() { local v; v="$("$1" --version 2>/dev/null | head -n1)" || true; printf '%s\n' "${v:-$(t "version inconnue" "unknown version")}"; }

# signaler_autre_opencode UTILISATEUR — prévient si `opencode` désigne pour lui un autre binaire que celui installé
# (OpenCode officiel, par exemple, qui n'a pas les commandes du hub). Ce binaire n'est jamais lancé : il lui appartient
# et ce script tourne en root. Le PATH testé est celui d'en_tant_que, pas celui de ses fichiers de démarrage.
signaler_autre_opencode() {
  local autre
  autre="$(en_tant_que "$1" bash -c 'type -P opencode' 2>/dev/null || true)"
  [[ -n "$autre" && "$(readlink -f "$autre")" != "$(readlink -f "$BIN_CIBLE")" ]] || return 0
  warn "$(t "pour $1, « opencode » lance $autre et non $BIN_CIBLE : les commandes du hub (agent run, hub…) peuvent y manquer." "for $1, \"opencode\" runs $autre, not $BIN_CIBLE: it may lack the hub commands (agent run, hub…).")"
  info "$(t "Utiliser le chemin complet ($BIN_CIBLE agent run) ou retirer l'autre binaire." "Use the full path ($BIN_CIBLE agent run) or remove the other binary.")"
}

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
    actif) printf '%s%s%s %s' "$green" "$S_ON" "$reset" "$(t "en marche" "running")" ;;
    inactif) printf '%s%s%s %s' "$yellow" "$S_ON" "$reset" "$(t "arrêté" "stopped")" ;;
    installe) printf '%s%s%s %s' "$green" "$S_ON" "$reset" "$(t "installé" "installed")" ;;
    *) printf '%s%s %s%s' "$dim" "$S_OFF" "$(t "absent" "missing")" "$reset" ;;
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
    0) a="${dim}$(t "manuel" "manual")${reset}" ;;
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
    [[ -n "$dom" ]] && d+=" $S_SEP $dom $(t "et" "and") *.$dom"
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
      if curl -fsS --max-time 2 "http://127.0.0.1:$port/hub/health" >/dev/null 2>&1; then sante="${green}$(t "répond" "responds")${reset}"
      else sante="${red}$(t "ne répond pas" "not responding")${reset}"; fi
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
    d="$(t "utilisateur" "user") ${u:-?}"
    if [[ $EUID -eq 0 && -n "$u" && -x "$BIN_CIBLE" ]]; then
      etat_agent="$(en_tant_que "$u" "$BIN_CIBLE" agent status 2>/dev/null || true)"
      if grep -q '^hub ' <<<"$etat_agent"; then
        d+=" $S_SEP $(sed -n 's/^hub *//p' <<<"$etat_agent" | head -n1)"
      else
        d+=" $S_SEP ${red}$(t "non enrôlé" "not enrolled")${reset}$dim"
      fi
    fi
    l+=("$(ligne_etat Client "$e" "$(auto_unite opencode-agent && echo 1 || echo 0)" "$d")")
  fi

  # Binaire
  if [[ -x "$BIN_CIBLE" ]]; then
    l+=("$(ligne_etat "$(t "Binaire" "Binary")" installe - "$BIN_CIBLE $S_SEP $(version_de "$BIN_CIBLE")")")
  else
    l+=("$(ligne_etat "$(t "Binaire" "Binary")" absent - "$BIN_CIBLE")")
  fi

  cadre "$gris" "$(t "État des services" "Service status")" "${l[@]}"
  [[ $EUID -eq 0 ]] || info "${dim}$(t "Lancer avec sudo pour voir aussi l'enrôlement de l'agent." "Run with sudo to also see the agent's enrollment.")${reset}"
  echo
  info "$(t "Journaux" "Logs")${DP}${dim}journalctl -u opencode-hub -f · journalctl -u opencode-agent -f · journalctl -u caddy -f${reset}"
  echo
}

desinstaller() {
  local present_caddy=0 present_hub=0 present_client=0 i u sauvegarde
  [[ -f "$CADDYFILE" ]] && grep -qF "$MARQUE" "$CADDYFILE" && present_caddy=1
  command -v caddy >/dev/null && present_caddy=1
  [[ -f "$UNIT_HUB" || -f "$ANCIEN_ENV_FILE" ]] && present_hub=1
  [[ -f "$UNIT_CLIENT" ]] && present_client=1

  if ((!INSTALLER_CADDY && !INSTALLER_HUB && !INSTALLER_CLIENT)); then
    local -a opts=() codes=()
    ((present_caddy)) && { opts+=("Caddy   ${dim}$(t "configuration du hub, paquet en option" "hub configuration, package optional")${reset}"); codes+=(caddy); }
    ((present_hub)) && { opts+=("Hub     ${dim}$(t "service opencode-hub, données en option" "opencode-hub service, data optional")${reset}"); codes+=(hub); }
    ((present_client)) && { opts+=("Client  ${dim}$(t "service opencode-agent, enrôlement en option" "opencode-agent service, enrollment optional")${reset}"); codes+=(client); }
    ((${#opts[@]})) || { ok "$(t "Rien à désinstaller : ni Caddy, ni hub, ni agent installés." "Nothing to uninstall: no Caddy, hub or agent installed.")"; return 0; }
    interactif || die "$(t "préciser les composants à retirer : --caddy, --hub ou --client (voir --help)." "specify the components to remove: --caddy, --hub or --client (see --help).")"
    cocher "$(t "Que faut-il désinstaller ?" "What should be uninstalled?")" "${opts[@]}" || die "$(t "abandon." "aborted.")"
    for i in "${COCHES[@]}"; do
      case "${codes[$i]}" in caddy) INSTALLER_CADDY=1 ;; hub) INSTALLER_HUB=1 ;; client) INSTALLER_CLIENT=1 ;; esac
    done
    ((INSTALLER_CADDY || INSTALLER_HUB || INSTALLER_CLIENT)) || die "$(t "aucun composant coché : rien à faire." "no component checked: nothing to do.")"
  fi

  # Questions avant d'agir ; --purge répond oui à tout.
  local oublier=0 effacer_donnees=0 retirer_caddy=0 retirer_binaire=0
  local -a recap=()
  if ((INSTALLER_CLIENT)); then
    if ((PURGER)) || oui_non "$(t "Oublier aussi l'enrôlement de cette machine auprès du hub ?" "Also forget this machine's enrollment with the hub?")" n; then oublier=1; fi
    recap+=("${bold}Client${reset}  $(t "service opencode-agent arrêté et retiré" "opencode-agent service stopped and removed")$( ((oublier)) && t ", enrôlement oublié" ", enrollment forgotten" || true)")
  fi
  if ((INSTALLER_HUB)); then
    if ((PURGER)) || oui_non "$(t "Supprimer aussi les données du hub ($DATA_DIR) ?" "Also delete the hub data ($DATA_DIR)?")" n; then effacer_donnees=1; fi
    recap+=("${bold}Hub${reset}     $(t "service opencode-hub retiré" "opencode-hub service removed")$( ((effacer_donnees)) && echo ", ${red}$(t "données effacées" "data deleted")${reset}" || true)")
  fi
  if ((INSTALLER_CADDY)); then
    if command -v caddy >/dev/null && { ((PURGER)) || oui_non "$(t "Désinstaller aussi le paquet Caddy ?" "Also uninstall the Caddy package?")" n; }; then retirer_caddy=1; fi
    if ((retirer_caddy)); then recap+=("${bold}Caddy${reset}   $(t "paquet désinstallé, configuration du hub retirée" "package uninstalled, hub configuration removed")")
    else recap+=("${bold}Caddy${reset}   $(t "configuration du hub retirée (ancien Caddyfile restauré s'il existe)" "hub configuration removed (previous Caddyfile restored if any)")"); fi
  fi
  # Le binaire ne part que si plus rien ne s'en sert.
  local hub_reste=$((present_hub && !INSTALLER_HUB)) client_reste=$((present_client && !INSTALLER_CLIENT))
  if [[ -x "$BIN_CIBLE" ]] && ((!hub_reste && !client_reste)) && ((INSTALLER_HUB || INSTALLER_CLIENT)); then
    if ((PURGER)) || oui_non "$(t "Supprimer aussi le binaire $BIN_CIBLE ?" "Also delete the binary $BIN_CIBLE?")" n; then retirer_binaire=1; fi
  fi
  ((retirer_binaire)) && recap+=("${bold}$(t "Binaire" "Binary")${reset} $BIN_CIBLE $(t "supprimé" "deleted")")

  echo
  cadre "$gris" "$(t "Désinstallation" "Uninstall")" "${recap[@]}"
  if [[ "$OUI" != 1 ]]; then
    interactif || die "$(t "confirmation impossible hors terminal : ajouter --yes." "cannot confirm without a terminal: add --yes.")"
    oui_non "$(t "Lancer la désinstallation ?" "Start the uninstall?")" n || die "$(t "abandon : rien n'a été modifié." "aborted: nothing was changed.")"
  fi
  if ((effacer_donnees)); then
    confirmer_grave "$(t "Les données du hub ($DATA_DIR : comptes, machines, fournisseurs, réglages) seront effacées." "The hub data ($DATA_DIR: accounts, machines, providers, settings) will be deleted.")" \
      "$(t "SUPPRIMER" "DELETE")" || die "$(t "abandon : rien n'a été modifié." "aborted: nothing was changed.")"
  fi

  # Client
  if ((INSTALLER_CLIENT)); then
    etape "Client"
    u="$(cle_unite "$UNIT_CLIENT" User)"
    if ((oublier)) && [[ -n "$u" && -x "$BIN_CIBLE" ]]; then
      if en_tant_que "$u" "$BIN_CIBLE" agent leave >/dev/null 2>&1; then ok "$(t "Enrôlement oublié" "Enrollment forgotten") ($u)"
      else warn "$(t "impossible d'oublier l'enrôlement : $BIN_CIBLE agent leave (en tant que $u)" "could not forget the enrollment: $BIN_CIBLE agent leave (as $u)")"; fi
    fi
    systemctl disable --now opencode-agent >/dev/null 2>&1 || true
    rm -f "$UNIT_CLIENT"
    systemctl daemon-reload
    systemctl reset-failed opencode-agent >/dev/null 2>&1 || true
    ok "$(t "Service opencode-agent arrêté et retiré" "opencode-agent service stopped and removed")"
  fi

  # Hub
  if ((INSTALLER_HUB)); then
    etape "Hub"
    u="$(cle_unite "$UNIT_HUB" User)"
    systemctl disable --now opencode-hub >/dev/null 2>&1 || true
    # Le fichier d'environnement ne vient que d'une ancienne installation ; il est retiré s'il reste.
    rm -f "$UNIT_HUB" "$ANCIEN_ENV_FILE"
    systemctl daemon-reload
    systemctl reset-failed opencode-hub >/dev/null 2>&1 || true
    ok "$(t "Service opencode-hub retiré" "opencode-hub service removed")"
    if ((effacer_donnees)); then
      rm -rf "$DATA_DIR"
      ok "$(t "Données effacées" "Data deleted")${DP}$DATA_DIR"
      # L'utilisateur système part avec ses données, s'il a été créé par ce script (dossier personnel = données).
      if [[ -n "$u" && "$u" != root ]] && id "$u" >/dev/null 2>&1 && [[ "$(dossier_de "$u")" == "$DATA_DIR" ]]; then
        if userdel "$u" >/dev/null 2>&1; then ok "$(t "Utilisateur système supprimé" "System user deleted")${DP}$u"
        else warn "$(t "impossible de supprimer l'utilisateur" "could not delete the user") $u"; fi
      fi
    else
      info "$(t "Données conservées" "Data kept")${DP}$DATA_DIR ${dim}$(t "(--purge pour les effacer)" "(--purge to delete it)")${reset}"
    fi
  fi

  # Caddy
  if ((INSTALLER_CADDY)); then
    etape "Caddy"
    if [[ -f "$CADDYFILE" ]] && grep -qF "$MARQUE" "$CADDYFILE"; then
      sauvegarde="$(find "$(dirname "$CADDYFILE")" -maxdepth 1 -name 'Caddyfile.bak.*' -type f 2>/dev/null | sort | tail -n1 || true)"
      if [[ -n "$sauvegarde" ]]; then
        cp -p "$sauvegarde" "$CADDYFILE"
        ok "$(t "Caddyfile restauré depuis" "Caddyfile restored from") $sauvegarde"
      elif ((retirer_caddy)); then
        rm -f "$CADDYFILE"
      else
        warn "$(t "aucune sauvegarde : $CADDYFILE renvoie toujours vers le hub ; le modifier puis : systemctl reload caddy" "no backup: $CADDYFILE still proxies to the hub; edit it, then: systemctl reload caddy")"
      fi
    fi
    if ((retirer_caddy)); then
      suivre "$(t "Désinstallation du paquet Caddy" "Uninstalling the Caddy package")" env DEBIAN_FRONTEND=noninteractive apt-get purge -y -q caddy
      rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      ok "$(t "Dépôt apt de Caddy retiré" "Caddy apt repository removed")"
    elif command -v caddy >/dev/null && systemctl is-active --quiet caddy; then
      if systemctl reload caddy >/dev/null 2>&1; then ok "$(t "Caddy rechargé" "Caddy reloaded")"
      else warn "$(t "rechargement de Caddy impossible" "could not reload Caddy")${DP}journalctl -u caddy -e"; fi
    fi
  fi

  # Binaire
  if ((retirer_binaire)); then
    rm -f "$BIN_CIBLE"
    ok "$(t "Binaire supprimé" "Binary deleted")${DP}$BIN_CIBLE"
  fi

  echo
  cadre "$green" "$(t "Désinstallation terminée" "Uninstall complete")" "$(t "État actuel" "Current status")${DP}${dim}./install.sh --status${reset}"
  echo
}

# ================================================================== Démarrage

if [[ "$MODE" == aide ]]; then aide; exit 0; fi
command -v systemctl >/dev/null || die "$(t "systemd est nécessaire (systemctl introuvable)." "systemd is required (systemctl not found).")"
if [[ "$MODE" == etat ]]; then afficher_etat; exit 0; fi

# Droits administrateur : on propose de relancer avec sudo (la langue choisie suit).
if [[ $EUID -ne 0 ]]; then
  # Sans question (--yes), la relance se fait d'office : sudo demande au besoin le mot de passe sur le terminal.
  if command -v sudo >/dev/null 2>&1 &&
    oui_non "$(t "Cette opération demande les droits administrateur. Relancer avec sudo ?" "This requires administrator rights. Run again with sudo?")"; then
    exec sudo env OPENCODE_HUB_SANS_BANNIERE=1 OPENCODE_HUB_LANG="$LANGUE" OPENCODE_HUB_COPIE="${OPENCODE_HUB_COPIE:-}" bash "$0" "${ARGS_ORIGINAUX[@]}"
  fi
  die "$(t "lancer en administrateur" "run as administrator")${DP}sudo $0 ${ARGS_ORIGINAUX[*]}"
fi

APPELANT="${SUDO_USER:-root}"

if [[ "$MODE" == desinstaller ]]; then desinstaller; exit 0; fi

# ------------------------------------------------------------------ Choix des composants

# Une installation précédente de Caddy par ce script donne les valeurs par défaut : son domaine, son adresse e-mail et
# le port du hub qu'il sert.
CADDY_DOMAINE=""
CADDY_EMAIL=""
CADDY_PORT=""
if [[ -f "$CADDYFILE" ]] && grep -qF "$MARQUE" "$CADDYFILE"; then
  CADDY_DOMAINE="$(sed -n 's/^\([a-z0-9.-]*\), \*\.\1 {$/\1/p' "$CADDYFILE" | head -n1)"
  CADDY_EMAIL="$(sed -n 's/^[[:space:]]*email[[:space:]]\{1,\}\([^[:space:]]*\).*/\1/p' "$CADDYFILE" | head -n1)"
  CADDY_PORT="$(sed -n 's/^[[:space:]]*reverse_proxy 127\.0\.0\.1:\([0-9]*\).*/\1/p' "$CADDYFILE" | head -n1)"
fi
[[ -z "$CADDY_PORT" ]] || ((PORT_DONNE)) || PORT="$CADDY_PORT"

if ((!INSTALLER_CADDY && !INSTALLER_HUB && !INSTALLER_CLIENT)); then
  interactif || die "$(t "préciser au moins un composant : --caddy, --hub ou --client (voir --help)." "specify at least one component: --caddy, --hub or --client (see --help).")"
  menu "$(t "Que voulez-vous faire ?" "What do you want to do?")" \
    "$(t "Installer un hub public sur ce serveur" "Install a public hub on this server") ${dim}$(t "(Caddy + hub en HTTPS, conseillé sur un VPS)" "(Caddy + hub over HTTPS, advised on a VPS)")${reset}" \
    "$(t "Relier cette machine à un hub" "Connect this machine to a hub") ${dim}$(t "(client)" "(client)")${reset}" \
    "$(t "Installer un hub local, sans HTTPS" "Install a local hub, without HTTPS") ${dim}$(t "(essai sur ce poste)" "(a trial on this computer)")${reset}" \
    "$(t "Choisir les composants un par un" "Choose the components one by one")" || die "$(t "abandon." "aborted.")"
  case "$MENU_CHOIX" in
    0) INSTALLER_CADDY=1; INSTALLER_HUB=1 ;;
    1) INSTALLER_CLIENT=1 ;;
    2) INSTALLER_HUB=1 ;;
  esac
fi
if ((!INSTALLER_CADDY && !INSTALLER_HUB && !INSTALLER_CLIENT)); then
  cocher "$(t "Que faut-il installer ?" "What should be installed?")" \
    "Caddy   ${dim}$(t "proxy HTTPS et certificats automatiques" "HTTPS proxy and automatic certificates")${reset}" \
    "Hub     ${dim}$(t "tableau de bord des machines" "machines dashboard")${reset}" \
    "Client  ${dim}$(t "relie cette machine à un hub" "connects this machine to a hub")${reset}" || die "$(t "abandon." "aborted.")"
  for i in "${COCHES[@]}"; do
    case "$i" in 0) INSTALLER_CADDY=1 ;; 1) INSTALLER_HUB=1 ;; 2) INSTALLER_CLIENT=1 ;; esac
  done
  ((INSTALLER_CADDY || INSTALLER_HUB || INSTALLER_CLIENT)) || die "$(t "aucun composant coché : rien à faire." "no component checked: nothing to do.")"
fi
choix=()
((INSTALLER_CADDY)) && choix+=("Caddy")
((INSTALLER_HUB)) && choix+=("Hub")
((INSTALLER_CLIENT)) && choix+=("Client")
ok "$(t "Composants" "Components")${DP}${bold}${choix[*]}${reset}"

# Caddy ne sert que le hub de ce serveur, et le hub doit connaître le domaine de Caddy : l'un ne va pas sans l'autre,
# dans quelque ordre qu'on les installe.
if ((INSTALLER_CADDY && !INSTALLER_HUB)); then
  INSTALLER_HUB=1
  info "$(t "Caddy sert le hub de ce serveur : le hub est installé ou mis à jour avec lui." "Caddy serves this server's hub: the hub is installed or updated with it.")"
elif ((INSTALLER_HUB && !INSTALLER_CADDY)) && [[ -n "$CADDY_DOMAINE" && -z "$HUB_URL" ]]; then
  INSTALLER_CADDY=1
  info "$(t "Caddy sert déjà $CADDY_DOMAINE : le hub prend ce domaine, en HTTPS." "Caddy already serves $CADDY_DOMAINE: the hub takes this domain, over HTTPS.")"
fi

if ((INSTALLER_CADDY)); then
  command -v apt-get >/dev/null || die "$(t "l'installation de Caddy demande Debian ou Ubuntu (apt-get)." "installing Caddy requires Debian or Ubuntu (apt-get).")"
fi

# ------------------------------------------------------------------ Réglages de Caddy et du hub

if ((INSTALLER_CADDY || INSTALLER_HUB)); then
  etape "$(t "Réglages du hub" "Hub settings")"
  demander PORT "$(t "Port local du hub" "Local hub port")" "4800" "$RE_PORT" "$(t "un nombre entre 1 et 65535" "a number between 1 and 65535")"
  ((PORT >= 1 && PORT <= 65535)) || die "$(t "port hors limites" "port out of range")${DP}$PORT"
fi

if ((INSTALLER_CADDY)); then
  demander DOMAIN "$(t "Nom de domaine public du hub (ex. hub.example.com)" "Public hub domain name (e.g. hub.example.com)")" "$CADDY_DOMAINE" "$RE_DOMAINE" \
    "$(t "un nom d'hôte nu, sans http:// ni chemin, par exemple hub.example.com" "a bare hostname, without http:// or a path, for example hub.example.com")"
  DOMAIN="${DOMAIN,,}"; DOMAIN="${DOMAIN%.}"
  demander EMAIL "$(t "Adresse e-mail pour les certificats (ACME)" "E-mail address for certificates (ACME)")" "$CADDY_EMAIL" "$RE_EMAIL" "$(t "adresse e-mail invalide" "invalid e-mail address")"
  HUB_URL="https://$DOMAIN"
fi

if ((INSTALLER_HUB)); then
  if ((!INSTALLER_CADDY)); then
    if [[ -z "$HUB_URL" && -n "$DOMAIN" ]]; then HUB_URL="https://$DOMAIN"; fi
    demander HUB_URL "$(t "URL publique du hub" "Public hub URL")" "http://localhost:$PORT" "$RE_URL" "$(t "une URL du type https://hub.example.com" "a URL such as https://hub.example.com")"
    HUB_URL="${HUB_URL%/}"
    url_sure "$HUB_URL" || warn "$(t "URL publique en http:// : les machines devront s'enrôler avec --insecure, code et jetons en clair. Préférer Caddy (HTTPS)." "plain http:// public URL: machines will have to enroll with --insecure, code and tokens in clear text. Prefer Caddy (HTTPS).")"
    demander HUB_HOTE "$(t "Adresse d'écoute du hub" "Hub listen address")" "127.0.0.1"
  fi
  demander HUB_UTILISATEUR "$(t "Utilisateur système du hub" "Hub system user")" "opencode" "$RE_UTILISATEUR" "$(t "nom d'utilisateur invalide" "invalid user name")"
  if [[ -z "$SERVICE_HUB" ]]; then
    if oui_non "$(t "Installer le service systemd ${bold}opencode-hub${reset} avec démarrage automatique ?" "Install the ${bold}opencode-hub${reset} systemd service, started at boot?")"; then SERVICE_HUB=1; else SERVICE_HUB=0; fi
  fi
fi

# ------------------------------------------------------------------ Réglages du client

if ((INSTALLER_CLIENT)); then
  etape "$(t "Réglages du client" "Client settings")"
  [[ -n "$CLIENT_URL" ]] || CLIENT_URL="$HUB_URL"
  while :; do
    demander CLIENT_URL "$(t "URL du hub à rejoindre" "URL of the hub to join")" "" "$RE_URL" "$(t "une URL du type https://hub.example.com" "a URL such as https://hub.example.com")"
    CLIENT_URL="${CLIENT_URL%/}"
    url_sure "$CLIENT_URL" && break
    if ((INSECURE)); then
      warn "$(t "--insecure : le code d'enrôlement et les jetons de la machine passeront en clair vers $CLIENT_URL." "--insecure: the enrollment code and the machine's tokens will travel in clear text to $CLIENT_URL.")"
      break
    fi
    err "$(t "$CLIENT_URL est en http:// sur une autre machine : le code et les jetons passeraient en clair. Utiliser https:// (ou --insecure)." "$CLIENT_URL is plain http:// on another machine: the code and the tokens would travel in clear text. Use https:// (or --insecure).")"
    interactif || exit 1
    CLIENT_URL=""
  done
  demander CLIENT_UTILISATEUR "$(t "Utilisateur qui fait tourner l'agent" "User running the agent")" "$APPELANT" "$RE_UTILISATEUR" "$(t "nom d'utilisateur invalide" "invalid user name")"
  id "$CLIENT_UTILISATEUR" >/dev/null 2>&1 || die "$(t "l'utilisateur $CLIENT_UTILISATEUR n'existe pas." "user $CLIENT_UTILISATEUR does not exist.")"
  demander NOM_MACHINE "$(t "Nom de cette machine" "Name of this machine")" "$(hostname)"
  if [[ -z "$SERVICE_CLIENT" ]]; then
    if oui_non "$(t "Installer le service systemd ${bold}opencode-agent${reset} avec démarrage automatique ?" "Install the ${bold}opencode-agent${reset} systemd service, started at boot?")"; then SERVICE_CLIENT=1; else SERVICE_CLIENT=0; fi
  fi
fi

# ------------------------------------------------------------------ Binaire opencode

OPENCODE_BIN=""
if ((INSTALLER_HUB || INSTALLER_CLIENT)); then
  etape "$(t "Binaire opencode" "opencode binary")"
  if [[ -n "$BINARY" ]]; then
    [[ -f "$BINARY" ]] || die "$(t "--binary introuvable" "--binary not found")${DP}$BINARY"
    BINARY="$(readlink -f "$BINARY")"
  elif ((!CONSTRUIRE && !TELECHARGER)); then
    candidats=()
    for c in "$BIN_CIBLE" "$(command -v opencode 2>/dev/null || true)" "$(dossier_de "$APPELANT")/.opencode/bin/opencode"; do
      [[ -n "$c" && -x "$c" ]] || continue
      c="$(readlink -f "$c")"
      [[ " ${candidats[*]} " == *" $c "* ]] || candidats+=("$c")
    done
    # Sans dépôt ni binaire, en mode automatique : il ne reste que le téléchargement.
    if ! interactif && ((${#candidats[@]} == 0)); then
      if [[ -x "$REPO/build.sh" ]]; then CONSTRUIRE=1; else TELECHARGER=1; fi
    else
      options=()
      proposee=""
      if interactif; then proposee="$(derniere_version)"; fi
      [[ -z "$proposee" ]] || options+=("$(t "Télécharger la dernière version" "Download the latest version") ${dim}($proposee, GitHub)${reset}")
      for c in "${candidats[@]}"; do options+=("$(t "Utiliser" "Use") $c ${dim}($(version_de "$c"))${reset}"); done
      [[ -x "$REPO/build.sh" ]] && options+=("$(t "Construire depuis ce dépôt" "Build from this repository") ${dim}$(t "(./build.sh, bun requis)" "(./build.sh, bun required)")${reset}")
      options+=("$(t "Indiquer le chemin d'un binaire" "Enter the path of a binary")")
      menu "$(t "Quel binaire opencode installer ?" "Which opencode binary should be installed?")" "${options[@]}" || die "$(t "abandon." "aborted.")"
      rang=$MENU_CHOIX
      [[ -z "$proposee" ]] || rang=$((rang - 1))
      if ((rang < 0)); then
        TELECHARGER=1
        TAG="$proposee"
      elif ((rang < ${#candidats[@]})); then
        BINARY="${candidats[$rang]}"
      elif [[ -x "$REPO/build.sh" ]] && ((rang == ${#candidats[@]})); then
        CONSTRUIRE=1
      else
        demander BINARY "$(t "Chemin du binaire opencode" "Path of the opencode binary")"
        [[ -f "$BINARY" ]] || die "$(t "binaire introuvable" "binary not found")${DP}$BINARY"
        BINARY="$(readlink -f "$BINARY")"
      fi
    fi
  fi
  if ((TELECHARGER)); then
    if [[ -n "$VERSION_VOULUE" ]]; then TAG="v$VERSION_VOULUE"; fi
    [[ -n "$TAG" ]] || TAG="$(derniere_version)"
    [[ -n "$TAG" ]] || die "$(t "impossible de trouver la dernière version sur GitHub." "could not find the latest version on GitHub.")"
    ((!CONSTRUIRE)) || die "$(t "--build et --download ne vont pas ensemble." "--build and --download cannot be combined.")"
  fi
  if ((CONSTRUIRE)); then
    [[ -x "$REPO/build.sh" ]] || die "$(t "build.sh introuvable dans" "build.sh not found in") $REPO."
  fi
fi

# ------------------------------------------------------------------ Récapitulatif

SERVICE_HUB="${SERVICE_HUB:-0}"
SERVICE_CLIENT="${SERVICE_CLIENT:-0}"

oui_txt() { if [[ "$1" == 1 ]]; then printf '%s%s%s' "$green" "$(t "oui" "yes")" "$reset"; else printf '%s%s%s' "$dim" "$(t "non" "no")" "$reset"; fi; }
recap=()
if ((INSTALLER_CADDY)); then
  recap+=("${bold}Caddy${reset}   $DOMAIN $(t "et" "and") *.$DOMAIN ${dim}$S_SEP $EMAIL${reset}")
fi
if ((INSTALLER_HUB)); then
  recap+=("${bold}Hub${reset}     $HUB_URL ${dim}$S_SEP $(t "écoute" "listens on") $HUB_HOTE:$PORT $S_SEP $(t "utilisateur" "user") $HUB_UTILISATEUR${reset}")
  recap+=("        $(t "service systemd" "systemd service")${DP}$(oui_txt "$SERVICE_HUB")")
fi
if ((INSTALLER_CLIENT)); then
  recap+=("${bold}Client${reset}  $CLIENT_URL ${dim}$S_SEP machine $NOM_MACHINE $S_SEP $(t "utilisateur" "user") $CLIENT_UTILISATEUR${reset}")
  recap+=("        $(t "service systemd" "systemd service")${DP}$(oui_txt "$SERVICE_CLIENT")")
fi
if ((INSTALLER_HUB || INSTALLER_CLIENT)); then
  if ((CONSTRUIRE)); then recap+=("${bold}$(t "Binaire" "Binary")${reset} $(t "construit depuis $REPO, installé dans $BIN_CIBLE" "built from $REPO, installed to $BIN_CIBLE")")
  elif ((TELECHARGER)); then recap+=("${bold}$(t "Binaire" "Binary")${reset} $TAG ${dim}$(t "(GitHub), installé dans" "(GitHub), installed to") $BIN_CIBLE${reset}")
  else recap+=("${bold}$(t "Binaire" "Binary")${reset} $BINARY"); fi
fi
echo
cadre "$gris" "$(t "Récapitulatif" "Summary")" "${recap[@]}"
oui_non "$(t "Lancer l'installation ?" "Start the installation?")" || die "$(t "abandon : rien n'a été modifié." "aborted: nothing was changed.")"

# ================================================================== Installation

# ------------------------------------------------------------------ Outils de base

if ((INSTALLER_CADDY || INSTALLER_HUB)) && command -v apt-get >/dev/null; then
  manque=0
  for outil in curl gpg openssl; do command -v "$outil" >/dev/null || manque=1; done
  if ((manque)); then
    etape "$(t "Outils de base" "Base tools")"
    suivre "$(t "Installation de curl, gnupg et openssl" "Installing curl, gnupg and openssl")" apt_installer curl gnupg openssl ca-certificates
  fi
fi

# ------------------------------------------------------------------ Binaire

if ((INSTALLER_HUB || INSTALLER_CLIENT)); then
  etape "$(t "Binaire opencode" "opencode binary")"
  if ((CONSTRUIRE)); then
    construire() {
      en_tant_que "$APPELANT" env ${OPENCODE_BUILD_TIMEOUT:+OPENCODE_BUILD_TIMEOUT="$OPENCODE_BUILD_TIMEOUT"} \
        ${OPENCODE_BROTLI_QUALITY:+OPENCODE_BROTLI_QUALITY="$OPENCODE_BROTLI_QUALITY"} \
        bash -c 'cd "$1" && ./build.sh --skip-tests' _ "$REPO"
    }
    suivre "$(t "Construction d'opencode (./build.sh)" "Building opencode (./build.sh)")" construire
    BINARY="$(ls -t "$REPO"/packages/cli/dist/*/bin/opencode 2>/dev/null | head -n1 || true)"
    [[ -n "$BINARY" ]] || die "$(t "binaire introuvable après la construction" "binary not found after the build") (packages/cli/dist/*/bin/opencode)."
  fi
  if ((TELECHARGER)); then
    command -v curl >/dev/null || die "$(t "curl est nécessaire pour télécharger le binaire." "curl is required to download the binary.")"
    DOSSIER_DL="$(mktemp -d /tmp/opencode-hub-download.XXXXXX)"
    suivre "$(t "Téléchargement d'opencode" "Downloading opencode") $TAG" telecharger_binaire ||
      die "$(t "téléchargement impossible." "download failed.")"
    BINARY="$DOSSIER_DL/opencode"
  fi
  if [[ "$BINARY" != "$BIN_CIBLE" ]]; then
    install -m 0755 "$BINARY" "$BIN_CIBLE.new"
    mv -f "$BIN_CIBLE.new" "$BIN_CIBLE"
    ok "$(t "Binaire installé" "Binary installed")${DP}$BIN_CIBLE"
  else
    ok "$(t "Binaire déjà en place" "Binary already in place")${DP}$BIN_CIBLE"
  fi
  OPENCODE_BIN="$BIN_CIBLE"
  info "Version${DP}$(version_de "$OPENCODE_BIN")"
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
    warn "$(t "adresse IPv4 publique inconnue : vérification DNS ignorée." "public IPv4 address unknown: skipping the DNS check.")"
    return
  fi
  info "$(t "IPv4 publique" "Public IPv4")${DP}$ip"
  for hote in "$DOMAIN" "dnscheck-$(openssl rand -hex 4).$DOMAIN"; do
    resolu="$({ getent ahostsv4 "$hote" 2>/dev/null || true; } | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
    if [[ -z "$resolu" ]]; then
      if [[ "$hote" == "$DOMAIN" ]]; then warn "$(t "$DOMAIN ne se résout pas : ajouter un enregistrement A $DOMAIN → $ip" "$DOMAIN does not resolve: add an A record $DOMAIN → $ip")"
      else warn "$(t "*.$DOMAIN ne se résout pas : ajouter un enregistrement A *.$DOMAIN → $ip" "*.$DOMAIN does not resolve: add an A record *.$DOMAIN → $ip")"; fi
    elif ! grep -qwF -- "$ip" <<<"$resolu"; then
      warn "$(t "$hote pointe vers $resolu, pas vers ce serveur ($ip) : les certificats échoueront." "$hote points to $resolu, not to this server ($ip): certificates will fail.")"
    else
      ok "DNS${DP}$hote → $ip"
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
    ok "$(t "Caddy déjà installé" "Caddy already installed") ${dim}($(caddy version | head -n1))${reset}"
  else
    suivre "$(t "Installation de Caddy (dépôt apt officiel)" "Installing Caddy (official apt repository)")" installer_caddy
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
    die "$(t "le Caddyfile produit est invalide." "the generated Caddyfile is invalid.")"
  fi
  mkdir -p /etc/caddy
  if [[ -f "$CADDYFILE" ]] && cmp -s "$nouveau" "$CADDYFILE"; then
    ok "$(t "Caddyfile inchangé" "Caddyfile unchanged")"
  else
    if [[ -f "$CADDYFILE" ]]; then
      sauvegarde="$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
      cp -p "$CADDYFILE" "$sauvegarde"
      info "$(t "Ancien Caddyfile sauvegardé" "Previous Caddyfile backed up")${DP}$sauvegarde"
    fi
    install -m 0644 "$nouveau" "$CADDYFILE"
    ok "$(t "Caddyfile écrit" "Caddyfile written")${DP}$CADDYFILE"
  fi
  rm -f "$nouveau"

  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ok "$(t "Ports 80 et 443 ouverts dans ufw" "Ports 80 and 443 opened in ufw")"
  fi

  systemctl enable caddy >/dev/null 2>&1
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy || systemctl restart caddy
  else
    systemctl restart caddy
  fi
  ok "$(t "Caddy démarré, démarrage automatique activé" "Caddy started, start at boot enabled")"
fi

# ------------------------------------------------------------------ Hub

# inviter_admin — crée une invitation administrateur sous l'utilisateur du hub, avec l'environnement de son service.
inviter_admin() {
  runuser -u "$HUB_UTILISATEUR" -- env HOME="$DATA_DIR" XDG_DATA_HOME="$DATA_DIR/.local/share" \
    XDG_CONFIG_HOME="$DATA_DIR/.config" XDG_CACHE_HOME="$DATA_DIR/.cache" XDG_STATE_HOME="$DATA_DIR/.local/state" \
    "$OPENCODE_BIN" hub invite --admin --data "$DATA_DIR"
}

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
      ok "$(t "Utilisateur $HUB_UTILISATEUR déjà présent" "User $HUB_UTILISATEUR already exists")"
    else
      useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$HUB_UTILISATEUR"
      ok "$(t "Utilisateur système créé" "System user created")${DP}$HUB_UTILISATEUR"
    fi
    # Comptes, enregistrements OPAQUE et clé du serveur : lisibles par l'utilisateur du hub seul.
    install -d -m 0700 -o "$HUB_UTILISATEUR" -g "$HUB_UTILISATEUR" "$DATA_DIR"
    runuser -u "$HUB_UTILISATEUR" -- test -x "$OPENCODE_BIN" || die "$(t "$HUB_UTILISATEUR ne peut pas exécuter $OPENCODE_BIN." "$HUB_UTILISATEUR cannot execute $OPENCODE_BIN.")"
    # Sans base, le hub n'a encore aucun compte : une invitation administrateur suivra son démarrage.
    premiere_installation=0
    [[ -f "$DATA_DIR/hub.db" ]] || premiere_installation=1
    if [[ -f "$ANCIEN_ENV_FILE" ]]; then
      rm -f "$ANCIEN_ENV_FILE"
      ok "$(t "Ancien mot de passe du hub retiré ($ANCIEN_ENV_FILE) : les comptes le remplacent" "Old hub password removed ($ANCIEN_ENV_FILE): accounts replace it")"
    fi

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
    ok "$(t "Service écrit" "Service written")${DP}$UNIT_HUB"
    systemctl daemon-reload
    systemctl enable opencode-hub >/dev/null 2>&1
    systemctl restart opencode-hub
    hub_pret=0
    if suivre "$(t "Démarrage du hub" "Starting the hub")" attendre_hub; then
      ok "$(t "Hub en marche, démarrage automatique activé" "Hub running, start at boot enabled")"
      hub_pret=1
    else
      warn "$(t "le hub ne répond pas encore sur 127.0.0.1:$PORT" "the hub does not answer on 127.0.0.1:$PORT yet")${DP}journalctl -u opencode-hub -e"
    fi
    # Le premier compte se crée par une invitation : à la première installation, ou sur demande quand le hub a déjà
    # ses comptes (un lien de plus ne sert qu'à un administrateur qui a perdu l'accès).
    if ((hub_pret)) && { ((premiere_installation)) || oui_non "$(t "Créer une invitation administrateur ?" "Create an administrator invitation?")" n; }; then
      if sortie="$(inviter_admin 2>&1)" && lien="$(grep -oE 'https?://[^[:space:]]+/register\?invite=[^[:space:]]+' <<<"$sortie" | tail -n1)" && [[ -n "$lien" ]]; then
        echo
        cadre "$yellow" "$(t "Invitation administrateur" "Administrator invitation")" "" "${bold}$lien${reset}" "" \
          "$(t "Lien à usage unique, valable 7 jours : il crée un compte administrateur." "One-time link, valid for 7 days: it creates an administrator account.")" \
          "$(t "Affiché une seule fois ; ne le transmettre qu'à la personne concernée." "Shown only once; give it only to the person it is for.")"
      else
        warn "$(t "invitation impossible à créer" "could not create the invitation")${DP}$sortie"
      fi
    elif ((!hub_pret)); then
      info "$(t "Une fois le hub démarré, créer le premier compte avec" "Once the hub runs, create the first account with")"
      echo "  sudo -u $HUB_UTILISATEUR env HOME=$DATA_DIR $OPENCODE_BIN hub invite --admin --data $DATA_DIR"
    fi
  else
    info "$(t "Sans service : lancer le hub à la main avec" "Without a service: start the hub by hand with")"
    echo "  $OPENCODE_BIN hub --hostname $HUB_HOTE --port $PORT --url $HUB_URL"
    info "${dim}$(t "Sans compte, il affiche au premier démarrage le lien qui crée l'administrateur." "Without accounts, its first start prints the link that creates the administrator.")${reset}"
  fi
fi

# ------------------------------------------------------------------ Client

if ((INSTALLER_CLIENT)); then
  etape "Client"
  CLIENT_HOME="$(dossier_de "$CLIENT_UTILISATEUR")"
  etat="$(en_tant_que "$CLIENT_UTILISATEUR" "$OPENCODE_BIN" agent status 2>/dev/null || true)"
  enroler=1
  if grep -q '^hub ' <<<"$etat"; then
    info "$(t "Machine déjà enrôlée :" "Machine already enrolled:")"
    sed 's/^/    /' <<<"$etat"
    if [[ -z "$CODE" ]] && ! oui_non "$(t "L'enrôler de nouveau ?" "Enroll it again?")" n; then enroler=0; fi
  fi
  if ((enroler)); then
    if [[ -z "$CODE" ]]; then
      info "$(t "Code d'enrôlement : tableau de bord" "Enrollment code: dashboard") $(lien "$CLIENT_URL"), $(t "bouton" "button") ${bold}add machine${reset}."
      demander_secret CODE "$(t "Code d'enrôlement" "Enrollment code")"
    fi
    # Le code passe par l'entrée standard : il n'apparaît ni dans la liste des processus ni dans un journal.
    rejoindre() {
      local -a opts=(--name "$NOM_MACHINE")
      ((INSECURE)) && opts+=(--insecure)
      printf '%s\n' "$CODE" | en_tant_que "$CLIENT_UTILISATEUR" "$OPENCODE_BIN" agent join "$CLIENT_URL" "${opts[@]}"
    }
    suivre "$(t "Enrôlement auprès de" "Enrolling with") $CLIENT_URL" rejoindre ||
      die "$(t "enrôlement refusé : vérifier l'URL et le code (un code ne sert qu'une fois)." "enrollment refused: check the URL and the code (a code works only once).")"
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
    ok "$(t "Service écrit" "Service written")${DP}$UNIT_CLIENT"
    systemctl daemon-reload
    systemctl enable opencode-agent >/dev/null 2>&1
    systemctl restart opencode-agent
    sleep 1
    if systemctl is-active --quiet opencode-agent; then
      ok "$(t "Agent en marche, démarrage automatique activé" "Agent running, start at boot enabled")"
    else
      warn "$(t "l'agent ne tourne pas" "the agent is not running")${DP}journalctl -u opencode-agent -e"
    fi
  else
    info "$(t "Sans service : garder la machine reliée avec" "Without a service: keep the machine connected with")"
    echo "  $OPENCODE_BIN agent run"
  fi
fi

((INSTALLER_HUB || INSTALLER_CLIENT)) && signaler_autre_opencode "${CLIENT_UTILISATEUR:-$APPELANT}"

# ================================================================== Résumé

fin=()
if ((INSTALLER_HUB || INSTALLER_CADDY)); then
  [[ -n "$HUB_URL" ]] && fin+=("$(pad "$(t "Tableau de bord" "Dashboard")" 16) $(lien "$HUB_URL")")
  [[ -n "$DOMAIN" ]] && fin+=("$(pad "Machines" 16) https://<id>.$DOMAIN")
fi
((INSTALLER_HUB && SERVICE_HUB)) && fin+=("$(pad "$(t "Journal du hub" "Hub logs")" 16) ${dim}journalctl -u opencode-hub -f${reset}")
((INSTALLER_CADDY)) && fin+=("$(pad "$(t "Journal Caddy" "Caddy logs")" 16) ${dim}journalctl -u caddy -f${reset}")
((INSTALLER_CLIENT && SERVICE_CLIENT)) && fin+=("$(pad "$(t "Journal agent" "Agent logs")" 16) ${dim}journalctl -u opencode-agent -f${reset}")
((INSTALLER_HUB && SERVICE_HUB)) && fin+=("$(pad "Invitation" 16) ${dim}sudo -u $HUB_UTILISATEUR env HOME=$DATA_DIR $OPENCODE_BIN hub invite --admin --data $DATA_DIR${reset}")
# Sans dépôt, les commandes à retenir repassent par curl : trop longues pour le cadre, elles s'affichent dessous.
if [[ -z "${OPENCODE_HUB_COPIE:-}" ]]; then
  fin+=("$(pad "$(t "État" "Status")" 16) ${dim}./install.sh --status${reset}")
  if ((INSTALLER_HUB && !INSTALLER_CLIENT)); then
    fin+=("" "$(t "Relier une machine : sur celle-ci," "Connect a machine: on that machine, run")")
    fin+=("  ${dim}sudo ./install.sh --client --client-url ${HUB_URL:-<url>} --code <code>${reset}")
  fi
fi
echo
cadre "$green" "$(t "Installation terminée" "Installation complete")" "${fin[@]}"
echo
if [[ -n "${OPENCODE_HUB_COPIE:-}" ]]; then
  info "$(t "Mettre à jour ou relier une machine : relancer la même commande" "Update or connect a machine: run the same command again")"
  echo "  curl -fsSL $SCRIPT_URL | bash"
  info "$(t "État et désinstallation : ajouter" "Status and uninstall: add")"
  echo "  | bash -s -- --status    | bash -s -- --uninstall"
  echo
fi
