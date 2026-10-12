interface BadEntry { id: string; targetRelativePath: string | null; reportedPath: string; severity: 'error' | 'warning' | 'unknown'; reasons: string[]; eligible: boolean; blocked: string | null; bytes: number | null; kind: 'folder' | 'sng'; }
interface BadPlan { planId: string; revision: number; modifiedAt: string; unsupportedLines: number; entries: BadEntry[]; }
interface LibraryState { settings: { rootPath: string | null }; revision: number; status: string; badSongsBusy?: boolean; bulkCleanup?: unknown; duplicateVerification?: { running: boolean } | null; }
interface Options { root: HTMLElement; command: (name: string, payload?: unknown) => Promise<unknown>; }
const tr = (fr: string, en: string): string => typeof document === 'undefined' || document.documentElement.lang.startsWith('fr') ? fr : en;
const token = (value: unknown, length: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const reasons: Record<string, [string, string]> = {
  warning: ['Avertissement · conservé', 'Warning · kept'], unsupported: ['Format non reconnu · conservé', 'Unrecognized format · kept'], outside: ['Hors du dossier Songs · conservé', 'Outside the Songs folder · kept'],
  protected: ['Dossier de données ChartsHub · protégé', 'ChartsHub data folder · protected'], shared: ['Emplacement partagé avec une autre chart · conservé', 'Location shared with another chart · kept'],
  unsafe: ['Fichiers absents ou emplacement non vérifiable · conservé', 'Missing files or unverifiable location · kept'], changed: ['Fichiers modifiés · importez à nouveau le rapport', 'Files changed · import the report again']
};
/** Imported Clone Hero errors, with explicit selection and native confirmation. */
export class BadSongsCleanupControls {
  private readonly abort = new AbortController();
  private cardsAbort = new AbortController();
  private state: LibraryState | null = null;
  private plan: BadPlan | null = null;
  private readonly selected = new Set<string>();
  private readonly checks = new Map<string, HTMLInputElement>();
  private busy = false;
  private serial = 0;
  private disposed = false;
  private visible = 50;
  private message: [string, string] | null = null;
  constructor(private readonly options: Options) {
    const signal = this.abort.signal;
    this.element('#library-bad-songs-import').addEventListener('click', () => { void this.importReport(); }, { signal });
    this.element('#library-bad-songs-recycle').addEventListener('click', () => { void this.recycle(); }, { signal });
    this.element('#library-bad-songs-clear').addEventListener('click', () => { if (!this.blocked) { this.selected.clear(); this.refresh(); } }, { signal });
    this.element('#library-bad-songs-close').addEventListener('click', () => { if (!this.busy) { this.invalidate(); void options.command('library.cancelBadSongs', {}); } }, { signal });
    const list = this.element('#library-bad-songs-list');
    list.addEventListener('scroll', () => { if (this.plan && this.visible < this.plan.entries.length && list.scrollTop + list.clientHeight >= list.scrollHeight - 100) { this.visible += 50; this.renderEntries(); } }, { signal });
    if (typeof window !== 'undefined') window.addEventListener('chartshub:languagechange', () => { this.renderEntries(); this.refresh(); }, { signal });
    this.refresh();
  }
  private element<T extends HTMLElement = HTMLElement>(selector: string): T { const value = this.options.root.matches(selector) ? this.options.root as T : this.options.root.querySelector<T>(selector); if (!value) throw Error('Missing bad songs control: ' + selector); return value; }
  private get blocked(): boolean { return this.busy || !this.state?.settings.rootPath || this.state.status !== 'ready' || !!this.state.bulkCleanup || this.state.duplicateVerification?.running === true || this.state.badSongsBusy === true; }
  update(snapshot: { library?: LibraryState }): void {
    if (this.disposed || !snapshot.library) return;
    const state = snapshot.library;
    if (this.state && (this.state.settings.rootPath !== state.settings.rootPath || this.state.revision !== state.revision || state.status === 'scanning') && !this.busy) this.invalidate();
    this.state = state; this.refresh();
  }
  private invalidate(): void { this.serial++; this.plan = null; this.selected.clear(); this.checks.clear(); this.element('#library-bad-songs-list').textContent = ''; this.refresh(); }
  private validPlan(value: unknown): value is BadPlan {
    const plan = value as BadPlan;
    return !!plan && token(plan.planId, 32) && Number.isSafeInteger(plan.revision) && typeof plan.modifiedAt === 'string' && Array.isArray(plan.entries)
      && plan.entries.every(entry => token(entry.id, 64) && typeof entry.reportedPath === 'string' && ['error','warning','unknown'].includes(entry.severity)
        && Array.isArray(entry.reasons) && entry.reasons.every(reason => typeof reason === 'string') && typeof entry.eligible === 'boolean'
        && (!entry.eligible || (entry.severity === 'error' && typeof entry.targetRelativePath === 'string' && !!entry.targetRelativePath && Number.isSafeInteger(entry.bytes) && entry.bytes! >= 0)))
      && new Set(plan.entries.map(entry => entry.id)).size === plan.entries.length;
  }
  private async importReport(): Promise<void> {
    if (this.blocked) return;
    this.invalidate(); const request = ++this.serial, root = this.state?.settings.rootPath, revision = this.state?.revision;
    this.busy = true; this.message = ["Lecture du rapport et vérification des fichiers…", 'Reading the report and verifying files…']; this.refresh();
    try {
      const response = await this.options.command('library.chooseBadSongs', {}) as { ok?: boolean; cancelled?: boolean; result?: unknown };
      if (this.disposed || request !== this.serial || root !== this.state?.settings.rootPath || revision !== this.state?.revision) return;
      if (response?.cancelled) { this.message = ['Import annulé.', 'Import cancelled.']; return; }
      if (!response?.ok || !this.validPlan(response.result) || response.result.revision !== revision) throw Error();
      this.plan = response.result; this.visible = 50; this.message = null; this.renderEntries();
    } catch { this.message = ['Le rapport est illisible ou son format n’est pas reconnu. Aucun fichier supprimé.', 'The report is unreadable or its format is unrecognized. No files deleted.']; }
    finally { if (!this.disposed && request === this.serial) { this.busy = false; this.refresh(); } }
  }
  private renderEntries(): void {
    this.cardsAbort.abort(); this.cardsAbort = new AbortController(); this.checks.clear();
    const list = this.element('#library-bad-songs-list'), scroll = list.scrollTop; list.textContent = '';
    if (!this.plan) return;
    const owner = list.ownerDocument;
    for (const entry of this.plan.entries.slice(0, this.visible)) {
      const card = owner.createElement('div'); card.className = 'library-bad-song'; card.dataset.severity = entry.severity;
      const label = owner.createElement('label'), check = owner.createElement('input'); check.type = 'checkbox'; check.className = 'library-bad-song-check'; check.dataset.id = entry.id;
      const heading = owner.createElement('strong'); heading.textContent = entry.eligible ? tr('Erreur Clone Hero', 'Clone Hero error') : tr(...(reasons[entry.blocked ?? 'unsupported'] ?? reasons.unsupported!));
      label.append(check, heading); card.append(label);
      const target = owner.createElement('code'); target.textContent = entry.targetRelativePath ?? entry.reportedPath; card.append(target);
      for (const reason of entry.reasons) { const detail = owner.createElement('p'); detail.textContent = reason; card.append(detail); }
      if (entry.eligible) { const detail = owner.createElement('p'); detail.textContent = tr(`${entry.kind === 'folder' ? 'Dossier complet' : 'Fichier .sng'} · ${entry.bytes} octets`, `${entry.kind === 'folder' ? 'Entire folder' : '.sng file'} · ${entry.bytes} bytes`); card.append(detail); }
      check.addEventListener('change', () => { if (this.blocked || !entry.eligible || !this.plan) { check.checked = this.selected.has(entry.id); return; }
        if (check.checked && this.selected.size < 200) this.selected.add(entry.id); else this.selected.delete(entry.id); this.refresh(); }, { signal: this.cardsAbort.signal });
      this.checks.set(entry.id, check); list.append(card);
    }
    list.scrollTop = scroll; this.refresh();
  }
  private async recycle(): Promise<void> {
    if (this.blocked || !this.plan || !this.selected.size) return;
    const plan = this.plan, root = this.state?.settings.rootPath, ids = plan.entries.filter(entry => entry.eligible && this.selected.has(entry.id)).map(entry => entry.id), request = ++this.serial;
    if (!ids.length) return;
    this.busy = true; this.message = ['Confirmation Windows en attente…', 'Waiting for Windows confirmation…']; this.refresh();
    try {
      const response = await this.options.command('library.recycleBadSongs', { planId: plan.planId, revision: plan.revision, ids }) as { ok?: boolean; cancelled?: boolean; result?: { recycledIds: string[]; failed: unknown[]; cancelled: boolean; plan?: BadPlan } };
      if (this.disposed || request !== this.serial || root !== this.state?.settings.rootPath) return;
      if (response?.cancelled) { this.message = ['Suppression annulée. Aucun fichier supprimé.', 'Deletion cancelled. No files deleted.']; return; }
      if (!response?.ok || !response.result || !Array.isArray(response.result.recycledIds) || !Array.isArray(response.result.failed)
        || response.result.recycledIds.some(id => !token(id, 64) || !ids.includes(id))
        || new Set(response.result.recycledIds).size !== response.result.recycledIds.length
        || response.result.failed.some(value => !value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' || !ids.includes(value.id) || response.result!.recycledIds.includes(value.id))) throw Error();
      const result = response.result, removed = new Set(result.recycledIds);
      this.plan = this.validPlan(result.plan) && result.plan.revision === this.state?.revision
        && result.plan.entries.every(entry => !removed.has(entry.id) && plan.entries.some(old => old.id === entry.id && old.targetRelativePath === entry.targetRelativePath)) ? result.plan : null;
      this.selected.clear(); this.renderEntries();
      this.message = [`${removed.size} chart(s) envoyée(s) à la Corbeille. ${result.failed.length ? 'Un fichier a changé ou n’a pas pu être supprimé. ' : ''}Continuez le nettoyage, puis cliquez sur « Actualiser à la fin ».`,
        `${removed.size} chart(s) sent to the Recycle Bin. ${result.failed.length ? 'A file changed or could not be deleted. ' : ''}Continue cleanup, then click “Refresh when finished”.`];
    } catch { this.plan = null; this.selected.clear(); this.message = ['Les fichiers ont changé ou le nettoyage est indisponible. Importez à nouveau le rapport.', 'The files changed or cleanup is unavailable. Import the report again.']; }
    finally { if (!this.disposed && request === this.serial) { this.busy = false; this.refresh(); } }
  }
  private refresh(): void {
    if (this.disposed) return;
    this.element('#library-bad-songs').setAttribute('aria-busy', String(this.busy));
    this.element<HTMLButtonElement>('#library-bad-songs-import').disabled = this.blocked;
    this.element('#library-bad-songs-plan').hidden = !this.plan;
    this.element('#library-bad-songs-status').textContent = this.message ? tr(...this.message) : this.plan ? tr(`Rapport du ${this.plan.modifiedAt} · ${this.plan.entries.filter(entry => entry.eligible).length} erreur(s) supprimable(s).`, `Report from ${this.plan.modifiedAt} · ${this.plan.entries.filter(entry => entry.eligible).length} removable error(s).`) : tr('Importez le rapport créé par Scan Songs dans Clone Hero.', 'Import the report created by Scan Songs in Clone Hero.');
    this.element('#library-bad-songs-selection').textContent = tr(`${this.selected.size} chart(s) cochée(s) · 200 maximum par lot.`, `${this.selected.size} selected chart(s) · maximum 200 per batch.`);
    this.element<HTMLButtonElement>('#library-bad-songs-recycle').disabled = this.blocked || !this.selected.size;
    this.element<HTMLButtonElement>('#library-bad-songs-clear').disabled = this.blocked || !this.selected.size;
    this.element<HTMLButtonElement>('#library-bad-songs-close').disabled = this.busy;
    for (const [id, check] of this.checks) { check.checked = this.selected.has(id); check.disabled = this.blocked || !this.plan?.entries.find(entry => entry.id === id)?.eligible; }
  }
  dispose(): void { this.disposed = true; this.serial++; this.abort.abort(); this.cardsAbort.abort(); }
}
