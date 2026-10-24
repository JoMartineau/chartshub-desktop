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
interface WidgetSettings { accentColor: string; fontSize: number; upcomingCount: number; showNowPlaying: boolean; showViewerNames: boolean; }
interface Snapshot {
  library?: { status: string; count: number; settings?: { watch: boolean }; watcher?: string };
  state?: { gameplay?: { state: string }; nowPlaying?: { title?: string; artist?: string } | null };
  cloneHero?: { mode: string };
  songRequests?: {
    enabled: boolean; revision: number; order?: 'votes' | 'manual'; rules: SongRequestRules; requests: SongRequest[];
    widget?: WidgetSettings;
    publicRequests?: { supported: boolean; active: boolean; connected: boolean; error: string | null; pendingAcknowledgements: number };
    bridge: { enabled: boolean; port?: number; url: string | null; overlayUrl: string | null; error: string | null; platforms: string[] };
    sharing?: { supported: boolean; url: string | null; count: number; updatedAt: string | null; busy: boolean; error: string | null; unavailableCount?: number;
      autoSync?: { enabled: boolean; pending: boolean; updating: boolean; retrying: boolean };
      progress?: { phase: string; processed: number; total: number; available?: number; unavailable?: number } | null };
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
  private widgetDirty = false;
  private showHistory = false;
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
        if (!sharing?.supported || (sharing.busy && !(command === 'removeLibrary' && sharing.autoSync?.updating)) || (command === 'publishLibrary' ? !this.libraryReady : !sharing.url)) return;
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
    for (const name of ['color', 'size', 'count', 'now-playing', 'viewers']) {
      const mark = (): void => { this.widgetDirty = true; this.availability(); };
      this.element('#song-requests-widget-' + name).addEventListener('input', mark, { signal });
      this.element('#song-requests-widget-' + name).addEventListener('change', mark, { signal });
    }
    this.element('#song-requests-widget-form').addEventListener('submit', event => { event.preventDefault(); void this.applyWidget(); }, { signal });
    this.element('#song-requests-toggle-history').addEventListener('click', () => { this.showHistory = !this.showHistory; this.render(); }, { signal });
    for (const [kind, target] of [['chat', 'connections-details'], ['sharing', 'sharing']] as const) {
      this.element('#song-requests-resolve-' + kind).addEventListener('click', () => {
        this.element<HTMLDetailsElement>('#song-requests-' + target).open = true;
        this.element('#song-requests-' + (kind === 'chat' ? 'connections-summary' : 'sharing-title')).focus();
      }, { signal });
    }
    this.element('#song-requests-resolve-library').addEventListener('click', () => {
      this.options.root.ownerDocument.defaultView?.dispatchEvent(new Event('companion:library-focus'));
    }, { signal });
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
  private async applyWidget(): Promise<void> {
    if (!this.snapshot?.songRequests?.widget || this.busy || !this.widgetDirty || this.disposed) return;
    const color = this.element<HTMLInputElement>('#song-requests-widget-color'), size = this.element<HTMLInputElement>('#song-requests-widget-size'), count = this.element<HTMLInputElement>('#song-requests-widget-count');
    const accentColor = color.value.toLowerCase(), fontSize = Number(size.value), upcomingCount = Number(count.value);
    const valid = [ /^#[a-f0-9]{6}$/.test(accentColor), Number.isInteger(fontSize) && fontSize >= 16 && fontSize <= 48, Number.isInteger(upcomingCount) && upcomingCount >= 1 && upcomingCount <= 10 ];
    [color, size, count].forEach((input, index) => input.setAttribute('aria-invalid', String(!valid[index])));
    if (valid.some(value => !value)) { this.feedback('Widget : couleur valide, texte de 16 à 48 px et 1 à 10 demandes.', 'Widget: choose a valid color, text from 16 to 48 px and 1 to 10 requests.', true); [color, size, count][valid.indexOf(false)]?.focus(); return; }
    const settings: WidgetSettings = { accentColor, fontSize, upcomingCount, showNowPlaying: this.element<HTMLInputElement>('#song-requests-widget-now-playing').checked, showViewerNames: this.element<HTMLInputElement>('#song-requests-widget-viewers').checked };
    await this.send('songRequests.widget', { settings }, false, true);
  }
  private async send(command: string, payload: unknown, clearDraft = false, clearWidgetDraft = false): Promise<void> {
    if (!this.snapshot?.songRequests || this.busy || this.disposed) return;
    this.busy = true; this.feedback('Mise à jour…', 'Updating…'); this.availability();
    try {
      const response = await this.options.command(command, payload);
      if (this.disposed) return;
      if (response && typeof response === 'object' && 'ok' in response && response.ok === true) {
        if (clearDraft) this.dirty = false;
        if (clearWidgetDraft) this.widgetDirty = false;
        if (command === 'songRequests.publishLibrary') this.feedback('Liste publiée. Copiez le lien pour vos spectateurs.', 'List published. Copy the link for your viewers.');
        else if (command === 'songRequests.removeLibrary') this.feedback('Partage retiré. Le lien public ne donne plus accès à cette liste.', 'Sharing removed. The public link no longer opens this list.');
        else this.feedback(command.includes('.copy') ? 'Copié dans le presse-papiers.' : 'Modification enregistrée.', command.includes('.copy') ? 'Copied to clipboard.' : 'Change saved.');
      } else if (['songRequests.publishLibrary', 'songRequests.copyLibraryUrl', 'songRequests.removeLibrary'].includes(command)) {
        this.feedback('Partage indisponible. Consultez le détail dans la liste publique ci-dessous.', 'Sharing unavailable. See the details in the public list section below.', true);
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
    this.element<HTMLButtonElement>('#song-requests-remove-library').disabled = unavailable || !sharing?.supported || !sharing.url || (sharing.busy && !sharing.autoSync?.updating);
    for (const button of Array.from(this.element('#song-requests-items').querySelectorAll<HTMLButtonElement>('button'))) {
      button.disabled = unavailable || button.dataset.unavailable === 'true' || (button.dataset.action === 'accept' && !this.libraryReady);
    }
    const widgetUnavailable = unavailable || !current?.widget;
    for (const name of ['color', 'size', 'count', 'now-playing', 'viewers']) this.element<HTMLInputElement>('#song-requests-widget-' + name).disabled = widgetUnavailable;
    this.element<HTMLButtonElement>('#song-requests-widget-apply').disabled = widgetUnavailable || !this.widgetDirty;
    this.element('#song-requests-widget-draft').textContent = this.widgetDirty ? this.tr('Modifications non enregistrées.', 'Unsaved changes.') : this.tr('Réglages enregistrés.', 'Settings saved.');
    const historyCount = current?.requests.filter(item => ['played', 'rejected'].includes(item.status)).length ?? 0;
    this.element<HTMLButtonElement>('#song-requests-toggle-history').disabled = !historyCount;
    this.element('#song-requests-toggle-history').setAttribute('aria-expanded', String(this.showHistory));
    this.element('#song-requests-toggle-history').textContent = (this.showHistory ? this.tr('Masquer l’historique', 'Hide history') : this.tr('Afficher l’historique', 'Show history')) + ' (' + historyCount + ')';
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
      'connections-summary': this.tr('Connexions du chat', 'Chat connections'),
      'health-chat-label': this.tr('Chat', 'Chat'), 'health-library-label': this.tr('Bibliothèque Songs', 'Songs library'), 'health-sharing-label': this.tr('Liste publique', 'Public list'),
      'resolve-chat': this.tr('Configurer le chat', 'Configure chat'), 'resolve-library': this.tr('Voir la bibliothèque', 'Open library'), 'resolve-sharing': this.tr('Gérer le partage', 'Manage sharing'),
      'queue-title': this.tr('File des demandes', 'Request queue'), 'queue-help': this.tr('Acceptez une demande, puis marquez-la jouée. Passer la retire de la file.', 'Accept a request, then mark it played. Skip removes it from the queue.'),
      'widget-summary': this.tr('Personnaliser le widget OBS', 'Customize OBS widget'), 'widget-color-label': this.tr('Couleur d’accent', 'Accent color'), 'widget-size-label': this.tr('Taille du texte (px)', 'Text size (px)'), 'widget-count-label': this.tr('Prochaines demandes', 'Upcoming requests'),
      'widget-now-playing-label': this.tr('Afficher le morceau actuel', 'Show current song'), 'widget-viewers-label': this.tr('Afficher les pseudos', 'Show viewer names'), 'widget-apply': this.tr('Appliquer au widget', 'Apply to widget'),
      'widget-help': this.tr('Trois prochaines demandes par défaut. Ces réglages s’appliquent au lien OBS existant.', 'Three upcoming requests by default. These settings apply to the existing OBS link.'),
      description: this.tr('Connectez votre chat, puis activez les demandes pour les morceaux de votre dossier Songs.', 'Connect your chat, then enable requests for songs in your Songs folder.'),
      'enabled-label': this.tr('Recevoir les demandes du chat', 'Receive chat requests'),
      'duration-label': this.tr('Durée maximale (minutes)', 'Maximum duration (minutes)'),
      'instrument-label': this.tr('Instrument', 'Instrument'), 'difficulty-label': this.tr('Difficulté', 'Difficulty'),
      'port-label': this.tr('Port local', 'Local port'), apply: this.tr('Appliquer les réglages', 'Apply settings'),
      'active-label': this.tr('Demandes actives', 'Active requests'), 'accepted-label': this.tr('Acceptées', 'Accepted'), 'history-label': this.tr('Historique', 'History'),
      'next-label': this.tr('Prochaine demande', 'Next request'), 'reset-order': this.tr('Reclasser par votes', 'Sort by votes again'),
      'rules-help': this.tr('Laissez la durée vide pour tout accepter. Les métadonnées absentes ne valident pas une règle active. Le port se modifie quand la réception est arrêtée.', 'Leave duration blank for any length. Missing metadata cannot satisfy an active rule. Change the port while reception is stopped.'),
      'copy-bridge': this.tr('Copier la configuration du pont', 'Copy bridge configuration'),
      'copy-overlay': this.tr('Copier le lien du widget OBS', 'Copy OBS widget link'),
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
      'overlay-help': this.tr('Dans OBS, ajoutez une source Navigateur et collez le lien du widget. Il affiche les prochaines demandes sans permettre de gérer la file. Les demandes ne téléchargent aucun fichier et ne lancent pas le jeu.', 'In OBS, add a Browser Source and paste the widget link. It shows upcoming requests without queue management. Requests never download files or launch the game.'),
      'sharing-title': this.tr('Liste publique pour les spectateurs', 'Public song list for viewers'),
      'sharing-help': this.tr('Publier envoie uniquement les informations des morceaux disponibles et les règles sur ChartsHub : aucun audio, aucune note ni aucun chemin local. Après publication, chaque changement détecté dans Songs ou dans les règles actualise automatiquement le même lien. La publication active la détection du dossier ; gardez ChartsHub ouvert. Pour les ajouts hors de l’application, conservez « Détecter les changements du dossier » activé. Les spectateurs consultent la liste sans compte et copient une commande !sr dans le chat. La file et les pseudos ne sont pas publiés.', 'Publishing uploads only available song metadata and rules to ChartsHub: no audio, notes or local paths. After publication, detected Songs changes and rule changes update the same link automatically. Publishing enables folder detection; keep ChartsHub open. For additions outside the app, keep “Detect folder changes” enabled. Viewers browse without an account and copy an !sr command into chat. The queue and viewer names are not published.'),
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
    this.renderConnections(); this.renderHealth();
    if (current?.widget && !this.widgetDirty) {
      this.element<HTMLInputElement>('#song-requests-widget-color').value = current.widget.accentColor;
      this.element<HTMLInputElement>('#song-requests-widget-size').value = String(current.widget.fontSize);
      this.element<HTMLInputElement>('#song-requests-widget-count').value = String(current.widget.upcomingCount);
      this.element<HTMLInputElement>('#song-requests-widget-now-playing').checked = current.widget.showNowPlaying;
      this.element<HTMLInputElement>('#song-requests-widget-viewers').checked = current.widget.showViewerNames;
    }
    const sharing = current?.sharing;
    const count = sharing && Number.isSafeInteger(sharing.count) && sharing.count >= 0 && sharing.count <= 200000 ? sharing.count : 0;
    const omitted = sharing && Number.isSafeInteger(sharing.unavailableCount) && (sharing.unavailableCount ?? 0) > 0 ? sharing.unavailableCount! : 0;
    const updatedAt = sharing?.updatedAt && Number.isFinite(Date.parse(sharing.updatedAt)) ? new Date(sharing.updatedAt).toLocaleString(this.tr('fr-CA', 'en-CA'), { dateStyle: 'short', timeStyle: 'short' }) : '';
    this.element('#song-requests-sharing-status').textContent = !sharing?.supported
      ? this.tr('Connectez votre compte ChartsHub pour partager la liste.', 'Connect your ChartsHub account to share the list.')
      : sharing.busy ? this.sharingProgress(sharing.progress)
      : sharing.url ? this.tr(`Liste publiée : ${count} morceau${count === 1 ? '' : 'x'}.`, `Published list: ${count} song${count === 1 ? '' : 's'}.`) + (updatedAt ? ` · ${updatedAt}` : '') + (omitted ? this.tr(` ${omitted} morceau${omitted === 1 ? '' : 'x'} indisponible${omitted === 1 ? '' : 's'} exclu${omitted === 1 ? '' : 's'}.`, ` ${omitted} unavailable song${omitted === 1 ? '' : 's'} excluded.`) : '') + this.sharingSyncStatus(sharing.autoSync)
      : this.tr('Aucune liste publiée. La publication démarre uniquement avec votre bouton.', 'No list published. Publishing starts only when you press the button.');
    const sharingError = this.element('#song-requests-sharing-error'); sharingError.hidden = !sharing?.error;
    sharingError.textContent = sharing?.error ? this.sharingError(sharing.error) + (sharing.url ? this.tr(' La liste publiée précédemment reste disponible.', ' Your previously published list remains available.') : '') : '';
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
  private renderHealth(): void {
    const current = this.snapshot?.songRequests, connections = current?.connections, sharing = current?.sharing, library = this.snapshot?.library;
    const connected = ['twitch', 'tiktok'].some(platform => connections?.[platform as ChatPlatform]?.state === 'connected');
    const reconnecting = ['twitch', 'tiktok'].some(platform => ['connecting', 'reconnecting', 'authorizing'].includes(connections?.[platform as ChatPlatform]?.state ?? ''));
    this.element('#song-requests-health-chat').textContent = connected ? this.tr('Chat connecté', 'Chat connected') : reconnecting ? this.tr('Connexion en cours…', 'Connecting…') : current?.bridge.enabled ? this.tr('Pont local actif', 'Local bridge active') : this.tr('Chat à connecter', 'Connect chat');
    this.element('#song-requests-health-chat-help').textContent = connected ? current?.enabled ? this.libraryReady ? this.tr('Les demandes du chat sont reçues.', 'Chat requests are being received.') : this.tr('Réception en attente de la bibliothèque Songs.', 'Reception is waiting for the Songs library.') : this.tr('Activez « Recevoir les demandes du chat » quand vous êtes prêt.', 'Enable “Receive chat requests” when you are ready.') : this.tr('Twitch et TikTok se règlent dans Connexions du chat.', 'Set up Twitch and TikTok under Chat connections.');
    this.element('#song-requests-health-library').textContent = this.libraryReady ? this.tr(library!.count.toLocaleString('fr-CA') + ' morceaux prêts', library!.count.toLocaleString('en-CA') + ' songs ready') : library?.status === 'scanning' ? this.tr('Analyse en cours…', 'Scan in progress…') : this.tr('Bibliothèque à préparer', 'Prepare library');
    this.element('#song-requests-health-library-help').textContent = this.libraryReady ? this.tr('Votre dossier Songs est disponible.', 'Your Songs folder is available.') : library?.status === 'scanning' ? this.tr('Attendez la fin de l’analyse avant d’accepter une demande.', 'Wait for the scan to finish before accepting a request.') : this.tr('Choisissez Songs puis lancez un scan ou une actualisation.', 'Choose Songs, then scan or refresh the library.');
    this.element('#song-requests-health-sharing').textContent = sharing?.busy ? this.tr('Liste en cours de mise à jour…', 'Updating list…') : sharing?.error ? this.tr('Partage à vérifier', 'Check sharing') : sharing?.url ? sharing.autoSync?.retrying ? this.tr('Nouvelle tentative prévue', 'Retry scheduled') : sharing.autoSync?.pending ? this.tr('Actualisation en attente', 'Update pending') : this.tr('Liste publiée', 'List published') : this.tr('Liste à publier', 'Publish list');
    this.element('#song-requests-health-sharing-help').textContent = !sharing?.supported ? this.tr('Connectez votre compte ChartsHub avant de publier.', 'Sign in to ChartsHub before publishing.') : sharing?.error ? this.sharingError(sharing.error) : sharing?.url ? this.tr('Le lien des spectateurs reste le même.', 'The viewer link stays the same.') + this.sharingSyncStatus(sharing.autoSync) : this.tr('Publiez une première fois pour obtenir le lien des spectateurs.', 'Publish once to get your viewer link.');
    const web = current?.publicRequests, status = this.element('#song-requests-health-web'); status.hidden = !web?.supported;
    status.textContent = web?.supported ? web.active && web.connected ? this.tr('Site web : réception active', 'Website: receiving requests') : web.error ? this.tr('Site web : connexion à vérifier', 'Website: check connection') : this.tr('Site web : réception arrêtée', 'Website: reception stopped') : '';
  }
  private sharingSyncStatus(sync: { enabled: boolean; pending: boolean; retrying: boolean } | undefined): string {
    if (!sync?.enabled) return '';
    if (sync.retrying) return this.tr(' Nouvelle tentative automatique prévue.', ' An automatic retry is scheduled.');
    if (sync.pending) return this.libraryReady
      ? this.tr(' Mise à jour automatique en attente.', ' Automatic update pending.')
      : this.tr(' Mise à jour automatique après la prochaine analyse réussie.', ' Automatic update follows the next successful scan.');
    if (this.snapshot?.library?.watcher === 'unavailable') return this.tr(' Détection indisponible : actualisez Songs pour repérer les ajouts.', ' Folder detection unavailable: refresh Songs to detect additions.');
    if (this.snapshot?.library?.settings?.watch === false) return this.tr(' Détection désactivée : actualisez Songs pour repérer les ajouts.', ' Folder detection is off: refresh Songs to detect additions.');
    return this.tr(' Mise à jour après chaque changement détecté.', ' Updates after each detected change.');
  }
  private sharingProgress(progress: { phase: string; processed: number; total: number } | null | undefined): string {
    if (!progress || !Number.isSafeInteger(progress.total) || progress.total < 0 || progress.total > 200000
      || !Number.isSafeInteger(progress.processed) || progress.processed < 0 || progress.processed > progress.total) return this.tr('Mise à jour du partage…', 'Updating sharing…');
    const counters = `${progress.processed.toLocaleString(this.tr('fr-CA', 'en-CA'))} / ${progress.total.toLocaleString(this.tr('fr-CA', 'en-CA'))}`;
    if (progress.phase === 'preparing') return this.tr(`Vérification des morceaux : ${counters}…`, `Checking songs: ${counters}…`);
    if (progress.phase === 'uploading') return this.tr(`Envoi de la liste : ${counters} morceaux…`, `Uploading list: ${counters} songs…`);
    if (progress.phase === 'committing') return this.tr('Publication de la liste complète…', 'Publishing the complete list…');
    if (progress.phase === 'removing') return this.tr('Retrait du partage…', 'Removing sharing…');
    return this.tr('Mise à jour du partage…', 'Updating sharing…');
  }
  private sharingError(code: string): string {
    const messages: Record<string, [string, string]> = {
      SHARE_ACCOUNT_REQUIRED: ['Connectez votre compte ChartsHub avant de publier.', 'Sign in to ChartsHub before publishing.'],
      SHARE_ACCOUNT_UNVERIFIED: ['Vérifiez l’adresse courriel de votre compte ChartsHub avant de publier.', 'Verify your ChartsHub email address before publishing.'],
      SHARE_ACCESS_DENIED: ['ChartsHub a refusé l’autorisation de partage. Reconnectez votre compte puis réessayez.', 'ChartsHub denied permission to share. Sign in again, then retry.'],
      SHARE_ACCOUNT_CHANGED: ['Le compte ChartsHub a changé. Relancez la publication avec le compte souhaité.', 'Your ChartsHub account changed. Publish again with the account you want.'],
      SHARE_LIBRARY_NOT_READY: ['Attendez la fin du scan de Songs avant de publier.', 'Wait for the Songs scan to finish before publishing.'],
      SHARE_LIBRARY_EMPTY: ['Aucun morceau disponible à publier. Actualisez la bibliothèque Songs.', 'No available songs to publish. Refresh your Songs library.'],
      SHARE_LIBRARY_CHANGED: ['La bibliothèque ou les règles ont changé. Relancez la publication après le scan.', 'Your library or rules changed. Publish again after the scan.'],
      SHARE_LIBRARY_LIMIT: ['Le partage accepte jusqu’à 200 000 morceaux. Votre bibliothèque dépasse cette limite.', 'Sharing supports up to 200,000 songs. Your library exceeds this limit.'],
      SHARE_METADATA_LIMIT: ['Les informations des morceaux dépassent la limite de 128 Mio. Aucune liste partielle n’a été publiée.', 'Song metadata exceeds the 128 MiB limit. No partial list was published.'],
      SHARE_METADATA_INVALID: ['Certaines informations des morceaux sont invalides. Actualisez la bibliothèque avant de réessayer.', 'Some song metadata is invalid. Refresh the library before trying again.'],
      SHARE_SERVER_UPDATE_REQUIRED: ['Le site ChartsHub doit être mis à jour pour recevoir cette liste. Réessayez après sa mise à jour.', 'The ChartsHub site needs an update to receive this list. Try again after it is updated.'],
      SHARE_UPLOAD_CONFLICT: ['La préparation du partage a expiré ou a été remplacée. Relancez la publication.', 'The upload expired or was replaced. Publish the list again.'],
      SHARE_RATE_LIMIT: ['Le service est occupé. Attendez un moment avant de relancer la publication.', 'The service is busy. Wait a moment before publishing again.'],
      SHARE_NETWORK: ['L’envoi a été interrompu. Vérifiez votre connexion Internet, puis relancez la publication.', 'The upload was interrupted. Check your Internet connection, then publish again.'],
      SHARE_RESPONSE_INVALID: ['La réponse du site ChartsHub est invalide. Réessayez plus tard.', 'The ChartsHub site returned an invalid response. Try again later.'],
      SHARE_CANCELLED: ['La publication a été arrêtée. Relancez-la lorsque vous êtes prêt.', 'Publishing stopped. Start it again when you are ready.']
    };
    const message = messages[code];
    return message ? this.tr(...message) : this.tr('Le partage est temporairement indisponible. Réessayez plus tard.', 'Sharing is temporarily unavailable. Try again later.');
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
      const help = value?.state === 'connected' ? this.tr('Le chat est connecté. Activez la réception quand vous êtes prêt.', 'Chat is connected. Enable reception when you are ready.') : value?.state === 'reconnecting' ? this.tr('La reconnexion est automatique. Consultez cet état si elle persiste.', 'Reconnection is automatic. Check this status if it continues.') : platform === 'twitch'
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
    const key = JSON.stringify([this.options.root.ownerDocument.documentElement.lang, this.showHistory, items]);
    if (key === this.listKey) return;
    this.listKey = key;
    this.cardsAbort.abort(); this.cardsAbort = new AbortController();
    const list = this.element('#song-requests-items'), document = list.ownerDocument;
    list.textContent = ''; this.element('#song-requests-empty').hidden = items.some(item => ['pending', 'accepted'].includes(item.status));
    const statuses = { pending: this.tr('À approuver', 'Pending approval'), accepted: this.tr('Acceptée', 'Accepted'), rejected: this.tr('Refusée', 'Rejected'), played: this.tr('Jouée', 'Played') };
    const active = items.filter(item => ['pending', 'accepted'].includes(item.status));
    for (const item of [...active, ...items.filter(item => !active.includes(item))]) {
      const card = document.createElement('article'); card.className = 'song-request-card'; card.dataset.requestId = item.id; card.setAttribute('role', 'listitem');
      const position = active.findIndex(value => value.id === item.id);
      card.hidden = position < 0 && !this.showHistory; card.dataset.status = item.status;
      card.classList.toggle('is-next', position === 0); card.classList.toggle('is-history', position < 0);
      const titleRow = document.createElement('div'); titleRow.className = 'song-request-title-row';
      if (position >= 0) { const rank = document.createElement('span'); rank.className = 'song-request-position'; rank.textContent = String(position + 1); titleRow.append(rank); }
      const heading = document.createElement('h3'); heading.className = 'song-request-heading'; heading.textContent = item.title; titleRow.append(heading);
      const artist = document.createElement('p'); artist.textContent = item.artist;
      const meta = document.createElement('p'); meta.className = 'song-request-meta';
      const platform = ({ twitch: 'Twitch', tiktok: 'TikTok', youtube: 'YouTube', website: this.tr('Site web', 'Website') } as Record<string, string>)[item.platform] ?? item.platform;
      const viewerName = item.platform === 'website' ? this.tr('Spectateur web', 'Website visitor') : item.viewerName;
      meta.textContent = `${viewerName} · ${platform} · ${Math.max(0, item.votes)} vote${item.votes === 1 ? '' : 's'} · ${statuses[item.status] ?? ''}`;
      const actions = document.createElement('div'); actions.className = 'song-request-actions';
      const add = (action: 'accept' | 'reject' | 'played', label: string): void => {
        const button = document.createElement('button'); button.type = 'button'; button.className = action === 'reject' ? 'button secondary' : 'button primary'; button.dataset.action = action; button.textContent = label;
        button.setAttribute('aria-label', `${label} : ${item.title}`);
        button.addEventListener('click', () => { void this.moderate(item.id, action); }, { signal: this.cardsAbort.signal }); actions.append(button);
      };
      if (item.status === 'pending') add('accept', this.tr('Accepter', 'Accept'));
      if (item.status === 'accepted') add('played', this.tr('Marquer jouée', 'Mark played'));
      if (['pending', 'accepted'].includes(item.status)) add('reject', this.tr('Passer', 'Skip'));
      if (['pending', 'accepted'].includes(item.status)) {
        for (const direction of ['up', 'down'] as const) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary'; button.dataset.action = 'move-' + direction;
          button.textContent = direction === 'up' ? '↑' : '↓'; button.setAttribute('aria-label', `${direction === 'up' ? this.tr('Monter', 'Move up') : this.tr('Descendre', 'Move down')} : ${item.title}`);
          const index = active.findIndex(value => value.id === item.id); button.dataset.unavailable = String(direction === 'up' ? index === 0 : index === active.length - 1);
          button.addEventListener('click', () => { void this.move(item.id, direction); }, { signal: this.cardsAbort.signal }); actions.append(button);
        }
      }
      card.append(titleRow, artist, meta, actions); list.append(card);
    }
  }
}
