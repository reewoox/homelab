# 🏠 Homelab

Dashboard façon Homarr, accessible de partout.

- **Site** : hébergé gratuitement sur GitHub Pages (dossier `docs/`)
- **Base de données + API** : tournent sur ton PC (`server/`, SQLite dans `server/data/`, jamais envoyé sur GitHub)
- **Accès distant** : tunnel Cloudflare gratuit ; son adresse est publiée automatiquement dans `docs/config.json`

```
Navigateur ──► GitHub Pages (site)  ──►  https://xxx.trycloudflare.com  ──►  ton PC :7575 (API + SQLite)
```

## Démarrer

```powershell
# lancer à la main (fenêtre ouverte)
powershell -ExecutionPolicy Bypass -File scripts\start-homelab.ps1

# OU : démarrage automatique à chaque connexion Windows
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
Start-ScheduledTask -TaskName Homelab

# arrêter
powershell -ExecutionPolicy Bypass -File scripts\stop-homelab.ps1
```

En local tu peux aussi ouvrir directement http://localhost:7575.

## Fonctionnalités

- Connexion / inscription (le **premier compte créé devient admin**)
- Inscriptions : ouvertes, sur validation admin (par défaut) ou fermées
- Apps rangées par catégories, glisser-déposer en mode édition ✏️
- Icônes automatiques ([dashboard-icons](https://github.com/homarr-labs/dashboard-icons)), URL d’image ou emoji
- Pastille verte/rouge : le PC vérifie chaque minute si l’app répond
- Widgets : horloge, météo (Open-Meteo), CPU / RAM / disques du PC
- Recherche (`/`), export / import des apps en JSON
- Gestion des utilisateurs (valider, désactiver, admin, supprimer)

## Sécurité

- Mots de passe hachés (scrypt), sessions signées HMAC (30 jours)
- Anti brute-force sur la connexion et l’inscription
- Changer de mot de passe déconnecte les autres sessions
- La base `server/data/` est dans `.gitignore`

## Adresse fixe (optionnel)

L’adresse `trycloudflare.com` change à chaque redémarrage (le site suit tout seul, ~1 min).
Pour une adresse fixe, ajoute un domaine sur Cloudflare et crée un *named tunnel*, puis mets son URL dans `docs/config.json`.
