# Instances Cloud

Les utilisateurs du hub créent des **instances Cloud** : des VM LXD prêtes à l'emploi, avec opencode déjà installé,
qui deviennent leurs machines sans rien installer eux-mêmes.

Statut : **implémentée** côté hub. L'agent des serveurs LXD est un projet Rust séparé,
[`agent-hub-lxd`](https://github.com/h082-orion/agent-hub-lxd), dont `docs/protocol.md` décrit le protocole hôte que
le hub parle (version 1).

## Rôles

- **Serveur Cloud (hôte)** : un serveur Ubuntu avec LXD et `agent-hub-lxd`. Comme une machine, il garde une connexion
  WebSocket sortante vers le hub, donc il peut être derrière un NAT. Il ne sert pas de sessions : il crée des VM.
- **Instance Cloud** : la VM `hub-<id>` d'un utilisateur sur un serveur Cloud. Une fois appairée, elle est une
  **machine personnelle** de cet utilisateur, nommée comme l'instance, avec le protocole machine habituel
  (`specs/remote-machines.md`).

## Parcours

1. Un **administrateur** lie un serveur : « Cloud servers » → « Link server » crée un code d'hôte à usage unique (10
   minutes). Sur le serveur, `agent-hub-lxd join <url du hub>` l'échange contre un jeton d'hôte.
2. L'agent se connecte (`/hub/host/connect`) et annonce sa capacité. Tout utilisateur voit alors la section « Cloud
   instances », avec la place restante sur chaque serveur connecté.
3. Un utilisateur crée une instance (nom, CPU, mémoire, disque). Le hub enregistre l'instance (`creating`), crée un
   **code machine lié à l'instance** (30 minutes) et envoie `create` au serveur.
4. L'agent clone la VM modèle, la démarre et y lance `hub-pair` avec le code. La VM exécute
   `opencode agent join` : le hub reconnaît le code de l'instance, crée la machine de l'utilisateur et la lie à
   l'instance.
5. L'agent répond `result` : l'instance passe `running`. Le bouton « Open » ouvre sa machine.
6. Démarrer, arrêter et supprimer passent par le serveur. Supprimer une instance supprime sa VM, puis révoque sa
   machine.

## Règles

- **Codes** : un code a un type. Un code machine n'enrôle pas un hôte, et un code d'hôte n'enrôle pas une machine.
  Seul un administrateur actif crée un code d'hôte, et il doit l'être encore à l'enrôlement. Un code d'instance ne sert
  qu'une fois, pour une instance qui existe encore, appartient à son auteur et n'a pas encore de machine.
- **Droits** : tout utilisateur actif crée des instances. Il ne voit et ne gère que les siennes ; un administrateur
  les voit toutes, avec le détail des serveurs (capacité, charge, versions), et peut les arrêter ou les supprimer, sans
  pouvoir les ouvrir. Les utilisateurs ne voient d'un serveur que son nom, son état et le maximum qu'une nouvelle
  instance peut y obtenir.
- **Capacité** : le hub refuse une demande au-delà de ce que le serveur a annoncé (maximum par instance, place
  restante, nombre d'instances). Le serveur vérifie de nouveau et a le dernier mot.
- **Une opération à la fois** par instance : une instance `creating`, `starting`, `stopping` ou `deleting` attend la
  réponse du serveur.
- **Machine d'une instance** : elle ne se révoque pas seule (409) ; elle part avec son instance.
- **Serveur** : un administrateur le révoque seulement s'il n'a plus d'instance (409 sinon). Son jeton est supprimé et
  sa connexion fermée avec le code 4401 : l'agent s'arrête sans redémarrer.
- **Reconnexion** : une réponse perdue avec la connexion est réglée au `hello` suivant. Une instance listée par le
  serveur prend son état. Une instance non listée devient `failed` si elle était en création, disparaît si elle était
  en suppression, et devient `missing` sinon. Le hub ne touche pas aux VM qu'il ne connaît pas.
- **Échec** : une création qui échoue laisse l'instance `failed` avec le message du serveur (qui a supprimé la VM).
  Elle se supprime même serveur déconnecté.

## API

Sous `/hub/api/`, mêmes règles que le reste (cookie de session, `Origin` et JSON pour les mutations) :

- `GET cloud` : `{ hosts, instances, admin }`. Le même contenu arrive en direct dans l'événement SSE `cloud` de
  `events`, à chaque changement et à chaque envoi de métriques.
- `POST cloud/instances` `{ host, name, cpu, memory_mib, disk_gib }` → `202 { instance }`.
- `POST cloud/instances/<id>/start`, `POST cloud/instances/<id>/stop` → `202`. `DELETE cloud/instances/<id>` → `202`,
  ou `204` pour une instance `failed` dont le serveur est déconnecté.
- Administrateurs : `POST cloud/hosts/code` → `{ code, expiresAt, command }`, `DELETE cloud/hosts/<id>`.

Hors `/hub/api/` : `POST /hub/host/enroll` `{ code, name }` → `{ host: { id, name }, token, url }` (limité comme
l'enrôlement des machines), et `GET /hub/host/connect`, montée WebSocket avec `Authorization: Bearer <token>`.

## Stockage

- `cloud_host` : id, name, token_hash (SHA-256 du jeton), created_by, created_at, last_seen_at.
- `cloud_instance` : id (12 caractères `a-z0-9`, la VM est `hub-<id>`), host_id, user_id, name, cpu, memory_mib,
  disk_gib, status, error, machine_id, created_at, updated_at.

La capacité et les métriques des serveurs ne sont gardées qu'en mémoire, le temps de la connexion. Le pourcentage CPU
d'une instance est calculé par le hub entre deux échantillons, sur le nombre de CPU de l'instance.

## Limites

- Pas de quota par utilisateur : seule la capacité des serveurs limite les créations.
- Un utilisateur désactivé garde ses instances. Ses machines n'ouvrent plus ; un administrateur supprime les instances.
- Le hub choisit le serveur indiqué par l'utilisateur ; il ne répartit pas la charge.
