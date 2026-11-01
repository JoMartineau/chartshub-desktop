# Input Viewer

Dans **Tableau de bord → Stream / OBS**, cliquez sur **Ouvrir et personnaliser l’Input Viewer**.

1. Choisissez **Guitare**, **Batterie · 4 pads** ou **Batterie · 5 pads**. Le modèle s’applique immédiatement et rétablit ses réglages, couleurs et affectations. **Rétablir les réglages du modèle** permet de réinitialiser le modèle courant.
2. Sélectionnez **Manette / guitare compatible** ou **Clavier · fenêtre active**, puis cliquez sur **Démarrer**. La lecture des entrées est arrêtée à l’ouverture.
3. Pour une manette, choisissez explicitement le contrôleur proposé. Sous Windows, la liste inclut les guitares et batteries XInput avec la mention **Windows** : elles peuvent apparaître même si la détection du navigateur les manque. Aucun pilote supplémentaire n’est installé. Sélectionnez chaque élément et cliquez sur **Associer cette entrée**, puis relâchez et appuyez sur le bouton ou l’axe souhaité. Les autres contrôleurs utilisent Gamepad API. Les appareils qui ne sont proposés par aucune des deux méthodes ne sont pas pris en charge.
4. Choisissez parmi douze styles : **Cyberpunk néon, Métal, Minimal, Hologramme, Arcade, Verre, Filaire, Énergie, Plasma, Cristal, Synthwave et Industriel**. La batterie propose des cymbales avec disque, cloche et pied ; Star Power utilise une étoile. Ces formes restent sélectionnables pour chaque élément.
5. Dans **Éléments affichés**, cochez ou décochez chaque touche, pad ou cymbale et cliquez sur son nom pour le modifier. Ses couleurs **Au repos, À l’appui, Texte et Lueur** sont indépendantes ; la lueur peut aussi suivre la couleur d’appui. Modifiez ses dimensions, son nom et sa position. **Aimantation** aligne les déplacements et les coordonnées X/Y sur la grille choisie ; décochez-la pour un placement libre, même si **Afficher la grille** reste coché. **Aligner les éléments** recale les éléments visibles en un clic lorsque l’aimantation est active.
6. Le bouton **Trails**, au-dessus de l’aperçu, ouvre directement les réglages d’animation. Choisissez **Lueur douce, Comète, Étincelles, Ondes, Ruban néon ou Pixels**. La lumière naît sur le bord de l’élément pour que son mouvement reste visible, puis s’efface après le relâchement. Chaque élément choisit sa direction **haut, bas, gauche ou droite**, ou suit la direction générale. Les réglages généraux contrôlent vitesse, durée, longueur, épaisseur, intensité et fondu ; le bloom des touches peut monter jusqu’à 80. Les lueurs restent uniquement en mémoire et s’effacent à l’arrêt ou lors d’une déconnexion.
7. Les réglages sont conservés localement, avec reprise des anciennes configurations ; aucune séquence d’entrées ni identité de périphérique n’est enregistrée. **Démo visuelle** permet de comparer les styles sans lire de périphérique. Changer d’instrument conserve le style et la grille choisis.
8. Pour le jeu, utilisez **Afficher au-dessus du jeu** dans le Tableau de bord. **Déplacer et redimensionner** montre la poignée du widget compact ; placez-le puis cliquez sur **Verrouiller la position**. Les clics traversent alors le widget. **Masquer le widget du jeu** retire seulement cette sortie. La fenêtre de réglages reste opaque et déplaçable ; elle ne reste pas au-dessus de toutes les fenêtres.
9. Pour OBS, cliquez sur **Copier le lien navigateur OBS**. Le serveur Stream s’active si nécessaire. Ajoutez une source **Navigateur** dans OBS et collez ce lien : elle affiche uniquement les touches et les trails, sur fond transparent si votre configuration le prévoit. Gardez ChartsHub ouvert. Gardez l’éditeur ouvert ou réduit pendant la lecture ; le fermer arrête les entrées. Le widget du jeu et la source OBS utilisent la même composition, sans afficher l’éditeur ni sa grille.

Le clavier est lu uniquement lorsque la fenêtre du viewer est active. Pour jouer dans une autre fenêtre en gardant le viewer animé, utilisez une guitare ou une manette proposée dans la liste. Sous Windows, **Démarrer** lance uniquement l’énumération XInput ; la lecture des boutons attend le choix explicite d’un contrôleur. **Arrêter**, fermer le viewer ou perdre l’accès au Tableau de bord arrête son auxiliaire. Après une déconnexion, choisissez de nouveau le contrôleur. Aucun raccourci global n’enregistre la frappe clavier.

Le viewer fonctionne indépendamment de Clone Hero et de MelonLoader. Il montre les entrées détectées ; il ne calcule pas l’avance ou le retard par rapport aux notes, la latence physique du matériel ou une valeur de calibration.

## Compteurs et affichage automatique

Dans les réglages de l’Input Viewer, cochez **Afficher les compteurs** pour voir le nombre d’appuis sur chaque frette, pad, cymbale et autre bouton affiché. Une pression compte une fois, même si elle est maintenue. Les totaux restent identiques dans l’éditeur, le widget du jeu et la source OBS. La démo visuelle reste séparée des appuis réels. **Remettre les compteurs à zéro** efface les totaux de la session ; seuls les réglages d’affichage sont conservés sur disque.

Deux options supplémentaires sont disponibles, désactivées par défaut :

- **Remettre à zéro à la fin du morceau** utilise une fin de partie confirmée par le jeu.
- **Afficher le widget au début du morceau** montre le widget compact à sa position actuelle, avec les clics traversants. Cliquez d’abord sur **Démarrer** pour activer la lecture des entrées de cette session.

Ces deux automatismes nécessitent le module des widgets Clone Hero et au moins une fonction **Paroles** ou **Accuracy** activée dans **Catalogue → Téléchargements → Intégrations Clone Hero**. Les débuts et fins confirmés proviennent de cette connexion au jeu. Le compteur et sa remise à zéro manuelle fonctionnent aussi sans module.

Le widget du jeu peut rester au-dessus des autres fenêtres ; l’option correspondante se règle dans le Tableau de bord. Un jeu en plein écran exclusif peut empêcher cet affichage : le mode fenêtré ou sans bordure peut être nécessaire.

Références techniques : [Gamepad API du W3C](https://www.w3.org/TR/gamepad/) et [XInput de Microsoft](https://learn.microsoft.com/en-us/windows/win32/xinput/getting-started-with-xinput).
