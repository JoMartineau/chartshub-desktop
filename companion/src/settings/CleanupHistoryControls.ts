interface HistoryTarget { id: string; relativePath: string; targetRelativePath: string; }
interface HistoryEntry {
  id: string; at: string; mode: 'normal' | 'force'; keep: HistoryTarget;
  candidates: (HistoryTarget & { status: 'recycled' | 'failed' | 'not-attempted'; reason: string | null })[];
  cancelled: boolean;
}
interface HistoryPage { entries: HistoryEntry[]; total: number; offset: number; limit: number; maxEntries: number; }
interface HistoryOptions { root: HTMLElement; command: (name: string, payload?: unknown) => Promise<unknown>; }
interface HistoryState { rootPath: string | null; revision: number; }
const unavailable = 'L’historique des nettoyages est indisponible. Les résultats du nettoyage restent inchangés.';

/** Read-only records scoped by the main process to the currently selected Songs folder. */
export class CleanupHistoryControls {
  private readonly abort = new AbortController();
  private readonly panel: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly pagination: HTMLElement;
  private state: HistoryState | null = null;
  private serial = 0;
  private offset = 0;
  private total = 0;
  private readonly limit = 10;
  private expanded = false;
  private loading = false;
  private disposed = false;

  constructor(private readonly options: HistoryOptions) {
    this.panel = this.make('div', 'library-cleanup-history'); this.panel.className = 'library-cleanup-history';
    const heading = this.make('h3', 'library-cleanup-history-title', 'Historique des nettoyages');
    const description = this.make('p', '', 'Les 200 derniers nettoyages sont conservés. Seuls ceux du dossier Songs actuel sont affichés.');
    this.toggle = this.make('button', 'library-cleanup-history-toggle', 'Afficher l’historique'); this.toggle.type = 'button';
    this.toggle.setAttribute('aria-controls', 'library-cleanup-history-body');
    this.body = this.make('div', 'library-cleanup-history-body');
    this.refreshButton = this.make('button', 'library-cleanup-history-refresh', 'Actualiser l’historique'); this.refreshButton.type = 'button';
    this.status = this.make('p', 'library-cleanup-history-status'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.rows = this.make('div', 'library-cleanup-history-rows');
    this.pagination = this.make('div', 'library-cleanup-history-pagination');
    this.previous = this.make('button', 'library-cleanup-history-prev', 'Nettoyages plus récents'); this.previous.type = 'button';
    this.next = this.make('button', 'library-cleanup-history-next', 'Nettoyages plus anciens'); this.next.type = 'button';
    this.pagination.append(this.previous, this.next);
    this.body.append(this.refreshButton, this.status, this.rows, this.pagination);
    this.panel.append(heading, description, this.toggle, this.body); options.root.append(this.panel);
    this.panel.setAttribute('aria-labelledby', heading.id);
    const signal = this.abort.signal;
    this.toggle.addEventListener('click', () => {
      if (!this.state?.rootPath || this.disposed) return;
      this.expanded = !this.expanded; this.renderAvailability();
      if (this.expanded) void this.load();
    }, { signal });
    this.refreshButton.addEventListener('click', () => this.refresh(), { signal });
    this.previous.addEventListener('click', () => { this.offset = Math.max(0, this.offset - this.limit); void this.load(); }, { signal });
    this.next.addEventListener('click', () => { if (this.offset + this.limit < this.total) { this.offset += this.limit; void this.load(); } }, { signal });
    options.root.ownerDocument.defaultView?.addEventListener('chartshub:languagechange', () => {
      if (!this.disposed) this.rows.querySelectorAll<HTMLTimeElement>('time').forEach(date => this.renderDate(date));
    }, { signal });
    this.renderAvailability();
  }

  update(state: HistoryState): void {
    if (this.disposed) return;
    const changed = state.rootPath !== this.state?.rootPath || state.revision !== this.state?.revision;
    const changedRoot = state.rootPath !== this.state?.rootPath;
    this.state = { ...state };
    if (changed) {
      this.serial++; this.loading = false; this.offset = 0; this.total = 0; this.rows.textContent = ''; this.status.textContent = '';
      if (changedRoot && !state.rootPath) this.expanded = false;
      if (this.expanded && state.rootPath) void this.load();
    }
    this.renderAvailability();
  }

  refresh(): void {
    if (this.disposed || this.loading) return;
    this.offset = 0;
    if (this.expanded) void this.load();
  }

  dispose(): void { this.disposed = true; this.serial++; this.abort.abort(); }

  private make<K extends keyof HTMLElementTagNameMap>(tag: K, id = '', text = ''): HTMLElementTagNameMap[K] {
    const element = this.options.root.ownerDocument.createElement(tag);
    if (id) element.id = id;
    if (text) element.textContent = text;
    return element;
  }

  private renderAvailability(): void {
    const available = Boolean(this.state?.rootPath);
    this.toggle.disabled = !available; this.toggle.textContent = this.expanded ? 'Masquer l’historique' : 'Afficher l’historique';
    this.toggle.setAttribute('aria-expanded', String(this.expanded)); this.body.hidden = !this.expanded;
    this.refreshButton.disabled = !available || this.loading;
    this.previous.disabled = !available || this.loading || this.offset === 0;
    this.next.disabled = !available || this.loading || this.offset + this.limit >= this.total;
    this.pagination.hidden = this.total <= this.limit;
    this.rows.setAttribute('aria-busy', String(this.loading));
  }

  private async load(): Promise<void> {
    if (this.disposed || !this.state?.rootPath || !this.expanded || this.loading) return;
    const serial = ++this.serial, root = this.state.rootPath;
    this.loading = true; this.rows.textContent = ''; this.status.textContent = 'Chargement de l’historique…'; this.renderAvailability();
    const current = (): boolean => !this.disposed && serial === this.serial && root === this.state?.rootPath;
    try {
      const response = await this.options.command('library.cleanupHistory', { offset: this.offset, limit: this.limit }) as { ok: boolean; result?: HistoryPage } | undefined;
      if (!current()) return;
      const page = response?.result;
      if (!response?.ok || !page || !Array.isArray(page.entries) || page.entries.length > this.limit || !Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== this.offset || page.limit !== this.limit) throw Error(unavailable);
      this.total = page.total;
      if (!page.entries.length && this.offset > 0 && this.total > 0) {
        this.offset = Math.floor((this.total - 1) / this.limit) * this.limit; this.loading = false; void this.load(); return;
      }
      for (const entry of page.entries) this.renderEntry(entry);
      this.status.textContent = page.entries.length ? 'Historique du dossier Songs actuel.' : 'Aucun nettoyage enregistré pour ce dossier Songs.';
    } catch (_) {
      if (!current()) return;
      this.rows.textContent = ''; this.status.textContent = unavailable; this.total = 0;
    } finally { if (current()) { this.loading = false; this.renderAvailability(); } }
  }

  private renderEntry(entry: HistoryEntry): void {
    const card = this.make('article'); card.className = 'library-cleanup-history-entry'; card.dataset.historyId = entry.id;
    const date = this.make('time'); date.dateTime = entry.at; this.renderDate(date);
    const mode = this.make('p', '', entry.mode === 'force' ? 'Suppression avec différences confirmées' : 'Nettoyage de copies identiques');
    const keeper = this.make('p'); keeper.className = 'library-cleanup-history-keeper';
    keeper.append(this.make('strong', '', 'Version conservée'), this.make('code', '', entry.keep.relativePath));
    const candidates = this.make('ul');
    for (const target of entry.candidates) {
      const row = this.make('li'); row.dataset.historyStatus = target.status;
      const label = target.status === 'recycled' ? 'Envoyée à la Corbeille' : target.status === 'failed' ? 'Échec de la mise à la Corbeille' : 'Non tentée — conservée';
      row.append(this.make('strong', '', label), this.make('code', '', target.targetRelativePath));
      if (target.status === 'failed') row.append(this.make('p', '', 'La mise à la corbeille n’a pas pu être vérifiée ou effectuée.'));
      candidates.append(row);
    }
    card.append(date, mode, keeper, candidates);
    if (entry.cancelled) card.append(this.make('p', '', 'Nettoyage interrompu. Les copies non traitées ont été conservées.'));
    this.rows.append(card);
  }

  private renderDate(date: HTMLTimeElement): void {
    const language = this.options.root.ownerDocument.documentElement?.lang?.startsWith('en') ? 'en-US' : 'fr-FR';
    const parsed = new Date(date.dateTime); date.textContent = Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(language) : '—';
  }
}
