# ChartsHub 0.14.30

- Corrige le refus de certaines mises à jour officielles lorsque GitHub renvoie un contrôle de publication réussi sans le détail de ses étapes.
- Dans ce cas précis, ChartsHub vérifie aussi la fiche de publication et son contrôle GitHub Actions : même dépôt, même version source, même exécution et résultat réussi. Une étape de publication présente mais échouée ou encore en cours reste bloquante.
- Les vérifications du tag, des cinq fichiers officiels, des empreintes et de l’archive restent obligatoires, ainsi que votre confirmation avant l’installation.
- Conserve l’onglet **État** et la reprise des mises à jour entièrement téléchargées ajoutés en 0.14.29.
