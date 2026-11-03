# ChartsHub Quick Import — BETA 0.1.0

## Français

Quick Import ajoute la nouvelle chart téléchargée au menu de Clone Hero, sans lancer un scan complet de sa bibliothèque. L’import attend le menu des chansons si une partie est en cours. Il ne lance pas automatiquement la chanson.

Cette extension facultative prend en charge uniquement **Clone Hero 1.1.0.6142-final, Windows x64** et les dossiers contenant `song.ini` avec `notes.chart` ou `notes.mid`. Elle vérifie les empreintes exactes du jeu. Une autre version reste sans import automatique ; le téléchargement normal et le scan manuel restent disponibles. Les formats SNG/ENC ne sont pas validés pour un nouvel import.

### Installation facultative — Windows x64 uniquement

Pour Clone Hero, MelonLoader 0.7.3 indique le [.NET 6 Desktop Runtime](https://github.com/LavaGang/MelonLoader/blob/v0.7.3/README.md#requirements) comme prérequis IL2CPP. Dans la [page Microsoft .NET 6](https://dotnet.microsoft.com/fr-fr/download/dotnet/6.0), choisissez **Desktop Runtime → Windows → x64**, puis lancez l’installateur.

**Installation guidée.** Fermez Clone Hero et son lanceur. Dans ChartsHub → Tableau de bord → Catalogue → Quick Import BÊTA, cliquez sur **Installer Quick Import** et sélectionnez `Clone Hero.exe`. Vérifiez le dossier Songs proposé. Choisissez **Non** pour le changer ou **Oui** pour télécharger et vérifier MelonLoader 0.7.3, installer le module et l’activer. Ensuite, ouvrez cette même copie du jeu et connectez-la dans ChartsHub.

Vous pouvez aussi ouvrir les fichiers d’installation depuis ChartsHub et lancer cette commande dans PowerShell depuis ce dossier.

```powershell
powershell.exe -NoProfile -STA -File .\Install-QuickImport.ps1 -Guided -Language fr
```

Si la console affiche `0 Mods loaded`, vérifiez la présence de `Mods\ChartsHub.QuickImport.dll` dans le dossier contenant l’exécutable que vous ouvrez. Les boutons **Masquer le terminal MelonLoader** et **Afficher le terminal MelonLoader** s’appliquent au prochain lancement du jeu. Fermez le jeu et son lanceur avant de modifier ce réglage.

**Installation manuelle.** Pour voir le plan complet ou laisser le module désactivé après l’installation, utilisez les paramètres suivants.

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

### Linux et macOS — aide MelonLoader, Quick Import non validé

**Le support de MelonLoader sur un système ne prouve pas celui de ce module ChartsHub.** Quick Import reste spécifique au build Windows x64 ci-dessus : il vérifie les empreintes de `Clone Hero.exe`, `GameAssembly.dll` et des métadonnées IL2CPP, ainsi que des points d’entrée natifs Windows. Linux natif, macOS, Wine et Proton ne sont pas validés. Les scripts d’installation et de retrait ChartsHub de ce dossier concernent uniquement Windows ; aucun installateur shell Linux/macOS de Quick Import n’est fourni. Les commandes Quick Import sont désactivées sur ces systèmes dans ChartsHub. Les téléchargements normaux puis **Scan Songs** dans Clone Hero restent disponibles.

Pour **MelonLoader seul**, gardez une copie de sécurité du jeu et fermez-le avant de suivre les instructions de son projet :

1. **Linux natif :** la [release officielle 0.7.3](https://github.com/LavaGang/MelonLoader/releases/tag/v0.7.3) propose `MelonLoader.Installer.Linux` et `MelonLoader.Linux.x64.zip`. Choisissez le téléchargement adapté à votre jeu. Le [guide officiel de démarrage](https://github.com/LavaGang/MelonWiki/blob/master/docs/gettingstarted.md) décrit les bibliothèques `.so` et `LD_LIBRARY_PATH` / `LD_PRELOAD`. Aucun installateur ou jeu n’est lancé par ChartsHub.
2. **Wine :** distinguez le jeu Windows du jeu Linux natif. Le même guide décrit le chargeur Windows, les prérequis .NET dans le même préfixe et le réglage `version=n,b`. Installer MelonLoader ainsi ne valide pas Quick Import sous Wine ou Proton.
3. **macOS :** la release 0.7.3 propose `MelonLoader.Installer.MacOS.dmg` et `MelonLoader.macOS.x64.zip`. Il n’y a pas d’archive macOS arm64 dans cette release ; la compatibilité de Quick Import avec Apple Silicon ou Rosetta n’est pas validée. Utilisez d’abord [l’aide de l’installateur officiel](https://github.com/LavaGang/MelonLoader.Installer#how-does-it-work) : sélectionnez un jeu Steam ou ajoutez le jeu manuellement, puis choisissez le chargeur 0.7.3. Les [détails macOS intégrés à cette version](https://github.com/LavaGang/MelonLoader/pull/1138) décrivent aussi les `.dylib` dans `.app/Contents/MacOS`, et `MelonLoader/` avec `melonloader-launch.sh` à côté de l’application. Ce paquet ChartsHub ne modifie pas une application macOS.

Dans ChartsHub, le système vient du processus principal. Choisir Windows, Linux ou macOS dans le guide change seulement les explications et n’active aucun module ni support supplémentaire.

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

For Clone Hero, MelonLoader 0.7.3 lists the [.NET 6 Desktop Runtime](https://github.com/LavaGang/MelonLoader/blob/v0.7.3/README.md#requirements) as its IL2CPP prerequisite. On the [Microsoft .NET 6 page](https://dotnet.microsoft.com/en-us/download/dotnet/6.0), select **Desktop Runtime → Windows → x64** and run the installer.

Quick Import adds a completed chart download to Clone Hero’s song menu without running a full library scan. Requests made during gameplay wait for the song menu. Songs are not launched automatically.

This optional BETA supports only **Clone Hero 1.1.0.6142-final for Windows x64**, with `song.ini` and `notes.chart` or `notes.mid`. Exact program hashes are checked. Other builds keep normal downloading and manual scanning; automatic import is unavailable. New SNG/ENC imports are not validated.

### Windows x64 setup

Close the game and launcher. Obtain the separate official **MelonLoader 0.7.3 Windows x64** archive from the [official release](https://github.com/LavaGang/MelonLoader/releases/tag/v0.7.3). Its exact SHA256 is listed above. Run `Install-QuickImport.ps1` with your own `-GameRoot`, existing configured `-SongsRoot` and `-LoaderZip`. It shows a read-only plan by default. Add `-Apply` to install; the BETA remains **disabled unless `-EnableBeta` is explicitly supplied**. Nothing is launched automatically, existing unknown files are never overwritten, game program files and profiles remain untouched, and existing loader settings are preserved.

For guided setup, close Clone Hero and its launcher. In ChartsHub → Dashboard → Catalogue → Quick Import BETA, click **Install Quick Import** and select `Clone Hero.exe`. Check the suggested Songs folder. Choose **No** to change it or **Yes** to download and verify MelonLoader 0.7.3, install the module, and enable it. Open that copy of the game and connect it in ChartsHub.

You can also open the setup files from ChartsHub and run this command in PowerShell from that folder.

```powershell
powershell.exe -NoProfile -STA -File .\Install-QuickImport.ps1 -Guided -Language en
```

If the console reports `0 Mods loaded`, check for `Mods\ChartsHub.QuickImport.dll` in the folder of the game executable you started. **Hide the MelonLoader console** and **Show the MelonLoader console** take effect the next time the game opens. Close the game and its launcher before changing that setting.

Launch the game normally, then enable Quick Import BETA in ChartsHub and select that same game folder. An initial normal game cache and the matching Songs setting are required. The console is hidden only when this installer creates new loader settings; file logs remain available. Never share `config.json` or `connection.json`, which contain your private local key. To enable an existing disabled setup later, close the game and change only `enabled` to `true` in `UserData/ChartsHubQuickImport/config.json`, preserving its key and Songs root.

### Linux and macOS — MelonLoader guidance, Quick Import not validated

**MelonLoader platform support does not establish support for this ChartsHub module.** Quick Import checks Windows-specific game hashes and native entry points. Native Linux, macOS, Wine and Proton are not validated. The ChartsHub setup/removal scripts in this folder are Windows-only; no Linux/macOS Quick Import shell installer is provided. Quick Import actions are unavailable on these systems. Normal chart downloads and Clone Hero’s **Scan Songs** remain available.

For **MelonLoader itself**, back up the game and close it before following its official instructions:

1. **Native Linux:** the [official 0.7.3 release](https://github.com/LavaGang/MelonLoader/releases/tag/v0.7.3) offers `MelonLoader.Installer.Linux` and `MelonLoader.Linux.x64.zip`. Choose files matching your game. The [official getting-started guide](https://github.com/LavaGang/MelonWiki/blob/master/docs/gettingstarted.md) describes `.so` libraries and `LD_LIBRARY_PATH` / `LD_PRELOAD`. ChartsHub does not run an installer or game.
2. **Wine:** distinguish a Windows game from native Linux. The same official guide describes the Windows loader, its .NET prerequisites in the same prefix and the `version=n,b` override. Installing MelonLoader that way does not validate Quick Import on Wine or Proton.
3. **macOS:** release 0.7.3 offers `MelonLoader.Installer.MacOS.dmg` and `MelonLoader.macOS.x64.zip`. It has no macOS arm64 archive; Quick Import compatibility with Apple Silicon or Rosetta is not validated. Start with the [official installer help](https://github.com/LavaGang/MelonLoader.Installer#how-does-it-work): select a Steam game or add the game manually, then choose loader 0.7.3. The [macOS details merged for this version](https://github.com/LavaGang/MelonLoader/pull/1138) also describe `.dylib` files in `.app/Contents/MacOS`, and `MelonLoader/` with `melonloader-launch.sh` beside the app. This ChartsHub package does not modify a macOS application.

ChartsHub gets its system capability from the main process. Selecting Windows, Linux or macOS in the guide changes only the explanation and never enables a module or additional platform support.

Unknown builds, mismatched roots, incomplete/changed files, changed/missing cache or an active scan prevent import. There is no hidden full-scan fallback. The cache is backed up beside itself and replaced atomically. Old chart folders are not traversed, although reading and rewriting the index still scales with its file size. Large-library tests are synthetic rather than a runtime guarantee.

`Uninstall-QuickImport.ps1 -GameRoot 'C:\Games\Clone Hero'` previews removal; add `-Apply` with the game and launcher closed. Only owned unchanged files are removed. Modified files and a loader needed by other/nested extensions are preserved. Songs, profiles, cache and cache backups remain.

For a reproducible build, install .NET SDK **10.0.401** and run `Build-Module.ps1 -LoaderZip 'C:\Downloads\MelonLoader.x64.zip'`. It extracts three development references from the pinned official archive, builds only the production module and verifies `MODULE.json`. No game or loader executes. Do not distribute extracted third-party references, generated binaries other than the ChartsHub module, logs or private local settings.
