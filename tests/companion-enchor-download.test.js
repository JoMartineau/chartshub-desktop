'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createCatalogueDownloadWorker } = require('../companion/catalogue-download-worker.cjs');
const { createDownloadService } = require('../companion/download-service.cjs');
const { createDownloadWorker } = require('../companion/download-worker.cjs');
const { scanLibrary } = require('../companion/library-scanner.cjs');
const id = '11111111-2222-4333-8444-555555555555', md5 = '0123456789abcdef0123456789abcdef', endpoint = 'enchor:' + md5;
const descriptor = { chartId: endpoint, endpoint, title: 'Song', artist: 'Band', charter: 'Charter' };
const nativeEndpoint = '/api/charts/12345678-1234-1234-1234-123456789012/SongFolderabcdefghij/download-manifest';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-companion-enchor-download-')), rootPath = path.join(directory, 'exports'); await fs.mkdir(rootPath);
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, rootPath, args: { id, endpoint, title: 'Song', artist: 'Band', rootPath } };
}
function sng(extraFiles = 0) {
  const metadata = [['name', 'Song'], ['artist', 'Band']].map(pair => pair.map(value => Buffer.from(value))), files = [['notes.chart', '[Song]\n{}'], ['song.ogg', 'synthetic audio'], ...Array.from({ length: extraFiles }, (_, index) => ['extra-' + index + '.txt', 'fixture'])].map(([name, data]) => ({ name: Buffer.from(name), data: Buffer.from(data) }));
  const metaLength = 8 + metadata.reduce((n, [key, value]) => n + 8 + key.length + value.length, 0), indexLength = 8 + files.reduce((n, file) => n + 17 + file.name.length, 0), start = 26 + 8 + metaLength + 8 + indexLength + 8, header = Buffer.alloc(start), mask = Buffer.from('0123456789abcdef'); let position = 0;
  const bytes = value => { value.copy(header, position); position += value.length; }, u32 = value => { header.writeUInt32LE(value, position); position += 4; }, u64 = value => { header.writeBigUInt64LE(BigInt(value), position); position += 8; };
  bytes(Buffer.from('SNGPKG')); u32(1); bytes(mask); u64(metaLength); u64(metadata.length); for (const [key, value] of metadata) { u32(key.length); bytes(key); u32(value.length); bytes(value); } u64(indexLength); u64(files.length); let offset = start;
  for (const file of files) { header[position++] = file.name.length; bytes(file.name); u64(file.data.length); u64(offset); offset += file.data.length; } u64(files.reduce((n, file) => n + file.data.length, 0));
  return Buffer.concat([header, ...files.map(file => Buffer.from(file.data.map((value, index) => value ^ mask[index % 16] ^ (index & 255))))]);
}

test('Companion external folder imports reuse the SNG validator and preserve UUID-owned receipt identity', async t => {
  const f = await fixture(t), calls = [], bytes = sng();
  await fs.mkdir(path.join(f.rootPath, 'Band - Song')); await fs.writeFile(path.join(f.rootPath, 'Band - Song', 'keep.txt'), 'keep');
  const worker = createCatalogueDownloadWorker({ fetcher: async (url, options) => { calls.push({ url, options }); return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } }); } });
  const result = await worker.run(f.args); assert.equal(result.folderName, 'Band - Song (2)'); assert.equal(result.files, 3); assert.ok(result.totalBytes > 0); assert.equal(await fs.readFile(path.join(result.destination, 'song.ogg'), 'utf8'), 'synthetic audio'); assert.equal(await fs.readFile(path.join(f.rootPath, 'Band - Song', 'keep.txt'), 'utf8'), 'keep');
  assert.equal(calls[0].url, 'https://files.enchor.us/' + md5 + '.sng'); assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers.Authorization, undefined);
  const recovered = await worker.run(f.args); assert.equal(recovered.destination, result.destination); assert.equal(calls.length, 1, 'an existing UUID receipt recovers without another transfer');
  assert.equal(await worker.resolveCompleted({ rootPath: f.rootPath, destination: result.destination }), result.destination);
  await assert.rejects(createDownloadWorker().discard({ id, rootPath: f.rootPath }), { code: 'DOWNLOAD_PATH' });
  const stage = path.join(f.rootPath, '.chartshub-companion-' + id), nested = path.join(stage, 'prepared'); await fs.mkdir(nested); await fs.writeFile(path.join(nested, 'song.ini'), '[song]\nname = Partial external\n'); await fs.writeFile(path.join(nested, 'notes.chart'), '[Song]\n{}');
  const scanned = await scanLibrary({ rootPath: f.rootPath }); assert.equal(scanned.items.some(item => item.title === 'Partial external'), false, 'existing UUID exclusion hides external receipts and extracted staging charts');
  await worker.discard(f.args); assert.equal(await fs.readFile(path.join(result.destination, 'song.ogg'), 'utf8'), 'synthetic audio'); await assert.rejects(fs.stat(path.join(f.rootPath, '.chartshub-companion-' + id)), { code: 'ENOENT' });
});

test('invalid external SNGs and unowned staging cannot publish or delete unrelated files', async t => {
  const f = await fixture(t), worker = createCatalogueDownloadWorker({ fetcher: async () => new Response('malformed SNG', { headers: { 'content-type': 'application/octet-stream' } }) });
  await assert.rejects(worker.run(f.args)); assert.deepEqual((await fs.readdir(f.rootPath)).filter(name => !name.startsWith('.')), []);
  await worker.discard(f.args); const stage = path.join(f.rootPath, '.chartshub-companion-' + id); await fs.mkdir(stage); await fs.writeFile(path.join(stage, 'owner.json'), JSON.stringify({ owner: 'foreign', id })); await fs.writeFile(path.join(stage, 'keep.txt'), 'keep');
  await assert.rejects(worker.run(f.args), { code: 'DOWNLOAD_PATH' }); await assert.rejects(worker.discard(f.args), { code: 'DOWNLOAD_PATH' }); assert.equal(await fs.readFile(path.join(stage, 'keep.txt'), 'utf8'), 'keep');
  await fs.writeFile(path.join(stage, 'owner.json'), JSON.stringify({ owner: 'ChartsHub Companion download v1', version: 1, id, endpoint: nativeEndpoint, root: f.rootPath, rootIdentity: 'native' }));
  await assert.rejects(worker.discard(f.args), { code: 'DOWNLOAD_PATH' }); assert.equal(await fs.readFile(path.join(stage, 'keep.txt'), 'utf8'), 'keep', 'external cleanup cannot claim a native owner');
});

// Full extraction and publication retain the security checks for all 1001 files;
// their filesystem identity checks can exceed the default deadline on CI disks.
test('the validated 1000-member SNG boundary also admits the reconstructed metadata file', { timeout: 180000 }, async t => {
  const f = await fixture(t), worker = createCatalogueDownloadWorker({ fetcher: async () => new Response(sng(998)) });
  const published = await worker.run(f.args); assert.equal(published.files, 1001); assert.ok((await fs.readFile(path.join(published.destination, 'song.ini'), 'utf8')).includes('name = Song')); await worker.discard(f.args);
});

test('external download cooldowns and denials prevent a following queued request from hitting the CDN', async t => {
  const f = await fixture(t); let stamp = 0, calls = 0;
  const worker = createCatalogueDownloadWorker({ now: () => stamp, fetcher: async () => { calls++; return new Response('private body', { status: 429, headers: { 'retry-after': '60' } }); } });
  await assert.rejects(worker.run(f.args), { code: 'ENCHOR_DOWNLOAD_RATE_LIMITED' }); await assert.rejects(worker.run({ ...f.args, id: '22222222-2222-4333-8444-555555555555' }), { code: 'ENCHOR_DOWNLOAD_RATE_LIMITED' }); assert.equal(calls, 1);
  stamp = 61000; await assert.rejects(worker.run(f.args), { code: 'ENCHOR_DOWNLOAD_RATE_LIMITED' }); assert.equal(calls, 2); await worker.discard(f.args);
  const denied = createCatalogueDownloadWorker({ fetcher: async () => { calls++; return new Response('private body', { status: 403 }); } });
  await assert.rejects(denied.run(f.args), { code: 'ENCHOR_DOWNLOAD_ACCESS_DENIED' }); await assert.rejects(denied.run(f.args), { code: 'ENCHOR_DOWNLOAD_ACCESS_DENIED' }); assert.equal(calls, 3); await denied.discard(f.args);
});

test('external completed receipts reject replaced directories and native work retains its original worker contract', async t => {
  const f = await fixture(t), calls = [], nativeWorker = { run: async value => { calls.push(['run', value]); return 'native'; }, discard: async value => calls.push(['discard', value]), resolveCompleted: async () => null };
  const worker = createCatalogueDownloadWorker({ nativeWorker, fetcher: async () => new Response(sng()) });
  const original = { ...f.args, endpoint: nativeEndpoint }; assert.equal(await worker.run(original), 'native'); await worker.discard({ id, rootPath: f.rootPath }); assert.deepEqual(calls, [['run', original], ['discard', { id, rootPath: f.rootPath }]]);
  const published = await worker.run(f.args), old = published.destination + '-old'; await fs.rename(published.destination, old); await fs.mkdir(published.destination); await fs.writeFile(path.join(published.destination, 'keep.txt'), 'keep');
  await assert.rejects(worker.run(f.args), { code: 'DOWNLOAD_PATH' }); await assert.rejects(worker.discard(f.args), { code: 'DOWNLOAD_PATH' }); assert.equal(await fs.readFile(path.join(published.destination, 'keep.txt'), 'utf8'), 'keep');
});

test('queue binds external endpoint to MD5 identity, restores paused offline and deduplicates before transfer', async t => {
  const f = await fixture(t), runs = []; let finish;
  const worker = { run: async value => { runs.push(value); return new Promise(resolve => { finish = resolve; }); }, discard: async () => {}, resolveCompleted: async value => value.destination };
  const service = createDownloadService({ dataDirectory: f.directory, worker }); await service.start(); await service.selectRoot(f.rootPath);
  for (const value of [{ ...descriptor, chartId: 'native:forged' }, { ...descriptor, endpoint: 'enchor:' + 'a'.repeat(32) }, { ...descriptor, endpoint: 'https://files.enchor.us/' + md5 + '.sng' }, { ...descriptor, chartId: 'enchor:garbage', endpoint: nativeEndpoint }]) await assert.rejects(service.enqueue(value));
  const first = await service.enqueue(descriptor), duplicate = await service.enqueue(descriptor); assert.equal(first.id, duplicate.id);
  while (!finish) await new Promise(resolve => setImmediate(resolve)); assert.equal(runs.length, 1); assert.equal(runs[0].endpoint, endpoint); assert.equal(runs[0].title, 'Song'); assert.equal(service.status().items[0].endpoint, undefined);
  const destination = path.join(f.rootPath, 'Band - Song'); await fs.mkdir(destination); finish({ destination, folderName: 'Band - Song', files: 1, totalBytes: 1 });
  while (service.status().items[0].state !== 'Completed') await new Promise(resolve => setImmediate(resolve)); await service.stop();
  const persisted = JSON.parse(await fs.readFile(path.join(f.directory, 'download-state.json'), 'utf8')); persisted.items[0].state = 'Downloading'; await fs.writeFile(path.join(f.directory, 'download-state.json'), JSON.stringify(persisted));
  const restored = createDownloadService({ dataDirectory: f.directory, worker }); await restored.start(); assert.equal(restored.status().items[0].state, 'Paused'); assert.equal(runs.length, 1); await restored.stop();
});
