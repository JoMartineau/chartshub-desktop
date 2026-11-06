const MAX_SELECTION = 1000, PAGE_SIZE = 50, ID = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const clean = (value, limit = 512) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : '';
const TEXT = {
  fr: {
    title: 'Libérer de l’espace · sélection de charts', intro: 'Filtrez votre bibliothèque, cochez les charts, puis vérifiez la taille et les dossiers avant la confirmation finale.',
    search: 'Titre, artiste, créateur ou dossier', artist: 'Filtrer par artiste', album: 'Filtrer par album', searchButton: 'Rechercher', reset: 'Effacer les filtres',
    history: 'Le filtre « jamais jouées » est indisponible : ChartsHub ne possède pas d’historique fiable de vos parties Clone Hero.',
    preservation: 'Seules les charts sélectionnées et vérifiées seront envoyées à la Corbeille, avec leur dossier complet. Aucun fichier n’est supprimé lors de la recherche ou de la vérification.',
    trashHelp: 'La Corbeille permet de récupérer les fichiers. L’espace disque est libéré lorsque vous la videz vous-même après vérification.',
    selectionHelp: 'La sélection conserve les charts cochées sur les autres pages et avec les autres filtres. Maximum : 1 000 charts par vérification.',
    selectPage: 'Sélectionner cette page', selectResults: 'Sélectionner les résultats · 1 000 max.', clear: 'Tout décocher', prepare: 'Vérifier la sélection', cancel: 'Arrêter / fermer la vérification', recycle: 'Envoyer les charts vérifiées à la Corbeille',
    previous: 'Précédent', next: 'Suivant', noRoot: 'Choisissez votre dossier Songs dans Bibliothèque.', unavailable: 'La bibliothèque doit être prête avant de préparer une suppression.',
    idle: 'Ouvrez cette section pour parcourir les charts à sélectionner.', loading: 'Recherche dans l’index local…', empty: 'Aucune chart ne correspond à ces filtres.',
    selected: 'chart(s) cochée(s)', results: 'résultat(s)', page: 'Page', of: 'sur', limit: 'Limite de 1 000 charts atteinte. Vérifiez ce lot avant de préparer le suivant.',
    preparing: 'Vérification des fichiers sélectionnés…', awaiting: 'Vérification terminée. Relisez les dossiers concernés avant de demander la confirmation finale.',
    confirming: 'Confirmation du système en attente…', cancelling: 'Arrêt du traitement…', cancelled: 'Action annulée. La sélection reste disponible.', stopped: 'Arrêt demandé. Les fichiers déjà déplacés restent dans la Corbeille.',
    queryError: 'La liste n’a pas pu être chargée. Vérifiez l’état de la bibliothèque, puis relancez Rechercher.',
    prepareError: 'La sélection ou ses fichiers ont changé. Actualisez la bibliothèque, puis préparez une nouvelle vérification.',
    recycleError: 'La mise à la Corbeille n’a pas abouti. Vérifiez l’état de la bibliothèque avant de préparer une nouvelle vérification.',
    selectError: 'La sélection des résultats n’a pas abouti. Relancez Rechercher.',
    eligible: 'chart(s) vérifiée(s) à envoyer à la Corbeille', blocked: 'chart(s) conservée(s), non vérifiable(s)', size: 'Taille des fichiers concernés', preview: 'Aperçu des dossiers concernés', previewLimit: 'Les 50 premiers éléments sont affichés. La confirmation finale porte sur le nombre total indiqué.',
    verified: 'Vérifiée', kept: 'Conservée · à vérifier', recycled: 'chart(s) envoyée(s) à la Corbeille', failed: 'échec(s)', resultTruncated: 'Les 1 000 premiers résultats ont été sélectionnés. Traitez ce lot avant les suivants.',
    noneEligible: 'Aucune chart de cette sélection ne peut être envoyée à la Corbeille en sécurité. Les fichiers sont conservés.',
  },
  en: {
    title: 'Free up space · chart selection', intro: 'Filter your library, select charts, then review their size and folders before the final confirmation.',
    search: 'Title, artist, charter or folder', artist: 'Filter by artist', album: 'Filter by album', searchButton: 'Search', reset: 'Clear filters',
    history: 'The “never played” filter is unavailable: ChartsHub does not have reliable Clone Hero play history.',
    preservation: 'Only selected, verified charts will be sent to the Recycle Bin, including their entire folder. Searching and verification delete no files.',
    trashHelp: 'The Recycle Bin lets you recover files. Disk space is freed when you empty it yourself after checking its contents.',
    selectionHelp: 'Charts selected on other pages and with other filters stay selected. Maximum: 1,000 charts per review.',
    selectPage: 'Select this page', selectResults: 'Select results · 1,000 max.', clear: 'Clear selection', prepare: 'Review selection', cancel: 'Stop / close review', recycle: 'Send verified charts to Recycle Bin',
    previous: 'Previous', next: 'Next', noRoot: 'Choose your Songs folder in Library.', unavailable: 'The library must be ready before preparing removal.',
    idle: 'Open this section to browse charts for selection.', loading: 'Searching the local index…', empty: 'No charts match these filters.',
    selected: 'selected chart(s)', results: 'result(s)', page: 'Page', of: 'of', limit: 'The 1,000-chart limit has been reached. Review this batch before preparing another.',
    preparing: 'Verifying selected files…', awaiting: 'Review ready. Read the affected folders before requesting the final confirmation.',
    confirming: 'Waiting for system confirmation…', cancelling: 'Stopping the operation…', cancelled: 'Action cancelled. Your selection remains available.', stopped: 'Stop requested. Files already moved remain in the Recycle Bin.',
    queryError: 'The list could not be loaded. Check the library status, then search again.',
    prepareError: 'The selection or its files changed. Refresh the library, then prepare another review.',
    recycleError: 'Recycling did not finish. Check the library status before preparing another review.',
    selectError: 'Results could not be selected. Search again.',
    eligible: 'verified chart(s) to send to the Recycle Bin', blocked: 'unverified chart(s) kept', size: 'Size of affected files', preview: 'Affected folder preview', previewLimit: 'The first 50 entries are shown. Final confirmation covers the total count displayed.',
    verified: 'Verified', kept: 'Kept · needs review', recycled: 'chart(s) sent to the Recycle Bin', failed: 'failure(s)', resultTruncated: 'The first 1,000 results were selected. Process this batch before the following results.',
    noneEligible: 'No selected chart can safely be sent to the Recycle Bin. Files are preserved.',
  },
};
const formatBytes = (bytes, language) => { const units = language === 'fr' ? ['o', 'Kio', 'Mio', 'Gio', 'Tio'] : ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let value = bytes, index = 0; while (value >= 1024 && index < 4) { value /= 1024; index++; } return value.toLocaleString(language, { maximumFractionDigits: index ? 1 : 0 }) + ' ' + units[index]; };
const validPage = value => value && ID.test(value.rootKey) && integer(value.revision) && integer(value.total) && integer(value.offset) && value.limit === PAGE_SIZE && Array.isArray(value.items) && value.items.length <= PAGE_SIZE && value.items.every(item => item && ID.test(item.id) && ['title', 'artist', 'album', 'relativePath'].every(key => typeof item[key] === 'string' && item[key].length <= 32768)) && new Set(value.items.map(item => item.id)).size === value.items.length;

export class LibraryRemovalControls {
  constructor({ root, command }) {
    this.root = root; this.document = root.ownerDocument; this.command = command; this.listeners = []; this.rowListeners = [];
    this.selected = new Set(); this.checks = new Map(); this.selectionRevision = 0; this.queryEpoch = 0; this.operationEpoch = 0; this.pageVersion = 0;
    this.model = { rootPath: null, revision: 0, ready: false, blocked: true, language: 'fr', backendPhase: 'idle' };
    this.page = null; this.rootKey = null; this.plan = null; this.pending = null; this.querying = false; this.disposed = false; this.needsQuery = true; this.offset = 0; this.message = null;
    const node = (tag, className = '') => { const value = this.document.createElement(tag); value.className = className; return value; }; this.node = node;
    const summary = node('summary'), body = node('div', 'library-removal-body'), intro = node('p', 'helper-text'), history = node('p', 'library-removal-history'), preservation = node('p', 'helper-text'), trashHelp = node('p', 'helper-text');
    summary.id = 'library-removal-title'; root.setAttribute('aria-labelledby', summary.id);
    const form = node('form', 'library-removal-filters'); this.inputs = {}; this.labels = {};
    for (const name of ['search', 'artist', 'album']) { const label = node('label'), text = node('span'), input = node('input'); input.type = 'search'; input.maxLength = 512; input.autocomplete = 'off'; input.id = 'library-removal-' + name; label.htmlFor = input.id; label.append(text, input); form.append(label); this.inputs[name] = input; this.labels[name] = text; }
    const searchButton = node('button', 'button secondary'), reset = node('button', 'button secondary'); searchButton.type = 'submit'; reset.type = 'button'; form.append(searchButton, reset);
    this.listen(form, 'submit', event => { event.preventDefault(); this.offset = 0; void this.search(); });
    this.listen(reset, 'click', () => { if (this.blocked()) return; for (const input of Object.values(this.inputs)) input.value = ''; this.offset = 0; void this.search(); });
    const status = node('p', 'library-removal-status'), selectedText = node('p', 'library-removal-selected'), selectionHelp = node('p', 'helper-text'); status.setAttribute('role', 'status'); selectedText.setAttribute('role', 'status');
    const actions = node('div', 'library-removal-actions'), list = node('div', 'library-removal-list'), pagination = node('div', 'library-removal-pagination'), pageText = node('span');
    list.setAttribute('role', 'group'); list.id = 'library-removal-results';
    this.nodes = { summary, body, intro, history, preservation, trashHelp, form, searchButton, reset, status, selectedText, selectionHelp, actions, list, pagination, pageText };
    for (const name of ['selectPage', 'selectResults', 'clear', 'prepare', 'previous', 'next', 'cancel', 'recycle']) {
      const button = node('button', 'button ' + (name === 'recycle' ? 'danger' : 'secondary')); button.type = 'button'; button.id = 'library-removal-' + name;
      this.listen(button, 'click', () => { void this.run(name); }); this.nodes[name] = button;
      if (['previous', 'next'].includes(name)) pagination.append(button); else if (!['recycle', 'cancel'].includes(name)) actions.append(button);
    }
    pagination.append(pageText);
    const preview = node('section', 'library-removal-preview'), previewTitle = node('h4'), previewSummary = node('p'), previewSize = node('p'), previewItems = node('ul'), previewLimit = node('p', 'helper-text'), previewActions = node('div', 'library-removal-actions');
    previewTitle.id = 'library-removal-preview-title'; preview.setAttribute('aria-labelledby', previewTitle.id); previewActions.append(this.nodes.cancel, this.nodes.recycle); preview.append(previewTitle, previewSummary, previewSize, previewItems, previewLimit, previewActions);
    const progress = node('p', 'helper-text'); progress.setAttribute('role', 'status');
    const cancelPending = node('button', 'button secondary'); cancelPending.type = 'button'; cancelPending.id = 'library-removal-stop'; this.listen(cancelPending, 'click', () => { void this.cancel(); });
    Object.assign(this.nodes, { preview, previewTitle, previewSummary, previewSize, previewItems, previewLimit, progress, cancelPending });
    body.append(intro, history, form, selectedText, selectionHelp, actions, status, list, pagination, progress, cancelPending, preview, preservation, trashHelp); root.replaceChildren(summary, body);
    this.listen(root, 'toggle', () => { if (root.open && this.needsQuery && this.model.ready && !this.blocked()) void this.search(); });
    this.render();
  }
  listen(node, type, listener, row = false) { node.addEventListener(type, listener); (row ? this.rowListeners : this.listeners).push([node, type, listener]); }
  blocked() { return this.disposed || this.model.blocked || Boolean(this.pending) || ['preparing', 'executing'].includes(this.model.backendPhase); }
  filters() { return { query: clean(this.inputs.search.value), artist: clean(this.inputs.artist.value), album: clean(this.inputs.album.value) }; }
  update(snapshot) {
    if (this.disposed) return;
    const library = snapshot?.library ?? {}, rootPath = typeof library.settings?.rootPath === 'string' ? library.settings.rootPath : null;
    const revision = integer(library.revision) ? library.revision : 0, rootChanged = this.model.rootPath !== rootPath, indexChanged = this.model.revision !== revision;
    const ready = library.status === 'ready' && Boolean(rootPath);
    this.model = { rootPath, revision, ready, language: snapshot?.language === 'en' ? 'en' : 'fr', backendPhase: library.selectedRemoval?.phase ?? 'idle', processed: library.selectedRemoval?.processed ?? 0, total: library.selectedRemoval?.total ?? 0,
      blocked: !ready || library.downloadBatchActive === true || Boolean(library.bulkCleanup) || library.badSongsBusy === true || library.duplicateVerification?.running === true || ['analyzing', 'running'].includes(snapshot?.catalogueSync?.phase) };
    if (rootChanged || indexChanged) {
      this.queryEpoch++; this.querying = false; this.needsQuery = true; this.page = null; this.rootKey = null; this.pageVersion++; this.offset = 0; this.selected.clear(); this.selectionRevision++; this.plan = null;
      if (rootChanged || this.pending !== 'recycle') { this.operationEpoch++; this.pending = null; }
      this.message = null;
    }
    this.render();
    if (this.root.open && this.needsQuery && !this.blocked() && !this.querying) void this.search();
  }
  current(root, revision) { return !this.disposed && this.model.rootPath === root && this.model.revision === revision; }
  async search({ keepMessage = false } = {}) {
    if (this.blocked()) return;
    const root = this.model.rootPath, revision = this.model.revision, ticket = ++this.queryEpoch, filters = this.filters();
    this.querying = true; if (!keepMessage) this.message = null; this.plan = null; this.render();
    try {
      const result = await this.command('library.selectedRemovalQuery', { ...filters, offset: this.offset, limit: PAGE_SIZE });
      if (ticket !== this.queryEpoch || !this.current(root, revision)) return;
      const value = result?.result;
      if (!result?.ok || !validPage(value) || value.revision !== revision || value.offset !== this.offset || this.rootKey && this.rootKey !== value.rootKey) throw Error();
      this.page = value; this.rootKey = value.rootKey; this.needsQuery = false; this.pageVersion++;
    } catch { if (ticket === this.queryEpoch && this.current(root, revision)) { this.page = null; this.pageVersion++; this.needsQuery = false; this.message = { key: 'queryError' }; } }
    finally { if (ticket === this.queryEpoch && this.current(root, revision)) { this.querying = false; this.render(); } }
  }
  select(id, enabled) {
    if (this.blocked() || this.querying || this.plan || !this.page?.items.some(item => item.id === id)) return;
    if (enabled && this.selected.size < MAX_SELECTION) this.selected.add(id); else if (!enabled) this.selected.delete(id); else this.message = { key: 'limit' };
    this.selectionRevision++; this.render();
  }
  async selectResults() {
    if (this.blocked() || this.querying || !this.page) return;
    const root = this.model.rootPath, revision = this.model.revision, ticket = ++this.operationEpoch, rootKey = this.rootKey;
    this.pending = 'selectResults'; this.message = null; this.render();
    try {
      const response = await this.command('library.selectedRemovalIds', this.filters()), result = response?.result;
      if (ticket !== this.operationEpoch || !this.current(root, revision)) return;
      if (!response?.ok || !result || result.rootKey !== rootKey || result.revision !== revision || !integer(result.total) || !Array.isArray(result.ids) || result.ids.length > MAX_SELECTION || !result.ids.every(id => ID.test(id)) || new Set(result.ids).size !== result.ids.length || typeof result.truncated !== 'boolean' || result.ids.length > result.total) throw Error();
      this.selected = new Set(result.ids); this.selectionRevision++; this.plan = null;
      this.message = result.truncated ? { key: 'resultTruncated' } : null;
    } catch { if (ticket === this.operationEpoch && this.current(root, revision)) this.message = { key: 'selectError' }; }
    finally { if (ticket === this.operationEpoch && this.current(root, revision)) { this.pending = null; this.render(); } }
  }
  validPlan(value, rootKey, revision, ids) {
    return value && UUID.test(value.planId) && value.rootKey === rootKey && value.revision === revision && value.count === ids.size && integer(value.eligibleCount) && integer(value.blockedCount) && value.eligibleCount + value.blockedCount === value.count && integer(value.totalBytes) && typeof value.previewTruncated === 'boolean' && Array.isArray(value.entries) && value.entries.length <= PAGE_SIZE && value.entries.length <= value.count && value.entries.every(entry => entry && ids.has(entry.id) && typeof entry.relativePath === 'string' && typeof entry.title === 'string' && typeof entry.eligible === 'boolean' && (!entry.eligible || typeof entry.targetRelativePath === 'string' && integer(entry.bytes))) && new Set(value.entries.map(entry => entry.id)).size === value.entries.length;
  }
  async prepare() {
    if (this.blocked() || this.querying || !this.rootKey || !this.selected.size || this.plan) return;
    const root = this.model.rootPath, revision = this.model.revision, rootKey = this.rootKey, ids = new Set(this.selected), ticket = ++this.operationEpoch;
    this.pending = 'prepare'; this.message = { key: 'preparing' }; this.render();
    try {
      const response = await this.command('library.prepareSelectedRemoval', { ids: [...ids], rootKey, revision });
      if (ticket !== this.operationEpoch || !this.current(root, revision)) return;
      if (!response?.ok || !this.validPlan(response.result, rootKey, revision, ids)) throw Error();
      this.plan = response.result; this.message = { key: this.plan.eligibleCount ? 'awaiting' : 'noneEligible' };
    } catch { if (ticket === this.operationEpoch && this.current(root, revision)) { this.plan = null; this.message = { key: 'prepareError' }; } }
    finally { if (ticket === this.operationEpoch && this.current(root, revision)) { this.pending = null; this.render(); } }
  }
  async recycle() {
    if (this.blocked() || !this.plan || this.plan.eligibleCount < 1) return;
    const plan = this.plan, selected = new Set(this.selected), root = this.model.rootPath, ticket = ++this.operationEpoch;
    this.pending = 'recycle'; this.message = { key: 'confirming' }; this.render();
    try {
      const response = await this.command('library.recycleSelectedRemoval', { planId: plan.planId, rootKey: plan.rootKey, revision: plan.revision });
      if (this.disposed || ticket !== this.operationEpoch || this.model.rootPath !== root) return;
      if (response?.ok && response.cancelled) { this.plan = null; this.message = { key: 'cancelled' }; return; }
      const result = response?.result;
      if (!response?.ok || !result || !Array.isArray(result.recycledIds) || !result.recycledIds.every(id => selected.has(id)) || new Set(result.recycledIds).size !== result.recycledIds.length || !Array.isArray(result.failed) || result.failed.some(entry => !entry || !selected.has(entry.id) || result.recycledIds.includes(entry.id)) || typeof result.cancelled !== 'boolean') throw Error();
      this.plan = null; this.selected = result.cancelled && this.model.revision === plan.revision ? new Set([...selected].filter(id => !result.recycledIds.includes(id))) : new Set(); this.selectionRevision++; this.page = null; this.pageVersion++; this.needsQuery = true;
      this.message = { recycled: result.recycledIds.length, failed: result.failed.length, stopped: result.cancelled };
    } catch { if (!this.disposed && ticket === this.operationEpoch && this.model.rootPath === root) { this.plan = null; this.message = { key: 'recycleError' }; } }
    finally { if (!this.disposed && ticket === this.operationEpoch && this.model.rootPath === root) { this.pending = null; this.render(); if (this.root.open && this.needsQuery && !this.blocked()) void this.search({ keepMessage: true }); } }
  }
  async cancel() {
    if (this.disposed || this.pending === 'cancel' || !this.pending && !this.plan) return;
    const executing = this.pending === 'recycle' || this.model.backendPhase === 'executing', ticket = ++this.operationEpoch; this.pending = 'cancel'; this.message = { key: 'cancelling' }; this.render();
    try { await this.command('library.cancelSelectedRemoval', {}); }
    catch { /* Original proof is discarded locally even if cancellation fails. */ }
    finally { if (!this.disposed && ticket === this.operationEpoch) { this.pending = null; this.plan = null; this.message = { key: executing ? 'stopped' : 'cancelled' }; this.render(); } }
  }
  async run(action) {
    if (action === 'cancel') return this.cancel();
    if (this.disposed || !this.nodes[action] || this.nodes[action].disabled) return;
    if (action === 'prepare') return this.prepare(); if (action === 'recycle') return this.recycle(); if (action === 'selectResults') return this.selectResults();
    if (action === 'clear') { this.selected.clear(); this.selectionRevision++; this.plan = null; this.message = null; this.render(); }
    if (action === 'selectPage' && this.page) { for (const item of this.page.items) { if (this.selected.size >= MAX_SELECTION) break; this.selected.add(item.id); } this.selectionRevision++; this.message = this.selected.size === MAX_SELECTION ? { key: 'limit' } : null; this.render(); }
    if (action === 'next' || action === 'previous') { this.offset = action === 'next' ? this.offset + PAGE_SIZE : Math.max(0, this.offset - PAGE_SIZE); return this.search(); }
  }
  render() {
    if (this.disposed) return;
    const m = this.model, signature = JSON.stringify([m, this.querying, this.pending, this.selectionRevision, this.pageVersion, this.plan, this.message]);
    if (signature === this.signature) return;
    this.signature = signature; const t = TEXT[m.language], n = this.nodes, locked = this.blocked() || this.querying || Boolean(this.plan), count = value => value.toLocaleString(m.language);
    n.summary.textContent = t.title; for (const key of ['intro', 'history', 'preservation', 'trashHelp', 'selectionHelp']) n[key].textContent = t[key];
    for (const [key, label] of Object.entries(this.labels)) label.textContent = t[key];
    n.searchButton.textContent = t.searchButton; n.reset.textContent = t.reset;
    for (const key of ['selectPage', 'selectResults', 'clear', 'prepare', 'previous', 'next', 'cancel', 'recycle']) n[key].textContent = t[key];
    n.searchButton.disabled = n.reset.disabled = locked; for (const input of Object.values(this.inputs)) input.disabled = locked;
    n.selectedText.textContent = count(this.selected.size) + ' / ' + count(MAX_SELECTION) + ' ' + t.selected;
    n.selectPage.disabled = locked || !this.page?.items.length || this.selected.size >= MAX_SELECTION; n.selectResults.disabled = locked || !this.page?.total;
    n.clear.disabled = locked || !this.selected.size; n.prepare.disabled = locked || !this.selected.size || !this.rootKey;
    n.previous.disabled = locked || this.offset === 0; n.next.disabled = locked || !this.page || this.offset + PAGE_SIZE >= this.page.total;
    n.status.textContent = this.message?.key ? t[this.message.key] : this.message?.recycled !== undefined ? count(this.message.recycled) + ' ' + t.recycled + ' · ' + count(this.message.failed) + ' ' + t.failed + (this.message.stopped ? ' · ' + t.stopped : '')
      : !m.rootPath ? t.noRoot : !m.ready ? t.unavailable : this.querying ? t.loading : this.page ? count(this.page.total) + ' ' + t.results : t.idle;
    n.pageText.textContent = this.page ? t.page + ' ' + count(Math.floor(this.offset / PAGE_SIZE) + 1) + ' ' + t.of + ' ' + count(Math.max(1, Math.ceil(this.page.total / PAGE_SIZE))) : '';
    const rowSignature = JSON.stringify([m.language, this.pageVersion]);
    if (rowSignature !== this.rowSignature) {
      this.rowSignature = rowSignature; for (const [node, type, listener] of this.rowListeners) node.removeEventListener(type, listener); this.rowListeners = []; this.checks.clear();
      n.list.replaceChildren(...(this.page?.items.length ? this.page.items.map(item => {
        const row = this.node('label', 'library-removal-row'), check = this.node('input'), content = this.node('span'), title = this.node('strong'), detail = this.node('span', 'helper-text'), relative = this.node('code');
        check.type = 'checkbox'; check.setAttribute('aria-label', clean(item.title) || clean(item.relativePath)); this.listen(check, 'change', () => this.select(item.id, check.checked), true);
        title.textContent = clean(item.title); detail.textContent = [clean(item.artist), clean(item.album)].filter(Boolean).join(' · '); relative.textContent = clean(item.relativePath, 32768); content.append(title, detail, relative); row.append(check, content); this.checks.set(item.id, check); return row;
      }) : [(() => { const p = this.node('p', 'helper-text'); p.textContent = this.page ? t.empty : ''; return p; })()]));
    }
    for (const [id, check] of this.checks) { check.checked = this.selected.has(id); check.disabled = locked || !check.checked && this.selected.size >= MAX_SELECTION; }
    n.preview.hidden = !this.plan; n.previewTitle.textContent = t.preview;
    if (this.plan) { n.previewSummary.textContent = count(this.plan.eligibleCount) + ' ' + t.eligible + ' · ' + count(this.plan.blockedCount) + ' ' + t.blocked; n.previewSize.textContent = t.size + ' · ' + formatBytes(this.plan.totalBytes, m.language); n.previewLimit.textContent = this.plan.previewTruncated ? t.previewLimit : '';
      const previewSignature = JSON.stringify([m.language, this.plan]); if (previewSignature !== this.previewSignature) { this.previewSignature = previewSignature; n.previewItems.replaceChildren(...this.plan.entries.map(entry => { const li = this.node('li'), name = this.node('code'), state = this.node('strong'); name.textContent = clean(entry.targetRelativePath || entry.relativePath, 32768); state.textContent = entry.eligible ? t.verified : t.kept; li.append(name, state); return li; })); } }
    n.recycle.disabled = this.blocked() || !this.plan?.eligibleCount; n.cancel.disabled = this.pending === 'cancel'; n.cancelPending.textContent = t.cancel; n.cancelPending.hidden = !['prepare', 'recycle', 'cancel'].includes(this.pending); n.cancelPending.disabled = this.pending === 'cancel';
    n.progress.hidden = !['preparing', 'executing'].includes(m.backendPhase); n.progress.textContent = count(integer(m.processed) ? m.processed : 0) + ' / ' + count(integer(m.total) ? m.total : 0);
    this.root.setAttribute('aria-busy', this.pending || this.querying ? 'true' : 'false');
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.queryEpoch++; this.operationEpoch++; for (const [node, type, listener] of [...this.listeners, ...this.rowListeners]) node.removeEventListener(type, listener); this.listeners = []; this.rowListeners = []; }
}
