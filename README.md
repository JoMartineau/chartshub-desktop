# ChartsHub Desktop

Application de bureau pour https://chartshub.ca : téléchargement des charts dans le dossier choisi, sans la restriction du navigateur sur `song.ini`.

## Utilisation

Ouvrez le catalogue comme visiteur ou connectez-vous avec votre compte ChartsHub. Choisissez Télécharger dans le catalogue, ou Télécharger pour vérification dans l'administration si vous avez les droits nécessaires. L'application demande le dossier de destination, vérifie la taille de chaque fichier et son empreinte SHA-256 lorsqu'elle est fournie, puis y déplace la chart complète. Les droits sont contrôlés par le serveur. La limite totale est de 2 Go.

Le site doit disposer de l'intégration `ChartsHubDesktop`. L'application nécessite Internet et conserve la session de connexion sur cet ordinateur. Aucun mot de passe, jeton administrateur ou code du serveur n'est inclus dans ce dépôt.

## Développement

Node.js 24 et npm sont nécessaires.

```sh
npm ci
npm test
npm start
```

## Versions téléchargeables

Les archives sont disponibles sur [GitHub Releases](https://github.com/JoMartineau/chartshub-desktop/releases). Le workflow `Desktop release` teste et compile Windows x64, Linux x64, macOS Intel et macOS Apple Silicon sur leurs systèmes respectifs. Une modification des sources sur `main` lance ce workflow : il publie la préversion correspondant à `package.json` après la réussite des quatre compilations, avec les empreintes SHA-256 des archives.

### Version 0.1.11

- Téléchargement des soumissions récentes pour vérification, y compris leurs vidéos.
- Compatibilité avec les inventaires sans empreinte SHA-256 obligatoire ; les empreintes fournies restent vérifiées.
- Messages précis pour les quotas Google Drive, les permissions et les fichiers modifiés.
- Annulation et nettoyage des téléchargements incomplets conservés.

### Version 0.1.10

- Conservation de la progression des téléchargements après un changement de page ou de disposition du catalogue.
- Progression par chart dans les téléchargements groupés et annulation cohérente.
- Compatibilité des noms de fichiers avec le serveur et gestion des transferts qui restent sans réponse.
- Actualisation des droits de la vue visiteur lors d'un changement de compte.

La première version est expérimentale. Les applications ne disposent pas d'une signature commerciale Windows ni d'une notarisation Apple. La compilation seule ne remplace pas un test de connexion et de téléchargement sur chaque système.

Le code du site et sa base de données restent dans un dépôt privé séparé. Aucune licence de redistribution du code n'est accordée pour le moment ; les dépendances conservent leurs licences respectives.
