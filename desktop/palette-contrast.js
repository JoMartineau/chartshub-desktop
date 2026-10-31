'use strict';
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChartshubPaletteContrast = Object.freeze(api);
})(globalThis, function() {
  const rgb = hex => hex.slice(1).match(/../g).map(v => parseInt(v, 16));
  const luminance = values => values.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const blend = (a, b, amount) => a.map((v, i) => Math.round(v * (1 - amount) + b[i] * amount));
  const hex = values => '#' + values.map(v => v.toString(16).padStart(2, '0')).join('');
  function readableAccent(accent, surface, secondary) {
    if (![accent, surface, secondary].every(v => typeof v === 'string' && /^#[a-f\d]{6}$/i.test(v))) return '#ffffff';
    const color = rgb(accent), background = rgb(surface);
    const mix = (a, b, amount) => a.map((v, i) => v * (1 - amount) + b[i] * amount);
    const regions = [background, mix(background, color, .10), mix(background, rgb(secondary), .08)];
    // Component bounds cover every point of the selected tab gradient and its
    // surrounding navigation, including the inset keyboard focus outline.
    const low = luminance([0, 1, 2].map(i => Math.min(...regions.map(c => c[i]))));
    const high = luminance([0, 1, 2].map(i => Math.max(...regions.map(c => c[i]))));
    const contrast = candidate => { const ink = luminance(candidate); return ink < low ? (low + .05) / (ink + .05) : ink > high ? (ink + .05) / (high + .05) : 1; };
    if (contrast(color) >= 4.5) return accent.toLowerCase();
    for (let step = 1; step <= 100; step++) {
      const light = blend(color, [255, 255, 255], step / 100), dark = blend(color, [0, 0, 0], step / 100);
      if (contrast(light) >= 4.5 || contrast(dark) >= 4.5) return hex(contrast(light) >= contrast(dark) ? light : dark);
    }
    return contrast([255, 255, 255]) >= contrast([0, 0, 0]) ? '#ffffff' : '#000000';
  }
  return { readableAccent };
});
