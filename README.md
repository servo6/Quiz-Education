# Plateforme de quiz – fondations (étape 1)

Contenu de cette étape :

- `prisma/schema.prisma` : schéma complet de la base (utilisateurs, matières, chapitres, questions, lots d'import, parties, manches, XP, titres, badges, avatars, paramètres, journal admin).
- `src/import/validate.ts` : lecture et validation du bloc de questions collé par l'administrateur.
- `src/app.ts`, `src/routes/*` : le serveur Fastify (authentification, matières, chapitres, import).
- `test/` : tests d'intégration sur un vrai schéma PostgreSQL temporaire.
- `src/permissions.ts` : rôles `USER`, `SUBJECT_MANAGER` (responsable de matière) et `ADMIN`, avec la fonction `can(acteur, action, matière)`.
- `src/xp.ts` : gains d'XP et calcul du niveau (`round(100 × n^1,2)`).
- `examples/questions-exemple.json` : exemple de bloc à importer.

## Démarrage (Supabase)

1. Crée un projet sur supabase.com. Retiens le mot de passe de la base.
2. Dans le projet : bouton **Connect**, puis copie la chaîne **Session pooler** (compatible IPv4).
   Si le mot de passe contient des caractères spéciaux, encode-les (`@` devient `%40`, `#` devient `%23`...).
3. Copie `.env.example` en `.env` et remplis `DATABASE_URL`, `JWT_SECRET` (32 caractères minimum),
   `ADMIN_USERNAME` et `ADMIN_PASSWORD`. Le serveur refuse de démarrer tant que les valeurs d'exemple sont présentes.
4. Installe et crée les tables :

```bash
npm install
npx prisma migrate dev --name init   # crée les tables dans Supabase
npm run db:rls                       # active la sécurité par ligne (RLS), à relancer après chaque migration
npm test                             # 149 tests, dans un schéma temporaire qt_xxxx supprimé à la fin
npm run dev                          # serveur sur http://127.0.0.1:3000
```

Au premier démarrage, le compte administrateur défini dans `.env` est créé s'il n'existe aucun administrateur.
Une fois connecté, retire `ADMIN_PASSWORD` du fichier `.env`.

### Pourquoi `npm run db:rls`

Supabase expose les tables du schéma `public` par une API REST publique. Sans RLS, quiconque possède la clé publique
du projet pourrait lire ou modifier les données. Le script active le RLS sur toutes les tables, sans politique :
l'API publique n'a plus accès à rien, tandis que le serveur (connexion directe à PostgreSQL) fonctionne normalement.

### SSL

La connexion est chiffrée. Pour que l'identité du serveur soit aussi vérifiée, télécharge le certificat racine
(Supabase > Database > Settings > SSL) et indique son chemin dans `DATABASE_SSL_CA`.

## Format d'import

```json
[
  {
    "question": "Quelle est la capitale de la France ?",
    "choices": ["Lyon", "Paris", "Marseille", "Lille"],
    "answer": 1,
    "explanation": "Optionnel."
  }
]
```

- `answer` = position de la bonne réponse, en partant de 0 (ici 1 = « Paris »).
- 2 à 6 choix, sans doublon ; aucun autre champ accepté.
- Jusqu'à 5000 questions par import (réglable).
- Un bloc entouré de ```json … ``` ou de la forme `{ "questions": [...] }` est accepté.
- Les questions valides sont importées même si d'autres contiennent des erreurs ; les doublons (dans le bloc ou déjà en base) sont ignorés.

## Rôles

| Rôle | Portée |
|---|---|
| `USER` | Joue, personnalise son avatar |
| `SUBJECT_MANAGER` | Pour les matières qui lui sont assignées (table `SubjectManager`) : chapitres, import et suppression de questions, paramètres de jeu de la matière, nom et mot de passe d'accès, liste et révocation des membres, journal de la matière |
| `ADMIN` | Tout, y compris création et suppression de matières, paramètres globaux, utilisateurs, assignation des responsables, badges, titres, avatars, sauvegardes |

Un responsable peut gérer plusieurs matières. Chaque route d'administration commence par `assertCan(acteur, action, matièreId)`.

## Routes disponibles

Toutes les réponses sont en JSON ; les erreurs ont la forme `{ "error": { "code", "message", "details"? } }`.
La session est un cookie `token` (httpOnly, SameSite=Lax).

| Route | Qui | Rôle |
|---|---|---|
| `POST /api/auth/register`, `/login`, `/logout` | tous | Inscription, connexion (10 essais par minute), déconnexion |
| `GET /api/me` | connecté | Profil, matières rejointes avec XP et niveau, matières gérées |
| `POST /api/subjects/join` | connecté | Rejoindre une matière (nom + mot de passe d'accès) |
| `POST /api/me/active-subject` | connecté | Changer de matière active |
| `GET /api/subjects`, `GET /api/subjects/:id` | admin, responsable | Matières gérées, paramètres effectifs |
| `POST /api/subjects` | admin | Créer une matière |
| `PATCH /api/subjects/:id` | admin ; responsable (accès, paramètres) | Renommer, changer l'accès, régler les paramètres |
| `PUT/DELETE /api/subjects/:id/managers/:userId` | admin | Assigner / retirer un responsable |
| `GET /api/users?q=` | admin | Chercher un utilisateur |
| `GET/PUT /api/settings` | admin | Paramètres globaux (`null` = retour au défaut) |
| `GET/POST /api/subjects/:id/chapters` | membres, responsable, admin (lecture) / responsable, admin (création) | Chapitres |
| `PATCH/DELETE /api/chapters/:id` | responsable, admin | Renommer, supprimer un chapitre et ses questions |
| `POST /api/subjects/:id/import/preview` | responsable, admin | Prévisualiser un import (ne modifie rien) |
| `POST /api/subjects/:id/import/commit` | responsable, admin | Importer (`partial` ou `all_or_nothing`) |
| `POST /api/chapters/:id/questions/delete-since` | responsable, admin | Supprimer les questions ajoutées depuis une date et heure |
| `DELETE /api/batches/:id` | responsable, admin | Annuler un import précis |
| `GET /api/subjects/:id/solo/status` | membre | Parties solo du jour (jouées, restantes) et partie en cours |
| `POST /api/solo/start` | membre | Lancer une partie `{ subjectId, chapterId }` (reprend la partie en cours s'il y en a une) |
| `GET /api/solo/:id/current` | joueur | Question en cours (le chronomètre démarre à la première consultation) |
| `POST /api/solo/:id/answer` | joueur | Répondre `{ gameQuestionId, choiceIndex }` ; renvoie la correction, l'XP et le niveau |
| `POST /api/solo/:id/abandon` | joueur | Abandonner (compte dans les parties du jour) |
| `GET /api/solo/:id/result` | joueur | Score, XP, niveau et revue des questions (partie terminée seulement) |

Corps d'un import : `{ "raw": "<bloc JSON>", "chapterId": "..." }` ou `{ "raw": "...", "newChapterName": "Atomes" }`.

## Choix techniques

- **Suppression douce** : chapitres, lots et questions supprimés restent en base avec `deletedAt` (corbeille). Un nettoyage définitif viendra plus tard.
- **Mots de passe** (comptes et accès aux matières) : scrypt, avec une vérification factice pour qu'un nom inconnu et un mauvais mot de passe soient indiscernables.
- **Client Prisma sans moteur Rust** (`engineType = "client"`) avec l'adaptateur `pg` (`src/db.ts`, `src/pgConfig.ts`).
- **Tests** : `test/schema.sql` est généré depuis `schema.prisma` par `npm run test:sql` (nécessite Python) ; chaque fichier de test crée son propre schéma PostgreSQL temporaire. `TEST_DATABASE_URL` permet d'utiliser une autre base que `DATABASE_URL`.
- **Pas encore fait** : suppression d'une matière, liste et révocation des membres par l'interface, jeu (solo, duels), XP en base, badges, avatars.

## Mode solo : règles

- Le joueur choisit un chapitre de sa matière ; les questions sont tirées au hasard dans ce chapitre, sans répétition.
  Si le chapitre en contient moins que `soloQuestions`, la partie utilise toutes ses questions.
- La bonne réponse n'est jamais envoyée avant que le joueur ait répondu. Le chronomètre est celui du serveur
  (marge de 1,5 s pour le réseau). Une réponse hors délai, ou une question laissée sans réponse, compte comme une erreur.
- +10 XP par bonne réponse (`xpPerCorrect`), propres à la matière. Les paramètres sont copiés au lancement :
  les modifier pendant une partie ne la change pas.
- `soloGamesPerDay` : une partie compte dès son lancement, abandonnée ou non ; 0 = illimité. Le jour commence à minuit
  heure de Paris. Lancer une partie alors qu'une autre est en cours reprend celle-ci.
- Il faut être membre actif de la matière (l'administrateur doit aussi la rejoindre pour y jouer).

## Duel amical en temps réel

Un duel oppose deux membres **de la même matière** (4 manches × 4 questions par défaut, réglable). Il passe par Socket.IO
(même cookie `token` que l'API ; connexion refusée sans session valide).

**Règles**
- Le défi est envoyé à un joueur en ligne ; il a 60 s pour accepter. Un joueur ne peut être que dans un duel à la fois.
- **Tour de rôle** : celui qui a lancé le défi choisit le chapitre des manches 1 et 3, l'adversaire celui des manches 2 et 4.
  Seuls les chapitres de la matière (avec des questions) sont proposés. Sans choix au bout de `chapterPickSec` (20 s), le serveur en tire un.
- Les deux joueurs reçoivent les mêmes questions en même temps. Le temps par question vient des paramètres (0 = illimité → 60 s en duel).
  La correction est envoyée quand les deux ont répondu ou que le temps est écoulé ; la bonne réponse n'est jamais envoyée avant.
- XP : +10 par bonne réponse ; victoire +40 ; match nul +20 chacun.
- Déconnexion : `reconnectSec` pour revenir (l'état est renvoyé). Passé ce délai : forfait, l'adversaire gagne +40.
  Forfait avant la fin de la première question, ou deux absents : partie abandonnée, aucun bonus.
- Redémarrage du serveur : les duels en cours sont marqués abandonnés (le moteur tourne dans un seul processus).

**API** : `GET /api/subjects/:id/players?q=` (adversaires possibles, niveau, en ligne, occupé).

**Événements client → serveur** (avec accusé `{ok:true}` / `{ok:false,error:{code,message}}`) :
`duel:challenge {subjectId, opponentId}`, `duel:respond {challengeId, accept}`, `duel:cancel`,
`duel:pick {gameId, chapterId}`, `duel:answer {gameId, gameQuestionId, choiceIndex}`, `duel:forfeit {gameId}`, `duel:resume`.

**Serveur → client** : `duel:invited`, `duel:challenge_declined|expired|cancelled`, `duel:started`, `duel:pick_chapter`,
`duel:round_started`, `duel:question`, `duel:opponent_answered`, `duel:reveal`, `duel:opponent_status`, `duel:state`, `duel:finished`.

## Duel différé (mode principal)

Chacun joue quand il veut ; tout est en base (rien en mémoire, le serveur peut redémarrer).

```
A : manche 1                  (A choisit le chapitre en lançant le défi)
B : manche 1, puis manche 2   (B choisit le chapitre de la manche 2)
A : manche 2, puis manche 3   (A choisit le chapitre de la manche 3)
B : manche 3, puis manche 4   (B choisit le chapitre de la manche 4)
A : manche 4                  → fin
```

- Le défi démarre la partie immédiatement (pas d'acceptation). Un seul duel en cours entre deux mêmes joueurs dans une matière.
- La manche est ouverte par celui qui choisit le chapitre ; l'autre la joue une fois que l'ouvreur l'a terminée. Mêmes questions pour les deux.
- Délai : `duelDeadlineDays` (3 par défaut, réglable globalement ou par matière) depuis le défi. Passé ce délai, le duel est clôturé
  automatiquement (au démarrage du serveur, toutes les 5 minutes, et dès qu'on le consulte) : le plus de bonnes réponses gagne,
  égalité = match nul, les manches non jouées comptent pour zéro. Personne n'a répondu : abandonné, sans bonus.
- XP : +10 par bonne réponse (au moment de répondre), victoire +40, nul +20 chacun. Abandon volontaire : l'adversaire gagne +40 s'il a répondu à au moins une question.
- Le chronomètre par question est propre à chaque joueur, côté serveur (table `QuestionServe`).
- Le score adverse d'une manche n'est visible qu'une fois la manche jouée par les deux ; le total, qu'à la fin.

| Route | Rôle |
|---|---|
| `POST /api/duels` `{subjectId, opponentId, chapterId}` | Lancer un défi |
| `GET /api/subjects/:id/duels` | Mes duels (+ nombre à jouer) |
| `GET /api/duels/:id` | Détail : manches, prochaine action (`play` / `pick` / `wait` / `done`), chapitres proposés |
| `POST /api/duels/:id/pick` `{chapterId}` | Choisir le chapitre de ma manche |
| `GET /api/duels/:id/current` | Question en cours |
| `POST /api/duels/:id/answer` `{gameQuestionId, choiceIndex}` | Répondre |
| `POST /api/duels/:id/forfeit` | Abandonner |
| `GET /api/duels/:id/result` | Résultat et revue (duel terminé) |

Le duel en direct (Socket.IO) reste disponible comme second mode.

## Titres, badges, avatar, classement, membres

**Titres** (par niveau) : Novice 1, Apprenti 5, Initié 10, Confirmé 20, Expert 30, Maître 40, Légende 50 par défaut.
`GET/PUT /api/tiers` (globaux, admin), `GET/PUT/DELETE /api/subjects/:id/tiers` (surcharge par matière). Le titre apparaît dans
`/api/me`, le classement et les profils. Un jeu de titres doit contenir le niveau 1 et pas de doublon de niveau.

**Badges** (globaux, créés au premier démarrage) : types `CORRECT_TOTAL`, `PERFECT_SOLO`, `FRIENDLY_WINS`, `PERFECT_DUEL`,
`STREAK_DAYS` (jours consécutifs, fuseau configuré), `SUBJECTS_PLAYED`, `FAST_STREAK` (réponses justes en moins de 5 s d'affilée).
Attribués à la fin d'une partie solo, à la fin d'une manche ou d'un duel différé (champ `newBadges` de la réponse), et à chaque
lecture de `GET /api/me/badges` (progression + nouveaux badges). Les duels en direct sont pris en compte à la lecture suivante.
Administration : `GET/POST /api/badges`, `PATCH/DELETE /api/badges/:id`.

**Avatar** : `GET /api/avatar/items` (catalogue avec `unlocked` / `lockReason`), `PUT /api/me/avatar {items:{hair:id,…}, colors:{skin:"#RRGGBB"}}`.
Déblocage `FREE`, `LEVEL` (meilleur niveau toutes matières), `BADGE` (code), `TIER` (nom de titre). Administration :
`POST /api/avatar/items`, `PATCH/DELETE /api/avatar/items/:id`. Les fichiers graphiques (`assetPath`) viendront avec l'interface.

**Classement et statistiques** : `GET /api/subjects/:id/leaderboard?limit=` (rang, égalités au même rang, votre rang),
`GET /api/subjects/:id/stats` (réussite globale, par mode, par chapitre, duels gagnés/nuls/perdus, XP par source),
`GET /api/subjects/:id/players/:userId` (profil d'un membre : niveau, titre, badges, bilan face à face).

**Membres et comptes** : `GET /api/subjects/:id/members`, `POST …/members/:userId/revoke` (clôt ses duels différés en cours,
conserve son XP) et `…/restore` (admin ou responsable de la matière ; un responsable ne peut pas agir sur un admin ou un autre responsable) ;
`POST /api/users/:id/ban`, `/unban`, `/reset-password {newPassword}` (admin).

## Suppression d'une matière et journal

- `DELETE /api/subjects/:id` avec le corps `{"confirmName":"<nom exact de la matière>"}` (administrateur) : supprime **définitivement**
  chapitres, questions, lots, parties, réponses, XP, titres, adhésions et responsabilités de la matière. Les comptes, les badges et les
  autres matières ne sont pas touchés ; un responsable qui n'a plus de matière redevient utilisateur. Refusé (409) si un duel en direct est en cours.
  Le nom d'accès peut ensuite être réutilisé. Une ligne `DELETE_SUBJECT` (nom et effectifs supprimés) reste dans le journal.
- `GET /api/logs?subjectId=&action=&adminId=&limit=&cursor=` : l'administrateur voit tout, un responsable uniquement ses matières.
  Résultats du plus récent au plus ancien ; `nextCursor` donne la page suivante.

## Compléments serveur

**Nouveaux paramètres** (globaux ou par matière, `PUT /api/settings` / `PATCH /api/subjects/:id`) :
`duelDeadlineDays` (3), `maxActiveDuels` (10 duels différés simultanés par joueur et par matière, 0 = illimité),
`shuffleChoices` (false) : mélange l'ordre des choix, différemment pour chaque joueur (solo, duels différés et directs).
Avec le mélange, tous les indices échangés avec l'API (`choices`, `choiceIndex`, `correctIndex`, revue) sont dans l'ordre **affiché** ;
la base conserve la position d'origine. À éviter si des questions contiennent « toutes les réponses ci-dessus ».

**Duels différés en plus** : `POST /api/duels/:id/rematch {chapterId}` (revanche), `POST /api/subjects/:id/duels/random {chapterId}`
(adversaire au hasard), `GET /api/me/summary` (duels à jouer, `expiresSoon` à moins de 24 h, parties solo en cours).
Événements Socket.IO poussés aux joueurs connectés : `duel:challenged`, `duel:turn {action:"play"|"pick"}`, `duel:ended`.

**Gestion des questions** (administrateur ou responsable de la matière) :
`GET /api/chapters/:id/questions?q=&deleted=no|only|all&cursor=&limit=` (avec taux de réussite par question),
`PATCH /api/questions/:id` (texte, choix, réponse, explication, ou déplacement vers un autre chapitre),
`DELETE /api/questions/:id` et `POST /api/questions/:id/restore`, `GET /api/chapters/:id/batches`,
`POST /api/batches/:id/restore`, `POST /api/chapters/:id/restore`, `GET /api/subjects/:id/trash`,
`POST /api/subjects/:id/trash/purge {olderThanDays}` (définitif ; les questions déjà jouées sont conservées),
`GET /api/subjects/:id/export?chapterId=` (même format que l'import, ré-importable).

**Comptes et administration** : `POST /api/me/password`, `PUT /api/users/:id/role {role:"USER"|"ADMIN"}`,
`GET /api/users?q=&role=&banned=&limit=&cursor=`, `GET /api/admin/overview`, `GET /api/admin/export` (sauvegarde logique sans aucun secret).

**Interface web** : si un dossier `public/` contenant `index.html` existe à la racine du projet, le serveur le sert (fichiers statiques,
et repli sur `index.html` pour les adresses internes). En-têtes `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` ;
les réponses `/api/` ne sont jamais mises en cache.

**À savoir** : les duels en direct gardent leur état en mémoire (un seul processus serveur). Pour une vérification stricte du certificat
de la base, renseigner `DATABASE_SSL_CA`. `npm audit` signale des alertes sans correctif compatible : `prisma`/`deepmerge-ts`
(outil de développement uniquement), `@fastify/static`/`glob` (non exploitable : aucun motif fourni par un utilisateur) et `zod`
(les corps de requête sont limités en taille ; le passage à zod 4 est une migration à part).

## Interface web

Lance `npm run dev` puis ouvre http://localhost:3000 (jamais le fichier `index.html` directement). L'interface est dans `public/`
(HTML, CSS et JavaScript sans étape de compilation ; un nouveau fichier est servi sans redémarrer).

**Joueurs** : connexion/inscription, rejoindre une matière, accueil (niveau, titre, rang), solo (choix du chapitre puis questions chronométrées),
duels différés (défi, manches, abandon, résultat, revanche), duels en direct (invitation, choix du chapitre à tour de rôle, questions simultanées),
classement avec profil et bilan face-à-face, profil (statistiques, badges, avatar, mot de passe). Les notifications arrivent via Socket.IO.

**Administration** (bouton « Admin » pour l'administrateur et les responsables de matière) :
questions (import avec vérification, chapitres, modification, suppression par question / import / date, export JSON), corbeille,
membres (révocation, responsables), réglages de la matière et accès, journal ; pour l'administrateur : comptes (suspension, mot de passe, rôle,
vue d'ensemble, sauvegarde), réglages globaux, journal global, titres, badges, objets d'avatar, matières.

**Avatars personnalisés** : mets l'image (SVG/PNG carré) dans `public/avatars/`, puis crée l'objet dans Admin > Avatars avec le fichier « avatars/nom.svg ».
Elle est dessinée par-dessus l'avatar.

## Thèmes et administrateur

- **Thèmes** : 13 thèmes (`public/css/themes.css`). L'administrateur choisit le thème de la plateforme dans *Administration › Apparence* et peut autoriser ou non chaque joueur à choisir le sien dans son profil. Pour ajouter un thème : un bloc `[data-theme="mon-theme"]` dans `themes.css`, une entrée dans `THEMES` (`public/js/theme.js`) et dans `src/routes/theme.ts`.
- **L'administrateur n'est pas un joueur** : il n'est membre d'aucune matière, n'apparaît ni au classement, ni dans les listes d'adversaires ou de membres, et ne peut ni jouer en solo ni défier. Il dispose uniquement de l'interface d'administration, avec son propre menu de panneaux.
