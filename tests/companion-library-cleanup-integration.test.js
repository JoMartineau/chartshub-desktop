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
