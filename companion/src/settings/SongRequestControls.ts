export interface SongRequestRules {
  maxDurationMinutes: number | null;
  instrument: 'all' | 'guitar' | 'bass' | 'drums' | 'pro-drums' | 'keys' | 'vocals' | 'rhythm' | 'guitar-coop' | 'guitar-6fret' | 'bass-6fret' | 'rhythm-6fret' | 'guitar-coop-6fret';
  difficulty: 'all' | 'easy' | 'medium' | 'hard' | 'expert';
}
interface SongRequest {
  id: string; songId: string; platform: string; viewerName: string; title: string; artist: string;
  status: 'pending' | 'accepted' | 'rejected' | 'played'; votes: number;
}
type ChatPlatform = 'twitch' | 'tiktok';
interface ChatConnection {
  state: string; displayName: string | null; error: string | null; canReply: boolean; userCode?: string | null;
}
interface Snapshot {
  library?: { status: string; count: number };
  state?: { gameplay?: { state: string }; nowPlaying?: { title?: string; artist?: string } | null };
  cloneHero?: { mode: string };
  songRequests?: {
    enabled: boolean; revision: number; order?: 'votes' | 'manual'; rules: SongRequestRules; requests: SongRequest[];
    bridge: { enabled: boolean; port?: number; url: string | null; overlayUrl: string | null; error: string | null; platforms: string[] };
    sharing?: { supported: boolean; url: string | null; count: number; updatedAt: string | null; busy: boolean; error: string | null; unavailableCount?: number };
    connections?: { receiving: boolean; persistent: boolean; storageError: string | null;
      lastResponse: { platform: string; message: string } | null; twitch: ChatConnection; tiktok: ChatConnection };
  };
}
interface Options { root: HTMLElement; command: (name: string, payload?: unknown) => Promise<unknown> }
const instruments = ['all', 'guitar', 'bass', 'drums', 'pro-drums', 'keys', 'vocals', 'rhythm', 'guitar-coop', 'guitar-6fret', 'bass-6fret', 'rhythm-6fret', 'guitar-coop-6fret'] as const;
const difficulties = ['all', 'easy', 'medium', 'hard', 'expert'] as const;

/** Local management UI. The bridge secrets are copied by the host, never rendered. */
export class SongRequestControls {
  private readonly abort = new AbortController();
  private cardsAbort = new AbortController();
  private snapshot: Snapshot | null = null;
  private busy = false;
  private dirty = false;
  private disposed = false;
  private listKey = '';
  private message: [string, string, boolean] = ['', '', false];
  private readonly connectionPending = new Map<ChatPlatform, { id: number; command: string }>();
  private connectionSequence = 0;

  constructor(private readonly options: Options) {
    const signal = this.abort.signal;
    this.element<HTMLInputElement>('#song-requests-enabled').addEventListener('change', event => {
      const enabled = (event.target as HTMLInputElement).checked;
      const current = this.snapshot?.songRequests;
      if (!current || this.busy || (enabled && !this.libraryReady)) { this.render(); return; }
      void this.send('songRequests.configure', { enabled, port: current.bridge.port ?? 38474, rules: current.rules });
    }, { signal });
    for (const name of ['port', 'max-duration', 'instrument', 'difficulty']) {
      const mark = (): void => { this.dirty = true; this.availability(); };
      this.element('#song-requests-' + name).addEventListener('input', mark, { signal });
      this.element('#song-requests-' + name).addEventListener('change', mark, { signal });
    }
    this.element('#song-requests-rules-form').addEventListener('submit', event => { event.preventDefault(); void this.apply(); }, { signal });
    this.element('#song-requests-reset-order').addEventListener('click', () => {
      if (this.snapshot?.songRequests?.order === 'manual') void this.send('songRequests.resetOrder', {});
    }, { signal });
    for (const [id, command] of [['bridge', 'copyBridgeConfiguration'], ['overlay', 'copyOverlayUrl']] as const) {
      this.element('#song-requests-copy-' + id).addEventListener('click', () => {
        const bridge = this.snapshot?.songRequests?.bridge;
        if (!bridge?.enabled || !(id === 'bridge' ? bridge.url : bridge.overlayUrl)) return;
        void this.send('songRequests.' + command, {});
      }, { signal });
    }
    for (const [id, command] of [['publish-library', 'publishLibrary'], ['copy-library', 'copyLibraryUrl'], ['remove-library', 'removeLibrary']] as const) {
      this.element('#song-requests-' + id).addEventListener('click', () => {
        const sharing = this.snapshot?.songRequests?.sharing;
        if (!sharing?.supported || sharing.busy || (command === 'publishLibrary' ? !this.libraryReady : !sharing.url)) return;
        void this.send('songRequests.' + command, {});
      }, { signal });
    }
    this.element('#song-requests-twitch-connect').addEventListener('click', () => { void this.connectionAction('connect', 'twitch'); }, { signal });
    this.element('#song-requests-twitch-cancel').addEventListener('click', () => { void this.connectionAction('cancelAuth', 'twitch'); }, { signal });
    for (const platform of ['twitch', 'tiktok'] as const) {
      this.element('#song-requests-' + platform + '-disconnect').addEventListener('click', () => { void this.connectionAction('disconnect', platform); }, { signal });
    }
    this.element('#song-requests-tiktok-form').addEventListener('submit', event => {
      event.preventDefault(); void this.connectionAction('connect', 'tiktok');
    }, { signal });
    this.element('#song-requests-tiktok-username').addEventListener('input', () => {
      this.element('#song-requests-tiktok-username').removeAttribute('aria-invalid'); this.availability();
    }, { signal });
    this.options.root.ownerDocument.defaultView?.addEventListener('chartshub:languagechange', () => this.render(), { signal });
    this.render();
  }
  update(snapshot: Snapshot): void { if (!this.disposed) { this.snapshot = snapshot; this.render(); } }
  dispose(): void { this.disposed = true; this.abort.abort(); this.cardsAbort.abort(); }
  private get libraryReady(): boolean { return this.snapshot?.library?.status === 'ready' && this.snapshot.library.count > 0; }
  private tr(fr: string, en: string): string { return this.options.root.ownerDocument.documentElement.lang.startsWith('fr') ? fr : en; }
  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.options.root.querySelector<T>(selector);
    if (!element) throw new Error('Missing Song Request control: ' + selector);
    return element;
  }
  private feedback(fr: string, en: string, error = false): void { this.message = [fr, en, error]; this.renderFeedback(); }
  private renderFeedback(): void {
    const element = this.element('#song-requests-feedback');
    element.textContent = this.tr(this.message[0], this.message[1]); element.hidden = !element.textContent;
    element.classList.toggle('is-error', this.message[2]);
  }
  private async connectionAction(action: 'connect' | 'disconnect' | 'cancelAuth', platform: ChatPlatform): Promise<void> {
    const connection = this.snapshot?.songRequests?.connections?.[platform];
    if (!connection || this.disposed) return;
    const pending = this.connectionPending.get(platform), authorizing = connection.state === 'authorizing';
    const connected = ['connected', 'reconnecting', 'connecting'].includes(connection.state)
      || (platform === 'tiktok' && connection.state === 'disconnected' && !!connection.displayName);
    if ((action === 'connect' && (pending || authorizing || connected))
        || (action === 'cancelAuth' && (!authorizing || pending?.command === 'cancelAuth'))
        || (action === 'disconnect' && (!connected || pending?.command === 'disconnect'))) return;
    const payload: { platform: ChatPlatform; username?: string } = { platform };
    if (action === 'connect' && platform === 'tiktok') {
      const input = this.element<HTMLInputElement>('#song-requests-tiktok-username');
      const username = input.value.trim().replace(/^@/, '');
      if (!/^[A-Za-z0-9_.]{1,24}$/.test(username) || username.startsWith('.') || username.endsWith('.') || username.includes('..')) {
        input.setAttribute('aria-invalid', 'true'); input.focus();
        this.feedback('Saisissez votre nom TikTok, par exemple @moncompte, sans lien.', 'Enter your TikTok username, for example @myaccount, without a link.', true); return;
      }
      payload.username = username;
    }
    const id = ++this.connectionSequence;
    this.connectionPending.set(platform, { id, command: action }); this.availability();
    try {
      const response = await this.options.command('songRequests.' + action, payload);
      if (this.disposed || this.connectionPending.get(platform)?.id !== id) return;
      if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true) {
        this.feedback('Connexion indisponible. Consultez l’état du compte puis réessayez.', 'Connection unavailable. Check the account status, then try again.', true);
      }
    } catch {
      if (!this.disposed && this.connectionPending.get(platform)?.id === id) {
        this.feedback('Connexion indisponible. Réessayez dans un instant.', 'Connection unavailable. Try again shortly.', true);
      }
    } finally {
      if (this.connectionPending.get(platform)?.id === id) this.connectionPending.delete(platform);
      if (!this.disposed) this.render();
    }
  }
  private async apply(): Promise<void> {
    const current = this.snapshot?.songRequests;
    if (!current || this.busy || !this.dirty || this.disposed) return;
    const portInput = this.element<HTMLInputElement>('#song-requests-port');
    const durationInput = this.element<HTMLInputElement>('#song-requests-max-duration');
    const port = current.enabled ? (current.bridge.port ?? 38474) : Number(portInput.value);
    const maxDurationMinutes = durationInput.value.trim() === '' ? null : Number(durationInput.value);
    const validPort = Number.isInteger(port) && port >= 1024 && port <= 65535;
    const validDuration = maxDurationMinutes === null || (Number.isInteger(maxDurationMinutes) && maxDurationMinutes >= 1 && maxDurationMinutes <= 60);
    portInput.setAttribute('aria-invalid', String(!validPort)); durationInput.setAttribute('aria-invalid', String(!validDuration));
    if (!validPort || !validDuration) {
      this.feedback('Port : 1 024 à 65 535. Durée : 1 à 60 minutes, ou vide pour toutes les durées.', 'Port: 1,024 to 65,535. Duration: 1 to 60 minutes, or blank for any duration.', true);
      (!validPort ? portInput : durationInput).focus(); return;
    }
    const instrument = this.element<HTMLSelectElement>('#song-requests-instrument').value;
    const difficulty = this.element<HTMLSelectElement>('#song-requests-difficulty').value;
    if (!instruments.includes(instrument as SongRequestRules['instrument']) || !difficulties.includes(difficulty as SongRequestRules['difficulty'])) return;
    await this.send('songRequests.configure', { enabled: current.enabled, port, rules: { maxDurationMinutes, instrument, difficulty } }, true);
  }
  private async send(command: string, payload: unknown, clearDraft = false): Promise<void> {
    if (!this.snapshot?.songRequests || this.busy || this.disposed) return;
    this.busy = true; this.feedback('Mise à jour…', 'Updating…'); this.availability();
    try {
      const response = await this.options.command(command, payload);
      if (this.disposed) return;
      if (response && typeof response === 'object' && 'ok' in response && response.ok === true) {
        if (clearDraft) this.dirty = false;
        if (command === 'songRequests.publishLibrary') this.feedback('Liste publiée. Copiez le lien pour vos spectateurs.', 'List published. Copy the link for your viewers.');
        else if (command === 'songRequests.removeLibrary') this.feedback('Partage retiré. Le lien public ne donne plus accès à cette liste.', 'Sharing removed. The public link no longer opens this list.');
        else this.feedback(command.includes('.copy') ? 'Copié dans le presse-papiers.' : 'Modification enregistrée.', command.includes('.copy') ? 'Copied to clipboard.' : 'Change saved.');
      } else if (['songRequests.publishLibrary', 'songRequests.copyLibraryUrl', 'songRequests.removeLibrary'].includes(command)) {
        this.feedback('Partage indisponible. Vérifiez votre connexion ChartsHub et la bibliothèque, puis réessayez.', 'Sharing unavailable. Check your ChartsHub connection and library, then try again.', true);
      } else this.feedback('Action impossible. Le morceau ou la file a peut-être changé. Actualisez la bibliothèque et réessayez.', 'Action unavailable. The song or queue may have changed. Refresh the library and try again.', true);
    } catch {
      if (!this.disposed) this.feedback('Song Request ne répond pas. Réessayez dans un instant.', 'Song Request is not responding. Try again shortly.', true);
    } finally { this.busy = false; if (!this.disposed) this.render(); }
  }
  private async moderate(id: string, action: 'accept' | 'reject' | 'played'): Promise<void> {
    const item = this.snapshot?.songRequests?.requests.find(request => request.id === id);
    const allowed = item && (action === 'played' ? item.status === 'accepted' : action === 'accept' ? item.status === 'pending' && this.libraryReady : ['pending', 'accepted'].includes(item.status));
    if (!allowed) return;
    await this.send('songRequests.' + action, { id });
  }
  private async move(id: string, direction: 'up' | 'down'): Promise<void> {
    const items = this.snapshot?.songRequests?.requests.filter(item => ['pending', 'accepted'].includes(item.status)) ?? [];
    const index = items.findIndex(item => item.id === id);
    if (index < 0 || (direction === 'up' ? index === 0 : index === items.length - 1)) return;
    await this.send('songRequests.move', { id, direction });
  }
  private availability(): void {
    const current = this.snapshot?.songRequests, unavailable = this.busy || !current;
    this.element<HTMLInputElement>('#song-requests-enabled').disabled = unavailable || (!current?.enabled && !this.libraryReady);
    this.element<HTMLInputElement>('#song-requests-port').disabled = unavailable || !!current?.enabled;
    for (const name of ['max-duration', 'instrument', 'difficulty']) this.element<HTMLInputElement>('#song-requests-' + name).disabled = unavailable;
    this.element<HTMLButtonElement>('#song-requests-apply').disabled = unavailable || !this.dirty;
    this.element<HTMLButtonElement>('#song-requests-copy-bridge').disabled = unavailable || !current?.bridge.enabled || !current.bridge.url;
    this.element<HTMLButtonElement>('#song-requests-copy-overlay').disabled = unavailable || !current?.bridge.enabled || !current.bridge.overlayUrl;
    this.element<HTMLButtonElement>('#song-requests-reset-order').disabled = unavailable || current?.order !== 'manual';
    this.element('#song-requests-reset-order').hidden = current?.order !== 'manual';
    const sharing = current?.sharing, sharingUnavailable = unavailable || !sharing?.supported || sharing.busy;
    this.element<HTMLButtonElement>('#song-requests-publish-library').disabled = sharingUnavailable || !this.libraryReady;
    this.element<HTMLButtonElement>('#song-requests-copy-library').disabled = sharingUnavailable || !sharing?.url;
    this.element<HTMLButtonElement>('#song-requests-remove-library').disabled = sharingUnavailable || !sharing?.url;
    for (const button of Array.from(this.element('#song-requests-items').querySelectorAll<HTMLButtonElement>('button'))) {
      button.disabled = unavailable || button.dataset.unavailable === 'true' || (button.dataset.action === 'accept' && !this.libraryReady);
    }
    this.element('#song-requests-draft-status').textContent = this.dirty ? this.tr('Modifications non enregistrées.', 'Unsaved changes.') : this.tr('Réglages enregistrés.', 'Settings saved.');
    for (const platform of ['twitch', 'tiktok'] as const) {
      const connection = current?.connections?.[platform], pending = this.connectionPending.get(platform);
      const authorizing = connection?.state === 'authorizing', active = ['connected', 'connecting', 'reconnecting'].includes(connection?.state ?? '')
        || (platform === 'tiktok' && connection?.state === 'disconnected' && !!connection.displayName);
      this.element<HTMLButtonElement>('#song-requests-' + platform + '-connect').disabled = !connection || !!pending || authorizing || active;
      const disconnect = this.element<HTMLButtonElement>('#song-requests-' + platform + '-disconnect');
      disconnect.hidden = !active; disconnect.disabled = !connection || !active || pending?.command === 'disconnect';
      if (platform === 'twitch') {
        const cancel = this.element<HTMLButtonElement>('#song-requests-twitch-cancel');
        cancel.hidden = !authorizing; cancel.disabled = !authorizing || pending?.command === 'cancelAuth';
      } else this.element<HTMLInputElement>('#song-requests-tiktok-username').disabled = !connection || !!pending || active;
    }
  }
  private render(): void {
    if (this.disposed) return;
    const copy: Record<string, string> = {
      title: this.tr('Song Request', 'Song Request'),
      description: this.tr('Connectez votre chat, puis activez les demandes pour les morceaux de votre dossier Songs.', 'Connect your chat, then enable requests for songs in your Songs folder.'),
      'enabled-label': this.tr('Recevoir les demandes du chat', 'Receive chat requests'),
      'duration-label': this.tr('Durée maximale (minutes)', 'Maximum duration (minutes)'),
      'instrument-label': this.tr('Instrument', 'Instrument'), 'difficulty-label': this.tr('Difficulté', 'Difficulty'),
      'port-label': this.tr('Port local', 'Local port'), apply: this.tr('Appliquer les réglages', 'Apply settings'),
      'active-label': this.tr('Demandes actives', 'Active requests'), 'accepted-label': this.tr('Acceptées', 'Accepted'), 'history-label': this.tr('Historique', 'History'),
      'next-label': this.tr('Prochaine demande', 'Next request'), 'reset-order': this.tr('Reclasser par votes', 'Sort by votes again'),
      'rules-help': this.tr('Laissez la durée vide pour tout accepter. Les métadonnées absentes ne valident pas une règle active. Le port se modifie quand la réception est arrêtée.', 'Leave duration blank for any length. Missing metadata cannot satisfy an active rule. Change the port while reception is stopped.'),
      'copy-bridge': this.tr('Copier la configuration du pont', 'Copy bridge configuration'),
      'copy-overlay': this.tr('Copier l’URL OBS de la file', 'Copy queue OBS URL'),
      'connections-title': this.tr('Connecter le chat', 'Connect chat'),
      'connections-help': this.tr('Les commandes !sr, !vote, !queue et !song sont prêtes. Connecter un compte ne démarre pas la réception.', 'The !sr, !vote, !queue and !song commands are ready. Connecting an account does not start reception.'),
      'twitch-connect': this.tr('Connecter Twitch', 'Connect Twitch'), 'twitch-disconnect': this.tr('Déconnecter', 'Disconnect'),
      'twitch-cancel': this.tr('Annuler la connexion', 'Cancel connection'),
      'tiktok-connect': this.tr('Connecter TikTok LIVE', 'Connect TikTok LIVE'), 'tiktok-disconnect': this.tr('Déconnecter', 'Disconnect'),
      'tiktok-username-label': this.tr('Nom du compte TikTok', 'TikTok username'),
      'tiktok-provider-help': this.tr('Ce connecteur non officiel utilise le service Euler Stream pour accéder au chat LIVE public du compte indiqué. Aucun mot de passe TikTok n’est demandé. Les réponses restent dans ChartsHub ; aucun message n’est envoyé dans le chat TikTok.', 'This unofficial connector uses the Euler Stream service to access the selected account’s public LIVE chat. No TikTok password is requested. Replies stay in ChartsHub; no messages are sent to TikTok chat.'),
      'last-response-label': this.tr('Dernière réponse TikTok — visible ici', 'Last TikTok response — shown here'),
      'rules-summary': this.tr('Règles des demandes', 'Request rules'),
      'advanced-summary': this.tr('Options avancées · pont local', 'Advanced options · local bridge'),
      'setup-help': this.tr('Compatibilité avec une configuration Streamer.bot existante, notamment YouTube. Copiez cette configuration uniquement dans votre pont local. Évitez de relayer un même chat déjà connecté directement.', 'Compatibility with an existing Streamer.bot setup, including YouTube. Copy this configuration only into your local bridge. Avoid relaying a chat already connected directly.'),
      'commands-help': this.tr('Chat : !sr artiste titre · !vote artiste titre · !queue · !song. Une demande pour un morceau déjà en attente ajoute un vote, une seule fois par spectateur. Les flèches choisissent l’ordre manuel.', 'Chat: !sr artist title · !vote artist title · !queue · !song. Requesting a song already waiting adds a vote, once per viewer. The arrows switch to manual order.'),
      'overlay-help': this.tr('Dans OBS, ajoutez une source Navigateur avec l’URL de la file. Cet affichage est en lecture seule. Les demandes ne téléchargent aucun fichier et ne lancent pas le jeu.', 'In OBS, add a Browser Source with the queue URL. This display is read-only. Requests never download files or launch the game.'),
      'sharing-title': this.tr('Liste publique pour les spectateurs', 'Public song list for viewers'),
      'sharing-help': this.tr('Publier envoie uniquement les informations des morceaux disponibles et les règles sur ChartsHub : aucun audio, aucune note ni aucun chemin local. Les spectateurs consultent cette liste sans compte et copient une commande !sr dans le chat. La liste reste un instantané : actualisez-la manuellement après un changement dans Songs. La file et les pseudos ne sont pas publiés.', 'Publishing uploads only available song metadata and rules to ChartsHub: no audio, notes or local paths. Viewers browse without an account and copy an !sr command into chat. This is a snapshot: update it manually after changes in Songs. The queue and viewer names are not published.'),
      'publish-library': this.snapshot?.songRequests?.sharing?.url ? this.tr('Actualiser la liste', 'Update song list') : this.tr('Publier la liste', 'Publish song list'),
      'copy-library': this.tr('Copier le lien public', 'Copy public link'),
      'remove-library': this.tr('Retirer le partage', 'Remove sharing'),
      empty: this.tr('Aucune demande reçue. Connectez votre chat, puis activez la réception.', 'No requests received. Connect your chat, then enable reception.'),
    };
    for (const [id, text] of Object.entries(copy)) this.element('#song-requests-' + id).textContent = text;
    const instrumentNames = this.tr('Tous|Guitare|Basse|Batterie|Pro Drums|Clavier|Voix|Rythmique|Guitare coop|Guitare 6 frettes|Basse 6 frettes|Rythmique 6 frettes|Guitare coop 6 frettes', 'All|Guitar|Bass|Drums|Pro Drums|Keys|Vocals|Rhythm|Guitar Co-op|Guitar 6-fret|Bass 6-fret|Rhythm 6-fret|Guitar Co-op 6-fret').split('|');
    const difficultyNames = this.tr('Toutes|Facile|Moyen|Difficile|Expert', 'All|Easy|Medium|Hard|Expert').split('|');
    for (const [id, names] of [['instrument', instrumentNames], ['difficulty', difficultyNames]] as const) {
      const select = this.element<HTMLSelectElement>('#song-requests-' + id);
      Array.from(select.querySelectorAll('option')).forEach((option, index) => { option.textContent = names[index] ?? ''; });
    }
    const current = this.snapshot?.songRequests;
    this.renderConnections();
    const sharing = current?.sharing;
    const count = sharing && Number.isSafeInteger(sharing.count) && sharing.count >= 0 && sharing.count <= 10000 ? sharing.count : 0;
    const omitted = sharing && Number.isSafeInteger(sharing.unavailableCount) && (sharing.unavailableCount ?? 0) > 0 ? sharing.unavailableCount! : 0;
    const updatedAt = sharing?.updatedAt && Number.isFinite(Date.parse(sharing.updatedAt)) ? new Date(sharing.updatedAt).toLocaleString(this.tr('fr-CA', 'en-CA'), { dateStyle: 'short', timeStyle: 'short' }) : '';
    this.element('#song-requests-sharing-status').textContent = !sharing?.supported
      ? this.tr('Connectez votre compte ChartsHub pour partager la liste.', 'Connect your ChartsHub account to share the list.')
      : sharing.busy ? this.tr('Mise à jour du partage…', 'Updating sharing…')
      : sharing.url ? this.tr(`Instantané publié : ${count} morceau${count === 1 ? '' : 'x'}.`, `Published snapshot: ${count} song${count === 1 ? '' : 's'}.`) + (updatedAt ? ` · ${updatedAt}` : '') + (omitted ? this.tr(` ${omitted} morceau${omitted === 1 ? '' : 'x'} indisponible${omitted === 1 ? '' : 's'} exclu${omitted === 1 ? '' : 's'}.`, ` ${omitted} unavailable song${omitted === 1 ? '' : 's'} excluded.`) : '')
      : this.tr('Aucune liste publiée. La publication démarre uniquement avec votre bouton.', 'No list published. Publishing starts only when you press the button.');
    const sharingError = this.element('#song-requests-sharing-error'); sharingError.hidden = !sharing?.error;
    sharingError.textContent = sharing?.error ? this.tr('Le partage est indisponible. Vérifiez votre connexion ChartsHub, puis réessayez.', 'Sharing is unavailable. Check your ChartsHub connection, then try again.') : '';
    const requests = current?.requests ?? [];
    const playing = this.snapshot?.state?.nowPlaying;
    const source = this.snapshot?.cloneHero?.mode;
    this.element('#song-requests-current-label').textContent = source === 'live' ? this.tr('Dernier morceau exporté', 'Last exported song') : source === 'mock' ? this.tr('Démonstration', 'Demo') : this.tr('Morceau actuel', 'Current song');
    this.element('#song-requests-current-title').textContent = playing?.title || this.tr('Aucun morceau disponible', 'No song available');
    this.element('#song-requests-current-artist').textContent = playing?.artist ?? '';
    const next = requests.find(item => ['pending', 'accepted'].includes(item.status));
    this.element('#song-requests-next-title').textContent = next ? `${next.title} — ${next.artist}` : this.tr('La file est vide.', 'The queue is empty.');
    this.element('#song-requests-active-count').textContent = String(requests.filter(item => ['pending', 'accepted'].includes(item.status)).length);
    this.element('#song-requests-accepted-count').textContent = String(requests.filter(item => item.status === 'accepted').length);
    this.element('#song-requests-history-count').textContent = String(requests.filter(item => ['played', 'rejected'].includes(item.status)).length);
    this.element<HTMLInputElement>('#song-requests-enabled').checked = !!current?.enabled;
    this.element('#song-requests-status').textContent = current?.enabled ? this.tr('Réception active', 'Receiving requests') : this.tr('Réception arrêtée', 'Reception stopped');
    this.element('#song-requests-readiness').textContent = this.libraryReady ? this.tr('Bibliothèque Songs prête. Les fichiers seront vérifiés à nouveau avant acceptation.', 'Songs library ready. Files are checked again before acceptance.') : this.tr('Choisissez et scannez votre dossier Songs dans la bibliothèque locale pour recevoir des demandes.', 'Choose and scan your Songs folder in the local library to receive requests.');
    const error = this.element('#song-requests-error'); error.hidden = !current?.bridge.error;
    error.textContent = current?.bridge.error ? this.tr('Le pont local est indisponible. Vérifiez le port puis relancez la réception.', 'The local bridge is unavailable. Check the port, then restart reception.') : '';
    if (current && !this.dirty) {
      this.element<HTMLInputElement>('#song-requests-port').value = String(current.bridge.port ?? 38474);
      this.element<HTMLInputElement>('#song-requests-max-duration').value = current.rules.maxDurationMinutes === null ? '' : String(current.rules.maxDurationMinutes);
      this.element<HTMLSelectElement>('#song-requests-instrument').value = current.rules.instrument;
      this.element<HTMLSelectElement>('#song-requests-difficulty').value = current.rules.difficulty;
    }
    this.renderRequests(current?.requests ?? []); this.renderFeedback(); this.availability();
  }
  private renderConnections(): void {
    const connections = this.snapshot?.songRequests?.connections;
    const states: Record<string, string> = {
      disconnected: this.tr('Non connecté', 'Not connected'), idle: this.tr('Non connecté', 'Not connected'),
      authorizing: this.tr('Autorisation Twitch en attente', 'Waiting for Twitch authorization'),
      connecting: this.tr('Connexion…', 'Connecting…'), reconnecting: this.tr('Reconnexion…', 'Reconnecting…'),
      connected: this.tr('Connecté', 'Connected'), error: this.tr('Connexion interrompue', 'Connection interrupted'),
      offline: this.tr('Compte hors live', 'Account is offline')
    };
    const errors: Record<string, string> = {
      setup_required: this.tr('La connexion Twitch doit être activée par ChartsHub dans une prochaine mise à jour.', 'Twitch connection must be enabled by ChartsHub in an upcoming update.'),
      offline: this.tr('Ce compte n’est pas en live. Vous pourrez le connecter lors de votre prochain direct.', 'This account is offline. You can connect it during your next live stream.'),
      not_live: this.tr('Ce compte n’est pas en live. Vous pourrez le connecter lors de votre prochain direct.', 'This account is offline. You can connect it during your next live stream.'),
      auth_denied: this.tr('Autorisation refusée. Vous pouvez recommencer la connexion.', 'Authorization declined. You can connect again.'),
      auth_expired: this.tr('L’autorisation a expiré. Recommencez la connexion.', 'Authorization expired. Connect again.'),
      unauthorized: this.tr('La connexion a expiré. Reconnectez ce compte.', 'The connection expired. Reconnect this account.')
    };
    for (const platform of ['twitch', 'tiktok'] as const) {
      const value = connections?.[platform];
      const displayName = typeof value?.displayName === 'string' ? value.displayName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : '';
      const usernameReady = platform === 'tiktok' && value?.state === 'disconnected' && !!displayName;
      this.element('#song-requests-' + platform + '-status').textContent = (usernameReady ? this.tr('Compte prêt', 'Account ready') : states[value?.state ?? 'disconnected'] ?? this.tr('Connexion indisponible', 'Connection unavailable'))
        + (displayName ? ' · ' + displayName : '');
      const help = platform === 'twitch'
        ? this.tr('Autorisez ChartsHub dans la page Twitch qui s’ouvre. Les réponses sont envoyées dans votre chat.', 'Authorize ChartsHub in the Twitch page that opens. Replies are sent to your chat.')
        : usernameReady ? this.tr('Activez la réception quand votre LIVE démarre. Vous pouvez attendre votre prochain direct.', 'Enable reception when your LIVE starts. You can wait until your next live stream.')
        : this.tr('Indiquez votre nom TikTok. Vous pourrez tester lors de votre prochain direct.', 'Enter your TikTok username. You can test during your next live stream.');
      this.element('#song-requests-' + platform + '-help').textContent = value?.error
        ? errors[value.error] ?? this.tr('Connexion indisponible. Réessayez plus tard.', 'Connection unavailable. Try again later.') : help;
    }
    const code = this.element('#song-requests-twitch-user-code');
    const userCode = connections?.twitch?.state === 'authorizing' && typeof connections.twitch.userCode === 'string'
      && /^[A-Za-z0-9-]{4,32}$/.test(connections.twitch.userCode) ? connections.twitch.userCode : '';
    code.hidden = !userCode;
    code.textContent = userCode ? this.tr('Code à saisir sur Twitch : ', 'Code to enter on Twitch: ') + userCode : '';
    const storage = this.element('#song-requests-connection-storage');
    storage.hidden = !connections || (connections.persistent && !connections.storageError);
    storage.textContent = connections?.storageError && connections.storageError !== 'encryption_unavailable'
      ? this.tr('L’enregistrement du compte est indisponible. Les données existantes sont conservées.', 'Account storage is unavailable. Existing data is preserved.')
      : this.tr('Cette connexion sera conservée uniquement pour cette session.', 'This connection will be kept for this session only.');
    const response = connections?.lastResponse;
    const text = response?.platform === 'tiktok' && typeof response.message === 'string'
      ? response.message.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 2048) : '';
    this.element('#song-requests-last-response').hidden = !text;
    this.element('#song-requests-last-response-message').textContent = text;
  }
  private renderRequests(items: SongRequest[]): void {
    const key = JSON.stringify([this.options.root.ownerDocument.documentElement.lang, items]);
    if (key === this.listKey) return;
    this.listKey = key;
    this.cardsAbort.abort(); this.cardsAbort = new AbortController();
    const list = this.element('#song-requests-items'), document = list.ownerDocument;
    list.textContent = ''; this.element('#song-requests-empty').hidden = items.length > 0;
    const statuses = { pending: this.tr('À approuver', 'Pending approval'), accepted: this.tr('Acceptée', 'Accepted'), rejected: this.tr('Refusée', 'Rejected'), played: this.tr('Jouée', 'Played') };
    const active = items.filter(item => ['pending', 'accepted'].includes(item.status));
    for (const item of items) {
      const card = document.createElement('article'); card.className = 'song-request-card'; card.dataset.requestId = item.id; card.setAttribute('role', 'listitem');
      const heading = document.createElement('h3'); heading.className = 'song-request-heading'; heading.textContent = item.title;
      const artist = document.createElement('p'); artist.textContent = item.artist;
      const meta = document.createElement('p'); meta.className = 'song-request-meta';
      const platform = ({ twitch: 'Twitch', tiktok: 'TikTok', youtube: 'YouTube' } as Record<string, string>)[item.platform] ?? item.platform;
      meta.textContent = `${item.viewerName} · ${platform} · ${Math.max(0, item.votes)} vote${item.votes === 1 ? '' : 's'} · ${statuses[item.status] ?? ''}`;
      const actions = document.createElement('div'); actions.className = 'song-request-actions';
      const add = (action: 'accept' | 'reject' | 'played', label: string): void => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary'; button.dataset.action = action; button.textContent = label;
        button.setAttribute('aria-label', `${label} : ${item.title}`);
        button.addEventListener('click', () => { void this.moderate(item.id, action); }, { signal: this.cardsAbort.signal }); actions.append(button);
      };
      if (item.status === 'pending') add('accept', this.tr('Accepter', 'Accept'));
      if (item.status === 'accepted') add('played', this.tr('Marquer jouée', 'Mark played'));
      if (['pending', 'accepted'].includes(item.status)) add('reject', this.tr('Refuser', 'Reject'));
      if (['pending', 'accepted'].includes(item.status)) {
        for (const direction of ['up', 'down'] as const) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary'; button.dataset.action = 'move-' + direction;
          button.textContent = direction === 'up' ? '↑' : '↓'; button.setAttribute('aria-label', `${direction === 'up' ? this.tr('Monter', 'Move up') : this.tr('Descendre', 'Move down')} : ${item.title}`);
          const index = active.findIndex(value => value.id === item.id); button.dataset.unavailable = String(direction === 'up' ? index === 0 : index === active.length - 1);
          button.addEventListener('click', () => { void this.move(item.id, direction); }, { signal: this.cardsAbort.signal }); actions.append(button);
        }
      }
      card.append(heading, artist, meta, actions); list.append(card);
    }
  }
}
