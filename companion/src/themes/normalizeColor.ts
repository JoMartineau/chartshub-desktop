const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const byte = (value: number): string => Math.round(value).toString(16).padStart(2, '0');

function numeric(value: string): number | null {
  if (!NUMBER.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function channel(value: string, max: number, requirePercent = false): number | null {
  const percent = value.endsWith('%');
  if (requirePercent && !percent) return null;
  const number = numeric(percent ? value.slice(0, -1) : value);
  if (number === null || number < 0 || number > (percent ? 100 : max)) return null;
  return percent ? number * max / 100 : number;
}

function hue(value: string): number | null {
  const match = /^(.*?)(deg|grad|rad|turn)?$/i.exec(value);
  if (!match) return null;
  const number = numeric(match[1] ?? '');
  if (number === null) return null;
  const degrees = number * ({ deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }[match[2]?.toLowerCase() ?? 'deg'] ?? 1);
  return Number.isFinite(degrees) ? ((degrees % 360) + 360) % 360 : null;
}

/** Parse supported color syntax into inert #rrggbb or #rrggbbaa, never CSS expressions. */
export function normalizeColor(value: string): string | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return '#00000000';
  if (/^#[a-f\d]{3,4}$/.test(text)) {
    const expanded = '#' + [...text.slice(1)].map(digit => digit + digit).join('');
    return expanded.length === 9 && expanded.endsWith('ff') ? expanded.slice(0, 7) : expanded;
  }
  if (/^#[a-f\d]{6}(?:[a-f\d]{2})?$/.test(text)) return text.length === 9 && text.endsWith('ff') ? text.slice(0, 7) : text;
  const match = /^(rgba?|hsla?)\(\s*([^()]*)\s*\)$/.exec(text);
  if (!match) return null;
  const body = match[2] ?? '';
  let channels: string[];
  let alphaText: string | undefined;
  if (body.includes(',')) {
    if (body.includes('/')) return null;
    const parts = body.split(',').map(part => part.trim());
    if (parts.length !== 3 && parts.length !== 4) return null;
    channels = parts.slice(0, 3);
    alphaText = parts[3];
  } else {
    const parts = body.split('/');
    if (parts.length > 2) return null;
    channels = (parts[0] ?? '').trim().split(/\s+/);
    alphaText = parts[1]?.trim();
  }
  if (channels.length !== 3) return null;
  const alpha = alphaText === undefined ? 1 : channel(alphaText, 1);
  if (alpha === null) return null;
  let rgb: number[];
  if (match[1]?.startsWith('rgb')) {
    const values = channels.map(part => channel(part, 255));
    if (values.some(part => part === null)) return null;
    rgb = values as number[];
  } else {
    const h = hue(channels[0] ?? '');
    const s = channel(channels[1] ?? '', 1, true);
    const l = channel(channels[2] ?? '', 1, true);
    if (h === null || s === null || l === null) return null;
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const second = chroma * (1 - Math.abs((h / 60) % 2 - 1));
    const offset = l - chroma / 2;
    const components = [[chroma, second, 0], [second, chroma, 0], [0, chroma, second], [0, second, chroma], [second, 0, chroma], [chroma, 0, second]][Math.floor(h / 60)];
    if (!components) return null;
    rgb = components.map(part => (part + offset) * 255);
  }
  const opacity = byte(alpha * 255);
  return '#' + rgb.map(byte).join('') + (opacity === 'ff' ? '' : opacity);
}
