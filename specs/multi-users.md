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
   **Faite** (2026-11-07). Écarts :
   - KSF : `@serenity-kit/opaque` 1.1.0 n'a pas d'option `rfc9106-low-memory` ; `memory-constrained` est Argon2id
     64 Mio, 3 passes, 4 voies (RFC 9106 §4), vérifié par un enregistrement en paramètres explicites
     `{ memory: 65536, iterations: 3, parallelism: 4 }` qui se connecte avec `memory-constrained`.
   - `register/start` et `login/start` renvoient aussi `userID` (l'`aad` de la clé enveloppée contient l'id, que le
     navigateur ne connaît pas encore), et `register/start` le `login` normalisé. La clé enveloppée commence par un
     octet de version (`1 | nonce | chiffré + étiquette`, 61 octets).
   - `register/finish` reçoit aussi `userKey.key` : le hub vérifie le `check` et garde la clé en mémoire dès
     l'inscription.
   - Route en plus `register/invite { invite }` → `{ role, login }`, pour que la page d'une réinitialisation affiche
     le login du compte.
   - Changement de mot de passe : `account/password/start|finish` prouvent l'ancien mot de passe par une connexion
     OPAQUE dans le même échange (le navigateur en a besoin pour obtenir `UK` et la ré-envelopper).
   - Réinitialisation : le mot de passe et la clé sont effacés dès la création du lien (l'ancien mot de passe cesse
     aussitôt de marcher), sessions fermées, clé retirée de la mémoire ; un lien de réinitialisation précédent est
     supprimé. Un compte désactivé se réactive (`users/<id>/enable`).
   - Un échec de connexion se compte dès `login/start` (un mauvais mot de passe échoue dans le navigateur, qui
     n'appelle pas `login/finish`) ; un succès remet les compteurs à zéro.
   - Premier démarrage sans compte : le lien n'est affiché que dans un terminal ; sous systemd, le hub affiche la
     commande `opencode hub invite --admin`, pour qu'aucun lien valide n'aille dans le journal. `install.sh` crée
     l'invitation à la première installation.
   - CSP du tableau de bord : `'wasm-unsafe-eval'` pour le WebAssembly d'OPAQUE.
   - Tableau de bord : Compte, Utilisateurs et Invitations en cours sont des sections de la page existante, pas des
     onglets (pas de nouvelle navigation à styler).
   - Pas encore fait : organisations dans l'invitation (étape 4), journal d'audit.
2. **Machines par utilisateur** : propriétaire des machines, code d'enrôlement lié à son auteur, liste et accès filtrés
   (fail-closed, tickets compris), révocation selon les droits.
   **Faite** (2026-11-07). Écarts et précisions :
   - `machine` gagne `owner_user_id`, `owner_org_id` (toujours vide, réservé à l'étape 4) et `enrolled_by`, ajoutés
     par `ALTER TABLE` sur une base existante. « Exactement un des deux » est assuré par le code : `createMachine`
     exige un propriétaire, et une machine d'organisation ou sans propriétaire ne s'ouvre pour personne.
   - Attribution des machines existantes : au plus ancien administrateur **actif** (pas désactivé), au démarrage et
     après chaque inscription, changement de rôle ou réactivation, tant qu'il reste des machines sans propriétaire.
     Un administrateur désactivé ne les reçoit pas, pour qu'elles restent utilisables.
   - Accès refusé = machine inconnue : même page 404 sur l'hôte, `/` pour `/hub/handoff`, 404 pour `DELETE`. Pour ne
     rien révéler sans session non plus, un hôte de machine sans session renvoie à la connexion que la machine existe
     ou non (avant, une machine inconnue répondait 404). `GET /hub/tls-allowed`, inchangé, dit toujours quelles
     machines existent.
   - Session déjà établie : chaque requête est contrôlée ; en plus, la déconnexion, la désactivation ou la
     réinitialisation d'un compte coupent aussitôt les flux relayés encore ouverts de ses sessions (réponse SSE close,
     WebSocket fermée en 1008).
   - Code d'enrôlement d'un auteur désactivé (ou réinitialisé, sans mot de passe) : refusé en 403, avec le même
     message qu'un code invalide.
   - Administration : `GET /hub/api/admin/machines` (toutes les machines, propriétaire, état, dernière connexion, sans
     lien d'ouverture) ; un administrateur révoque toute machine par `DELETE machines/<id>`.
   - Tableau de bord : « My machines » (flux en direct) et, pour les administrateurs, « All machines », rechargée à
     chaque événement du flux.
   - `Hub.start(...).createEnrollmentCode(userID)` prend désormais l'utilisateur.
3. **Clés d'API chiffrées** : déverrouillage de `UK` à la connexion, fournisseurs par utilisateur chiffrés, relais LLM
   par utilisateur (jeton encore par machine, rattaché à son propriétaire), 423 quand c'est verrouillé, ChatGPT par
   utilisateur.
   **Faite** (2026-11-07). Écarts et précisions :
   - Module `hub/secrets.ts` (Web Crypto) : format et `aad` de la spec, la table étant `provider` et l'id de ligne
     l'id du fournisseur. Stocké en base64url sans remplissage, comme la clé enveloppée. `hub/providers.ts` est le
     seul à sceller et ouvrir, en mémoire, à chaque requête ; aucun journal ne contient de secret ni d'`UK`.
   - Table `provider` : clé `(user_id, id)`, colonnes `api_key` (pour `key`) et `oauth` (JSON, pour `chatgpt`)
     scellées, l'autre à `NULL`. Le nom, l'URL amont et le type restent en clair (ils partent vers les machines).
   - Passage : une table `provider` sans `user_id` est supprimée sans être lue. La connexion tourne avec
     `secure_delete` (pages libérées mises à zéro) et la suppression est suivie d'un `wal_checkpoint(TRUNCATE)` :
     les anciennes clés ne restent ni dans `hub.db` ni dans son WAL (vérifié par un test sur le fichier brut).
   - Relais : 401 (jeton invalide, ou jetons de deux machines dans une requête) ; 403 pour une machine
     d'organisation ou sans propriétaire ; 423 si le propriétaire est désactivé, réinitialisé ou si sa clé n'est pas
     en mémoire ; puis 404 pour un fournisseur inconnu de ce propriétaire ; 500 si le secret ne s'ouvre pas. Le 423
     passe avant le 404 pour que réinitialisation et désactivation répondent « verrouillé ». Message en anglais,
     comme le reste de l'API : « Keys locked: sign in to the hub to unlock them. »
   - Routes `providers` : 423 `{ error, locked: true }` pour l'ajout, la modification et `chatgpt/begin|complete`
     sans `UK` en mémoire ; la suppression n'en a pas besoin (rien n'est déchiffré). Une tentative ChatGPT est liée à
     l'utilisateur qui l'a ouverte.
   - ChatGPT : le jeton renouvelé est rescellé avec la clé qui a ouvert le fournisseur au début de la requête. Sans
     `UK`, le relais répond 423 avant tout renouvellement ; un verrouillage qui tombe pendant un renouvellement déjà
     parti ne perd donc pas le jeton de renouvellement, que OpenAI a pu remplacer.
   - READY et CONFIG portent les fournisseurs du propriétaire (liste vide pour une machine d'organisation ou sans
     propriétaire) ; un changement n'est poussé qu'aux machines de cet utilisateur, y compris après une
     réinitialisation (liste vide).
   - Indicateur d'administration : `waiting` dans `users`, vrai pour un utilisateur dont la clé est verrouillée et
     qui a au moins une machine personnelle et un fournisseur ; affiché « Keys locked » dans la liste. C'est un
     état calculé, pas un relevé des 423 effectivement renvoyés.
   - Tableau de bord : section Fournisseurs propre à l'utilisateur ; clés verrouillées, une ligne l'explique avec
     « Sign in again », et l'ajout est désactivé. L'état est partagé avec la section Compte.
4. **Organisations** : tables, administration, enrôlement pour une organisation, accès des membres. Tant que l'étape 5
   n'est pas faite, les membres partagent l'instance unique de la machine, qui utilise les clés d'API de celui qui
   l'a enrôlée.
   **Faite** (2026-11-07). Écarts et précisions :
   - Tables `org` (nom unique sans distinction de casse, normalisé NFKC, espaces réduits, 1 à 64 caractères) et
     `membership`. Les organisations d'une invitation sont dans une table de liaison `invitation_org`, pas dans une
     colonne : supprimer une organisation la retire des invitations en cours, et le compte créé ne rejoint que celles
     qui existent encore, dans la transaction qui le crée.
   - Routes (administrateurs, 403 pour tout autre utilisateur, même membre) : `GET|POST orgs`,
     `POST orgs/<id>/rename`, `DELETE orgs/<id>` (409 tant qu'elle a des machines), `POST orgs/<id>/members { user }`,
     `DELETE orgs/<id>/members/<user>`. Pour tous : `GET memberships` (ses organisations, pour « Add machine »).
     `invitations` accepte `orgs` (ids ; une organisation inconnue vaut 400) et la liste les rend par leur nom.
   - `opencode hub invite --org <nom>` (répétable) : noms sans distinction de casse ; un nom inconnu fait échouer la
     commande sans rien écrire.
   - Code d'enrôlement `machines/code { org? }` : un non-membre (administrateur compris) reçoit 403 à la création ;
     à l'enrôlement, auteur désactivé ou plus membre (ou organisation supprimée) : 403 avec le même message qu'un code
     invalide, comme à l'étape 2.
   - Accès : `canOpen` vérifie l'appartenance à chaque requête (liste, SSE, hôte, WebSocket, tickets) ; une machine
     d'organisation qui aurait aussi `owner_user_id` ne s'ouvre pour personne. Le retrait d'un membre réutilise la
     coupure des flux de l'étape 2 (`recheckStreams`) et pousse aussitôt la liste à jour aux tableaux de bord. Les
     instances ne sont pas encore arrêtées (étape 5) : la machine garde l'instance unique, partagée.
   - Relais LLM d'une machine d'organisation : clés de `enrolled_by` tant qu'il est actif (ni désactivé, ni
     réinitialisé) et membre ; sinon 403 « The member who enrolled this organization machine is no longer an active
     member of it… ». Différence voulue avec une machine personnelle, dont le propriétaire désactivé donne 423 : ici
     le droit aux clés est perdu, pas seulement verrouillé. Clé absente de la mémoire : 423 comme avant.
   - READY/CONFIG : fournisseurs de `enrolled_by` (liste vide quand il n'y a plus droit), poussés quand ses
     fournisseurs changent, quand il est retiré ou réajouté, désactivé ou réactivé.
   - Révocation : l'auteur de l'enrôlement tant qu'il est membre (colonne « Membre » de la table des droits), ou un
     administrateur. Un autre membre reçoit 403 (il voit la machine), un non-membre 404. La liste porte `canRevoke`
     pour n'afficher l'action qu'à ceux qui l'ont.
   - Indicateur `waiting` des administrateurs : compte aussi les machines d'organisation enrôlées par l'utilisateur
     tant qu'il en est membre.
   - Tableau de bord : « My machines » puis une section par organisation (par nom) ; « Add machine » propose « For
     me » ou « For <organisation> » quand l'utilisateur est membre d'au moins une organisation, sinon crée le code
     aussitôt comme avant ; section d'administration « Organizations » (créer, renommer, supprimer, fenêtre
     « Members… » pour ajouter ou retirer) ; l'invitation coche des organisations, et les invitations en cours
     affichent « Joins … ». « All machines » indique « Organization <nom> ».
5. **Instances par utilisateur** : protocole 2 du tunnel, instances à la demande dans l'agent, jeton par instance,
   relais LLM par instance, suppression des instances au retrait d'un membre.
   **Faite** (2026-11-07). Écarts et précisions :
   - Table `instance` (`id` = iid de 128 bits en base64url, `machine_id`, `user_id`, `token_hash`, `created_at`,
     `token_issued_at`, unique `(machine_id, user_id)`). Le jeton n'est pas émis à la création : il l'est quand le
     hub envoie INSTANCE à un agent qui ne détient pas le jeton courant, et il **remplace** le précédent. La colonne
     `machine.llm_token_hash` disparaît (table reconstruite sur une base existante, SQLite ne sachant pas supprimer
     une colonne `UNIQUE`) ; l'enrôlement ne rend plus de `llmToken`.
   - Ajout au protocole : HELLO porte `instances: [{ iid, hash }]`, les jetons que l'agent détient encore (SHA-256
     hexadécimal) ; INSTANCE n'a `token` que lorsque le hub en émet un nouveau. Sans cela, le hub ne pourrait pas
     savoir si l'agent a encore le jeton après une reconnexion, et devrait en émettre un à chaque fois : la machine
     personnelle redémarrerait son service à chaque coupure réseau. Un hash qui ne correspond pas (trame perdue)
     vaut « pas de jeton » : le hub en émet un nouveau.
   - READY porte aussi `instances` (les iid encore valides) : c'est le mécanisme des retraits faits hors ligne.
     L'agent oublie les instances absentes de la liste et supprime leurs dossiers, y compris ceux laissés sur disque
     par une exécution précédente.
   - Machine personnelle : l'instance du propriétaire est créée dès la connexion de l'agent (pas à la première
     ouverture) et INSTANCE suit READY, pour que le service habituel, aussi utilisé localement, ait ses fournisseurs
     comme avant. Son environnement enregistré gagne `OPENCODE_HUB_INSTANCE` (l'iid), que l'agent relit au démarrage
     avec le jeton pour les annoncer dans HELLO ; il ne redémarre le service que si l'environnement change. DROP n'y
     retire que ces trois variables : le dossier de l'instance est celui du compte, qui n'est **jamais** supprimé.
   - Machine d'organisation : chaque instance est `opencode serve --stdio --hostname 127.0.0.1 --port 0`, enfant de
     l'agent, avec un mot de passe aléatoire à chaque démarrage et ses `XDG_*` sous
     `<données globales>/hub-instances/<iid>/` (`0700`). Le mode `--stdio` fait de stdin un bail : l'instance s'arrête
     quand l'agent ferme stdin ou meurt, sans processus orphelin. L'environnement hérité de l'agent est filtré
     (`XDG_*`, `OPENCODE_CONFIG*`, mots de passe et jeton de l'agent). Le dossier de travail est celui de l'agent (un
     checkout source en a besoin pour le `bunfig.toml` de la CLI) ; le service personnel, lui, se place dans le
     dossier personnel. Un changement de configuration arrête l'instance, qui redémarre à la requête suivante.
   - Retrait d'accès : une seule règle, `pruneInstances`, supprime toute instance dont l'utilisateur ne pourrait plus
     ouvrir la machine (mêmes conditions que l'accès : compte actif avec mot de passe, propriétaire ou membre). Elle
     tourne après un retrait ou ajout de membre, une désactivation, une réactivation, un changement de rôle (adoption)
     et une réinitialisation, puis DROP part vers les agents connectés. Une réactivation recrée l'instance du
     propriétaire d'une machine personnelle connectée (nouveau jeton, clé verrouillée : 423). La révocation d'une
     machine envoie DROP pour chaque instance avant de fermer le tunnel en 4403.
   - Réinitialisation : comme le demandait la consigne de l'étape, elle supprime aussi les instances (sur une
     machine d'organisation, les sessions du membre sont perdues ; sur sa machine personnelle, seule la configuration
     du hub est retirée). La section « Réinitialisation » disait « machines conservées » : elles le sont.
   - Relais LLM : 401 (jeton inconnu, jetons de deux instances, machine disparue) ; 403 « This account no longer has
     access to this machine. » si l'utilisateur ne peut plus ouvrir la machine, contrôlé à chaque appel en plus de la
     suppression de l'instance (fail-closed) ; puis 404 / 423 / 500 comme à l'étape 3. Un propriétaire désactivé
     reçoit donc 401 (instance supprimée), et non plus 423 comme à l'étape 3. La règle provisoire de l'étape 4 (clés
     de `enrolled_by`, `ENROLLER_GONE`) est supprimée.
   - Indicateur `waiting` : utilisateur à clé verrouillée qui a un fournisseur **et** au moins une instance.
   - `mcp: []` et `skills: { version }` (empreinte SHA-256 de la liste vide) dans INSTANCE ; SKILLS est défini et
     décodé mais jamais envoyé (envoyé depuis l'étape 6).
   - Agent : `agent.json` ne contient plus que `{ url, machine, tunnelToken }` ; un ancien fichier se charge et perd
     son `llmToken` à la première lecture. `agent status` affiche le dossier des instances ; `agent leave` retire la
     configuration du hub de l'environnement du service.
   - Tableau de bord : seul le texte des sections d'organisation change (chaque membre a sa propre instance, ses
     fournisseurs et ses sessions).
   - Non fait : arrêt des instances inactives (hors périmètre) ; à la révocation d'une machine personnelle, l'agent
     s'arrête avant d'avoir retiré la configuration du hub du service (le jeton, supprimé sur le hub, ne sert plus).
6. **Skills** : skills personnels et d'organisation, héritage, distribution SKILLS, rechargement de l'instance.
   **Faite** (2026-11-07). Écarts et précisions :
   - Table `skill` (`id`, `owner_kind` `user` ou `org`, `owner_id`, `name`, `description`, `files` en JSON
     `[{ path, content }]` en clair, `created_at`, `updated_at`, unique `(owner_kind, owner_id, name)`). Supprimer une
     organisation supprime ses skills ; une réinitialisation garde ceux de l'utilisateur.
   - Validation au dépôt (`src/skills.ts`, partagée avec l'agent) : nom `[a-z0-9]+(-[a-z0-9]+)*`, 64 caractères au
     plus (c'est le nom du dossier `hub-<nom>`) ; `SKILL.md` à la racine, commençant par un frontmatter YAML dont
     `name` est **égal au nom du skill** et `description` une chaîne non vide de 1024 caractères au plus (opencode
     tolère l'absence de `name` et de `description`, le hub non : un skill sans description ne serait pas choisi) ;
     chemins relatifs de segments `[A-Za-z0-9_][A-Za-z0-9._-]*` (ni `..`, ni chemin absolu, ni `\`, ni fichier
     caché), 6 niveaux, 100 fichiers, deux chemins égaux sans distinction de casse refusés, pas d'octet nul ;
     256 Kio comptés sur les chemins et contenus en UTF-8. Les liens n'existent pas dans ce format ; l'agent écrit
     dans un dossier qu'il vient de créer, avec `wx`. Le YAML est lu par `Bun.YAML` ; opencode utilise gray-matter et
     accepte en plus des valeurs non citées contenant `:`, que le hub refuse (message clair, le tableau de bord cite
     toujours la description).
   - Routes : `GET skills` → `{ own, inherited, version }` (chaque skill avec `hiddenBy`, l'organisation dont le skill
     du même nom l'emporte), `POST skills { name, files }`, `POST|DELETE skills/<id>` ; administrateurs seulement :
     `GET|POST orgs/<id>/skills`, `POST|DELETE orgs/<id>/skills/<skill>` (403 pour les autres, membres compris).
     400 pour un skill invalide, 409 pour un nom déjà pris par ce propriétaire ou au-delà de 200, 404 pour le skill
     d'un autre propriétaire (même réponse qu'un skill inconnu).
   - Skills effectifs : organisations dans l'ordre de leur nom sans distinction de casse (comme leur liste), puis les
     skills personnels ; le premier d'un nom l'emporte. Version : SHA-256 du JSON canonique (skills par nom,
     fichiers par chemin), égale à l'empreinte de `[]` sans skill, comme à l'étape 5.
   - Protocole : HELLO porte aussi `instances[].skills`, la version que l'agent a écrite pour chaque instance dont il
     annonce le jeton ; sans cela le hub ne saurait pas qu'un agent reconnecté a déjà la bonne version. SKILLS suit
     INSTANCE quand l'agent n'a pas la version, et part vers chaque instance que l'agent détient sur la connexion
     quand la version de son utilisateur change : skill personnel ou d'organisation ajouté, modifié ou supprimé,
     entrée ou retrait d'une organisation, organisation renommée (l'ordre change) ou supprimée. Les autres instances
     le reçoivent avec INSTANCE avant leur premier flux. L'agent ignore SKILLS pour une instance inconnue, revérifie
     noms et chemins, et n'annonce une version qu'une fois écrite.
   - Écriture : `<config>/skills/hub-<nom>/`, avec un manifeste `.hub-skills.json` (caché du scan d'opencode) qui
     liste les dossiers écrits par l'agent : seuls ceux-là sont remplacés ou supprimés. Un dossier local qui
     s'appellerait déjà `hub-<nom>` est laissé tel quel et ce skill est sauté (journalisé). Chaque skill est écrit en
     entier dans un dossier de préparation caché `.hub-staging-*` à l'intérieur de `skills/`, puis renommé à sa place ;
     **le remplacement est atomique par skill, pas pour l'ensemble** (un renommage atomique de tout l'ensemble
     demanderait de changer la disposition des dossiers attendue par la spec) : un scan au mauvais moment peut voir un
     mélange, corrigé par le rechargement qui suit.
   - Rechargement : `POST /api/location/reload` (l'API derrière `opencode reload`) sur l'instance **si elle tourne**
     et si les skills ont réellement changé. Raisons : c'est le mécanisme documenté de rechargement de la
     configuration, il relit les dossiers de skills de façon déterministe, et les sessions continuent ; un redémarrage
     couperait sessions et terminaux. Le greffon de skills d'opencode surveille aussi ces dossiers, mais dépend des
     événements du système de fichiers. Contrepartie : le rechargement annule les demandes de permission en attente,
     d'où l'appel seulement quand la version change. Sur une machine d'organisation, l'instance ne démarre qu'une fois
     ses skills écrits ; sur une machine personnelle, le service n'est pas démarré pour être rechargé.
   - Machine personnelle : dossier de configuration du compte (`Global.config`, par exemple
     `~/.config/opencode/skills/hub-*`). DROP, une instance absente de READY et `agent leave` retirent les dossiers
     `hub-*` du manifeste, rien d'autre.
   - Tableau de bord : section « Skills » (les siens, avec « Not used » et « Hidden by <organisation>'s skill of the
     same name » quand un skill d'organisation l'emporte, puis « From your organizations » en lecture seule) ; pour
     les administrateurs, « Skills… » dans le menu de chaque organisation. L'éditeur a nom, description,
     instructions (corps de `SKILL.md`) et fichiers supplémentaires (chemin et contenu). Il réécrit le frontmatter avec
     `name` et `description` seulement : d'autres clés (`metadata`…) posées par l'API sont perdues si le skill est
     modifié depuis le tableau de bord. Écart à « classes existantes uniquement » : une règle CSS `hub-skill-dialog`
     (sur le modèle de `hub-provider-dialog`), parce que l'éditeur peut dépasser la hauteur de l'écran et que son
     bouton d'enregistrement devenait inaccessible ; et `w-full` (Tailwind) sur les zones de texte.
7. **Connecteurs MCP** : connecteurs par utilisateur à secrets chiffrés, relais `/mcp/`, configuration des instances,
   puis OAuth géré par le hub.
