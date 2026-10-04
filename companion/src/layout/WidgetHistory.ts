import type { WidgetInstance } from '../core/types/Widget.js';

function sameValue(left: unknown, right: unknown, seen = new WeakMap<object, WeakSet<object>>()): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (seen.get(left)?.has(right)) return true;
  const matched = seen.get(left) ?? new WeakSet<object>();
  matched.add(right);
  seen.set(left, matched);
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
  if (left instanceof Date || right instanceof Date) return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  // Persisted layout/theme configuration is JSON data. Treat other object types as changed.
  const prototype = Object.getPrototypeOf(left) as unknown;
  if (prototype !== Object.getPrototypeOf(right) || (!Array.isArray(left) && prototype !== Object.prototype && prototype !== null)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  const leftValues = left as Record<string, unknown>;
  const rightValues = right as Record<string, unknown>;
  return keys.every(key => Object.hasOwn(right, key) && sameValue(leftValues[key], rightValues[key], seen));
}

/** Each commit represents one complete edit across all included settings slices. */
export class SnapshotHistory<T> {
  private current: T;
  private readonly past: T[] = [];
  private readonly future: T[] = [];
  private readonly limit: number;

  constructor(initial: T, limit = 100) {
    this.current = structuredClone(initial);
    this.limit = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 100;
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  peekUndo(): T | null { return this.past.length ? structuredClone(this.past[this.past.length - 1]!) : null; }
  peekRedo(): T | null { return this.future.length ? structuredClone(this.future[this.future.length - 1]!) : null; }

  commit(next: T): boolean {
    const snapshot = structuredClone(next);
    if (sameValue(this.current, snapshot)) return false;
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = snapshot;
    this.future.length = 0;
    return true;
  }

  undo(): T | null {
    if (!this.past.length) return null;
    const previous = this.past.pop()!;
    this.future.push(this.current);
    this.current = previous;
    return structuredClone(this.current);
  }

  redo(): T | null {
    if (!this.future.length) return null;
    const next = this.future.pop()!;
    this.past.push(this.current);
    this.current = next;
    return structuredClone(this.current);
  }
}

/** Compatibility wrapper for callers that only keep widget layout history. */
export class WidgetHistory extends SnapshotHistory<WidgetInstance[]> {
  constructor(initialWidgets: readonly WidgetInstance[], limit = 100) { super([...initialWidgets], limit); }
  override commit(next: readonly WidgetInstance[]): boolean { return super.commit([...next]); }
}
