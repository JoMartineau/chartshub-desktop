export interface UpdaterSnapshot {
  status: 'idle'|'checking'|'available'|'current'|'downloading'|'ready'|'staging'|'error';
  currentVersion: string; latestVersion: string|null; notes: string; releaseUrl: string|null;
  progress: {receivedBytes: number; totalBytes: number}|null;
  installSupported: boolean; canCheck: boolean; canDownload: boolean; canInstall: boolean;
  canRollback?: boolean; previousVersion?: string|null;
  busyReasons: string[]; error: string|null;
  lastResult?: {status: 'complete'|'rolled-back'|'failed'|'recovery-required'; version: string}|null;
}
export interface MaintenanceBridge {
  getState(): Promise<{updater: UpdaterSnapshot}|null>;
  subscribe(listener: (state: {updater: UpdaterSnapshot}) => void): () => void;
  invoke(action: string,payload?: unknown): Promise<{ok: boolean; cancelled?: boolean; error?: string}>;
}

/** Owns only its supplied mount node. All release text is rendered as plain text. */
export class UpdatesControls {
  private readonly abort = new AbortController();
  private readonly unsubscribe: () => void;
  private readonly heading: HTMLElement;
  private readonly status: HTMLElement;
  private readonly details: HTMLElement;
  private readonly notes: HTMLElement;
  private readonly noteSummary: HTMLElement;
  private readonly progress: HTMLProgressElement;
  private readonly feedback: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private state: UpdaterSnapshot|null = null;
  private language = 'en';
  private busy = false;
  private disposed = false;
  private lastRead = 0;
  private readPending = false;
  private localError: string|null = null;
  constructor(private readonly options: {root: HTMLElement; bridge: MaintenanceBridge}) {
    const doc = options.root.ownerDocument;
    const heading = this.heading = doc.createElement('h2'); heading.dataset.updatesHeading = '';
    this.status = doc.createElement('p'); this.status.setAttribute('role','status'); this.status.dataset.updatesStatus = '';
    this.details = doc.createElement('p'); this.details.className = 'helper-text';
    this.progress = doc.createElement('progress'); this.progress.hidden = true; this.progress.dataset.updatesProgress = '';
    const actions = doc.createElement('div'); actions.className = 'updates-actions';
    for (const name of ['check','download','install','rollback','cancel','openRelease']) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = `button ${name === 'install' ? 'primary' : 'secondary'}`;
      button.dataset.updateAction = name;
      button.addEventListener('click', () => { void this.send(name); }, {signal:this.abort.signal});
      this.buttons.set(name,button); actions.append(button);
    }
    const noteContainer = doc.createElement('details'); noteContainer.dataset.updatesNotes = '';
    this.noteSummary = doc.createElement('summary'); this.notes = doc.createElement('p'); this.notes.className = 'helper-text';
    this.notes.style.whiteSpace = 'pre-wrap'; this.notes.style.overflowWrap = 'anywhere'; this.notes.style.maxHeight = '18em'; this.notes.style.overflowY = 'auto';
    noteContainer.append(this.noteSummary,this.notes);
    this.feedback = doc.createElement('p'); this.feedback.setAttribute('role','status'); this.feedback.className = 'helper-text'; this.feedback.dataset.updatesFeedback = '';
    options.root.replaceChildren(heading,this.status,this.details,this.progress,actions,noteContainer,this.feedback);
    this.unsubscribe = options.bridge.subscribe(value => { if (!this.disposed && value?.updater) { this.state = value.updater; this.render(); } });
    this.render(); void this.read();
  }
  update(value: {language?: string}): void {
    if (this.disposed) return;
    this.language = value.language === 'fr' ? 'fr' : 'en'; this.render();
    // Local IPC only, so install readiness follows ongoing downloads/scans.
    if (Date.now()-this.lastRead > 1000) void this.read();
  }
  dispose(): void { this.disposed = true; this.abort.abort(); this.unsubscribe(); }
  private tr(fr: string,en: string): string { return this.language === 'fr' ? fr : en; }
  private async read(): Promise<void> {
    if (this.disposed || this.readPending) return;
    this.readPending = true; this.lastRead = Date.now();
    try { const value = await this.options.bridge.getState(); if (!this.disposed && value?.updater) { this.state = value.updater; this.render(); } }
    catch { if (!this.disposed) { this.localError = 'UPDATE_FAILED'; this.render(); } }
    finally { this.readPending = false; }
  }
  private async send(name: string): Promise<void> {
    const button = this.buttons.get(name); if (this.disposed || this.busy && name !== 'cancel' || !button || button.disabled || button.hidden) return;
    this.busy = true; this.localError = null; this.render();
    try { const result = await this.options.bridge.invoke('update.'+name); if (!this.disposed && !result?.ok) this.localError = result?.error || 'UPDATE_FAILED'; }
    catch { if (!this.disposed) this.localError = 'UPDATE_FAILED'; }
    finally { this.busy = false; if (!this.disposed) { await this.read(); this.render(); } }
  }
  private render(): void {
    if (this.disposed) return;
    const current = this.state, status = current?.status;
    const titles: Record<string,[string,string]> = {
      idle:['Vérifiez les nouvelles versions lorsque vous le souhaitez.','Check for new versions whenever you want.'],
      checking:['Vérification de la version officielle…','Checking the official release…'],
      available:['Une nouvelle version est disponible.','A new version is available.'],
      current:['Vous utilisez une version à jour.','Your version is up to date.'],
      downloading:['Téléchargement de la mise à jour…','Downloading the update…'],
      ready:['La mise à jour vérifiée est prête à être installée.','The verified update is ready to install.'],
      staging:['Préparation du redémarrage…','Preparing to restart…'],
      error:['La mise à jour demande votre attention.','The update needs your attention.']
    };
    const phrase = titles[status || 'idle'] || titles.idle!;
    this.heading.textContent = this.tr('Mises à jour','Updates');
    this.status.textContent = this.tr(...phrase);
    this.details.textContent = current ? this.tr(`Version installée : ${current.currentVersion}${current.latestVersion ? ` · Version officielle : ${current.latestVersion}` : ''}`,`Installed version: ${current.currentVersion}${current.latestVersion ? ` · Official release: ${current.latestVersion}` : ''}`) : this.tr('Connexion à l’application…','Connecting to the application…');
    const labels: Record<string,string> = {
      check:this.tr('Rechercher une mise à jour','Check for updates'),
      download:current?.installSupported ? this.tr('Télécharger la mise à jour','Download update') : this.tr('Téléchargement officiel','Official download'),
      install:this.tr('Installer et redémarrer','Install and restart'),rollback:current?.previousVersion?this.tr('Revenir à la version ','Restore version ')+current.previousVersion:this.tr('Revenir à la version précédente','Restore previous version'),cancel:this.tr('Annuler','Cancel'),openRelease:this.tr('Voir la version officielle','View official release')
    };
    for (const [name,button] of this.buttons) {
      button.textContent = labels[name]!;
      button.hidden = ['install','rollback'].includes(name) ? current?.installSupported !== true : name === 'cancel' ? !['checking','downloading'].includes(status || '') : name === 'openRelease' ? !current?.releaseUrl : false;
      button.disabled = this.busy && name !== 'cancel' || !current || (name === 'check' ? !current.canCheck : name === 'download' ? !current.canDownload : name === 'install' ? !current.canInstall : name === 'rollback' ? !current.canRollback : name === 'cancel' ? !['checking','downloading'].includes(status || '') : !current.releaseUrl);
      if(name==='rollback')button.title=current?.previousVersion?this.tr('Version vérifiée : ','Verified version: ')+current.previousVersion:this.tr('Aucune sauvegarde intégrée vérifiable.','No verified in-app backup available.');
    }
    this.noteSummary.textContent = this.tr('Nouveautés de cette version','What’s new in this release');
    this.notes.textContent = typeof current?.notes === 'string' && current.notes ? current.notes.slice(0,40000) : this.tr('Les nouveautés apparaîtront après la vérification.','Release notes will appear after checking.');
    const progress = current?.progress;
    this.progress.hidden = !progress || !Number.isSafeInteger(progress.totalBytes) || progress.totalBytes <= 0 || !Number.isSafeInteger(progress.receivedBytes) || progress.receivedBytes < 0 || progress.receivedBytes > progress.totalBytes;
    if (progress && !this.progress.hidden) { this.progress.max = progress.totalBytes; this.progress.value = progress.receivedBytes; this.progress.setAttribute('aria-label',this.tr('Téléchargement de la mise à jour','Update download')); }
    const code = this.localError || current?.error;
    if (code) this.feedback.textContent = this.errorMessage(code);
    else if (current?.busyReasons.length && status === 'ready') this.feedback.textContent = this.tr('Avant l’installation, terminez ou arrêtez : ','Before installing, finish or stop: ')+current.busyReasons.map(reason => this.busyLabel(reason)).join(', ')+'.';
    else if (current?.lastResult && ['rolled-back','failed','recovery-required'].includes(current.lastResult.status)) this.feedback.textContent = current.lastResult.status === 'recovery-required' ? this.tr('La dernière installation demande une vérification manuelle. Les dossiers modifiés et la sauvegarde ont été conservés.','The last installation requires manual review. Changed folders and the backup have been preserved.') : this.tr('La dernière installation n’a pas abouti. La version précédente a été conservée.','The last installation did not finish. The previous version was preserved.');
    else if (current && !current.installSupported) this.feedback.textContent = this.tr('L’installation sur ce système se fait depuis le téléchargement officiel. Vos réglages restent dans votre profil ChartsHub.','Install on this system using the official download. Your settings remain in your ChartsHub profile.');
    else this.feedback.textContent = this.tr('Vous choisissez quand installer. Vos chansons et vos réglages sont conservés.','You choose when to install. Your songs and settings are preserved.');
  }
  private busyLabel(code: string): string {
    const labels: Record<string,[string,string]> = {chart_downloads:['les téléchargements de charts','chart downloads'],library_scanning:['l’analyse de la bibliothèque','the library scan'],library_cleanup:['le nettoyage de la bibliothèque','library cleanup'],game_setup:['l’installation des effets du jeu','game effects setup'],player_active:['la lecture audio','audio playback'],stream_active:['le serveur OBS','the OBS server'],requests_active:['la réception des demandes','request reception'],sharing_active:['la publication de la liste','song list publishing'],dialog_active:['la fenêtre de choix ouverte','the open selection dialog'],configuration_busy:['la sauvegarde de configuration','configuration backup']};
    return this.tr(...(labels[code] || ['l’opération en cours','the current operation']));
  }
  private errorMessage(code: string): string {
    if (code === 'UPDATE_CANCELLED') return this.tr('Téléchargement ou vérification annulé.','Download or check cancelled.');
    if (code === 'UPDATE_RATE_LIMITED') return this.tr('GitHub limite temporairement les vérifications. Réessayez plus tard.','GitHub is temporarily limiting checks. Try again later.');
    if (code === 'UPDATE_OPERATIONS_ACTIVE') return this.tr('Terminez les opérations en cours avant d’installer.','Finish active operations before installing.');
    if (['UPDATE_BACKUP_UNAVAILABLE','UPDATE_BACKUP_INVALID','UPDATE_BACKUP_CHANGED'].includes(code)) return this.tr('La sauvegarde précédente ne peut pas être vérifiée. Aucun fichier de l’application n’a été remplacé.','The previous backup could not be verified. No application files were replaced.');
    if (['UPDATE_PATH_UNSAFE','UPDATE_SONGS_IN_APPLICATION','UPDATE_INSTALL_UNSUPPORTED'].includes(code)) return this.tr('L’installation intégrée n’est pas disponible pour ce dossier. Utilisez le téléchargement officiel.','In-app installation is unavailable for this folder. Use the official download.');
    if (['UPDATE_SOURCE_MISMATCH','UPDATE_BUILD_UNVERIFIED','UPDATE_ARCHIVE_DIGEST','UPDATE_CHECKSUMS_MISMATCH','UPDATE_RELEASE_CHANGED','UPDATE_ARCHIVE_CHANGED'].includes(code)) return this.tr('La version n’a pas pu être vérifiée. Aucun fichier de l’application n’a été remplacé.','The release could not be verified. No application files were replaced.');
    return this.tr('La mise à jour n’a pas pu être préparée. Réessayez ou ouvrez la version officielle.','The update could not be prepared. Try again or open the official release.');
  }
}
