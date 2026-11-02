# ChartsHub 0.14.38

## Catalogue flottant

- **Recherche pendant la frappe** : les résultats se chargent après une courte pause, sans devoir appuyer sur Entrée. Le bouton Rechercher et Entrée permettent toujours de lancer immédiatement la recherche. Les anciennes réponses ne remplacent pas une recherche plus récente ; les limites réelles de ChorusEncore restent respectées.
- **Pochettes ChorusEncore** : rétablit les images d’album fournies par la source, avec le même chargement local contrôlé que les pochettes ChartsHub. Une image absente ou invalide conserve son remplacement discret.
- **Niveaux d’instrument** : conserve les nombres fournis par ChorusEncore, y compris zéro et les niveaux personnalisés supérieurs à six. Les valeurs absentes ou invalides ne deviennent pas des niveaux inventés.
- **Cartes plus compactes** : réduit les marges et regroupe les informations et les actions pour afficher davantage de charts dans la fenêtre flottante.
- **Téléchargements ChartsHub** : un changement de la bibliothèque locale ne grise plus inutilement les charts encore disponibles. Leur disponibilité est vérifiée de nouveau au moment de l’ajout. Les résultats externes périmés nécessitent toujours une nouvelle recherche.

Les téléchargements restent déclenchés par votre clic. Le catalogue principal conserve sa disposition.

Le test des délais d’erreur de téléchargement utilise désormais une horloge contrôlée après le début réel de lecture du flux. Un disque lent ne provoque plus un faux échec de ce test ; le comportement du téléchargement n’est pas modifié.
