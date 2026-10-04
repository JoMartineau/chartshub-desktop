import type { AppState } from '../../core/state/AppState.js';
import { validateColoredTextSegments, type ColoredTextSegment } from '../../core/types/ColoredText.js';
import type { WidgetDestination } from '../../core/types/Widget.js';
import { resolveWidgetStyle, type ResolvedWidgetStyle } from '../../themes/ThemeResolver.js';
import { WidgetErrorBoundary } from './WidgetErrorBoundary.js';
import type { WidgetErrorHandler } from './WidgetErrorBoundary.js';
import { WidgetRegistry } from './WidgetRegistry.js';
import { meaningfulText } from './WidgetSelectors.js';
import { isWidgetVisible } from './VisibilityResolver.js';

export interface WidgetRenderModel {
  id: string;
  type: string;
  text: string;
  segments?: ColoredTextSegment[];
  position: { x: number; y: number };
  size: { width: number; height: number };
  style: ResolvedWidgetStyle;
}

function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export class WidgetRenderer {
  private readonly boundary: WidgetErrorBoundary;

  constructor(private readonly registry: WidgetRegistry, onError?: WidgetErrorHandler) {
    this.boundary = new WidgetErrorBoundary(onError);
  }

  /** DOM-independent rendering makes visibility and fault isolation testable. */
  renderWidgetModels(state: AppState, destination: WidgetDestination = 'game'): WidgetRenderModel[] {
    const models: WidgetRenderModel[] = [];
    for (const instance of state.widgets.instances) {
      const model = this.boundary.run(instance, () => {
        const registration = this.registry.get(instance.type);
        if (!registration || !isWidgetVisible(instance, registration.definition, state, destination)) return null;
        const content = registration.component(state, instance);
        const text = meaningfulText(content?.text);
        if (text === null) return null;
        const defaultSize = registration.definition.defaultSize;
        const style = resolveWidgetStyle(instance, state.theme);
        // Source formatting is restricted to validated charter text, even for a custom registry.
        const segments = instance.type === 'song.charter' && style.useSourceColors
          ? validateColoredTextSegments(content?.segments, text) : undefined;
        return {
          id: instance.id,
          type: instance.type,
          text,
          ...(segments ? { segments } : {}),
          position: {
            x: boundedNumber(instance.position.x, 0, -100000, 100000),
            y: boundedNumber(instance.position.y, 0, -100000, 100000)
          },
          size: {
            width: boundedNumber(instance.size.width, boundedNumber(defaultSize.width, 200, 1, 100000), 1, 100000),
            height: boundedNumber(instance.size.height, boundedNumber(defaultSize.height, 40, 1, 100000), 1, 100000)
          },
          style
        };
      });
      if (model !== null) models.push(model);
    }
    return models;
  }

  render(container: HTMLElement, state: AppState, destination: WidgetDestination = 'game'): void {
    const document = container.ownerDocument;
    const fragment = document.createDocumentFragment();
    for (const model of this.renderWidgetModels(state, destination)) {
      this.boundary.run(model, () => {
        const element = document.createElement('span');
        element.className = 'companion-widget';
        element.dataset.widgetId = model.id;
        element.dataset.widgetType = model.type;
        const text = document.createElement('span');
        text.className = 'companion-widget-text';
        if (model.segments) {
          for (const segment of model.segments) {
            const run = document.createElement('span');
            run.className = 'companion-widget-segment';
            run.textContent = segment.text;
            if (segment.color) run.style.color = segment.color;
            text.appendChild(run);
          }
        } else text.textContent = model.text;
        Object.assign(element.style, {
          position: 'absolute',
          left: `${model.position.x}px`,
          top: `${model.position.y}px`,
          width: `${model.size.width}px`,
          height: `${model.size.height}px`,
          color: model.style.color,
          backgroundColor: model.style.backgroundColor,
          boxShadow: `inset 0 0 0 1px ${model.style.borderColor}`,
          fontSize: `${model.style.fontSize}px`,
          fontWeight: String(model.style.fontWeight),
          lineHeight: '1.25',
          whiteSpace: 'nowrap',
          overflow: 'visible',
          pointerEvents: 'none'
        });
        const shadowColor = model.style.shadowColor ?? '#000000e6';
        const shadows = [`0 2px 6px ${shadowColor}`, `0 0 2px ${shadowColor}`];
        if (model.style.glow.enabled) shadows.push(`0 0 ${model.style.glow.blur}px ${model.style.glow.color}`);
        // Padding outside the unchanged widget rectangle gives shadows room while
        // preserving text ellipsis inside the original content width.
        const padding = Math.max(8, model.style.glow.enabled ? Math.ceil(model.style.glow.blur) : 0);
        Object.assign(text.style, {
          display: 'block',
          boxSizing: 'border-box',
          width: `calc(100% + ${padding * 2}px)`,
          // Large fonts may extend below the fixed layout frame without clipping a line.
          height: `${Math.max(model.size.height, model.style.fontSize * 1.25) + padding * 2}px`,
          padding: `${padding}px`,
          margin: `-${padding}px`,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textShadow: shadows.join(', '),
        });
        if (model.style.gradient.enabled && !model.segments) {
          // Text shadows paint above a clipped background and obscure its colors.
          // Filter the composed glyphs instead, keeping each shadow behind them.
          const filters = [`drop-shadow(0 2px 3px ${shadowColor})`, `drop-shadow(0 0 1px ${shadowColor})`];
          if (model.style.glow.enabled) filters.push(`drop-shadow(0 0 ${model.style.glow.blur / 2}px ${model.style.glow.color})`);
          Object.assign(text.style, {
            backgroundImage: `linear-gradient(${model.style.gradient.angle}deg, ${model.style.gradient.from}, ${model.style.gradient.to})`,
            backgroundOrigin: 'content-box',
            backgroundClip: 'text',
            webkitBackgroundClip: 'text',
            color: 'transparent',
            webkitTextFillColor: 'transparent',
            textShadow: 'none',
            filter: filters.join(' '),
          });
        }
        element.appendChild(text);
        fragment.appendChild(element);
      });
    }
    container.replaceChildren(fragment);
  }
}
