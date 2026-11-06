'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { createSyncCandidateResolver } = require('../companion/catalogue-sync-candidates.cjs');
const rootPath = path.resolve('Synthetic-Songs');
function fixture() {
  let snapshot = { rootKey: 'a'.repeat(64), revision: 1, items: [{ id: '1', title: 'Signal', artist: 'Artiste Démo', charter: 'Charter Démo' }] }, root = rootPath;
  const calls = [];
  const options = { getSnapshot: () => snapshot, getRoot: () => root, resolveFolder: async id => { calls.push(id); return path.join(rootPath, 'Pack', 'Signal'); } };
  return { options, calls, resolve: createSyncCandidateResolver(options), setSnapshot: value => { snapshot = value; }, setRoot: value => { root = value; }, snapshot: () => snapshot };
}
test('existing nested chart is only a candidate for later full-file verification, with no Songs scan', async () => {
  const f = fixture(), descriptor = { title: 'Signal', artist: 'Artiste Démo', charter: 'Charter Démo' };
  assert.deepEqual(await f.resolve({ descriptor, rootPath }), { candidateFolder: 'Pack/Signal' }); assert.deepEqual(f.calls, ['1']);
  assert.equal(await f.resolve({ descriptor: { title: 'Autre', artist: 'Autre' }, rootPath }), null); assert.equal(f.calls.length, 1);
});
test('ambiguous versions, another root and index changes during resolution cannot authorize adoption', async () => {
  const f = fixture(), descriptor = { title: 'Signal', artist: 'Artiste Démo' };
  f.setSnapshot({ ...f.snapshot(), items: [...f.snapshot().items, { ...f.snapshot().items[0], id: '2' }] });
  assert.deepEqual(await f.resolve({ descriptor, rootPath }), { conflict: true }); assert.equal(f.calls.length, 0);
  f.setRoot(path.join(rootPath, 'Other')); assert.equal(await f.resolve({ descriptor, rootPath }), null);
  f.setRoot(rootPath); f.setSnapshot({ ...f.snapshot(), items: [f.snapshot().items[0]] });
  f.options.resolveFolder = async () => { f.setSnapshot({ ...f.snapshot(), revision: 2 }); return path.join(rootPath, 'Pack', 'Signal'); };
  const resolving = createSyncCandidateResolver(f.options); assert.deepEqual(await resolving({ descriptor, rootPath }), { conflict: true });
});
test('candidate lookup indexes100000 metadata rows once and resolves only matching IDs', async () => {
  const f = fixture(); f.setSnapshot({ rootKey: 'a'.repeat(64), revision: 1, items: Array.from({ length: 100000 }, (_, i) => ({ id: String(i), title: 'Signal ' + i, artist: 'Artiste Démo', charter: 'Charter Démo' })) });
  for (let i = 0; i < 100; i++) assert.deepEqual(await f.resolve({ descriptor: { title: 'Signal ' + i, artist: 'Artiste Démo' }, rootPath }), { candidateFolder: 'Pack/Signal' });
  assert.equal(f.calls.length, 100);
});
