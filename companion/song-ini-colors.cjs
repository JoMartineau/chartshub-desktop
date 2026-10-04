'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BYTES = 64 * 1024, MAX_ROOTS = 16, MAX_ENTRIES = 1000000, MAX_INIS = 100000;
const MAX_MATCHES = 32, CACHE_MS = 30 * 60 * 1000, PARSED_CACHE_SIZE = 256;
const INDEX_BYTES = 32 * 1024 * 1024;
const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const samePath = (a, b) => path.relative(a, b) === '';
const inside = (root, filename) => { const relative = path.relative(root, filename); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };
const absolute = value => typeof value === 'string' && value.length <= 32768 && !value.includes('\0') && path.isAbsolute(value);
const unsupported = () => Object.assign(Error('Unsupported metadata'), { code: 'INI_UNSUPPORTED' });
const aborted = () => Object.assign(Error('Lookup cancelled'), { code: 'ABORT_ERR' });
const check = signal => { if (signal?.aborted) throw aborted(); };
const unavailable = () => ({ matched: false, ambiguous: true });
let parserTask;
const parser = () => parserTask ??= import('./dist/core/types/ColoredText.js');

function decode(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; bytes = bytes.subarray(2); }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; bytes = bytes.subarray(2); }
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    if (text.includes('\0')) throw unsupported();
    return text;
  } catch { throw unsupported(); }
}

async function readMetadata(filename, root, signal, limit = MAX_BYTES) {
  check(signal);
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw unsupported();
  const canonical = await fs.realpath(filename);
  if (!samePath(filename, canonical) || !inside(root, canonical)) throw unsupported();
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    check(signal);
    const opened = await handle.stat();
    if (!opened.isFile() || version(opened) !== version(before)) throw Error('Metadata changed');
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {
      check(signal);
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break; offset += result.bytesRead;
    }
    const after = await handle.stat(), final = await fs.lstat(filename);
    if (offset !== before.size || version(after) !== version(before) || version(final) !== version(before) || final.isSymbolicLink() || !samePath(canonical, await fs.realpath(filename))) throw Error('Metadata changed');
    check(signal);
    return { text: decode(bytes.subarray(0, offset)), version: version(after) };
  } finally { await handle.close(); }
}

function fields(text, wanted) {
  const result = new Map(); let section = '';
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const value = line.trim(), header = /^\[([^\]]+)\]\s*$/.exec(value);
    if (header) { section = header[1].trim().toLowerCase(); continue; }
    if (section !== wanted || !value || /^[;#]/.test(value)) continue;
    const match = /^([^=]+?)\s*=\s*(.*)$/.exec(value);
    if (match) {
      const raw = match[2].trim();
      const value = raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) ? raw.slice(1, -1) : raw;
      result.set(match[1].trim().toLowerCase(), value);
    }
  }
  return result;
}

function plain(value, api) {
  if (typeof value !== 'string' || !value || value.length > 16384) return '';
  const text = api.parseColoredText(value).text.normalize('NFC');
  return /^(?:undefined|null|n\/?a)$/i.test(text) ? '' : text;
}
function identity(song, api) {
  const values = [song?.title, song?.artist, song?.charter].map(value => plain(value, api));
  return values.every(Boolean) ? JSON.stringify(values.map(value => value.toLowerCase())) : undefined;
}
function songMetadata(text, api) {
  const values = fields(text, 'song');
  const title = plain(values.get('name'), api), artist = plain(values.get('artist'), api);
  const raw = plain(values.get('charter'), api) ? values.get('charter') : values.get('frets');
  const charter = plain(raw, api), key = identity({ title, artist, charter }, api);
  if (!key) return undefined;
  const parsed = api.parseColoredText(raw);
  return { key, charter, segments: api.validateColoredTextSegments(parsed.segments, parsed.text) };
}

async function rootsFor(currentSongFile, signal) {
  const directory = path.dirname(currentSongFile);
  let settings;
  try { settings = await readMetadata(path.join(directory, 'settings.ini'), directory, signal); }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'INI_UNSUPPORTED') return []; throw error; }
  const values = fields(settings.text, 'directories'), configured = [];
  for (const [name, raw] of values) {
    if (!/^path\d+$/i.test(name)) continue;
    const value = raw.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_all, double, single) => double ?? single);
    if (!absolute(value)) continue;
    if (!configured.some(previous => samePath(previous, value))) configured.push(path.resolve(value));
    if (configured.length > MAX_ROOTS) throw Error('Too many song directories');
  }
  const roots = [];
  for (const filename of configured) {
    check(signal);
    const stat = await fs.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const canonical = await fs.realpath(filename);
    if (!samePath(filename, canonical)) continue;
    roots.push({ path: canonical, version: version(stat) });
  }
  roots.sort((a, b) => a.path.length - b.path.length);
  return roots.filter((root, index) => !roots.slice(0, index).some(parent => inside(parent.path, root.path)));
}

async function scan(roots, api, signal) {
  const index = new Map(), pending = roots.map(root => ({ root: root.path, directory: root.path, depth: 0 }));
  let entries = 0, inis = 0;
  async function visit({ root, directory, depth }) {
    check(signal);
    const before = await fs.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || !samePath(directory, await fs.realpath(directory)) || !inside(root, directory)) throw Error('Song directory changed');
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      check(signal);
      if (++entries > MAX_ENTRIES) throw Error('Too many song entries');
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 64 || filename.length > 32768) throw Error('Song directory limit');
        pending.push({ root, directory: filename, depth: depth + 1 });
      } else if (entry.isFile() && entry.name.toLowerCase() === 'song.ini') {
        if (++inis > MAX_INIS) throw Error('Too many song INIs');
        let value;
        try { value = songMetadata((await readMetadata(filename, root, signal)).text, api); }
        catch (error) { if (error?.code === 'INI_UNSUPPORTED') continue; throw error; }
        if (!value) continue;
        if (!index.has(value.key)) index.set(value.key, [filename]);
        else {
          const matches = index.get(value.key);
          if (matches && matches.length < MAX_MATCHES) matches.push(filename);
          else index.set(value.key, null);
        }
      }
    }
    const after = await fs.lstat(directory);
    if (version(before) !== version(after) || after.isSymbolicLink()) throw Error('Song directory changed');
  }
  while (pending.length) {
    check(signal);
    const results = await Promise.allSettled(pending.splice(-8).map(visit));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  return index;
}

/** Exact chart metadata only: author palettes from other charts are never reused. */
function createSongIniColorResolver({ dataDirectory } = {}) {
  const indexes = new Map(), parsed = new Map(); let scanning = Promise.resolve();
  const rejectedSavedKeys = new Set();
  const cacheFile = absolute(dataDirectory) ? path.join(dataDirectory, 'charter-ini-index.json') : null;
  async function readIndex(roots, signal) {
    if (!cacheFile || rejectedSavedKeys.has(JSON.stringify(roots))) return undefined;
    try {
      const value = JSON.parse((await readMetadata(cacheFile, dataDirectory, signal, INDEX_BYTES)).text);
      const age = Date.now() - value.createdAt;
      if (value.version !== 1 || !Number.isSafeInteger(value.createdAt) || age < 0 || age >= CACHE_MS || JSON.stringify(value.roots) !== JSON.stringify(roots) || !Array.isArray(value.entries) || value.entries.length > MAX_INIS) return undefined;
      const index = new Map(); let paths = 0;
      for (const row of value.entries) {
        check(signal);
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || row[0].length > 8192 || index.has(row[0])) return undefined;
        const identity = JSON.parse(row[0]);
        if (!Array.isArray(identity) || identity.length !== 3 || identity.some(text => typeof text !== 'string' || !text || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) || JSON.stringify(identity) !== row[0]) return undefined;
        if (row[1] === null) { index.set(row[0], null); continue; }
        if (!Array.isArray(row[1]) || !row[1].length || row[1].length > MAX_MATCHES) return undefined;
        const files = [];
        for (const item of row[1]) {
          if (!Array.isArray(item) || item.length !== 2 || !Number.isInteger(item[0]) || item[0] < 0 || item[0] >= roots.length || typeof item[1] !== 'string' || item[1].length > 32768 || /[\\:\u0000-\u001f\u007f]/.test(item[1]) || item[1].split('/').some(part => !part || part === '.' || part === '..') || path.posix.basename(item[1]).toLowerCase() !== 'song.ini') return undefined;
          const filename = path.resolve(roots[item[0]].path, ...item[1].split('/'));
          if (!inside(roots[item[0]].path, filename) || files.includes(filename) || ++paths > MAX_INIS) return undefined;
          files.push(filename);
        }
        index.set(row[0], files);
      }
      return { index, createdAt: value.createdAt };
    } catch { return undefined; }
  }
  async function writeIndex(roots, index, createdAt, signal) {
    if (!cacheFile) return;
    let temporary;
    try {
      check(signal);
      const entries = [...index].map(([key, files]) => [key, files?.map(filename => {
        const rootIndex = roots.findIndex(root => inside(root.path, filename));
        return [rootIndex, path.relative(roots[rootIndex].path, filename).split(path.sep).join('/')];
      }) ?? null]);
      const text = JSON.stringify({ version: 1, roots, createdAt, entries });
      if (Buffer.byteLength(text) > INDEX_BYTES) return;
      await fs.mkdir(dataDirectory, { recursive: true });
      const stat = await fs.lstat(dataDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(dataDirectory, await fs.realpath(dataDirectory))) return;
      temporary = cacheFile + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      check(signal);
      await fs.rename(temporary, cacheFile);
      rejectedSavedKeys.delete(JSON.stringify(roots));
    } catch { /* A rebuildable cache must never prevent showing the local metadata. */ }
    finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
  }
  function invalidate(entry) {
    if (indexes.get(entry.key) === entry) indexes.delete(entry.key);
    if (entry.index) {
      rejectedSavedKeys.add(entry.key);
      while (rejectedSavedKeys.size > 4) rejectedSavedKeys.delete(rejectedSavedKeys.values().next().value);
    }
  }
  async function indexFor(roots, api, signal) {
    const key = JSON.stringify(roots), now = Date.now(); let entry = indexes.get(key);
    if (entry && (now - entry.createdAt >= CACHE_MS || entry.signal?.aborted && !entry.index)) { indexes.delete(key); entry = null; }
    if (!entry) {
      entry = { key, createdAt: now, signal, index: null, task: null };
      indexes.set(key, entry);
      while (indexes.size > 2) indexes.delete(indexes.keys().next().value);
      const current = entry;
      entry.task = scanning.then(async () => {
        check(signal);
        const saved = await readIndex(roots, signal);
        if (saved) { current.index = saved.index; current.createdAt = saved.createdAt; return saved.index; }
        const index = await scan(roots, api, signal);
        current.index = index; current.createdAt = Date.now();
        await writeIndex(roots, index, current.createdAt, signal);
        return index;
      }).catch(error => { invalidate(current); throw error; });
      scanning = entry.task.then(() => {}, () => {});
    }
    const index = await entry.task;
    check(signal);
    return { entry, index };
  }
  return async function resolveSongIniColors(song, currentSongFile, { signal } = {}) {
    try {
      check(signal);
      if (!absolute(currentSongFile)) return { matched: false };
      const api = await parser(), key = identity(song, api), currentName = api.parseColoredText(song?.charter).text;
      if (!key || currentName !== song.charter) return { matched: false };
      const roots = await rootsFor(currentSongFile, signal);
      if (!roots.length) return { matched: false };
      const { entry, index } = await indexFor(roots, api, signal);
      if (!index.has(key)) return { matched: false };
      const paths = index.get(key);
      if (!paths) return { matched: true, ambiguous: true };
      let selected, selectedStyle;
      for (const filename of paths) {
        check(signal);
        const root = roots.find(value => inside(value.path, filename));
        let source;
        try { source = await readMetadata(filename, root.path, signal); }
        catch (error) { invalidate(entry); throw error; }
        let cached = parsed.get(filename);
        if (cached?.version !== source.version) cached = { version: source.version, value: songMetadata(source.text, api) };
        parsed.delete(filename); parsed.set(filename, cached);
        while (parsed.size > PARSED_CACHE_SIZE) parsed.delete(parsed.keys().next().value);
        const value = cached.value;
        if (!value || value.key !== key) { invalidate(entry); return unavailable(); }
        // Colors may follow case-equivalent names, but the displayed spelling
        // remains the live export. Unequal Unicode lengths cannot be projected.
        let segments;
        if (value.segments && value.charter.length === currentName.length) {
          let offset = 0;
          segments = value.segments.map(segment => { const text = currentName.slice(offset, offset + segment.text.length); offset += segment.text.length; return { text, ...(segment.color ? { color: segment.color } : {}) }; });
          segments = api.validateColoredTextSegments(segments, currentName);
        }
        const style = JSON.stringify(segments ?? null);
        if (selectedStyle !== undefined && style !== selectedStyle) return { matched: true, ambiguous: true };
        selectedStyle = style; selected = segments;
      }
      check(signal);
      return { matched: true, ...(selected ? { segments: selected.map(segment => ({ ...segment })) } : {}) };
    } catch { return unavailable(); }
  };
}

module.exports = { createSongIniColorResolver };
