# Synchronisation du catalogue et sélection à supprimer

## Télécharger les nouvelles charts et mettre à jour les charts suivies

Dans **Tableau de bord → Catalogue → Téléchargements**, utilisez **Synchroniser le catalogue ChartsHub**. Cette fonction concerne les charts publiées sur **ChartsHub**. Les résultats de ChorusEncore et des autres sources externes restent accessibles par la recherche habituelle ; ils ne sont pas téléchargés en masse par cette synchronisation.

1. **Choisissez la destination.** Sélectionnez le dossier de téléchargement au-dessus de la section. Pour jouer ensuite dans Clone Hero, utilisez le bon dossier Songs. Choisissez aussi ce dossier dans **Bibliothèque** pour que la synchronisation actualise son index et repère les charts déjà présentes.
2. **Choisissez le contenu.** Sélectionnez **Tout le catalogue ChartsHub** ou **Seulement mes charts suivies**. Ce second mode concerne les installations que ChartsHub peut suivre ou vérifier ; une correspondance de titre seule ne suffit pas.
3. **Réglez les options.** Choisissez de 1 à 4 téléchargements simultanés et l’inclusion des vidéos. Les vidéos peuvent représenter beaucoup d’espace. Ces choix sont mémorisés pour la prochaine analyse.
4. **Cliquez sur Analyser.** Consultez le nombre de charts à télécharger, de mises à jour, de charts inchangées et d’erreurs. L’analyse vérifie les installations existantes et peut consulter les informations de la source. Le transfert des nouvelles charts démarre à l’étape suivante.
5. **Cliquez sur Démarrer la synchronisation.** Les nouvelles charts et les mises à jour vérifiables sont traitées. Les charts confirmées inchangées sont ignorées.
6. **Mettez en pause si nécessaire.** Utilisez **Reprendre** pour continuer, y compris après avoir fermé puis rouvert ChartsHub. La reprise reste un choix manuel. Si seule une analyse incomplète a été enregistrée, relancez **Analyser**. Les fichiers déjà préparés sont réutilisés lorsque leur contenu et leur source peuvent être revérifiés ; un fichier interrompu peut devoir recommencer.
7. **Traitez les erreurs.** Après avoir corrigé un problème de connexion ou de dossier, utilisez **Réessayer les erreurs**. Si le disque est plein, libérez de l’espace puis utilisez **Reprendre**.

### Ce qui est conservé

Une empreinte de contenu ou une version fiable de la source permet d’éviter un nouveau transfert. Sans cette preuve, ChartsHub peut devoir télécharger certains fichiers pour comparer leur contenu. Deux fichiers identiques ne deviennent pas deux installations simplement parce qu’une vérification a nécessité ce transfert.

ChartsHub compare les fichiers du catalogue à ceux des dossiers candidats. Si les fichiers requis sont identiques, la copie locale est reconnue, y compris lorsqu’elle contient des fichiers supplémentaires. Si les fichiers diffèrent et que la mise à jour sur place ne peut pas être vérifiée, ChartsHub installe la version du catalogue séparément. Les retraits du catalogue laissent les charts déjà installées dans Songs.

Lors d’une mise à jour, la nouvelle version est préparée avant le remplacement et l’ancienne est conservée dans un dossier de sauvegarde sous `.chartshub-companion-…` à la racine de destination. Les préparations de reprise et les sauvegardes occupent donc de l’espace ; elles ne sont pas purgées automatiquement. Ne modifiez pas ces dossiers pendant une synchronisation ou une reprise. Cette section ne propose pas de bouton de restauration ou de purge de ces sauvegardes.

Les téléchargements sont traités par lots avec une concurrence limitée et au plus 50 opérations affichées. ChartsHub regroupe aussi les actualisations automatiques de sa bibliothèque pendant un lot. L’index de Clone Hero reste distinct : actualisez le jeu par sa méthode habituelle ou utilisez Quick Import lorsqu’il est configuré et compatible.

## Libérer de l’espace par artiste, album ou sélection

Dans **Tableau de bord → Bibliothèque**, ouvrez **Libérer de l’espace · sélection de charts**. Cette action est indépendante de la synchronisation.

1. **Attendez que la bibliothèque soit prête.** Mettez en pause la synchronisation et terminez les autres vérifications en cours.
2. **Recherchez les charts.** Utilisez la recherche générale, le filtre artiste ou le filtre album. Les filtres artiste et album recherchent le texte saisi dans les métadonnées locales.
3. **Cochez votre sélection.** Faites défiler la liste pour charger les résultats par lots de 50. Vous pouvez sélectionner la page courante ou les résultats, dans la limite de **1 000 charts par vérification**. Si les résultats dépassent cette limite, seuls les 1 000 premiers sont sélectionnés et un message le précise. La sélection est conservée au défilement et entre les filtres. Changer de dossier Songs ou actualiser l’index l’efface.
4. **Cliquez sur Vérifier la sélection.** Relisez le nombre de charts vérifiables, celles qui seront conservées, la taille des fichiers concernés et les chemins relatifs. L’aperçu contient au plus 50 éléments ; le total porte sur toute la sélection. Un dossier partagé, un lien ou une cible non vérifiable reste en place.
5. **Demandez la mise à la Corbeille.** Le bouton ouvre une confirmation native avec le nombre, la taille et les dossiers concernés. Vous pouvez annuler. Seuls les dossiers de charts vérifiés, avec tout leur contenu, ou les fichiers `.sng` indiqués sont déplacés. Aucun effacement définitif n’est utilisé en remplacement de la Corbeille.
6. **Vérifiez avant de vider la Corbeille.** L’espace disque est réellement libéré lorsque vous la videz vous-même. Arrêter un traitement ne remet pas en place les fichiers déjà déplacés. Actualisez aussi la liste de Clone Hero après un nettoyage.

Le filtre **jamais jouées** est indisponible : ChartsHub ne possède pas d’historique persistant fiable de toutes vos parties Clone Hero. L’absence d’information ne permet pas de classer une chart comme jamais jouée.

## English

### Download new charts and update tracked charts

Open **Dashboard → Catalogue → Downloads → Synchronize the ChartsHub catalogue**. This covers charts published on **ChartsHub**. ChorusEncore and other external search sources are not automatically bulk-downloaded.

1. **Choose the destination above the section.** Use the correct Songs folder for Clone Hero. Choose the same folder in **Library** so synchronization refreshes its index and finds existing charts.
2. **Choose Entire ChartsHub catalogue or Only my tracked charts.** The latter covers installations ChartsHub can track or verify. A matching title alone never authorizes replacement.
3. **Choose 1–4 simultaneous downloads and whether to include videos.** Videos can require substantial space. These options are remembered for the next analysis.
4. **Choose Analyze.** Review the totals for charts to download, updates, unchanged charts and errors. Analysis checks existing installations and may fetch source information. New chart transfers start in the next step.
5. **Choose Start synchronization.** New charts and verifiable updates are processed. Confirmed unchanged charts are skipped.
6. **Pause and Resume when needed.** Saved progress remains available after restarting ChartsHub; resuming is manual. An interrupted, incomplete analysis needs Analyze again. Prepared files are reused when their content and source can be verified; an interrupted file may need to restart.
7. **Resolve errors before continuing.** Use Retry errors after fixing connection or folder problems. If the disk is full, free space and choose Resume.

A reliable source fingerprint or version can avoid another transfer. Without that proof, some files must be downloaded to compare their content. Identical files do not become duplicate installations just because verification required a transfer.

ChartsHub compares catalogue files with the files in candidate folders. If the required files match, ChartsHub recognizes the local copy, including folders with additional files. If files differ and an in-place update cannot be verified, ChartsHub installs the catalogue version separately. Charts removed from the online catalogue stay in Songs.

Updates prepare the new version before replacement and retain the previous version in a backup under `.chartshub-companion-…` in the destination root. Prepared downloads and backups use disk space and are not automatically purged. Do not modify these folders during synchronization or resume. This section does not provide a backup restore or purge button.

Work is processed in bounded batches with up to 50 recent operations displayed. Automatic ChartsHub library refreshes are grouped during a batch. Clone Hero has a separate index: update its song list normally, or use Quick Import when configured and compatible.

### Free space by artist, album or selection

Open **Dashboard → Library → Free up space · chart selection**. This is separate from synchronization.

1. Wait for the library to be ready. Pause synchronization and finish other reviews first.
2. Search the local index by general text, artist or album. Artist and album filters match the text entered against local metadata.
3. Scroll to load more results in batches of 50. Select individual charts, the current page or matching results. Each review is limited to **1,000 selected charts**. Larger results select only the first 1,000 and display a notice. Selection survives scrolling and filter changes. Changing Songs folders or refreshing the index clears it.
4. Choose **Review selection**. Check the verified and preserved counts, affected file size and relative paths. Only the first 50 entries appear in the preview; totals cover the full selection. Shared folders, links and unverifiable targets are preserved.
5. Choose **Send verified charts to Recycle Bin**. A native confirmation lists the count, size and affected folders. Cancel if necessary. Only reviewed chart folders, including their entire contents, or the listed `.sng` files are moved. There is no permanent-delete fallback.
6. Check the Recycle Bin before emptying it yourself to reclaim space. Stopping an operation does not restore files already moved. Refresh Clone Hero’s own song list after cleanup as well.

**Never played** is unavailable because ChartsHub has no reliable persistent record of all Clone Hero play sessions. Missing history does not mean a chart has never been played.
