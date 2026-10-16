'use strict';
const { ORIGIN } = require('../download');
const { MAX_SONGS, MAX_BYTES, BATCH_SIZE, BATCH_BYTES, shareError } = require('../companion/song-request-share-contract.cjs');
const { INSTRUMENTS, DIFFICULTIES } = require('../companion/song-requests.cjs');
const route = ORIGIN + '/api/account/song-request-library';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const cleanText = value => typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value);
function normalizeSong(song) {
  if (!plain(song) || Object.keys(song).some(key => !['id', 'title', 'artist', 'charter', 'durationMs', 'tracks'].includes(key))
    || !/^[a-f0-9]{64}$/.test(song.id) || !cleanText(song.title) || !song.title.trim() || !cleanText(song.artist) || !cleanText(song.charter)
    || (song.durationMs !== undefined && (!Number.isSafeInteger(song.durationMs) || song.durationMs <= 0))) throw shareError('SHARE_METADATA_INVALID');
  let tracks;
  if (song.tracks !== undefined) {
    if (!Array.isArray(song.tracks) || song.tracks.length > 64) throw shareError('SHARE_METADATA_INVALID');
    const seen = new Set(); tracks = song.tracks.map(track => {
      if (!plain(track) || Object.keys(track).length !== 2 || Object.keys(track).some(key => !['instrument', 'difficulty'].includes(key))
        || track.instrument === 'all' || !INSTRUMENTS.includes(track.instrument) || track.difficulty === 'all' || !DIFFICULTIES.includes(track.difficulty)) throw shareError('SHARE_METADATA_INVALID');
      const key = track.instrument + ':' + track.difficulty;
      if (seen.has(key)) throw shareError('SHARE_METADATA_INVALID'); seen.add(key);
      return { instrument: track.instrument, difficulty: track.difficulty };
    });
  }
  return { id: song.id, title: song.title.trim(), artist: song.artist.trim(), charter: song.charter.trim(),
    ...(song.durationMs === undefined ? {} : { durationMs: song.durationMs }), ...(tracks === undefined ? {} : { tracks }) };
}
function normalizePayload(payload) {
  if (!plain(payload) || !Array.isArray(payload.songs) || !payload.songs.length) throw shareError('SHARE_LIBRARY_EMPTY');
  if (payload.songs.length > MAX_SONGS) throw shareError('SHARE_LIBRARY_LIMIT');
  const rules = payload.rules;
  if (!plain(rules) || Object.keys(rules).some(key => !['maxDurationMinutes', 'instrument', 'difficulty'].includes(key))
    || !(rules.maxDurationMinutes === null || (Number.isInteger(rules.maxDurationMinutes) && rules.maxDurationMinutes >= 1 && rules.maxDurationMinutes <= 60))
    || !INSTRUMENTS.includes(rules.instrument) || !DIFFICULTIES.includes(rules.difficulty)) throw shareError('SHARE_METADATA_INVALID');
  const seen = new Set(), songs = payload.songs.map(song => {
    const value = normalizeSong(song); if (seen.has(value.id)) throw shareError('SHARE_METADATA_INVALID'); seen.add(value.id); return value;
  });
  // Plan ranges, keeping only one bounded serialized request body in flight.
  const batches = []; let start = 0, bytes = Buffer.byteLength('{"songs":[]}'), totalBytes = 0;
  for (let index = 0; index < songs.length; index++) {
    const length = Buffer.byteLength(JSON.stringify(songs[index]), 'utf8');
    if (length + Buffer.byteLength('{"songs":[]}') > BATCH_BYTES) throw shareError('SHARE_METADATA_LIMIT');
    if (index - start === BATCH_SIZE || bytes + length + (index > start ? 1 : 0) > BATCH_BYTES) {
      batches.push([start, index]); totalBytes += bytes; start = index; bytes = Buffer.byteLength('{"songs":[]}');
    }
    bytes += length + (index > start ? 1 : 0);
    if (totalBytes + bytes > MAX_BYTES) throw shareError('SHARE_METADATA_LIMIT');
  }
  batches.push([start, songs.length]);
  return { songs, batches, rules: { maxDurationMinutes: rules.maxDurationMinutes, instrument: rules.instrument, difficulty: rules.difficulty } };
}
async function boundedJson(response) {
  const maximum = 65536;
  try {
    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maximum) throw Error(); chunks.push(bytes); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    // Adapter fallback for controlled test transports; Electron supplies a body.
    const value = await response.json();
    if (Buffer.byteLength(JSON.stringify(value)) > maximum) throw Error();
    return value;
  } catch { throw shareError('SHARE_RESPONSE_INVALID'); }
}
function publicSummary(data) {
  if (!plain(data)) throw shareError('SHARE_RESPONSE_INVALID');
  if (data.library === null) return { url: null, count: 0, updatedAt: null };
  const library = data.library;
  if (!plain(library) || typeof library.token !== 'string' || !/^[a-f0-9]{64}$/.test(library.token)
    || !Number.isInteger(library.count) || library.count < 0 || library.count > MAX_SONGS
    || typeof library.updatedAt !== 'string' || !Number.isFinite(Date.parse(library.updatedAt))) throw shareError('SHARE_RESPONSE_INVALID');
  return { url: ORIGIN + '/song-requests.html?library=' + library.token, count: library.count, updatedAt: library.updatedAt };
}
function createSongRequestSharing({ fetcher, readAccount, generation = () => 0 } = {}) {
  if (typeof fetcher !== 'function' || typeof readAccount !== 'function') throw shareError('SHARE_UNAVAILABLE');
  async function capture() {
    const before = generation(), user = await readAccount();
    if (before !== generation()) throw shareError('SHARE_ACCOUNT_CHANGED');
    if (!user?.id) throw shareError('SHARE_ACCOUNT_REQUIRED');
    if (user.emailVerified !== true) throw shareError('SHARE_ACCOUNT_UNVERIFIED');
    return Object.freeze({ generation: before, userId: user.id });
  }
  const checkpoint = options => {
    if (options?.signal?.aborted) throw shareError('SHARE_CANCELLED');
    if (options?.isCurrent && !options.isCurrent()) throw shareError('SHARE_LIBRARY_CHANGED');
  };
  async function request(method, suffix = '', payload, captured, options) {
    checkpoint(options);
    const current = await capture();
    if (captured && (captured.generation !== current.generation || captured.userId !== current.userId)) throw shareError('SHARE_ACCOUNT_CHANGED');
    checkpoint(options);
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body && Buffer.byteLength(body, 'utf8') > BATCH_BYTES) throw shareError('SHARE_METADATA_LIMIT');
    let response;
    try {
      const timeout = AbortSignal.timeout(30000), signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      response = await fetcher(route + suffix, { method, credentials: 'include', redirect: 'error', cache: 'no-store', signal,
        headers: { Origin: ORIGIN, 'X-ChartsHub-Account-Id': current.userId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }) });
    } catch { checkpoint(options); throw shareError('SHARE_NETWORK'); }
    checkpoint(options);
    if (generation() !== current.generation) throw shareError('SHARE_ACCOUNT_CHANGED');
    if (!response.ok) {
      const codes = { 401: 'SHARE_ACCOUNT_REQUIRED', 403: 'SHARE_ACCESS_DENIED', 404: 'SHARE_SERVER_UPDATE_REQUIRED', 405: 'SHARE_SERVER_UPDATE_REQUIRED', 409: 'SHARE_UPLOAD_CONFLICT', 410: 'SHARE_UPLOAD_CONFLICT', 413: 'SHARE_METADATA_LIMIT', 429: 'SHARE_RATE_LIMIT' };
      throw shareError(codes[response.status] ?? 'SHARE_UNAVAILABLE');
    }
    const data = await boundedJson(response), after = await capture();
    checkpoint(options);
    if (after.generation !== current.generation || after.userId !== current.userId) throw shareError('SHARE_ACCOUNT_CHANGED');
    return data;
  }
  function uploadState(data, count, received, batches, id) {
    const upload = data?.upload;
    if (!plain(upload) || typeof upload.id !== 'string' || !UUID.test(upload.id) || (id && upload.id !== id)
      || upload.count !== count || upload.received !== received || upload.batches !== batches
      || upload.batchSize !== BATCH_SIZE || upload.maxBatchBytes !== BATCH_BYTES
      || typeof upload.expiresAt !== 'string' || !Number.isFinite(Date.parse(upload.expiresAt)) || Date.parse(upload.expiresAt) <= Date.now()) throw shareError('SHARE_RESPONSE_INVALID');
    return upload.id;
  }
  async function publish(payload, context, options = {}) {
    checkpoint(options);
    const captured = context ?? await capture(), prepared = normalizePayload(payload);
    let id = null;
    const progress = (phase, processed) => { checkpoint(options); try { options.onProgress?.({ phase, processed, total: prepared.songs.length }); } catch { checkpoint(options); } };
    try {
      progress('uploading', 0);
      const opened = await request('POST', '/uploads', { count: prepared.songs.length, rules: prepared.rules }, captured, options);
      id = uploadState(opened, prepared.songs.length, 0, 0);
      for (const [index, [start, end]] of prepared.batches.entries()) {
        const data = await request('PUT', `/uploads/${id}/batches/${index}`, { songs: prepared.songs.slice(start, end) }, captured, options);
        uploadState(data, prepared.songs.length, end, index + 1, id); progress('uploading', end);
      }
      // This guard includes the host library revision/rules and account identity.
      progress('committing', prepared.songs.length);
      const committed = await request('POST', `/uploads/${id}/commit`, {}, captured, options), result = publicSummary(committed);
      if (!result.url || result.count !== prepared.songs.length || committed.library?.revision !== id) throw shareError('SHARE_RESPONSE_INVALID');
      return result;
    } catch (failure) {
      // Removing an unfinished stage cannot revoke the previous published link.
      // A changed account cannot send cleanup requests under the new identity.
      if (id) { try { await request('DELETE', `/uploads/${id}`, undefined, captured); } catch {} }
      throw failure;
    }
  }
  return { capture, status: async () => publicSummary(await request('GET')), publish,
    remove: async (context, options) => publicSummary(await request('DELETE', '', undefined, context, options)) };
}
module.exports = { createSongRequestSharing };
