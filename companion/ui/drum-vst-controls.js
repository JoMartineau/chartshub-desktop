import { languageCode, localizedPair } from './locale-text.js';
const PADS = [
  ['kick', 'Grosse caisse', 'Kick'], ['snare', 'Caisse claire', 'Snare'],
  ['hat', 'Charleston fermé', 'Closed hi-hat'], ['hat-open', 'Charleston ouvert', 'Open hi-hat'],
  ['tom-high', 'Tom aigu', 'High tom'], ['tom-mid', 'Tom médium', 'Mid tom'],
  ['tom-low', 'Tom grave', 'Low tom'], ['crash', 'Crash', 'Crash'], ['ride', 'Ride', 'Ride']
];
const copy = value => JSON.parse(JSON.stringify(value));
const numeric = value => value !== '' && Number.isFinite(Number(value)) ? Number(value) : NaN;
const ERRORS = {
  DRUM_HELPER_UNAVAILABLE: ['Le moteur audio n’est pas disponible dans cette installation.', 'The audio engine is unavailable in this installation.'],
  DRUM_UNAVAILABLE: ['Le module batterie est indisponible.', 'The drum module is unavailable.'],
  DRUM_PLUGIN_INVALID: ['Cet instrument VST3 n’a pas pu être chargé. Vérifiez son installation et sa version 64 bits.', 'This VST3 instrument could not be loaded. Check its installation and 64-bit version.'],
  DRUM_PLUGIN_REQUIRED: ['Choisissez d’abord un instrument VST3.', 'Choose a VST3 instrument first.'],
  DRUM_MIDI_REQUIRED: ['Choisissez le périphérique MIDI, puis appliquez les réglages.', 'Select the MIDI device, then apply settings.'],
  DRUM_STALE_REVISION: ['Les réglages enregistrés ont changé. Rechargez-les avant de réessayer.', 'Saved settings changed. Reload them before trying again.'],
  DRUM_BUSY: ['Une action est en cours. Attendez sa fin.', 'An action is in progress. Wait for it to finish.'],
  DRUM_CANCELLED: ['Action annulée.', 'Action cancelled.'],
  DRUM_NOT_RUNNING: ['Démarrez l’audio avant de tester un pad.', 'Start audio before testing a pad.'],
  DRUM_PREFERENCES: ['Les réglages n’ont pas pu être enregistrés. Réessayez après avoir vérifié l’accès au dossier de données.', 'Settings could not be saved. Check access to the data folder and try again.'],
  DRUM_TIMEOUT: ['L’instrument ou le moteur audio ne répond pas. Arrêtez l’audio, puis réessayez.', 'The instrument or audio engine is not responding. Stop audio, then try again.'],
  DRUM_HOST_EXITED: ['Le moteur audio s’est fermé. Vérifiez l’instrument, puis redémarrez explicitement.', 'The audio engine closed. Check the instrument, then explicitly restart.'],
  DRUM_PROTOCOL: ['La connexion au moteur audio a été interrompue.', 'The connection to the audio engine was interrupted.'],
  DRUM_AUDIO_DISCONNECTED: ['La sortie audio a été débranchée. Rebranchez-la ou choisissez une autre sortie avant de redémarrer.', 'The audio output disconnected. Reconnect it or choose another output before restarting.'],
  DRUM_MIDI_BUSY: ['Cette entrée MIDI est déjà utilisée ou indisponible. Libérez-la dans l’autre application, puis réessayez.', 'This MIDI input is busy or unavailable. Release it in the other application, then try again.'],
  DRUM_CONTROLLER_DISCONNECTED: ['La manette ou la batterie XInput a été débranchée. Rebranchez-la, actualisez les périphériques et redémarrez.', 'The XInput controller or drum kit disconnected. Reconnect it, refresh devices and restart.'],
  DRUM_EDITOR_UNAVAILABLE: ['Cet instrument ne propose pas de fenêtre compatible.', 'This instrument does not provide a compatible editor window.'],
  DRUM_MT_CONSENT: ['Consultez la licence et donnez votre accord avant de préparer MT Power Drum Kit.', 'Read the licence and give consent before preparing MT Power Drum Kit.'],
  DRUM_MT_DOWNLOAD: ['Le téléchargement officiel n’a pas pu être vérifié. Réessayez plus tard.', 'The official download could not be verified. Try again later.'],
  DRUM_MT_ARCHIVE: ['Le paquet MT Power Drum Kit est incomplet ou incompatible. Aucun instrument n’a été installé.', 'The MT Power Drum Kit package is incomplete or incompatible. No instrument was installed.'],
  DRUM_MT_STORAGE: ['L’instrument n’a pas pu être préparé dans le dossier privé de ChartsHub.', 'The instrument could not be prepared in ChartsHub’s private folder.'],
  DRUM_MT_CANCELLED: ['Préparation annulée.', 'Preparation cancelled.'],
  DRUM_MT_TIMEOUT: ['Le téléchargement a pris trop de temps. Réessayez.', 'The download took too long. Try again.'],
  DRUM_MT_BUSY: ['La préparation de MT Power Drum Kit est déjà en cours.', 'MT Power Drum Kit preparation is already in progress.'],
  DRUM_MT_UNAVAILABLE: ['La préparation de MT Power Drum Kit est indisponible.', 'MT Power Drum Kit preparation is unavailable.'],
  DRUM_NATIVE_ERROR: ['Le moteur audio a rencontré une erreur. Vérifiez la sortie et l’instrument.', 'The audio engine encountered an error. Check the output and instrument.'],
  DRUM_COMMAND: ['Cette action batterie est indisponible.', 'This drum action is unavailable.']
};

/** This panel only sends explicit, bounded actions. Snapshot updates never
 * enumerate hardware, load a plug-in, start input reading or play a sound. */
export class DrumVstControls {
  constructor({ root, command }) {
    this.root = root; this.command = command; this.snapshot = null; this.draft = null; this.baseRevision = null;
    this.dirty = false; this.busy = false; this.pending = 0; this.disposed = false; this.abort = new AbortController();
    this.renderSignature = null; this.liveSignature = null;
    this.labels = []; this.optionLabels = new Map(); this.fields = []; this.buttons = []; this.padRows = [];
    this.heading = this.make('h3'); this.text(this.heading, 'Batterie / VST', 'Drums / VST');
    this.intro = this.make('p'); this.intro.className = 'helper-text';
    this.text(this.intro, 'Choisissez votre instrument, votre sortie audio et votre batterie, puis démarrez. Aucun son ni périphérique ne démarre automatiquement.', 'Choose your instrument, audio output and drum input, then start. Sound and device reading never start automatically.');
    this.status = this.make('p'); this.status.id = 'drums-status'; this.status.setAttribute('role', 'status');
    this.lockHint = this.make('p'); this.lockHint.id = 'drums-lock-help'; this.lockHint.className = 'helper-text'; this.lockHint.setAttribute('role', 'status');
    this.plugin = this.make('p'); this.plugin.id = 'drums-plugin';
    const pluginActions = this.make('div'); pluginActions.className = 'button-row';
    this.chooseButton = this.button(pluginActions, 'drums-choose-plugin', '1. Choisir un instrument VST3', '1. Choose a VST3 instrument', () => this.perform('drums.choosePlugin'));
    this.editorButton = this.button(pluginActions, 'drums-editor', 'Ouvrir l’instrument', 'Open instrument', () => this.perform('drums.editor', { open: true }));
    this.mtButton = this.button(pluginActions, 'drums-mt-page', 'Obtenir MT Power Drum Kit', 'Get MT Power Drum Kit', () => this.perform('drums.openMtPage'));
    const pluginHelp = this.make('p'); pluginHelp.className = 'helper-text';
    this.text(pluginHelp, 'Choisissez un instrument VST3 64 bits déjà installé ou préparez MT Power Drum Kit ci-dessous. Aucun fichier de Clone Hero n’est modifié.', 'Choose an installed 64-bit VST3 instrument or prepare MT Power Drum Kit below. No Clone Hero files are modified.');
    const mtStartHelp = this.make('p'); mtStartHelp.className = 'helper-text';
    this.text(mtStartHelp, 'MT Power Drum Kit gratuit : à chaque session, activez ses sons dans sa propre fenêtre. Son bouton START est différent de Démarrer l’audio dans ChartsHub.', 'Free MT Power Drum Kit: enable its sounds in its own window at the beginning of each session. Its START button is separate from Start audio in ChartsHub.');
    this.mtStartGuide = this.make('ol'); this.mtStartGuide.id = 'drums-mt-start-steps'; this.mtStartGuide.className = 'helper-text';
    this.text(this.make('li', this.mtStartGuide), 'Dans ChartsHub, cliquez sur Ouvrir l’instrument.', 'In ChartsHub, select Open instrument.');
    this.text(this.make('li', this.mtStartGuide), 'Dans la fenêtre MT Power Drum Kit, cliquez sur START en bas à droite.', 'In the MT Power Drum Kit window, click START in the bottom-right corner.');
    this.text(this.make('li', this.mtStartGuide), 'Revenez dans ChartsHub : cliquez sur Démarrer l’audio, puis sur Tester pour vérifier un pad.', 'Return to ChartsHub: select Start audio, then Test to check a pad.');
    const mtHelp = this.make('p'); mtHelp.className = 'helper-text';
    this.text(mtHelp, 'MT Power Drum Kit 2.1.5.1 : téléchargement officiel d’environ 63 Mo, uniquement après votre accord. L’instrument et ses sons restent dans le dossier privé de ChartsHub ; aucun installateur système ni audio automatique.', 'MT Power Drum Kit 2.1.5.1: official download of about 63 MB, only after your consent. The instrument and its sounds stay in ChartsHub’s private folder; no system installer or automatic audio.');
    this.mtLicenseButton = this.button(root, 'drums-mt-license', 'Consulter la licence MANDA AUDIO', 'Read the MANDA AUDIO licence', () => this.perform('drums.openMtLicense'));
    this.mtConsentLabel = this.make('label'); this.mtConsent = this.make('input', this.mtConsentLabel); this.mtConsent.type = 'checkbox'; this.mtConsent.id = 'drums-mt-consent'; this.mtConsent.checked = false;
    const consentText = this.make('span', this.mtConsentLabel); this.text(consentText, ' J’ai lu et j’accepte la licence MANDA AUDIO pour télécharger et préparer MT Power Drum Kit.', ' I have read and accept the MANDA AUDIO licence to download and prepare MT Power Drum Kit.');
    this.mtConsent.addEventListener('change', () => this.updateState(), { signal: this.abort.signal });
    this.mtInstallButton = this.button(root, 'drums-mt-install', 'Télécharger et préparer MT Power Drum Kit', 'Download and prepare MT Power Drum Kit', () => this.installMt());
    this.mtStatus = this.make('p'); this.mtStatus.id = 'drums-mt-status'; this.mtStatus.className = 'helper-text'; this.mtStatus.setAttribute('role', 'status');

    this.audioHeading = this.make('h4'); this.text(this.audioHeading, '2. Sortie audio et entrée', '2. Audio output and input');
    this.refreshButton = this.button(root, 'drums-refresh-devices', 'Détecter / actualiser les périphériques', 'Detect / refresh devices', () => this.perform('drums.refreshDevices'));
    const grid = this.make('div'); grid.setAttribute('style', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:12px 0');
    this.audio = this.select(grid, 'drums-audio', 'Sortie audio', 'Audio output', [], value => this.edit('audioDeviceId', value));
    this.source = this.select(grid, 'drums-source', 'Entrée de la batterie', 'Drum input', [
      ['midi', 'Batterie MIDI', 'MIDI drum kit'], ['xinput', 'Manette / batterie XInput', 'XInput controller / drums'], ['manual', 'Pads à cliquer', 'On-screen pads']
    ], value => this.edit('source', value));
    this.midi = this.select(grid, 'drums-midi', 'Périphérique MIDI', 'MIDI device', [], value => this.edit('midiDeviceId', numeric(value)));
    this.xinput = this.select(grid, 'drums-xinput', 'Manette XInput', 'XInput controller', [], value => this.edit('xinputIndex', numeric(value)));
    this.sampleRate = this.select(grid, 'drums-sample-rate', 'Fréquence', 'Sample rate', [44100, 48000, 96000].map(value => [String(value), value + ' Hz', value + ' Hz']), value => this.edit('sampleRate', numeric(value)));
    this.blockSize = this.select(grid, 'drums-block-size', 'Tampon audio', 'Audio buffer', [64, 128, 256, 512].map(value => [String(value), value + ' échantillons', value + ' samples']), value => this.edit('blockSize', numeric(value)));
    this.volume = this.number(grid, 'drums-volume', 'Volume (%)', 'Volume (%)', 0, 100, value => this.edit('volume', value / 100));
    this.sourceHelp = this.make('p'); this.sourceHelp.className = 'helper-text';
    const audioHelp = this.make('p'); audioHelp.className = 'helper-text';
    this.text(audioHelp, 'Un petit tampon réduit le délai mais sollicite davantage l’ordinateur. Si le son craque, essayez 256 ou 512 échantillons. Les valeurs disponibles dépendent de la sortie audio.', 'A smaller buffer reduces delay but puts more load on the computer. If audio crackles, try 256 or 512 samples. Available values depend on the audio output.');

    const padsHeading = this.make('h4'); this.text(padsHeading, '3. Pads Tester / XInput', '3. Test / XInput pads');
    const padsHelp = this.make('p'); padsHelp.className = 'helper-text';
    this.text(padsHelp, 'Ces notes et canaux règlent les boutons Tester et les frappes XInput. Les frappes MIDI réelles conservent les valeurs envoyées par la batterie. Les notes initiales suivent General MIDI. Pour XInput, assignez le bouton ou l’axe de chaque pad ; leurs numéros commencent à 0.', 'These notes and channels configure Test buttons and XInput hits. Real MIDI hits retain the values sent by the drum kit. Initial notes follow General MIDI. For XInput, assign each pad’s button or axis; numbering starts at 0.');
    const padList = this.make('div'); padList.id = 'drums-pad-list';
    for (const [id, fr, en] of PADS) this.createPad(padList, id, fr, en);
    this.saveButton = this.button(root, 'drums-save-settings', 'Appliquer les réglages', 'Apply settings', () => this.save());
    this.reloadButton = this.button(root, 'drums-reload-settings', 'Recharger les réglages enregistrés', 'Reload saved settings', () => { this.dirty = false; this.invalidate(); this.update(this.snapshot); });
    this.unsaved = this.make('p'); this.unsaved.className = 'helper-text'; this.unsaved.setAttribute('role', 'status');

    const runHeading = this.make('h4'); this.text(runHeading, '4. Jouer et envoyer le son dans OBS', '4. Play and send audio to OBS');
    const actions = this.make('div'); actions.className = 'button-row';
    this.startButton = this.button(actions, 'drums-start', 'Démarrer l’audio', 'Start audio', () => this.perform('drums.start'));
    this.stopButton = this.button(actions, 'drums-stop', 'Arrêter l’audio', 'Stop audio', () => this.perform('drums.stop'));
    this.panicButton = this.button(actions, 'drums-panic', 'Couper les notes', 'Silence notes', () => this.perform('drums.panic'));
    this.meterLabel = this.make('label'); this.meterLabel.setAttribute('for', 'drums-meter'); this.text(this.meterLabel, 'Niveau de sortie', 'Output level');
    this.meter = this.make('meter'); this.meter.id = 'drums-meter'; this.meter.min = 0; this.meter.max = 1; this.meter.value = 0;
    this.audioFormat = this.make('p'); this.audioFormat.className = 'helper-text';
    this.obs = this.make('p'); this.obs.className = 'helper-text';
    this.text(this.obs, 'Dans OBS, ajoutez une Capture audio d’application et choisissez ChartsHubDrumHost.exe / ChartsHub — Batterie VST. Le lien Navigateur de l’Input Viewer affiche les frappes ; il ne transporte pas le son. Évitez de capturer deux fois la même sortie audio.', 'In OBS, add Application Audio Capture and select ChartsHubDrumHost.exe / ChartsHub — Drums VST. The Input Viewer Browser Source shows hits; it does not carry audio. Avoid capturing the same audio output twice.');
    this.feedback = this.make('p'); this.feedback.id = 'drums-feedback'; this.feedback.className = 'helper-text'; this.feedback.setAttribute('role', 'status'); this.feedback.hidden = true;
    this.update(null);
  }
  make(tag, parent = this.root) { const node = this.root.ownerDocument.createElement(tag); parent.append(node); return node; }
  text(node, fr, en) { this.labels.push({ node, fr, en }); node.textContent = this.tr(fr, en); }
  tr(fr, en) { return localizedPair(languageCode(this.snapshot?.language), fr, en); }
  button(parent, id, fr, en, action) {
    const node = this.make('button', parent); node.id = id; node.type = 'button'; node.className = 'button secondary'; this.text(node, fr, en);
    node.addEventListener('click', () => { if (!node.disabled) void action(); }, { signal: this.abort.signal }); this.buttons.push(node); return node;
  }
  field(parent, id, fr, en, tag) {
    const label = this.make('label', parent), title = this.make('span', label); this.text(title, fr, en); label.setAttribute('for', id);
    const input = this.make(tag, label); input.id = id; this.fields.push(input); return input;
  }
  select(parent, id, fr, en, options, change) {
    const input = this.field(parent, id, fr, en, 'select'); this.options(input, options);
    input.addEventListener('change', () => { if (!input.disabled) change(input.value); }, { signal: this.abort.signal }); return input;
  }
  options(input, entries) {
    for (const option of input.children) this.optionLabels.delete(option);
    input.replaceChildren();
    for (const [value, fr, en] of entries) { const option = this.make('option', input); option.value = String(value); option.textContent = this.tr(fr, en); this.optionLabels.set(option, { fr, en }); }
  }
  number(parent, id, fr, en, min, max, change) {
    const input = this.field(parent, id, fr, en, 'input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = '1';
    input.addEventListener('input', () => { if (!input.disabled) change(numeric(input.value)); }, { signal: this.abort.signal }); return input;
  }
  createPad(parent, id, fr, en) {
    const row = this.make('div', parent); row.setAttribute('style', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(95px,1fr));gap:8px;align-items:end;padding:10px 0;border-bottom:1px solid var(--border,#30445c)');
    const title = this.make('strong', row); this.text(title, fr, en);
    const pad = { id, row };
    pad.note = this.number(row, 'drums-' + id + '-note', 'Note à jouer', 'Output note', 0, 127, value => this.editPad(id, 'note', value));
    pad.channel = this.number(row, 'drums-' + id + '-channel', 'Canal joué (1–16)', 'Output channel (1–16)', 1, 16, value => this.editPad(id, 'channel', value - 1));
    pad.velocity = this.number(row, 'drums-' + id + '-velocity', 'Force fixe (1–127)', 'Fixed velocity (1–127)', 1, 127, value => this.editPad(id, 'velocity', value));
    pad.binding = this.select(row, 'drums-' + id + '-binding', 'Commande XInput', 'XInput control', [
      ['none', 'Non assigné', 'Unassigned'], ...Array.from({ length: 17 }, (_, n) => ['button:' + n, 'Bouton ' + n, 'Button ' + n]),
      ...Array.from({ length: 4 }, (_, n) => [1, -1].map(direction => ['axis:' + n + ':' + direction, 'Axe ' + n + (direction === 1 ? ' +' : ' −'), 'Axis ' + n + (direction === 1 ? ' +' : ' −')])).flat()
    ], value => { const [kind, index, direction] = value.split(':'); this.editPad(id, 'binding', { kind, index: kind === 'none' ? 0 : Number(index), direction: kind === 'axis' ? Number(direction) : 1 }); });
    pad.testButton = this.button(row, 'drums-' + id + '-test', 'Tester', 'Test', () => this.testPad(id)); this.padRows.push(pad);
  }
  edit(key, value) { if (!this.draft || this.busy || this.disposed) return; this.draft[key] = value; this.dirty = true; this.updateState(); }
  editPad(id, key, value) { if (!this.draft || this.busy || this.disposed) return; const pad = this.draft.pads.find(item => item.id === id); if (pad) { pad[key] = value; this.dirty = true; this.updateState(); } }
  settingsValid() {
    const value = this.draft;
    return !!value && Number.isInteger(value.midiDeviceId) && value.midiDeviceId >= -1 && value.midiDeviceId <= 65535
      && Number.isInteger(value.xinputIndex) && value.xinputIndex >= 0 && value.xinputIndex <= 3
      && [44100, 48000, 96000].includes(value.sampleRate) && [64, 128, 256, 512].includes(value.blockSize)
      && Number.isFinite(value.volume) && value.volume >= 0 && value.volume <= 1 && Array.isArray(value.pads) && value.pads.length === PADS.length
      && value.pads.every(pad => Number.isInteger(pad.note) && pad.note >= 0 && pad.note <= 127 && Number.isInteger(pad.channel) && pad.channel >= 0 && pad.channel <= 15 && Number.isInteger(pad.velocity) && pad.velocity >= 1 && pad.velocity <= 127);
  }
  update(snapshot) {
    if (this.disposed) return;
    this.snapshot = snapshot; this.state = snapshot?.drums ?? (snapshot?.phase ? snapshot : null);
    // Other Companion sources can publish many snapshots per second. Only the
    // drum DTO and language affect this panel; live levels/progress never need
    // to rebuild its labels, device options or in-progress mapping fields.
    const { meters, mt, ...configuration } = this.state ?? {};
    const { progress, ...mtConfiguration } = mt ?? {};
    const renderSignature = JSON.stringify([snapshot?.language === 'en' ? 'en' : 'fr', configuration, mtConfiguration]);
    const liveSignature = JSON.stringify([meters, progress]);
    if (this.renderSignature === renderSignature) {
      if (this.liveSignature !== liveSignature) { this.liveSignature = liveSignature; this.updateLive(); }
      return;
    }
    this.renderSignature = renderSignature; this.liveSignature = liveSignature;
    for (const item of this.labels) item.node.textContent = this.tr(item.fr, item.en);
    for (const [option, item] of this.optionLabels) option.textContent = this.tr(item.fr, item.en);
    const value = this.state;
    if (!this.dirty && !this.busy && value?.settings) { this.draft = copy(value.settings); this.baseRevision = value.revision; this.populate(); }
    this.updateState();
  }
  invalidate() { this.renderSignature = null; this.liveSignature = null; }
  sync(snapshot) { this.update(snapshot); }
  populate() {
    if (!this.draft) return;
    const value = this.draft, devices = this.state?.devices ?? {};
    const audio = Array.isArray(devices.audio) ? devices.audio.slice(0, 128) : [], midi = Array.isArray(devices.midi) ? devices.midi.slice(0, 128) : [], xinput = Array.isArray(devices.xinput) ? devices.xinput.slice(0, 4) : [];
    const audioOptions = [['default', 'Sortie Windows par défaut', 'Default Windows output'], ...audio.filter(item => item.id !== 'default').map(item => [item.id, item.name, item.name])];
    if (!audioOptions.some(item => item[0] === value.audioDeviceId)) audioOptions.push([value.audioDeviceId, 'Sortie enregistrée (indisponible)', 'Saved output (unavailable)']);
    this.options(this.audio, audioOptions);
    const midiOptions = [[-1, 'Choisir un périphérique', 'Choose a device'], ...midi.map(item => [item.id, item.name, item.name])];
    if (value.midiDeviceId !== -1 && !midiOptions.some(item => Number(item[0]) === value.midiDeviceId)) midiOptions.push([value.midiDeviceId, 'Entrée enregistrée (indisponible)', 'Saved input (unavailable)']);
    this.options(this.midi, midiOptions);
    this.options(this.xinput, Array.from({ length: 4 }, (_, index) => [index, (xinput.find(item => (item.index ?? item.id) === index)?.name ?? 'XInput ' + (index + 1)), (xinput.find(item => (item.index ?? item.id) === index)?.name ?? 'XInput ' + (index + 1))]));
    for (const [field, key] of [[this.audio, 'audioDeviceId'], [this.source, 'source'], [this.midi, 'midiDeviceId'], [this.xinput, 'xinputIndex'], [this.sampleRate, 'sampleRate'], [this.blockSize, 'blockSize']]) field.value = String(value[key]);
    this.volume.value = String(Math.round(value.volume * 100));
    for (const row of this.padRows) { const pad = value.pads.find(item => item.id === row.id); if (!pad) continue;
      row.note.value = String(pad.note); row.channel.value = String(pad.channel + 1); row.velocity.value = String(pad.velocity);
      row.binding.value = pad.binding.kind === 'none' ? 'none' : pad.binding.kind + ':' + pad.binding.index + (pad.binding.kind === 'axis' ? ':' + pad.binding.direction : '');
    }
  }
  updateState() {
    const state = this.state, supported = state?.supported === true, available = supported && state?.available === true;
    const running = state?.phase === 'running', loaded = state?.plugin?.loaded === true, selected = !!state?.plugin;
    const busy = this.busy || state?.busy === true || !available, source = this.draft?.source;
    for (const field of this.fields) field.disabled = busy || running;
    for (const button of this.buttons) button.disabled = busy;
    this.chooseButton.disabled = busy || running; this.refreshButton.disabled = busy || running;
    this.mtButton.disabled = this.busy || !state;
    const mt = state?.mt, mtBusy = ['downloading', 'extracting'].includes(mt?.state);
    this.mtLicenseButton.disabled = this.busy || !state;
    this.mtConsent.disabled = busy || running || mtBusy;
    this.mtInstallButton.disabled = busy || running || mtBusy || this.mtConsent.checked !== true;
    this.editorButton.disabled = busy || !selected;
    this.midi.disabled = busy || running || source !== 'midi'; this.xinput.disabled = busy || running || source !== 'xinput';
    this.saveButton.disabled = busy || running || !this.dirty || !this.settingsValid();
    this.reloadButton.disabled = busy || running || !this.dirty;
    this.startButton.disabled = busy || running || !selected || this.dirty || !this.settingsValid() || source === 'midi' && this.draft.midiDeviceId === -1;
    this.stopButton.disabled = !state || !(running || state.busy === true || this.busy || mtBusy);
    this.panicButton.disabled = this.stopButton.disabled;
    const editorBusy = busy && state?.operation === 'editor';
    this.lockHint.hidden = !available || !(running || busy);
    this.lockHint.textContent = editorBusy
      ? this.tr('Ouverture de l’instrument en cours. Si sa fenêtre ne répond pas, Annuler l’ouverture ferme ce moteur et libère les réglages. Aucun audio ne redémarre automatiquement.', 'Opening the instrument. If its window is not responding, Cancel opening closes this engine and unlocks settings. Audio never restarts automatically.')
      : busy ? state?.operation === 'configure'
        ? this.tr('Enregistrement des réglages en cours. Les commandes redeviennent disponibles à la fin de l’enregistrement.', 'Saving settings. Controls become available when saving finishes.')
        : this.tr('Une action est en cours. Arrêter l’audio annule son chargement et libère les commandes.', 'An action is in progress. Stop audio cancels loading and releases the controls.')
      : running ? this.tr('Pour modifier les périphériques, le volume ou les pads, arrêtez d’abord l’audio, puis appliquez vos réglages.', 'To change devices, volume or pads, stop audio first, then apply your settings.') : '';
    this.stopButton.textContent = editorBusy ? this.tr('Annuler l’ouverture', 'Cancel opening') : this.tr('Arrêter l’audio', 'Stop audio');
    for (const row of this.padRows) { row.binding.disabled = busy || running || source !== 'xinput'; row.testButton.disabled = busy || !running || this.dirty; }
    this.plugin.textContent = selected ? this.tr('Instrument : ', 'Instrument: ') + String(state.plugin.name ?? '').slice(0, 200) + (!loaded ? this.tr(' · ouvrez sa fenêtre pour le charger', ' · open its window to load it') : '') : this.tr('Aucun instrument choisi.', 'No instrument selected.');
    const phases = { stopped: this.tr('Audio arrêté.', 'Audio stopped.'), loaded: this.tr('Instrument chargé. Vérifiez sa fenêtre avant de démarrer l’audio.', 'Instrument loaded. Check its window before starting audio.'), running: this.tr('Audio actif.', 'Audio running.'), error: this.tr('Audio arrêté après une erreur. Vérifiez l’instrument et la sortie, puis réessayez.', 'Audio stopped after an error. Check the instrument and output, then try again.') };
    this.status.textContent = !supported ? this.tr('Batterie VST disponible sous Windows 64 bits.', 'Drum VST is available on 64-bit Windows.') : !available ? this.tr('Le moteur audio est indisponible.', 'The audio engine is unavailable.') : phases[state.phase] ?? phases.stopped;
    if (state?.error) this.status.textContent += ' ' + this.errorText(state.error.message ?? state.error);
    this.unsaved.textContent = this.dirty ? this.settingsValid() ? this.tr('Réglages modifiés : appliquez-les avant de jouer.', 'Settings changed: apply them before playing.') : this.tr('Vérifiez les valeurs : notes 0–127, canaux 1–16, force 1–127 et volume 0–100 %.', 'Check values: notes 0–127, channels 1–16, velocity 1–127 and volume 0–100%.') : '';
    this.sourceHelp.textContent = source === 'midi' ? this.tr('MIDI direct : les notes, canaux et vélocités reçus de la batterie sont transmis tels quels. Les réglages des pads ChartsHub ne remappent pas ces frappes ; dans ce mode, ils servent uniquement aux boutons Tester.', 'MIDI pass-through: incoming drum notes, channels and velocities are preserved. ChartsHub pad settings do not remap these hits; in this mode, they apply only to Test buttons.') : source === 'xinput' ? this.tr('XInput : chaque nouvelle pression déclenche une frappe. Cette source ne mesure pas la force du coup ; la vélocité fixe du pad est utilisée.', 'XInput: each new press triggers a hit. This source does not measure hit strength; the pad’s fixed velocity is used.') : this.tr('Mode manuel : démarrez l’audio, puis cliquez sur Tester pour jouer chaque pad.', 'Manual mode: start audio, then click Test to play each pad.');
    this.updateLive();
    const audio = state?.audio;
    this.audioFormat.textContent = audio && Number.isFinite(audio.sampleRate) && Number.isFinite(audio.blockSize)
      ? this.tr('Format utilisé : ', 'Actual format: ') + audio.sampleRate + ' Hz · ' + audio.blockSize + this.tr(' échantillons', ' samples')
        + (audio.latencyKind === 'reported' && Number.isFinite(audio.latencyMs) ? this.tr(' · latence déclarée : ', ' · reported latency: ') + audio.latencyMs.toFixed(1) + ' ms' : '')
      : '';
  }
  updateLive() {
    const meters = this.state?.meters, levels = Array.isArray(meters) ? meters : [meters?.left, meters?.right, meters?.peak];
    const level = Math.max(0, ...levels.filter(value => typeof value === 'number' && Number.isFinite(value)).map(value => Math.min(1, value)));
    if (this.meter.value !== level) this.meter.value = level;
    const mt = this.state?.mt, received = mt?.progress?.receivedBytes, total = mt?.progress?.totalBytes;
    const progress = Number.isFinite(received) && received >= 0 ? ' · ' + (received / 1000000).toFixed(1) + (Number.isFinite(total) && total > 0 ? ' / ' + (total / 1000000).toFixed(1) : '') + this.tr(' Mo', ' MB') : '';
    const message = mt?.state === 'downloading' ? this.tr('Téléchargement officiel en cours', 'Downloading from the publisher') + progress
      : mt?.state === 'extracting' ? this.tr('Vérification et préparation dans le dossier privé…', 'Checking and preparing in the private folder…')
      : mt?.state === 'installed' ? this.tr('MT Power Drum Kit est préparé. Ouvrez l’instrument, cliquez sur START dans MT, puis sur Démarrer l’audio dans ChartsHub.', 'MT Power Drum Kit is prepared. Open instrument, click START in MT, then Start audio in ChartsHub.')
      : mt?.error ? this.errorText(mt.error) : '';
    if (this.mtStatus.textContent !== message) this.mtStatus.textContent = message;
  }
  errorText(value) { const code = typeof value === 'string' ? value : ''; return ERRORS[code] ? this.tr(...ERRORS[code]) : String(value).slice(0, 300); }
  async installMt() {
    if (this.mtConsent.checked !== true || this.state?.phase === 'running') return;
    try { return await this.perform('drums.installMt', { consent: true }); }
    finally { if (!this.disposed) { this.mtConsent.checked = false; this.updateState(); } }
  }
  async save() {
    if (!this.dirty || !this.settingsValid() || this.state?.phase === 'running') return;
    const submitted = copy(this.draft), result = await this.perform('drums.configure', { revision: this.baseRevision, settings: submitted });
    if (result?.ok && !this.disposed) { this.dirty = false; this.invalidate(); this.update(this.snapshot); }
  }
  async testPad(id) {
    const pad = this.draft?.pads.find(item => item.id === id);
    if (this.state?.phase !== 'running' || this.dirty || !pad) return;
    return this.perform('drums.testPad', { padId: id, velocity: pad.velocity });
  }
  async perform(name, payload = {}) {
    if (this.disposed || this.busy && !['drums.stop', 'drums.panic'].includes(name)) return null;
    this.pending++; this.busy = true; this.feedback.hidden = true; this.updateState();
    try { const result = await this.command(name, payload); if (!result?.ok) throw Error(result?.code && ERRORS[result.code] ? this.errorText(result.code) : this.errorText(result?.error || this.tr('L’action batterie a échoué.', 'The drum action failed.'))); return result; }
    catch (error) { if (!this.disposed) { this.feedback.textContent = String(error?.message || this.tr('Action indisponible.', 'Action unavailable.')).slice(0, 500); this.feedback.hidden = false; } return null; }
    finally { this.pending--; this.busy = this.pending > 0; if (!this.disposed) { this.invalidate(); this.update(this.snapshot); } }
  }
  dispose() { this.disposed = true; this.abort.abort(); }
}
