const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Module, createRequire } = require('node:module');

const hash = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function item(relativePath, fields = {}) { return { id: hash(relativePath), relativePath, format: relativePath.endsWith('.sng') ? 'sng' : 'chart', ...fields }; }
function bundle(relativePath, changes = {}) {
  return { status: 'verified', reason: null, kind: 'folder', targetRelativePath: path.posix.dirname(relativePath), notes: { format: 'chart', sha256: hash('notes'), bytes: 5 },
    audio: { status: 'verified', count: 1, bytes: 5, digest: hash('audio') }, nonAudioHash: hash('non-audio'), bundleHash: hash('bundle'), totalBytes: 10, entryCount: 2, identity: { relativePath }, ...changes };
}
async function injected(overrides) {
  const absolute = require.resolve('../companion/library-cleanup.cjs'), local = new Module(absolute, module), normal = createRequire(absolute);
  local.filename = absolute; local.paths = Module._nodeModulePaths(path.dirname(absolute));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(absolute, 'utf8'), absolute); return local.exports;
}
async function fixture(t, hooks = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-cleanup-')), rootPath = path.join(base, 'songs'); await fs.mkdir(rootPath);
  let document = { revision: 4, settings: { rootPath }, items: ['A/notes.chart', 'B/notes.chart', 'C/notes.chart'].map(value => item(value)) };
  let context = { contextId: 'a'.repeat(32), revision: 4, rootPath, keepId: document.items[0].id, keepHash: hash('notes'), keepFormat: 'chart', preferenceToken: {}, members: document.items.map(value => ({ ...value })) };
  const inspected = [], checked = [], recycled = []; let refreshes = 0;
  const { createLibraryCleanup } = await injected({ './chart-bundle.cjs': {
    inspectChartBundle: async options => { inspected.push(options); return hooks.inspect ? hooks.inspect(options) : bundle(options.relativePath); },
    revalidateBundle: async options => { checked.push(options); return hooks.revalidate ? hooks.revalidate(options) : path.join(options.rootPath, options.expected.targetRelativePath); },
    recheckBundleIdentity: async options => hooks.identity ? hooks.identity(options) : path.join(options.rootPath, options.expected.targetRelativePath)
  } });
  const service = createLibraryCleanup({ getDocument: () => document,
    getContext: async request => { if (hooks.context) await hooks.context(request); if (request.contextId !== context.contextId || request.revision !== context.revision || request.keepId !== context.keepId) throw Error('Private filesystem context'); return context; },
    recycle: async target => { recycled.push(target); await hooks.recycle?.(target); },
    onCleaned: async () => { refreshes++; await hooks.onCleaned?.(); }
  });
  t.after(async () => {
    await service.stop();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-cleanup-')) throw Error('Unsafe temporary fixture');
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, rootPath, service, inspected, checked, recycled,
    get document() { return document; }, set document(value) { document = value; },
    get context() { return context; }, set context(value) { context = value; }, get refreshes() { return refreshes; },
    prepare: () => service.prepare({ contextId: context.contextId, revision: context.revision, keepId: context.keepId }),
    select: (plan, ids = plan.candidates.filter(value => value.eligible).map(value => value.id)) => ({ planId: plan.planId, revision: plan.revision, ids })
  };
}
const safe = failure => failure.code === 'LIBRARY_CLEANUP_SAFE' && !failure.message.includes('Private');

test('prepare verifies keeper first and exposes relative summaries without internal hashes or absolute paths', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  assert.match(prepared.planId, /^[a-f0-9]{32}$/); assert.equal(prepared.keepId, f.context.keepId);
  assert.deepEqual(f.inspected.map(value => value.relativePath), ['A/notes.chart', 'B/notes.chart', 'C/notes.chart']);
  assert.ok(f.inspected.every(value => value.rootPath === f.rootPath && value.signal instanceof AbortSignal));
  assert.deepEqual(prepared.candidates.map(value => value.eligible), [true, true]);
  assert.deepEqual(prepared.keep.audio, { status: 'verified', count: 1, bytes: 5 });
  const json = JSON.stringify(prepared); assert.ok(!json.includes(f.rootPath)); assert.ok(!json.includes(hash('notes'))); assert.ok(!json.includes('identity'));
  assert.equal(f.recycled.length, 0); assert.equal(f.refreshes, 0);
});

test('eligibility requires verified notes, audio, kind and the entire bundle including extra files', async t => {
  const cases = [
    { status: 'unavailable', reason: 'nested-folder' }, { notes: { format: 'chart', sha256: hash('other notes') } },
    { notes: { format: 'midi', sha256: hash('notes') } }, { audio: { status: 'missing', count: 0, bytes: 0, digest: null } },
    { audio: { status: 'verified', count: 1, bytes: 10, digest: hash('different audio') } },
    { bundleHash: hash('unique video extra') }, { kind: 'sng' }, { targetRelativePath: '../outside' }, { targetRelativePath: '' }, { targetRelativePath: 'A' }
  ];
  for (const changes of cases) {
    const f = await fixture(t, { inspect: async options => bundle(options.relativePath, options.relativePath.startsWith('B/') ? changes : {}) });
    const prepared = await f.prepare(); assert.equal(prepared.candidates[0].eligible, false, JSON.stringify(changes)); assert.equal(typeof prepared.candidates[0].reason, 'string');
    await assert.rejects(f.service.execute(f.select(prepared, [prepared.candidates[0].id])), safe); assert.equal(f.recycled.length, 0);
  }
});

test('fully verified differences require the explicit force path and never enter normal cleanup', async t => {
  for (const changes of [
    { audio: { status: 'verified', count: 1, bytes: 9, digest: hash('different audio') }, bundleHash: hash('bundle-with-different-audio') },
    { nonAudioHash: hash('different non-audio'), bundleHash: hash('different bundle'), totalBytes: 13 },
    { audio: { status: 'verified', count: 1, bytes: 9, digest: hash('different audio') }, nonAudioHash: hash('different non-audio'), bundleHash: hash('different bundle'), totalBytes: 17 }
  ]) {
    const f = await fixture(t, { inspect: async options => bundle(options.relativePath, options.relativePath.startsWith('B/') ? changes : {}) });
    const prepared = await f.prepare(), candidate = prepared.candidates[0];
    assert.equal(candidate.eligible, false); assert.equal(candidate.forceable, true, JSON.stringify(changes));
    await assert.rejects(f.service.review(f.select(prepared, [candidate.id])), safe);
    const force = { planId: prepared.planId, revision: prepared.revision, id: candidate.id };
    const reviewed = await f.service.forceReview(force);
    assert.deepEqual(reviewed.candidates.map(value => value.id), [candidate.id]);
    const result = await f.service.forceExecute(force);
    assert.deepEqual(result.recycledIds, [candidate.id]); assert.deepEqual(result.failed, []);
    assert.deepEqual(f.recycled, [path.join(f.rootPath, 'B')]);
  }
});

test('force override stays unavailable for missing or unverified audio, changed notes, unsafe targets and non-folder copies', async t => {
  for (const changes of [
    { audio: { status: 'missing', count: 0, bytes: 0, digest: null } },
    { audio: { status: 'unavailable', count: 1, bytes: 5, digest: null } },
    { notes: { format: 'chart', sha256: hash('changed notes'), bytes: 5 } },
    { targetRelativePath: '../outside' },
    { kind: 'sng', targetRelativePath: 'B/chart.sng' }
  ]) {
    const f = await fixture(t, { inspect: async options => bundle(options.relativePath, options.relativePath.startsWith('B/') ? changes : {}) });
    const prepared = await f.prepare(), candidate = prepared.candidates[0];
    assert.equal(candidate.eligible, false, JSON.stringify(changes));
    assert.equal(candidate.forceable, false, JSON.stringify(changes));
    await assert.rejects(f.service.forceReview({ planId: prepared.planId, revision: prepared.revision, id: candidate.id }), safe);
    assert.equal(f.recycled.length, 0);
  }
});

test('missing keeper audio, changed keeper notes and unsafe keeper target block every candidate', async t => {
  for (const changes of [{ audio: { status: 'missing', count: 0, bytes: 0, digest: null } }, { notes: { format: 'chart', sha256: hash('changed') } }, { targetRelativePath: '.' }]) {
    const f = await fixture(t, { inspect: async options => bundle(options.relativePath, options.relativePath.startsWith('A/') ? changes : {}) });
    assert.ok((await f.prepare()).candidates.every(value => !value.eligible));
  }
});

test('targets shared with indexed charts outside the group, and ancestor or overlapping targets are protected', async t => {
  const f = await fixture(t);
  f.document.items.push(item('B/Another song.sng'));
  assert.equal((await f.prepare()).candidates[0].eligible, false);
  f.document.items.pop();
  f.document.items.push(item('B/Nested/notes.chart'));
  assert.equal((await f.prepare()).candidates[0].eligible, false);
  assert.equal(f.recycled.length, 0);
});

test('review rejects malformed, duplicate, unknown, keeper, stale and path-bearing selections without mutation', async t => {
  const f = await fixture(t), prepared = await f.prepare(), good = f.select(prepared);
  for (const input of [null, {}, { ...good, ids: [] }, { ...good, ids: [good.ids[0], good.ids[0]] }, { ...good, ids: [f.context.keepId] }, { ...good, ids: [hash('foreign')] }, { ...good, revision: 99 }, { ...good, planId: 'b'.repeat(32) }, { ...good, paths: ['C:/songs/B'] }, { ...good, ids: ['B/notes.chart'] }]) {
    await assert.rejects(f.service.review(input), safe);
  }
  const reviewed = await f.service.review({ ...good, ids: [good.ids[1]] });
  assert.deepEqual(reviewed.candidates.map(value => value.id), [good.ids[1]]); assert.equal(reviewed.keep.id, f.context.keepId);
  reviewed.candidates[0].targetRelativePath = 'A'; prepared.candidates[1].eligible = false;
  assert.equal((await f.service.review({ ...good, ids: [good.ids[1]] })).candidates[0].targetRelativePath, 'C');
  assert.equal(f.recycled.length, 0); assert.equal(f.refreshes, 0);
});

test('only the explicitly selected target is revalidated and passed to native recycling; plan becomes unusable', async t => {
  const f = await fixture(t), prepared = await f.prepare(), chosen = prepared.candidates[1];
  assert.deepEqual(await f.service.execute(f.select(prepared, [chosen.id])), { recycledIds: [chosen.id], failed: [], cancelled: false, refreshRequested: true });
  assert.deepEqual(f.recycled, [path.join(f.rootPath, 'C')]); assert.equal(f.refreshes, 1); assert.equal(f.service.busy(), false);
  assert.ok(f.checked.some(value => value.relativePath === 'A/notes.chart')); assert.ok(f.checked.some(value => value.relativePath === 'C/notes.chart'));
  assert.ok(!f.checked.some(value => value.relativePath === 'B/notes.chart'));
  await assert.rejects(f.service.execute(f.select(prepared, [chosen.id])), safe);
});

test('the first native failure stops remaining targets, preserves partial success and sanitizes errors', async t => {
  let calls = 0; const f = await fixture(t, { recycle: async () => { if (++calls === 2) throw Error('Private C:/secret denied'); } });
  f.document.items.push(item('D/notes.chart')); f.context.members.push(item('D/notes.chart'));
  const prepared = await f.prepare(), result = await f.service.execute(f.select(prepared));
  assert.deepEqual(result.recycledIds, [prepared.candidates[0].id]);
  assert.deepEqual(result.failed.map(value => value.id), [prepared.candidates[1].id]); assert.ok(!result.failed[0].reason.includes('Private'));
  assert.equal(f.recycled.length, 2); assert.equal(result.refreshRequested, true); assert.equal(f.refreshes, 1);
});

test('changed keeper, changed candidate and an escaped checked target cause no recycle and one refresh', async t => {
  for (const bad of ['A/notes.chart', 'B/notes.chart', 'escape']) {
    const f = await fixture(t, { revalidate: async options => bad === options.relativePath ? null : bad === 'escape' && options.relativePath.startsWith('B/') ? path.join(options.rootPath, '..', 'private') : path.join(options.rootPath, options.expected.targetRelativePath) });
    const prepared = await f.prepare(), result = await f.service.execute(f.select(prepared));
    assert.equal(result.recycledIds.length, 0); assert.equal(result.failed.length, 1); assert.equal(f.recycled.length, 0); assert.equal(f.refreshes, 1);
  }
});

test('root, revision, snapshot, context, preference and membership changes invalidate existing plans', async t => {
  for (const change of ['root', 'revision', 'items', 'context', 'preference', 'member', 'keep']) {
    const f = await fixture(t), prepared = await f.prepare();
    if (change === 'root') f.document = { ...f.document, settings: { rootPath: path.join(f.rootPath, 'other') } };
    if (change === 'revision') f.document = { ...f.document, revision: 5 };
    if (change === 'items') f.document = { ...f.document, items: [...f.document.items] };
    if (change === 'context') f.context = { ...f.context, contextId: 'c'.repeat(32) };
    if (change === 'preference') f.context = { ...f.context, preferenceToken: {} };
    if (change === 'member') f.context.members[1] = { ...f.context.members[1], relativePath: 'Changed/notes.chart' };
    if (change === 'keep') f.context = { ...f.context, keepId: f.context.members[1].id };
    await assert.rejects(f.service.review(f.select(prepared)), safe); await assert.rejects(f.service.execute(f.select(prepared)), safe);
    assert.equal(f.recycled.length, 0); assert.equal(f.refreshes, 0);
  }
});

test('new prepare and preference changes invalidate older reads before publication', async t => {
  const entered = deferred(), gate = deferred(); let block = true, oldSignal;
  const f = await fixture(t, { inspect: async options => { if (block) { block = false; oldSignal = options.signal; entered.resolve(); await gate.promise; } return bundle(options.relativePath); } });
  const pending = f.prepare(), rejected = assert.rejects(pending, safe); await entered.promise;
  const newer = await f.prepare(); assert.equal(oldSignal.aborted, true); gate.resolve(); await rejected;
  await f.service.review(f.select(newer));
  const nextEntered = deferred(), nextGate = deferred(); let delayed = true;
  const second = await fixture(t, { inspect: async options => { if (delayed) { delayed = false; nextEntered.resolve(); await nextGate.promise; } return bundle(options.relativePath); } });
  const reading = second.prepare(), rejectedChoice = assert.rejects(reading, safe); await nextEntered.promise;
  second.context = { ...second.context, preferenceToken: {} }; nextGate.resolve(); await rejectedChoice;
});

test('execute captures IDs before asynchronous context checks and rejects concurrent execution', async t => {
  const entered = deferred(), gate = deferred(); let block = false;
  const f = await fixture(t, { context: async () => { if (block) { entered.resolve(); await gate.promise; } } });
  const prepared = await f.prepare(), request = f.select(prepared, [prepared.candidates[0].id]); block = true;
  const running = f.service.execute(request); await entered.promise;
  assert.equal(f.service.busy(), true); request.ids.push(prepared.candidates[1].id); request.ids[0] = f.context.keepId; request.revision = 99;
  await assert.rejects(f.service.execute(f.select(prepared)), safe); await assert.rejects(f.prepare(), safe);
  block = false; gate.resolve(); const result = await running;
  assert.deepEqual(result.recycledIds, [prepared.candidates[0].id]); assert.deepEqual(f.recycled, [path.join(f.rootPath, 'B')]);
});

test('stop cancels reads, waits for preparation and allows later reuse', async t => {
  const entered = deferred(), gate = deferred(); let block = true, signal;
  const f = await fixture(t, { inspect: async options => { signal = options.signal; if (block) { entered.resolve(); await gate.promise; } return bundle(options.relativePath); } });
  const pending = f.prepare(), rejected = assert.rejects(pending, safe); await entered.promise;
  let stopped = false; const stop = f.service.stop().then(() => { stopped = true; });
  assert.equal(signal.aborted, true); await Promise.resolve(); assert.equal(stopped, false); await assert.rejects(f.prepare(), safe);
  block = false; gate.resolve(); await rejected; await stop; assert.equal((await f.prepare()).candidates.length, 2);
});

test('stop before the first native recycle cancels validation and never sends a target', async t => {
  const entered = deferred(), gate = deferred(); let signal;
  const f = await fixture(t, { revalidate: async options => { signal = options.signal; entered.resolve(); await gate.promise; return path.join(options.rootPath, options.expected.targetRelativePath); } });
  const prepared = await f.prepare(), running = f.service.execute(f.select(prepared)); await entered.promise;
  const stopping = f.service.stop(); assert.equal(signal.aborted, true); gate.resolve();
  const result = await running; await stopping; assert.equal(result.cancelled, true); assert.equal(f.recycled.length, 0);
});

test('stop waits for an in-flight native recycle and never starts the next selected target', async t => {
  const entered = deferred(), gate = deferred();
  const f = await fixture(t, { recycle: async () => { entered.resolve(); await gate.promise; } });
  const prepared = await f.prepare(), running = f.service.execute(f.select(prepared)); await entered.promise;
  let stopped = false; const stop = f.service.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false);
  gate.resolve(); const result = await running; await stop;
  assert.deepEqual(result.recycledIds, [prepared.candidates[0].id]); assert.equal(result.cancelled, true); assert.equal(f.recycled.length, 1); assert.equal(f.refreshes, 1);
});

test('real bundles preserve all fixture files and reject audio or extra-file changes made after preview', async t => {
  const { createLibraryCleanup } = require('../companion/library-cleanup.cjs');
  const { inspectChartBundle } = require('../companion/chart-bundle.cjs');
  const f = await fixture(t);
  for (const member of f.context.members) { const directory = path.dirname(path.join(f.rootPath, member.relativePath)); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'notes.chart'), 'notes'); await fs.writeFile(path.join(directory, 'song.ogg'), 'audio'); }
  let recycled = 0;
  const service = createLibraryCleanup({ getDocument: () => f.document, getContext: async () => f.context, recycle: async () => { recycled++; } });
  t.after(() => service.stop());
  let prepared = await service.prepare({ contextId: f.context.contextId, revision: 4, keepId: f.context.keepId }); assert.ok(prepared.candidates.every(value => value.eligible));
  await fs.writeFile(path.join(f.rootPath, 'B', 'unique-video.mp4'), 'unique');
  let result = await service.execute(f.select(prepared, [prepared.candidates[0].id])); assert.equal(result.failed.length, 1); assert.equal(recycled, 0);
  prepared = await service.prepare({ contextId: f.context.contextId, revision: 4, keepId: f.context.keepId }); assert.equal(prepared.candidates[0].eligible, false);
  await fs.writeFile(path.join(f.rootPath, 'C', 'song.ogg'), 'changed');
  result = await service.execute(f.select(prepared, [prepared.candidates[1].id])); assert.equal(result.failed.length, 1); assert.equal(recycled, 0);
  assert.equal(await fs.readFile(path.join(f.rootPath, 'A', 'notes.chart'), 'utf8'), 'notes');
  assert.equal((await inspectChartBundle({ rootPath: f.rootPath, relativePath: 'A/notes.chart', format: 'chart' })).audio.status, 'verified');
});

test('cleanup context requires persisted preference and rejects external changes and earlier choice epochs', async t => {
  const { createLibraryDuplicates } = require('../companion/library-duplicates.cjs');
  const f = await fixture(t), dataDirectory = path.join(f.base, 'profile');
  f.document.items = f.document.items.map(member => ({ ...member, title: 'Song', artist: 'Artist', charter: 'Charter', audio: 'present' }));
  for (const member of f.document.items) { const target = path.join(f.rootPath, member.relativePath); await fs.mkdir(path.dirname(target)); await fs.writeFile(target, 'notes'); }
  const duplicates = createLibraryDuplicates({ dataDirectory, getDocument: () => f.document }); t.after(() => duplicates.stop());
  const comparison = await duplicates.compare({ revision: 4, id: f.document.items[0].id });
  const request = { contextId: comparison.contextId, revision: 4, keepId: f.document.items[0].id };
  await assert.rejects(duplicates.cleanupContext(request), { code: 'LIBRARY_COMPARISON_SAFE' });
  await duplicates.choose({ contextId: comparison.contextId, revision: 4, id: request.keepId });
  const first = await duplicates.cleanupContext(request); assert.equal(first.keepHash, hash('notes'));
  await duplicates.choose({ contextId: comparison.contextId, revision: 4, id: f.document.items[1].id });
  await duplicates.choose({ contextId: comparison.contextId, revision: 4, id: request.keepId });
  assert.notEqual((await duplicates.cleanupContext(request)).preferenceToken, first.preferenceToken);
  await fs.writeFile(path.join(dataDirectory, 'library-duplicate-choices.json'), '{externally changed');
  await assert.rejects(duplicates.cleanupContext(request), { code: 'LIBRARY_COMPARISON_SAFE' });
  assert.equal(await fs.readFile(path.join(dataDirectory, 'library-duplicate-choices.json'), 'utf8'), '{externally changed');
});

test('final candidate identity gate catches edits during the final keeper check without recycling', async t => {
  const real = require('../companion/chart-bundle.cjs');
  const f = await fixture(t);
  for (const member of f.context.members) { const directory = path.dirname(path.join(f.rootPath, member.relativePath)); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'notes.chart'), 'notes'); await fs.writeFile(path.join(directory, 'song.ogg'), 'audio'); }
  let recycled = 0, fullReads = 0, changed = false;
  const { createLibraryCleanup } = await injected({ './chart-bundle.cjs': {
    ...real,
    revalidateBundle: async options => { fullReads++; return real.revalidateBundle(options); },
    recheckBundleIdentity: async options => {
      if (!changed && options.relativePath.startsWith('A/')) { changed = true; await fs.writeFile(path.join(f.rootPath, 'B', 'song.ogg'), 'changed during final keeper check'); }
      return real.recheckBundleIdentity(options);
    }
  } });
  const service = createLibraryCleanup({ getDocument: () => f.document, getContext: async () => f.context, recycle: async () => { recycled++; } }); t.after(() => service.stop());
  const prepared = await service.prepare({ contextId: f.context.contextId, revision: 4, keepId: f.context.keepId });
  const result = await service.execute(f.select(prepared, [prepared.candidates[0].id]));
  assert.equal(result.failed.length, 1); assert.equal(recycled, 0); assert.equal(fullReads, 2, 'hash each bundle once before metadata-only gates');
});

test('cleanup planning covers the complete requested comparison without query-page truncation', async t => {
  const f = await fixture(t);
  f.document.items = Array.from({ length: 257 }, (_, index) => item(`Version ${index}/notes.chart`));
  f.context = { ...f.context, keepId: f.document.items[0].id, members: f.document.items.map(member => ({ ...member })) };
  const prepared = await f.prepare(); assert.equal(prepared.candidates.length, 256); assert.ok(prepared.candidates.every(value => value.eligible));
  const last = prepared.candidates.at(-1); assert.equal((await f.service.review(f.select(prepared, [last.id]))).candidates[0].id, last.id);
});
