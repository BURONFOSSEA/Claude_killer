# 🎯 Claude_killer — application web de Killer

Application pour organiser des parties de **Killer** : chaque joueur reçoit secrètement une cible et un défi.
Pour « tuer » sa cible, il doit lui faire réaliser le défi sans qu'elle s'en rende compte. La victime transmet
alors sa cible et son défi à son tueur… jusqu'au dernier survivant.

## Démarrage rapide

Prérequis : **Node.js 22.13 ou plus récent** (la base SQLite est intégrée à Node, rien d'autre à installer).

```bash
cd Claude_killer
npm install
cp .env.example .env      # puis renseignez ADMIN_PASSWORD (et ANTHROPIC_API_KEY pour l'IA)
npm start                 # http://localhost:3000
```

- Joueurs : `http://localhost:3000/jouer`
- Organisateur : `http://localhost:3000/admin`

Sans `ADMIN_PASSWORD`, un mot de passe est généré au premier démarrage et affiché dans la console.
Il peut ensuite être changé depuis l'interface.

## Fonctionnalités

### Espace organisateur (protégé par identifiant + mot de passe)
- Créer / modifier / supprimer des parties (nom, contexte, date de fin prévue).
- Gérer les joueurs : ajout en masse (un par ligne), édition des noms, infos privées (« Alice ; adore le café »).
  Chaque joueur reçoit un **code personnel** ; lien direct copiable et fiche des codes imprimable.
- Gérer les défis : saisie manuelle, édition, suppression.
- **IA (Claude)** :
  - propose des défis adaptés au contexte de la partie (vous choisissez ceux à garder) ;
  - propose **qui tue qui** : une boucle unique tenant compte des infos sur les joueurs, avec un défi adapté
    à chaque duo et une justification.
- Tirage aléatoire sans IA, réordonnancement de la boucle, modification de chaque défi avant lancement.
- Suivi en direct : boucle complète, kills en attente (valider / refuser), modification d'un défi en cours,
  retrait d'un joueur (son tueur hérite de sa cible), journal des éliminations, classement, fin de partie.

### Espace joueur (code personnel)
- Ne voit **que sa cible et son défi** (masqués tant qu'on ne tape pas dessus, anti-regard indiscret).
- Chrono depuis le début de la partie et compte à rebours jusqu'à la fin prévue.
- Bouton « J'ai éliminé ma cible » → la cible confirme ou conteste (l'organisateur peut trancher).
- Statistiques personnelles : kills, temps de survie, kill le plus rapide, temps moyen, victimes,
  « dernière élimination dans la partie il y a… ».
- **Jamais le nombre de joueurs restants.** Le classement complet n'est révélé qu'à la fin.

## IA

L'IA utilise l'API Claude (`@anthropic-ai/sdk`, modèle `claude-opus-5-5` par défaut, modifiable avec
`ANTHROPIC_MODEL`). Les réponses sont demandées au format JSON structuré, puis vérifiées côté serveur
(la boucle proposée doit passer une seule fois par chaque joueur). Le repli serveur (`fallbacks: "default"`)
est activé : si une requête est refusée par un filtre de sécurité, l'API la rejoue sur un modèle de repli.

Sans clé `ANTHROPIC_API_KEY`, ou en cas d'erreur, l'application bascule automatiquement en mode hors-ligne :
bibliothèque de 50 défis intégrée et tirage aléatoire.

## Sécurité
- Mots de passe hachés (scrypt), sessions par cookie `HttpOnly` / `SameSite=Lax` (`COOKIE_SECURE=true` derrière HTTPS).
- Limitation des tentatives de connexion, requêtes modifiantes en JSON uniquement (anti-CSRF), en-têtes CSP.
- Le serveur ne renvoie à un joueur que ses propres données : la boucle complète reste côté organisateur.

## Tests

```bash
npm test
```

## Structure

```
Claude_killer/
├── server.js               # API Express + pages statiques
├── src/
│   ├── db.js               # schéma SQLite
│   ├── auth.js             # mots de passe, sessions, limitation
│   ├── game.js             # boucle, kills, héritage des cibles, vues
│   ├── ai.js               # intégration Claude + mode hors-ligne
│   └── challenge-library.js
├── public/                 # interface (HTML/CSS/JS sans framework)
└── test/
```

## Déploiement

Toute plateforme capable d'exécuter Node.js avec un disque persistant (Render, Railway, Fly.io, un VPS…) :
`npm install && npm start`, en définissant les variables de `.env.example` et en pointant `DATABASE_PATH`
vers un volume persistant.
