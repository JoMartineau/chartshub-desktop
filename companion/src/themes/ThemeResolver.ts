import type { WidgetInstance, WidgetStyle } from '../core/types/Widget.js';
import type { ThemeColorToken, ThemeSettings } from './types.js';
import { normalizeColor } from './normalizeColor.js';
import { validateTheme } from './ThemeService.js';
import { boolean, color, number, record } from './validation.js';

export interface ResolvedWidgetStyle {
  color: string;
  useSourceColors: boolean;
  backgroundColor: string;
  borderColor: string;
  fontSize: number;
  fontWeight: number;
  glow: { enabled: boolean; color: string; blur: number };
  gradient: { enabled: boolean; from: string; to: string; angle: number };
  shadowColor?: string;
}

export function validateWidgetStyle(value: unknown): WidgetStyle {
  const style = record(value, ['colorMode', 'useSourceColors', 'color', 'fontSize', 'fontWeight', 'backgroundColor', 'borderColor', 'glow', 'gradient']);
  const result: WidgetStyle = {};
  if (style.useSourceColors !== undefined) result.useSourceColors = boolean(style.useSourceColors);
  if (style.colorMode !== undefined) {
    if (style.colorMode !== 'theme' && style.colorMode !== 'custom') throw Error('Invalid widget color mode.');
    result.colorMode = style.colorMode;
  }
  for (const key of ['color', 'backgroundColor', 'borderColor'] as const) if (style[key] !== undefined) result[key] = color(style[key]);
  if (style.fontSize !== undefined) result.fontSize = number(style.fontSize, 8, 200);
  if (style.fontWeight !== undefined) result.fontWeight = number(style.fontWeight, 100, 900);
  if (style.glow !== undefined) {
    const glow = record(style.glow, ['enabled', 'color', 'blur']);
    result.glow = { enabled: boolean(glow.enabled), color: color(glow.color), blur: number(glow.blur, 0, 40) };
  }
  if (style.gradient !== undefined) {
    const gradient = record(style.gradient, ['enabled', 'from', 'to', 'angle']);
    result.gradient = { enabled: boolean(gradient.enabled), from: color(gradient.from), to: color(gradient.to), angle: number(gradient.angle, 0, 360) };
  }
  return result;
}

const tokenByWidget = new Map<string, ThemeColorToken>([['song.title', 'text'], ['song.artist', 'primary'], ['song.charter', 'mutedText'], ['song.instrument', 'secondary'], ['song.difficulty', 'accent']]);
const safeColor = (value: unknown, fallback: string): string => typeof value === 'string' ? normalizeColor(value) ?? fallback : fallback;
const bounded = (value: unknown, fallback: number, min: number, max: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Resolve safe rendering values even for a malformed in-memory widget. Strict validation happens at storage/IPC boundaries. */
export function resolveWidgetStyle(instance: WidgetInstance, theme?: ThemeSettings): ResolvedWidgetStyle {
  let validTheme: ThemeSettings | undefined;
  if (theme !== undefined) {
    try { validTheme = validateTheme(theme); } catch { /* Invalid theme data falls back to legacy safe colors. */ }
  }
  const style = object(instance.style);
  const localColor = typeof style.color === 'string' ? normalizeColor(style.color) : null;
  const customColor = style.colorMode !== 'theme' && localColor !== null;
  const palette = validTheme?.colors;
  const themeColor = palette?.[tokenByWidget.get(instance.type) ?? 'text'] ?? '#f1f5f9';
  const resolvedColor = !validTheme ? localColor ?? '#f1f5f9' : customColor ? localColor : themeColor;
  const globalGlow = validTheme?.effects.glow;
  const globalGradient = validTheme?.effects.gradient;
  const glow = object(style.glow);
  const gradient = object(style.gradient);
  return {
    color: resolvedColor,
    useSourceColors: style.useSourceColors !== false,
    backgroundColor: safeColor(style.backgroundColor, palette?.background ?? '#00000000'),
    borderColor: safeColor(style.borderColor, palette?.border ?? '#00000000'),
    fontSize: bounded(style.fontSize, 20, 8, 200),
    fontWeight: bounded(style.fontWeight, 500, 100, 900),
    glow: {
      enabled: typeof glow.enabled === 'boolean' ? glow.enabled : globalGlow?.enabled ?? false,
      color: safeColor(glow.color, palette?.glow ?? resolvedColor),
      blur: bounded(glow.blur, globalGlow?.blur ?? 0, 0, 40),
    },
    gradient: {
      enabled: typeof gradient.enabled === 'boolean' ? gradient.enabled : !customColor && (globalGradient?.enabled ?? false),
      from: safeColor(gradient.from, globalGradient?.from ?? resolvedColor),
      to: safeColor(gradient.to, globalGradient?.to ?? resolvedColor),
      angle: bounded(gradient.angle, globalGradient?.angle ?? 90, 0, 360),
    },
    ...(palette ? { shadowColor: palette.shadow } : {}),
  };
}
