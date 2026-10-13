'use strict';

// Only ChartsHub's bounded public proxy is contacted for discovery. The renderer
// cannot choose a destination, headers, upstream URL or provider chart identity.
const ORIGIN = 'https://chartshub.ca';
const ENDPOINTS = ['/api/external/enchor/search', '/api/external/enchor/advanced', '/api/external/enchor/browse'];
const INSTRUMENTS = { Guitar: 'guitar', 'Guitar Co-op': 'guitarcoop', Rhythm: 'rhythm', Bass: 'bass', Drums: 'drums', Keys: 'keys', 'Guitar 6-fret': 'guitarghl', 'Guitar Co-op 6-fret': 'guitarcoopghl', 'Rhythm 6-fret': 'rhythmghl', 'Bass 6-fret': 'bassghl', 'Pro Drums': 'drums' };
const LEVELS = ['Easy', 'Medium', 'Hard', 'Expert'];
const MAX_BYTES = 2 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max = 200) => typeof value === 'string' ? value.slice(0, 8192).replace(/<[^>\r\n]{0,256}>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const cancelled = () => Object.assign(Error('Recherche ChorusEncore annulée.'), { name: 'AbortError', code: 'ABORT_ERR' });
function charterColor(value) {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const color = value.trim().replace(/^["']|["']$/g, '').toLowerCase();
  return /^(?:#[a-f0-9]{3}|#[a-f0-9]{4}|#[a-f0-9]{6}|#[a-f0-9]{8}|red|green|blue|yellow|white|black|orange|purple|violet|cyan|magenta|grey|gray|lime|pink|silver|gold|teal|navy|maroon|olive|aqua|fuchsia)$/.test(color) ? color : undefined;
}
function failure(code = 'ENCHOR_UNAVAILABLE', retryAfterSeconds = 0) {
  const messages = { ENCHOR_INVALID_QUERY: 'Saisissez un titre, un artiste, un charter ou un filtre pour ChorusEncore.', ENCHOR_INVALID_RESPONSE: 'La réponse de ChorusEncore est invalide.', ENCHOR_TIMEOUT: 'ChorusEncore met trop de temps à répondre.', ENCHOR_DISABLED: 'La recherche ChorusEncore est désactivée.', ENCHOR_ACCESS_DENIED: 'La recherche ChorusEncore est suspendue. Un administrateur doit rétablir l’accès.', ENCHOR_RECOVERY_REQUIRED: 'La recherche ChorusEncore est suspendue. Un administrateur doit rétablir l’accès.', ENCHOR_RATE_LIMITED: 'ChorusEncore limite temporairement les recherches. Réessayez après le délai indiqué.', ENCHOR_PACED: 'Une recherche ChorusEncore est déjà en cours. Attendez avant de réessayer.', ENCHOR_CLIENT_LIMIT: 'Le service limite temporairement les recherches. Attendez avant de réessayer.' };
  return Object.assign(Error(messages[code] || 'La recherche ChorusEncore est indisponible. Réessayez.'), { code, retryAfterSeconds });
}
function normalizeChart(row) {
  if (!object(row) || row.source !== 'chorusencore' || !/^enchor:[a-f0-9]{32}$/.test(row.id || '') || row.md5 !== row.id.slice(7) || row.sourceUrl !== 'https://enchor.us/chart/' + row.md5 || !Number.isSafeInteger(row.externalChartId) || row.externalChartId < 1) throw failure('ENCHOR_INVALID_RESPONSE');
  const title = clean(row.title), artist = clean(row.artist), charter = clean(row.charter);
  if (!title) throw failure('ENCHOR_INVALID_RESPONSE');
  const instruments = Object.keys(INSTRUMENTS).filter(key => key !== 'Pro Drums' && Array.isArray(row.instruments) && row.instruments.includes(key)), instrumentDifficulties = {};
  for (const instrument of instruments) if (Array.isArray(row.instrumentDifficulties?.[instrument])) instrumentDifficulties[instrument] = LEVELS.filter(level => row.instrumentDifficulties[instrument].includes(level));
  const difficulties = LEVELS.filter(level => Object.values(instrumentDifficulties).some(levels => levels.includes(level)));
  const parts = row.charterSegments;
  const charterSegments = Array.isArray(parts) && parts.length <= 200 && parts.every(part => object(part) && typeof part.text === 'string' && part.text.length <= 200 && !/[<>\u0000-\u001f\u007f]/.test(part.text)) && parts.map(part => part.text).join('') === charter ? parts.map(part => ({ text: part.text, ...(charterColor(part.color) ? { color: charterColor(part.color) } : {}) })) : undefined;
  return { id: row.id, md5: row.md5, source: 'chorusencore', sourceUrl: row.sourceUrl, viewUrl: row.sourceUrl, externalChartId: row.externalChartId, title, artist, charter, ...(charterSegments ? { charterSegments } : {}), album: clean(row.album), genre: clean(row.genre), year: clean(row.year, 16), duration: Number.isSafeInteger(row.duration) && row.duration >= 0 ? row.duration : null, instruments, difficulties, instrumentDifficulties,
    // CDN art is validated even though external cards currently use a local placeholder.
    coverUrl: typeof row.coverUrl === 'string' && /^https:\/\/files\.enchor\.us\/[a-f0-9]{32}\.jpg$/.test(row.coverUrl) ? row.coverUrl : '', artworkUrl: null, downloadable: true };
}
function normalizeResult(value, page) {
  if (!object(value) || value.source !== 'chorusencore' || value.page !== page || value.perPage !== 25 || !Number.isSafeInteger(value.found) || value.found < 0 || typeof value.hasMore !== 'boolean' || !Array.isArray(value.charts) || value.charts.length > 5000 || value.cached !== undefined && typeof value.cached !== 'boolean') throw failure('ENCHOR_INVALID_RESPONSE');
  const charts = [], seen = new Set();
  for (const row of value.charts) { const chart = normalizeChart(row); if (!seen.has(chart.id)) { seen.add(chart.id); charts.push(chart); } }
  return { source: 'chorusencore', charts, page, perPage: 25, found: value.found, hasMore: value.hasMore && page < 200, cached: value.cached === true };
}
function normalizeStatus(value) {
  if (!object(value) || typeof value.enabled !== 'boolean' || typeof value.suspended !== 'boolean' || !Number.isSafeInteger(value.retryAfterSeconds) || value.retryAfterSeconds < 0) throw failure('ENCHOR_INVALID_RESPONSE');
  return { enabled: value.enabled, suspended: value.suspended, retryAfterSeconds: value.retryAfterSeconds };
}
function buildRequest(selected, page) {
  const instrument = Object.keys(INSTRUMENTS).find(key => key.toLowerCase() === selected.instrument.toLowerCase() || INSTRUMENTS[key] === selected.instrument.toLowerCase());
  const difficulty = LEVELS.find(key => key.toLowerCase() === selected.difficulty.toLowerCase());
  const unsupported = ['verified', 'favorites', 'installed'].filter(key => selected[key] !== 'all');
  if (selected.instrument && !instrument) unsupported.push('instrument');
  if (selected.difficulty && !difficulty) unsupported.push('difficulty');
  const body = { page, sort: 'latest' }, localFilters = [];
  if (instrument) body.instrument = INSTRUMENTS[instrument];
  if (instrument === 'Pro Drums') body.drumType = 'fourLanePro';
  if (difficulty) body.difficulty = difficulty.toLowerCase();
  const text = ['artist', 'charter', 'genre', 'year'].filter(key => selected[key]);
  const query = selected.query.trim().replace(/\s+/g, ' ');
  if (query) {
    if (query.length < 2 || query === '*') throw failure('ENCHOR_INVALID_QUERY');
    localFilters.push(...text);
    return { endpoint: ENDPOINTS[0], body: { ...body, search: query }, unsupported, localFilters };
  }
  for (const key of text) body[key] = { value: selected[key].trim(), exact: key === 'year', exclude: false };
  if (!text.length && !body.instrument && !body.difficulty) return { endpoint: null, body, unsupported, localFilters };
  return { endpoint: ENDPOINTS[1], body, unsupported, localFilters };
}
function createEnchorClient({ fetcher = globalThis.fetch, timeoutMs = 15000, now = Date.now } = {}) {
  if (typeof fetcher !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw Error('Configuration ChorusEncore invalide.');
  async function request(endpoint, body, signal) {
    if (signal?.aborted) throw cancelled();
    const url = ORIGIN + endpoint, controller = new AbortController(); let timedOut = false, response, reader, closed = false, rejectAbort;
    const relay = () => controller.abort(); signal?.addEventListener('abort', relay, { once: true });
    const interrupted = new Promise((_resolve, reject) => { rejectAbort = () => reject(timedOut ? failure('ENCHOR_TIMEOUT') : cancelled()); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const wait = promise => Promise.race([promise, interrupted]);
    try {
      const pending = Promise.resolve().then(() => fetcher(url, { method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal }));
      void pending.then(value => { if (closed) { try { value?.body?.cancel?.()?.catch?.(() => {}); } catch {} } }, () => {});
      response = await wait(pending);
      if (!response || !Number.isInteger(response.status) || response.redirected || response.url && response.url !== url) throw failure('ENCHOR_INVALID_RESPONSE');
      let delay = 0;
      const raw = response.headers?.get('retry-after')?.trim(), server = Date.parse(response.headers?.get('date') || '');
      if (raw && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) delay = Number(raw);
      else if (raw && Number.isFinite(Date.parse(raw))) delay = Math.max(0, Math.ceil((Date.parse(raw) - (Number.isFinite(server) ? server : now())) / 1000));
      const errorCode = response.status === 429 ? 'ENCHOR_RATE_LIMITED' : [401, 403].includes(response.status) ? 'ENCHOR_ACCESS_DENIED' : 'ENCHOR_UNAVAILABLE';
      const type = (response.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') throw failure(response.ok ? 'ENCHOR_INVALID_RESPONSE' : errorCode, delay || (response.status === 429 ? 30 : 0));
      const length = response.headers?.get('content-length');
      if (length != null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw failure(response.ok ? 'ENCHOR_INVALID_RESPONSE' : errorCode, delay);
      reader = response.body?.getReader?.(); if (!reader) throw failure('ENCHOR_INVALID_RESPONSE', delay);
      const chunks = []; let total = 0;
      for (;;) { const part = await wait(reader.read()); if (part.done) break; if (!(part.value instanceof Uint8Array) || (total += part.value.byteLength) > MAX_BYTES) throw failure(response.ok ? 'ENCHOR_INVALID_RESPONSE' : errorCode, delay); chunks.push(Buffer.from(part.value)); }
      let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))); } catch { throw failure(response.ok ? 'ENCHOR_INVALID_RESPONSE' : errorCode, delay); }
      if (!response.ok) {
        if (Number.isSafeInteger(value?.retryAfterSeconds) && value.retryAfterSeconds > 0) delay = Math.max(delay, value.retryAfterSeconds);
        const code = typeof value?.code === 'string' && /^ENCHOR_[A-Z_]{1,64}$/.test(value.code) ? value.code : errorCode;
        throw failure([401, 403].includes(response.status) ? 'ENCHOR_ACCESS_DENIED' : code, delay || (response.status === 429 ? 30 : 0));
      }
      return value;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') throw timedOut ? failure('ENCHOR_TIMEOUT') : cancelled();
      if (typeof error?.code === 'string' && error.code.startsWith('ENCHOR_')) throw error;
      throw failure();
    } finally {
      closed = true; clearTimeout(timer); signal?.removeEventListener('abort', relay); controller.signal.removeEventListener('abort', rejectAbort); controller.abort();
      try { (reader ? reader.cancel() : response?.body?.cancel?.())?.catch?.(() => {}); } catch {}
    }
  }
  async function enchorStatus({ signal } = {}) { return normalizeStatus(await request('/api/external/enchor/status', null, signal)); }
  async function enchorSearch({ endpoint, body, signal } = {}) {
    if (!ENDPOINTS.includes(endpoint) || !object(body) || !Number.isSafeInteger(body.page) || body.page < 1 || body.page > 200) throw failure('ENCHOR_INVALID_QUERY');
    return normalizeResult(await request(endpoint, body, signal), body.page);
  }
  return { enchorStatus, enchorSearch };
}
module.exports = { createEnchorClient, normalizeChart, normalizeResult, normalizeStatus, buildRequest, failure };
