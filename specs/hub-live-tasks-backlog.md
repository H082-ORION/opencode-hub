# Backlog — tâches machine en direct dans le hub chat

Audit en lecture seule (sous-agent Fable), branche `remote-machines`. Cible : expérience « sous-agent » façon Claude Code web,
dans le style OpenCode (vrais composants `session-ui` / `ui` / timeline, pas de copies visuelles).

Objectifs utilisateur :
1. Pas de redirection : la carte `machine_task` dans le chat hub est cliquable et ouvre une **sidebar droite** sur la même page,
   avec la session distante en temps réel (texte, raisonnement, outils, shell, todo, statut, erreurs).
2. On continue à parler au chat hub pendant que la tâche tourne.
3. L'agent hub supervise : lister, inspecter, arrêter, envoyer de nouveaux ordres (steer/queue), lancer d'autres sessions (en parallèle, autres machines).
4. L'utilisateur agit depuis la sidebar : stop, message, réponse aux permissions/questions.
5. Les captures d'écran / images de l'agent distant remontent dans le chat hub.
6. Tokens et coût visibles (par tâche, par conversation, par machine/utilisateur).
7. Robuste : reconnexion, redémarrage hub, machine offline, tâches concurrentes, mobile, i18n, machines à états, sécurité.

## État actuel

- `machine_task` (`packages/relay/src/hub/chat-tools.ts:48-65`, exécution `:175-188`) est **bloquant** : `ChatMachines.run`
  (`chat-machines.ts:294-313`) crée/réutilise la session distante « Hub task » (`startSession` `:456-470`, questions refusées `:463`),
  POST prompt, puis **poll** `GET …/message?limit=30` toutes les 2 s (`wait` `:484-507`), rejette les permissions (`rejectPermissions`
  `:549-561`), ne renvoie que le texte final tronqué à 60 k (`finalMessage` `:566-577`). L'abandon de l'appel MCP interrompt la session
  distante (`:311`). Timeout MCP 6 h (`chat.ts:41,66`).
- Une seule cible et une seule `remote_session` par conversation (`store.ts:392-401`) ; `runs`/`failures` en mémoire
  (`chat-machines.ts:123-125`) ; le schéma `Message` (`:58-68`) ignore `tokens`/`cost`.
- `/commande` et `!shell` (`launch` `:319-376`) : résultat enregistré seulement à la fin (message synthétique), ré-affiché par
  `packages/app/src/hub/chat-machine-runs.ts`.
- App : `packages/app/src/hub/chat.tsx` utilise déjà `createData` + `SessionTimeline` + `DataProvider` (`:59-81`, `:505-517`), sans
  `onNavigateToSession`, avec `omitToolFileData: true` (`:79`). `hub-tools_machine_task` est rendu par le fallback `GenericTool`
  (`packages/session-ui/src/tools/tool-renderer.tsx:1367` → `components/basic-tool.tsx:243-258`). Seul panneau droit : `ChatSidePanel`
  (`chat-context-panel.tsx`, CSS `chat-context-panel.css:57-125`, overlay < 768 px).
- `machineRequest` (`packages/relay/src/hub/index.ts:808-834`) revérifie `mayOpen` et tague les streams `hub:<user>` ; `recheckStreams`
  (`:604-613`) passe ce tag à `auth.session(...)` → **tout stream long initié par le hub serait coupé au premier recheck** (vérifié dans le code).
- Tunnel sans contrôle de flux (`tunnel.ts:42-44`, `agent/index.ts:391-401`, spec `remote-machines.md:99`). `/api/event` ne filtre que
  par `types` (`packages/protocol/src/groups/event.ts:38-54`), jamais par session ; un consommateur lent fait échouer le flux.
- Proxy LLM (`llm.ts:100-104`) ne mesure rien ; `catalog.ts` ne conserve pas les prix.
- `specs/remote-machines.md` ne décrit pas le hub chat.

Endpoints machine disponibles (Protocol non modifié) : `session.prompt` avec `delivery: steer|queue` (`groups/session.ts:339-350`),
`session.interrupt` (`:676`), `session.background` (`:695`), `session.active` (`:222`), `session.messages` (`groups/message.ts:102`),
`session.permission.list/reply` `once|always|reject` (`groups/permission.ts:114,142`), `session.form.get/reply/cancel` (`session.ts:753-784`),
`session.inbox.list/cancel/update` (`:542-569`), `session.synthetic` avec `id`, `delivery`, `resume` (`:400-411`),
`experimental.media.get` + capacité `experimental-media-uri` (`groups/media.ts`, `packages/client/src/promise/media.ts`).

---

## A. Transport temps réel hub ↔ machine

- **A1. Watcher SSE par (user, machine), filtré par session** — P0, L. Nouveau `packages/relay/src/hub/chat-watch.ts` : ouvre via
  `machineRequest` `GET /api/event?types=…` (`session.text.delta`, `session.reasoning.delta`, `session.tool.*`, `session.step.*`,
  `session.execution.*`, `session.shell.*`, `session.compaction.*`, `session.usage.updated`, `session.synthetic`, `session.inbox.*`,
  `session.renamed`, `permission.*`, `form.*`, `server.connected`), parse le SSE, ne redistribue que les événements dont `data.sessionID`
  appartient aux tâches suivies (+ enfants via `session.created`/`parentID`). Ref-count, reconnexion avec backoff (modèle :
  `transitionFeed` de `packages/app/src/hub/machine.ts`). Remplace le polling. Dépend de I1.
- **A2. Route SSE navigateur `GET /hub/api/chat-tasks/<task>/events`** — P0, M. Vérifie le propriétaire, s'abonne à A1, émet un
  `server.connected` synthétique puis les événements filtrés + `hub.task.updated`. Motif `stream()` de `chat.ts:390-410`. Compatible
  avec `createClientConnection` (`packages/client/src/solid/connection.ts`).
- **A3. Contrôle de flux minimal** — P1, M. Hub : si `desiredSize ≤ 0` d'un abonné, coalescer les deltas consécutifs, au-delà d'un seuil
  fermer avec `hub.task.resync` (le client refait `message.sync`). Tunnel : attendre quand `ws.bufferedAmount` dépasse un plafond
  (à vérifier côté client WebSocket Bun). Mettre à jour la spec.
- **A4. Événement `hub.task.updated`** — P0, S. `{ task, status: starting|running|waiting|idle|failed|interrupted|offline|lost,
  remoteSession, machineOnline, tokens?, cost?, error? }`, émis sur A2 et sur le SSE du chat hub.
- **A5. Sessions enfants (sous-agents distants)** — P2, S. Suivies par A1, transmises par A2, rendues par le renderer `subagent` (D4).

## B. API hub, routes, stockage

- **B1. Table `chat_task`** — P0, M. Dans `store.ts` : `id, user_id, session_id, machine_id, directory, remote_session, title,
  prompt_excerpt, status, created_at, started_at, ended_at, outcome, error, tokens_*, cost, notified_at` + index `(user_id, session_id)`.
  `chat_target.remote_session` reste la session par défaut de `/commande` et `!shell` (décision Q4).
- **B2. Routes REST** — P0, M. `GET chat-tasks?session=`, `GET chat-tasks/<id>`, `POST chat-tasks`, `DELETE chat-tasks/<id>/run`,
  `POST chat-tasks/<id>/prompt {text, delivery}`, `POST …/permission/<req>`, `POST|DELETE …/form/<form>`, `POST …/background`.
  Corps reconstruits champ par champ (règle `chat.ts:150-153`).
- **B3. Proxy en liste fermée `ANY /hub/api/chat-tasks/<id>/api/<rest>`** — P0, M. Pour brancher `OpenCode.make({ baseUrl })` +
  `createData` + `SessionTimeline`. GET uniquement : session, messages, inbox, permission, form, `session/active`,
  `experimental/media/<hash>`, `agent`, `model`, et seulement pour la session de la tâche (ou enfants connus). Transmettre
  `x-opencode-directory` et `X-OpenCode-Capabilities: experimental-media-uri`. Gabarit : `READS`/`MESSAGES` de `chat.ts:130-141`.
- **B4. Démarrage asynchrone** — P0, L. `run()` → `start(task)` : ligne `chat_task` créée avant le premier `await`, **nouvelle
  session distante par tâche** (titre = prompt tronqué), POST prompt, suivi par A1. Fin sur `session.execution.*` : texte final,
  agrégats tokens/coût (G1), notification au modèle hub (C2). `wait()` en repli seulement.
- **B5. Découpler la tâche du `request.signal` MCP** — P0, S. `chat-machines.ts:311`, `chat-tools.ts:166,185`.
- **B6. Tâche sur une autre machine/dossier** — P1, S. `machine?`/`directory?` optionnels, accès via `machineRequest`, chemin absolu.

## C. Outils de l'agent hub (supervision)

- **C1. Outils asynchrones** (`chat-tools.ts` `TOOLS` `:48`, `run()` `:174`) — P0, L.
  - `machine_task` non bloquant → handle `{ task, remoteSession, machine, directory, status }` ; params `prompt, images?, machine?,
    directory?, wait_seconds? (0–600)`.
  - `machine_tasks_list { scope: session|all }`, `machine_task_status { task }` (dernière activité, permissions/questions en attente,
    tokens/coût), `machine_task_read { task, limit?, since? }` (digest borné ~20 k), `machine_task_send { task, text, delivery }`,
    `machine_task_stop { task }`, `machines_list`, `machine_task_permissions` / `machine_task_reply_permission` / `machine_task_answer`
    (seulement si l'utilisateur le demande, Q5), `machine_task_files` / `machine_task_image` (F3).
  - Schémas Effect manuels étendus (la relay ne dépend pas de `@opencode/schema`).
- **C2. Notification de fin au modèle hub** — P0, M. `input.record` avec `resume: true`, `delivery: queue`, `id` dérivé de l'id de
  tâche (idempotence), metadata `{ source: "hub-machine", kind: "task", … }` ; étendre `Recorded` ; `notified_at`.
- **C3. Prompt `SYSTEM` (`chat.ts:16-29`)** — P0, S. Tâches async/parallèles, vérifier statut avant de conclure, ne jamais répondre
  aux permissions à la place de l'utilisateur sauf demande, relayer les captures, signaler le coût.
- **C4. Permissions de l'engine** — P1, S. Préfixe `hub-tools_*` ; `timeout.execution` peut redescendre (~15 min).
- **C5. `/commande` et `!shell` en tâches visibles en direct** — P1, M. Supprime le poll `RUN_POLL` de `chat.tsx:215-226`.

## D. UI : sidebar droite et rendu

- **D1. Carte `machine_task` cliquable** — P0, M. `ToolRegistry.register` (`tool-renderer.tsx:1178`) pour `hub-tools_machine_task*`,
  en reprenant le renderer `subagent` (`tool-renderer.tsx:1734-1847`, `task-tool-card`, `SessionProgressIndicatorV2`). Clic →
  `openTask(id)`. Statut live via A4. (À vérifier : noms préfixés `hub-tools_` acceptés.)
- **D2. Panneau droit « tâche »** — P0, L. `chat-context.ts` : `panel: none | context | { task, id }`. Nouveau
  `packages/app/src/hub/chat-task-panel.tsx`, enveloppe `.hub-chat-panel` élargie (`clamp(360px, 42vw, 720px)`, redimensionnable en P2).
  En-tête : titre, machine, dossier, statut, tokens/coût, Stop / Background / Fermer / « Ouvrir sur la machine ».
- **D3. Timeline distante avec les vrais composants** — P0, L. `OpenCode.make({ baseUrl: …/hub/api/chat-tasks/<id> })`,
  `createClientConnection` sur A2, `createData({ omitToolFileData: false })`, `DataProvider` + `SessionTimeline` comme `chat.tsx:505-517`,
  `onNavigateToSession` pour les enfants, scroll collant factorisé depuis `chat.tsx:368-382`.
- **D4. Pile de sous-agents distants** — P2, S.
- **D5. `task-panel-machine.ts`** — P0, M. `loading | live | reconnecting | offline | ended | lost` avec attempt ids, `view(state)`,
  `Spinner` seulement quand l'agent travaille, `Loader` pour la connexion. Tests purs.
- **D6. Gardes Suspense** — P0, S.
- **D7. Section « Tasks » dans `chat-sidebar.tsx`** — P1, M. Tâches en cours de toutes les conversations, badges.
- **D8. Mobile** — P0, S. Overlay comme `chat-context-panel.css:115-125`, bouton retour, scrim, `data-scrollable`.
- **D9. i18n** — P0, S. `packages/app/src/hub/i18n/en.ts` (`chat.task.*`), anglais uniquement.
- **D10. `chat-machine-runs.ts`** — P1, S. Décoder `kind: "task"`.

## E. Interaction utilisateur depuis la sidebar

- **E1. Stop / Background** — P0, S.
- **E2. Message à la session distante** — P0, M. `HubComposer` en mode minimal ; Mod+Enter = steer comme l'app.
- **E3. Permissions et questions distantes** — P0, M. Supprimer `rejectPermissions` et le refus `question` (`:463`, `:549`). Réutiliser
  `session-permission-dock.tsx`, `session-question-dock.tsx`, `session-elicitation-dock.tsx` + `permission-machine.ts`, `question-machine.ts`.
  Badge « waiting ».
- **E4. Repli configurable** — P1, S. Rejet automatique après N minutes sans réponse, sinon statut `waiting`.
- **E5. Notifications** — P1, S. `chat-notify.ts` sur fin / échec / permission en attente.
- **E6. Inbox distante** — P2, S.

## F. Images et captures

- **F1. Rendu des fichiers de résultats d'outil** — P1, M (à vérifier). Aucun rendu de `Tool.FileContent`
  (`packages/schema/src/tool.ts:73-79`) dans `tool-renderer.tsx` : une capture Playwright renvoyée par un outil ne s'affiche nulle part.
  Galerie générique via `FileMedia`/`createImagePreview` (`components/file-media.tsx`). Package partagé : décision Q7.
- **F2. Médias par référence** — P0, S. `withMediaRefs` sur le client du panneau, `api/experimental/media/<hash>` autorisé dans B3.
- **F3. Captures vers le modèle hub** — P1, M. `machine_task_files` / `machine_task_image` (contenu MCP `image`, ≤ 5 Mo) ; lecture
  disque restreinte au `directory` de la tâche (route exacte à vérifier dans `groups/fs.ts`).
- **F4. Vignettes dans la conversation hub** — P1, M. Refs média dans la metadata de C2.
- **F5. Images utilisateur → `machine_task_send`** — P2, S.

## G. Tokens, coût, quotas

- **G1. Par tâche (relay)** — P0, M. `Message` étendu (`tokens`, `cost`), agrégation assistant + compaction + enfants, en continu via
  `session.usage.updated` / `session.step.ended`, stocké dans `chat_task`.
- **G2. Affichage** — P0, S. En-tête du panneau (`createChatUsage`, `ProgressCircle` de `chat-header.tsx:109`), sous-titre de la carte,
  « Tasks cost » dans `ChatSidePanel`.
- **G3. Mesure hub-wide dans le proxy LLM** — P2, L. Tee par famille (OpenAI `usage` + `stream_options.include_usage`, Anthropic
  `message_start`/`message_delta.usage`, Gemini `usageMetadata`), table `usage`, prix (étendre `catalog.ts`), routes `usage` / `admin/usage`.
- **G4. Quotas** — P2, M. 429 au proxy, refus de `machine_task`.

## H. Robustesse

- **H1. Reprise après redémarrage** — P0, M. Recharger les `chat_task` non terminées, réconcilier au `hello()` (`index.ts:750`),
  notifier si besoin ; supprimer `runs`/`failures` en mémoire.
- **H2. Machine offline pendant la tâche** — P0, M. Statut `offline`, reprise à la reconnexion, `lost` après délai.
- **H3. Reconnexion SSE navigateur** — P0, S. `onStatus` → D5, `message.sync` à chaque reconnexion.
- **H4. Tâches concurrentes** — P0, S. Plus de `runKey` unique (`:329-330`), limite par utilisateur.
- **H5. Nettoyage** — P1, S. Purge, suppression avec la conversation (`chat.ts:348`).
- **H6. Session distante disparue** — P1, S. Statut `lost` au lieu de la recréation silencieuse (`:303-307`, `:398-401`).

## I. Sécurité

- **I1. Tag des streams initiés par le hub** — P0, S. Bug latent confirmé (`index.ts:832` + `:604-613`). Tag dédié `hub-user:<id>`
  évalué avec `mayOpen(user, machine)`. Test.
- **I2. Isolation par tâche** — P0, S. Propriétaire + `mayOpen` à chaque appel, chemins B3 limités à la session de la tâche,
  aucune écriture en passthrough (`/shell`, `/command`, `/fs`, `/pty`).
- **I3. Pas de surface élargie dans l'engine** — P0, S. Outils limités à la conversation appelante ; réponses de permission journalisées.
- **I4. Médias / fichiers** — P1, S. Par hash référencé ; lecture bornée au `directory`.
- **I5. Limites** — P1, S. Taille d'événement, abonnés par tâche, watchers par utilisateur.
- **I6. Core/Protocol/Server non modifiés** — P0, S. Filtrage par session dans la relay, pas dans `/api/event`.

## J. Tests

- **J1. `packages/relay/test/chat-machines.test.ts`** — P0, M. Fixture SSE scriptable : démarrage async, filtrage, notification
  idempotente, stop, steer/queue, permissions, reprise après `Store.open`, offline, I1, autre utilisateur → 404.
- **J2. `chat.test.ts`** — P1, M. Handle `machine_task`, route `chat-tasks/*/api/*` fermée aux POST.
- **J3. App** — P0, S. `task-panel-machine.test.ts`, `chat-machine-runs` pour `kind: "task"`.
- **J4. Stories** — P1, S. Carte D1 et panneau D2 (pas d'e2e hub aujourd'hui, Q8).
- **J5. Tunnel** — P1, S. SSE long avec consommateur lent.

## K. Spec et documentation

- **K1. `specs/remote-machines.md`** — P0, M. Section « Hub chat » : engine, `chat_target`, `chat_task`, outils, routes, SSE,
  sécurité, reprise, coûts ; tables ; « Out of scope ».
- **K2. `specs/multi-users.md`** — P2, S.
- **K3. Commentaires d'en-tête** — P1, S. Cycle de vie d'une tâche et invariants.

---

## Ordre d'implémentation

1. **Phase 0, fondations relay** : B1, I1, A1, A2, A4, B4, B5, C2, G1, H1, H2, H4 ; J1.
2. **Phase 1, outils de l'agent hub** : C1, C3, C4, B6, I3 ; J2.
3. **Phase 2, sidebar** : B3, F2, D2, D3, D5, D6, D8, D9, D1, E1, E2, E3, H3, G2 ; J3.
4. **Phase 3, finitions UX** : C5, D7, D10, E4, E5, F1, F3, F4, H5, H6, I4, I5, A3, J4, J5, K1.
5. **Phase 4, hub-wide** : G3, G4, D4/A5, E6, K2.

## Décisions (validées par l'utilisateur)

- **Q1** `machine_task` asynchrone par défaut, `wait_seconds` optionnel borné.
- **Q2** Stopper la conversation hub ne stoppe pas les tâches ; bouton explicite « Stop all tasks ».
- **Q3** Notification de fin au modèle hub en `queue`.
- **Q4** Une session distante par tâche, avec `machine_task { continue: <task> }` pour réutiliser une session existante.
- **Q5** Oui : l'agent hub peut répondre aux permissions **et** aux questions de l'agent distant quand l'utilisateur lui a confié le
  pilotage (« pilote cette session »). L'utilisateur peut toujours répondre lui-même depuis la sidebar. Réponses journalisées et
  visibles dans la timeline. Sans délégation, les demandes attendent l'utilisateur (repli E4).
- **Q5 bis, à préparer sans tout livrer** : l'utilisateur veut ensuite des **modèles d'agent** (planification, implémentation,
  vérification de code…) définis par un prompt système, et que le chat hub enchaîne les tâches d'un agent à l'autre (récupérer la
  réponse, passer le relais). Le design ne doit pas l'empêcher : `machine_task` accepte dès maintenant un paramètre `agent?` (agent
  OpenCode de la machine, cf. `GET /api/agent`) et le résultat/handle est réutilisable comme entrée d'une tâche suivante.
- **Q6** La carte de tâche suffit dans la timeline hub ; la notification de fin reste pour le modèle mais s'affiche de façon compacte
  (rattachée à la carte).
- **Q7** Rendu des images de résultats d'outil dans `session-ui` partagé (profite aussi à l'app). Les images ne sont **envoyées à un
  modèle** (modèle hub via `machine_task_image`, ou agent distant) que si ce modèle supporte la vision (capacité du modèle,
  catalogue models.dev / `api/model`) ; sinon on transmet une description textuelle / la référence.
- **Q8** Pas de harnais e2e hub complet pour l'instant : tests unitaires relay + app, et une vérification manuelle/Playwright de l'UI.
- **Q9** D'abord l'agrégation par tâche (`step.ended` / messages) ; la mesure exacte dans le proxy LLM viendra ensuite. Quotas : plus tard.
- **Q10** Permission sans réponse : statut `waiting` + notification ; pas de rejet automatique par défaut (réglage optionnel).
