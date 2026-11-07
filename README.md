<h1 align="center">opencode-hub</h1>

<p align="center">
  <a href="README.md">Français</a> |
  <a href="README.en.md">English</a>
</p>

<p align="center">
  Un fork d'<a href="https://github.com/anomalyco/opencode">OpenCode</a> qui ajoute un <strong>hub</strong> :
  une instance publique, sur un VPS, depuis laquelle on pilote des sessions de code sur plusieurs machines distantes.
</p>

<p align="center">
  <img src="docs/hub/dashboard.png" alt="Tableau de bord du hub : machines connectées et fournisseurs LLM" width="860">
</p>

> [!IMPORTANT]
> **Projet indépendant.** opencode-hub n'est pas développé par l'équipe d'OpenCode et n'a aucun lien avec elle. Il est
> maintenu séparément ; pour toute question ou tout problème lié au hub, s'adresser à ce dépôt, pas au projet OpenCode.

> [!WARNING]
> **Projet en cours de développement.** Le hub fonctionne de bout en bout en local, mais n'a pas encore été éprouvé en
> production. Les interfaces, le protocole et le format des données peuvent encore changer.

## Pourquoi

OpenCode tourne sur la machine où se trouve le code. Ce fork permet d'installer une instance principale sur un serveur
accessible depuis Internet et d'y rattacher autant de machines qu'on veut (poste de travail, serveur de build, machine
de calcul…), même derrière un NAT, sans ouvrir aucun port sur elles. Depuis le navigateur, on choisit une machine, puis
un dossier, et on travaille comme si on était devant.

## Fonctionnalités

- **Hub sécurisé** : comptes créés sur invitation, connexion OPAQUE (le mot de passe ne quitte jamais le navigateur),
  HTTPS automatique (Let's Encrypt via Caddy), une session par navigateur.
- **Machines distantes** : chaque machine lance `opencode agent run`, qui garde un tunnel WebSocket sortant vers le hub
  (heartbeat, reconnexion automatique). Aucun port à ouvrir, NAT et pare-feu ne posent pas de problème.
- **Interface complète de chaque machine** : `https://<machine>.hub.exemple.fr` affiche l'interface web d'OpenCode de
  la machine elle-même, à travers le tunnel (sessions, fichiers, terminal, diffs, flux en direct).
- **Enrôlement simple** : un code à usage unique généré depuis le hub, une commande à lancer sur la machine.
  Chaque machine reçoit son propre jeton, révocable à tout moment.
- **Proxy LLM** : les clés des fournisseurs restent sur le hub. Les machines n'ont qu'un jeton propre au hub, qui
  remplace la vraie clé au passage. Changer une clé ne demande aucune action sur les machines.
- **Relais MCP** : les connecteurs MCP distants de chaque utilisateur (en-têtes secrets ou connexion OAuth gérée par le
  hub) sont chiffrés sur le hub ; les machines les joignent par `<hub>/mcp/<id>` avec le même jeton, et le hub ajoute
  les secrets au passage. Ils apparaissent sur les machines comme les serveurs MCP `hub-<id>`.
- **Instances Cloud** : un administrateur lie des serveurs LXD (agent Rust
  [`agent-hub-lxd`](https://github.com/h082-orion/agent-hub-lxd), connexion sortante comme les machines). Chaque
  utilisateur y crée des VM avec opencode déjà installé, qui deviennent ses machines. Le hub affiche la capacité des
  serveurs et l'usage de chaque instance *(expérimental, voir [`specs/cloud.md`](specs/cloud.md))*.
- **Catalogue de fournisseurs** : plus de 200 fournisseurs issus du catalogue d'OpenCode, groupés par entreprise, avec
  l'URL de l'API déjà renseignée. Il ne reste qu'à coller la clé.
- **Abonnement ChatGPT** : connexion « Sign in with ChatGPT » sur le hub, jeton renouvelé automatiquement *(non testé
  contre le vrai service OpenAI pour l'instant)*.

<p align="center">
  <img src="docs/hub/add-machine.png" alt="Ajout d'une machine avec un code à usage unique" width="49%">
  <img src="docs/hub/providers.png" alt="Choix d'un fournisseur dans le catalogue" width="49%">
</p>

## Architecture

```
navigateur ──https──> Caddy ──> opencode hub (127.0.0.1:4800)
                                  ├─ hub.exemple.fr            tableau de bord, connexion, enrôlement, proxy LLM et MCP
                                  └─ <machine>.hub.exemple.fr  proxy vers la machine
                                            ▲
                         tunnel WebSocket sortant (initié par la machine)
                                            │
            machine : opencode agent ──> service opencode local (127.0.0.1)
```

Chaque machine fait tourner un serveur OpenCode complet : Git, terminal, fichiers et outils s'exécutent localement.
Le hub se contente d'authentifier, de router et de relayer. Le cœur d'OpenCode n'est pas modifié. Le détail du
protocole est dans [`specs/remote-machines.md`](specs/remote-machines.md).

## Essayer en local

Prérequis : [Bun](https://bun.sh) (version indiquée dans `package.json`).

```bash
./build.sh                    # dépendances, tests, interface web et binaire pour cette machine
BIN=packages/cli/dist/cli-linux-x64/bin/opencode

$BIN hub                      # http://localhost:4800 ; sans compte, affiche le lien qui crée l'administrateur
# Dans le tableau de bord : « Add machine », puis sur la machine :
$BIN agent join http://localhost:4800      # demande le code sans l'afficher
$BIN agent run
# La machine est accessible sur http://<machine>.localhost:4800
```

Depuis les sources sans binaire : `./build.sh --ui-only`, puis `bun run dev hub` et `bun run dev agent run`.

## Installer

`install.sh`, à la racine du dépôt, installe et met en place les trois composants. Au lancement, un menu propose la
langue (français ou anglais), puis les composants à cocher :

- **Caddy** : proxy HTTPS devant le hub, certificats à la demande pour le hub et pour chaque machine ;
- **Hub** : le tableau de bord ;
- **Client** : l'agent qui relie la machine à un hub.

Le hub et le client peuvent être installés en service systemd avec démarrage automatique.

1. Faire pointer `hub.exemple.fr` **et** `*.hub.exemple.fr` vers le VPS (enregistrements A/AAAA).
2. Sur le VPS, depuis ce dépôt :

   ```bash
   sudo ./install.sh                  # menu : langue, composants, réglages
   ```

   Le binaire est pris sur la machine, construit depuis le dépôt (`./build.sh`) ou indiqué par un chemin. Pour un
   serveur d'une autre architecture : `./build.sh --target linux-x64` (ou `linux-arm64`), puis `--binary <chemin>`.
3. Sur chaque machine à relier, après avoir créé un code dans le tableau de bord (« Add machine ») :

   ```bash
   sudo ./install.sh --client --client-url https://hub.exemple.fr --code XXXX-XXXX --service
   ```

| Commande | Rôle |
|---|---|
| `./install.sh --status` | État de Caddy, du hub, de l'agent et du binaire |
| `sudo ./install.sh --uninstall [--purge]` | Désinstallation ; `--purge` efface aussi les données, l'enrôlement, Caddy et le binaire |
| `./install.sh --help` | Toutes les options, pour une installation sans questions (`--yes`) |
| `--lang fr\|en` | Fixe la langue sans passer par le menu (`build.sh` l'accepte aussi) |

Détails sur Caddy, le DNS et le dépannage : [`script/hub/README.md`](script/hub/README.md).

## Commandes

| Commande | Rôle |
|---|---|
| `opencode hub [--port 4800] [--url https://hub.exemple.fr] [--data <dossier>] [--mcp-private-network]` | Lance le hub (`--mcp-private-network` : connecteurs MCP autorisés vers les adresses privées et de boucle locale) |
| `opencode hub invite [--admin] [--data <dossier>]` | Crée une invitation à usage unique et affiche son lien (`--admin` pour un administrateur) |
| `opencode agent join <url> [--code <code>] [--name <nom>] [--insecure]` | Enrôle cette machine (sans `--code`, le code est demandé sans affichage ou lu sur l'entrée standard) |
| `opencode agent run` | Maintient la machine connectée au hub |
| `opencode agent status` / `opencode agent leave` | État de l'enrôlement / désenrôlement |

<img src="docs/hub/provider-variants-phone.png" alt="Variantes d'un fournisseur sur téléphone" width="260" align="right">

## Sécurité de l'enrôlement

Le code d'enrôlement, puis les jetons que le hub renvoie à la machine, ne passent qu'en HTTPS : `opencode agent join`
et `install.sh` refusent une URL en `http://` vers une autre machine (seuls `localhost`, `*.localhost`, `127.x.x.x` et
`::1` restent permis en HTTP, pour les essais locaux). Ils refusent aussi un hub qui annonce une URL publique en
`http://`, car le tunnel y enverrait le jeton de la machine en clair. `--insecure` lève ces deux refus, en connaissance
de cause. Sans `--code`, le code n'apparaît ni dans la liste des processus ni dans l'historique du shell.

## Limites connues

- Un seul utilisateur par hub.
- Une machine hors ligne n'est pas accessible : ses sessions vivent sur la machine.
- Pas de contrôle de flux dans le tunnel (protocole v1).
- Les sessions de connexion au hub sont en mémoire : redémarrer le hub déconnecte le navigateur.
- Les abonnements Anthropic ne peuvent pas passer par le hub : OpenCode ne les utilise qu'à travers la CLI `claude`
  installée sur chaque machine.
- Si une machine a déjà une clé enregistrée pour un fournisseur proposé par le hub, c'est cette clé locale qui est
  utilisée.

## Organisation du code

| Chemin | Contenu |
|---|---|
| `packages/relay` | Hub, protocole du tunnel, agent, proxy LLM, relais MCP, catalogue, connexion ChatGPT |
| `packages/app/hub.html`, `packages/app/src/hub` | Interface du hub (composants `@opencode/ui`) |
| `packages/cli/src/commands/handlers/{hub,agent}` | Commandes `opencode hub` et `opencode agent` |
| `install.sh` | Installation, état et désinstallation (Caddy, hub, client, services systemd) |
| `script/hub` | Ancien installateur du VPS (Caddy + hub), documentation du déploiement |
| `specs/remote-machines.md` | Spécification |
| `build.sh` | Build complet |

## OpenCode

Tout le reste est [OpenCode](https://github.com/anomalyco/opencode), développé par son équipe. opencode-hub n'est pas
développé par l'équipe d'OpenCode et n'est affilié à elle d'aucune manière. Le README d'origine est
conservé dans [`README.opencode.md`](README.opencode.md). Ce fork suit la branche `dev` de l'amont ; le hub est
développé sur la branche `remote-machines`.

Licence : MIT, comme OpenCode ([`LICENSE`](LICENSE)).

## Remerciements

Un grand merci à l'équipe d'[OpenCode](https://github.com/anomalyco/opencode), et toutes nos félicitations pour son
excellent travail. opencode-hub n'existerait pas sans elle : le serveur, l'interface web, le terminal, le catalogue des
fournisseurs, tout ce que le hub rend accessible à distance, c'est OpenCode. Merci aussi de l'avoir publié en logiciel
libre, ce qui permet à des projets comme celui-ci de construire par-dessus.
