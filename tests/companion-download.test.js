const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Module, createRequire } = require('node:module');
const { createDownloadService } = require('../companion/download-service.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const abortError = () => Object.assign(Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
async function until(predicate, timeout = 4000) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > timeout) throw Error('Download condition timed out'); await delay(5); } }
function descriptor(index = 1) { return { chartId: `drive:root:song-${index}`, title: `Song ${index}`, artist: 'Artist', charter: 'Charter', endpoint: `/api/charts/00000000-0000-4000-8000-000000000000/DriveFileId${index}/download-manifest` }; }
async function injected(overrides) {
  const filename = require.resolve('../companion/download-service.cjs'), localModule = new Module(filename, module), normal = createRequire(filename);
  localModule.filename = filename; localModule.paths = Module._nodeModulePaths(path.dirname(filename)); localModule.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  localModule._compile(await fs.readFile(filename, 'utf8'), filename); return localModule.exports.createDownloadService;
}
function controlledWorker() {
  const worker = { runs: [], discarded: [], holdAbort: false, active: 0, maximum: 0, discardFailure: null };
  worker.run = options => {
    let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    const run = { ...options, settled: false, aborted: false };
    const finish = (callback, value) => { if (!run.settled) { run.settled = true; options.signal.removeEventListener('abort', onAbort); worker.active--; callback(value); } };
    run.resolve = value => finish(resolve, value); run.reject = value => finish(reject, value);
    const onAbort = () => { run.aborted = true; if (!worker.holdAbort) run.reject(abortError()); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    worker.runs.push(run); worker.maximum = Math.max(worker.maximum, ++worker.active); if (options.signal.aborted) onAbort(); return promise;
  };
  worker.discard = async data => { worker.discarded.push(data); if (worker.discardFailure) throw worker.discardFailure; };
  worker.resolveCompleted = async ({ rootPath, destination }) => {
    if (path.relative(rootPath, path.dirname(destination)) !== '') return null;
    try { const stat = await fs.lstat(destination); if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(destination, await fs.realpath(destination)) !== '') return null; return destination; } catch { return null; }
  };
  worker.complete = async (run, patch = {}) => {
    const folderName = `Installed-${run.id}`, destination = path.join(run.rootPath, folderName);
    await fs.mkdir(destination, { recursive: true }); await fs.writeFile(path.join(destination, 'notes.chart'), 'retained final chart');
    run.resolve({ destination, folderName, files: 2, totalBytes: 100, ...patch }); return destination;
  };
  return worker;
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-download-')), root = path.join(directory, 'songs'), data = path.join(directory, 'profile');
  await fs.mkdir(root); await fs.mkdir(data); const services = [], revisions = [], worker = options.worker ?? controlledWorker();
  const f = { directory, root, data, file: path.join(data, 'download-state.json'), worker, revisions };
  f.create = () => { const service = (options.factory ?? createDownloadService)({ dataDirectory: data, worker, onChange: snapshot => revisions.push(snapshot.revision) }); services.push(service); return service; };
  f.service = f.create(); f.initialize = async () => { await f.service.start(); await f.service.selectRoot(root); };
  t.after(async () => { worker.holdAbort = false; for (const run of worker.runs) if (!run.settled) run.reject(abortError()); for (const service of services) await service.stop(); if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('chartshub-download-')) throw Error('Unexpected temporary download folder'); await fs.rm(directory, { recursive: true, force: true }); });
  return f;
}
const state = (service, id) => service.status().items.find(item => item.id === id);

test('download defaults are isolated/offline and descriptor/root validation rejects unsafe requests', async t => {
  const f = await fixture(t); const initial = await f.service.load(); assert.deepEqual(initial, { revision: 0, rootPath: null, items: [], error: null });
  initial.items.push({}); assert.equal(f.service.status().items.length, 0); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  await assert.rejects(f.service.enqueue(descriptor()), { code: 'DOWNLOAD_SAFE' }); await f.service.start();
  await assert.rejects(f.service.enqueue(descriptor()), /dossier/); await assert.rejects(f.service.selectRoot('relative/path'), { code: 'DOWNLOAD_SAFE' });
  await assert.rejects(f.service.selectRoot(path.join(f.root, 'missing')), /inaccessible/); await f.service.selectRoot(f.root);
  for (const patch of [{ endpoint: 'https://evil.test/file' }, { endpoint: 'https://chartshub.ca' + descriptor().endpoint }, { endpoint: descriptor().endpoint + '?token=secret' }, { endpoint: descriptor().endpoint.replace('/api/', '/x/../api/') }, { chartId: '../outside' }, { path: f.root }, { title: null }]) await assert.rejects(f.service.enqueue({ ...descriptor(), ...patch }), { code: 'DOWNLOAD_SAFE' });
  assert.equal(f.worker.runs.length, 0);
});

test('queue transfers serially, deduplicates a chart in the same root and exposes no endpoints', async t => {
  const f = await fixture(t); await f.initialize(); const first = await f.service.enqueue(descriptor()), second = await f.service.enqueue(descriptor(2));
  assert.match(first.id, /^[a-f0-9-]{36}$/); assert.deepEqual(await f.service.enqueue(descriptor()), first);
  await until(() => f.worker.runs.length === 1); assert.equal(state(f.service, first.id).state, 'Downloading'); assert.equal(state(f.service, second.id).state, 'Queued');
  assert.ok(!JSON.stringify(f.service.status()).includes('endpoint')); assert.ok(!JSON.stringify(f.service.status()).includes('/download-manifest'));
  await f.worker.complete(f.worker.runs[0]); await until(() => f.worker.runs.length === 2); assert.equal(state(f.service, first.id).state, 'Completed');
  await f.worker.complete(f.worker.runs[1]); await until(() => state(f.service, second.id).state === 'Completed'); assert.equal(f.worker.maximum, 1);
  assert.deepEqual(await f.service.enqueue(descriptor()), first, 'completed entries also deduplicate');
});

test('pause waits for abort, preserves progress and resumes with the same UUID; late progress is fenced', async t => {
  const f = await fixture(t); await f.initialize(); const { id } = await f.service.enqueue(descriptor()); await until(() => f.worker.runs.length === 1);
  const run = f.worker.runs[0]; run.onProgress({ receivedBytes: 40, totalBytes: 100, completedFiles: 1, totalFiles: 2, currentFile: 'song.ogg' });
  await f.service.pause(id); assert.equal(run.aborted, true); assert.equal(state(f.service, id).state, 'Paused'); assert.equal(state(f.service, id).receivedBytes, 40); assert.equal(f.worker.discarded.length, 0);
  run.onProgress({ receivedBytes: 99, completedFiles: 2, currentFile: 'late' }); assert.equal(state(f.service, id).receivedBytes, 40);
  await f.service.resume(id); await until(() => f.worker.runs.length === 2); assert.equal(f.worker.runs[1].id, id);
  await f.worker.complete(f.worker.runs[1]); await until(() => state(f.service, id).state === 'Completed');
  assert.equal(state(f.service, id).receivedBytes, 100); assert.equal(state(f.service, id).completedFiles, 2);
});

test('queued pause has no worker traffic and resumes only on an explicit command', async t => {
  const f = await fixture(t); await f.initialize(); await f.service.enqueue(descriptor()); const second = await f.service.enqueue(descriptor(2)); await f.service.pause(second.id);
  await f.worker.complete(f.worker.runs[0]); await until(() => f.service.status().items[0].state === 'Completed'); await delay(10);
  assert.equal(f.worker.runs.length, 1); assert.equal(state(f.service, second.id).state, 'Paused'); await f.service.resume(second.id); await until(() => f.worker.runs.length === 2);
});

test('cancel waits for abort before discarding and retry cannot duplicate a replacement queue entry', async t => {
  const f = await fixture(t); await f.initialize(); const first = await f.service.enqueue(descriptor()); await until(() => f.worker.runs.length === 1);
  f.worker.holdAbort = true; let done = false; const cancelling = f.service.cancel(first.id).then(() => { done = true; });
  await until(() => f.worker.runs[0].aborted); assert.equal(f.worker.discarded.length, 0); assert.equal(done, false);
  f.worker.runs[0].reject(abortError()); await cancelling; assert.equal(state(f.service, first.id).state, 'Cancelled'); assert.deepEqual(f.worker.discarded, [{ id: first.id, rootPath: f.root }]);
  f.worker.holdAbort = false; const replacement = await f.service.enqueue(descriptor()); assert.notEqual(replacement.id, first.id);
  await assert.rejects(f.service.retry(first.id), /déjà/); await f.service.cancel(replacement.id);
  await f.service.retry(first.id); await until(() => f.worker.runs.some(run => run.id === first.id && run !== f.worker.runs[0]));
});

test('network failures are safe, keep partials, and retry advances the serial queue', async t => {
  const f = await fixture(t); await f.initialize(); const first = await f.service.enqueue(descriptor()), second = await f.service.enqueue(descriptor(2)); await until(() => f.worker.runs.length === 1);
  f.worker.runs[0].onProgress({ receivedBytes: 32, totalBytes: 100, completedFiles: 1, totalFiles: 2, currentFile: 'notes.chart' });
  f.worker.runs[0].reject(Object.assign(Error('https://secret.example?token=PRIVATE'), { code: 'DOWNLOAD_NETWORK' })); await until(() => f.worker.runs.length === 2);
  assert.equal(state(f.service, first.id).state, 'Failed'); assert.match(state(f.service, first.id).error, /connexion/); assert.ok(!JSON.stringify(f.service.status()).includes('PRIVATE'));
  assert.equal(state(f.service, first.id).receivedBytes, 32); assert.equal(f.worker.discarded.length, 0);
  await f.service.retry(first.id); assert.equal(state(f.service, first.id).state, 'Queued'); await f.worker.complete(f.worker.runs[1]); await until(() => f.worker.runs.length === 3); assert.equal(f.worker.runs[2].id, first.id); assert.equal(state(f.service, second.id).state, 'Completed');
});

test('changing root affects new tasks only, including the same chart selected in another folder', async t => {
  const f = await fixture(t); await f.initialize(); const first = await f.service.enqueue(descriptor()); await until(() => f.worker.runs.length === 1);
  const other = path.join(f.directory, 'other'); await fs.mkdir(other); await f.service.selectRoot(other); const second = await f.service.enqueue(descriptor()); assert.notEqual(first.id, second.id);
  assert.equal(f.worker.runs[0].rootPath, f.root); await f.worker.complete(f.worker.runs[0]); await until(() => f.worker.runs.length === 2); assert.equal(f.worker.runs[1].rootPath, other);
  assert.equal(state(f.service, first.id).rootPath, f.root); assert.equal(state(f.service, second.id).rootPath, other);
});

test('stop pauses active/queued tasks, awaits abort, and restarting does not produce traffic', async t => {
  const f = await fixture(t); await f.initialize(); const first = await f.service.enqueue(descriptor()), second = await f.service.enqueue(descriptor(2)); await until(() => f.worker.runs.length === 1);
  f.worker.holdAbort = true; let stopped = false; const stopping = f.service.stop().then(() => { stopped = true; });
  await until(() => f.worker.runs[0].aborted); await delay(5); assert.equal(stopped, false);
  await assert.rejects(f.service.enqueue(descriptor(3)), { code: 'DOWNLOAD_SAFE' }); f.worker.runs[0].reject(abortError()); await stopping;
  assert.equal(state(f.service, first.id).state, 'Paused'); assert.equal(state(f.service, second.id).state, 'Paused');
  const persisted = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.ok(persisted.items.every(item => item.state === 'Paused'));
  f.worker.holdAbort = false; await f.service.start(); await delay(10); assert.equal(f.worker.runs.length, 1); await f.service.resume(second.id); await until(() => f.worker.runs.length === 2); assert.equal(f.worker.runs[1].id, second.id);
});

test('interrupted persisted work restores Paused without changing files or starting transfers on load/start', async t => {
  const f = await fixture(t); const now = new Date().toISOString(), ids = [randomUUID(), randomUUID()];
  const saved = { version: 1, revision: 9, rootPath: f.root, items: ids.map((id, index) => ({ id, ...descriptor(index + 1), rootPath: f.root, state: index ? 'Queued' : 'Downloading', receivedBytes: 10, totalBytes: 100, completedFiles: 0, totalFiles: 2, currentFile: 'notes.chart', error: null, createdAt: now, updatedAt: now })) };
  const raw = JSON.stringify(saved); await fs.writeFile(f.file, raw); await f.service.load(); await f.service.start();
  assert.ok(f.service.status().items.every(item => item.state === 'Paused')); assert.equal(f.worker.runs.length, 0); assert.equal(await fs.readFile(f.file, 'utf8'), raw);
  await f.service.resume(ids[0]); await until(() => f.worker.runs.length === 1); assert.equal(f.worker.runs[0].id, ids[0]);
});

test('future/corrupt state stays protected from every mutation and stop cannot overwrite it', async t => {
  const f = await fixture(t);
  for (const raw of ['{"version":8,"future":"keep"}', '{broken']) {
    await fs.writeFile(f.file, raw); const service = f.create(); await service.start(); assert.ok(service.status().error);
    for (const operation of [() => service.selectRoot(f.root), () => service.enqueue(descriptor()), () => service.resume(randomUUID()), () => service.remove(randomUUID())]) await assert.rejects(operation(), { code: 'DOWNLOAD_SAFE' });
    await service.stop(); assert.equal(await fs.readFile(f.file, 'utf8'), raw);
  }
});

test('completed history removal cleans only the worker receipt and never the installed folder', async t => {
  const f = await fixture(t); await f.initialize(); const { id } = await f.service.enqueue(descriptor()); await until(() => f.worker.runs.length === 1);
  const destination = await f.worker.complete(f.worker.runs[0]); await until(() => state(f.service, id).state === 'Completed'); assert.equal(await f.service.resolveFolder(id), destination);
  await assert.rejects(f.service.cancel(id), { code: 'DOWNLOAD_SAFE' }); await assert.rejects(f.service.pause(id), { code: 'DOWNLOAD_SAFE' }); await f.service.remove(id);
  assert.equal(f.service.status().items.length, 0); assert.deepEqual(f.worker.discarded, [{ id, rootPath: f.root }]); assert.equal(await fs.readFile(path.join(destination, 'notes.chart'), 'utf8'), 'retained final chart');
  await assert.rejects(f.service.resolveFolder(id), { code: 'DOWNLOAD_SAFE' });
});

test('remove Paused discards partials and failed cleanup retains recoverable history', async t => {
  const f = await fixture(t); await f.initialize(); const { id } = await f.service.enqueue(descriptor()); await until(() => f.worker.runs.length === 1); await f.service.pause(id);
  f.worker.discardFailure = Error('private filesystem path'); await assert.rejects(f.service.remove(id), /nettoyer/); assert.equal(state(f.service, id).state, 'Paused');
  f.worker.discardFailure = null; await f.service.remove(id); assert.equal(f.service.status().items.length, 0);
});

test('completed promotion wins a too-late cancel without deleting the final destination', async t => {
  const f = await fixture(t); await f.initialize(); const { id } = await f.service.enqueue(descriptor()); await until(() => f.worker.runs.length === 1); f.worker.holdAbort = true;
  const cancelling = f.service.cancel(id); await until(() => f.worker.runs[0].aborted); const destination = await f.worker.complete(f.worker.runs[0]); await cancelling;
  assert.equal(state(f.service, id).state, 'Completed'); assert.equal(f.worker.discarded.length, 0); assert.ok((await fs.stat(destination)).isDirectory());
});

test('malformed completion or missing/replaced final directories cannot be opened', async t => {
  const f = await fixture(t); await f.initialize(); const first = await f.service.enqueue(descriptor()); await until(() => f.worker.runs.length === 1);
  f.worker.runs[0].resolve({ destination: f.directory, folderName: path.basename(f.directory), files: 1, totalBytes: 1 }); await until(() => state(f.service, first.id).state === 'Failed');
  await assert.rejects(f.service.resolveFolder(first.id), /uniquement/);
  const second = await f.service.enqueue(descriptor(2)); await until(() => f.worker.runs.length === 2); const destination = await f.worker.complete(f.worker.runs[1]); await until(() => state(f.service, second.id).state === 'Completed');
  const moved = path.join(f.root, 'moved'); await fs.rename(destination, moved); await fs.symlink(f.directory, destination, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.resolveFolder(second.id), /indisponible/);
});

test('pending root selection cannot commit or schedule work after stop', async t => {
  const entered = deferred(), gate = deferred(); let hold = false;
  const factory = await injected({ 'node:fs/promises': { ...fs, realpath: async value => { if (hold) { entered.resolve(); await gate.promise; } return fs.realpath(value); } } });
  const f = await fixture(t, { factory }); await f.initialize(); const other = path.join(f.directory, 'new-root'); await fs.mkdir(other); hold = true;
  const selecting = f.service.selectRoot(other), rejected = assert.rejects(selecting, { code: 'DOWNLOAD_SAFE' }); await entered.promise;
  const stopping = f.service.stop(); gate.resolve(); await rejected; await stopping; assert.equal(f.service.status().rootPath, f.root); assert.equal(f.worker.runs.length, 0);
});

test('progress is throttled, does not write per chunk and revisions remain monotone across concurrent saves', async t => {
  let writes = 0, hold = false; const entered = deferred(), gate = deferred();
  const factory = await injected({ 'node:fs/promises': { ...fs, rename: async (...args) => { writes++; if (hold) { entered.resolve(); await gate.promise; } return fs.rename(...args); } } });
  const f = await fixture(t, { factory }); await f.initialize(); await f.service.enqueue(descriptor()); await until(() => f.worker.runs.length === 1);
  const baselineWrites = writes, baselineNotifications = f.revisions.length, run = f.worker.runs[0];
  for (let count = 0; count < 100; count++) run.onProgress({ receivedBytes: count, totalBytes: 100, completedFiles: 0, totalFiles: 1, currentFile: 'song.ogg' });
  assert.equal(writes, baselineWrites); assert.ok(f.revisions.length - baselineNotifications <= 1);
  const other = path.join(f.directory, 'other-root'); await fs.mkdir(other); hold = true; const selecting = f.service.selectRoot(other); await entered.promise; await delay(110);
  run.onProgress({ receivedBytes: 100, totalBytes: 100, completedFiles: 1, totalFiles: 1, currentFile: 'song.ogg' }); const progressRevision = f.service.status().revision;
  gate.resolve(); await selecting; hold = false; assert.ok(f.service.status().revision > progressRevision);
  assert.ok(f.revisions.every((value, index) => index === 0 || value >= f.revisions[index - 1]));
});

test('a failed atomic enqueue keeps disk and queue unchanged and exposes no raw filesystem error', async t => {
  let fail = false;
  const factory = await injected({ 'node:fs/promises': { ...fs, rename: async (...args) => { if (fail) throw Object.assign(Error('C:\\PRIVATE\\secret'), { code: 'EACCES' }); return fs.rename(...args); } } });
  const f = await fixture(t, { factory }); await f.initialize(); const original = await fs.readFile(f.file, 'utf8'); fail = true;
  await assert.rejects(f.service.enqueue(descriptor()), { code: 'DOWNLOAD_SAFE' }); assert.equal(f.service.status().items.length, 0); assert.equal(f.worker.runs.length, 0); assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.ok(!f.service.status().error.includes('PRIVATE')); assert.ok(!(await fs.readdir(f.data)).some(name => name.endsWith('.tmp'))); fail = false;
});

test('queue limits remain bounded at 100 persisted records', async t => {
  const f = await fixture(t); const now = new Date().toISOString();
  const items = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(), ...descriptor(index), rootPath: f.root, state: 'Paused', receivedBytes: 0, totalBytes: null, completedFiles: 0, totalFiles: null, currentFile: null, error: null, createdAt: now, updatedAt: now }));
  await fs.writeFile(f.file, JSON.stringify({ version: 1, revision: 1, rootPath: f.root, items })); await f.service.start();
  await assert.rejects(f.service.enqueue(descriptor(101)), /100/); assert.equal(f.service.status().items.length, 100); assert.equal(f.worker.runs.length, 0);
  await f.service.remove(items[0].id); await f.service.enqueue(descriptor(101)); await until(() => f.worker.runs.length === 1);
});
