'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Module, createRequire } = require('node:module');
const bundles = require('../companion/chart-bundle.cjs');
const { scanLibrary } = require('../companion/library-scanner.cjs');
const safe = { code: 'LIBRARY_CLEANUP_SAFE' };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function settled(service) { const end = Date.now() + 10000; while (service.status().status === 'scanning') { if (Date.now() > end) throw Error('scan timeout'); await tick(); } }
async function injected(filename, overrides) {
  const absolute = require.resolve(filename), local = new Module(absolute, module), normal = createRequire(absolute);
  local.filename = absolute; local.paths = Module._nodeModulePaths(path.dirname(absolute));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute); return local.exports;
}
async function fixture(t, hooks = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-bulk-cleanup-'));
  const root = path.join(base, 'songs'), profile = path.join(base, 'profile'); await fs.mkdir(root);
  for (const group of ['alpha', 'beta']) for (const version of ['keep', 'copy1', 'copy2']) {
    const folder = path.join(root, group + '-' + version); await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'song.ini'), `[song]\nname=${group}\nartist=Artist\ncharter=Charter\n`);
    await fs.writeFile(path.join(folder, 'notes.chart'), '[Song]\n{\n Resolution = 192\n}\n[ExpertSingle]\n{\n 0 = N ' + (version === 'copy1' ? '1' : '0') + ' 192\n}\n');
    await fs.writeFile(path.join(folder, 'song.ogg'), version === 'copy2' ? 'different full audio' : 'shared full audio');
  }
  const cleanup = await injected('../companion/library-cleanup.cjs', { './chart-bundle.cjs': { ...bundles,
    inspectChartBundle: async options => { await hooks.inspect?.(options); return bundles.inspectChartBundle(options); } } });
  const bulk = await injected('../companion/library-bulk-cleanup.cjs', { './library-cleanup.cjs': cleanup, './chart-bundle.cjs': { ...bundles,
    revalidateBundle: async options => { await hooks.revalidate?.(options); return bundles.revalidateBundle(options); } } });
  const scans = [], calls = [], snapshots = [];
  const { createInstalledLibraryService } = await injected('../companion/library-service.cjs', {
    './library-bulk-cleanup.cjs': bulk,
    './library-scanner.cjs': { scanLibrary: async options => { scans.push(options.mode); return scanLibrary(options); } }
  });
  const service = createInstalledLibraryService({ dataDirectory: profile, onChange: status => snapshots.push(status),
    recycle: async (target, proof) => {
      assert.equal(path.dirname(target), root); assert.ok(!path.basename(target).endsWith('-keep'));
      calls.push({ target, proof });
      if (hooks.recycle) await hooks.recycle(target, { root, base, proof });
      else { const bin = path.join(base, 'fake-bin'); await fs.mkdir(bin, { recursive: true }); await fs.rename(target, path.join(bin, path.basename(target))); }
    } });
  t.after(async () => {
    await service.stop();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-bulk-cleanup-')) throw Error('Unsafe fixture');
    await fs.rm(base, { recursive: true, force: true });
  });
  await hooks.beforeScan?.({ root, base }); await service.selectRoot(root); await settled(service);
  assert.equal(service.status().status, 'ready');
  for (const group of ['alpha', 'beta']) {
    const keep = service.query().items.find(item => item.relativePath === group + '-keep/notes.chart');
    const compared = await service.compareDuplicates({ id: keep.id, revision: service.status().revision });
    if (hooks.decisions?.[group] === 'all') await service.keepDuplicateVersions({ contextId: compared.contextId, revision: compared.revision });
    else if (hooks.decisions?.[group] !== 'none') await service.chooseDuplicate({ contextId: compared.contextId, revision: compared.revision, id: keep.id });
  }
  await hooks.afterScan?.({ root, base, profile, service });
  return { root, base, profile, service, scans, calls, snapshots,
    prepare: () => service.prepareBulkCleanup({}), selection: (plan, names) => ({ planId: plan.planId, revision: plan.revision,
      ids: plan.candidates.filter(candidate => !names || names.includes(candidate.targetRelativePath)).map(candidate => candidate.id) }) };
}

test('global differing-copy plan protects every keeper, selects individually and commits one revision without scanning', async t => {
  const f = await fixture(t), plan = await f.prepare(), before = f.service.status().revision;
  assert.deepEqual(plan.summary, { totalGroups: 2, needsKeeperGroups: 0, blockedGroups: 0, readyGroups: 2, identicalGroups: 0, candidateCount: 4 });
  assert.equal(plan.keepers.length, 2); assert.ok(plan.candidates.every(candidate => candidate.forceable && !candidate.eligible));
  assert.ok(!JSON.stringify(plan).includes(f.root)); assert.ok(!JSON.stringify(plan).includes('sha256'));
  const selection = f.selection(plan, ['alpha-copy1', 'beta-copy2']);
  const review = await f.service.bulkCleanupReview(selection);
  assert.deepEqual(review.candidates.map(candidate => candidate.id), selection.ids); assert.equal(review.keepers.length, 2);
  assert.deepEqual(f.calls, [], 'preparation and review are read-only');
  review.candidates[0].targetRelativePath = 'alpha-keep'; review.keepers.length = 0;
  const result = await f.service.recycleBulkDifferences(selection);
  assert.deepEqual(result, { recycledIds: selection.ids, failed: [], cancelled: false, refreshRequested: false });
  assert.deepEqual(f.calls.map(call => path.basename(call.target)), ['alpha-copy1', 'beta-copy2']);
  for (const call of f.calls) {
    assert.equal(call.proof.rootPath, f.root); assert.match(call.proof.keeper.relativePath, /-keep\/notes.chart$/);
    assert.equal(call.proof.target.expected.status, 'verified');
  }
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['alpha-copy2', 'alpha-keep', 'beta-copy1', 'beta-keep']);
  assert.equal(f.service.status().revision, before + 1); assert.equal(f.service.status().count, 4);
  assert.equal(f.service.status().cleanupRefreshPending, true); assert.deepEqual(f.scans, ['full']);
  assert.ok(f.snapshots.some(status => status.bulkCleanup?.phase === 'preparing'));
  assert.ok(f.snapshots.some(status => status.bulkCleanup?.phase === 'executing' && status.bulkCleanup.processed === 2));
  assert.equal(f.service.status().bulkCleanup, null);
  const history = await f.service.cleanupHistory({ limit: 10 });
  assert.equal(history.total, 2); assert.ok(history.entries.every(entry => entry.mode === 'force' && entry.candidates.length === 1));
  await assert.rejects(f.service.recycleBulkDifferences(selection), safe);
});

test('same-group partial selection keeps unchecked copies and normal identical candidates out of the bulk list', async t => {
  const f = await fixture(t, { beforeScan: async ({ root }) => {
    await fs.copyFile(path.join(root, 'alpha-keep', 'song.ogg'), path.join(root, 'alpha-copy2', 'song.ogg'));
  } });
  const plan = await f.prepare(); assert.equal(plan.candidates.length, 3);
  assert.ok(!plan.candidates.some(candidate => candidate.targetRelativePath === 'alpha-copy2'));
  const selection = f.selection(plan, ['beta-copy1', 'beta-copy2']);
  assert.equal((await f.service.bulkCleanupReview(selection)).keepers.length, 1);
  const result = await f.service.recycleBulkDifferences(selection); assert.deepEqual(result.recycledIds, selection.ids);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['alpha-copy1', 'alpha-copy2', 'alpha-keep', 'beta-keep']);
  assert.deepEqual(f.scans, ['full']);
});

test('groups with no explicit keeper or kept-all choices never become bulk targets', async t => {
  for (const decision of ['none', 'all']) {
    const f = await fixture(t, { decisions: { beta: decision } }), plan = await f.prepare();
    assert.equal(plan.keepers.length, 1); assert.ok(plan.candidates.every(candidate => candidate.targetRelativePath.startsWith('alpha-')));
    assert.equal(plan.summary.needsKeeperGroups, decision === 'none' ? 1 : 0);
    assert.equal(plan.summary.totalGroups, decision === 'none' ? 2 : 1);
    assert.deepEqual(f.calls, []);
  }
});

test('bulk selections reject keepers, foreign IDs, duplicates, stale revisions and caller paths', async t => {
  const f = await fixture(t), plan = await f.prepare(), good = f.selection(plan);
  for (const bad of [null, {}, { ...good, ids: [] }, { ...good, ids: [plan.keepers[0].id] },
    { ...good, ids: [good.ids[0], plan.keepers[1].id] }, { ...good, ids: [good.ids[0], good.ids[0]] },
    { ...good, ids: ['f'.repeat(64)] }, { ...good, revision: plan.revision + 1 }, { ...good, paths: ['../outside'] }]) {
    await assert.rejects(f.service.bulkCleanupReview(bad), safe);
  }
  await f.service.bulkCleanupReview(good); assert.deepEqual(f.calls, []);
  await f.service.cancelBulkCleanup({}); await assert.rejects(f.service.recycleBulkDifferences(good), safe);
});

test('a changed last selected copy aborts the entire batch before any native call', async t => {
  const f = await fixture(t), plan = await f.prepare(), selection = f.selection(plan, ['alpha-copy1', 'beta-copy2']);
  await f.service.bulkCleanupReview(selection);
  const filename = path.join(f.root, 'beta-copy2', 'notes.chart'), before = await fs.stat(filename), bytes = await fs.readFile(filename);
  bytes[0] ^= 1; await fs.writeFile(filename, bytes); await fs.utimes(filename, before.atime, before.mtime);
  const result = await f.service.recycleBulkDifferences(selection);
  assert.deepEqual(result.recycledIds, []); assert.deepEqual(result.failed.map(value => value.id), [selection.ids[1]]);
  assert.deepEqual(f.calls, []); assert.equal(f.service.status().count, 6); assert.deepEqual(f.scans, ['full']);
  await assert.rejects(f.service.bulkCleanupReview(selection), safe);
});

test('preflight closes the hash window before recycling when an earlier target changes during a later read', async t => {
  let changed = false;
  const f = await fixture(t, { revalidate: async options => {
    if (!changed && options.relativePath === 'beta-copy2/notes.chart') {
      changed = true; await fs.appendFile(path.join(options.rootPath, 'alpha-copy1', 'song.ogg'), 'late change');
    }
  } });
  const plan = await f.prepare(), selection = f.selection(plan, ['alpha-copy1', 'beta-copy2']);
  const result = await f.service.recycleBulkDifferences(selection);
  assert.equal(changed, true); assert.deepEqual(result.recycledIds, []); assert.deepEqual(f.calls, []);
  assert.deepEqual(result.failed.map(value => value.id), [selection.ids[0]]);
});

test('changed keeper, preference, root or index invalidates bulk confirmation safely', async t => {
  for (const change of ['keeper', 'preference', 'external-preference', 'root', 'scan']) {
    const f = await fixture(t), plan = await f.prepare(), selection = f.selection(plan);
    await f.service.bulkCleanupReview(selection);
    if (change === 'keeper') await fs.appendFile(path.join(f.root, 'beta-keep', 'notes.chart'), 'changed keeper');
    if (change === 'preference') {
      const comparison = await f.service.compareDuplicates({ id: plan.keepers[0].id, revision: plan.revision });
      await f.service.chooseDuplicate({ contextId: comparison.contextId, revision: comparison.revision, id: plan.candidates[0].id });
    }
    if (change === 'external-preference') await fs.appendFile(path.join(f.profile, 'library-duplicate-choices.json'), ' ');
    if (change === 'root') { const other = path.join(f.base, 'other'); await fs.mkdir(other); await f.service.selectRoot(other); await settled(f.service); }
    if (change === 'scan') { f.service.requestScan('quick'); await settled(f.service); }
    await assert.rejects(f.service.bulkCleanupReview(selection), safe); assert.deepEqual(f.calls, []);
    if (change === 'keeper') {
      const result = await f.service.recycleBulkDifferences(selection); assert.deepEqual(result.recycledIds, []); assert.equal(result.failed.length, 1);
    } else await assert.rejects(f.service.recycleBulkDifferences(selection), safe);
    assert.deepEqual(f.calls, []);
  }
});

test('nested and junction targets stay excluded even when their note bytes differ', async t => {
  const f = await fixture(t, { beforeScan: async ({ root }) => {
    await fs.mkdir(path.join(root, 'alpha-copy1', 'nested')); await fs.writeFile(path.join(root, 'alpha-copy1', 'nested', 'extra.txt'), 'protected');
  }, afterScan: async ({ root, base }) => {
    const target = path.join(root, 'beta-copy1'), outside = path.join(base, 'external-synthetic-copy');
    await fs.rename(target, outside); await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  } });
  const plan = await f.prepare();
  assert.deepEqual(plan.candidates.map(candidate => candidate.targetRelativePath).sort(), ['alpha-copy2', 'beta-copy2']);
  assert.equal(await fs.readFile(path.join(f.base, 'external-synthetic-copy', 'song.ogg'), 'utf8'), 'shared full audio');
  assert.deepEqual(f.calls, []);
});

test('cancellation during preparation aborts hashes and releases mutation gates without publishing a plan', async t => {
  const entered = deferred(), gate = deferred(); let first = true;
  const f = await fixture(t, { inspect: async () => { if (first) { first = false; entered.resolve(); await gate.promise; } } });
  const preparing = f.prepare(), rejected = assert.rejects(preparing, safe); await entered.promise;
  assert.throws(() => f.service.requestScan('quick'), safe);
  await assert.rejects(f.service.configure({ watch: true }), safe);
  await assert.rejects(f.service.verifyAllDuplicates(), safe);
  const cancelled = f.service.cancelBulkCleanup({}); gate.resolve(); await Promise.all([rejected, cancelled]);
  assert.equal(f.service.status().bulkCleanup, null); assert.deepEqual(f.calls, []); assert.deepEqual(f.scans, ['full']);
  assert.equal((await f.prepare()).candidates.length, 4);
});

test('cancellation drains the current native target and commits only its success once', async t => {
  const entered = deferred(), gate = deferred();
  const f = await fixture(t, { recycle: async (target, { base }) => {
    entered.resolve(); await gate.promise; await fs.rename(target, path.join(base, 'fake-bin-first'));
  } });
  const plan = await f.prepare(), selection = f.selection(plan), running = f.service.recycleBulkDifferences(selection);
  await entered.promise;
  assert.throws(() => f.service.requestScan('quick'), safe);
  await assert.rejects(f.service.compareDuplicates({ id: plan.keepers[0].id, revision: plan.revision }), safe);
  let done = false; const cancelled = f.service.cancelBulkCleanup({}).then(() => { done = true; });
  await tick(); assert.equal(done, false); gate.resolve();
  const result = await running; await cancelled;
  assert.equal(result.cancelled, true); assert.deepEqual(result.recycledIds, [selection.ids[0]]); assert.equal(f.calls.length, 1);
  assert.equal(f.service.status().count, 5); assert.equal(f.service.status().revision, plan.revision + 1); assert.deepEqual(f.scans, ['full']);
});

test('partial native failure stops later targets and preserves accurate per-keeper history and one index commit', async t => {
  let count = 0;
  const f = await fixture(t, { recycle: async (target, { base }) => {
    if (++count === 2) throw Error('Private native failure');
    await fs.rename(target, path.join(base, 'fake-bin-first'));
  } });
  const plan = await f.prepare(), selection = f.selection(plan);
  const result = await f.service.recycleBulkDifferences(selection);
  assert.deepEqual(result.recycledIds, [selection.ids[0]]); assert.deepEqual(result.failed.map(value => value.id), [selection.ids[1]]);
  assert.ok(!JSON.stringify(result).includes('Private')); assert.equal(f.calls.length, 2);
  assert.equal(f.service.status().count, 5); assert.equal(f.service.status().revision, plan.revision + 1); assert.deepEqual(f.scans, ['full']);
  const history = await f.service.cleanupHistory({ limit: 10 });
  assert.equal(history.total, 2); assert.equal(history.entries.flatMap(entry => entry.candidates).filter(candidate => candidate.status === 'not-attempted').length, 2);
  assert.ok(history.entries.every(entry => entry.keep.relativePath.includes('-keep/')));
});

test('a keeper changed after an earlier native success stops every later target across groups', async t => {
  const f = await fixture(t, { recycle: async (target, { base, root }) => {
    await fs.rename(target, path.join(base, 'fake-bin-first'));
    await fs.appendFile(path.join(root, 'beta-keep', 'notes.chart'), 'changed during batch');
  } });
  const plan = await f.prepare(), selection = f.selection(plan);
  const result = await f.service.recycleBulkDifferences(selection);
  assert.deepEqual(result.recycledIds, [selection.ids[0]]); assert.equal(result.failed.length, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.service.status().count, 5); assert.equal(f.service.status().revision, plan.revision + 1);
  assert.deepEqual(f.scans, ['full']);
  assert.equal((await fs.stat(path.join(f.root, 'alpha-keep'))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(f.root, 'beta-keep'))).isDirectory(), true);
});
