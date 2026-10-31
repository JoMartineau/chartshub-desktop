# ChartsHub 0.14.32

Le Companion propose des widgets sans MelonLoader, une capture séparée des paroles et un Input Viewer personnalisable pour guitare et batterie.

- **Mini-widget ReShade** : son niveau au-dessus des fenêtres est réaffirmé à chaque affichage, sans prendre le focus du jeu. Le plein écran exclusif peut empêcher l’affichage de fenêtres externes ; utilisez le mode fenêtré ou sans bordure si nécessaire.
- **Input Viewer** : cinq frettes, grattage et Star Power, ou batterie avec quatre/cinq pads, cymbales et pédale. Les affectations, couleurs, formes, positions, tailles et traînées sont personnalisables. Les traînées peuvent défiler vers le haut, le bas, la gauche ou la droite.
- L’Input Viewer s’ouvre depuis **Companion → Stream / OBS**. Les entrées ne sont lues qu’après un clic sur **Démarrer**. Les manettes/guitares doivent être exposées par Gamepad API ; certaines interfaces USB ne le sont pas. Le clavier fonctionne uniquement dans la fenêtre active du viewer, sans écoute globale. Dans OBS, utilisez une source Capture de fenêtre « ChartsHub — Input Viewer ».
- La configuration du viewer est enregistrée localement. Aucun historique d’entrées n’est enregistré. Ce viewer ne calcule pas l’avance ou le retard des frappes par rapport aux notes et ne remplace pas Accuracy ou une calibration.
- **Paroles dans OBS** : une troisième capture recadrée reprend les paroles réellement affichées par le jeu, à côté des sorties Highway et Score. Choisissez la fenêtre du jeu, démarrez explicitement la capture puis tracez chaque zone. Le fond présent dans la zone reste visible. La capture ne démarre jamais automatiquement et s’arrête à la fermeture ou à la perte de la fenêtre.
- **Retrait des fonctions expérimentales publiques** : l’assistant Calibration BETA, MelonLoader, son installateur et les widgets de mesures associés ne sont plus proposés. Les binaires du connecteur ne sont pas distribués. Les anciens réglages sont conservés dans les profils et restent masqués.
- Les widgets du titre, de l’artiste, du charter, de l’instrument et de la difficulté restent disponibles. Le texte des paroles locales et la vidéo synchronisée attendent une horloge de jeu compatible ; utilisez la capture Paroles pour afficher celles du jeu sans connecteur.
- L’éditeur conserve ses dispositions Jeu/Stream, les déplacements groupés, les couleurs et les profils existants. Les mises à jour des mesures ne reconstruisent plus tous les réglages de l’éditeur.

Les tests de capture utilisent des images synthétiques et ne remplacent pas un essai dans votre jeu et dans OBS. Les tests de développement des anciennes mesures utilisent uniquement un opt-in explicite et ne font pas partie de l’interface publique.
