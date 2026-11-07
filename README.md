<h1 align="center">opencode-hub</h1>

<p align="center">
  Un fork d'<a href="https://github.com/anomalyco/opencode">OpenCode</a> qui ajoute un <strong>hub</strong> :
  une instance publique, sur un VPS, depuis laquelle on pilote des sessions de code sur plusieurs machines distantes.
</p>

<p align="center">
  <img src="docs/hub/dashboard.png" alt="Tableau de bord du hub : machines connectées et fournisseurs LLM" width="860">
</p>

> [!WARNING]
> **Projet en cours de développement.** Le hub fonctionne de bout en bout en local, mais n'a pas encore été éprouvé en
> production. Les interfaces, le protocole et le format des données peuvent encore changer.

## Pourquoi

OpenCode tourne sur la machine où se trouve le code. Ce fork permet d'installer une instance principale sur un serveur
accessible depuis Internet et d'y rattacher autant de machines qu'on veut (poste de travail, serveur de build, machine
de calcul…), même derrière un NAT, sans ouvrir aucun port sur elles. Depuis le navigateur, on choisit une machine, puis
un dossier, et on travaille comme si on était devant.

## Fonctionnalités

- **Hub sécurisé** : connexion par mot de passe, HTTPS automatique (Let's Encrypt via Caddy), une session par navigateur.
- **Machines distantes** : chaque machine lance `opencode agent run`, qui garde un tunnel WebSocket sortant vers le hub
  (heartbeat, reconnexion automatique). Aucun port à ouvrir, NAT et pare-feu ne posent pas de problème.
- **Interface complète de chaque machine** : `https://<machine>.hub.exemple.fr` affiche l'interface web d'OpenCode de
  la machine elle-même, à travers le tunnel (sessions, fichiers, terminal, diffs, flux en direct).
- **Enrôlement simple** : un code à usage unique généré depuis le hub, une commande à lancer sur la machine.
  Chaque machine reçoit son propre jeton, révocable à tout moment.
- **Proxy LLM** : les clés des fournisseurs restent sur le hub. Les machines n'ont qu'un jeton propre au hub, qui
  remplace la vraie clé au passage. Changer une clé ne demande aucune action sur les machines.
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
                                  ├─ hub.exemple.fr            tableau de bord, connexion, enrôlement, proxy LLM
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

$BIN hub                      # http://localhost:4800, le mot de passe s'affiche une fois
# Dans le tableau de bord : « Add machine », puis sur la machine :
$BIN agent join http://localhost:4800 --code XXXX-XXXX
$BIN agent run
# La machine est accessible sur http://<machine>.localhost:4800
```

Depuis les sources sans binaire : `./build.sh --ui-only`, puis `bun run dev hub` et `bun run dev agent run`.

## Déployer sur un VPS

1. Faire pointer `hub.exemple.fr` **et** `*.hub.exemple.fr` vers le VPS (enregistrements A/AAAA).
2. Construire le binaire pour le serveur : `./build.sh --target linux-x64` (ou `linux-arm64`).
3. Sur le VPS :

   ```bash
   sudo script/hub/install.sh --domain hub.exemple.fr --email vous@exemple.fr --binary ./opencode
   ```

   Le script installe Caddy (certificats à la demande, pour chaque machine), un service systemd `opencode-hub`, et
   affiche le mot de passe généré. Détails, mise à jour et démarrage automatique des agents :
   [`script/hub/README.md`](script/hub/README.md).

## Commandes

| Commande | Rôle |
|---|---|
| `opencode hub [--port 4800] [--url https://hub.exemple.fr] [--data <dossier>]` | Lance le hub |
| `opencode hub password` | Réinitialise le mot de passe du hub |
| `opencode agent join <url> --code <code> [--name <nom>]` | Enrôle cette machine |
| `opencode agent run` | Maintient la machine connectée au hub |
| `opencode agent status` / `opencode agent leave` | État de l'enrôlement / désenrôlement |

<img src="docs/hub/provider-variants-phone.png" alt="Variantes d'un fournisseur sur téléphone" width="260" align="right">

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
| `packages/relay` | Hub, protocole du tunnel, agent, proxy LLM, catalogue, connexion ChatGPT |
| `packages/app/hub.html`, `packages/app/src/hub` | Interface du hub (composants `@opencode/ui`) |
| `packages/cli/src/commands/handlers/{hub,agent}` | Commandes `opencode hub` et `opencode agent` |
| `script/hub` | Installation Caddy + systemd sur le VPS |
| `specs/remote-machines.md` | Spécification |
| `build.sh` | Build complet |

## OpenCode

Tout le reste est [OpenCode](https://github.com/anomalyco/opencode), développé par son équipe. Le README d'origine est
conservé dans [`README.opencode.md`](README.opencode.md). Ce fork suit la branche `dev` de l'amont ; le hub est
développé sur la branche `remote-machines`.

Licence : MIT, comme OpenCode ([`LICENSE`](LICENSE)).
