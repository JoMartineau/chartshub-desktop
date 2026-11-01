# ChartsHub 0.14.34

L’Input Viewer distingue maintenant sa fenêtre de réglages du widget affiché au-dessus du jeu. L’éditeur est opaque, déplaçable et redimensionnable ; il ne reste plus devant toutes les fenêtres.

- **Configurer les touches** ouvre directement l’association des entrées. Le guide affiche **Démarrer → Choisir la guitare → Associer les touches**, avec le nombre de touches déjà associées.
- **Afficher au-dessus du jeu** ouvre un widget compact. **Déplacer et redimensionner** affiche sa poignée ; **Verrouiller la position** laisse passer les clics vers le jeu. **Masquer le widget du jeu** retire uniquement cet affichage.
- **Copier le lien navigateur OBS** fournit une source Navigateur transparente dédiée et active le serveur Stream si nécessaire. Cette source reprend les couleurs, formes, trails et entrées du viewer, sans capturer sa fenêtre de réglages.
- Les sorties utilisent uniquement l’état visuel des touches. L’arrêt, la déconnexion et une interruption de lecture effacent les appuis pour éviter une touche bloquée.

Accès : **Companion → Stream / OBS → Input Viewer**. Après avoir choisi votre guitare, associez chaque frette, le strum et Star Power avec **Associer cette entrée**. La détection du contrôleur ne remplace pas cette association.

Gardez ChartsHub et l’éditeur ouverts ou réduits pendant la lecture de la guitare. Fermer l’éditeur arrête la lecture. Le clavier reste limité à la fenêtre active de l’éditeur. Un plein écran exclusif peut empêcher l’affichage au-dessus du jeu ; utilisez le mode fenêtré ou sans bordure si nécessaire.

Les douze styles, six trails et réglages existants sont conservés. Aucun VST ni MelonLoader n’est ajouté dans cette version.
