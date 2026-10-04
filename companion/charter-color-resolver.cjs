'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createSongIniColorResolver } = require('./song-ini-colors.cjs');

const MAX_BYTES = 64 * 1024 * 1024, MAX_ROWS = 100000, MAX_FIELD = 8192, MAX_TEXT = 512;
const MAX_SOURCES = 2, MAX_VARIANTS = 16;
const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const samePath = (a, b) => path.relative(a, b) === '';
let parserTask;
function parser() { return parserTask ??= import('./dist/core/types/ColoredText.js'); }

// Index only plain metadata. The full color parser runs lazily for the matched
// charter variants, not for all 100,000 possible rows on every source poll.
function plain(value) {
  if (typeof value !== 'string' || value.length > MAX_FIELD || value.includes('\0')) return undefined;
  const text = value.replace(/<[^>\r\n]{0,256}>/g, '').replace(/\s+/g, ' ').trim().normalize('NFC');
  if (!text || text.length > MAX_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return undefined;
  return text;
}
function key(title, artist, charter) {
  const values = [title, artist, charter].map(plain);
  return values.some(value => value === undefined) ? undefined : JSON.stringify(values.map(value => value.toLowerCase()));
}

async function metadata(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || !samePath(filename, await fs.realpath(filename))) return undefined;
  return stat;
}

async function loadIndex(filename, expected) {
  let handle;
  try {
    const before = await metadata(filename);
    if (!before || version(before) !== expected) return undefined;
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (version(await handle.stat()) !== expected) return undefined;
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break; offset += result.bytesRead;
    }
    const after = await metadata(filename);
    if (offset !== before.size || !after || version(after) !== expected || version(await handle.stat()) !== expected) return undefined;
    const rows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)).replace(/^\uFEFF/, ''));
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) return undefined;
    const index = new Map(), charters = new Map();
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
      const identity = key(row.Name, row.Artist, row.Charter);
      if (identity === undefined) continue;
      if (!charters.has(row.Charter)) charters.set(row.Charter, row.Charter);
      const raw = charters.get(row.Charter), previous = index.get(identity);
      if (previous === null) continue;
      if (previous) {
        previous.raw.add(raw);
        if (previous.raw.size > MAX_VARIANTS) index.set(identity, null);
      } else index.set(identity, { raw: new Set([raw]), parsed: undefined });
    }
    return index;
  } catch { return undefined; }
  finally { await handle?.close().catch(() => {}); }
}

function createCharterColorResolver({ dataDirectory, resolveLocal = createSongIniColorResolver({ dataDirectory }) } = {}) {
  const sources = new Map(); let reading = Promise.resolve();
  async function indexFor(filename) {
    let stat;
    try { stat = await metadata(filename); } catch { sources.delete(filename); return undefined; }
    if (!stat) { sources.delete(filename); return undefined; }
    const expected = version(stat);
    let entry = sources.get(filename);
    if (entry?.version === expected) {
      sources.delete(filename); sources.set(filename, entry);
      return entry.task;
    }
    entry = { version: expected, task: null };
    sources.delete(filename); sources.set(filename, entry);
    while (sources.size > MAX_SOURCES) sources.delete(sources.keys().next().value);
    // Serial bounded reads keep simultaneous source changes from allocating
    // several large JSON buffers. Evicted requests do not start another read.
    entry.task = reading.then(() => sources.get(filename) === entry ? loadIndex(filename, expected) : undefined);
    reading = entry.task.then(() => {}, () => {});
    return entry.task;
  }
  async function resolveCharter(song, currentSongFile, options = {}) {
    try {
      if (!song || typeof song !== 'object' || typeof currentSongFile !== 'string' || currentSongFile.length > 32768 || currentSongFile.includes('\0') || !path.isAbsolute(currentSongFile)) return undefined;
      const identity = key(song.title, song.artist, song.charter), currentText = plain(song.charter);
      if (identity === undefined || currentText === undefined) return undefined;
      if (options.signal?.aborted) return undefined;
      const local = await resolveLocal(song, currentSongFile, options);
      if (options.signal?.aborted) return undefined;
      if (local?.matched || local?.ambiguous) {
        if (local.ambiguous) return undefined;
        const { validateColoredTextSegments } = await parser();
        return validateColoredTextSegments(local.segments, currentText)?.map(segment => ({ ...segment }));
      }
      const filename = path.join(path.dirname(path.resolve(currentSongFile)), 'songs.json');
      const index = await indexFor(filename), match = index?.get(identity);
      if (!match || options.signal?.aborted) return undefined;
      const { parseColoredText, validateColoredTextSegments } = await parser();
      if (!match.parsed) {
        let chosen, chosenStyle, ambiguous = false;
        for (const raw of match.raw) {
          const parsed = parseColoredText(raw);
          const segments = validateColoredTextSegments(parsed.segments, parsed.text);
          const style = JSON.stringify(segments ?? null);
          if (chosenStyle !== undefined && style !== chosenStyle) { ambiguous = true; break; }
          chosenStyle = style; chosen = { text: parsed.text, segments };
        }
        match.parsed = { ambiguous, ...chosen };
      }
      if (match.parsed.ambiguous || match.parsed.text !== currentText || !match.parsed.segments) return undefined;
      // Revalidate against the live plain text; never replace its spelling or
      // reuse the cache's title/artist as current-game metadata.
      const segments = validateColoredTextSegments(match.parsed.segments, currentText);
      return segments?.map(segment => ({ ...segment }));
    } catch { return undefined; }
  }
  return resolveCharter;
}

module.exports = { createCharterColorResolver };
