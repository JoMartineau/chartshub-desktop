import { FloatingPanelsControls, applyFloatingAppearance } from './floating-panels-controls.js';

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
    this.pendingCharts = new Set(); this.pendingDownloads = new Set();
    this.appearance = new FloatingPanelsControls({ root: this.element('#catalogue-widget-appearance-controls'), command, panels: ['catalogue'] });
    const signal = this.abort.signal;
    this.element('#catalogue-widget-search-form').addEventListener('submit', event => { event.preventDefault(); this.filters = this.readFilters(); void this.search(1); }, { signal });
    this.element('#catalogue-widget-refresh').addEventListener('click', () => { void this.refresh(); }, { signal });
    this.element('#catalogue-widget-prev').addEventListener('click', () => { if (this.page > 1) void this.search(this.page - 1); }, { signal });
    this.element('#catalogue-widget-next').addEventListener('click', () => { if (this.hasMore) void this.search(this.page + 1); }, { signal });
    this.element('#catalogue-widget-choose-root').addEventListener('click', () => { void this.chooseRoot(); }, { signal });
    this.element('#catalogue-widget-close').addEventListener('click', () => { void this.close(); }, { signal });
    for (const tab of tabs) {
      this.element(`#catalogue-widget-tab-${tab}`).addEventListener('click', () => this.selectTab(tab), { signal });
      this.element(`#catalogue-widget-tab-${tab}`).addEventListener('keydown', event => {
        const index = tabs.indexOf(tab), next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (next !== null) { event.preventDefault(); this.selectTab(tabs[next]); this.element(`#catalogue-widget-tab-${tabs[next]}`).focus(); }
      }, { signal });
    }
    root.ownerDocument.defaultView?.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void this.close(); } }, { signal });
    root.ownerDocument.defaultView?.addEventListener('chartshub:languagechange', () => { if (!this.disposed) this.renderDownloads(); }, { signal });
    this.selectTab('search'); this.availability();
  }
  element(selector) { const element = this.root.querySelector(selector); if (!element) throw Error(`Missing catalogue widget control: ${selector}`); return element; }
  make(tag, content = '', className = '') { const element = this.root.ownerDocument.createElement(tag); if (content) element.textContent = content; if (className) element.className = className; return element; }
  feedback(message, error = false) { const node = this.element('#catalogue-widget-feedback'); node.textContent = message; node.hidden = !message; node.classList.toggle('is-error', error); }
  locale() { return this.root.ownerDocument.documentElement?.lang?.startsWith('en') ? 'en-US' : 'fr-FR'; }
  readFilters() {
    const value = field => this.element(`#catalogue-widget-${field}`).value.trim().slice(0, field === 'query' ? 200 : 128);
    return { query: value('query'), artist: value('artist'), charter: value('charter'), instrument: value('instrument'), difficulty: value('difficulty'), genre: '', year: '', verified: 'all', installed: 'all' };
  }
  update(snapshot) {
    if (this.disposed || !snapshot) return;
    this.appearance.update(snapshot); applyFloatingAppearance(this.root, snapshot.floatingPanels?.appearance?.catalogue);
    const signature = JSON.stringify([snapshot.catalogue, snapshot.downloads, snapshot.catalogueShortcut]); if (signature === this.snapshotSignature) return;
    this.snapshotSignature = signature;
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
    this.renderResults(); this.renderDownloads(); this.availability();
  }
  selectTab(tab) {
    if (this.disposed || !tabs.includes(tab)) return;
    this.tab = tab;
    for (const value of tabs) { const selected = tab === value, button = this.element(`#catalogue-widget-tab-${value}`); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; this.element(`#catalogue-widget-${value}-panel`).hidden = !selected; }
  }
  availability() {
    this.element('#catalogue-widget-search').disabled = !this.catalogue || this.refreshing;
    this.element('#catalogue-widget-refresh').disabled = !this.catalogue || this.refreshing;
    this.element('#catalogue-widget-prev').disabled = this.loading || this.refreshing || this.stale || this.page <= 1;
    this.element('#catalogue-widget-next').disabled = this.loading || this.refreshing || this.stale || !this.hasMore;
    this.element('#catalogue-widget-choose-root').disabled = !this.downloads || this.choosing;
    this.element('#catalogue-widget-close').disabled = this.closing;
    this.element('#catalogue-widget-results').setAttribute('aria-busy', String(this.loading));
  }
  async search(page) {
    if (this.disposed || !this.catalogue || this.refreshing || !this.filters || page < 1 || page > 1000) return;
    const serial = ++this.searchSerial, filters = { ...this.filters, page };
    this.loading = true; this.stale = false; this.items = []; this.renderResults(); this.feedback(''); this.element('#catalogue-widget-search-status').textContent = 'Recherche en cours…'; this.availability();
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
    for (const item of this.items) {
      const card = this.make('article', '', 'catalogue-item floating-catalogue-item'); card.dataset.chartId = item.id;
      card.append(this.make('h3', text(item.title)), this.make('p', text(item.artist), 'catalogue-item-artist'), this.make('p', text(item.charter), 'catalogue-item-details'));
      const queued = this.downloads?.items?.some(value => value.chartId === item.id && ['Queued', 'Downloading', 'Paused'].includes(value.state));
      const button = this.make('button', queued ? 'Déjà dans la file' : 'Télécharger'); button.type = 'button'; button.dataset.chartId = item.id;
      button.disabled = !item.downloadable || !!this.catalogue?.demo || !this.downloads?.hasRoot || queued || this.pendingCharts.has(item.id) || this.loading || this.stale;
      button.addEventListener('click', () => { void this.enqueue(item.id); }, { signal: this.resultAbort.signal }); card.append(button); container.append(card);
    }
  }
  async enqueue(id) {
    const item = this.items.find(value => value.id === id);
    if (this.disposed || !item?.downloadable || this.catalogue?.demo || !this.downloads?.hasRoot || this.pendingCharts.has(id) || this.loading || this.stale) return;
    this.pendingCharts.add(id); this.renderResults(); this.feedback('');
    try { const response = await this.command('downloads.enqueue', { chartId: id }); if (!this.disposed) { if (!response?.ok) this.feedback(response?.error || 'Le téléchargement n’a pas pu être ajouté.', true); else this.feedback('Chart ajoutée aux téléchargements.'); } }
    catch (_) { if (!this.disposed) this.feedback('Le téléchargement n’a pas pu être ajouté.', true); }
    finally { this.pendingCharts.delete(id); if (!this.disposed) this.renderResults(); }
  }
  async refresh() {
    if (this.disposed || this.refreshing) return;
    this.refreshing = true; this.searchSerial++; this.loading = false; this.items = []; this.hasMore = false; this.renderResults(); this.availability(); this.feedback('Actualisation du catalogue…');
    try { const response = await this.command('catalogue.refresh'); if (!this.disposed) this.feedback(response?.ok ? 'Catalogue actualisé. Lancez une recherche.' : response?.error || 'Le catalogue ne peut pas être actualisé.', !response?.ok); }
    catch (_) { if (!this.disposed) this.feedback('Le catalogue ne peut pas être actualisé.', true); }
    finally { if (!this.disposed) { this.refreshing = false; this.availability(); } }
  }
  async chooseRoot() {
    if (this.disposed || this.choosing) return;
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
    if (this.disposed || this.closing) return; this.closing = true; this.availability();
    try { const response = await this.command('catalogue.widget', { enabled: false }); if (!this.disposed && !response?.ok) this.feedback('La fenêtre n’a pas pu être masquée.', true); }
    catch (_) { if (!this.disposed) this.feedback('La fenêtre n’a pas pu être masquée.', true); }
    finally { if (!this.disposed) { this.closing = false; this.availability(); } }
  }
  dispose() { this.disposed = true; this.searchSerial++; this.abort.abort(); this.resultAbort.abort(); this.downloadAbort.abort(); this.appearance.dispose(); }
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
