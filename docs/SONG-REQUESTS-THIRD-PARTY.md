# Dépendances de la réception TikTok

ChartsHub intègre localement :

- `tiktok-live-connector` 2.5.0 — [projet et licence](https://github.com/zerodytrash/TikTok-Live-Connector/tree/v2.5.0).
- `tiktok-live-proto` 0.2.4 — schémas du protocole, livrés avec leur licence.
- `tiktok-live-api-sdk` 0.4.0-beta1 — client Euler Stream, licence MIT.

Les licences complètes et les mentions de copyright restent dans chaque paquet distribué, à l’intérieur de `resources/app.asar/node_modules`. Des copies des licences des deux paquets sous AGPL avec permissions supplémentaires sont également conservées dans `docs/licenses`.

Les fichiers LICENSE de `tiktok-live-connector` et `tiktok-live-proto` comprennent les sections 18 à 21 autorisant certaines intégrations, notamment les bots de stream et applications de bureau. Ces permissions supplémentaires ne couvrent pas de la même manière un service réseau hébergé : la réception reste dans le processus local de ChartsHub.

La connexion publique au LIVE utilise le service de signature tiers Euler Stream à une adresse fixe. Aucun compte Euler, clé API ou cookie TikTok n’est embarqué. Les quotas anonymes du service portent sur les requêtes de connexion/signature, pas sur chaque commentaire reçu. Le service peut changer ou être indisponible.

Sources : [connecteur](https://github.com/zerodytrash/TikTok-Live-Connector#readme), [Euler Stream](https://www.eulerstream.com/docs/api/rate-limits).
