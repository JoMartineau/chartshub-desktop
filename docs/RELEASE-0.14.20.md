# ChartsHub Desktop 0.14.20

L’analyse de la bibliothèque traite jusqu’à quatre dossiers en parallèle et
évite des vérifications répétées sur les fichiers qui ne servent pas à l’index.
L’actualisation rapide réutilise les métadonnées des charts inchangées.

Les contrôles de tous les fichiers avant et après lecture sont conservés.
L’annulation attend la fermeture des opérations en cours ; les protections
des chemins et le nettoyage des doublons restent inchangés. L’analyse ne lit
pas le contenu des fichiers audio, vidéo ou image.

Sur une bibliothèque synthétique de 1 000 charts, deux mesures par mode donnent
43,2 à 18,2 secondes en analyse complète et 25,7 à 8,1 secondes en actualisation
rapide. Ces mesures locales ne prédisent pas le temps d’une bibliothèque réelle
de 83 000 charts : il dépend aussi du disque et des fichiers.
