# ChartsHub 0.14.37

## Intégrations Clone Hero · BÊTA

Quick Import, les paroles synchronisées et Accuracy sont regroupés dans **Tableau de bord → Catalogue → Téléchargements → Intégrations Clone Hero**. Les trois fonctions sont facultatives et désactivées à chaque démarrage de ChartsHub. Les profils, positions, tailles et couleurs existants sont conservés.

- **Accuracy** reçoit les écarts réels de frappe : dernier écart, moyenne, écart absolu moyen, dispersion, pourcentage dans la fenêtre et nombre de jugements. Le texte et les valeurs affichées restent personnalisables dans Stream / OBS.
- **Paroles synchronisées** utilise les paroles de la chart locale et l’horloge du jeu, y compris sa vitesse et ses pauses. Une chart absente de la bibliothèque, sans paroles ou ambiguë ne produit aucun texte inventé.
- Une seule installation **MelonLoader 0.7.3** est partagée entre le module Quick Import et le module des widgets. Le module des widgets s’ajoute et se retire séparément, en conservant MelonLoader et Quick Import.
- Le guide et les contrôles d’installation distinguent jeu actif, mauvaise version, installation étrangère ou incomplète, fichiers bloqués, prérequis et premier lancement. Les erreurs interrompent proprement l’installation ; aucune protection Windows n’est désactivée.

Compatibilité validée : **Clone Hero 1.1.0.6142-final Stable · Windows x64**, avec vérification du programme et de ses métadonnées. Les autres versions restent refusées plutôt que supposées compatibles.

Le module est fourni séparément, avec son code source et des scripts réversibles. Aucun binaire du jeu ou de MelonLoader n’est redistribué. Aucun jeu, son ou périphérique n’est démarré automatiquement. L’assistant de calibration reste retiré de l’application publique.

Les mesures Accuracy ont été vérifiées sur ce build du jeu ; la synchronisation des paroles est couverte par des essais synthétiques de pause, vitesse et déplacement de lecture. Un essai dans votre installation reste utile, notamment selon les charts et les autres mods présents.

Les fonctions de la version 0.14.36 sont conservées : accueil, bibliothèque, demandes, chat Twitch/TikTok, sources OBS, Input Viewer, Batterie / VST, thèmes et récupération des mises à jour.

## Compteurs Input Viewer

- Compteur d’appuis indépendant pour chaque bouton de guitare ou de batterie, avec les mêmes totaux dans l’éditeur, le widget du jeu et OBS. Une pression maintenue compte une fois ; la démo garde ses propres valeurs.
- Affichage des compteurs et remise à zéro manuelle ; les totaux restent en mémoire pendant la session.
- Options facultatives de remise à zéro à la fin du morceau et d’affichage du widget au début du morceau. Elles utilisent les événements confirmés du module des widgets déjà activé. L’affichage automatique conserve la position et nécessite une lecture des entrées démarrée par le joueur.

[Mode d’emploi de l’Input Viewer](INPUT-VIEWER.md).

## Corrections

- **Batterie / VST** : corrige le blocage des pads et des réglages de l’éditeur VST. L’hôte transmet de nouveau les événements de mise à jour du plug-in. Annuler l’ouverture d’un instrument libère les commandes et empêche un chargement tardif après l’arrêt. Les réglages audio verrouillés pendant la lecture indiquent comment les modifier.
- **Catalogue principal et flottant** : distingue la maintenance du site d’un quota ChorusEncore. Après la réouverture du site, une recherche peut être relancée sans conserver les 300 secondes d’attente de la maintenance. Les véritables limites du service sont conservées.
- **Widgets facultatifs** : Accuracy et les paroles ne lisent ni ne modifient les anciens records. Une vérification d’installation lente laisse disponible l’arrêt de ces widgets.

Le correctif de l’interface VST a été reproduit et vérifié avec un éditeur synthétique dans le véritable moteur natif, sans périphérique audio. Un essai de MT Power Drum Kit avec votre sortie audio et OBS reste à effectuer.
