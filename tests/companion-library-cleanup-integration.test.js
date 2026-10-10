const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Module, createRequire } = require('node:module');
const bundles = require('../companion/chart-bundle.cjs');
const { scanLibrary } = require('../companion/library-scanner.cjs');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settled(service) {
  const started = Date.now();
  while (service.status().status === 'scanning') { if (Date.now() - started > 5000) throw Error('Scan did not settle'); await delay(5); }
  await delay(0); return service.status();
}
async function injected(filename, overrides) {
  const absolute = require.resolve(filename), local = new Module(absolute, module), normal = createRequire(absolute);
  local.filename = absolute; local.paths = Module._nodeModulePaths(path.dirname(absolute));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute); return local.exports;
}
async function fixture(t, hooks = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-cleanup-integration-')), root = path.join(base, 'songs'), dataDirectory = path.join(base, 'profile');
  await fs.mkdir(root); await fs.mkdir(dataDirectory);
  for (const folder of ['A', 'B', 'C']) {
    const target = path.join(root, folder); await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'notes.chart'), '[Song]\n{\n Name = "Song"\n Artist = "Artist"\n Charter = "Charter"\n}\n');
    await fs.writeFile(path.join(target, 'song.ini'), '[song]\nname=Song\nartist=Artist\ncharter=Charter\n');
    await fs.writeFile(path.join(target, 'song.ogg'), 'identical audio bytes');
  }
  const cleanupModule = await injected('../companion/library-cleanup.cjs', { './chart-bundle.cjs': {
    ...bundles, inspectChartBundle: async options => { await hooks.inspect?.(options); return bundles.inspectChartBundle(options); }
  } });
  const scans = [], recycled = [];
  const { createInstalledLibraryService } = await injected('../companion/library-service.cjs', {
    './library-cleanup.cjs': cleanupModule,
    './library-scanner.cjs': { scanLibrary: async options => { scans.push(options.mode); return scanLibrary(options); } }
  });
  const service = createInstalledLibraryService({ dataDirectory, recycle: async target => { recycled.push(target); await hooks.recycle?.(target, base); } });
  t.after(async () => {
    await service.stop();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-cleanup-integration-')) throw Error('Unexpected cleanup fixture');
    await fs.rm(base, { recursive: true, force: true });
  });
  await service.selectRoot(root); await settled(service);
  assert.equal(service.status().status, 'ready'); assert.equal(service.status().count, 3);
  await hooks.afterScan?.({ root, base, service });
  const first = service.query().items.find(item => item.relativePath.startsWith('A/'));
  const comparison = await service.compareDuplicates({ id: first.id, revision: service.status().revision });
  await service.chooseDuplicate({ contextId: comparison.contextId, revision: comparison.revision, id: first.id });
  const preparation = { contextId: comparison.contextId, revision: comparison.revision, keepId: first.id };
  return { service, root, base, scans, recycled, comparison, preparation,
    prepare: () => service.prepareCleanup(preparation),
    selection: plan => ({ planId: plan.planId, revision: plan.revision, ids: plan.candidates.filter(item => item.eligible).map(item => item.id) })
  };
}
async function assertBusy(f) {
  assert.throws(() => f.service.requestScan('quick'), { code: 'LIBRARY_CLEANUP_SAFE' });
  await assert.rejects(f.service.selectRoot(f.root), { code: 'LIBRARY_CLEANUP_SAFE' });
  await assert.rejects(f.service.configure({ watch: true }), { code: 'LIBRARY_CLEANUP_SAFE' });
  await assert.rejects(f.service.compareDuplicates({ id: f.preparation.keepId, revision: f.preparation.revision }), { code: 'LIBRARY_CLEANUP_SAFE' });
  await assert.rejects(f.service.chooseDuplicate({ contextId: f.preparation.contextId, revision: f.preparation.revision, id: null }), { code: 'LIBRARY_CLEANUP_SAFE' });
}

test('service protects the root, index and preferred choice throughout preparation', async t => {
  const entered = deferred(), gate = deferred(); let first = true;
  const f = await fixture(t, { inspect: async () => { if (first) { first = false; entered.resolve(); await gate.promise; } } });
  const preparing = f.prepare(); await entered.promise; await assertBusy(f);
  assert.equal(f.scans.length, 1); gate.resolve(); const plan = await preparing;
  assert.equal(plan.candidates.length, 2); assert.ok(plan.candidates.every(item => item.eligible));
  assert.equal((await f.service.cleanupReview(f.selection(plan))).keep.id, f.preparation.keepId);
});

test('native recycle of selected fixture copies starts exactly one quick refresh and keeps preferred notes', async t => {
  const f = await fixture(t, { recycle: async (target, base) => {
    const fixtureRoot = path.join(base, 'songs'), folder = path.basename(target);
    assert.equal(path.dirname(target), fixtureRoot); assert.notEqual(folder, 'A');
    // A fake bin entirely inside this disposable fixture; never call the OS bin.
    const bin = path.join(base, 'fake-bin'); await fs.mkdir(bin, { recursive: true }); await fs.rename(target, path.join(bin, folder));
  } });
  const plan = await f.prepare(), candidate = plan.candidates[1], before = f.service.status().revision;
  const result = await f.service.recycleDuplicates({ planId: plan.planId, revision: plan.revision, ids: [candidate.id] });
  assert.deepEqual(result, { recycledIds: [candidate.id], failed: [], cancelled: false, refreshRequested: true });
  await settled(f.service); assert.deepEqual(f.scans, ['full', 'quick']); assert.equal(f.service.status().revision, before + 1);
  assert.equal(f.service.status().count, 2); assert.deepEqual(f.service.status().changes, { added: 0, removed: 1, modified: 0 });
  assert.ok(f.service.query().items.some(item => item.id === f.preparation.keepId)); assert.equal(f.recycled.length, 1);
  assert.match(await fs.readFile(path.join(f.root, 'A', 'notes.chart'), 'utf8'), /Song/);
  await assert.rejects(f.service.cleanupReview(f.selection(plan)), { code: 'LIBRARY_CLEANUP_SAFE' });
});

test('service blocks concurrent mutations while native recycling runs and stop drains only the current target', async t => {
  const entered = deferred(), gate = deferred();
  const f = await fixture(t, { recycle: async () => { entered.resolve(); await gate.promise; } });
  const plan = await f.prepare(), running = f.service.recycleDuplicates(f.selection(plan)); await entered.promise;
  await assertBusy(f); assert.equal(f.recycled.length, 1);
  let stopped = false; const stopping = f.service.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false);
  gate.resolve(); const result = await running; await stopping;
  assert.equal(result.recycledIds.length, 1); assert.equal(result.cancelled, true); assert.equal(result.refreshRequested, false);
  assert.equal(f.recycled.length, 1); assert.deepEqual(f.scans, ['full']);
  await f.service.configure({ refreshOnStart: false }); await f.service.start();
  assert.equal(f.service.status().count, 3, 'fake recycling leaves these fixture files intact');
});

test('stop aborts a pending preparation, prevents recycling, and service can compare again after restart', async t => {
  const entered = deferred(), gate = deferred(); let block = true, signal;
  const f = await fixture(t, { inspect: async options => { signal = options.signal; if (block) { entered.resolve(); await gate.promise; } } });
  const preparing = f.prepare(), rejected = assert.rejects(preparing, { code: 'LIBRARY_CLEANUP_SAFE' }); await entered.promise;
  let stopped = false; const stopping = f.service.stop().then(() => { stopped = true; });
  assert.equal(signal.aborted, true); await Promise.resolve(); assert.equal(stopped, false);
  block = false; gate.resolve(); await rejected; await stopping; assert.equal(f.recycled.length, 0);
  await f.service.configure({ refreshOnStart: false }); await f.service.start();
  const comparison = await f.service.compareDuplicates({ id: f.preparation.keepId, revision: f.service.status().revision });
  assert.equal(comparison.preferredId, f.preparation.keepId);
});

test('files changed since the index scan stay protected even when size and mtime are restored before comparison', async t => {
  for (const filename of ['notes.chart', 'song.ogg', 'song.ini']) {
    const f = await fixture(t, { afterScan: async ({ root }) => {
      const target = path.join(root, 'B', filename), original = await fs.readFile(target), before = await fs.stat(target);
      // Rewriting identical bytes also changes the reviewed filesystem identity.
      // Restoring mtime must not erase the evidence held by the scan snapshot.
      await fs.writeFile(target, original); await fs.utimes(target, before.atime, before.mtime);
    } });
    const plan = await f.prepare(), changed = plan.candidates.find(candidate => candidate.relativePath.startsWith('B/'));
    assert.equal(changed.eligible, false, filename); assert.equal(changed.forceable, false, filename);
    assert.match(changed.reason, /depuis le scan/); assert.equal(plan.candidates.find(candidate => candidate.relativePath.startsWith('C/')).eligible, true);
    await assert.rejects(f.service.recycleDuplicates({ planId: plan.planId, revision: plan.revision, ids: [changed.id] }), { code: 'LIBRARY_CLEANUP_SAFE' });
    assert.equal(f.recycled.length, 0); assert.deepEqual((await fs.readdir(f.root)).sort(), ['A', 'B', 'C']);
  }
});

test('extra files, identical folder replacements and changed keeper are rejected after scan', async t => {
  for (const change of ['extra', 'copy-replacement', 'keeper-replacement']) {
    const f = await fixture(t, { afterScan: async ({ root, base }) => {
      if (change === 'extra') { await fs.writeFile(path.join(root, 'B', 'unique-cover.png'), 'keep this unique file'); return; }
      const folder = change === 'keeper-replacement' ? 'A' : 'B', target = path.join(root, folder), saved = path.join(base, 'original-' + folder);
      await fs.rename(target, saved); await fs.mkdir(target);
      for (const name of await fs.readdir(saved)) await fs.copyFile(path.join(saved, name), path.join(target, name));
    } });
    const plan = await f.prepare();
    assert.equal(plan.candidates[0].eligible, false, change); assert.equal(plan.candidates[0].forceable, false, change);
    if (change === 'keeper-replacement') assert.ok(plan.candidates.every(candidate => !candidate.eligible && !candidate.forceable));
    assert.equal(f.recycled.length, 0);
  }
});

test('comparison bundle content cannot be silently replaced before cleanup preparation', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'B', 'song.ogg'), 'changed audio content');
  const plan = await f.prepare(), changed = plan.candidates[0];
  assert.equal(changed.eligible, false); assert.equal(changed.forceable, false); assert.match(changed.reason, /depuis le scan/);
  assert.equal(plan.candidates[1].eligible, true); assert.equal(f.recycled.length, 0);
});

test('legacy index remains browsable and preference persists, but cleanup requires a new scan', async t => {
  const f = await fixture(t); await f.service.configure({ refreshOnStart: false }); await f.service.stop();
  const filename = path.join(f.base, 'profile', 'library.json'), stored = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.ok(stored.items.every(item => /^[a-f0-9]{64}$/.test(item.cleanupSnapshot)));
  for (const item of stored.items) delete item.cleanupSnapshot;
  await fs.writeFile(filename, JSON.stringify(stored));
  const { createInstalledLibraryService } = require('../companion/library-service.cjs');
  const service = createInstalledLibraryService({ dataDirectory: path.join(f.base, 'profile'), recycle: async () => assert.fail('legacy evidence cannot recycle') });
  t.after(() => service.stop()); await service.start();
  assert.equal(service.query().total, 3); assert.ok(!JSON.stringify(service.query()).includes('cleanupSnapshot'));
  let comparison = await service.compareDuplicates({ id: f.preparation.keepId, revision: service.status().revision });
  assert.equal(comparison.preferredId, f.preparation.keepId);
  let plan = await service.prepareCleanup({ contextId: comparison.contextId, revision: comparison.revision, keepId: comparison.preferredId });
  assert.ok(plan.candidates.every(candidate => !candidate.eligible && !candidate.forceable)); assert.match(plan.candidates[0].reason, /Relancez le scan/);
  service.requestScan('full'); await settled(service);
  comparison = await service.compareDuplicates({ id: f.preparation.keepId, revision: service.status().revision });
  assert.equal(comparison.preferredId, f.preparation.keepId);
  plan = await service.prepareCleanup({ contextId: comparison.contextId, revision: comparison.revision, keepId: comparison.preferredId });
  assert.ok(plan.candidates.every(candidate => candidate.eligible));
});
