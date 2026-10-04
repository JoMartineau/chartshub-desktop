import type { AppState } from '../core/state/AppState.js';
import type { WidgetInstance, WidgetStyle } from '../core/types/Widget.js';
import type { ThemeColorToken, ThemeEffects, ThemeSettings } from '../themes/types.js';
import { THEME_COLOR_TOKENS } from '../themes/types.js';
import { themePresets } from '../themes/ThemePresets.js';
import { createDefaultTheme } from '../themes/ThemeService.js';
import { normalizeColor } from '../themes/normalizeColor.js';
import { resolveWidgetStyle } from '../themes/ThemeResolver.js';
import { ColorField } from './ColorField.js';

interface ThemeSnapshot {
  state: AppState;
  editor?: { revision: number; canUndo: boolean; canRedo: boolean };
}
interface ThemeControlOptions {
  root: HTMLElement;
  command: (name: string, payload?: unknown) => Promise<unknown>;
}
type ClearDraft = 'none' | 'effects' | 'appearance' | 'all';
const tokenLabels: Record<ThemeColorToken, string> = {
  primary: 'Primaire', secondary: 'Secondaire', accent: 'Accent', text: 'Texte', mutedText: 'Texte secondaire',
  background: 'Fond', border: 'Bordure', progress: 'Progression · à venir', glow: 'Lueur', shadow: 'Ombre',
};
const widgetLabels: Record<string, string> = {
  'song.title': 'Titre du morceau', 'song.artist': 'Artiste', 'song.charter': 'Créateur de la chart',
  'song.instrument': 'Instrument', 'song.difficulty': 'Difficulté',
};

/** Overlay appearance controls; draft inputs never alter the live store until committed. */
export class ThemeControls {
  private readonly abort = new AbortController();
  private readonly colorInputs = new Map<ThemeColorToken, HTMLInputElement>();
  private readonly colorFields: ColorField[] = [];
  private snapshot: ThemeSnapshot | null = null;
  private selectedWidget = '';
  private optionIds = '';
  private busy = false;
  private effectsDirty = false;
  private appearanceDirty = false;
  private appearanceStyleDirty = false;
  private glowDirty = false;
  private gradientDirty = false;

  constructor(private readonly options: ThemeControlOptions) {
    const document = options.root.ownerDocument;
    const signal = this.abort.signal;
    const preset = this.element<HTMLSelectElement>('#theme-preset');
    for (const entry of themePresets) {
      const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.name; preset.append(option);
    }
    preset.addEventListener('change', () => { void this.send('theme.preset', { revision: this.revision, id: preset.value }, 'effects'); }, { signal });
    this.element('#theme-preset-reset').addEventListener('click', () => { void this.send('theme.preset', { revision: this.revision, id: preset.value }, 'effects'); }, { signal });
    for (const token of THEME_COLOR_TOKENS) {
      const label = document.createElement('label'); label.className = 'theme-color-field';
      const title = document.createElement('span'); title.className = 'theme-color-label'; title.textContent = tokenLabels[token];
      const control = document.createElement('span'); control.className = 'theme-color-control';
      const input = document.createElement('input'); input.type = 'text'; input.id = `theme-color-${token}`;
      input.dataset.themeToken = token; input.spellcheck = false; input.autocomplete = 'off'; input.disabled = true;
      input.setAttribute('aria-describedby', 'theme-color-format');
      input.addEventListener('change', () => { void this.commitColor(token, input); }, { signal });
      label.htmlFor = input.id;
      control.append(input); label.append(title, control); this.element('#theme-colors').append(label);
      this.colorInputs.set(token, input);
      this.colorFields.push(new ColorField(input, tokenLabels[token]));
    }
    for (const id of ['#theme-glow-enabled', '#theme-glow-blur', '#theme-gradient-enabled', '#theme-gradient-from', '#theme-gradient-to', '#theme-gradient-angle']) {
      this.element(id).addEventListener('input', () => { this.effectsDirty = true; this.refreshAvailability(); }, { signal });
      this.element(id).addEventListener('change', () => { this.effectsDirty = true; this.refreshAvailability(); }, { signal });
    }
    this.element('#theme-effects-apply').addEventListener('click', () => { void this.commitEffects(); }, { signal });
    this.element('#theme-undo').addEventListener('click', () => { void this.send('editor.undo', undefined, 'all'); }, { signal });
    this.element('#theme-redo').addEventListener('click', () => { void this.send('editor.redo', undefined, 'all'); }, { signal });
    this.element<HTMLSelectElement>('#appearance-widget').addEventListener('change', event => {
      this.selectedWidget = (event.target as HTMLSelectElement).value;
      this.clearDraft('appearance'); this.render();
    }, { signal });
    this.element('#appearance-color-mode').addEventListener('change', () => { this.appearanceDirty = true; this.appearanceStyleDirty = true; this.refreshAvailability(); }, { signal });
    this.element('#appearance-source-colors').addEventListener('change', () => { this.appearanceDirty = true; this.refreshAvailability(); }, { signal });
    for (const id of ['color', 'background', 'border', 'glow-enabled', 'glow-color', 'glow-blur', 'gradient-enabled', 'gradient-from', 'gradient-to', 'gradient-angle']) {
      const mark = (): void => {
        this.appearanceDirty = true;
        this.appearanceStyleDirty = true;
        if (id.startsWith('glow-')) this.glowDirty = true;
        if (id.startsWith('gradient-')) this.gradientDirty = true;
        this.refreshAvailability();
      };
      this.element(`#appearance-${id}`).addEventListener('input', mark, { signal });
      this.element(`#appearance-${id}`).addEventListener('change', mark, { signal });
    }
    this.element('#appearance-apply').addEventListener('click', () => { void this.commitAppearance(); }, { signal });
    this.element('#appearance-reset').addEventListener('click', () => { void this.resetAppearance(); }, { signal });
    const effectColors: Record<string, string> = {
      'theme-gradient-from': 'Début du dégradé global', 'theme-gradient-to': 'Fin du dégradé global',
      'appearance-color': 'Texte du widget', 'appearance-background': 'Fond du widget', 'appearance-border': 'Bordure du widget',
      'appearance-glow-color': 'Lueur du widget', 'appearance-gradient-from': 'Début du dégradé du widget', 'appearance-gradient-to': 'Fin du dégradé du widget',
    };
    for (const [id, label] of Object.entries(effectColors)) {
      const input = this.element<HTMLInputElement>(`#${id}`);
      const parentLabel = input.closest('label');
      if (parentLabel) parentLabel.htmlFor = id;
      this.colorFields.push(new ColorField(input, label));
    }
    this.refreshAvailability();
  }

  update(snapshot: ThemeSnapshot): void { this.snapshot = snapshot; this.render(); }
  dispose(): void { this.abort.abort(); this.colorFields.forEach(field => field.dispose()); }

  private get revision(): number { return this.snapshot?.editor?.revision ?? 0; }
  private get theme(): ThemeSettings { return this.snapshot?.state.theme ?? createDefaultTheme(); }
  private get widget(): WidgetInstance | undefined { return this.snapshot?.state.widgets.instances.find(instance => instance.id === this.selectedWidget); }
  private customColor(instance: WidgetInstance | undefined): boolean {
    return !!instance && (instance.style.colorMode === 'custom' || (instance.style.colorMode !== 'theme' && typeof instance.style.color === 'string' && normalizeColor(instance.style.color) !== null));
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.options.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing theme control: ${selector}`);
    return element;
  }

  private value(selector: string, value: string | number): void {
    const input = this.element<HTMLInputElement | HTMLSelectElement>(selector);
    if (input !== this.options.root.ownerDocument.activeElement) input.value = String(value);
  }

  private checked(selector: string, value: boolean): void { this.element<HTMLInputElement>(selector).checked = value; }

  private feedback(message: string, error = false): void {
    const feedback = this.element('#theme-feedback'); feedback.textContent = message; feedback.hidden = !message;
    feedback.classList.toggle('is-error', error);
  }

  private validateColor(input: HTMLInputElement, focus = true): string | null {
    const normalized = normalizeColor(input.value);
    input.setAttribute('aria-invalid', String(normalized === null));
    if (normalized === null) {
      this.feedback('Couleur invalide. Utilisez une valeur HEX, RGB ou HSL, avec un alpha facultatif.', true);
      if (focus) input.focus({ preventScroll: true });
    }
    return normalized;
  }

  private number(selector: string, min: number, max: number): number | null {
    const input = this.element<HTMLInputElement>(selector);
    const value = input.valueAsNumber;
    const valid = Number.isFinite(value) && value >= min && value <= max;
    input.setAttribute('aria-invalid', String(!valid));
    if (!valid) { this.feedback(`Saisissez une valeur comprise entre ${min} et ${max}.`, true); input.focus({ preventScroll: true }); }
    return valid ? value : null;
  }

  private async commitColor(token: ThemeColorToken, input: HTMLInputElement): Promise<void> {
    if (!this.snapshot || this.busy) return;
    const color = this.validateColor(input, false);
    if (color === null) return;
    input.value = color;
    await this.send('theme.color', { revision: this.revision, token, color }, 'none');
  }

  private readEffects(): ThemeEffects | null {
    const blur = this.number('#theme-glow-blur', 0, 40); if (blur === null) return null;
    const from = this.validateColor(this.element('#theme-gradient-from')); if (from === null) return null;
    const to = this.validateColor(this.element('#theme-gradient-to')); if (to === null) return null;
    const angle = this.number('#theme-gradient-angle', 0, 360); if (angle === null) return null;
    return {
      glow: { enabled: this.element<HTMLInputElement>('#theme-glow-enabled').checked, blur },
      gradient: { enabled: this.element<HTMLInputElement>('#theme-gradient-enabled').checked, from, to, angle },
    };
  }

  private async commitEffects(): Promise<void> {
    if (!this.snapshot || this.busy) return;
    const effects = this.readEffects();
    if (effects) await this.send('theme.effects', { revision: this.revision, effects }, 'effects');
  }

  private baseStyle(instance: WidgetInstance): WidgetStyle {
    const style: WidgetStyle = { colorMode: 'theme' };
    if (instance.style.fontSize !== undefined) style.fontSize = instance.style.fontSize;
    if (instance.style.fontWeight !== undefined) style.fontWeight = instance.style.fontWeight;
    return style;
  }

  private async commitAppearance(): Promise<void> {
    const instance = this.widget;
    if (!instance || this.busy) return;
    let style = this.appearanceStyleDirty ? this.baseStyle(instance) : { ...instance.style };
    if (this.appearanceStyleDirty && this.element<HTMLSelectElement>('#appearance-color-mode').value === 'custom') {
      const color = this.validateColor(this.element('#appearance-color')); if (color === null) return;
      const backgroundColor = this.validateColor(this.element('#appearance-background')); if (backgroundColor === null) return;
      const borderColor = this.validateColor(this.element('#appearance-border')); if (borderColor === null) return;
      style = { ...instance.style, colorMode: 'custom', color, backgroundColor, borderColor };
      if (this.glowDirty) {
        const glowColor = this.validateColor(this.element('#appearance-glow-color')); if (glowColor === null) return;
        const blur = this.number('#appearance-glow-blur', 0, 40); if (blur === null) return;
        style.glow = { enabled: this.element<HTMLInputElement>('#appearance-glow-enabled').checked, color: glowColor, blur };
      }
      if (this.gradientDirty) {
        const from = this.validateColor(this.element('#appearance-gradient-from')); if (from === null) return;
        const to = this.validateColor(this.element('#appearance-gradient-to')); if (to === null) return;
        const angle = this.number('#appearance-gradient-angle', 0, 360); if (angle === null) return;
        style.gradient = { enabled: this.element<HTMLInputElement>('#appearance-gradient-enabled').checked, from, to, angle };
      }
    }
    if (instance.type === 'song.charter') style.useSourceColors = this.element<HTMLInputElement>('#appearance-source-colors').checked;
    await this.send('widget.appearance', { revision: this.revision, id: instance.id, style }, 'appearance');
  }

  private async resetAppearance(): Promise<void> {
    const instance = this.widget;
    if (!instance || this.busy) return;
    await this.send('widget.appearance', { revision: this.revision, id: instance.id, style: this.baseStyle(instance) }, 'appearance');
  }

  private clearDraft(which: ClearDraft): void {
    if (which === 'effects' || which === 'all') this.effectsDirty = false;
    if (which === 'appearance' || which === 'all') { this.appearanceDirty = false; this.appearanceStyleDirty = false; this.glowDirty = false; this.gradientDirty = false; }
  }

  private async send(name: string, payload: unknown, clear: ClearDraft): Promise<void> {
    if (!this.snapshot || this.busy) return;
    this.busy = true; this.feedback('Enregistrement…'); this.refreshAvailability();
    try {
      const result = await this.options.command(name, payload);
      const ok = result && typeof result === 'object' && 'ok' in result && result.ok === true;
      if (ok) { this.clearDraft(clear); this.feedback('Apparence enregistrée.'); }
      else this.feedback('La modification n’a pas été appliquée. Vérifiez le réglage et réessayez.', true);
    } catch { this.feedback('L’apparence n’a pas pu être enregistrée. Réessayez dans un instant.', true); }
    finally { this.busy = false; this.render(); }
  }

  private render(): void {
    if (!this.snapshot) { this.refreshAvailability(); return; }
    const theme = this.theme;
    this.value('#theme-preset', theme.presetId);
    for (const token of THEME_COLOR_TOKENS) {
      const input = this.colorInputs.get(token)!;
      const active = this.options.root.ownerDocument.activeElement;
      if (input !== active && !input.closest('.color-field')?.contains(active)) input.value = theme.colors[token];
    }
    if (!this.effectsDirty) {
      this.checked('#theme-glow-enabled', theme.effects.glow.enabled); this.value('#theme-glow-blur', theme.effects.glow.blur);
      this.checked('#theme-gradient-enabled', theme.effects.gradient.enabled);
      this.value('#theme-gradient-from', theme.effects.gradient.from); this.value('#theme-gradient-to', theme.effects.gradient.to);
      this.value('#theme-gradient-angle', theme.effects.gradient.angle);
    }
    const instances = this.snapshot.state.widgets.instances;
    const optionIds = instances.map(instance => instance.id).join('\u0000');
    const select = this.element<HTMLSelectElement>('#appearance-widget');
    if (optionIds !== this.optionIds) {
      this.optionIds = optionIds;
      const document = this.options.root.ownerDocument;
      const fragment = document.createDocumentFragment();
      for (const instance of instances) { const option = document.createElement('option'); option.value = instance.id; option.textContent = widgetLabels[instance.type] ?? instance.type; fragment.append(option); }
      select.replaceChildren(fragment);
    }
    if (!instances.some(instance => instance.id === this.selectedWidget)) { this.selectedWidget = instances[0]?.id ?? ''; this.clearDraft('appearance'); }
    select.value = this.selectedWidget;
    const instance = this.widget;
    if (instance && !this.appearanceDirty) {
      const resolved = resolveWidgetStyle(instance, theme);
      this.checked('#appearance-source-colors', resolved.useSourceColors);
      this.value('#appearance-color-mode', this.customColor(instance) ? 'custom' : 'theme');
      this.value('#appearance-color', resolved.color); this.value('#appearance-background', resolved.backgroundColor); this.value('#appearance-border', resolved.borderColor);
      this.checked('#appearance-glow-enabled', resolved.glow.enabled); this.value('#appearance-glow-color', resolved.glow.color); this.value('#appearance-glow-blur', resolved.glow.blur);
      this.checked('#appearance-gradient-enabled', resolved.gradient.enabled); this.value('#appearance-gradient-from', resolved.gradient.from);
      this.value('#appearance-gradient-to', resolved.gradient.to); this.value('#appearance-gradient-angle', resolved.gradient.angle);
    }
    this.refreshAvailability();
  }

  private refreshAvailability(): void {
    const disabled = this.busy || !this.snapshot;
    const panel = this.element('#theme-panel');
    panel.setAttribute('aria-busy', String(this.busy));
    panel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach(control => { control.disabled = disabled; });
    this.element<HTMLButtonElement>('#theme-undo').disabled = disabled || !this.snapshot?.editor?.canUndo;
    this.element<HTMLButtonElement>('#theme-redo').disabled = disabled || !this.snapshot?.editor?.canRedo;
    this.element<HTMLButtonElement>('#theme-effects-apply').disabled = disabled || !this.effectsDirty;
    this.element('#theme-effects-status').textContent = this.effectsDirty ? 'Effets modifiés, à appliquer.' : 'Effets enregistrés.';
    const instance = this.widget;
    const custom = this.element<HTMLSelectElement>('#appearance-color-mode').value === 'custom';
    this.element('#appearance-source-colors-field').hidden = instance?.type !== 'song.charter';
    this.element<HTMLInputElement>('#appearance-source-colors').disabled = disabled || instance?.type !== 'song.charter';
    this.element<HTMLSelectElement>('#appearance-widget').disabled = disabled || !instance;
    this.element<HTMLSelectElement>('#appearance-color-mode').disabled = disabled || !instance;
    for (const id of ['color', 'background', 'border', 'glow-enabled', 'glow-color', 'glow-blur', 'gradient-enabled', 'gradient-from', 'gradient-to', 'gradient-angle']) {
      this.element<HTMLInputElement>(`#appearance-${id}`).disabled = disabled || !instance || !custom;
    }
    this.element<HTMLButtonElement>('#appearance-apply').disabled = disabled || !instance || !this.appearanceDirty;
    this.element<HTMLButtonElement>('#appearance-reset').disabled = disabled || !instance;
    this.element('#appearance-status').textContent = this.appearanceDirty ? 'Modifications à appliquer au widget.' : this.customColor(instance) ? 'Couleurs personnalisées enregistrées.' : 'Le widget suit le thème.';
    this.element('#appearance-glow-source').textContent = this.glowDirty || !!instance?.style.glow ? 'Personnalisée' : 'Thème';
    this.element('#appearance-gradient-source').textContent = this.gradientDirty || !!instance?.style.gradient ? 'Personnalisé' : 'Thème';
    this.colorFields.forEach(field => field.sync());
  }
}
