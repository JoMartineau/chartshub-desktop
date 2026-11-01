# ChartsHub 0.14.35

Le Companion ajoute **Batterie / VST**, un espace pour jouer un instrument virtuel depuis une batterie MIDI, un contrôleur XInput ou des pads à cliquer, sans modifier Clone Hero.

- Choisissez un instrument **VST3 64 bits**, la sortie audio et votre source d’entrée. Les notes, canaux, vélocités fixes et boutons des neuf pads sont modifiables et enregistrés localement.
- **MT Power Drum Kit 2.1.5.1** peut être téléchargé directement depuis son éditeur et préparé dans le dossier privé de ChartsHub après votre acceptation de sa licence. Ses fichiers restent ensemble. Aucun instrument, pilote, son ou périphérique ne démarre à l’ouverture de l’app.
- **Démarrer l’audio**, **Arrêter l’audio** et **Couper les notes** contrôlent le moteur. La vélocité MIDI est conservée ; les boutons XInput utilisent une vélocité fixe réglable.
- Le moteur affiche le format audio réellement négocié et sa latence déclarée. Ces chiffres ne mesurent pas le délai physique complet du matériel.
- Pour OBS, utilisez **Capture audio d’application** avec `ChartsHubDrumHost.exe`. Le lien Navigateur de l’Input Viewer reste une source visuelle distincte.

Cette première version du moteur audio vise **Windows x64 et VST3 x64**. Elle utilise WASAPI partagé ; VST2, ASIO, les plug-ins 32 bits et la sauvegarde de leurs presets ne sont pas proposés. Le fonctionnement de chaque instrument, du matériel réel et d’OBS doit être vérifié sur votre installation. Le moteur est isolé dans un processus distinct.

Les widgets, les associations de touches et les couleurs existants sont conservés. Aucun MelonLoader ni connecteur de mesures Accuracy n’est ajouté.

[Guide français et anglais](DRUMS-VST.md).
