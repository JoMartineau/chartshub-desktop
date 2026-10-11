'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { captureBundleSnapshot } = require('./chart-bundle.cjs');

const CHUNK_BYTES = 64 * 1024, ARTWORK_LIMIT = 8 * 1024 * 1024, VIDEO_LIMIT = 4 * 1024 * 1024 * 1024;
// Clone Hero Wiki links this specification for the reserved audio stem names:
// https://thenathannator.github.io/GuitarGame_ChartFormats/Chart-File-Formats/Supported-Audio-Files/
const ROLES = ['song', 'guitar', 'rhythm', 'bass', 'keys', 'drums', 'drums_1', 'drums_2', 'drums_3', 'drums_4',
  'vocals', 'vocals_1', 'vocals_2', 'vocals_explicit', 'vocals_explicit_1', 'vocals_explicit_2', 'crowd'];
const AUDIO = { '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4' };
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const VIDEOS = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime' };
const ID_FIELDS = ['dev', 'ino'], FILE_FIELDS = [...ID_FIELDS, 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode'];
const failure = (message = 'Les fichiers de cette chanson sont indisponibles ou ont changé. Actualisez la bibliothèque.') => Object.assign(Error(message), { code: 'LIBRARY_MEDIA_SAFE' });
const unsupported = message => Object.assign(Error(message), { code: 'LIBRARY_MEDIA_UNSUPPORTED' });
const hash = value => createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => path.relative(a, b) === '';
const relativeValid = value => typeof value === 'string' && value.length > 0 && value.length <= 32768
  && !path.isAbsolute(value) && !/[\\<>:"|?*\u0000-\u001f\u007f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
const describe = (stat, full) => Object.fromEntries((full ? FILE_FIELDS : ID_FIELDS).map(key => [key, String(stat[key])]));
const matches = (stat, expected, full) => !!expected && (full ? FILE_FIELDS : ID_FIELDS).every(key => String(stat[key]) === expected[key]);

async function inspect(root, relative, previous) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !relativeValid(relative)) throw failure();
  const names = [root];
  for (const part of relative.split('/')) names.push(path.join(names.at(-1), part));
  if (previous && (!Array.isArray(previous.ancestors) || previous.ancestors.length !== names.length - 1)) throw failure();
  const entries = [];
  for (const [index, filename] of names.entries()) {
    const stat = await fs.lstat(filename, { bigint: true }), last = index === names.length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())
      || !samePath(filename, await fs.realpath(filename))) throw failure();
    // The song folder's full identity also detects an added/removed file. Higher
    // ancestors use inode identity so other songs do not invalidate this media.
    const full = last || index === names.length - 2;
    if (previous && !matches(stat, last ? previous.file : previous.ancestors[index], full)) throw failure();
    entries.push(describe(stat, full));
  }
  return { ancestors: entries.slice(0, -1), file: entries.at(-1) };
}
async function openChecked(entry) {
  await inspect(entry.rootPath, entry.relativePath, entry.identity);
  let handle;
  try {
    handle = await fs.open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !matches(stat, entry.identity.file, true)) throw failure();
    await inspect(entry.rootPath, entry.relativePath, entry.identity);
    return handle;
  } catch (error) { await handle?.close().catch(() => {}); throw error; }
}
async function readPrefix(entry, maximum) {
  const handle = await openChecked(entry);
  try {
    const bytes = Buffer.alloc(Math.min(entry.size, maximum)); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw failure();
      offset += bytesRead;
    }
    if (!matches(await handle.stat({ bigint: true }), entry.identity.file, true)) throw failure();
    await inspect(entry.rootPath, entry.relativePath, entry.identity);
    return bytes;
  } finally { await handle.close(); }
}
function artworkMatches(bytes, contentType) {
  if (contentType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return contentType === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}
function videoMatches(bytes, contentType) {
  if (contentType === 'video/webm') return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  return ['video/mp4', 'video/quicktime'].includes(contentType) && bytes.length >= 12
    && bytes.toString('ascii', 4, 8) === 'ftyp' && bytes.readUInt32BE(0) >= 12;
}
async function entryFor(root, directory, name, kind, contentType, bundle, role) {
  const relativePath = directory + '/' + name, identity = await inspect(root, relativePath);
  const size = Number(identity.file.size);
  if (!Number.isSafeInteger(size) || size < 0 || (kind === 'audio' && size === 0)) throw failure();
  return { name, kind, ...(role ? { role } : {}), path: path.join(root, ...relativePath.split('/')),
    rootPath: root, relativePath, contentType, size, identity, bundle };
}
async function metadataFromIni(root, directory, names, bundle) {
  const name = names.find(value => value.toLowerCase() === 'song.ini');
  if (!name) return { videoStartTimeMs: 0 };
  const entry = await entryFor(root, directory, name, 'metadata', 'text/plain', bundle);
  if (entry.size > 128 * 1024) return { videoStartTimeMs: 0 };
  const bytes = await readPrefix(entry, entry.size);
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { videoStartTimeMs: 0 }; }
  let section = '';
  const values = new Map(), conflicts = new Set();
  for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (heading) { section = heading[1].trim().toLowerCase(); continue; }
    const match = section === 'song' && /^\s*(genre|video_start_time)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (values.has(key) && values.get(key) !== match[2]) conflicts.add(key);
    values.set(key, match[2]);
  }
  const genre = conflicts.has('genre') ? '' : (values.get('genre') ?? '').replace(/<[^>\r\n]{0,128}>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 512);
  const start = values.get('video_start_time');
  const videoStartTimeMs = !conflicts.has('video_start_time') && /^-?\d+$/.test(start ?? '')
    && Number.isSafeInteger(Number(start)) && Math.abs(Number(start)) <= 24 * 60 * 60 * 1000 ? Number(start) : 0;
  return { ...(genre ? { genre } : {}), videoStartTimeMs };
}

/** Main/worker only. Requires a scanned item with its original bundle snapshot. */
async function preparePlaybackMedia({ root, item } = {}) {
  if (item?.format === 'sng') throw unsupported('La lecture des fichiers SNG n’est pas prise en charge. Utilisez une chanson avec des fichiers audio séparés.');
  const relative = item?.relativePath, extension = { chart: '.chart', midi: '.mid' }[item?.format];
  if (typeof root !== 'string' || !path.isAbsolute(root) || !relativeValid(relative) || !extension
    || path.posix.extname(relative).toLowerCase() !== extension || !/^notes\.(?:chart|mid)$/i.test(path.posix.basename(relative))
    || item.id !== hash(relative) || !/^[a-f0-9]{64}$/.test(item.cleanupSnapshot ?? '')) throw failure();
  root = path.resolve(root);
  const directory = path.posix.dirname(relative);
  if (directory === '.' || !relativeValid(directory)) throw failure();
  const bundle = { relativePath: relative, format: item.format, snapshot: item.cleanupSnapshot };
  const options = { rootPath: root, relativePath: relative, format: item.format };
  if (await captureBundleSnapshot(options) !== bundle.snapshot) throw failure();
  const folderPath = path.join(root, ...directory.split('/')), names = await fs.readdir(folderPath);
  if (names.filter(name => /^notes\.(?:chart|mid)$/i.test(name)).length !== 1) throw failure('Plusieurs fichiers de notes rendent cette chanson ambiguë.');
  const roles = new Map(), artworkNames = [], videoNames = [];
  for (const name of names) {
    const ext = path.extname(name).toLowerCase(), role = path.basename(name, path.extname(name)).toLowerCase();
    if (ROLES.includes(role) && ['.aif', '.aiff'].includes(ext)) throw unsupported('Ce format audio n’est pas pris en charge par le lecteur.');
    if (Object.hasOwn(AUDIO, ext) && ROLES.includes(role)) {
      if (roles.has(role)) throw failure('Plusieurs fichiers audio existent pour le même instrument.');
      roles.set(role, name);
    }
    if (role === 'album' && Object.hasOwn(IMAGES, ext)) artworkNames.push(name);
    if (role === 'video') videoNames.push(name);
  }
  // Numbered drum/vocal stems replace the combined stem according to the chart format.
  if ([1, 2, 3, 4].some(index => roles.has('drums_' + index))) roles.delete('drums');
  if ([1, 2].some(index => roles.has('vocals_' + index))) roles.delete('vocals');
  if ([1, 2].some(index => roles.has('vocals_explicit_' + index))) roles.delete('vocals_explicit');
  const media = [];
  for (const role of ROLES) if (roles.has(role)) {
    const name = roles.get(role);
    media.push(await entryFor(root, directory, name, 'audio', AUDIO[path.extname(name).toLowerCase()], bundle, role));
  }
  if (!media.length) throw failure('Aucun fichier audio complet compatible n’est disponible pour cette chanson.');
  let artwork = null;
  if (artworkNames.length === 1) {
    const name = artworkNames[0], candidate = await entryFor(root, directory, name, 'artwork', IMAGES[path.extname(name).toLowerCase()], bundle);
    if (candidate.size <= ARTWORK_LIMIT && artworkMatches(await readPrefix(candidate, 12), candidate.contentType)) artwork = candidate;
  }
  let video = null, videoUnavailable = null;
  if (videoNames.length > 1) videoUnavailable = 'ambiguous';
  else if (videoNames.length === 1) {
    const name = videoNames[0], contentType = VIDEOS[path.extname(name).toLowerCase()];
    if (!contentType) videoUnavailable = 'unsupported';
    else {
      const candidate = await entryFor(root, directory, name, 'video', contentType, bundle);
      if (candidate.size < 1 || candidate.size > VIDEO_LIMIT) videoUnavailable = 'unavailable';
      else if (videoMatches(await readPrefix(candidate, 12), contentType)) video = candidate;
      else videoUnavailable = 'unsupported';
    }
  }
  const metadata = await metadataFromIni(root, directory, names, bundle);
  if (await captureBundleSnapshot(options) !== bundle.snapshot) throw failure();
  return { rootPath: root, folderPath, mediaMode: media.length === 1 && media[0].role === 'song' ? 'song' : 'stems', media, artwork, video, videoUnavailable, ...metadata };
}

function rangeFor(value, size) {
  if (!value) return { start: 0, end: size - 1, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length < 1) return null;
    start = Math.max(0, size - length); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end, status: 206 };
}
function validEntry(entry) {
  return entry && typeof entry.rootPath === 'string' && path.isAbsolute(entry.rootPath) && relativeValid(entry.relativePath)
    && samePath(entry.path, path.join(entry.rootPath, ...entry.relativePath.split('/')))
    && entry.name === path.posix.basename(entry.relativePath) && Number.isSafeInteger(entry.size) && entry.size > 0
    && entry.identity?.file?.size === String(entry.size) && /^[a-f0-9]{64}$/.test(entry.bundle?.snapshot ?? '')
    && relativeValid(entry.bundle.relativePath) && ['chart', 'midi'].includes(entry.bundle.format)
    && path.posix.dirname(entry.bundle.relativePath) === path.posix.dirname(entry.relativePath)
    && ((entry.kind === 'audio' && ROLES.includes(entry.role) && path.basename(entry.name, path.extname(entry.name)).toLowerCase() === entry.role
      && AUDIO[path.extname(entry.name).toLowerCase()] === entry.contentType)
      || (entry.kind === 'artwork' && entry.size <= ARTWORK_LIMIT && path.basename(entry.name, path.extname(entry.name)).toLowerCase() === 'album'
        && IMAGES[path.extname(entry.name).toLowerCase()] === entry.contentType)
      || (entry.kind === 'video' && entry.size <= VIDEO_LIMIT && path.basename(entry.name, path.extname(entry.name)).toLowerCase() === 'video'
        && VIDEOS[path.extname(entry.name).toLowerCase()] === entry.contentType));
}

/** The host first resolves an opaque capability to this private entry. No URL
 * or renderer-supplied path is ever interpreted by this helper. */
async function mediaResponse(entry, request, { signal, isAllowed, onClose } = {}) {
  let handle = null, closed = false, closeTask = null, controller = null;
  const signals = [...new Set([signal, request?.signal].filter(Boolean))];
  const authorized = () => !closed && !signals.some(value => value.aborted) && (!isAllowed || isAllowed() === true);
  const close = () => {
    if (closeTask) return closeTask;
    closed = true;
    for (const value of signals) value.removeEventListener('abort', abort);
    const opened = handle; handle = null;
    closeTask = (async () => {
      try { await opened?.close(); } finally { try { onClose?.(); } catch {} }
    })();
    return closeTask;
  };
  const abort = () => {
    try { controller?.error(Object.assign(Error('Lecture locale interrompue.'), { name: 'AbortError' })); } catch {}
    void close().catch(() => {});
  };
  const guard = () => { if (!authorized()) throw failure(); };
  const verifyBundle = async () => {
    guard();
    if (await captureBundleSnapshot({ rootPath: entry.rootPath, relativePath: entry.bundle.relativePath, format: entry.bundle.format }) !== entry.bundle.snapshot) throw failure();
    guard();
  };
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
  try {
    const method = request?.method?.toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) { await close(); return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } }); }
    if (!validEntry(entry)) throw failure();
    await verifyBundle();
    handle = await openChecked(entry); guard();
    await verifyBundle();
    if (entry.kind === 'artwork' || entry.kind === 'video') {
      const bytes = Buffer.alloc(Math.min(12, entry.size));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length || !(entry.kind === 'artwork' ? artworkMatches(bytes, entry.contentType) : videoMatches(bytes, entry.contentType))) throw failure();
    }
    const range = rangeFor(request.headers.get('range'), entry.size);
    if (!range) { await close(); return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + entry.size } }); }
    headers['Content-Type'] = entry.contentType;
    headers['Content-Length'] = String(range.end - range.start + 1);
    if (range.status === 206) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${entry.size}`;
    if (method === 'HEAD') { await close(); return new Response(null, { status: range.status, headers }); }
    let position = range.start, firstPull = true;
    const body = new ReadableStream({
      start(value) { controller = value; },
      async pull(value) {
        try {
          guard();
          if (firstPull) { await verifyBundle(); firstPull = false; }
          await inspect(entry.rootPath, entry.relativePath, entry.identity); guard();
          if (!matches(await handle.stat({ bigint: true }), entry.identity.file, true)) throw failure();
          const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, range.end - position + 1));
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, position); guard();
          if (!bytesRead || !matches(await handle.stat({ bigint: true }), entry.identity.file, true)) throw failure();
          await inspect(entry.rootPath, entry.relativePath, entry.identity); guard();
          position += bytesRead;
          if (position > range.end) { await verifyBundle(); value.enqueue(bytes.subarray(0, bytesRead)); value.close(); await close(); }
          else value.enqueue(bytes.subarray(0, bytesRead));
        } catch (error) { try { value.error(failure()); } catch {} await close().catch(() => {}); }
      },
      cancel() { return close(); }
    }, { highWaterMark: 0 });
    for (const value of signals) value.addEventListener('abort', abort, { once: true });
    if (!authorized()) abort();
    return new Response(body, { status: range.status, headers });
  } catch {
    await close().catch(() => {});
    return new Response(null, { status: 404, headers });
  }
}

module.exports = { preparePlaybackMedia, mediaResponse };
