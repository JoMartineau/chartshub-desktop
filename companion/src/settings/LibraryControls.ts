import { DuplicateComparisonControls } from './DuplicateComparisonControls.js';

interface LibrarySummary {
  settings: { rootPath: string | null; watch: boolean; refreshOnStart: boolean };
  status: 'idle' | 'scanning' | 'ready' | 'cancelled' | 'error';
  mode: 'full' | 'quick' | null;
  progress: { visited: number; processed: number; discovered: number };
  count: number;
  lastScanAt: string | number | null;
  changes: { added: number; removed: number; modified: number };
  warningCount: number;
  skippedCount: number;
  error: string | null;
  watcher: 'off' | 'watching' | 'unavailable';
  revision: number;
  duplicateVerification?: { running: boolean; stopping?: boolean; processed: number; total: number } | null;
}
interface LibraryItem {
  id: string; relativePath: string; title: string; artist: string; charter: string;
  album?: string; year?: string | number;
  format: 'chart' | 'midi' | 'sng'; audio: 'present' | 'missing' | 'unknown';
  duplicateCount?: number;
  duplicateVerification?: 'ready' | 'needs_keeper' | 'blocked';
  verifiedEligibleCopies?: number;
}
interface LibraryQueryResult { items: LibraryItem[]; total: number; offset: number; limit: number; revision: number; }
interface LibraryResponse { ok: boolean; result?: LibraryQueryResult; error?: string; }
interface BulkDuplicateResult {
  revision: number; totalGroups: number; processedGroups: number; cancelled: boolean;
  readyGroups: number; needsKeeperGroups: number; blockedGroups: number; eligibleCopies: number;
}
interface LibraryOptions { root: HTMLElement; command: (name: string, payload?: unknown) => Promise<unknown>; }
interface LibraryRow {
  row: HTMLTableRowElement; title: HTMLElement; path: HTMLElement; duplicate: HTMLElement; artist: HTMLElement;
  charter: HTMLElement; format: HTMLElement; audio: HTMLElement; open: HTMLButtonElement; catalogue: HTMLButtonElement; compare: HTMLButtonElement;
}
type Sort = 'title' | 'artist' | 'charter';
type AudioFilter = 'all' | 'missing' | 'present' | 'unknown';
type DuplicateFilter = 'all' | 'possible';
const locale = (): string => typeof document === 'undefined' || document.documentElement.lang.startsWith('fr') ? 'fr-FR' : 'en-US';
const count = (value: number): string => Math.max(0, Math.trunc(value || 0)).toLocaleString(locale());
const text = (value: unknown, fallback = '—'): string => typeof value === 'string' && value.trim() ? value : fallback;

/** Reads paginated index results; gameplay-only snapshots never requery the library. */
export class LibraryControls {
  private readonly comparison: DuplicateComparisonControls;
  private readonly abort = new AbortController();
  private readonly pendingActions = new Map<number, string>();
  private readonly rows = new Map<string, LibraryRow>();
  private summary: LibrarySummary | null = null;
  private summarySignature = '';
  private observedIndex = '';
  private query = '';
  private sort: Sort = 'title';
  private audio: AudioFilter = 'all';
  private duplicates: DuplicateFilter = 'all';
  private offset = 0;
  private readonly limit = 50;
  private items: LibraryItem[] = [];
  private total = 0;
  private querySerial = 0;
  private queryTimer: ReturnType<typeof setTimeout> | null = null;
  private querying = false;
  private queryError = false;
  private hasResult = false;
  private staleRetries = 0;
  private actionSerial = 0;
  private bulkSerial = 0;
  private bulkPending = false;
  private bulkCancelling = false;
  private bulkResult: BulkDuplicateResult | null = null;
  private bulkMessage = '';
  private bulkError = false;
  private disposed = false;

  constructor(private readonly options: LibraryOptions) {
    this.comparison = new DuplicateComparisonControls({ ...options, feedback: message => this.feedback(message) });
    const signal = this.abort.signal;
    this.element('#library-choose-root').addEventListener('click', () => { void this.action('library.chooseRoot', {}); }, { signal });
    this.element('#library-scan-full').addEventListener('click', () => { void this.action('library.scan', { mode: 'full' }); }, { signal });
    this.element('#library-refresh').addEventListener('click', () => { void this.action('library.scan', { mode: 'quick' }); }, { signal });
    this.element('#library-cancel').addEventListener('click', () => { void this.action('library.cancel', {}); }, { signal });
    for (const id of ['#library-watch', '#library-refresh-on-start']) {
      this.element(id).addEventListener('change', () => {
        void this.action('library.settings', {
          watch: this.element<HTMLInputElement>('#library-watch').checked,
          refreshOnStart: this.element<HTMLInputElement>('#library-refresh-on-start').checked,
        });
      }, { signal });
    }
    const search = this.element<HTMLInputElement>('#library-search');
    search.addEventListener('input', () => this.setQuery(search.value), { signal });
    search.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.scheduleQuery(0); }
      else if (event.key === 'Escape' && search.value) { event.preventDefault(); search.value = ''; this.setQuery(''); }
    }, { signal });
    this.element('#library-clear-search').addEventListener('click', () => { search.value = ''; this.setQuery(''); search.focus(); }, { signal });
    this.element<HTMLSelectElement>('#library-sort').addEventListener('change', event => {
      const value = (event.target as HTMLSelectElement).value;
      if (value !== 'title' && value !== 'artist' && value !== 'charter') return;
      if (value === this.sort) return;
      this.sort = value; this.offset = 0; this.staleRetries = 0; this.scheduleQuery(0);
    }, { signal });
    this.element<HTMLSelectElement>('#library-audio').addEventListener('change', event => {
      const value = (event.target as HTMLSelectElement).value;
      if (value !== 'all' && value !== 'missing' && value !== 'present' && value !== 'unknown') return;
      if (value === this.audio) return;
      this.audio = value; this.offset = 0; this.staleRetries = 0; this.scheduleQuery(0);
    }, { signal });
    this.element<HTMLSelectElement>('#library-duplicates').addEventListener('change', event => {
      const value = (event.target as HTMLSelectElement).value;
      if (value !== 'all' && value !== 'possible') return;
      if (value === this.duplicates) return;
      this.duplicates = value; this.offset = 0; this.staleRetries = 0; this.scheduleQuery(0);
    }, { signal });
    this.element('#library-clear-filters').addEventListener('click', () => {
      this.audio = 'all'; this.duplicates = 'all'; this.offset = 0; this.staleRetries = 0;
      this.element<HTMLSelectElement>('#library-audio').value = 'all';
      this.element<HTMLSelectElement>('#library-duplicates').value = 'all';
      this.scheduleQuery(0);
    }, { signal });
    this.element('#library-prev').addEventListener('click', () => { this.offset = Math.max(0, this.offset - this.limit); this.scheduleQuery(0); }, { signal });
    this.element('#library-next').addEventListener('click', () => { if (this.offset + this.limit < this.total) { this.offset += this.limit; this.scheduleQuery(0); } }, { signal });
    this.element('#library-query-retry').addEventListener('click', () => { this.staleRetries = 0; this.scheduleQuery(0); }, { signal });
    this.element('#library-verify-all-duplicates').addEventListener('click', () => { void this.verifyAllDuplicates(); }, { signal });
    this.element('#library-cancel-duplicate-verification').addEventListener('click', () => { void this.cancelDuplicateVerification(); }, { signal });
    this.refreshAvailability();
    this.renderBulkVerification();
  }

  update(snapshot: { library?: LibrarySummary }): void {
    if (this.disposed || !snapshot.library) return;
    const signature = JSON.stringify(snapshot.library);
    if (signature === this.summarySignature) return;
    this.summarySignature = signature;
    const previousRoot = this.summary?.settings.rootPath;
    this.summary = snapshot.library;
    this.renderSummary();
    const index = `${this.summary.settings.rootPath ?? ''}\u0000${this.summary.revision}`;
    if (index !== this.observedIndex) {
      this.observedIndex = index; this.staleRetries = 0; this.bulkResult = null; this.bulkMessage = ''; this.bulkError = false;
      if (previousRoot !== this.summary.settings.rootPath) {
        this.offset = 0; this.items = []; this.total = 0; this.hasResult = false;
        this.renderRows();
      }
      this.scheduleQuery(0);
    }
    this.refreshAvailability();
    this.renderResultsStatus();
    this.renderBulkVerification();
  }

  dispose(): void {
    this.disposed = true; this.abort.abort(); this.querySerial++; this.bulkSerial++;
    this.comparison.dispose();
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = null; this.rows.clear();
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.options.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing library control: ${selector}`);
    return element;
  }

  private feedback(message: string, error = false): void {
    const element = this.element('#library-feedback'); element.textContent = message; element.hidden = !message;
    element.classList.toggle('is-error', error);
  }

  private setQuery(value: string): void {
    const query = value.slice(0, 200);
    if (query === this.query) return;
    this.query = query; this.offset = 0; this.staleRetries = 0; this.scheduleQuery(220);
  }

  private scheduleQuery(delay: number): void {
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = null;
    const serial = ++this.querySerial;
    this.queryError = false;
    if (this.disposed || !this.summary?.settings.rootPath) {
      this.querying = false; this.items = []; this.total = 0; this.hasResult = false;
      this.renderRows(); this.renderResultsStatus(); this.refreshAvailability(); return;
    }
    this.querying = true; this.renderResultsStatus(); this.refreshAvailability();
    this.queryTimer = setTimeout(() => { this.queryTimer = null; void this.requestPage(serial); }, delay);
  }

  private async requestPage(serial: number): Promise<void> {
    if (this.disposed || serial !== this.querySerial || !this.summary?.settings.rootPath) return;
    const root = this.summary.settings.rootPath;
    try {
      const response = await this.options.command('library.query', { query: this.query, sort: this.sort, audio: this.audio, duplicates: this.duplicates, offset: this.offset, limit: this.limit }) as LibraryResponse | undefined;
      if (this.disposed || serial !== this.querySerial || root !== this.summary?.settings.rootPath) return;
      const result = response?.result;
      if (!response?.ok || !result || !Array.isArray(result.items)) throw Error('Library query unavailable');
      if (result.revision !== this.summary.revision) {
        if (this.staleRetries++ < 2) { this.scheduleQuery(100); return; }
        throw Error('Library index changed');
      }
      this.staleRetries = 0;
      this.total = Math.max(0, Math.trunc(result.total));
      this.offset = Math.max(0, Math.trunc(result.offset));
      if (!result.items.length && this.total > 0 && this.offset >= this.total) {
        this.offset = Math.floor((this.total - 1) / this.limit) * this.limit; this.scheduleQuery(0); return;
      }
      this.items = result.items.slice(0, this.limit); this.hasResult = true; this.queryError = false;
      this.renderRows();
    } catch {
      if (this.disposed || serial !== this.querySerial) return;
      this.queryError = true; this.items = []; this.total = 0; this.hasResult = false; this.renderRows();
    } finally {
      if (!this.disposed && serial === this.querySerial) {
        this.querying = false; this.renderResultsStatus(); this.refreshAvailability();
      }
    }
  }

  private async action(name: string, payload: unknown): Promise<void> {
    if (!this.summary || this.disposed) return;
    if (name === 'library.cancel') {
      if (this.summary.status !== 'scanning' || [...this.pendingActions.values()].includes(name)) return;
    } else if (this.pendingActions.size || (this.summary.status === 'scanning' && name !== 'library.openFolder')) return;
    const serial = ++this.actionSerial;
    const previousRoot = this.summary.settings.rootPath;
    this.pendingActions.set(serial, name); this.feedback(''); this.refreshAvailability();
    try {
      const response = await this.options.command(name, payload) as LibraryResponse | undefined;
      if (this.disposed) return;
      if (!response?.ok) this.feedback('Cette action n’a pas pu être terminée. Vérifiez le dossier sélectionné et réessayez.', true);
      else if (name === 'library.settings') this.feedback('Options de bibliothèque enregistrées.');
      else if (name === 'library.chooseRoot' && previousRoot !== this.summary.settings.rootPath) this.feedback('Dossier Songs sélectionné. Son analyse démarre automatiquement.');
      else if (name === 'library.cancel') this.feedback('Annulation demandée. Les résultats déjà enregistrés restent disponibles.');
    } catch { if (!this.disposed) this.feedback('La bibliothèque ne répond pas à cette action. Réessayez dans un instant.', true); }
    finally {
      this.pendingActions.delete(serial);
      if (!this.disposed) { this.renderSummary(); this.refreshAvailability(); }
    }
  }

  private async verifyAllDuplicates(): Promise<void> {
    const summary = this.summary;
    if (!summary?.settings.rootPath || this.disposed || summary.status === 'scanning' || this.bulkPending || this.pendingActions.size) return;
    const serial = ++this.bulkSerial, root = summary.settings.rootPath, revision = summary.revision;
    this.bulkPending = true; this.bulkCancelling = false; this.bulkResult = null; this.bulkMessage = ''; this.bulkError = false;
    this.renderBulkVerification(); this.refreshAvailability();
    try {
      const response = await this.options.command('library.verifyAllDuplicates') as { ok: boolean; result?: BulkDuplicateResult; error?: string } | undefined;
      if (this.disposed || serial !== this.bulkSerial || root !== this.summary?.settings.rootPath || revision !== this.summary?.revision) return;
      if (!response?.ok || !response.result) throw new Error(response?.error || 'La vérification globale n’a pas pu être confirmée.');
      this.acceptBulkResult(response.result, revision);
    } catch (error) {
      if (this.disposed || serial !== this.bulkSerial) return;
      this.bulkResult = null; this.bulkError = true;
      this.bulkMessage = error instanceof Error ? error.message : 'La vérification globale est indisponible. Réessayez.';
    } finally {
      if (!this.disposed && serial === this.bulkSerial) {
        this.bulkPending = false; this.bulkCancelling = false; this.renderBulkVerification(); this.refreshAvailability();
      }
    }
  }

  private acceptBulkResult(result: BulkDuplicateResult, revision: number): void {
    const values = [result.revision, result.totalGroups, result.processedGroups, result.readyGroups, result.needsKeeperGroups, result.blockedGroups, result.eligibleCopies];
    if (values.some(value => !Number.isSafeInteger(value) || value < 0) || typeof result.cancelled !== 'boolean'
      || result.revision !== revision || result.processedGroups > result.totalGroups
      || result.readyGroups + result.needsKeeperGroups + result.blockedGroups !== result.processedGroups
      || (!result.cancelled && result.processedGroups !== result.totalGroups)) throw new Error('La vérification globale n’a pas pu être confirmée.');
    this.bulkResult = result; this.bulkError = false;
    const counts = `${count(result.readyGroups)} groupe(s) prêt(s) · ${count(result.needsKeeperGroups)} choix de version requis · ${count(result.blockedGroups)} bloqué(s) · ${count(result.eligibleCopies)} copie(s) vérifiée(s).`;
    this.bulkMessage = result.cancelled
      ? `Vérification interrompue : ${count(result.processedGroups)} / ${count(result.totalGroups)} groupe(s) vérifié(s). ${counts} Aucun fichier n’a été supprimé.`
      : result.totalGroups === 0 ? 'Aucun groupe de doublons n’a été détecté.' : counts;
    this.duplicates = 'possible'; this.offset = 0; this.staleRetries = 0;
    this.element<HTMLSelectElement>('#library-duplicates').value = 'possible';
    this.scheduleQuery(0);
  }

  private async cancelDuplicateVerification(): Promise<void> {
    if (this.disposed || this.bulkCancelling || (!this.bulkPending && !this.summary?.duplicateVerification?.running)) return;
    const serial = this.bulkSerial, root = this.summary?.settings.rootPath, revision = this.summary?.revision;
    this.bulkCancelling = true; this.renderBulkVerification();
    try {
      const response = await this.options.command('library.cancelDuplicateVerification') as { ok: boolean; result?: BulkDuplicateResult | null; error?: string } | undefined;
      if (this.disposed || serial !== this.bulkSerial || root !== this.summary?.settings.rootPath || revision !== this.summary?.revision) return;
      if (!response?.ok) throw new Error(response?.error || 'L’arrêt de la vérification n’a pas pu être confirmé.');
      // The original request normally supplies the result. A panel opened while
      // verification was already running obtains it from the stop response.
      if (!this.bulkPending && !this.bulkResult && response.result && revision !== undefined) this.acceptBulkResult(response.result, revision);
    } catch (error) {
      if (!this.disposed && serial === this.bulkSerial && !this.bulkResult) this.feedback(error instanceof Error ? error.message : 'L’arrêt de la vérification n’a pas pu être confirmé.', true);
    } finally {
      if (!this.disposed && serial === this.bulkSerial) { this.bulkCancelling = false; this.renderBulkVerification(); this.refreshAvailability(); }
    }
  }

  private renderBulkVerification(): void {
    const progress = this.summary?.duplicateVerification;
    const running = this.bulkPending || (progress?.running === true && !this.bulkResult && !this.bulkMessage);
    const button = this.element<HTMLButtonElement>('#library-verify-all-duplicates');
    const stopping = running && (this.bulkCancelling || progress?.stopping === true);
    const cancel = this.element<HTMLButtonElement>('#library-cancel-duplicate-verification');
    cancel.hidden = !running; cancel.disabled = !running || stopping;
    cancel.textContent = stopping ? 'Arrêt en cours…' : 'Arrêter la vérification';
    button.textContent = running
      ? `Vérification ${count(progress?.processed ?? 0)} / ${count(progress?.total ?? 0)}…`
      : 'Vérifier l’audio de tous les doublons';
    const status = this.element('#library-verify-all-status');
    status.classList.toggle('is-error', this.bulkError);
    if (running) {
      status.textContent = stopping
        ? `Arrêt de la vérification en cours : ${count(progress?.processed ?? 0)} / ${count(progress?.total ?? 0)} groupes. Les résultats terminés seront conservés.`
        : `Vérification des notes, de l’audio et des fichiers : ${count(progress?.processed ?? 0)} / ${count(progress?.total ?? 0)} groupes.`;
      status.hidden = false;
    } else if (this.bulkMessage) {
      status.textContent = this.bulkMessage; status.hidden = false;
    } else {
      status.textContent = 'Analyse tous les groupes détectés. Aucune copie n’est supprimée automatiquement.';
      status.hidden = false;
    }
  }

  private renderSummary(): void {
    const summary = this.summary; if (!summary) return;
    const scanning = summary.status === 'scanning';
    const statuses = { idle: summary.settings.rootPath ? 'À analyser' : 'Choisir un dossier', scanning: summary.mode === 'quick' ? 'Actualisation en cours' : 'Scan complet en cours', ready: 'Bibliothèque à jour', cancelled: 'Analyse annulée', error: 'Analyse indisponible' };
    this.element('#library-count').textContent = `${count(summary.count)} morceau${summary.count > 1 ? 'x' : ''}`;
    this.element('#library-status').textContent = statuses[summary.status];
    this.element('#library-status').classList.toggle('is-visible', summary.status === 'ready');
    const root = this.element('#library-root'); root.textContent = summary.settings.rootPath ?? 'Aucun dossier sélectionné'; root.title = summary.settings.rootPath ?? '';
    this.element('#library-progress').hidden = !scanning && summary.status !== 'cancelled';
    this.element('#library-progress-label').textContent = summary.status === 'cancelled' ? 'Analyse interrompue' : summary.mode === 'quick' ? 'Actualisation de la bibliothèque…' : 'Analyse complète de la bibliothèque…';
    this.element('#library-progress-meter').hidden = !scanning;
    for (const key of ['visited', 'processed', 'discovered'] as const) this.element(`#library-progress-${key}`).textContent = count(summary.progress[key]);
    const date = summary.lastScanAt === null ? null : new Date(summary.lastScanAt);
    this.element('#library-last-scan').textContent = date && !Number.isNaN(date.getTime()) ? `Dernière analyse : ${date.toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' })}` : 'Aucune analyse effectuée';
    this.element('#library-changes').textContent = `+${count(summary.changes.added)} ajouté${summary.changes.added > 1 ? 's' : ''} · −${count(summary.changes.removed)} supprimé${summary.changes.removed > 1 ? 's' : ''} · ${count(summary.changes.modified)} modifié${summary.changes.modified > 1 ? 's' : ''}`;
    this.element('#library-watcher').textContent = summary.watcher === 'watching' ? 'Changements du dossier surveillés' : summary.watcher === 'unavailable' ? 'Détection indisponible · utilisez Actualiser' : 'Détection désactivée';
    const warnings = this.element('#library-warnings'); warnings.hidden = !summary.warningCount && !summary.skippedCount;
    warnings.textContent = `${count(summary.warningCount)} avertissement${summary.warningCount > 1 ? 's' : ''} · ${count(summary.skippedCount)} élément${summary.skippedCount > 1 ? 's' : ''} ignoré${summary.skippedCount > 1 ? 's' : ''} lors de la dernière analyse.`;
    const error = this.element('#library-error'); error.hidden = !summary.error; error.textContent = summary.error ?? '';
    this.element<HTMLInputElement>('#library-watch').checked = summary.settings.watch;
    this.element<HTMLInputElement>('#library-refresh-on-start').checked = summary.settings.refreshOnStart;
  }

  private renderRows(): void {
    const document = this.options.root.ownerDocument;
    const focused = (document.activeElement as HTMLElement | null)?.dataset.libraryOpenId;
    const focusedCatalogue = (document.activeElement as HTMLElement | null)?.dataset.libraryCatalogueId;
    const focusedCompare = (document.activeElement as HTMLElement | null)?.dataset.libraryCompareId;
    const ids = new Set(this.items.map(item => item.id));
    for (const [id, entry] of this.rows) if (!ids.has(id)) { entry.row.remove(); this.rows.delete(id); }
    const body = this.element<HTMLTableSectionElement>('#library-rows');
    for (const item of this.items) {
      let entry = this.rows.get(item.id);
      if (!entry) {
        const row = document.createElement('tr'); row.dataset.librarySongId = item.id;
        const titleCell = document.createElement('td'); titleCell.className = 'library-song-title-cell';
        const title = document.createElement('strong'); const path = document.createElement('span'); path.className = 'library-relative-path';
        const duplicate = document.createElement('span'); duplicate.className = 'library-duplicate-badge';
        titleCell.append(title, path, duplicate);
        const artist = document.createElement('td'), charter = document.createElement('td'), format = document.createElement('td'), audio = document.createElement('td'), actions = document.createElement('td');
        const open = document.createElement('button'); open.type = 'button'; open.className = 'button secondary library-open-folder'; open.textContent = 'Ouvrir dossier'; open.dataset.libraryOpenId = item.id;
        open.addEventListener('click', () => { void this.action('library.openFolder', { id: item.id }); }, { signal: this.abort.signal });
        const catalogue = document.createElement('button'); catalogue.type = 'button'; catalogue.className = 'button secondary library-catalogue'; catalogue.textContent = 'Sur ChartsHub'; catalogue.dataset.libraryCatalogueId = item.id;
        catalogue.addEventListener('click', () => { this.options.root.dispatchEvent(new CustomEvent('companion:catalogue-candidates', { detail: { localId: item.id } })); }, { signal: this.abort.signal });
        const compare = document.createElement('button'); compare.type = 'button'; compare.className = 'button secondary library-compare'; compare.textContent = 'Comparer'; compare.dataset.libraryCompareId = item.id;
        compare.addEventListener('click', () => this.comparison.open(item.id, title.textContent ?? '', compare), { signal: this.abort.signal });
        actions.className = 'library-row-actions'; actions.append(open, compare, catalogue); row.append(titleCell, artist, charter, format, audio, actions);
        entry = { row, title, path, duplicate, artist, charter, format, audio, open, catalogue, compare }; this.rows.set(item.id, entry);
      }
      entry.title.textContent = text(item.title, 'Titre inconnu'); entry.path.textContent = text(item.relativePath, ''); entry.path.title = text(item.relativePath, '');
      entry.duplicate.hidden = !(item.duplicateCount && item.duplicateCount > 1);
      if (entry.duplicate.hidden) {
        entry.duplicate.textContent = ''; delete entry.duplicate.dataset.verification;
      } else {
        entry.duplicate.dataset.verification = item.duplicateVerification ?? 'pending';
        entry.duplicate.textContent = item.duplicateVerification === 'ready'
          ? `Prêt à nettoyer · ${count(item.verifiedEligibleCopies ?? 0)} copie(s) vérifiée(s)`
          : item.duplicateVerification === 'needs_keeper' ? 'Choisir une version à garder'
          : item.duplicateVerification === 'blocked' ? 'Vérification bloquée'
          : `Doublon possible (${count(item.duplicateCount!)})`;
      }
      entry.compare.hidden = entry.duplicate.hidden;
      entry.compare.setAttribute('aria-label', `Comparer les versions locales de ${text(item.title, 'ce morceau')}`);
      entry.artist.textContent = text(item.artist); entry.charter.textContent = text(item.charter);
      entry.format.textContent = item.format === 'chart' ? '.chart' : item.format === 'midi' ? 'MIDI' : item.format === 'sng' ? '.sng' : '—';
      entry.audio.textContent = item.audio === 'present' ? 'Présent' : item.audio === 'missing' ? 'Absent' : 'Non vérifié';
      entry.audio.dataset.audio = item.audio; entry.open.setAttribute('aria-label', `Ouvrir le dossier de ${text(item.title, 'ce morceau')}`);
      entry.catalogue.setAttribute('aria-label', `Comparer ${text(item.title, 'ce morceau')} sur ChartsHub`);
      body.append(entry.row);
    }
    if (focused && this.rows.has(focused)) this.rows.get(focused)!.open.focus({ preventScroll: true });
    if (focusedCatalogue && this.rows.has(focusedCatalogue)) this.rows.get(focusedCatalogue)!.catalogue.focus({ preventScroll: true });
    if (focusedCompare && this.rows.has(focusedCompare)) this.rows.get(focusedCompare)!.compare.focus({ preventScroll: true });
  }

  private renderResultsStatus(): void {
    const root = this.summary?.settings.rootPath;
    this.element('#library-results').setAttribute('aria-busy', String(this.querying));
    this.element('#library-table-container').hidden = !this.items.length;
    const empty = this.element('#library-empty'); empty.hidden = this.items.length > 0;
    let title = 'Choisissez votre dossier Songs', description = 'Son analyse démarrera automatiquement pour retrouver vos charts installées.';
    if (this.queryError) { title = 'Les résultats ne peuvent pas être affichés'; description = 'Réessayez une fois la bibliothèque disponible.'; }
    else if (root && this.querying && !this.hasResult) { title = 'Chargement de la bibliothèque…'; description = 'Lecture de l’index local.'; }
    else if (root && (this.audio !== 'all' || this.duplicates !== 'all')) { title = 'Aucune chart ne correspond à ces filtres'; description = this.query ? 'Modifiez la recherche ou réinitialisez les filtres pour élargir les résultats.' : 'Réinitialisez les filtres pour retrouver les autres charts de votre bibliothèque.'; }
    else if (root && this.query) { title = 'Aucun résultat pour cette recherche'; description = 'Essayez un autre titre, artiste ou créateur de chart.'; }
    else if (root) { title = this.summary?.status === 'scanning' ? 'Analyse en cours…' : 'Aucune chart dans l’index'; description = this.summary?.status === 'scanning' ? 'La liste sera mise à jour à la fin de l’analyse.' : 'Lancez un scan complet ou vérifiez le dossier Songs sélectionné.'; }
    this.element('#library-empty-title').textContent = title; this.element('#library-empty-description').textContent = description;
    this.element('#library-query-retry').hidden = !this.queryError;
    this.element('#library-page-status').textContent = this.querying ? 'Chargement des résultats…' : this.items.length ? `${count(this.offset + 1)}–${count(this.offset + this.items.length)} sur ${count(this.total)} résultat${this.total > 1 ? 's' : ''} · page ${count(Math.floor(this.offset / this.limit) + 1)} sur ${count(Math.ceil(this.total / this.limit))}` : this.queryError ? 'Affichage indisponible' : '0 résultat';
  }

  private refreshAvailability(): void {
    const unavailable = !this.summary;
    const scanning = this.summary?.status === 'scanning';
    const verificationBusy = this.bulkPending || (this.summary?.duplicateVerification?.running === true && !this.bulkResult && !this.bulkMessage);
    const busy = this.pendingActions.size > 0 || verificationBusy;
    const noRoot = !this.summary?.settings.rootPath;
    this.element<HTMLButtonElement>('#library-choose-root').disabled = unavailable || busy || scanning;
    for (const id of ['#library-scan-full', '#library-refresh']) this.element<HTMLButtonElement>(id).disabled = unavailable || noRoot || busy || scanning;
    const cancel = this.element<HTMLButtonElement>('#library-cancel'); cancel.hidden = !scanning;
    cancel.disabled = unavailable || !scanning || [...this.pendingActions.values()].includes('library.cancel');
    for (const id of ['#library-watch', '#library-refresh-on-start']) this.element<HTMLInputElement>(id).disabled = unavailable || busy || scanning;
    this.element<HTMLInputElement>('#library-search').disabled = unavailable || noRoot;
    this.element<HTMLSelectElement>('#library-sort').disabled = unavailable || noRoot;
    this.element<HTMLSelectElement>('#library-audio').disabled = unavailable || noRoot;
    this.element<HTMLSelectElement>('#library-duplicates').disabled = unavailable || noRoot;
    this.element<HTMLButtonElement>('#library-clear-filters').disabled = unavailable || noRoot || (this.audio === 'all' && this.duplicates === 'all');
    this.element<HTMLButtonElement>('#library-clear-search').disabled = unavailable || !this.query;
    this.element<HTMLButtonElement>('#library-prev').disabled = unavailable || this.querying || this.offset === 0 || this.queryError;
    this.element<HTMLButtonElement>('#library-next').disabled = unavailable || this.querying || this.offset + this.limit >= this.total || this.queryError;
    this.element<HTMLButtonElement>('#library-query-retry').disabled = unavailable || this.querying;
    this.element<HTMLButtonElement>('#library-verify-all-duplicates').disabled = unavailable || noRoot || busy || scanning || this.querying;
    for (const entry of this.rows.values()) {
      entry.open.disabled = unavailable || busy || this.querying; entry.catalogue.disabled = unavailable || busy || this.querying || scanning;
      entry.compare.disabled = unavailable || busy || this.querying || scanning || entry.compare.hidden;
    }
    this.comparison.update({ rootPath: this.summary?.settings.rootPath ?? null, revision: this.summary?.revision ?? 0, scanning, busy });
    this.renderBulkVerification();
  }
}
