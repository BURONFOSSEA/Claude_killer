# 🎯 Claude_killer : application web de Killer

Application pour organiser des parties de **Killer**. Chaque joueur reçoit secrètement une cible et un défi.
Pour « tuer » sa cible, il doit lui faire réaliser le défi sans qu'elle s'en rende compte. La victime transmet
alors sa cible et son défi à son tueur, jusqu'au dernier survivant.

**100 % gratuit** : le site est hébergé par **GitHub Pages**, et le serveur (base de données, sécurité,
notifications, IA) tourne sur **Supabase** (offre gratuite).

```
 Navigateur ──► GitHub Pages (site : web/)
     │
     └──────► Supabase Edge Function « api » ──► Postgres Supabase
                (supabase/functions/)        ├─► notifications push (Web Push)
                                             ├─► e-mails (Brevo)
                                             └─► IA (Claude)
```

## Mise en ligne (une seule fois, ~15 minutes)

### 1. Rendre le dépôt public
GitHub Pages n'est gratuit que pour les dépôts publics : **Settings → General → Danger Zone → Change
visibility → Public**. Aucun secret n'est stocké dans le code : ils restent dans les réglages GitHub et Supabase.

### 2. Créer le projet Supabase
1. Sur https://supabase.com/dashboard, cliquez sur **New project** (offre *Free*), région *West EU (Paris)*.
   Notez le mot de passe de la base, même s'il ne sera pas utilisé ici.
2. Récupérez l'**identifiant du projet** (*Project ID / Reference ID*) : **Project Settings → General**.
   C'est la suite de lettres présente dans l'adresse `https://<identifiant>.supabase.co`.
3. Créez un **jeton d'accès** sur https://supabase.com/dashboard/account/tokens → **Generate new token**.

Les tables sont créées automatiquement au premier démarrage : il n'y a pas de SQL à exécuter.

### 3. (Facultatif) E-mails avec Brevo
1. Créez un compte gratuit sur https://www.brevo.com (300 e-mails par jour).
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender** : ajoutez votre adresse et validez le lien reçu.
3. **SMTP & API → API Keys → Generate a new API key**.

### 4. Ajouter les secrets dans GitHub
**Settings → Secrets and variables → Actions → New repository secret** :

| Secret | Valeur | Obligatoire |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | le jeton de l'étape 2.3 | ✅ |
| `SUPABASE_PROJECT_REF` | l'identifiant du projet (étape 2.2) | ✅ |
| `ADMIN_PASSWORD` | le mot de passe de l'espace organisateur (identifiant : `admin`) | ✅ |
| `BREVO_API_KEY` | la clé API Brevo | pour les e-mails |
| `MAIL_FROM` | l'expéditeur validé dans Brevo, ex. `Killer <vous@exemple.fr>` | pour les e-mails |
| `ANTHROPIC_API_KEY` | une clé API Claude (https://console.anthropic.com) | pour l'IA |

### 5. Activer GitHub Pages
**Settings → Pages → Build and deployment → Source : GitHub Actions**.

### 6. Déployer
Chaque push sur `main` déploie automatiquement la fonction Supabase puis le site (onglet **Actions**,
workflow *Déploiement*). Vous pouvez aussi le lancer à la main : **Actions → Déploiement → Run workflow**.

Le site est ensuite disponible sur **https://&lt;votre-compte&gt;.github.io/Claude_killer/**
(espace organisateur : `admin.html`).

> Le mot de passe admin n'est utilisé qu'à la **création** du compte. Pour le changer ensuite, passez par
> l'interface (bouton « Mot de passe »).

## Fonctionnalités

### Espace organisateur (identifiant et mot de passe)
- Créer, modifier et supprimer des parties (nom, contexte, date de fin prévue).
- Joueurs : ajout en liste (`Alice ; alice@exemple.fr ; adore le café`), noms, e-mails et infos privées
  modifiables. Chaque joueur a un **code personnel**, avec un lien direct à copier et une fiche des codes imprimable.
- Défis : saisie à la main, modification, suppression.
- **IA (Claude)** : propose des défis adaptés au contexte, et **qui tue qui** (une seule boucle, avec un défi
  adapté à chaque duo et une justification). Sans clé : bibliothèque de 50 défis et tirage aléatoire.
- Suivi en direct : boucle complète, kills à valider ou refuser, défi modifiable en cours de partie, retrait
  d'un joueur (son tueur hérite de sa cible), journal des éliminations, classement, fin de partie.

### Espace joueur (code personnel)
- Ne voit **que sa cible et son défi**, masqués tant qu'il ne tape pas dessus.
- Chrono depuis le début, compte à rebours jusqu'à la fin prévue.
- « J'ai éliminé ma cible » : la cible confirme ou conteste, et l'organisateur peut trancher.
- Statistiques personnelles. **Jamais le nombre de joueurs restants** ; le classement n'est révélé qu'à la fin.

### Notifications (push + e-mail)

| Événement | Qui est prévenu |
|---|---|
| Lancement de la partie | tous les joueurs |
| Kill déclaré | la cible (pour confirmer ou contester) |
| Kill validé | le tueur (nouvelle cible) et la victime |
| Kill contesté ou refusé | le tueur |
| Joueur retiré par l'organisateur | le joueur retiré et son chasseur (nouvelle cible) |
| Défi modifié | le joueur concerné |
| Fin de partie | tous les joueurs (message spécial pour le vainqueur) |

Les messages **ne révèlent jamais la cible ni le défi**. Le push fonctionne sur Android, sur ordinateur, et sur
iPhone (iOS 16.4+) **après « Sur l'écran d'accueil »**. Les clés VAPID sont générées automatiquement.

## Sécurité
- Les tables Supabase ont la sécurité RLS activée **sans aucune règle** : rien n'est lisible avec la clé
  publique. Toutes les données passent par la fonction serveur, qui ne renvoie à un joueur que ses propres données.
- Mots de passe hachés (PBKDF2), jetons de session aléatoires stockés hachés, limitation des tentatives de
  connexion, accès à l'API restreint à l'adresse du site (CORS).

## Développement local

Prérequis : Node.js 22.13+. La base est **PGlite** (Postgres embarqué), rien d'autre à installer.

```bash
npm install
npm run dev     # http://localhost:3000 (identifiant admin, mot de passe affiché dans la console)
npm test
```

Variables utiles (fichier `.env`, voir `.env.example`) : `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`,
`BREVO_API_KEY`, `MAIL_FROM`.

## Structure

```
web/                         # site statique (GitHub Pages)
supabase/functions/
├── api/index.ts             # point d'entrée de l'Edge Function (Deno)
└── _shared/                 # code serveur commun (Edge Function + serveur local)
    ├── app.js               # routes de l'API
    ├── game.js              # boucle, kills, héritage des cibles, vues
    ├── auth.js              # mots de passe, sessions, limitation
    ├── notify.js            # push + e-mail
    ├── ai.js                # intégration Claude + mode hors-ligne
    └── db.js                # schéma Postgres
dev/server.js                # serveur local (Node + PGlite)
.github/workflows/           # déploiement, tests, maintien en activité de Supabase
```
