# Craft Queue

Craft en boucle / par lot avec arrêt auto quand les matériaux manquent, compteur exact,
chaînes de recettes auto-enchaînées, toggle de réactif niveau 2, et stats de crit de session.

Basé sur Endless Crafting (Bubble / TerableCoder).

Toutes les commandes commencent par `craft` (tape-les dans le chat en jeu, préfixe proxy habituel).

## Commandes

| Commande | Effet |
|---|---|
| `craft` | Démarre / arrête le craft en boucle (toggle). |
| `craft <N>` | Craft exactement N fois puis s'arrête. |
| `craft max` | Craft jusqu'à épuisement des matériaux (calcule le nombre de runs). |
| `craft stop` | Arrête immédiatement. |
| `craft learn <nom>` | Enregistre la prochaine recette craftée à la main sous ce nom (brique de chaîne). |
| `craft chain <a> <b> <c>` | Enchaîne des recettes apprises, dans l'ordre. |
| `craft steps` | Liste les recettes apprises. |
| `craft forget <nom>` | Supprime une recette apprise. |
| `craft reagent on\|off` | Active / coupe le réactif niveau 2 sur tous les crafts (nécessite calibrate). |
| `craft calibrate` | Apprend quel champ du paquet est le réactif (voir plus bas). |
| `craft stats` | Stats de session : crafts, crits, taux, détail par recette. |
| `craft stats reset` | Remet les stats de session à zéro. |
| `craft status` | État courant (on/off, chaîne, étape, PP, réactif). |
| `craft info` | Détail de la recette courante (résultat, matériaux, runs restants). |
| `craft pie` | Active / coupe la réapplication auto de Moongourd Pie. |
| `craft delay <ms>` | Délai entre deux crafts (0 = max vitesse). |
| `craft pp <lien item>` | Définit la potion de PP à consommer quand les points de production sont bas. |

## Setup : chaîne auto (preset de recettes)

Exemple ruby -> saphir -> émeraude -> diamant (chaque étape consomme la gemme précédente).

1. Apprends chaque recette une fois (craft-la à la main, puis nomme-la) :
   - crafte un ruby -> `craft learn ruby`
   - crafte un saphir -> `craft learn sapphire`
   - crafte une émeraude -> `craft learn emerald`
   - crafte un diamant -> `craft learn diamond`
   - vérifie avec `craft steps`
2. Lance la chaîne :
   ```
   craft chain ruby sapphire emerald diamond
   ```
   Chaque étape tourne jusqu'à épuisement de ses matériaux, puis passe auto à la suivante.
3. Limiter une étape à un nombre précis : suffixe `:N`
   ```
   craft chain ruby:50 sapphire emerald
   ```
   (50 rubys, puis saphirs et émeraudes jusqu'à épuisement.)

Les recettes apprises sont sauvées dans `data/steps.json` : tu n'as à les apprendre qu'une fois.
Une chaîne peut mélanger n'importe quelles recettes apprises, pas seulement des gemmes.

## Setup : réactif niveau 2 auto

Le toggle a besoin de savoir quel champ du paquet porte le réactif. Calibration une seule fois :

1. `craft calibrate`
2. Crafte la recette une fois **sans** réactif (le mod capture l'échantillon OFF).
3. Crafte la **même** recette une fois **avec** le réactif niveau 2 (échantillon ON).
   Le mod compare et annonce le champ détecté.
4. Ensuite :
   - `craft reagent on` -> applique le réactif niveau 2 à chaque craft, chaînes comprises.
   - `craft reagent off` -> coupe.

Une fois calibré, ça reste valable pour la session. Refais `craft calibrate` si rien n'est détecté.

## Stats de crit

- `craft stats` affiche, pour la session : total de crafts, total de crits, taux global,
  puis le détail par recette.
- `craft stats reset` repart de zéro.
- Les crits sont aussi comptés sur les crafts manuels, pas seulement la boucle.

## Points de production (PP)

- `craft pp <lien item>` : shift-clic ton item de cure dans le chat pour obtenir le lien,
  puis `craft pp <colle le lien>`. Le mod consomme la potion dès que les PP passent sous le seuil.
- Seuil et autres réglages dans `config.json` (`ppThreshold`, `delay`, `reUsePie`, `progressEvery`).

## Notes client Asura

- `S_FATIGABILITY_POINT` n'existe pas dans le protocole d'Asura par défaut : la def est fournie
  dans `data/definitions/S_FATIGABILITY_POINT.3.def`. Redémarre Toolbox complètement une fois
  pour que les PP soient lus (un simple `/reload` ne recharge pas les defs de protocole).
- Le mod détecte automatiquement la version de chaque paquet ; s'il en manque un, il l'ignore
  avec un warning au lieu de planter.
