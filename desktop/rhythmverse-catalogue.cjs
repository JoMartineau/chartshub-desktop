'use strict';

const { searchRhythmVersePage } = require('./rhythmverse-client.cjs');
const { canDownloadRhythmVerse } = require('./rhythmverse-download.cjs');
const { createRhythmVerseArtwork, rhythmVerseArtworkUrl } = require('./rhythmverse-artwork.cjs');

const SEARCH = 'chartshub-rhythmverse:search';
const OPEN = 'chartshub-rhythmverse:open';
const ARTWORK = 'chartshub-rhythmverse:artwork';
const MAX_PAGES = 250;
const MAX_DOWNLOAD_RECORDS = 6000;

function createRhythmVerseCatalogue({ ipcMain, contents, allowedSender, download, openExternal,
  nativeArchiveSupport, search = searchRhythmVersePage, artwork = createRhythmVerseArtwork() }) {
  const records = new Map();
  const downloadRecords = new Map();
  let pending = null, revision = 0, loaded = null, coverRequests = new AbortController();
  const trusted = event => allowedSender(event) && ['/', '/index.html'].includes(new URL(event.senderFrame.url).pathname);
  const clearRecords = () => {
    coverRequests.abort();
    coverRequests = new AbortController();
    loaded = null;
    records.clear();
  };
  const clear = () => { pending?.controller.abort(); pending = null; clearRecords(); downloadRecords.clear(); };
  const navigate = details => {
    if (details.isMainFrame && !details.isSameDocument) { revision++; clear(); }
  };
  contents.on('did-start-navigation', navigate);

  ipcMain.handle(SEARCH, (event, payload) => {
    const { query, page } = payload ?? {};
    if (!trusted(event) || typeof query !== 'string' || query.length > 120 || query.trim().length === 1
      || !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGES) {
      return { ok: false, error: 'Saisissez un titre ou un artiste (2 à 120 caractères).' };
    }
    const text = query.trim();
    if (pending?.query === text && pending.page === page) return pending.promise;
    if (page > 1) {
      if (!pending && loaded?.query === text && page === loaded.page) return loaded.response;
      if (pending || loaded?.query !== text || page !== loaded.page + 1 || !loaded.hasMore) return { ok: false, cancelled: true };
    }
    pending?.controller.abort();
    const request = { query: text, page, controller: new AbortController(), promise: null };
    pending = request;
    request.promise = (async () => {
      const { signal } = request.controller;
      try {
        const result = await search(text, { page, signal });
        if (pending !== request || !trusted(event)) return { ok: false, cancelled: true };
        if (page === 1) clearRecords();
        const items = [];
        for (const { downloadUrl, pageUrl, artworkUrl, ...item } of result.items) {
          if (records.has(item.id)) continue;
          const canDownload = nativeArchiveSupport === true && canDownloadRhythmVerse(downloadUrl);
          const browserUrl = pageUrl || downloadUrl;
          const cover = rhythmVerseArtworkUrl(artworkUrl);
          const record = { ...item, artworkUrl: cover, downloadUrl: canDownload ? downloadUrl : null, browserDownloadUrl: downloadUrl, browserUrl };
          records.set(item.id, record);
          // A selected chart stays downloadable across searches within this document.
          downloadRecords.delete(item.id);
          if (canDownload) {
            downloadRecords.set(item.id, record);
            if (downloadRecords.size > MAX_DOWNLOAD_RECORDS) downloadRecords.delete(downloadRecords.keys().next().value);
          }
          items.push({ ...item, hasArtwork: Boolean(cover), canDownload, canDownloadInBrowser: Boolean(downloadUrl), canOpenPage: Boolean(browserUrl) });
        }
        const hasMore = page < MAX_PAGES && result.hasMore;
        const response = { ok: true, items, page, total: result.total, hasMore, nativeArchiveSupport };
        loaded = { query: text, page, hasMore, response };
        return response;
      } catch {
        return signal.aborted ? { ok: false, cancelled: true }
          : { ok: false, error: 'RhythmVerse est indisponible. Réessayez dans un instant.' };
      } finally {
        if (pending === request) pending = null;
      }
    })();
    return request.promise;
  });

  ipcMain.handle(ARTWORK, async (event, id) => {
    if (!trusted(event) || typeof id !== 'string') return null;
    const record = records.get(id);
    if (!record?.artworkUrl) return null;
    try {
      const data = await artwork.load(record.artworkUrl, { signal: coverRequests.signal });
      return trusted(event) && records.get(id) === record ? data : null;
    } catch { return null; }
  });

  ipcMain.handle(OPEN, async (event, payload) => {
    if (!trusted(event) || typeof payload?.id !== 'string') return { ok: false };
    const record = records.get(payload.id);
    if (payload.kind === 'download' && record?.downloadUrl) {
      const format = payload.format ?? 'folder';
      const includeVideo = payload.includeVideo ?? true;
      if (!['folder', 'zip', 'sng'].includes(format) || typeof includeVideo !== 'boolean') return { ok: false, error: 'Format de téléchargement invalide.' };
      const expected = revision;
      return download(record, () => revision === expected && trusted(event), { format, includeVideo });
    }
    const browserUrl = payload.kind === 'page' ? record?.browserUrl : payload.kind === 'browser-download' ? record?.browserDownloadUrl : null;
    if (browserUrl) {
      try {
        await openExternal(browserUrl);
        return { ok: true };
      } catch {
        return { ok: false, error: 'Impossible d’ouvrir ce lien dans le navigateur.' };
      }
    }
    return { ok: false, error: 'Ce lien n’est plus disponible. Relancez la recherche.' };
  });

  function authorizeDownloads(event, ids) {
    if (!trusted(event)) return null;
    const selected = new Map();
    for (const id of ids) {
      const record = downloadRecords.get(id);
      if (!record) return null;
      selected.set(id, record);
    }
    const expected = revision;
    return { get: id => selected.get(id), current: () => revision === expected && trusted(event) };
  }

  return { authorizeDownloads, dispose() {
    revision++;
    clear();
    artwork.clear();
    contents.removeListener('did-start-navigation', navigate);
    ipcMain.removeHandler(SEARCH);
    ipcMain.removeHandler(OPEN);
    ipcMain.removeHandler(ARTWORK);
  } };
}

module.exports = { createRhythmVerseCatalogue };
