'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { createBackgroundLibraryService } = require('../companion/library-background.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Background library timed out'); await delay(10); }
}
async function ready(service, revision = -1) {
  await until(() => service.status().status === 'ready' && service.status().revision > revision);
  return service.status();
}
async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-library-background-'));
  const root = path.join(base, 'songs'), dataDirectory = path.join(base, 'profile');
  await fs.mkdir(root); await fs.mkdir(dataDirectory);
  const workers = [], messages = [], notifications = [];
  const service = createBackgroundLibraryService({ dataDirectory,
    workerFactory: (filename, configuration) => {
      const worker = options.workerFactory ? options.workerFactory(filename, configuration) : new Worker(filename, configuration); workers.push(worker);
      worker.on('message', message => messages.push(message));
      return worker;
    },
    onChange: state => {
      notifications.push({ state, matching: service.matchingSnapshot() });
      options.onChange?.(state);
    }
  });
  t.after(async () => {
    await service.stop();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-library-background-')) throw Error('Unsafe test cleanup');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, dataDirectory, file: path.join(dataDirectory, 'library.json'), service, workers, messages, notifications };
}
async function song(root, folder, { title = folder, artist = 'Artist', charter = 'Charter', audio = false, format = 'chart' } = {}) {
  const directory = path.join(root, folder); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, format === 'midi' ? 'notes.mid' : 'notes.chart'), format === 'midi' ? 'MThd' : '[Song]\n{\n}\n');
  await fs.writeFile(path.join(directory, 'song.ini'), '[song]\nname=' + title + '\nartist=' + artist + '\ncharter=' + charter + '\n');
  if (audio) await fs.writeFile(path.join(directory, 'song.ogg'), 'synthetic fixture');
  return directory;
}

test('background library scans, searches and filters in a real worker with synchronized private snapshots', async t => {
  const f = await fixture(t);
  const folder = await song(f.root, 'Original', { title: 'Same Song', audio: true });
  await song(f.root, 'Copy', { title: 'same song', format: 'midi' });
  await song(f.root, 'Separate', { title: 'Unique Song', charter: 'Other Charter' });
  assert.equal(f.workers.length, 0, 'construction does not launch a worker');
  await f.service.load();
  assert.equal(f.workers.length, 1);
  assert.equal(f.service.status().status, 'idle');
  await f.service.selectRoot(f.root); await ready(f.service);
  const state = f.service.status(), matching = f.service.matchingSnapshot();
  assert.equal(state.count, 3); assert.equal(matching.items.length, 3); assert.equal(matching.revision, state.revision);
  const page = await f.service.query({ query: 'song', duplicates: 'possible', audio: 'missing', limit: 1 });
  assert.equal(page.total, 1); assert.equal(page.items[0].relativePath, 'Copy/notes.mid'); assert.equal(page.items[0].duplicateCount, 2);
  assert.equal(page.items[0].signature, undefined); assert.equal(page.items[0].folderRelativePath, undefined);
  const present = await f.service.query({ audio: 'present' });
  assert.equal(await f.service.resolveSongFolder(present.items[0].id), folder);
  assert.equal((await f.service.query({ query: 'other charter' })).total, 1);
  await assert.rejects(f.service.query({ audio: 'invalid' }), /invalide/);
  await assert.rejects(f.service.requestScan('invalid'), /invalide/);
  assert.equal(f.service.status().status, 'ready', 'a rejected operation does not kill the worker');
  state.settings.watch = true; state.progress.processed = 999;
  assert.equal(f.service.status().settings.watch, false); assert.notEqual(f.service.status().progress.processed, 999);
  assert.ok(Object.isFrozen(matching) && Object.isFrozen(matching.items) && Object.isFrozen(matching.items[0]));
  assert.equal(matching.items[0].relativePath, undefined); assert.equal(matching.items[0].signature, undefined);
  assert.throws(() => { matching.items[0].title = 'mutated'; }, TypeError);
  await f.service.configure({ refreshOnStart: false });
  assert.equal(f.service.matchingSnapshot(), matching, 'settings and queries do not replace matching data');
  for (const notification of f.notifications) {
    assert.equal(notification.state.revision, notification.matching.revision, 'onChange observes the updated matching cache');
    assert.equal(notification.state.count, notification.matching.items.length);
    assert.equal(notification.state.items, undefined, 'notifications contain no full index');
  }
  const snapshots = f.messages.filter(message => message.state?.matching).map(message => message.state.matching);
  assert.equal(new Set(snapshots.map(value => value.rootKey + ':' + value.revision)).size, snapshots.length, 'each committed index crosses the worker boundary once');
});

test('background cancellation retains committed songs, restarts and closes before reopening', async t => {
  const f = await fixture(t);
  await song(f.root, 'Keep', { title: 'Committed' });
  await f.service.load(); await f.service.selectRoot(f.root); await ready(f.service);
  await f.service.configure({ refreshOnStart: false });
  const before = f.service.matchingSnapshot();
  await Promise.all(Array.from({ length: 100 }, (_, index) => song(f.root, 'New ' + index)));
  const requested = f.service.requestScan('full'), cancelled = f.service.cancel();
  assert.equal(await requested, true); assert.equal(await cancelled, true);
  assert.equal(f.service.status().status, 'cancelled');
  assert.equal(f.service.matchingSnapshot(), before);
  assert.equal((await f.service.query()).total, 1);
  await f.service.requestScan('quick'); await ready(f.service, before.revision);
  assert.equal((await f.service.query()).total, 101);
  const committed = f.service.matchingSnapshot();
  const shutdown = f.service.stop(), reopen = f.service.start();
  await shutdown;
  assert.equal(f.workers[0].threadId, -1, 'shutdown joins the old worker');
  await reopen;
  assert.equal(f.workers.length, 2);
  assert.equal(f.service.status().status, 'ready');
  assert.deepEqual(f.service.matchingSnapshot(), committed);
  assert.equal((await f.service.query({ offset: 100, limit: 100 })).items.length, 1);
  await f.service.stop(); await f.service.stop();
  await assert.rejects(f.service.query(), /arrêté/);
  await f.service.load();
  assert.equal(f.workers.length, 3); assert.equal((await f.service.query()).total, 101);
});

test('background stop cancels scans before terminating', async t => {
  const f = await fixture(t);
  await song(f.root, 'Keep'); await f.service.load(); await f.service.selectRoot(f.root); await ready(f.service);
  const revision = f.service.status().revision;
  await Promise.all(Array.from({ length: 75 }, (_, index) => song(f.root, 'Pending ' + index)));
  await f.service.configure({ refreshOnStart: false });
  const scan = f.service.requestScan('full'), configure = f.service.configure({ watch: false }), stopped = f.service.stop();
  await Promise.all([scan, configure, stopped]);
  assert.equal(f.workers[0].threadId, -1);
  assert.equal(f.service.status().revision, revision);
  assert.equal(f.service.status().status, 'cancelled');
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(stored.items.length, 1); assert.equal(stored.settings.refreshOnStart, false);
  assert.ok((await fs.readdir(f.dataDirectory)).every(filename => !filename.endsWith('.tmp')));
  await f.service.start(); assert.equal((await f.service.query()).total, 1);
});

test('background stop waits for an in-flight durable settings write', async t => {
  const f = await fixture(t, { workerFactory: (filename, configuration) => new Worker(`
    const fs = require('node:fs/promises');
    const { parentPort, workerData } = require('node:worker_threads');
    const open = fs.open;
    fs.open = async (...args) => {
      const handle = await open(...args), sync = handle.sync.bind(handle);
      handle.sync = async () => {
        parentPort.postMessage({ type: 'test-write-started' });
        await new Promise(resolve => setTimeout(resolve, 100));
        return sync();
      };
      return handle;
    };
    require(workerData.workerScript);
  `, { eval: true, workerData: { ...configuration.workerData, workerScript: filename } }) });
  await f.service.load();
  const configure = f.service.configure({ refreshOnStart: false });
  await until(() => f.messages.some(message => message.type === 'test-write-started'));
  await f.service.stop();
  await configure;
  assert.equal(f.workers[0].threadId, -1);
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(stored.settings.refreshOnStart, false);
  assert.equal(f.service.status().settings.refreshOnStart, false);
  assert.deepEqual(await fs.readdir(f.dataDirectory), ['library.json']);
});

test('background worker failure rejects pending RPCs, preserves matching data and ignores stale generations', async t => {
  const f = await fixture(t);
  await song(f.root, 'Keep'); await f.service.load(); await f.service.selectRoot(f.root); await ready(f.service);
  await f.service.configure({ refreshOnStart: false });
  const matching = f.service.matchingSnapshot(), old = f.workers[0];
  const first = f.service.query(), second = f.service.configure({ watch: true });
  // A real worker with an injected runtime error makes in-flight rejection deterministic.
  old.emit('error', Error('private filesystem path and worker stack'));
  for (const request of [first, second]) await assert.rejects(request, error => /indisponible/.test(error.message) && !/private/.test(error.message));
  assert.equal(f.service.status().status, 'error'); assert.equal(f.service.status().count, 1);
  assert.equal(f.service.matchingSnapshot(), matching);
  await assert.rejects(f.service.query(), /indisponible/);
  await f.service.load();
  assert.equal(f.service.status().status, 'ready'); assert.equal(f.workers.length, 2);
  const reloaded = f.service.matchingSnapshot();
  old.emit('message', { type: 'change', state: { status: { ...f.service.status(), count: 999 }, matching: { rootKey: null, revision: 0, items: [] } } });
  assert.equal(f.service.status().count, 1); assert.equal(f.service.matchingSnapshot(), reloaded);
  await f.workers[1].terminate();
  await until(() => f.service.status().status === 'error');
  assert.equal(f.service.matchingSnapshot(), reloaded, 'an unexpected exit also preserves the visible index');
});

test('background worker construction failures are generic and retryable', async () => {
  const service = createBackgroundLibraryService({ dataDirectory: os.tmpdir(), workerFactory: () => { throw Error('private details'); } });
  await assert.rejects(service.load(), error => /indisponible/.test(error.message) && !/private/.test(error.message));
  assert.equal(service.status().status, 'error'); assert.deepEqual(service.matchingSnapshot().items, []);
  await assert.rejects(service.start(), /indisponible/);
  await service.stop();
});

test('background shutdown still resolves when its worker crashes with operations pending', async t => {
  const f = await fixture(t);
  await f.service.load();
  const query = f.service.query(), shutdown = f.service.stop();
  f.workers[0].emit('error', Error('private crash details'));
  await assert.rejects(query, /indisponible/);
  await shutdown;
  assert.equal(f.workers[0].threadId, -1);
  assert.equal(f.service.status().status, 'error');
  await f.service.start();
  assert.equal(f.service.status().status, 'idle');
});

test('an idle background worker does not keep a standalone Node process alive', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e',
    'const { createBackgroundLibraryService } = require(process.argv[1]); const service = createBackgroundLibraryService({ dataDirectory: process.argv[2] }); service.load().then(() => process.stdout.write("loaded"));',
    require.resolve('../companion/library-background.cjs'), f.dataDirectory
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const timeout = setTimeout(() => child.kill(), 10000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  clearTimeout(timeout);
  assert.equal(code, 0, stderr); assert.equal(stdout, 'loaded', 'pending RPC stays alive until load resolves');
});
