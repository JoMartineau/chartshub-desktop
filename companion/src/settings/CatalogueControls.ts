interface CatalogueItem {
  id: string; title: string; artist: string; charter: string; verified: boolean | null;
  album: string; year: string; genre: string; instruments: string[]; difficulties: string[];
  artworkUrl: string | null; viewUrl: string; downloadable: boolean;
  installed: { status: 'linked' | 'candidate' | 'none'; localIds: string[]; reason: string };
  matchKind?: string; reason?: string; ambiguous?: boolean;
}
interface CatalogueStatus {
  status: 'idle' | 'loading' | 'ready' | 'error'; error: string | null; warning: string | null;
  revision: number; availableCount: number; lastLoadedAt: string | null; demo: boolean;
}
interface Filters {
  query: string; artist: string; charter: string; genre: string; year: string; instrument: string;
  difficulty: string; verified: 'all' | 'yes'; installed: 'all' | 'linked' | 'unlinked';
}
interface SearchResult {
  items: CatalogueItem[]; page: number; pageSize: number; total: number; hasMore: boolean;
  facets: { instruments: string[]; difficulties: string[] };
}
interface CandidateResult {
  local: { id: string; title: string; artist: string; charter: string }; contextId: string;
  items: CatalogueItem[]; linkedChartId: string | null; total: number;
}
interface Response { ok: boolean; result?: SearchResult | CandidateResult; error?: string; cancelled?: boolean; }
interface Options { root: HTMLElement; command: (name: string, payload?: unknown) => Promise<unknown>; }
const emptyFilters = (): Filters => ({ query: '', artist: '', charter: '', genre: '', year: '', instrument: '', difficulty: '', verified: 'all', installed: 'all' });
const readable = (value: string, fallback = 'Non renseigné'): string => value?.trim() || fallback;
const count = (value: number): string => Math.max(0, Math.trunc(value || 0)).toLocaleString('fr-FR');

/** Catalogue requests only follow an explicit search, comparison, paging or refresh action. */
export class CatalogueControls {
  private readonly abort = new AbortController();
  private status: CatalogueStatus | null = null;
  private snapshotSignature = '';
  private libraryRevision = -1;
  private resultRevision = -1;
  private resultCatalogueRevision = -1;
  private contextInvalidated = false;
  private items: CatalogueItem[] = [];
  private filters = emptyFilters();
  private page = 1;
  private total = 0;
  private hasMore = false;
  private context: CandidateResult | null = null;
  private localId: string | null = null;
  private requested = false;
  private loading = false;
  private changing = false;
  private error = false;
  private serial = 0;
  private disposed = false;

  constructor(private readonly options: Options) {
    const signal = this.abort.signal;
    this.element('#catalogue-search-form').addEventListener('submit', event => {
      event.preventDefault(); if (this.changing) return;
      this.filters = this.readFilters(); this.localId = null; this.context = null;
      void this.request(1);
    }, { signal });
    this.element('#catalogue-filters').addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault(); this.element<HTMLFormElement>('#catalogue-search-form').requestSubmit();
      }
    }, { signal });
    this.element('#catalogue-clear').addEventListener('click', () => this.clear(), { signal });
    this.element('#catalogue-refresh').addEventListener('click', () => { void this.refresh(); }, { signal });
    this.element('#catalogue-leave-local').addEventListener('click', () => this.clear(), { signal });
    for (const selector of ['#catalogue-retry', '#catalogue-reload-results']) {
      this.element(selector).addEventListener('click', () => { void this.request(this.page); }, { signal });
    }
    this.element('#catalogue-prev').addEventListener('click', () => { if (this.page > 1) void this.request(this.page - 1); }, { signal });
    this.element('#catalogue-next').addEventListener('click', () => { if (this.hasMore) void this.request(this.page + 1); }, { signal });
    this.renderStatus();
  }

  update(snapshot: { catalogue?: CatalogueStatus; library?: { revision: number } }): void {
    if (this.disposed) return;
    const signature = JSON.stringify([snapshot.catalogue, snapshot.library?.revision]);
    if (signature === this.snapshotSignature) return;
    this.snapshotSignature = signature;
    const previousDemo = this.status?.demo;
    const previousStale = this.stale;
    if (snapshot.catalogue?.status === 'loading' && this.resultRevision >= 0) this.contextInvalidated = true;
    if (snapshot.catalogue) this.status = snapshot.catalogue;
    if (snapshot.library) this.libraryRevision = snapshot.library.revision;
    if (previousDemo !== this.status?.demo || previousStale !== this.stale) this.renderItems();
    this.renderStatus();
  }

  showCandidates(localId: string): void {
    if (!localId || this.disposed || this.changing) return;
    this.localId = localId; this.context = null; this.page = 1;
    this.element('#catalogue-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
    void this.request(1);
  }

  dispose(): void { this.disposed = true; this.serial++; this.abort.abort(); }
  private get stale(): boolean {
    return this.requested && this.resultRevision >= 0 && (this.contextInvalidated || this.resultRevision !== this.libraryRevision || this.resultCatalogueRevision !== this.status?.revision);
  }
  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.options.root.querySelector<T>(selector);
    if (!element) throw Error(`Missing catalogue control: ${selector}`);
    return element;
  }
  private feedback(message: string, error = false): void {
    const element = this.element('#catalogue-feedback'); element.textContent = message; element.hidden = !message;
    element.classList.toggle('is-error', error);
  }
  private readFilters(): Filters {
    const filters = emptyFilters();
    for (const key of ['query', 'artist', 'charter', 'genre', 'year', 'instrument', 'difficulty'] as const) filters[key] = this.element<HTMLInputElement>(`#catalogue-${key}`).value.trim();
    filters.verified = this.element<HTMLSelectElement>('#catalogue-verified').value === 'yes' ? 'yes' : 'all';
    const installed = this.element<HTMLSelectElement>('#catalogue-installed').value;
    filters.installed = installed === 'linked' || installed === 'unlinked' ? installed : 'all';
    return filters;
  }
  private clear(): void {
    if (this.changing) return;
    this.serial++; this.localId = null; this.context = null; this.requested = false;
    this.loading = false; this.error = false; this.items = []; this.total = 0; this.page = 1; this.hasMore = false;
    this.filters = emptyFilters(); this.resultRevision = -1; this.resultCatalogueRevision = -1; this.contextInvalidated = false;
    for (const [key, value] of Object.entries(this.filters)) this.element<HTMLInputElement>(`#catalogue-${key}`).value = value;
    this.feedback(''); this.renderItems(); this.renderStatus(); this.element('#catalogue-query').focus();
  }
  private async request(page: number): Promise<void> {
    if (this.disposed || !this.status || this.changing) return;
    const serial = ++this.serial, localId = this.localId, revision = this.libraryRevision;
    this.requested = true; this.loading = true; this.error = false; this.page = Math.max(1, page);
    this.feedback(''); this.renderStatus();
    try {
      const response = await this.options.command(localId ? 'catalogue.candidates' : 'catalogue.search', localId ? { localId } : { ...this.filters, page: this.page }) as Response | undefined;
      if (this.disposed || serial !== this.serial) return;
      if (!response?.ok || !response.result || !Array.isArray(response.result.items)) throw Error('Catalogue unavailable');
      const result = response.result;
      this.items = result.items; this.total = result.total; this.resultRevision = revision;
      this.resultCatalogueRevision = this.status.revision; this.contextInvalidated = false;
      if (localId) {
        this.context = result as CandidateResult; this.hasMore = false;
      } else {
        const search = result as SearchResult; this.context = null; this.page = search.page; this.hasMore = search.hasMore;
        this.setFacet('#catalogue-instrument', search.facets?.instruments ?? [], 'Tous');
        this.setFacet('#catalogue-difficulty', search.facets?.difficulties ?? [], 'Toutes');
      }
    } catch {
      if (this.disposed || serial !== this.serial) return;
      this.error = true; this.items = []; this.total = 0; this.hasMore = false;
      this.feedback(this.status?.error || 'Le catalogue ne peut pas être chargé. Réessayez dans un instant.', true);
    } finally {
      if (!this.disposed && serial === this.serial) { this.loading = false; this.renderItems(); this.renderStatus(); }
    }
  }
  private async refresh(): Promise<void> {
    if (this.loading || this.changing || !this.status) return;
    this.changing = true; this.contextInvalidated = true; this.feedback('Actualisation du catalogue…'); this.renderItems(); this.renderStatus();
    let success = false;
    try {
      const response = await this.options.command('catalogue.refresh', {}) as Response | undefined;
      if (this.disposed) return;
      if (!response?.ok) throw Error('Refresh unavailable');
      success = true;
    } catch { if (!this.disposed) this.feedback(this.status?.error || 'Le catalogue n’a pas pu être actualisé. Réessayez.', true); }
    finally { this.changing = false; if (!this.disposed) this.renderStatus(); }
    if (success && !this.disposed) {
      if (!this.requested) this.filters = this.readFilters();
      await this.request(this.page);
    }
  }
  private async action(action: 'open' | 'link' | 'unlink' | 'download', item: CatalogueItem): Promise<void> {
    if (this.changing || this.loading || this.disposed) return;
    if ((action === 'link' || action === 'unlink') && (!this.context || this.stale || this.status?.demo)) return;
    if (action === 'download' && (!item.downloadable || this.status?.demo)) return;
    const context = this.context;
    const payload = action === 'open' || action === 'download' ? { chartId: item.id } : { localId: context!.local.id, contextId: context!.contextId, ...(action === 'link' ? { chartId: item.id } : {}) };
    this.changing = true; this.feedback(''); this.renderStatus();
    let success = false;
    try {
      const response = await this.options.command(action === 'download' ? 'downloads.enqueue' : `catalogue.${action}`, payload) as Response | undefined;
      if (this.disposed) return;
      if (!response?.ok) {
        if (action === 'download') { this.feedback(response?.error || 'Cette chart n’a pas pu être ajoutée à la file de téléchargements.', true); return; }
        throw Error('Action unavailable');
      }
      if (action === 'download' && response.cancelled) { this.feedback('Aucun téléchargement ajouté.'); return; }
      success = true;
      this.feedback(action === 'download' ? 'Cette chart figure dans la file de téléchargements ci-dessous.' : action === 'open' ? 'La fiche ChartsHub a été ouverte dans votre navigateur.' : action === 'link' ? 'Cette chart est maintenant liée à votre morceau local.' : 'Le lien a été retiré. Votre morceau local est conservé.');
    } catch { if (!this.disposed) this.feedback(action === 'download' ? 'Cette chart n’a pas pu être ajoutée à la file de téléchargements.' : action === 'open' ? 'La fiche ChartsHub n’a pas pu être ouverte.' : 'Le lien n’a pas pu être modifié. Rechargez les résultats puis réessayez.', true); }
    finally { this.changing = false; if (!this.disposed) this.renderStatus(); }
    if (success && (action === 'link' || action === 'unlink') && !this.disposed) {
      await this.request(1);
      if (!this.error) this.feedback(action === 'link' ? 'Cette chart est maintenant liée à votre morceau local.' : 'Le lien a été retiré. Votre morceau local est conservé.');
    }
  }
  private setFacet(selector: string, values: string[], defaultLabel: string): void {
    const select = this.element<HTMLSelectElement>(selector), selected = select.value;
    const options = [...new Set(values.filter(value => typeof value === 'string' && value))];
    if (selected && !options.includes(selected)) options.push(selected);
    select.replaceChildren();
    const blank = this.options.root.ownerDocument.createElement('option'); blank.value = ''; blank.textContent = defaultLabel; select.append(blank);
    for (const value of options) { const option = this.options.root.ownerDocument.createElement('option'); option.value = value; option.textContent = value; select.append(option); }
    select.value = selected;
  }
  private renderItems(): void {
    const document = this.options.root.ownerDocument, container = this.element('#catalogue-items');
    const active = document.activeElement as HTMLElement | null;
    const focusAction = active?.dataset.catalogueAction, focusId = active?.closest<HTMLElement>('[data-catalogue-id]')?.dataset.catalogueId;
    const nodes: HTMLElement[] = [];
    for (const item of this.items) {
      const card = document.createElement('article'); card.className = 'catalogue-item'; card.dataset.catalogueId = item.id; card.setAttribute('role', 'listitem');
      const art = document.createElement('div'); art.className = 'catalogue-artwork'; art.setAttribute('aria-hidden', 'true');
      const placeholder = document.createElement('span'); placeholder.textContent = '♪'; art.append(placeholder);
      if (item.artworkUrl && /^chartshub-companion:\/\/app\/catalogue-artwork\/[a-f0-9]{64}$/.test(item.artworkUrl)) {
        const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => { image.hidden = true; image.removeAttribute('src'); }, { once: true });
        image.src = item.artworkUrl; art.append(image);
      }
      const body = document.createElement('div'); body.className = 'catalogue-item-body';
      const title = document.createElement('h3'); title.textContent = readable(item.title, 'Titre non renseigné');
      const artist = document.createElement('p'); artist.className = 'catalogue-item-artist'; artist.textContent = readable(item.artist, 'Artiste non renseigné');
      const creator = document.createElement('div'); creator.className = 'catalogue-item-creator';
      const name = document.createElement('span'); name.textContent = `Chart : ${readable(item.charter)}`; creator.append(name);
      if (item.verified === true && !this.status?.demo) { const badge = document.createElement('span'); badge.className = 'catalogue-verified'; badge.dataset.catalogueVerified = 'true'; badge.textContent = 'Créateur vérifié'; creator.append(badge); }
      const details = document.createElement('p'); details.className = 'catalogue-item-details'; details.textContent = [item.album, item.year, item.genre].filter(Boolean).join(' · '); details.hidden = !details.textContent;
      const playable = document.createElement('p'); playable.className = 'catalogue-item-playable';
      playable.textContent = [item.instruments?.length ? `Instruments : ${item.instruments.join(', ')}` : '', item.difficulties?.length ? `Difficultés : ${item.difficulties.join(', ')}` : ''].filter(Boolean).join(' · '); playable.hidden = !playable.textContent;
      const relation = document.createElement('p'); relation.className = 'catalogue-relation';
      const linked = this.context ? this.context.linkedChartId === item.id : item.installed.status === 'linked';
      const possible = !!this.context || item.installed.status === 'candidate';
      relation.dataset.catalogueRelation = this.stale ? 'stale' : linked ? 'linked' : possible ? 'candidate' : 'none';
      relation.textContent = this.stale ? 'Liens à actualiser' : linked ? 'Liée à votre bibliothèque' : possible ? 'Correspondance possible' : 'Aucun lien confirmé';
      const reason = document.createElement('p'); reason.className = 'catalogue-match-reason'; reason.textContent = item.reason || item.installed.reason || ''; reason.hidden = !reason.textContent || this.stale;
      body.append(title, artist, creator, details, playable, relation, reason);
      const actions = document.createElement('div'); actions.className = 'catalogue-item-actions';
      const button = (action: 'open' | 'link' | 'unlink' | 'download', label: string): void => {
        const node = document.createElement('button'); node.type = 'button'; node.className = `button ${action === 'link' || action === 'download' ? 'primary' : 'secondary'}`; node.textContent = label; node.dataset.catalogueAction = action;
        if (action === 'download') { node.dataset.downloadable = String(item.downloadable === true); node.title = item.downloadable ? 'Ajouter cette chart à la file de téléchargements' : 'Cette chart ne propose pas de téléchargement disponible.'; }
        node.addEventListener('click', () => { void this.action(action, item); }, { signal: this.abort.signal }); actions.append(node);
      };
      button('download', 'Ajouter à la file');
      button('open', 'Ouvrir sur ChartsHub');
      if (this.context) button(linked ? 'unlink' : 'link', linked ? 'Retirer le lien' : this.context.linkedChartId ? 'Remplacer le lien' : 'Lier cette chart');
      card.append(art, body, actions); nodes.push(card);
    }
    container.replaceChildren(...nodes);
    if (focusAction && focusId) {
      const card = nodes.find(node => node.dataset.catalogueId === focusId);
      card?.querySelector<HTMLButtonElement>(`[data-catalogue-action="${focusAction}"]`)?.focus({ preventScroll: true });
    }
  }
  private renderStatus(): void {
    const busy = this.loading || this.changing, available = !!this.status;
    this.element('#catalogue-results').setAttribute('aria-busy', String(busy));
    this.element('#catalogue-demo').hidden = !this.status?.demo;
    const loadedAt = this.status?.lastLoadedAt ? new Date(this.status.lastLoadedAt) : null;
    this.element('#catalogue-last-loaded').textContent = loadedAt && !Number.isNaN(loadedAt.getTime()) ? `Catalogue chargé le ${loadedAt.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : 'Le catalogue sera chargé à votre demande.';
    const warning = this.element('#catalogue-warning'); warning.textContent = this.status?.warning ?? ''; warning.hidden = !warning.textContent;
    this.element('#catalogue-status').textContent = this.loading || this.status?.status === 'loading' ? 'Chargement…' : this.status?.demo ? 'Démonstration' : this.status?.status === 'ready' ? `${count(this.status.availableCount)} charts chargées` : this.status?.status === 'error' ? 'Indisponible' : 'À la demande';
    this.element('#catalogue-local-context').hidden = !this.localId;
    this.element('#catalogue-local-title').textContent = this.context ? `${readable(this.context.local.title)} · ${readable(this.context.local.artist)}` : 'Chargement du morceau local…';
    this.element('#catalogue-local-description').textContent = this.context ? `Créateur local : ${readable(this.context.local.charter)}. Comparez les versions avant de confirmer une association.` : 'Recherche de versions à partir du titre et de l’artiste.';
    this.element('#catalogue-stale').hidden = !this.stale || this.loading;
    this.element('#catalogue-empty').hidden = this.items.length > 0;
    let title = 'Explorez le catalogue ChartsHub', description = 'Lancez une recherche ou comparez un morceau de votre bibliothèque. Aucune recherche ne démarre automatiquement.';
    if (this.loading) { title = 'Chargement des charts…'; description = 'Le catalogue est chargé à votre demande.'; }
    else if (this.error) { title = 'Catalogue indisponible'; description = 'Vérifiez votre connexion puis réessayez.'; }
    else if (this.requested) { title = this.localId ? 'Aucune version proposée' : 'Aucune chart trouvée'; description = this.localId ? 'Aucune correspondance n’est proposée pour ce morceau local. Vous pouvez effectuer une recherche dans le catalogue.' : 'Essayez une autre recherche ou élargissez vos filtres.'; }
    this.element('#catalogue-empty-title').textContent = title; this.element('#catalogue-empty-description').textContent = description;
    this.element('#catalogue-retry').hidden = !this.error;
    this.element('#catalogue-page-status').textContent = busy ? 'Chargement des résultats…' : !this.requested ? 'Aucune recherche lancée' : this.error ? 'Résultats indisponibles' : this.localId ? `${count(this.items.length)} version${this.items.length > 1 ? 's' : ''} proposée${this.items.length > 1 ? 's' : ''}${this.total > this.items.length ? ` sur ${count(this.total)}` : ''}` : `${count(this.total)} résultat${this.total > 1 ? 's' : ''} · page ${count(this.page)}`;
    this.element<HTMLButtonElement>('#catalogue-search').disabled = !available || this.changing;
    for (const selector of ['#catalogue-refresh', '#catalogue-prev', '#catalogue-next', '#catalogue-retry', '#catalogue-reload-results']) this.element<HTMLButtonElement>(selector).disabled = !available || busy;
    this.element<HTMLButtonElement>('#catalogue-prev').disabled ||= !!this.localId || this.page <= 1;
    this.element<HTMLButtonElement>('#catalogue-next').disabled ||= !!this.localId || !this.hasMore;
    for (const selector of ['#catalogue-clear', '#catalogue-leave-local']) this.element<HTMLButtonElement>(selector).disabled = this.changing;
    this.options.root.querySelectorAll<HTMLButtonElement>('[data-catalogue-action]').forEach(node => {
      const action = node.dataset.catalogueAction;
      node.disabled = busy || ((action === 'link' || action === 'unlink') && (this.stale || !!this.status?.demo)) || (action === 'download' && (node.dataset.downloadable !== 'true' || !!this.status?.demo));
    });
  }
}
