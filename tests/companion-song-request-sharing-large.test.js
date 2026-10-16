'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { Module, createRequire } = require('node:module');
const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, count, onProgress) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-share-large-')), root = path.join(base, 'SyntheticEmptySongs');
  await fs.mkdir(root);
  let items = Array.from({ length: count }, (_, index) => {
    const folder = 'Song-' + index, relativePath = folder + '/notes.chart';
    return { id: digest(relativePath), relativePath, folderRelativePath: folder, title: 'Song ' + index, artist: 'Band', charter: 'Mapper', album: '', year: '', format: 'chart', audio: 'missing', signature: String(index), cleanupSnapshot: 'a'.repeat(64) };
  });
  const filename = require.resolve('../companion/library-service.cjs'), local = new Module(filename, module), normal = createRequire(filename), resolved = [];
  local.filename = filename; local.paths = Module._nodeModulePaths(path.dirname(filename));
  local.require = name => name === './library-scanner.cjs' ? { scanLibrary: async () => ({ items, warningCount: 0, skippedCount: 0 }) }
    : name === './chart-bundle.cjs' ? { captureBundleSnapshot: async () => 'a'.repeat(64) }
    : name === './song-request-library.cjs' ? { resolveInstalledSong: async (_root, item) => {
      resolved.push(item.id); return { id: item.id, title: item.title, artist: item.artist, charter: item.charter };
    } } : normal(name);
  local._compile(await fs.readFile(filename, 'utf8'), filename);
  const progress = [], service = local.exports.createInstalledLibraryService({ dataDirectory: path.join(base, 'Profile'), onChange: status => {
    if (status.sharingPreparation) { progress.push(status.sharingPreparation); onProgress?.(status.sharingPreparation, service); }
  } });
  t.after(async () => { await service.stop(); assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir())); await fs.rm(base, { recursive: true, force: true }); });
  await service.selectRoot(root);
  while (service.status().status === 'scanning') await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.status().status, 'ready');
  return { service, progress, resolved, items, replace: values => { items = values; } };
}

test('83,401 synthetic songs prepare completely with progress and refresh indexed metadata after a new revision', async t => {
  const f = await fixture(t, 83401), result = await f.service.requestLibraryForSharing();
  assert.equal(result.songs.length, 83401); assert.equal(result.unavailableCount, 0);
  assert.deepEqual(f.resolved, f.items.map(item => item.id));
  assert.equal(result.songs.at(-1).id, f.items.at(-1).id);
  assert.equal(Object.hasOwn(result.songs[0], 'relativePath'), false);
  assert.equal(f.progress[0].processed, 0); assert.equal(f.progress.at(-1).processed, 83401);
  assert.equal(f.progress.at(-1).available, 83401); assert.equal(f.progress.at(-1).total, 83401);
  assert.equal(f.service.status().sharingPreparation, null);
  const oldContext = f.service.matchingSnapshot();
  f.replace([{ ...f.items[0], title: 'Replacement metadata', signature: 'replacement' }]);
  f.service.requestScan('quick'); while (f.service.status().status === 'scanning') await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(f.service.resolveRequestSong(f.items[0].id, oldContext));
  const updated = await f.service.requestLibraryForSharing();
  assert.equal(updated.songs.length, 1); assert.equal(updated.songs[0].title, 'Replacement metadata');
});

test('preparation remains interruptible and reports a fixed changed-library reason', async t => {
  const f = await fixture(t, 1500, (progress, service) => { if (progress.processed === 100) void service.stop(); });
  await assert.rejects(f.service.requestLibraryForSharing(), { code: 'SHARE_LIBRARY_CHANGED' });
  assert.ok(f.resolved.length <= 100); assert.equal(f.service.status().sharingPreparation, null);
});
