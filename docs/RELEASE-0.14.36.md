# ChartsHub 0.14.36

## Tableau de bord / Dashboard

- Nouveau nom visible pour Companion, avec les mêmes profils, réglages et raccourcis conservés.
- Accueil avec morceau, demandes, téléchargements, connexions et accès directs aux outils existants.
- Chat Twitch / TikTok regroupé, avec réception volontaire, filtre, pause de l’affichage et effacement. Kick reste non configuré.
- Demandes introuvables : recherche explicite dans le catalogue, téléchargement choisi, puis sélection du morceau installé avant confirmation dans la file.
- Formulations titre « by / par » artiste reconnues après une recherche littérale infructueuse.
- Widgets Navigateur OBS pour le chat et l’activité, avec couleur, taille et nombre de lignes. Partages désactivés au démarrage ; pseudos de l’activité masqués par défaut.

Les fonctions existantes de bibliothèque, file, Input Viewer, captures du jeu, Batterie / VST et thèmes sont conservées. Aucun module Accuracy ni assistant de calibration n’est réintroduit.

## Quick Import · BÊTA

- Section facultative dans Catalogue → Téléchargements, avec étapes numérotées en français et en anglais.
- Compatibilité affichée : **Clone Hero 1.1.0.6142-final Stable · Windows x64**. Les autres versions ne sont pas validées.
- Choix explicite du jeu et connexion volontaire, désactivée à chaque démarrage de ChartsHub. Les autres widgets et les téléchargements restent utilisables sans Quick Import.
- Ajout des nouvelles charts au format Dossier depuis le catalogue principal ou le Tableau de bord, sans scan complet. Les formats `notes.chart` et `notes.mid` sont pris en charge par le module compatible ; les archives conservées ZIP/SNG et les téléchargements administrateur de vérification sont exclus.
- Mise en attente pendant une partie, résultats confirmés par le jeu et bouton d’actualisation. Les imports acceptés peuvent se terminer après une déconnexion ; aucun ancien téléchargement n’est rejoué.

L’option nécessite le module ChartsHub Quick Import et MelonLoader dans le jeu. La sélection du programme n’installe aucun module. La validation utilise une copie isolée du jeu avec des charts synthétiques ; elle ne constitue pas une garantie de compatibilité avec les futures versions ou une mesure de performances sur toutes les bibliothèques.

[Guide Quick Import](QUICK-IMPORT.md). Les fonctions Batterie / VST de 0.14.35 sont conservées.
