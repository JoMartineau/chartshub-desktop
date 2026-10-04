import { normalizeColor } from './normalizeColor.js';

export function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error('Unsupported theme settings.');
  return value as Record<string, unknown>;
}
export function color(value: unknown): string {
  const result = typeof value === 'string' ? normalizeColor(value) : null;
  if (result === null) throw Error('Invalid color.');
  return result;
}
export function number(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw Error('Invalid theme value.');
  return value;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw Error('Invalid theme option.');
  return value;
}
