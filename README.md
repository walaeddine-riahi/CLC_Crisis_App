# CLC Crisis App V4.0 — Next.js + MongoDB

Application collaborative de pilotage du PCA Inondations CLC. Cette version conserve le cockpit décisionnel V3.0.2 et remplace Supabase par une API Next.js sécurisée connectée à MongoDB Atlas.

## Fonctionnalités dynamiques

- Authentification serveur avec cookie de session HTTP-only.
- Premier compte créé automatiquement comme administrateur si la base est vide.
- Persistance MongoDB par sections métier versionnées.
- Rôles : `ADMIN`, `GROUP_CRISIS`, `SITE_CLC`, `SITE_CF`, `ACTION_OWNER`, `DG`, `VIEWER`.
- Contrôle des droits d'écriture côté API.
- Fusion à trois voies et verrouillage optimiste pour limiter les écrasements concurrents.
- Synchronisation automatique toutes les 4 secondes et mode local dégradé.
- Présence des utilisateurs connectés et journal d'audit.
- Création de comptes depuis le panneau « Temps réel » pour le rôle Administrateur.
- Tableau de bord Administration réservé au rôle `ADMIN` : création et modification des comptes, rôles, activation, réinitialisation des mots de passe et révocation des sessions.
- Journal d’audit administrateur filtrable : connexions, échecs, déconnexions, gestion des comptes, initialisation et modifications des sections métier.
- Interface historique complète : météo, terrain, actions PCA, sites, journal, cockpit et vues DG.
- Vigilance INM officielle récupérée automatiquement pour Nabeul toutes les 15 minutes (statut, phénomènes, période et source), avec conservation sécurisée de la dernière donnée et péremption automatique « À revalider » ; elle agit sur la posture sans modifier le score terrain.

## Démarrage local

1. Copier `.env.example` vers `.env.local` et renseigner `MONGODB_URI`.
2. Installer les dépendances : `npm install`.
3. Lancer : `npm run dev`.
4. Ouvrir `http://localhost:3000`.
5. Sur une base vide, saisir l'e-mail et un mot de passe d'au moins 10 caractères : ce premier compte devient administrateur.

## Déploiement Vercel

Configurer les variables suivantes dans Vercel pour Production, Preview et Development :

```text
MONGODB_URI=<connexion MongoDB Atlas>
MONGODB_DB=clc_crisis
CLC_WORKSPACE_CODE=DELICE-INONDATIONS
```

Dans MongoDB Atlas, autoriser les connexions depuis Vercel dans **Network Access**. Pour une mise en service interne, restreindre ensuite la plage réseau selon l'architecture retenue et faire tourner le mot de passe transmis pendant le développement.

Vercel détecte automatiquement Next.js. La commande de build est `npm run build`.

## Architecture

- `public/crisis.html` : interface décisionnelle complète.
- `public/mongo-collab.js` : synchronisation navigateur/API et mode dégradé.
- `app/api/auth/session` : connexion, session et déconnexion.
- `app/api/inm` : lecture serveur de la vigilance officielle INM pour Nabeul.
- `app/api/collab/bootstrap` : chargement et initialisation du workspace.
- `app/api/collab/section` : lecture et écriture versionnée des sections.
- `app/api/collab/presence` : présence des utilisateurs.
- `app/api/admin/users` : administration sécurisée des comptes et rôles.
- `app/api/admin/logs` : consultation administrateur paginée et filtrée des journaux d’audit.
- `lib/mongodb.ts` : connexion mutualisée MongoDB Atlas.
- `lib/auth.ts` : hash `scrypt`, sessions opaques et cookies sécurisés.
- `lib/inm.ts` : extraction contrôlée du statut, des dates et des phénomènes INM.

## Sécurité

- Ne jamais préfixer `MONGODB_URI` par `NEXT_PUBLIC_`.
- `.env.local` est exclu de Git.
- Les mots de passe utilisateurs sont hachés avec `scrypt` et un sel aléatoire.
- Le cookie d’authentification est limité à la session du navigateur. Les sessions serveur expirent aussi automatiquement après sept jours via un index TTL MongoDB.
- Faire tourner l'identifiant MongoDB de test avant une utilisation de production.
