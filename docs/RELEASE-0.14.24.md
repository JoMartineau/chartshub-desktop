# ChartsHub Desktop 0.14.24

Les actions du catalogue Companion, dont « Ajouter à la file », gardent leur
position au survol. Leur fond reste opaque pendant le changement de couleur,
ce qui évite le scintillement près du curseur.
Les actualisations d’état conservent aussi les cartes et le focus du clavier
tant que la langue ne change pas.

Un menu natif au clic droit permet de couper, copier, coller, annuler et tout
sélectionner dans les champs du Catalogue et de Companion. Les commandes
agissent sur le champ ouvert dans l’onglet concerné.

Une liste Song Request déjà publiée se synchronise après les changements de
bibliothèque détectés par un scan terminé et après une modification des règles.
Les changements rapprochés sont regroupés ; un scan sans changement ne renvoie
pas toute la liste. Le lien public reste identique et l’ancienne publication
reste disponible si un envoi échoue. La première publication reste volontaire.
Une page spectateur déjà ouverte voit la nouvelle liste à sa prochaine recherche
ou à son prochain rechargement.

Le scan traite davantage de dossiers en parallèle et évite une vérification
redondante de chaque sous-dossier. Les contrôles des fichiers avant et après
lecture, le cache du scan rapide et l’annulation restent actifs. Le gain dépend
du disque et du contenu de la bibliothèque.
