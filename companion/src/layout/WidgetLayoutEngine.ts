import type { WidgetInstance } from '../core/types/Widget.js';

export const CANVAS_WIDTH = 1280;
export const CANVAS_HEIGHT = 720;
export const MIN_WIDGET_WIDTH = 24;
export const MIN_WIDGET_HEIGHT = 16;

export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export type LayoutAlignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export interface LayoutOptions { snap?: number; }
export interface GeometryPatch { x?: number; y?: number; width?: number; height?: number; }
interface Geometry { x: number; y: number; width: number; height: number; }

const finite = (value: number | undefined, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function geometry(instance: WidgetInstance, patch: GeometryPatch = {}): Geometry {
  const width = clamp(finite(patch.width, finite(instance.size.width, MIN_WIDGET_WIDTH)), MIN_WIDGET_WIDTH, CANVAS_WIDTH);
  const height = clamp(finite(patch.height, finite(instance.size.height, MIN_WIDGET_HEIGHT)), MIN_WIDGET_HEIGHT, CANVAS_HEIGHT);
  return {
    x: clamp(finite(patch.x, finite(instance.position.x, 0)), 0, CANVAS_WIDTH - width),
    y: clamp(finite(patch.y, finite(instance.position.y, 0)), 0, CANVAS_HEIGHT - height),
    width,
    height,
  };
}

function applyGeometry(instance: WidgetInstance, next: Geometry): WidgetInstance {
  if (instance.position.x === next.x && instance.position.y === next.y && instance.size.width === next.width && instance.size.height === next.height) return instance;
  return { ...instance, position: { x: next.x, y: next.y }, size: { width: next.width, height: next.height } };
}

function snap(value: number, options?: LayoutOptions): number {
  // Omitted options preserve free movement; an explicitly enabled grid defaults to 8.
  const grid = options ? finite(options.snap, 8) : 0;
  return grid > 0 ? Math.round(value / grid) * grid : value;
}

function selected(instances: readonly WidgetInstance[], ids: readonly string[]): Array<{ instance: WidgetInstance; box: Geometry }> {
  const selection = new Set(ids);
  return instances.filter(instance => selection.has(instance.id) && instance.locked !== true).map(instance => ({ instance, box: geometry(instance) }));
}

function bounds(items: Array<{ box: Geometry }>): Geometry {
  const x = Math.min(...items.map(({ box }) => box.x));
  const y = Math.min(...items.map(({ box }) => box.y));
  return {
    x,
    y,
    width: Math.max(...items.map(({ box }) => box.x + box.width)) - x,
    height: Math.max(...items.map(({ box }) => box.y + box.height)) - y,
  };
}

/** Convert pointer displacement to canvas units without coupling layout to the DOM. */
export function screenDeltaToCanvas(dx: number, dy: number, scale: number): { dx: number; dy: number } {
  if (!Number.isFinite(scale) || scale <= 0) return { dx: 0, dy: 0 };
  return { dx: finite(dx / scale, 0), dy: finite(dy / scale, 0) };
}

/** Move a selection with one clamped delta, preserving all relative spacing. */
export function moveWidgets(instances: readonly WidgetInstance[], ids: readonly string[], dx: number, dy: number, options?: LayoutOptions): WidgetInstance[] {
  const items = selected(instances, ids);
  if (!items.length) return [...instances];
  const box = bounds(items);
  const deltaX = clamp(snap(box.x + finite(dx, 0), options) - box.x, -box.x, CANVAS_WIDTH - box.x - box.width);
  const deltaY = clamp(snap(box.y + finite(dy, 0), options) - box.y, -box.y, CANVAS_HEIGHT - box.y - box.height);
  const updates = new Map(items.map(({ instance, box: item }) => [instance.id, applyGeometry(instance, { ...item, x: item.x + deltaX, y: item.y + deltaY })]));
  return instances.map(instance => updates.get(instance.id) ?? instance);
}

/** The edge opposite the handle stays fixed. Snap the moved edges, then clamp. */
export function resizeWidget(instance: WidgetInstance, handle: ResizeHandle, dx: number, dy: number, options?: LayoutOptions): WidgetInstance {
  if (instance.locked === true) return instance;
  const original = geometry(instance);
  let left = original.x;
  let top = original.y;
  let right = left + original.width;
  let bottom = top + original.height;
  const deltaX = finite(dx, 0);
  const deltaY = finite(dy, 0);
  if (handle.includes('w')) left = clamp(snap(left + deltaX, options), 0, right - MIN_WIDGET_WIDTH);
  if (handle.includes('e')) right = clamp(snap(right + deltaX, options), left + MIN_WIDGET_WIDTH, CANVAS_WIDTH);
  if (handle.includes('n')) top = clamp(snap(top + deltaY, options), 0, bottom - MIN_WIDGET_HEIGHT);
  if (handle.includes('s')) bottom = clamp(snap(bottom + deltaY, options), top + MIN_WIDGET_HEIGHT, CANVAS_HEIGHT);
  return applyGeometry(instance, { x: left, y: top, width: right - left, height: bottom - top });
}

/** A single widget aligns to the canvas; multiple widgets align within their bounds. */
export function alignWidgets(instances: readonly WidgetInstance[], ids: readonly string[], alignment: LayoutAlignment): WidgetInstance[] {
  const items = selected(instances, ids);
  if (!items.length) return [...instances];
  const box = items.length === 1 ? { x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT } : bounds(items);
  const updates = new Map(items.map(({ instance, box: item }) => {
    const next = { ...item };
    switch (alignment) {
      case 'left': next.x = box.x; break;
      case 'center': next.x = box.x + (box.width - item.width) / 2; break;
      case 'right': next.x = box.x + box.width - item.width; break;
      case 'top': next.y = box.y; break;
      case 'middle': next.y = box.y + (box.height - item.height) / 2; break;
      case 'bottom': next.y = box.y + box.height - item.height; break;
    }
    return [instance.id, applyGeometry(instance, next)] as const;
  }));
  return instances.map(instance => updates.get(instance.id) ?? instance);
}

/** Clamp sizes first, then positions, so the final rectangle always fits the canvas. */
export function patchWidgetGeometry(instances: readonly WidgetInstance[], id: string, patch: GeometryPatch): WidgetInstance[] {
  return instances.map(instance => instance.id === id && instance.locked !== true ? applyGeometry(instance, geometry(instance, patch)) : instance);
}
