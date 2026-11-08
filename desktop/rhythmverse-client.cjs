'use strict';

const { isIP } = require('node:net');

const ORIGIN = 'https://rhythmverse.co';
const SEARCH_URL = `${ORIGIN}/api/ch/songfiles/search/live`;
const BROWSE_URL = `${ORIGIN}/api/ch/songfiles/list`;
const LEGACY_PAGE_SIZE = 12;
const PAGE_SIZE = 24;
const MAX_PAGE = 250;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const MAX_QUERY_LENGTH = 120;
const instruments = {
  guitar: 'Guitare', guitar_coop: 'Guitare coop', guitarghl: 'Guitare 6 touches',
  rhythm: 'Guitare rythmique', bass: 'Basse', bassghl: 'Basse 6 touches', drums: 'Batterie',
  prodrums: 'Batterie pro', keys: 'Clavier', vocals: 'Chant',
  proguitar: 'Guitare pro', probass: 'Basse pro', prokeys: 'Clavier pro',
};
const levels = { e: 'Facile', m: 'Moyen', h: 'Difficile', x: 'Expert' };

function cleanText(value, limit = 240) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim();
  return trimmed.slice(0, limit) || null;
}

function publicLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\u0000-\u001f\u007f]|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null;
  const link = value.trim();
  if (!link || /^none$/i.test(link) || link.startsWith('//')) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(link) && !/^https:\/\//i.test(link)) return null;
  try {
    const url = new URL(link, ORIGIN);
    const host = url.hostname.replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !host.includes('.') || isIP(host) || /\.(?:local|localhost|internal|lan|home|arpa|onion)$/i.test(host)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function positiveInteger(value, maximum) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : null;
}

function authored(value) {
  return value === 1 || value === '1' || value === true;
}

function catalogueDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const iso = value.replace(' ', 'T') + 'Z';
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function instrumentDetails(file) {
  const entries = [];
  for (const [key, name] of Object.entries(instruments)) {
    const flags = file.difficulties?.[key];
    const available = Object.entries(levels)
      .filter(([code]) => authored(flags?.all) || authored(flags?.[code]))
      .map(([, label]) => label);
    const rank = positiveInteger(file[`diff_${key}`], 99);
    if (available.length || rank) entries.push({ name, available, rank });
  }
  return entries;
}

function normalizeChart(song) {
  const file = song?.file;
  const data = song?.data;
  const fileId = file?.file_id;
  const id = Number.isSafeInteger(fileId) && fileId > 0 ? String(fileId) : fileId;
  if (typeof id !== 'string' || !/^[a-z\d_-]{1,80}$/i.test(id)) return null;
  const charter = typeof file.charter === 'string'
    ? file.charter.replace(/<\/?color(?:=[^>]*?)?>/gi, '')
    : null;
  return {
    id,
    title: cleanText(data?.title) ?? cleanText(file.file_title) ?? 'Titre inconnu',
    artist: cleanText(data?.artist) ?? cleanText(file.file_artist) ?? 'Artiste inconnu',
    charter: cleanText(charter) ?? cleanText(file.author?.name),
    format: cleanText(file.gameformat, 32),
    album: cleanText(file.file_album) ?? cleanText(data?.album),
    year: positiveInteger(file.file_year, 9999) ?? positiveInteger(data?.year, 9999),
    modifiedAt: catalogueDate(file.update_date) ?? catalogueDate(file.release_date),
    genre: cleanText(file.file_genre) ?? cleanText(data?.genre),
    duration: positiveInteger(file.file_song_length, 86400) ?? positiveInteger(data?.song_length, 86400),
    instruments: instrumentDetails(file),
    artworkUrl: publicLink(data?.album_art) ?? publicLink(file.album_art),
    downloadUrl: publicLink(file.download_url),
    pageUrl: publicLink(file.download_page_url_full) ?? publicLink(file.download_page_url) ?? publicLink(file.external_url),
  };
}

async function readPayload(response, signal) {
  if (!response?.ok || !response.body) throw new Error(`RhythmVerse HTTP ${response?.status ?? 'error'}`);
  const declared = response.headers.get('content-length');
  if (Number(declared) > RESPONSE_LIMIT) {
    await response.body.cancel();
    throw new Error('RhythmVerse response too large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > RESPONSE_LIMIT) throw new Error('RhythmVerse response too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

async function requestRhythmVersePage(query, { page, pageSize, fetchImpl = globalThis.fetch, signal }) {
  if (typeof query !== 'string' || query.trim().length > MAX_QUERY_LENGTH) throw new TypeError('Invalid RhythmVerse search');
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) throw new TypeError('Invalid RhythmVerse page');
  const text = cleanText(query, MAX_QUERY_LENGTH) ?? '';
  if (query.trim() && text.length < 2) throw new TypeError('Invalid RhythmVerse search');

  const body = new URLSearchParams({ data_type: 'full', records: String(pageSize), page: String(page) });
  if (text) body.set('text', text);
  else {
    body.set('sort[0][sort_by]', 'update_date');
    body.set('sort[0][sort_order]', 'DESC');
  }

  const timeout = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  requestSignal.throwIfAborted();
  const response = await fetchImpl(text ? SEARCH_URL : BROWSE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body,
    credentials: 'omit',
    redirect: 'error',
    signal: requestSignal,
  });
  const payload = await readPayload(response, requestSignal);
  requestSignal.throwIfAborted();
  if (payload?.status !== 'success' || !Array.isArray(payload.data?.songs)) throw new Error('Invalid RhythmVerse response');

  const songs = payload.data.songs.slice(0, pageSize);
  const matches = new Map();
  for (const song of songs) {
    const chart = normalizeChart(song);
    if (chart && !matches.has(chart.id)) matches.set(chart.id, chart);
  }
  const reportedTotal = payload.data.records?.total_filtered;
  const knownTotal = reportedTotal === 0 || reportedTotal === '0' ? 0 : positiveInteger(reportedTotal, Number.MAX_SAFE_INTEGER);
  const lastOffset = (page - 1) * pageSize + songs.length;
  return {
    items: Array.from(matches.values()),
    total: knownTotal ?? lastOffset,
    hasMore: page < MAX_PAGE && songs.length > 0 && (knownTotal === null ? songs.length === pageSize : lastOffset < knownTotal),
  };
}

function searchRhythmVersePage(query, { page = 1, fetchImpl, signal } = {}) {
  return requestRhythmVersePage(query, { page, pageSize: PAGE_SIZE, fetchImpl, signal });
}

async function searchRhythmVerse(query, { fetchImpl, signal } = {}) {
  const { items } = await requestRhythmVersePage(query, { page: 1, pageSize: LEGACY_PAGE_SIZE, fetchImpl, signal });
  return items.map(({ artworkUrl, modifiedAt, ...item }) => item);
}

module.exports = { searchRhythmVerse, searchRhythmVersePage };
