'use strict';

const fs = require('node:fs/promises');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isRhythmVerseDriveFolder, downloadDriveFolder } = require('./rhythmverse-drive-folder.cjs');

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DRIVE_CONTENT = 'drive.usercontent.google.com';
const DRIVE_VIEWERS = new Set(['drive.google.com', 'docs.google.com']);
const RHYTHMVERSE = new Set(['rhythmverse.co', 'www.rhythmverse.co']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DRIVE_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

function archiveError(code, message) {
  return Object.assign(new Error(message), { code });
}

function archiveUrl(value, base, redirect = false) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  let url;
  try { url = new URL(value, base); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  url.hash = '';
  if (RHYTHMVERSE.has(url.hostname)) {
    return /^\/download(?:_file)?\//i.test(url.pathname) || /\.(?:zip|7z)$/i.test(url.pathname) ? url : null;
  }

  let id;
  if (DRIVE_VIEWERS.has(url.hostname)) {
    const match = /^\/file\/d\/([A-Za-z0-9_-]{1,128})(?:\/(?:view|preview|edit))?\/?$/.exec(url.pathname);
    id = match?.[1] ?? (/^\/(?:open|uc)$/.test(url.pathname) ? url.searchParams.get('id') : null);
  } else if (url.hostname === DRIVE_CONTENT && url.pathname === '/download') {
    id = url.searchParams.get('id');
    if (redirect && DRIVE_TOKEN.test(id ?? '')) return url;
  }
  if (!DRIVE_TOKEN.test(id ?? '')) return null;

  const target = new URL(`https://${DRIVE_CONTENT}/download`);
  target.search = new URLSearchParams({ id, export: 'download', confirm: 't' });
  const resourceKey = url.searchParams.get('resourcekey');
  if (resourceKey) {
    if (!DRIVE_TOKEN.test(resourceKey)) return null;
    target.searchParams.set('resourcekey', resourceKey);
  }
  return target;
}

function canDownloadRhythmVerse(url) {
  return archiveUrl(url) !== null || isRhythmVerseDriveFolder(url);
}

async function fetchArchive(url, fetchImpl, signal) {
  const visited = new Set();
  for (let hops = 0; hops <= MAX_REDIRECTS && url && !visited.has(url.href); hops++) {
    visited.add(url.href);
    const response = await fetchImpl(url.href, {
      headers: { Accept: 'application/octet-stream, application/zip, application/x-7z-compressed, */*', 'Accept-Encoding': 'identity' },
      credentials: 'omit', redirect: 'manual', signal,
    });
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    url = archiveUrl(location, url, true);
  }
  throw archiveError('RV_ARCHIVE_REDIRECT', 'Le lien redirige vers un hébergeur non pris en charge.');
}

async function downloadRhythmVerseFile({ url, filename, signal, fetchImpl = globalThis.fetch, maxBytes = MAX_ARCHIVE_BYTES, allowPlainText = false }) {
  const target = archiveUrl(url);
  if (!target) throw archiveError('RV_ARCHIVE_HOST', 'Ce lien doit être ouvert dans le navigateur.');
  const timeout = AbortSignal.timeout(90_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response, file, complete = false;
  try {
    requestSignal.throwIfAborted();
    response = await fetchArchive(target, fetchImpl, requestSignal);
    if (response.status !== 200 || !response.body) {
      throw archiveError('RV_ARCHIVE_UNAVAILABLE', 'L’hébergeur ne donne pas accès à cette archive.');
    }

    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
    if (/^text\/|(?:html|json|xml)$/.test(type) && !(allowPlainText && /^text\/(?:plain|x-ini|ini)$/.test(type))) {
      throw archiveError('RV_ARCHIVE_PAGE', 'L’hébergeur a renvoyé une page web. Ouvre le lien dans le navigateur.');
    }

    const length = response.headers.get('content-length');
    const declared = length === null ? null : Number(length);
    if (declared !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes)) {
      throw archiveError('RV_ARCHIVE_SIZE', 'La taille de l’archive est invalide ou dépasse 256 Mio.');
    }

    const encoding = response.headers.get('content-encoding');
    const expected = !encoding || encoding.toLowerCase() === 'identity' ? declared : null;
    let bytes = 0;
    const count = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes || expected !== null && bytes > expected) {
        done(archiveError('RV_ARCHIVE_SIZE', 'La taille de l’archive est invalide ou dépasse 256 Mio.'));
      } else done(null, chunk);
    } });

    file = await fs.open(filename, 'wx', 0o600);
    await pipeline(Readable.fromWeb(response.body), count, file.createWriteStream(), { signal: requestSignal });
    if (bytes === 0 || expected !== null && bytes !== expected) {
      throw archiveError('RV_ARCHIVE_TRUNCATED', 'Le téléchargement de l’archive est incomplet. Réessaie.');
    }
    complete = true;
    return { bytes };
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw archiveError('RV_ARCHIVE_TIMEOUT', 'Le téléchargement de l’archive a expiré. Réessaie.');
    if (requestSignal.aborted || String(error?.code).startsWith('RV_ARCHIVE_')) throw error;
    throw archiveError('RV_ARCHIVE_FAILED', 'Impossible de télécharger l’archive. Réessaie ou ouvre le lien dans le navigateur.');
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    if (file) {
      await file.close().catch(() => {});
      if (!complete) await fs.rm(filename, { force: true }).catch(() => {});
    }
  }
}

function downloadRhythmVerseArchive({ url, filename, signal, fetchImpl }) {
  return downloadRhythmVerseFile({ url, filename, signal, fetchImpl });
}

function downloadRhythmVerseDriveFolder(options) {
  return downloadDriveFolder(options, downloadRhythmVerseFile);
}

module.exports = { canDownloadRhythmVerse, downloadRhythmVerseArchive, isRhythmVerseDriveFolder, downloadRhythmVerseDriveFolder };
