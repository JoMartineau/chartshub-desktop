const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { Module, createRequire } = require('node:module');
const { createInstalledLibraryService } = require('../companion/library-service.cjs');
const { scanLibrary, SCANNER_LIMITS } = require('../companion/library-scanner.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate, timeout = 6000) {
  const started = Date.now(); while (!predicate()) { if (Date.now() - started > timeout) throw Error('Library condition timed out'); await delay(10); }
}
async function settled(service) { await until(() => service.status().status !== 'scanning'); await delay(0); return service.status(); }
async function injected(filename, overrides) {
  const absolute = require.resolve(filename), local = new Module(absolute, module), normal = createRequire(absolute);
  local.filename = absolute; local.paths = Module._nodeModulePaths(path.dirname(absolute));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute); return local.exports;
}
async function fixture(t, factory = createInstalledLibraryService) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-library-'));
  const root = path.join(base, 'songs'), data = path.join(base, 'profile');
  await fs.mkdir(root); await fs.mkdir(data); const services = [];
  function create(options = {}) { const service = factory({ dataDirectory: data, ...options }); services.push(service); return service; }
  const service = create();
  t.after(async () => {
    for (const item of services) await item.stop();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-library-')) throw Error('Unexpected library test directory');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, data, file: path.join(data, 'library.json'), service, create };
}
async function song(root, folder, ini = '', format = 'chart') {
  const target = path.join(root, folder); await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'notes.' + (format === 'midi' ? 'mid' : 'chart')), format === 'midi' ? 'MThd' : '[Song]\n{\n Name = "Chart fallback"\n Artist = "Chart Artist"\n Year = ", 1997"\n}\n');
  if (ini) await fs.writeFile(path.join(target, 'song.ini'), ini);
  return target;
}
function sng(metadata, names = ['notes.mid', 'song.ogg']) {
  const u64 = n => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(n)); return bytes; };
  const string = text => { const bytes = Buffer.from(text), length = Buffer.alloc(4); length.writeInt32LE(bytes.length); return Buffer.concat([length, bytes]); };
  const entries = Object.entries(metadata), meta = Buffer.concat([u64(entries.length), ...entries.flatMap(([key, value]) => [string(key), string(value)])]);
  const indexLength = 8 + names.reduce((sum, name) => sum + 1 + Buffer.byteLength(name) + 16, 0);
  let offset = 26 + 8 + meta.length + 8 + indexLength + 8;
  const index = Buffer.concat([u64(names.length), ...names.map(name => { const bytes = Buffer.from(name), entry = Buffer.concat([Buffer.from([bytes.length]), bytes, u64(1), u64(offset)]); offset++; return entry; })]);
  const header = Buffer.alloc(26); header.write('SNGPKG'); header.writeUInt32LE(1, 6);
  return Buffer.concat([header, u64(meta.length), meta, u64(index.length), index, u64(names.length), Buffer.alloc(names.length)]);
}

test('library missing: isolated defaults, no file writes, safe query validation', async t => {
  const f = await fixture(t); const loaded = await f.service.load();
  assert.equal(loaded.status, 'idle'); assert.deepEqual(loaded.settings, { rootPath: null, watch: false, refreshOnStart: true });
  loaded.settings.watch = true; assert.equal(f.service.status().settings.watch, false);
  assert.deepEqual(f.service.query(), { items: [], total: 0, offset: 0, limit: 50, revision: 0 });
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  assert.throws(() => f.service.requestScan('full'), /dossier/);
  for (const options of [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { sort: 'path' }, { query: null }, { path: '/' }, { audio: 'broken' }, { audio: null }, { audio: true }, { duplicates: 'exact' }, { duplicates: null }, { duplicates: true }]) assert.throws(() => f.service.query(options));
  await assert.rejects(f.service.configure({ watch: 'yes' }));
});

test('library excludes Companion download staging until the completed folder is published', async t => {
  const f = await fixture(t);
  const partial = await song(f.root, '.chartshub-companion-12345678-1234-4123-8123-123456789abc', '[song]\nname = Pending\n');
  const publishing = await song(f.root, 'Being published', '[song]\nname = Publishing\n');
  await fs.writeFile(path.join(publishing, '.chartshub-companion-installing'), '');
  await song(f.root, '.chartshub-companion-ordinary-album', '[song]\nname = Real album\n');
  await f.service.selectRoot(f.root); await settled(f.service);
  assert.deepEqual(f.service.query().items.map(item => item.title), ['Real album']);
  await fs.rename(partial, path.join(f.root, 'Published'));
  f.service.requestScan('quick'); await settled(f.service);
  assert.deepEqual(f.service.query().items.map(item => item.title), ['Pending', 'Real album']);
  await fs.unlink(path.join(publishing, '.chartshub-companion-installing'));
  f.service.requestScan('quick'); await settled(f.service);
  assert.deepEqual(f.service.query().items.map(item => item.title), ['Pending', 'Publishing', 'Real album']);
});

test('full scan reads Chart/INI/MIDI/SNG metadata, audio presence, and never writes songs', async t => {
  const f = await fixture(t);
  const folder = await song(f.root, 'Foo', '[song]\nname = Everlong\nartist = Foo Fighters\ncharter = ExampleCharter\nalbum = The Colour and the Shape\nyear = 1997\n');
  await fs.writeFile(path.join(folder, 'notes.mid'), 'also present'); await fs.writeFile(path.join(folder, 'song.ogg'), 'unchanged audio');
  await song(f.root, 'Midi only', '[song]\nname = Midi song\n', 'midi');
  await fs.writeFile(path.join(f.root, 'Packed.sng'), sng({ name: 'Packed title', artist: 'Packed artist', charter: 'SNG Charter', year: '2026' }));
  const before = await fs.stat(path.join(folder, 'song.ogg'));
  await f.service.selectRoot(f.root); const state = await settled(f.service); const page = f.service.query();
  assert.equal(state.status, 'ready'); assert.equal(state.count, 3); assert.deepEqual(state.changes, { added: 3, removed: 0, modified: 0 });
  const everlong = page.items.find(item => item.title === 'Everlong');
  assert.deepEqual(everlong, { id: everlong.id, relativePath: 'Foo/notes.chart', title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', album: 'The Colour and the Shape', year: '1997', format: 'chart', audio: 'present' });
  assert.match(everlong.id, /^[a-f0-9]{64}$/); assert.equal(await f.service.resolveSongFolder(everlong.id), folder);
  assert.equal(page.items.find(item => item.format === 'midi').audio, 'missing');
  assert.equal(page.items.find(item => item.format === 'sng').charter, 'SNG Charter');
  assert.equal(page.items.find(item => item.format === 'sng').audio, 'present');
  assert.equal((await fs.stat(path.join(folder, 'song.ogg'))).mtimeMs, before.mtimeMs);
  assert.equal(await fs.readFile(path.join(folder, 'song.ogg'), 'utf8'), 'unchanged audio');
  assert.ok(!JSON.stringify(page).includes(f.root)); assert.ok(!Object.hasOwn(everlong, 'signature'));
  page.items[0].title = 'mutated'; assert.notEqual(f.service.query().items[0].title, 'mutated');
});

test('quick scan detects additions, metadata edits and deletions with stable IDs and searchable pagination', async t => {
  const f = await fixture(t); const a = await song(f.root, 'A', '[song]\nname=Alpha\nartist=Zulu\ncharter=First\n');
  await song(f.root, 'B', '[song]\nname=Beta\nartist=Alpha\n');
  await f.service.selectRoot(f.root); await settled(f.service); const id = f.service.query({ query: 'first' }).items[0].id;
  f.service.requestScan('quick'); await settled(f.service); assert.deepEqual(f.service.status().changes, { added: 0, removed: 0, modified: 0 });
  await fs.writeFile(path.join(a, 'song.ini'), '[song]\nname=Alpha updated\nartist=Updated Band\ncharter=First\n');
  await fs.unlink(path.join(f.root, 'B', 'notes.chart')); await song(f.root, 'C', '[song]\nname=Charlie\nartist=A Band\n');
  f.service.requestScan('quick'); await settled(f.service);
  assert.deepEqual(f.service.status().changes, { added: 1, removed: 1, modified: 1 });
  assert.equal(f.service.query({ query: 'updated' }).items[0].id, id);
  const page = f.service.query({ query: 'band', sort: 'artist', offset: 1, limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.items[0].title, 'Alpha updated');
});

test('atomic index persists independently, preferences keep revision stable, restart without refresh retains ready index', async t => {
  const f = await fixture(t); await song(f.root, 'Track'); await f.service.selectRoot(f.root); await settled(f.service);
  const revision = f.service.status().revision, scannedAt = f.service.status().lastScanAt;
  await f.service.configure({ refreshOnStart: false }); assert.equal(f.service.status().revision, revision);
  await Promise.all([f.service.start(), f.service.start()]); await Promise.all([f.service.stop(), f.service.stop()]);
  assert.equal(f.service.status().status, 'ready'); await f.service.start(); assert.equal(f.service.status().lastScanAt, scannedAt);
  const second = f.create(); await second.load(); assert.equal(second.status().count, 1); assert.equal(second.status().status, 'ready');
  assert.deepEqual(second.query(), f.service.query()); await second.start(); assert.equal(second.status().status, 'ready');
  const stored = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(stored.version, 1); assert.equal(stored.items.length, 1);
  assert.ok((await fs.readdir(f.data)).every(name => ['library.json', 'library.json.bak'].includes(name)));
});

test('future and corrupt indexes remain untouched; explicit root selection backs up a corrupt file', async t => {
  const f = await fixture(t); const original = '{"version":91,"future":"preserve"}'; await fs.writeFile(f.file, original);
  await f.service.load(); assert.equal(f.service.status().status, 'error');
  await assert.rejects(f.service.configure({ watch: true }), /protégé/); await assert.rejects(f.service.selectRoot(f.root), /protégé/);
  await f.service.start(); await f.service.stop(); assert.equal(await fs.readFile(f.file, 'utf8'), original);
  const corrupt = '{ broken json'; await fs.writeFile(f.file, corrupt); const recovered = f.create(); await recovered.load();
  await assert.rejects(recovered.configure({ watch: true })); assert.equal(await fs.readFile(f.file, 'utf8'), corrupt);
  await recovered.selectRoot(f.root);
  await settled(recovered); assert.equal(recovered.status().status, 'ready');
  const backups = (await fs.readdir(f.data)).filter(name => /^library\.json\.corrupt-.*\.bak$/.test(name));
  assert.equal(backups.length, 1); assert.equal(await fs.readFile(path.join(f.data, backups[0]), 'utf8'), corrupt);
  await recovered.configure({ refreshOnStart: false }); recovered.requestScan('quick'); await settled(recovered);
  assert.equal(await fs.readFile(path.join(f.data, backups[0]), 'utf8'), corrupt, 'the original survives later commits');
});

test('cancel and scan faults keep committed songs; only one queued refresh runs', async t => {
  let calls = 0, gate = null, fail = null;
  const module = await injected('../companion/library-service.cjs', { './library-scanner.cjs': { SCANNER_LIMITS, scanLibrary: async options => {
    calls++; if (fail) throw fail;
    if (gate) { const held = gate; gate = null; await held.promise; }
    return scanLibrary(options);
  } } });
  const f = await fixture(t, module.createInstalledLibraryService); await song(f.root, 'Old'); await f.service.selectRoot(f.root); await settled(f.service);
  const committed = f.service.query(), disk = await fs.readFile(f.file, 'utf8');
  const held = deferred(); gate = held; f.service.requestScan('quick'); f.service.requestScan('quick'); f.service.requestScan('full');
  assert.equal(f.service.cancel(), true); held.resolve(); await settled(f.service); await delay(20);
  assert.equal(f.service.status().status, 'cancelled'); assert.equal(calls, 2); assert.deepEqual(f.service.query(), committed); assert.equal(await fs.readFile(f.file, 'utf8'), disk);
  fail = Object.assign(Error('C:\\private\\secret stack'), { code: 'EACCES' }); f.service.requestScan('full'); await settled(f.service);
  assert.equal(f.service.status().status, 'error'); assert.ok(!f.service.status().error.includes('private')); assert.deepEqual(f.service.query(), committed);
  fail = Error('Unexpected scanner failure'); f.service.requestScan('full'); await settled(f.service);
  assert.equal(f.service.status().status, 'error'); assert.deepEqual(f.service.query(), committed); assert.equal(await fs.readFile(f.file, 'utf8'), disk);
  fail = null; const second = deferred(); gate = second; f.service.requestScan('quick'); f.service.requestScan('quick'); f.service.requestScan('full'); f.service.requestScan('quick'); second.resolve();
  await until(() => calls === 6 && f.service.status().status === 'ready'); assert.equal(calls, 6);
});

test('stop waits for cancellation, invalidates in-flight root/configuration, and can restart', async t => {
  let entered, hold, blockRealpath = false;
  const module = await injected('../companion/library-service.cjs', { 'node:fs/promises': { ...fs, realpath: async target => {
    if (blockRealpath) { entered.resolve(); await hold.promise; } return fs.realpath(target);
  } } });
  const f = await fixture(t, module.createInstalledLibraryService); await song(f.root, 'One'); await f.service.selectRoot(f.root); await settled(f.service);
  await f.service.configure({ refreshOnStart: false }); await f.service.start(); const old = f.service.status();
  const alternative = path.join(f.base, 'other'); await fs.mkdir(alternative);
  entered = deferred(); hold = deferred(); blockRealpath = true; const selecting = f.service.selectRoot(alternative); await entered.promise;
  const configuring = f.service.configure({ watch: true }); await f.service.stop(); hold.resolve(); await Promise.all([selecting, configuring]); blockRealpath = false;
  assert.equal(f.service.status().settings.rootPath, old.settings.rootPath); assert.equal(f.service.status().settings.watch, false); assert.equal(f.service.status().watcher, 'off');
  await f.service.start(); assert.equal(f.service.status().status, 'ready'); assert.equal(f.service.status().revision, old.revision);
});

test('selecting the same root retains its index and a scan requested immediately after cancel still runs', async t => {
  let gate, calls = 0;
  const module = await injected('../companion/library-service.cjs', { './library-scanner.cjs': { SCANNER_LIMITS, scanLibrary: async options => {
    calls++; if (gate) { const held = gate; gate = null; await held.promise; } return scanLibrary(options);
  } } });
  const f = await fixture(t, module.createInstalledLibraryService); await song(f.root, 'Retained'); await f.service.selectRoot(f.root); await settled(f.service);
  const committed = f.service.query(), scannedAt = f.service.status().lastScanAt;
  const held = deferred(); gate = held; await f.service.selectRoot(f.root);
  assert.equal(f.service.status().status, 'scanning'); assert.deepEqual(f.service.query(), committed); assert.equal(f.service.status().lastScanAt, scannedAt);
  f.service.cancel(); assert.equal(f.service.requestScan('full'), true); held.resolve();
  await until(() => calls === 3 && f.service.status().status === 'ready'); assert.equal(f.service.query().total, 1);
});

test('stop waits for the active scanner to unwind and discards queued refreshes', async t => {
  let gate, calls = 0;
  const module = await injected('../companion/library-service.cjs', { './library-scanner.cjs': { SCANNER_LIMITS, scanLibrary: async options => {
    calls++; if (gate) { const held = gate; gate = null; await held.promise; } return scanLibrary(options);
  } } });
  const f = await fixture(t, module.createInstalledLibraryService); await song(f.root, 'Committed'); await f.service.selectRoot(f.root); await settled(f.service);
  await f.service.configure({ refreshOnStart: false }); await f.service.start(); const page = f.service.query();
  const held = deferred(); gate = held; f.service.requestScan('quick'); f.service.requestScan('full');
  let stopped = false; const stopping = f.service.stop().then(() => { stopped = true; });
  await delay(15); assert.equal(stopped, false); held.resolve(); await stopping; await delay(15);
  assert.equal(calls, 2); assert.deepEqual(f.service.query(), page); assert.equal(f.service.status().status, 'cancelled'); assert.equal(f.service.status().watcher, 'off');
  await f.service.start(); assert.deepEqual(f.service.query(), page); assert.equal(calls, 2);
});

test('atomic persistence failure preserves the committed index and cleans temporary files', async t => {
  let failRename = false;
  const module = await injected('../companion/library-service.cjs', { 'node:fs/promises': { ...fs, rename: async (...args) => {
    if (failRename) throw Object.assign(Error('C:\\secret\\private'), { code: 'EACCES' }); return fs.rename(...args);
  } } });
  const f = await fixture(t, module.createInstalledLibraryService); await song(f.root, 'Committed'); await f.service.selectRoot(f.root); await settled(f.service);
  const before = await fs.readFile(f.file, 'utf8'), page = f.service.query(); await song(f.root, 'New');
  failRename = true; f.service.requestScan('quick'); await settled(f.service);
  assert.equal(f.service.status().status, 'error'); assert.deepEqual(f.service.query(), page); assert.equal(await fs.readFile(f.file, 'utf8'), before);
  assert.ok(!(await fs.readdir(f.data)).some(name => name.endsWith('.tmp'))); assert.ok(!f.service.status().error.includes('secret'));
});

test('watcher debounces recursively, queues one scan, reports unavailable, and closes on stop', async t => {
  const watchers = []; let scanCount = 0, gate;
  const module = await injected('../companion/library-service.cjs', {
    'node:fs': { ...nativeFs, watch: (root, options, callback) => { const watcher = new EventEmitter(); Object.assign(watcher, { root, options, callback, closed: false, close() { this.closed = true; } }); watchers.push(watcher); return watcher; } },
    './library-scanner.cjs': { SCANNER_LIMITS, scanLibrary: async options => { scanCount++; if (gate) { const held = gate; gate = null; await held.promise; } return scanLibrary(options); } }
  });
  const f = await fixture(t, module.createInstalledLibraryService);
  // A song folder inside the data directory is supported; its events must not be suppressed.
  const nested = path.join(f.data, 'Songs'); await song(nested, 'One'); await f.service.selectRoot(nested); await settled(f.service);
  await f.service.configure({ watch: true, refreshOnStart: false }); await f.service.start(); const watcher = watchers.at(-1);
  assert.equal(watcher.options.recursive, true); assert.equal(f.service.status().watcher, 'watching');
  watcher.callback('change', '.chartshub-companion-12345678-1234-4123-8123-123456789abc/active.part');
  watcher.callback('change', 'Nested\\.chartshub-companion-12345678-1234-4123-8123-123456789abc\\files\\blob');
  await delay(850); assert.equal(scanCount, 1, 'download chunks do not trigger library scans');
  watcher.callback('change', 'One/song.ini'); watcher.callback('change', 'One/notes.chart');
  await until(() => scanCount === 2 && f.service.status().status === 'ready');
  const held = deferred(); gate = held; f.service.requestScan('quick'); watcher.callback('rename', 'One'); await delay(850); watcher.callback('change', 'One/song.ini'); await delay(850);
  assert.equal(scanCount, 3); held.resolve(); await until(() => scanCount === 4 && f.service.status().status === 'ready');
  watcher.emit('error', Error('watch failed')); assert.equal(f.service.status().watcher, 'unavailable'); assert.equal(watcher.closed, true);
  await f.service.configure({ watch: false }); await f.service.configure({ watch: true }); const final = watchers.at(-1);
  final.callback('change', 'One'); await f.service.stop(); await delay(800); assert.equal(final.closed, true); assert.equal(scanCount, 4);
});

test('native recursive watcher refreshes changed metadata when supported', async t => {
  let nativeEvents = 0;
  const module = await injected('../companion/library-service.cjs', {
    'node:fs': { ...nativeFs, watch: (root, options, callback) => nativeFs.watch(root, options, (...args) => { nativeEvents++; callback(...args); }) }
  });
  const f = await fixture(t, module.createInstalledLibraryService); const directory = await song(f.root, 'Watched', '[song]\nname=Before\n');
  await f.service.selectRoot(f.root); await settled(f.service); await f.service.configure({ watch: true, refreshOnStart: false }); await f.service.start();
  if (f.service.status().watcher === 'unavailable') { t.diagnostic('Recursive filesystem watcher unavailable on this platform; deterministic watcher contract is covered separately.'); return; }
  // fs.watch has no ready event. In particular, macOS can finish attaching
  // FSEvents after start() returns. Prime the real callback with a harmless
  // fixture file before making the single metadata change under test.
  const revision = f.service.status().revision, started = Date.now();
  while (!nativeEvents && Date.now() - started < 6000) {
    await fs.writeFile(path.join(f.root, '.watcher-ready'), String(Date.now()));
    await delay(100);
  }
  assert.ok(nativeEvents > 0, 'the native watcher must acknowledge a real filesystem event');
  await until(() => f.service.status().revision > revision && f.service.status().status === 'ready');
  assert.equal(f.service.query().items[0]?.title, 'Before');
  const beforeChange = nativeEvents;
  await fs.writeFile(path.join(directory, 'song.ini'), '[song]\nname=After native event\n');
  await until(() => nativeEvents > beforeChange && f.service.query().items[0]?.title === 'After native event');
  assert.equal(f.service.status().status, 'ready');
});

test('scanner skips directory links and open-folder rejects a folder replaced by a junction', async t => {
  const f = await fixture(t); const outside = path.join(f.base, 'outside'); await song(outside, 'External');
  await song(f.root, 'Inside'); await fs.symlink(outside, path.join(f.root, 'Linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.service.selectRoot(f.root); await settled(f.service); assert.equal(f.service.status().count, 1); assert.ok(f.service.status().skippedCount >= 1);
  const id = f.service.query().items[0].id;
  await fs.rename(path.join(f.root, 'Inside'), path.join(f.root, 'Original')); await fs.symlink(outside, path.join(f.root, 'Inside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.resolveSongFolder(id), /indisponible/);
  await assert.rejects(f.service.resolveSongFolder('../outside')); await assert.rejects(f.service.resolveSongFolder('a'.repeat(64)));
});

test('file symlinks are excluded where the platform permits creating them', async t => {
  const f = await fixture(t); const outside = await song(f.base, 'external');
  try { await fs.symlink(path.join(outside, 'notes.chart'), path.join(f.root, 'notes.chart'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('This Windows account cannot create file symlinks; junction protection is tested separately.'); return; } throw error; }
  await f.service.selectRoot(f.root); await settled(f.service); assert.equal(f.service.status().count, 0); assert.equal(f.service.status().skippedCount, 1);
});

test('persisted traversal, forged IDs and duplicate items are rejected without overwriting the file', async t => {
  const f = await fixture(t); await song(f.root, 'Safe'); await f.service.selectRoot(f.root); await settled(f.service); const valid = JSON.parse(await fs.readFile(f.file, 'utf8'));
  for (const mutate of [value => { value.items[0].folderRelativePath = '../outside'; }, value => { value.items[0].id = 'f'.repeat(64); }, value => { value.items.push(value.items[0]); }]) {
    const value = structuredClone(valid); mutate(value); const raw = JSON.stringify(value); await fs.writeFile(f.file, raw); const service = f.create(); await service.load();
    assert.equal(service.status().status, 'error'); assert.equal(service.query().total, 0); await assert.rejects(service.configure({ watch: true })); assert.equal(await fs.readFile(f.file, 'utf8'), raw);
  }
});

test('inaccessible subtrees and metadata preserve existing songs without false deletions', async t => {
  const f = await fixture(t); const folder = await song(f.root, 'Keep', '[song]\nname=Original metadata\n');
  const baseline = await scanLibrary({ rootPath: f.root }); let denial = 'directory';
  const module = await injected('../companion/library-scanner.cjs', { 'node:fs/promises': { ...fs,
    opendir: async target => { if (denial === 'directory' && target === folder) throw Object.assign(Error('private path'), { code: 'EACCES' }); return fs.opendir(target); },
    open: async (...args) => { if (denial === 'metadata' && args[0] === path.join(folder, 'song.ini')) throw Object.assign(Error('private'), { code: 'EACCES' }); return fs.open(...args); }
  } });
  let result = await module.scanLibrary({ rootPath: f.root, previousItems: baseline.items });
  assert.deepEqual(result.items, baseline.items); assert.ok(result.warningCount); assert.deepEqual(result.preservedPrefixes, ['Keep']);
  denial = 'metadata'; result = await module.scanLibrary({ rootPath: f.root, previousItems: baseline.items }); assert.deepEqual(result.items, baseline.items); assert.ok(result.warningCount);
  denial = 'directory'; await assert.rejects(module.scanLibrary({ rootPath: folder, previousItems: baseline.items }), { code: 'EACCES' });
});

test('bounded UTF16/INI/SNG parsing tolerates missing or malformed metadata safely', async t => {
  const f = await fixture(t); const directory = await song(f.root, 'Unicode');
  await fs.writeFile(path.join(directory, 'song.ini'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[song]\nname=Été 日本語\nartist=Unicode Band\n', 'utf16le')]));
  const large = await song(f.root, 'Large'); await fs.writeFile(path.join(large, 'song.ini'), '[song]\nname=Safe beginning\n' + ';'.repeat(SCANNER_LIMITS.metadataBytes) + '\nname=Beyond allowed read\n');
  const invalid = Buffer.alloc(34); invalid.write('SNGPKG'); invalid.writeUInt32LE(1, 6); invalid.writeBigUInt64LE(0xffffffffffffffffn, 26); await fs.writeFile(path.join(f.root, 'Hostile.sng'), invalid);
  const traversal = sng({ name: 'Unsafe archive' }, ['../outside.ogg']); await fs.writeFile(path.join(f.root, 'Traversal.sng'), traversal);
  await fs.writeFile(path.join(f.root, 'NoAudio.sng'), sng({ name: 'No audio' }, ['notes.mid']));
  await f.service.selectRoot(f.root); await settled(f.service); const page = f.service.query();
  assert.ok(page.items.some(item => item.title === 'Été 日本語')); assert.ok(page.items.some(item => item.title === 'Safe beginning'));
  assert.equal(page.items.find(item => item.relativePath === 'Hostile.sng').audio, 'unknown');
  assert.equal(page.items.find(item => item.relativePath === 'Traversal.sng').audio, 'unknown');
  assert.equal(page.items.find(item => item.title === 'No audio').audio, 'missing'); assert.ok(f.service.status().warningCount >= 3);
});

test('full and quick scans include more than 10000 songs and 100000 filesystem entries', async () => {
  const root = path.resolve(os.tmpdir(), 'synthetic-large-library'), songCount = 10001, extraFiles = 90000;
  const directory = { ino: 1, dev: 1, isDirectory: () => true, isSymbolicLink: () => false };
  const file = { ino: 2, dev: 1, size: 4, mtimeMs: 1, isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true };
  const entry = (name, isDirectory) => ({ name, isDirectory: () => isDirectory, isSymbolicLink: () => false });
  const module = await injected('../companion/library-scanner.cjs', { 'node:fs/promises': { ...fs,
    realpath: async value => value,
    lstat: async value => {
      if (path.basename(value) === '.chartshub-companion-installing') throw Object.assign(Error('Absent'), { code: 'ENOENT' });
      return value === root || path.basename(value).startsWith('Track ') ? directory : file;
    },
    opendir: async target => (async function* () {
      if (target === root) {
        for (let index = 0; index < extraFiles; index++) yield entry(index + '.txt', false);
        for (let index = 0; index < songCount; index++) yield entry('Track ' + String(index).padStart(5, '0'), true);
      } else yield entry('notes.mid', false);
    })(),
    open: async () => { throw Error('MIDI-only scans should not read chart or audio contents'); }
  } });
  let previousItems = [], progress;
  for (const mode of ['full', 'quick']) {
    const result = await module.scanLibrary({ rootPath: root, previousItems, mode, onProgress: value => { progress = value; } });
    assert.equal(result.items.length, songCount); assert.equal(result.warningCount, 0); assert.equal(result.skippedCount, 0);
    assert.equal(result.items.at(-1).relativePath, 'Track 10000/notes.mid');
    assert.deepEqual(progress, { visited: extraFiles + songCount * 2, processed: songCount, discovered: songCount });
    if (mode === 'quick') assert.deepEqual(result.items, previousItems);
    previousItems = result.items;
  }
});

test('indexes larger than 10000 songs and 32 MiB load, commit, paginate and reload', async t => {
  const files = new Map(), missing = () => Object.assign(Error('Absent'), { code: 'ENOENT' });
  const stored = filename => { if (!files.has(filename)) throw missing(); return files.get(filename); };
  let scanItems;
  const module = await injected('../companion/library-service.cjs', {
    './library-scanner.cjs': { SCANNER_LIMITS, scanLibrary: async () => ({ items: scanItems, warningCount: 0, skippedCount: 0 }) },
    'node:fs/promises': { ...fs,
      stat: async filename => ({ isFile: () => true, size: Buffer.byteLength(stored(filename)) }),
      readFile: async filename => stored(filename),
      open: async (filename, flags) => {
        assert.equal(flags, 'wx'); assert.equal(files.has(filename), false); files.set(filename, '');
        return { writeFile: async bytes => { files.set(filename, stored(filename) + bytes); }, sync: async () => {}, close: async () => {} };
      },
      copyFile: async (from, to) => { files.set(to, stored(from)); },
      rename: async (from, to) => { files.set(to, stored(from)); files.delete(from); },
      unlink: async filename => { if (!files.delete(filename)) throw missing(); }
    }
  });
  const f = await fixture(t, module.createInstalledLibraryService), metadata = 'é'.repeat(512);
  const items = Array.from({ length: 10001 }, (_, index) => {
    const title = 'Track ' + String(index).padStart(5, '0'), relativePath = title + '/notes.mid';
    return { id: createHash('sha256').update(relativePath).digest('hex'), relativePath, folderRelativePath: title,
      title, artist: metadata, charter: metadata, album: metadata, year: '2026', format: 'midi', audio: 'missing', signature: 'a'.repeat(64) };
  });
  const original = JSON.stringify({ version: 1, settings: { rootPath: f.root, watch: false, refreshOnStart: false }, items,
    revision: 1, lastScanAt: '2026-01-01T00:00:00.000Z', changes: { added: items.length, removed: 0, modified: 0 }, warningCount: 0, skippedCount: 0 });
  assert.ok(Buffer.byteLength(original) > 32 * 1024 * 1024, 'fixture crosses the former persisted index size limit');
  files.set(f.file, original);
  const loaded = await f.service.load(); assert.equal(loaded.status, 'ready'); assert.equal(loaded.count, items.length);
  assert.equal(f.service.query({ offset: 10000, limit: 100 }).items[0].id, items.at(-1).id);
  scanItems = items.map((item, index) => index === items.length - 1 ? { ...item, title: item.title + ' updated', signature: 'b'.repeat(64) } : item);
  f.service.requestScan('quick'); const state = await settled(f.service);
  assert.equal(state.status, 'ready'); assert.equal(state.count, items.length); assert.equal(state.revision, 2);
  assert.deepEqual(state.changes, { added: 0, removed: 0, modified: 1 });
  assert.ok(Buffer.byteLength(stored(f.file)) > 32 * 1024 * 1024); assert.equal(stored(f.file + '.bak'), original);
  assert.ok([...files.keys()].every(filename => !filename.endsWith('.tmp')));
  const reloaded = f.create(); assert.equal((await reloaded.load()).status, 'ready');
  const page = reloaded.query({ offset: 10000, limit: 100 });
  assert.equal(page.total, items.length); assert.equal(page.items.length, 1); assert.equal(page.items[0].title, 'Track 10000 updated');
  assert.equal(page.items[0].signature, undefined); assert.deepEqual(page, f.service.query({ offset: 10000, limit: 100 }));
});

test('matching snapshots are immutable, cached per index, and scoped to the chosen library root', async t => {
  const f = await fixture(t);
  await song(f.root, 'Example', '[song]\nname=Title\nartist=Artist\ncharter=Creator\n');
  await f.service.selectRoot(f.root); await settled(f.service);
  const before = f.service.matchingSnapshot();
  assert.match(before.rootKey, /^[a-f0-9]{64}$/);
  assert.equal(before.items[0].title, 'Title');
  assert.equal(before.items[0].relativePath, undefined);
  assert.match(before.items[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(before) && Object.isFrozen(before.items) && Object.isFrozen(before.items[0]));
  assert.equal(f.service.matchingSnapshot(), before, 'gameplay snapshots need no rehashing');
  await fs.writeFile(path.join(f.root, 'Example/song.ini'), '[song]\nname=Changed title\nartist=Artist\ncharter=Creator\n');
  f.service.requestScan('quick'); await settled(f.service);
  const changed = f.service.matchingSnapshot();
  assert.equal(changed.rootKey, before.rootKey);
  assert.notEqual(changed.items[0].fingerprint, before.items[0].fingerprint);
  const other = path.join(f.base, 'another-root'); await fs.mkdir(other);
  await song(other, 'Example', '[song]\nname=Title\nartist=Artist\ncharter=Creator\n');
  await f.service.selectRoot(other); await settled(f.service);
  const replacement = f.service.matchingSnapshot();
  assert.equal(replacement.items[0].id, before.items[0].id);
  assert.notEqual(replacement.rootKey, before.rootKey, 'a shared relative path must not transfer another root’s associations');
});

test('audio and possible-duplicate filters combine with search, sort and isolated pagination', async t => {
  const f = await fixture(t);
  const records = [
    { title: ' Écho   Live ', artist: 'The   Band', charter: 'Mapper', audio: 'present' },
    { title: 'e\u0301CHO Live', artist: 'the band', charter: ' MAPPER ', audio: 'missing' },
    { title: 'Écho Live', artist: 'The Band', charter: 'Mapper', audio: 'unknown' },
    { title: 'Alpha', artist: 'The Band', charter: 'Mapper', audio: 'missing' },
    { title: 'Alpha', artist: 'The Band', charter: 'Mapper', audio: 'missing' },
    { title: 'Écho Live (Remaster)', artist: 'The Band', charter: 'Mapper' },
    { title: 'Écho Live!', artist: 'The Band', charter: 'Mapper' },
    { title: 'Écho Live', artist: 'Other Band', charter: 'Mapper' },
    { title: 'Écho Live', artist: 'The Band', charter: 'Other Mapper' },
    { title: '', artist: 'The Band', charter: 'Mapper' },
    { title: ' ', artist: 'The Band', charter: 'Mapper' },
    { title: 'Écho Live', artist: '', charter: 'Mapper' },
    { title: 'Écho Live', artist: ' ', charter: 'Mapper' },
    { title: 'Écho Live', artist: 'The Band', charter: '' },
    { title: 'Écho Live', artist: 'The Band', charter: ' ' },
    { title: 'Echo Live', artist: 'The Band', charter: 'Mapper' },
    { title: 'Écho-Live', artist: 'The Band', charter: 'Mapper' }
  ];
  const items = records.map((record, i) => {
    const folderRelativePath = 'Folder ' + i, relativePath = folderRelativePath + '/notes.chart';
    return { id: createHash('sha256').update(relativePath).digest('hex'), relativePath, folderRelativePath,
      album: 'Collection', year: '2026', format: 'chart', signature: 'private', audio: 'missing', ...record };
  });
  await fs.writeFile(f.file, JSON.stringify({ version: 1, settings: { rootPath: f.root, watch: false, refreshOnStart: false }, items,
    revision: 1, lastScanAt: '2026-01-01T00:00:00.000Z' }));
  await f.service.load();
  assert.equal(f.service.query().total, records.length);
  const possible = f.service.query({ duplicates: 'possible' });
  assert.equal(possible.total, 5);
  assert.deepEqual(new Set(possible.items.map(item => item.id)), new Set(items.slice(0, 5).map(item => item.id)));
  for (const item of possible.items) assert.equal(item.duplicateCount, item.title === 'Alpha' ? 2 : 3);
  assert.ok(f.service.query({ query: 'Remaster' }).items.every(item => item.duplicateCount === undefined));
  assert.deepEqual(f.service.query({ audio: 'present', duplicates: 'possible' }).items.map(item => item.id), [items[0].id]);
  assert.deepEqual(f.service.query({ audio: 'unknown', duplicates: 'possible' }).items.map(item => item.id), [items[2].id]);
  const options = { query: 'band', audio: 'missing', duplicates: 'possible', sort: 'title', offset: 1, limit: 1 };
  const page = f.service.query(options);
  assert.equal(page.total, 3); assert.equal(page.items[0].id, items[4].id); assert.equal(page.items[0].duplicateCount, 2);
  assert.equal(f.service.query({ ...options, offset: 2 }).items[0].id, items[1].id);
  assert.equal(f.service.query({ ...options, offset: 999 }).total, 3);
  assert.deepEqual(f.service.query({ ...options, offset: 999 }).items, []);
  page.items[0].title = 'Mutated'; page.items[0].duplicateCount = 100; page.items.push({}); page.total = 999;
  const next = f.service.query(options);
  assert.equal(next.total, 3); assert.equal(next.items.length, 1); assert.equal(next.items[0].title, 'Alpha'); assert.equal(next.items[0].duplicateCount, 2);
  assert.equal(next.items[0].signature, undefined); assert.equal(next.items[0].folderRelativePath, undefined);
  assert.equal(f.service.query({ query: 'ÉCHO', duplicates: 'possible' }).total, 3, 'canonical Unicode forms remain searchable');
  for (const sort of ['title', 'artist', 'charter']) {
    assert.equal(f.service.query({ query: 'collection', sort, audio: 'missing', duplicates: 'possible' }).total, 3);
    assert.equal(f.service.query({ query: '2026', sort, audio: 'unknown' }).items[0].id, items[2].id);
  }
  assert.equal(f.service.query({ query: 'folder 0' }).items[0].id, items[0].id);
  assert.equal(await fs.readFile(f.file, 'utf8').then(raw => JSON.parse(raw).items.length), records.length, 'duplicate detection never modifies the index');
});

test('cached filters and duplicate groups refresh after committed scans and root replacements', async t => {
  const f = await fixture(t), metadata = '[song]\nname=Common title\nartist=Band\ncharter=Mapper\n';
  const first = await song(f.root, 'First', metadata), second = await song(f.root, 'Second', metadata);
  await f.service.selectRoot(f.root); await settled(f.service);
  const options = { query: 'common', audio: 'missing', duplicates: 'possible', sort: 'charter', limit: 1 };
  const initial = f.service.query(options); assert.equal(initial.total, 2); assert.equal(initial.items[0].duplicateCount, 2);
  await fs.writeFile(path.join(second, 'song.ogg'), 'audio');
  f.service.requestScan('quick'); await settled(f.service);
  const changedAudio = f.service.query(options); assert.equal(changedAudio.total, 1); assert.equal(changedAudio.items[0].duplicateCount, 2);
  assert.ok(changedAudio.revision > initial.revision);
  await fs.writeFile(path.join(second, 'song.ini'), '[song]\nname=Separate version\nartist=Band\ncharter=Mapper\n');
  f.service.requestScan('quick'); await settled(f.service);
  assert.equal(f.service.query(options).total, 0);
  assert.equal(f.service.query({ query: 'common' }).items[0].duplicateCount, undefined);
  await fs.writeFile(path.join(first, 'song.ini'), '[song]\nname=Changed search text\nartist=Band\ncharter=Mapper\n');
  f.service.requestScan('full'); await settled(f.service);
  assert.equal(f.service.query({ query: 'common' }).total, 0); assert.equal(f.service.query({ query: 'changed' }).total, 1);
  const other = path.join(f.base, 'replacement'); await fs.mkdir(other);
  await song(other, 'First', metadata);
  await f.service.selectRoot(other); await settled(f.service);
  assert.equal(f.service.query(options).total, 0); assert.equal(f.service.query({ query: 'changed' }).total, 0);
  const replaced = f.service.query({ query: 'common' });
  assert.equal(replaced.total, 1); assert.equal(replaced.items[0].duplicateCount, undefined);
  assert.equal(replaced.items[0].id, initial.items[0].id, 'identical relative paths in another root must not retain prior query data');
});
