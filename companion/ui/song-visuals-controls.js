export class SongVisualControls {
  constructor({ root, command }) {
    this.root = root; this.command = command; this.snapshot = null; this.busy = false; this.disposed = false; this.abort = new AbortController();
    const node = (tag, parent = root, className = '') => { const e = root.ownerDocument.createElement(tag); e.className = className; parent.append(e); return e; };
    this.heading = node('h3'); this.intro = node('p', root, 'helper-text');
    this.status = node('p', root, 'helper-text'); this.status.setAttribute('role', 'status');
    this.lyricsStatus = node('p', root, 'helper-text'); this.lyricsStatus.setAttribute('role', 'status');
    const choice = node('label', root, 'song-visual-choice'); this.choiceLabel = node('span', choice); this.choice = node('select', choice); this.choice.id = 'song-visual-choice';
    this.choice.addEventListener('change', () => { if (this.choice.value) void this.run('visuals.select', { id: this.choice.value, selectionKey: this.snapshot?.visuals?.selectionKey }); }, { signal: this.abort.signal });
    const grid = node('div', root, 'song-visual-source-grid'); this.cards = {};
    for (const kind of ['background', 'video']) {
      const card = node('div', grid, 'song-visual-source'), title = node('h4', card), state = node('p', card, 'helper-text');
      const label = node('label', card), caption = node('span', label), input = node('input', label); input.id = `song-visual-${kind}-url`; input.readOnly = true; input.spellcheck = false;
      input.addEventListener('focus', () => input.select(), { signal: this.abort.signal });
      const copy = node('button', card, 'button secondary'); copy.type = 'button'; copy.id = `song-visual-${kind}-copy`;
      copy.addEventListener('click', () => void this.run('visuals.copyUrl', { kind }), { signal: this.abort.signal });
      this.cards[kind] = { title, state, caption, input, copy };
    }
    this.help = node('p', root, 'helper-text'); this.feedback = node('p', root, 'helper-text'); this.feedback.hidden = true; this.feedback.setAttribute('role', 'status');
    this.update(null);
  }
  tr(fr, en) { return this.snapshot?.language === 'en' ? en : fr; }
  async run(name, payload) {
    if (this.disposed || this.busy) return;
    this.busy = true; this.feedback.hidden = true; this.update(this.snapshot);
    try { const result = await this.command(name, payload); if (!result?.ok) throw Error(result?.error || this.tr('Cette source est indisponible.', 'This source is unavailable.')); this.feedback.textContent = name === 'visuals.copyUrl' ? this.tr('Adresse copiée.', 'Address copied.') : this.tr('Version sélectionnée pour ce morceau.', 'Version selected for this song.'); }
    catch (error) { this.feedback.textContent = error.message; }
    finally { this.busy = false; this.feedback.hidden = false; this.update(this.snapshot); }
  }
  update(snapshot) {
    if (this.disposed) return; this.snapshot = snapshot;
    const v = snapshot?.visuals, s = snapshot?.stream, states = {
      disabled: ['Activez le serveur Stream pour utiliser ces sources.', 'Enable the Stream server to use these sources.'],
      library: ['Scannez votre bibliothèque Songs pour détecter les médias du morceau.', 'Scan your Songs library to detect song media.'],
      waiting: ['En attente d’un morceau réel dans Clone Hero.', 'Waiting for an actual song in Clone Hero.'],
      searching: ['Recherche des médias…', 'Finding media…'], loading: ['Vérification des fichiers du morceau…', 'Checking song files…'],
      ambiguous: ['Plusieurs versions ou charter non confirmé : choisissez la version locale.', 'Several versions or no confirmed charter: choose the local version.'],
      missing: ['Aucun morceau local ne correspond exactement aux informations reçues.', 'No local song exactly matches the received information.'],
      unsupported: ['Les médias des chansons SNG ne sont pas encore disponibles.', 'Media inside SNG songs is not yet available.'],
      unavailable: ['Les fichiers ont changé ou sont indisponibles. Actualisez la bibliothèque.', 'The files changed or are unavailable. Refresh the library.'],
      ready: ['Médias du morceau détectés.', 'Song media detected.']
    };
    this.heading.textContent = this.tr('Fond et vidéo du morceau — sources séparées', 'Song background and video — separate sources');
    this.intro.textContent = this.tr('Placez le fond et la vidéo indépendamment du jeu et des widgets dans OBS. Les fichiers restent sur votre PC.', 'Place the background and video independently from the game and widgets in OBS. Files stay on your computer.');
    this.status.textContent = this.tr(...(states[v?.state] || states.disabled)) + (v?.title ? ' · ' + v.title : '');
    const lyricsReasons = { missing: ['Cette chart ne contient pas de paroles.', 'This chart contains no lyrics.'], invalid: ['Les paroles de cette chart ne peuvent pas être synchronisées.', 'The lyrics in this chart cannot be synchronized.'], ambiguous: ['Les phrases de paroles sont ambiguës ; le widget reste transparent.', 'Lyric phrases are ambiguous; the widget stays transparent.'], unsupported: ['Ce format de paroles n’est pas encore pris en charge.', 'This lyrics format is not yet supported.'] };
    this.lyricsStatus.textContent = this.tr('Paroles : ', 'Lyrics: ') + (v?.hasLyrics ? v.clockReady ? this.tr('disponibles dans le widget Paroles synchronisées.', 'available in the Synchronized lyrics widget.') : this.tr('détectées · en attente de l’horloge et de la vitesse du jeu.', 'detected · waiting for the game clock and speed.') : v?.state === 'ready' ? this.tr(...(lyricsReasons[v.lyricsReason] || lyricsReasons.missing)) : this.tr('en attente du morceau local et de son horloge.', 'waiting for the local song and its clock.'));
    this.choiceLabel.textContent = this.tr('Version du morceau', 'Song version'); this.choice.parentElement.hidden = v?.state !== 'ambiguous';
    const signature = JSON.stringify([v?.selectionKey, v?.candidates, v?.selected, snapshot?.language]);
    if (this.choice.dataset.signature !== signature) {
      this.choice.dataset.signature = signature; this.choice.replaceChildren();
      const empty = this.root.ownerDocument.createElement('option'); empty.value = ''; empty.textContent = this.tr('Choisir une version…', 'Choose a version…'); this.choice.append(empty);
      for (const [index, row] of (v?.candidates || []).entries()) { const option = this.root.ownerDocument.createElement('option'); option.value = row.id; option.textContent = `${index + 1}. ${row.title} · ${row.artist} · ${row.charter || '—'} · ${row.id.slice(-8)}`; this.choice.append(option); }
      this.choice.value = v?.selected || '';
    }
    this.choice.disabled = this.busy;
    const reasons = { missing: ['Aucun fichier de ce type dans le morceau.', 'No file of this type in the song.'], ambiguous: ['Plusieurs fichiers : média non choisi automatiquement.', 'Several files: no automatic selection.'], unsupported: ['Format non pris en charge par cette source.', 'Format unsupported by this source.'], decoder: ['Le navigateur OBS ne peut pas lire ce fichier. La source reste transparente.', 'The OBS browser cannot decode this file. The source stays transparent.'], unavailable: ['Fichier indisponible.', 'File unavailable.'] };
    for (const kind of ['background', 'video']) {
      const card = this.cards[kind], url = kind === 'background' ? s?.backgroundUrl : s?.videoUrl;
      card.title.textContent = kind === 'background' ? this.tr('Fond du morceau', 'Song background') : this.tr('Vidéo du morceau', 'Song video');
      card.caption.textContent = this.tr('URL pour une source Navigateur OBS', 'URL for an OBS Browser source'); card.input.value = url || '';
      card.copy.textContent = this.tr('Copier l’URL', 'Copy URL'); card.copy.disabled = this.busy || !s?.enabled || !url;
      const present = kind === 'background' ? v?.hasBackground : v?.hasVideo, reason = kind === 'background' ? v?.backgroundReason : v?.videoReason;
      card.state.textContent = reason === 'decoder' ? this.tr(...reasons.decoder) : present ? kind === 'video' && !v.clockReady ? this.tr('Vidéo détectée · en attente de l’horloge et de la vitesse du jeu pour la synchroniser.', 'Video detected · waiting for the game clock and speed to synchronize it.') : kind === 'video' ? this.tr('Vidéo silencieuse · synchronisée avec le jeu.', 'Muted video · synchronized with the game.') : this.tr('Image détectée.', 'Image detected.') : v?.state === 'ready' ? this.tr(...(reasons[reason] || reasons.unavailable)) : this.tr('Source transparente en attente.', 'Transparent source waiting.');
    }
    this.help.textContent = this.tr('Ajoutez deux sources Navigateur OBS avec ces adresses. Pause, reprise et déplacement dans la vidéo suivent l’horloge réelle du jeu. Seuls background.* et video.* du dossier de la chanson sont détectés ; le fond global choisi dans Clone Hero reste indépendant.', 'Add two OBS Browser sources using these addresses. Pause, resume and seeking follow the actual game clock. Only background.* and video.* in the song folder are detected; Clone Hero’s global background remains separate.');
  }
  dispose() { this.disposed = true; this.abort.abort(); }
}
