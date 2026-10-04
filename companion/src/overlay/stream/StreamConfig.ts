import type { AppState } from '../../core/state/AppState.js';
import type { WidgetInstance } from '../../core/types/Widget.js';
import { CANVAS_WIDTH, CANVAS_HEIGHT, MIN_WIDGET_WIDTH, MIN_WIDGET_HEIGHT, patchWidgetGeometry } from '../../layout/WidgetLayoutEngine.js';

export interface StreamLayoutItem { id: string; x: number; y: number; width: number; height: number; }
export interface StreamSettings {
  port: number;
  canvas: { width: number; height: number; fps: 30 | 60 };
  /** Geometry stays in 1280×720 logical units, independent of the OBS viewport. */
  layout: StreamLayoutItem[];
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('Réglages stream non pris en charge.');
  return value as Record<string, unknown>;
}

function finite(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw Error('Valeur stream invalide.');
  return value;
}

/** A complete layout avoids silently reusing game coordinates after later edits. */
export function validateStream(value: unknown, widgets: readonly WidgetInstance[]): StreamSettings {
  const stream = record(value, ['port', 'canvas', 'layout']);
  const port = finite(stream.port, 1024, 65535, true);
  const canvas = record(stream.canvas, ['width', 'height', 'fps']);
  const width = finite(canvas.width, 320, 7680, true);
  const height = finite(canvas.height, 180, 4320, true);
  if (canvas.fps !== 30 && canvas.fps !== 60) throw Error('Fréquence stream invalide.');
  const ids = new Set(widgets.map(widget => widget.id));
  if (ids.size !== widgets.length || widgets.length > 100 || !Array.isArray(stream.layout) || stream.layout.length !== widgets.length) throw Error('Disposition stream incomplète.');
  const layout = new Map<string, StreamLayoutItem>();
  for (const entry of stream.layout) {
    const item = record(entry, ['id', 'x', 'y', 'width', 'height']);
    if (typeof item.id !== 'string' || !ids.has(item.id) || layout.has(item.id)) throw Error('Identifiant stream invalide.');
    const itemWidth = finite(item.width, MIN_WIDGET_WIDTH, CANVAS_WIDTH);
    const itemHeight = finite(item.height, MIN_WIDGET_HEIGHT, CANVAS_HEIGHT);
    layout.set(item.id, {
      id: item.id,
      x: finite(item.x, 0, CANVAS_WIDTH - itemWidth),
      y: finite(item.y, 0, CANVAS_HEIGHT - itemHeight),
      width: itemWidth,
      height: itemHeight,
    });
  }
  return { port, canvas: { width, height, fps: canvas.fps }, layout: widgets.map(widget => ({ ...layout.get(widget.id)! })) };
}

/** Copy the current game layout once; legacy oversized rectangles are fitted only in the stream copy. */
export function createDefaultStream(widgets: readonly WidgetInstance[]): StreamSettings {
  const layout = widgets.map(widget => {
    // Initial stream fitting is migration, not an edit to the locked game widget.
    const normalized = patchWidgetGeometry([{ ...widget, locked: false }], widget.id, {})[0]!;
    return { id: widget.id, x: normalized.position.x, y: normalized.position.y, width: normalized.size.width, height: normalized.size.height };
  });
  return validateStream({ port: 38473, canvas: { width: 1280, height: 720, fps: 60 }, layout }, widgets);
}

/** Project independent stream geometry without changing the game layout, flags, or theme. */
export function projectStreamState(state: AppState): AppState {
  const stream = state.stream ? validateStream(state.stream, state.widgets.instances) : createDefaultStream(state.widgets.instances);
  const layout = new Map(stream.layout.map(item => [item.id, item]));
  return {
    ...state,
    widgets: {
      ...state.widgets,
      instances: state.widgets.instances.map(instance => {
        const item = layout.get(instance.id)!;
        return { ...instance, position: { x: item.x, y: item.y }, size: { width: item.width, height: item.height } };
      }),
    },
  };
}
