# ChartsHub Desktop 0.14.22

Song Request propose les connexions dans ChartsHub : **Connecter Twitch** ouvre
l’autorisation officielle dans le navigateur ; **Connecter TikTok LIVE** utilise
le pseudo du compte. Les spectateurs demandent un morceau avec `!sr artiste titre`
et votent avec `!vote artiste titre`. Les deux plateformes partagent la même file,
limitée aux morceaux déjà présents dans la bibliothèque locale scannée.

La section regroupe les comptes, les demandes et les règles facultatives.
Les réglages du pont Streamer.bot restent accessibles dans les options avancées.
Twitch reçoit les commandes avec EventSub et répond par l’API officielle.
Chaque streamer autorise son propre compte Twitch. L’autorisation est
conservée avec le chiffrement du système, ou seulement pour la session si
ce stockage est indisponible. La réception reste arrêtée au démarrage.

TikTok reçoit les commandes du LIVE via le connecteur tiers non officiel
TikTok-Live-Connector et son service Euler Stream. Aucun mot de passe ni cookie
TikTok n’est demandé. Ce mode reçoit uniquement les messages : le résultat
s’affiche dans ChartsHub, sans réponse automatique dans le chat TikTok.
Un compte hors LIVE ou un service indisponible affiche son état ; les nouvelles
tentatives restent manuelles.

**Copier le lien du widget OBS** fournit une source Navigateur transparente.
La prochaine demande est mise en évidence, suivie de quatre morceaux, avec
les votes et la plateforme de chaque spectateur. La commande pour participer
reste visible. Le streamer accepte, refuse, déplace ou marque les demandes
comme jouées depuis ChartsHub ; le widget permet uniquement leur consultation.

Cette version ne télécharge pas de chart pour une demande et ne lance ni
Clone Hero ni un morceau automatiquement. La publication de la bibliothèque
pour les spectateurs reste facultative et manuelle. Les essais avec de vrais
comptes Twitch et un LIVE TikTok restent à effectuer ; les vérifications
automatisées utilisent des échanges simulés.
