# Input Viewer

Dans **Companion → Stream / OBS**, cliquez sur **Ouvrir et personnaliser l’Input Viewer**.

1. Choisissez **Guitare**, **Batterie · 4 pads** ou **Batterie · 5 pads**. Le modèle s’applique immédiatement et rétablit ses réglages, couleurs et affectations. **Rétablir les réglages du modèle** permet de réinitialiser le modèle courant.
2. Sélectionnez **Manette / guitare compatible** ou **Clavier · fenêtre active**, puis cliquez sur **Démarrer**. La lecture des entrées est arrêtée à l’ouverture.
3. Pour une manette, choisissez explicitement le contrôleur proposé. Sélectionnez chaque élément et associez son bouton ou son axe. L’association simplifiée attend une nouvelle pression ; elle ignore les touches déjà maintenues. Les périphériques non exposés par Gamepad API ne sont pas disponibles dans cette version.
4. Modifiez les positions à la souris ou avec X/Y, les tailles, les couleurs, les formes et les étiquettes. Les réglages sont conservés localement ; aucune séquence d’entrées ni identité de périphérique n’est enregistrée.
5. Réglez les traînées : **haut, bas, gauche ou droite**, vitesse, durée, longueur, épaisseur, intensité et fondu. Elles restent uniquement en mémoire et s’effacent à l’arrêt ou lors d’une déconnexion.
6. Pour OBS, cliquez sur **Masquer les réglages**, puis ajoutez une source **Capture de fenêtre** visant **ChartsHub — Input Viewer**. Échap ou un double-clic permet de retrouver les réglages. Le rendu du canevas peut être transparent ; la méthode de capture OBS doit prendre en charge la transparence si elle est souhaitée.

Le clavier est lu uniquement lorsque la fenêtre du viewer est active. Pour jouer dans une autre fenêtre en gardant le viewer animé, utilisez une guitare ou une manette compatible Gamepad API. Aucun raccourci global n’enregistre la frappe clavier.

Le viewer fonctionne indépendamment de Clone Hero et de MelonLoader. Il montre les entrées détectées ; il ne calcule pas l’avance ou le retard par rapport aux notes, la latence physique du matériel ou une valeur de calibration.

La fenêtre demande à rester au-dessus des autres fenêtres. Un jeu en plein écran exclusif peut empêcher cet affichage : le mode fenêtré ou sans bordure peut être nécessaire.

Référence technique : [Gamepad API du W3C](https://www.w3.org/TR/gamepad/).
