const TEXT = {
  fr: {
    title: 'Quick Import · BÊTA',
    compatibility: 'Compatible et testé avec Clone Hero 1.1.0.6142-final Stable · Windows x64. Autres versions, Linux, macOS, Wine et Proton non validés.',
    optional: 'Facultatif · désactivé à chaque démarrage de ChartsHub. Sans cette option, téléchargez normalement puis utilisez Scan Songs dans Clone Hero.',
    intro: 'Ajoutez les nouvelles charts téléchargées à Clone Hero, sans lancer un scan complet.',
    installTitle: 'Installation guidée de MelonLoader et Quick Import',
    installIntro: 'MelonLoader charge les extensions du jeu. Le module Quick Import est fourni avec ChartsHub et doit être installé dans la copie de Clone Hero que vous ouvrez.',
    installSteps: [
      ['Fermer le jeu', 'Gardez une copie de sécurité de Clone Hero, puis fermez le jeu et son lanceur. Vérifiez la version 1.1.0.6142-final Stable · Windows x64.'],
      ['Choisir le jeu', 'Cliquez sur Installer Quick Import et sélectionnez Clone Hero.exe. L’assistant propose le dossier Songs trouvé dans les réglages du jeu. Choisissez Non pour en sélectionner un autre.'],
      ['Confirmer l’installation', 'Cliquez sur Oui. L’assistant télécharge et vérifie MelonLoader 0.7.3, puis installe et active Quick Import. Le README donne les liens Microsoft pour le .NET 6 Desktop Runtime requis et le SDK .NET 9.0 facultatif.'],
      ['Ouvrir Clone Hero', 'Ouvrez cette copie du jeu, puis connectez-la dans ChartsHub. Si MelonLoader affiche « 0 Mods loaded », vérifiez que Mods/ChartsHub.QuickImport.dll se trouve dans le dossier de ce Clone Hero.exe.'],
    ],
    installExample: 'Autre façon d’ouvrir l’assistant depuis le dossier d’installation. Collez cette commande dans PowerShell.',
    installShared: 'Une installation MelonLoader compatible déjà présente est conservée. Quick Import, Accuracy et les paroles utilisent le même chargeur, avec des modules et des activations séparés.',
    installRemoval: 'Pour retirer Quick Import, Uninstall-QuickImport.ps1 affiche d’abord le plan ; -Apply retire seulement les fichiers créés par cette installation et restés inchangés. Les chansons et profils sont conservés, ainsi que le chargeur si d’autres modules en dépendent.',
    openPackage: 'Ouvrir les fichiers d’installation', prerequisites: 'Prérequis officiels MelonLoader',
    setup: 'Installer Quick Import',
    hideConsole: 'Masquer le terminal MelonLoader', showConsole: 'Afficher le terminal MelonLoader',
    hideConsoleDone: 'Le terminal MelonLoader sera masqué au prochain lancement du jeu.',
    showConsoleDone: 'Le terminal MelonLoader sera visible au prochain lancement du jeu.',
    consoleError: 'Le réglage du terminal n’a pas été enregistré. Fermez Clone Hero et son lanceur, puis vérifiez que MelonLoader est installé dans le jeu choisi.',
    setupError: 'L’assistant n’a pas terminé. Consultez le message de l’assistant ou ouvrez les fichiers d’installation.',
    installError: 'Le guide n’a pas pu être ouvert. Réessayez ; les fichiers d’installation Quick Import sont réservés au paquet Windows x64 complet.',
    guideLabel: 'Guide pour le système', detected: 'Système de ChartsHub : ',
    systems: { win32: 'Windows', linux: 'Linux', darwin: 'macOS', unknown: 'Autre / non reconnu' },
    release: 'Téléchargement officiel MelonLoader 0.7.3',
    unsupported: 'Quick Import n’est pas validé sur ce système. Téléchargez normalement, puis utilisez Scan Songs dans Clone Hero. Installer MelonLoader seul ne rend pas le module ChartsHub compatible.',
    guideOnly: 'Le choix de ce guide change uniquement les explications. Il n’installe rien et n’active aucune compatibilité.',
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
    moduleMissing: 'Vérifiez que Mods/ChartsHub.QuickImport.dll est présent dans le dossier du jeu choisi. Ouvrez cette copie de Clone Hero, puis reconnectez-la.',
    timeout: 'Le jeu ne répond pas. Réessayez une fois revenu au menu.',
    full: 'La file d’import est pleine. Revenez au menu du jeu pour terminer les ajouts en attente.',
    unknown: 'À vérifier', waiting: 'En attente du menu', preparing: 'Préparation', submitted: 'Transmis au jeu',
    queued: 'En attente du menu', importing: 'Ajout dans le jeu', ready: 'Prêt dans Clone Hero', failed: 'Import échoué',
    cancelled: 'Envoi local arrêté', unconfirmed: 'Résultat à vérifier', resolving: 'Préparation', submitting: 'Envoi au jeu', item: 'Import ',
  },
  en: {
    title: 'Quick Import · BETA',
    compatibility: 'Compatible and tested with Clone Hero 1.1.0.6142-final Stable · Windows x64. Other versions, Linux, macOS, Wine and Proton are not validated.',
    optional: 'Optional · off every time ChartsHub starts. Without this option, download normally and use Scan Songs in Clone Hero.',
    intro: 'Add newly downloaded charts to Clone Hero without starting a full scan.',
    installTitle: 'Guided setup for MelonLoader and Quick Import',
    installIntro: 'MelonLoader loads game extensions. The Quick Import module comes with ChartsHub and must be installed into the copy of Clone Hero you open.',
    installSteps: [
      ['Close the game', 'Keep a backup of Clone Hero, then close the game and its launcher. Check for version 1.1.0.6142-final Stable · Windows x64.'],
      ['Select the game', 'Click Install Quick Import and select Clone Hero.exe. The wizard suggests the Songs folder from the game settings. Choose No to select another folder.'],
      ['Confirm setup', 'Choose Yes. The wizard downloads and verifies MelonLoader 0.7.3, then installs and enables Quick Import. The README links to the required Microsoft .NET 6 Desktop Runtime and the optional .NET 9.0 SDK.'],
      ['Open Clone Hero', 'Open that copy of the game and connect it in ChartsHub. If MelonLoader shows “0 Mods loaded”, check for Mods/ChartsHub.QuickImport.dll in the folder containing that Clone Hero.exe.'],
    ],
    installExample: 'Another way to open the wizard from the setup folder. Paste this command into PowerShell.',
    installShared: 'An existing compatible MelonLoader installation is preserved. Quick Import, Accuracy and lyrics share the loader, with separate modules and activation choices.',
    installRemoval: 'To remove Quick Import, Uninstall-QuickImport.ps1 first previews a plan; -Apply removes only unchanged files created by that setup. Songs and profiles are preserved, together with the loader when other modules depend on it.',
    openPackage: 'Open setup files', prerequisites: 'Official MelonLoader prerequisites',
    setup: 'Install Quick Import',
    hideConsole: 'Hide the MelonLoader console', showConsole: 'Show the MelonLoader console',
    hideConsoleDone: 'The MelonLoader console will be hidden the next time the game opens.',
    showConsoleDone: 'The MelonLoader console will be visible the next time the game opens.',
    consoleError: 'The console setting could not be saved. Close Clone Hero and its launcher, then check that MelonLoader is installed in the selected game.',
    setupError: 'The wizard did not finish. Check its message or open the setup files.',
    installError: 'The guide could not be opened. Try again; Quick Import setup files require the complete Windows x64 ChartsHub download.',
    guideLabel: 'System guide', detected: 'ChartsHub system: ',
    systems: { win32: 'Windows', linux: 'Linux', darwin: 'macOS', unknown: 'Other / unrecognised' },
    release: 'Official MelonLoader 0.7.3 download',
    unsupported: 'Quick Import is not validated on this system. Download normally, then use Scan Songs in Clone Hero. Installing MelonLoader alone does not make the ChartsHub module compatible.',
    guideOnly: 'Choosing this guide only changes the instructions. It installs nothing and does not enable compatibility.',
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
    moduleMissing: 'Check for Mods/ChartsHub.QuickImport.dll in the selected game folder. Open that copy of Clone Hero, then reconnect it.',
    timeout: 'The game is not responding. Try again after returning to its menu.',
    full: 'The import queue is full. Return to the game menu to finish the pending additions.',
    unknown: 'Check result', waiting: 'Waiting for a menu', preparing: 'Preparing', submitted: 'Sent to the game',
    queued: 'Waiting for a menu', importing: 'Adding to the game', ready: 'Ready in Clone Hero', failed: 'Import failed',
    cancelled: 'Local send stopped', unconfirmed: 'Check result', resolving: 'Preparing', submitting: 'Sending to the game', item: 'Import ',
  },
};
const PLATFORM_GUIDES = {
  fr: {
    linux: {
      intro: 'MelonLoader possède une distribution Linux, mais Quick Import ChartsHub n’est pas validé sous Linux natif ni sous Wine. Ne lancez pas le script Windows de ChartsHub sur ce système.',
      steps: [
        ['Identifier le jeu', 'Fermez le jeu et gardez une copie de sécurité. Distinguez Clone Hero Linux natif d’un jeu Windows lancé avec Wine : leurs installations MelonLoader sont différentes.'],
        ['Choisir les fichiers officiels', 'La release 0.7.3 propose MelonLoader.Installer.Linux et MelonLoader.Linux.x64.zip pour Linux natif. Choisissez les fichiers correspondant à votre jeu et consultez les prérequis officiels. ChartsHub ne télécharge ni ne lance cet installateur.'],
        ['Suivre le guide Linux ou Wine', 'Le guide officiel décrit les bibliothèques .so et LD_LIBRARY_PATH / LD_PRELOAD pour Linux natif. Pour Wine, il décrit le chargeur Windows, ses prérequis .NET dans le même préfixe et le réglage version=n,b. Ces étapes ne valident pas Quick Import sous Wine.'],
        ['Continuer sans Quick Import', 'Le module actuel vérifie des fichiers et des points d’entrée propres à Windows x64. Les commandes Quick Import restent indisponibles sur Linux ; téléchargez vos charts normalement puis lancez Scan Songs dans Clone Hero.'],
      ],
    },
    darwin: {
      intro: 'MelonLoader 0.7.3 propose des fichiers macOS. Quick Import ChartsHub n’est pas validé sur macOS ; n’utilisez pas les scripts Windows de ChartsHub.',
      steps: [
        ['Préparer une copie du jeu', 'Fermez le jeu et gardez une copie de sécurité. Vérifiez l’architecture de votre jeu ; la présence d’un chargeur macOS ne prouve pas sa compatibilité avec Clone Hero.'],
        ['Choisir le téléchargement officiel', 'La release 0.7.3 propose MelonLoader.Installer.MacOS.dmg et MelonLoader.macOS.x64.zip. Elle ne propose pas d’archive macOS arm64 ; aucune compatibilité Apple Silicon ou Rosetta de Quick Import n’est validée.'],
        ['Suivre l’installateur macOS officiel', 'L’aide officielle de MelonLoader Installer explique le choix d’un jeu Steam ou son ajout manuel, puis le choix de la version du chargeur. Sélectionnez 0.7.3 et suivez ces instructions pour votre jeu. ChartsHub ne modifie ni ne lance le jeu ou cet installateur.'],
        ['Continuer sans Quick Import', 'Le module ChartsHub actuel est spécifique à Windows x64. Les commandes Quick Import restent indisponibles sur macOS ; les téléchargements normaux et Scan Songs dans Clone Hero restent disponibles.'],
      ],
    },
    unknown: { intro: 'Ce système n’est pas reconnu pour Quick Import. Consultez la release et les prérequis officiels de MelonLoader ; aucun script d’installation ChartsHub n’est proposé pour ce système.', steps: [['Utiliser les fonctions disponibles', 'Téléchargez les charts normalement puis utilisez Scan Songs dans Clone Hero. Choisir un autre guide ici ne rend pas le module compatible avec votre système.']] },
  },
  en: {
    linux: {
      intro: 'MelonLoader has a Linux distribution, but ChartsHub Quick Import is not validated on native Linux or Wine. Do not run the ChartsHub Windows setup script on this system.',
      steps: [
        ['Identify the game', 'Close the game and keep a backup. Distinguish native Linux Clone Hero from a Windows game running in Wine: their MelonLoader installations differ.'],
        ['Choose the official files', 'Release 0.7.3 offers MelonLoader.Installer.Linux and MelonLoader.Linux.x64.zip for native Linux. Choose files matching your game and read the official prerequisites. ChartsHub does not download or launch that installer.'],
        ['Follow the Linux or Wine guide', 'The official guide describes .so libraries and LD_LIBRARY_PATH / LD_PRELOAD for native Linux. For Wine, it describes the Windows loader, its .NET prerequisites in the same prefix and the version=n,b override. These steps do not validate Quick Import on Wine.'],
        ['Continue without Quick Import', 'The current module checks Windows x64-specific files and entry points. Quick Import commands remain unavailable on Linux; download charts normally, then run Scan Songs in Clone Hero.'],
      ],
    },
    darwin: {
      intro: 'MelonLoader 0.7.3 offers macOS files. ChartsHub Quick Import is not validated on macOS; do not use the ChartsHub Windows scripts.',
      steps: [
        ['Prepare a game backup', 'Close the game and keep a backup. Check your game architecture; a macOS loader does not prove Clone Hero compatibility.'],
        ['Choose the official download', 'Release 0.7.3 offers MelonLoader.Installer.MacOS.dmg and MelonLoader.macOS.x64.zip. It has no macOS arm64 archive; Quick Import compatibility with Apple Silicon or Rosetta is not validated.'],
        ['Follow the official macOS installer', 'The official MelonLoader Installer help explains choosing a Steam game or adding a game manually, then selecting the loader version. Select 0.7.3 and follow those instructions for your game. ChartsHub does not modify or launch the game or installer.'],
        ['Continue without Quick Import', 'The current ChartsHub module is Windows x64-specific. Quick Import commands remain unavailable on macOS; normal downloading and Scan Songs in Clone Hero remain available.'],
      ],
    },
    unknown: { intro: 'This system is not recognised for Quick Import. Read the official MelonLoader release and prerequisites; no ChartsHub setup script is offered for this system.', steps: [['Use the available features', 'Download charts normally, then use Scan Songs in Clone Hero. Choosing another guide here does not make the module compatible with your system.']] },
  },
};
const platformName = value => ['win32', 'linux', 'darwin'].includes(value) ? value : 'unknown';
const GUIDED_INSTALL = 'powershell.exe -NoProfile -STA -File .\\Install-QuickImport.ps1 -Guided -Language ';
const ACTIONS = ['chooseGame', 'connect', 'disable', 'refresh'];
const HELP_ACTIONS = Object.freeze({
  setup: 'quickImport.setup', openPackage: 'quickImport.openPackage', prerequisites: 'quickImport.prerequisites', release: 'quickImport.release',
  hideConsole: 'quickImport.console', showConsole: 'quickImport.console',
});
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
    this.helpPending = new Set(); this.helpError = false; this.helpNotice = null; this.helpLanguage = null; this.guideSelection = null;
    const document = root.ownerDocument;
    const make = (tag, className = '') => { const node = document.createElement(tag); node.className = className; return node; };
    const title = make('h3'), compatibility = make('p', 'quick-import-compatibility'), optional = make('p', 'helper-text');
    const intro = make('p', 'helper-text'), steps = make('ol', 'quick-import-steps');
    const installation = make('section', 'quick-import-installation'); installation.id = 'quick-import-installation-guide';
    const installTitle = make('h4'), installIntro = make('p', 'helper-text'), installSteps = make('ol');
    installTitle.id = 'quick-import-installation-title'; installation.setAttribute('aria-labelledby', installTitle.id);
    const guideLabel = make('label', 'quick-import-guide-label'), guideSystem = make('select'), detected = make('p', 'helper-text'), guideOnly = make('p', 'helper-text');
    guideSystem.id = 'quick-import-guide-system'; guideLabel.htmlFor = guideSystem.id;
    for (const value of ['win32', 'linux', 'darwin', 'unknown']) { const option = make('option'); option.value = value; guideSystem.append(option); }
    const guideListener = () => { this.guideSelection = platformName(guideSystem.value); this.signature = null; this.update(this.snapshot); };
    guideSystem.addEventListener('change', guideListener); this.listeners.push([guideSystem, guideListener, 'change']);
    const helpActions = make('div', 'quick-import-actions'), setup = make('button', 'button primary'), openPackage = make('button', 'button secondary'), prerequisites = make('button', 'button secondary'), release = make('button', 'button secondary');
    const consoleActions = make('div', 'quick-import-actions'), hideConsole = make('button', 'button secondary'), showConsole = make('button', 'button secondary');
    for (const [button, action] of [[setup, 'setup'], [openPackage, 'openPackage'], [prerequisites, 'prerequisites'], [release, 'release'], [hideConsole, 'hideConsole'], [showConsole, 'showConsole']]) {
      button.type = 'button'; button.id = action === 'openPackage' ? 'quick-import-open-package' : 'quick-import-' + action;
      const listener = () => { void this.openHelp(action); }; button.addEventListener('click', listener); this.listeners.push([button, listener]);
      (action.endsWith('Console') ? consoleActions : helpActions).append(button);
    }
    const installExample = make('p', 'helper-text'), installCommand = make('pre', 'quick-import-install-command');
    const installShared = make('p', 'helper-text'), installRemoval = make('p', 'helper-text'), installFeedback = make('p', 'quick-import-feedback');
    const installNotice = make('p', 'helper-text');
    installFeedback.setAttribute('role', 'alert'); installFeedback.hidden = true;
    installNotice.setAttribute('role', 'status'); installNotice.hidden = true;
    installation.append(installTitle, detected, guideLabel, guideSystem, guideOnly, installIntro, helpActions, installSteps, installExample, installCommand, installShared, installRemoval, consoleActions, installFeedback, installNotice);
    const status = make('p', 'quick-import-status'); status.id = 'quick-import-status'; status.setAttribute('role', 'status');
    const feedback = make('p', 'quick-import-feedback'); feedback.id = 'quick-import-feedback'; feedback.setAttribute('role', 'alert'); feedback.hidden = true;
    const actions = make('div', 'quick-import-actions'), jobs = make('ul', 'quick-import-jobs');
    const empty = make('p', 'helper-text'), scope = make('p', 'helper-text');
    this.nodes = { title, compatibility, optional, intro, installation, installTitle, installIntro, installSteps, installExample, installCommand, installShared, installRemoval, installFeedback, installNotice, setup, openPackage, prerequisites, release, consoleActions, hideConsole, showConsole, guideLabel, guideSystem, detected, guideOnly, steps, status, feedback, actions, jobs, empty, scope };
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
    const detectedPlatform = platformName(state.platform), guidePlatform = this.guideSelection ?? detectedPlatform;
    const windows = detectedPlatform === 'win32';
    const hasRoot = typeof snapshot?.library?.settings?.rootPath === 'string' && snapshot.library.settings.rootPath.length > 0;
    const signature = JSON.stringify([state, language, guidePlatform, hasRoot, this.pending, this.localError, [...this.helpPending].sort(), this.helpError, this.helpNotice]);
    if (signature === this.signature) return;
    this.signature = signature;
    const t = TEXT[language], n = this.nodes, busy = this.pending || state.busy === true;
    n.title.textContent = t.title; n.compatibility.textContent = t.compatibility; n.optional.textContent = t.optional;
    n.intro.textContent = t.intro; n.scope.textContent = t.scope;
    const guideSignature = [language, guidePlatform, detectedPlatform].join(':');
    if (this.helpLanguage !== guideSignature) {
      this.helpLanguage = guideSignature;
      const guide = guidePlatform === 'win32' ? { intro: t.installIntro, steps: t.installSteps } : PLATFORM_GUIDES[language][guidePlatform];
      for (const name of ['installTitle', 'installExample', 'installShared', 'installRemoval', 'setup', 'openPackage', 'prerequisites', 'release', 'hideConsole', 'showConsole', 'guideLabel', 'guideOnly']) n[name].textContent = t[name];
      n.guideLabel.textContent = t.guideLabel; n.detected.textContent = t.detected + t.systems[detectedPlatform];
      n.prerequisites.textContent = t.prerequisites + ' · ' + t.systems[detectedPlatform];
      for (const option of n.guideSystem.children) option.textContent = t.systems[option.value];
      n.guideSystem.value = guidePlatform; n.installIntro.textContent = guide.intro;
      n.installCommand.textContent = windows && guidePlatform === 'win32' ? GUIDED_INSTALL + language : '';
      n.installSteps.replaceChildren(...guide.steps.map(([label, detail]) => {
        const row = this.root.ownerDocument.createElement('li'), heading = this.root.ownerDocument.createElement('strong'), description = this.root.ownerDocument.createElement('p');
        heading.textContent = label; description.textContent = detail; row.append(heading, description); return row;
      }));
    }
    const windowsGuide = guidePlatform === 'win32';
    for (const name of ['installExample', 'installCommand', 'installShared', 'installRemoval']) n[name].hidden = !windows || !windowsGuide;
    n.setup.hidden = n.openPackage.hidden = n.consoleActions.hidden = !windows || !windowsGuide;
    const consoleBusy = this.helpPending.has('hideConsole') || this.helpPending.has('showConsole');
    n.setup.disabled = !windows || !windowsGuide || busy || consoleBusy || this.helpPending.has('setup');
    n.hideConsole.disabled = n.showConsole.disabled = !windows || !windowsGuide || !state.selected || busy || consoleBusy || this.helpPending.has('setup');
    n.openPackage.disabled = !windows || !windowsGuide || this.helpPending.has('openPackage');
    n.prerequisites.disabled = this.helpPending.has('prerequisites'); n.release.disabled = this.helpPending.has('release');
    n.installFeedback.hidden = !this.helpError; n.installFeedback.textContent = this.helpError ? t[this.helpError] : '';
    n.installNotice.hidden = !this.helpNotice; n.installNotice.textContent = this.helpNotice ? t[this.helpNotice] : '';
    const steps = t.steps.map(([label, description]) => {
      const row = this.root.ownerDocument.createElement('li');
      const heading = this.root.ownerDocument.createElement('strong'), detail = this.root.ownerDocument.createElement('p');
      heading.textContent = label; detail.textContent = description; row.append(heading, detail); return row;
    });
    n.steps.replaceChildren(...steps);
    n.chooseGame.textContent = t.choose; n.connect.textContent = t.connect;
    n.disable.textContent = t.disable; n.refresh.textContent = t.refresh;
    n.steps.hidden = !windows || !windowsGuide; n.actions.hidden = !windows || !windowsGuide;
    n.status.textContent = !windows ? t.unsupported : !state.supported ? t.unavailable : busy ? t.busy : !state.selected ? t.noGame : !hasRoot ? t.noRoot
      : state.connected ? t.connected : t.selected + (typeof state.gameName === 'string' ? state.gameName : '') + ' · ' + t.disconnected;
    const readonly = state.savedCanWrite === false;
    n.chooseGame.disabled = !windows || !windowsGuide || !state.supported || busy || readonly;
    n.connect.disabled = !windows || !windowsGuide || !state.supported || busy || readonly || !state.selected || !hasRoot || state.connected === true;
    n.disable.disabled = !windows || !windowsGuide || !(state.connected || state.enabled || busy);
    const jobs = Array.isArray(state.jobs) ? state.jobs.slice(-32) : [];
    n.refresh.disabled = !windows || !windowsGuide || !state.connected || busy || jobs.length === 0;
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
    if (this.disposed || !Object.hasOwn(HELP_ACTIONS, action) || this.helpPending.has(action) || this.nodes[action].disabled) return;
    const consoleAction = action.endsWith('Console');
    const errorKey = consoleAction ? 'consoleError' : action === 'setup' ? 'setupError' : 'installError';
    this.helpPending.add(action); this.helpError = false; this.helpNotice = null; this.signature = null; this.update(this.snapshot);
    try {
      const result = await this.command(HELP_ACTIONS[action], consoleAction ? { hidden: action === 'hideConsole' } : {});
      if (!this.disposed) {
        this.helpError = result?.ok === true ? false : errorKey;
        if (result?.ok === true && consoleAction) this.helpNotice = action + 'Done';
      }
    } catch { if (!this.disposed) this.helpError = errorKey; }
    finally {
      if (!this.disposed) { this.helpPending.delete(action); this.signature = null; this.update(this.snapshot); }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.commandEpoch++;
    for (const [button, listener, event = 'click'] of this.listeners) button.removeEventListener(event, listener);
    this.listeners = [];
  }
}
