import { normalizeColor } from '../themes/normalizeColor.js';

/** Mouse-friendly color controls that preserve the existing text field and its events. */
export class ColorField {
  private readonly abort = new AbortController();
  private readonly wrapper: HTMLSpanElement;
  private readonly picker: HTMLInputElement;
  private readonly opacity: HTMLInputElement;
  private readonly fill: HTMLSpanElement;
  private readonly percentage: HTMLSpanElement;
  private readonly hadTextClass: boolean;
  private rgb = '#000000';
  private alpha = 255;
  private disposed = false;

  constructor(private readonly input: HTMLInputElement, label: string) {
    if (!input.id || !input.parentNode) throw new Error('ColorField requires an existing input with an ID.');
    const document = input.ownerDocument;
    this.wrapper = document.createElement('span');
    this.wrapper.className = 'color-field';
    const swatch = document.createElement('span');
    swatch.className = 'color-field-swatch';
    this.fill = document.createElement('span');
    this.fill.className = 'color-field-fill';
    this.fill.setAttribute('aria-hidden', 'true');
    this.picker = document.createElement('input');
    this.picker.type = 'color';
    this.picker.id = `${input.id}-picker`;
    this.picker.dataset.colorFor = input.id;
    this.picker.className = 'color-field-picker';
    this.picker.setAttribute('aria-label', `Choisir la couleur : ${label}`);
    this.picker.title = `Choisir la couleur : ${label}`;
    swatch.append(this.fill, this.picker);

    const opacityRow = document.createElement('span');
    opacityRow.className = 'color-field-opacity';
    const opacityLabel = document.createElement('span');
    opacityLabel.className = 'color-field-opacity-label';
    opacityLabel.textContent = 'Opacité';
    opacityLabel.setAttribute('aria-hidden', 'true');
    this.opacity = document.createElement('input');
    this.opacity.type = 'range';
    this.opacity.id = `${input.id}-opacity`;
    this.opacity.dataset.opacityFor = input.id;
    this.opacity.min = '0';
    this.opacity.max = '100';
    this.opacity.step = '1';
    this.opacity.setAttribute('aria-label', `Opacité : ${label}`);
    this.percentage = document.createElement('span');
    this.percentage.className = 'color-field-opacity-value';
    this.percentage.setAttribute('aria-hidden', 'true');
    opacityRow.append(opacityLabel, this.opacity, this.percentage);

    this.hadTextClass = input.classList.contains('color-field-text');
    input.classList.add('color-field-text');
    input.parentNode.insertBefore(this.wrapper, input);
    this.wrapper.append(swatch, input, opacityRow);
    const signal = this.abort.signal;
    input.addEventListener('input', () => this.sync(), { signal });
    input.addEventListener('change', () => this.sync(), { signal });
    for (const type of ['input', 'change'] as const) {
      this.picker.addEventListener(type, event => this.updateFromControl(event, 'rgb', type), { signal });
      this.opacity.addEventListener(type, event => this.updateFromControl(event, 'alpha', type), { signal });
    }
    this.sync();
  }

  /** Programmatic refresh only: never rewrites text, dispatches events, or changes app state. */
  sync(): void {
    if (this.disposed) return;
    const color = normalizeColor(this.input.value);
    if (color !== null) {
      this.rgb = color.slice(0, 7);
      this.alpha = color.length === 9 ? Number.parseInt(color.slice(7), 16) : 255;
    }
    const percent = Math.round(this.alpha * 100 / 255);
    this.picker.value = this.rgb;
    this.opacity.value = String(percent);
    this.opacity.setAttribute('aria-valuetext', `${percent} %`);
    this.percentage.textContent = `${percent} %`;
    this.fill.style.backgroundColor = this.hexValue();
    this.wrapper.style.setProperty('--color-field-rgb', this.rgb);
    this.picker.disabled = this.input.disabled;
    this.opacity.disabled = this.input.disabled;
    this.wrapper.classList.toggle('is-disabled', this.input.disabled);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.wrapper.replaceWith(this.input);
    if (!this.hadTextClass) this.input.classList.remove('color-field-text');
  }

  private hexValue(): string {
    return this.rgb + (this.alpha === 255 ? '' : this.alpha.toString(16).padStart(2, '0'));
  }

  private updateFromControl(event: Event, channel: 'rgb' | 'alpha', type: 'input' | 'change'): void {
    // Only the proxied text-field event should bubble to existing application handlers.
    event.stopPropagation();
    if (this.disposed || this.input.disabled) return;
    const current = normalizeColor(this.input.value);
    if (current !== null) {
      this.rgb = current.slice(0, 7);
      this.alpha = current.length === 9 ? Number.parseInt(current.slice(7), 16) : 255;
    }
    if (channel === 'rgb') {
      const color = normalizeColor(this.picker.value);
      if (color === null) return;
      // Preserve the exact alpha byte, rather than reconstructing it from the rounded slider.
      this.rgb = color.slice(0, 7);
    } else {
      const percent = Number(this.opacity.value);
      if (!Number.isFinite(percent)) return;
      this.alpha = Math.round(Math.min(100, Math.max(0, percent)) * 255 / 100);
    }
    this.input.value = this.hexValue();
    this.sync();
    const EventClass = this.input.ownerDocument.defaultView?.Event ?? Event;
    this.input.dispatchEvent(new EventClass(type, { bubbles: true }));
  }
}
