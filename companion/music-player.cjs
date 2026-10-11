'use strict';
const { randomBytes, randomInt } = require('node:crypto');
const { DEFAULT_APPEARANCE, validateAppearance } = require('./music-player-preferences.cjs');
const SCHEME = 'chartshub-companion:';
const MEDIA = /^\/music-media\/([a-f0-9]{64})\/(0|[1-9][0-9]?)$/;
const ARTWORK = /^\/music-artwork\/([a-f0-9]{64})$/;
const VIDEO = /^\/music-video\/([a-f0-9]{64})$/;
const secret = () => randomBytes(32).toString('hex');
const META = ['id', 'title', 'artist', 'charter', 'album', 'year', 'genre', 'durationMs', 'tracks', 'mediaMode', 'videoUnavailable', 'videoStartTimeMs'];

/** One audio owner; panel and floating window control the same session. */
function createMusicPlayer({ library, onChange, onAction, preferences, randomIndex = randomInt, respond = (...args) => require('./library-media.cjs').mediaResponse(...args) } = {}) {
  let revision = 0, generation = 0, disposed = false, loading = false, plan = null;
  let mediaToken = null, artworkToken = null, videoToken = null, playing = false, currentTime = 0, duration = 0, volume = .7, error = null, widgetEnabled = false;
  let videoEnabled = true;
  let appearance = { ...DEFAULT_APPEARANCE }, appearanceCanWrite = true, preferencesError = null;
  let shuffle = preferences?.shuffle === true, playlists = structuredClone(preferences?.playlists ?? []);
  let queue = [], queueRoot = null, activePlaylistId = null, queueSource = '';
  let playIntent = false, playbackEpoch = 0, queueReshuffle = false;
  let songLookup = new Map(), lookupRoot = null, lookupRevision = -1;
  if (preferences) { appearance = validateAppearance(preferences.appearance); videoEnabled = preferences.videoEnabled; volume = preferences.volume; appearanceCanWrite = preferences.canWrite; preferencesError = preferences.error; }
  const readers = new Set();
  const index = () => library.matchingSnapshot();
  const ready = () => !disposed && library.status().status === 'ready' && !!index().rootKey;
  const current = () => !!plan && ready() && plan.rootKey === index().rootKey && plan.revision === index().revision;
  function songsById() {
    const document = index();
    if (document.rootKey !== lookupRoot || document.revision !== lookupRevision) { songLookup = new Map(document.items.map(item => [item.id, item])); lookupRoot = document.rootKey; lookupRevision = document.revision; }
    return songLookup;
  }
  const orderedSongs = () => [...index().items].sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true, sensitivity: 'base' }) || a.artist.localeCompare(b.artist, 'en') || a.id.localeCompare(b.id));
  const playlistSongs = id => id === null ? orderedSongs().map(item => item.id) : playlists.find(list => list.id === id && list.rootKey === index().rootKey)?.songIds ?? [];
  const shuffleIds = ids => {
    const result = [...ids];
    for (let position = result.length - 1; position > 0; position--) { const other = randomIndex(position + 1); [result[position], result[other]] = [result[other], result[position]]; }
    return result;
  };
  function clearQueue() { queue = []; queueRoot = null; activePlaylistId = null; queueSource = ''; queueReshuffle = false; }
  function rebuildQueue(ids) {
    const position = plan ? queue.indexOf(plan.id) : -1;
    const prefix = position >= 0 ? queue.slice(0, position + 1) : plan ? [plan.id] : [];
    const known = songsById(), played = new Set(prefix);
    const remaining = ids.filter(id => known.has(id) && !played.has(id));
    queue = [...prefix, ...(shuffle ? shuffleIds(remaining) : remaining)]; queueRoot = index().rootKey; queueSource = JSON.stringify(ids); queueReshuffle = false;
  }
  function changed() { try { onChange?.(); } catch {} }
  function action(name, value) { try { onAction?.({ revision, epoch: playbackEpoch, action: name, ...(value === undefined ? {} : { value }) }); } catch {} }
  function revoke() { for (const reader of readers) reader.abort(); readers.clear(); mediaToken = artworkToken = videoToken = null; }
  function clear(code = null) {
    generation++; revision++; playbackEpoch++; revoke(); plan = null; loading = false; playing = false; playIntent = false; currentTime = duration = 0; error = code; clearQueue();
    changed();
  }
  function libraryChanged() {
    if ((plan || loading) && (!ready() || (plan && !current()))) clear('unavailable');
  }
  function snapshot({ engine = false } = {}) {
    const available = ready();
    let selection = null;
    if (plan) {
      selection = Object.fromEntries(META.filter(key => plan[key] !== undefined).map(key => [key, structuredClone(plan[key])]));
      selection.artworkUrl = plan.artwork && artworkToken ? `chartshub-companion://app/music-artwork/${artworkToken}` : null;
      selection.videoUrl = plan.video && videoToken ? `chartshub-companion://app/music-video/${videoToken}` : null;
      if (engine) selection.mediaUrls = plan.media.map((entry, i) => ({ name: entry.name, url: `chartshub-companion://app/music-media/${mediaToken}/${i}` }));
    }
    const navigation = available && !loading && index().items.length > 1 && !!selection;
    const position = plan ? queue.indexOf(plan.id) : -1, queued = queue.length > 0 && queueRoot === index().rootKey;
    const known = songsById();
    const lists = playlists.filter(list => list.rootKey === index().rootKey).map(list => ({ id: list.id, name: list.name, songIds: [...list.songIds],
      items: list.songIds.map(id => ({ id, title: known.get(id)?.title ?? '', artist: known.get(id)?.artist ?? '', available: known.has(id) })) }));
    return { revision, available, selection, loading, playing, currentTime, duration, volume, error, widgetEnabled, videoEnabled, appearance: { ...appearance }, appearanceCanWrite, preferencesError,
      shuffle, playlists: lists, activePlaylistId, playbackEpoch, queuePosition: queued ? position + 1 : 0, queueLength: queued ? queue.length : 0,
      canPrevious: queued ? available && !loading && position > 0 : navigation, canNext: queued ? available && !loading && position >= 0 && position < queue.length - 1 : navigation };
  }
  async function select(id, { fromQueue = false } = {}) {
    if (disposed || !ready()) return { ok: false, code: 'unavailable' };
    if (!fromQueue) clearQueue();
    const startIndex = index(), ticket = ++generation;
    revision++; playbackEpoch++; revoke(); plan = null; loading = true; playing = false; playIntent = true; currentTime = duration = 0; error = null; changed();
    try {
      const resolved = await library.resolvePlaybackSong(id);
      if (disposed || ticket !== generation || !ready() || startIndex.rootKey !== index().rootKey || startIndex.revision !== index().revision
          || resolved.rootKey !== startIndex.rootKey || resolved.revision !== startIndex.revision) return { ok: false, code: 'unavailable' };
      if (!Array.isArray(resolved.media) || !resolved.media.length || resolved.media.length > 20) throw Error('Invalid media plan');
      plan = resolved; mediaToken = secret(); artworkToken = plan.artwork ? secret() : null; videoToken = plan.video ? secret() : null; loading = false;
      if (!fromQueue && shuffle) rebuildQueue(orderedSongs().map(item => item.id));
      else if (fromQueue && queue.length && queueRoot === index().rootKey && (queueReshuffle || JSON.stringify(playlistSongs(activePlaylistId)) !== queueSource)) rebuildQueue(playlistSongs(activePlaylistId));
      duration = Number.isSafeInteger(plan.durationMs) && plan.durationMs > 0 ? Math.min(86400, plan.durationMs / 1000) : 0;
      changed(); if (playIntent) action('play'); return { ok: true };
    } catch (failure) {
      if (ticket === generation && !disposed) { loading = false; playIntent = false; error = failure?.code === 'LIBRARY_MEDIA_UNSUPPORTED' ? 'unsupported' : 'unavailable'; changed(); }
      return { ok: false, code: error || 'unavailable' };
    } finally {
      if (ticket === generation && loading) { loading = false; error = 'unavailable'; changed(); }
    }
  }
  async function control(name, value) {
    if (disposed) return { ok: false, code: 'unavailable' };
    if (loading && name === 'stop') { clear(); return { ok: true }; }
    if (loading && name === 'pause') { playbackEpoch++; playIntent = false; playing = false; action('pause'); changed(); return { ok: true }; }
    if (name === 'volume') {
      if (!Number.isFinite(value) || value < 0 || value > 1) return { ok: false };
      volume = value; action(name, value); changed(); return { ok: true };
    }
    if (['next', 'previous'].includes(name)) {
      if (!current() || loading) return { ok: false, code: 'unavailable' };
      if (queue.length && queueRoot === index().rootKey) {
        const position = queue.indexOf(plan.id), next = position + (name === 'next' ? 1 : -1);
        if (position < 0 || next < 0 || next >= queue.length) return { ok: false, code: 'unavailable' };
        return select(queue[next], { fromQueue: true });
      }
      const songs = orderedSongs();
      const position = songs.findIndex(item => item.id === plan.id);
      if (position < 0 || songs.length < 2) return { ok: false, code: 'unavailable' };
      return select(songs[(position + (name === 'next' ? 1 : songs.length - 1)) % songs.length].id);
    }
    if (!current() || loading) { libraryChanged(); return { ok: false, code: 'unavailable' }; }
    if (name === 'seek') {
      if (!Number.isFinite(value) || value < 0 || value > 86400) return { ok: false };
      playbackEpoch++; currentTime = Math.min(value, duration || value); action(name, currentTime);
      if (duration > 0 && currentTime >= duration) playIntent = false;
    }
    else if (['play', 'pause', 'stop'].includes(name)) {
      if (name !== 'play') playing = false;
      playbackEpoch++;
      playIntent = name === 'play';
      if (name === 'stop') currentTime = 0;
      if (name === 'play') error = null;
      action(name);
    } else return { ok: false, code: 'unavailable' };
    changed(); return { ok: true };
  }
  function report(value) {
    if (!current() || value.revision !== revision || loading || typeof value.playing !== 'boolean'
        || ![value.currentTime, value.duration].every(n => Number.isFinite(n) && n >= 0 && n <= 86400)
        || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1
        || (value.errorCode !== undefined && !['unavailable', 'unsupported', 'playback'].includes(value.errorCode))) return { ok: false };
    playing = value.playing; duration = value.duration; currentTime = Math.min(value.currentTime, value.duration || value.currentTime); volume = value.volume;
    error = value.errorCode || null;
    if (error) { playing = false; playIntent = false; }
    changed(); return { ok: true };
  }
  function setWidget(enabled) { widgetEnabled = enabled; changed(); }
  function setVideo(enabled) { videoEnabled = enabled; changed(); }
  function applyPreferences(value) {
    const shuffleChanged = shuffle !== (value.shuffle === true);
    appearance = validateAppearance(value.appearance); videoEnabled = value.videoEnabled; volume = value.volume; appearanceCanWrite = value.canWrite; preferencesError = value.error;
    shuffle = value.shuffle === true; playlists = structuredClone(value.playlists ?? []);
    if (activePlaylistId && !playlists.some(list => list.id === activePlaylistId && list.rootKey === index().rootKey)) clearQueue();
    else if (loading && queue.length && shuffleChanged) queueReshuffle = true;
    else if (current() && (shuffleChanged || (activePlaylistId && queue.length && JSON.stringify(playlistSongs(activePlaylistId)) !== queueSource))) rebuildQueue(playlistSongs(activePlaylistId));
    action('volume',volume); changed();
  }
  async function playPlaylist(id) {
    if (!ready() || (id !== null && !playlists.some(list => list.id === id && list.rootKey === index().rootKey))) return { ok: false, code: 'unavailable' };
    const known = songsById(), ids = playlistSongs(id).filter(song => known.has(song));
    if (!ids.length) return { ok: false, code: 'unavailable' };
    activePlaylistId = id; queue = shuffle ? shuffleIds(ids) : [...ids]; queueRoot = index().rootKey; queueSource = JSON.stringify(playlistSongs(id));
    return select(queue[0], { fromQueue: true });
  }
  async function ended(value) {
    if (!current() || loading || !playIntent || value.revision !== revision || value.epoch !== playbackEpoch) return { ok: false };
    playIntent = false; playing = false; currentTime = duration; changed();
    if (queueRoot === index().rootKey && queue.indexOf(plan.id) >= 0 && queue.indexOf(plan.id) < queue.length - 1) return control('next');
    return { ok: true };
  }
  function acceptSpectrum(value) { return current() && value.revision === revision && Array.isArray(value.bands)
    && value.bands.length === 32 && value.bands.every(n => Number.isFinite(n) && n >= 0 && n <= 1); }
  async function serve(request) {
    let url;
    try { url = new URL(request.url); } catch { return null; }
    if (url.protocol !== SCHEME || url.hostname !== 'app' || url.port || url.username || url.password || url.search || url.hash) return null;
    const media = MEDIA.exec(url.pathname), artwork = ARTWORK.exec(url.pathname), video = VIDEO.exec(url.pathname);
    if (!media && !artwork && !video) return null;
    if (!['GET', 'HEAD'].includes(request.method) || !current()) return new Response('Not found', { status: 404 });
    const entry = media ? media[1] === mediaToken ? plan.media[Number(media[2])] : null
      : artwork ? artwork[1] === artworkToken ? plan.artwork : null : video[1] === videoToken ? plan.video : null;
    if (!entry) return new Response('Not found', { status: 404 });
    const selectedPlan = plan, controller = new AbortController(); readers.add(controller);
    const abort = () => controller.abort(); request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) controller.abort();
    try {
      return await respond(entry, request, { signal: controller.signal, isAllowed: () => selectedPlan === plan && current(), onClose: () => {
        readers.delete(controller); request.signal?.removeEventListener('abort', abort);
      } });
    } catch { readers.delete(controller); request.signal?.removeEventListener('abort', abort); return new Response('Not found', { status: 404 }); }
  }
  function stop() { clear(); widgetEnabled = false; changed(); }
  function dispose() { disposed = true; stop(); }
  return { snapshot, select, control, report, setWidget, setVideo, applyPreferences, playPlaylist, ended, serve, libraryChanged, stop, dispose, acceptSpectrum };
}
module.exports = { createMusicPlayer };
