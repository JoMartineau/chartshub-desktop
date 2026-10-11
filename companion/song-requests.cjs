'use strict';

const { randomUUID } = require('node:crypto');

const PLATFORMS = Object.freeze(['twitch', 'tiktok', 'youtube']);
const INSTRUMENTS = Object.freeze(['all', 'guitar', 'bass', 'drums', 'pro-drums', 'keys', 'vocals',
  'rhythm', 'guitar-coop', 'guitar-6fret', 'bass-6fret', 'rhythm-6fret', 'guitar-coop-6fret']);
const DIFFICULTIES = Object.freeze(['all', 'easy', 'medium', 'hard', 'expert']);
const DEFAULT_RULES = Object.freeze({ maxDurationMinutes: null, instrument: 'all', difficulty: 'all' });
const LIMITS = Object.freeze({
  active: 50, activePerViewer: 2, history: 200, search: 10, queryLength: 200,
  cooldownMs: 30_000, attemptWindowMs: 60_000, attemptsPerViewer: 5, attemptsGlobal: 60,
  trackedViewers: 1000, trackedEvents: 1000, votesPerSong: 1000, eventLifetimeMs: 600_000
});
const SONG_ID = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const active = item => item.status === 'pending' || item.status === 'accepted';
const failure = code => ({ ok: false, code });

function text(value, maximum = 512) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, maximum)
    : '';
}
function token(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
}
function source(input) {
  if (!input || typeof input !== 'object' || !PLATFORMS.includes(input.platform)
      || !token(input.eventId) || !token(input.viewerId)) return null;
  if (typeof input.viewerName !== 'string' || input.viewerName.length > 256
      || (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > LIMITS.queryLength))) return null;
  const viewerName = text(input.viewerName, 80);
  if (!viewerName) return null;
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (input.songId !== undefined && (typeof input.songId !== 'string' || !SONG_ID.test(input.songId))) return null;
  if (input.songId === undefined && (!query || query.length > LIMITS.queryLength)) return null;
  return { platform: input.platform, eventId: input.eventId, viewerId: input.viewerId,
    viewerName, query, songId: input.songId,
    viewerKey: JSON.stringify([input.platform, input.viewerId]),
    eventKey: JSON.stringify([input.platform, input.eventId]) };
}
function parseCommand(query) {
  if (/^!queue$/i.test(query)) return { type: 'queue' };
  if (/^!song$/i.test(query)) return { type: 'song' };
  const match = /^!(sr|vote)\s+(.+)$/i.exec(query);
  if (!match) return null;
  const type = match[1].toLowerCase() === 'vote' ? 'vote' : 'request';
  if (match[2].startsWith('id:')) {
    const id = match[2].slice(3);
    return SONG_ID.test(id) ? { type, songId: id } : null;
  }
  return { type, query: match[2] };
}
function validateRules(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || !Object.keys(input).every(key => Object.hasOwn(DEFAULT_RULES, key))) throw new TypeError('Invalid song-request rules.');
  const rules = { ...DEFAULT_RULES, ...input };
  if ((rules.maxDurationMinutes !== null && (!Number.isSafeInteger(rules.maxDurationMinutes)
      || rules.maxDurationMinutes < 1 || rules.maxDurationMinutes > 60))
      || !INSTRUMENTS.includes(rules.instrument) || !DIFFICULTIES.includes(rules.difficulty)) {
    throw new TypeError('Invalid song-request rules.');
  }
  return rules;
}
function checkRules(metadata, rules) {
  if (rules.maxDurationMinutes !== null) {
    if (!Number.isSafeInteger(metadata.durationMs) || metadata.durationMs <= 0) return 'metadata_unknown';
    if (metadata.durationMs > rules.maxDurationMinutes * 60_000) return 'duration_limit';
  }
  if (rules.instrument !== 'all' || rules.difficulty !== 'all') {
    if (!Array.isArray(metadata.tracks)) return 'metadata_unknown';
    let tracks = metadata.tracks;
    if (rules.instrument !== 'all') {
      const selected = tracks.filter(track => track && track.instrument === rules.instrument);
      if (!selected.length) {
        return tracks.some(track => !track || !INSTRUMENTS.slice(1).includes(track.instrument))
          ? 'metadata_unknown' : 'instrument_unavailable';
      }
      tracks = selected;
    }
    if (rules.difficulty !== 'all' && !tracks.some(track => track && INSTRUMENTS.slice(1).includes(track.instrument)
        && track.difficulty === rules.difficulty)) {
      return tracks.some(track => !track || !INSTRUMENTS.slice(1).includes(track.instrument)
        || !DIFFICULTIES.slice(1).includes(track.difficulty))
        ? 'metadata_unknown' : 'difficulty_unavailable';
    }
  }
  return null;
}
function publicSong(song) {
  return { id: song.id, title: text(song.title), artist: text(song.artist), charter: text(song.charter) };
}
function publicRequest(item) {
  return { id: item.id, songId: item.song.id, platform: item.platform, viewerName: item.viewerName,
    title: item.song.title, artist: item.song.artist, status: item.status, votes: item.votes,
    requestedAt: item.requestedAt, acceptedAt: item.acceptedAt, closedAt: item.closedAt };
}

/**
 * Platform-neutral, in-memory queue. Only a trusted chat adapter may call receive:
 * platform/eventId/viewerId must come from the authenticated provider event, never
 * the command text. This module opens no listener and makes no network/file writes.
 *
 * getLibrarySnapshot(): synchronous {rootKey, revision, items}, compatible with
 * library.matchingSnapshot(). rootKey is private; IDs are library opaque hashes.
 * searchSongs({query,offset,limit}): {items,total,revision}, compatible with query().
 * resolveSong(id,{rootKey,revision}): verifies the current installed chart inside
 * Songs (including the actual notes file), then returns metadata with that ID.
 * A directory-only existence check is insufficient for this callback.
 * Neither search results nor queue snapshots forward callback objects or paths.
 * Optional rules consume durationMs and tracks[{instrument,difficulty}] from the
 * resolver; absent metadata never passes an active rule. getNowPlaying may return
 * state:'exported' to distinguish retained native export metadata from playing.
 * The queue/history and explicit manual ordering last only for this session.
 */
function createSongRequests({ getLibrarySnapshot, searchSongs, resolveSong, getNowPlaying, onChange, now = Date.now } = {}) {
  if (typeof getLibrarySnapshot !== 'function' || typeof searchSongs !== 'function'
      || typeof resolveSong !== 'function' || typeof now !== 'function') {
    throw new TypeError('Song requests require installed-library callbacks.');
  }
  let enabled = false, generation = 0, revision = 0, lastTime = 0, serial = Promise.resolve();
  let rules = { ...DEFAULT_RULES }, sequence = 0, manualOrder = null;
  const requests = [], viewers = new Map(), events = new Map(), attempts = [];
  function time() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid song-request clock.');
    return (lastTime = Math.max(lastTime, value));
  }
  function library() {
    const value = getLibrarySnapshot();
    if (!value || typeof value.rootKey !== 'string' || !SONG_ID.test(value.rootKey) || !Number.isSafeInteger(value.revision)
        || value.revision < 0 || !Array.isArray(value.items)) throw Error('library_unavailable');
    return { rootKey: value.rootKey, revision: value.revision, items: value.items };
  }
  function sameLibrary(before) {
    const after = library();
    return before.rootKey === after.rootKey && before.revision === after.revision;
  }
  function indexedSong(context, id) {
    const value = context.items.find(item => item && item.id === id);
    return value && typeof value.id === 'string' && SONG_ID.test(value.id) ? publicSong(value) : null;
  }
  function ranked() {
    const queued = requests.filter(active);
    if (manualOrder !== null) {
      const positions = new Map(manualOrder.map((id, index) => [id, index]));
      return queued.sort((left, right) => (positions.get(left.id) ?? Infinity) - (positions.get(right.id) ?? Infinity)
        || left.sequence - right.sequence);
    }
    return queued.sort((left, right) => right.votes - left.votes
      || left.requestedAt - right.requestedAt || left.sequence - right.sequence);
  }
  function snapshot() {
    const ordered = [...ranked(), ...requests.filter(item => !active(item)).reverse()];
    return { enabled, revision, order: manualOrder === null ? 'votes' : 'manual',
      rules: { ...rules }, requests: ordered.map(publicRequest), limits: { ...LIMITS } };
  }
  function changed() {
    revision++;
    try {
      if (typeof onChange === 'function') Promise.resolve(onChange(snapshot())).catch(() => {});
    } catch { /* A UI observer cannot undo a transition. */ }
  }
  function configure(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || !Object.keys(options).length || !Object.keys(options).every(key => key === 'enabled' || key === 'rules')
        || (options.enabled !== undefined && typeof options.enabled !== 'boolean')) {
      throw new TypeError('An explicit enabled preference or session rules are required.');
    }
    if (options.rules !== undefined && (!options.rules || typeof options.rules !== 'object' || Array.isArray(options.rules))) {
      throw new TypeError('Invalid song-request rules.');
    }
    const nextRules = options.rules === undefined ? rules : validateRules({ ...rules, ...options.rules });
    const nextEnabled = options.enabled === undefined ? enabled : options.enabled;
    const different = JSON.stringify(nextRules) !== JSON.stringify(rules) || nextEnabled !== enabled;
    if (nextEnabled !== enabled) generation++;
    enabled = nextEnabled; rules = nextRules;
    if (different) changed();
    return snapshot();
  }
  function enqueue(operation) {
    const result = serial.then(operation, operation);
    serial = result.catch(() => {});
    return result;
  }
  function guard(capturedGeneration) {
    return enabled && generation === capturedGeneration;
  }
  async function find(query, limit, context) {
    const result = await searchSongs({ query, offset: 0, limit });
    if (!sameLibrary(context) || !result || result.revision !== context.revision
        || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0) {
      throw Error('library_changed');
    }
    const songs = [], ids = new Set();
    for (const item of result.items.slice(0, limit)) {
      if (!item || typeof item.id !== 'string' || !SONG_ID.test(item.id) || ids.has(item.id)) continue;
      const song = indexedSong(context, item.id);
      if (song) { ids.add(item.id); songs.push(song); }
    }
    return { songs, total: result.total };
  }
  async function search(options) {
    if (!enabled) return failure('disabled');
    if (!options || typeof options.query !== 'string' || !options.query.trim()
        || options.query.trim().length > LIMITS.queryLength) return failure('invalid_query');
    const query = options.query.trim(), capturedGeneration = generation;
    const limit = options.limit === undefined ? LIMITS.search : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.search) return failure('invalid_query');
    try {
      const context = library(), result = await find(query, limit, context);
      if (!guard(capturedGeneration)) return failure('disabled');
      return { ok: true, items: result.songs, total: result.total };
    } catch { return failure('library_unavailable'); }
  }
  function prune(clock) {
    for (const [key, stamp] of events) if (clock - stamp >= LIMITS.eventLifetimeMs) events.delete(key);
    for (const [key, value] of viewers) {
      if (clock - value.lastTouched >= LIMITS.eventLifetimeMs) viewers.delete(key);
    }
    while (attempts.length && clock - attempts[0] >= LIMITS.attemptWindowMs) attempts.shift();
  }
  function reserve(event, clock) {
    prune(clock);
    if (events.has(event.eventKey)) return 'duplicate_event';
    let viewer = viewers.get(event.viewerKey);
    if (!viewer && viewers.size >= LIMITS.trackedViewers) return 'rate_limited';
    if (events.size >= LIMITS.trackedEvents || attempts.length >= LIMITS.attemptsGlobal) return 'rate_limited';
    if (!viewer) { viewer = { attempts: [], lastAcceptedAt: null, lastTouched: clock }; viewers.set(event.viewerKey, viewer); }
    viewer.attempts = viewer.attempts.filter(stamp => clock - stamp < LIMITS.attemptWindowMs);
    viewer.lastTouched = clock;
    if (viewer.attempts.length >= LIMITS.attemptsPerViewer) return 'rate_limited';
    viewer.attempts.push(clock); attempts.push(clock); events.set(event.eventKey, clock);
    return null;
  }
  async function resolve(id, context) {
    if (!indexedSong(context, id)) throw Error('song_unavailable');
    const value = await resolveSong(id, { rootKey: context.rootKey, revision: context.revision });
    if (!sameLibrary(context)) throw Error('library_changed');
    if (!value || value.id !== id) throw Error('song_unavailable');
    // Authoritative display metadata comes from the local index, not chat text.
    const metadata = { durationMs: value.durationMs,
      tracks: Array.isArray(value.tracks) && value.tracks.length <= 64
        ? value.tracks.map(track => track && ({ instrument: track.instrument, difficulty: track.difficulty })) : undefined };
    return { song: indexedSong(context, id), metadata };
  }
  function finishResolve(resolved, context) {
    // The nested await above creates another scheduling boundary. Recheck scope
    // and the latest rules immediately before committing a request or acceptance.
    if (!sameLibrary(context)) throw Error('library_changed');
    const blocked = checkRules(resolved.metadata, rules);
    if (blocked) throw Error(blocked);
    return resolved.song;
  }
  function receive(input) {
    if (!enabled) return Promise.resolve(failure('disabled'));
    const event = source(input);
    if (!event) return Promise.resolve(failure('invalid_request'));
    const command = event.songId ? { type: 'request', songId: event.songId } : parseCommand(event.query);
    if (!command) return Promise.resolve(failure('invalid_command'));
    const clock = time(), capturedGeneration = generation, reservation = reserve(event, clock);
    if (reservation) return Promise.resolve(failure(reservation));
    // Reserve before awaiting callbacks so simultaneous arrivals cannot bypass limits.
    return enqueue(async () => {
      if (!guard(capturedGeneration)) return failure('disabled');
      if (command.type === 'queue') {
        const queue = ranked(), position = queue.findIndex(item => item.voters.has(event.viewerKey));
        return { ok: true, command: 'queue', items: queue.slice(0, 5).map(publicRequest), position: position < 0 ? null : position + 1 };
      }
      if (command.type === 'song') {
        let value;
        try { value = typeof getNowPlaying === 'function' ? await getNowPlaying() : null; } catch { return failure('not_playing'); }
        if (!guard(capturedGeneration)) return failure('disabled');
        if (!value || !['playing', 'exported'].includes(value.state) || !text(value.title)) return failure('not_playing');
        const song = { title: text(value.title), artist: text(value.artist), charter: text(value.charter) };
        if (value.state === 'exported') song.exported = true;
        return { ok: true, command: 'song', song };
      }
      const currentTime = time(), viewer = viewers.get(event.viewerKey);
      let context, songId = command.songId;
      try {
        context = library();
        if (!songId) {
          const matches = await find(command.query, LIMITS.search, context);
          if (!guard(capturedGeneration)) return failure('disabled');
          if (!matches.songs.length) return failure('not_found');
          if (matches.total !== 1 || matches.songs.length !== 1) return { ...failure('ambiguous'), matches: matches.songs };
          songId = matches.songs[0].id;
        }
        const existing = requests.find(item => active(item) && item.scopeKey === context.rootKey && item.song.id === songId);
        if (command.type === 'vote' && !existing) return failure('not_queued');
        if (existing && existing.voters.has(event.viewerKey)) return failure('duplicate_vote');
        if (existing && existing.voters.size >= LIMITS.votesPerSong) return failure('vote_limit');
        if (!existing) {
          if (requests.filter(item => active(item) && item.viewerKey === event.viewerKey).length >= LIMITS.activePerViewer) return failure('viewer_limit');
          if (viewer && viewer.lastAcceptedAt !== null && currentTime - viewer.lastAcceptedAt < LIMITS.cooldownMs) return failure('cooldown');
          if (requests.filter(active).length >= LIMITS.active) return failure('queue_full');
        }
        const resolved = await resolve(songId, context);
        if (!guard(capturedGeneration)) return failure('disabled');
        const song = finishResolve(resolved, context);
        if (existing) {
          existing.song = song; existing.voters.add(event.viewerKey); existing.votes++;
          changed();
          return { ok: true, action: 'vote', request: publicRequest(existing) };
        }
        const requestedAt = time();
        const item = { id: randomUUID(), song, scopeKey: context.rootKey,
          platform: event.platform, eventId: event.eventId, viewerId: event.viewerId,
          viewerKey: event.viewerKey, viewerName: event.viewerName, status: 'pending',
          votes: 1, voters: new Set([event.viewerKey]), sequence: sequence++,
          requestedAt, acceptedAt: null, closedAt: null };
        requests.push(item);
        if (manualOrder !== null) manualOrder.push(item.id);
        const latestViewer = viewers.get(event.viewerKey);
        if (latestViewer) latestViewer.lastAcceptedAt = requestedAt;
        changed();
        return { ok: true, action: 'request', request: publicRequest(item) };
      } catch (error) {
        const code = error && error.message;
        return failure(['song_unavailable', 'library_changed', 'metadata_unknown', 'duration_limit',
          'instrument_unavailable', 'difficulty_unavailable'].includes(code) ? code : 'library_unavailable');
      }
    });
  }
  function transition(id, target) {
    if (typeof id !== 'string' || !REQUEST_ID.test(id)) return Promise.resolve(failure('invalid_request'));
    return enqueue(async () => {
      const item = requests.find(value => value.id === id);
      if (!item) return failure('not_found');
      if ((target === 'accepted' && item.status !== 'pending')
          || (target === 'played' && item.status !== 'accepted')
          || (target === 'rejected' && !active(item))) return failure('invalid_transition');
      if (target === 'accepted') {
        try {
          const context = library();
          if (item.scopeKey !== context.rootKey) return failure('song_unavailable');
          const resolved = await resolve(item.song.id, context);
          item.song = finishResolve(resolved, context);
        } catch (error) {
          return failure(['metadata_unknown', 'duration_limit', 'instrument_unavailable', 'difficulty_unavailable']
            .includes(error && error.message) ? error.message : 'song_unavailable');
        }
      }
      item.status = target;
      if (target === 'accepted') item.acceptedAt = time();
      else { item.closedAt = time(); item.voters.clear(); }
      if (manualOrder !== null && !active(item)) manualOrder = manualOrder.filter(value => value !== id);
      // Prune only completed requests. The installed library is never changed.
      while (requests.filter(value => !active(value)).length > LIMITS.history) {
        requests.splice(requests.findIndex(value => !active(value)), 1);
      }
      changed();
      return { ok: true, request: publicRequest(item) };
    });
  }
  function move(id, options) {
    if (typeof id !== 'string' || !REQUEST_ID.test(id) || !options
        || !['up', 'down'].includes(options.direction)) return Promise.resolve(failure('invalid_request'));
    const direction = options.direction;
    return enqueue(() => {
      const queued = ranked(), index = queued.findIndex(item => item.id === id);
      if (index < 0) return failure(requests.some(item => item.id === id) ? 'invalid_transition' : 'not_found');
      const target = index + (direction === 'up' ? -1 : 1);
      if (target < 0 || target >= queued.length) return { ok: true, moved: false, request: publicRequest(queued[index]) };
      const nextOrder = queued.map(item => item.id);
      [nextOrder[index], nextOrder[target]] = [nextOrder[target], nextOrder[index]];
      manualOrder = nextOrder;
      changed();
      return { ok: true, moved: true, request: publicRequest(queued[index]) };
    });
  }
  function resetOrder() {
    return enqueue(() => {
      if (manualOrder !== null) { manualOrder = null; changed(); }
      return { ok: true };
    });
  }
  return { configure, snapshot, search, receive,
    accept: id => transition(id, 'accepted'), reject: id => transition(id, 'rejected'),
    played: id => transition(id, 'played'), move, resetOrder };
}

module.exports = { createSongRequests, LIMITS, PLATFORMS, INSTRUMENTS, DIFFICULTIES, DEFAULT_RULES, parseCommand };
