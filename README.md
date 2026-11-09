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

## Apps intégrées

| App | À quoi ça sert |
|---|---|
| 📁 **Drive** | Tes fichiers sur le PC depuis tous tes appareils : envoi (glisser-déposer, gros fichiers par morceaux), aperçu photos/vidéos/PDF, dossiers, déplacer, liens de partage publics. Espace perso + dossier « Commun ». Stocké dans `~/HomelabDrive`. |
| 📋 **Presse-papiers** | Copie un texte/lien sur ton téléphone, récupère-le sur le PC (et inversement). Épingler, historique. |
| 🤖 **Assistant IA** | Chat avec tes modèles Ollama locaux, réponses en direct, discussions synchronisées entre appareils. |
| 📊 **Moniteur** | CPU/RAM sur 1 h, disponibilité de chaque app sur 24 h, journal de sécurité (connexions, échecs, partages). |

## Apps locales accessibles de partout (Tailscale)

Coche **🌐 Accessible de partout** sur une app locale (`http://localhost:…`, `192.168.x.x`) :
le serveur crée automatiquement une adresse `https://ml.tail76e554.ts.net:100XX` avec `tailscale serve`
(visible uniquement par tes appareils Tailscale). Hors de chez toi, la tuile ouvre cette adresse.
Le homelab lui-même est aussi sur `https://ml.tail76e554.ts.net:10000`.
Les ports 10000-10999 sont gérés par le homelab ; ta config existante (port 443) n'est jamais modifiée.

Mode édition → **🔍 Détecter mes services** : scanne le PC et propose d'ajouter les services trouvés.

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
