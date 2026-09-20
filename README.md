# Pyramid

Petite app mobile de gestion de bankroll **par paliers** : tu pars d'une mise, tu la joues, et à
chaque palier gagné tu rejoues **l'intégralité du gain** sur le palier suivant, jusqu'à atteindre
ton objectif.

- Tu saisis la **mise de départ** et l'**objectif**.
- À chaque palier, tu entres la **cote** du pari puis tu appuies sur **Gagné** ou **Perdu**.
- L'app calcule le montant à rejouer, la progression vers l'objectif, l'historique des paliers et
  le compteur de tentatives. Tout est sauvegardé sur le téléphone, ça marche hors ligne.

Zéro dépendance, zéro build : du HTML, du CSS et du JavaScript.

## Lancer sur ton téléphone

### 1. Activer GitHub Pages (une seule fois)

1. Sur GitHub, ouvre **Settings → Pages** du dépôt.
2. Dans **Build and deployment**, choisis **Deploy from a branch**.
3. Branche `main`, dossier `/ (root)`, puis **Save**.
4. Après une minute environ, l'app est en ligne sur :
   `https://ldjelouah.github.io/Pyramid/`

### 2. Ajouter à l'écran d'accueil

- **iPhone (Safari)** : ouvre l'URL, bouton **Partager** → **Sur l'écran d'accueil**.
- **Android (Chrome)** : ouvre l'URL, menu **⋮** → **Ajouter à l'écran d'accueil** (ou
  **Installer l'application**).

L'app s'ouvre alors en plein écran comme une app native.

## Lancer en local

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Les trois écrans : paramètres, partie en cours, fin. |
| `styles.css` | Design mobile-first, thème sombre et clair automatique. |
| `app.js` | Logique des paliers, persistance `localStorage`, service worker. |
| `manifest.webmanifest` | Rend l'app installable (PWA). |
| `sw.js` | Cache des fichiers pour le hors ligne. |
| `icons/` | Icône de l'app (SVG + PNG 192 et 512). |
