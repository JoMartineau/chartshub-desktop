# ChartsHub Desktop 0.14.12

Windows x64, Linux x64, macOS Intel et Apple Silicon.

- **Changement de chanson** : Suivant et Précédent réutilisent l’ordre de la bibliothèque au lieu de trier toutes les chansons à chaque clic. L’ordre est reconstruit après un nouveau scan ou un changement de dossier Songs. Les pistes peuvent démarrer dès que toutes disposent des premières données audio décodées.
- **Lectures audio et vidéo** : les lectures locales utilisent des blocs bornés de 1 Mio, avec les mêmes contrôles de chemin, d’identité et de changement des fichiers. Cela réduit les opérations disque répétées ; les médias restent chargés à la demande.
- **Vidéo fluide** : la synchronisation suit une horloge audio locale, sans ramener la vidéo en arrière à chaque publication d’un état identique. Pause, recherche de position et changement de chanson invalident les anciennes demandes de lecture.
- **Vidéo entière et plein écran** : le cadre respecte les proportions de la vidéo originale, sans rogner les bords. Un bouton permet de passer en plein écran. ChartsHub lit le fichier original sans compression ni réduction de résolution ; la qualité disponible dépend du fichier et du codec pris en charge.
- **Présentation du lecteur** : les textes et contrôles retrouvent les marges des autres sections du Companion. La liste charge automatiquement les chansons suivantes en défilant, en conservant les recherches et filtres ; un échec peut être retenté sans perdre les résultats affichés.
- **Lecteur flottant et OBS** : le lecteur possède un cadre sans barre Windows, déplaçable, redimensionnable et toujours au-dessus des fenêtres. Son titre stable est proposé dans la section OBS pour la Capture de fenêtre. Ouvrir ou masquer le widget conserve le même moteur audio et ne démarre aucun morceau automatiquement.
- **Thème et couleurs** : la bulle rassemble les réglages de l’interface, des widgets du morceau, du Catalogue, de ReShade / Filtres du jeu et du Lecteur. Chaque fenêtre flottante possède ses couleurs, son opacité du fond, sa police et sa taille du texte. Les anciens réglages sont migrés en mémoire puis enregistrés seulement lors d’une sauvegarde explicite. Les bulles de prévisualisation, de widgets affichés et de destinations suivent aussi le bloom de l’interface.
- **Doublons** : rouvrir une comparaison avec une version conservée relance la vérification des notes, de l’audio et des fichiers avant de présenter les cases. « Conserver toutes les versions » efface la sélection sans déplacer de fichiers. Les copies non cochées restent en place ; la version gardée et les chemins non vérifiés restent protégés. Les compteurs distinguent les copies identiques prêtes à sélectionner des groupes bloqués.

Les playlists, le mode aléatoire, les couleurs, le volume et les préférences vidéo restent enregistrés dans le profil. Le lecteur ne modifie pas les chansons et ne reprend pas automatiquement la lecture au lancement. Le partage public Song Request nécessite le site 1.8.4, dont le déploiement est séparé de l’archive Desktop.

Les tests utilisent des médias et bibliothèques synthétiques. Ils contrôlent l’ordre sur une grande bibliothèque, les lectures bornées et leurs refus en cas de modification, la synchronisation, le plein écran et le défilement. Ils ne mesurent pas le temps de chargement ni les capacités de décodage de tous les médias utilisateur.

Dans OBS sous Windows, ouvrez le lecteur depuis la section OBS du Companion, ajoutez une source **Capture de fenêtre** puis choisissez **ChartsHub — Lecteur Songs**. Gardez cette fenêtre ouverte pour la capture. La capture de fenêtre fournit l’image ; configurez séparément le son voulu dans OBS. [Documentation OBS](https://obsproject.com/kb/window-capture-sources).

Conservez votre profil et vos dossiers Songs lors de la mise à jour. Les empreintes des quatre archives sont publiées dans `SHA256SUMS.txt`.
