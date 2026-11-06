'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createSelectedLibraryRemoval, verifyNativeSelectedRemoval } = require('../companion/library-selected-removal.cjs');
const { createInstalledLibraryService } = require('../companion/library-service.cjs');
const { createBackgroundLibraryService } = require('../companion/library-background.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const row = (folder, fields = {}) => ({ id: hash(folder + '/notes.chart'), relativePath: folder + '/notes.chart', format: 'chart',
  title: 'Signal ' + folder, artist: 'Projet fictif', album: 'Album de démonstration', ...fields });
const request = plan => ({ planId: plan.planId, revision: plan.revision, rootKey: plan.rootKey });
async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-selected-removal-')), root = path.join(base, 'Songs'), bin = path.join(base, 'FakeBin'), dataDirectory = path.join(base, 'Profile');
  await fs.mkdir(root); await fs.mkdir(bin); await fs.mkdir(dataDirectory);
  const folders = options.folders || ['A', 'B', 'C'];
  for (const folder of folders) {
    const directory = path.join(root, folder); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'notes.chart'), '[Song]\n{}\n[ExpertSingle]\n{\n0 = N 0 0\n}\n');
    await fs.writeFile(path.join(directory, 'song.ini'), '[song]\nname = Signal ' + folder + '\nartist = Projet fictif\nalbum = Album de démonstration\n');
    await fs.writeFile(path.join(directory, 'song.ogg'), 'synthetic audio ' + folder);
  }
  let document = { settings: { rootPath: root }, revision: 7, items: folders.map(folder => row(folder)) };
  const recycled = [], events = [], callbacks = [];
  const cleanup = createSelectedLibraryRemoval({ getDocument: () => document, protectedDirectory: options.protectedDirectory ?? dataDirectory,
    recycle: async (target, proof) => {
      if (options.recycle) return options.recycle({ target, proof, root, bin, recycled, cleanup });
      await verifyNativeSelectedRemoval({ root, target, proof }); recycled.push(target); await fs.rename(target, path.join(bin, path.basename(target)));
    },
    onChange: status => callbacks.push(status),
    onCleaned: async event => {
      events.push(event); const removed = new Set(event.recycledIds);
      document = { ...document, revision: document.revision + 1, items: document.items.filter(item => !removed.has(item.id)) };
    } });
  t.after(async () => { await cleanup.stop(); assert.equal(path.dirname(base), await fs.realpath(os.tmpdir())); assert.ok(path.basename(base).startsWith('chartshub-selected-removal-')); await fs.rm(base, { recursive: true, force: true }); });
  const selected = ids => ({ ids: ids ?? document.items.map(item => item.id), revision: document.revision, rootKey: hash(process.platform === 'win32' ? root.toLowerCase() : root) });
  return { base, root, bin, dataDirectory, cleanup, recycled, events, callbacks, selected, getDocument: () => document, setDocument: value => { document = value; } };
}

test('artist/album filters and100000-row selection queries stay paged and cap explicit selection at1000', async t => {
  const f = await fixture(t), items = Array.from({ length: 100000 }, (_, index) => row('Demo-' + String(index).padStart(6, '0'), {
    title: 'Signal ' + index, artist: index % 2 ? 'Projet rouge' : 'Projet bleu', album: index % 3 ? 'Collection du soir' : 'Collection du matin' }));
  f.setDocument({ ...f.getDocument(), items });
  const page = f.cleanup.query({ artist: 'BLEU', album: 'SOIR', offset: 50, limit: 50 });
  assert.equal(page.items.length, 50); assert.ok(page.total > 30000); assert.ok(page.items.every(item => item.artist === 'Projet bleu' && item.album === 'Collection du soir'));
  const chosen = f.cleanup.ids({ artist: 'bleu' }); assert.equal(chosen.ids.length, 1000); assert.equal(chosen.total, 50000); assert.equal(chosen.truncated, true);
  assert.equal(f.cleanup.ids({ query: 'Signal100' }).ids.length, 0);
  assert.throws(() => f.cleanup.query({ limit: 1000 }), { code: 'LIBRARY_SELECTED_REMOVAL_SAFE' });
  assert.throws(() => f.cleanup.query({ played: false }), { code: 'LIBRARY_SELECTED_REMOVAL_SAFE' });
  assert.deepEqual(f.recycled, []);
});

test('preparation and review do not delete or read audio payloads; only explicitly selected charts are recycled', async t => {
  const f = await fixture(t), opened = [], originalOpen = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => { opened.push(args[0]); return originalOpen(...args); });
  const plan = await f.cleanup.prepare(f.selected([row('A').id, row('C').id]));
  assert.equal(plan.count, 2); assert.equal(plan.eligibleCount, 2); assert.ok(plan.totalBytes > 0); assert.equal(plan.previewTruncated, false);
  const review = await f.cleanup.review(request(plan)); assert.equal(review.entries.length, 2); assert.equal(review.rootPath, f.root);
  assert.deepEqual(opened, [], 'identity snapshots do not hash potentially terabytes of audio'); assert.deepEqual(f.recycled, []);
  const result = await f.cleanup.execute(request(plan)); assert.deepEqual(result.recycledIds, [row('A').id, row('C').id]); assert.equal(result.failed.length, 0);
  assert.equal(await fs.readFile(path.join(f.root, 'B', 'song.ogg'), 'utf8'), 'synthetic audio B'); assert.equal(f.events.length, 1);
  assert.equal(f.getDocument().items.length, 1); assert.equal(f.cleanup.status().phase, 'idle');
});

test('the fixed reviewed plan cannot be widened with supplied IDs, paths, stale revisions or duplicate selection IDs', async t => {
  const f = await fixture(t), ids = [row('A').id], input = f.selected(ids), preparing = f.cleanup.prepare(input);
  ids.push(row('B').id); const plan = await preparing; assert.equal(plan.count, 1);
  for (const options of [{ ...request(plan), ids: [row('B').id] }, { ...request(plan), rootPath: f.root }, { ...request(plan), revision: 99 }, { ...request(plan), rootKey: 'f'.repeat(64) }]) {
    await assert.rejects(Promise.resolve().then(() => f.cleanup.execute(options)), { code: 'LIBRARY_SELECTED_REMOVAL_SAFE' });
  }
  for (const options of [f.selected([row('A').id, row('A').id]), f.selected(['f'.repeat(64)]), { ...f.selected(), ids: Array(1001).fill(row('A').id) }]) {
    assert.throws(() => f.cleanup.prepare(options), { code: 'LIBRARY_SELECTED_REMOVAL_SAFE' });
  }
  assert.deepEqual(f.recycled, []); assert.equal((await f.cleanup.execute(request(plan))).recycledIds.length, 1);
});

test('changed files, directory replacements and added files invalidate the approved target before recycling', async t => {
  for (const attack of ['changed', 'added', 'replaced']) {
    const f = await fixture(t), plan = await f.cleanup.prepare(f.selected([row('A').id])); await f.cleanup.review(request(plan));
    if (attack === 'changed') await fs.writeFile(path.join(f.root, 'A', 'song.ogg'), 'modified audio!');
    if (attack === 'added') await fs.writeFile(path.join(f.root, 'A', 'keep.txt'), 'new user file');
    if (attack === 'replaced') { await fs.rename(path.join(f.root, 'A'), path.join(f.base, 'old-A')); await fs.mkdir(path.join(f.root, 'A')); await fs.writeFile(path.join(f.root, 'A', 'song.ini'), '[song]\nname=Replacement'); }
    const result = await f.cleanup.execute(request(plan)); assert.equal(result.failed.length, 1); assert.deepEqual(result.recycledIds, []); assert.deepEqual(f.recycled, []);
    assert.ok(await fs.stat(path.join(f.root, 'A')));
  }
});

test('unselected indexed charts, shared folders and nested packs are never included in a recycle target', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'A', 'child')); await fs.writeFile(path.join(f.root, 'A', 'child', 'important.txt'), 'keep');
  f.setDocument({ ...f.getDocument(), items: [...f.getDocument().items, row('B', { id: hash('B/notes.mid'), relativePath: 'B/notes.mid', format: 'midi' })] });
  const plan = await f.cleanup.prepare(f.selected([row('A').id, row('B').id, row('C').id]));
  assert.equal(plan.eligibleCount, 1); assert.equal(plan.blockedCount, 2); assert.equal(plan.entries.find(item => item.id === row('B').id).blocked, 'shared');
  const result = await f.cleanup.execute(request(plan)); assert.deepEqual(result.recycledIds, [row('C').id]); assert.ok(await fs.stat(path.join(f.root, 'A'))); assert.ok(await fs.stat(path.join(f.root, 'B')));
});

test('application data directories and internal transfer stages remain protected', async t => {
  const f = await fixture(t), document = f.getDocument();
  for (const protectedDirectory of [f.root, f.base, path.join(f.root, 'A'), path.join(f.root, 'A', 'Profile')]) {
    const cleanup = createSelectedLibraryRemoval({ getDocument: () => document, protectedDirectory, recycle: async () => assert.fail('Unexpected recycle') });
    const plan = await cleanup.prepare(f.selected([row('A').id])); assert.equal(plan.eligibleCount, 0); assert.equal(plan.entries[0].blocked, 'protected'); await cleanup.stop();
  }
  const transfer = '.chartshub-companion-12345678-1234-4234-8234-123456789012';
  f.setDocument({ ...document, items: [...document.items, row(transfer)] });
  const plan = await f.cleanup.prepare(f.selected([row(transfer).id])); assert.equal(plan.entries[0].blocked, 'protected');
});

test('a standalone SNG selection recycles only that file and preserves its neighboring charts', async t => {
  const f = await fixture(t), relativePath = 'single.sng', item = row('', { id: hash(relativePath), relativePath, format: 'sng', title: 'Conteneur de démonstration' });
  await fs.writeFile(path.join(f.root, relativePath), 'synthetic container bytes'); f.setDocument({ ...f.getDocument(), items: [...f.getDocument().items, item] });
  const plan = await f.cleanup.prepare(f.selected([item.id])); assert.equal(plan.eligibleCount, 1); assert.equal(plan.entries[0].kind, 'sng');
  const result = await f.cleanup.execute(request(plan)); assert.deepEqual(result.recycledIds, [item.id]); assert.ok(await fs.stat(path.join(f.root, 'A')));
});

test('cancelling preparation or a prepared plan performs no native recycling', async t => {
  const f = await fixture(t), preparation = f.cleanup.prepare(f.selected()); f.cleanup.invalidate();
  await assert.rejects(preparation, { code: 'LIBRARY_SELECTED_REMOVAL_SAFE' }); assert.equal(f.cleanup.status().phase, 'idle');
  const plan = await f.cleanup.prepare(f.selected()); f.cleanup.invalidate(); await assert.rejects(f.cleanup.review(request(plan)), { code: 'LIBRARY_SELECTED_REMOVAL_SAFE' });
  assert.deepEqual(f.recycled, []);
});

test('stop waits for an in-flight native recycle and commits only confirmed successes', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { recycle: async ({ target, proof, root, bin, recycled }) => {
    entered.resolve(); await release.promise; await verifyNativeSelectedRemoval({ root, target, proof }); recycled.push(target); await fs.rename(target, path.join(bin, path.basename(target)));
  } });
  const plan = await f.cleanup.prepare(f.selected()), pending = f.cleanup.execute(request(plan)); await entered.promise;
  const stopping = f.cleanup.stop(); release.resolve(); const result = await pending; await stopping;
  assert.equal(result.recycledIds.length, 1); assert.equal(result.cancelled, true); assert.equal(f.events.length, 1); assert.equal(f.getDocument().items.length, 2);
});

test('the native boundary rejects changed identities, incomplete proofs and another root', async t => {
  let saved;
  const f = await fixture(t, { recycle: async ({ target, proof }) => { saved = { target, proof }; } });
  const plan = await f.cleanup.prepare(f.selected([row('A').id])); await f.cleanup.execute(request(plan));
  await verifyNativeSelectedRemoval({ root: f.root, ...saved });
  for (const proof of [{ ...saved.proof, expected: {} }, { ...saved.proof, rootKey: 'f'.repeat(64) }, { ...saved.proof, type: 'bad-songs' }, { ...saved.proof, targetRelativePath: '../outside' }]) {
    await assert.rejects(verifyNativeSelectedRemoval({ root: f.root, target: saved.target, proof }), { code: 'LIBRARY_SELECTED_REMOVAL_SAFE' });
  }
  await fs.writeFile(path.join(f.root, 'A', 'song.ogg'), 'modified after worker IPC');
  await assert.rejects(verifyNativeSelectedRemoval({ root: f.root, ...saved }), { code: 'LIBRARY_SELECTED_REMOVAL_SAFE' });
});

test('a root or index revision change invalidates a prepared selection', async t => {
  const f = await fixture(t), plan = await f.cleanup.prepare(f.selected());
  f.setDocument({ ...f.getDocument(), revision: f.getDocument().revision + 1 });
  await assert.rejects(f.cleanup.review(request(plan)), { code: 'LIBRARY_SELECTED_REMOVAL_SAFE' }); assert.deepEqual(f.recycled, []);
});

async function libraryFixture(t, background = false) {
  const f = await fixture(t), recycled = []; let service;
  const options = { dataDirectory: f.dataDirectory, recycle: async (target, proof) => {
    await verifyNativeSelectedRemoval({ root: f.root, target, proof });
    if (!background) {
      assert.throws(() => service.requestScan('quick'), { code: 'LIBRARY_CLEANUP_SAFE' });
      await assert.rejects(service.selectRoot(f.root), { code: 'LIBRARY_CLEANUP_SAFE' });
      await assert.rejects(service.configure({ watch: true }), { code: 'LIBRARY_CLEANUP_SAFE' });
    }
    recycled.push(target); await fs.rename(target, path.join(f.bin, path.basename(target)));
  } };
  service = background ? createBackgroundLibraryService(options) : createInstalledLibraryService(options);
  t.after(() => service.stop());
  await service.load(); await service.start(); await service.selectRoot(f.root);
  for (let attempt = 0; attempt < 500 && service.status().status === 'scanning'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.status().status, 'ready'); return { ...f, service, recycled };
}

test('library integration removes only confirmed index rows and avoids rescanning allSongs', async t => {
  const f = await libraryFixture(t), query = await f.service.selectedRemovalQuery({ artist: 'fictif' }), beforeScan = f.service.status().lastScanAt;
  const plan = await f.service.prepareSelectedRemoval({ ids: [query.items[0].id], revision: query.revision, rootKey: query.rootKey });
  const result = await f.service.recycleSelectedRemoval(request(plan));
  assert.equal(result.recycledIds.length, 1); assert.equal(f.service.status().count, 2); assert.equal(f.service.status().cleanupRefreshPending, true);
  assert.equal(f.service.status().lastScanAt, beforeScan); assert.equal((await f.service.selectedRemovalQuery()).total, 2);
});

test('background worker passes only selected-removal RPCs and verified native proofs across its recycle boundary', async t => {
  const f = await libraryFixture(t, true), query = await f.service.selectedRemovalQuery(), chosen = await f.service.selectedRemovalIds({ artist: 'fictif' });
  assert.equal(chosen.ids.length, 3);
  const plan = await f.service.prepareSelectedRemoval({ ids: chosen.ids.slice(0, 1), revision: query.revision, rootKey: query.rootKey });
  const review = await f.service.selectedRemovalReview(request(plan)); assert.equal(review.entries.length, 1);
  const result = await f.service.recycleSelectedRemoval(request(plan)); assert.equal(result.recycledIds.length, 1); assert.equal(f.recycled.length, 1); assert.equal(f.service.status().count, 2);
});
