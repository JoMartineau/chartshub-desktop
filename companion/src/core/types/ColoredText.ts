export interface ColoredTextSegment {
  text: string;
  color?: string;
}

const MAX_INPUT = 16 * 1024, MAX_TEXT = 512, MAX_SEGMENTS = 128, MAX_DEPTH = 32;
const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
// Unity's documented rich-text names, not arbitrary browser/CSS colors.
// https://docs.unity3d.com/Manual/StyledText.html
const COLORS: Readonly<Record<string, string>> = Object.freeze({
  aqua: '#00ffff', black: '#000000', blue: '#0000ff', brown: '#a52a2a', cyan: '#00ffff',
  darkblue: '#0000a0', fuchsia: '#ff00ff', green: '#008000', grey: '#808080', lightblue: '#add8e6',
  lime: '#00ff00', magenta: '#ff00ff', maroon: '#800000', navy: '#000080', olive: '#808000',
  orange: '#ffa500', purple: '#800080', red: '#ff0000', silver: '#c0c0c0', teal: '#008080',
  white: '#ffffff', yellow: '#ffff00',
});
const OTHER_TAG = /^<\/?(?:b|i|u|s|strikethrough|sub|sup|size|font|alpha|align|cspace|mspace|indent|line-height|line-indent|margin|margin-left|margin-right|mark|nobr|rotate|voffset|width|uppercase|lowercase|smallcaps|link|page|pos|space|style|sprite|quad|br)(?:\s+[^<>]*|=[^<>]*)?\s*\/?>$/i;
const whitespace = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

function color(value: string): string | undefined {
  if (/^#[0-9a-f]{3,4}$/i.test(value)) return '#' + [...value.slice(1)].map(character => character + character).join('').toLowerCase();
  return HEX.test(value) ? value.toLowerCase() : Object.hasOwn(COLORS, value.toLowerCase()) ? COLORS[value.toLowerCase()] : undefined;
}

/** Validate a bounded plain-text/color projection. Segment spaces are significant. */
export function validateColoredTextSegments(input: unknown, plainText: string): ColoredTextSegment[] | undefined {
  if (typeof plainText !== 'string' || !plainText || plainText.length > MAX_TEXT || whitespace(plainText) !== plainText || !Array.isArray(input) || !input.length || input.length > MAX_SEGMENTS) return undefined;
  const result: ColoredTextSegment[] = []; let joined = '', colored = false;
  for (const segment of input) {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return undefined;
    const entry = segment as Record<string, unknown>;
    if (Object.keys(entry).some(key => key !== 'text' && key !== 'color') || typeof entry.text !== 'string' || !entry.text || /[\u0000-\u001f\u007f]/.test(entry.text)) return undefined;
    joined += entry.text; if (joined.length > MAX_TEXT) return undefined;
    if (entry.color !== undefined && (typeof entry.color !== 'string' || !HEX.test(entry.color))) return undefined;
    const normalized = typeof entry.color === 'string' ? entry.color.toLowerCase() : undefined;
    colored ||= normalized !== undefined;
    const previous = result.at(-1);
    if (previous && previous.color === normalized) previous.text += entry.text;
    else result.push({ text: entry.text, ...(normalized ? { color: normalized } : {}) });
  }
  return colored && joined === plainText ? result : undefined;
}

/** Parse only supported Unity colors; all text is ultimately rendered as text nodes. */
export function parseColoredText(input: unknown): { text: string; segments?: ColoredTextSegment[] } {
  if (typeof input !== 'string' || !input) return { text: '' };
  const source = input.slice(0, MAX_INPUT), chunks: ColoredTextSegment[] = [], stack: Array<string | undefined> = [];
  let bounded = input.length <= MAX_INPUT, excessDepth = 0, cursor = 0;
  function append(text: string): void {
    if (!text) return;
    const current = stack.at(-1); chunks.push({ text, ...(current ? { color: current } : {}) });
  }
  function push(value: string | undefined): void {
    if (stack.length >= MAX_DEPTH || excessDepth > 0) { excessDepth++; bounded = false; }
    else stack.push(value);
  }
  for (const token of source.matchAll(/<[^<>]{0,1024}>/g)) {
    const index = token.index, markup = token[0]; append(source.slice(cursor, index)); cursor = index + markup.length;
    const opening = /^<color\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))\s*>$/i.exec(markup);
    const shorthand = /^<(#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8})>$/i.exec(markup);
    if (opening) push(color(opening[1] ?? opening[2] ?? opening[3] ?? ''));
    else if (shorthand?.[1]) push(color(shorthand[1]));
    else if (/^<\/color\s*>$/i.test(markup)) { if (excessDepth > 0) excessDepth--; else stack.pop(); }
    else if (/^<color\b/i.test(markup) || /^<#[^>]*>$/i.test(markup)) push(undefined);
    else if (!OTHER_TAG.test(markup)) append(markup);
  }
  append(source.slice(cursor));
  // An unclosed color is valid in Unity: it applies until the end of the field.
  // Normalize whitespace once across tag boundaries, preserving the color of
  // the first whitespace character when a run collapses to a single space.
  const segments: ColoredTextSegment[] = []; let text = '', pending = false, pendingColor: string | undefined;
  function emit(value: string, shade?: string): void {
    text += value; const previous = segments.at(-1);
    if (previous && previous.color === shade) previous.text += value;
    else segments.push({ text: value, ...(shade ? { color: shade } : {}) });
  }
  outer: for (const chunk of chunks) for (const character of chunk.text) {
    if (/[\s\u0000-\u001f\u007f]/u.test(character)) {
      if (!pending) { pending = true; pendingColor = chunk.color; } continue;
    }
    const gap = pending && text.length > 0;
    if (text.length + (gap ? 1 : 0) + character.length > MAX_TEXT) break outer;
    if (gap) emit(' ', pendingColor);
    pending = false; emit(character, chunk.color);
  }
  const validated = bounded ? validateColoredTextSegments(segments, text) : undefined;
  return { text, ...(validated ? { segments: validated } : {}) };
}
