# Batterie / VST — Companion

## Français

Ce module fait jouer un instrument VST3 installé sur votre ordinateur à partir d’une batterie MIDI, d’une batterie/manette XInput ou des pads à cliquer. Il fonctionne séparément de Clone Hero : aucun mod ni MelonLoader n’est nécessaire. La première version vise Windows 64 bits et les instruments VST3 64 bits ; les anciens plug-ins VST2 `.dll` ne sont pas pris en charge.

### Préparer l’instrument

1. Pour préparer **MT Power Drum Kit 2.1.5.1** dans ChartsHub, consultez la licence MANDA AUDIO, cochez vous-même l’accord, puis cliquez sur **Télécharger et préparer MT Power Drum Kit**. Le paquet VST3 Windows 64 bits provient directement de l’éditeur. Ses fichiers d’origine, sons et licences fournis restent ensemble dans un nouveau dossier privé de ChartsHub, sans installation système ni démarrage automatique du son. Un reçu indique la source, votre accord et les empreintes calculées ; celles-ci ne sont pas présentées comme des empreintes publiées par l’éditeur.
   Vous pouvez aussi installer un autre instrument VST3 depuis son éditeur. **Obtenir MT Power Drum Kit** ouvre simplement la page officielle.
2. Après la préparation intégrée de MT Power Drum Kit, l’instrument est déjà sélectionné. Pour utiliser un autre instrument, cliquez sur **Choisir un instrument VST3**, puis sélectionnez-le.
3. Cliquez sur **Ouvrir l’instrument** pour choisir le kit et régler les sons dans sa propre fenêtre.

### MT Power Drum Kit gratuit : au début de chaque session

La version gratuite reste muette tant que son écran d’accueil n’a pas été validé. **START dans MT** et **Démarrer l’audio dans ChartsHub** sont deux boutons différents.

1. Dans ChartsHub, cliquez sur **Ouvrir l’instrument**, même si MT Power Drum Kit est déjà sélectionné. Cette action charge sa fenêtre sans démarrer l’audio.
2. Dans la fenêtre MT Power Drum Kit, cliquez sur **START**, en bas à droite. Répétez cette étape à chaque nouvelle session avec la version gratuite.
3. Revenez dans ChartsHub : après avoir vérifié et appliqué votre sortie et vos pads, cliquez sur **Démarrer l’audio**, puis sur **Tester** pour vérifier le son d’un pad.

La préparation de l’instrument ne valide pas son écran d’accueil. ChartsHub n’appuie sur aucun de ces boutons automatiquement. [Explication officielle de MANDA AUDIO](https://www.powerdrumkit.com/help-page.php?os=General&topic=no_sound_when_reopening_project).

### Choisir la sortie et les pads

1. Cliquez sur **Détecter / actualiser les périphériques**. La détection et la lecture d’entrée ne démarrent pas à l’ouverture du panneau.
2. Sélectionnez la sortie audio sur laquelle vous écoutez. Commencez à faible volume. Un tampon de 128 ou 256 échantillons constitue un point de départ ; si le son craque, augmentez-le. Le format effectivement utilisé dépend du périphérique.
3. Choisissez votre entrée :
   - **Batterie MIDI** : choisissez le périphérique MIDI. La vélocité des frappes reçues est conservée ; ChartsHub ne déduit pas la force d’un simple bouton. Les canaux affichés vont de 1 à 16.
   - **Manette / batterie XInput** : choisissez la manette, puis assignez manuellement les boutons ou axes des pads. Les indices commencent à 0. Chaque nouvelle pression produit une frappe avec la force fixe réglée pour ce pad ; XInput ne mesure pas la force du coup.
   - **Pads à cliquer** : utilisez **Tester** après le démarrage de l’audio.
4. Adaptez les notes à votre instrument. Les valeurs initiales suivent General MIDI : grosse caisse 36, caisse claire 38, charleston fermé 42, ouvert 46, toms 48/45/43, crash 49 et ride 51. Le canal initial est 10. Les instruments peuvent employer d’autres mappings.
5. Cliquez sur **Appliquer les réglages**, puis **Démarrer l’audio**. Aucun son ne démarre automatiquement. Les réglages sont verrouillés pendant la lecture : arrêtez l’audio pour les changer.

**Couper les notes** permet d’interrompre les notes actives ; **Arrêter l’audio** arrête le moteur et la lecture des entrées. Un périphérique débranché ou une erreur de plug-in doit être corrigé avant de redémarrer explicitement. Fermer uniquement la fenêtre de l’instrument n’équivaut pas à arrêter l’audio.

### OBS

Ajoutez une **Capture audio d’application** pour `ChartsHubDrumHost.exe` / **ChartsHub — Batterie VST**, puis vérifiez le niveau dans OBS. Le lien Navigateur de l’Input Viewer affiche uniquement les frappes : il ne transporte pas le son. Évitez de capturer à la fois le son de l’application et la même sortie dans Audio du bureau, pour prévenir un doublage.

Le tampon et la latence annoncés par le moteur ne mesurent pas le délai physique complet des enceintes, du casque ou de la batterie. Cette fonction ne calibre pas Clone Hero.

## English

This module plays an installed VST3 instrument from a MIDI drum kit, an XInput drum kit/controller, or on-screen pads. It runs separately from Clone Hero and requires neither a game mod nor MelonLoader. The initial version targets 64-bit Windows and 64-bit VST3 instruments; legacy VST2 `.dll` plug-ins are not supported.

### Set up the instrument

1. To prepare **MT Power Drum Kit 2.1.5.1** inside ChartsHub, read the MANDA AUDIO licence, manually select the consent checkbox, then choose **Download and prepare MT Power Drum Kit**. The Windows 64-bit VST3 package comes directly from its publisher. The original files, sounds and supplied licences remain together in a new private ChartsHub folder, without a system installer or automatic sound playback. A receipt records the source, your consent and computed hashes; these are not described as publisher-provided hashes.
   Alternatively, install another VST3 instrument from its publisher. **Get MT Power Drum Kit** only opens the official download page.
2. After preparing MT Power Drum Kit inside ChartsHub, the instrument is already selected. To use another instrument, choose **Choose a VST3 instrument** and select it.
3. Choose **Open instrument** to select a kit and adjust its sounds in the instrument’s own window.

### Free MT Power Drum Kit: at the beginning of every session

The free version remains silent until its welcome screen is dismissed. **START inside MT** and **Start audio in ChartsHub** are separate buttons.

1. In ChartsHub, select **Open instrument**, even when MT Power Drum Kit is already selected. This loads its window without starting audio.
2. In the MT Power Drum Kit window, click **START** in the bottom-right corner. Repeat this step at the beginning of each session with the free version.
3. Return to ChartsHub: after checking and applying your audio output and pads, select **Start audio**, then **Test** to check a pad’s sound.

Preparing the instrument does not dismiss its welcome screen. ChartsHub never clicks either button automatically. [Official MANDA AUDIO explanation](https://www.powerdrumkit.com/help-page.php?os=General&topic=no_sound_when_reopening_project).

### Choose audio and pads

1. Choose **Detect / refresh devices**. Opening this panel does not start device detection or input reading.
2. Select the audio output you listen to and start with a low volume. Begin with a buffer of 128 or 256 samples and increase it if audio crackles. The actual format depends on the output device.
3. Select the input:
   - **MIDI drum kit**: select the MIDI device. Incoming hit velocity is preserved; ChartsHub does not infer hit strength from an ordinary button. Displayed channels range from 1 to 16.
   - **XInput controller / drums**: select the controller and manually map each pad’s button or axis. Indices start at 0. Each new press triggers a hit at the pad’s fixed velocity; XInput does not measure hit strength.
   - **On-screen pads**: use **Test** after starting audio.
4. Adjust notes for your instrument. Initial General MIDI values are kick 36, snare 38, closed hi-hat 42, open hi-hat 46, toms 48/45/43, crash 49 and ride 51, on channel 10. Instruments may use a different mapping.
5. Choose **Apply settings**, then **Start audio**. Audio never starts automatically. Settings are locked while running; stop audio before changing them.

**Silence notes** interrupts active notes; **Stop audio** stops the engine and input reading. Fix a disconnected device or a plug-in error before explicitly restarting. Closing only the instrument editor does not stop audio.

### OBS

Add **Application Audio Capture** for `ChartsHubDrumHost.exe` / **ChartsHub — Drums VST**, then check the OBS audio meter. The Input Viewer Browser Source displays hits only; it does not carry audio. Avoid capturing the application and the same Desktop Audio output simultaneously, which would double the sound.

The engine’s reported buffer and latency do not measure the complete physical delay of speakers, headphones or the drum kit. This module does not calibrate Clone Hero.

## References

- [Steinberg VST3 API and threading](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/API%2BDocumentation/Index.html)
- [MT Power Drum Kit official site](https://www.powerdrumkit.com/)
- [OBS Application Audio Capture](https://obsproject.com/kb/application-audio-capture-guide)
