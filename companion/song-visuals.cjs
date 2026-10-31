'use strict';
const { randomBytes } = require('node:crypto');
const { mediaResponse } = require('./library-media.cjs');
const secret = () => randomBytes(32).toString('hex');
const text = value => typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) ? value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';
const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Main process only: scanned file plans never leave this service. The browser
 * receives capabilities for one active chart, never paths or the song index. */
function createSongVisuals({ library, onChange, now = Date.now, respond = mediaResponse } = {}) {
  let desired = false, key = '', selectionKey = secret(), generation = 0, mediaKey = null, plan = null, task = null;
  let state = 'disabled', song = null, phase = 'idle', clock = null, clockAt = 0, clockSignature = '', candidates = [], selected = null;
  let lookupIndex = null, lookup = new Map(), decoderErrors = { background: false, video: false };
  const readers = new Set();
  const index = () => library.matchingSnapshot();
  const ready = () => desired && library.status().status === 'ready' && !!index().rootKey;
  const current = () => !!plan && ready() && plan.rootKey === index().rootKey && plan.revision === index().revision && ['playing', 'paused'].includes(phase);
  function changed() { try { onChange?.(); } catch {} }
  function revoke() { for (const reader of readers) reader.abort(); readers.clear(); mediaKey = null; plan = null; decoderErrors = { background: false, video: false }; }
  function clear(next) { generation++; revoke(); task = null; state = next; candidates = []; selected = null; selectionKey = secret(); }
  function matching(metadata) {
    const document = index();
    if (lookupIndex !== document) {
      lookup = new Map(); lookupIndex = document;
      for (const row of document.items) {
        const group = JSON.stringify([text(row.title), text(row.artist)]);
        if (!lookup.has(group)) lookup.set(group, []);
        lookup.get(group).push(row);
      }
    }
    const rows = lookup.get(JSON.stringify([text(metadata.title), text(metadata.artist)])) || [];
    const charter = text(metadata.charter);
    return charter ? rows.filter(row => text(row.charter) === charter) : rows;
  }
  async function resolve(id) {
    const ticket = ++generation, document = index(); revoke(); selected = id; state = 'loading'; changed();
    const operation = Promise.resolve().then(async () => {
      try {
        const result = await library.resolveVisualSong(id);
        if (ticket !== generation || !ready() || document !== index() || result.rootKey !== document.rootKey || result.revision !== document.revision) return;
        plan = result; mediaKey = secret(); state = 'ready'; changed();
      } catch (error) {
        if (ticket === generation) { state = error?.code === 'LIBRARY_MEDIA_UNSUPPORTED' ? 'unsupported' : 'unavailable'; changed(); }
      } finally { if (task === operation) task = null; }
    });
    task = operation; return operation;
  }
  function update(input) {
    const active = input?.live === true && ['playing', 'paused'].includes(input.phase);
    phase = active ? input.phase : 'idle';
    song = active && text(input.song?.title) && text(input.song?.artist) ? { title: input.song.title, artist: input.song.artist, charter: input.song.charter || '' } : null;
    const c = input?.clock;
    // Legacy clocks omit speed. They still support progress widgets, but cannot
    // safely drive video: the song may be running at a non-default game speed.
    clock = active && c && Number.isFinite(c.positionSeconds) && c.positionSeconds >= -60 && c.positionSeconds <= 86400
      && Number.isFinite(c.durationSeconds) && c.durationSeconds >= 0 && c.durationSeconds <= 86400
      && c.positionSeconds <= c.durationSeconds + 5 && Number.isFinite(c.speed) && c.speed >= .01 && c.speed <= 10
      ? { positionSeconds: c.positionSeconds, durationSeconds: c.durationSeconds, speed: c.speed } : null;
    const signature = JSON.stringify([phase, clock, song]);
    if (signature !== clockSignature) { clockAt = now(); clockSignature = signature; }
    const document = index(), next = JSON.stringify([desired, library.status().status, document.rootKey, document.revision, song ? [text(song.title), text(song.artist), text(song.charter)] : null]);
    if (next === key) return task;
    key = next; clear(!desired ? 'disabled' : !ready() ? 'library' : !song ? 'waiting' : 'searching');
    if (!desired || !ready() || !song) { changed(); return null; }
    const matches = matching(song);
    candidates = matches.slice(0, 20).map(row => ({ id: row.id, title: row.title, artist: row.artist, charter: row.charter }));
    if (matches.length === 1 && text(song.charter)) return resolve(matches[0].id);
    state = matches.length ? 'ambiguous' : 'missing'; changed(); return null;
  }
  function setEnabled(enabled) { if (typeof enabled !== 'boolean') throw Error('Invalid visual state'); desired = enabled; key = ''; if (!enabled) { clear('disabled'); changed(); } }
  function select(value) {
    if (!ready() || !song || value?.selectionKey !== selectionKey || !validId(value.id) || !candidates.some(row => row.id === value.id)) throw Error('Le morceau ou la bibliothèque a changé.');
    return resolve(value.id);
  }
  function snapshot() {
    return { state, selectionKey, candidates: candidates.map(row => ({ ...row })), selected,
      title: song?.title || null, hasBackground: !!(current() && plan.background), hasVideo: !!(current() && plan.video),
      backgroundReason: current() ? decoderErrors.background ? 'decoder' : plan.backgroundUnavailable : null, videoReason: current() ? decoderErrors.video ? 'decoder' : plan.videoUnavailable : null, clockReady: !!clock && (phase === 'paused' || now() - clockAt <= 2500) };
  }
  function browserSnapshot() {
    const available = current(), timed = available && clock && (phase === 'paused' || now() - clockAt <= 2500);
    return { generation: available ? mediaKey : null, background: available && !!plan.background && !decoderErrors.background,
      video: !!(timed && plan.video && !decoderErrors.video), phase: available ? phase : 'idle',
      clock: timed ? { ...clock, positionSeconds: clock.positionSeconds + (phase === 'playing' ? Math.max(0, now() - clockAt) / 1000 * clock.speed : 0) } : null,
      videoStartTimeMs: available && Number.isSafeInteger(plan.videoStartTimeMs) ? plan.videoStartTimeMs : 0 };
  }
  function reportError(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
      || Object.keys(value).some(key => !['kind','generation','code'].includes(key)) || !['background','video'].includes(value.kind)
      || value.code !== 'decode' || !validId(value.generation) || value.generation !== mediaKey || !current() || !plan[value.kind]) return false;
    decoderErrors[value.kind] = true; changed(); return true;
  }
  async function serve(kind, capability, request) {
    if (!['background', 'video'].includes(kind) || !validId(capability) || capability !== mediaKey || !current() || !plan[kind]) return new Response(null, { status: 404 });
    if (readers.size >= 8) return new Response(null, { status: 503 });
    const ticket = generation, controller = new AbortController(); readers.add(controller);
    return respond(plan[kind], request, { signal: controller.signal,
      isAllowed: () => generation === ticket && capability === mediaKey && current(), onClose: () => readers.delete(controller) });
  }
    function stop() { desired = false; key = ''; song = null; clock = null; clockSignature = ''; phase = 'idle'; clear('disabled'); }
  return { update, setEnabled, select, snapshot, browserSnapshot, serve, reportError, stop };
}
module.exports = { createSongVisuals };
