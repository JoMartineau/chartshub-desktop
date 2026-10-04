import type { AppState } from '../core/state/AppState.js';
import type { WidgetDestination, WidgetInstance } from '../core/types/Widget.js';
import { projectStreamState } from '../overlay/stream/StreamConfig.js';
import { alignWidgets, moveWidgets, patchWidgetGeometry, resizeWidget } from '../layout/WidgetLayoutEngine.js';
import type { LayoutAlignment, ResizeHandle } from '../layout/WidgetLayoutEngine.js';

export interface BuilderSnapshot {
  state: AppState;
  editor?: { revision: number; canUndo: boolean; canRedo: boolean };
}
export interface WidgetBuilderOptions {
  root: HTMLElement;
  surface: HTMLElement;
  renderPreview: (state: AppState, destination: WidgetDestination) => void;
  command: (command: string, payload?: unknown) => Promise<unknown>;
}
interface Gesture {
  pointerId: number;
  revision: number;
  clientX: number;
  clientY: number;
  scale: number;
  handle?: ResizeHandle;
  widgetId: string;
  ids: string[];
  original: WidgetInstance[];
  current: WidgetInstance[];
}

const labels: Record<string, string> = {
  'song.title': 'Titre du morceau', 'song.artist': 'Artiste', 'song.charter': 'Créateur de la chart',
  'song.instrument': 'Instrument', 'song.difficulty': 'Difficulté',
};
const handles: ResizeHandle[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const handleLabels: Record<ResizeHandle, string> = {
  n: 'haut', ne: 'haut droite', e: 'droite', se: 'bas droite', s: 'bas', sw: 'bas gauche', w: 'gauche', nw: 'haut gauche',
};
const fallbackSong = { songId: 'builder-preview', title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', instrument: 'Guitar', difficulty: 'Expert' };

/** Local edit preview only. Real game state changes exclusively through the host. */
export class WidgetBuilder {
  private readonly canvas: HTMLElement;
  private readonly abort = new AbortController();
  private readonly observer: ResizeObserver;
  private readonly boxes = new Map<string, HTMLElement>();
  private readonly rows = new Map<string, HTMLButtonElement>();
  private readonly selected = new Set<string>();
  private snapshot: BuilderSnapshot | null = null;
  private gesture: Gesture | null = null;
  private draft: WidgetInstance[] | null = null;
  private busy = false;
  private active = false;
  private scale = 1;
  private status = '';
  private target: WidgetDestination = 'game';

  constructor(private readonly options: WidgetBuilderOptions) {
    this.canvas = this.element('#builder-canvas');
    this.canvas.dataset.destination = this.target;
    const signal = this.abort.signal;
    this.element<HTMLButtonElement>('#builder-toggle').addEventListener('click', () => this.setEnabled(!this.active), { signal });
    this.element('#builder-undo').addEventListener('click', () => { void this.history('editor.undo'); }, { signal });
    this.element('#builder-redo').addEventListener('click', () => { void this.history('editor.redo'); }, { signal });
    this.element('#builder-snap').addEventListener('change', () => this.render(), { signal });
    this.options.root.querySelectorAll<HTMLButtonElement>('[data-align]').forEach(button => {
      button.addEventListener('click', () => {
        if (!this.snapshot || this.busy || this.selected.size === 0) return;
        void this.commitLayout(alignWidgets(this.layoutInstances(), [...this.selected], button.dataset.align as LayoutAlignment));
      }, { signal });
    });
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      const input = this.element<HTMLInputElement>(`#builder-${key}`);
      input.addEventListener('change', () => {
        const id = this.singleId();
        if (!this.snapshot || !id || this.busy) return;
        const value = input.valueAsNumber;
        if (!Number.isFinite(value)) { this.status = 'Saisissez une valeur numérique.'; input.value = ''; this.render(); return; }
        void this.commitLayout(patchWidgetGeometry(this.layoutInstances(), id, { [key]: value }));
      }, { signal });
      input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } }, { signal });
    }
    for (const suffix of ['game', 'stream', 'playing', 'paused']) {
      this.element(`#builder-visible-${suffix}`).addEventListener('change', () => { void this.commitVisibility(); }, { signal });
    }
    this.element('#builder-locked').addEventListener('change', () => { void this.commitLocked(); }, { signal });
    this.canvas.addEventListener('pointerdown', this.pointerDown, { signal });
    this.canvas.addEventListener('pointermove', this.pointerMove, { signal });
    this.canvas.addEventListener('pointerup', this.pointerUp, { signal });
    this.canvas.addEventListener('pointercancel', () => this.cancelGesture('Déplacement annulé.'), { signal });
    this.canvas.addEventListener('lostpointercapture', () => { if (this.gesture) this.cancelGesture('Déplacement annulé.'); }, { signal });
    this.options.root.ownerDocument.addEventListener('keydown', this.keyDown, { signal });
    this.options.root.ownerDocument.defaultView?.addEventListener('blur', () => { if (this.gesture) this.cancelGesture('Déplacement annulé.'); }, { signal });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(options.surface);
    this.resize();
  }

  get enabled(): boolean { return this.active; }
  get destination(): WidgetDestination { return this.target; }

  setDestination(destination: WidgetDestination): void {
    if (this.busy || destination === this.target) return;
    this.finishGesture();
    this.draft = null;
    this.target = destination;
    this.status = `Disposition ${destination === 'game' ? 'Jeu' : 'Stream'} sélectionnée.`;
    this.canvas.dataset.destination = destination;
    this.render();
  }

  private layoutInstances(): WidgetInstance[] {
    if (!this.snapshot) return [];
    return this.target === 'stream' ? projectStreamState(this.snapshot.state).widgets.instances : this.snapshot.state.widgets.instances;
  }

  update(snapshot: BuilderSnapshot): void {
    if (this.gesture && this.gesture.revision !== (snapshot.editor?.revision ?? 0)) {
      this.finishGesture();
      this.status = 'La disposition a changé. Le geste en cours a été annulé.';
    }
    if (this.draft && (snapshot.editor?.revision ?? 0) !== (this.snapshot?.editor?.revision ?? 0)) this.draft = null;
    this.snapshot = snapshot;
    const existing = new Set(snapshot.state.widgets.instances.map(instance => instance.id));
    for (const id of this.selected) if (!existing.has(id)) this.selected.delete(id);
    this.render();
  }

  setEnabled(enabled: boolean): void {
    if (this.busy) return;
    this.finishGesture();
    this.active = enabled;
    this.status = enabled ? 'Sélectionnez un widget pour le placer.' : '';
    this.options.root.classList.toggle('builder-editing', enabled);
    const toggle = this.element<HTMLButtonElement>('#builder-toggle');
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.textContent = enabled ? 'Terminer la disposition' : 'Modifier la disposition';
    for (const selector of ['#builder-toolbar', '#builder-layer', '#builder-guidance', '#builder-inspector']) this.element(selector).hidden = !enabled;
    this.resize();
    this.render();
  }

  dispose(): void {
    this.finishGesture();
    this.abort.abort();
    this.observer.disconnect();
    this.boxes.clear();
    this.rows.clear();
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.options.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing builder control: ${selector}`);
    return element;
  }

  private singleId(): string | undefined { return this.selected.size === 1 ? this.selected.values().next().value : undefined; }

  private resize(): void {
    const width = this.options.surface.clientWidth;
    const height = this.options.surface.clientHeight;
    const scale = Math.max(.001, Math.min(width / 1280, height / 720));
    const cancelled = !!this.gesture && Math.abs(this.scale - scale) > .000001;
    if (cancelled) { this.finishGesture(); this.status = 'L’aperçu a changé de taille. Le geste en cours a été annulé.'; }
    this.scale = scale;
    Object.assign(this.canvas.style, {
      left: `${(width - 1280 * this.scale) / 2}px`, top: `${(height - 720 * this.scale) / 2}px`, transform: `scale(${this.scale})`,
    });
    this.canvas.style.setProperty('--builder-inverse-scale', String(1 / this.scale));
    if (cancelled) this.render();
  }

  private select(id: string, additive: boolean): void {
    if (additive) {
      if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
    } else if (!this.selected.has(id)) {
      this.selected.clear(); this.selected.add(id);
    }
    this.status = '';
    this.render();
  }

  private readonly pointerDown = (event: PointerEvent): void => {
    if (!this.active || this.busy || !this.snapshot || event.button !== 0) return;
    const target = event.target as Element;
    const box = target.closest<HTMLElement>('[data-builder-widget-id]');
    if (!box) {
      if (!event.shiftKey) this.selected.clear();
      this.status = ''; this.render(); this.canvas.focus({ preventScroll: true }); return;
    }
    event.preventDefault();
    const id = box.dataset.builderWidgetId!;
    const handle = target.closest<HTMLElement>('[data-resize-handle]')?.dataset.resizeHandle as ResizeHandle | undefined;
    if (!handle) this.select(id, event.shiftKey);
    if (!this.selected.has(id)) return;
    this.canvas.focus({ preventScroll: true });
    const original = this.layoutInstances();
    if (original.find(instance => instance.id === id)?.locked === true) {
      this.status = 'Widget verrouillé. Déverrouillez-le dans l’inspecteur pour le déplacer.';
      this.render(); return;
    }
    this.gesture = {
      pointerId: event.pointerId, revision: this.snapshot.editor?.revision ?? 0,
      clientX: event.clientX, clientY: event.clientY, scale: this.scale,
      handle, widgetId: id, ids: [...this.selected], original, current: original,
    };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly pointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    const dx = (event.clientX - gesture.clientX) / gesture.scale;
    const dy = (event.clientY - gesture.clientY) / gesture.scale;
    const snap = this.element<HTMLInputElement>('#builder-snap').checked && !event.altKey ? 8 : 0;
    if (gesture.handle) {
      gesture.current = gesture.original.map(instance => instance.id === gesture.widgetId
        ? resizeWidget(instance, gesture.handle!, dx, dy, { snap }) : instance);
    } else gesture.current = moveWidgets(gesture.original, gesture.ids, dx, dy, { snap });
    this.render();
  };

  private readonly pointerUp = (event: PointerEvent): void => {
    if (!this.gesture || event.pointerId !== this.gesture.pointerId) return;
    const instances = this.gesture.current;
    this.finishGesture();
    void this.commitLayout(instances);
  };

  private finishGesture(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture && this.canvas.hasPointerCapture(gesture.pointerId)) this.canvas.releasePointerCapture(gesture.pointerId);
  }

  private cancelGesture(message: string): void {
    if (!this.gesture) return;
    this.finishGesture(); this.status = message; this.render();
  }

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (!this.active || event.defaultPrevented || (event.target as Element | null)?.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.gesture) this.cancelGesture('Déplacement annulé.');
      else { this.selected.clear(); this.status = ''; this.render(); }
      return;
    }
    if (this.busy) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && (key === 'z' || key === 'y')) {
      event.preventDefault();
      if (this.gesture) { this.cancelGesture('Déplacement annulé.'); return; }
      void this.history(key === 'y' || event.shiftKey ? 'editor.redo' : 'editor.undo');
      return;
    }
    if (!modifier && this.snapshot && this.selected.size && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const amount = event.shiftKey ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0;
      const dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0;
      void this.commitLayout(moveWidgets(this.layoutInstances(), [...this.selected], dx, dy, { snap: 0 }));
    }
  };

  private async history(command: 'editor.undo' | 'editor.redo'): Promise<void> {
    if (!this.snapshot || this.busy || !this.active) return;
    if (!(command === 'editor.undo' ? this.snapshot.editor?.canUndo : this.snapshot.editor?.canRedo)) return;
    await this.send(command);
  }

  private async commitLayout(instances: WidgetInstance[]): Promise<void> {
    if (!this.snapshot || this.busy) return;
    const original = new Map(this.layoutInstances().map(instance => [instance.id, instance]));
    const items = instances.filter(instance => {
      const before = original.get(instance.id);
      return before && before.locked !== true && (before.position.x !== instance.position.x || before.position.y !== instance.position.y || before.size.width !== instance.size.width || before.size.height !== instance.size.height);
    }).map(instance => ({ id: instance.id, x: instance.position.x, y: instance.position.y, width: instance.size.width, height: instance.size.height }));
    if (!items.length) { this.render(); return; }
    this.draft = instances;
    await this.send('widget.layout', { revision: this.snapshot.editor?.revision ?? 0, destination: this.target, items });
  }

  private async commitVisibility(): Promise<void> {
    const id = this.singleId();
    if (!this.snapshot || !id || this.busy) return;
    const gameplayVisibility: ('playing' | 'paused')[] = [];
    if (this.element<HTMLInputElement>('#builder-visible-playing').checked) gameplayVisibility.push('playing');
    if (this.element<HTMLInputElement>('#builder-visible-paused').checked) gameplayVisibility.push('paused');
    await this.send('widget.visibility', { revision: this.snapshot.editor?.revision ?? 0, id, game: this.element<HTMLInputElement>('#builder-visible-game').checked, stream: this.element<HTMLInputElement>('#builder-visible-stream').checked, gameplayVisibility });
  }

  private async commitLocked(): Promise<void> {
    const id = this.singleId();
    if (!this.snapshot || !id || this.busy) return;
    this.finishGesture();
    await this.send('widget.locked', { revision: this.snapshot.editor?.revision ?? 0, id, locked: this.element<HTMLInputElement>('#builder-locked').checked });
  }

  private async send(command: string, payload?: unknown): Promise<void> {
    this.busy = true; this.status = 'Enregistrement…'; this.render();
    try {
      const result = await this.options.command(command, payload);
      const succeeded = result && typeof result === 'object' && 'ok' in result && result.ok === true;
      this.status = succeeded ? '' : 'La modification n’a pas été appliquée. La disposition a été actualisée.';
    }
    catch { this.status = 'La modification n’a pas pu être enregistrée. Réessayez.'; }
    finally { this.draft = null; this.busy = false; this.render(); }
  }

  private render(): void {
    if (!this.snapshot) return;
    const instances = this.gesture?.current ?? this.draft ?? this.layoutInstances();
    const state = this.snapshot.state;
    if (this.active) {
      const preview: AppState = {
        ...state, gameplay: { state: state.gameplay.state === 'paused' ? 'paused' : 'playing', isChartActive: true },
        nowPlaying: state.nowPlaying ?? fallbackSong,
        widgets: { ...state.widgets, instances: instances.map(instance => ({ ...instance, enabled: true, visibility: { ...instance.visibility, [this.target]: true }, gameplayVisibility: ['playing', 'paused'] })) },
      };
      if (this.target === 'stream' && state.stream) {
        preview.stream = { ...state.stream, layout: instances.map(instance => ({ id: instance.id, x: instance.position.x, y: instance.position.y, width: instance.size.width, height: instance.size.height })) };
      }
      this.options.renderPreview(preview, this.target);
      this.renderBoxes(instances);
      this.renderInspector(instances);
      const selectedInstance = instances.find(instance => this.selected.has(instance.id));
      const selection = this.selected.size === 1
        ? `${labels[selectedInstance?.type ?? ''] ?? 'Widget'}${selectedInstance?.locked === true ? ' · verrouillé' : ''}`
        : this.selected.size ? `${this.selected.size} widgets sélectionnés` : 'Sélectionnez un widget pour le placer.';
      this.element('#builder-selection-status').textContent = this.status || selection;
      this.canvas.classList.toggle('show-grid', this.element<HTMLInputElement>('#builder-snap').checked);
      this.canvas.setAttribute('aria-busy', String(this.busy));
    } else this.options.renderPreview(state, this.target);
    this.element<HTMLButtonElement>('#builder-toggle').disabled = this.busy;
    this.element<HTMLButtonElement>('#builder-undo').disabled = this.busy || !this.snapshot.editor?.canUndo;
    this.element<HTMLButtonElement>('#builder-redo').disabled = this.busy || !this.snapshot.editor?.canRedo;
    this.element<HTMLInputElement>('#builder-snap').disabled = this.busy;
    const movableSelection = instances.some(instance => this.selected.has(instance.id) && instance.locked !== true);
    this.options.root.querySelectorAll<HTMLButtonElement>('[data-align]').forEach(button => { button.disabled = this.busy || !movableSelection; });
    this.options.root.querySelectorAll<HTMLInputElement>('#widget-settings input').forEach(input => { input.disabled = this.busy; });
    this.options.root.querySelectorAll<HTMLButtonElement>('#preview-game-tab, #preview-stream-tab').forEach(button => { button.disabled = this.busy; });
  }

  private renderBoxes(instances: WidgetInstance[]): void {
    const existing = new Set(instances.map(instance => instance.id));
    for (const [id, box] of this.boxes) if (!existing.has(id)) { box.remove(); this.boxes.delete(id); }
    for (const [id, row] of this.rows) if (!existing.has(id)) { row.remove(); this.rows.delete(id); }
    const document = this.options.root.ownerDocument;
    for (const instance of instances) {
      let box = this.boxes.get(instance.id);
      if (!box) {
        box = document.createElement('div'); box.className = 'builder-widget-box';
        box.dataset.builderWidgetId = instance.id; box.setAttribute('role', 'option');
        const caption = document.createElement('span'); caption.className = 'builder-widget-caption'; caption.textContent = labels[instance.type] ?? instance.type;
        box.append(caption); this.canvas.append(box); this.boxes.set(instance.id, box);
      }
      const selected = this.selected.has(instance.id);
      const locked = instance.locked === true;
      const caption = `${labels[instance.type] ?? instance.type}${locked ? ' · verrouillé' : ''}`;
      const allowed = instance.gameplayVisibility ?? ['playing', 'paused'];
      const ghost = !instance.enabled || !instance.visibility[this.target] || !allowed.includes(this.snapshot?.state.gameplay.state === 'paused' ? 'paused' : 'playing');
      box.setAttribute('aria-selected', String(selected));
      box.setAttribute('aria-label', caption);
      box.querySelector('.builder-widget-caption')!.textContent = caption;
      box.classList.toggle('is-ghost', ghost);
      box.classList.toggle('is-locked', locked);
      Object.assign(box.style, { left: `${instance.position.x}px`, top: `${instance.position.y}px`, width: `${instance.size.width}px`, height: `${instance.size.height}px` });
      const showHandles = selected && this.selected.size === 1 && !locked;
      if (showHandles && !box.querySelector('[data-resize-handle]')) {
        for (const direction of handles) {
          const handle = document.createElement('button'); handle.type = 'button'; handle.tabIndex = -1;
          handle.className = `builder-resize-handle handle-${direction}`; handle.dataset.resizeHandle = direction;
          handle.setAttribute('aria-label', `Redimensionner : ${handleLabels[direction]}`); box.append(handle);
        }
      } else if (!showHandles) box.querySelectorAll('[data-resize-handle]').forEach(handle => handle.remove());
      let row = this.rows.get(instance.id);
      if (!row) {
        row = document.createElement('button'); row.type = 'button'; row.dataset.selectWidgetId = instance.id;
        row.className = 'builder-list-item'; row.setAttribute('role', 'option');
        row.addEventListener('click', event => {
          if (this.busy) return;
          if (!event.shiftKey) this.selected.clear();
          this.select(instance.id, event.shiftKey);
        }, { signal: this.abort.signal });
        this.element('#builder-list').append(row); this.rows.set(instance.id, row);
      }
      row.textContent = `${caption}${ghost ? ' · masqué' : ''}`;
      row.classList.toggle('is-locked', locked);
      row.setAttribute('aria-selected', String(selected)); row.disabled = this.busy;
      this.options.surface.querySelectorAll<HTMLElement>(`#${this.target}-preview [data-widget-id]`).forEach(element => {
        if (element.dataset.widgetId === instance.id) element.classList.toggle('is-builder-ghost', ghost);
      });
    }
  }

  private renderInspector(instances: WidgetInstance[]): void {
    const id = this.singleId();
    const instance = instances.find(widget => widget.id === id);
    this.element('#builder-inspector-selection').textContent = instance ? labels[instance.type] ?? instance.type : this.selected.size ? `${this.selected.size} widgets sélectionnés · déplacement et alignement groupés` : 'Aucune sélection';
    const values = { x: instance?.position.x, y: instance?.position.y, width: instance?.size.width, height: instance?.size.height };
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      const input = this.element<HTMLInputElement>(`#builder-${key}`);
      input.disabled = this.busy || !instance || instance.locked === true;
      if (this.options.root.ownerDocument.activeElement !== input) input.value = values[key] === undefined ? '' : String(values[key]);
    }
    const locked = this.element<HTMLInputElement>('#builder-locked');
    locked.disabled = this.busy || !instance;
    locked.checked = instance?.locked === true;
    const visibility = instance?.gameplayVisibility ?? ['playing', 'paused'];
    for (const suffix of ['game', 'stream', 'playing', 'paused'] as const) {
      const input = this.element<HTMLInputElement>(`#builder-visible-${suffix}`);
      input.disabled = this.busy || !instance;
      input.checked = !!instance && (suffix === 'game' || suffix === 'stream' ? instance.visibility[suffix] : visibility.includes(suffix));
    }
  }
}
