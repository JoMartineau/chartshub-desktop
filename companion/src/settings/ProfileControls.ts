interface SavedProfile { id: string; name: string; updatedAt: string; }
interface ProfileSummary {
  revision: number;
  items: SavedProfile[];
  activeId: string | null;
  error: string | null;
  canWrite: boolean;
}
interface ProfileSnapshot {
  profiles?: ProfileSummary;
  editor?: { revision: number };
}
interface ProfileControlOptions {
  root: HTMLElement;
  command: (name: string, payload?: unknown) => Promise<unknown>;
}
interface ProfileRow {
  element: HTMLElement;
  apply: HTMLButtonElement;
  name: HTMLSpanElement;
  status: HTMLSpanElement;
  updated: HTMLSpanElement;
  updatedAt?: string;
  select: HTMLButtonElement;
}
const locale = (): string => typeof document === 'undefined' || document.documentElement.lang.startsWith('fr') ? 'fr-FR' : 'en-US';
const setText = (element: HTMLElement, value: string): void => { if (element.textContent !== value) element.textContent = value; };

/** Named overlay settings, with stable controls and explicit overwrite/delete targets. */
export class ProfileControls {
  private readonly abort = new AbortController();
  private readonly rows = new Map<string, ProfileRow>();
  private snapshot: ProfileSnapshot | null = null;
  private selectedId: string | null = null;
  private deleteId: string | null = null;
  private nameDirty = false;
  private busy = false;
  private disposed = false;

  constructor(private readonly options: ProfileControlOptions) {
    const signal = this.abort.signal;
    this.element<HTMLInputElement>('#profiles-name').addEventListener('input', () => {
      this.nameDirty = true; this.feedback(''); this.renderAvailability();
    }, { signal });
    this.element('#profiles-create').addEventListener('click', () => { void this.save(false); }, { signal });
    this.element('#profiles-update').addEventListener('click', () => { void this.save(true); }, { signal });
    this.element('#profiles-delete').addEventListener('click', () => {
      if (this.busy || !this.summary?.canWrite || !this.selected) return;
      this.deleteId = this.selected.id; this.renderAvailability();
      this.element('#profiles-delete-cancel').focus({ preventScroll: true });
    }, { signal });
    this.element('#profiles-delete-cancel').addEventListener('click', () => {
      this.deleteId = null; this.renderAvailability(); this.element('#profiles-delete').focus({ preventScroll: true });
    }, { signal });
    this.element('#profiles-delete-confirm').addEventListener('click', () => { void this.remove(); }, { signal });
    this.render();
  }

  update(snapshot: ProfileSnapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    if (this.selectedId && !this.selected) this.selectedId = null;
    if (!this.selectedId && !this.nameDirty && this.summary?.activeId) this.selectedId = this.summary.activeId;
    if (this.deleteId && !this.summary?.items.some(item => item.id === this.deleteId)) this.deleteId = null;
    this.render();
  }

  dispose(): void {
    this.disposed = true; this.abort.abort();
    this.element('#profiles-panel').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => { control.disabled = true; });
    this.rows.clear();
  }

  private get summary(): ProfileSummary | undefined { return this.snapshot?.profiles; }
  private get selected(): SavedProfile | undefined { return this.summary?.items.find(item => item.id === this.selectedId); }
  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.options.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing profile control: ${selector}`);
    return element;
  }

  private feedback(message: string, error = false): void {
    const element = this.element('#profiles-feedback');
    element.textContent = message; element.hidden = !message; element.classList.toggle('is-error', error);
    element.setAttribute('role', error ? 'alert' : 'status');
  }

  private select(id: string, focusName = false): void {
    if (this.busy || this.disposed || !this.summary?.items.some(item => item.id === id)) return;
    this.selectedId = id; this.deleteId = null; this.nameDirty = false; this.feedback(''); this.render();
    if (focusName) { const input = this.element<HTMLInputElement>('#profiles-name'); input.focus({ preventScroll: true }); input.select(); }
  }

  private async save(update: boolean): Promise<void> {
    if (this.disposed || this.busy || !this.summary?.canWrite || (update ? !this.selected : this.summary.items.length >= 20)) return;
    const input = this.element<HTMLInputElement>('#profiles-name');
    const name = input.value.trim();
    if (!name || name.length > 40) { this.feedback('Saisissez un nom de 1 à 40 caractères.', true); input.focus({ preventScroll: true }); return; }
    const id = update ? this.selectedId : null;
    const previousIds = new Set(this.summary.items.map(item => item.id));
    const result = await this.send('profile.save', {
      revision: this.snapshot?.editor?.revision ?? 0, profilesRevision: this.summary.revision, name, ...(id ? { id } : {}),
    });
    if (!result || this.disposed) return;
    const added = this.summary?.items.filter(item => !previousIds.has(item.id)) ?? [];
    this.selectedId = id ?? (added.length === 1 ? added[0]!.id : this.summary?.activeId ?? null);
    this.nameDirty = false; this.deleteId = null;
    this.feedback(update ? 'Profil mis à jour.' : 'Nouveau profil enregistré.'); this.render();
  }

  private async apply(id: string): Promise<void> {
    if (this.disposed || this.busy || !this.summary?.canWrite || !this.summary.items.some(item => item.id === id)) return;
    this.select(id);
    const ok = await this.send('profile.apply', {
      revision: this.snapshot?.editor?.revision ?? 0, profilesRevision: this.summary.revision, id,
    });
    if (ok && !this.disposed) this.feedback('Profil appliqué.');
  }

  private async remove(): Promise<void> {
    if (this.disposed || this.busy || !this.summary?.canWrite || !this.deleteId) return;
    const id = this.deleteId;
    const ok = await this.send('profile.delete', { profilesRevision: this.summary.revision, id });
    if (!ok || this.disposed) return;
    this.deleteId = null;
    if (this.selectedId === id) { this.selectedId = null; this.nameDirty = false; }
    this.feedback('Profil supprimé. Votre disposition actuelle est conservée.'); this.render();
  }

  private async send(name: string, payload: unknown): Promise<boolean> {
    if (this.disposed || this.busy) return false;
    this.busy = true; this.feedback(''); this.renderAvailability();
    try {
      const result = await this.options.command(name, payload);
      if (this.disposed) return false;
      if (result && typeof result === 'object' && 'ok' in result && result.ok === true) return true;
      const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' && result.error
        ? result.error : 'Le profil n’a pas pu être modifié. Réessayez.';
      this.feedback(message, true); return false;
    } catch {
      if (!this.disposed) this.feedback('Les profils sont momentanément indisponibles. Réessayez.', true);
      return false;
    } finally {
      this.busy = false;
      if (!this.disposed) this.render();
    }
  }

  private createRow(id: string): ProfileRow {
    const document = this.options.root.ownerDocument;
    const element = document.createElement('div'); element.className = 'profile-item'; element.setAttribute('role', 'listitem');
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'profile-apply'; apply.dataset.profileApply = id;
    const name = document.createElement('span'); name.className = 'profile-item-name';
    const status = document.createElement('span'); status.className = 'profile-item-status';
    const updated = document.createElement('span'); updated.className = 'profile-item-updated';
    apply.append(name, status, updated);
    apply.addEventListener('click', () => { void this.apply(id); }, { signal: this.abort.signal });
    const select = document.createElement('button'); select.type = 'button'; select.className = 'button secondary profile-manage'; select.textContent = 'Gérer'; select.dataset.profileSelect = id;
    select.addEventListener('click', () => this.select(id, true), { signal: this.abort.signal });
    element.append(apply, select);
    return { element, apply, name, status, updated, select };
  }

  private render(): void {
    if (this.disposed) return;
    const summary = this.summary, items = summary?.items ?? [];
    const ids = new Set(items.map(item => item.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.element.remove(); this.rows.delete(id); }
    for (const item of items) {
      let row = this.rows.get(item.id);
      if (!row) { row = this.createRow(item.id); this.rows.set(item.id, row); this.element('#profiles-list').append(row.element); }
      if (row.name.textContent !== item.name) row.name.textContent = item.name;
      const active = item.id === summary?.activeId;
      row.element.classList.toggle('is-active', active);
      row.element.classList.toggle('is-selected', item.id === this.selectedId);
      row.apply.setAttribute('aria-label', `Appliquer le profil ${item.name}`);
      setText(row.status, active ? 'Actif' : 'Cliquer pour appliquer');
      row.select.setAttribute('aria-label', `Gérer le profil ${item.name}`);
      row.select.setAttribute('aria-pressed', String(item.id === this.selectedId));
      if (row.updatedAt !== item.updatedAt) {
        row.updatedAt = item.updatedAt;
        const date = new Date(item.updatedAt);
        row.updated.textContent = Number.isFinite(date.getTime()) ? `Enregistré le ${date.toLocaleDateString(locale())} à ${date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}` : '';
      }
    }
    const active = items.find(item => item.id === summary?.activeId);
    setText(this.element('#profiles-current-status'), active ? `Profil actif : ${active.name}` : items.length ? 'Disposition modifiée · aucun profil actif' : 'Disposition actuelle non enregistrée');
    setText(this.element('#profiles-count'), `${items.length} / 20 profils`);
    this.element('#profiles-empty').hidden = items.length > 0;
    setText(this.element('#profiles-selected'), this.selected ? `Profil à mettre à jour : ${this.selected.name}` : 'Utilisez Gérer sur un profil pour le renommer ou le mettre à jour.');
    const input = this.element<HTMLInputElement>('#profiles-name');
    if (!this.nameDirty && !this.busy) { const name = this.selected?.name ?? ''; if (input.value !== name) input.value = name; }
    const error = this.element('#profiles-error'); setText(error, summary?.error || ''); error.hidden = !summary?.error;
    this.element('#profiles-readonly').hidden = !summary || summary.canWrite;
    this.renderAvailability();
  }

  private renderAvailability(): void {
    const summary = this.summary;
    const disabled = this.disposed || this.busy || !summary;
    const writable = !disabled && !!summary?.canWrite;
    this.element('#profiles-panel').setAttribute('aria-busy', String(this.busy));
    this.element<HTMLInputElement>('#profiles-name').disabled = !writable;
    this.element<HTMLButtonElement>('#profiles-create').disabled = !writable || (summary?.items.length ?? 0) >= 20;
    this.element<HTMLButtonElement>('#profiles-update').disabled = !writable || !this.selected;
    this.element<HTMLButtonElement>('#profiles-delete').disabled = !writable || !this.selected;
    this.element('#profiles-limit').hidden = (summary?.items.length ?? 0) < 20;
    for (const row of this.rows.values()) { row.apply.disabled = !writable; row.select.disabled = disabled; }
    this.element('#profiles-delete-prompt').hidden = !this.deleteId;
    const pending = summary?.items.find(item => item.id === this.deleteId);
    this.element('#profiles-delete-message').textContent = pending ? `Supprimer le profil « ${pending.name} » ? La disposition actuelle restera en place.` : '';
    this.element<HTMLButtonElement>('#profiles-delete-confirm').disabled = !writable || !pending;
    this.element<HTMLButtonElement>('#profiles-delete-cancel').disabled = disabled;
  }
}
