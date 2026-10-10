import { normalizeColor } from '../dist/themes/normalizeColor.js';

const defaults = () => ({ backgroundColor: '#151719e6', textColor: '#eef1f2', fontFamily: 'system', fontSize: 14 });
const fonts = Object.freeze({ system: '"Segoe UI", Arial, sans-serif', arial: 'Arial, sans-serif', verdana: 'Verdana, sans-serif', georgia: 'Georgia, serif', consolas: 'Consolas, monospace' });
const panels = ['catalogue', 'filters'];
const clone = value => ({ ...value });
function normalized(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(fonts, value.fontFamily) || !Number.isInteger(value.fontSize) || value.fontSize < 10 || value.fontSize > 24) return null;
  const backgroundColor = normalizeColor(value.backgroundColor), textColor = normalizeColor(value.textColor);
  return backgroundColor && textColor?.length === 7 ? { backgroundColor, textColor, fontFamily: value.fontFamily, fontSize: value.fontSize } : null;
}
const validState = (value, allowed = panels) => value && Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.canWrite === 'boolean' && allowed.every(panel => normalized(value.appearance?.[panel]));

/** Scoped variables only; callers decide which panel surface inherits them. */
export function applyFloatingAppearance(element, appearance) {
  const value = normalized(appearance) ?? defaults();
  element.style.setProperty('--floating-background', value.backgroundColor);
  element.style.setProperty('--floating-text', value.textColor);
  element.style.setProperty('--floating-font', fonts[value.fontFamily]);
  element.style.setProperty('--floating-font-size', `${value.fontSize}px`);
}

export class FloatingPanelsControls {
  constructor({ root, command, panels: allowedPanels = ['catalogue', 'filters'] }) {
    if (!Array.isArray(allowedPanels) || !allowedPanels.length || allowedPanels.some(panel => !panels.includes(panel)) || new Set(allowedPanels).size !== allowedPanels.length) throw Error('Invalid floating panel controls');
    this.panels = [...allowedPanels];
    this.root = root; this.command = command; this.abort = new AbortController(); this.state = null; this.signature = '';
    this.selected = this.panels[0]; this.drafts = new Map(this.panels.map(panel => [panel, defaults()])); this.dirty = new Set(); this.busy = false; this.disposed = false; this.invalid = false;
    this.container = this.make('div', 'floating-panels-controls'); this.container.className = 'floating-panels-controls';
    const title = this.make('h3', '', 'Apparence des fenêtres flottantes');
    const hint = this.make('p', '', 'Personnalisez chaque fenêtre. L’aperçu reste local jusqu’à l’enregistrement.'); hint.className = 'floating-panels-hint';
    this.panel = this.make('select', 'floating-panels-panel');
    for (const [value, label] of [['catalogue', 'Catalogue'], ['filters', 'Filtres du jeu']]) if (this.panels.includes(value)) this.option(this.panel, value, label);
    this.background = this.make('input', 'floating-panels-background'); this.background.type = 'color';
    this.text = this.make('input', 'floating-panels-text'); this.text.type = 'color';
    this.opacity = this.make('input', 'floating-panels-opacity'); this.opacity.type = 'range'; this.opacity.min = '0'; this.opacity.max = '100'; this.opacity.step = '1';
    this.opacityValue = this.make('output', 'floating-panels-opacity-value'); this.opacityValue.setAttribute('for', this.opacity.id); this.opacity.setAttribute('aria-describedby', this.opacityValue.id);
    this.font = this.make('select', 'floating-panels-font');
    for (const [value, label] of [['system', 'Système'], ['arial', 'Arial'], ['verdana', 'Verdana'], ['georgia', 'Georgia'], ['consolas', 'Consolas']]) this.option(this.font, value, label);
    this.size = this.make('input', 'floating-panels-font-size'); this.size.type = 'number'; this.size.min = '10'; this.size.max = '24'; this.size.step = '1';
    const grid = this.make('div'); grid.className = 'floating-panels-grid';
    grid.append(this.label('Fenêtre à personnaliser', this.panel), this.label('Couleur du fond', this.background), this.label('Couleur du texte', this.text));
    const opacity = this.label('Opacité du fond', this.opacity); opacity.append(this.opacityValue);
    grid.append(opacity, this.label('Police', this.font), this.label('Taille du texte', this.size));
    const previewWrap = this.make('div'); previewWrap.className = 'floating-panels-preview-wrap';
    this.preview = this.make('div', 'floating-panels-preview'); this.preview.className = 'floating-panels-preview'; this.preview.setAttribute('role', 'group'); this.preview.setAttribute('aria-label', 'Aperçu local');
    this.previewTitle = this.make('strong'); this.previewText = this.make('p'); this.preview.append(this.previewTitle, this.previewText); previewWrap.append(this.preview);
    const actions = this.make('div'); actions.className = 'floating-panels-actions';
    this.save = this.make('button', 'floating-panels-save', 'Enregistrer l’apparence'); this.save.type = 'button'; this.save.className = 'button primary';
    this.reset = this.make('button', 'floating-panels-reset', 'Valeurs par défaut'); this.reset.type = 'button'; this.reset.className = 'button secondary';
    actions.append(this.save, this.reset);
    this.feedback = this.make('p', 'floating-panels-feedback'); this.feedback.className = 'floating-panels-feedback'; this.feedback.setAttribute('role', 'status'); this.feedback.setAttribute('aria-live', 'polite'); this.feedback.hidden = true;
    this.container.append(title, hint, grid, previewWrap, actions, this.feedback); root.append(this.container);
    const signal = this.abort.signal;
    this.panel.addEventListener('change', () => { if (!this.panels.includes(this.panel.value) || this.busy) return; this.selected = this.panel.value; this.invalid = false; this.message(''); this.render(); }, { signal });
    for (const input of [this.background, this.text, this.opacity, this.font, this.size]) {
      input.addEventListener('input', () => this.edit(), { signal }); input.addEventListener('change', () => this.edit(), { signal });
    }
    this.save.addEventListener('click', () => { void this.commit(); }, { signal });
    this.reset.addEventListener('click', () => {
      if (!this.state?.canWrite || this.busy) return;
      this.drafts.set(this.selected, defaults()); this.dirty.add(this.selected); this.invalid = false; this.render();
      this.message('Valeurs par défaut prêtes. Enregistrez pour les appliquer.');
    }, { signal });
    this.render();
  }
  make(tag, id = '', text = '') { const element = this.root.ownerDocument.createElement(tag); if (id) element.id = id; if (text) element.textContent = text; return element; }
  label(text, input) { const label = this.make('label'); label.htmlFor = input.id; label.append(this.make('span', '', text), input); return label; }
  option(select, value, label) { const option = this.make('option', '', label); option.value = value; select.append(option); }
  message(text, error = false) { this.feedback.textContent = text; this.feedback.hidden = !text; this.feedback.classList.toggle('is-error', error); }
  update(snapshot) {
    if (this.disposed || !validState(snapshot?.floatingPanels, this.panels)) return;
    const value = snapshot.floatingPanels, signature = JSON.stringify(value); if (signature === this.signature) return;
    this.signature = signature; this.state = { ...value, appearance: Object.fromEntries(this.panels.map(panel => [panel, normalized(value.appearance[panel])])) };
    for (const panel of this.panels) if (!this.dirty.has(panel)) this.drafts.set(panel, clone(this.state.appearance[panel]));
    if (value.error) this.message(value.error, true);
    // A progress snapshot cannot overwrite an unfinished local draft or an invalid text field.
    if (!this.dirty.has(this.selected) && !this.invalid) this.render(); else this.availability();
  }
  edit() {
    if (this.disposed || !this.state?.canWrite || this.busy) return;
    const opacity = Number(this.opacity.value), size = Number(this.size.value);
    this.invalid = !Number.isInteger(opacity) || opacity < 0 || opacity > 100 || !Number.isInteger(size) || size < 10 || size > 24;
    this.size.setAttribute('aria-invalid', String(!Number.isInteger(size) || size < 10 || size > 24));
    this.opacity.setAttribute('aria-invalid', String(!Number.isInteger(opacity) || opacity < 0 || opacity > 100));
    if (this.invalid) { this.message('Choisissez une taille entière de 10 à 24 et une opacité de 0 à 100 %.', true); this.availability(); return; }
    const previous = this.drafts.get(this.selected)?.backgroundColor ?? defaults().backgroundColor;
    const previousAlpha = previous.length === 9 ? parseInt(previous.slice(7), 16) : 255;
    const alpha = (Math.round(previousAlpha * 100 / 255) === opacity ? previousAlpha : Math.round(opacity * 255 / 100)).toString(16).padStart(2, '0');
    const value = normalized({ backgroundColor: this.background.value + (alpha === 'ff' ? '' : alpha), textColor: this.text.value, fontFamily: this.font.value, fontSize: size });
    if (!value) { this.invalid = true; this.message('Les réglages de la fenêtre flottante sont invalides.', true); this.availability(); return; }
    this.drafts.set(this.selected, value); this.dirty.add(this.selected); this.message('Aperçu local. Enregistrez pour appliquer ces réglages.');
    this.opacityValue.textContent = `${opacity} %`; this.opacity.setAttribute('aria-valuetext', `${opacity} %`);
    applyFloatingAppearance(this.preview, value); this.availability();
  }
  render() {
    const value = this.drafts.get(this.selected) ?? defaults(), alpha = value.backgroundColor.length === 9 ? parseInt(value.backgroundColor.slice(7), 16) : 255;
    this.panel.value = this.selected; this.background.value = value.backgroundColor.slice(0, 7); this.text.value = value.textColor;
    this.opacity.value = String(Math.round(alpha * 100 / 255)); this.opacityValue.textContent = `${this.opacity.value} %`; this.opacity.setAttribute('aria-valuetext', `${this.opacity.value} %`);
    this.font.value = value.fontFamily; this.size.value = String(value.fontSize); this.size.setAttribute('aria-invalid', 'false'); this.opacity.setAttribute('aria-invalid', 'false');
    this.previewTitle.textContent = this.selected === 'catalogue' ? 'Aperçu du Catalogue' : 'Aperçu des filtres';
    this.previewText.textContent = this.selected === 'catalogue' ? 'Recherche, téléchargements et morceaux récents.' : 'Filtres du jeu et réglages rapides.';
    applyFloatingAppearance(this.preview, value); this.availability();
  }
  availability() {
    const unavailable = !this.state?.canWrite || this.busy;
    this.panel.disabled = !this.state || this.busy;
    for (const input of [this.background, this.text, this.opacity, this.font, this.size, this.reset]) input.disabled = unavailable;
    this.save.disabled = unavailable || this.invalid || !this.dirty.has(this.selected);
    this.save.textContent = this.busy ? 'Enregistrement…' : 'Enregistrer l’apparence'; this.container.setAttribute('aria-busy', String(this.busy));
  }
  async commit() {
    if (this.disposed || !this.state?.canWrite || this.busy || this.invalid || !this.dirty.has(this.selected)) return;
    const panel = this.selected, appearance = clone(this.drafts.get(panel)), revision = this.state.revision;
    this.busy = true; this.message(''); this.availability();
    try {
      const response = await this.command('panels.appearance', { revision, panel, appearance });
      if (this.disposed) return;
      if (!response?.ok) throw Error(response?.error || 'L’apparence n’a pas pu être enregistrée. Vos réglages restent dans l’aperçu.');
      const saved = response.result ?? response.snapshot?.floatingPanels;
      if (!validState(saved, this.panels) || saved.revision <= revision) throw Error('L’apparence n’a pas pu être enregistrée. Vos réglages restent dans l’aperçu.');
      this.update({ floatingPanels: saved });
      this.dirty.delete(panel); this.drafts.set(panel, clone(saved.appearance[panel]));
      this.invalid = false; this.render(); this.message('Apparence enregistrée pour cette fenêtre.');
    } catch (failure) {
      if (!this.disposed) this.message(failure instanceof Error ? failure.message : 'L’apparence n’a pas pu être enregistrée. Vos réglages restent dans l’aperçu.', true);
    } finally { if (!this.disposed) { this.busy = false; this.availability(); } }
  }
  dispose() { this.disposed = true; this.abort.abort(); }
}
