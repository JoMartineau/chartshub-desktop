import type { WidgetInstance } from '../core/types/Widget.js';
import { widgetLabel } from '../widgets/engine/WidgetLabels.js';
import { ACCURACY_FIELDS, validateAccuracyConfig, type AccuracyField, type AccuracyConfig } from '../widgets/core/Gameplay/AccuracyConfig.js';

interface AccuracyControls { fields: Map<AccuracyField, HTMLInputElement>; title: HTMLInputElement; coverage: HTMLInputElement; saved: AccuracyConfig; }

interface SettingRow {
  element: HTMLDivElement;
  checkbox: HTMLInputElement;
  name: HTMLSpanElement;
  destination: HTMLSpanElement;
  fontSize: HTMLInputElement;
  decrease: HTMLButtonElement;
  increase: HTMLButtonElement;
  feedback: HTMLParagraphElement;
  savedFontSize: number;
  dirty: boolean;
  accuracy?: AccuracyControls;
  lyrics?: { next: HTMLInputElement; saved: boolean };
}

interface FontSizeChange { revision: number; id: string; fontSize: number; }

/** Reconciles settings without replacing controls, preserving keyboard focus. */
export class WidgetSettings {
  private readonly rows = new Map<string, SettingRow>();
  private readonly abort = new AbortController();
  private revision = 0;
  private busy = false;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly onToggle: (id: string, enabled: boolean) => void,
    private readonly onFontSize?: (change: FontSizeChange) => Promise<unknown>,
    private readonly onAccuracy?: (change: { revision: number; id: string; config: AccuracyConfig }) => Promise<unknown>,
    private readonly onLyrics?: (change: { revision: number; id: string; config: { showNextLine: boolean } }) => Promise<unknown>,
  ) {}

  render(instances: readonly WidgetInstance[], revision = 0): void {
    if (this.disposed) return;
    this.revision = revision;
    const ids = new Set(instances.map(instance => instance.id));
    for (const [id, row] of this.rows) {
      if (!ids.has(id)) {
        row.element.remove();
        this.rows.delete(id);
      }
    }
    for (const instance of instances) {
      let row = this.rows.get(instance.id);
      if (row && (Boolean(row.accuracy) !== (instance.type === 'gameplay.accuracy') || Boolean(row.lyrics) !== (instance.type === 'song.lyrics'))) { row.element.remove(); this.rows.delete(instance.id); row = undefined; }
      if (!row) {
        const document = this.container.ownerDocument;
        const signal = this.abort.signal;
        const element = document.createElement('div');
        element.className = 'widget-setting';
        const toggle = document.createElement('label');
        toggle.className = 'widget-setting-toggle';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.widgetId = instance.id;
        checkbox.addEventListener('change', () => { if (!this.busy) this.onToggle(instance.id, checkbox.checked); }, { signal });
        const name = document.createElement('span');
        name.className = 'widget-setting-name';
        const destination = document.createElement('span');
        destination.className = 'destination-pill';
        toggle.append(checkbox, name, destination);
        const sizeControls = document.createElement('div');
        sizeControls.className = 'widget-font-size';
        const sizeLabel = document.createElement('label');
        sizeLabel.textContent = 'Taille du texte';
        const fontSize = document.createElement('input');
        fontSize.type = 'number'; fontSize.min = '8'; fontSize.max = '200'; fontSize.step = '1';
        fontSize.id = `widget-font-size-${instance.id}`;
        fontSize.dataset.widgetFontSize = instance.id;
        sizeLabel.htmlFor = fontSize.id;
        const decrease = document.createElement('button');
        decrease.type = 'button'; decrease.textContent = '−'; decrease.dataset.widgetFontDecrease = instance.id;
        const increase = document.createElement('button');
        increase.type = 'button'; increase.textContent = '+'; increase.dataset.widgetFontIncrease = instance.id;
        const unit = document.createElement('span'); unit.textContent = 'px';
        const feedback = document.createElement('p');
        feedback.id = `widget-font-feedback-${instance.id}`;
        feedback.className = 'widget-font-feedback'; feedback.hidden = true; feedback.setAttribute('role', 'alert');
        fontSize.setAttribute('aria-describedby', feedback.id);
        sizeControls.append(sizeLabel, decrease, fontSize, increase, unit);
        element.append(toggle, sizeControls, feedback);
        row = { element, checkbox, name, destination, fontSize, decrease, increase, feedback, savedFontSize: 20, dirty: false };
        this.rows.set(instance.id, row);
        const setting = row;
        if (instance.type === 'gameplay.accuracy') {
          const choices = document.createElement('fieldset'); choices.className = 'widget-accuracy-fields'; choices.dataset.widgetAccuracyFields = instance.id;
          const legend = document.createElement('legend'); legend.textContent = 'Valeurs affichées dans Accuracy'; choices.append(legend);
          const fields = new Map<AccuracyField, HTMLInputElement>();
          const choice = (key: string, label: string) => { const line = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.dataset.accuracyField = key; const name = document.createElement('span'); name.textContent = label; line.append(input, name); choices.append(line); input.addEventListener('change', () => { void this.commitAccuracy(instance.id); }, { signal }); return input; };
          const names = ['Dernier décalage', 'Moyenne signée', 'Écart absolu moyen', 'Dispersion', 'Dans la fenêtre ±', 'Nombre de jugements'];
          ACCURACY_FIELDS.forEach((key, index) => fields.set(key, choice(key, names[index]!)));
          const title = choice('showTitle', 'Afficher le titre Accuracy'), coverage = choice('showCoverage', 'Afficher la couverture des mesures');
          setting.accuracy = { fields, title, coverage, saved: validateAccuracyConfig(instance.config) };
          const hint = document.createElement('p'); hint.className = 'helper-text'; hint.textContent = 'Pour deux lignes : gardez Dernier et Moyenne, puis décochez le titre et la couverture. Les réglages s’appliquent à Jeu et OBS.'; choices.append(hint);
          element.append(choices);
        }
        if (instance.type === 'song.lyrics') {
          const label = document.createElement('label'), next = document.createElement('input'), caption = document.createElement('span');
          label.className = 'widget-lyrics-next';
          next.type = 'checkbox'; next.dataset.lyricsNext = instance.id; caption.textContent = 'Afficher aussi la prochaine ligne'; label.append(next, caption); element.append(label);
          setting.lyrics = { next, saved: instance.config.showNextLine === true };
          const hint = document.createElement('p'); hint.className = 'helper-text'; hint.textContent = 'Paroles de votre chart locale, synchronisées avec l’horloge du jeu. Scannez Songs ; choisissez la version dans Stream si nécessaire. Sans paroles ou horloge compatible, le widget reste transparent.'; element.append(hint);
          next.addEventListener('change', () => { void this.commitLyrics(instance.id); }, { signal });
        }
        fontSize.addEventListener('input', () => { setting.dirty = true; this.feedback(setting); this.availability(); }, { signal });
        fontSize.addEventListener('change', () => { void this.commit(instance.id); }, { signal });
        fontSize.addEventListener('blur', () => { if (setting.dirty) void this.commit(instance.id); }, { signal });
        fontSize.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void this.commit(instance.id); }
          if (event.key === 'Escape' && !this.busy) {
            event.preventDefault(); event.stopPropagation(); setting.dirty = false;
            fontSize.value = String(setting.savedFontSize); this.feedback(setting); this.availability();
          }
        }, { signal });
        decrease.addEventListener('click', () => this.step(instance.id, -2), { signal });
        increase.addEventListener('click', () => this.step(instance.id, 2), { signal });
        this.container.append(element);
      }
      row.checkbox.checked = instance.enabled;
      row.name.textContent = widgetLabel(instance.type);
      row.destination.textContent = instance.visibility.game ? 'Jeu' : 'Masqué';
      row.destination.title = instance.visibility.game ? 'Destination : overlay du jeu' : 'Non affiché dans le jeu';
      const fontSize = instance.style.fontSize;
      row.savedFontSize = typeof fontSize === 'number' && Number.isFinite(fontSize) ? Math.min(200, Math.max(8, fontSize)) : instance.type === 'gameplay.accuracy' ? 16 : 20;
      if (!row.dirty && this.container.ownerDocument.activeElement !== row.fontSize) row.fontSize.value = String(row.savedFontSize);
      row.fontSize.setAttribute('aria-label', `Taille du texte · ${row.name.textContent}`);
      row.decrease.setAttribute('aria-label', `Réduire le texte · ${row.name.textContent}`);
      row.increase.setAttribute('aria-label', `Agrandir le texte · ${row.name.textContent}`);
      if (row.accuracy) {
        const config = row.accuracy.saved = validateAccuracyConfig(instance.config);
        for (const [field,input] of row.accuracy.fields) input.checked = config.fields.includes(field);
        row.accuracy.title.checked = config.showTitle; row.accuracy.coverage.checked = config.showCoverage;
      }
      if (row.lyrics) { row.lyrics.saved = instance.config.showNextLine === true; row.lyrics.next.checked = row.lyrics.saved; }
    }
    this.availability();
  }

  private value(row: SettingRow): number | null {
    const value = row.fontSize.valueAsNumber;
    return Number.isFinite(value) && value >= 8 && value <= 200 ? value : null;
  }

  private feedback(row: SettingRow, message = ''): void {
    row.feedback.textContent = message; row.feedback.hidden = !message;
    row.fontSize.setAttribute('aria-invalid', String(!!message));
  }

  private availability(): void {
    this.container.setAttribute('aria-busy', String(this.busy));
    for (const row of this.rows.values()) {
      const value = this.value(row) ?? row.savedFontSize;
      row.checkbox.disabled = this.busy;
      // Readonly keeps focus and the draft intact while an IPC commit completes.
      row.fontSize.readOnly = this.busy || !this.onFontSize;
      row.decrease.disabled = this.busy || !this.onFontSize || value <= 8;
      row.increase.disabled = this.busy || !this.onFontSize || value >= 200;
      if (row.accuracy) {
        const count = [...row.accuracy.fields.values()].filter(input => input.checked).length;
        for (const input of row.accuracy.fields.values()) input.disabled = this.busy || !this.onAccuracy || count === 1 && input.checked;
        row.accuracy.title.disabled = row.accuracy.coverage.disabled = this.busy || !this.onAccuracy;
      }
      if (row.lyrics) row.lyrics.next.disabled = this.busy || !this.onLyrics;
    }
  }

  private step(id: string, delta: number): void {
    const row = this.rows.get(id);
    if (!row || this.busy || row.fontSize.disabled) return;
    row.fontSize.value = String(Math.min(200, Math.max(8, (this.value(row) ?? row.savedFontSize) + delta)));
    row.dirty = true;
    void this.commit(id);
  }

  private async commit(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || this.disposed || this.busy || !this.onFontSize) return;
    const fontSize = this.value(row);
    if (fontSize === null) { this.feedback(row, 'Saisissez une taille entre 8 et 200 px.'); return; }
    if (fontSize === row.savedFontSize) { row.dirty = false; this.feedback(row); return; }
    const revision = this.revision;
    this.busy = true; this.feedback(row); this.availability();
    try {
      const result = await this.onFontSize({ revision, id, fontSize });
      if (this.disposed || this.rows.get(id) !== row) return;
      if (result && typeof result === 'object' && 'ok' in result && result.ok === true) {
        if (this.revision === revision) row.savedFontSize = fontSize;
        row.dirty = false; row.fontSize.value = String(row.savedFontSize);
      } else this.feedback(row, 'La taille n’a pas été appliquée. Réessayez.');
    } catch {
      if (!this.disposed) this.feedback(row, 'La taille n’a pas pu être enregistrée. Réessayez.');
    } finally {
      this.busy = false;
      if (!this.disposed) this.availability();
    }
  }

  private async commitAccuracy(id: string): Promise<void> {
    const row = this.rows.get(id), controls = row?.accuracy;
    if (!row || !controls || this.disposed || this.busy || !this.onAccuracy) return;
    const fields = [...controls.fields].filter(([,input]) => input.checked).map(([key]) => key);
    if (!fields.length) { for (const [field,input] of controls.fields) input.checked = controls.saved.fields.includes(field); this.feedback(row, 'Gardez au moins une mesure.'); this.availability(); return; }
    const config = validateAccuracyConfig({ fields, showTitle: controls.title.checked, showCoverage: controls.coverage.checked });
    this.busy = true; this.feedback(row); this.availability();
    try {
      const result = await this.onAccuracy({ revision: this.revision, id, config });
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) this.feedback(row, 'Les valeurs affichées n’ont pas été enregistrées. Réessayez.');
    } catch { if (!this.disposed) this.feedback(row, 'Les valeurs affichées n’ont pas été enregistrées. Réessayez.'); }
    finally {
      this.busy = false;
      if (!this.disposed) {
        for (const [field,input] of controls.fields) input.checked = controls.saved.fields.includes(field);
        controls.title.checked = controls.saved.showTitle; controls.coverage.checked = controls.saved.showCoverage;
        this.availability();
      }
    }
  }

  private async commitLyrics(id: string): Promise<void> {
    const row = this.rows.get(id), controls = row?.lyrics;
    if (!row || !controls || this.disposed || this.busy || !this.onLyrics) return;
    this.busy = true; this.feedback(row); this.availability();
    try {
      const result = await this.onLyrics({ revision: this.revision, id, config: { showNextLine: controls.next.checked } });
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) this.feedback(row, 'Les paroles n’ont pas été enregistrées. Réessayez.');
    } catch { if (!this.disposed) this.feedback(row, 'Les paroles n’ont pas été enregistrées. Réessayez.'); }
    finally { this.busy = false; if (!this.disposed) { controls.next.checked = controls.saved; this.availability(); } }
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.rows.clear();
    this.container.replaceChildren();
  }
}
