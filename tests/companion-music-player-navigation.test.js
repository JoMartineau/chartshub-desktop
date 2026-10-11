'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMusicPlayer } = require('../companion/music-player.cjs');

function fixture() {
  const raw = ['Song 10', 'song 2', 'Écho', 'echo', 'Alpha', 'Song 1'].map((title, i) => ({
    id: i.toString(16).padStart(64, '0'), title, artist: i % 2 ? 'Élodie' : 'Artist', charter: 'Creator'
  }));
  let reads = 0;
  const items = raw.map(item => Object.defineProperty({ ...item }, 'title', { enumerable: true, get() { reads++; return item.title; } }));
  let document = { rootKey: 'root-A', revision: 1, items };
  const library = { status: () => ({ status: 'ready' }), matchingSnapshot: () => document,
    resolvePlaybackSong: async id => ({ ...raw.find(item => item.id === id), rootKey: document.rootKey, revision: document.revision, media: [{ name: 'song.wav' }] }) };
  const expected = [...raw].sort((a,b) => a.title.localeCompare(b.title, 'en', { numeric: true, sensitivity: 'base' }) || a.artist.localeCompare(b.artist, 'en') || a.id.localeCompare(b.id));
  return { raw, expected, player: createMusicPlayer({ library }), reads: () => reads, resetReads: () => { reads = 0; },
    replace: value => { document = { ...document, ...value }; } };
}

test('Next preserves natural accented ordering and reuses it across navigation and reports', async () => {
  const f = fixture();
  await f.player.select(f.expected[0].id);
  await f.player.control('next');
  assert.equal(f.player.snapshot().selection.id, f.expected[1].id);
  assert.ok(f.reads() > 0, 'the first navigation must establish the order');
  f.resetReads();
  for (let i = 2; i < f.expected.length; i++) {
    await f.player.control('next');
    const state = f.player.snapshot();
    assert.equal(state.selection.id, f.expected[i].id);
    assert.equal(f.player.report({ revision: state.revision, epoch: state.playbackEpoch, playing: true, currentTime: 0, duration: 60, volume: .7 }).ok, true);
  }
  await f.player.control('next');
  assert.equal(f.player.snapshot().selection.id, f.expected[0].id, 'ordinary library navigation still wraps');
  await f.player.control('previous');
  assert.equal(f.player.snapshot().selection.id, f.expected.at(-1).id);
  assert.equal(f.reads(), 0, 'later Next/Previous and progress never compare every title again');
});

test('navigation rebuilds its order after a scan revision or a Songs root change', async () => {
  const f = fixture();
  await f.player.select(f.expected[0].id); await f.player.control('next');
  for (const replacement of [{ revision: 2 }, { rootKey: 'root-B' }]) {
    const oldUrl = f.player.snapshot({ engine: true }).selection.mediaUrls[0].url;
    f.replace(replacement); f.player.libraryChanged();
    assert.equal(f.player.snapshot().selection, null);
    assert.equal((await f.player.serve(new Request(oldUrl))).status, 404);
    await f.player.select(f.expected[0].id); f.resetReads();
    await f.player.control('next');
    assert.equal(f.player.snapshot().selection.id, f.expected[1].id);
    assert.ok(f.reads() > 0, 'the replacement index must not reuse the previous cached order');
    f.resetReads(); await f.player.control('next');
    assert.equal(f.reads(), 0);
  }
});
