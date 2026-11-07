'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { createSyncCandidateResolver, MAX_CANDIDATES } = require('../companion/catalogue-sync-candidates.cjs');
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
test('lists the exact charter first and retains other versions for later byte verification', async () => {
  const f = fixture(), descriptor = { title: 'Signal', artist: 'Artiste Démo', charter: 'Autre charter' };
  f.setSnapshot({ ...f.snapshot(), items: [...f.snapshot().items, { ...f.snapshot().items[0], id: '2', charter: 'Autre Charter' }] });
  f.options.resolveFolder = async id => { f.calls.push(id); return path.join(rootPath, 'Pack', 'Signal ' + id); };
  const resolve = createSyncCandidateResolver(f.options);
  assert.deepEqual(await resolve({ descriptor, rootPath }), { candidateFolders: ['Pack/Signal 2', 'Pack/Signal 1'] });
  assert.deepEqual(f.calls, ['2', '1']);
});
test('another root and index changes during resolution cannot authorize adoption', async () => {
  const f = fixture(), descriptor = { title: 'Signal', artist: 'Artiste Démo' };
  f.setRoot(path.join(rootPath, 'Other')); assert.equal(await f.resolve({ descriptor, rootPath }), null);
  f.setRoot(rootPath);
  f.options.resolveFolder = async () => { f.setSnapshot({ ...f.snapshot(), revision: 2 }); return path.join(rootPath, 'Pack', 'Signal'); };
  const resolving = createSyncCandidateResolver(f.options); assert.deepEqual(await resolving({ descriptor, rootPath }), { conflict: true });
});
test('rejects unsafe and inaccessible folders and deduplicates multiple local entries in one folder', async () => {
  const f = fixture(), descriptor = { title: 'Signal', artist: 'Artiste Démo' };
  const row = f.snapshot().items[0];
  f.setSnapshot({ ...f.snapshot(), items: ['outside', 'hidden', 'root', 'failed', 'first', 'duplicate'].map(id => ({ ...row, id })) });
  f.options.resolveFolder = async id => {
    if (id === 'outside') return path.resolve(rootPath, '..', 'Outside');
    if (id === 'hidden') return path.join(rootPath, '.chartshub-stage', 'Copy');
    if (id === 'root') return rootPath;
    if (id === 'failed') throw Error('Fixture disappeared');
    return path.join(rootPath, 'Valid pack', 'Chart');
  };
  const resolve = createSyncCandidateResolver(f.options);
  assert.deepEqual(await resolve({ descriptor, rootPath }), { candidateFolders: ['Valid pack/Chart'], incomplete: true });
  f.setSnapshot({ ...f.snapshot(), items: [{ ...row, id: 'outside' }] });
  assert.deepEqual(await resolve({ descriptor, rootPath }), { conflict: true });
});
test('the limit counts checked candidates and keeps a later exact charter ahead of the first 32', async () => {
  const f = fixture(), row = f.snapshot().items[0], descriptor = { title: row.title, artist: row.artist, charter: 'Exact charter' };
  f.setSnapshot({ ...f.snapshot(), items: Array.from({ length: MAX_CANDIDATES + 4 }, (_, index) => ({
    ...row, id: String(index), charter: index === MAX_CANDIDATES + 2 ? descriptor.charter : row.charter
  })) });
  f.options.resolveFolder = async id => { f.calls.push(id); return path.join(rootPath, 'Pack', 'Signal ' + id); };
  const resolve = createSyncCandidateResolver(f.options), result = await resolve({ descriptor, rootPath });
  assert.equal(result.candidateFolders.length, MAX_CANDIDATES);
  assert.equal(result.candidateFolders[0], 'Pack/Signal ' + (MAX_CANDIDATES + 2));
  assert.equal(result.incomplete, true);
  assert.equal(f.calls.length, MAX_CANDIDATES);
});
test('abort after the first folder check stops candidate resolution', async () => {
  const f = fixture(), row = f.snapshot().items[0], controller = new AbortController();
  f.setSnapshot({ ...f.snapshot(), items: [row, { ...row, id: '2' }] });
  f.options.resolveFolder = async id => { f.calls.push(id); controller.abort(); return path.join(rootPath, 'Pack', 'Signal'); };
  const resolve = createSyncCandidateResolver(f.options);
  await assert.rejects(resolve({ descriptor: row, rootPath, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(f.calls, ['1']);
});
test('candidate lookup indexes100000 metadata rows once and resolves only matching IDs', async () => {
  const f = fixture(); f.setSnapshot({ rootKey: 'a'.repeat(64), revision: 1, items: Array.from({ length: 100000 }, (_, i) => ({ id: String(i), title: 'Signal ' + i, artist: 'Artiste Démo', charter: 'Charter Démo' })) });
  for (let i = 0; i < 100; i++) assert.deepEqual(await f.resolve({ descriptor: { title: 'Signal ' + i, artist: 'Artiste Démo' }, rootPath }), { candidateFolder: 'Pack/Signal' });
  assert.equal(f.calls.length, 100);
});
