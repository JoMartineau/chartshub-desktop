export const THEME_COLOR_TOKENS = ['primary', 'secondary', 'accent', 'text', 'mutedText', 'background', 'border', 'progress', 'glow', 'shadow'] as const;
export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];
export type ThemeColors = Record<ThemeColorToken, string>;
export interface ThemeEffects {
  glow: { enabled: boolean; blur: number };
  gradient: { enabled: boolean; from: string; to: string; angle: number };
}
export interface ThemeEffectsPatch {
  glow?: Partial<ThemeEffects['glow']>;
  gradient?: Partial<ThemeEffects['gradient']>;
}
export interface ThemeSettings { presetId: string; colors: ThemeColors; effects: ThemeEffects; }
export interface ThemePreset { id: string; name: string; theme: ThemeSettings; }
