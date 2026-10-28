# Suivixo

Suivi des séries de la médiathèque de Servon-sur-Vilaine : quels tomes sont où, ce qui manque, ce qu'il faut acheter. Trois collections, au choix en haut du site :

- **Mangas** : tout le réseau (Châteaugiron, Domloup, Noyal-sur-Vilaine, Ossé, Piré-Chancé, Servon-sur-Vilaine, St-Aubin du Pavail), avec AniList, Manga-News et la BnF ;
- **BD jeunesse** et **Romans jeunesse** : Servon seulement, avec la BnF. Les titres uniques (romans, albums) peuvent être masqués dans les filtres.

Suivixo remplace le classeur Excel « MangaV2-3 » (créé par Erick Bagliniere) par un site web, sans macros.

**Site :** https://mediatheque-ssv.github.io/Suivixo/

## Ce que fait le site

- **Séries** : chaque série apparaît comme une rangée de tranches. Une tranche pleine est un tome présent dans ta médiathèque, une tranche tramée est un tome présent ailleurs dans le réseau, un contour rouge est un tome paru mais absent du réseau, et un pointillé est un tome pas encore paru en France. Le statut reprend celui de l'Excel : Finie, À compléter, À continuer, En attente.
- **À acheter** : tomes absents de tout le réseau, tomes absents de ta médiathèque mais disponibles ailleurs, exemplaires perdus ou à remplacer, tomes à paraître. Export en tableur et impression.
- **Prêts** : séries les plus empruntées (au total ou par exemplaire), réservées en ce moment, lecteurs qui continuent ou s'arrêtent après le tome 1, séries qui sortent le moins, prêts par genre et par médiathèque. Pour sa médiathèque ou pour tout le réseau, avec export en tableur. Ces chiffres restent dans le navigateur où l'export Orphée a été importé.
- **Contrôles** : commandes arrivées, nouvelles séries, exemplaires sans numéro de tome, séries à relier, etc.
- **Importer** : on dépose l'export Excel d'Orphée. Le fichier est lu dans le navigateur et n'est envoyé nulle part.

## D'où viennent les infos

| Info | Source | Mise à jour |
|---|---|---|
| Tomes présents dans chaque médiathèque | Export Orphée | À chaque import |
| Prêts, emprunts, réservations | Export Orphée | Restent dans le navigateur de la personne qui importe, jamais publiés |
| État de l'édition française (terminée, en cours, abandonnée), dernier tome paru, prochain tome annoncé, tomes en VO | Fiche de la série sur [Manga-News](https://www.manga-news.com) (la page indiquée dans la série, sinon celle du jeu de données) | Chaque lundi pour les séries en cours, tous les 3 mois pour les terminées (une page toutes les 2 secondes) |
| État de la série au Japon, nombre de tomes en VO (secours) | [AniList](https://anilist.co) | Chaque lundi (GitHub Actions) |
| Tomes parus en France et date du dernier | [Catalogue général de la BnF](https://catalogue.bnf.fr) (dépôt légal), sous Licence Ouverte | Chaque lundi |
| Tomes parus en France (deuxième source) | [Jeu de données Manga-News sur data.gouv.fr](https://www.data.gouv.fr/datasets/manga-news), sous licence ODbL | Chaque lundi |
| Couvertures françaises | Manga-News, sinon Decitre, la BnF ou ePagine (d'après l'ISBN de la notice BnF), sinon [Open Library](https://openlibrary.org) ; à défaut, couverture VO d'AniList | Une fois par série (nouvel essai tous les 6 mois si aucune) |
| Genre, public, commandes, commentaires, liens | Saisis dans Suivixo (repris de l'ancien Excel) | À la main |

L'état de l'édition française vient d'abord de la fiche Manga-News ; sans fiche, il est déduit d'AniList et de la BnF. Le nombre de tomes parus en France retenu est le plus grand entre la BnF, Manga-News et les exemplaires du réseau (un tome présent dans une médiathèque est forcément paru) ; si la fiche Manga-News dit la série terminée en France, son nombre de tomes fait foi. Les données dérivées de Manga-News dans `data/enrich.json` sont sous licence ODbL.

Quand les sources se trompent (édition française différente, série arrêtée par l'éditeur…), on peut forcer le nombre de tomes parus et l'état dans la fiche de la série.

## Publier des modifications

Les modifications (import, fiches) sont d'abord enregistrées sur le poste. Pour les partager avec l'équipe, il faut une clé d'accès GitHub, à créer une seule fois :

1. Se connecter à GitHub avec le compte **mediatheque-ssv**.
2. Aller sur https://github.com/settings/personal-access-tokens/new
3. Accès : *Only select repositories* → **suivixo**. Permissions : **Contents** et **Actions** → **Read and write** (Actions permet de lancer la vérification des parutions depuis le site).
4. Copier la clé dans Suivixo, bouton « Réglages » en haut à droite.

La clé reste dans le navigateur. Les collègues qui consultent seulement n'en ont pas besoin.

## Organisation du dépôt

```
index.html, assets/        le site (HTML, CSS, JavaScript sans compilation)
assets/core.js             la logique : lecture d'Orphée, rattachement des titres, statuts
data/series.json           mangas : les séries et ce qui est saisi à la main
data/fonds.json            mangas : le dernier import Orphée publié (tomes par médiathèque)
data/enrich.json           mangas : les infos AniList, Manga-News et BnF (écrit par la vérification automatique)
data/bd/, data/romans/     les mêmes fichiers pour la BD et les romans jeunesse
couvertures/               les couvertures françaises (couvertures/bd/, couvertures/romans/ pour les autres collections)
scripts/enrich.py          la vérification automatique des parutions
scripts/seed_from_excel.mjs  la migration depuis l'ancien Excel (déjà faite)
.github/workflows/         la vérification planifiée du lundi
```

## Maintenance

- Tests de la logique : `npm install` puis `npm test`.
- Lancer la vérification des parutions à la main : onglet **Actions** → « Vérifier les parutions » → *Run workflow*. Le champ « Tester une seule série » affiche le détail pour une série sans rien enregistrer.
- Le site est servi par GitHub Pages depuis la branche `main`, à la racine (*Settings* → *Pages* → *Deploy from a branch*). Il se met à jour tout seul après chaque publication et chaque vérification des parutions.
