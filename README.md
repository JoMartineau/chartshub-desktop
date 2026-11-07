# ChartsHub Desktop

Application de bureau pour https://chartshub.ca : téléchargement des charts dans le dossier choisi, sans la restriction du navigateur sur `song.ini`.

Le **Tableau de bord** (**Dashboard** en anglais) regroupe les outils de l’ancien Companion. Son accueil résume la session ; les onglets existants, profils et réglages sont conservés. Le chat Twitch/TikTok, la recherche des demandes introuvables et les nouveaux flux OBS sont décrits dans le [guide des demandes](docs/SONG-REQUESTS.md). Quick Import reste une [option BÊTA](docs/QUICK-IMPORT.md), distincte des téléchargements habituels.

## Utilisation

Ouvrez le catalogue comme visiteur ou connectez-vous avec votre compte ChartsHub. Choisissez Télécharger dans le catalogue, ou Télécharger pour vérification dans l'administration si vous avez les droits nécessaires. L'application demande le dossier de destination, vérifie la taille de chaque fichier et son empreinte SHA-256 lorsqu'elle est fournie, puis y déplace la chart complète. Les droits sont contrôlés par le serveur. La limite totale est de 2 Go.

Le site doit disposer de l'intégration `ChartsHubDesktop`. L'application nécessite Internet et conserve la session de connexion sur cet ordinateur. Aucun mot de passe, jeton administrateur ou code du serveur n'est inclus dans ce dépôt.

## Développement

Dans **Tableau de bord → État**, consultez les connexions, la bibliothèque, le partage public, OBS, les mises à jour et les téléchargements au même endroit. Les boutons ouvrent les réglages correspondants sans lancer d’opération.

Si ChartsHub retrouve une mise à jour complètement téléchargée après un redémarrage, ouvrez **Réglages → Mises à jour → Vérifier et reprendre**. La version officielle et l’archive sont contrôlées de nouveau avant que vous choisissiez d’installer. Les archives incomplètes ne sont pas reprises automatiquement.

Le Tableau de bord 0.12 ajoute un assistant qui télécharge ReShade depuis son site
officiel et propose un pack Curves, MagicHDR et Technicolor2. Le panneau
et le widget contrôlent aussi vos effets existants. Voir [les instructions ReShade](docs/RESHADE.txt).

La version 0.12.1 retire les plafonds de taille de la bibliothèque locale et
des associations : le scan complet et la pagination prennent en charge les
grandes collections, avec conservation du dernier index en cas d’interruption.
Le pont natif se compile avec `reshade-bridge/build.ps1` ; le moteur classique
indépendant reste disponible via `native-filters/build.ps1`. Les deux binaires
sont nécessaires avant de construire la distribution Windows x64.

Node.js 24 et npm sont nécessaires.

```sh
npm ci
npm test
npm start
```

## Versions téléchargeables

Les archives sont disponibles sur [GitHub Releases](https://github.com/JoMartineau/chartshub-desktop/releases). Le workflow `Desktop release` teste et compile Windows x64, Linux x64, macOS Intel et macOS Apple Silicon sur leurs systèmes respectifs. Une modification des sources sur `main` lance ce workflow : il publie la version correspondant à `package.json` après la réussite des quatre compilations, avec les empreintes SHA-256 des archives et le statut `Latest` pour l’affichage sur le dépôt. Une version déjà publiée conserve ses archives et son tag ; il faut augmenter le numéro de version pour distribuer un nouveau paquet.

Les pull requests vers `main` exécutent les mêmes tests et compilations et produisent des artefacts suffixés `-candidate`. Elles ne créent ni release ni tag, et leur exécution n’annule pas une compilation de `main`. La publication reste réservée à `main` et exige les notes `docs/RELEASE-<version>.md`.

### Version 0.14.47

Le widget flottant des demandes peut afficher un fond transparent. Le fond uni reste disponible pour l’incrustation couleur. [Notes 0.14.47](docs/RELEASE-0.14.47.md).

### Version 0.14.46

ChartsHub retrouve la langue choisie à chaque ouverture. Le Catalogue et le Tableau de bord partagent ce réglage. L’espagnol du Mexique, le chinois simplifié et le japonais sont disponibles en aperçu de traduction. [Notes 0.14.46](docs/RELEASE-0.14.46.md).

### Version 0.14.45

La synchronisation compare les fichiers de Songs pour reconnaître les copies identiques et traiter les mises à jour. Le nettoyage de la bibliothèque charge les résultats au défilement. Le rapport Clone Hero permet de sélectionner toutes les erreurs admissibles par lot. [Notes 0.14.45](docs/RELEASE-0.14.45.md).

### Version 0.14.44

Synchronisez le catalogue ChartsHub dans Songs avec analyse préalable, reprise et vérification des fichiers identiques. Un panneau de bibliothèque permet aussi de préparer jusqu’à 1 000 charts par lot pour la corbeille, avec filtres par artiste ou album et confirmation explicite. [Notes 0.14.44](docs/RELEASE-0.14.44.md).

### Version 0.14.43

Le classement de ChartsHub peut comptabiliser les téléchargements terminés depuis l’application. [Notes 0.14.43](docs/RELEASE-0.14.43.md).

### Version 0.14.42

Quick Import permet de retirer MelonLoader d’une installation reconnue de Clone Hero sur Linux ou macOS en déplaçant le chargeur dans un dossier de sauvegarde. [Notes 0.14.42](docs/RELEASE-0.14.42.md).

### Version 0.14.41

Quick Import propose un assistant Windows pour choisir le jeu et son dossier Songs, vérifier MelonLoader et installer le module facultatif. Le tableau de bord permet aussi de masquer ou d’afficher le terminal de MelonLoader au prochain lancement du jeu. [Notes 0.14.41](docs/RELEASE-0.14.41.md).

### Version 0.14.40

Le panneau Batterie / VST conserve une marge intérieure autour des textes et des commandes, y compris dans une petite fenêtre. Quick Import affiche les étapes de première installation de MelonLoader et ouvre directement ses fichiers d’installation sur demande. Aucune installation ni connexion ne démarre depuis ce guide. [Notes 0.14.40](docs/RELEASE-0.14.40.md).

### Version 0.14.39

La lecture d’une manette déjà démarrée reste active après fermeture des réglages de l’Input Viewer. Les options de suivi des charts permettent d’afficher le widget au début, de le masquer à la fin et de remettre les compteurs à zéro avec le module facultatif. La capture des fenêtres Clone Hero corrige aussi son autorisation vidéo et attend une première image avant d’annoncer un aperçu actif. [Notes 0.14.39](docs/RELEASE-0.14.39.md).

### Version 0.14.38

Le catalogue flottant affiche des cartes plus compactes et les pochettes ChorusEncore disponibles. La recherche se lance après une courte pause de frappe ; Entrée ou Rechercher restent immédiats. Les charts ChartsHub restent téléchargeables après un changement de bibliothèque, avec vérification au moment de l’ajout. [Notes 0.14.38](docs/RELEASE-0.14.38.md).

### Version 0.14.37

**Intégrations Clone Hero · BÊTA** regroupe Quick Import, Accuracy et les paroles synchronisées, avec une seule installation MelonLoader partagée. Chaque fonction reste indépendante et désactivée à l’ouverture de ChartsHub. Un diagnostic à la demande vérifie la version exacte du jeu, le chargeur, le module et les prérequis avant l’installation. Compatibilité validée : **Clone Hero 1.1.0.6142-final Stable · Windows x64**. [Notes 0.14.37](docs/RELEASE-0.14.37.md) · [Installation et retrait du module des widgets](game-widgets-mod/README.md).

Le catalogue distingue maintenant la maintenance du site d’une limite de recherche ChorusEncore : la recherche peut être relancée après la réouverture du site, sans conserver une attente artificielle. Les limites réellement imposées par le service sont respectées.

L’Input Viewer propose des compteurs par bouton, une remise à zéro manuelle et, avec le module des widgets actif, des options d’affichage au début du morceau et de remise à zéro à sa fin. Le correctif VST rétablit les mises à jour de l’éditeur et permet d’annuler une ouverture restée en attente. [Guide Input Viewer](docs/INPUT-VIEWER.md).

### Version 0.14.36

**Quick Import · BÊTA** propose l’ajout des nouvelles charts téléchargées sans scan complet, avec une connexion facultative et des étapes numérotées. Compatible et testé avec **Clone Hero 1.1.0.6142-final Stable sous Windows x64**, avec module Quick Import et MelonLoader. Les autres versions ne sont pas validées. L’option reste désactivée au démarrage ; les téléchargements et les autres widgets fonctionnent sans elle. [Guide](docs/QUICK-IMPORT.md) · [Notes 0.14.36](docs/RELEASE-0.14.36.md).

### Version 0.14.35

Le nouvel espace **Batterie / VST** permet de jouer un instrument VST3 x64 sous Windows avec une batterie MIDI, un contrôleur XInput ou des pads à cliquer. MT Power Drum Kit peut être préparé depuis son éditeur après accord explicite de sa licence. Choisissez votre sortie et vos mappings, puis démarrez le son. Pour OBS, capturez le son de ChartsHubDrumHost.exe. [Guide Batterie / VST](docs/DRUMS-VST.md). [Notes 0.14.35](docs/RELEASE-0.14.35.md).

### Widgets et sorties conservés

Les widgets du morceau se règlent séparément pour Jeu et Stream. Les widgets ordinaires ne nécessitent pas MelonLoader ; Accuracy et les paroles synchronisées utilisent le module facultatif décrit ci-dessus. L’assistant de calibration reste retiré de la version publique. Stream / OBS fournit aussi des captures recadrées de la highway, du score et des paroles réellement affichées par le jeu : choisissez sa fenêtre puis démarrez explicitement la capture. Le fond reste présent dans chaque zone ; la séparation transparente des éléments natifs est indisponible. La vidéo du morceau et le texte des paroles locales nécessitent une horloge de jeu compatible pour se synchroniser. Un Input Viewer personnalisable pour guitare et batterie propose une détection Windows XInput, douze styles, six effets de trails, cymbales, étoile Star Power, couleurs indépendantes et alignement sur une grille dont l’aimantation peut être désactivée. Son éditeur opaque explique l’association des touches ; un widget compact se place au-dessus du jeu et une source Navigateur OBS utilise un lien dédié. Il fonctionne sans accès aux données du jeu. [Mode d’emploi](docs/INPUT-VIEWER.md). [Notes et limites de la version](docs/RELEASE-0.14.34.md).

### Version 0.14.8

Cette version améliore le passage au morceau suivant, la lecture vidéo avec ses proportions originales et le plein écran, les marges et le défilement automatique du lecteur Songs. Les playlists, Song Request, widgets personnalisables et le nettoyage sûr des doublons restent disponibles. [Notes complètes de la version](docs/RELEASE-0.14.12.md).

Le centre de notifications du compte, les profils de charters et le preview néon dans le catalogue principal sont partagés avec le site et nécessitent le déploiement de ChartsHub **1.8.3**. Le nouveau preview préserve les cinq couleurs de notes, distingue normale/HOPO/TAP et conserve les pads, cymbales et kick violet. Il n’est pas embarqué dans l’archive Desktop ni dans le mini Catalogue flottant.

### Doublons

Choisissez explicitement la version à conserver, puis cochez individuellement les copies à envoyer à la Corbeille. Aucune copie n'est cochée par défaut. Le récapitulatif indique les chemins et tailles sélectionnés ; la confirmation Windows est obligatoire et propose Annuler par défaut. La version conservée et les copies non cochées restent en place. Le choix de version est mémorisé entre les sessions.

Le nettoyage vérifie les identités et l'état de tous les fichiers depuis le scan, compare leurs contenus puis les revérifie avant l'appel natif à la Corbeille. Les changements, liens/jonctions, chemins hors du dossier Songs sélectionné et cibles ambiguës bloquent le nettoyage. Un ancien index doit être rescanné avant de permettre une suppression. Aucun recours à une suppression définitive n'est autorisé.

Dépliez « Comparer les fichiers » pour consulter les notes, l’audio, les illustrations et les autres fichiers : identiques, modifiés ou présents dans une seule version, avec leurs tailles. Un fichier non vérifié reste signalé comme tel. Les différences des conteneurs SNG sont également affichées ; ce détail ne donne aucune autorisation supplémentaire de suppression.

Le bouton « Arrêter la vérification » interrompt la vérification globale et conserve les résultats des groupes terminés. La vérification peut ensuite être relancée ; le choix des versions conservées reste enregistré.

L’historique indique la date, la version gardée et le résultat de chaque copie sélectionnée : envoyée à la Corbeille, échec ou non tentée. Il est conservé dans le profil Tableau de bord après redémarrage et affiche uniquement le dossier Songs actif. La rétention est limitée aux 200 derniers nettoyages et à 2 Mio ; les annulations avant confirmation ne créent aucune entrée. Une erreur d’enregistrement est signalée sans modifier le résultat réel du nettoyage. La restauration des copies reste accessible dans la Corbeille Windows.

Validation : `npm test` et `npm run test:companion:duplicates -- <dossier-de-resultats>`. Le test Electron utilise uniquement des Songs synthétiques isolés ; les fenêtres de confirmation et l'appel Corbeille sont interceptés. Le reste du flux (interface, IPC, worker, vérification et persistance) est réel. Le workflow PR « Tableau de bord duplicate safety » exécute les deux suites sur Windows.

### Catalogue flottant

Le panneau Catalogue du Tableau de bord peut s’ouvrir dans une petite fenêtre au-dessus du jeu. Le raccourci `Ctrl+Maj+K` sous Windows (`Commande+Maj+K` sous macOS) affiche ou masque cette fenêtre lorsque la session ChartsHub est active. Déplacez-la par sa barre de titre ; le bouton Fermer ou `Échap` la masque sans arrêter les téléchargements.

Les onglets Recherche, Téléchargements et Récents permettent de chercher par titre, artiste ou charter, d’affiner par instrument ou difficulté, puis de suivre la progression. La recherche se lance après une courte pause de frappe à partir de deux caractères ; Entrée et Rechercher la lancent immédiatement. Chaque ajout à la file exige un clic ; choisissez explicitement le dossier de destination avant de télécharger. Pause, reprise, annulation et nouvelle tentative restent disponibles dans la file. Après l’installation de nouvelles chansons, utilisez Quick Import si vous l’avez activé ou lancez **Scan Songs** dans Clone Hero.

Le volet Apparence propose couleur de fond, transparence, couleur du texte, police et taille. L’aperçu reste local jusqu’à « Enregistrer ». Les réglages du Catalogue et du panneau Filtres sont indépendants et conservés après redémarrage dans `companion/floating-panels.json`. Le bouton des valeurs par défaut prépare un aperçu à enregistrer ; il ne modifie pas les widgets de jeu.

Utilisez Clone Hero en mode fenêtré ou sans bordures : l’affichage au-dessus d’un jeu en plein écran exclusif n’est pas garanti. Si une autre application réserve le raccourci, le panneau reste accessible depuis le Tableau de bord.

Validation : `npm test` et `npm run test:companion:catalogue-widget -- <dossier-de-resultats>`. Le test Electron utilise un catalogue local et des téléchargements simulés dans un dossier Songs isolé ; il couvre recherche, file, fermeture, langue et persistance de l’apparence. Le workflow Windows « Tableau de bord duplicate safety » publie son rapport JSON et ses captures comme artefacts. Une réussite de ces tests ne remplace pas un essai visuel au-dessus de Clone Hero.

### Notifications du compte et alertes natives

Les résultats des nouveaux téléchargements du Catalogue et du Tableau de bord sont enregistrés pour le compte qui les a lancés. Le centre partagé avec le site permet de filtrer les notifications lues/non lues, de supprimer une notification déjà lue ou toutes les lues, sans supprimer les non lues, et d’ajuster les catégories proposées : téléchargements, compte, annonces, nouveautés du catalogue et événements sociaux.

Les alertes natives de téléchargement suivent ces préférences. « Suspendre les alertes Windows quand Clone Hero est détecté » garde le centre actif tout en évitant les alertes du bureau lorsque le processus du jeu est présent ou que sa présence ne peut pas être vérifiée. Cela ne détecte pas précisément le début d’un morceau. Un clic sur une alerte ouvre le centre ; une déconnexion ou un changement de compte invalide les événements encore en attente. Aucun chemin ou nom de fichier local n’est envoyé dans ces résumés.

### Version 0.14.7

- Le bouton « Supprimer quand même » est maintenant disponible pour une copie entièrement vérifiée ayant les mêmes notes, même si l’audio ou certains fichiers non audio diffèrent.
- Les copies avec audio absent/non vérifié, notes différentes, cible dangereuse, format non pris en charge ou contenu modifié après vérification restent bloquées.
- La suppression reste explicitement manuelle, avec confirmation renforcée Windows et Corbeille uniquement.

### Version 0.14.6

- Dans Doublons, une copie dont seul l’audio diffère peut maintenant être supprimée manuellement avec « Supprimer quand même ».
- Cette action n’est jamais présélectionnée : les notes et tous les fichiers non audio doivent être strictement identiques, l’audio des deux versions doit être vérifié et la cible doit rester sûre dans Songs.
- Une confirmation Windows renforcée rappelle l’audio différent avant l’envoi à la Corbeille. La version conservée reste protégée et aucune suppression définitive n’est utilisée.

### Version 0.14.5

- Dans Doublons, choisir « Conserver cette version » lance automatiquement la vérification des autres copies du groupe.
- Les copies sûres sont présélectionnées ; le bouton devient « Supprimer l’autre version » ou « Supprimer les X autres versions ».
- Les copies dont l’audio ou les fichiers sont différents, absents ou non vérifiés restent bloquées et ne peuvent pas être envoyées à la Corbeille.
- La version conservée reste protégée et la confirmation Windows est toujours obligatoire avant tout déplacement vers la Corbeille.

### Version 0.14.4

- Correction de la localisation English du Tableau de bord : les états dynamiques Clone Hero, ReShade et Filtres suivent maintenant complètement la langue choisie.
- Les messages natifs comme « En attente d’un morceau », « Pont installé » et les états de préparation ReShade sont traduits sans redémarrage.
- Les contenus utilisateur (titres, artistes, charters, chemins et noms de profils) restent inchangés.

### Version 0.14.3

- Le Tableau de bord suit automatiquement la langue Français / English choisie sur ChartsHub et bascule sans redémarrage.
- Les fenêtres natives du Tableau de bord, les nombres et les dates suivent aussi la langue sélectionnée ; les titres de chansons, artistes, charters, chemins et noms de profils restent inchangés.
- La Bibliothèque locale peut vérifier l’audio et le contenu de tous les groupes de doublons détectés en une seule opération, avec progression et statut par groupe.
- La vérification globale ne supprime rien automatiquement : le choix de la version à garder, la sélection des copies, la revalidation finale et la Corbeille Windows restent obligatoires.

### Version 0.14.2

- Navigation Compte/Catalogue/Tableau de bord stabilisée : Tableau de bord reste visible pendant la revalidation du même compte.
- Les changements réels de session, déconnexions et échecs de vérification continuent de retirer immédiatement l’accès Tableau de bord.
- Les indicateurs de chargement des onglets gardent une largeur fixe pour éviter les déplacements visuels.

### Version 0.14.1

- Panneau **Thème** dans le Tableau de bord : bloom optionnel, couleur HEX/RVB, intensité, rayon, flou, opacité et mode économique.
- Réglages du bloom enregistrés dans un fichier local dédié ; restauration après redémarrage. Aucun effet sur les notes, mini-widgets ou ReShade.
- Le catalogue annonce explicitement sa disposition à onglets pour éviter un espace ou un chevauchement de la barre de menu. Le correctif du site est compatible avec la version 0.14.0.
- Les couleurs du bloom du site et du Tableau de bord restent indépendantes. La couleur d’accentuation du site est conservée dans son panneau Thème.
- Mise à jour du programme uniquement : les profils, widgets et fichiers de chansons existants doivent être conservés.

### Version 0.14.0

- Le catalogue et le Tableau de bord partagent la même fenêtre, avec deux onglets pour passer de l’un à l’autre.
- Un compte ChartsHub ordinaire permet d’ouvrir le Tableau de bord. Les outils d’administration et de modération restent réservés aux comptes autorisés ; une déconnexion retire l’accès au Tableau de bord.
- Les réglages des widgets, les dispositions, les associations de la bibliothèque et les préférences restent enregistrés localement sur cet ordinateur. Ils ne sont pas enregistrés dans le compte ChartsHub et ne suivent pas une connexion sur un autre appareil.
- Les profils d’overlay et le verrouillage des widgets sont inclus. La bibliothèque travaille en arrière-plan et ne fixe plus de plafond de chansons ; la comparaison des doublons permet de choisir les copies identiques à envoyer à la Corbeille après confirmation.
- Sous Windows x64, l’assistant installe ReShade depuis sa source officielle et propose trois effets optionnels : Curves, MagicHDR et Technicolor2. Il conserve les presets existants. Le moteur classique de filtres reste également disponible.
- Les archives Windows incluent les deux modules compilés et les notices MinHook, ReShade et nlohmann/json. La CI utilise Zig 0.14.1, téléchargé depuis ziglang.org et vérifié par SHA-256 avant compilation.

Cette version conserve le statut expérimental des précédentes publications. Les fonctions ReShade et les filtres natifs sont propres à Windows x64 ; leur présence n’est pas annoncée comme prise en charge sur macOS ou Linux.

### Version 0.1.14

- Messages français précisant pourquoi une archive R2 ne peut pas être téléchargée : import non terminé, archive indisponible, version modifiée ou blocage antivirus. Les détails privés du serveur restent masqués.
- Le téléchargement natif conserve le dossier d’exportation et les vérifications de fichiers existants. Les nouvelles commandes de modération, dont la sélection individuelle des charts et leurs liens Google Drive, sont chargées depuis le site après le déploiement du correctif serveur.

### Version 0.1.13

- Enregistrement des rapports du Chart Checker en JSON avec une fenêtre « Enregistrer sous » dans l'application.
- Vérification du compte et de l'origine de la page avant l'export d'un rapport ; un changement de compte interrompt l'opération.
- Correctifs de la version 0.1.12 inclus : vidéos reconnues par le site et progression des téléchargements liée au compte.
- Compatibilité avec les téléchargements Google Drive et les archives R2 servis par l'API ChartsHub, dans le dossier d'exportation choisi.

### Version 0.1.11

- Téléchargement des soumissions récentes pour vérification, y compris leurs vidéos.
- Compatibilité avec les inventaires sans empreinte SHA-256 obligatoire ; les empreintes fournies restent vérifiées.
- Messages précis pour les quotas Google Drive, les permissions et les fichiers modifiés.
- Annulation et nettoyage des téléchargements incomplets conservés.

### Version 0.1.10

- Conservation de la progression des téléchargements après un changement de page ou de disposition du catalogue.
- Progression par chart dans les téléchargements groupés et annulation cohérente.
- Compatibilité des noms de fichiers avec le serveur et gestion des transferts qui restent sans réponse.
- Actualisation des droits de la vue visiteur lors d'un changement de compte.

La première version est expérimentale. Les applications ne disposent pas d'une signature commerciale Windows ni d'une notarisation Apple. La compilation seule ne remplace pas un test de connexion et de téléchargement sur chaque système.

Le code du site et sa base de données restent dans un dépôt privé séparé. Aucune licence de redistribution du code n'est accordée pour le moment ; les dépendances conservent leurs licences respectives.

### Version 0.1.12 — audit du 28 septembre 2026

Les exports natifs acceptent les dix formats vidéo déjà reconnus par le site. L’historique et la progression des téléchargements sont liés au compte : une déconnexion, un changement de compte ou une perte de droits efface cet état et interrompt le transfert associé. Une navigation du même compte conserve la progression après vérification de la session.

Ces correctifs sont inclus dans la version 0.1.13.
