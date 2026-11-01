# Widgets du jeu / Game widgets — BÊTA optionnelle

## Français

Ce module facultatif fournit les mesures **Accuracy** et une horloge du morceau pour les **paroles synchronisées**. Il accepte uniquement le Clone Hero **1.1.0.6142-final Windows x64** dont les fichiers correspondent aux empreintes vérifiées. Les autres versions restent inactives. Il ne modifie ni les notes, ni les frappes, ni les réglages du jeu. Aucun assistant de calibration n'est proposé.

Accuracy et les paroles s'activent séparément dans ChartsHub. Une mesure Accuracy décrit l'écart d'une frappe acceptée par le jeu ; elle ne mesure pas à elle seule la latence physique d'un écran ou d'une enceinte. Les paroles nécessitent une chart qui en contient, une identité de morceau résolue et une horloge valide. Elles ne sont pas créées lorsqu'elles manquent. Le jeu et ChartsHub doivent fonctionner sous le même compte Windows.

### Installation

1. Fermez Clone Hero et son lanceur. Choisissez son vrai dossier, celui qui contient `Clone Hero.exe`, pas le dossier Songs.
2. MelonLoader **0.7.3 x64** doit être installé. Si Quick Import l'a déjà installé, réutilisez-le : aucun second téléchargement du chargeur n'est nécessaire. Le diagnostic vérifie ses 164 fichiers connus sans les modifier. Une installation absente, partielle ou différente est refusée ; aucune réparation automatique ne remplace vos fichiers.
3. Vérifiez d'abord le plan, sans modification :

   ```powershell
   .\Install-GameWidgets.ps1 -GameRoot 'D:\Games\Clone Hero'
   ```

4. Si le diagnostic autorise l'installation et que vous avez relu le plan, ajoutez explicitement le module :

   ```powershell
   .\Install-GameWidgets.ps1 -GameRoot 'D:\Games\Clone Hero' -Apply
   ```

5. Lancez ensuite le jeu vous-même. Son premier démarrage avec le chargeur peut demander davantage de temps pour générer les fichiers d'interopérabilité. Ouvrez ChartsHub, vérifiez l'état de la connexion, puis activez Accuracy et/ou les paroles dans Stream / OBS. Une nouvelle connexion commence de nouvelles mesures ; une coupure ne reconstitue pas les frappes manquantes.

L'installation ajoute seulement `Mods/ChartsHub.CloneHero.Telemetry.dll` et son reçu `UserData/ChartsHubGameWidgets/install-receipt.json`. Le chargeur, Quick Import, ses réglages et son reçu restent inchangés. Aucun jeu n'est lancé par les scripts. Aucun connecteur, token ou journal privé n'est inclus dans ce paquet.

### En cas de problème

| Situation | Étape à suivre |
| --- | --- |
| Mauvais dossier, édition x86 ou autre build | Choisissez le bon exécutable. Ne forcez pas les empreintes et n'utilisez pas un nom de version comme preuve de compatibilité. |
| Jeu ou lanceur ouvert | Fermez-les normalement, puis relancez le diagnostic. Aucun processus n'est arrêté automatiquement. |
| Chargeur incomplet, étranger ou autre module déjà présent | Conservez les fichiers et examinez l'installation existante. Aucun mod inconnu n'est supprimé ou écrasé. Les conflits entre mods ne peuvent pas être exclus par un simple diagnostic. |
| Accès refusé ou disque plein | Vérifiez vos droits sur le dossier choisi et l'espace libre. Le diagnostic ne crée pas de fichier de test et ne peut pas garantir que les conditions resteront identiques. Une erreur d'écriture déclenche le retrait des nouveaux fichiers inchangés créés par cette opération. |
| Téléchargement interrompu ou empreinte différente | Téléchargez de nouveau le paquet officiel complet. N'ignorez pas le contrôle d'intégrité. Aucun antivirus n'est désactivé et aucune exclusion n'est ajoutée. |
| Premier démarrage lent ou erreur de génération | Consultez `MelonLoader/Logs`. Le chargeur peut avoir besoin du réseau pour Cpp2IL, les dépendances Unity et le runtime .NET. Les scripts ChartsHub ne téléchargent ni n'exécutent ces dépendances. |
| Aucun widget après une mise à jour | Vérifiez le module, les réglages d'activation du chargeur, la version exacte et l'état de la connexion. Relancez normalement le jeu et ChartsHub pour renouveler la connexion locale ; ne partagez jamais son descripteur privé. |

La [documentation officielle MelonLoader 0.7.3](https://github.com/LavaGang/MelonLoader/blob/v0.7.3/README.md) indique le **.NET 6 Desktop Runtime** pour les jeux IL2CPP. Elle décrit aussi `--no-mods` pour un démarrage de récupération sans plugins ni mods, et `--melonloader.hideconsole` ou `[console] hide_console = true` pour masquer la console. `--no-mods` suspend aussi Quick Import. Ces options restent un choix manuel ; les journaux permettent de diagnostiquer un échec.

### Retrait

Affichez d'abord le plan avec `Uninstall-GameWidgets.ps1 -GameRoot 'D:\Games\Clone Hero'`. Ajoutez `-Apply` seulement pour retirer ce module et son reçu. Si ses octets ont changé, ils sont conservés. Le chargeur et Quick Import ne sont jamais retirés par cet outil. L'installation d'un nouveau module ne remplace pas un ancien module existant sans examen et retrait explicites.

## English

This optional module supplies **Accuracy** measurements and a song clock for **synchronized lyrics**. It supports only the fingerprint-verified **Clone Hero 1.1.0.6142-final Windows x64** build. Unknown builds remain inactive. It does not change game settings, notes or input. There is no calibration assistant.

Accuracy and lyrics are separate choices in ChartsHub. Hit timing is not an independent measurement of physical display or speaker latency. Lyrics require a chart containing lyrics, a resolved song identity and a valid clock. Missing lyrics are not generated. Run the game and ChartsHub under the same Windows account.

### Install

1. Close Clone Hero and its launcher. Select the folder containing `Clone Hero.exe`, rather than Songs.
2. Reuse the existing verified **MelonLoader 0.7.3 x64** installation. Quick Import users do not need another loader download. The read-only check verifies 164 known files. Missing, partial or different loader files block installation; no automatic repair overwrites them.
3. Review the read-only plan:

   ```powershell
   .\Install-GameWidgets.ps1 -GameRoot 'D:\Games\Clone Hero'
   ```

4. After reviewing a successful check, explicitly add `-Apply` to install.
5. Start the game yourself. Initial interop generation can take longer. In ChartsHub, check the connection, then enable Accuracy and/or lyrics in Stream / OBS. Reconnection begins fresh measurements; missing hits cannot be recovered.

Only `Mods/ChartsHub.CloneHero.Telemetry.dll` and `UserData/ChartsHubGameWidgets/install-receipt.json` are added. The shared loader, Quick Import, its settings and receipt are unchanged. Scripts never launch the game. No private connection descriptor, token or log is shipped.

### Troubleshooting

| Issue | What to check |
| --- | --- |
| Wrong folder, x86 edition or unsupported build | Select the correct executable. Never bypass fingerprints or infer support from a version label alone. |
| Game or launcher running | Close it normally and repeat the check. Scripts never kill a process. |
| Missing/foreign loader or an existing module | Preserve the files and review that installation. Unknown mods are never deleted or overwritten. A file check cannot guarantee compatibility with every other mod. |
| Permission denied or full disk | Check folder access and free space. The read-only check creates no test file and cannot guarantee later write conditions. A write failure rolls back unchanged new files owned by that operation. |
| Truncated download or hash mismatch | Obtain the complete official package again. Do not bypass integrity checks. Antivirus settings and exclusions are never changed. |
| Slow first boot or generation error | Inspect `MelonLoader/Logs`. Generation may need network access for Cpp2IL, Unity dependencies and the .NET runtime. ChartsHub scripts neither fetch nor execute these dependencies. |
| Missing widgets after an update | Check the module, loader enable settings, exact build and connection status. Restart the game and ChartsHub normally to renew the local connection. Keep its private descriptor private. |

See the [official MelonLoader 0.7.3 requirements and recovery options](https://github.com/LavaGang/MelonLoader/blob/v0.7.3/README.md): IL2CPP needs the **.NET 6 Desktop Runtime**. `--no-mods` starts without mods/plugins and also suspends Quick Import. `--melonloader.hideconsole` or `[console] hide_console = true` hides the console. These are manual choices; logs remain useful for diagnosis.

### Remove

Review `Uninstall-GameWidgets.ps1 -GameRoot 'D:\Games\Clone Hero'`; add `-Apply` only to remove this module and its receipt. Modified bytes are preserved. This tool never removes the shared loader or Quick Import.

## Reproducible developer build

Install the exact .NET SDK **10.0.401** pinned in `source/global.json`. Supply the official MelonLoader 0.7.3 x64 ZIP with SHA-256 `5b2b2f3d1cd42b59ec886c5bdc2663edae87a0097a4f4a8f58c0965a99dda416`:

```powershell
.\Build-Module.ps1 -LoaderZip 'D:\Downloads\MelonLoader.x64.zip'
```

The script extracts development references into ignored `source/vendor`, compiles without accessing or launching a game, and verifies the output against `MODULE.json`. It does not install or overwrite the packaged module. CI copies only the reproduced ChartsHub DLL into the optional package. No Clone Hero binary or MelonLoader binary is redistributed here. Debug symbols are disabled to keep the module digest stable across compiler-host runtime patches. The runtime method bodies remain identical to the previously reviewed 0.2.2 provider.

The upstream MIT notice is preserved in `UPSTREAM-MIT-LICENSE.txt`. MelonLoader and its separate dependencies retain their own licenses; see its official repository. This optional module is not an official Clone Hero or MelonLoader product.
