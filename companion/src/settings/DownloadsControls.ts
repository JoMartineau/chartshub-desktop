type DownloadState = 'Queued' | 'Downloading' | 'Paused' | 'Completed' | 'Failed' | 'Cancelled';
type DownloadAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'openFolder';
interface DownloadItem {
  id: string; chartId: string; title: string; artist: string; charter: string; state: DownloadState;
  receivedBytes: number; totalBytes: number | null; completedFiles: number; totalFiles: number | null;
  currentFile: string | null; error: string | null; destination?: string;
}
interface DownloadsSummary { revision: number; rootPath: string | null; items: DownloadItem[]; error: string | null; }
interface Response { ok: boolean; error?: string; }
interface Options { root: HTMLElement; command: (name: string, payload?: unknown) => Promise<unknown>; }
interface Row {
  element: HTMLElement; title: HTMLElement; metadata: HTMLElement; status: HTMLElement; progress: HTMLProgressElement;
  bytes: HTMLElement; files: HTMLElement; currentFile: HTMLElement; error: HTMLElement; destination: HTMLElement;
  actions: Map<DownloadAction, HTMLButtonElement>;
}
const states: Record<DownloadState, string> = { Queued: 'En attente', Downloading: 'Téléchargement en cours', Paused: 'En pause', Completed: 'Terminé · dossier prêt', Failed: 'Échec', Cancelled: 'Annulé' };
const labels: Record<DownloadAction, string> = { pause: 'Mettre en pause', resume: 'Reprendre', cancel: 'Annuler', retry: 'Réessayer', remove: 'Retirer de la liste', openFolder: 'Ouvrir le dossier' };
const allowed: Record<DownloadAction, DownloadState[]> = {
  pause: ['Queued', 'Downloading'], resume: ['Paused'], cancel: ['Queued', 'Downloading', 'Paused', 'Failed'],
  retry: ['Failed', 'Cancelled'], remove: ['Paused', 'Completed', 'Failed', 'Cancelled'], openFolder: ['Completed'],
};
const actions: DownloadAction[] = ['pause', 'resume', 'retry', 'cancel', 'openFolder', 'remove'];
const amount = (value: number): number => Math.max(0, Number.isFinite(value) ? value : 0);
const bytes = (value: number): string => {
  const size = amount(value), unit = size >= 1024 ** 3 ? 3 : size >= 1024 ** 2 ? 2 : size >= 1024 ? 1 : 0;
  return `${(size / 1024 ** unit).toLocaleString('fr-FR', { maximumFractionDigits: unit ? 1 : 0 })} ${['o', 'Kio', 'Mio', 'Gio'][unit]}`;
};
const setText = (element: HTMLElement, value: string): void => { if (element.textContent !== value) element.textContent = value; };

/** Retains each queue row across progress updates and ignores unrelated gameplay snapshots. */
export class DownloadsControls {
  private readonly abort = new AbortController();
  private readonly rows = new Map<string, Row>();
  private readonly pending = new Set<string>();
  private summary: DownloadsSummary | null = null;
  private choosingRoot = false;
  private disposed = false;

  constructor(private readonly options: Options) {
    this.element('#downloads-choose-root').addEventListener('click', () => { void this.chooseRoot(); }, { signal: this.abort.signal });
    this.renderSummary();
  }

  update(snapshot: { downloads?: DownloadsSummary }): void {
    const next = snapshot.downloads;
    if (!next || this.disposed) return;
    if (this.summary && next.revision === this.summary.revision && next.rootPath === this.summary.rootPath && next.error === this.summary.error) return;
    this.summary = next; this.renderRows(); this.renderSummary();
  }
  dispose(): void { this.disposed = true; this.abort.abort(); this.rows.clear(); this.pending.clear(); }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.options.root.querySelector<T>(selector);
    if (!element) throw Error(`Missing downloads control: ${selector}`);
    return element;
  }
  private feedback(message: string, error = false): void {
    const element = this.element('#downloads-feedback'); setText(element, message); element.hidden = !message; element.classList.toggle('is-error', error);
  }
  private async chooseRoot(): Promise<void> {
    if (!this.summary || this.choosingRoot || this.disposed) return;
    this.choosingRoot = true; const previous = this.summary.rootPath;
    this.feedback(''); this.renderSummary();
    try {
      const result = await this.options.command('downloads.chooseRoot') as Response | undefined;
      if (this.disposed) return;
      if (!result?.ok) this.feedback(result?.error || 'Le dossier de téléchargement n’a pas pu être sélectionné.', true);
      else if (this.summary.rootPath !== previous) this.feedback('Les prochains téléchargements utiliseront ce dossier. Les éléments déjà ajoutés conservent leur destination.');
    } catch { if (!this.disposed) this.feedback('Le dossier de téléchargement n’a pas pu être sélectionné.', true); }
    finally { this.choosingRoot = false; if (!this.disposed) this.renderSummary(); }
  }
  private async action(action: DownloadAction, id: string): Promise<void> {
    const item = this.summary?.items.find(candidate => candidate.id === id);
    if (!item || this.disposed || this.pending.has(id) || !allowed[action].includes(item.state)) return;
    const document = this.options.root.ownerDocument, row = this.rows.get(id);
    const restoreFocus = !!row?.element.contains(document.activeElement);
    this.pending.add(id); this.feedback(''); this.refreshActions(item);
    try {
      const response = await this.options.command(`downloads.${action}`, { id }) as Response | undefined;
      if (this.disposed) return;
      if (!response?.ok) this.feedback(response?.error || 'Cette action n’a pas pu être appliquée au téléchargement.', true);
      else if (action === 'remove') this.feedback('Le téléchargement a été retiré de la liste.');
      else if (action === 'openFolder') this.feedback('Le dossier téléchargé a été ouvert.');
    } catch { if (!this.disposed) this.feedback('La file de téléchargements ne répond pas. Réessayez.', true); }
    finally {
      this.pending.delete(id);
      if (!this.disposed) {
        const current = this.summary?.items.find(candidate => candidate.id === id);
        if (current) this.refreshActions(current);
        if (restoreFocus && (document.activeElement === document.body || row?.element.contains(document.activeElement))) {
          const present = this.rows.get(id);
          const target = present?.actions.get(action);
          const fallback = present && [...present.actions.values()].find(button => !button.hidden && !button.disabled);
          if (target && !target.hidden && !target.disabled) target.focus({ preventScroll: true });
          else if (fallback) fallback.focus({ preventScroll: true });
          else this.element<HTMLButtonElement>('#downloads-choose-root').focus({ preventScroll: true });
        }
      }
    }
  }
  private renderSummary(): void {
    const summary = this.summary, items = summary?.items ?? [];
    const root = this.element('#downloads-root'); setText(root, summary?.rootPath || 'Aucun dossier sélectionné'); root.title = summary?.rootPath || '';
    this.element<HTMLButtonElement>('#downloads-choose-root').disabled = !summary || this.choosingRoot;
    setText(this.element('#downloads-count'), `${items.length.toLocaleString('fr-FR')} téléchargement${items.length > 1 ? 's' : ''}`);
    this.element('#downloads-empty').hidden = items.length > 0;
    const groups: [DownloadState, string, string][] = [['Downloading', 'en cours', 'en cours'], ['Queued', 'en attente', 'en attente'], ['Paused', 'en pause', 'en pause'], ['Completed', 'terminé', 'terminés'], ['Failed', 'en échec', 'en échec'], ['Cancelled', 'annulé', 'annulés']];
    const counts = groups.map(([state, singular, plural]) => { const total = items.filter(item => item.state === state).length; return total ? `${total.toLocaleString('fr-FR')} ${total > 1 ? plural : singular}` : ''; }).filter(Boolean);
    setText(this.element('#downloads-status'), counts.join(' · ') || 'La file est vide.');
    const error = this.element('#downloads-error'); setText(error, summary?.error || ''); error.hidden = !summary?.error;
  }
  private createRow(item: DownloadItem): Row {
    const document = this.options.root.ownerDocument;
    const element = document.createElement('article'); element.className = 'download-item'; element.dataset.downloadId = item.id; element.setAttribute('role', 'listitem');
    const header = document.createElement('div'); header.className = 'download-item-heading';
    const information = document.createElement('div'); information.className = 'download-item-information';
    const title = document.createElement('h3'); title.id = `download-title-${item.id}`;
    const metadata = document.createElement('p'); metadata.className = 'download-item-metadata'; information.append(title, metadata);
    const status = document.createElement('span'); status.className = 'download-state'; status.dataset.downloadStatus = ''; header.append(information, status);
    const progress = document.createElement('progress'); progress.className = 'download-progress'; progress.dataset.downloadProgress = ''; progress.setAttribute('aria-labelledby', title.id);
    const details = document.createElement('div'); details.className = 'download-progress-details';
    const bytes = document.createElement('span'); bytes.dataset.downloadBytes = '';
    const files = document.createElement('span'); files.dataset.downloadFiles = ''; details.append(bytes, files);
    const currentFile = document.createElement('p'); currentFile.className = 'download-current-file'; currentFile.dataset.downloadCurrentFile = '';
    const error = document.createElement('p'); error.className = 'download-error'; error.dataset.downloadError = ''; error.setAttribute('role', 'status');
    const destination = document.createElement('code'); destination.className = 'download-destination'; destination.dataset.downloadDestination = '';
    const buttons = document.createElement('div'); buttons.className = 'download-actions';
    const actionMap = new Map<DownloadAction, HTMLButtonElement>();
    for (const action of actions) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary'; button.dataset.downloadAction = action; button.textContent = labels[action];
      button.addEventListener('click', () => { void this.action(action, item.id); }, { signal: this.abort.signal });
      actionMap.set(action, button); buttons.append(button);
    }
    element.append(header, progress, details, currentFile, error, destination, buttons);
    return { element, title, metadata, status, progress, bytes, files, currentFile, error, destination, actions: actionMap };
  }
  private renderRows(): void {
    const items = this.summary?.items ?? [], ids = new Set(items.map(item => item.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.element.remove(); this.rows.delete(id); }
    const container = this.element('#downloads-items');
    items.forEach((item, index) => {
      let row = this.rows.get(item.id);
      if (!row) { row = this.createRow(item); this.rows.set(item.id, row); }
      if (container.children[index] !== row.element) container.insertBefore(row.element, container.children[index] ?? null);
      row.element.dataset.downloadState = item.state;
      setText(row.title, item.title || 'Titre non renseigné');
      setText(row.metadata, [item.artist || 'Artiste non renseigné', item.charter ? `Chart : ${item.charter}` : ''].filter(Boolean).join(' · '));
      setText(row.status, states[item.state]); row.status.dataset.state = item.state;
      const received = amount(item.receivedBytes), total = item.totalBytes === null ? null : amount(item.totalBytes);
      const completed = Math.trunc(amount(item.completedFiles)), totalFiles = item.totalFiles === null ? null : Math.trunc(amount(item.totalFiles));
      const percentage = total && total > 0 ? Math.min(100, Math.floor(received / total * 100)) : null;
      const transferred = `${bytes(received)}${total !== null ? ` / ${bytes(total)}` : ' reçus'}${percentage !== null ? ` · ${percentage} %` : ''}`;
      setText(row.bytes, transferred);
      setText(row.files, totalFiles !== null ? `${completed.toLocaleString('fr-FR')} / ${totalFiles.toLocaleString('fr-FR')} fichier${totalFiles > 1 ? 's' : ''}` : `${completed.toLocaleString('fr-FR')} fichier${completed > 1 ? 's' : ''} terminé${completed > 1 ? 's' : ''}`);
      if (item.state === 'Completed') { row.progress.max = 1; row.progress.value = 1; }
      else if (total && total > 0) { row.progress.max = total; row.progress.value = Math.min(received, total); }
      else if (item.state === 'Downloading') { row.progress.removeAttribute('value'); }
      else { row.progress.max = 1; row.progress.value = totalFiles ? Math.min(1, completed / totalFiles) : 0; }
      row.progress.setAttribute('aria-valuetext', `${states[item.state]} · ${transferred}`);
      setText(row.currentFile, item.currentFile ? `Fichier : ${item.currentFile}` : ''); row.currentFile.hidden = !item.currentFile;
      setText(row.error, item.error || ''); row.error.hidden = !item.error;
      setText(row.destination, item.destination || ''); row.destination.hidden = !item.destination; row.destination.title = item.destination || '';
      this.refreshActions(item);
    });
  }
  private refreshActions(item: DownloadItem): void {
    const row = this.rows.get(item.id); if (!row) return;
    const document = this.options.root.ownerDocument, active = document.activeElement;
    for (const [action, button] of row.actions) {
      button.hidden = !allowed[action].includes(item.state); button.disabled = this.pending.has(item.id);
      button.setAttribute('aria-label', `${labels[action]} : ${item.title || 'cette chart'}`);
    }
    if (!this.pending.has(item.id) && active instanceof HTMLButtonElement && row.element.contains(active) && active.hidden) {
      [...row.actions.values()].find(button => !button.hidden && !button.disabled)?.focus({ preventScroll: true });
    }
  }
}
