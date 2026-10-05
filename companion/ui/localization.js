'use strict';
(() => {
  const initial = window.ChartsHubCompanion?.initialLanguage === 'fr' ? 'fr' : 'en';
  let language = initial;
  let writing = false;
  const exact = new Map([
    ['MODE DÉMO','DEMO MODE'],['CLONE HERO COMPANION','CLONE HERO COMPANION'],['Now Playing','Now Playing'],
    ['Les informations du morceau, visibles au bon moment.','Song information, visible at the right time.'],
    ['Activer l’overlay du jeu','Enable game overlay'],['Source des informations','Information source'],
    ['Connectez l’export de Clone Hero ou essayez le scénario de démonstration.','Connect the Clone Hero export or try the demo scenario.'],
    ['Démonstration','Demo'],['Fichier exporté par Clone Hero','File exported by Clone Hero'],['Aucun fichier sélectionné','No file selected'],
    ['Détection automatique','Auto-detect'],['Choisir currentsong.txt','Choose currentsong.txt'],
    ['Le morceau en cours est repris automatiquement si Clone Hero est détecté.','The current song is picked up automatically when Clone Hero is detected.'],
    ['Sinon, démarrez un morceau après connexion.','Otherwise, start a song after connecting.'],['Démonstration locale','Local demo'],
    ['Le scénario ci-dessous simule les étapes d’une chart.','The scenario below simulates the steps of a chart.'],
    ['Ce que l’export natif permet d’afficher','What the native export can display'],
    ['Titre, artiste et créateur de la chart, lorsqu’ils sont fournis par le jeu.','Chart title, artist and charter when provided by the game.'],
    ['Instrument et difficulté indisponibles.','Instrument and difficulty unavailable.'],
    ['Ces widgets ne peuvent pas afficher de valeur réelle avec cet export.','These widgets cannot display a real value with this export.'],
    ['Lecture, pause et écrans du jeu indéterminés.','Playing, pause and game screens cannot be determined.'],
    ['IMAGE DU JEU','GAME IMAGE'],['Filtres du jeu','Game filters'],['Choisissez vos effets et ajustez l’image de Clone Hero.','Choose your effects and adjust the Clone Hero image.'],
    ['Effets ReShade','ReShade effects'],['Les effets et paramètres de votre installation ReShade, directement dans ChartsHub.','Effects and settings from your ReShade installation, directly in ChartsHub.'],
    ['Mini-widget','Mini widget'],['Connexion…','Connecting…'],['Chargement de la connexion ReShade.','Loading the ReShade connection.'],
    ['Installation de Clone Hero','Clone Hero installation'],['Aucun dossier sélectionné','No folder selected'],['Choisir le dossier du jeu','Choose game folder'],
    ['Installer l’intégration ReShade','Install ReShade integration'],['Actualiser l’état','Refresh status'],['Installer ou mettre à jour ReShade','Install or update ReShade'],
    ['Installer ReShade','Install ReShade'],['Téléchargez la version officielle, vérifiez les fichiers préparés, puis installez-les dans Clone Hero.','Download the official version, review the prepared files, then install them in Clone Hero.'],
    ['Chargement…','Loading…'],['Ajouter le pack Bloom, FilmGrain et aberration chromatique','Add the Bloom, FilmGrain and chromatic aberration pack'],
    ['Ces effets resteront désactivés par défaut. Vous pourrez les choisir après connexion.','These effects remain disabled by default. You can choose them after connecting.'],
    ['Choisissez le dossier du jeu ci-dessus pour commencer.','Choose the game folder above to begin.'],['Version officielle','Official version'],['Dossier cible','Target folder'],
    ['Fichiers préparés','Prepared files'],['Préparer le téléchargement','Prepare download'],['Installer dans Clone Hero','Install in Clone Hero'],['Annuler','Cancel'],
    ['Activer les effets ReShade','Enable ReShade effects'],['Enregistrer le preset','Save preset'],['Enregistre les réglages des effets activés.','Saves the settings of enabled effects.'],
    ['Preset en cours','Current preset'],['En attente de ReShade','Waiting for ReShade'],['Rechercher un effet','Search effects'],['Aucun effet reçu','No effects received'],
    ['Réglages de l’effet','Effect settings'],['Sélectionnez un effet pour afficher ses paramètres.','Select an effect to display its settings.'],
    ['Moteur ChartsHub classique','Classic ChartsHub engine'],['Réglages classiques','Classic settings'],['Activer les filtres','Enable filters'],
    ['Chargement du module de filtres.','Loading the filter module.'],['Installer le module','Install module'],['Restaurer le module précédent','Restore previous module'],
    ['Style visuel','Visual style'],['Neutre','Neutral'],['Couleurs vives','Vivid colors'],['Doux','Soft'],['Contraste','Contrast'],['Personnalisé','Custom'],
    ['Réinitialiser','Reset'],['Saturation','Saturation'],['Gamma','Gamma'],['Exposition','Exposure'],['Netteté','Sharpness'],['Vignette','Vignette'],
    ['Afficher le mini-widget Filtres','Show Filters mini widget'],['Accès rapide aux styles et à l’activation.','Quick access to styles and activation.'],
    ['Profils d’overlay','Overlay profiles'],['Disposition actuelle non enregistrée','Current layout not saved'],['Votre première disposition est prête à être enregistrée.','Your first layout is ready to be saved.'],
    ['Nom du profil','Profile name'],['Enregistrer un nouveau profil','Save new profile'],['Mettre à jour','Update'],['Supprimer','Delete'],
    ['Utilisez Gérer sur un profil pour le renommer ou le mettre à jour.','Use Manage on a profile to rename or update it.'],
    ['Confirmer la suppression','Confirm deletion'],['Conserver le profil','Keep profile'],
    ['Aperçu de l’overlay','Overlay preview'],['Masqué','Hidden'],['Modifier la disposition','Edit layout'],['Jeu','Game'],['Deux dispositions indépendantes','Two independent layouts'],
    ['ÉDITION DE L’APERÇU','PREVIEW EDITING'],['Grille 8 px','8 px grid'],['Rétablir','Redo'],['Aligner','Align'],['Gauche','Left'],['Centre','Center'],['Droite','Right'],
    ['Haut','Top'],['Milieu','Middle'],['Bas','Bottom'],['ÉCRAN DE JEU','GAME SCREEN'],['Now Playing est masqué','Now Playing is hidden'],
    ['Démarrez une chart avec la simulation ci-dessous.','Start a chart with the simulation below.'],['Sélectionnez un widget pour le placer.','Select a widget to place it.'],
    ['L’overlay apparaît pendant une chart et reste visible en pause.','The overlay appears during a chart and remains visible while paused.'],
    ['Fenêtre overlay désactivée','Overlay window disabled'],['Fenêtre overlay activée','Overlay window enabled'],['Simulation Clone Hero','Clone Hero simulation'],
    ['Un scénario reproductible, étape par étape.','A repeatable scenario, step by step.'],['Inactif','Idle'],['Menu','Menu'],['Chargement','Loading'],['En jeu','Playing'],['Pause','Pause'],['En pause','Paused'],['Résultats','Results'],
    ['Étape suivante','Next step'],['Rejouer','Replay'],['État du jeu','Game state'],['Disposition des widgets','Widget layout'],['Sélectionnez aussi depuis cette liste.','You can also select from this list.'],
    ['Aucune sélection','No selection'],['Largeur','Width'],['Hauteur','Height'],['Verrouiller ce widget','Lock this widget'],['Visibilité du widget','Widget visibility'],
    ['Dans l’overlay du jeu','In game overlay'],['Dans Stream / OBS','In Stream / OBS'],['Pendant une chart','During a chart'],['Pendant la pause','While paused'],
    ['Widgets affichés','Displayed widgets'],['Réglages enregistrés automatiquement','Settings saved automatically'],['Enregistrement indisponible','Saving unavailable'],
    ['Destinations','Destinations'],['Overlay du jeu','Game overlay'],['Disponible','Available'],['Source locale','Local source'],['Visibilité automatique','Automatic visibility'],
    ['Visible en jeu et en pause.','Visible while playing and paused.'],['Masqué au menu, au chargement et aux résultats.','Hidden in menus, loading and results.'],
    ['INSTALLED LIBRARY','INSTALLED LIBRARY'],['Bibliothèque locale','Local library'],['Retrouvez les charts présentes dans votre dossier Songs.','Find charts installed in your Songs folder.'],
    ['Choisir un dossier','Choose folder'],['Dossier Songs','Songs folder'],['Choisir le dossier Songs','Choose Songs folder'],['Scan complet','Full scan'],['Actualiser','Refresh'],
    ['Annuler l’analyse','Cancel scan'],['Analyse en cours…','Scanning…'],['Aucune analyse effectuée','No scan performed'],['Détection désactivée','Change detection off'],
    ['Actualiser au démarrage de ChartsHub','Refresh when ChartsHub starts'],['Détecter les changements du dossier','Watch folder changes'],
    ['Rechercher dans la bibliothèque','Search library'],['Effacer','Clear'],['Trier par','Sort by'],['Titre','Title'],['Artiste','Artist'],['Créateur','Charter'],
    ['Audio','Audio'],['Tous','All'],['Absent','Missing'],['Présent','Present'],['Non vérifié','Unverified'],['Charts','Charts'],['Toutes','All'],
    ['Doublons possibles','Possible duplicates'],['Réinitialiser les filtres','Reset filters'],
    ['Vérification globale des doublons','Global duplicate verification'],['Vérifier l’audio de tous les doublons','Verify audio for all duplicates'],
    ['Analyse tous les groupes détectés. Aucune copie n’est supprimée automatiquement.','Checks all detected groups. No copy is deleted automatically.'],
    ['Choisissez votre dossier Songs','Choose your Songs folder'],['Réessayer l’affichage','Retry display'],['Format','Format'],['Actions','Actions'],['50 morceaux par page','50 songs per page'],
    ['Précédente','Previous'],['Suivante','Next'],['Comparer les versions','Compare versions'],['Fermer la comparaison','Close comparison'],
    ['Recharger la comparaison','Reload comparison'],['Effacer le choix','Clear choice'],['Nettoyer les copies vérifiées','Clean verified copies'],
    ['Vérifier l’audio et préparer le nettoyage','Verify audio and prepare cleanup'],['Version à conserver','Version to keep'],['Ouvrir dossier','Open folder'],
    ['Conserver cette version','Keep this version'],['Cible non vérifiée','Unverified target'],['Dossier entier, avec tout son contenu','Entire folder, including all contents'],
    ['Fichier .sng uniquement','.sng file only'],['Taille non vérifiée','Size unverified'],['Notes non vérifiées','Notes unverified'],['Lisibles','Readable'],
    ['Format non pris en charge','Unsupported format'],['Indisponibles','Unavailable'],['Envoyer 0 copies à la Corbeille','Send 0 copies to Recycle Bin'],
    ['CATALOGUE EN LIGNE','ONLINE CATALOGUE'],['Catalogue ChartsHub','ChartsHub Catalogue'],['Recherchez des charts et comparez les versions d’un morceau.','Search charts and compare song versions.'],
    ['À la demande','On demand'],['Titre, artiste ou créateur','Title, artist or charter'],['Rechercher','Search'],['Actualiser le catalogue','Refresh catalogue'],['Affiner la recherche','Refine search'],
    ['Genre','Genre'],['Année','Year'],['Instrument','Instrument'],['Difficulté','Difficulty'],['Créateur vérifié','Verified charter'],['Vérifiés uniquement','Verified only'],
    ['Liens avec la bibliothèque','Library links'],['Toutes les charts','All charts'],['Liées à la bibliothèque','Linked to library'],['Sans lien confirmé','No confirmed link'],
    ['COMPARER UN MORCEAU LOCAL','COMPARE A LOCAL SONG'],['Retour à la recherche','Back to search'],['Recharger les résultats','Reload results'],
    ['Explorez le catalogue ChartsHub','Explore the ChartsHub catalogue'],['Réessayer','Retry'],['Le catalogue sera chargé à votre demande.','The catalogue will load on demand.'],
    ['Aucune recherche lancée','No search started'],['Ajouter à la file','Add to queue'],['Ouvrir sur ChartsHub','Open on ChartsHub'],['Retirer le lien','Remove link'],['Remplacer le lien','Replace link'],['Lier cette chart','Link this chart'],
    ['Liens à actualiser','Links need refresh'],['Correspondance possible','Possible match'],['Aucun lien confirmé','No confirmed link'],['Instruments','Instruments'],['Difficultés','Difficulties'],
    ['FILE DE TÉLÉCHARGEMENTS','DOWNLOAD QUEUE'],['Téléchargements','Downloads'],['Préparez les dossiers de charts depuis le catalogue ChartsHub.','Prepare chart folders from the ChartsHub catalogue.'],
    ['Dossier des prochains téléchargements','Folder for upcoming downloads'],['La file est vide.','The queue is empty.'],['Ajoutez une chart depuis le catalogue','Add a chart from the catalogue'],
    ['Choisissez le dossier de destination, puis utilisez « Ajouter à la file » sur une chart téléchargeable.','Choose the destination folder, then use “Add to queue” on a downloadable chart.'],
    ['Activer le serveur Stream','Enable Stream server'],['Serveur arrêté','Server stopped'],['URL de la source navigateur','Browser source URL'],['Copier l’URL','Copy URL'],
    ['Résolution','Resolution'],['Images / seconde','Frames / second'],['Port local','Local port'],['Appliquer les réglages','Apply settings'],['Réglages enregistrés.','Settings saved.'],
    ['Widgets dans le Stream','Widgets in Stream'],['Source navigateur','Browser Source'],
    ['Thèmes et couleurs','Themes and colors'],['Apparence de l’overlay uniquement','Overlay appearance only'],['Thème global','Global theme'],['Preset','Preset'],['Restaurer ce thème','Restore this theme'],
    ['Lueur du texte','Text glow'],['Activer la lueur','Enable glow'],['Diffusion','Spread'],['Dégradé du texte','Text gradient'],['Activer le dégradé','Enable gradient'],
    ['Début','Start'],['Fin','End'],['Angle','Angle'],['Appliquer les effets','Apply effects'],['Aperçu du thème','Theme preview'],['Données de démonstration','Demo data'],
    ['Style d’un widget','Widget style'],['Couleurs','Colors'],['Suivre le thème','Follow theme'],['Personnalisées','Custom'],['Texte','Text'],['Fond','Background'],['Bordure','Border'],['Lueur','Glow'],['Thème','Theme'],['Activer','Enable'],['Couleur','Color'],
    ['Appliquer au widget','Apply to widget'],['Revenir au thème','Return to theme'],['Le widget suit le thème.','Widget follows theme.'],
    ['Source Clone Hero simulée','Simulated Clone Hero source'],['Connexion au Companion…','Connecting to Companion…'],['Préparation de ReShade','Preparing ReShade'],
    ['Effets disponibles','Available effects'],['Profils d’overlay enregistrés','Saved overlay profiles'],['Destination de l’aperçu','Preview destination'],
    ['Annuler (Ctrl+Z)','Undo (Ctrl+Z)'],['Rétablir (Ctrl+Maj+Z)','Redo (Ctrl+Shift+Z)'],['Alignement de la sélection','Selection alignment'],
    ['Parcours de démonstration','Demo flow'],['Sélection des widgets','Widget selection'],['Analyse de la bibliothèque en cours','Library scan in progress'],
    ['Versions à comparer, défilement horizontal','Versions to compare, horizontal scrolling'],['Sélection des copies à envoyer à la Corbeille','Copies selected for Recycle Bin'],
    ['Charts du catalogue','Catalogue charts'],['File et historique des téléchargements','Download queue and history'],
    ['Démonstration déterministe : aucune donnée du jeu réel.','Deterministic demo: no real game data.'],
    ['Un morceau exporté ne confirme pas que la chart est en cours ; le menu, le chargement et les résultats ne sont pas distingués.','An exported song does not confirm that the chart is currently being played; menus, loading and results cannot be distinguished.'],
    ['ReShade à connecter','ReShade not connected'],['À préparer','Needs preparation'],
    ['ReShade — crosire et contributeurs. Téléchargement officiel depuis reshade.me.','ReShade — crosire and contributors. Official download from reshade.me.'],
    ['Les effets apparaîtront à la connexion.','Effects will appear after connection.'],['Connectez ReShade pour modifier les paramètres.','Connect ReShade to edit settings.'],
    ['Moteur indépendant de ReShade. La restauration remet le module précédent en place.','Independent from ReShade. Restoring puts the previous module back in place.'],
    ['Module à installer','Module not installed'],['Le module s’installe lorsque le jeu est fermé. Il sera chargé au prochain lancement de Clone Hero.','The module installs while the game is closed. It will load the next time Clone Hero starts.'],
    ['Les réglages sont enregistrés automatiquement et transmis au module pendant le jeu. L’état ci-dessus confirme si le module répond.','Settings are saved automatically and sent to the module while playing. The status above confirms whether the module is responding.'],
    ['Enregistrez les widgets, leurs tailles, couleurs et verrouillages, le thème et les dispositions Jeu et Stream. Cliquez sur un profil pour l’appliquer.','Save widgets, sizes, colors, locks, theme, and Game and Stream layouts. Click a profile to apply it.'],
    ['20 profils enregistrés. Mettez à jour un profil existant ou supprimez-en un pour en créer un autre.','20 profiles saved. Update or delete an existing profile before creating another.'],
    ['L’application et l’enregistrement des profils sont indisponibles. Fermez puis rouvrez le Companion pour les recharger.','Applying and saving profiles is unavailable. Close and reopen Companion to reload them.'],
    ['Les morceaux, la connexion à Clone Hero, le port et l’activation du serveur Stream restent indépendants des profils.','Songs, the Clone Hero connection, port and Stream server activation remain independent from profiles.'],
    ['Le morceau apparaîtra en jeu et restera visible en pause.','The song will appear while playing and remain visible while paused.'],
    ['Maj + clic : sélection multiple · Alt : déplacement libre · Échap : annuler le geste','Shift + click: multi-select · Alt: free movement · Esc: cancel the gesture'],
    ['Flèches : 1 px · Maj + flèches : 10 px · Un widget seul s’aligne sur le canvas.','Arrow keys: 1 px · Shift + arrows: 10 px · A single widget snaps to the canvas.'],
    ['Menu → Chargement → En jeu → Pause → Reprise → Résultats → Menu','Menu → Loading → Playing → Pause → Resume → Results → Menu'],
    ['Protège sa position et son cadre dans Jeu et Stream. Son style et sa visibilité restent modifiables.','Protects its position and frame in Game and Stream. Its style and visibility remain editable.'],
    ['Les widgets masqués restent modifiables en fantôme. Placement sur une grille de 1 280 × 720, centrée dans les formats personnalisés.','Hidden widgets remain editable as ghosts. Placement uses a 1,280 × 720 grid centered in custom formats.'],
    ['Réglez la taille du texte avec − / + ou en pixels. Les changements sont immédiats, pour Jeu et Stream.','Adjust text size with − / + or in pixels. Changes apply immediately to Game and Stream.'],
    ['Titre du morceau','Song title'],['Créateur de la chart','Chart charter'],
    ['Choisissez Jeu ou Stream dans l’aperçu pour modifier chaque disposition. Les couleurs restent partagées.','Choose Game or Stream in the preview to edit each layout. Colors remain shared.'],
    ['Le scan relit toute la bibliothèque. Actualiser recherche les ajouts, suppressions et modifications.','A full scan rereads the entire library. Refresh checks for additions, removals and changes.'],
    ['Analyse complète de la bibliothèque…','Full library scan…'],['traités ·','processed ·'],['charts repérées','charts found'],
    ['L’actualisation au démarrage reste rapide ; elle ne lance pas de scan complet.','Startup refresh stays fast; it does not run a full scan.'],
    ['Doublons possibles : mêmes titre, artiste et créateur, dans des emplacements distincts. Les versions peuvent différer.','Possible duplicates: same title, artist and charter in different locations. Versions may differ.'],
    ['Vérifie les notes, l’audio et le contenu de tous les groupes détectés. Les groupes sont traités un par un pour éviter de saturer le disque. Aucune copie n’est supprimée automatiquement.','Checks notes, audio and contents for every detected group. Groups are processed one at a time to avoid saturating the disk. No copy is deleted automatically.'],
    ['Son analyse démarrera automatiquement pour retrouver vos charts installées.','Scanning starts automatically to find your installed charts.'],
    ['Charts installées dans la bibliothèque locale','Charts installed in the local library'],['0 résultat','0 results'],
    ['« Conserver cette version » enregistre uniquement votre préférence. Aucun fichier n’est supprimé, déplacé ou modifié par ce choix ; toutes les versions restent dans vos dossiers.','“Keep this version” only saves your preference. No file is deleted, moved or modified; all versions remain in their folders.'],
    ['Les groupes identiques ont un fichier de notes au contenu strictement identique, dans le même format. La comparaison inclut les métadonnées et l’encodage du fichier. Les notes .chart et MIDI ne sont pas comparées entre elles. Des notes identiques ne prouvent pas que les fichiers audio sont identiques.','Identical groups have strictly identical note-file contents in the same format. Comparison includes metadata and file encoding. .chart and MIDI notes are not compared with each other. Identical notes do not prove that audio files are identical.'],
    ['Analyse en cours. Les versions restent visibles ; attendez sa fin pour enregistrer un choix.','Scan in progress. Versions remain visible; wait for it to finish before saving a choice.'],
    ['Choisissez d’abord une version à conserver, puis vérifiez les notes, l’audio et tous les fichiers. Chaque copie doit être cochée individuellement. Les dossiers sélectionnés, avec tout leur contenu, ou les fichiers .sng indiqués seront envoyés à la Corbeille Windows après une confirmation. Aucune suppression définitive.','First choose a version to keep, then verify notes, audio and all files. Each copy must be selected individually. Selected folders with all their contents, or the listed .sng files, are sent to the Windows Recycle Bin after confirmation. No permanent deletion.'],
    ['Les chemins ci-dessous sont relatifs au dossier Songs et désignent les éléments entiers concernés.','The paths below are relative to the Songs folder and identify the complete items involved.'],
    ['Catalogue de démonstration · Ces exemples ne peuvent pas être associés à votre bibliothèque.','Demo catalogue · These examples cannot be linked to your library.'],
    ['Ces filtres portent sur le catalogue chargé. Choisissez vos filtres, puis lancez Rechercher.','These filters apply to the loaded catalogue. Choose your filters, then run Search.'],
    ['Chargement du morceau local…','Loading local song…'],['Recherche de versions à partir du titre et de l’artiste.','Searching versions from the title and artist.'],
    ['« Correspondance possible » désigne une suggestion basée sur les métadonnées. Seule une association confirmée par vous affiche « Liée à votre bibliothèque ». Pour associer une chart, utilisez','“Possible match” is a metadata-based suggestion. Only a link you confirm displays “Linked to your library”. To link a chart, use'],
    ['dans la bibliothèque locale.','in the local library.'],['Le catalogue ou la bibliothèque a changé. Rechargez les résultats avant d’associer une chart.','The catalogue or library changed. Reload results before linking a chart.'],
    ['Lancez une recherche ou comparez un morceau de votre bibliothèque. Aucune recherche ne démarre automatiquement.','Start a search or compare a song from your library. No search starts automatically.'],
    ['La pause conserve les fichiers terminés. À la reprise, le fichier interrompu recommence depuis le début.','Pausing keeps completed files. When resumed, the interrupted file starts again from the beginning.'],
    ['Retirer un élément incomplet supprime ses fichiers temporaires. Les dossiers terminés sont conservés.','Removing an incomplete item deletes its temporary files. Completed folders are kept.'],
    ['Utilisez un dossier de préparation distinct de Songs.','Use a staging folder separate from Songs.'],['Les charts téléchargées ne sont pas encore installées dans Clone Hero ; l’installation sera disponible à l’étape suivante.','Downloaded charts are not installed in Clone Hero yet; installation will be available in the next step.'],
    ['Personnalisée','Custom'],['Le port se modifie quand le serveur est arrêté.','The port can be changed while the server is stopped.'],
    ['Activez les éléments à diffuser. Leur réglage global « Widgets affichés » reste également pris en compte.','Enable the items to broadcast. Their global “Displayed widgets” setting also applies.'],
    ['Aucun widget n’est activé pour le Stream. Cochez au moins un élément ci-dessus.','No widget is enabled for Stream. Select at least one item above.'],
    ['La résolution de sortie conserve les placements sur la grille 1 280 × 720 ; les formats personnalisés centrent cette grille. Aucun morceau n’est envoyé depuis les aperçus de démonstration.','Output resolution preserves placements on the 1,280 × 720 grid; custom formats center that grid. No song is sent from demo previews.'],
    ['Ces réglages changent l’overlay et son aperçu. L’interface ChartsHub conserve son apparence. Dans les menus, activez','These settings change the overlay and its preview. The ChartsHub interface keeps its appearance. In the menus, enable'],
    ['pour voir les couleurs sur la chanson de démonstration.','to see colors on the demo song.'],['Un preset change la palette et les effets. Les placements et les styles personnalisés restent conservés.','A preset changes the palette and effects. Placements and custom styles remain saved.'],
    ['Opacité','Opacity'],['Progression · à venir','Progress · coming soon'],
    ['Cliquez sur un carré coloré pour choisir sa couleur à la souris. Réglez l’opacité avec le curseur : 0 % transparent, 100 % opaque. La palette s’enregistre à la fin du choix. La saisie HEX, RGB ou HSL reste disponible.','Click a color square to choose with the mouse. Adjust opacity with the slider: 0% transparent, 100% opaque. The palette saves when the choice is complete. HEX, RGB and HSL input remains available.'],
    ['La couleur « Progression » est conservée pour les futurs widgets de progression.','The “Progress” color is reserved for future progress widgets.'],['Effets enregistrés.','Effects saved.'],
    ['Tous les widgets sont montrés ici, sans modifier leur visibilité dans le jeu.','All widgets are shown here without changing their in-game visibility.'],
    ['Personnalisez un élément indépendamment du thème global.','Customize an item independently from the global theme.'],
    ['Lorsqu’elles sont disponibles, elles remplacent la couleur et le dégradé du texte. Décochez pour utiliser votre style. Appliquez ensuite au widget.','When available, these replace the text color and gradient. Uncheck to use your own style, then apply it to the widget.'],
    ['Les effets suivent le thème tant que vous ne les modifiez pas ici. Une couleur de texte personnalisée remplace le dégradé global ; un dégradé propre au widget peut le réactiver. Revenir au thème conserve la position, la taille et la police.','Effects follow the theme until you change them here. A custom text color replaces the global gradient; a widget-specific gradient can enable it again. Returning to the theme keeps position, size and font.'],
    ['La démonstration utilise un scénario local. Choisissez Direct Clone Hero pour lire les informations exportées par le jeu.','The demo uses a local scenario. Choose Direct Clone Hero to read information exported by the game.'],
    ['Source : Mock Clone Hero · Démonstration locale','Source: Mock Clone Hero · Local demo']
  ]);

  const rules = [
    [/^Choisissez le dossier de destination, puis utilisez .*Ajouter à la file.* sur une chart téléchargeable\.$/, () => 'Choose a destination folder, then use “Add to queue” on a downloadable chart.'],
    [/^\+(.+) ajouté(?:s)? · −(.+) supprimé(?:s)? · (.+) modifié(?:s)?$/, m => `+${m[1]} added · −${m[2]} removed · ${m[3]} modified`],
    [/^(.+) avertissement(?:s)? · (.+) élément(?:s)? ignoré(?:s)? lors de la dernière analyse\.$/, m => `${m[1]} warning(s) · ${m[2]} item(s) skipped during the last scan.`],
    [/^(.+) source(?:s)? connectée(?:s)?$/, m => `${m[1]} connected source(s)`],
    [/^(.+) résultat(?:s)?$/, m => `${m[1]} result(s)`],
    [/^(\d[\d\s.,]*) morceau(x?)$/, m => `${m[1]} ${m[2] ? 'songs' : 'song'}`],
    [/^(\d[\d\s.,]*) téléchargement(s?)$/, m => `${m[1]} download${m[2] ? 's' : ''}`],
    [/^Doublon possible \((.+)\)$/, m => `Possible duplicate (${m[1]})`],
    [/^Prêt à nettoyer · (.+) copie\(s\) vérifiée\(s\)$/, m => `Ready to clean · ${m[1]} verified cop${m[1] === '1' ? 'y' : 'ies'}`],
    [/^Vérification (.+) \/ (.+)…$/, m => `Checking ${m[1]} / ${m[2]}…`],
    [/^Vérification des notes, de l’audio et des fichiers : (.+) \/ (.+) groupes\.$/, m => `Checking notes, audio and files: ${m[1]} / ${m[2]} groups.`],
    [/^(\d[\d\s.,]*) groupe\(s\) prêt\(s\) · (\d[\d\s.,]*) choix de version requis · (\d[\d\s.,]*) bloqué\(s\) · (\d[\d\s.,]*) copie\(s\) vérifiée\(s\)\.$/, m => `${m[1]} ready group(s) · ${m[2]} keeper choice(s) required · ${m[3]} blocked · ${m[4]} verified copy/copies.`],
    [/^Comparer les versions · (.+)$/, m => `Compare versions · ${m[1]}`],
    [/^Créateur : (.+)$/, m => `Charter: ${m[1]}`],
    [/^Chart : (.+)$/, m => `Chart: ${m[1]}`],
    [/^Instruments : (.+)$/, m => `Instruments: ${m[1]}`],
    [/^Difficultés : (.+)$/, m => `Difficulties: ${m[1]}`],
    [/^Ouvrir le dossier (.+)$/, m => `Open folder ${m[1]}`],
    [/^Conserver cette version : (.+)$/, m => `Keep this version: ${m[1]}`],
    [/^Sélectionner cette copie : (.+)$/, m => `Select this copy: ${m[1]}`],
    [/^Appliquer le profil (.+)$/, m => `Apply profile ${m[1]}`],
    [/^Gérer le profil (.+)$/, m => `Manage profile ${m[1]}`],
    [/^Profil actif : (.+)$/, m => `Active profile: ${m[1]}`],
    [/^Profil à mettre à jour : (.+)$/, m => `Profile to update: ${m[1]}`],
    [/^Fichier : (.+)$/, m => `File: ${m[1]}`],
    [/^Dernière analyse : (.+)$/, m => `Last scan: ${m[1]}`],
    [/^Catalogue chargé le (.+)$/, m => `Catalogue loaded ${m[1]}`],
    [/^Enregistré le (.+) à (.+)$/, m => `Saved on ${m[1]} at ${m[2]}`],
    [/^Envoyer (.+) copies à la Corbeille$/, m => `Send ${m[1]} copies to Recycle Bin`],
    [/^(.+) copie\(s\) sélectionnée\(s\)\. La version conservée est exclue\.$/, m => `${m[1]} selected copy/copies. The kept version is excluded.`],
    [/^(.+) versions · (.+) fichiers de notes lisibles · (.+) groupes de notes · (.+) groupes identiques · (.+) non vérifiées$/, m => `${m[1]} versions · ${m[2]} readable note files · ${m[3]} note groups · ${m[4]} identical groups · ${m[5]} unverified`],
    [/^Notes identiques · groupe (.+) \((.+) versions\)$/, m => `Identical notes · group ${m[1]} (${m[2]} versions)`],
    [/^Notes vérifiées · groupe (.+)$/, m => `Verified notes · group ${m[1]}`],
    [/^Audio vérifié · (.+) fichier\(s\) · (.+) octets$/, m => `Audio verified · ${m[1]} file(s) · ${m[2]} bytes`]
  ];

  const blocked = 'code,pre,.companion-widget,.library-relative-path,.library-variant-path,.library-variant h4,.library-variant-metadata,.catalogue-item h3,.catalogue-item-artist,.catalogue-item-details,.download-item h3,.download-destination,.profile-item-name,#clonehero-file-path,#library-root,#downloads-root,#reshade-root,#filters-root,#reshade-preset';
  const records = new WeakMap();
  const attrRecords = new WeakMap();
  const attrs = ['placeholder','title','aria-label'];

  const normalizedExact = new Map([...exact].map(([fr,en]) => [fr.normalize('NFC').replace(/\s+/g,' ').trim(), en]));
  function english(source) {
    const normalized = source.normalize('NFC').replace(/\s+/g,' ').trim();
    if (normalizedExact.has(normalized)) return normalizedExact.get(normalized);
    for (const [pattern, replace] of rules) {
      const match = normalized.match(pattern);
      if (match) return replace(match);
    }
    return source;
  }
  function blockedElement(element) { return !element || !!element.closest?.(blocked); }
  function textRecord(node) {
    const raw = node.nodeValue ?? '', trimmed = raw.trim();
    if (!trimmed || blockedElement(node.parentElement)) return null;
    let record = records.get(node);
    if (record && trimmed !== record.fr && trimmed !== record.en) {
      const en = english(trimmed);
      if (en === trimmed) { records.delete(node); return null; }
      record = { fr: trimmed, en, leading: raw.match(/^\s*/)?.[0] ?? '', trailing: raw.match(/\s*$/)?.[0] ?? '' }; records.set(node, record);
    } else if (!record) {
      const en = english(trimmed);
      if (en === trimmed) return null;
      record = { fr: trimmed, en, leading: raw.match(/^\s*/)?.[0] ?? '', trailing: raw.match(/\s*$/)?.[0] ?? '' }; records.set(node, record);
    }
    return record;
  }
  function translateText(node) {
    const record = textRecord(node); if (!record) return;
    const value = record.leading + (language === 'fr' ? record.fr : record.en) + record.trailing;
    if (node.nodeValue !== value) node.nodeValue = value;
  }
  function translateAttr(element, attr) {
    if (blockedElement(element) || !element.hasAttribute?.(attr)) return;
    const raw = element.getAttribute(attr); if (!raw) return;
    let all = attrRecords.get(element); if (!all) { all = new Map(); attrRecords.set(element, all); }
    let record = all.get(attr);
    if (record && raw !== record.fr && raw !== record.en) {
      const en = english(raw);
      if (en === raw) { all.delete(attr); return; }
      record = { fr: raw, en }; all.set(attr, record);
    } else if (!record) {
      const en = english(raw);
      if (en === raw) return;
      record = { fr: raw, en }; all.set(attr, record);
    }
    const value = language === 'fr' ? record.fr : record.en;
    if (raw !== value) element.setAttribute(attr, value);
  }
  function scan(root = document.body) {
    if (!root) return;
    writing = true;
    try {
      if (root.nodeType === Node.TEXT_NODE) translateText(root);
      else {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node; while ((node = walker.nextNode())) translateText(node);
        if (root.nodeType === Node.ELEMENT_NODE) for (const attr of attrs) translateAttr(root, attr);
        for (const element of root.querySelectorAll?.('[placeholder],[title],[aria-label]') ?? []) for (const attr of attrs) translateAttr(element, attr);
      }
    } finally { writing = false; }
  }
  function refresh() { scan(document.body); }
  function apply(value) {
    const next = value === 'fr' ? 'fr' : 'en';
    language = next; document.documentElement.lang = next; refresh();
    window.dispatchEvent(new CustomEvent('chartshub:languagechange', { detail: { language: next } }));
    return language;
  }
  function mount() {
    document.documentElement.lang = language; refresh();
    const observer = new MutationObserver(recordsList => {
      if (writing) return;
      for (const mutation of recordsList) {
        if (mutation.type === 'characterData') scan(mutation.target);
        else if (mutation.type === 'attributes') translateAttr(mutation.target, mutation.attributeName);
        else for (const node of mutation.addedNodes) scan(node);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attrs });
  }
  window.ChartshubCompanionLanguage = Object.freeze({ get: () => language, apply, refresh, t: (fr, en) => language === 'fr' ? fr : en });
  document.documentElement.lang = language;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
