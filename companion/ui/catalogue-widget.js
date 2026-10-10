import { FloatingPanelsControls, applyFloatingAppearance } from './floating-panels-controls.js';
import { createCatalogueCard } from './catalogue-card.js';

const tabs = ['search', 'downloads', 'recent'];
const chartId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/.test(value);
const downloadId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const states = { Queued: 'En attente', Downloading: 'Téléchargement en cours', Paused: 'En pause', Completed: 'Terminé', Failed: 'Échec', Cancelled: 'Annulé' };
const allowed = { pause: ['Queued', 'Downloading'], resume: ['Paused'], cancel: ['Queued', 'Downloading', 'Paused', 'Failed'], retry: ['Failed', 'Cancelled'] };
const actionLabels = { pause: 'Mettre en pause', resume: 'Reprendre', cancel: 'Annuler', retry: 'Réessayer' };
const text = (value, fallback = '—') => typeof value === 'string' && value.trim() ? value : fallback;

export class CatalogueWidgetControls {
  constructor({ root, command }) {
    this.root = root; this.command = command; this.abort = new AbortController(); this.resultAbort = new AbortController(); this.downloadAbort = new AbortController();
    this.catalogue = null; this.downloads = null; this.snapshotSignature = ''; this.items = []; this.page = 1; this.hasMore = false; this.filters = null;
    this.searchSerial = 0; this.loading = false; this.refreshing = false; this.choosing = false; this.closing = false; this.stale = false; this.disposed = false; this.tab = 'search';
    this.pendingCharts = new Set(); this.pendingDownloads = new Set(); this.expandedCharts = new Set(); this.selectedCharts = new Set(); this.pendingFavorites = new Set();
    this.batchRunning = false; this.batchCancelled = false; this.batchReport = null; this.operationEpoch = 0;
    this.appearance = new FloatingPanelsControls({ root: this.element('#catalogue-widget-appearance-controls'), command, panels: ['catalogue'] });
    const signal = this.abort.signal;
    this.element('#catalogue-widget-search-form').addEventListener('submit', event => { event.preventDefault(); if (this.batchRunning || this.pendingFavorites.size) return; this.filters = this.readFilters(); void this.search(1); }, { signal });
    this.element('#catalogue-widget-refresh').addEventListener('click', () => { void this.refresh(); }, { signal });
    this.element('#catalogue-widget-prev').addEventListener('click', () => { if (this.page > 1) void this.search(this.page - 1); }, { signal });
    this.element('#catalogue-widget-next').addEventListener('click', () => { if (this.hasMore) void this.search(this.page + 1); }, { signal });
    this.element('#catalogue-widget-choose-root').addEventListener('click', () => { void this.chooseRoot(); }, { signal });
    this.element('#catalogue-widget-close').addEventListener('click', () => { void this.close(); }, { signal });
    this.element('#catalogue-widget-download-selected').addEventListener('click', () => { void this.enqueueSelection(); }, { signal });
    this.element('#catalogue-widget-clear-selection').addEventListener('click', () => { if (!this.batchRunning) { this.selectedCharts.clear(); this.batchReport = null; this.renderResults(); } }, { signal });
    this.element('#catalogue-widget-cancel-batch').addEventListener('click', () => { this.batchCancelled = true; this.renderSelection(); }, { signal });
    for (const tab of tabs) {
      this.element(`#catalogue-widget-tab-${tab}`).addEventListener('click', () => this.selectTab(tab), { signal });
      this.element(`#catalogue-widget-tab-${tab}`).addEventListener('keydown', event => {
        const index = tabs.indexOf(tab), next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (next !== null) { event.preventDefault(); this.selectTab(tabs[next]); this.element(`#catalogue-widget-tab-${tabs[next]}`).focus(); }
      }, { signal });
    }
    root.ownerDocument.defaultView?.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void this.close(); } }, { signal });
    root.ownerDocument.defaultView?.addEventListener('chartshub:languagechange', () => { if (!this.disposed) { this.renderFeatureLabels(); this.renderResults(); this.renderDownloads(); } }, { signal });
    this.renderFeatureLabels(); this.selectTab('search'); this.availability();
  }
  element(selector) { const element = this.root.querySelector(selector); if (!element) throw Error(`Missing catalogue widget control: ${selector}`); return element; }
  make(tag, content = '', className = '') { const element = this.root.ownerDocument.createElement(tag); if (content) element.textContent = content; if (className) element.className = className; return element; }
  feedback(message, error = false) { const node = this.element('#catalogue-widget-feedback'); node.textContent = message; node.hidden = !message; node.classList.toggle('is-error', error); }
  locale() { return this.root.ownerDocument.documentElement?.lang?.startsWith('en') ? 'en-US' : 'fr-FR'; }
  tr(fr, en) { return this.locale().startsWith('fr') ? fr : en; }
  renderFeatureLabels() {
    const labels = { 'installed-label': ['Installation', 'Installation'], 'installed-all': ['Toutes les charts', 'All charts'], 'installed-linked': ['Déjà installées', 'Already installed'],
      'installed-unlinked': ['Sans installation confirmée', 'No confirmed installation'], 'favorites-label': ['Favoris', 'Favorites'], 'favorites-all': ['Toutes les charts', 'All charts'], 'favorites-yes': ['Mes favoris', 'My favorites'] };
    for (const [id, labelsForId] of Object.entries(labels)) this.element('#catalogue-widget-' + id).textContent = this.tr(...labelsForId);
  }
  readFilters() {
    const value = field => this.element(`#catalogue-widget-${field}`).value.trim().slice(0, field === 'query' ? 200 : 128);
    const installed = value('installed');
    return { query: value('query'), artist: value('artist'), charter: value('charter'), instrument: value('instrument'), difficulty: value('difficulty'), genre: '', year: '', verified: 'all', installed: ['linked', 'unlinked'].includes(installed) ? installed : 'all', ...(value('favorites') === 'yes' ? { favorites: 'yes' } : {}) };
  }
  resultConditions() {
    const queued = [...new Set((this.downloads?.items ?? []).filter(item => ['Queued', 'Downloading', 'Paused'].includes(item.state)).map(item => item.chartId))].sort();
    return JSON.stringify([this.catalogue, this.stale, this.downloads?.hasRoot, this.downloads?.error, queued]);
  }
  update(snapshot) {
    if (this.disposed || !snapshot) return;
    this.appearance.update(snapshot); applyFloatingAppearance(this.root, snapshot.floatingPanels?.appearance?.catalogue);
    const signature = JSON.stringify([snapshot.catalogue, snapshot.downloads, snapshot.catalogueShortcut]); if (signature === this.snapshotSignature) return;
    this.snapshotSignature = signature;
    const previousConditions = this.resultConditions();
    if (snapshot.catalogue) {
      if (this.catalogue && this.catalogue.revision !== snapshot.catalogue.revision && this.items.length && !this.loading) {
        this.stale = true; this.element('#catalogue-widget-search-status').textContent = 'Le catalogue a changé. Relancez la recherche.';
      }
      this.catalogue = snapshot.catalogue;
    }
    if (snapshot.downloads) this.downloads = snapshot.downloads;
    this.element('#catalogue-widget-root-status').textContent = this.downloads?.hasRoot ? 'Dossier de téléchargement prêt.' : 'Choisissez un dossier de téléchargement.';
    const shortcut = this.element('#catalogue-widget-shortcut');
    shortcut.textContent = snapshot.catalogueShortcut?.registered ? 'Raccourci : Ctrl + Maj + K' : snapshot.catalogueShortcut?.error ? 'Raccourci indisponible. Utilisez le bouton du Companion.' : '';
    // Progress bytes do not affect catalogue cards. Keep their images, bounded
    // retry timers, disclosure state and keyboard focus while the queue updates.
    if (previousConditions !== this.resultConditions()) this.renderResults();
    this.renderDownloads(); this.availability();
  }
  selectTab(tab) {
    if (this.disposed || !tabs.includes(tab)) return;
    this.tab = tab;
    for (const value of tabs) { const selected = tab === value, button = this.element(`#catalogue-widget-tab-${value}`); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; this.element(`#catalogue-widget-${value}-panel`).hidden = !selected; }
  }
  availability() {
    const changing = this.batchRunning || this.pendingFavorites.size > 0;
    this.element('#catalogue-widget-search').disabled = !this.catalogue || this.refreshing || changing;
    this.element('#catalogue-widget-refresh').disabled = !this.catalogue || this.refreshing || changing;
    this.element('#catalogue-widget-prev').disabled = this.loading || this.refreshing || this.stale || changing || this.page <= 1;
    this.element('#catalogue-widget-next').disabled = this.loading || this.refreshing || this.stale || changing || !this.hasMore;
    this.element('#catalogue-widget-choose-root').disabled = !this.downloads || this.choosing || changing;
    this.element('#catalogue-widget-close').disabled = this.closing;
    this.element('#catalogue-widget-results').setAttribute('aria-busy', String(this.loading));
    this.renderSelection();
  }
  async search(page) {
    if (this.disposed || this.closing || this.batchRunning || this.pendingFavorites.size || !this.catalogue || this.refreshing || !this.filters || page < 1 || page > 1000) return;
    const serial = ++this.searchSerial, filters = { ...this.filters, page };
    this.loading = true; this.stale = false; this.items = []; this.expandedCharts.clear(); this.selectedCharts.clear(); this.batchReport = null; this.renderResults(); this.feedback(''); this.element('#catalogue-widget-search-status').textContent = 'Recherche en cours…'; this.availability();
    try {
      const response = await this.command('catalogue.search', filters);
      if (this.disposed || serial !== this.searchSerial) return;
      const result = response?.result;
      if (!response?.ok || !result || !Array.isArray(result.items) || result.items.length > 20 || result.items.some(item => !item || !chartId(item.id)) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || typeof result.hasMore !== 'boolean') throw Error(response?.error || 'La recherche est indisponible. Réessayez.');
      this.items = result.items; this.page = page; this.hasMore = result.hasMore;
      this.element('#catalogue-widget-search-status').textContent = result.items.length ? `${result.total.toLocaleString(this.locale())} résultat(s)` : 'Aucun résultat. Modifiez votre recherche.';
      this.element('#catalogue-widget-page').textContent = result.total ? `Page ${page.toLocaleString(this.locale())}` : '';
    } catch (failure) {
      if (this.disposed || serial !== this.searchSerial) return;
      this.items = []; this.hasMore = false; this.element('#catalogue-widget-page').textContent = ''; this.element('#catalogue-widget-search-status').textContent = 'Recherche indisponible'; this.feedback(failure instanceof Error ? failure.message : 'La recherche est indisponible. Réessayez.', true);
    } finally { if (!this.disposed && serial === this.searchSerial) { this.loading = false; this.renderResults(); this.availability(); } }
  }
  renderResults() {
    this.resultAbort.abort(); this.resultAbort = new AbortController(); const container = this.element('#catalogue-widget-results'); container.textContent = '';
    for (const id of this.selectedCharts) if (!this.availableToDownload(this.items.find(item => item.id === id))) this.selectedCharts.delete(id);
    for (const item of this.items) {
      const { card, body } = createCatalogueCard(this.root.ownerDocument, item, { locale: this.locale(), demo: !!this.catalogue?.demo, signal: this.resultAbort.signal,
        expanded: this.expandedCharts.has(item.id), onToggle: open => { if (open) this.expandedCharts.add(item.id); else this.expandedCharts.delete(item.id); } });
      const favorite = this.make('button', item.favorite === true ? '★' : '☆', 'catalogue-favorite'); favorite.type = 'button'; favorite.dataset.chartId = item.id;
      favorite.setAttribute('aria-pressed', String(item.favorite === true)); favorite.setAttribute('aria-label', this.tr(item.favorite === true ? 'Retirer des favoris' : 'Ajouter aux favoris', item.favorite === true ? 'Remove from favorites' : 'Add to favorites') + ' : ' + text(item.title));
      favorite.disabled = !!this.catalogue?.demo || this.loading || this.stale || this.batchRunning || this.pendingFavorites.size > 0 || this.closing;
      favorite.addEventListener('click', () => { void this.setFavorite(item.id); }, { signal: this.resultAbort.signal });
      const selection = this.make('label', '', 'catalogue-selection-label'), checkbox = this.make('input', '', 'catalogue-selection-check'); checkbox.type = 'checkbox'; checkbox.dataset.chartId = item.id; checkbox.checked = this.selectedCharts.has(item.id);
      checkbox.setAttribute('aria-label', this.tr('Sélectionner', 'Select') + ' : ' + text(item.title)); checkbox.disabled = !this.canDownload(item) || this.pendingCharts.has(item.id) || this.batchRunning || this.pendingFavorites.size > 0;
      checkbox.addEventListener('change', () => { if (!checkbox.disabled && this.canDownload(item)) { if (checkbox.checked) this.selectedCharts.add(item.id); else this.selectedCharts.delete(item.id); this.batchReport = null; this.renderSelection(); } }, { signal: this.resultAbort.signal });
      selection.append(checkbox, this.make('span', this.tr('Sélectionner', 'Select')));
      const controls = this.make('div', '', 'catalogue-card-controls'); controls.append(favorite, selection); body.append(controls);
      const queued = this.isQueued(item.id);
      const button = this.make('button', queued ? 'Déjà dans la file' : 'Télécharger', 'catalogue-download-single'); button.type = 'button'; button.dataset.chartId = item.id;
      button.disabled = !this.canDownload(item) || this.pendingCharts.has(item.id) || this.batchRunning || this.pendingFavorites.size > 0;
      button.addEventListener('click', () => { void this.enqueue(item.id); }, { signal: this.resultAbort.signal }); body.append(button); container.append(card);
    }
    this.renderSelection();
  }
  isQueued(id) { return this.downloads?.items?.some(value => value.chartId === id && ['Queued', 'Downloading', 'Paused'].includes(value.state)); }
  availableToDownload(item) { return !!item && chartId(item.id) && item.downloadable === true && !this.catalogue?.demo && !!this.downloads?.hasRoot && !this.isQueued(item.id); }
  canDownload(item) { return this.availableToDownload(item) && !this.loading && !this.stale && !this.closing && !this.disposed; }
  renderSelection() {
    const selected = this.items.filter(item => this.selectedCharts.has(item.id));
    const panel = this.element('#catalogue-widget-selection'), count = selected.length;
    const canStart = count > 0 && !this.batchRunning && !this.pendingFavorites.size && !this.pendingCharts.size && selected.every(item => this.canDownload(item));
    const signature = JSON.stringify([selected.map(item => [item.id, item.title, item.artist]), this.locale(), this.batchRunning, this.batchCancelled, this.batchReport, canStart]);
    if (signature === this.selectionSignature) return;
    this.selectionSignature = signature;
    panel.hidden = !count && !this.batchRunning && !this.batchReport;
    this.element('#catalogue-widget-selection-summary').textContent = this.tr(`${count} chart${count === 1 ? '' : 's'} sélectionnée${count === 1 ? '' : 's'}`, `${count} selected chart${count === 1 ? '' : 's'}`);
    const list = this.element('#catalogue-widget-selection-items'); list.textContent = '';
    for (const item of selected) list.append(this.make('li', `${text(item.title)} · ${text(item.artist)}`));
    const start = this.element('#catalogue-widget-download-selected'); start.textContent = this.tr(`Télécharger la sélection (${count})`, `Download selection (${count})`);
    start.disabled = !canStart;
    const clear = this.element('#catalogue-widget-clear-selection'); clear.textContent = this.tr('Effacer la sélection', 'Clear selection'); clear.disabled = !count || this.batchRunning;
    const cancel = this.element('#catalogue-widget-cancel-batch'); cancel.textContent = this.tr('Arrêter les ajouts restants', 'Stop remaining additions'); cancel.hidden = !this.batchRunning; cancel.disabled = this.batchCancelled;
    const report = this.element('#catalogue-widget-batch-status'); report.hidden = !this.batchReport;
    if (this.batchReport) {
      const { added, failed, skipped } = this.batchReport;
      report.textContent = this.tr(`${added} ajout(s) à la file · ${failed} échec(s) · ${skipped} ignorée(s).`, `${added} added to queue · ${failed} failed · ${skipped} skipped.`) +
        (this.batchCancelled ? this.tr(' Ajouts restants arrêtés. Un ajout déjà en cours peut encore se terminer.', ' Remaining additions stopped. An addition already in progress may still finish.') : '') +
        (!this.batchRunning && count ? this.tr(' Les charts restantes restent sélectionnées.', ' Remaining charts stay selected.') : '');
    }
  }
  async setFavorite(id) {
    const item = this.items.find(value => value.id === id);
    if (this.disposed || this.closing || !item || this.pendingFavorites.size || this.batchRunning || this.loading || this.stale || this.catalogue?.demo) return;
    const favorite = item.favorite !== true, epoch = this.operationEpoch;
    this.pendingFavorites.add(id); this.renderResults(); this.availability(); this.feedback(''); let saved = false;
    try {
      const response = await this.command('catalogue.favorite', { chartId: id, favorite });
      if (this.disposed || epoch !== this.operationEpoch) return;
      if (!response?.ok || response.result?.chartId !== id || response.result?.favorite !== favorite) throw Error('favorite');
      item.favorite = favorite; saved = true;
    } catch (_) { if (!this.disposed && epoch === this.operationEpoch) this.feedback(this.tr('Le favori n’a pas pu être enregistré. Réessayez.', 'The favorite could not be saved. Try again.'), true); }
    finally { this.pendingFavorites.delete(id); if (!this.disposed) { this.renderResults(); this.availability(); } }
    if (saved && epoch === this.operationEpoch) await this.search(this.page);
  }
  async enqueueSelection() {
    if (this.disposed || this.closing || this.batchRunning || this.pendingFavorites.size || this.pendingCharts.size) return;
    const ids = this.items.filter(item => this.selectedCharts.has(item.id) && this.canDownload(item)).map(item => item.id);
    if (!ids.length) return;
    const epoch = this.operationEpoch; this.batchRunning = true; this.batchCancelled = false; this.batchReport = { added: 0, failed: 0, skipped: 0 }; this.feedback(''); this.renderResults(); this.availability();
    try {
      for (const id of ids) {
        if (this.disposed || this.batchCancelled || epoch !== this.operationEpoch) break;
        const item = this.items.find(value => value.id === id);
        if (!this.selectedCharts.has(id) || !this.canDownload(item)) { this.selectedCharts.delete(id); this.batchReport.skipped++; continue; }
        this.pendingCharts.add(id);
        try {
          const response = await this.command('downloads.enqueue', { chartId: id });
          if (this.disposed) return;
          if (response?.cancelled) this.batchCancelled = true;
          else if (response?.ok) { this.selectedCharts.delete(id); this.batchReport.added++; }
          else this.batchReport.failed++;
        } catch (_) { if (!this.disposed) this.batchReport.failed++; }
        finally { this.pendingCharts.delete(id); }
        if (!this.disposed) this.renderSelection();
      }
    } finally { this.batchRunning = false; if (!this.disposed) { this.renderResults(); this.availability(); } }
  }
  async enqueue(id) {
    const item = this.items.find(value => value.id === id);
    if (!this.canDownload(item) || this.pendingCharts.has(id) || this.batchRunning || this.pendingFavorites.size) return;
    this.pendingCharts.add(id); this.renderResults(); this.feedback('');
    try { const response = await this.command('downloads.enqueue', { chartId: id }); if (!this.disposed) { if (!response?.ok) this.feedback(response?.error || 'Le téléchargement n’a pas pu être ajouté.', true); else this.feedback('Chart ajoutée aux téléchargements.'); } }
    catch (_) { if (!this.disposed) this.feedback('Le téléchargement n’a pas pu être ajouté.', true); }
    finally { this.pendingCharts.delete(id); if (!this.disposed) this.renderResults(); }
  }
  async refresh() {
    if (this.disposed || this.closing || this.refreshing || this.batchRunning || this.pendingFavorites.size) return;
    this.refreshing = true; this.searchSerial++; this.loading = false; this.items = []; this.selectedCharts.clear(); this.batchReport = null; this.hasMore = false; this.renderResults(); this.availability(); this.feedback('Actualisation du catalogue…');
    try { const response = await this.command('catalogue.refresh'); if (!this.disposed) this.feedback(response?.ok ? 'Catalogue actualisé. Lancez une recherche.' : response?.error || 'Le catalogue ne peut pas être actualisé.', !response?.ok); }
    catch (_) { if (!this.disposed) this.feedback('Le catalogue ne peut pas être actualisé.', true); }
    finally { if (!this.disposed) { this.refreshing = false; this.availability(); } }
  }
  async chooseRoot() {
    if (this.disposed || this.choosing || this.batchRunning || this.pendingFavorites.size) return;
    this.choosing = true; this.availability();
    try { const response = await this.command('downloads.chooseRoot'); if (!this.disposed && !response?.ok) this.feedback(response?.error || 'Le dossier de téléchargement n’a pas pu être choisi.', true); }
    catch (_) { if (!this.disposed) this.feedback('Le dossier de téléchargement n’a pas pu être choisi.', true); }
    finally { if (!this.disposed) { this.choosing = false; this.availability(); } }
  }
  renderDownloads() {
    this.downloadAbort.abort(); this.downloadAbort = new AbortController();
    const queue = this.element('#catalogue-widget-downloads'), recent = this.element('#catalogue-widget-recent'); queue.textContent = ''; recent.textContent = '';
    const items = Array.isArray(this.downloads?.items) ? this.downloads.items.filter(item => downloadId(item?.id) && Object.hasOwn(states, item.state)).slice(0, 100) : [];
    const completed = items.filter(item => item.state === 'Completed').sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)).slice(0, 20);
    const active = items.filter(item => item.state !== 'Completed');
    this.element('#catalogue-widget-queue-status').textContent = active.length ? 'File de téléchargements' : 'Aucun téléchargement en cours.';
    this.element('#catalogue-widget-recent-status').textContent = completed.length ? 'Derniers téléchargements terminés' : 'Aucun téléchargement terminé.';
    for (const item of [...active, ...completed]) {
      const card = this.make('article', '', 'download-item floating-download-item'); card.dataset.downloadId = item.id;
      card.append(this.make('h3', text(item.title)), this.make('p', text(item.artist), 'catalogue-item-artist'), this.make('p', states[item.state]));
      if (item.state === 'Downloading' || item.state === 'Paused' || item.state === 'Queued') {
        const progress = this.make('progress'); progress.max = 100; progress.setAttribute('aria-label', 'Progression du téléchargement');
        if (Number.isFinite(item.totalBytes) && item.totalBytes > 0 && Number.isFinite(item.receivedBytes)) progress.value = Math.min(100, Math.max(0, item.receivedBytes / item.totalBytes * 100));
        card.append(progress);
      }
      if (item.error) card.append(this.make('p', text(item.error)));
      if (item.state === 'Completed') {
        const date = this.make('time'), parsed = new Date(item.updatedAt); date.dateTime = item.updatedAt;
        date.textContent = Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(this.locale()) : '—'; card.append(date);
      } else {
        const actions = this.make('div', '', 'catalogue-widget-actions');
        for (const action of Object.keys(allowed)) if (allowed[action].includes(item.state)) {
          const button = this.make('button', actionLabels[action]); button.type = 'button'; button.dataset.action = action; button.disabled = this.pendingDownloads.has(item.id);
          button.addEventListener('click', () => { void this.downloadAction(action, item.id); }, { signal: this.downloadAbort.signal }); actions.append(button);
        }
        card.append(actions);
      }
      (item.state === 'Completed' ? recent : queue).append(card);
    }
  }
  async downloadAction(action, id) {
    const item = this.downloads?.items?.find(value => value.id === id);
    if (this.disposed || !item || !allowed[action]?.includes(item.state) || this.pendingDownloads.has(id)) return;
    this.pendingDownloads.add(id); this.renderDownloads();
    try { const response = await this.command(`downloads.${action}`, { id }); if (!this.disposed && !response?.ok) this.feedback(response?.error || 'Cette action de téléchargement n’a pas pu être appliquée.', true); }
    catch (_) { if (!this.disposed) this.feedback('Cette action de téléchargement n’a pas pu être appliquée.', true); }
    finally { this.pendingDownloads.delete(id); if (!this.disposed) this.renderDownloads(); }
  }
  async close() {
    if (this.disposed || this.closing) return; this.closing = true; this.operationEpoch++; this.batchCancelled = true; this.availability();
    try { const response = await this.command('catalogue.widget', { enabled: false }); if (!this.disposed && !response?.ok) this.feedback('La fenêtre n’a pas pu être masquée.', true); }
    catch (_) { if (!this.disposed) this.feedback('La fenêtre n’a pas pu être masquée.', true); }
    finally { if (!this.disposed) { this.closing = false; this.availability(); } }
  }
  dispose() { this.disposed = true; this.searchSerial++; this.operationEpoch++; this.batchCancelled = true; this.abort.abort(); this.resultAbort.abort(); this.downloadAbort.abort(); this.appearance.dispose(); }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.querySelector('#catalogue-widget-app')) {
  const api = window.ChartsHubCompanion; let disposed = false, received = false, unsubscribe = () => {};
  const controls = new CatalogueWidgetControls({ root: document.querySelector('#catalogue-widget-app'), command: async (name, payload) => {
    const result = await api.command(name, payload); if (!disposed) update(await api.getSnapshot()); return result;
  } });
  function update(snapshot) {
    if (!snapshot || disposed) return;
    if (snapshot.language && window.ChartshubCompanionLanguage?.get() !== snapshot.language) window.ChartshubCompanionLanguage?.apply(snapshot.language);
    controls.update(snapshot);
  }
  async function connect() {
    if (!api) { controls.feedback('La connexion au Companion est indisponible.', true); return; }
    try { unsubscribe = api.subscribe(snapshot => { received = true; update(snapshot); }); const snapshot = await api.getSnapshot(); if (!received) update(snapshot); }
    catch (_) { if (!disposed) controls.feedback('La connexion au Companion est indisponible.', true); }
  }
  window.addEventListener('beforeunload', () => { disposed = true; unsubscribe(); controls.dispose(); }, { once: true });
  void connect();
}
