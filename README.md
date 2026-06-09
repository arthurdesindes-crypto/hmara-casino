# HmaraCasino — Guide d'installation

## Ce que tu as dans ce dossier

| Fichier | Rôle |
|---|---|
| `server.js` | Le serveur principal (OAuth Discord, API) |
| `bot.js` | Le bot Discord (annonce les achats) |
| `public/index.html` | Page d'accueil avec bouton Discord |
| `public/casino.html` | Le casino complet |
| `.env` | Tes clés secrètes (à remplir !) |
| `package.json` | Les dépendances |

---

## Étape 1 — Remplis le fichier .env

Ouvre `.env` et remplace les valeurs :

```
DISCORD_CLIENT_ID=       ← ton Client ID (Discord Developer Portal)
DISCORD_CLIENT_SECRET=   ← ton Client Secret
DISCORD_BOT_TOKEN=       ← le token de ton bot
DISCORD_GUILD_ID=        ← clic droit sur ton serveur Discord > Copier l'identifiant
DISCORD_CHANNEL_ID=      ← clic droit sur le salon > Copier l'identifiant
SUPABASE_URL=            ← https://oupconjlbovrzobsbtsq.supabase.co
SUPABASE_SERVICE_KEY=    ← ta secret key Supabase
SESSION_SECRET=          ← invente une phrase longue au hasard
BASE_URL=                ← http://localhost:3000 (ou ton URL Railway)
```

## Étape 2 — Installer Node.js

Télécharge Node.js sur https://nodejs.org (version LTS)

## Étape 3 — Installer les dépendances

Ouvre un terminal dans le dossier hmara-casino et tape :
```
npm install
```

## Étape 4 — Lancer le serveur

Dans le terminal :
```
node server.js
```

Dans un 2ème terminal :
```
node bot.js
```

Puis ouvre http://localhost:3000 dans ton navigateur !

## Étape 5 — Mettre en ligne (Railway)

1. Crée un compte sur railway.app
2. "New Project" > "Deploy from GitHub repo"
3. Dans les variables d'environnement Railway, recopie toutes les lignes de ton .env
4. Mets BASE_URL = l'URL que Railway te donne (ex: https://hmara-casino.up.railway.app)
5. Retourne sur Discord Developer Portal > OAuth2 > Redirects > ajoute https://hmara-casino.up.railway.app/auth/callback

## Comment activer le bot sur ton serveur Discord

1. Va sur Discord Developer Portal > ton app > OAuth2 > URL Generator
2. Coche "bot" dans Scopes
3. Coche "Send Messages" dans Bot Permissions
4. Copie l'URL générée et ouvre-la dans ton navigateur
5. Ajoute le bot à ton serveur
