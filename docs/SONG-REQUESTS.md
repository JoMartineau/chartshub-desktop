# Song Request — Twitch, YouTube et TikTok

Le Companion reçoit les demandes du chat pour les morceaux **déjà présents dans le dossier Songs scanné**. Il ne télécharge aucune chart, ne lance pas Clone Hero et ne joue pas automatiquement un morceau. Le streamer accepte, refuse, déplace ou marque les demandes comme jouées. La file vit dans la session : elle est vidée au redémarrage et la réception doit être réactivée.

Le port, les règles et les deux clés locales sont conservés dans le profil du Companion. Il n’est donc pas nécessaire de refaire la configuration Streamer.bot ou OBS à chaque démarrage. Le jeton du pont autorise les commandes de chat ; celui de l’overlay permet seulement la lecture. Un fichier de réglages invalide ou remplacé est conservé et bloque la modification : le Companion ne régénère pas silencieusement ses clés.

L’organisation pratique du tableau de bord et de la file s’inspire de [ClonePod](https://github.com/itsCuttle/ClonePod). Cette intégration utilise le thème ChartsHub et sa bibliothèque locale ; elle ne reprend pas de binaire ClonePod, de téléchargement automatique ou de connexion Kick.

## Dans ChartsHub

1. Choisir le dossier Songs dans la bibliothèque locale, puis le scanner.
2. Dans **Song Request**, définir éventuellement une durée maximale, un instrument et une difficulté, puis appliquer. Une métadonnée inconnue ne satisfait pas une règle active.
3. Activer **Recevoir les demandes du chat**. Le port local par défaut est `38474` ; il peut se changer lorsque la réception est arrêtée.
4. Cliquer **Copier la configuration du pont**. Le presse-papiers contient un JSON avec `url` et `token`, réservé à Streamer.bot sur ce même PC. Le jeton est une clé locale ChartsHub ; ce n’est pas un jeton Twitch, Google ou TikTok. Ne pas publier ce JSON dans le chat ni dans une capture.
5. Pour OBS, utiliser le bouton distinct **Copier l’URL OBS de la file**, puis ajouter une source Navigateur. Son jeton donne seulement accès à l’affichage de la file, pas à sa gestion.

Les spectateurs n’ont pas besoin de compte ChartsHub. La validation des fichiers locaux est refaite lors de la réception et de l’acceptation. Un fichier absent ou déplacé n’est pas accepté sur la seule foi d’un ancien scan.

## Partager la liste des morceaux disponibles

La section **Liste publique pour les spectateurs** propose une page ChartsHub consultable sans compte. Le streamer utilise son compte ChartsHub connecté et vérifié pour publier ou retirer sa propre liste.

1. Scanner Songs, puis cliquer **Publier la liste**. Cette action explicite envoie les titres, artistes, charters, durées, instruments/difficultés et identifiants de commande des morceaux vérifiés, ainsi que les règles appliquées. Aucun audio, contenu de notes, chemin local, pseudo du chat ni historique de demandes n’est envoyé.
2. Cliquer **Copier le lien public** et partager ce lien avec les spectateurs. Ils peuvent consulter les morceaux et copier une commande `!sr` dans le chat du direct. La page publique ne commande pas directement le Companion et ne permet pas de gérer la file.
3. Après un ajout, un retrait ou un déplacement dans Songs, rescanner puis cliquer **Actualiser la liste**. La page contient un **instantané publié manuellement**, pas une vue en direct du disque ni de la file. Les morceaux devenus indisponibles sont exclus lors de la publication ; leur nombre est indiqué dans le Companion.
4. Cliquer **Retirer le partage** pour rendre cette liste inaccessible via son lien. Ce retrait reste disponible si la bibliothèque locale est indisponible et ne supprime aucun morceau ni demande de la session.

La publication ne démarre jamais au lancement, au scan, à la réception d’un vote ou au changement de langue. Elle n’active pas la réception du chat. La liste publique reste sur ChartsHub jusqu’à son actualisation ou son retrait, tandis que la file du Companion reste limitée à la session. Toute nouvelle demande issue d’un ancien instantané est à nouveau vérifiée dans Songs.

Le lien public peut être communiqué aux spectateurs. La configuration JSON du pont et l’URL locale OBS doivent rester dans leurs outils respectifs : ce sont trois accès distincts.

## Twitch et YouTube avec Streamer.bot

Connecter les comptes dans Streamer.bot avec ses écrans de connexion. ChartsHub ne demande aucun mot de passe de plateforme, aucun `client_secret` et aucun jeton OAuth de ces comptes.

Dans **Global Variables**, créer deux variables persistantes de type texte, en copiant séparément les valeurs du JSON ChartsHub :

| Variable | Valeur |
| --- | --- |
| `chartshubSongRequestUrl` | La valeur `url`, par exemple `http://127.0.0.1:38474/song-requests` |
| `chartshubSongRequestToken` | La valeur `token` locale, conservée privée |

Créer une action contenant **Core → C# → Execute C# Code** et y coller [ChartsHub-SongRequest.cs](song-requests/ChartsHub-SongRequest.cs). Faire **Save and Compile**. Le script utilise `HttpClient` et `Newtonsoft.Json`, comme l’[exemple POST officiel](https://docs.streamer.bot/examples/http-post).

Créer quatre commandes : `!sr`, `!vote`, `!queue`, `!song`. Associer à l’action un déclencheur **Core → Commands → Command Triggered** pour chacune. Choisir le mode « Starts With » pour les commandes à paramètres, et limiter les sources à Twitch/YouTube. Ignorer les messages internes et ceux du bot ; conserver les délais anti-spam. Streamer.bot fournit `command`, `commandSource`, `rawInput` et `msgId` à l’action ; le script reconstitue la commande complète. [Référence Command Triggered](https://docs.streamer.bot/api/triggers/core/commands/command-triggered).

Pour YouTube, surveiller le direct voulu dans Streamer.bot. Le script utilise `broadcastId` pour répondre au bon direct. Si cette variable n’est pas présente sur votre version de Command Triggered, définir `chartshubYouTubeBroadcastId` avec l’identifiant de la vidéo du direct (la partie `v=` de son lien YouTube), à mettre à jour à chaque nouveau direct. Sans cet identifiant, la demande fonctionne mais le script n’envoie pas sa réponse dans un autre direct. [Envoi YouTube officiel](https://docs.streamer.bot/api/csharp/methods/youtube/chat/send-youtube-message).

## TikTok avec TikFinity et Streamer.bot

TikFinity est un pont tiers, pas une API officielle TikTok intégrée à ChartsHub. Il doit être connecté au direct TikTok. Dans Streamer.bot, activer son serveur WebSocket sur l’interface locale ; dans TikFinity, ouvrir **Setup → Streamer.bot Connection**, saisir la connexion locale et utiliser **Test Connection**. Suivre les paramètres d’authentification proposés par les deux applications ; ne pas exposer ce serveur sur Internet.

Créer quatre actions Streamer.bot. Avant le même code C#, chacune définit deux arguments locaux :

| Commande TikFinity | `chartshubPlatform` | `chartshubCommand` |
| --- | --- | --- |
| `!sr` | `tiktok` | `!sr` |
| `!vote` | `tiktok` | `!vote` |
| `!queue` | `tiktok` | `!queue` |
| `!song` | `tiktok` | `!song` |

Dans TikFinity **Actions & Events**, créer pour chaque commande une action **Streamer.bot Action** ciblant l’action correspondante, puis lui associer l’événement de commande. TikFinity transmet `userId`, `nickname`, `username` et `commandParams`. Pour les réponses, activer dans son Chatbot **Allow Streamer.bot to push messages to TikFinity**. [Procédure et arguments officiels TikFinity](https://tikfinity.zerody.one/streamerbot-integration).

L’identité du spectateur repose sur `userId`, jamais sur le pseudo modifiable. L’intégration TikFinity standard ne documente pas d’identifiant de message : le script attribue un GUID à chaque invocation. Il ne garantit donc pas la déduplication d’un événement que TikFinity rediffuse comme une nouvelle invocation. Les limites par spectateur et le vote unique restent appliqués. Le script ne réessaie pas automatiquement un POST.

Au moment de cette vérification documentaire, le [catalogue public TikTok for Developers](https://developers.tiktok.com/doc/) ne fournit pas d’API publique documentée adaptée à la réception du chat LIVE. L’API de commentaires vidéo n’est pas une API de chat LIVE. La disponibilité de TikFinity dépend de son service et de TikTok.

## Commandes et gestion

| Commande | Effet |
| --- | --- |
| `!sr artiste titre` | Rechercher dans Songs et proposer le morceau ; ajouter un vote s’il est déjà dans la file |
| `!sr id:<identifiant>` | Choisir précisément une version locale proposée en cas d’ambiguïté |
| `!vote artiste titre` | Voter pour une demande déjà active ; ne crée pas de nouvelle demande |
| `!queue` | Afficher les prochaines demandes et sa position éventuelle |
| `!song` | Afficher le morceau en cours, ou le dernier morceau exporté si la source est un export du jeu |

Une recherche ambiguë demande un choix ; elle ne sélectionne pas automatiquement la première version. Un spectateur peut voter une fois par demande. Les flèches du Companion choisissent l’ordre manuel ; accepter une demande l’inscrit comme acceptée, sans lancer la chanson. Marquer « Jouée » ou « Refuser » conserve l’entrée dans l’historique de la session.

Les messages et pseudonymes sont traités comme texte. L’endpoint accepte uniquement des commandes de chat bornées avec une clé locale ; le navigateur OBS ne peut ni accepter une demande, ni changer les règles, ni accéder aux chemins privés. Le script n’envoie aucun contenu de fichier ni identifiant OAuth à ChartsHub.

## Validation de la connexion

Tester avec un titre réellement présent dans Songs. Vérifier l’apparition d’une carte, un vote provenant d’un second spectateur, puis `!queue`. Tester un titre absent : aucun téléchargement ne doit démarrer. Arrêter la réception et vérifier que les nouvelles demandes sont refusées.

Le POST local expire après cinq secondes, sans redirection ni proxy. En cas d’échec, le journal Streamer.bot affiche uniquement une erreur générique ; il ne copie ni le jeton ni la réponse brute. La file peut avoir reçu une demande même si sa réponse réseau a été perdue : vérifier le Companion avant de recommencer.

Ce guide documente les interfaces des outils ; il ne remplace pas une vérification avec vos comptes et un direct réel. Les tests ChartsHub utilisent des messages synthétiques et une bibliothèque isolée.
