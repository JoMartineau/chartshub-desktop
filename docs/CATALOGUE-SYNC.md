# Synchronisation du catalogue et sélection à supprimer

## Télécharger les nouvelles charts et mettre à jour les charts suivies

Dans **Tableau de bord → Catalogue → Téléchargements**, utilisez **Synchroniser le catalogue ChartsHub**. Cette fonction concerne les charts publiées sur **ChartsHub**. Les résultats de ChorusEncore et des autres sources externes restent accessibles par la recherche habituelle ; ils ne sont pas téléchargés en masse par cette synchronisation.

1. **Choisissez la destination.** Sélectionnez le dossier de téléchargement au-dessus de la section. Pour jouer ensuite dans Clone Hero, utilisez le bon dossier Songs. Pour reconnaître des charts déjà présentes, choisissez également ce dossier dans **Bibliothèque** et actualisez son index.
2. **Choisissez le contenu.** Sélectionnez **Tout le catalogue ChartsHub** ou **Seulement mes charts suivies**. Ce second mode concerne les installations que ChartsHub peut suivre ou vérifier ; une correspondance de titre seule ne suffit pas.
3. **Réglez les options.** Choisissez de 1 à 4 téléchargements simultanés et l’inclusion des vidéos. Les vidéos peuvent représenter beaucoup d’espace. Ces choix sont mémorisés pour la prochaine analyse.
4. **Cliquez sur Analyser.** Lisez les nombres de nouvelles charts, mises à jour, charts inchangées, éléments à vérifier et erreurs. L’analyse vérifie les installations existantes et peut consulter les informations de la source. Le transfert des nouvelles charts ne démarre pas à cette étape.
5. **Cliquez sur Démarrer la synchronisation.** Les nouvelles charts et les mises à jour vérifiables sont traitées. Les charts confirmées inchangées sont ignorées.
6. **Mettez en pause si nécessaire.** Utilisez **Reprendre** pour continuer, y compris après avoir fermé puis rouvert ChartsHub. La reprise reste un choix manuel. Si seule une analyse incomplète a été enregistrée, relancez **Analyser**. Les fichiers déjà préparés sont réutilisés lorsque leur contenu et leur source peuvent être revérifiés ; un fichier interrompu peut devoir recommencer.
7. **Traitez les erreurs.** Après avoir corrigé un problème de connexion ou de dossier, utilisez **Réessayer les erreurs**. Si le disque est plein, libérez de l’espace puis utilisez **Reprendre**. Un élément **À vérifier** nécessite une vérification de votre part ; il n’est pas écrasé par une nouvelle tentative.

### Ce qui est conservé

Une empreinte de contenu ou une version fiable de la source permet d’éviter un nouveau transfert. Sans cette preuve, ChartsHub peut devoir télécharger certains fichiers pour comparer leur contenu. Deux fichiers identiques ne deviennent pas deux installations simplement parce qu’une vérification a nécessité ce transfert.

Un dossier existant non suivi n’est adopté que si tous ses fichiers peuvent être vérifiés. Les modifications locales, les correspondances ambiguës et les fichiers supplémentaires restent **À vérifier**. Une chart ne disparaît pas de Songs parce qu’elle a été retirée du catalogue.

Lors d’une mise à jour, la nouvelle version est préparée avant le remplacement et l’ancienne est conservée dans un dossier de sauvegarde sous `.chartshub-companion-…` à la racine de destination. Les préparations de reprise et les sauvegardes occupent donc de l’espace ; elles ne sont pas purgées automatiquement. Ne modifiez pas ces dossiers pendant une synchronisation ou une reprise. Cette section ne propose pas de bouton de restauration ou de purge de ces sauvegardes.

Les téléchargements sont traités par lots avec une concurrence limitée et au plus 50 opérations affichées. ChartsHub regroupe aussi les actualisations automatiques de sa bibliothèque pendant un lot. L’index de Clone Hero reste distinct : actualisez le jeu par sa méthode habituelle ou utilisez Quick Import lorsqu’il est configuré et compatible.

## Libérer de l’espace par artiste, album ou sélection

Dans **Tableau de bord → Bibliothèque**, ouvrez **Libérer de l’espace · sélection de charts**. Cette action est indépendante de la synchronisation.

1. **Attendez que la bibliothèque soit prête.** Mettez en pause la synchronisation et terminez les autres vérifications en cours.
2. **Recherchez les charts.** Utilisez la recherche générale, le filtre artiste ou le filtre album. Les filtres artiste et album recherchent le texte saisi dans les métadonnées locales.
3. **Cochez votre sélection.** La liste affiche 50 charts par page. Vous pouvez sélectionner cette page ou les résultats, dans la limite de **1 000 charts par vérification**. Si les résultats dépassent cette limite, seuls les 1 000 premiers sont sélectionnés et un message le précise. La sélection est conservée entre les pages et les filtres ; changer de dossier Songs ou actualiser l’index l’efface.
4. **Cliquez sur Vérifier la sélection.** Relisez le nombre de charts vérifiables, celles qui seront conservées, la taille des fichiers concernés et les chemins relatifs. L’aperçu contient au plus 50 éléments ; le total porte sur toute la sélection. Un dossier partagé, un lien ou une cible non vérifiable reste en place.
5. **Demandez la mise à la Corbeille.** Le bouton ouvre une confirmation native avec le nombre, la taille et les dossiers concernés. Vous pouvez annuler. Seuls les dossiers de charts vérifiés, avec tout leur contenu, ou les fichiers `.sng` indiqués sont déplacés. Aucun effacement définitif n’est utilisé en remplacement de la Corbeille.
6. **Vérifiez avant de vider la Corbeille.** L’espace disque est réellement libéré lorsque vous la videz vous-même. Arrêter un traitement ne remet pas en place les fichiers déjà déplacés. Actualisez aussi la liste de Clone Hero après un nettoyage.

Le filtre **jamais jouées** est indisponible : ChartsHub ne possède pas d’historique persistant fiable de toutes vos parties Clone Hero. L’absence d’information ne permet pas de classer une chart comme jamais jouée.

## English

### Download new charts and update tracked charts

Open **Dashboard → Catalogue → Downloads → Synchronize the ChartsHub catalogue**. This covers charts published on **ChartsHub**. ChorusEncore and other external search sources are not automatically bulk-downloaded.

1. **Choose the destination above the section.** Use the correct Songs folder for Clone Hero. To recognize existing charts, choose that folder in **Library** as well and refresh its index.
2. **Choose Entire ChartsHub catalogue or Only my tracked charts.** The latter covers installations ChartsHub can track or verify. A matching title alone never authorizes replacement.
3. **Choose 1–4 simultaneous downloads and whether to include videos.** Videos can require substantial space. These options are remembered for the next analysis.
4. **Choose Analyze.** Review New, Updates, Unchanged, Needs review and Errors. Analysis checks existing installations and may fetch source information; new chart transfers do not start yet.
5. **Choose Start synchronization.** New charts and verifiable updates are processed. Confirmed unchanged charts are skipped.
6. **Pause and Resume when needed.** Saved progress remains available after restarting ChartsHub; resuming is manual. An interrupted, incomplete analysis needs Analyze again. Prepared files are reused when their content and source can be verified; an interrupted file may need to restart.
7. **Resolve errors before continuing.** Use Retry errors after fixing connection or folder problems. If the disk is full, free space and choose Resume. Needs review entries are preserved rather than overwritten by retries.

A reliable source fingerprint or version can avoid another transfer. Without that proof, some files must be downloaded to compare their content. Identical files do not become duplicate installations just because verification required a transfer.

Untracked folders are adopted only after every file can be verified. Local edits, ambiguous matches and additional files need review. Removing a chart from the online catalogue does not delete its local installation.

Updates prepare the new version before replacement and retain the previous version in a backup under `.chartshub-companion-…` in the destination root. Prepared downloads and backups use disk space and are not automatically purged. Do not modify these folders during synchronization or resume. This section does not provide a backup restore or purge button.

Work is processed in bounded batches with up to 50 recent operations displayed. Automatic ChartsHub library refreshes are grouped during a batch. Clone Hero has a separate index: update its song list normally, or use Quick Import when configured and compatible.

### Free space by artist, album or selection

Open **Dashboard → Library → Free up space · chart selection**. This is separate from synchronization.

1. Wait for the library to be ready. Pause synchronization and finish other reviews first.
2. Search the local index by general text, artist or album. Artist and album filters match the text entered against local metadata.
3. Select individual charts, the current page or matching results. Pages show **50 charts**; each review is limited to **1,000 selected charts**. Larger results select only the first 1,000 and display a notice. Selection survives paging and filter changes, but changing Songs folders or refreshing the index clears it.
4. Choose **Review selection**. Check the verified and preserved counts, affected file size and relative paths. Only the first 50 entries appear in the preview; totals cover the full selection. Shared folders, links and unverifiable targets are preserved.
5. Choose **Send verified charts to Recycle Bin**. A native confirmation lists the count, size and affected folders. Cancel if necessary. Only reviewed chart folders, including their entire contents, or the listed `.sng` files are moved. There is no permanent-delete fallback.
6. Check the Recycle Bin before emptying it yourself to reclaim space. Stopping an operation does not restore files already moved. Refresh Clone Hero’s own song list after cleanup as well.

**Never played** is unavailable because ChartsHub has no reliable persistent record of all Clone Hero play sessions. Missing history does not mean a chart has never been played.
