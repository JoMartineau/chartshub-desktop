'use strict';
// Appearance only. No CSS, URLs, paths, widget settings or arbitrary properties
// cross this boundary from the remote Catalogue into local Companion pages.
const COLOR_KEYS = Object.freeze(['accent', 'secondary', 'background', 'surface', 'surfaceAlt', 'text', 'muted', 'border', 'bloom']);
function validateUIPalette(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || !Object.keys(value).every(key => ['mode', 'paletteMode', 'colors'].includes(key))
    || !['dark', 'light'].includes(value.mode) || !['season', 'custom'].includes(value.paletteMode)) return null;
  const colors = value.colors;
  if (!colors || typeof colors !== 'object' || Array.isArray(colors) || Object.keys(colors).length !== COLOR_KEYS.length
    || !COLOR_KEYS.every(key => Object.hasOwn(colors, key) && typeof colors[key] === 'string' && /^#[a-f\d]{6}$/i.test(colors[key]))) return null;
  return { mode: value.mode, paletteMode: value.paletteMode, colors: Object.fromEntries(COLOR_KEYS.map(key => [key, colors[key].toLowerCase()])) };
}
function createUIPaletteIpc({ ipcMain, allowedSender, onPalette }) {
  const channel = 'chartshub:ui-palette';
  ipcMain.handle(channel, (event, value) => {
    if (!allowedSender(event)) return null;
    const palette = validateUIPalette(value);
    return palette ? onPalette(palette) : null;
  });
  return { dispose: () => ipcMain.removeHandler(channel) };
}
module.exports = { COLOR_KEYS, validateUIPalette, createUIPaletteIpc };
