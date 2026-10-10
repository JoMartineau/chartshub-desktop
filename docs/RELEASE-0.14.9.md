# ChartsHub Desktop 0.14.9

Windows x64, Linux x64, macOS Intel et Apple Silicon.

- **Cartes du catalogue flottant** : pochettes d’album, noms de charters colorés et badges, avec instruments, notes de difficulté et détails du chart comme dans le catalogue ChartsHub. Les informations absentes restent masquées et les pochettes indisponibles ont un remplacement discret.
- **Détails accessibles pendant le jeu** : informations du chart repliables dans le panneau, en français ou en anglais, avec les préférences de police, couleur et transparence conservées.

- **Doublons** : choisissez la version à conserver, puis chaque copie à envoyer à la Corbeille. Aucune copie n’est cochée automatiquement. Le récapitulatif et la confirmation Windows protègent la version gardée et les copies non choisies.
- **Vérifications renforcées** : les fichiers sont comparés et leur état depuis le scan est contrôlé de nouveau avant le nettoyage. Les changements, chemins hors de Songs, liens/jonctions et cibles ambiguës bloquent l’opération. Corbeille Windows uniquement, sans suppression définitive.
- **Comparaison et historique** : détail des différences fichier par fichier, arrêt de la vérification globale et historique persistant des copies traitées. « Supprimer quand même » reste réservé aux copies entièrement vérifiées ayant les mêmes notes, avec une confirmation renforcée.
- **Catalogue flottant** : recherche par titre, artiste ou charter, filtres, téléchargements et récents au-dessus du jeu en mode fenêtré ou sans bordures. `Ctrl+Maj+K` affiche ou masque la fenêtre (`Commande+Maj+K` sur macOS).
- **Apparence personnalisable** : fond, transparence, texte, police et taille du Catalogue et du panneau Filtres, avec aperçu avant enregistrement et préférences indépendantes conservées après redémarrage.
- **Notifications** : les résultats des nouveaux téléchargements du Catalogue et du Companion rejoignent le centre du compte. Alertes natives selon les préférences ; mode discret pendant la détection de Clone Hero. Une déconnexion ou un changement de compte invalide les notifications encore en attente.
- **Site partagé dans l’application** : centre lu/non lu avec suppression des notifications lues, préférences par catégorie, profils de charters améliorés et nouveau preview néon ChartsHub. Le preview distingue notes normales, HOPO, TAP, notes ouvertes, pads et cymbales ; cinq couleurs de notes conservées et kick violet.

Le centre du compte, les profils et le nouveau preview sont fournis par le site : leur disponibilité nécessite le déploiement de ChartsHub **1.8.3**. Installer l’archive Desktop seule ne déploie pas le site. Le Catalogue flottant utilise sa propre interface de recherche et de téléchargement ; le preview partagé s’ouvre dans le catalogue principal.

Conservez votre profil ChartsHub, vos réglages et vos dossiers de chansons lors de la mise à jour. Les anciens index Songs doivent être rescannés avant le nettoyage des doublons. Les copies envoyées à la Corbeille restent restaurables depuis Windows.

Téléchargez l’archive de votre système et consultez `Lisez-moi.txt`. Les empreintes des quatre archives figurent dans `SHA256SUMS.txt`. Les artefacts « candidate » produits sur une pull request servent à la validation et ne créent ni tag ni publication.

Version expérimentale : Windows non signé commercialement, macOS non notarisé. ReShade et les filtres natifs nécessitent Windows x64. L’affichage au-dessus d’un jeu en plein écran exclusif n’est pas garanti.
