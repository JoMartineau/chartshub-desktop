# ChartsHub Desktop 0.14.21

La recherche du Companion et du catalogue flottant propose désormais les
sources **Toutes les sources**, **ChartsHub** et **ChorusEncore**. Les résultats
ChartsHub apparaissent d’abord. Une recherche envoyée par l’utilisateur charge
ensuite ChorusEncore avec les filtres compatibles ; la pagination charge la
suite à la demande.

Les charts ChorusEncore portent leur source et le nom du charter. Le bouton
Télécharger les importe dans le dossier d’exportation configuré, avec la même
file de téléchargements que les charts ChartsHub. Ouvrir la chart mène à sa
page officielle ChorusEncore.

Les favoris, badges de vérification et associations manuelles à la bibliothèque
locale restent liés aux charts ChartsHub. Les erreurs, la suspension du service
et les délais de recherche ChorusEncore s’affichent dans le catalogue. Il n’y a
pas de recherche du fournisseur au démarrage ni de nouvelle tentative en arrière-plan.

Validation : recherches et téléchargements synthétiques, filtres et réponses
malformées, annulation et remplacement de requêtes, reprise de la file,
contrôles des dossiers et vérification des deux interfaces dans Electron.
