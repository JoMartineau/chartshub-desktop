// Main panel decoration only. This module is never imported by an overlay,
// floating game window, player, widget renderer or stream document.
const keys = ['accent', 'secondary', 'background', 'surface', 'surfaceAlt', 'text', 'muted', 'border', 'bloom'];
const variables = { accent: '--accent', secondary: '--accent-violet', background: '--background', surface: '--surface', surfaceAlt: '--surface-raised', text: '--text', muted: '--muted', border: '--border' };
let palette = null, follow = true;
export function normalizePalette(value) {
  if (!value || !['dark', 'light'].includes(value.mode) || !['season', 'custom'].includes(value.paletteMode)
    || !value.colors || !keys.every(key => typeof value.colors[key] === 'string' && /^#[a-f\d]{6}$/i.test(value.colors[key]))) return null;
  return { mode: value.mode, paletteMode: value.paletteMode, colors: Object.fromEntries(keys.map(key => [key, value.colors[key].toLowerCase()])) };
}
export function foreground(value) {
  const c = value.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  const luminance = c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000000' : '#ffffff';
}
export function paintCataloguePalette(value = follow) {
  follow = value === true;
  const root = document.documentElement, colors = follow && palette ? palette.colors : null;
  for (const [key, variable] of Object.entries(variables)) {
    if (colors) root.style.setProperty(variable, colors[key]); else root.style.removeProperty(variable);
  }
  if (colors) {
    root.dataset.chCataloguePalette = palette.paletteMode;
    root.style.colorScheme = palette.mode;
    root.style.setProperty('--accent-hover', colors.secondary);
    root.style.setProperty('--accent-soft', `color-mix(in srgb, ${colors.accent} 16%, ${colors.surface})`);
    root.style.setProperty('--ch-button-ink', foreground(colors.accent));
    root.style.setProperty('--ch-button-hover-ink', foreground(colors.secondary));
  } else {
    delete root.dataset.chCataloguePalette;
    root.style.removeProperty('color-scheme');
    for (const key of ['--accent-hover', '--accent-soft', '--ch-button-ink', '--ch-button-hover-ink']) root.style.removeProperty(key);
  }
  return colors;
}
export function setCataloguePalette(value) {
  const next = normalizePalette(value);
  if (!next || JSON.stringify(next) === JSON.stringify(palette)) return;
  palette = next;
  paintCataloguePalette();
  window.dispatchEvent(new Event('chartshub:cataloguepalettechange'));
}
