'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { queryMusicLibrary, DEFAULT_FILTERS } = require('../companion/music-library-query.cjs');
const { INSTRUMENTS, DIFFICULTIES } = require('../companion/song-requests.cjs');
const song = (id, changes = {}) => ({ id: id.repeat(64), title: 'Été', artist: 'Björk', charter: 'Créateur', album: 'Océan', year: '2026', format: 'chart', audio: 'present', ...changes });
function fixture() {
  return { revision: 7, items: [song('a', { genre: 'Métal progressif', tracks: [{ instrument: 'guitar', difficulty: 'easy' }, { instrument: 'drums', difficulty: 'expert' }], relativePath: 'PRIVATE/notes.chart', signature: 'PRIVATE', musicMetadataVersion: 1 }),
    song('b', { title: 'Inconnu', artist: 'Autre' }), song('c', { title: 'Été 2', genre: 'Rock', tracks: [] })] };
}

test('genre combines with existing filters and free search using accent-insensitive actual metadata', () => {
  const document = fixture();
  const result = queryMusicLibrary(document, { query: 'metal ete createur', filters: { genre: 'progressif', artist: 'bjork', album: 'ocean', year: '2026', audio: 'present', format: 'chart' } });
  assert.equal(result.total, 1); assert.equal(result.items[0].genre, 'Métal progressif'); assert.equal(result.revision, 7);
  assert.equal(queryMusicLibrary(document, { query: '', filters: { genre: 'Rock' } }).total, 1);
  assert.equal(queryMusicLibrary(document, { query: '', filters: { genre: 'Inconnu' } }).total, 0, 'missing genre is not inferred from song title');
  assert.equal(queryMusicLibrary(document, { query: '', filters: { genre: '' } }).total, 3);
});

test('instrument and difficulty must match the same known track, never two different instruments', () => {
  const document = fixture();
  assert.equal(queryMusicLibrary(document, { query: '', filters: { instrument: 'drums', difficulty: 'easy' } }).total, 0);
  assert.equal(queryMusicLibrary(document, { query: '', filters: { instrument: 'drums', difficulty: 'expert' } }).total, 1);
  assert.equal(queryMusicLibrary(document, { query: '', filters: { instrument: 'guitar', difficulty: 'easy', genre: 'metal' } }).total, 1);
  assert.equal(queryMusicLibrary(document, { query: '', filters: { instrument: 'guitar', difficulty: 'expert' } }).total, 0);
  assert.equal(queryMusicLibrary(document, { query: '', filters: { instrument: 'all', difficulty: 'expert' } }).total, 1);
  assert.equal(queryMusicLibrary(document, { query: '', filters: { instrument: 'drums', difficulty: 'all' } }).total, 1);
  assert.equal(queryMusicLibrary(document, { query: '' }).total, 3, 'unknown tracks remain visible when no track rule is active');
});

test('core instruments and difficulties are accepted; invalid types, values and extra filter keys are refused', () => {
  const document = fixture();
  assert.equal(Object.keys(DEFAULT_FILTERS).length, 9);
  for (const instrument of INSTRUMENTS) assert.doesNotThrow(() => queryMusicLibrary(document, { query: '', filters: { instrument } }));
  for (const difficulty of DIFFICULTIES) assert.doesNotThrow(() => queryMusicLibrary(document, { query: '', filters: { difficulty } }));
  for (const filters of [{ genre: null }, { genre: 'x'.repeat(201) }, { genre: 'metal\nrock' }, { instrument: 'Guitar' }, { instrument: null },
    { instrument: 'path/outside' }, { difficulty: 'Expert' }, { difficulty: null }, { difficulty: 'all', maxDuration: 5 }]) assert.throws(() => queryMusicLibrary(document, { query: '', filters }));
});

test('filtered pagination remains stable and metadata projection excludes private fields without sharing track objects', () => {
  const document = fixture(), original = structuredClone(document);
  const first = queryMusicLibrary(document, { query: '', limit: 1 }), second = queryMusicLibrary(document, { query: '', offset: 1, limit: 1 });
  assert.equal(first.total, 3); assert.equal(second.total, 3); assert.notEqual(first.items[0].id, second.items[0].id);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|signature|relativePath|musicMetadataVersion/);
  first.items[0].tracks[0].difficulty = 'expert'; first.items[0].genre = 'Invented';
  assert.deepEqual(document, original); assert.equal(queryMusicLibrary(document, { query: '', filters: { instrument: 'guitar', difficulty: 'expert' } }).total, 0);
});
