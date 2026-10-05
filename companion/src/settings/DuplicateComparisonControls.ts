interface ComparisonVariant {
  id: string; relativePath: string; format: 'chart' | 'midi' | 'sng'; audio: 'present' | 'missing' | 'unknown';
  title?: string; artist?: string; charter?: string;
  notes: { status: 'readable' | 'unavailable' | 'unsupported'; format: 'chart' | 'midi' | null; bytes: number | null; modifiedAt: string | null; reason: string | null };
  noteGroup: number | null; identicalCount: number;
}
interface ComparisonResult {
  contextId: string; revision: number; title: string; artist: string; charter: string;
  preferredId: string | null; selectionError: string | null; canChoose: boolean;
  summary: { total: number; readable: number; noteGroups: number; identicalGroups: number; unverified: number };
  variants: ComparisonVariant[];
}
interface ComparisonState { rootPath: string | null; revision: number; scanning: boolean; busy: boolean; }
interface CleanupTarget {
  id: string; relativePath: string; targetRelativePath: string | null; kind: 'folder' | 'sng' | null; bytes: number | null;
  audio: { status: 'verified' | 'missing' | 'unavailable'; count: number; bytes: number };
}
interface CleanupPlan {
  planId: string; contextId: string; revision: number; keepId: string; keep: CleanupTarget;
  candidates: (CleanupTarget & { eligible: boolean; forceable: boolean; reason: string | null })[];
}
interface CleanupResult { recycledIds: string[]; failed: { id: string; reason: string }[]; cancelled: boolean; refreshRequested: boolean; }
interface ComparisonOptions {
  root: HTMLElement;
  command: (name: string, payload?: unknown) => Promise<unknown>;
  feedback: (message: string) => void;
}
const display = (value: string): string => value?.trim() ? value : '—';
const locale = (): string => typeof document === 'undefined' || document.documentElement.lang.startsWith('fr') ? 'fr-FR' : 'en-US';
const number = (value: number): string => Math.max(0, Math.trunc(value || 0)).toLocaleString(locale());
const format = (value: string | null): string => value === 'chart' ? '.chart' : value === 'midi' ? 'MIDI' : value === 'sng' ? '.sng' : 'Non vérifié';

/** A comparison is bound to one committed index revision, independently of list filters. */
export class DuplicateComparisonControls {
  private readonly abort = new AbortController();
  private cardAbort = new AbortController();
  private readonly cards = new Map<string, { card: HTMLElement; badge: HTMLElement; choose: HTMLButtonElement; open: HTMLButtonElement }>();
  private state: ComparisonState | null = null;
  private targetId: string | null = null;
  private trigger: HTMLButtonElement | null = null;
  private result: ComparisonResult | null = null;
  private serial = 0;
  private loading = false;
  private saving = false;
  private opening = false;
  private preparing = false;
  private executing = false;
  private executionSerial = 0;
  private cleanupPlan: CleanupPlan | null = null;
  private readonly cleanupSelection = new Set<string>();
  private cleanupAbort = new AbortController();
  private readonly cleanupChecks = new Map<string, HTMLInputElement>();
  private readonly cleanupForceButtons = new Map<string, HTMLButtonElement>();
  private needsReload = false;
  private disposed = false;

  constructor(private readonly options: ComparisonOptions) {
    this.element('#library-comparison-close').addEventListener('click', () => { if (!this.executing) this.close(true); }, { signal: this.abort.signal });
    this.element('#library-comparison-retry').addEventListener('click', () => { void this.load(); }, { signal: this.abort.signal });
    this.element('#library-comparison-clear').addEventListener('click', () => { void this.choose(null); }, { signal: this.abort.signal });
    this.element('#library-cleanup-prepare').addEventListener('click', () => { void this.prepareCleanup(); }, { signal: this.abort.signal });
    this.element('#library-cleanup-recycle').addEventListener('click', () => { void this.recycle(); }, { signal: this.abort.signal });
    this.element('#library-comparison').hidden = true;
    this.element('#library-cleanup-plan').hidden = true;
  }

  update(state: ComparisonState): void {
    if (this.disposed) return;
    const changed = this.state && (state.rootPath !== this.state.rootPath || state.revision !== this.state.revision);
    this.state = state;
    if (changed && this.targetId) {
      this.close(false);
      this.options.feedback('La bibliothèque a changé. Relancez « Comparer » pour vérifier les versions actuelles.');
    }
    this.refreshAvailability();
  }

  open(id: string, title: string, trigger: HTMLButtonElement): void {
    if (this.disposed || this.executing || !this.state?.rootPath || this.state.scanning || this.state.busy) return;
    this.close(false);
    this.targetId = id; this.trigger = trigger;
    this.element('#library-comparison').hidden = false;
    const heading = this.element('#library-comparison-title'); heading.textContent = `Comparer les versions · ${display(title)}`;
    heading.focus({ preventScroll: true });
    this.element('#library-comparison').scrollIntoView?.({ block: 'nearest' });
    void this.load();
  }

  dispose(): void { this.disposed = true; this.serial++; this.executionSerial++; this.abort.abort(); this.cardAbort.abort(); this.cleanupAbort.abort(); this.cards.clear(); this.cleanupChecks.clear(); this.cleanupForceButtons.clear(); }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.options.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing duplicate comparison control: ${selector}`);
    return element;
  }

  private close(restoreFocus: boolean): void {
    this.serial++; this.targetId = null; this.result = null; this.loading = false; this.saving = false; this.opening = false; this.needsReload = false;
    this.preparing = false; this.clearCleanup();
    this.clearCards(); this.element('#library-comparison').hidden = true;
    if (restoreFocus && this.trigger?.isConnected !== false) this.trigger?.focus({ preventScroll: true });
    this.trigger = null;
  }

  private clearCards(): void {
    this.cardAbort.abort(); this.cardAbort = new AbortController();
    this.cards.clear(); this.element('#library-comparison-cards').textContent = '';
  }

  private current(serial: number, root: string, revision: number): boolean {
    return !this.disposed && serial === this.serial && root === this.state?.rootPath && revision === this.state?.revision && this.targetId !== null;
  }

  private feedback(message: string, error = false): void {
    const feedback = this.element('#library-comparison-feedback'); feedback.textContent = message; feedback.hidden = !message;
    feedback.classList.toggle('is-error', error);
  }

  private async load(): Promise<void> {
    if (this.disposed || !this.targetId || !this.state?.rootPath || this.state.scanning || this.state.busy || this.loading || this.saving || this.preparing || this.executing) return;
    const serial = ++this.serial, root = this.state.rootPath, revision = this.state.revision;
    this.result = null; this.clearCards(); this.clearCleanup();
    this.element('#library-comparison-summary').textContent = 'Lecture des fichiers de notes…';
    this.loading = true; this.needsReload = false; this.opening = false; this.feedback(''); this.refreshAvailability();
    try {
      const response = await this.options.command('library.compareDuplicates', { id: this.targetId, revision }) as { ok: boolean; result?: ComparisonResult; error?: string } | undefined;
      if (!this.current(serial, root, revision)) return;
      const result = response?.result;
      if (!response?.ok || !result) throw new Error(response?.error || 'Comparaison indisponible. Réessayez après avoir vérifié les dossiers.');
      if (result.revision !== revision || !Array.isArray(result.variants) || !result.variants.length || !/^[a-f0-9]{32}$/i.test(result.contextId)) throw new Error('Cette comparaison est périmée ou indisponible. Rechargez-la.');
      this.result = result; this.renderCards();
      const summary = result.summary;
      this.element('#library-comparison-summary').textContent = `${number(summary.total)} versions · ${number(summary.readable)} fichiers de notes lisibles · ${number(summary.noteGroups)} groupes de notes · ${number(summary.identicalGroups)} groupes identiques · ${number(summary.unverified)} non vérifiées`;
      if (result.selectionError) this.feedback(result.selectionError, true);
      else if (!result.canChoose) this.feedback('L’enregistrement du choix est indisponible. Rechargez la comparaison pour réessayer.', true);
      this.needsReload = !result.canChoose;
    } catch (error) {
      if (!this.current(serial, root, revision)) return;
      this.result = null; this.clearCards();
      this.element('#library-comparison-summary').textContent = 'Comparaison indisponible';
      this.feedback(error instanceof Error ? error.message : 'La comparaison ne répond pas. Réessayez.', true); this.needsReload = true;
    } finally {
      if (this.current(serial, root, revision)) { this.loading = false; this.refreshAvailability(); }
    }
  }

  private async choose(id: string | null): Promise<void> {
    const result = this.result;
    let prepareAfterSave = false;
    if (!result || !this.state?.rootPath || this.disposed || this.loading || this.saving || this.opening || this.preparing || this.executing || this.needsReload || this.state.scanning || this.state.busy || !result.canChoose) return;
    if (id !== null && !result.variants.some(variant => variant.id === id && variant.notes.status === 'readable')) return;
    const serial = ++this.serial, root = this.state.rootPath, revision = this.state.revision;
    this.clearCleanup(); this.saving = true; this.feedback('Enregistrement du choix…'); this.refreshAvailability();
    try {
      const response = await this.options.command('library.chooseDuplicate', { contextId: result.contextId, revision, id }) as { ok: boolean; error?: string; result?: { contextId: string; revision: number; preferredId: string | null } } | undefined;
      if (!this.current(serial, root, revision)) return;
      if (!response?.ok) throw new Error(response?.error || 'Le choix n’a pas pu être enregistré. Rechargez la comparaison pour réessayer.');
      if (response.result?.contextId !== result.contextId || response.result.revision !== revision || response.result.preferredId !== id) throw new Error('La comparaison a changé. Rechargez-la avant de choisir une version.');
      result.preferredId = id;
      prepareAfterSave = id !== null;
      this.feedback(id === null ? 'Choix effacé. Tous les fichiers restent en place.' : 'Version à conserver enregistrée. Vérification automatique des autres versions…');
    } catch (error) {
      if (!this.current(serial, root, revision)) return;
      this.feedback(error instanceof Error ? error.message : 'Enregistrement indisponible. Rechargez la comparaison.', true); this.needsReload = true;
    } finally {
      if (this.current(serial, root, revision)) { this.saving = false; this.refreshAvailability(); }
    }
    if (prepareAfterSave && this.current(serial, root, revision) && result.preferredId === id && !this.needsReload) await this.prepareCleanup();
  }

  private async openFolder(id: string): Promise<void> {
    if (!this.result || !this.state?.rootPath || this.disposed || this.loading || this.saving || this.opening || this.preparing || this.executing || this.state.busy) return;
    const serial = this.serial, root = this.state.rootPath, revision = this.state.revision;
    this.opening = true; this.refreshAvailability();
    try {
      const response = await this.options.command('library.openFolder', { id }) as { ok: boolean } | undefined;
      if (this.current(serial, root, revision) && !response?.ok) this.feedback('Ce dossier ne peut pas être ouvert. Vérifiez qu’il est toujours disponible.', true);
    } catch { if (this.current(serial, root, revision)) this.feedback('Le dossier ne peut pas être ouvert. Réessayez.', true); }
    finally { if (this.current(serial, root, revision)) { this.opening = false; this.refreshAvailability(); } }
  }

  private clearCleanup(): void {
    this.cleanupPlan = null; this.cleanupSelection.clear(); this.cleanupChecks.clear(); this.cleanupForceButtons.clear();
    this.cleanupAbort.abort(); this.cleanupAbort = new AbortController();
    this.element('#library-cleanup-plan').hidden = true;
    this.element('#library-cleanup-keep').textContent = '';
    this.element('#library-cleanup-candidates').textContent = '';
  }

  private cleanupFeedback(message: string, error = false): void {
    const status = this.element('#library-cleanup-result');
    status.textContent = message; status.hidden = !message; status.classList.toggle('is-error', error);
  }

  private cleanupAvailable(): boolean {
    return !this.disposed && !!this.result?.preferredId && !!this.result.canChoose && !!this.state?.rootPath
      && !this.loading && !this.saving && !this.opening && !this.preparing && !this.executing
      && !this.needsReload && !this.state.scanning && !this.state.busy;
  }

  private async prepareCleanup(): Promise<void> {
    const comparison = this.result;
    if (!comparison?.preferredId || !this.state?.rootPath || !this.cleanupAvailable()) return;
    const serial = ++this.serial, root = this.state.rootPath, revision = this.state.revision, keepId = comparison.preferredId;
    this.clearCleanup(); this.preparing = true;
    this.feedback('Vérification des notes, de l’audio et de tous les fichiers…'); this.refreshAvailability();
    try {
      const response = await this.options.command('library.prepareCleanup', { contextId: comparison.contextId, revision, keepId }) as { ok: boolean; result?: CleanupPlan; error?: string } | undefined;
      if (!this.current(serial, root, revision)) return;
      const plan = response?.result;
      if (!response?.ok || !plan) throw new Error(response?.error || 'La vérification du nettoyage est indisponible. Rechargez la comparaison.');
      const ids = new Set(comparison.variants.map(variant => variant.id));
      const validTarget = (target: CleanupTarget): boolean => !!target && ids.has(target.id)
        && typeof target.relativePath === 'string' && (target.targetRelativePath === null || (typeof target.targetRelativePath === 'string' && !!target.targetRelativePath))
        && (target.kind === null || target.kind === 'folder' || target.kind === 'sng') && (target.bytes === null || (Number.isFinite(target.bytes) && target.bytes >= 0))
        && !!target.audio && ['verified', 'missing', 'unavailable'].includes(target.audio.status)
        && Number.isFinite(target.audio.count) && target.audio.count >= 0 && Number.isFinite(target.audio.bytes) && target.audio.bytes >= 0;
      if (plan.contextId !== comparison.contextId || plan.revision !== revision || plan.keepId !== keepId || !/^[a-f0-9]{32}$/i.test(plan.planId)
        || !validTarget(plan.keep) || plan.keep.id !== keepId || !Array.isArray(plan.candidates)
        || plan.candidates.some(candidate => !validTarget(candidate) || candidate.id === keepId || typeof candidate.eligible !== 'boolean' || typeof candidate.forceable !== 'boolean'
          || (candidate.reason !== null && typeof candidate.reason !== 'string'))
        || new Set(plan.candidates.map(candidate => candidate.id)).size !== plan.candidates.length) {
        throw new Error('Ce plan de nettoyage est périmé ou invalide. Rechargez la comparaison.');
      }
      this.cleanupPlan = plan;
      const eligibleCandidates = plan.candidates.filter(candidate => this.eligible(candidate, plan));
      for (const candidate of eligibleCandidates) this.cleanupSelection.add(candidate.id);
      this.renderCleanup();
      const eligible = eligibleCandidates.length, forceable = plan.candidates.filter(candidate => candidate.forceable).length;
      const blocked = plan.candidates.length - eligible - forceable;
      this.feedback(eligible
        ? `${number(eligible)} autre(s) version(s) sûre(s) présélectionnée(s) pour la Corbeille.${forceable ? ` ${number(forceable)} version(s) avec audio différent peuvent être supprimées manuellement.` : ''}${blocked ? ` ${number(blocked)} version(s) restent protégées.` : ''} Vérifiez puis confirmez la suppression.`
        : forceable
          ? `${number(forceable)} autre(s) version(s) ont les mêmes notes et fichiers non audio, mais un audio différent. Utilisez « Supprimer quand même » uniquement si vous voulez réellement perdre cet audio.`
          : 'Aucune autre version n’est suffisamment vérifiée pour être supprimée. Consultez les raisons indiquées.');
    } catch (error) {
      if (!this.current(serial, root, revision)) return;
      this.clearCleanup(); this.needsReload = true;
      this.feedback(error instanceof Error ? error.message : 'Vérification indisponible. Rechargez la comparaison.', true);
    } finally {
      if (this.current(serial, root, revision)) { this.preparing = false; this.refreshAvailability(); }
    }
  }

  private eligible(candidate: CleanupPlan['candidates'][number], plan: CleanupPlan): boolean {
    const verifiedTarget = (target: CleanupTarget): boolean => !!target.targetRelativePath && target.kind !== null && target.bytes !== null;
    return candidate.id !== plan.keepId && candidate.eligible && verifiedTarget(candidate) && verifiedTarget(plan.keep) && plan.keep.audio.status === 'verified'
      && plan.keep.audio.count > 0 && candidate.audio.status === 'verified' && candidate.audio.count > 0;
  }

  private renderCleanup(): void {
    const plan = this.cleanupPlan; if (!plan) return;
    const document = this.options.root.ownerDocument;
    const details = (target: CleanupTarget, container: HTMLElement): void => {
      const path = document.createElement('code'); path.className = 'library-cleanup-path'; path.textContent = target.targetRelativePath ?? target.relativePath;
      const scope = document.createElement('p');
      scope.textContent = `${target.targetRelativePath === null || target.kind === null ? 'Cible non vérifiée' : target.kind === 'folder' ? 'Dossier entier, avec tout son contenu' : 'Fichier .sng uniquement'} · ${target.bytes === null ? 'Taille non vérifiée' : `${number(target.bytes)} octets`}`;
      const audio = document.createElement('p'); audio.className = 'library-cleanup-audio';
      audio.textContent = `Audio ${target.audio.status === 'verified' ? 'vérifié' : target.audio.status === 'missing' ? 'absent' : 'indisponible'} · ${number(target.audio.count)} fichier(s) · ${number(target.audio.bytes)} octets`;
      container.append(path, scope, audio);
    };
    const keeper = this.element('#library-cleanup-keep');
    const title = document.createElement('strong'); title.textContent = 'Version conservée · exclue du nettoyage'; keeper.append(title); details(plan.keep, keeper);
    const container = this.element('#library-cleanup-candidates');
    for (const [index, candidate] of plan.candidates.entries()) {
      const item = document.createElement('div'); item.className = 'library-cleanup-candidate'; item.dataset.cleanupId = candidate.id;
      const label = document.createElement('label'); label.className = 'library-cleanup-choice';
      const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'library-cleanup-check';
      check.id = `library-cleanup-check-${index}`; check.dataset.cleanupId = candidate.id;
      const eligible = this.eligible(candidate, plan);
      check.checked = eligible && this.cleanupSelection.has(candidate.id);
      const caption = document.createElement('span'); caption.textContent = eligible ? `Supprimer cette copie : ${candidate.relativePath}` : `Suppression bloquée : ${candidate.relativePath}`;
      label.append(check, caption); item.append(label); details(candidate, item);
      const reason = document.createElement('p'); reason.className = 'library-cleanup-reason'; reason.id = `library-cleanup-reason-${index}`;
      reason.textContent = eligible ? 'Notes, audio et tous les fichiers identiques à la version conservée.'
        : candidate.forceable ? 'Les notes et les fichiers non audio sont identiques, mais l’audio est différent. Cette copie ne sera jamais présélectionnée.'
        : candidate.reason || 'Nettoyage bloqué : les fichiers et un audio présent doivent être entièrement vérifiés.';
      check.setAttribute('aria-describedby', reason.id); item.append(reason);
      if (!eligible && candidate.forceable) {
        const force = document.createElement('button'); force.type = 'button'; force.className = 'button secondary library-cleanup-force';
        force.textContent = 'Supprimer quand même'; force.setAttribute('aria-label', `Supprimer quand même cette copie : ${candidate.relativePath}`);
        force.addEventListener('click', () => { void this.forceRecycle(candidate.id); }, { signal: this.cleanupAbort.signal });
        item.append(force); this.cleanupForceButtons.set(candidate.id, force);
      }
      container.append(item);
      check.addEventListener('change', () => {
        if (this.cleanupPlan !== plan || !this.cleanupAvailable() || !eligible || check.disabled) { check.checked = this.cleanupSelection.has(candidate.id); return; }
        if (check.checked) this.cleanupSelection.add(candidate.id); else this.cleanupSelection.delete(candidate.id);
        this.refreshAvailability();
      }, { signal: this.cleanupAbort.signal });
      this.cleanupChecks.set(candidate.id, check);
    }
    this.element('#library-cleanup-plan').hidden = false;
  }

  private async recycle(): Promise<void> {
    const plan = this.cleanupPlan;
    if (!plan || !this.cleanupAvailable() || !this.state?.rootPath || plan.keepId !== this.result?.preferredId) return;
    const ids = plan.candidates.filter(candidate => this.eligible(candidate, plan) && this.cleanupSelection.has(candidate.id)).map(candidate => candidate.id);
    if (!ids.length) return;
    const serial = this.serial, root = this.state.rootPath, revision = this.state.revision, execution = ++this.executionSerial;
    this.executing = true; this.cleanupPlan = null; this.cleanupSelection.clear();
    this.cleanupFeedback('Confirmation Windows en attente, puis envoi des copies sélectionnées à la Corbeille…'); this.refreshAvailability();
    try {
      const response = await this.options.command('library.recycleDuplicates', { planId: plan.planId, revision, ids }) as { ok: boolean; cancelled?: boolean; result?: CleanupResult; error?: string } | undefined;
      if (this.disposed || execution !== this.executionSerial) return;
      if (!response?.ok) throw new Error(response?.error || 'Le nettoyage n’a pas pu être confirmé. Rechargez la comparaison avant de réessayer.');
      if (response.cancelled && !response.result) {
        this.cleanupFeedback('Nettoyage annulé dans la confirmation Windows. Aucun fichier envoyé à la Corbeille. Vérifiez à nouveau pour préparer une autre sélection.');
      } else {
        const result = response.result;
        if (!result || !Array.isArray(result.recycledIds) || !Array.isArray(result.failed)
          || result.recycledIds.some(id => !ids.includes(id)) || result.failed.some(failure => !ids.includes(failure.id) || typeof failure.reason !== 'string')
          || typeof result.cancelled !== 'boolean' || typeof result.refreshRequested !== 'boolean') {
          throw new Error('Le résultat du nettoyage n’a pas pu être confirmé. Actualisez la bibliothèque avant de réessayer.');
        }
        const messages = [`${number(result.recycledIds.length)} copie(s) envoyée(s) à la Corbeille Windows. Version conservée : ${plan.keep.targetRelativePath}.`];
        if (result.failed.length) messages.push(`${number(result.failed.length)} copie(s) non envoyée(s).`);
        if (result.cancelled) messages.push('Opération interrompue ; certaines copies peuvent rester en place.');
        for (const failure of result.failed) messages.push(`${plan.candidates.find(candidate => candidate.id === failure.id)?.targetRelativePath ?? failure.id} : ${failure.reason}`);
        messages.push(result.refreshRequested ? 'Actualisation de la bibliothèque demandée.' : 'Actualisez la bibliothèque pour vérifier les fichiers actuels.');
        this.cleanupFeedback(messages.join('\n'), result.failed.length > 0);
        if (this.current(serial, root, revision)) this.needsReload = true;
      }
      if (this.current(serial, root, revision)) this.feedback('Cette sélection a été utilisée. Une nouvelle vérification est nécessaire avant tout autre nettoyage.');
    } catch (error) {
      if (this.disposed || execution !== this.executionSerial) return;
      this.cleanupFeedback(error instanceof Error ? error.message : 'Nettoyage indisponible. Actualisez la bibliothèque avant de réessayer.', true);
      if (this.current(serial, root, revision)) this.needsReload = true;
    } finally {
      if (!this.disposed && execution === this.executionSerial) { this.executing = false; this.clearCleanup(); this.refreshAvailability(); }
    }
  }

  private async forceRecycle(id: string): Promise<void> {
    const plan = this.cleanupPlan, candidate = plan?.candidates.find(value => value.id === id);
    if (!plan || !candidate?.forceable || candidate.eligible || !this.cleanupAvailable() || !this.state?.rootPath || plan.keepId !== this.result?.preferredId) return;
    const serial = this.serial, root = this.state.rootPath, revision = this.state.revision, execution = ++this.executionSerial;
    this.executing = true; this.cleanupPlan = null; this.cleanupSelection.clear();
    this.cleanupFeedback('Confirmation renforcée requise pour supprimer une copie dont l’audio diffère…'); this.refreshAvailability();
    try {
      const response = await this.options.command('library.forceRecycleDuplicate', { planId: plan.planId, revision, id }) as { ok: boolean; cancelled?: boolean; result?: CleanupResult; error?: string } | undefined;
      if (this.disposed || execution !== this.executionSerial) return;
      if (!response?.ok) throw new Error(response?.error || 'La suppression forcée n’a pas pu être confirmée. Revérifiez les versions avant de réessayer.');
      if (response.cancelled && !response.result) {
        this.cleanupFeedback('Suppression forcée annulée. Aucun fichier envoyé à la Corbeille.');
      } else {
        const result = response.result;
        if (!result || !Array.isArray(result.recycledIds) || !Array.isArray(result.failed)
          || result.recycledIds.some(value => value !== id) || result.failed.some(failure => failure.id !== id || typeof failure.reason !== 'string')
          || typeof result.cancelled !== 'boolean' || typeof result.refreshRequested !== 'boolean') {
          throw new Error('Le résultat de la suppression forcée n’a pas pu être confirmé. Actualisez la bibliothèque.');
        }
        const messages = [result.recycledIds.length
          ? `1 copie avec audio différent envoyée à la Corbeille Windows. Version conservée : ${plan.keep.targetRelativePath}.`
          : 'Aucune copie n’a été envoyée à la Corbeille.'];
        if (result.failed.length) messages.push(result.failed[0].reason);
        if (result.cancelled) messages.push('Opération interrompue.');
        messages.push(result.refreshRequested ? 'Actualisation de la bibliothèque demandée.' : 'Actualisez la bibliothèque pour vérifier les fichiers actuels.');
        this.cleanupFeedback(messages.join('\n'), result.failed.length > 0);
        if (this.current(serial, root, revision)) this.needsReload = true;
      }
      if (this.current(serial, root, revision)) this.feedback('Cette vérification a été utilisée. Une nouvelle vérification est nécessaire avant toute autre suppression.');
    } catch (error) {
      if (this.disposed || execution !== this.executionSerial) return;
      this.cleanupFeedback(error instanceof Error ? error.message : 'Suppression forcée indisponible. Actualisez la bibliothèque.', true);
      if (this.current(serial, root, revision)) this.needsReload = true;
    } finally {
      if (!this.disposed && execution === this.executionSerial) { this.executing = false; this.clearCleanup(); this.refreshAvailability(); }
    }
  }

  private renderCards(): void {
    const result = this.result; if (!result) return;
    const document = this.options.root.ownerDocument, container = this.element('#library-comparison-cards');
    for (const [index, variant] of result.variants.entries()) {
      const card = document.createElement('article'); card.className = 'library-variant'; card.dataset.variantId = variant.id;
      const heading = document.createElement('h4'); heading.textContent = display(variant.title ?? result.title); heading.id = `library-variant-${index}`;
      card.setAttribute('aria-labelledby', heading.id);
      const metadata = document.createElement('p'); metadata.className = 'library-variant-metadata'; metadata.textContent = `${display(variant.artist ?? result.artist)} · Créateur : ${display(variant.charter ?? result.charter)}`;
      const badge = document.createElement('strong'); badge.className = 'library-preferred-badge'; badge.textContent = 'Version à conserver'; badge.hidden = true;
      const pathLabel = document.createElement('span'); pathLabel.className = 'library-variant-path-label'; pathLabel.textContent = 'Chemin relatif au dossier Songs';
      const path = document.createElement('code'); path.className = 'library-variant-path'; path.textContent = display(variant.relativePath);
      const details = document.createElement('dl'); details.className = 'library-variant-details';
      const field = (label: string, value: string): void => { const term = document.createElement('dt'), detail = document.createElement('dd'); term.textContent = label; detail.textContent = value; details.append(term, detail); };
      field('Format de la chart', format(variant.format));
      field('Audio', variant.audio === 'present' ? 'Présent' : variant.audio === 'missing' ? 'Absent' : 'Non vérifié');
      field('Fichier de notes', format(variant.notes.format));
      field('Taille des notes', variant.notes.bytes === null ? 'Non vérifiée' : `${number(variant.notes.bytes)} octets`);
      const modified = variant.notes.modifiedAt ? new Date(variant.notes.modifiedAt) : null;
      field('Fichier modifié le', modified && !Number.isNaN(modified.getTime()) ? modified.toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'medium' }) : 'Non vérifié');
      field('État des notes', variant.notes.status === 'readable' ? 'Lisibles' : variant.notes.status === 'unsupported' ? 'Format non pris en charge' : 'Indisponibles');
      const group = document.createElement('p'); group.className = 'library-note-group';
      group.textContent = variant.notes.status !== 'readable' || variant.noteGroup === null ? 'Notes non vérifiées' : variant.identicalCount > 1 ? `Notes identiques · groupe ${number(variant.noteGroup)} (${number(variant.identicalCount)} versions)` : `Notes vérifiées · groupe ${number(variant.noteGroup)}`;
      const reason = document.createElement('p'); reason.className = 'library-variant-reason'; reason.textContent = variant.notes.reason ?? ''; reason.hidden = !variant.notes.reason;
      const actions = document.createElement('div'); actions.className = 'library-variant-actions';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'button secondary library-variant-open'; open.textContent = 'Ouvrir dossier';
      open.setAttribute('aria-label', `Ouvrir le dossier ${variant.relativePath}`);
      open.addEventListener('click', () => { void this.openFolder(variant.id); }, { signal: this.cardAbort.signal });
      const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'button primary library-variant-choose'; choose.textContent = 'Conserver cette version';
      choose.setAttribute('aria-label', `Conserver cette version : ${variant.relativePath}`);
      choose.addEventListener('click', () => { void this.choose(variant.id); }, { signal: this.cardAbort.signal });
      actions.append(open, choose); card.append(badge, heading, metadata, pathLabel, path, details, group, reason, actions); container.append(card);
      this.cards.set(variant.id, { card, badge, choose, open });
    }
  }

  private refreshAvailability(): void {
    const busy = this.loading || this.saving || this.opening || this.preparing || this.executing;
    const unavailable = !this.state?.rootPath || this.state.scanning || this.state.busy;
    this.element('#library-comparison').setAttribute('aria-busy', String(busy));
    this.element<HTMLButtonElement>('#library-comparison-close').disabled = this.executing;
    const prepare = this.element<HTMLButtonElement>('#library-cleanup-prepare');
    prepare.hidden = !this.result?.preferredId; prepare.disabled = !this.cleanupAvailable();
    prepare.textContent = this.preparing ? 'Vérification des fichiers…' : this.cleanupPlan ? 'Revérifier les autres versions' : 'Vérifier l’audio et préparer le nettoyage';
    const recycle = this.element<HTMLButtonElement>('#library-cleanup-recycle');
    const selected = this.cleanupSelection.size;
    recycle.disabled = !this.cleanupPlan || !this.cleanupAvailable() || !selected;
    recycle.textContent = selected === 1 ? 'Supprimer l’autre version' : selected > 1 ? `Supprimer les ${number(selected)} autres versions` : 'Aucune autre version sûre à supprimer';
    this.element('#library-cleanup-selection').textContent = selected === 1
      ? '1 autre version sera envoyée à la Corbeille. La version conservée est protégée.'
      : selected > 1
        ? `${number(selected)} autres versions seront envoyées à la Corbeille. La version conservée est protégée.`
        : 'Aucune autre version sûre n’est sélectionnée. La version conservée est protégée.';
    for (const [id, check] of this.cleanupChecks) {
      const candidate = this.cleanupPlan?.candidates.find(value => value.id === id);
      check.disabled = !this.cleanupAvailable() || !this.cleanupPlan || !candidate || !this.eligible(candidate, this.cleanupPlan);
      check.checked = this.cleanupSelection.has(id);
    }
    for (const [id, button] of this.cleanupForceButtons) {
      const candidate = this.cleanupPlan?.candidates.find(value => value.id === id);
      button.disabled = !this.cleanupAvailable() || !this.cleanupPlan || !candidate?.forceable || candidate.eligible;
    }
    const scan = this.element('#library-comparison-scanning'); scan.hidden = !this.targetId || !this.state?.scanning;
    const retry = this.element<HTMLButtonElement>('#library-comparison-retry'); retry.hidden = !this.needsReload; retry.disabled = busy || unavailable;
    const clear = this.element<HTMLButtonElement>('#library-comparison-clear'); clear.hidden = !this.result?.preferredId;
    clear.disabled = busy || unavailable || this.needsReload || !this.result?.canChoose;
    for (const variant of this.result?.variants ?? []) {
      const entry = this.cards.get(variant.id); if (!entry) continue;
      const selected = this.result!.preferredId === variant.id;
      entry.badge.hidden = !selected; entry.card.classList.toggle('is-preferred', selected);
      entry.choose.disabled = busy || unavailable || this.needsReload || !this.result!.canChoose || variant.notes.status !== 'readable' || selected;
      entry.open.disabled = busy || !this.state?.rootPath || this.state.busy;
    }
  }
}
