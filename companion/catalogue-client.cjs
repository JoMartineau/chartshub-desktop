'use strict';

// Contract checked against ChartsHub's public server/index.js, drive.js and
// chart-analysis.js. Search/pagination are local: /api/charts is a full snapshot.
const ORIGIN = 'https://chartshub.ca';
const MAX_JSON_BYTES = 24 * 1024 * 1024, MAX_ARTWORK_BYTES = 3 * 1024 * 1024, MAX_ITEMS = 20000;
const INSTRUMENTS = ['Guitar', 'Bass', 'Drums', 'Vocals', 'Keys', 'Guitar Co-op', 'Rhythm', 'Guitar 6-fret', 'Guitar Co-op 6-fret', 'Rhythm 6-fret', 'Bass 6-fret', 'Pro Drums'];
const DIFFICULTIES = ['Easy', 'Medium', 'Hard', 'Expert'];
const COVER_PATH = /^\/api\/charts\/[a-f0-9-]{36}\/[A-Za-z0-9_-]{10,200}\/cover$/;
const SOURCE_PATH = /^\/api\/charts\/[a-f0-9-]{36}\/[A-Za-z0-9_-]{10,200}\/source$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function failure(code) {
  const messages = {
    CATALOGUE_HTTP: 'Le catalogue ChartsHub est temporairement indisponible.',
    CATALOGUE_TIMEOUT: 'ChartsHub n’a pas répondu à temps. Réessayez.',
    CATALOGUE_INVALID: 'La réponse du catalogue ChartsHub est invalide.',
    CATALOGUE_LIMIT: 'Le catalogue dépasse la limite de cette version du Companion.',
    CATALOGUE_NETWORK: 'La connexion à ChartsHub a échoué.'
  };
  const error = Error(messages[code] || messages.CATALOGUE_NETWORK); error.code = code; return error;
}
function cancelled() { const error = Error('Chargement du catalogue annulé.'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; return error; }
function cleanText(value, max = 512) {
  return typeof value === 'string' ? value.slice(0, 8192).replace(/<[^>\r\n]{0,256}>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/.test(value); }
function artworkUrl(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const relative = value.startsWith(ORIGIN + '/') ? value.slice(ORIGIN.length) : value;
  // Validate the original path before URL parsing can normalize dot segments.
  if (!COVER_PATH.test(relative)) return null;
  return ORIGIN + relative;
}
function downloadEndpoint(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const relative = value.startsWith(ORIGIN + '/') ? value.slice(ORIGIN.length) : value;
  // The publication ID is supplied by publicChart.downloadUrl, not creatorId.
  return SOURCE_PATH.test(relative) ? relative.replace(/source$/, 'download-manifest') : null;
}
function creatorBadges(value) {
  if (!record(value) || !Array.isArray(value.creators) || value.creators.length > MAX_ITEMS) return { badges: new Map(), unavailable: true };
  const result = new Map(); let unavailable = false;
  for (const creator of value.creators) {
    if (!record(creator) || !validId(creator.id)) { unavailable = true; continue; }
    if (result.has(creator.id) || typeof creator.verifiedCharter !== 'boolean') unavailable = true;
    result.set(creator.id, result.has(creator.id) ? null : typeof creator.verifiedCharter === 'boolean' ? creator.verifiedCharter : null);
  }
  return { badges: result, unavailable };
}
function normalizeCharts(value, badges) {
  if (!record(value) || !Array.isArray(value.charts) || typeof value.demo !== 'boolean') throw failure('CATALOGUE_INVALID');
  if (value.charts.length > MAX_ITEMS) throw failure('CATALOGUE_LIMIT');
  const seen = new Set(), items = [];
  for (const row of value.charts) {
    if (!record(row) || !validId(row.id) || typeof row.title !== 'string' || typeof row.artist !== 'string' || seen.has(row.id)) throw failure('CATALOGUE_INVALID');
    const title = cleanText(row.title), artist = cleanText(row.artist);
    if (!title || !artist) throw failure('CATALOGUE_INVALID');
    seen.add(row.id);
    const instruments = Array.isArray(row.instruments) ? INSTRUMENTS.filter(instrument => row.instruments.includes(instrument)) : [];
    const available = new Set(), instrumentDifficulties = {};
    if (record(row.instrumentDifficulties)) for (const instrument of INSTRUMENTS) {
      const levels = row.instrumentDifficulties[instrument];
      if (Array.isArray(levels)) {
        instrumentDifficulties[instrument] = DIFFICULTIES.filter(level => levels.includes(level));
        for (const level of instrumentDifficulties[instrument]) available.add(level);
      }
    }
    if (!available.size && DIFFICULTIES.includes(row.difficulty)) available.add(row.difficulty);
    const year = typeof row.year === 'number' && Number.isInteger(row.year) ? String(row.year) : typeof row.year === 'string' ? row.year.trim() : '';
    items.push({
      id: row.id, title, artist, charter: cleanText(row.charter), verified: badges.get(row.creatorId) ?? null,
      album: cleanText(row.album), year: /^\d{4}$/.test(year) ? year : '', genre: cleanText(row.genre),
      instruments, difficulties: DIFFICULTIES.filter(level => available.has(level)), instrumentDifficulties,
      artworkUrl: artworkUrl(row.coverUrl), viewUrl: `${ORIGIN}/index.html?chart=${encodeURIComponent(row.id)}&share=2`,
      downloadEndpoint: downloadEndpoint(row.downloadUrl),
      contentHash: typeof row.contentHash === 'string' && /^[a-f0-9]{64}$/i.test(row.contentHash) ? row.contentHash.toLowerCase() : null
    });
  }
  return items;
}
function imageType(bytes, contentType) {
  if (contentType === 'image/png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return contentType;
  if (contentType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return contentType;
  if (contentType === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return contentType;
  return null;
}

function createChartsHubClient({ fetcher = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw Error('Configuration du client ChartsHub invalide.');
  async function request(url, { signal, image = false } = {}) {
    if (signal?.aborted) throw cancelled();
    const controller = new AbortController(); let timedOut = false, reader = null, response = null;
    const relay = () => controller.abort(); signal?.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = () => reject(timedOut ? failure('CATALOGUE_TIMEOUT') : cancelled()); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const pending = (async () => {
      try {
        response = await fetcher(url, {
          method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
          headers: { Accept: image ? 'image/webp, image/png, image/jpeg' : 'application/json' }, signal: controller.signal
        });
        if (controller.signal.aborted) throw timedOut ? failure('CATALOGUE_TIMEOUT') : cancelled();
        if (!response || !response.ok || response.redirected || (response.url && response.url !== url)) throw failure('CATALOGUE_HTTP');
        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (image ? !['image/png', 'image/jpeg', 'image/webp'].includes(contentType) : contentType !== 'application/json') throw failure('CATALOGUE_INVALID');
        const maximum = image ? MAX_ARTWORK_BYTES : MAX_JSON_BYTES;
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw failure('CATALOGUE_LIMIT');
        if (!response.body || typeof response.body.getReader !== 'function') throw failure('CATALOGUE_INVALID');
        reader = response.body.getReader(); const chunks = []; let total = 0;
        for (;;) {
          const part = await reader.read();
          if (controller.signal.aborted) throw timedOut ? failure('CATALOGUE_TIMEOUT') : cancelled();
          if (part.done) break;
          if (!(part.value instanceof Uint8Array)) throw failure('CATALOGUE_INVALID');
          total += part.value.byteLength; if (total > maximum) throw failure('CATALOGUE_LIMIT');
          chunks.push(Buffer.from(part.value));
        }
        const bytes = Buffer.concat(chunks, total);
        if (image) return imageType(bytes, contentType) ? { bytes, contentType } : null;
        try { return JSON.parse(bytes.toString('utf8')); } catch { throw failure('CATALOGUE_INVALID'); }
      } catch (error) {
        if (timedOut) throw failure('CATALOGUE_TIMEOUT');
        if (controller.signal.aborted || error?.name === 'AbortError') throw cancelled();
        if (['CATALOGUE_HTTP', 'CATALOGUE_TIMEOUT', 'CATALOGUE_INVALID', 'CATALOGUE_LIMIT', 'CATALOGUE_NETWORK'].includes(error?.code)) throw failure(error.code);
        throw failure('CATALOGUE_NETWORK');
      } finally {
        if (reader) void reader.cancel().catch(() => {});
        else if (response?.body) void response.body.cancel().catch(() => {});
      }
    })();
    try { return await Promise.race([pending, aborted]); }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', relay); controller.signal.removeEventListener('abort', rejectAbort);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  }
  async function load({ signal } = {}) {
    if (signal?.aborted) throw cancelled();
    const controller = new AbortController(), relay = () => controller.abort();
    signal?.addEventListener('abort', relay, { once: true });
    try {
      const [charts, creators] = await Promise.all([
        request(ORIGIN + '/api/charts', { signal: controller.signal }),
        request(ORIGIN + '/api/creators', { signal: controller.signal }).catch(error => { if (error?.name === 'AbortError') throw error; return null; })
      ]);
      const { badges, unavailable } = creatorBadges(creators);
      return { items: normalizeCharts(charts, badges), revision: null, demo: charts.demo, source: 'live',
        ...(unavailable ? { warning: 'Le statut des créateurs vérifiés est temporairement indisponible.' } : {}) };
    } finally { signal?.removeEventListener('abort', relay); controller.abort(); }
  }
  async function artwork(url, { signal } = {}) {
    if (signal?.aborted) throw cancelled();
    const safe = artworkUrl(url); if (!safe) return null;
    try { return await request(safe, { signal, image: true }); }
    catch (error) { if (error?.name === 'AbortError') throw error; return null; }
  }
  return { load, artwork };
}

module.exports = { createChartsHubClient };
