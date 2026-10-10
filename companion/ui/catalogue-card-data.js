// Same bounded name/color contract as ChartsHub chart-text.js. The profile
// accent color is intentionally unrelated to a chart's song.ini charter name.
export function safeCharterColor(value) {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const color = value.trim().replace(/^["']|["']$/g, '').toLowerCase();
  return /^(?:#[a-f0-9]{3}|#[a-f0-9]{4}|#[a-f0-9]{6}|#[a-f0-9]{8}|red|green|blue|yellow|white|black|orange|purple|violet|cyan|magenta|grey|gray|lime|pink|silver|gold|teal|navy|maroon|olive|aqua|fuchsia)$/.test(color) ? color : undefined;
}
export function charterSegments(text, input) {
  if (typeof text !== 'string' || text.length > 512 || !Array.isArray(input) || !input.length || input.length > 150) return undefined;
  if (!input.every(part => part && typeof part.text === 'string' && part.text.length <= 512 && !/[\u0000-\u001f\u007f]/.test(part.text)) || input.map(part => part.text).join('') !== text) return undefined;
  const segments = input.map(part => ({ text: part.text, ...(safeCharterColor(part.color) ? { color: safeCharterColor(part.color) } : {}) }));
  return segments.some(part => part.color) ? segments : undefined;
}
// Legacy/imported snapshots may still contain the original Unity color tags.
export function parseCharter(value) {
  const source = typeof value === 'string' ? value.slice(0, 4096) : '', segments = [], stack = [];
  let position = 0, length = 0;
  const add = value => {
    const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 150 - length); if (!text) return;
    length += text.length; const color = stack.at(-1), last = segments.at(-1);
    if (last && last.color === color) last.text += text; else segments.push({ text, ...(color ? { color } : {}) });
  };
  for (const match of source.matchAll(/<[^>]*>/g)) {
    add(source.slice(position, match.index)); position = match.index + match[0].length;
    const opening = match[0].match(/^<color\s*=\s*([^<>]+)>$/i);
    if (opening) stack.push(safeCharterColor(opening[1])); else if (/^<\/color\s*>$/i.test(match[0])) stack.pop();
  }
  add(source.slice(position));
  if (segments.length) { segments[0].text = segments[0].text.trimStart(); segments.at(-1).text = segments.at(-1).text.trimEnd(); }
  const parts = segments.filter(part => part.text), text = parts.map(part => part.text).join('');
  return { text, segments: charterSegments(text, parts) };
}
export const instrumentNames = Object.freeze({ Guitar: 'Guitare', Bass: 'Basse', Drums: 'Batterie', Vocals: 'Chant', Keys: 'Clavier', 'Guitar Co-op': 'Guitare coop', Rhythm: 'Guitare rythmique', 'Guitar 6-fret': 'Guitare 6 frettes', 'Guitar Co-op 6-fret': 'Guitare coop 6 frettes', 'Rhythm 6-fret': 'Rythmique 6 frettes', 'Bass 6-fret': 'Basse 6 frettes', 'Pro Drums': 'Batterie pro' });
export const difficultyNames = Object.freeze({ Easy: 'Facile', Medium: 'Moyen', Hard: 'Difficile', Expert: 'Expert' });
// Static paths from the main catalogue; no remote SVG/markup is accepted.
export const instrumentPaths = Object.freeze({ Guitar: 'M15 3l6 6m-5-5-6 6m2-1 3 3-2 2c1 4-2 7-5 7-4 0-7-3-5-7 1-2 3-3 5-2l2-2m6-5 3 3', Bass: 'M17 2l4 4m-3-3-8 9m3-2 2 2-3 3c1 3-1 6-4 6-4 0-6-3-5-6 1-3 3-4 6-3', Drums: 'M4 10c0-3 16-3 16 0s-16 3-16 0m0 0v8c0 3 16 3 16 0v-8M6 3l10 5M18 2l-5 6M7 12v8m10-8v8', Vocals: 'M9 4a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V4m-3 6v1a6 6 0 0 0 12 0v-1m-6 7v5m-4 0h8', Keys: 'M3 4h18v16H3V4m6 0v16m6-16v16M7 4v8m6-8v8m6-8v8' });
