const TEXT = {
  fr: {
    title: 'Quick Import · BÊTA',
    compatibility: 'Compatible et testé avec Clone Hero 1.1.0.6142-final Stable · Windows x64. Autres versions non validées.',
    optional: 'Facultatif · désactivé à chaque démarrage de ChartsHub. Sans cette option, téléchargez normalement puis utilisez Scan Songs dans Clone Hero.',
    intro: 'Ajoutez les nouvelles charts téléchargées à Clone Hero, sans lancer un scan complet.',
    installTitle: 'Première installation : MelonLoader et le module',
    installIntro: 'Ce guide est facultatif. Le bouton ci-dessous ouvre le dossier qui contient le README ; il ne lance aucun script et n’installe rien.',
    installSteps: [
      ['Fermer le jeu', 'Gardez une copie de sécurité de Clone Hero, puis fermez le jeu et son lanceur. Vérifiez la version 1.1.0.6142-final Stable · Windows x64.'],
      ['Récupérer les prérequis', 'Depuis le lien officiel du README, téléchargez séparément MelonLoader 0.7.3 Windows x64. Il n’est pas inclus dans ChartsHub. Vérifiez aussi les prérequis officiels, dont .NET 6 Desktop Runtime pour ce jeu IL2CPP.'],
      ['Afficher le plan', 'Ouvrez les fichiers d’installation ci-dessous et lisez README.md. Dans PowerShell, depuis ce dossier, adaptez l’exemple aux chemins de votre jeu, de son dossier Songs déjà configuré et de l’archive MelonLoader téléchargée. Sans -Apply, le script affiche seulement le plan.'],
      ['Appliquer et ouvrir le jeu', 'Après lecture du plan, reprenez la commande avec -Apply -EnableBeta pour installer et activer explicitement le module. Avec -Apply seul, il reste désactivé. Ouvrez ensuite le jeu vous-même et laissez son premier démarrage préparer ses composants, puis suivez les étapes de connexion ci-dessous.'],
    ],
    installExample: 'Exemple à adapter · aperçu sans installation',
    installShared: 'Une installation MelonLoader compatible déjà présente est conservée. Quick Import, Accuracy et les paroles utilisent le même chargeur, avec des modules et des activations séparés.',
    installRemoval: 'Pour retirer Quick Import, Uninstall-QuickImport.ps1 affiche d’abord le plan ; -Apply retire seulement les fichiers créés par cette installation et restés inchangés. Les chansons et profils sont conservés, ainsi que le chargeur si d’autres modules en dépendent.',
    openPackage: 'Ouvrir les fichiers d’installation', prerequisites: 'Prérequis officiels MelonLoader',
    installError: 'Le guide n’a pas pu être ouvert. Vérifiez que vous utilisez le téléchargement Windows x64 complet de ChartsHub, puis réessayez.',
    steps: [
      ['Préparer Clone Hero', 'Vérifiez la version indiquée ci-dessus. Quick Import nécessite son module compatible et MelonLoader dans le jeu. Ils restent facultatifs ; choisir le jeu ici ne les installe pas.'],
      ['Choisir le dossier Songs', 'Dans Bibliothèque, choisissez le dossier Songs utilisé par Clone Hero. Choisissez ce même dossier comme destination de vos téléchargements.'],
      ['Connecter le jeu', 'Ouvrez Clone Hero avec le module, revenez ici, cliquez sur Choisir Clone Hero et sélectionnez Clone Hero.exe, puis sur Activer et connecter. Attendez l’état Connecté.'],
      ['Télécharger une chart', 'Dans le Catalogue ou le Tableau de bord, téléchargez une nouvelle chart au format Dossier dans Songs. Quick Import prend en charge notes.chart et notes.mid. Les fichiers ZIP ou SNG conservés en archive ne sont pas ajoutés.'],
      ['Revenir à la liste des chansons', 'Si vous jouez, l’ajout attend le menu. Utilisez Actualiser les imports pour vérifier l’état Prêt dans Clone Hero, puis sélectionnez la nouvelle chart. Aucun scan complet n’est lancé.'],
    ],
    choose: 'Choisir Clone Hero', connect: 'Activer et connecter', disable: 'Désactiver et déconnecter', refresh: 'Actualiser les imports',
    unavailable: 'Quick Import attend un module validé pour cette version du jeu.',
    noGame: 'Choisissez votre installation de Clone Hero.', noRoot: 'Choisissez votre dossier Songs dans Bibliothèque.',
    selected: 'Jeu choisi : ', connected: 'Connecté', disconnected: 'Non connecté', busy: 'Action en cours…',
    readonly: 'Le choix du jeu ne peut pas être enregistré. Le fichier de réglages existant est conservé.',
    empty: 'Aucun nouvel import pendant cette session.',
    scope: 'Les anciennes charts ne sont pas réimportées. Déconnecter arrête les prochains envois ; un import déjà reçu par le jeu peut encore se terminer.',
    failure: 'Quick Import n’a pas pu terminer cette action. Vérifiez le module, le jeu et le dossier Songs.',
    moduleMissing: 'Ouvrez Clone Hero avec le module Quick Import compatible, puis reconnectez-le.',
    timeout: 'Le jeu ne répond pas. Réessayez une fois revenu au menu.',
    full: 'La file d’import est pleine. Revenez au menu du jeu pour terminer les ajouts en attente.',
    unknown: 'À vérifier', waiting: 'En attente du menu', preparing: 'Préparation', submitted: 'Transmis au jeu',
    queued: 'En attente du menu', importing: 'Ajout dans le jeu', ready: 'Prêt dans Clone Hero', failed: 'Import échoué',
    cancelled: 'Envoi local arrêté', unconfirmed: 'Résultat à vérifier', resolving: 'Préparation', submitting: 'Envoi au jeu', item: 'Import ',
  },
  en: {
    title: 'Quick Import · BETA',
    compatibility: 'Compatible and tested with Clone Hero 1.1.0.6142-final Stable · Windows x64. Other versions are not validated.',
    optional: 'Optional · off every time ChartsHub starts. Without this option, download normally and use Scan Songs in Clone Hero.',
    intro: 'Add newly downloaded charts to Clone Hero without starting a full scan.',
    installTitle: 'First setup: MelonLoader and the module',
    installIntro: 'This guide is optional. The button below opens the folder containing the README; it does not run a script or install anything.',
    installSteps: [
      ['Close the game', 'Keep a backup of Clone Hero, then close the game and its launcher. Check for version 1.1.0.6142-final Stable · Windows x64.'],
      ['Obtain the prerequisites', 'Use the official link in the README to download MelonLoader 0.7.3 Windows x64 separately. It is not bundled with ChartsHub. Check the official prerequisites, including .NET 6 Desktop Runtime for this IL2CPP game.'],
      ['Preview the plan', 'Open the setup files below and read README.md. In PowerShell, from that folder, adapt the example to your game, its already configured Songs folder and the downloaded MelonLoader archive. Without -Apply, the script only shows a plan.'],
      ['Apply and open the game', 'After reviewing the plan, repeat the command with -Apply -EnableBeta to explicitly install and enable the module. With -Apply alone it stays disabled. Open the game yourself and let its first launch prepare the components, then follow the connection steps below.'],
    ],
    installExample: 'Adapt this example · preview without installation',
    installShared: 'An existing compatible MelonLoader installation is preserved. Quick Import, Accuracy and lyrics share the loader, with separate modules and activation choices.',
    installRemoval: 'To remove Quick Import, Uninstall-QuickImport.ps1 first previews a plan; -Apply removes only unchanged files created by that setup. Songs and profiles are preserved, together with the loader when other modules depend on it.',
    openPackage: 'Open setup files', prerequisites: 'Official MelonLoader prerequisites',
    installError: 'The guide could not be opened. Check that you have the complete Windows x64 ChartsHub download, then try again.',
    steps: [
      ['Prepare Clone Hero', 'Check the version shown above. Quick Import requires its compatible module and MelonLoader in the game. Both are optional; choosing the game here does not install them.'],
      ['Choose the Songs folder', 'In Library, choose the Songs folder used by Clone Hero. Choose that same folder as your download destination.'],
      ['Connect the game', 'Open Clone Hero with the module, return here, click Choose Clone Hero and select Clone Hero.exe, then Enable and connect. Wait for Connected.'],
      ['Download a chart', 'From the Catalogue or the Dashboard, download a new chart in Folder format into Songs. Quick Import supports notes.chart and notes.mid. ZIP or SNG files kept as archives are not added.'],
      ['Return to the song list', 'If you are playing, the addition waits for a menu. Use Refresh imports to check for Ready in Clone Hero, then select the new chart. No full scan is started.'],
    ],
    choose: 'Choose Clone Hero', connect: 'Enable and connect', disable: 'Disable and disconnect', refresh: 'Refresh imports',
    unavailable: 'Quick Import is waiting for a validated module for this game build.',
    noGame: 'Choose your Clone Hero installation.', noRoot: 'Choose your Songs folder in Library.',
    selected: 'Selected game: ', connected: 'Connected', disconnected: 'Not connected', busy: 'Action in progress…',
    readonly: 'The selected game cannot be saved. The existing settings file is preserved.',
    empty: 'No new imports in this session.',
    scope: 'Old charts are not imported again. Disconnect stops new sends; an import already received by the game may still finish.',
    failure: 'Quick Import could not complete this action. Check the module, game and Songs folder.',
    moduleMissing: 'Open Clone Hero with its compatible Quick Import module, then reconnect it.',
    timeout: 'The game is not responding. Try again after returning to its menu.',
    full: 'The import queue is full. Return to the game menu to finish the pending additions.',
    unknown: 'Check result', waiting: 'Waiting for a menu', preparing: 'Preparing', submitted: 'Sent to the game',
    queued: 'Waiting for a menu', importing: 'Adding to the game', ready: 'Ready in Clone Hero', failed: 'Import failed',
    cancelled: 'Local send stopped', unconfirmed: 'Check result', resolving: 'Preparing', submitting: 'Sending to the game', item: 'Import ',
  },
};
const ACTIONS = ['chooseGame', 'connect', 'disable', 'refresh'];
const HELP_ACTIONS = Object.freeze({ openPackage: 'quickImport.openPackage', prerequisites: 'quickImport.prerequisites' });
function errorText(code, t) {
  if (['QUICK_IMPORT_NOT_VALIDATED', 'UNVERIFIED_BUILD', 'IMPORT_NOT_VALIDATED'].includes(code)) return t.unavailable;
  if (['CONNECTION_UNAVAILABLE', 'INVALID_DESCRIPTOR', 'CONNECTION_CHANGED'].includes(code)) return t.moduleMissing;
  if (code === 'QUICK_IMPORT_SONGS_REQUIRED') return t.noRoot;
  if (['QUICK_IMPORT_GAME_REQUIRED', 'QUICK_IMPORT_GAME_INVALID'].includes(code)) return t.noGame;
  if (code === 'QUICK_IMPORT_PREFERENCES') return t.readonly;
  if (code === 'TIMEOUT') return t.timeout;
  if (['QUEUE_FULL', 'CLIENT_QUEUE_FULL', 'OBSERVER_QUEUE_FULL'].includes(code)) return t.full;
  return t.failure;
}

export class QuickImportControls {
  constructor({ root, command }) {
    this.root = root; this.command = command; this.snapshot = null; this.signature = null;
    this.pending = false; this.localError = false; this.disposed = false; this.listeners = []; this.commandEpoch = 0;
    this.helpPending = new Set(); this.helpError = false; this.helpLanguage = null;
    const document = root.ownerDocument;
    const make = (tag, className = '') => { const node = document.createElement(tag); node.className = className; return node; };
    const title = make('h3'), compatibility = make('p', 'quick-import-compatibility'), optional = make('p', 'helper-text');
    const intro = make('p', 'helper-text'), steps = make('ol', 'quick-import-steps');
    const installation = make('section', 'quick-import-installation'); installation.id = 'quick-import-installation-guide';
    const installTitle = make('h4'), installIntro = make('p', 'helper-text'), installSteps = make('ol');
    installTitle.id = 'quick-import-installation-title'; installation.setAttribute('aria-labelledby', installTitle.id);
    const helpActions = make('div', 'quick-import-actions'), openPackage = make('button', 'button secondary'), prerequisites = make('button', 'button secondary');
    for (const [button, action] of [[openPackage, 'openPackage'], [prerequisites, 'prerequisites']]) {
      button.type = 'button'; button.id = action === 'openPackage' ? 'quick-import-open-package' : 'quick-import-prerequisites';
      const listener = () => { void this.openHelp(action); }; button.addEventListener('click', listener); this.listeners.push([button, listener]); helpActions.append(button);
    }
    const installExample = make('p', 'helper-text'), installCommand = make('pre', 'quick-import-install-command');
    installCommand.textContent = ".\\Install-QuickImport.ps1 -GameRoot 'C:\\Games\\Clone Hero' -SongsRoot 'D:\\Songs' -LoaderZip 'C:\\Downloads\\MelonLoader.x64.zip'";
    const installShared = make('p', 'helper-text'), installRemoval = make('p', 'helper-text'), installFeedback = make('p', 'quick-import-feedback');
    installFeedback.setAttribute('role', 'alert'); installFeedback.hidden = true;
    installation.append(installTitle, installIntro, helpActions, installSteps, installExample, installCommand, installShared, installRemoval, installFeedback);
    const status = make('p', 'quick-import-status'); status.id = 'quick-import-status'; status.setAttribute('role', 'status');
    const feedback = make('p', 'quick-import-feedback'); feedback.id = 'quick-import-feedback'; feedback.setAttribute('role', 'alert'); feedback.hidden = true;
    const actions = make('div', 'quick-import-actions'), jobs = make('ul', 'quick-import-jobs');
    const empty = make('p', 'helper-text'), scope = make('p', 'helper-text');
    this.nodes = { title, compatibility, optional, intro, installation, installTitle, installIntro, installSteps, installExample, installCommand, installShared, installRemoval, installFeedback, openPackage, prerequisites, steps, status, feedback, actions, jobs, empty, scope };
    for (const action of ACTIONS) {
      const button = make('button', 'button secondary'); button.type = 'button';
      button.id = 'quick-import-' + (action === 'chooseGame' ? 'choose-game' : action);
      button.setAttribute('data-quick-import-action', action);
      const listener = () => { void this.run(action); };
      button.addEventListener('click', listener); this.listeners.push([button, listener]);
      actions.append(button); this.nodes[action] = button;
    }
    root.replaceChildren(title, compatibility, optional, intro, installation, steps, status, actions, feedback, empty, jobs, scope);
    this.update({ language: 'fr', quickImport: null });
  }

  update(snapshot) {
    if (this.disposed) return;
    this.snapshot = snapshot;
    const state = snapshot?.quickImport ?? {}, language = snapshot?.language === 'en' ? 'en' : 'fr';
    const hasRoot = typeof snapshot?.library?.settings?.rootPath === 'string' && snapshot.library.settings.rootPath.length > 0;
    const signature = JSON.stringify([state, language, hasRoot, this.pending, this.localError, [...this.helpPending].sort(), this.helpError]);
    if (signature === this.signature) return;
    this.signature = signature;
    const t = TEXT[language], n = this.nodes, busy = this.pending || state.busy === true;
    n.title.textContent = t.title; n.compatibility.textContent = t.compatibility; n.optional.textContent = t.optional;
    n.intro.textContent = t.intro; n.scope.textContent = t.scope;
    if (this.helpLanguage !== language) {
      this.helpLanguage = language;
      for (const name of ['installTitle', 'installIntro', 'installExample', 'installShared', 'installRemoval', 'openPackage', 'prerequisites']) n[name].textContent = t[name];
      n.installSteps.replaceChildren(...t.installSteps.map(([label, detail]) => {
        const row = this.root.ownerDocument.createElement('li'), heading = this.root.ownerDocument.createElement('strong'), description = this.root.ownerDocument.createElement('p');
        heading.textContent = label; description.textContent = detail; row.append(heading, description); return row;
      }));
    }
    n.openPackage.disabled = this.helpPending.has('openPackage'); n.prerequisites.disabled = this.helpPending.has('prerequisites');
    n.installFeedback.hidden = !this.helpError; n.installFeedback.textContent = this.helpError ? t.installError : '';
    const steps = t.steps.map(([label, description]) => {
      const row = this.root.ownerDocument.createElement('li');
      const heading = this.root.ownerDocument.createElement('strong'), detail = this.root.ownerDocument.createElement('p');
      heading.textContent = label; detail.textContent = description; row.append(heading, detail); return row;
    });
    n.steps.replaceChildren(...steps);
    n.chooseGame.textContent = t.choose; n.connect.textContent = t.connect;
    n.disable.textContent = t.disable; n.refresh.textContent = t.refresh;
    n.status.textContent = !state.supported ? t.unavailable : busy ? t.busy : !state.selected ? t.noGame : !hasRoot ? t.noRoot
      : state.connected ? t.connected : t.selected + (typeof state.gameName === 'string' ? state.gameName : '') + ' · ' + t.disconnected;
    const readonly = state.savedCanWrite === false;
    n.chooseGame.disabled = !state.supported || busy || readonly;
    n.connect.disabled = !state.supported || busy || readonly || !state.selected || !hasRoot || state.connected === true;
    n.disable.disabled = !(state.connected || state.enabled || busy);
    const jobs = Array.isArray(state.jobs) ? state.jobs.slice(-32) : [];
    n.refresh.disabled = !state.connected || busy || jobs.length === 0;
    n.feedback.hidden = !(this.localError || state.error || readonly);
    n.feedback.textContent = readonly ? t.readonly : errorText(this.localError || state.error, t);
    n.empty.hidden = jobs.length > 0; n.empty.textContent = t.empty;
    const rows = jobs.map(job => {
      const row = this.root.ownerDocument.createElement('li');
      const uncertain = job.confirmed === false && ['queued', 'importing', 'ready', 'submitted'].includes(job.state);
      const label = uncertain ? t.unconfirmed : t[job.state] ?? t.unknown;
      const id = typeof job.id === 'string' && /^[a-f0-9-]{36}$/i.test(job.id) ? job.id.slice(0, 8) : '—';
      row.textContent = t.item + id + ' · ' + label;
      return row;
    });
    n.jobs.replaceChildren(...rows);
    this.root.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  async run(action) {
    if (this.disposed || !ACTIONS.includes(action) || this.nodes[action].disabled) return;
    if (this.pending && action !== 'disable') return;
    const ticket = ++this.commandEpoch;
    this.pending = true; this.localError = false; this.signature = null; this.update(this.snapshot);
    try {
      const result = await this.command('quickImport.' + action, {});
      if (this.disposed || ticket !== this.commandEpoch) return;
      this.localError = result?.ok === true ? false : typeof result?.code === 'string' && result.code.length <= 64 ? result.code : true;
    } catch { if (!this.disposed && ticket === this.commandEpoch) this.localError = true; }
    finally {
      if (!this.disposed && ticket === this.commandEpoch) { this.pending = false; this.signature = null; this.update(this.snapshot); }
    }
  }

  async openHelp(action) {
    if (this.disposed || !Object.hasOwn(HELP_ACTIONS, action) || this.helpPending.has(action)) return;
    this.helpPending.add(action); this.helpError = false; this.signature = null; this.update(this.snapshot);
    try {
      const result = await this.command(HELP_ACTIONS[action], {});
      if (!this.disposed) this.helpError = result?.ok !== true;
    } catch { if (!this.disposed) this.helpError = true; }
    finally {
      if (!this.disposed) { this.helpPending.delete(action); this.signature = null; this.update(this.snapshot); }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.commandEpoch++;
    for (const [button, listener] of this.listeners) button.removeEventListener('click', listener);
    this.listeners = [];
  }
}
