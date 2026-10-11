'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDocument, tick } = require('./floating-panel-dom.cjs');
const id = character => character.repeat(64);
const song = character => ({ id: id(character), title: `Song ${character}`, artist: 'Artist', charter: 'Creator', album: 'Album', year: 2026, genre: 'Rock' });
const initial = () => ({ player: { revision: 1, available: true, selection: null, playing: false, currentTime: 0, duration: 0, volume: .7, widgetEnabled: false, error: null, videoEnabled: true, canPrevious: false, canNext: false } });
async function fixture(t, { compact = false, handler } = {}) {
  const { LocalMusicPlayerControls } = await import('../companion/dist/settings/LocalMusicPlayerControls.js');
  const document = createDocument(), create = document.createElement.bind(document), drawing = [];
  document.createElement = tag => {
    const element = create(tag);
    if (tag === 'canvas') element.getContext = () => ({ clearRect: () => drawing.push('clear'), createLinearGradient: () => ({ addColorStop() {} }), fillRect: (...args) => drawing.push(['bar', ...args]), beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, stroke: () => drawing.push('stroke') });
    if (tag === 'video') { element.readyState = 4; element.duration = 100; element.currentTime = 0; element.paused = true; element.play = async () => { element.paused = false; element.plays = (element.plays || 0) + 1; }; element.pause = () => { element.paused = true; }; element.load = () => { element.loads = (element.loads || 0) + 1; }; }
    return element;
  };
  const root = document.createElement('main'), calls = [];
  const ui = new LocalMusicPlayerControls({ root, compact, command: async (name, payload) => {
    calls.push({ name, payload });
    if (handler) return handler(name, payload);
    if (name === 'player.search') return { ok: true, result: { items: [song('a'), song('b')], total: 2, offset: payload.offset, limit: 50 } };
    return { ok: true };
  } });
  t.after(() => ui.dispose()); const get = name => root.querySelector('#local-player-' + name);
  return { ui, root, document, get, calls, drawing };
}

test('local player lists installed titles but never starts playback or opens a widget automatically', async t => {
  const f = await fixture(t); assert.equal(f.calls.length, 0);
  assert.equal(f.get('play').disabled, true);
  f.ui.update(initial()); await tick();
  assert.deepEqual(f.calls.map(call => call.name), ['player.search']);
  assert.equal(f.get('results').children.length, 2);
  f.get('results').children[1].querySelector('button').click(); await tick();
  assert.deepEqual(f.calls.at(-1), { name: 'player.select', payload: { id: id('b') } });
  f.get('widget').click(); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.widget', payload: { enabled: true } });
});

test('local player displays literal metadata, validated local artwork and a fallback on failure', async t => {
  const f = await fixture(t), state = initial();
  state.player.selection = { ...song('a'), title: '<img src=x onerror=bad()>', album: '<script>bad()</script>', artworkUrl: 'https://untrusted.invalid/art.png' };
  f.ui.update(state); await tick();
  assert.equal(f.get('title').textContent, state.player.selection.title); assert.ok(f.get('details').textContent.includes('<script>bad()</script>'));
  assert.equal(f.get('artwork').hidden, true); assert.equal(f.get('placeholder').hidden, false);
  state.player.selection.artworkUrl = 'chartshub-companion://app/music-artwork/' + id('a'); f.ui.update(state);
  assert.equal(f.get('artwork').src, state.player.selection.artworkUrl);
  f.get('artwork').dispatchEvent(new Event('error')); assert.equal(f.get('artwork').hidden, true); assert.equal(f.get('placeholder').hidden, false);
});

test('local player navigation, seek and volume target the shared owner; main creates no audio element', async t => {
  const f = await fixture(t), state = initial(); state.player = { ...state.player, selection: song('a'), duration: 180, currentTime: 12, canPrevious: true, canNext: true };
  f.ui.update(state); await tick();
  for (const action of ['play', 'previous', 'next', 'stop']) { f.get(action).click(); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.control', payload: { action } }); }
  for (const [action, value] of [['seek', 48], ['volume', .2]]) { f.get(action).value = String(value); f.get(action).dispatchEvent(new Event('change')); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.control', payload: { action, value } }); }
  const count = f.calls.length; f.get('seek').value = '181'; f.get('seek').dispatchEvent(new Event('change')); assert.equal(f.calls.length, count);
  assert.equal(f.root.querySelectorAll('audio').length, 0); assert.equal(f.get('current-time').textContent, '0:12');
});

test('native range focus and the latest keyboard value survive slow acknowledgements and progress snapshots', async t => {
  for (const action of ['seek', 'volume']) await t.test(action, async t => {
    const replies = [];
    const f = await fixture(t, { handler: (name) => name === 'player.control' ? new Promise(resolve => replies.push(resolve)) : { ok: true, result: { items: [], total: 0, offset: 0, limit: 50 } } });
    const state = initial(); state.player = { ...state.player, selection: song('a'), duration: 180, currentTime: 12 };
    f.ui.update(state); await tick(); const range = f.get(action); let disabled = range.disabled;
    Object.defineProperty(range, 'disabled', { get: () => disabled, set: value => { disabled = value; if (value && f.document.activeElement === range) f.document.activeElement = null; } });
    range.focus();
    const change = value => { range.value = String(value); range.dispatchEvent(new Event('input')); range.dispatchEvent(new Event('change')); };
    change(.1); change(.2); change(.3);
    assert.equal(range.disabled, false); assert.equal(f.document.activeElement, range, 'Chromium must never blur this range during its own command');
    assert.equal(f.calls.filter(call => call.name === 'player.control').length, 1, 'intermediate changes are coalesced while awaiting the first command');
    f.ui.update(state); assert.equal(range.value, '0.3', 'a progress snapshot cannot undo a newer keyboard value');
    assert.equal(f.get('play').disabled, true, 'unrelated transport actions remain guarded');
    state.player[action === 'seek' ? 'currentTime' : 'volume'] = .1; f.ui.update(state); replies.shift()({ ok: true }); await tick();
    assert.deepEqual(f.calls.at(-1), { name: 'player.control', payload: { action, value: .3 } });
    assert.equal(f.document.activeElement, range); assert.equal(range.value, '0.3');
    state.player[action === 'seek' ? 'currentTime' : 'volume'] = .3; f.ui.update(state); replies.shift()({ ok: true }); await tick();
    assert.equal(f.document.activeElement, range); assert.equal(range.disabled, false); assert.equal(range.value, '0.3'); assert.equal(f.get('play').disabled, false);
  });
});

test('a queued range update is discarded when the song selection changes', async t => {
  let resolve;
  const f = await fixture(t, { handler: name => name === 'player.control' ? new Promise(done => { resolve = done; }) : { ok: true, result: { items: [], total: 0, offset: 0, limit: 50 } } });
  const state = initial(); state.player = { ...state.player, selection: song('a'), duration: 180 };
  f.ui.update(state); await tick();
  for (const value of [4, 7]) { f.get('seek').value = String(value); f.get('seek').dispatchEvent(new Event('change')); }
  f.ui.update({ player: { ...state.player, revision: 2, selection: song('b'), currentTime: 0 } });
  resolve({ ok: true }); await tick();
  assert.equal(f.calls.filter(call => call.name === 'player.control').length, 1, 'the old song seek is never sent to its replacement');
  assert.equal(f.get('seek').value, '0');
});

test('library loss clears local player results and invalidates an in-flight search', async t => {
  let resolve; const f = await fixture(t, { handler: () => new Promise(done => { resolve = done; }) });
  f.ui.update(initial()); const state = initial(); state.player.available = false; f.ui.update(state);
  resolve({ ok: true, result: { items: [song('a')], total: 1, offset: 0, limit: 50 } }); await tick();
  assert.equal(f.get('results').children.length, 0); assert.equal(f.get('query').disabled, true);
  f.get('widget').click(); assert.equal(f.calls.length, 1);
});

test('search pagination appends 50 songs and preserves exact selected identity', async t => {
  const songs = Array.from({ length: 51 }, (_, index) => ({ ...song('a'), id: index.toString(16).padStart(64, '0'), title: `Fixture ${index}` }));
  const f = await fixture(t, { handler: async (name, payload) => name === 'player.search' ? ({ ok: true, result: { items: songs.slice(payload.offset, payload.offset + 50), total: 51, offset: payload.offset, limit: 50 } }) : ({ ok: true }) });
  f.ui.update(initial()); await tick(); assert.equal(f.get('results').children.length, 50); assert.equal(f.get('more').hidden, false);
  f.get('more').click(); await tick(); assert.equal(f.get('results').children.length, 51); assert.equal(f.get('more').hidden, true);
  f.get('results').children[50].querySelector('button').click(); await tick(); assert.deepEqual(f.calls.at(-1).payload, { id: songs[50].id });
});

test('both player surfaces translate labels without translating song names; closing only hides the widget', async t => {
  const f = await fixture(t, { compact: true }), state = initial(); state.player.selection = { ...song('a'), title: 'Lecture en cours' };
  f.ui.update(state); await tick(); f.document.documentElement.lang = 'en'; f.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.equal(f.get('heading-title').textContent, 'Songs player'); assert.equal(f.get('title').textContent, 'Lecture en cours');
  assert.equal(f.get('play').getAttribute('aria-label'), 'Play');
  f.get('widget').click(); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.widget', payload: { enabled: false } });
  assert.equal(f.calls.some(call => call.name === 'player.control'), false);
});

test('video remains muted, synchronizes offsets, releases when disabled and falls back without pausing audio', async t => {
  const f = await fixture(t), state = initial(); state.player = { ...state.player, selection: { ...song('a'), videoUrl: 'chartshub-companion://app/music-video/' + id('b'), videoStartTimeMs: -3000 }, currentTime: 2, duration: 100, playing: true };
  f.ui.update(state); await tick(); const video = f.get('video');
  assert.equal(video.muted, true); assert.equal(video.paused, true, 'negative offset waits before video begins');
  state.player.currentTime = 8; f.ui.update(state); await tick(); assert.equal(video.currentTime, 5); assert.equal(video.paused, false);
  video.dispatchEvent(new Event('error')); assert.equal(f.get('cover').hidden, false); assert.equal(video.hidden, true);
  assert.equal(f.calls.some(call => call.name === 'player.control'), false, 'video error does not stop audio');
  state.player.videoEnabled = false; f.ui.update(state); assert.equal(video.src, ''); assert.equal(video.paused, true);
  f.get('video-enabled').checked = true; f.get('video-enabled').dispatchEvent(new Event('change')); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.video', payload: { enabled: true } });
});

test('spectrum uses validated current measured bands for all styles, clears on pause and rejects stale frames', async t => {
  const f = await fixture(t), state = initial(); state.player.playing = true;
  for (const model of ['bars', 'curve', 'circle', 'mirror']) {
    state.player.appearance = { backgroundColor: '#0b1322', textColor: '#eaf2ff', accentColor: '#22d3ee', secondaryColor: '#a855f7', spectrumModel: model };
    f.ui.update(state); f.drawing.length = 0; f.ui.spectrum({ revision: 1, bands: Array(32).fill(.5) });
    assert.ok(f.drawing.some(entry => Array.isArray(entry) || entry === 'stroke'), model + ' renders actual magnitudes');
  }
  f.drawing.length = 0; f.ui.spectrum({ revision: 0, bands: Array(32).fill(.5) }); f.ui.spectrum({ revision: 1, bands: Array(32).fill(NaN) }); assert.equal(f.drawing.length, 0);
  state.player.playing = false; f.ui.update(state); assert.equal(f.drawing.at(-1), 'clear');
});

test('appearance is explicit and sends exactly the four colors plus selected model', async t => {
  const f = await fixture(t); f.ui.update(initial()); await tick();
  const input = f.get('color-accentColor'); input.value = '#ff9911'; input.dispatchEvent(new Event('input'));
  f.ui.update(initial()); assert.equal(input.value, '#ff9911', 'reports preserve the draft');
  f.get('spectrum-model').value = 'mirror'; f.get('spectrum-model').dispatchEvent(new Event('change'));
  assert.equal(f.calls.length, 1); f.get('appearance-form').dispatchEvent(new Event('submit', { cancelable: true })); await tick();
  assert.deepEqual(f.calls.at(-1), { name: 'player.appearance', payload: { appearance: { backgroundColor: '#0b1322', textColor: '#eaf2ff', accentColor: '#ff9911', secondaryColor: '#a855f7', spectrumModel: 'mirror' } } });
});

test('library filters are an explicit combined search with the documented audio and format values', async t => {
  const f = await fixture(t); f.ui.update(initial()); await tick();
  f.get('query').value = 'Live';
  const filters = { artist: 'Björk', charter: 'Creator', album: 'Debut', year: '1993', audio: 'present', format: 'chart', genre: 'Alternative', instrument: 'drums', difficulty: 'expert' };
  for (const [name, value] of Object.entries(filters)) f.get('filter-' + name).value = value;
  assert.equal(f.calls.length, 1); f.get('search-form').dispatchEvent(new Event('submit', { cancelable: true })); await tick();
  assert.deepEqual(f.calls.at(-1), { name: 'player.search', payload: { query: 'Live', offset: 0, limit: 50, filters } });
});

test('genre and parsed track pairs are shown literally and translated without inventing unavailable combinations', async t => {
  const f = await fixture(t), state = initial(); state.player.selection = { ...song('a'), genre: '<b>Post-Rock</b>', tracks: [{ instrument: 'guitar', difficulty: 'easy' }, { instrument: 'drums', difficulty: 'expert' }] };
  f.ui.update(state); await tick();
  assert.ok(f.get('details').textContent.includes('<b>Post-Rock</b>')); assert.ok(f.get('details').textContent.includes('Guitare · Facile / Batterie · Expert'));
  assert.equal(f.get('details').textContent.includes('Batterie · Facile'), false);
  f.document.documentElement.lang = 'en'; f.document.defaultView.dispatchEvent(new Event('chartshub:languagechange'));
  assert.ok(f.get('details').textContent.includes('Guitar · Easy / Drums · Expert')); assert.equal(f.get('filter-instrument-pro-drums').textContent, 'Pro Drums');
  assert.equal(f.get('filter-difficulty-label').textContent, 'Difficulty');
});

test('protected preference errors remain generic and prevent overwriting the original appearance', async t => {
  const f = await fixture(t), state = initial(); state.player.appearanceCanWrite = false; state.player.preferencesError = 'C:\\private\\profile\\settings.json';
  f.ui.update(state); await tick(); assert.equal(f.get('appearance-save').disabled, true);
  const count = f.calls.length; f.get('appearance-form').dispatchEvent(new Event('submit', { cancelable: true })); assert.equal(f.calls.length, count);
  assert.equal(f.get('error').hidden, false); assert.equal(f.get('error').textContent.includes('C:'), false);
  assert.equal(f.get('widget').disabled, false, 'read-only preference failure does not prevent opening playback');
});

const playlist = (members = []) => ({ id: '12345678-1234-4123-8123-123456789abc', name: '<img> Set local', songIds: members.map(item => item.id), items: members });
const choosePlaylist = (f, value) => { f.get('playlist-select').value = value; f.get('playlist-select').dispatchEvent(new Event('change')); };

test('choosing a playlist never starts playback; explicit play and shuffle target shared queue controls', async t => {
  const f = await fixture(t), state = initial(), list = playlist([{ ...song('a'), available: true }]); state.player.playlists = [list];
  f.ui.update(state); await tick(); const before = f.calls.length; choosePlaylist(f, list.id);
  assert.equal(f.calls.length, before); assert.equal(f.get('playlist-play').disabled, false);
  assert.equal(f.get('playlist-name').value, list.name); assert.ok(f.get('playlist-select').textContent.includes('<img> Set local'));
  f.get('playlist-play').click(); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.playPlaylist', payload: { id: list.id } });
  choosePlaylist(f, ''); f.get('playlist-play').click(); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.playPlaylist', payload: { id: null } });
  f.get('shuffle').checked = true; f.get('shuffle').dispatchEvent(new Event('change')); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.shuffle', payload: { enabled: true } });
  state.player = { ...state.player, activePlaylistId: list.id, queuePosition: 2, queueLength: 2, shuffle: true }; f.ui.update(state);
  assert.equal(f.get('queue-status').textContent, '<img> Set local · 2 / 2'); assert.equal(f.get('shuffle').checked, true);
});

test('adding and removing playlist songs uses opaque IDs, prevents duplicate additions and labels missing entries honestly', async t => {
  const f = await fixture(t), state = initial(), list = playlist(); state.player.playlists = [list]; f.ui.update(state); await tick(); choosePlaylist(f, list.id);
  f.root.querySelector('.local-player-add-playlist').click(); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.playlistAdd', payload: { id: list.id, songId: id('a') } });
  list.songIds = [id('a')]; list.items = [{ ...song('a'), available: false }]; f.ui.update(state);
  assert.equal(f.root.querySelector('.local-player-add-playlist').disabled, true); assert.equal(f.get('playlist-play').disabled, true);
  assert.ok(f.get('playlist-items').textContent.includes('Morceau indisponible')); assert.equal(f.get('playlist-items').textContent.includes(id('a')), false);
  f.get('playlist-items').querySelector('button').click(); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.playlistRemove', payload: { id: list.id, songId: id('a') } });
});

test('playlist create, rename and delete are explicit with validated names, and creation selects without playing', async t => {
  const state = initial(), list = playlist(); let f;
  f = await fixture(t, { handler: async (name, payload) => {
    if (name === 'player.search') return { ok: true, result: { items: [], total: 0, offset: 0, limit: 50 } };
    if (name === 'player.playlistCreate') { list.name = payload.name; state.player.playlists = [list]; f.ui.update(state); return { ok: true, playlistId: list.id }; }
    return { ok: true };
  } }); f.ui.update(state); await tick();
  assert.equal(f.get('playlist-create').disabled, true);
  f.get('playlist-name').value = '  New Set  '; f.get('playlist-name').dispatchEvent(new Event('input')); f.get('playlist-create').click(); await tick();
  assert.deepEqual(f.calls.at(-1), { name: 'player.playlistCreate', payload: { name: 'New Set' } }); assert.equal(f.get('playlist-select').value, list.id);
  assert.equal(f.calls.some(call => call.name === 'player.playPlaylist' || call.name === 'player.select'), false);
  f.get('playlist-name').value = 'Renamed'; f.get('playlist-name').dispatchEvent(new Event('input')); f.get('playlist-rename').click(); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.playlistRename', payload: { id: list.id, name: 'Renamed' } });
  f.get('playlist-name').value = 'bad\nname'; f.get('playlist-name').dispatchEvent(new Event('input')); assert.equal(f.get('playlist-rename').disabled, true);
  f.get('playlist-delete').click(); await tick(); assert.deepEqual(f.calls.at(-1), { name: 'player.playlistDelete', payload: { id: list.id } }); assert.equal(f.get('playlist-select').value, '');
});
