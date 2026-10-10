const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Module, createRequire } = require('node:module');
const { createCatalogueService } = require('../companion/catalogue-service.cjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > 3000) throw Error('Catalogue condition timed out'); await delay(5); } }
const local = { id: digest('local'), title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', fingerprint: digest('original file') };
function record(index = 1, patch = {}) {
  const id = `drive:root:song-${index}`;
  return { id, title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', album: 'The Colour and the Shape', year: '1997', genre: 'Rock', verified: true, instruments: ['Guitar', 'Bass'], difficulties: ['Easy', 'Expert'], instrumentDifficulties: { Guitar: ['Expert'], Bass: ['Easy'] }, artworkUrl: `https://chartshub.ca/uploads/covers/00000000-0000-4000-8000-${String(index).padStart(12, '0')}.png`, viewUrl: `https://chartshub.ca/index.html?chart=${encodeURIComponent(id)}&share=2`, ...patch };
}
async function injected(overrides) {
  const absolute = require.resolve('../companion/catalogue-service.cjs'), localModule = new Module(absolute, module), normal = createRequire(absolute);
  localModule.filename = absolute; localModule.paths = Module._nodeModulePaths(path.dirname(absolute)); localModule.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  localModule._compile(await fs.readFile(absolute, 'utf8'), absolute); return localModule.exports.createCatalogueService;
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-catalogue-')), services = [];
  const f = { directory, file: path.join(directory, 'matching.json'), requests: [], records: options.records ?? [record()], library: { rootKey: digest('root'), revision: 1, items: [{ ...local }] } };
  f.client = options.client ?? { load: async request => { f.requests.push(request); return { items: f.records, revision: null, demo: false }; }, artwork: async () => ({ bytes: Buffer.from('image fixture'), contentType: 'image/png' }) };
  f.create = () => { const service = (options.factory ?? createCatalogueService)({ dataDirectory: directory, client: f.client, getLibrary: () => f.library }); services.push(service); return service; };
  f.service = f.create();
  t.after(async () => { for (const service of services) await service.stop(); if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('chartshub-catalogue-')) throw Error('Unexpected fixture directory'); await fs.rm(directory, { recursive: true, force: true }); });
  return f;
}

test('startup is offline; first concurrent searches and candidates share one catalogue request without local metadata', async t => {
  const f = await fixture(t); await Promise.all([f.service.load(), f.service.start()]); assert.equal(f.requests.length, 0);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  const [page, other, candidates] = await Promise.all([f.service.search(), f.service.search({ query: 'foo' }), f.service.candidates(local.id)]);
  assert.equal(f.requests.length, 1); assert.deepEqual(Object.keys(f.requests[0]), ['signal']);
  assert.equal(page.total, 1); assert.equal(other.total, 1); assert.equal(candidates.items.length, 1); assert.match(candidates.contextId, /^[a-f0-9]{32}$/);
  assert.equal(page.items[0].installed.status, 'candidate'); assert.equal(page.items[0].verified, true);
  assert.match(page.items[0].artworkUrl, /^chartshub-companion:\/\/app\/catalogue-artwork\/[a-f0-9]{64}$/);
  assert.equal(f.service.status().status, 'ready'); assert.equal(f.service.status().availableCount, 1);
});

test('card presentation snapshots are independent and charter icons use the known artwork proxy cache', async t => {
  const charterIconUrl = 'https://chartshub.ca/api/charts/11111111-1111-4111-8111-111111111111/FixtureCharterIcon/charter-icon';
  const f = await fixture(t, { records: [record(1, { charter: 'JoMartineau', charterSegments: [{ text: 'Jo', color: 'pink' }, { text: 'Martineau', color: 'cyan' }], charterIconUrl, staffRole: 'moderator', game: ['Clone Hero'], duration: 245, instrumentIntensities: { Guitar: 2 } })] });
  const first = (await f.service.search()).items[0];
  assert.equal(first.charterIconUrl, 'chartshub-companion://app/catalogue-artwork/' + digest(charterIconUrl));
  assert.equal(first.staffRole, 'moderator'); assert.equal(first.duration, 245);
  assert.doesNotMatch(JSON.stringify(first), /\/api\/charts/);
  first.charterSegments[0].color = 'red'; first.instrumentIntensities.Guitar = 1000; first.game.push('Other');
  const second = (await f.service.search()).items[0];
  assert.equal(second.charterSegments[0].color, 'pink'); assert.equal(second.instrumentIntensities.Guitar, 2); assert.deepEqual(second.game, ['Clone Hero']);
  const image = await f.service.artwork(digest(charterIconUrl)); assert.equal(image.contentType, 'image/png');
  await f.service.stop(); assert.equal(await f.service.artwork(digest(charterIconUrl)), null);
});

test('demo catalogue suppresses creator role and verification badges', async t => {
  const f = await fixture(t, { client: { load: async () => ({ demo: true, items: [record(1, { staffRole: 'administrator', verified: true })] }) } });
  const item = (await f.service.search()).items[0]; assert.equal(item.verified, null); assert.equal(item.staffRole, undefined);
});

test('catalogue matching and associations include songs beyond the first 10000 library entries', async t => {
  const f = await fixture(t);
  f.library.items = [
    ...Array.from({ length: 10000 }, (_, index) => ({ id: digest('unrelated-' + index), title: 'Unrelated ' + index,
      artist: 'Other artist', charter: 'Other charter', fingerprint: digest('unrelated-file-' + index) })),
    { ...local }
  ];
  const page = await f.service.search();
  assert.equal(page.items[0].installed.status, 'candidate'); assert.deepEqual(page.items[0].installed.localIds, [local.id]);
  const selection = await f.service.candidates(local.id);
  assert.equal(selection.local.id, local.id); assert.equal(selection.items[0].id, record().id);
  await f.service.link({ localId: local.id, chartId: record().id, contextId: selection.contextId });
  const linked = await f.service.search({ installed: 'linked' });
  assert.equal(linked.total, 1); assert.deepEqual(linked.items[0].installed.localIds, [local.id]);
});

test('download descriptors stay private and require a known public non-demo catalogue entry', async t => {
  const endpoint = '/api/charts/12345678-1234-4123-8123-123456789abc/songFolder123/download-manifest';
  const f = await fixture(t, { records: [record(1, { downloadEndpoint: endpoint }), record(2, { downloadEndpoint: endpoint.replace('/api/', '/api/admin/') }), record(3, { downloadEndpoint: 'https://other.test/chart' })] });
  assert.throws(() => f.service.downloadDescriptor(record().id));
  const page = await f.service.search();
  assert.deepEqual(page.items.map(item => item.downloadable), [true, false, false]);
  assert.ok(page.items.every(item => !Object.hasOwn(item, 'downloadEndpoint')));
  assert.deepEqual(f.service.downloadDescriptor(record().id), { chartId: record().id, title: record().title, artist: record().artist, charter: record().charter, endpoint });
  for (const id of [record(2).id, record(3).id, 'unknown']) assert.throws(() => f.service.downloadDescriptor(id));
  f.client.load = async () => ({ items: f.records, demo: true }); await f.service.refresh();
  assert.ok((await f.service.search()).items.every(item => !item.downloadable));
  assert.throws(() => f.service.downloadDescriptor(record().id));
  await f.service.stop(); assert.throws(() => f.service.downloadDescriptor(record().id));
});

test('search paginates and applies verified/year/genre/artist/charter and paired instrument difficulty filters', async t => {
  const f = await fixture(t, { records: Array.from({ length: 25 }, (_, index) => record(index + 1, { verified: index % 2 === 0 ? true : null })) });
  const first = await f.service.search(), second = await f.service.search({ page: 2 });
  assert.equal(first.items.length, 20); assert.equal(first.hasMore, true); assert.equal(first.total, 25); assert.equal(second.items.length, 5); assert.equal(second.hasMore, false);
  assert.deepEqual(first.facets, { instruments: ['Bass', 'Guitar'], difficulties: ['Easy', 'Expert'] });
  assert.equal((await f.service.search({ artist: 'Fóo', charter: 'example', year: '1997', genre: 'rock', verified: 'yes', instrument: 'Guitar', difficulty: 'Expert' })).total, 13);
  assert.equal((await f.service.search({ instrument: 'Guitar', difficulty: 'Easy' })).total, 0);
  assert.equal((await f.service.search({ instrument: 'Bass', difficulty: 'Easy' })).total, 25);
  assert.equal((await f.service.search({ year: '199' })).total, 0);
  first.items[0].instrumentDifficulties.Guitar.push('Easy'); assert.equal((await f.service.search({ instrument: 'Guitar', difficulty: 'Easy' })).total, 0);
  for (const filters of [{ page: 0 }, { page: Infinity }, { verified: 'no' }, { installed: 'yes' }, { artist: null }, { query: 'a'.repeat(201) }, { rootPath: 'secret' }]) await assert.rejects(f.service.search(filters));
});

test('manual links persist by root and fingerprint, are never inferred, and can be removed with the same context', async t => {
  const f = await fixture(t, { records: [record(), record(2, { verified: false })] }); const selection = await f.service.candidates(local.id);
  assert.equal(selection.linkedChartId, null); assert.ok(selection.items.every(item => item.ambiguous));
  await assert.rejects(f.service.link({ localId: local.id, chartId: 'drive:root:unknown', contextId: selection.contextId }), /sélection/);
  await assert.rejects(f.service.link({ localId: local.id, contextId: selection.contextId }), /invalide/);
  assert.deepEqual(await f.service.link({ localId: local.id, chartId: record(2).id, contextId: selection.contextId }), { linkedChartId: record(2).id });
  const linked = await f.service.search({ installed: 'linked' }); assert.equal(linked.total, 1); assert.equal(linked.items[0].id, record(2).id); assert.equal(linked.items[0].verified, false);
  assert.equal((await f.service.search({ installed: 'unlinked' })).total, 1);
  const raw = await fs.readFile(f.file, 'utf8'), persisted = JSON.parse(raw); assert.equal(persisted.version, 1); assert.equal(persisted.links[0].fingerprint, local.fingerprint); assert.ok(!raw.includes(f.directory));
  const other = f.create(); await other.load(); assert.equal((await other.search({ installed: 'linked' })).total, 1);
  assert.deepEqual(await f.service.unlink({ localId: local.id, contextId: selection.contextId }), { linkedChartId: null });
  assert.equal((await f.service.search({ installed: 'linked' })).total, 0); assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')).links, []);
});

test('large libraries stay available and build metadata badges only for the requested page', async t => {
  const matching = require('../companion/chart-matching.cjs');
  let lookups = 0, badges = 0;
  const factory = await injected({ './chart-matching.cjs': { ...matching,
    buildInstalledLookup: items => { lookups++; return matching.buildInstalledLookup(items); },
    annotateInstalled: (remote, lookup) => { badges++; return matching.annotateInstalled(remote, lookup); }
  } });
  const f = await fixture(t, { factory, records: Array.from({ length: 100 }, (_, index) => record(index + 1)) });
  f.library.items = Array.from({ length: 20000 }, (_, index) => ({ ...local, id: digest(`large-local-${index}`), title: `Unrelated song ${index}` })).concat({ ...local });
  const first = await f.service.search();
  assert.equal(first.total, 100); assert.equal(first.items.length, 20);
  assert.deepEqual(first.items[0].installed.localIds, [local.id]);
  assert.equal(badges, 20, 'off-page matches must not expand local duplicate groups');
  assert.equal((await f.service.search({ installed: 'linked' })).total, 0);
  assert.equal(badges, 20, 'manual-link filtering must not build metadata badges');
  assert.equal((await f.service.search({ installed: 'unlinked', page: 5 })).items.length, 20);
  assert.equal(badges, 40); assert.equal(lookups, 1, 'unchanged large snapshots reuse their lookup');
  const selection = await f.service.candidates(local.id);
  await f.service.link({ localId: local.id, chartId: record().id, contextId: selection.contextId });
  assert.equal((await f.service.search({ installed: 'linked' })).total, 1);
  assert.equal((await f.service.search({ installed: 'unlinked' })).total, 99);
  assert.equal(lookups, 1, 'link changes do not rebuild the library metadata index');
  f.library = { ...f.library, revision: 2, items: f.library.items.slice(0, -1) };
  assert.equal((await f.service.search({ installed: 'linked' })).total, 0);
  assert.equal(lookups, 2, 'library revision changes still invalidate the lookup and associations');
});

test('association files beyond the former count and byte limits load, grow and reload without losing links', async t => {
  const longId = 'chart:' + 'x'.repeat(506);
  const f = await fixture(t, { records: [record(1, { id: longId, viewUrl: `https://chartshub.ca/index.html?chart=${longId}&share=2` }), record(2)] });
  const associations = Array.from({ length: 16500 }, (_, index) => ({ rootKey: f.library.rootKey, localId: digest(`stored-local-${index}`), fingerprint: local.fingerprint, chartId: longId, linkedAt: '2026-01-01T00:00:00.000Z' }));
  associations[associations.length - 1].localId = local.id;
  const original = JSON.stringify({ version: 1, links: associations });
  assert.ok(Buffer.byteLength(original) > 12 * 1024 * 1024);
  await fs.writeFile(f.file, original);
  const newLocal = { ...local, id: digest('new local beyond count limit') };
  f.library.items.push(newLocal);
  await f.service.load(); assert.equal(f.service.status().warning, null);
  assert.equal((await f.service.search({ installed: 'linked' })).items[0].id, longId);
  const selection = await f.service.candidates(newLocal.id);
  await f.service.link({ localId: newLocal.id, chartId: record(2).id, contextId: selection.contextId });
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(saved.links.length, 16501); assert.deepEqual(saved.links.slice(0, -1), associations);
  assert.equal(await fs.readFile(f.file + '.bak', 'utf8'), original);
  const reloaded = f.create(); await reloaded.load(); assert.equal(reloaded.status().warning, null);
  assert.equal((await reloaded.search({ installed: 'linked' })).total, 2);
  const context = await reloaded.candidates(newLocal.id);
  await reloaded.unlink({ localId: newLocal.id, contextId: context.contextId });
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')).links, associations);
});

test('malformed associations after ten thousand valid entries remain protected with a complete recovery backup', async t => {
  const f = await fixture(t);
  const associations = Array.from({ length: 10001 }, (_, index) => ({ rootKey: f.library.rootKey, localId: digest(`malformed-tail-${index}`), fingerprint: local.fingerprint, chartId: record().id, linkedAt: '2026-01-01T00:00:00.000Z' }));
  associations.push({ ...associations[0] });
  const original = JSON.stringify({ version: 1, links: associations });
  await fs.writeFile(f.file, original); await f.service.load();
  assert.match(f.service.status().warning, /illisibles/);
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  const selection = await f.service.candidates(local.id);
  await f.service.link({ localId: local.id, chartId: record().id, contextId: selection.contextId });
  const backup = (await fs.readdir(f.directory)).find(name => /^matching\.json\.corrupt-.*\.bak$/.test(name));
  assert.ok(backup); assert.equal(await fs.readFile(path.join(f.directory, backup), 'utf8'), original);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).links.length, 1);
});

test('root, revision and fingerprint changes reject old contexts and cannot reuse associations across roots', async t => {
  const f = await fixture(t); let selection = await f.service.candidates(local.id);
  await f.service.link({ localId: local.id, chartId: record().id, contextId: selection.contextId });
  f.library = { ...f.library, rootKey: digest('different root'), revision: 2 }; f.service.libraryChanged();
  await assert.rejects(f.service.link({ localId: local.id, chartId: record().id, contextId: selection.contextId }), /sélection/);
  assert.equal((await f.service.search({ installed: 'linked' })).total, 0);
  selection = await f.service.candidates(local.id); f.library = { ...f.library, revision: 3 };
  await assert.rejects(f.service.link({ localId: local.id, chartId: record().id, contextId: selection.contextId }), /sélection/);
  selection = await f.service.candidates(local.id); f.library.items[0] = { ...local, fingerprint: digest('changed without revision') };
  await assert.rejects(f.service.link({ localId: local.id, chartId: record().id, contextId: selection.contextId }), /sélection/);
  f.library = { rootKey: digest('root'), revision: 4, items: [{ ...local, fingerprint: digest('changed file') }] }; f.service.libraryChanged();
  assert.equal((await f.service.search({ installed: 'linked' })).total, 0);
  f.library = { rootKey: digest('root'), revision: 5, items: [{ ...local }] }; f.service.libraryChanged();
  assert.equal((await f.service.search({ installed: 'linked' })).total, 1);
});

test('explicit refresh supersedes stale completions and invalidates match contexts', async t => {
  const first = deferred(), second = deferred(); let calls = 0;
  const f = await fixture(t, { client: { load: () => ++calls === 1 ? first.promise : second.promise } });
  const old = f.service.search(), rejected = assert.rejects(old, /sélection/); await until(() => calls === 1);
  const fresh = f.service.refresh(); await until(() => calls === 2);
  second.resolve({ items: [record(2, { title: 'Fresh' })], demo: false, revision: 'new' }); await fresh;
  first.resolve({ items: [record()], demo: false, revision: 'old' }); await rejected;
  assert.equal((await f.service.search()).items[0].title, 'Fresh'); assert.equal(f.service.status().status, 'ready');
  // A loaded catalogue is not refreshed automatically.
  assert.equal(calls, 2);
});

test('stop cancels pending requests and clears the cache; start remains offline and later search reloads', async t => {
  const gate = deferred(); let calls = 0, aborted = false;
  const f = await fixture(t, { client: { load: ({ signal }) => { calls++; signal.addEventListener('abort', () => { aborted = true; }); return calls === 1 ? gate.promise : Promise.resolve({ items: [record(2)], demo: false }); } } });
  const pending = f.service.search(), rejected = assert.rejects(pending, /sélection/); await until(() => calls === 1); await f.service.stop();
  assert.equal(aborted, true); assert.equal(f.service.status().availableCount, 0); gate.resolve({ items: [record()], demo: false }); await rejected;
  await f.service.start(); assert.equal(calls, 1); assert.equal((await f.service.search()).items[0].id, record(2).id); assert.equal(calls, 2);
});

test('catalogue failures are safe and retryable; a partial creators warning does not fabricate verified status', async t => {
  let fail = true;
  const f = await fixture(t, { client: { load: async () => { if (fail) throw Object.assign(Error('private token secret'), { code: 'CATALOGUE_TIMEOUT' }); return { items: [record(1, { verified: null })], demo: false, warning: 'Le statut des créateurs vérifiés est temporairement indisponible.' }; } } });
  await assert.rejects(f.service.search(), /temps/); assert.ok(!f.service.status().error.includes('secret')); assert.equal(f.service.status().status, 'error');
  fail = false; const page = await f.service.search(); assert.equal(page.items[0].verified, null); assert.match(f.service.status().warning, /créateurs/); assert.equal((await f.service.search({ verified: 'yes' })).total, 0);
});

test('demo records cannot be manually associated', async t => {
  const f = await fixture(t, { client: { load: async () => ({ items: [record()], demo: true }) } }); const selection = await f.service.candidates(local.id);
  assert.equal(f.service.status().demo, true); await assert.rejects(f.service.link({ localId: local.id, chartId: record().id, contextId: selection.contextId }), /démonstration/);
  await assert.rejects(f.service.unlink({ localId: local.id, contextId: selection.contextId }), /démonstration/);
  assert.equal(selection.items[0].verified, null); assert.equal((await f.service.search({ verified: 'yes' })).total, 0);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('failed refresh identifies the retained catalogue as stale and does not silently refetch', async t => {
  let fail = false, calls = 0;
  const f = await fixture(t, { client: { load: async () => { calls++; if (fail) throw Error('offline'); return { items: [record()], demo: false }; } } });
  await f.service.search(); const loadedAt = f.service.status().lastLoadedAt, context = await f.service.candidates(local.id);
  fail = true; await assert.rejects(f.service.refresh(), /indisponible/);
  assert.match(f.service.status().warning, /Dernier catalogue chargé affiché/); assert.equal(f.service.status().lastLoadedAt, loadedAt);
  await assert.rejects(f.service.link({ localId: local.id, chartId: record().id, contextId: context.contextId }), /sélection/);
  assert.equal((await f.service.search()).total, 1); assert.equal(calls, 2);
  fail = false; await f.service.refresh(); assert.equal(f.service.status().warning, null);
});

test('future association files remain protected and explicit corrupt recovery retains a permanent backup', async t => {
  const f = await fixture(t); const future = '{"version":12,"future":"keep"}'; await fs.writeFile(f.file, future); const selection = await f.service.candidates(local.id);
  await assert.rejects(f.service.link({ localId: local.id, chartId: record().id, contextId: selection.contextId }), /protégées/); assert.equal(await fs.readFile(f.file, 'utf8'), future);
  const corrupt = '{broken'; await fs.writeFile(f.file, corrupt); const recovered = f.create(); await recovered.load(); assert.equal(await fs.readFile(f.file, 'utf8'), corrupt);
  const context = await recovered.candidates(local.id); await recovered.link({ localId: local.id, chartId: record().id, contextId: context.contextId });
  await recovered.unlink({ localId: local.id, contextId: context.contextId });
  const backup = (await fs.readdir(f.directory)).find(name => /^matching\.json\.corrupt-.*\.bak$/.test(name));
  assert.ok(backup); assert.equal(await fs.readFile(path.join(f.directory, backup), 'utf8'), corrupt); assert.equal(recovered.status().warning, null);
});

test('late library changes during persistence reject the association before replacing disk', async t => {
  let holding = false; const entered = deferred(), gate = deferred();
  const factory = await injected({ 'node:fs/promises': { ...fs, copyFile: async (...args) => { if (holding) { entered.resolve(); await gate.promise; } return fs.copyFile(...args); } } });
  const f = await fixture(t, { factory, records: [record(), record(2)] }); let context = await f.service.candidates(local.id);
  await f.service.link({ localId: local.id, chartId: record().id, contextId: context.contextId }); const original = await fs.readFile(f.file, 'utf8');
  context = await f.service.candidates(local.id); holding = true;
  const pending = f.service.link({ localId: local.id, chartId: record(2).id, contextId: context.contextId }), rejected = assert.rejects(pending, /sélection/);
  await entered.promise; f.library = { ...f.library, revision: 2 }; f.service.libraryChanged(); gate.resolve(); await rejected;
  assert.equal(await fs.readFile(f.file, 'utf8'), original); assert.ok(!(await fs.readdir(f.directory)).some(name => name.endsWith('.tmp')));
});

test('opening requires a known chart ID and its exact validated ChartsHub view URL', async t => {
  const f = await fixture(t); await f.service.search(); assert.equal(await f.service.openUrl(record().id), record().viewUrl);
  for (const id of ['https://evil.test', 'unknown', null]) await assert.rejects(f.service.openUrl(id));
  await f.service.stop(); await assert.rejects(f.service.openUrl(record().id));
  const bad = await fixture(t, { records: [record(1, { viewUrl: 'https://evil.test/index.html' })] }); await assert.rejects(bad.service.search(), /indisponible/);
});

test('artwork requests require known URL hashes, deduplicate, and never run more than four transfers', async t => {
  const releases = [], requests = []; let running = 0, maximum = 0;
  const records = Array.from({ length: 6 }, (_, index) => record(index + 1));
  const f = await fixture(t, { client: { load: async () => ({ items: records, demo: false }), artwork: async (url, { signal }) => {
    requests.push({ url, signal }); maximum = Math.max(maximum, ++running); const gate = deferred(); releases.push(gate); await gate.promise; running--; return { bytes: Buffer.from(url), contentType: 'image/png' };
  } } });
  await f.service.search(); assert.equal(await f.service.artwork(digest('unknown')), null); assert.equal(await f.service.artwork('../outside'), null);
  const jobs = records.map(item => f.service.artwork(digest(item.artworkUrl))); const duplicate = f.service.artwork(digest(records[0].artworkUrl));
  await until(() => requests.length === 4); assert.equal(maximum, 4); releases.slice(0, 4).forEach(gate => gate.resolve()); await until(() => requests.length === 6); releases.slice(4).forEach(gate => gate.resolve());
  const images = await Promise.all(jobs); await duplicate; assert.equal(requests.length, 6); assert.equal(maximum, 4); assert.ok(images.every(image => image.contentType === 'image/png'));
  images[0].bytes.fill(0); assert.notEqual((await f.service.artwork(digest(records[0].artworkUrl))).bytes[0], 0);
  await f.service.artwork(digest(records[0].artworkUrl)); assert.equal(requests.length, 6);
});

test('artwork cache evicts beyond 32MB, rejects oversized/mistyped images and clears on stop', async t => {
  const records = Array.from({ length: 13 }, (_, index) => record(index + 1)), counts = new Map();
  const f = await fixture(t, { client: { load: async () => ({ items: records, demo: false }), artwork: async url => {
    counts.set(url, (counts.get(url) ?? 0) + 1);
    if (url === records[11].artworkUrl) return { bytes: Buffer.alloc(3 * 1024 * 1024 + 1), contentType: 'image/png' };
    if (url === records[12].artworkUrl) return { bytes: Buffer.from('<svg/>'), contentType: 'image/svg+xml' };
    return { bytes: Buffer.alloc(3 * 1024 * 1024, 1), contentType: 'image/png' };
  } } });
  await f.service.search(); for (const item of records.slice(0, 11)) assert.ok(await f.service.artwork(digest(item.artworkUrl)));
  await f.service.artwork(digest(records[0].artworkUrl)); assert.equal(counts.get(records[0].artworkUrl), 2);
  assert.equal(await f.service.artwork(digest(records[11].artworkUrl)), null); assert.equal(await f.service.artwork(digest(records[12].artworkUrl)), null);
  await f.service.stop(); assert.equal(await f.service.artwork(digest(records[0].artworkUrl)), null);
});
