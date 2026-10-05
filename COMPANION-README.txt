ChartsHub Desktop 0.14.3 — Catalogue et Companion

NOUVEAUTÉS 0.14.3
Le Companion suit automatiquement la langue Français / English choisie sur ChartsHub, sans redémarrage.
La Bibliothèque locale peut vérifier tous les groupes de doublons en une seule opération, au-delà de la pagination.
Aucune copie n’est supprimée automatiquement : la version à conserver, les copies à envoyer à la Corbeille et la confirmation restent explicites.

ChartsHub Desktop 0.14.2 — Catalogue et Companion

NOUVEAUTÉS 0.14.2
Navigation Compte/Catalogue/Companion stabilisée sans clignotement de l’onglet Companion pendant la revalidation du même compte.
Les déconnexions et changements réels de session continuent de retirer immédiatement l’accès.

ChartsHub Desktop 0.14.1 — Catalogue et Companion

NOUVEAUTÉS 0.14.1
Panneau Thème du Companion avec bloom optionnel et sauvegarde locale.
Disposition du catalogue corrigée pour la fenêtre à onglets.
Conservez les profils, réglages et dossiers de chansons lors de la mise à jour.

ONGLETS INTÉGRÉS 0.14.0
Catalogue et Companion sont réunis dans la même fenêtre ChartsHub.
L’onglet Companion apparaît après connexion à un compte ChartsHub,
y compris un compte ordinaire. Il disparaît à la déconnexion.
Ctrl+Tab change d’onglet ; Ctrl+Maj+C ouvre le Companion si connecté.
Le catalogue conserve sa page, et les widgets restent actifs entre onglets.
Les comptes et réglages utilisent le profil habituel de ChartsHub.

GRANDES BIBLIOTHÈQUES 0.12.1
Le nombre de chansons et de fichiers analysés n’a plus de plafond fixe.
Les plafonds de taille de l’index et du nombre d’associations sont retirés.
Les résultats restent affichés par pages ; le tri est réutilisé entre les pages.
Une analyse interrompue conserve le dernier index terminé.

ASSISTANT D’INSTALLATION RESHADE 0.12.0
Filtres du jeu propose le téléchargement officiel de ReShade 6.8 avec add-ons.
Choisir le dossier de Clone Hero, préparer les fichiers, puis fermer le jeu
et installer dans le dossier affiché. Le pack optionnel contient ArcaneBloom,
FilmGrain et ChromaticAberration, désactivés au départ. Les fichiers remplacés
sont sauvegardés ; les presets et shaders déjà présents sont conservés.
Les joueurs n’ont plus besoin de chercher les téléchargements eux-mêmes.

CORRECTIF D’AFFICHAGE 0.11.1
Les vérifications des filtres conservent leur dernier état confirmé pendant
leur exécution. Les textes et boutons ReShade ne clignotent plus entre les
états connecté et déconnecté lors des actualisations du Companion.

EFFETS RESHADE
Filtres du jeu affiche maintenant les vrais effets de ReShade, avec recherche,
activation individuelle et réglages. Le mini-widget offre les mêmes contrôles.
ReShade 6.8 avec prise en charge des add-ons reste le moteur nécessaire.
Fermer Clone Hero avant Installer l’intégration ReShade. ChartsHub rétablit
la sauvegarde ReShade si son moteur classique l’avait remplacé, puis ajoute
ChartsHubReShade.addon64. Les shaders et presets existants sont conservés.
Relancer le jeu, choisir un effet et enregistrer le preset après les réglages.
Détails et limites : docs/RESHADE.txt dans les sources ou Effets-ReShade.txt.

FILTRES CLASSIQUES (WINDOWS DIRECT3D 11)
La section repliée Filtres classiques et le widget contrôlent aussi un moteur
ChartsHub indépendant de ReShade. Six réglages : saturation, contraste,
gamma, exposition, netteté et vignette. Les filtres démarrent désactivés.
Choisir le dossier du jeu, fermer Clone Hero, puis installer le module
depuis le panneau. Le dxgi.dll précédent est sauvegardé ; Restaurer permet
de le remettre après fermeture du jeu. Presets et shaders ReShade conservés.
Les réglages et thèmes des widgets de texte restent séparés.
Détails et limites : docs/FILTERS.txt dans les sources.

Cette version étend ChartsHub Desktop 0.1.14 sous Electron. ChartsHub Studio
est un projet distinct et n'a pas été modifié.

OUVRIR LE COMPANION
Dans ChartsHub : se connecter, puis cliquer sur l’onglet Companion.
Le menu → Clone Hero Companion et Ctrl+Maj+C ouvrent le même onglet.
La distribution Windows contient également Lancer Companion.cmd.
Ce raccourci ouvre la même application et le même profil. Une connexion
au compte doit être vérifiée pour accéder au Companion. Les fichiers
et réglages du Companion restent locaux sur votre ordinateur.

CONNECTER CLONE HERO
Dans Clone Hero : Settings > General > Export Current Song, activer l'export.
Le format custom_song_export, section [streamer] du settings.ini du jeu,
doit être %s%n%a%n%c : titre, artiste et charter sur trois lignes.
Le Companion lit ces fichiers ; il ne modifie jamais les réglages du jeu.
Dans Source des informations, choisir Direct Clone Hero, puis utiliser la
détection ou choisir currentsong.txt. Le dossier Documents peut être redirigé
vers OneDrive : sélectionner le fichier réellement écrit par le jeu.
Sur Windows, le morceau en cours est repris automatiquement à l'ouverture
si Clone Hero est détecté et si son export date de la session actuelle du jeu.
Un export datant d'avant le démarrage du jeu reste masqué. Si la présence
du jeu ne peut pas être vérifiée, démarrer un morceau après connexion.
Les lectures se font environ toutes les 500 ms ; deux lectures identiques
confirment les données avant affichage.

Le direct fournit titre, artiste et charter. Instrument et difficulté restent
masqués : ils ne sont pas exportés dans ce format. La pause et les écrans
exacts du jeu ne sont pas détectés. Un morceau détecté reste affiché pendant
une pause ; dans les filtres de visibilité, il relève de En jeu.
Le filtre Pause distinct reste utilisable avec la démonstration.
Quand Clone Hero vide l'export, les métadonnées disparaissent des overlays.
Un fichier absent, illisible, désactivé ou d'un format incompatible produit
un diagnostic dans le panneau et ne conserve pas les anciennes données.
Sur Windows, la fermeture confirmée du processus Clone Hero retire aussi
les informations, même si son export n'a pas été vidé. La présence du jeu
est vérifiée avec un cache de deux secondes. Si cette vérification est
indisponible, le fichier seul ne permet pas de détecter un crash : repasser
à la démonstration retire les informations. L'absence de nouvelle écriture
ne suffit pas à déduire un arrêt ou une pause.
Le chemin local reste dans le Companion et n'est pas transmis à OBS.
Détails et procédure de vérification : docs/CLONEHERO-INTEGRATION.txt.

COULEURS DES CHARTERS
Les couleurs originales du nom du charter sont activées par défaut pour
toutes les charts détectées. Les noms multicolores, y compris une couleur
par lettre, sont conservés dans l'aperçu, l'overlay Jeu et Stream / OBS.
Si l'export courant ne contient que le nom brut, le Companion lit les
couleurs du champ charter (ou frets) dans le song.ini correspondant au
titre, à l'artiste et au charter joués. Les dossiers Songs sont retrouvés
dans settings.ini de Clone Hero. La première recherche indexe seulement
les métadonnées en arrière-plan ; sur une grosse bibliothèque, le texte
peut apparaître avant ses couleurs. Les morceaux suivants réutilisent
l'index et relisent le fichier correspondant pour respecter ses couleurs.
Un même charter peut avoir des couleurs différentes selon la chanson :
le Companion ne reprend jamais la palette d'un autre morceau. Aucun nom
ni couleur de créateur n'est codé spécialement dans l'application.
Si plusieurs charts identiques déclarent des couleurs contradictoires,
le style habituel reste utilisé : l'export texte ne permet pas de choisir.
Sans song.ini correspondant, l'export songs.json peut encore fournir les
couleurs de cette même chart. Un song.ini trouvé reste prioritaire, même
si son nom de charter n'est pas coloré. Sans couleur disponible, le style
habituel du widget s'applique. Les fichiers sont lus localement, jamais
modifiés ni envoyés à OBS.
Dans Apparence des widgets, choisir Créateur de la chart, puis décocher
« Couleurs du charter dans la chanson » et cliquer Appliquer au widget pour
utiliser votre couleur personnalisée ou votre dégradé. Cocher l'option les
remplace par les couleurs du charter lorsqu'elles sont disponibles.

TAILLE DU TEXTE
Dans Widgets affichés, chaque widget possède des boutons − et + et un champ
Taille du texte. Les boutons changent la taille de 2 px ; le champ accepte
une valeur de 8 à 200 px. Le changement est immédiat et enregistré
automatiquement. Ctrl+Z annule la modification, Ctrl+Maj+Z la rétablit.
La taille de police est partagée entre l'aperçu, l'overlay Jeu et Stream / OBS.
Les couleurs et les positions sont conservées. Si un nom long est tronqué,
élargir sa zone avec Modifier la disposition.

DÉMONSTRATION
Choisir le mode Démonstration pour retrouver la source simulée indépendante.
Cliquer Étape suivante pour parcourir :
Menu → Chargement → En jeu → En pause → En jeu → Résultats → Menu.
Le morceau de démonstration est Everlong / Foo Fighters / ExampleCharter /
Guitar / Expert. Il n'inclut aucun fichier audio ni chart téléchargée.
Now Playing apparaît en jeu et en pause. Il disparaît au chargement,
aux résultats et au menu. Les anciennes métadonnées sont effacées.
Désactiver Artiste retire uniquement ce widget, immédiatement.
Activer la fenêtre overlay affiche les mêmes widgets dans une fenêtre
transparente au-dessus du bureau, laissant passer les clics.
Fermer l’application ferme les overlays et arrête les services. Passer d’un

onglet à l’autre conserve les widgets et leurs réglages.

PROFILS D'OVERLAY
Dans Profils d'overlay, saisir un nom (par exemple Jeu ou OBS), puis cliquer
Enregistrer un nouveau profil. Jusqu'à 20 profils peuvent être conservés.
Chaque profil garde les positions, dimensions, tailles de texte, couleurs,
thème, visibilité et verrous des widgets, ainsi que la disposition et le
format de sortie Stream. Les couleurs originales du charter continuent
de provenir de la chart en cours lorsque leur option reste activée.
Cliquer directement sur un profil pour l'appliquer. Le changement complet
correspond à une seule action Annuler ; Ctrl+Z permet de revenir en arrière.
Le port et l'adresse OBS, les connexions et le morceau en cours restent
propres à la session. Un profil ne démarre ni l'overlay ni le serveur OBS.

Après modification de la disposition, utiliser Gérer sur le profil voulu,
puis Mettre à jour pour remplacer sa copie enregistrée. Le même bouton
enregistre un nouveau nom si le champ Nom du profil a été modifié.
Pour garder plusieurs versions, utiliser Enregistrer un nouveau profil
avec un autre nom. Deux profils ne peuvent pas porter le même nom.
Supprimer demande une confirmation dans le panneau et conserve la
disposition actuellement affichée. Les profils sont stockés localement
dans overlay-profiles.json ; la copie précédente est conservée en .bak.
Un fichier invalide ou d'une version future est protégé contre l'écrasement.

ÉDITEUR VISUEL
Cliquer Modifier la disposition au-dessus de l'aperçu.
Cliquer un widget ou son nom dans la liste pour le sélectionner.
Maj+clic ajoute ou retire un widget de la sélection ; glisser déplace la
sélection entière. Les huit poignées redimensionnent un widget sélectionné.
Les champs X, Y, largeur et hauteur permettent un placement précis.
La taille représente la zone de texte ; elle ne modifie pas la police.
Cocher Verrouiller ce widget dans l'inspecteur protège son placement et
son cadre dans Jeu et Stream : glissement, poignées, champs de géométrie,
flèches et alignement ne le déplacent plus. Il reste sélectionnable pour
le déverrouiller ; sa couleur, sa taille de texte et sa visibilité restent
modifiables. Dans une sélection mixte, seuls les widgets libres bougent.
Le verrou est enregistré, inclus dans les profils et annulable. Appliquer
un profil ou utiliser Annuler restaure volontairement la disposition complète.
La grille aimante les déplacements et tailles par pas de 8 ; Alt permet
un déplacement libre. Flèches : 1 unité ; Maj+flèches : 10 unités.
Échap annule le geste en cours. Les éléments restent dans le cadre 1280×720.
Aligner un seul widget le place par rapport au cadre ; avec plusieurs
widgets, l'alignement utilise les limites de leur sélection.
Les réglages de visibilité distinguent les destinations Jeu et Stream,
ainsi que les états En jeu et Pause.
En édition, les éléments masqués restent sélectionnables en transparence.
L'aperçu de placement peut utiliser des données de démonstration au menu ;
cela ne rend pas visible la véritable fenêtre overlay au menu.
Ctrl+Z : annuler ; Ctrl+Maj+Z ou Ctrl+Y : rétablir. Un glissement correspond
à une seule action. L'historique conserve jusqu'à 100 actions en mémoire,
et repart à zéro au redémarrage de l'application. Une nouvelle modification
après Annuler remplace les actions à rétablir.

THÈMES ET COULEURS
Ouvrir le panneau Thèmes et couleurs sous l'espace de travail.
Son petit aperçu affiche les cinq widgets avec des données locales, même
quand le jeu est au menu. Il ne change pas leur visibilité réelle.
Huit styles d'overlay : ChartsHub, Dark, Light, Neon, Cyberpunk, Retro,
Transparent et High Contrast. Changer de style conserve les placements.
Restaurer ce thème remet sa palette et ses effets d'origine, tout en
conservant les styles personnalisés des widgets.
La palette permet de personnaliser les couleurs principales et secondaires,
accent, texte, texte discret, fond, bordure, progression, lueur et ombre.
Le fond et la bordure s'appliquent aux cadres des widgets ; l'overlay
reste transparent en dehors de ces cadres. Progression est réservée aux
futurs widgets qui l'utilisent ; aucun indicateur de progression n'est ajouté.
Les couleurs acceptent HEX, RGB et HSL avec transparence, par exemple :
  #ff4fd880
  rgb(255 79 216 / 50%)
  hsl(315 100% 65%)
Pour choisir à la souris, cliquer sur le carré coloré à côté de chaque
champ. Le sélecteur de couleur s'ouvre ; le code suit le choix effectué.
Chaque couleur possède aussi un curseur Opacité : 0 % transparent,
100 % opaque. Changer la teinte conserve la transparence déjà réglée.
La palette globale est enregistrée à la fin du choix ou du déplacement du
curseur. Pour les dégradés, cliquer ensuite Appliquer les effets.
Pour un widget, choisir le widget puis Couleurs : Personnalisées,
sélectionner les couleurs à la souris et cliquer Appliquer au widget.
Le petit carré reflète immédiatement la couleur et son opacité ; le rendu
du widget suit les réglages enregistrés. Annuler restaure le réglage précédent.
Activer la lueur et régler son rayon ; activer le dégradé de texte et choisir
ses deux couleurs et son angle. Les effets sont partagés par l'aperçu et
la fenêtre overlay native.
Un widget peut suivre le thème ou utiliser sa propre couleur. Ses couleurs
de fond et de bordure, sa lueur et son dégradé peuvent aussi être définis
indépendamment. Une couleur personnalisée simple prend le dessus sur le
dégradé global ; un dégradé local explicitement activé reste prioritaire.
Restaurer le style du thème retire les personnalisations locales et conserve
la taille de police, la graisse et le placement du widget.
Utiliser l'aperçu de placement pour voir le style au menu. En jeu ou en
pause, la fenêtre overlay active suit le même rendu.
L'annulation et le rétablissement suivent l'ordre des changements de thème,
de style, de disposition et de visibilité, dans un même historique.

BIBLIOTHÈQUE LOCALE
1. Dans Bibliothèque locale, cliquer Choisir un dossier et sélectionner
   le dossier Songs contenant vos chansons Clone Hero.
2. La première analyse complète démarre automatiquement. Elle parcourt
   les sous-dossiers et lit les métadonnées des charts, sans lire l'audio.
3. Rechercher un titre, un artiste ou un charter ; choisir le tri et utiliser
   Précédent / Suivant pour parcourir les résultats par pages de 50.
4. Ouvrir dossier affiche la chanson dans l'Explorateur Windows.

Audio filtre les charts avec audio présent, absent ou non vérifié.
Charts > Doublons possibles retrouve les entrées dont le titre, l'artiste
et le charter complets correspondent dans plusieurs dossiers ou conteneurs.
La casse et les espaces ne changent pas le groupe ; les mentions de version
et la ponctuation sont conservées. Des métadonnées manquantes ne suffisent
pas à déclarer un doublon. Le nombre affiché concerne toute la bibliothèque.
Ces correspondances ne prouvent pas que les fichiers sont identiques.
Le filtrage et Ouvrir dossier ne suppriment aucun fichier.
Le bouton Comparer ouvre les versions côte à côte : emplacement, format,
présence d'audio, taille et date du fichier de notes. Les fichiers notes.chart
et notes.mid sont lus entièrement ; les notes d'un conteneur .sng sont
décodées en mémoire par morceaux, sans extraire le conteneur sur disque.
Les versions d'un même groupe de notes ont le même format et exactement les
mêmes octets. Des formats différents, un encodage différent ou des métadonnées
différentes dans le fichier de notes peuvent produire des groupes distincts.
Il ne s'agit pas d'une comparaison musicale entre les formats chart et MIDI.
À cette étape, la présence d'audio est indiquée par l'index ; les fichiers
audio ne sont pas encore comparés. Des notes identiques ne prouvent donc pas
l'identité de toute la chart.

Conserver cette version enregistre votre préférence locale et affiche
« Version à conserver ». Les autres copies restent sur disque.
Le choix est sauvegardé dans library-duplicate-choices.json dans le profil,
et reste lié au dossier de bibliothèque, au groupe et au contenu des notes.
Si les notes choisies changent, comparer à nouveau avant de choisir la version.
Un nouvel index, un changement de dossier ou la fermeture invalide les anciens
résultats ; aucune sélection ne peut utiliser une comparaison devenue périmée.

NETTOYAGE SÉLECTIF DES COPIES — WINDOWS
1. Ouvrir Comparer, puis utiliser Conserver cette version pour enregistrer
   la copie à garder. Ce choix seul ne déplace aucun fichier.
2. Cliquer Vérifier l'audio et préparer le nettoyage. La vérification lit
   les notes, tous les fichiers audio et l'ensemble du contenu de chaque
   version. L'interface indique la copie conservée, les cibles complètes,
   leurs chemins relatifs, tailles et états de vérification audio.
3. Cocher individuellement les copies vérifiées à retirer. Aucune copie
   n'est cochée par défaut ; la version conservée ne peut pas être cochée.
   Les versions bloquées restent visibles avec la raison du blocage.
4. Cliquer Envoyer N copies à la Corbeille et confirmer dans la fenêtre
   native Windows. Annuler cette confirmation laisse tous les fichiers
   en place. Les dossiers cochés sont envoyés avec tout leur contenu ;
   pour une archive .sng, seul le fichier .sng indiqué est concerné.
5. Consulter le résultat : copies envoyées, échecs et éventuelle interruption
   sont distingués. Une actualisation de bibliothèque est demandée
   automatiquement après l'exécution ; le résultat reste affiché.

Le nettoyage accepte uniquement des copies complètes identiques octet pour
octet. Pour des dossiers, les mêmes chemins de fichiers et tous leurs contenus
doivent correspondre, y compris audio, song.ini, pochettes et autres fichiers.
Pour les .sng, le conteneur entier doit être identique, en plus des vérifications
des notes et de l'audio. Une version en dossier et une version .sng ne peuvent
pas être nettoyées l'une par rapport à l'autre. Des notes ou pistes musicales
équivalentes ne suffisent pas. Les versions avec métadonnées ou pochettes
différentes, fichiers supplémentaires, audio absent ou illisible restent
en place. Les dossiers imbriqués ou partagés avec une autre chart sont bloqués.

La confirmation porte seulement sur les copies cochées. Les cibles et la
version conservée sont vérifiées à nouveau avant l'envoi à la Corbeille.
Un changement du dossier Songs, de l'index, du choix conservé ou des fichiers
rend l'ancien plan inutilisable. Chaque tentative exige une nouvelle
vérification ; les anciennes cases cochées ne sont pas réutilisées.
Si la Corbeille est indisponible ou refuse une copie, l'opération signale
l'échec et n'utilise jamais de suppression définitive en remplacement.
La fonction ne fusionne pas les fichiers et ne remplace pas une chart.

Les filtres se combinent à la recherche et au tri. Réinitialiser les filtres
conserve le texte recherché et le tri choisi.

L'analyse, la lecture et l'enregistrement de l'index, la recherche et le tri
fonctionnent dans un worker séparé du processus qui pilote l'overlay.
Les recherches et tris sont mis en cache pour accélérer la pagination ;
une nouvelle analyse remplace ces caches avec le nouvel index.
La liste déjà enregistrée reste consultable pendant l'actualisation.

Scan complet relit les métadonnées. Actualiser compare la taille et la date
des fichiers pour réutiliser les entrées inchangées et détecter les ajouts,
modifications et suppressions. Si un logiciel conserve ces deux attributs
malgré une modification, utiliser Scan complet pour forcer la relecture.
Annuler interrompt le travail et conserve le dernier index terminé.
Le compteur indique les charts détectées ; ce n'est pas une validation
de leur jouabilité dans Clone Hero. La présence d'audio est indiquée à part.
L'application reconnaît notes.chart, notes.mid et les conteneurs .sng.
Les noms proviennent de song.ini, de l'en-tête chart ou du conteneur SNG ;
un nom de dossier/fichier sert de repli si les métadonnées manquent.
Les archives ZIP/RAR/7z doivent d'abord être extraites.

Actualiser au démarrage est activé par défaut après le choix d'un dossier.
Détecter les changements est une option : les notifications du système
regroupent les changements avant de lancer une actualisation rapide.
La surveillance s'arrête avec le panneau Companion. Si elle est indisponible,
le bouton Actualiser reste utilisable. Aucun scan complet automatique au
démarrage et aucune interrogation périodique de tous les fichiers.
Un dossier indisponible ne doit pas effacer silencieusement l'index existant.
Les liens et jonctions sont ignorés ; choisir directement le vrai dossier.
Les fichiers de chansons ne sont jamais modifiés par le scanner.
L’analyse parcourt toutes les chansons et entrées sans quota fixe. L’index
est écrit par lots et conserve son format compatible avec les profils existants.
La durée et la mémoire nécessaires dépendent de la taille de la bibliothèque.

Le dossier choisi, les options et l'index résident dans library.json dans
le profil Companion. Les métadonnées restent locales. Seule la page de
résultats demandée passe à l'interface ; l'index n'est pas envoyé à OBS.
Si l'index est endommagé, sélectionner à nouveau le dossier permet de le
reconstruire en conservant une copie distincte library.json.corrupt-*.bak.
Un index provenant d'une version future reste protégé de l'écrasement.
La bibliothèque ne sélectionne pas le morceau actuellement joué : les
données de l'overlay viennent uniquement de la source Direct ou Démonstration.

CATALOGUE CHARTSHUB ET CORRESPONDANCES
Dans Catalogue ChartsHub, cliquer Rechercher pour charger le catalogue public.
Une recherche vide affiche toutes les charts. Les filtres permettent de
chercher par titre/texte, artiste, charter, genre, année, instrument,
difficulté, créateur vérifié et liens avec votre bibliothèque.
Les pages contiennent 20 résultats. Le filtre instrument + difficulté
respecte la difficulté de cet instrument, lorsqu'elle est renseignée.
Les pochettes se chargent au fil de l'affichage. Ouvrir sur ChartsHub
ouvre uniquement la fiche publique de la chart choisie dans le navigateur.

Dans Bibliothèque locale, cliquer Sur ChartsHub à côté d'un morceau pour
comparer les versions proposées. Le titre et l'artiste doivent correspondre ;
les versions live/remaster/feat. ne sont pas fusionnées arbitrairement.
Une concordance supplémentaire du charter renforce la suggestion, sans
prouver que les fichiers sont identiques. Plusieurs versions peuvent rester
possibles. Cliquer Lier cette chart pour confirmer votre choix.
Remplacer le lien choisit une autre version ; Retirer le lien supprime
seulement cette association. Les fichiers de chansons restent inchangés.

« Correspondance possible » indique un rapprochement de métadonnées.
« Liée à votre bibliothèque » indique votre association manuelle confirmée,
pas une comparaison des fichiers audio ou des notes. Les associations restent
propres au dossier Songs sélectionné et à l'empreinte de l'entrée locale.
Un fichier local modifié peut exiger de confirmer de nouveau sa correspondance.
Après une actualisation de bibliothèque ou de catalogue, recharger les
résultats avant de confirmer une ancienne sélection.

« Créateur vérifié » provient du statut officiel du créateur sur ChartsHub.
Ce badge n'est pas déduit d'un nom, d'un titre ou d'une correspondance locale.
Si les statuts des créateurs sont indisponibles, un avertissement l'indique.
Si le serveur fournit un catalogue de démonstration, les exemples sont
signalés, sans badge vérifié ni possibilité de les associer à vos chansons.

Le catalogue complet est chargé à votre première recherche ou comparaison.
Les recherches, filtres et rapprochements suivants s'exécutent localement.
Actualiser le catalogue recharge explicitement les données du site.
La date de chargement est affichée. Si une actualisation échoue, l'ancien
catalogue peut rester visible avec un avertissement.
Aucune connexion réseau n'est lancée simplement en ouvrant le Companion.
Les requêtes publiques n'envoient ni cookies de compte ni fichiers locaux.
Les titres de votre bibliothèque ne sont pas envoyés au serveur pour chercher.
La fermeture du panneau efface le cache distant en mémoire.

Les liens sont conservés dans matching.json, séparé de library.json et des
réglages d'overlay. Un fichier illisible est conservé dans une copie distincte
lors d'une nouvelle association explicite ; les versions futures restent
protégées de l'écrasement. Les sauvegardes contiennent des identifiants et
empreintes, sans chemin absolu vers vos chansons.
Les associations locales n’ont pas de quota fixe. Le catalogue distant garde
ses limites : 20 000 charts, réponse JSON de 24 Mio, 200 versions proposées
par comparaison.
Pochettes PNG/JPEG/WebP : 3 Mio maximum par image, cache mémoire de 32 Mio.
Le bouton Ajouter à la file prépare le téléchargement d'une chart disponible.

TÉLÉCHARGEMENTS
1. Dans Catalogue ChartsHub, rechercher une chart puis Ajouter à la file.
2. Au premier téléchargement, choisir un dossier dans la fenêtre Windows.
   Préférer un dossier de téléchargements distinct de Songs : l'installation
   avec validation et détection de doublons arrivera à l'étape suivante.
3. La section Téléchargements affiche la file, les octets et fichiers reçus.
   Un seul téléchargement fonctionne à la fois, dans l'ordre de la file.
4. Pause arrête le transfert ; Reprendre le remet en file d'attente.
5. Annuler retire les fichiers temporaires de cette tâche. Réessayer remet
   un échec ou une tâche annulée dans la file. Retirer enlève l'historique ;
   un téléchargement terminé et ses fichiers sont conservés.
6. Ouvrir dossier affiche un téléchargement terminé dans l'Explorateur.

Le serveur envoie chaque fichier complet et ne propose pas de reprise par
plage d'octets. Pause conserve les fichiers déjà terminés et contrôlés ;
le fichier interrompu repart du début à la reprise. La progression peut
donc reculer de sa portion incomplète. Les tailles sont toujours contrôlées,
et les empreintes SHA-256 sont comparées lorsqu'elles sont fournies.
La reprise vérifie de nouveau le manifeste et les fichiers conservés.
Les destinations existantes ne sont pas écrasées : un suffixe est ajouté.
Le dossier choisi ensuite ne déplace pas les tâches déjà créées.
Les dossiers temporaires et ceux en cours de publication sont ignorés par
le scanner de la bibliothèque, même si le téléchargement se trouve dans Songs.

La file est conservée dans download-state.json, indépendamment de l'overlay
et de la bibliothèque. À la fermeture, les tâches actives et en attente
passent en pause. Reprendre est nécessaire après réouverture : aucune
chanson n'est téléchargée automatiquement au lancement du Companion.
Une file illisible ou issue d'une version future est protégée ; les actions
restent bloquées et le fichier original n'est pas remplacé.
Limites : 100 tâches conservées, 1 000 fichiers et 2 Go par chart.
Retirer des tâches terminées libère de la place dans l'historique.
Les requêtes utilisent uniquement les routes publiques officielles du site,
sans cookies de compte. Les charts de démonstration ne sont pas téléchargeables.
Cette étape prépare les fichiers ; elle ne valide pas leur jouabilité,
ne les installe pas automatiquement et ne crée pas d'association de catalogue.

STREAM / OBS
1. Dans Stream / OBS, cocher les widgets à afficher dans le stream.
   La case générale Widgets affichés doit aussi rester activée.
2. Choisir la résolution (720p, 1080p, 1440p, 2160p ou personnalisée)
   et 30 ou 60 images par seconde, puis Appliquer les réglages.
3. Activer le serveur Stream et cliquer Copier l’URL.
4. Dans OBS : Sources > + > Navigateur. Désactiver Fichier local si coché,
   coller l’URL, puis reporter la largeur et la hauteur choisies ici.
   Activer la fréquence d’images personnalisée et reporter 30 ou 60 i/s.
5. En Direct, jouer une chanson dans Clone Hero. Le morceau déjà en cours
   est repris automatiquement si la session Windows du jeu est reconnue.
   Pour essayer sans jouer, choisir Démonstration puis En jeu.

Le fond de la page OBS est transparent. Le damier appartient uniquement à
l’aperçu du Companion et ne fait pas partie du stream.
Les onglets Jeu et Stream choisissent la disposition à modifier dans
l’éditeur. Déplacer un widget dans Stream ne change pas son placement Jeu.
Les couleurs, la police, l’activation générale et les états de gameplay
restent partagés ; les deux cases de destination sont indépendantes.
L’éditeur utilise une scène logique 1280×720, adaptée à la résolution OBS.
Un format personnalisé d’un autre rapport largeur/hauteur centre cette
scène avec des bandes transparentes. Choisir la même résolution dans OBS
et le Companion pour que l’aperçu corresponde à la source navigateur.
Le réglage i/s limite la fréquence des mises à jour du serveur ; la source
Navigateur OBS possède son propre réglage de fréquence, à reporter aussi.

L’adresse locale reste identique tant que le port et le profil sont conservés.
Le serveur est arrêté au démarrage et à la fermeture du panneau Companion.
Il écoute uniquement sur 127.0.0.1 : OBS doit fonctionner sur le même PC.
En démonstration, les informations disparaissent au menu, au chargement
et aux résultats. En Direct, elles disparaissent lorsque le jeu vide l'export.
Une coupure de connexion efface le texte ; la page tente de se reconnecter.
Le compteur indique les pages navigateur connectées, y compris OBS.
En cas de port occupé, arrêter le serveur, choisir un autre port et Appliquer.
Il faut ensuite recopier l’URL dans OBS. Le port ne change pas pendant que
le serveur est actif ; annuler un changement de port exige aussi son arrêt.
Les demandes de chansons et les widgets de veille viendront ultérieurement.

RÉGLAGES
Cinq widgets indépendants : titre, artiste, charter, instrument et difficulté.
Le direct n'alimente que les trois premiers ; les champs absents sont masqués.
Les changements sont enregistrés après 500 ms et lors de la fermeture.
Le format version 3 conserve positions, tailles, destinations, états autorisés,
thème, styles personnalisés, disposition Stream et réglages de canvas/port.
Les formats 1 et 2 sont migrés à la première modification, avec sauvegarde
du fichier précédent en .bak. Le layout Stream est initialisé depuis le Jeu.
Les couleurs du format 1 qui diffèrent des valeurs d'origine sont conservées
comme personnalisations ; les couleurs d'origine suivent désormais le thème.
Les réglages normaux résident dans le dossier de données Electron de
ChartsHub, sous companion/settings.json. L'ancienne copie devient .bak.
Un fichier d'une version future est protégé contre l'écrasement.
Le lanceur de démonstration portable peut utiliser un profil séparé, indiqué
dans le fichier Lancer Companion.cmd, pour préserver la session habituelle.
L'activation de l'overlay et du serveur Stream n'est pas restaurée au démarrage.
La clé locale d'accès Stream réside dans stream-access.key dans le profil.

ARCHITECTURE
Adapter Clone Hero → services GameplaySession et NowPlaying → bus typé
→ liaisons du store → sélecteurs → registry et resolvers → renderer.
Le moteur de widgets est TypeScript et indépendant de l'interface.
Le scanner de bibliothèque et la vérification des copies travaillent dans un
worker ; le processus principal conserve les dialogues natifs et l'envoi
des seules cibles autorisées à la Corbeille Windows.
Le rendu utilise le DOM local d'Electron déjà employé par ChartsHub ;
aucun framework React ni deuxième application native n'a été introduit.
Chaque widget ne lit que l'état normalisé. Aucun accès au disque, au réseau
ou à Clone Hero dans les widgets. Chaque rendu possède sa frontière d'erreur.
Les sessions Electron et les canaux IPC locaux sont séparés du site distant.
La source Direct lit l'export local et la source Mock conserve la simulation,
sans accès aux fichiers dans le moteur de widgets. WidgetLayoutEngine centralise les transformations et
SnapshotHistory conserve les actions de disposition et de thème ensemble
côté processus principal. ThemeService valide les réglages et ThemeResolver
résout les styles utilisés par les aperçus et l'overlay natif. Une révision
de disposition empêche un geste ancien d'écraser une modification récente.
Le mock garde volontairement des métadonnées après
la chanson pour vérifier leur effacement par les services.

DÉVELOPPEMENT
Node.js et npm sont nécessaires seulement pour compiler les sources.
  npm ci
  npm test
  npm run typecheck
  npm run start:companion
  npm run package -- win32 x64
Test natif :
  node_modules\.bin\electron tests\companion-electron.cjs C:\chemin\tests
Utiliser un dossier de test neuf. Il contient réglages, logs et captures.
Les tests automatisés de nettoyage utilisent des fixtures temporaires et une
API Corbeille simulée : aucun fichier d'une bibliothèque réelle n'est envoyé
à la Corbeille. Ils couvrent sélection individuelle, copies inéligibles,
confirmation annulée, fichiers modifiés, résultats partiels et plans périmés.
Ces tests ne constituent pas une validation graphique de l'application.

LIMITES ET ÉTAPES DIFFÉRÉES
La connexion réelle utilise uniquement l'export currentsong.txt documenté.
Les métadonnées n’utilisent aucune lecture mémoire ni modification du jeu.
Les filtres optionnels installent leur module séparément, comme décrit plus haut.
État exact, instrument et difficulté joués restent indisponibles.
L'overlay se place sur l'écran principal. Il ne suit pas encore la position
de la fenêtre du jeu. Le plein écran exclusif n'est pas garanti ; utiliser
le mode fenêtré ou sans bordures pour ce premier overlay.
En Direct, le vidage de l’export masque les widgets ; aucun écran de résultats
n’est détecté. Affichage post-chanson et Song Complete différés.
Groupes permanents, duplication et ordre des couches différés.
Thèmes séparés par destination, styles conditionnels,
demandes, historique,
métriques, Twitch et YouTube restent différés.
Le catalogue et les téléchargements déjà présents dans ChartsHub restent
en place. Le Companion réutilise leurs validations de fichiers et de chemins,
avec une file persistante indépendante pour la pause et la reprise.

Références techniques officielles :
https://www.electronjs.org/docs/latest/tutorial/security
https://www.electronjs.org/docs/latest/api/protocol
https://www.electronjs.org/docs/latest/tutorial/custom-window-styles
https://obsproject.com/kb/browser-source
https://github.com/websockets/ws
https://wiki.clonehero.net/books/clone-hero-manual/page/adding-custom-songs
https://wiki.clonehero.net/books/guides-and-tutorials/page/general-guides
https://clonehero.net/releases/v0.20.0/
https://clonehero.net/releases/v0.23.2/
https://github.com/mdsitton/SngFileFormat/blob/main/README.md
https://chartshub.ca/api/charts
https://chartshub.ca/api/creators
