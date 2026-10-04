const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Module, createRequire } = require('node:module');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const readable = (bytes = 'same', format = 'chart') => ({ status: 'readable', format, sha256: hash(bytes), bytes: Buffer.byteLength(bytes), modifiedAt: '2026-10-04T01:02:03.000Z', reason: null });
const unavailable = { status: 'unavailable', format: null, sha256: null, bytes: null, modifiedAt: null, reason: 'unavailable-file' };
function item(relativePath, fields = {}) {
  return { id: hash(relativePath), relativePath, title: 'Same song', artist: 'Same artist', charter: 'Same charter', format: 'chart', audio: 'present', ...fields };
}
async function injected(overrides) {
  const absolute = require.resolve('../companion/library-duplicates.cjs'), local = new Module(absolute, module), normal = createRequire(absolute);
  local.filename = absolute; local.paths = Module._nodeModulePaths(path.dirname(absolute));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute); return local.exports;
}
async function fixture(t, { fingerprint = async () => readable(), fsOverrides = {} } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-duplicates-'));
  const root = path.join(base, 'songs'), data = path.join(base, 'profile');
  await fs.mkdir(root); await fs.mkdir(data);
  const { createLibraryDuplicates } = await injected({ './chart-fingerprint.cjs': { fingerprintChart: fingerprint }, 'node:fs/promises': { ...fs, ...fsOverrides } });
  let document = { revision: 1, settings: { rootPath: root }, items: [item('A/notes.chart'), item('B/notes.chart')] };
  const services = [];
  const create = () => { const service = createLibraryDuplicates({ dataDirectory: data, getDocument: () => document }); services.push(service); return service; };
  const service = create();
  t.after(async () => {
    for (const service of services) await service.stop();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-duplicates-')) throw Error('Unexpected duplicate test directory');
    await fs.rm(base, { recursive: true, force: true });
  });
  return {
    root, data, file: path.join(data, 'library-duplicate-choices.json'), service, create,
    get document() { return document; }, set document(value) { document = value; },
    compare: (id = document.items[0].id) => service.compare({ id, revision: document.revision }),
    choose: (comparison, id) => service.choose({ contextId: comparison.contextId, revision: comparison.revision, id })
  };
}

test('duplicate groups use complete NFC/case/whitespace metadata and preserve punctuation and version qualifiers', async t => {
  const f = await fixture(t);
  f.document.items = [
    item('A/notes.chart', { title: ' Café  Song ', artist: ' ARTIST ', charter: 'Charter' }),
    item('B/notes.chart', { title: 'Cafe\u0301\tSong', artist: 'artist', charter: ' CHARTER ' }),
    item('Punctuation/notes.chart', { title: 'Café-Song', artist: 'artist', charter: 'charter' }),
    item('Qualifier/notes.chart', { title: 'Café Song (Live)', artist: 'artist', charter: 'charter' }),
    item('Accent/notes.chart', { title: 'Cafe Song', artist: 'artist', charter: 'charter' }),
    item('Missing/notes.chart', { title: 'Café Song', artist: 'artist', charter: '' }),
    item('Missing2/notes.chart', { title: 'Café Song', artist: 'artist', charter: ' ' })
  ];
  const compared = await f.compare();
  assert.deepEqual(compared.variants.map(value => value.relativePath), ['A/notes.chart', 'B/notes.chart']);
  assert.deepEqual(compared.summary, { total: 2, readable: 2, noteGroups: 1, identicalGroups: 1, unverified: 0 });
  await assert.rejects(f.compare(f.document.items[2].id), /doublon/);
  await assert.rejects(f.compare(f.document.items[5].id), /complets/);
});

test('only matching note bytes and formats are identical; unreadable and unsupported notes remain unverified', async t => {
  const calls = [];
  const results = new Map([
    ['A/notes.chart', readable('equal')], ['B/notes.chart', readable('equal')],
    ['C/notes.chart', readable('different')], ['D/notes.mid', readable('equal', 'midi')],
    ['E.sng', { ...unavailable, status: 'unsupported', reason: 'missing-notes' }], ['F/notes.chart', unavailable]
  ]);
  const f = await fixture(t, { fingerprint: async options => { calls.push(options); return results.get(options.relativePath); } });
  f.document.items = [...results.keys()].map(relativePath => item(relativePath, { format: relativePath.endsWith('.mid') ? 'midi' : relativePath.endsWith('.sng') ? 'sng' : 'chart' }));
  const compared = await f.compare();
  assert.match(compared.contextId, /^[a-f0-9]{32}$/);
  assert.deepEqual(compared.summary, { total: 6, readable: 4, noteGroups: 3, identicalGroups: 1, unverified: 2 });
  assert.deepEqual(compared.variants.map(value => [value.noteGroup, value.identicalCount]), [[1, 2], [1, 2], [2, 1], [3, 1], [null, 0], [null, 0]]);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(value => value.rootPath === f.root && value.signal instanceof AbortSignal));
  assert.ok(!JSON.stringify(compared).includes(f.root));
  assert.ok(!JSON.stringify(compared).includes(hash('equal')));
  assert.equal(compared.variants[0].notes.reason, null);
  assert.match(compared.variants[5].notes.reason, /inaccessible/);
  for (const index of [4, 5]) await assert.rejects(f.choose(compared, f.document.items[index].id), /vérifiées/);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('preferences rehash before save, survive restart, retain backups, and can be cleared without changing notes', async t => {
  let calls = 0;
  const f = await fixture(t, { fingerprint: async () => { calls++; return readable(); } });
  const comparison = await f.compare();
  assert.equal(calls, 2);
  const chosen = f.document.items[1].id;
  assert.deepEqual(await f.choose(comparison, chosen), { contextId: comparison.contextId, revision: 1, preferredId: chosen });
  assert.equal(calls, 3, 'choosing reads notes again');
  const stored = await fs.readFile(f.file, 'utf8'), parsed = JSON.parse(stored);
  assert.equal(parsed.version, 1); assert.equal(Object.keys(parsed.choices).length, 1);
  assert.match(Object.keys(parsed.choices)[0], /^[a-f0-9]{64}:[a-f0-9]{64}$/);
  assert.deepEqual(Object.values(parsed.choices), [{ id: chosen, hash: hash('same'), format: 'chart' }]);
  assert.ok(!stored.includes(f.root)); assert.ok(!stored.includes(f.document.items[1].relativePath));
  const second = f.create(), reloaded = await second.compare({ id: chosen, revision: 1 });
  assert.equal(reloaded.preferredId, chosen); assert.equal(reloaded.selectionError, null);
  await second.choose({ contextId: reloaded.contextId, revision: 1, id: null });
  assert.equal(await fs.readFile(f.file + '.bak', 'utf8'), stored);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')).choices, {});
  assert.equal(calls, 5, 'clearing does not read or modify notes');
});

test('persisted preferences are isolated by root, complete metadata, and current note fingerprint', async t => {
  let bytes = 'same';
  const f = await fixture(t, { fingerprint: async () => readable(bytes) });
  let comparison = await f.compare(); const chosen = f.document.items[0].id;
  await f.choose(comparison, chosen);
  bytes = 'changed'; comparison = await f.compare();
  assert.equal(comparison.preferredId, null); assert.match(comparison.selectionError, /changé/);
  bytes = 'same'; comparison = await f.compare(); assert.equal(comparison.preferredId, chosen);
  f.document = { ...f.document, settings: { rootPath: path.join(f.root, 'other') }, revision: 2 };
  comparison = await f.compare(); assert.equal(comparison.preferredId, null); assert.equal(comparison.selectionError, null);
  f.document = { ...f.document, settings: { rootPath: f.root }, revision: 3, items: f.document.items.map(value => ({ ...value, title: 'Different song' })) };
  comparison = await f.compare(); assert.equal(comparison.preferredId, null);
});

test('changed or newly unreadable notes invalidate a pending choice without writing preferences', async t => {
  let result = readable(); const f = await fixture(t, { fingerprint: async () => result });
  let comparison = await f.compare(); result = readable('changed');
  await assert.rejects(f.choose(comparison, f.document.items[0].id), /Recomparez/);
  await assert.rejects(f.choose(comparison, null), /Recomparez/);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  comparison = await f.compare(); result = unavailable;
  await assert.rejects(f.choose(comparison, f.document.items[0].id), /Recomparez/);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('malformed, foreign, stale, and no-longer-member choices are rejected', async t => {
  const f = await fixture(t); const comparison = await f.compare();
  for (const options of [null, {}, { id: 'x', revision: 1 }, { id: f.document.items[0].id, revision: -1 }, { id: f.document.items[0].id, revision: 1, path: '/private' }]) {
    await assert.rejects(f.service.compare(options), { code: 'LIBRARY_COMPARISON_SAFE' });
  }
  for (const options of [{}, { contextId: comparison.contextId, revision: 1 }, { contextId: 'a'.repeat(32), revision: 1, id: null }, { contextId: comparison.contextId, revision: 0, id: null }]) {
    await assert.rejects(f.service.choose(options), { code: 'LIBRARY_COMPARISON_SAFE' });
  }
  await assert.rejects(f.choose(comparison, hash('another song')), /Recomparez/);
  f.document.items[0] = { ...f.document.items[0], title: 'Changed' };
  await assert.rejects(f.choose(comparison, f.document.items[0].id), /Recomparez/);
  f.document = { ...f.document, revision: 2 };
  await assert.rejects(f.choose(comparison, null), /Recomparez/);
  await assert.rejects(f.service.compare({ id: f.document.items[1].id, revision: 1 }), /Recomparez/);
});

test('a new comparison aborts an older one and hashes each group sequentially', async t => {
  const entered = deferred(), gate = deferred(); let first = true, active = 0, maxActive = 0, oldSignal;
  const f = await fixture(t, { fingerprint: async options => {
    active++; maxActive = Math.max(maxActive, active);
    try {
      if (first) { first = false; oldSignal = options.signal; entered.resolve(); await gate.promise; }
      return readable();
    } finally { active--; }
  } });
  const old = f.compare(); const rejected = assert.rejects(old, /Recomparez/); await entered.promise;
  const newer = await f.compare(); assert.equal(oldSignal.aborted, true); gate.resolve(); await rejected;
  assert.equal(newer.summary.total, 2); assert.equal(maxActive, 2, 'at most one hash per individual comparison');
  await f.choose(newer, f.document.items[0].id);
});

test('revision, root, and snapshot changes are rechecked after asynchronous note reads', async t => {
  for (const change of ['revision', 'root', 'items', 'invalidate']) {
    const entered = deferred(), gate = deferred(); let calls = 0;
    const f = await fixture(t, { fingerprint: async () => { calls++; entered.resolve(); await gate.promise; return readable(); } });
    const pending = f.compare(), rejected = assert.rejects(pending, /Recomparez/); await entered.promise;
    if (change === 'revision') f.document = { ...f.document, revision: 2 };
    if (change === 'root') f.document = { ...f.document, settings: { rootPath: path.join(f.root, 'other') } };
    if (change === 'items') f.document = { ...f.document, items: [...f.document.items] };
    if (change === 'invalidate') f.service.invalidate();
    gate.resolve(); await rejected; assert.equal(calls, 1);
  }
});

test('stop aborts and drains active work and allows later comparisons', async t => {
  const entered = deferred(), gate = deferred(); let block = true, signal;
  const f = await fixture(t, { fingerprint: async options => { signal = options.signal; if (block) { entered.resolve(); await gate.promise; } return readable(); } });
  const pending = f.compare(), rejected = assert.rejects(pending, /Recomparez/); await entered.promise;
  let stopped = false; const stopping = f.service.stop().then(() => { stopped = true; });
  assert.equal(signal.aborted, true); await Promise.resolve(); assert.equal(stopped, false);
  await assert.rejects(f.compare(), /arrêt/);
  gate.resolve(); await rejected; await stopping; block = false;
  assert.equal((await f.compare()).summary.readable, 2);
});

test('corrupt and future preference stores are read-only while note comparisons still work', async t => {
  for (const original of ['{broken', '{"version":45,"future":"untouched"}', '{"version":1,"choices":{"/private/path":{}}}']) {
    const f = await fixture(t); await fs.writeFile(f.file, original);
    const comparison = await f.compare();
    assert.equal(comparison.summary.readable, 2); assert.equal(comparison.canChoose, false); assert.equal(comparison.preferredId, null);
    assert.match(comparison.selectionError, /protégés|illisibles/);
    await assert.rejects(f.choose(comparison, f.document.items[0].id), { code: 'LIBRARY_COMPARISON_SAFE' });
    await assert.rejects(f.choose(comparison, null), { code: 'LIBRARY_COMPARISON_SAFE' });
    assert.equal(await fs.readFile(f.file, 'utf8'), original); assert.deepEqual(await fs.readdir(f.data), ['library-duplicate-choices.json']);
  }
});

test('choices serialize and an atomic rename failure preserves the prior choice and removes temporary files', async t => {
  let failRename = false;
  const f = await fixture(t, { fsOverrides: { rename: async (...args) => { if (failRename) throw Error('C:\\private\\profile denied'); return fs.rename(...args); } } });
  const comparison = await f.compare(), [a, b] = f.document.items;
  await Promise.all([f.choose(comparison, a.id), f.choose(comparison, b.id)]);
  assert.equal(Object.values(JSON.parse(await fs.readFile(f.file, 'utf8')).choices)[0].id, b.id);
  assert.equal(Object.values(JSON.parse(await fs.readFile(f.file + '.bak', 'utf8')).choices)[0].id, a.id);
  const original = await fs.readFile(f.file, 'utf8'); failRename = true;
  await assert.rejects(f.choose(comparison, a.id), failure => failure.code === 'LIBRARY_COMPARISON_SAFE' && !failure.message.includes('private'));
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.deepEqual((await fs.readdir(f.data)).sort(), ['library-duplicate-choices.json', 'library-duplicate-choices.json.bak']);
  assert.equal((await f.compare()).preferredId, b.id);
});

test('invalidation during an atomic write prevents publication and stop waits for cleanup', async t => {
  const entered = deferred(), gate = deferred();
  const f = await fixture(t, { fsOverrides: { open: async (...args) => { if (args[1] === 'wx') { entered.resolve(); await gate.promise; } return fs.open(...args); } } });
  const comparison = await f.compare();
  const choosing = f.choose(comparison, f.document.items[0].id), rejected = assert.rejects(choosing, /Recomparez/);
  await entered.promise;
  let stopped = false; const stopping = f.service.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  gate.resolve(); await rejected; await stopping;
  assert.deepEqual(await fs.readdir(f.data), []);
});

test('queued choices snapshot caller input before asynchronous verification', async t => {
  const entered = deferred(), gate = deferred(); let block = false;
  const f = await fixture(t, { fingerprint: async () => { if (block) { entered.resolve(); await gate.promise; } return readable(); } });
  const comparison = await f.compare(), [a, b] = f.document.items; block = true;
  const first = f.choose(comparison, a.id); await entered.promise;
  const input = { contextId: comparison.contextId, revision: 1, id: b.id };
  const second = f.service.choose(input); input.id = hash('not in this group'); input.contextId = 'bad'; input.revision = 99;
  gate.resolve(); await first;
  assert.equal((await second).preferredId, b.id);
  assert.equal(Object.values(JSON.parse(await fs.readFile(f.file, 'utf8')).choices)[0].id, b.id);
});

test('external preference changes after loading are preserved and make later choices read-only', async t => {
  for (const replacement of ['{"version":89,"future":"keep"}', '{broken externally', null]) {
    const f = await fixture(t), comparison = await f.compare();
    await f.choose(comparison, f.document.items[0].id);
    if (replacement === null) await fs.unlink(f.file); else await fs.writeFile(f.file, replacement);
    await assert.rejects(f.choose(comparison, f.document.items[1].id), /changé sur disque/);
    const again = await f.compare(); assert.equal(again.canChoose, false); assert.equal(again.preferredId, null); assert.match(again.selectionError, /changé sur disque/);
    if (replacement === null) await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(f.file, 'utf8'), replacement);
  }
});

test('malformed persisted identifiers cannot be coerced into valid choices', async t => {
  const f = await fixture(t);
  const malformed = JSON.stringify({ version: 1, choices: { [hash('root') + ':' + hash('group')]: { id: [f.document.items[0].id], hash: hash('same'), format: 'chart' } } });
  await fs.writeFile(f.file, malformed);
  const compared = await f.compare(); assert.equal(compared.canChoose, false);
  assert.equal(await fs.readFile(f.file, 'utf8'), malformed);
});

test('external replacement during main or backup fsync survives without changing the existing backup', async t => {
  for (const stage of ['main', 'backup']) for (const replacement of ['{"version":91,"future":"keep"}', '{externally corrupted']) {
    const entered = deferred(), gate = deferred(); let block = false;
    const f = await fixture(t, { fsOverrides: { open: async (...args) => {
      const handle = await fs.open(...args);
      if (args[1] === 'wx' && (String(args[0]).endsWith('.bak.tmp') ? 'backup' : 'main') === stage) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { if (block) { entered.resolve(); await gate.promise; } return sync(); };
      }
      return handle;
    } } });
    const comparison = await f.compare(), [a, b] = f.document.items;
    await f.choose(comparison, a.id); await f.choose(comparison, b.id);
    const backup = await fs.readFile(f.file + '.bak', 'utf8'); block = true;
    const choosing = f.choose(comparison, a.id), rejected = assert.rejects(choosing, /changé sur disque/);
    await entered.promise; await fs.writeFile(f.file, replacement); gate.resolve(); await rejected;
    assert.equal(await fs.readFile(f.file, 'utf8'), replacement);
    assert.equal(await fs.readFile(f.file + '.bak', 'utf8'), backup);
    assert.deepEqual((await fs.readdir(f.data)).sort(), ['library-duplicate-choices.json', 'library-duplicate-choices.json.bak']);
    assert.equal((await f.compare()).canChoose, false);
  }
});

test('real note fingerprints compare bytes and saving a choice never modifies songs', async t => {
  const { fingerprintChart } = require('../companion/chart-fingerprint.cjs');
  const f = await fixture(t, { fingerprint: fingerprintChart });
  const contents = '[Song]\n{\n Name = "Same song"\n}\n[ExpertSingle]\n{\n 0 = N 0 0\n}\n';
  for (const entry of f.document.items) {
    const target = path.join(f.root, entry.relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, contents);
  }
  const before = await Promise.all(f.document.items.map(value => fs.stat(path.join(f.root, value.relativePath))));
  const compared = await f.compare(); assert.equal(compared.summary.identicalGroups, 1);
  await f.choose(compared, f.document.items[0].id);
  for (let index = 0; index < f.document.items.length; index++) {
    const target = path.join(f.root, f.document.items[index].relativePath);
    assert.equal(await fs.readFile(target, 'utf8'), contents);
    assert.equal((await fs.stat(target)).mtimeMs, before[index].mtimeMs);
  }
});

test('choosing rechecks the context after rereading notes and never leaks filesystem errors', async t => {
  const entered = deferred(), gate = deferred(); let choosing = false, failure = false;
  const f = await fixture(t, { fingerprint: async () => {
    if (failure) throw Error('C:\\private\\songs unreadable');
    if (choosing) { entered.resolve(); await gate.promise; }
    return readable();
  } });
  const comparison = await f.compare(); choosing = true;
  const pending = f.choose(comparison, f.document.items[0].id), rejected = assert.rejects(pending, /Recomparez/);
  await entered.promise; f.service.invalidate(); gate.resolve(); await rejected;
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  choosing = false; failure = true;
  await assert.rejects(f.compare(), error => error.code === 'LIBRARY_COMPARISON_SAFE' && !error.message.includes('private'));
});

test('large candidate groups remain complete without applying the query page limit', async t => {
  const f = await fixture(t); f.document.items = Array.from({ length: 257 }, (_, index) => item(`Version ${index}/notes.chart`));
  const comparison = await f.compare();
  assert.equal(comparison.summary.total, 257); assert.equal(comparison.variants.length, 257);
  assert.equal(comparison.variants[256].identicalCount, 257);
  await f.choose(comparison, f.document.items[256].id);
});
