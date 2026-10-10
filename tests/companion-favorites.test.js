'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createCatalogueFavorites, validateFavorites, MAX_IDS } = require('../companion/catalogue-favorites.cjs');
const { validCommand, trustedCatalogueWidgetCommand } = require('../companion/security.cjs');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-favorites-')), stores = [];
  const create = (patch = {}) => { const store = createCatalogueFavorites({ dataDirectory: directory, ...options, ...patch }); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) await store.stop(); if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('chartshub-favorites-')) throw Error('Unsafe fixture cleanup'); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, file: path.join(directory, 'favorites.json'), create, store: create() };
}
const write = (store, chartId, favorite = true) => store.set({ chartId, favorite });

test('favorites persist independently, serialize concurrent changes and reload after restart', async t => {
  const f = await fixture(t); await f.store.load(); assert.equal(f.store.has('chart:1'), false);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  await Promise.all([write(f.store, 'chart:1'), write(f.store, 'chart:2'), write(f.store, 'chart:1', false)]);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), { version: 1, ids: ['chart:2'] });
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['favorites.json']);
  const reloaded = f.create(); await reloaded.load(); assert.equal(reloaded.has('chart:2'), true); assert.equal(reloaded.has('chart:1'), false);
  await reloaded.stop(); await assert.rejects(write(reloaded, 'chart:3'), /arrêtés/);
  await reloaded.start(); assert.equal(reloaded.has('chart:2'), true); await write(reloaded, 'chart:3');
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')).ids, ['chart:2', 'chart:3']);
});

test('future, malformed, duplicate, oversized-count and unsupported files remain unchanged', async t => {
  const f = await fixture(t);
  const sources = ['{"version":2,"ids":["keep"],"future":"preserve"}', '{broken', '{"version":1,"ids":["same","same"]}', '{"version":1,"ids":[],"extra":true}', JSON.stringify({ version: 1, ids: Array.from({ length: MAX_IDS + 1 }, (_, i) => 'c:' + i) })];
  for (const source of sources) {
    await fs.writeFile(f.file, source); const store = f.create(); await store.load(); assert.ok(store.status().warning);
    await assert.rejects(write(store, 'chart:new'), /protégé/); assert.equal(await fs.readFile(f.file, 'utf8'), source);
  }
  assert.deepEqual(await fs.readdir(f.directory), ['favorites.json']);
});

test('identifiers are bounded, exact and unique; the maximum valid count stays readable', async t => {
  for (const id of ['', '../outside', 'https://host/chart', 'a\n', 'a'.repeat(513), 7, null]) assert.throws(() => validateFavorites({ version: 1, ids: [id] }));
  assert.equal(validateFavorites({ version: 1, ids: ['a'.repeat(512)] }).size, 1);
  const f = await fixture(t), ids = Array.from({ length: MAX_IDS }, (_, i) => 'chart:' + i);
  await fs.writeFile(f.file, JSON.stringify({ version: 1, ids })); await f.store.load(); assert.equal(f.store.status().count, MAX_IDS);
  await assert.rejects(write(f.store, 'chart:new'), /20 000/); assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).ids.length, MAX_IDS);
  await write(f.store, ids[0], false); await write(f.store, 'chart:new'); assert.equal(f.store.status().count, MAX_IDS);
  for (const payload of [null, {}, { chartId: 'valid', favorite: 1 }, { chartId: 'valid', favorite: true, path: 'private' }]) await assert.rejects(f.store.set(payload), /invalide/);
});

test('external edits, replacement identity and files created after a missing scan are never overwritten', async t => {
  const f = await fixture(t); await f.store.load(); const foreign = '{"version":1,"ids":["external"]}';
  await fs.writeFile(f.file, foreign); await assert.rejects(write(f.store, 'new'), /changé/); assert.equal(await fs.readFile(f.file, 'utf8'), foreign);
  const loaded = f.create(); await loaded.load(); await fs.rename(f.file, f.file + '.old'); await fs.writeFile(f.file, foreign);
  await assert.rejects(write(loaded, 'new'), /changé/); assert.equal(await fs.readFile(f.file, 'utf8'), foreign);
  const edited = f.create(); await edited.load(); const changed = '{"version":5,"ids":[],"future":"keep"}'; await fs.writeFile(f.file, changed);
  await assert.rejects(write(edited, 'new'), /changé/); assert.equal(await fs.readFile(f.file, 'utf8'), changed);
});

test('directory junctions and hard-linked files are protected without changing their targets', async t => {
  const f = await fixture(t), other = path.join(f.directory, 'outside'), link = path.join(f.directory, 'linked');
  await fs.mkdir(other); await fs.symlink(other, link, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = f.create({ dataDirectory: link }); await linked.load(); await assert.rejects(write(linked, 'chart'), /protégé/); assert.deepEqual(await fs.readdir(other), []);
  const original = path.join(other, 'original.json'), bytes = '{"version":1,"ids":["keep"]}'; await fs.writeFile(original, bytes); await fs.link(original, f.file);
  const hardlinked = f.create(); await hardlinked.load(); await assert.rejects(write(hardlinked, 'chart'), /protégé/); assert.equal(await fs.readFile(original, 'utf8'), bytes);
});

test('a foreign lock is retained and refuses mutation; write failure preserves the original and cleans owned files', async t => {
  const f = await fixture(t), original = '{"version":1,"ids":["keep"]}'; await fs.writeFile(f.file, original); await f.store.load();
  await fs.writeFile(f.file + '.lock', 'another writer'); await assert.rejects(write(f.store, 'chart')); assert.equal(await fs.readFile(f.file + '.lock', 'utf8'), 'another writer'); await fs.unlink(f.file + '.lock');
  const failing = f.create({ io: { ...fs, rename: async () => { throw Error('disk failure'); } } }); await failing.load(); await assert.rejects(write(failing, 'chart'), /disk failure/);
  assert.equal(await fs.readFile(f.file, 'utf8'), original); assert.deepEqual(await fs.readdir(f.directory), ['favorites.json']);
});

test('change during temp-file sync and stop during persistence abort before replacement', async t => {
  const f = await fixture(t), original = '{"version":1,"ids":["keep"]}'; await fs.writeFile(f.file, original);
  let release = deferred(), entered = deferred();
  const io = { ...fs, async open(file, ...args) {
    const handle = await fs.open(file, ...args);
    if (!file.endsWith('.tmp')) return handle;
    return { stat: () => handle.stat(), writeFile: (...values) => handle.writeFile(...values), close: () => handle.close(), async sync() { await handle.sync(); entered.resolve(); await release.promise; } };
  } };
  const drifting = f.create({ io }); await drifting.load();
  const first = write(drifting, 'chart'), firstRejected = assert.rejects(first, /changé/); await entered.promise;
  await fs.writeFile(f.file, '{"version":1,"ids":["external"]}'); release.resolve(); await firstRejected;
  assert.equal(drifting.has('chart'), false); assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).ids[0], 'external');
  release = deferred(); entered = deferred(); const stopping = f.create({ io }); await stopping.load();
  const second = write(stopping, 'chart'), secondRejected = assert.rejects(second, /arrêtés/); await entered.promise;
  const queued = write(stopping, 'queued'), queuedRejected = assert.rejects(queued, /arrêtés/), stopped = stopping.stop();
  release.resolve(); await Promise.all([secondRejected, queuedRejected, stopped]);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')).ids, ['external']); assert.deepEqual(await fs.readdir(f.directory), ['favorites.json']);
});

test('favorite IPC accepts only exact local intent and its trusted catalogue frame', () => {
  const filters = { query: '', artist: '', charter: '', genre: '', year: '', instrument: '', difficulty: '', verified: 'all', installed: 'all', page: 1 };
  for (const payload of [filters, { ...filters, favorites: 'all' }, { ...filters, favorites: 'yes' }]) assert.equal(validCommand('catalogue.search', payload, []), true);
  for (const favorites of [undefined, null, true, 'no', [], { yes: true }]) assert.equal(validCommand('catalogue.search', { ...filters, favorites }, []), false);
  assert.equal(validCommand('catalogue.favorite', { chartId: 'drive:folder:chart', favorite: true }, []), true);
  for (const payload of [null, {}, { chartId: '../file', favorite: true }, { chartId: 'valid', favorite: 'true' }, { chartId: 'valid', favorite: false, path: 'secret' }]) assert.equal(validCommand('catalogue.favorite', payload, []), false);
  const frame = { url: 'chartshub-companion://app/ui/catalogue-widget.html' }, webContents = { mainFrame: frame }, window = { webContents, isDestroyed: () => false }, event = { sender: webContents, senderFrame: frame };
  assert.equal(trustedCatalogueWidgetCommand(event, window, 'catalogue.favorite'), true);
  assert.equal(trustedCatalogueWidgetCommand({ ...event, senderFrame: { ...frame } }, window, 'catalogue.favorite'), false);
  frame.url = 'https://chartshub.ca/'; assert.equal(trustedCatalogueWidgetCommand(event, window, 'catalogue.favorite'), false);
});
