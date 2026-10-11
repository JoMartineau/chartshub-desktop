import type { AppState } from '../core/state/AppState.js';
import type { StreamSettings } from '../overlay/stream/StreamConfig.js';
import { createDefaultStream } from '../overlay/stream/StreamConfig.js';

interface StreamSnapshot {
  state: AppState;
  editor?: { revision: number; canUndo: boolean; canRedo: boolean };
  stream?: { enabled: boolean; url: string | null; clients: number; error: string | null };
  captureWindows?: Partial<Record<'catalogue' | 'filters', { canOpen: boolean; title: string }>>;
}
interface StreamControlOptions {
  root: HTMLElement;
  command: (name: string, payload?: unknown) => Promise<unknown>;
}
const resolutions: Record<string, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 }, '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 }, '2160p': { width: 3840, height: 2160 },
};
const labels: Record<string, string> = {
  'song.title': 'Titre du morceau', 'song.artist': 'Artiste', 'song.charter': 'Créateur de la chart',
  'song.instrument': 'Instrument', 'song.difficulty': 'Difficulté',
};

export class StreamControls {
  private readonly abort = new AbortController();
  private readonly rows = new Map<string, { label: HTMLLabelElement; input: HTMLInputElement }>();
  private snapshot: StreamSnapshot | null = null;
  private busy = false;
  private dirty = false;
  private disposed = false;

  constructor(private readonly options: StreamControlOptions) {
    const signal = this.abort.signal;
    this.element<HTMLInputElement>('#stream-enabled').addEventListener('change', event => {
      void this.send('stream.enabled', { enabled: (event.target as HTMLInputElement).checked }, false);
    }, { signal });
    this.element('#stream-copy-url').addEventListener('click', () => { void this.send('stream.copyUrl', {}, false); }, { signal });
    this.element<HTMLInputElement>('#stream-url').addEventListener('focus', event => (event.target as HTMLInputElement).select(), { signal });
    this.element<HTMLSelectElement>('#stream-resolution').addEventListener('change', event => {
      const resolution = resolutions[(event.target as HTMLSelectElement).value];
      if (resolution) {
        this.element<HTMLInputElement>('#stream-width').value = String(resolution.width);
        this.element<HTMLInputElement>('#stream-height').value = String(resolution.height);
      }
      this.dirty = true; this.refreshAvailability();
    }, { signal });
    for (const suffix of ['width', 'height', 'fps', 'port']) {
      const mark = (): void => { this.dirty = true; this.refreshAvailability(); };
      this.element(`#stream-${suffix}`).addEventListener('input', mark, { signal });
      this.element(`#stream-${suffix}`).addEventListener('change', mark, { signal });
    }
    this.element('#stream-settings-apply').addEventListener('click', () => { void this.commitSettings(); }, { signal });
    for (const name of ['catalogue', 'filters'] as const) {
      this.element(`#stream-open-${name}`).addEventListener('click', () => { void this.openWindow(name); }, { signal });
    }
    this.options.root.ownerDocument.defaultView?.addEventListener('chartshub:languagechange', () => { this.renderCaptureWindows(); }, { signal });
    this.renderCaptureWindows();
    this.refreshAvailability();
  }

  update(snapshot: StreamSnapshot): void { if (!this.disposed) { this.snapshot = snapshot; this.render(); } }
  dispose(): void { this.disposed = true; this.abort.abort(); this.rows.clear(); }

  private get settings(): StreamSettings { return this.snapshot?.state.stream ?? createDefaultStream(this.snapshot?.state.widgets.instances ?? []); }
  private get revision(): number { return this.snapshot?.editor?.revision ?? 0; }
  private tr(fr: string, en: string): string { return this.options.root.ownerDocument.documentElement.lang.startsWith('fr') ? fr : en; }

  private async openWindow(name: 'catalogue' | 'filters'): Promise<void> {
    if (this.disposed || this.busy || this.snapshot?.captureWindows?.[name]?.canOpen !== true) return;
    await this.send(`${name}.widget`, { enabled: true }, false);
  }

  private renderCaptureWindows(): void {
    if (this.disposed) return;
    const copy = {
      '#stream-description': this.tr('Widgets du morceau et fenêtres flottantes dans OBS / Streamlabs.', 'Song widgets and floating windows in OBS / Streamlabs.'),
      '#stream-browser-heading': this.tr('Widgets du morceau — source Navigateur', 'Song widgets — Browser Source'),
      '#stream-windows-heading': this.tr('Catalogue et Filtres — Capture de fenêtre', 'Catalogue and Filters — Window Capture'),
      '#stream-window-instructions': this.tr('Dans OBS, ajoutez une source « Capture de fenêtre » pour chaque panneau et sélectionnez son titre ci-dessous. Gardez ces fenêtres ouvertes pendant la capture.', 'In OBS, add a Window Capture source for each panel and select its title below. Keep these windows open during capture.'),
      '#stream-open-catalogue': this.tr('Ouvrir le Catalogue', 'Open Catalogue'),
      '#stream-open-filters': this.tr('Ouvrir les Filtres', 'Open Filters'),
    };
    for (const [selector, text] of Object.entries(copy)) this.element(selector).textContent = text;
    this.element('#stream-catalogue-window-title').textContent = this.snapshot?.captureWindows?.catalogue?.title ?? 'ChartsHub — Mini Catalogue';
    this.element('#stream-filters-window-title').textContent = this.snapshot?.captureWindows?.filters?.title ?? 'ChartsHub — Filtres du jeu';
    const unavailable = [];
    if (this.snapshot?.captureWindows?.catalogue?.canOpen !== true) unavailable.push(this.tr('Catalogue indisponible pour le moment.', 'Catalogue is currently unavailable.'));
    if (this.snapshot?.captureWindows?.filters?.canOpen !== true) unavailable.push(this.tr('Filtres indisponibles sur cette installation.', 'Filters are unavailable on this installation.'));
    const status = this.element('#stream-window-status'); status.hidden = unavailable.length === 0; status.textContent = unavailable.join(' ');
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.options.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing stream control: ${selector}`);
    return element;
  }

  private feedback(message: string, error = false): void {
    const element = this.element('#stream-feedback'); element.textContent = message; element.hidden = !message;
    element.classList.toggle('is-error', error);
  }

  private number(selector: string, min: number, max: number): number | null {
    const input = this.element<HTMLInputElement>(selector);
    const value = input.valueAsNumber;
    const valid = Number.isInteger(value) && value >= min && value <= max;
    input.setAttribute('aria-invalid', String(!valid));
    if (!valid) {
      this.feedback(`Saisissez un nombre entier entre ${min} et ${max}.`, true);
      input.focus({ preventScroll: true });
    }
    return valid ? value : null;
  }

  private async commitSettings(): Promise<void> {
    if (!this.snapshot || this.busy) return;
    const width = this.number('#stream-width', 320, 7680); if (width === null) return;
    const height = this.number('#stream-height', 180, 4320); if (height === null) return;
    const port = this.snapshot.stream?.enabled ? this.settings.port : this.number('#stream-port', 1024, 65535); if (port === null) return;
    const fps = Number(this.element<HTMLSelectElement>('#stream-fps').value);
    if (fps !== 30 && fps !== 60) { this.feedback('Choisissez 30 ou 60 images par seconde.', true); return; }
    const settings: StreamSettings = { ...this.settings, port, canvas: { width, height, fps } };
    await this.send('stream.settings', { revision: this.revision, settings }, true);
  }

  private async toggleWidget(id: string, stream: boolean): Promise<void> {
    const widget = this.snapshot?.state.widgets.instances.find(instance => instance.id === id);
    if (!widget || this.busy) return;
    await this.send('widget.visibility', {
      revision: this.revision, id, game: widget.visibility.game, stream,
      gameplayVisibility: widget.gameplayVisibility ?? ['playing', 'paused'],
    }, false);
  }

  private async send(command: string, payload: unknown, clearDraft: boolean): Promise<void> {
    if (!this.snapshot || this.busy || this.disposed) return;
    this.busy = true; this.feedback('Mise à jour…'); this.refreshAvailability();
    try {
      const result = await this.options.command(command, payload);
      if (this.disposed) return;
      const ok = result && typeof result === 'object' && 'ok' in result && result.ok === true;
      if (ok) {
        if (clearDraft) this.dirty = false;
        this.feedback(command.endsWith('.widget') ? this.tr('Fenêtre ouverte. Sélectionnez son titre dans OBS.', 'Window opened. Select its title in OBS.') : command === 'stream.copyUrl' ? 'URL copiée.' : command === 'stream.enabled' ? '' : 'Réglage enregistré.');
      } else this.feedback('Cette action n’a pas pu être appliquée. Vérifiez les réglages et réessayez.', true);
    } catch { if (!this.disposed) this.feedback('Le Stream ne répond pas à cette action. Réessayez dans un instant.', true); }
    finally { this.busy = false; if (!this.disposed) this.render(); }
  }

  private render(): void {
    this.renderCaptureWindows();
    if (!this.snapshot) { this.refreshAvailability(); return; }
    const status = this.snapshot.stream;
    const enabled = !!status?.enabled;
    this.element<HTMLInputElement>('#stream-enabled').checked = enabled;
    this.element<HTMLInputElement>('#stream-url').value = status?.url ?? '';
    this.element('#stream-status').textContent = enabled ? 'Serveur actif' : 'Serveur arrêté';
    this.element('#stream-status').classList.toggle('is-visible', enabled);
    const clients = Math.max(0, status?.clients ?? 0);
    this.element('#stream-clients').textContent = `${clients} source${clients > 1 ? 's' : ''} connectée${clients > 1 ? 's' : ''}`;
    const error = this.element('#stream-error');
    error.hidden = !status?.error;
    error.textContent = status?.error ? 'Le serveur Stream est indisponible. Vérifiez que le port est libre, puis réactivez-le.' : '';
    if (!this.dirty) {
      const settings = this.settings;
      const resolution = Object.entries(resolutions).find(([, item]) => item.width === settings.canvas.width && item.height === settings.canvas.height)?.[0] ?? 'custom';
      this.setValue('#stream-resolution', resolution); this.setValue('#stream-width', settings.canvas.width);
      this.setValue('#stream-height', settings.canvas.height); this.setValue('#stream-fps', settings.canvas.fps);
      this.setValue('#stream-port', settings.port);
    } else if (enabled) this.setValue('#stream-port', this.settings.port);
    const instances = this.snapshot.state.widgets.instances;
    const ids = new Set(instances.map(instance => instance.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.label.remove(); this.rows.delete(id); }
    for (const instance of instances) {
      let row = this.rows.get(instance.id);
      if (!row) {
        const document = this.options.root.ownerDocument;
        const label = document.createElement('label'); const input = document.createElement('input');
        input.type = 'checkbox'; input.dataset.streamWidgetId = instance.id;
        input.addEventListener('change', () => { void this.toggleWidget(instance.id, input.checked); }, { signal: this.abort.signal });
        const text = document.createElement('span'); text.textContent = labels[instance.type] ?? instance.type;
        label.append(input, text); this.element('#stream-widget-visibility').append(label);
        row = { label, input }; this.rows.set(instance.id, row);
      }
      row.input.checked = instance.visibility.stream;
    }
    const anySelected = instances.some(instance => instance.visibility.stream);
    const anyVisible = instances.some(instance => instance.enabled && instance.visibility.stream && (instance.gameplayVisibility ?? ['playing', 'paused']).some(state => state === 'playing' || state === 'paused'));
    const warning = this.element('#stream-empty-warning'); warning.hidden = anyVisible;
    warning.textContent = anySelected ? 'Les widgets Stream sont désactivés ou masqués. Vérifiez aussi « Widgets affichés » et les états de visibilité.' : 'Aucun widget n’est activé pour le Stream. Cochez au moins un élément ci-dessus.';
    this.refreshAvailability();
  }

  private setValue(selector: string, value: string | number): void {
    const input = this.element<HTMLInputElement | HTMLSelectElement>(selector);
    if (input !== this.options.root.ownerDocument.activeElement) input.value = String(value);
  }

  private refreshAvailability(): void {
    const disabled = this.busy || !this.snapshot;
    const panel = this.element('#stream-panel'); panel.setAttribute('aria-busy', String(this.busy));
    panel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach(control => { control.disabled = disabled; });
    this.element<HTMLInputElement>('#stream-url').disabled = false;
    this.element<HTMLButtonElement>('#stream-copy-url').disabled = disabled || !this.snapshot?.stream?.enabled || !this.snapshot.stream.url;
    this.element<HTMLInputElement>('#stream-port').disabled = disabled || !!this.snapshot?.stream?.enabled;
    const custom = this.element<HTMLSelectElement>('#stream-resolution').value === 'custom';
    this.element<HTMLInputElement>('#stream-width').disabled = disabled || !custom;
    this.element<HTMLInputElement>('#stream-height').disabled = disabled || !custom;
    this.element<HTMLButtonElement>('#stream-settings-apply').disabled = disabled || !this.dirty;
    for (const name of ['catalogue', 'filters'] as const) this.element<HTMLButtonElement>(`#stream-open-${name}`).disabled = disabled || this.snapshot?.captureWindows?.[name]?.canOpen !== true;
    this.element('#stream-settings-status').textContent = this.dirty ? 'Modifications à appliquer.' : 'Réglages enregistrés.';
  }
}
