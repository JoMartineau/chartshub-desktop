import type { ThemeColors, ThemePreset, ThemeSettings } from './types.js';

function preset(id: string, name: string, colors: ThemeColors, glow = false, gradient = false, blur = 12): ThemePreset {
  const theme: ThemeSettings = {
    presetId: id,
    colors,
    effects: {
      glow: { enabled: glow, blur },
      gradient: { enabled: gradient, from: colors.primary, to: colors.accent, angle: 90 },
    },
  };
  Object.freeze(theme.colors);
  Object.freeze(theme.effects.glow);
  Object.freeze(theme.effects.gradient);
  Object.freeze(theme.effects);
  Object.freeze(theme);
  return Object.freeze({ id, name, theme });
}

export const themePresets: readonly ThemePreset[] = Object.freeze([
  preset('chartshub', 'ChartsHub', { primary: '#e0e7ff', secondary: '#c4b5fd', accent: '#c4b5fd', text: '#ffffff', mutedText: '#aebbd0', background: '#00000000', border: '#00000000', progress: '#8b5cf6', glow: '#a78bfa', shadow: '#000000e6' }),
  preset('dark', 'Dark', { primary: '#93c5fd', secondary: '#c4b5fd', accent: '#38bdf8', text: '#f8fafc', mutedText: '#94a3b8', background: '#111827e6', border: '#334155', progress: '#60a5fa', glow: '#60a5fa', shadow: '#000000cc' }),
  preset('light', 'Light', { primary: '#1d4ed8', secondary: '#6d28d9', accent: '#be185d', text: '#111827', mutedText: '#475569', background: '#f8fafcf2', border: '#cbd5e1', progress: '#2563eb', glow: '#60a5fa', shadow: '#00000000' }),
  preset('neon', 'Neon', { primary: '#00f5ff', secondary: '#d0ff00', accent: '#ff4fd8', text: '#ffffff', mutedText: '#cbd5ff', background: '#080b18cc', border: '#00f5ff80', progress: '#00f5ff', glow: '#00f5ff', shadow: '#000000cc' }, true, true, 18),
  preset('cyberpunk', 'Cyberpunk', { primary: '#ffe600', secondary: '#00e5ff', accent: '#ff2ea6', text: '#fffbe6', mutedText: '#e9d5ff', background: '#190b25e6', border: '#ff2ea699', progress: '#ffe600', glow: '#ff2ea6', shadow: '#090014e6' }, true, true, 10),
  preset('retro', 'Retro', { primary: '#ffb86b', secondary: '#81c784', accent: '#f4d35e', text: '#fff1cf', mutedText: '#cfb997', background: '#30251fe6', border: '#9e7650', progress: '#f4d35e', glow: '#ffb86b', shadow: '#1b120dcc' }),
  preset('transparent', 'Transparent', { primary: '#dbeafe', secondary: '#ddd6fe', accent: '#a7f3d0', text: '#ffffff', mutedText: '#cbd5e1', background: '#00000000', border: '#00000000', progress: '#93c5fd', glow: '#ffffff', shadow: '#000000e6' }),
  preset('high-contrast', 'High Contrast', { primary: '#ffff00', secondary: '#00ffff', accent: '#ffff00', text: '#ffffff', mutedText: '#ffffff', background: '#000000', border: '#ffffff', progress: '#ffff00', glow: '#ffffff', shadow: '#00000000' }),
]);
