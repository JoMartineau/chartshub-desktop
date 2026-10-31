# ChartsHub 0.14.31 — préparation publique

- Retire de la version publique l’assistant Calibration BETA, l’installation de MelonLoader, le connecteur et les sept widgets de mesures qui en dépendent. Aucun fournisseur de mesures ni diagnostic matériel ne démarre ; les commandes associées sont refusées. Les fichiers du connecteur et de MelonLoader sont exclus des paquets publics.
- Conserve les cinq widgets du morceau : titre, artiste, charter, instrument et difficulté. Les profils et documents existants sont conservés ; les anciens widgets dépendants des mesures restent masqués.
- Ajoute une capture recadrée **Paroles** à celles de la highway et du score. Choisissez explicitement la fenêtre du jeu, démarrez la capture puis tracez chaque zone. Chaque sortie possède sa fenêtre OBS. Les paroles sont celles affichées par le jeu ; le fond de la zone reste visible. Aucun MelonLoader ni accès mémoire au jeu n’est requis.
- La capture reste locale, ne démarre pas automatiquement et s’arrête à la fermeture de l’aperçu, à la perte de la fenêtre, à l’arrêt ou à la fermeture du Companion. Une nouvelle sélection est nécessaire ensuite. La séparation transparente des éléments natifs est indisponible.
- Le widget de paroles textuelles synchronisées nécessite une horloge de jeu et n’est pas proposé dans la version publique. Utilisez la capture Paroles. La vidéo locale synchronisée attend elle aussi une horloge compatible ; aucun décompte approximatif n’est présenté comme une position mesurée.
- Conserve l’édition groupée des widgets, les dispositions Jeu/Stream indépendantes, les thèmes et les sources du morceau. Les réglages inutiles ne sont pas reconstruits à chaque rafraîchissement.

Les anciens essais de mesures et de calibration restent accessibles uniquement aux tests de développement avec un opt-in explicite. Ils ne font pas partie de la version publique et ne modifient aucun réglage du jeu.
