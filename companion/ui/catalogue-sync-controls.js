import { languageCode, languageKey, wordsFor } from './locale-text.js';
const PHASES = new Set(['idle', 'analyzing', 'ready', 'running', 'paused', 'completed', 'error']);
const ACTIONS = new Set(['analyze', 'start', 'pause', 'resume', 'retry']);
const COUNTS = ['new', 'update', 'unchanged', 'failed', 'completed'];
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const clean = (value, limit = 180) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : '';
const TEXT = {
  fr: {
    title: 'Synchroniser le catalogue ChartsHub', intro: '1. Choisissez le dossier de téléchargement ci-dessus. 2. Analysez le catalogue. 3. Vérifiez le résumé avant de démarrer.',
    scope: 'Cette synchronisation concerne les charts publiées sur ChartsHub. Les sources externes se téléchargent depuis la recherche habituelle.',
    mode: 'Charts à synchroniser', all: 'Tout le catalogue ChartsHub', installed: 'Seulement mes charts suivies', concurrency: 'Téléchargements simultanés', includeVideo: 'Inclure les vidéos disponibles', videoHelp: 'Les vidéos peuvent augmenter fortement le volume à télécharger. Ce choix est conservé pour la prochaine analyse.', changed: 'Les options ont changé. Relancez Analyser avant de démarrer.',
    analyze: 'Analyser', start: 'Démarrer la synchronisation', pause: 'Mettre en pause', resume: 'Reprendre', retry: 'Réessayer les erreurs',
    root: 'Dossier Songs', noRoot: 'Choisissez le dossier de téléchargement ci-dessus avant de commencer.', unavailable: 'La synchronisation n’est pas disponible dans cette version.',
    idle: 'Prêt à analyser. Aucun téléchargement automatique.', analyzing: 'Analyse du catalogue…', ready: 'Analyse terminée. Vérifiez le résumé, puis démarrez.', pausedAnalysis: 'Analyse interrompue. Relancez Analyser avant de télécharger.',
    running: 'Synchronisation en cours', paused: 'Synchronisation en pause. La progression est conservée.', completed: 'Synchronisation terminée.', error: 'La synchronisation demande votre attention.',
    counts: { new: 'À télécharger', update: 'Mises à jour', unchanged: 'Inchangées', failed: 'Erreurs', completed: 'Installées' },
    processed: 'charts traitées', transferred: 'transférés', details: 'Dernières opérations', empty: 'Aucune opération à afficher.', bounded: 'Les 50 dernières opérations au maximum sont affichées ici.',
    preservation: 'Les charts identiques sont ignorées. Sans empreinte fiable de la source, certains fichiers sont téléchargés pour comparer leur contenu. Si une copie locale ne peut pas être mise à jour en toute sécurité, ChartsHub installe la version du catalogue dans un dossier séparé. Lors d’une mise à jour, l’ancienne version reste disponible en sauvegarde.',
    pauseHelp: 'Vous pouvez mettre en pause et reprendre plus tard. Après un redémarrage de ChartsHub, utilisez Reprendre.',
    actionError: 'Cette action n’a pas abouti. Vérifiez le dossier et la connexion, puis réessayez.', serverUpdate: 'Le site ChartsHub doit être mis à jour avant de pouvoir synchroniser le catalogue.', storageError: 'La progression enregistrée ne peut pas être chargée ou sauvegardée. Les fichiers existants sont conservés.',
    spaceError: 'L’espace disque est insuffisant. Libérez de l’espace dans le dossier de destination, puis cliquez sur Reprendre.',
    states: { new: 'À télécharger', update: 'Mise à jour', unchanged: 'Inchangée', conflict: 'En attente', queued: 'En attente', downloading: 'Téléchargement', running: 'Téléchargement', completed: 'Installée', failed: 'Échec', paused: 'En pause' },
    unknown: 'État indisponible', failedHelp: 'Réessayez les erreurs après avoir vérifié le dossier et la connexion.',
  },
  en: {
    title: 'Synchronize the ChartsHub catalogue', intro: '1. Choose the download folder above. 2. Analyze the catalogue. 3. Review the summary before starting.',
    scope: 'Synchronization covers charts published on ChartsHub. Download external sources through the usual search.',
    mode: 'Charts to synchronize', all: 'Entire ChartsHub catalogue', installed: 'Only my tracked charts', concurrency: 'Simultaneous downloads', includeVideo: 'Include available videos', videoHelp: 'Videos can greatly increase the download size. This choice is saved for the next analysis.', changed: 'Options changed. Analyze again before starting.',
    analyze: 'Analyze', start: 'Start synchronization', pause: 'Pause', resume: 'Resume', retry: 'Retry errors',
    root: 'Songs folder', noRoot: 'Choose the download folder above before starting.', unavailable: 'Synchronization is unavailable in this version.',
    idle: 'Ready to analyze. No automatic downloads.', analyzing: 'Analyzing the catalogue…', ready: 'Analysis complete. Review the summary, then start.', pausedAnalysis: 'Analysis interrupted. Analyze again before downloading.',
    running: 'Synchronizing', paused: 'Synchronization paused. Progress is saved.', completed: 'Synchronization complete.', error: 'Synchronization needs your attention.',
    counts: { new: 'To download', update: 'Updates', unchanged: 'Unchanged', failed: 'Errors', completed: 'Installed' },
    processed: 'charts processed', transferred: 'transferred', details: 'Recent operations', empty: 'No operations to display.', bounded: 'Up to the 50 most recent operations are shown here.',
    preservation: 'Identical charts are skipped. Without a reliable source fingerprint, some files are downloaded for comparison. If a local copy cannot safely be updated, ChartsHub installs the catalogue version in a separate folder. Updates retain the previous version as a backup.',
    pauseHelp: 'Pause and resume later. After restarting ChartsHub, choose Resume.',
    actionError: 'This action did not finish. Check the folder and connection, then try again.', serverUpdate: 'The ChartsHub website must be updated before the catalogue can be synchronized.', storageError: 'Saved progress could not be loaded or saved. Existing files are preserved.',
    spaceError: 'There is not enough disk space. Free up space in the destination folder, then choose Resume.',
    states: { new: 'To download', update: 'Update', unchanged: 'Unchanged', conflict: 'Queued', queued: 'Queued', downloading: 'Downloading', running: 'Downloading', completed: 'Installed', failed: 'Failed', paused: 'Paused' },
    unknown: 'Status unavailable', failedHelp: 'Check the folder and connection before retrying the errors.',
  },
};

export function projectCatalogueSync(snapshot = {}) {
  const source = snapshot?.catalogueSync;
  const state = source && typeof source === 'object' ? source : {};
  const phase = PHASES.has(state.phase) ? state.phase : 'idle';
  const rootPath = clean(state.rootPath || snapshot?.downloads?.rootPath, 32768);
  return {
    available: Boolean(source) && state.supported !== false,
    language: languageCode(snapshot?.language), phase, rootPath,
    mode: state.mode === 'installed' ? 'installed' : 'all', total: integer(state.total), processed: integer(state.processed),
    counts: Object.fromEntries(COUNTS.map(key => [key, integer(state.counts?.[key]) + (key === 'new' ? integer(state.counts?.conflict) : 0)])),
    receivedBytes: integer(state.receivedBytes), concurrency: [1, 2, 3, 4].includes(state.concurrency) ? state.concurrency : 2, includeVideo: state.includeVideo === true,
    error: Boolean(state.error), errorCode: ['SYNC_SERVER_UPDATE_REQUIRED', 'SYNC_STORAGE', 'SYNC_NO_SPACE', 'SYNC_ANALYSIS_INTERRUPTED'].includes(state.error) ? state.error : null, canResume: state.canResume === true,
    items: Array.isArray(state.items) ? state.items.slice(-50).map(item => ({
      title: clean(item?.title), state: Object.hasOwn(TEXT.en.states, item?.state) ? item.state : 'unknown',
    })) : [],
  };
}

function byteText(value, language) {
  const units = language === 'fr' ? ['o', 'Kio', 'Mio', 'Gio', 'Tio'] : ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value, index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return size.toLocaleString(language, { maximumFractionDigits: index ? 1 : 0 }) + ' ' + units[index];
}

export class CatalogueSyncControls {
  constructor({ root, command }) {
    this.root = root; this.document = root.ownerDocument; this.command = command; this.listeners = [];
    this.disposed = false; this.pending = null; this.localError = false; this.epoch = 0; this.signature = null; this.selectionDirty = false;
    const node = (tag, className = '') => { const element = this.document.createElement(tag); element.className = className; return element; };
    this.node = node;
    const title = node('h3'), intro = node('p', 'helper-text'), scope = node('p', 'helper-text'), fields = node('div', 'catalogue-sync-fields');
    title.id = 'catalogue-sync-title'; root.setAttribute('aria-labelledby', title.id);
    const modeLabel = node('label'), modeText = node('span'), mode = node('select'); mode.id = 'catalogue-sync-mode'; modeLabel.htmlFor = mode.id;
    for (const value of ['all', 'installed']) { const option = node('option'); option.value = value; mode.append(option); } mode.value = 'all';
    modeLabel.append(modeText, mode);
    const concurrencyLabel = node('label'), concurrencyText = node('span'), concurrency = node('select'); concurrency.id = 'catalogue-sync-concurrency'; concurrencyLabel.htmlFor = concurrency.id;
    for (const value of [1, 2, 3, 4]) { const option = node('option'); option.value = String(value); option.textContent = String(value); concurrency.append(option); } concurrency.value = '2';
    concurrencyLabel.append(concurrencyText, concurrency); fields.append(modeLabel, concurrencyLabel);
    const videoLabel = node('label', 'catalogue-sync-video'), includeVideo = node('input'), videoText = node('span'), videoHelp = node('p', 'helper-text');
    includeVideo.type = 'checkbox'; includeVideo.id = 'catalogue-sync-include-video'; videoHelp.id = 'catalogue-sync-video-help'; includeVideo.setAttribute('aria-describedby', videoHelp.id); videoLabel.append(includeVideo, videoText);
    for (const control of [mode, concurrency, includeVideo]) this.listen(control, 'change', () => { this.selectionDirty = true; this.signature = null; this.update(this.snapshot); });
    const folder = node('p', 'helper-text catalogue-sync-folder'), status = node('p', 'catalogue-sync-status'), counts = node('dl', 'catalogue-sync-counts'); status.setAttribute('role', 'status');
    this.countNodes = {};
    for (const key of COUNTS) { const row = node('div'), value = node('dd'), label = node('dt'); row.append(value, label); counts.append(row); this.countNodes[key] = { value, label }; }
    const progress = node('progress', 'catalogue-sync-progress'), progressText = node('p', 'helper-text'), actions = node('div', 'catalogue-sync-actions');
    const feedback = node('p', 'catalogue-sync-feedback'); feedback.setAttribute('role', 'alert'); feedback.hidden = true;
    const details = node('details', 'catalogue-sync-details'), summary = node('summary'), items = node('ul', 'catalogue-sync-items'), bounded = node('p', 'helper-text'); details.append(summary, items, bounded);
    const preservation = node('p', 'helper-text'), pauseHelp = node('p', 'helper-text');
    this.nodes = { title, intro, scope, fields, modeText, mode, concurrencyText, concurrency, videoLabel, includeVideo, videoText, videoHelp, folder, status, counts, progress, progressText, actions, feedback, details, summary, items, bounded, preservation, pauseHelp };
    for (const action of ACTIONS) {
      const button = node('button', 'button ' + (action === 'start' ? 'primary' : 'secondary')); button.id = 'catalogue-sync-' + action; button.type = 'button';
      this.listen(button, 'click', () => { void this.run(action); }); this.nodes[action] = button; actions.append(button);
    }
    root.replaceChildren(title, intro, scope, fields, videoLabel, videoHelp, folder, status, counts, progress, progressText, actions, feedback, details, preservation, pauseHelp);
    this.update({});
  }
  listen(node, type, listener) { node.addEventListener(type, listener); this.listeners.push([node, type, listener]); }
  update(snapshot) {
    if (this.disposed) return;
    this.snapshot = snapshot; const model = projectCatalogueSync(snapshot);
    const signature = JSON.stringify([model, languageKey(model.language), this.pending, this.localError, this.selectionDirty]);
    if (signature === this.signature) return;
    this.signature = signature; this.model = model;
    const t = wordsFor(TEXT, model.language), n = this.nodes, count = value => value.toLocaleString(model.language);
    const locked = ['analyzing', 'running'].includes(model.phase) || model.phase === 'paused' && model.canResume;
    for (const key of ['title', 'intro', 'scope', 'preservation', 'pauseHelp', 'bounded']) n[key].textContent = t[key];
    n.modeText.textContent = t.mode; n.concurrencyText.textContent = t.concurrency; n.videoText.textContent = t.includeVideo; n.videoHelp.textContent = t.videoHelp;
    for (const option of n.mode.children) option.textContent = t[option.value];
    if (!this.selectionDirty || locked) { n.mode.value = model.mode; n.concurrency.value = String(model.concurrency); n.includeVideo.checked = model.includeVideo; this.selectionDirty = false; }
    n.mode.disabled = n.concurrency.disabled = n.includeVideo.disabled = !model.available || locked || Boolean(this.pending);
    n.folder.textContent = model.rootPath ? t.root + ' · ' + model.rootPath : t.noRoot;
    n.status.textContent = !model.available ? t.unavailable : !model.rootPath ? t.noRoot : this.selectionDirty && model.phase === 'ready' ? t.changed : model.phase === 'paused' && !model.canResume ? t.pausedAnalysis : t[model.phase];
    for (const key of COUNTS) { this.countNodes[key].label.textContent = t.counts[key]; this.countNodes[key].value.textContent = count(model.counts[key]); }
    const progressed = Math.min(model.processed, model.total); n.progress.max = Math.max(1, model.total); n.progress.value = progressed;
    n.progress.hidden = n.progressText.hidden = model.total === 0;
    n.progress.setAttribute('aria-label', t.processed); n.progressText.textContent = count(progressed) + ' / ' + count(model.total) + ' ' + t.processed + ' · ' + byteText(model.receivedBytes, model.language) + ' ' + t.transferred;
    for (const action of ACTIONS) n[action].textContent = t[action];
    n.analyze.disabled = !model.available || !model.rootPath || locked || Boolean(this.pending);
    n.start.disabled = !model.available || !model.rootPath || model.phase !== 'ready' || model.counts.new + model.counts.update === 0 || Boolean(this.pending) || this.selectionDirty;
    n.pause.disabled = !model.available || !['analyzing', 'running'].includes(model.phase) || this.pending === 'pause';
    n.resume.disabled = !model.available || !model.rootPath || !['paused', 'error'].includes(model.phase) || !model.canResume || Boolean(this.pending);
    n.retry.disabled = !model.available || !model.rootPath || model.counts.failed === 0 || locked || Boolean(this.pending);
    n.start.hidden = model.phase !== 'ready'; n.pause.hidden = !['analyzing', 'running'].includes(model.phase);
    n.resume.hidden = !['paused', 'error'].includes(model.phase) || !model.canResume; n.retry.hidden = model.counts.failed === 0;
    n.feedback.hidden = !this.localError && !model.error; n.feedback.textContent = model.errorCode === 'SYNC_SERVER_UPDATE_REQUIRED' || this.localError === 'SYNC_SERVER_UPDATE_REQUIRED' ? t.serverUpdate : model.errorCode === 'SYNC_NO_SPACE' || this.localError === 'SYNC_NO_SPACE' ? t.spaceError : model.errorCode === 'SYNC_STORAGE' || this.localError === 'SYNC_STORAGE' ? t.storageError : model.errorCode === 'SYNC_ANALYSIS_INTERRUPTED' ? t.pausedAnalysis : t.actionError;
    n.summary.textContent = t.details + ' · ' + count(model.items.length);
    n.items.replaceChildren(...(model.items.length ? model.items.map(item => { const row = this.node('li'), title = this.node('span'), state = this.node('strong'); title.textContent = item.title || '—'; state.textContent = t.states[item.state] || t.unknown; row.append(title, state); return row; }) : [(() => { const row = this.node('li'); row.textContent = t.empty; return row; })()]));
    this.root.setAttribute('aria-busy', ['analyzing', 'running'].includes(model.phase) || this.pending ? 'true' : 'false');
  }
  async run(action) {
    if (this.disposed || !ACTIONS.has(action) || this.nodes[action].disabled || (this.pending && action !== 'pause')) return;
    const ticket = ++this.epoch;
    const concurrency = Number(this.nodes.concurrency.value);
    const payload = action === 'analyze' ? { mode: this.nodes.mode.value === 'installed' ? 'installed' : 'all', concurrency: [1, 2, 3, 4].includes(concurrency) ? concurrency : 2, includeVideo: this.nodes.includeVideo.checked === true } : {};
    this.pending = action; this.localError = false; this.signature = null; this.update(this.snapshot);
    try {
      const result = await this.command('catalogueSync.' + action, payload);
      if (!this.disposed && ticket === this.epoch) this.localError = result?.ok === true ? false : ['SYNC_SERVER_UPDATE_REQUIRED', 'SYNC_STORAGE', 'SYNC_NO_SPACE'].includes(result?.code) ? result.code : true;
    } catch { if (!this.disposed && ticket === this.epoch) this.localError = true; }
    finally { if (!this.disposed && ticket === this.epoch) { this.pending = null; this.signature = null; this.update(this.snapshot); } }
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.epoch++; for (const [node, type, listener] of this.listeners) node.removeEventListener(type, listener); this.listeners = []; }
}
