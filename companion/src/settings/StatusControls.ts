import type { MaintenanceBridge, UpdaterSnapshot } from './UpdatesControls.js';

interface StatusSnapshot {
  language?: string;
  library?: {status: string; count: number; error?: string|null; watcher?: string};
  songRequests?: {
    enabled: boolean; bridge?: {enabled: boolean; error?: string|null};
    connections?: Partial<Record<'twitch'|'tiktok', {state: string}>>;
    sharing?: {busy: boolean; error?: string|null; url?: string|null; autoSync?: {pending?: boolean; retrying?: boolean}};
    publicRequests?: {supported?: boolean; active?: boolean; connected?: boolean; error?: string|null};
  };
  stream?: {enabled: boolean; clients: number; error: string|null};
  downloads?: {items: {state: string}[]; error?: string|null};
  persistenceError?: string|null;
}
type Tone = 'idle'|'ready'|'working'|'attention';
type CardName = 'chat'|'library'|'sharing'|'obs'|'updates'|'downloads';
interface Card {title: HTMLElement; status: HTMLElement; detail: HTMLElement; button: HTMLButtonElement; root: HTMLElement;}
const number = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value,1000000) : 0;
const setText = (node: HTMLElement,value: string): void => { if (node.textContent !== value) node.textContent = value; };

/** Existing local snapshots only. These buttons reveal controls and start no operation. */
export class StatusControls {
  private readonly abort = new AbortController();
  private readonly unsubscribe: () => void;
  private readonly heading: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly note: HTMLElement;
  private readonly cards = new Map<CardName, Card>();
  private snapshot: StatusSnapshot|null = null;
  private updater: UpdaterSnapshot|null = null;
  private language = 'en';
  private maintenanceRevision = 0;
  private disposed = false;
  constructor(private readonly options: {root: HTMLElement; reveal: (selector: string) => unknown; bridge?: MaintenanceBridge}) {
    const doc = options.root.ownerDocument;
    this.heading = doc.createElement('h2'); this.heading.id = 'status-title';
    this.summary = doc.createElement('p'); this.summary.className = 'helper-text'; this.summary.dataset.statusSummary = ''; this.summary.setAttribute('role','status');
    const grid = doc.createElement('div'); grid.className = 'status-cards';
    const destinations: Record<CardName,string> = {chat:'#song-requests-connections-details',library:'#library-panel',sharing:'#song-requests-sharing',obs:'#stream-panel',updates:'#updates-panel',downloads:'#downloads-panel'};
    for (const name of Object.keys(destinations) as CardName[]) {
      const root = doc.createElement('article'); root.className = 'status-card'; root.dataset.statusCard = name;
      const title = doc.createElement('h3'), status = doc.createElement('strong'), detail = doc.createElement('p'), button = doc.createElement('button');
      status.dataset.statusValue = name; detail.className = 'helper-text'; button.type = 'button'; button.className = 'button secondary'; button.dataset.statusAction = name;
      button.addEventListener('click', () => { if (!this.disposed && !button.disabled) options.reveal(destinations[name]); }, {signal:this.abort.signal});
      root.append(title,status,detail,button); grid.append(root); this.cards.set(name,{root,title,status,detail,button});
    }
    this.note = doc.createElement('p'); this.note.className = 'helper-text';
    options.root.replaceChildren(this.heading,this.summary,grid,this.note);
    this.unsubscribe = options.bridge?.subscribe(value => { if (!this.disposed && value?.updater) { this.maintenanceRevision++; this.updater = value.updater; this.render(); } }) ?? (() => {});
    this.render();
    const revision = this.maintenanceRevision;
    if (options.bridge) void options.bridge.getState().then(value => { if (!this.disposed && this.maintenanceRevision === revision && value?.updater) { this.updater = value.updater; this.render(); } }).catch(() => {});
  }
  update(snapshot: StatusSnapshot): void { if (!this.disposed) { this.snapshot = snapshot; this.language = snapshot.language === 'fr' ? 'fr' : 'en'; this.render(); } }
  dispose(): void { this.disposed = true; this.abort.abort(); this.unsubscribe(); }
  private tr(fr: string,en: string): string { return this.language === 'fr' ? fr : en; }
  private render(): void {
    if (this.disposed) return;
    let attention = this.snapshot?.persistenceError ? 1 : 0;
    const display = (name: CardName,title: string,status: string,detail: string,action: string,tone: Tone): void => {
      const card = this.cards.get(name)!; setText(card.title,title); setText(card.status,status); setText(card.detail,detail); setText(card.button,action);
      card.root.dataset.state = tone; card.button.disabled = !this.snapshot || name === 'updates' && !this.options.bridge;
      if (tone === 'attention') attention++;
    };
    const s = this.snapshot, requests = s?.songRequests, chat = requests?.connections;
    const connected = ['twitch','tiktok'].filter(name => chat?.[name as 'twitch'|'tiktok']?.state === 'connected');
    const connecting = ['twitch','tiktok'].some(name => ['connecting','reconnecting','authorizing'].includes(chat?.[name as 'twitch'|'tiktok']?.state ?? ''));
    const chatError = ['twitch','tiktok'].some(name => chat?.[name as 'twitch'|'tiktok']?.state === 'error') || !!requests?.bridge?.error;
    display('chat',this.tr('Connexions du chat','Chat connections'),connected.length ? connected.map(name => name === 'twitch' ? 'Twitch' : 'TikTok').join(' · ') : connecting ? this.tr('Connexion en cours…','Connecting…') : requests?.bridge?.enabled ? this.tr('Pont local actif','Local bridge active') : this.tr('Chat déconnecté','Chat disconnected'),
      chatError ? this.tr('Une connexion demande une vérification.','A connection needs attention.') : requests?.enabled ? this.tr('Réception activée ; les demandes suivent vos règles et votre bibliothèque.','Reception enabled; requests follow your rules and library.') : this.tr('La réception des demandes est arrêtée.','Request reception is off.'),this.tr('Ouvrir les connexions','Open connections'),chatError?'attention':connecting?'working':connected.length?'ready':'idle');
    const library = s?.library, count = number(library?.count), ready = library?.status === 'ready';
    display('library',this.tr('Bibliothèque','Library'),library?.status === 'scanning' ? this.tr('Analyse en cours…','Scan in progress…') : ready ? this.tr(`${count.toLocaleString('fr-CA')} morceaux`,`${count.toLocaleString('en-CA')} songs`) : this.tr('Bibliothèque à préparer','Prepare library'),
      library?.error ? this.tr('La dernière analyse demande une vérification. Le dernier index enregistré est conservé.','The last scan needs attention. The last saved index is preserved.') : ready && library?.watcher === 'unavailable' ? this.tr('Détection des changements indisponible : actualisez pour voir les ajouts.','Folder detection unavailable: refresh to see additions.') : ready ? this.tr('Le dernier index enregistré est disponible.','The last saved index is available.') : this.tr('Choisissez votre dossier Songs ou consultez la progression.','Choose your Songs folder or view scan progress.'),this.tr('Ouvrir la bibliothèque','Open library'),library?.error?'attention':library?.status === 'scanning'?'working':ready&&count?'ready':'idle');
    const share = requests?.sharing, web = requests?.publicRequests;
    display('sharing',this.tr('Liste publique','Public list'),share?.error || web?.error ? this.tr('Partage à vérifier','Check sharing') : share?.busy ? this.tr('Mise à jour en cours…','Updating…') : share?.url ? this.tr('Liste publiée','List published') : this.tr('Aucune liste publiée','No list published'),
      share?.error || web?.error ? this.tr('Consultez le détail et les actions dans Demandes.','View details and available actions in Requests.') : share?.autoSync?.retrying ? this.tr('Une nouvelle tentative de synchronisation est prévue.','Another synchronization attempt is scheduled.') : share?.autoSync?.pending ? this.tr('Actualisation automatique en attente.','Automatic update pending.') : web?.supported && web.active && web.connected ? this.tr('Les demandes du site sont reçues.','Website requests are being received.') : share?.url ? this.tr('Le lien des spectateurs reste le même.','The viewer link stays the same.') : this.tr('La publication reste votre choix.','You choose when to publish.'),this.tr('Gérer le partage','Manage sharing'),share?.error||web?.error?'attention':share?.busy?'working':share?.url?'ready':'idle');
    const stream = s?.stream;
    display('obs','Stream / OBS',stream?.error ? this.tr('Serveur à vérifier','Check server') : stream?.enabled ? this.tr('Serveur actif','Server active') : this.tr('Serveur arrêté','Server stopped'),
      stream?.error ? this.tr('Consultez le message du serveur et ses réglages.','View the server message and settings.') : this.tr(`${number(stream?.clients)} source(s) connectée(s).`,`${number(stream?.clients)} source(s) connected.`),this.tr('Ouvrir Stream / OBS','Open Stream / OBS'),stream?.error?'attention':stream?.enabled?'ready':'idle');
    const update = this.updater;
    const updateLabels: Partial<Record<UpdaterSnapshot['status'],[string,string]>> = {cached:['Téléchargement retrouvé · à vérifier','Download found · verify to resume'],ready:['Mise à jour prête','Update ready'],checking:['Vérification en cours…','Checking…'],downloading:['Téléchargement en cours…','Downloading…'],staging:['Préparation en cours…','Preparing…'],available:['Nouvelle version disponible','New version available'],current:['Application à jour','App up to date'],error:['Mise à jour à vérifier','Check update']};
    const updateIssue = !!update?.error || ['failed','recovery-required','rolled-back'].includes(update?.lastResult?.status ?? '');
    display('updates',this.tr('Application','Application'),update && updateLabels[update.status] ? this.tr(...updateLabels[update.status]!) : this.tr('Vérification à votre demande','Check when you choose'),
      !this.options.bridge ? this.tr('Ouvrez ChartsHub pour gérer ses mises à jour.','Open ChartsHub to manage its updates.') : updateIssue ? this.tr('La dernière opération demande une vérification. Ouvrez les mises à jour pour la suite.','The last operation needs attention. Open Updates for the next step.') : update?.status === 'cached' ? this.tr('Vérifiez la version officielle avant de choisir une installation.','Verify the official release before choosing to install.') : this.tr('Aucune installation ne démarre sans votre confirmation.','No installation starts without your confirmation.'),this.tr('Ouvrir les mises à jour','Open updates'),updateIssue?'attention':['checking','downloading','staging'].includes(update?.status??'')?'working':['ready','current'].includes(update?.status??'')?'ready':'idle');
    const items = s?.downloads?.items ?? [], paused = items.filter(item => item.state === 'Paused').length, failed = items.filter(item => item.state === 'Failed').length, active = items.filter(item => ['Queued','Downloading'].includes(item.state)).length;
    display('downloads',this.tr('Téléchargements de charts','Chart downloads'),active ? this.tr(`${active} en cours ou en attente`,`${active} active or queued`) : paused ? this.tr(`${paused} en pause`,`${paused} paused`) : this.tr('Aucun téléchargement actif','No active downloads'),
      s?.downloads?.error || failed ? this.tr('Des téléchargements demandent une vérification.','Some downloads need attention.') : paused ? this.tr('Choisissez les éléments à reprendre dans la liste.','Choose which items to resume in the list.') : this.tr('Les téléchargements interrompus restent en pause après un redémarrage.','Interrupted downloads stay paused after a restart.'),this.tr('Voir les téléchargements','View downloads'),s?.downloads?.error||failed?'attention':active?'working':paused?'idle':'ready');
    setText(this.heading,this.tr('État de ChartsHub','ChartsHub status'));
    setText(this.summary,!s ? this.tr('Lecture de l’état local…','Reading local status…') : attention ? this.tr(`${attention} point(s) à vérifier.`,`${attention} item(s) need attention.`)+(s.persistenceError?this.tr(' Les réglages ne sont pas enregistrés ; consultez le message en haut.',' Settings are not being saved; see the message above.'):'') : this.tr('Aucun problème signalé par les services locaux.','No problems reported by local services.'));
    setText(this.note,this.tr('Ouvrez les réglages pour choisir la suite. Cet écran ne démarre aucune connexion, publication ni reprise de téléchargement.','Open settings to choose what happens next. This screen starts no connection, publication or download recovery.'));
  }
}
