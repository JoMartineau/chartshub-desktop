'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createCatalogueSyncService } = require('../companion/catalogue-sync-service.cjs');
const { createCatalogueSyncStore } = require('../companion/catalogue-sync-store.cjs');
const { createCatalogueSyncClient } = require('../companion/catalogue-sync-client.cjs');
const { validCommand } = require('../companion/security.cjs');
const clone = value => structuredClone(value);
const revision = 'a'.repeat(64);
const endpoint = index => '/api/charts/12345678-1234-1234-1234-123456789012/SourceFile' + String(index).padStart(10, '0') + '/download-manifest';
const descriptor = index => ({ chartId: 'chart-' + index, title: 'Signal ' + index, artist: 'Artiste Démo', charter: 'Charter Démo', endpoint: endpoint(index), contentRevision: revision, verification: 'content', files: 2, totalBytes: 30 });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
function memoryStore() {
  let state = null; const pages = new Map(), records = new Map(), writes = { state: 0, pages: 0, records: 0, append: 0, maxPage: 0 };
  return { writes, pages, records,
    readState: async () => state && clone(state), writeState: async value => { state = clone(value); writes.state++; },
    savePage: async (job, number, items) => { pages.set(job + ':' + number, clone(items)); writes.pages++; writes.maxPage = Math.max(writes.maxPage, items.length); },
    loadPage: async (job, number) => clone(pages.get(job + ':' + number)),
    append: async (job, number, event) => { Object.assign(pages.get(job + ':' + number)[event.index], clone(event)); writes.append++; },
    readRecord: async (root, key) => records.has(root + key) ? clone(records.get(root + key)) : null,
    writeRecord: async (root, key, record) => { records.set(root + key, clone(record)); writes.records++; }
  };
}
async function fixture(t, { total = 6, store = memoryStore(), worker: customWorker, onInstalled, onStarting, onSettled } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-sync-service-')), rootPath = path.join(directory, 'Songs'); await fs.mkdir(rootPath);
  t.after(async () => { if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('chartshub-sync-service-')) throw Error('Unsafe test cleanup'); await fs.rm(directory, { recursive: true, force: true }); });
  const calls = [], notices = []; let running = 0, maximum = 0;
  const catalogue = { page: async ({ offset, revision: expected }) => {
    calls.push(offset); assert.ok(!expected || expected === revision);
    const count = Math.min(500, total - offset); return { total, revision, offset, nextOffset: offset + count === total ? null : offset + count,
      items: Array.from({ length: count }, (_, i) => descriptor(i + offset)) };
  } };
  const worker = customWorker || {
    inspect: async ({ record }) => ({ state: record ? 'unchanged' : 'new', record }),
    run: async ({ endpoint, record }) => {
      running++; maximum = Math.max(maximum, running); await new Promise(resolve => setImmediate(resolve)); running--;
      return { changed: !record, destination: path.join(rootPath, 'Demo-' + endpoint.split('/')[4]), record: { endpoint, revision }, receivedBytes: record ? 0 : 30, files: 2, totalBytes: 30 };
    }
  };
  const context = { active: true, rootPath, busy: false };
  const options = { dataDirectory: directory, catalogue, worker, store, getContext: () => context, onChange: value => notices.push(value), onInstalled, onStarting, onSettled };
  const service = createCatalogueSyncService(options); await service.load();
  return { service, options, context, rootPath, directory, store, calls, notices, maximum: () => maximum };
}

test('100000-entry analysis stays paginated, skips per-new-chart manifests and never downloads without Start', async t => {
  let downloads = 0, inspections = 0;
  const f = await fixture(t, { total: 100000, worker: { inspect: async () => { inspections++; }, run: async () => { downloads++; } } });
  await f.service.analyze({ mode: 'all', concurrency: 3, includeVideo: false }); await f.service.whenIdle();
  const status = f.service.status(); assert.equal(status.phase, 'ready'); assert.equal(status.total, 100000); assert.equal(status.counts.new, 100000);
  assert.equal(f.calls.length, 200); assert.equal(f.store.writes.maxPage, 500); assert.equal(f.store.writes.pages, 200);
  assert.equal(downloads, 0); assert.equal(inspections, 0); assert.ok(f.notices.every(value => value.items.length <= 50));
});

test('bounded concurrent transfers record provenance once, skip identical next sync, and report only actual completed installs', async t => {
  const installed = [], settled = [], starting = [];
  const f = await fixture(t, { onInstalled: value => installed.push(value), onStarting: value => starting.push(value), onSettled: value => settled.push(value) });
  await f.service.analyze({ concurrency: 3 }); await f.service.whenIdle(); await f.service.start(); await f.service.whenIdle();
  assert.ok(f.maximum() > 1 && f.maximum() <= 3); assert.equal(f.service.status().counts.completed, 6); assert.equal(f.service.status().receivedBytes, 180);
  assert.equal(installed.length, 6); assert.equal(starting.length, 1); assert.equal(settled.at(-1).changed, true);
  await f.service.analyze(); await f.service.whenIdle(); assert.equal(f.service.status().counts.unchanged, 6);
  await f.service.start(); await f.service.whenIdle(); assert.equal(installed.length, 6); assert.equal(f.service.status().receivedBytes, 0);
});

test('paused plan restarts explicitly, never resumes on load and keeps video and concurrency preferences', async t => {
  const gate = deferred(), entered = deferred(); let runs = 0;
  const f = await fixture(t, { worker: { inspect: async () => ({ state: 'new' }), run: async ({ signal, endpoint }) => {
    runs++; entered.resolve(); await gate.promise; signal.throwIfAborted(); return { changed: true, record: { endpoint }, receivedBytes: 30 };
  } } });
  await f.service.analyze({ concurrency: 1, includeVideo: true }); await f.service.whenIdle(); await f.service.start(); await entered.promise;
  const paused = f.service.pause(); gate.resolve(); await paused;
  assert.equal(f.service.status().phase, 'paused'); assert.equal(f.service.status().counts.completed, 0);
  const restored = createCatalogueSyncService(f.options); await restored.load();
  assert.equal(restored.status().phase, 'paused'); assert.equal(restored.status().includeVideo, true); assert.equal(restored.status().concurrency, 1); assert.equal(runs, 1);
});

test('installed-only includes tracked sources and old completed queue provenance, never arbitrary title matches', async t => {
  const inspected = [];
  const f = await fixture(t, { worker: { inspect: async value => { inspected.push(value); return { state: 'unchanged' }; }, run: async () => assert.fail('No download') } });
  await f.store.writeRecord(f.rootPath, endpoint(0), { endpoint: endpoint(0) });
  f.context.completedDownloads = [{ endpoint: endpoint(2), rootPath: f.rootPath, destination: path.join(f.rootPath, 'Legacy') }];
  await f.service.analyze({ mode: 'installed' }); await f.service.whenIdle();
  assert.equal(f.service.status().total, 2); assert.equal(f.service.status().counts.unchanged, 2); assert.equal(inspected.length, 2);
  assert.equal(inspected[1].candidateFolder, 'Legacy');
});

test('automatic synchronization retries real failures without leaving a review queue', async t => {
  let attempts = 0, repaired = false;
  const f = await fixture(t, { total: 3, worker: { inspect: async () => ({ state: 'new' }), run: async ({ endpoint }) => {
    attempts++;
    if (endpoint === descriptor(1).endpoint) throw Object.assign(Error(), { code: 'SYNC_CONFLICT' });
    if (endpoint === descriptor(2).endpoint && !repaired) throw Object.assign(Error(), { code: 'DOWNLOAD_NETWORK' });
    return { changed: true, record: { endpoint }, receivedBytes: 30 };
  } } });
  await f.service.analyze(); await f.service.whenIdle(); await f.service.start(); await f.service.whenIdle();
  assert.equal(f.service.status().counts.conflict, 0); assert.equal(f.service.status().counts.failed, 2); assert.equal(attempts, 3);
  repaired = true; await f.service.retry(); await f.service.whenIdle();
  assert.equal(attempts, 5); assert.equal(f.service.status().counts.failed, 1); assert.equal(f.service.status().counts.completed, 2); assert.equal(f.service.status().counts.conflict, 0);
});

test('a saved review row from an older app is processed with freshly resolved Songs candidates', async t => {
  const runs = [];
  const f = await fixture(t, { total: 1, worker: { inspect: async () => ({ state: 'new' }), run: async options => {
    runs.push(options);
    return { changed: true, record: { endpoint: options.endpoint }, receivedBytes: 30 };
  } } });
  await f.service.analyze();
  await f.service.whenIdle();
  const saved = await f.store.readState();
  const [entry] = await f.store.loadPage(saved.jobId, 0);
  await f.store.savePage(saved.jobId, 0, [{ ...entry, kind: 'conflict', state: 'conflict', error: 'LOCAL_CHANGED' }]);
  f.context.findCandidate = async () => ({ candidateFolders: ['Première version', 'Autre version'] });
  const restored = createCatalogueSyncService(f.options);
  await restored.load();
  assert.equal(restored.status().counts.conflict, 1);
  await restored.start();
  await restored.whenIdle();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].automatic, true);
  assert.equal(runs[0].candidateFolder, 'Première version');
  assert.deepEqual(runs[0].candidateFolders, ['Autre version']);
  assert.equal(restored.status().counts.conflict, 0);
  assert.equal(restored.status().counts.completed, 1);
});

test('changed catalogue between pages refuses partial plan, root/context change blocks writes', async t => {
  const f = await fixture(t, { total: 501 }); let calls = 0;
  f.options.catalogue.page = async ({ offset }) => ({ total: 501, revision: ++calls === 1 ? revision : 'b'.repeat(64), offset,
    nextOffset: offset === 0 ? 500 : null, items: Array.from({ length: offset === 0 ? 500 : 1 }, (_, i) => descriptor(offset + i)) });
  await f.service.analyze(); await f.service.whenIdle(); assert.equal(f.service.status().phase, 'error'); assert.equal(f.service.status().error, 'SYNC_CATALOGUE_CHANGED');
  await assert.rejects(f.service.start(), { code: 'SYNC_ANALYZE_FIRST' });
  f.context.active = false; await assert.rejects(f.service.analyze(), { code: 'SYNC_CONTEXT' });
});

test('real store journals recover complete events and ignore/truncate a torn final append', async t => {
  const f = await fixture(t), store = createCatalogueSyncStore({ dataDirectory: f.directory }), job = '12345678-1234-4234-8234-123456789012';
  await store.writeState({ version: 1 }); assert.deepEqual(await store.readState(), { version: 1 });
  await store.savePage(job, 0, [descriptor(0), descriptor(1)]);
  await store.append(job, 0, { index: 0, state: 'completed', receivedBytes: 30 });
  const journal = path.join(f.directory, 'catalogue-sync', 'plans', job, '000000.jsonl'); await fs.appendFile(journal, '{"index":');
  assert.equal((await store.loadPage(job, 0))[0].state, 'completed');
  await store.append(job, 0, { index: 1, state: 'failed', error: 'SYNC_NETWORK' });
  assert.equal((await store.loadPage(job, 0))[1].state, 'failed');
  await store.writeRecord(f.rootPath, endpoint(0), { revision }); assert.deepEqual(await store.readRecord(f.rootPath, endpoint(0)), { revision });
  assert.equal(await store.readRecord(f.rootPath, endpoint(2)), null);
});

test('sync IPC accepts only bounded options, rejects supplied paths and fake bulk sources', () => {
  assert.equal(validCommand('catalogueSync.analyze', { mode: 'all', concurrency: 4, includeVideo: false }, []), true);
  for (const payload of [{ mode: 'all', concurrency: 99, includeVideo: false }, { mode: 'enchor', concurrency: 2, includeVideo: false }, { mode: 'all', concurrency: 2, includeVideo: false, rootPath: 'C:\\' }]) assert.equal(validCommand('catalogueSync.analyze', payload, []), false);
  assert.equal(validCommand('catalogueSync.start', {}, []), true); assert.equal(validCommand('catalogueSync.start', { endpoint: 'https://example.test' }, []), false);
});

test('inventory client validates pages and handles server upgrade/change errors', async () => {
  const response = { revision, total: 1, offset: 0, nextOffset: null, items: [descriptor(1)] }, calls = [];
  const client = createCatalogueSyncClient({ fetcher: async (url, options) => { calls.push({ url, options }); return Response.json(response); } });
  assert.equal((await client.page()).items.length, 1); assert.equal(calls[0].options.credentials, 'omit');
  response.nextOffset = 0; await assert.rejects(client.page(), { code: 'SYNC_INVALID' });
  for (const [status, code] of [[404, 'SYNC_SERVER_UPDATE_REQUIRED'], [409, 'SYNC_CATALOGUE_CHANGED']]) {
    await assert.rejects(createCatalogueSyncClient({ fetcher: async () => new Response('', { status }) }).page(), { code });
  }
});

test('inventory timeout/abort settle even when a mocked fetch/read ignores its signal', async () => {
  const client = createCatalogueSyncClient({ timeoutMs: 10, fetcher: () => new Promise(() => {}) });
  await assert.rejects(client.page(), { code: 'SYNC_TIMEOUT' });
  const abort = new AbortController(); const pending = client.page({ signal: abort.signal }); abort.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
});

test('fresh real profile analyzes and installs with the real worker, then restores provenance without downloading identical files', async t => {
  const { createCatalogueSyncWorker } = require('../companion/catalogue-sync-worker.cjs');
  const { createHash } = require('node:crypto'); const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  let filesRequested = 0; const content = [Buffer.from('[song]\nname = Signal\nartist = Démo\n'), Buffer.from('[Song]\n{}')];
  const manifest = { title: 'Signal', artist: 'Démo', contentRevision: revision, files: content.map((bytes, i) => ({ parts: [i ? 'notes.chart' : 'song.ini'], size: bytes.length, sha256: hash(bytes), url: endpoint(0).replace('download-manifest', 'files/FileNumber' + String(i).padStart(10, '0')) })) };
  const worker = createCatalogueSyncWorker({ fetcher: async url => {
    if (url.endsWith('/download-manifest')) return Response.json(manifest);
    filesRequested++; return new Response(content[Number(url.at(-1))], { headers: { 'content-type': 'application/octet-stream' } });
  } });
  const f = await fixture(t, { total: 1, worker });
  const options = { ...f.options, store: createCatalogueSyncStore({ dataDirectory: f.directory }) }, service = createCatalogueSyncService(options);
  await service.load(); assert.equal(service.status().phase, 'idle');
  await service.analyze(); await service.whenIdle(); await service.start(); await service.whenIdle();
  assert.equal(service.status().phase, 'completed'); assert.equal(service.status().counts.completed, 1); assert.equal(filesRequested, 2);
  const restored = createCatalogueSyncService({ ...options, store: createCatalogueSyncStore({ dataDirectory: f.directory }) });
  await restored.load(); await restored.analyze(); await restored.whenIdle();
  assert.equal(restored.status().counts.unchanged, 1); assert.equal(filesRequested, 2);
});

test('duplicate Start requests and Pause during preparation cannot launch an orphan transfer', async t => {
  const entered = deferred(), release = deferred(); let starting = 0, settled = 0;
  const f = await fixture(t, { onStarting: async () => { starting++; entered.resolve(); await release.promise; }, onSettled: () => { settled++; } });
  const analyze = f.service.analyze(); await assert.rejects(f.service.analyze(), { code: 'SYNC_BUSY' }); await analyze; await f.service.whenIdle();
  const before = settled, first = f.service.start(); await entered.promise;
  await assert.rejects(f.service.start(), { code: 'SYNC_BUSY' }); await f.service.pause(); release.resolve();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(f.maximum(), 0); assert.equal(starting, 1); assert.equal(settled, before + 1); assert.equal(f.service.status().phase, 'paused');
});

test('disk-full stops the entire job before attempting the remaining catalogue', async t => {
  let attempts = 0;
  const f = await fixture(t, { total: 1000, worker: { inspect: async () => ({ state: 'new' }), run: async () => { attempts++; throw Object.assign(Error(), { code: 'ENOSPC' }); } } });
  await f.service.analyze({ concurrency: 2 }); await f.service.whenIdle(); await f.service.start(); await f.service.whenIdle();
  assert.equal(f.service.status().phase, 'error'); assert.equal(f.service.status().error, 'SYNC_NO_SPACE'); assert.ok(attempts <= 2);
});

test('a provenance failure after promotion stops further installs and still refreshes actual installed folders', async t => {
  let settled, attempts = 0, finalized = 0; const store = memoryStore(); store.writeRecord = async () => { throw Object.assign(Error(), { code: 'SYNC_STORAGE' }); };
  const f = await fixture(t, { total: 1000, store, onSettled: value => { settled = value; }, worker: {
    inspect: async () => ({ state: 'new' }), run: async ({ endpoint }) => { attempts++; return { changed: true, record: { endpoint }, receivedBytes: 10 }; }, finalize: async () => { finalized++; }
  } });
  await f.service.analyze({ concurrency: 1 }); await f.service.whenIdle(); await f.service.start(); await f.service.whenIdle();
  assert.equal(f.service.status().phase, 'error'); assert.equal(f.service.status().error, 'SYNC_STORAGE'); assert.equal(attempts, 1); assert.equal(settled.changed, true); assert.equal(finalized, 0);
});

test('receipt cleanup only runs after durable provenance and cannot turn an installed chart into a failed transfer', async t => {
  const f = await fixture(t, { total: 2 }), finalized = [];
  f.options.worker.finalize = async value => {
    assert.deepEqual(await f.store.readRecord(value.rootPath, value.endpoint), value.record);
    finalized.push(value.endpoint);
    throw Error('An unexpected receipt file must be preserved.');
  };
  await f.service.analyze(); await f.service.whenIdle(); await f.service.start(); await f.service.whenIdle();
  assert.equal(f.service.status().phase, 'completed'); assert.equal(f.service.status().counts.completed, 2); assert.equal(finalized.length, 2);
});

test('checking already identical receipts does not rewrite the installed provenance files', async t => {
  const f = await fixture(t, { total: 1000, worker: { inspect: async ({ record }) => ({ state: 'unchanged', record: structuredClone(record) }), run: () => assert.fail('Unchanged chart must not download') } });
  for (let index = 0; index < 1000; index++) await f.store.writeRecord(f.rootPath, endpoint(index), { endpoint: endpoint(index), revision });
  const before = f.store.writes.records;
  await f.service.analyze(); await f.service.whenIdle();
  assert.equal(f.service.status().counts.unchanged, 1000); assert.equal(f.store.writes.records, before);
});

test('a recovered update is reported only after its durable completion, and only once on resume', async t => {
  const store = memoryStore(), append = store.append, write = store.writeState;
  let failAppend = true, failSave = false, reports = 0, attempts = 0;
  store.append = async (...args) => { if (failAppend) throw Object.assign(Error(), { code: 'SYNC_STORAGE' }); await append(...args); };
  store.writeState = async state => { if (failSave && state.counts.completed) throw Object.assign(Error(), { code: 'SYNC_STORAGE' }); await write(state); };
  const f = await fixture(t, { total: 1, store, onInstalled: () => { reports++; }, worker: {
    inspect: async () => ({ state: 'update' }), run: async ({ endpoint }) => { attempts++; return { changed: true, record: { endpoint }, receivedBytes: 12 }; }
  } });
  await f.service.analyze(); await f.service.whenIdle(); await f.service.start(); await f.service.whenIdle();
  assert.equal(f.service.status().error, 'SYNC_STORAGE'); assert.equal(reports, 0);
  failAppend = false; failSave = true; await f.service.resume(); await f.service.whenIdle();
  assert.equal(f.service.status().error, 'SYNC_STORAGE'); assert.equal(reports, 1);
  failSave = false; await f.service.resume(); await f.service.whenIdle();
  assert.equal(f.service.status().phase, 'completed'); assert.equal(reports, 1); assert.equal(attempts, 2);
});

test('resume refreshes previously completed or reconciled installs even when no new bytes are written', async t => {
  let settled;
  const f = await fixture(t, { total: 1, onSettled: value => { settled = value; }, worker: {
    inspect: async () => ({ state: 'new' }), run: async ({ endpoint }) => ({ changed: false, record: { endpoint }, receivedBytes: 0 })
  } });
  await f.service.analyze(); await f.service.whenIdle(); await f.service.start(); await f.service.whenIdle();
  assert.equal(settled.changed, true); assert.equal(f.service.status().counts.completed, 0);
  const saved = await f.store.readState(); saved.phase = 'running'; saved.counts.completed = 1;
  f.store.pages.get(saved.jobId + ':0')[0].state = 'completed'; await f.store.writeState(saved);
  f.options.worker.run = () => assert.fail('Completed journal entry must not run again');
  const restored = createCatalogueSyncService(f.options); await restored.load(); await restored.resume(); await restored.whenIdle();
  assert.equal(settled.changed, true); assert.equal(restored.status().counts.completed, 1);
});
