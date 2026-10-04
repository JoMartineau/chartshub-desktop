import { themePresets } from './ThemePresets.js';
import { THEME_COLOR_TOKENS, type ThemeColorToken, type ThemeColors, type ThemeEffectsPatch, type ThemeSettings } from './types.js';
import { boolean, color, number, record } from './validation.js';

export function validateTheme(value: unknown): ThemeSettings {
  const theme = record(value, ['presetId', 'colors', 'effects']);
  if (typeof theme.presetId !== 'string' || !themePresets.some(preset => preset.id === theme.presetId)) throw Error('Unknown theme preset.');
  const palette = record(theme.colors, THEME_COLOR_TOKENS);
  const colors = Object.fromEntries(THEME_COLOR_TOKENS.map(token => [token, color(palette[token])])) as ThemeColors;
  const effects = record(theme.effects, ['glow', 'gradient']);
  const glow = record(effects.glow, ['enabled', 'blur']);
  const gradient = record(effects.gradient, ['enabled', 'from', 'to', 'angle']);
  return {
    presetId: theme.presetId,
    colors,
    effects: {
      glow: { enabled: boolean(glow.enabled), blur: number(glow.blur, 0, 40) },
      gradient: { enabled: boolean(gradient.enabled), from: color(gradient.from), to: color(gradient.to), angle: number(gradient.angle, 0, 360) },
    },
  };
}

export function createDefaultTheme(): ThemeSettings {
  return new ThemeService().applyPreset('chartshub');
}

/** Value-in/value-out operations. Persistence, subscriptions and IPC belong to the host. */
export class ThemeService {
  applyPreset(id: string): ThemeSettings {
    const preset = themePresets.find(candidate => candidate.id === id);
    if (!preset) throw Error('Unknown theme preset.');
    return structuredClone(preset.theme);
  }

  setColor(theme: ThemeSettings, token: ThemeColorToken, value: string): ThemeSettings {
    if (!THEME_COLOR_TOKENS.includes(token)) throw Error('Unknown theme color.');
    const next = validateTheme(theme);
    next.colors[token] = color(value);
    return next;
  }

  setEffects(theme: ThemeSettings, patch: ThemeEffectsPatch): ThemeSettings {
    const effects = record(patch, ['glow', 'gradient']);
    const next = validateTheme(theme);
    if (effects.glow !== undefined) next.effects.glow = { ...next.effects.glow, ...record(effects.glow, ['enabled', 'blur']) } as ThemeSettings['effects']['glow'];
    if (effects.gradient !== undefined) next.effects.gradient = { ...next.effects.gradient, ...record(effects.gradient, ['enabled', 'from', 'to', 'angle']) } as ThemeSettings['effects']['gradient'];
    return validateTheme(next);
  }
}
