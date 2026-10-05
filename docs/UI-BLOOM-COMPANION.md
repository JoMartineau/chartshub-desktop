# Bloom personnalisable — panneau natif du Companion

Cette modification raccorde le bloom au vrai panneau `companion/ui/index.html`
de l'application à onglets, sans ajouter un éditeur ChartsHub Studio.
Le bouton « Bloom de l’interface » apparaît dans l’en-tête du Companion.

## Utilisation

Activer le bloom, choisir une couleur avec le sélecteur natif, un code HEX
(3 ou 6 chiffres) ou les trois valeurs RVB. Six couleurs rapides sont proposées.
Intensité et opacité : 0–100 %. Rayon de diffusion : 0–24 px. Flou : 0–80 px.
Le mode économique utilise un seul halo, avec flou et diffusion réduits.
L’effet reste désactivé par défaut.

L’aperçu est immédiat et ne provoque aucune écriture. Appliquer attend la
confirmation du processus principal. Une erreur ne devient jamais un message
« enregistré ». Annuler, Fermer ou Échap rétablit le dernier choix appliqué.
Réinitialiser reste un aperçu jusqu’à Appliquer. Pendant une sauvegarde,
les contrôles de fermeture sont bloqués pour éviter une annulation trompeuse.
Le raccourci de sortie du plein écran existant reste prioritaire dans la coque ;
le comportement des dialogues en plein écran fait partie de la recette Electron.

## Persistance et sécurité

Les préférences sont enregistrées dans `userData/companion/ui-bloom.json`.
Ce fichier distinct est conservé entre les redémarrages de l’application.
La session Electron `companion-local` reste éphémère : aucun cookie, compte
ou autre stockage de session n'est rendu persistant par cette fonctionnalité.
Le réglage est local au profil de l’application sur cet ordinateur, partagé
entre les comptes utilisant ce même profil, et non synchronisé avec le site.

Le processus principal valide les champs, couleurs et bornes. Seul le
WebContents exact du Companion attaché à la coque, sa frame principale,
son URL locale exacte et un accès Companion encore autorisé peuvent lire ou
écrire ce réglage. Aucun chemin de fichier ni canal IPC libre n’est exposé.
Une seule opération est acceptée à la fois. La fermeture attend une écriture
acceptée. Les fichiers sont écrits dans un temporaire privé puis renommés ;
les fichiers invalides sont conservés jusqu’à une action explicite et les
liens symboliques de destination sont refusés.

Le preload attend le signal d’attachement de la coque avant d’injecter les
assets locaux : le panneau peut finir son chargement avant son attachement.
Le rechargement de la vue réactive ce signal sans dupliquer les contrôles.
Les protections `sandbox`, `contextIsolation`, CSP et navigation sont conservées.

## Portée visuelle

Les règles CSS ciblent uniquement les cartes de premier niveau et l’en-tête
sous `#companion-app`, ainsi que l’échantillon du dialogue. Elles ne modifient
ni les notes, ni les couleurs d’accent, ni les aperçus de widgets, ni les
mini-widgets/overlays, ni ReShade. Les couleurs forcées désactivent le halo.
Aucune animation permanente, aucun appel réseau, aucun ajout de dépendance.
Les commandes du dialogue sont disponibles en français et en anglais.

## Vérifications effectuées pendant la préparation

`node --test tests/ui-bloom-native.test.js tests/ui-bloom-shell.test.js`

19 tests ciblés réussis sous Node 22.16 : modèle et validation, persistance
réelle sur disque avec nouvelle instance du stockage, fichiers invalides,
liens symboliques (Linux), erreurs, filtrage IPC, déconnexion, concurrence,
fermeture, injection preload et raccordement à la vraie coque avec objets
Electron simulés. Vérification de syntaxe réussie pour les fichiers modifiés.

17 contrôles DOM Chromium réussis sur une page en mémoire avec le pont natif
simulé : aperçu, HEX/RVB invalides, Appliquer/Annuler/Échap/Réinitialiser,
restauration, erreurs, mode économique, widget inchangé, langues, largeur de
720 px et couleurs forcées. Le chargement ESM/CSP du protocole natif n’a PAS été
testé par ces contrôles DOM. Ce n’est pas un essai de l’application compilée.

## Avant fusion et diffusion

- Exécuter `npm ci` puis `npm test` avec Node 24 dans l’environnement du projet.
- Ouvrir la vraie application et vérifier le chargement des modules sous le
  protocole local, la CSP, l’injection du preload et les dialogues/plein écran.
- Appliquer une couleur, fermer complètement l’application, la relancer et
  vérifier sa restauration dans le panneau du Companion.
- Vérifier changement d’onglet, déconnexion/reconnexion, nouvelle ouverture du
  Companion, erreurs d’écriture et absence d’effet sur mini-widgets/ReShade.
- Tester les distributions Windows, macOS et Linux avant publication.

Aucun changement de `main`, du numéro de version ou du workflow de publication.
Aucun déploiement serveur et aucun retrait de maintenance.

Références : documentation officielle Electron, « Using Preload Scripts »,
« Process Sandboxing », `webContents` ; MDN, `HTMLDialogElement`.
