# Quick Import · BÊTA

**Compatible et testé avec Clone Hero 1.1.0.6142-final Stable, Windows x64.** Les autres versions ne sont pas validées.

Cette option ajoute une nouvelle chart téléchargée à la liste du jeu sans relire tous les dossiers Songs. Elle est facultative et désactivée à chaque démarrage de ChartsHub. Les téléchargements et les autres widgets fonctionnent sans elle.

## Les étapes

1. **Préparer le jeu.** Vérifiez la version de Clone Hero. L’intégration utilise MelonLoader et le module ChartsHub Quick Import correspondant. Fermez le jeu et son lanceur avant leur installation. Le bouton « Choisir Clone Hero » choisit le programme ; il n’installe aucun module.
2. **Choisir Songs.** Dans **Tableau de bord → Bibliothèque**, choisissez le dossier Songs utilisé par cette installation de Clone Hero. Dans le catalogue, choisissez le même dossier comme destination des téléchargements.
3. **Ouvrir Clone Hero.** Lancez cette installation avec le module compatible et rejoignez la liste des chansons dans Quickplay.
4. **Activer Quick Import.** Dans **Tableau de bord → Catalogue → Téléchargements → Quick Import**, cliquez sur **Choisir Clone Hero**, sélectionnez `Clone Hero.exe`, puis cliquez sur **Activer et connecter**. Attendez **Connecté**.
5. **Télécharger une chart.** Utilisez le catalogue principal ou celui du Tableau de bord. Choisissez une sortie **Dossier**, dans Songs. Les dossiers avec `notes.chart` ou `notes.mid` sont pris en charge. Les téléchargements de vérification de l’administration et les archives ZIP/SNG conservées telles quelles ne sont pas importés.
6. **Jouer.** Si une partie est en cours, l’ajout attend le menu. Revenez à la liste des chansons et cliquez sur **Actualiser les imports** dans ChartsHub pour vérifier **Prêt dans Clone Hero**, puis sélectionnez la nouvelle chart dans le jeu.

Quick Import analyse uniquement le nouveau dossier. Clone Hero réenregistre son index pour conserver l’ajout après redémarrage ; cette sauvegarde peut prendre plus de temps avec une grande bibliothèque. Elle ne constitue pas un scan de tous les fichiers de chansons.

## Ne pas utiliser Quick Import

Laissez-le désactivé : aucun module n’est nécessaire pour télécharger les charts ou utiliser les autres widgets. Après les téléchargements, utilisez **Scan Songs** dans Clone Hero comme auparavant.

Pour arrêter une connexion existante, cliquez sur **Désactiver et déconnecter**. Aucun nouvel envoi ne sera effectué. Un import déjà reçu par le jeu peut encore se terminer. La connexion ne se réactive pas automatiquement au prochain démarrage de ChartsHub et les anciens téléchargements ne sont pas renvoyés.

## Si l’ajout n’apparaît pas

- **Non connecté :** ouvrez le jeu choisi avec son module compatible, puis reconnectez-le.
- **Version non validée :** utilisez le scan habituel du jeu. Quick Import ne lance jamais un scan complet en remplacement.
- **En attente du menu :** terminez votre partie, puis revenez à Quickplay.
- **Résultat à vérifier :** revenez au menu, vérifiez la liste du jeu et actualisez les imports. Cet état ne confirme pas un ajout.
- **Mauvais dossier :** la destination du téléchargement doit se trouver dans le dossier Songs choisi dans Bibliothèque et utilisé par le jeu.

Le statut « Prêt » correspond à un ajout confirmé par le module, avec liste actualisée et index enregistré. Les chemins et le secret de connexion restent locaux ; ils ne sont pas transmis au site ou à OBS. Cette intégration ne réintroduit pas les mesures Accuracy ni l’assistant de calibration.

## English

Quick Import is an **optional BETA tested with Clone Hero 1.1.0.6142-final Stable on Windows x64**. Other builds are not validated. It is off whenever ChartsHub starts.

1. Prepare the matching Quick Import module and MelonLoader while Clone Hero and its launcher are closed. Selecting the executable does not install them.
2. Choose the same Songs folder in Dashboard Library, Clone Hero and the download destination.
3. Open the chosen game and enter its Quickplay song list.
4. Open **Dashboard → Catalogue → Downloads → Quick Import**, choose `Clone Hero.exe` and click **Enable and connect**.
5. Download a new chart in **Folder** format. `notes.chart` and `notes.mid` are supported; packed ZIP/SNG files and administrator review downloads are excluded.
6. Return to the song list, refresh import statuses and wait for **Ready in Clone Hero** before selecting the chart.

Only the new folder is analysed. Saving the native index can still take time in a large library. No full-scan fallback is started. Leave the option off to keep using normal downloads and the game's manual Scan Songs. Disconnect stops new sends; a job already accepted by the game can still finish.
