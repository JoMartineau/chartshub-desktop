# ChartsHub Quick Import — BETA 0.1.0

## Français

Quick Import ajoute la nouvelle chart téléchargée au menu de Clone Hero, sans lancer un scan complet de sa bibliothèque. L’import attend le menu des chansons si une partie est en cours. Il ne lance pas automatiquement la chanson.

Cette extension facultative prend en charge uniquement **Clone Hero 1.1.0.6142-final, Windows x64** et les dossiers contenant `song.ini` avec `notes.chart` ou `notes.mid`. Elle vérifie les empreintes exactes du jeu. Une autre version reste sans import automatique ; le téléchargement normal et le scan manuel restent disponibles. Les formats SNG/ENC ne sont pas validés pour un nouvel import.

### Installation facultative

1. Gardez une copie de sécurité de votre jeu et fermez Clone Hero ainsi que son lanceur.
2. Téléchargez séparément l’archive officielle **MelonLoader 0.7.3 Windows x64** depuis la [release officielle](https://github.com/LavaGang/MelonLoader/releases/tag/v0.7.3). Elle n’est pas incluse dans ce paquet. Le script exige son SHA256 exact : `5b2b2f3d1cd42b59ec886c5bdc2663edae87a0097a4f4a8f58c0965a99dda416`.
3. Dans PowerShell, affichez d’abord le plan avec les chemins de **votre** jeu, de son dossier Songs déjà configuré dans Clone Hero et de l’archive téléchargée :

```powershell
.\Install-QuickImport.ps1 -GameRoot 'C:\Games\Clone Hero' -SongsRoot 'D:\Songs' -LoaderZip 'C:\Downloads\MelonLoader.x64.zip'
```

4. Après lecture du plan, reprenez la même commande avec `-Apply`. Le module reste désactivé par défaut. Ajoutez aussi **`-EnableBeta`** pour l’activer explicitement dès cette installation.
5. Ouvrez normalement le jeu. Le premier lancement de MelonLoader peut préparer ses composants. Le terminal est masqué lorsqu’aucune configuration MelonLoader ne préexistait ; les journaux restent dans le dossier du jeu. Une configuration déjà présente est conservée.
6. Dans ChartsHub, activez Quick Import BETA et choisissez ce même dossier de jeu. Au premier usage, Clone Hero doit déjà posséder un cache issu de son scan normal et connaître le dossier Songs choisi. Les nouveaux téléchargements terminés seront ensuite ajoutés au menu ; pendant une partie, ils attendent votre retour au menu.

Le script ne remplace aucun fichier existant inconnu, ne touche ni aux chansons ni aux profils, ne modifie aucun binaire du jeu et ne lance aucun programme. Un chargeur ou une configuration incompatibles arrêtent l’installation et demandent une vérification. Ne partagez jamais `config.json` ou `connection.json` : ils contiennent une clé locale privée. Pour activer plus tard une installation désactivée, changez uniquement `enabled` en `true` dans `UserData/ChartsHubQuickImport/config.json`, jeu fermé, en conservant sa clé et sa racine Songs.

### Si l’import n’aboutit pas

Un build inconnu, un dossier Songs différent du réglage du jeu, des fichiers incomplets ou modifiés, un cache manquant/changé ou un scan déjà actif empêchent l’import. Il n’y a pas de scan complet caché en secours. Une erreur ne doit pas être présentée comme un ajout réussi. Le cache est sauvegardé à côté de son fichier avant remplacement atomique ; les anciens dossiers de charts ne sont pas parcourus. Lire et réécrire l’index dépend tout de même de la taille de ce fichier. Les tests de grande bibliothèque sont synthétiques, pas une garantie de temps d’exécution sur tout matériel.

### Retrait

```powershell
.\Uninstall-QuickImport.ps1 -GameRoot 'C:\Games\Clone Hero'
```

Cette commande affiche seulement le plan. Fermez le jeu et son lanceur puis ajoutez `-Apply` pour retirer uniquement les fichiers créés par cette installation et restés inchangés. Les fichiers modifiés sont conservés. Le chargeur et ses réglages sont conservés si d’autres extensions, sous-dossiers ou notre module modifié peuvent en dépendre. Chansons, profils, cache et sauvegardes du cache sont conservés.

### Reproduire le module

Les sources incluses appartiennent à ChartsHub. Aucun binaire de Clone Hero, MelonLoader ou SDK généré depuis le jeu n’est redistribué. Avec le SDK .NET **10.0.401**, exécutez :

```powershell
.\Build-Module.ps1 -LoaderZip 'C:\Downloads\MelonLoader.x64.zip'
```

La construction extrait uniquement trois références de compilation de l’archive officielle, construit le module de production puis compare son SHA256 à `MODULE.json`. Elle n’exécute ni MelonLoader ni Clone Hero et n’installe rien. Ne distribuez pas les références extraites, `bin/obj`, les journaux ou vos configurations locales.

## English

Quick Import adds a completed chart download to Clone Hero’s song menu without running a full library scan. Requests made during gameplay wait for the song menu. Songs are not launched automatically.

This optional BETA supports only **Clone Hero 1.1.0.6142-final for Windows x64**, with `song.ini` and `notes.chart` or `notes.mid`. Exact program hashes are checked. Other builds keep normal downloading and manual scanning; automatic import is unavailable. New SNG/ENC imports are not validated.

Close the game and launcher. Obtain the separate official **MelonLoader 0.7.3 Windows x64** archive from the [official release](https://github.com/LavaGang/MelonLoader/releases/tag/v0.7.3). Its exact SHA256 is listed above. Run `Install-QuickImport.ps1` with your own `-GameRoot`, existing configured `-SongsRoot` and `-LoaderZip`. It shows a read-only plan by default. Add `-Apply` to install; the BETA remains **disabled unless `-EnableBeta` is explicitly supplied**. Nothing is launched automatically, existing unknown files are never overwritten, game program files and profiles remain untouched, and existing loader settings are preserved.

Launch the game normally, then enable Quick Import BETA in ChartsHub and select that same game folder. An initial normal game cache and the matching Songs setting are required. The console is hidden only when this installer creates new loader settings; file logs remain available. Never share `config.json` or `connection.json`, which contain your private local key. To enable an existing disabled setup later, close the game and change only `enabled` to `true` in `UserData/ChartsHubQuickImport/config.json`, preserving its key and Songs root.

Unknown builds, mismatched roots, incomplete/changed files, changed/missing cache or an active scan prevent import. There is no hidden full-scan fallback. The cache is backed up beside itself and replaced atomically. Old chart folders are not traversed, although reading and rewriting the index still scales with its file size. Large-library tests are synthetic rather than a runtime guarantee.

`Uninstall-QuickImport.ps1 -GameRoot 'C:\Games\Clone Hero'` previews removal; add `-Apply` with the game and launcher closed. Only owned unchanged files are removed. Modified files and a loader needed by other/nested extensions are preserved. Songs, profiles, cache and cache backups remain.

For a reproducible build, install .NET SDK **10.0.401** and run `Build-Module.ps1 -LoaderZip 'C:\Downloads\MelonLoader.x64.zip'`. It extracts three development references from the pinned official archive, builds only the production module and verifies `MODULE.json`. No game or loader executes. Do not distribute extracted third-party references, generated binaries other than the ChartsHub module, logs or private local settings.
