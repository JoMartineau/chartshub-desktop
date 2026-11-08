'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const ORIGIN = 'https://drive.google.com';
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const AUDIO = new Set(['.aac', '.aif', '.aiff', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);
const VIDEO = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.webm', '.wmv']);
const ASSETS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.webp', '.lrc']);
const TEXT = new Set(['notes.chart', 'song.ini']);
const ESSENTIAL_NAMES = new Set([...TEXT, 'notes.mid']);
const MAX_LISTING = 1024 * 1024;
const MAX_FOLDER_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 80;
const MAX_FOLDERS = 12;

function unavailable() {
  return Object.assign(new Error('Ce dossier Google Drive ne peut pas être téléchargé automatiquement. Ouvre-le dans le navigateur.'), { code: 'RV_ARCHIVE_DRIVE_FOLDER' });
}

function driveUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function folderId(url) {
  return /^\/(?:drive\/(?:u\/\d+\/)?)?folders\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname)?.[1];
}

function resourceKey(url) {
  const key = url.searchParams.get('resourcekey');
  if (key !== null && !TOKEN.test(key)) throw unavailable();
  return key;
}

function isRhythmVerseDriveFolder(value) {
  const url = driveUrl(value);
  if (!url || !folderId(url)) return false;
  try { resourceKey(url); return true; } catch { return false; }
}

function decodeHtml(value) {
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0' };
  return value.replace(/&(#\d+|#x[\da-f]+|amp|quot|apos|lt|gt|nbsp);/gi, (original, entity) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()];
    const hex = entity[1].toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original;
  });
}

function validName(name) {
  return name.length > 0 && name.length <= 180 && Buffer.byteLength(name) <= 255
    && !/[<>:"/\\|?*\u0000-\u001f\u007f\ufffd\ud800-\udfff\u202a-\u202e\u2066-\u2069]/u.test(name)
    && !/^[ ]|[. ]$|^(?:con(?:in\$|out\$)?|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name);
}

function parseEntries(html) {
  if (!html.includes('flip-entries')) throw unavailable();
  const blocks = html.split(/<div\s+class="flip-entry"\s+/i).slice(1);
  if (blocks.length > MAX_ENTRIES) throw unavailable();
  return blocks.map(block => {
    const entryId = /^id="entry-([A-Za-z0-9_-]{1,128})"/i.exec(block)?.[1];
    const href = /<a\s+href="([^"<>]+)"/i.exec(block)?.[1];
    const title = /<div\s+class="flip-entry-title"\s*>([^<>]*)<\/div>/i.exec(block)?.[1];
    const url = href && driveUrl(decodeHtml(href));
    if (!entryId || title === undefined || !url) throw unavailable();
    const folder = folderId(url);
    const file = /^\/file\/d\/([A-Za-z0-9_-]{1,128})(?:\/view)?\/?$/.exec(url.pathname)?.[1];
    if ((folder ?? file) !== entryId) throw unavailable();
    const key = resourceKey(url);
    const target = new URL(folder ? `/drive/folders/${folder}` : `/file/d/${file}/view`, ORIGIN);
    if (key) target.searchParams.set('resourcekey', key);
    return { id: entryId, folder: Boolean(folder), name: decodeHtml(title), url: target.href };
  });
}

async function readEntries(url, fetchImpl, signal) {
  const target = new URL('/embeddedfolderview', ORIGIN);
  target.searchParams.set('id', folderId(url));
  const key = resourceKey(url);
  if (key) target.searchParams.set('resourcekey', key);
  const response = await fetchImpl(target.href, { headers: { Accept: 'text/html' }, credentials: 'omit', redirect: 'error', signal });
  const chunks = [];
  let bytes = 0;
  try {
    if (response.status !== 200 || !response.body || Number(response.headers.get('content-length')) > MAX_LISTING) throw unavailable();
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > MAX_LISTING) throw unavailable();
      chunks.push(chunk);
    }
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
  return parseEntries(Buffer.concat(chunks, bytes).toString('utf8'));
}

function chartAssets(entries, includeVideo) {
  const assets = new Map();
  const ids = new Set();
  for (const entry of entries) {
    if (entry.folder) continue;
    const lower = entry.name.normalize('NFC').toLowerCase();
    const extension = path.extname(lower);
    if (!ESSENTIAL_NAMES.has(lower) && !AUDIO.has(extension) && !ASSETS.has(extension) && !(includeVideo && VIDEO.has(extension))) continue;
    if (!validName(entry.name) || assets.has(lower) || ids.has(entry.id)) throw unavailable();
    ids.add(entry.id);
    assets.set(lower, { ...entry, extension, allowPlainText: TEXT.has(lower) || extension === '.lrc' });
  }
  if (!assets.has('song.ini') || !(assets.has('notes.chart') || assets.has('notes.mid'))
    || ![...assets.values()].some(asset => AUDIO.has(asset.extension))) return null;
  return [...assets.values()];
}

async function findChartAssets(start, fetchImpl, signal, includeVideo) {
  const pending = [{ url: start, depth: 0 }];
  const visited = new Set();
  let selected = null;
  for (const { url, depth } of pending) {
    const id = folderId(url);
    if (visited.has(id)) continue;
    if (visited.size >= MAX_FOLDERS) throw unavailable();
    visited.add(id);
    const entries = await readEntries(url, fetchImpl, signal);
    const assets = chartAssets(entries, includeVideo);
    if (assets) {
      if (depth === 0) return assets;
      if (selected) throw unavailable();
      selected = assets;
    } else if (depth < 3) {
      for (const entry of entries) if (entry.folder) pending.push({ url: new URL(entry.url), depth: depth + 1 });
    }
  }
  if (!selected) throw unavailable();
  return selected;
}

async function downloadDriveFolder({ url, directory, signal, includeVideo = true, fetchImpl = globalThis.fetch }, downloadFile) {
  if (!isRhythmVerseDriveFolder(url) || !path.isAbsolute(directory)) throw unavailable();
  const timeout = AbortSignal.timeout(120_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const written = [];
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) || (await fs.readdir(directory)).length) throw unavailable();
    const assets = await findChartAssets(new URL(url), fetchImpl, requestSignal, includeVideo);
    let remaining = MAX_FOLDER_BYTES;
    for (const asset of assets) {
      requestSignal.throwIfAborted();
      const filename = path.join(directory, asset.name);
      const { bytes } = await downloadFile({ url: asset.url, filename, signal: requestSignal, fetchImpl,
        maxBytes: asset.allowPlainText ? Math.min(8 * 1024 * 1024, remaining) : remaining, allowPlainText: asset.allowPlainText });
      written.push(filename);
      remaining -= bytes;
    }
    return directory;
  } catch {
    await Promise.allSettled(written.map(filename => fs.rm(filename, { force: true })));
    signal?.throwIfAborted();
    throw unavailable();
  }
}

module.exports = { isRhythmVerseDriveFolder, downloadDriveFolder };
