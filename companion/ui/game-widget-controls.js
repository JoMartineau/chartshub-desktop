const COPY = {
  fr: {
    heading: 'Intégrations Clone Hero · BÊTA', title: 'Paroles synchronisées et Accuracy',
    intro: 'Une seule installation de MelonLoader, avec un module pour Quick Import et un module pour ces widgets. Chaque option reste indépendante.',
    compatibility: 'Clone Hero 1.1.0.6142-final Stable · Windows x64 uniquement. Autres versions non validées.',
    accuracy: 'Recevoir Accuracy', lyrics: 'Synchroniser les paroles', apply: 'Appliquer les choix',
    off: 'Désactivé · aucune mesure reçue', waiting: 'En attente du connecteur dans Clone Hero', connecting: 'Connexion au jeu…', connected: 'Connecté au jeu',
    stale: 'Connexion interrompue · les données anciennes sont masquées', unavailable: 'Version du jeu ou système non pris en charge', error: 'Connexion indisponible · vérifiez le module et le jeu',
    note: 'Ces deux options sont désactivées à chaque ouverture de ChartsHub. Vos positions, tailles et couleurs de widgets sont conservées.',
    display: 'Configurer les widgets dans Stream / OBS', package: 'Ouvrir le module et son guide', requirements: 'Prérequis officiels',
    help: 'Installation et aide', steps: [
      'Fermez Clone Hero et son lanceur, puis utilisez le guide du module. Une installation MelonLoader compatible déjà présente est conservée.',
      'Ouvrez ensuite Clone Hero, cochez les fonctions voulues ici et appliquez vos choix. Aucune partie ne démarre depuis ChartsHub.',
      'Dans Stream / OBS, choisissez où afficher les widgets, puis réglez leur position, leur texte et leurs couleurs comme les autres widgets.'
    ],
    lyricsNote: 'Les paroles proviennent de la chart dans votre bibliothèque Songs et suivent l’horloge du jeu. Une chart sans paroles ou une version ambiguë ne donne pas de texte inventé.',
    accuracyNote: 'Accuracy affiche les écarts de frappe en millisecondes. Ces mesures ne calculent pas un réglage de calibration.',
    feedback: 'L’action n’a pas pu être terminée. Actualisez l’état et vérifiez le guide.', staleChoice: 'Les choix ont changé. Vérifiez les cases puis appliquez à nouveau.',
    check: 'Vérifier l’installation', diagnostic: 'Vérification avant installation', unchecked: 'Aucune vérification effectuée. Choisissez Clone Hero ci-dessus, puis lancez la vérification.',
  },
  en: {
    heading: 'Clone Hero integrations · BETA', title: 'Synced lyrics and Accuracy',
    intro: 'One MelonLoader installation, with one module for Quick Import and one for these widgets. Each option remains independent.',
    compatibility: 'Clone Hero 1.1.0.6142-final Stable · Windows x64 only. Other versions are not validated.',
    accuracy: 'Receive Accuracy', lyrics: 'Sync lyrics', apply: 'Apply choices',
    off: 'Off · no measurements received', waiting: 'Waiting for the connector in Clone Hero', connecting: 'Connecting to the game…', connected: 'Connected to the game',
    stale: 'Connection interrupted · old data is hidden', unavailable: 'Unsupported game build or operating system', error: 'Connection unavailable · check the module and game',
    note: 'Both options are off every time ChartsHub opens. Your widget positions, sizes and colors are preserved.',
    display: 'Configure widgets in Stream / OBS', package: 'Open the module and guide', requirements: 'Official prerequisites',
    help: 'Setup and help', steps: [
      'Close Clone Hero and its launcher, then follow the module guide. A compatible MelonLoader installation already present is preserved.',
      'Then open Clone Hero, select the functions you want here and apply your choices. ChartsHub does not start a game.',
      'In Stream / OBS, choose where to display the widgets, then adjust their position, text and colors like other widgets.'
    ],
    lyricsNote: 'Lyrics come from the chart in your Songs library and follow the game clock. A chart without lyrics or an ambiguous version does not produce invented text.',
    accuracyNote: 'Accuracy shows hit timing offsets in milliseconds. These measurements do not calculate a calibration setting.',
    feedback: 'The action could not finish. Refresh the state and check the guide.', staleChoice: 'The choices changed. Review the checkboxes and apply again.',
    check: 'Check installation', diagnostic: 'Pre-installation check', unchecked: 'No check performed. Choose Clone Hero above, then run the check.',
  },
};
const CHECK_MESSAGES = {
  REVIEWED_GAME_X64: ['Version du jeu reconnue et compatible.', 'Recognized, compatible game build.'],
  GAME_FOLDER_INVALID: ['Choisissez le dossier qui contient Clone Hero.exe.', 'Choose the folder containing Clone Hero.exe.'],
  GAME_FOLDER_MISSING: ['Le dossier du jeu est introuvable. Choisissez-le à nouveau.', 'Game folder not found. Choose it again.'],
  GAME_NOT_X64: ['Ce module nécessite la version Windows 64 bits du jeu.', 'This module requires the Windows 64-bit game.'],
  UNSUPPORTED_GAME_BUILD: ['Cette version du jeu n’est pas validée. Installation interrompue.', 'This game build is not validated. Setup is stopped.'],
  GAME_AND_LAUNCHER_CLOSED: ['Le jeu et son lanceur sont fermés.', 'The game and its launcher are closed.'],
  GAME_RUNNING: ['Fermez Clone Hero et son lanceur avant l’installation.', 'Close Clone Hero and its launcher before setup.'],
  PROCESS_CHECK_FAILED: ['La fermeture du jeu n’a pas pu être confirmée.', 'Could not confirm that the game is closed.'],
  SHARED_LOADER_MISSING: ['MelonLoader est absent ou incomplet. Consultez le guide avant de poursuivre.', 'MelonLoader is missing or incomplete. Check the guide before continuing.'],
  SHARED_LOADER_DIFFERENT: ['Une autre installation MelonLoader est présente. Aucun fichier ne sera remplacé.', 'A different MelonLoader installation is present. Its files will be preserved.'],
  SHARED_LOADER_VERIFIED: ['MelonLoader 0.7.3 reconnu. Il sera partagé avec les autres modules.', 'MelonLoader 0.7.3 recognized. It will be shared with the other modules.'],
  MODULE_ALREADY_EXISTS: ['Un module différent est déjà présent. Vérifiez son origine avant de modifier l’installation.', 'A different module is already present. Verify its origin before changing setup.'],
  MODULE_NOT_INSTALLED: ['Le module des widgets peut être préparé depuis son guide.', 'The widget module can be prepared using its guide.'],
  MODULE_VERIFIED: ['Le module des widgets est installé et vérifié.', 'The widget module is installed and verified.'],
  RECEIPT_ALREADY_EXISTS: ['Une installation est déjà enregistrée. Utilisez son retrait prévu avant une réinstallation.', 'An installation is already recorded. Use its provided removal step before reinstalling.'],
  INSTALLATION_RECEIPT_MISSING: ['Le module est reconnu, mais son reçu de retrait est absent.', 'The module is recognized, but its removal receipt is missing.'],
  DOTNET6_DESKTOP_PRESENT: ['.NET 6 Desktop Runtime est présent.', '.NET 6 Desktop Runtime is present.'],
  DOTNET6_DESKTOP_NOT_FOUND: ['.NET 6 Desktop Runtime n’a pas été repéré. Consultez les prérequis officiels.', '.NET 6 Desktop Runtime was not found. Check the official prerequisites.'],
  DOTNET6_DESKTOP_UNKNOWN: ['Les prérequis .NET restent à vérifier.', 'The .NET prerequisites still need checking.'],
  WRITE_ACCESS_NOT_PROVEN: ['L’accès en écriture sera confirmé au moment de l’installation.', 'Write access will be confirmed during setup.'],
  WRITE_PERMISSION_MAY_BE_DENIED: ['Windows peut refuser l’écriture dans ce dossier. Vérifiez son accès avant l’installation.', 'Windows may deny writes to this folder. Check folder access before setup.'],
  DISK_SPACE_AVAILABLE: ['L’espace disponible contrôlé est suffisant pour le module.', 'Checked free space is sufficient for the module.'],
  LOW_DISK_SPACE: ['Libérez de l’espace sur le disque du jeu avant l’installation.', 'Free space on the game drive before setup.'],
  DISK_SPACE_UNKNOWN: ['L’espace disponible n’a pas pu être confirmé.', 'Available disk space could not be confirmed.'],
  PACKAGE_INVALID: ['Le paquet des widgets est incomplet ou différent. Récupérez la version officielle.', 'The widget package is incomplete or different. Get the official version.'],
  LINKED_PATH: ['Ce dossier redirige vers un autre emplacement. Utilisez une installation locale vérifiée.', 'This folder redirects elsewhere. Use a verified local installation.'],
  HARDLINK_FILE: ['Un fichier partagé avec un autre emplacement empêche une installation sûre.', 'A file shared with another location prevents safe setup.'],
  FILE_CHANGED: ['Un fichier a changé pendant la vérification. Recommencez une fois le jeu fermé.', 'A file changed during the check. Retry after closing the game.'],
  READ_PERMISSION_DENIED: ['Certains fichiers sont illisibles. Vérifiez les autorisations du dossier.', 'Some files cannot be read. Check folder permissions.'],
  CHECK_TIMED_OUT: ['La vérification a dépassé son délai. Réessayez lorsque le disque est disponible.', 'The check timed out. Retry when the drive is available.'],
};
export class GameWidgetControls {
  constructor({root, command, navigate}) {
    this.root=root;this.command=command;this.navigate=navigate;this.snapshot=null;this.pending=false;this.actionPending=new Set();this.dirty=false;this.disposed=false;this.error=null;this.key=null;this.listeners=[];
    const doc=root.ownerDocument, make=(tag,className='')=>{const n=doc.createElement(tag);n.className=className;return n;};
    const title=make('h3'),intro=make('p','helper-text'),compatibility=make('p','quick-import-compatibility'),note=make('p','helper-text');
    const choices=make('div','game-widget-choices'),accuracyLabel=make('label'),lyricsLabel=make('label'),accuracy=make('input'),lyrics=make('input'),accuracyText=make('span'),lyricsText=make('span');
    accuracy.type=lyrics.type='checkbox';accuracy.id='game-widgets-accuracy';lyrics.id='game-widgets-lyrics';accuracyLabel.append(accuracy,accuracyText);lyricsLabel.append(lyrics,lyricsText);choices.append(accuracyLabel,lyricsLabel);
    const actions=make('div','quick-import-actions'),apply=make('button','button primary'),display=make('button','button secondary'),openPackage=make('button','button secondary');
    apply.id='game-widgets-apply';openPackage.id='game-widgets-open-package';for(const b of [apply,display,openPackage]){b.type='button';actions.append(b);}
    const status=make('p','quick-import-status'),feedback=make('p','quick-import-feedback');status.id='game-widgets-status';status.setAttribute('role','status');feedback.setAttribute('role','alert');feedback.hidden=true;
    const details=make('details','game-widget-help'),summary=make('summary'),steps=make('ol'),lyricsNote=make('p','helper-text'),accuracyNote=make('p','helper-text'),requirements=make('button','button secondary');requirements.type='button';details.append(summary,steps,lyricsNote,accuracyNote,requirements);
    const diagnostics=make('details','game-widget-help'),diagnosticTitle=make('summary'),check=make('button','button secondary'),diagnosticStatus=make('p','helper-text'),report=make('ul','game-mod-checks');check.type='button';check.id='game-widgets-check';diagnostics.append(diagnosticTitle,diagnosticStatus,check,report);
    this.nodes={title,intro,compatibility,note,accuracy,lyrics,accuracyText,lyricsText,apply,display,openPackage,status,feedback,summary,steps,lyricsNote,accuracyNote,requirements,diagnosticTitle,check,diagnosticStatus,report};
    const listen=(node,event,listener)=>{node.addEventListener(event,listener);this.listeners.push([node,event,listener]);};
    for(const input of [accuracy,lyrics])listen(input,'change',()=>{this.dirty=true;this.key=null;this.update(this.snapshot);});
    listen(apply,'click',()=>void this.run('gameWidgets.configure'));
    listen(openPackage,'click',()=>void this.run('gameWidgets.openPackage'));
    listen(requirements,'click',()=>void this.run('gameWidgets.prerequisites'));
    listen(check,'click',()=>void this.run('gameWidgets.check'));
    listen(display,'click',()=>this.navigate?.());
    root.replaceChildren(title,intro,compatibility,choices,actions,status,feedback,note,diagnostics,details);
    this.update(null);
  }
  update(snapshot) {
    if(this.disposed)return;this.snapshot=snapshot;const language=snapshot?.language==='en'?'en':'fr',t=COPY[language],state=snapshot?.gameWidgets,diagnostic=snapshot?.gameModPreflight;
    this.root.hidden=!state;
    const key=JSON.stringify([language,state,diagnostic,this.pending,[...this.actionPending],this.dirty,this.error]);if(key===this.key)return;this.key=key;
    const n=this.nodes,heading=this.root.ownerDocument.querySelector('#game-integrations-title');if(heading)heading.textContent=t.heading;
    for(const name of ['title','intro','compatibility','note','lyricsNote','accuracyNote'])n[name].textContent=t[name];
    n.accuracyText.textContent=t.accuracy;n.lyricsText.textContent=t.lyrics;n.apply.textContent=t.apply;n.display.textContent=t.display;n.openPackage.textContent=t.package;n.requirements.textContent=t.requirements;n.summary.textContent=t.help;
    if(!this.dirty&&!this.pending){n.accuracy.checked=state?.accuracy===true;n.lyrics.checked=state?.lyrics===true;}
    const disabled=this.pending||state?.busy===true||state?.supported!==true;
    n.accuracy.disabled=n.lyrics.disabled=disabled;n.apply.disabled=disabled||!this.dirty;n.openPackage.disabled=this.actionPending.has('gameWidgets.openPackage');n.display.disabled=!state;n.requirements.disabled=this.actionPending.has('gameWidgets.prerequisites');
    const phase=state?.status;n.status.textContent=!state?.enabled?t.off:state.connected?t.connected:phase==='stale'?t.stale:phase==='unsupported'?t.unavailable:phase==='error'?t.error:phase==='connecting'?t.connecting:t.waiting;
    if(state&&state.supported===false)n.status.textContent=t.unavailable;
    n.feedback.hidden=!this.error;n.feedback.textContent=this.error==='GAME_WIDGETS_STALE'?t.staleChoice:this.error?t.feedback:'';
    n.steps.replaceChildren(...t.steps.map(text=>{const li=this.root.ownerDocument.createElement('li');li.textContent=text;return li;}));
    n.diagnosticTitle.textContent=t.diagnostic;n.check.textContent=t.check;n.check.disabled=this.actionPending.has('gameWidgets.check')||diagnostic?.busy===true||!diagnostic?.supported;
    n.diagnosticStatus.textContent=diagnostic?.checked?(diagnostic.compatible===true?(language==='fr'?'Version du jeu reconnue. Consultez les vérifications ci-dessous.':'Recognized game build. Review the checks below.'):(language==='fr'?'Vérification terminée. Certains points demandent une intervention.':'Check completed. Some items need attention.')):t.unchecked;
    n.report.replaceChildren(...(diagnostic?.checks??[]).slice(0,12).map(item=>{const li=this.root.ownerDocument.createElement('li');li.textContent=this.checkText(item,language);li.dataset.level=['ok','warning','error'].includes(item.level)?item.level:'warning';return li;}));
  }
  checkText(item,language) {
    if(Object.hasOwn(CHECK_MESSAGES,item.code))return CHECK_MESSAGES[item.code][language==='fr'?0:1];
    const names=language==='fr'?{game:'Jeu',build:'Compatibilité',architecture:'Architecture',process:'Jeu et lanceur',loader:'MelonLoader',module:'Module des widgets',runtime:'.NET Desktop Runtime',permissions:'Accès au dossier',space:'Espace disponible',integrity:'Intégrité des fichiers'}:{game:'Game',build:'Compatibility',architecture:'Architecture',process:'Game and launcher',loader:'MelonLoader',module:'Widget module',runtime:'.NET Desktop Runtime',permissions:'Folder access',space:'Free space',integrity:'File integrity'};
    const state=item.level==='ok'?(language==='fr'?'vérifié':'verified'):item.level==='error'?(language==='fr'?'à corriger avant installation':'needs attention before setup'):(language==='fr'?'à vérifier':'check required');
    return (names[item.id]??(language==='fr'?'Vérification':'Check'))+' : '+state;
  }
  async run(action) {
    if(!['gameWidgets.configure','gameWidgets.check','gameWidgets.openPackage','gameWidgets.prerequisites'].includes(action)||this.actionPending.has(action)||this.disposed||!this.snapshot?.gameWidgets)return;const state=this.snapshot.gameWidgets;
    const payload=action==='gameWidgets.configure'?{revision:state.revision,accuracy:this.nodes.accuracy.checked,lyrics:this.nodes.lyrics.checked}:action==='gameWidgets.check'?{revision:this.snapshot.gameModPreflight?.revision}:{};
    this.actionPending.add(action);if(action==='gameWidgets.configure')this.pending=true;this.error=null;this.key=null;this.update(this.snapshot);
    try {const result=await this.command(action,payload);if(this.disposed)return;if(!result?.ok)this.error=result?.code??'GAME_WIDGETS_FAILED';else if(action==='gameWidgets.configure')this.dirty=false;}
    catch {if(!this.disposed)this.error='GAME_WIDGETS_FAILED';}
    finally {this.actionPending.delete(action);if(action==='gameWidgets.configure')this.pending=false;this.key=null;if(!this.disposed)this.update(this.snapshot);}
  }
  dispose(){this.disposed=true;for(const[n,e,f]of this.listeners)n.removeEventListener(e,f);this.listeners=[];}
}
