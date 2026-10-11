'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { captureBundleSnapshot } = require('./chart-bundle.cjs');
const { chartTracks, midiTracks } = require('./song-request-library.cjs');

const TEXT_LIMIT = 256 * 1024, NOTES_LIMIT = 16 * 1024 * 1024, SNG_SECTION_LIMIT = 1024 * 1024, SNG_COUNT_LIMIT = 4096;
const AUDIO = /\.(?:ogg|opus|mp3|wav|flac|aiff?|m4a)$/i;
const fields = { name: 'title', title: 'title', artist: 'artist', charter: 'charter', frets: 'charter', album: 'album', year: 'year', genre: 'genre' };
const missing = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
function abort(signal) {
  if (signal?.aborted) { const error = Error('Analyse annulée.'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; throw error; }
}
function safeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>\r\n]{0,128}>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 512);
}
function portable(value) { return value.split(path.sep).join('/'); }
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function relativeValid(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 && !value.includes('\\') && !value.startsWith('/') && !value.includes(':') && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function isAudio(name) { return AUDIO.test(name) && !/^preview\./i.test(path.posix.basename(name)); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function decode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const copy = Buffer.from(bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2))); copy.swap16(); return copy.toString('utf16le');
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}
function parseText(bytes, chart) {
  const metadata = {}, lines = decode(bytes).split(/\r?\n/); let section = chart ? '' : 'song', genreConflict = false;
  for (const line of lines) {
    const trimmed = line.trim(), heading = /^\[([^\]]+)\]/.exec(trimmed);
    if (heading) { section = heading[1].trim().toLowerCase(); continue; }
    if (section !== 'song' || /^[;#]/.test(trimmed)) continue;
    const pair = /^([\w]+)\s*=\s*(.*)$/.exec(trimmed); if (!pair) continue;
    const key = pair[1].toLowerCase(), field = Object.hasOwn(fields, key) ? fields[key] : null;
    if (!field) continue;
    let value = pair[2].trim();
    if (value.startsWith('"')) { const quoted = /^"((?:\\.|[^"\\])*)"/.exec(value); if (quoted) value = quoted[1].replace(/\\(["\\])/g, '$1'); }
    if (field === 'year') value = value.replace(/^,\s*/, '');
    const text = safeText(value);
    if (field === 'genre' && text && metadata.genre && metadata.genre !== text) { genreConflict = true; metadata.genre = ''; }
    if (text && (key !== 'frets' || !metadata.charter) && !(field === 'genre' && genreConflict)) metadata[field] = text;
  }
  return metadata;
}

/** Metadata/index only. SNG v1: https://github.com/mdsitton/SngFileFormat */
async function readSng(handle, size, signal) {
  async function read(position, length) {
    abort(signal);
    if (!Number.isSafeInteger(position) || position < 0 || length < 0 || position + length > size) throw Error('Invalid SNG range');
    const bytes = Buffer.alloc(length); let offset = 0;
    while (offset < length) {
      const part = await handle.read(bytes, offset, length - offset, position + offset); abort(signal);
      if (!part.bytesRead) throw Error('Truncated SNG'); offset += part.bytesRead;
    }
    return bytes;
  }
  function uint64(bytes, offset, maximum = Number.MAX_SAFE_INTEGER) {
    if (offset < 0 || offset + 8 > bytes.length) throw Error('Invalid SNG integer');
    const value = bytes.readBigUInt64LE(offset);
    if (value > BigInt(maximum)) throw Error('Unsupported SNG length'); return Number(value);
  }
  async function section(position) {
    const length = uint64(await read(position, 8), 0, SNG_SECTION_LIMIT);
    if (length < 8) throw Error('Invalid SNG section');
    const bytes = await read(position + 8, length), count = uint64(bytes, 0, SNG_COUNT_LIMIT);
    return { bytes, count, next: position + 8 + length };
  }
  const header = await read(0, 26);
  if (header.subarray(0, 6).toString('ascii') !== 'SNGPKG' || header.readUInt32LE(6) !== 1) throw Error('Unsupported SNG header');
  const meta = await section(26), metadata = {}; let cursor = 8;
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  function readString(bytes, maxLength) {
    if (cursor + 4 > bytes.length) throw Error('Truncated SNG string');
    const length = bytes.readInt32LE(cursor); cursor += 4;
    if (length < 0 || length > maxLength || cursor + length > bytes.length) throw Error('Invalid SNG string');
    const value = utf8.decode(bytes.subarray(cursor, cursor + length)); cursor += length;
    if (value.includes('\0')) throw Error('Invalid SNG text'); return value;
  }
  for (let index = 0; index < meta.count; index++) {
    abort(signal); const key = readString(meta.bytes, 4096).toLowerCase(), value = readString(meta.bytes, TEXT_LIMIT);
    if (Object.hasOwn(fields, key)) { const field = fields[key], text = safeText(value); if (text && (key !== 'frets' || !metadata.charter)) metadata[field] = text; }
  }
  if (cursor !== meta.bytes.length) throw Error('Invalid SNG metadata length');
  const files = await section(meta.next), ranges = []; cursor = 8; let audio = false;
  for (let index = 0; index < files.count; index++) {
    abort(signal);
    if (cursor >= files.bytes.length) throw Error('Truncated SNG file name');
    const length = files.bytes[cursor++];
    if (!length || cursor + length + 16 > files.bytes.length) throw Error('Invalid SNG file index');
    const name = utf8.decode(files.bytes.subarray(cursor, cursor + length)); cursor += length;
    if (!relativeValid(name) || /[\u0000-\u001f\u007f]/.test(name)) throw Error('Invalid SNG file path');
    const bytes = uint64(files.bytes, cursor), position = uint64(files.bytes, cursor + 8); cursor += 16;
    ranges.push({ position, bytes }); audio ||= isAudio(name);
  }
  if (cursor !== files.bytes.length) throw Error('Invalid SNG index length');
  const dataLength = uint64(await read(files.next, 8), 0), start = files.next + 8;
  if (start + dataLength > size) throw Error('Truncated SNG data section');
  for (const range of ranges) if (range.position < start || range.position + range.bytes > start + dataLength || !Number.isSafeInteger(range.position + range.bytes)) throw Error('Invalid SNG file offset');
  return { metadata, audio: audio ? 'present' : 'missing' };
}

/** Scan without following links or reading audio. Results are committed only by the caller. */
async function scanLibrary({ rootPath, previousItems = [], mode = 'full', signal, onProgress } = {}) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || !['full', 'quick'].includes(mode)) throw Error('Configuration de bibliothèque invalide.');
  abort(signal);
  const root = path.resolve(rootPath), canonicalRoot = await fs.realpath(root), rootStat = await fs.lstat(root);
  if (path.relative(root, canonicalRoot) !== '' || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('Le dossier de bibliothèque est indisponible.');
  const previous = new Map();
  for (const item of Array.isArray(previousItems) ? previousItems : []) if (item && relativeValid(item.relativePath)) previous.set(item.relativePath, item);
  const result = new Map(), preserved = new Set(); let visited = 0, processed = 0, warningCount = 0, skippedCount = 0, lastProgress = 0, ticks = 0;
  function progress(force = false) {
    if (!force && Date.now() - lastProgress < 100) return;
    lastProgress = Date.now(); try { onProgress?.({ visited, processed, discovered: result.size }); } catch { /* Progress is observational. */ }
  }
  async function checkpoint() {
    abort(signal); progress();
    if (++ticks % 32 === 0) { await new Promise(resolve => setImmediate(resolve)); abort(signal); }
  }
  function preserve(prefix) { preserved.add(prefix); warningCount++; }
  function hasPreservedPrefix(relativePath) {
    if (preserved.has('')) return true;
    let candidate = relativePath;
    while (candidate) { if (preserved.has(candidate)) return true; const separator = candidate.lastIndexOf('/'); if (separator < 0) break; candidate = candidate.slice(0, separator); }
    return false;
  }
  function add(item) { result.set(item.relativePath, item); }
  async function inspect(filename) {
    const stat = await fs.lstat(filename); abort(signal);
    if (stat.isSymbolicLink()) return null;
    const actual = await fs.realpath(filename); abort(signal);
    return isWithin(root, actual) && path.relative(filename, actual) === '' ? stat : null;
  }
  async function openChecked(filename, expected) {
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const current = await handle.stat(), actual = await fs.realpath(filename); abort(signal);
      if (!current.isFile() || !isWithin(root, actual) || path.relative(filename, actual) !== '' || current.ino !== expected.ino || current.dev !== expected.dev) { const error = Error('Library entry changed'); error.code = 'ESTALE'; throw error; }
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async function readText(entry, maximum = TEXT_LIMIT) {
    const handle = await openChecked(entry.filename, entry.stat);
    try {
      const bytes = Buffer.alloc(Math.min(maximum, entry.stat.size)); let offset = 0;
      while (offset < bytes.length) { const part = await handle.read(bytes, offset, bytes.length - offset, offset); abort(signal); if (!part.bytesRead) break; offset += part.bytesRead; }
      return bytes.subarray(0, offset);
    } finally { await handle.close(); }
  }
  function signature(entries) {
    return digest('library-v1\n' + entries.map(entry => `${entry.name}\0${entry.stat.size}\0${entry.stat.mtimeMs}`).sort().join('\n'));
  }
  function itemFor(entry, folder, format, fingerprint, metadata, audio, tracks) {
    const relativePath = portable(path.relative(root, entry.filename));
    return {
      id: digest(relativePath), relativePath, title: metadata.title || safeText(format === 'sng' ? path.basename(entry.name, path.extname(entry.name)) : path.basename(folder)),
      artist: metadata.artist || '', charter: metadata.charter || '', album: metadata.album || '', year: metadata.year || '', format, audio,
      signature: fingerprint, folderRelativePath: portable(path.relative(root, folder)), musicMetadataVersion: 1,
      ...(metadata.genre ? { genre: metadata.genre } : {}), ...(tracks ? { tracks } : {})
    };
  }
  async function scanSong(entry, folder, files, format) {
    abort(signal); processed++;
    const relevant = format === 'sng' ? [entry] : files.filter(file => /^(?:song\.ini|notes\.(?:chart|mid))$/i.test(file.name) || isAudio(file.name));
    const fingerprint = signature(relevant), relativePath = portable(path.relative(root, entry.filename)), old = previous.get(relativePath);
    if (old && hasPreservedPrefix(relativePath)) { add({ ...old }); return; }
    const snapshotOptions = { rootPath: root, relativePath, format, signal };
    const cleanupSnapshot = await captureBundleSnapshot(snapshotOptions); abort(signal);
    if (mode === 'quick' && old?.musicMetadataVersion === 1 && old.signature === fingerprint && old.cleanupSnapshot === cleanupSnapshot) { if (old.audio === 'unknown') warningCount++; add({ ...old, id: digest(relativePath), relativePath, folderRelativePath: portable(path.relative(root, folder)) }); return; }
    let metadata = {}, tracks, audio = format === 'sng' ? 'unknown' : files.some(file => isAudio(file.name)) ? 'present' : 'missing';
    try {
      if (format === 'sng') {
        const handle = await openChecked(entry.filename, entry.stat);
        try { ({ metadata, audio } = await readSng(handle, entry.stat.size, signal)); } finally { await handle.close(); }
      } else {
        const bytes = format === 'chart' ? await readText(entry, entry.stat.size <= NOTES_LIMIT ? NOTES_LIMIT : TEXT_LIMIT)
          : entry.stat.size >= 14 && entry.stat.size <= NOTES_LIMIT ? await readText(entry, NOTES_LIMIT) : null;
        if (format === 'chart') metadata = parseText(bytes.subarray(0, TEXT_LIMIT), true);
        if (bytes && entry.stat.size <= NOTES_LIMIT) {
          try {
            const parsed = format === 'chart' ? chartTracks(bytes) : midiTracks(bytes);
            tracks = [...new Map(parsed.map(track => [JSON.stringify([track.instrument, track.difficulty]), track])).values()];
          }
          catch { warningCount++; }
        } else if (entry.stat.size > NOTES_LIMIT) warningCount++;
        const ini = files.find(file => /^song\.ini$/i.test(file.name));
        if (ini) { if (ini.stat.size > TEXT_LIMIT) warningCount++; metadata = { ...metadata, ...parseText(await readText(ini), false) }; }
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      warningCount++;
      if (old && error?.code && !missing(error)) { add({ ...old }); preserved.add(format === 'sng' ? relativePath : portable(path.relative(root, folder))); return; }
      if (missing(error)) { skippedCount++; return; }
    }
    // Metadata reads cannot silently advance the cleanup baseline when files
    // changed during this song's scan. A fresh scan is required in that case.
    const finalSnapshot = cleanupSnapshot && await captureBundleSnapshot(snapshotOptions); abort(signal);
    add({ ...itemFor(entry, folder, format, fingerprint, metadata, audio, tracks), cleanupSnapshot: cleanupSnapshot === finalSnapshot ? cleanupSnapshot : null });
  }

  progress(true); abort(signal);
  const pending = [root];
  while (pending.length) {
    await checkpoint(); const folder = pending.pop(), prefix = portable(path.relative(root, folder));
    const files = [], children = []; let directory;
    try {
      const stat = await inspect(folder);
      if (!stat?.isDirectory()) { if (folder === root) throw Error('Library root changed'); skippedCount++; continue; }
      const publishing = async () => fs.lstat(path.join(folder, '.chartshub-companion-installing')).then(() => true, error => { if (missing(error)) return false; throw error; });
      if (await publishing()) continue;
      directory = await fs.opendir(folder);
      for await (const entry of directory) {
        visited++; await checkpoint();
        const filename = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) { skippedCount++; continue; }
        // Download staging can contain notes before the other files are complete.
        if (entry.isDirectory() && /^\.chartshub-companion-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(entry.name)) continue;
        try {
          const entryStat = await inspect(filename);
          if (!entryStat) { skippedCount++; continue; }
          if (entryStat.isDirectory()) children.push(filename);
          else if (entryStat.isFile() && (/^(?:song\.ini|notes\.(?:chart|mid))$/i.test(entry.name) || /\.sng$/i.test(entry.name) || isAudio(entry.name))) files.push({ name: entry.name, filename, stat: entryStat });
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          if (missing(error)) skippedCount++; else preserve(entry.isDirectory() ? portable(path.relative(root, filename)) : prefix);
        }
      }
      if (await publishing()) continue;
    } catch (error) {
      if (error?.name === 'AbortError' || folder === root) throw error;
      if (missing(error)) skippedCount++; else preserve(prefix);
      continue;
    }
    files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const chart = files.find(entry => /^notes\.chart$/i.test(entry.name)), midi = files.find(entry => /^notes\.mid$/i.test(entry.name));
    if (chart || midi) { await scanSong(chart || midi, folder, files, chart ? 'chart' : 'midi'); await checkpoint(); }
    for (const entry of files) if (/\.sng$/i.test(entry.name)) { await scanSong(entry, folder, files, 'sng'); await checkpoint(); }
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  for (const old of previous.values()) {
    await checkpoint();
    if (!result.has(old.relativePath) && hasPreservedPrefix(old.relativePath)) add({ ...old });
  }
  abort(signal); progress(true); abort(signal);
  const finalRoot = await fs.realpath(root), finalStat = await fs.lstat(root); abort(signal);
  if (path.relative(root, finalRoot) !== '' || !finalStat.isDirectory() || finalStat.isSymbolicLink() || finalStat.ino !== rootStat.ino || finalStat.dev !== rootStat.dev) throw Error('Le dossier de bibliothèque a changé pendant l’analyse.');
  return { items: [...result.values()].sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0), warningCount, skippedCount, preservedPrefixes: [...preserved].sort() };
}

// Only individual metadata reads are bounded; library size has no fixed quota.
module.exports = { scanLibrary, SCANNER_LIMITS: Object.freeze({ metadataBytes: TEXT_LIMIT, notesBytes: NOTES_LIMIT, sngSectionBytes: SNG_SECTION_LIMIT }) };
