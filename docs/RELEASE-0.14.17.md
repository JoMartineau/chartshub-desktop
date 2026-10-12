# ChartsHub Desktop 0.14.17

Le bouton Télécharger du catalogue ChorusEncore importe directement le fichier
SNG complet dans le dossier d’exportation choisi dans ChartsHub. Le conteneur
conserve l’audio, les images et les vidéos fournis par ChorusEncore. Clone Hero
et l’analyse de la bibliothèque locale reconnaissent ce format.

Le téléchargement affiche la progression et utilise le même bouton d’annulation
que les téléchargements ChartsHub. Une chanson existante reste intacte : chaque
import réserve un nouveau dossier et ajoute un suffixe quand son nom existe déjà.
Une même sélection peut mélanger des charts ChartsHub et ChorusEncore : le lot
les importe l’une après l’autre dans ce dossier, conserve les réussites et affiche
les éventuelles erreurs pour chaque chanson.

Les fichiers sont écrits dans un dossier temporaire, vérifiés, puis installés.
Les limites sont de 4 Go par chart et de 2 147 483 644 octets par fichier inclus
(environ 2 Gio). Les chemins,
les sections SNG, les tailles et les offsets sont contrôlés avant la publication
locale. Une erreur ou une annulation retire les fichiers temporaires de cette
opération. Un changement de compte annule le téléchargement et masque ses anciens
résultats.

Les téléchargements externes utilisent uniquement le hash de la chart sur le CDN
officiel ChorusEncore, sans transmettre les cookies ChartsHub. Ils restent des
charts externes et n’obtiennent pas les badges ou statistiques du catalogue natif.

Les dépendances sont inchangées. Les téléchargements ChartsHub utilisent aussi
ces limites, afin de conserver les fichiers vidéo dépassant l’ancienne limite
de 2 Go. Le lecteur
Songs lit actuellement les chansons contenant des fichiers audio séparés ; la
lecture directe de l’audio depuis un conteneur SNG n’est pas encore prise en charge.
