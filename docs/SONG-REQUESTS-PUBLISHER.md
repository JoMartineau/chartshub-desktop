# Connexion Twitch — configuration unique de l’éditeur ChartsHub

Les utilisateurs finaux n’ont pas à créer d’application Twitch ni à saisir une clé. Cette inscription appartient à l’éditeur de ChartsHub et doit être terminée avant de publier une version annonçant la connexion Twitch directe.

1. Dans la [console développeur Twitch](https://dev.twitch.tv/console/apps), enregistrer une application dédiée **ChartsHub Desktop**, catégorie Chat Bot, avec un type de client **Public**. Ne pas modifier le type d’une application confidentielle utilisée par un autre service. La console peut demander une URL de redirection ; `http://localhost` peut être utilisée pour cette inscription, mais le flux appareil n’utilise pas de serveur de rappel local.
2. Copier uniquement le **Client ID** public dans `companion/song-request-config.cjs` (`twitchClientId`). Aucun Client Secret n’est nécessaire et aucun secret ne doit être distribué dans le binaire ou le dépôt.
3. Construire et tester l’application. **Connecter Twitch** utilise le Device Code Grant avec `user:read:chat user:write:chat`, ouvre uniquement la page d’activation Twitch, puis valide l’identité retournée. Les jetons sont conservés chiffrés par Electron `safeStorage`, dans le processus principal.

Le Client ID du dépôt reste vide jusqu’à l’inscription réelle de ChartsHub. Dans cet état, le bouton retourne `setup_required` et n’ouvre pas un faux formulaire de connexion. Ne pas remplacer cette valeur par une application d’exemple ou l’identifiant d’un autre logiciel.

L’adaptateur n’ouvre EventSub que lorsque l’utilisateur a connecté son compte et activé la réception. Il valide les jetons, renouvelle les jetons publics en sérialisant leur rotation, traite les révocations et annule les requêtes lors de l’arrêt. Les publications de messages ayant un résultat incertain ne sont jamais rejouées automatiquement.

Références officielles : [enregistrer une application](https://dev.twitch.tv/docs/authentication/register-app/), [Device Code Grant](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow), [authentification des chatbots installés](https://dev.twitch.tv/docs/chat/authenticating), [validation des jetons](https://dev.twitch.tv/docs/authentication/validate-tokens/).

## TikTok

La réception TikTok ne nécessite pas d’inscription développeur ChartsHub : le connecteur local utilise la signature anonyme Euler Stream. Ce n’est pas une API officielle TikTok. La distribution doit conserver les licences des paquets `tiktok-live-connector`, `tiktok-live-proto` et `tiktok-live-api-sdk` ; les deux premiers comprennent des permissions supplémentaires pour les intégrations de bureau. Cette intégration ne fournit pas de relais de chat sur le site ChartsHub et n’envoie aucun cookie TikTok. Voir [les dépendances et leurs licences](SONG-REQUESTS-THIRD-PARTY.md).

Les réponses automatiques TikTok ne sont pas implémentées dans ce mode anonyme. Une future intégration authentifiée devra faire l’objet d’un flux d’autorisation distinct, sans copie de cookies depuis le navigateur.
