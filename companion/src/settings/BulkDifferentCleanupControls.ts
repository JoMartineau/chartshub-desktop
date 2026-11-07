import { localizedPair } from '../localization/locale-pair.js';
interface CleanupTarget {
  id: string; relativePath: string; targetRelativePath: string | null; kind: 'folder' | 'sng' | null; bytes: number | null;
  audio: { status: 'verified' | 'missing' | 'unavailable'; count: number; bytes: number };
}
interface FileDifference {
  name: string; category: 'notes' | 'audio' | 'artwork' | 'metadata' | 'other';
  status: 'identical' | 'changed' | 'only-keeper' | 'only-copy' | 'unverified'; keeperBytes: number | null; copyBytes: number | null;
}
interface BulkCandidate extends CleanupTarget {
  keeperId: string; eligible: false; forceable: true; reason: string | null;
  differences: { status: 'verified'; files: FileDifference[] };
}
interface BulkPlan {
  planId: string; revision: number;
  keepers: (CleanupTarget & { title?: string; artist?: string; charter?: string })[];
  candidates: BulkCandidate[];
  summary: { totalGroups: number; readyGroups: number; needsKeeperGroups: number; blockedGroups: number; identicalGroups: number; candidateCount: number };
}
interface BulkResult { recycledIds: string[]; failed: { id: string; reason: string }[]; cancelled: boolean; refreshRequested: boolean; historyError?: string; }
interface BulkState {
  rootPath: string | null; revision: number; scanning: boolean; busy: boolean;
  progress?: { phase: 'preparing' | 'executing'; processed: number; total: number } | null;
}
interface BulkOptions {
  root: HTMLElement; command: (name: string, payload?: unknown) => Promise<unknown>;
  refreshIndex: () => void; availabilityChanged: () => void;
}
const language = (): string => typeof document === 'undefined' ? 'fr' : document.documentElement.lang || 'en';
const tr = (fr: string, en: string, values?: Record<string, unknown>): string => localizedPair(language(), fr, en, values);
const number = (value: number): string => value.toLocaleString(language());
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const token = (value: unknown, length: number): value is string => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const categories = { notes: ['Notes', 'Notes'], audio: ['Audio', 'Audio'], artwork: ['Illustration', 'Artwork'], metadata: ['Métadonnées', 'Metadata'], other: ['Autre', 'Other'] } as const;
const statuses = { identical: ['Identique', 'Identical'], changed: ['Modifié', 'Changed'], 'only-keeper': ['Uniquement dans la version conservée', 'Only in the kept version'], 'only-copy': ['Uniquement dans cette copie', 'Only in this copy'], unverified: ['Non vérifié', 'Unverified'] } as const;

/** Prepares one reviewed batch of different copies; native confirmation owns recycling. */
export class BulkDifferentCleanupControls {
  private readonly abort = new AbortController();
  private cardsAbort = new AbortController();
  private state: BulkState | null = null;
  private plan: BulkPlan | null = null;
  private readonly selected = new Set<string>();
  private readonly checks = new Map<string, HTMLInputElement>();
  private serial = 0;
  private interaction = 0;
  private preparing = false;
  private executing = false;
  private cancelling = false;
  private disposed = false;
  private message: { fr: string; en: string; error: boolean } | null = null;
  private outcome: { fr: string; en: string; error: boolean; result?: { copies: number; failed: number; untreated: number; cancelled: boolean; historyError: boolean } } | null = null;

  constructor(private readonly options: BulkOptions) {
    const signal = this.abort.signal;
    this.element('#library-bulk-cleanup-prepare').addEventListener('click', () => { void this.prepare(); }, { signal });
    this.element('#library-bulk-cleanup-cancel').addEventListener('click', () => { void this.cancel(); }, { signal });
    this.element('#library-bulk-cleanup-close').addEventListener('click', () => { if (!this.busy) this.invalidate(); }, { signal });
    this.element('#library-bulk-cleanup-select-all').addEventListener('click', () => {
      if (!this.plan || this.blocked) return;
      for (const item of this.plan.candidates) this.selected.add(item.id);
      this.refreshSelection();
    }, { signal });
    this.element('#library-bulk-cleanup-clear').addEventListener('click', () => {
      if (this.blocked) return;
      this.selected.clear(); this.refreshSelection();
    }, { signal });
    this.element('#library-bulk-cleanup-recycle').addEventListener('click', () => { void this.recycle(); }, { signal });
    options.root.addEventListener('companion:duplicate-choice-changed', () => this.invalidate(true), { signal });
    options.root.addEventListener('companion:duplicate-context-changed', () => this.invalidate(true), { signal });
    for (const event of ['pointerdown', 'keydown', 'wheel']) options.root.addEventListener(event, () => { this.interaction++; }, { signal, passive: true });
    if (typeof window !== 'undefined') window.addEventListener('chartshub:languagechange', () => this.render(), { signal });
    this.render();
  }

  get busy(): boolean { return this.preparing || this.executing; }
  private get blocked(): boolean { return this.busy || !this.state?.rootPath || this.state.scanning || this.state.busy || !!this.state.progress; }

  update(state: BulkState): void {
    if (this.disposed) return;
    const changed = this.state && (state.rootPath !== this.state.rootPath || state.revision !== this.state.revision);
    const ownCommit = this.executing && this.state && state.rootPath === this.state.rootPath
      && state.revision === this.state.revision + 1 && !state.scanning;
    const interrupted = state.scanning && !this.state?.scanning;
    this.state = state;
    if ((changed && !ownCommit) || interrupted) this.invalidate(true);
    else if (changed && ownCommit) this.clearPlan();
    this.refreshAvailability(); this.renderStatus();
  }

  dispose(): void {
    this.disposed = true; this.serial++; this.abort.abort(); this.cardsAbort.abort(); this.selected.clear(); this.checks.clear();
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.options.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing bulk cleanup control: ${selector}`);
    return element;
  }

  private clearPlan(): void {
    this.plan = null; this.selected.clear(); this.checks.clear(); this.cardsAbort.abort(); this.cardsAbort = new AbortController();
    this.element('#library-bulk-cleanup-plan').hidden = true;
    this.element('#library-bulk-cleanup-candidates').textContent = '';
  }

  private invalidate(changed = false): void {
    this.serial++; this.preparing = false; this.executing = false; this.cancelling = false; this.clearPlan();
    this.outcome = null;
    this.message = changed ? {
      fr: 'La bibliothèque ou le choix des versions a changé. Préparez une nouvelle sélection avant de supprimer.',
      en: 'The library or kept versions changed. Prepare a new selection before deleting.', error: true,
    } : null;
    this.render(); this.options.availabilityChanged();
  }

  private current(serial: number, root: string, revision?: number): boolean {
    return !this.disposed && serial === this.serial && root === this.state?.rootPath && !this.state.scanning
      && (revision === undefined || revision === this.state.revision);
  }

  private async prepare(): Promise<void> {
    if (this.blocked || !this.state?.rootPath) return;
    const serial = ++this.serial, root = this.state.rootPath, revision = this.state.revision;
    this.clearPlan(); this.message = null; this.outcome = null; this.preparing = true; this.cancelling = false;
    this.render(); this.options.availabilityChanged();
    try {
      const response = await this.options.command('library.prepareBulkCleanup', {}) as { ok?: boolean; result?: BulkPlan; error?: string } | undefined;
      if (!this.current(serial, root, revision)) return;
      if (!response?.ok || !this.validPlan(response.result, revision)) throw new Error('Invalid bulk cleanup plan');
      this.plan = response.result!;
      this.message = this.plan.candidates.length ? null : {
        fr: 'Aucune copie différente vérifiée à sélectionner. Choisissez les versions à garder avec « Comparer » dans la liste.',
        en: 'No verified different copy to select. Choose kept versions using “Compare” in the list.', error: false,
      };
      this.renderPlan();
    } catch {
      if (!this.current(serial, root, revision)) return;
      this.message = { fr: 'La préparation est indisponible ou a été interrompue. Aucun fichier supprimé. Réessayez quand la bibliothèque est disponible.', en: 'Preparation is unavailable or was interrupted. No files deleted. Try again when the library is available.', error: true };
    } finally {
      if (!this.disposed && serial === this.serial) {
        this.preparing = false; this.cancelling = false; this.render(); this.options.availabilityChanged();
      }
    }
  }

  private validTarget(target: CleanupTarget | undefined): boolean {
    return !!target && token(target.id, 64) && typeof target.relativePath === 'string'
      && typeof target.targetRelativePath === 'string' && target.targetRelativePath.length > 0
      && (target.kind === 'folder' || target.kind === 'sng') && safeCount(target.bytes)
      && target.audio?.status === 'verified' && safeCount(target.audio.count) && target.audio.count > 0 && safeCount(target.audio.bytes);
  }

  private validPlan(plan: BulkPlan | undefined, revision: number): boolean {
    if (!plan || !token(plan.planId, 32) || plan.revision !== revision || !Array.isArray(plan.keepers) || !Array.isArray(plan.candidates)
      || !plan.summary || ['totalGroups', 'readyGroups', 'needsKeeperGroups', 'blockedGroups', 'identicalGroups', 'candidateCount'].some(key => !safeCount(plan.summary[key as keyof BulkPlan['summary']])) || plan.summary.candidateCount !== plan.candidates.length
      || plan.keepers.some(item => !this.validTarget(item))) return false;
    const keepers = new Set(plan.keepers.map(item => item.id)), copies = new Set<string>();
    if (keepers.size !== plan.keepers.length) return false;
    let bytes = 0;
    for (const item of plan.candidates) {
      if (!this.validTarget(item) || !keepers.has(item.keeperId) || keepers.has(item.id) || copies.has(item.id)
        || item.eligible !== false || item.forceable !== true || item.differences?.status !== 'verified' || !Array.isArray(item.differences.files)
        || !item.differences.files.length || item.differences.files.some(file => !file || typeof file.name !== 'string' || !file.name
          || !Object.hasOwn(categories, file.category) || !Object.hasOwn(statuses, file.status) || file.status === 'unverified'
          || (file.keeperBytes !== null && !safeCount(file.keeperBytes)) || (file.copyBytes !== null && !safeCount(file.copyBytes)))) return false;
      copies.add(item.id); bytes += item.bytes!;
      if (!Number.isSafeInteger(bytes)) return false;
    }
    return true;
  }

  private async cancel(): Promise<void> {
    if (!this.busy || this.cancelling || !this.state?.rootPath) return;
    const serial = this.serial, root = this.state.rootPath;
    this.cancelling = true; this.render();
    try {
      const response = await this.options.command('library.cancelBulkCleanup', {}) as { ok?: boolean } | undefined;
      if (this.current(serial, root) && !response?.ok) this.message = { fr: 'L’arrêt n’a pas pu être confirmé. Attendez le résultat.', en: 'The stop could not be confirmed. Wait for the result.', error: true };
    } catch {
      if (this.current(serial, root)) this.message = { fr: 'L’arrêt n’a pas pu être confirmé. Attendez le résultat.', en: 'The stop could not be confirmed. Wait for the result.', error: true };
    } finally { if (this.current(serial, root)) this.renderStatus(); }
  }

  private async recycle(): Promise<void> {
    const plan = this.plan;
    if (!plan || this.blocked || !this.state?.rootPath || plan.revision !== this.state.revision) return;
    const ids = plan.candidates.filter(item => this.selected.has(item.id)).map(item => item.id);
    if (!ids.length) return;
    const serial = ++this.serial, root = this.state.rootPath, interaction = this.interaction;
    this.executing = true; this.cancelling = false; this.message = null; this.outcome = null;
    this.render(); this.options.availabilityChanged();
    try {
      const response = await this.options.command('library.recycleBulkDifferences', { planId: plan.planId, revision: plan.revision, ids }) as { ok?: boolean; cancelled?: boolean; result?: BulkResult } | undefined;
      if (!this.current(serial, root)) return;
      if (response?.cancelled === true && !response.result) {
        this.outcome = { fr: 'Suppression groupée annulée dans la confirmation Windows. Aucun fichier envoyé à la Corbeille.', en: 'Bulk deletion cancelled in Windows confirmation. No files sent to the Recycle Bin.', error: false };
      } else {
        const result = response?.result;
        if (!response?.ok || !this.validResult(result, ids)) throw new Error('Invalid bulk cleanup result');
        this.outcome = {
          fr: 'Copies différentes envoyées à la Corbeille Windows : {copies}. Les versions conservées sont protégées.',
          en: 'Different copies sent to the Windows Recycle Bin: {copies}. Kept versions are protected.',
          error: result!.failed.length > 0 || !!result!.historyError,
          result: { copies: result!.recycledIds.length, failed: result!.failed.length,
            untreated: ids.length - result!.recycledIds.length - result!.failed.length,
            cancelled: result!.cancelled, historyError: !!result!.historyError },
        };
        if (result!.recycledIds.length) this.options.refreshIndex();
      }
    } catch {
      if (!this.current(serial, root)) return;
      this.outcome = { fr: 'La suppression groupée n’a pas pu être confirmée. Préparez à nouveau les copies et vérifiez les résultats ; aucune nouvelle analyse n’a été lancée.', en: 'Bulk deletion could not be confirmed. Prepare copies again and check the results; no new scan was started.', error: true };
    } finally {
      if (!this.disposed && serial === this.serial) {
        this.executing = false; this.cancelling = false; this.clearPlan(); this.render(); this.options.availabilityChanged();
        if (this.outcome && interaction === this.interaction) {
          const outcome = this.element('#library-bulk-cleanup-result'); outcome.focus({ preventScroll: true }); outcome.scrollIntoView?.({ block: 'nearest' });
        }
      }
    }
  }

  private validResult(result: BulkResult | undefined, selected: string[]): boolean {
    if (!result || !Array.isArray(result.recycledIds) || !Array.isArray(result.failed) || typeof result.cancelled !== 'boolean' || result.refreshRequested !== false) return false;
    const ids = new Set(selected), outcomes = new Set<string>();
    for (const id of result.recycledIds) { if (!ids.has(id) || outcomes.has(id)) return false; outcomes.add(id); }
    for (const failure of result.failed) {
      if (!failure || !ids.has(failure.id) || outcomes.has(failure.id) || typeof failure.reason !== 'string') return false;
      outcomes.add(failure.id);
    }
    return result.cancelled || result.failed.length > 0 || outcomes.size === selected.length;
  }

  private render(): void {
    this.element('#library-bulk-cleanup-prepare').textContent = tr('Préparer les copies différentes', 'Prepare different copies');
    this.element('#library-bulk-cleanup-select-all').textContent = tr('Tout sélectionner', 'Select all');
    this.element('#library-bulk-cleanup-clear').textContent = tr('Tout décocher', 'Clear selection');
    this.element('#library-bulk-cleanup-close').textContent = tr('Fermer la sélection', 'Close selection');
    if (this.plan) this.renderPlan();
    this.renderStatus(); this.refreshAvailability();
  }

  private renderStatus(): void {
    const status = this.element('#library-bulk-cleanup-status'); status.classList.toggle('is-error', !!this.message?.error);
    if (this.busy) {
      const progress = this.state?.progress, processed = number(progress?.processed ?? 0), total = number(progress?.total ?? 0);
      status.textContent = this.cancelling ? tr('Arrêt demandé ; attendez la fin de la copie en cours.', 'Stop requested; wait for the current copy to finish.')
        : this.executing ? tr("Confirmation Windows, puis nettoyage des copies sélectionnées · {processed} / {total}.", "Windows confirmation, then cleanup of selected copies · {processed} / {total}.", { processed, total })
          : tr("Vérification des groupes · {processed} / {total}. Aucun fichier supprimé.", "Checking groups · {processed} / {total}. No files deleted.", { processed, total });
    } else status.textContent = this.message ? tr(this.message.fr, this.message.en) : tr('Prépare les copies vérifiées qui diffèrent. Aucune copie n’est cochée automatiquement.', 'Prepares verified copies that differ. No copy is selected automatically.');
    const result = this.element('#library-bulk-cleanup-result'); result.hidden = !this.outcome;
    const outcome = this.outcome, summary = outcome?.result;
    result.textContent = outcome ? tr(outcome.fr, outcome.en, summary && { copies: number(summary.copies) }) : '';
    if (summary) {
      if (summary.failed) result.textContent += ' ' + tr('Échecs : {count}. Ces copies restent en place.', 'Failures: {count}. Those copies stay in place.', { count: number(summary.failed) });
      if (summary.cancelled) result.textContent += ' ' + tr('Opération interrompue.', 'Operation stopped.');
      if (summary.untreated) result.textContent += ' ' + tr('Copies non traitées conservées : {count}.', 'Unprocessed copies left in place: {count}.', { count: number(summary.untreated) });
      result.textContent += ' ' + tr('Continuez le nettoyage, puis cliquez sur « Actualiser à la fin ».', 'Continue cleanup, then click “Refresh when finished”.');
      if (summary.historyError) result.textContent += ' ' + tr('L’historique n’a pas pu être enregistré. Le résultat ci-dessus reste valide.', 'History could not be saved. The result above remains valid.');
    }
    result.classList.toggle('is-error', !!this.outcome?.error);
    const cancel = this.element<HTMLButtonElement>('#library-bulk-cleanup-cancel');
    cancel.hidden = !this.busy; cancel.disabled = !this.busy || this.cancelling;
    cancel.textContent = this.cancelling ? tr('Arrêt en cours…', 'Stopping…') : tr('Arrêter', 'Stop');
  }

  private renderPlan(): void {
    const plan = this.plan; if (!plan) return;
    this.cardsAbort.abort(); this.cardsAbort = new AbortController(); this.checks.clear();
    const document = this.options.root.ownerDocument, candidates = this.element('#library-bulk-cleanup-candidates');
    candidates.textContent = ''; this.element('#library-bulk-cleanup-plan').hidden = false;
    const summary = plan.summary;
    this.element('#library-bulk-cleanup-summary').textContent = tr(
      "Copies différentes vérifiées : {copies} · Groupes prêts : {ready} · Choix de version requis : {choices} · Groupes bloqués : {blocked} · Groupes identiques : {identical}. Utilisez « Comparer » pour choisir les versions à garder.", "Verified different copies: {copies} · Groups ready: {ready} · Keeper choices required: {choices} · Groups blocked: {blocked} · Identical groups: {identical}. Use “Compare” to choose the versions to keep.", { copies: number(summary.candidateCount), ready: number(summary.readyGroups), choices: number(summary.needsKeeperGroups), blocked: number(summary.blockedGroups), identical: number(summary.identicalGroups) },
    );
    const grouped = new Map<string, BulkCandidate[]>();
    for (const candidate of plan.candidates) {
      const group = grouped.get(candidate.keeperId) ?? []; group.push(candidate); grouped.set(candidate.keeperId, group);
    }
    for (const keeper of plan.keepers) {
      const group = document.createElement('div'); group.className = 'library-bulk-cleanup-group';
      const kept = document.createElement('div'); kept.className = 'library-cleanup-keep';
      const label = document.createElement('strong'); label.textContent = tr('Version conservée · exclue du nettoyage', 'Kept version · excluded from cleanup');
      const title = document.createElement('span'); title.className = 'library-bulk-cleanup-song'; title.textContent = [keeper.title, keeper.artist, keeper.charter].filter(Boolean).join(' · ');
      const path = document.createElement('code'); path.className = 'library-cleanup-path'; path.textContent = keeper.targetRelativePath;
      kept.append(label, title, path); group.append(kept);
      for (const candidate of grouped.get(keeper.id) ?? []) {
        const card = document.createElement('div'); card.className = 'library-cleanup-candidate'; card.dataset.bulkCleanupId = candidate.id;
        const choice = document.createElement('label'); choice.className = 'library-cleanup-choice';
        const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'library-bulk-cleanup-check'; check.dataset.cleanupId = candidate.id; check.checked = this.selected.has(candidate.id); this.checks.set(candidate.id, check);
        const label = document.createElement('span'); label.textContent = tr('Supprimer quand même cette copie différente', 'Delete this different copy anyway');
        check.addEventListener('change', () => {
          if (this.blocked || this.plan !== plan) { check.checked = this.selected.has(candidate.id); return; }
          if (check.checked) this.selected.add(candidate.id); else this.selected.delete(candidate.id);
          this.refreshSelection();
        }, { signal: this.cardsAbort.signal });
        choice.append(check, label);
        const path = document.createElement('code'); path.className = 'library-cleanup-path'; path.textContent = candidate.targetRelativePath;
        const target = document.createElement('p'); target.textContent = tr('{kind} · {bytes} octets', '{kind} · {bytes} bytes', { kind: candidate.kind === 'sng' ? tr('Fichier .sng uniquement', '.sng file only') : tr('Dossier entier, avec tout son contenu', 'Entire folder, including all contents'), bytes: number(candidate.bytes!) });
        const warning = document.createElement('p'); warning.className = 'library-cleanup-reason';
        warning.textContent = tr('Les notes, l’audio ou les autres fichiers diffèrent. Consultez les différences avant de sélectionner.', 'Notes, audio or other files differ. Review differences before selecting.');
        card.append(choice, path, target, warning); this.renderDifferences(candidate, card); group.append(card);
      }
      candidates.append(group);
    }
    this.refreshSelection();
  }

  private renderDifferences(candidate: BulkCandidate, card: HTMLElement): void {
    const document = this.options.root.ownerDocument, details = document.createElement('details'); details.className = 'library-file-differences'; details.open = true;
    const files = candidate.differences.files;
    const summary = document.createElement('summary'); summary.textContent = tr("Comparer les fichiers · Différences : {count}", "Compare files · Differences: {count}", { count: number(files.filter(file => file.status !== 'identical').length) });
    const table = document.createElement('table'); table.className = 'library-file-differences-table';
    const caption = document.createElement('caption'); caption.textContent = tr('Comparaison du contenu des fichiers avec la version conservée', 'File contents compared with the kept version');
    const head = document.createElement('thead'), heading = document.createElement('tr');
    for (const label of [tr('Fichier', 'File'), tr('Type', 'Type'), tr('Comparaison', 'Comparison'), tr('Version conservée (octets)', 'Kept version (bytes)'), tr('Cette copie (octets)', 'This copy (bytes)')]) {
      const cell = document.createElement('th'); cell.setAttribute('scope', 'col'); cell.textContent = label; heading.append(cell);
    }
    head.append(heading); const body = document.createElement('tbody');
    for (const file of files) {
      const row = document.createElement('tr'), name = document.createElement('td'), code = document.createElement('code'); code.textContent = file.name; name.append(code); row.append(name);
      const category = categories[file.category], status = statuses[file.status];
      for (const value of [tr(category[0], category[1]), tr(status[0], status[1]), file.keeperBytes === null ? '—' : number(file.keeperBytes), file.copyBytes === null ? '—' : number(file.copyBytes)]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      body.append(row);
    }
    table.append(caption, head, body); details.append(summary, table); card.append(details);
  }

  private refreshSelection(): void {
    const selected = this.plan?.candidates.filter(item => this.selected.has(item.id)) ?? [];
    for (const [id, check] of this.checks) check.checked = this.selected.has(id);
    const count = number(selected.length), bytes = number(selected.reduce((total, item) => total + item.bytes!, 0));
    this.element('#library-bulk-cleanup-selection').textContent = tr("Copies sélectionnées : {count} · {bytes} octets. Les versions conservées et les copies non cochées restent en place.", "Selected copies: {count} · {bytes} bytes. Kept versions and unchecked copies stay in place.", { count, bytes });
    this.element('#library-bulk-cleanup-recycle').textContent = selected.length
      ? tr("Supprimer les copies sélectionnées ({count})…", "Delete selected copies ({count})…", { count })
      : tr('Cochez les copies à supprimer quand même', 'Select the copies to delete anyway');
    this.refreshAvailability();
  }

  private refreshAvailability(): void {
    this.element<HTMLButtonElement>('#library-bulk-cleanup-prepare').disabled = this.blocked;
    this.element<HTMLButtonElement>('#library-bulk-cleanup-close').disabled = this.busy;
    this.element<HTMLButtonElement>('#library-bulk-cleanup-select-all').disabled = this.blocked || !this.plan?.candidates.length;
    this.element<HTMLButtonElement>('#library-bulk-cleanup-clear').disabled = this.blocked || !this.selected.size;
    this.element<HTMLButtonElement>('#library-bulk-cleanup-recycle').disabled = this.blocked || !this.plan || !this.selected.size;
    for (const check of this.checks.values()) check.disabled = this.blocked;
    this.element('#library-bulk-cleanup').setAttribute('aria-busy', String(this.busy));
  }
}
