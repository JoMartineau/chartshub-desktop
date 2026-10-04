# ChartsHub Desktop

Application de bureau pour https://chartshub.ca : téléchargement des charts dans le dossier choisi, sans la restriction du navigateur sur `song.ini`.

## Utilisation

Ouvrez le catalogue comme visiteur ou connectez-vous avec votre compte ChartsHub. Choisissez Télécharger dans le catalogue, ou Télécharger pour vérification dans l'administration si vous avez les droits nécessaires. L'application demande le dossier de destination, vérifie la taille de chaque fichier et son empreinte SHA-256 lorsqu'elle est fournie, puis y déplace la chart complète. Les droits sont contrôlés par le serveur. La limite totale est de 2 Go.

Le site doit disposer de l'intégration `ChartsHubDesktop`. L'application nécessite Internet et conserve la session de connexion sur cet ordinateur. Aucun mot de passe, jeton administrateur ou code du serveur n'est inclus dans ce dépôt.

## Développement

Le Companion 0.12 ajoute un assistant qui télécharge ReShade depuis son site
officiel et propose un pack bloom, grain et aberration chromatique. Le panneau
et le widget contrôlent aussi vos effets existants. Voir [les instructions ReShade](docs/RESHADE.txt).

La version 0.12.1 retire les plafonds de taille de la bibliothèque locale et
des associations : le scan complet et la pagination prennent en charge les
grandes collections, avec conservation du dernier index en cas d’interruption.
Le pont natif se compile avec `reshade-bridge/build.ps1` ; le moteur classique
indépendant reste disponible via `native-filters/build.ps1`. Les deux binaires
sont nécessaires avant de construire la distribution Windows x64.

Node.js 24 et npm sont nécessaires.

```sh
npm ci
npm test
npm start
```

## Versions téléchargeables

Les archives sont disponibles sur [GitHub Releases](https://github.com/JoMartineau/chartshub-desktop/releases). Le workflow `Desktop release` teste et compile Windows x64, Linux x64, macOS Intel et macOS Apple Silicon sur leurs systèmes respectifs. Une modification des sources sur `main` lance ce workflow : il publie la préversion correspondant à `package.json` après la réussite des quatre compilations, avec les empreintes SHA-256 des archives.

### Version 0.14.0 — préversion

- Le catalogue et le Companion partagent la même fenêtre, avec deux onglets pour passer de l’un à l’autre.
- Un compte ChartsHub ordinaire permet d’ouvrir le Companion. Les outils d’administration et de modération restent réservés aux comptes autorisés ; une déconnexion retire l’accès au Companion.
- Les réglages des widgets, les dispositions, les associations de la bibliothèque et les préférences restent enregistrés localement sur cet ordinateur. Ils ne sont pas enregistrés dans le compte ChartsHub et ne suivent pas une connexion sur un autre appareil.
- Les profils d’overlay et le verrouillage des widgets sont inclus. La bibliothèque travaille en arrière-plan et ne fixe plus de plafond de chansons ; la comparaison des doublons permet de choisir les copies identiques à envoyer à la Corbeille après confirmation.
- Sous Windows x64, l’assistant installe ReShade depuis sa source officielle et propose trois effets optionnels : bloom, grain et aberration chromatique. Il conserve les presets existants. Le moteur classique de filtres reste également disponible.
- Les archives Windows incluent les deux modules compilés et les notices MinHook, ReShade et nlohmann/json. La CI utilise Zig 0.14.1, téléchargé depuis ziglang.org et vérifié par SHA-256 avant compilation.

Cette version conserve le statut expérimental des précédentes publications. Les fonctions ReShade et les filtres natifs sont propres à Windows x64 ; leur présence n’est pas annoncée comme prise en charge sur macOS ou Linux.

### Version 0.1.14

- Messages français précisant pourquoi une archive R2 ne peut pas être téléchargée : import non terminé, archive indisponible, version modifiée ou blocage antivirus. Les détails privés du serveur restent masqués.
- Le téléchargement natif conserve le dossier d’exportation et les vérifications de fichiers existants. Les nouvelles commandes de modération, dont la sélection individuelle des charts et leurs liens Google Drive, sont chargées depuis le site après le déploiement du correctif serveur.

### Version 0.1.13

- Enregistrement des rapports du Chart Checker en JSON avec une fenêtre « Enregistrer sous » dans l'application.
- Vérification du compte et de l'origine de la page avant l'export d'un rapport ; un changement de compte interrompt l'opération.
- Correctifs de la version 0.1.12 inclus : vidéos reconnues par le site et progression des téléchargements liée au compte.
- Compatibilité avec les téléchargements Google Drive et les archives R2 servis par l'API ChartsHub, dans le dossier d'exportation choisi.

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

### Version 0.1.12 — audit du 28 septembre 2026

Les exports natifs acceptent les dix formats vidéo déjà reconnus par le site. L’historique et la progression des téléchargements sont liés au compte : une déconnexion, un changement de compte ou une perte de droits efface cet état et interrompt le transfert associé. Une navigation du même compte conserve la progression après vérification de la session.

Ces correctifs sont inclus dans la version 0.1.13.
