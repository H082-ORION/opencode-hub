# Hub multi-utilisateurs

Spécification de l'évolution du hub (`specs/remote-machines.md`) vers plusieurs utilisateurs, des organisations, des clés
d'API chiffrées par utilisateur, et des skills et connecteurs MCP propres à chacun. Elle remplace la section « Out of
scope » de la spec d'origine pour ce qui concerne les utilisateurs.

Statut : **à implémenter**, par étapes (dernière section). Le hub n'est pas encore en production : aucune
compatibilité n'est due avec le mot de passe unique, le protocole 1 du tunnel ni les bases existantes, sauf ce que la
section « Passage depuis la version actuelle » prévoit.

## Décisions

Prises par le porteur du projet le 2026-11-07 :

1. **Comptes** : plusieurs utilisateurs, créés uniquement par **code d'invitation**, avec identifiant et mot de passe,
   authentifiés par **OPAQUE**. Le mot de passe unique du hub disparaît.
2. **Administration** : seul un **administrateur du hub** crée les invitations, les organisations, et gère leurs
   membres et leurs skills.
3. **Machines** : un utilisateur enrôle une machine **pour lui seul** ou **pour une organisation** dont il est membre.
   Tous les membres d'une organisation peuvent utiliser ses machines, chacun avec **sa propre instance** d'opencode.
4. **Isolation** : les instances d'une même machine tournent sous **le même compte système**. Les membres d'une
   organisation se font confiance sur ses machines (voir « Limites »).
5. **Clés d'API** : chaque utilisateur saisit les siennes. Elles sont **chiffrées sur disque** par une clé propre à
   l'utilisateur, que le hub ne garde **qu'en mémoire**, après une connexion de l'utilisateur, tant qu'il tourne
   (compromis détaillé dans « Chiffrement »).
6. **Connecteurs MCP** : même système que les LLM. Les secrets restent sur le hub, chiffrés, et les instances passent
   par un relais du hub qui les injecte.
7. **Skills** : définis par l'utilisateur, ou au niveau d'une organisation ; les membres héritent des skills de leurs
   organisations.

## Rôles et droits

| Action                                               | Administrateur             | Membre de l'organisation   | Utilisateur                |
| ---------------------------------------------------- | -------------------------- | -------------------------- | -------------------------- |
| Créer une invitation (nouvel utilisateur)            | oui                        | non                        | non                        |
| Désactiver un compte, réinitialiser son mot de passe | oui                        | non                        | non                        |
| Créer, renommer, supprimer une organisation          | oui                        | non                        | non                        |
| Ajouter ou retirer un membre d'une organisation      | oui                        | non                        | non                        |
| Gérer les skills d'une organisation                  | oui                        | non (lecture)              | non                        |
| Enrôler une machine pour soi                         | oui                        | oui                        | oui                        |
| Enrôler une machine pour une organisation            | s'il en est membre         | oui                        | non                        |
| Ouvrir une machine personnelle                       | son propriétaire seulement | son propriétaire seulement | son propriétaire seulement |
| Ouvrir une machine d'organisation                    | s'il en est membre         | oui                        | non                        |
| Révoquer une machine                                 | toutes                     | celles qu'il a enrôlées    | les siennes                |
| Gérer ses clés d'API, skills, connecteurs            | oui                        | oui                        | oui                        |

- Un administrateur est un utilisateur comme les autres : il n'ouvre pas les machines personnelles des autres et ne
  voit pas leurs clés. Il peut révoquer une machine (perte, départ) et désactiver un compte.
- Il y a toujours au moins un administrateur actif : le hub refuse de retirer ce rôle ou de désactiver le dernier.
- Tous les contrôles d'accès sont **fail-closed** : une erreur de lecture, un utilisateur introuvable ou désactivé, une
  appartenance absente valent refus.

## Comptes

### Identifiant

`login` : 3 à 32 caractères `[a-z0-9._-]`, en minuscules après normalisation (NFKC puis minuscules), unique. Il n'est
jamais réutilisé tant que le compte existe, même désactivé.

### Invitation

- Créée par un administrateur depuis le tableau de bord, ou par `opencode hub invite [--admin] [--data <dossier>]`
  (pour créer le premier compte).
- Contenu : rôle (`admin` ou `user`), organisations à rejoindre (facultatif), expiration (7 jours par défaut, 30 au
  plus), auteur.
- Le code est un jeton de 32 octets aléatoires en base64url, stocké haché (SHA-256), à usage unique. Le hub affiche
  une fois le lien `https://<hub>/register?invite=<code>`.
- Une invitation se révoque tant qu'elle n'a pas servi. Elle est consommée dans la même transaction que la création du
  compte.

### Inscription et connexion (OPAQUE)

Bibliothèque : `@serenity-kit/opaque` (MIT, opaque-ke compilé en WebAssembly, utilisable dans le navigateur et dans
Bun). La fonction de dérivation (KSF) est Argon2id ; ses paramètres sont à vérifier dans la bibliothèque et à fixer
au plus près de 64 Mio et 3 passes.

- **Clé du serveur OPAQUE** (`serverSetup`) : générée au premier démarrage, stockée dans `<data>/opaque-server-setup`
  (droits `0600`), **hors de la base** : une copie de `hub.db` seule ne permet pas d'attaque hors ligne sur les mots de
  passe.
- **Inscription** (page `/register?invite=`) :
  1. `POST /hub/api/register/start { invite, login, registrationRequest }` → `{ registrationResponse }`. L'invitation
     et le `login` sont vérifiés ici (invitation valide, login libre).
  2. `POST /hub/api/register/finish { invite, login, registrationRecord, userKey: { wrapped, check } }` → crée le
     compte, consomme l'invitation, ouvre une session.
- **Connexion** (page `/login`) :
  1. `POST /hub/api/login/start { login, startLoginRequest }` → `{ attempt, loginResponse, wrappedUserKey }`. L'état
     du serveur est gardé en mémoire 60 s sous `attempt`. Pour un login inconnu, le hub répond avec un enregistrement
     factice indiscernable (pas d'énumération des comptes) et une clé enveloppée factice.
  2. `POST /hub/api/login/finish { attempt, finishLoginRequest, userKey }` → session. `userKey` est la clé de
     l'utilisateur déchiffrée par le navigateur (voir « Chiffrement ») ; le hub la vérifie et la garde en mémoire.
- **Limites** : délai exponentiel par adresse IP (comme aujourd'hui) **et** par compte ; 5 échecs consécutifs sur un
  compte imposent 15 minutes d'attente. Réponses d'erreur uniformes.
- **Changement de mot de passe** : nouvelle inscription OPAQUE depuis la session ouverte ; la clé de l'utilisateur est
  ré-enveloppée avec la nouvelle clé d'export, les données chiffrées ne changent pas.
- **Réinitialisation** par un administrateur : il produit une invitation de réinitialisation liée au compte. La clé de
  l'utilisateur est perdue : ses clés d'API, secrets de connecteurs et jetons ChatGPT sont **supprimés** et devront être
  ressaisis. Machines, organisations et skills sont conservés.

### Sessions

- Cookie `opencode_hub` comme aujourd'hui (hôte seul, HttpOnly, SameSite=Lax, Secure en HTTPS), qui désigne désormais
  une session **d'un utilisateur**. Durée : 30 jours. Gardées en mémoire, comme aujourd'hui : un redémarrage du hub
  déconnecte tout le monde, ce qui va avec le reverrouillage des clés.
- La déconnexion ferme la session, mais ne retire pas la clé de l'utilisateur de la mémoire : ses machines continuent
  d'utiliser ses clés. Le tableau de bord propose « Verrouiller mes clés », qui la retire.
- Désactiver un compte ferme ses sessions, retire sa clé de la mémoire et coupe ses instances.

## Chiffrement

Inspiré du schéma de sauvegarde d'Astra : la clé d'export OPAQUE, que le navigateur obtient à chaque connexion et que
le serveur ne voit jamais, sert à protéger une clé propre à l'utilisateur.

- **Clé de l'utilisateur** `UK` : 32 octets aléatoires tirés par le navigateur à l'inscription.
- **Clé d'enveloppe** `KEK = HKDF-SHA256(ikm = clé d'export OPAQUE, salt = "opencode-hub/v1", info = "opencode-hub/v1/user-key-wrap")`.
- **Clé enveloppée** : `AES-256-GCM(KEK, UK, aad = "opencode-hub/v1/user-key|" + user id)`, stockée dans `user.wrapped_key`.
- **Contrôle** : `user.key_check = HMAC-SHA256(UK, "opencode-hub/v1/key-check")`, pour que le hub refuse une clé fausse
  envoyée à la connexion.
- **Données chiffrées** : chaque secret (clé d'API, jeton OAuth, secret de connecteur) est stocké
  `v1 | nonce (12 octets) | chiffré + étiquette`, en `AES-256-GCM(UK, aad = "opencode-hub/v1|" + table + "|" + id de
ligne + "|" + user id)`. L'`aad` empêche de déplacer un secret d'une ligne ou d'un utilisateur à l'autre.
- **En mémoire** : après `login/finish`, le hub garde `UK` dans une table `user id → UK` jusqu'à son arrêt, au
  verrouillage demandé par l'utilisateur ou à la désactivation du compte. Rien n'est écrit sur disque.
- **Clé verrouillée** : un appel d'une instance au relais LLM ou MCP reçoit `423 Locked` avec le message « clés
  verrouillées : connectez-vous au hub pour les déverrouiller ». Le tableau de bord signale les utilisateurs dont des
  instances attendent un déverrouillage.
- Cryptographie : Web Crypto (`crypto.subtle`), disponible dans le navigateur et dans Bun. Pas de bibliothèque maison.

Ce que ça protège : la base `hub.db` et ses sauvegardes, volées seules, ne révèlent aucun secret. Ce que ça ne protège
pas : un attaquant qui contrôle le hub **pendant qu'il tourne**, puisque c'est le hub qui appelle les fournisseurs.

## Organisations

- Table `org` (id, nom, date) et `membership` (org, utilisateur, date). Pas de rôle interne : l'administration des
  organisations revient aux administrateurs du hub.
- Retirer un membre : ses instances sur les machines de l'organisation sont arrêtées et supprimées (voir « Instances »),
  ses jetons d'instance révoqués. Il perd les skills hérités de l'organisation.
- Supprimer une organisation : refusé tant qu'elle a des machines ; il faut d'abord les révoquer.
- Les organisations n'ont **pas** de clés d'API ni de connecteurs partagés (voir « Hors périmètre »).

## Machines

- `machine` gagne `owner_user_id` **ou** `owner_org_id` (exactement un des deux), et `enrolled_by`.
- Le code d'enrôlement (toujours en mémoire, 10 minutes, usage unique) porte son destinataire : `{ user }` ou
  `{ org }`. Le tableau de bord demande « Pour moi » ou « Pour l'organisation … » ; l'utilisateur doit être membre de
  l'organisation au moment de créer le code **et** au moment de l'enrôlement.
- Le tableau de bord liste les machines personnelles de l'utilisateur et celles de ses organisations, groupées.
- Routage inchangé : `<machine>.<domaine>`. Le hub retrouve l'utilisateur par le cookie, vérifie son droit
  d'accès à la machine (fail-closed, à chaque requête, y compris pour les tickets de passage `/hub/handoff`), puis
  ouvre le flux vers **son** instance.
- `GET /hub/tls-allowed` inchangé.

## Instances

Une instance est un serveur opencode local d'**un utilisateur** sur **une machine**, désignée par un identifiant
d'instance `iid` (aléatoire, sans rapport avec le login).

- **Machine personnelle** : une seule instance, celle du propriétaire, qui est le service opencode habituel du compte
  système (ses sessions et sa configuration existantes restent visibles).
- **Machine d'organisation** : une instance par membre qui l'utilise, démarrée à la demande à sa première requête, avec
  ses propres dossiers de données, de configuration et de cache (`<données globales>/hub-instances/<iid>/`, passés par
  les variables `XDG_*`), son port et son mot de passe local. Toutes tournent sous le compte système de l'agent.
- Chaque instance a son **jeton LLM** (32 octets, haché sur le hub, table `instance`), qui sert aussi pour le relais
  MCP. Le jeton LLM unique par machine disparaît.
- Configuration d'une instance, passée par `OPENCODE_CONFIG_CONTENT` comme aujourd'hui : fournisseurs LLM de
  l'utilisateur vers `<hub>/llm/<id>`, connecteurs MCP vers `<hub>/mcp/<id>` (voir plus bas).
- Arrêt et suppression d'une instance : retrait du membre, révocation de la machine, désactivation du compte. Le
  dossier de l'instance est supprimé (sessions, configuration, jetons).

### Tunnel, protocole 2

Le format des trames ne change pas. Changements par rapport au protocole 1 :

| Trame         | Changement                                                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HELLO         | `protocol: 2`                                                                                                                                                                                  |
| READY         | `{ machine, owner: "user" \| "org" }` ; plus de bloc `llm` (il passe dans INSTANCE)                                                                                                            |
| OPEN          | gagne `instance: <iid>` : l'agent route le flux vers cette instance, et la démarre si besoin                                                                                                   |
| 0x15 INSTANCE | hub → agent : `{ iid, token, llm: { baseURL, providers }, mcp: [{ id, name }], skills: { version } }`, envoyée avant le premier OPEN d'une instance et à chaque changement de sa configuration |
| 0x16 SKILLS   | hub → agent : `{ iid, version, skills: [{ name, files: [{ path, content }] }] }`                                                                                                               |
| 0x17 DROP     | hub → agent : `{ iid }`, arrêter et supprimer l'instance                                                                                                                                       |

L'agent ne garde le jeton d'une instance qu'en mémoire et dans la configuration de cette instance. Un agent en
protocole 1 est refusé (4400), comme aujourd'hui pour un protocole inconnu.

## Clés d'API (relais LLM)

- Table `provider` par utilisateur : `(user_id, id)` en clé, `api_key` et `oauth` chiffrés.
- `/llm/<fournisseur>/...` : le jeton d'instance donne `(machine, utilisateur)` ; le hub prend le fournisseur **de cet
  utilisateur**, le déchiffre avec sa `UK` en mémoire (sinon 423), et relaie comme aujourd'hui.
- Connexion ChatGPT par utilisateur ; le jeton renouvelé est rechiffré à chaque renouvellement.
- Le catalogue des fournisseurs (`presets`) reste commun.

## Connecteurs MCP (relais MCP)

Même système que les LLM : les secrets ne quittent pas le hub.

- Table `connector` : `(user_id, id)`, nom, URL du serveur MCP distant, en-têtes à injecter (chiffrés), ou connexion
  OAuth gérée par le hub (jetons chiffrés).
- `ANY /mcp/<id>/<reste>` : jeton d'instance en `Authorization: Bearer` → connecteur **de cet utilisateur** → requête
  relayée vers l'URL du connecteur avec ses en-têtes déchiffrés, flux (HTTP « streamable » et SSE) sans mise en
  tampon. Jeton invalide : 401 ; connecteur inconnu : 404 ; clé verrouillée : 423.
- Côté instance : `mcp: { "<id>": { type: "remote", url: "<hub>/mcp/<id>", headers: { Authorization: "Bearer <jeton>" }, oauth: false } }`.
- Seuls les serveurs MCP **distants** passent par le hub. Un serveur local (`type: "local"`, lancé sur la machine)
  reste configuré sur la machine elle-même.

## Skills

- Table `skill` : propriétaire (`user` ou `org`), nom, fichiers (`SKILL.md` obligatoire, autres fichiers texte),
  date. Pas de secret : stockés en clair. Limites : 256 Kio par skill, 200 skills par propriétaire.
- **Skills effectifs** d'un utilisateur = ses skills + ceux de toutes ses organisations. En cas de nom en double, **le
  skill de l'organisation l'emporte** ; le tableau de bord signale le skill personnel masqué. Entre deux organisations,
  l'ordre alphabétique de leur nom décide, et le conflit est signalé.
- Les skills effectifs vont à **toutes** les instances de l'utilisateur, sur ses machines personnelles comme sur celles
  de ses organisations.
- Distribution : le hub envoie SKILLS (version = empreinte du contenu) ; l'agent écrit les fichiers dans
  `<config de l'instance>/skills/hub-<nom>/`, en remplaçant tout le dossier géré par le hub et sans toucher aux skills
  locaux, puis demande à l'instance de recharger sa configuration.
- Écarté : les sources de skills par URL d'opencode (`skills: ["https://…"]`) ne savent pas s'authentifier ; il
  faudrait mettre un jeton dans l'URL.

## Stockage

`hub.db` (SQLite), dossier en `0700`, fichiers en `0600` quel que soit le mode de lancement :

| Table               | Contenu                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `user`              | id, login, rôle, enregistrement OPAQUE, `wrapped_key`, `key_check`, dates, désactivé le                               |
| `invitation`        | id, empreinte du code, rôle, organisations, auteur, expiration, utilisée le, compte lié (réinitialisation)            |
| `org`, `membership` | organisations et membres                                                                                              |
| `machine`           | comme aujourd'hui, plus le propriétaire (utilisateur ou organisation) et `enrolled_by` ; empreinte du jeton de tunnel |
| `instance`          | iid, machine, utilisateur, empreinte du jeton, dates                                                                  |
| `provider`          | par utilisateur, secrets chiffrés                                                                                     |
| `connector`         | par utilisateur, secrets chiffrés                                                                                     |
| `skill`             | par utilisateur ou organisation                                                                                       |
| `setting`           | réglages du hub (plus de mot de passe)                                                                                |

Hors de la base : `<data>/opaque-server-setup` (`0600`). En mémoire seulement : sessions, clés `UK` déverrouillées,
codes d'enrôlement, tickets de passage, états OPAQUE en cours, compteurs d'échecs.

## Tableau de bord

- Pages `/register?invite=` et `/login` (identifiant et mot de passe), toutes deux en OPAQUE dans le navigateur.
- Onglets : Machines (personnelles et par organisation), Fournisseurs, Connecteurs, Skills (les siens, et ceux hérités
  en lecture seule), Compte (mot de passe, verrouiller mes clés).
- Administration (administrateurs) : Utilisateurs (inviter, désactiver, réinitialiser, rôle), Organisations (créer,
  membres, skills de l'organisation), invitations en cours.

## Passage depuis la version actuelle

- Au premier démarrage sans aucun utilisateur, le hub affiche une invitation administrateur (comme il affichait le mot
  de passe généré). `opencode hub invite --admin` en recrée une. `opencode hub password` et `OPENCODE_HUB_PASSWORD`
  disparaissent ; `install.sh` affiche une invitation à la place du mot de passe et ne crée plus
  `/etc/opencode-hub.env`.
- Les machines existantes sont attribuées au premier administrateur créé. Elles doivent mettre à jour opencode
  (protocole 2) pour se reconnecter.
- Les fournisseurs existants, stockés en clair, sont supprimés au passage : ils doivent être ressaisis.

## Limites

- **Isolation sur une machine d'organisation** : les instances partagent le compte système. Un membre peut lire les
  fichiers, sessions et jetons des instances des autres membres sur cette machine. C'est le choix assumé (décision 4).
- **Clés en mémoire** : le processus du hub détient les clés déverrouillées tant qu'il tourne.
- **Mot de passe perdu** : les secrets de l'utilisateur sont perdus et à ressaisir.
- Pas de contrôle de flux dans le tunnel (inchangé).

## Hors périmètre

- Clés d'API et connecteurs **partagés par une organisation** : il faudrait une clé d'organisation enveloppée pour
  chaque membre. À reprendre si le besoin se confirme.
- Rôles internes aux organisations (responsable qui gère ses membres).
- Arrêt automatique des instances inactives, quotas par instance.
- Comptes système séparés par utilisateur sur les machines d'organisation.
- Journal d'audit des actions d'administration (à prévoir dès l'étape 1 si possible, sans secret).

## Étapes

Chacune est une PR qui fonctionne seule, avec ses tests.

1. **Comptes** : tables `user` et `invitation`, OPAQUE (inscription par invitation, connexion, limites), sessions par
   utilisateur, rôle administrateur, `opencode hub invite`, pages `/register` et `/login`, administration des
   utilisateurs, droits `0700`/`0600`, `install.sh` adapté. La clé `UK` est déjà créée et enveloppée, mais encore
   inutilisée. Suppression du mot de passe unique.
2. **Machines par utilisateur** : propriétaire des machines, code d'enrôlement lié à son auteur, liste et accès filtrés
   (fail-closed, tickets compris), révocation selon les droits.
3. **Clés d'API chiffrées** : déverrouillage de `UK` à la connexion, fournisseurs par utilisateur chiffrés, relais LLM
   par utilisateur (jeton encore par machine, rattaché à son propriétaire), 423 quand c'est verrouillé, ChatGPT par
   utilisateur.
4. **Organisations** : tables, administration, enrôlement pour une organisation, accès des membres. Tant que l'étape 5
   n'est pas faite, les membres partagent l'instance unique de la machine, qui utilise les clés d'API de celui qui
   l'a enrôlée.
5. **Instances par utilisateur** : protocole 2 du tunnel, instances à la demande dans l'agent, jeton par instance,
   relais LLM par instance, suppression des instances au retrait d'un membre.
6. **Skills** : skills personnels et d'organisation, héritage, distribution SKILLS, rechargement de l'instance.
7. **Connecteurs MCP** : connecteurs par utilisateur à secrets chiffrés, relais `/mcp/`, configuration des instances,
   puis OAuth géré par le hub.
