# ChartsHub Desktop

Application de bureau pour https://chartshub.ca : téléchargement des charts dans le dossier choisi, sans la restriction du navigateur sur `song.ini`.

## Utilisation

Connectez-vous avec votre compte ChartsHub. Choisissez Télécharger dans le catalogue, ou Télécharger pour vérification dans l'administration. L'application demande le dossier de destination, vérifie la taille et l'empreinte SHA-256 des fichiers puis y déplace la chart complète. Les droits sont contrôlés par le serveur. La limite totale est de 2 Go.

Le site doit disposer de l'intégration `ChartsHubDesktop`. L'application nécessite Internet et conserve la session de connexion sur cet ordinateur. Aucun mot de passe, jeton administrateur ou code du serveur n'est inclus dans ce dépôt.

## Développement

Node.js 24 et npm sont nécessaires.

```sh
npm ci
npm test
npm start
```

## Versions téléchargeables

Le workflow `Desktop release` compile Windows x64, Linux x64, macOS Intel et macOS Apple Silicon sur leurs systèmes respectifs. Lancez-le dans l'onglet Actions pour préparer une préversion GitHub Releases en brouillon. Vérifiez les quatre archives avant de publier le brouillon.

La première version est expérimentale. Les applications ne disposent pas d'une signature commerciale Windows ni d'une notarisation Apple. La compilation seule ne remplace pas un test de connexion et de téléchargement sur chaque système.

Le code du site et sa base de données restent dans un dépôt privé séparé. Aucune licence de redistribution du code n'est accordée pour le moment ; les dépendances conservent leurs licences respectives.
