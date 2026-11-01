'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuickImportDownloadObserver, MAX_PENDING, MAX_RECORDS } = require('../companion/quick-import-download-observer.cjs');

const ROOT = 'D:\\Songs';
const id = number => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function item(number, state = 'Downloading', overrides = {}) {
  return { id: id(number), state, rootPath: ROOT,
    ...(state === 'Completed' ? { destination: `${ROOT}\\Chart-${number}`, folderName: `Chart-${number}` } : {}), ...overrides };
}
function fixture(options = {}) {
  let current = { enabled: true, available: true, root: ROOT, lifecycle: 1 };
  const calls = [], resolves = [], changes = [];
  const observer = createQuickImportDownloadObserver({
    platform: 'win32', context: () => current,
    resolveCompletion: async (value, { signal }) => {
      resolves.push({ item: value, signal });
      return { id: value.id, folder: value.destination, chartFile: 'notes.chart' };
    },
    client: { newCompleted: async value => { calls.push(value); return { id: value.id, state: 'queued', confirmed: true }; } },
    onChange: value => changes.push(value), ...options
  });
  return { observer, calls, resolves, changes,
    set: value => { current = { ...current, ...value }; },
    get: () => current,
    observe: values => observer.observe({ items: values }),
    transition(number) { this.observe([item(number)]); this.observe([item(number, 'Completed')]); }
  };
}

test('construction and snapshot perform no context, resolver or client I/O', () => {
  let count = 0;
  const unused = () => { count++; throw Error('must not run'); };
  const observer = createQuickImportDownloadObserver({ context: unused, resolveCompletion: unused, client: { newCompleted: unused } });
  assert.deepEqual(observer.snapshot(), { schema: 1, phase: 'disabled', pending: 0, fault: null, ignored: 0, jobs: [] });
  assert.equal(count, 0);
});

test('baseline completed history and later unknown Completed IDs are never imported', async () => {
  const f = fixture();
  f.observe([item(1, 'Completed')]); f.observe([item(1, 'Completed'), item(2, 'Completed')]);
  await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.resolves.length, 0);
});

test('only observed non-Completed to Completed sends exactly one new completion', async () => {
  const f = fixture();
  f.observe([item(1)]); f.observe([item(1, 'Paused')]); f.observe([item(1, 'Completed')]);
  f.observe([item(1, 'Completed')]); await tick();
  assert.deepEqual(f.calls, [{ id: id(1), folder: `${ROOT}\\Chart-1`, chartFile: 'notes.chart' }]);
  assert.equal(f.resolves.length, 1);
  assert.deepEqual(f.observer.snapshot().jobs[0], { id: id(1), state: 'submitted', code: null,
    mayHaveReachedMod: true, confirmed: true, remoteState: 'queued' });
});

test('disabled observations and reactivation establish a fresh baseline, not history replay', async () => {
  const f = fixture(); f.set({ enabled: false }); f.observe([item(1)]);
  f.set({ enabled: true }); f.observe([item(1, 'Completed')]); await tick();
  assert.equal(f.calls.length, 0);
  f.transition(2); await tick(); assert.equal(f.calls.length, 1);
});

test('ID disappearing before its first Completed notification cannot prove a transition', async () => {
  const f = fixture(); f.observe([item(1)]); f.observe([]); f.observe([item(1, 'Completed')]);
  await tick(); assert.equal(f.calls.length, 0);
});

test('case-insensitive UUID and Windows root identity preserve a stable transition', async () => {
  const f = fixture(); f.observe([item(11, 'Downloading', { id: id(11).toUpperCase(), rootPath: 'd:\\songs' })]);
  f.observe([item(11, 'Completed')]); await tick(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].id, id(11));
});

test('completed ID cannot be imported a second time after state cycling', async () => {
  const f = fixture(); f.transition(1); await tick(); f.transition(1); await tick();
  assert.equal(f.calls.length, 1);
});

test('client readiness gates resolution and delivery, resumed only by update', async () => {
  const f = fixture(); f.set({ available: false }); f.transition(1); await tick();
  assert.equal(f.resolves.length, 0); assert.equal(f.observer.snapshot().phase, 'waiting-for-client');
  f.set({ available: true }); await tick(); assert.equal(f.calls.length, 0);
  f.observer.update(); await tick(); assert.equal(f.calls.length, 1);
});

test('availability lost during resolution retains one resolved task without resolving twice', async () => {
  const pending = deferred(); let count = 0;
  const f = fixture({ resolveCompletion: async value => { count++; await pending.promise;
    return { id: value.id, folder: value.destination, chartFile: 'notes.mid' }; } });
  f.transition(1); await tick(); f.set({ available: false });
  pending.resolve(); await tick(); assert.equal(f.calls.length, 0);
  f.set({ available: true }); f.observer.update(); await tick();
  assert.equal(count, 1); assert.equal(f.calls[0].chartFile, 'notes.mid');
});

test('32-place queue is bounded, serial, and overflow never changes download status', async () => {
  const f = fixture(); f.set({ available: false });
  const downloading = Array.from({ length: 100 }, (_, i) => item(i + 1));
  const complete = Array.from({ length: 100 }, (_, i) => item(i + 1, 'Completed'));
  f.observe(downloading); f.observe(complete);
  const snap = f.observer.snapshot();
  assert.equal(snap.pending, MAX_PENDING); assert.equal(snap.ignored, 68); assert.equal(snap.jobs.length, MAX_RECORDS);
  assert.equal(complete.every(value => value.state === 'Completed'), true);
  f.set({ available: true }); f.observer.update(); await tick();
  assert.equal(f.calls.length, 32); assert.equal(f.observer.snapshot().pending, 0);
});

test('independent observers can share one strict 32-task admission budget', async () => {
  let first, second;
  const pendingCount = () => first.observer.snapshot().pending + second.observer.snapshot().pending;
  first = fixture({ pendingCount }); second = fixture({ pendingCount });
  first.set({ available: false }); second.set({ available: false });
  first.observe(Array.from({ length: 20 }, (_, index) => item(index + 1)));
  second.observe(Array.from({ length: 20 }, (_, index) => item(index + 21)));
  first.observe(Array.from({ length: 20 }, (_, index) => item(index + 1, 'Completed')));
  second.observe(Array.from({ length: 20 }, (_, index) => item(index + 21, 'Completed')));
  assert.equal(pendingCount(), 32); assert.equal(second.observer.snapshot().ignored, 8);
  first.observer.dispose(); second.observer.dispose(); await tick();
});

test('resolver and client calls are physically serial, including a blocked client', async () => {
  const first = deferred(); let active = 0, maximum = 0, calls = 0;
  const f = fixture({ client: { newCompleted: async () => { active++; maximum = Math.max(maximum, active);
    if (++calls === 1) await first.promise; active--; return { state: 'queued', confirmed: true }; } } });
  f.observe([item(1), item(2)]); f.observe([item(1, 'Completed'), item(2, 'Completed')]);
  await tick(); assert.equal(calls, 1); first.resolve(); await tick();
  assert.equal(calls, 2); assert.equal(maximum, 1);
});

test('root change discards queued work and resets the transition baseline', async () => {
  const f = fixture(); f.set({ available: false }); f.transition(1);
  f.set({ root: 'E:\\Songs', available: true }); f.observer.update();
  f.observe([item(1, 'Completed')]); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.observer.snapshot().jobs[0].state, 'cancelled');
});

test('lifecycle change cancels a resolver even if it ignores AbortSignal; stale work never sends', async () => {
  const pending = deferred(); let signal;
  const f = fixture({ resolveCompletion: async (value, options) => { signal = options.signal; await pending.promise;
    return { id: value.id, folder: value.destination, chartFile: 'notes.chart' }; } });
  f.transition(1); await tick(); f.set({ lifecycle: 2 }); f.observer.update();
  assert.equal(signal.aborted, true); pending.resolve(); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.observer.snapshot().jobs[0].state, 'cancelled');
});

test('context changes are rechecked after await even without an explicit update notification', async () => {
  const pending = deferred();
  const f = fixture({ resolveCompletion: async value => { await pending.promise;
    return { id: value.id, folder: value.destination, chartFile: 'notes.chart' }; } });
  f.transition(1); await tick(); f.set({ enabled: false }); pending.resolve(); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.observer.snapshot().phase, 'disabled');
});

test('opt-out after client invocation honestly leaves delivery unconfirmed, not remotely cancelled', async () => {
  const pending = deferred(); let count = 0;
  const f = fixture({ client: { newCompleted: async () => { count++; await pending.promise;
    return { state: 'ready', confirmed: true }; } } });
  f.transition(1); await tick(); f.set({ enabled: false }); f.observer.update();
  const current = f.observer.snapshot().jobs[0];
  assert.equal(current.state, 'unconfirmed'); assert.equal(current.mayHaveReachedMod, true); assert.equal(current.confirmed, false);
  pending.resolve(); await tick();
  assert.deepEqual(f.observer.snapshot().jobs[0], current); assert.equal(count, 1);
});

test('an old delivery cannot block the bound or overlap delivery in a fresh session', async () => {
  const pending = deferred(); let count = 0, active = 0, maximum = 0;
  const f = fixture({ client: { newCompleted: async () => { active++; maximum = Math.max(maximum, active);
    if (++count === 1) await pending.promise; active--; return { state: 'queued', confirmed: true }; } } });
  f.transition(1); await tick(); f.set({ lifecycle: 2 }); f.observer.update(); f.transition(2);
  await tick(); assert.equal(count, 1); pending.resolve(); await tick();
  assert.equal(count, 2); assert.equal(maximum, 1);
});

for (const trigger of ['update', 'stale observation']) test(`new Songs baseline observed inside abort survives an outer ${trigger}`, async () => {
  const first = deferred(), nextRoot = 'E:\\Songs'; let f;
  const nextItem = state => item(2, state, { rootPath: nextRoot,
    ...(state === 'Completed' ? { destination: `${nextRoot}\\Chart-2` } : {}) });
  f = fixture({ resolveCompletion: async (value, { signal }) => {
    if (value.id === id(1)) {
      signal.addEventListener('abort', () => f.observe([nextItem('Downloading')]), { once: true });
      await first.promise;
    }
    return { id: value.id, folder: value.destination, chartFile: 'notes.chart' };
  } });
  f.transition(1); await tick(); f.set({ root: nextRoot, lifecycle: 2 });
  if (trigger === 'update') f.observer.update(); else f.observe([item(1, 'Completed')]);
  first.resolve(); await tick(); f.observe([nextItem('Completed')]); await tick();
  assert.deepEqual(f.calls, [{ id: id(2), folder: `${nextRoot}\\Chart-2`, chartFile: 'notes.chart' }]);
  assert.equal(f.observer.snapshot().jobs.find(job => job.id === id(1)).state, 'cancelled');
});

for (const method of ['stop', 'dispose']) test(`${method} cannot be reactivated by its synchronous abort listener or old completion`, async () => {
  const first = deferred(); let f, resolutions = 0;
  f = fixture({ resolveCompletion: async (value, { signal }) => {
    resolutions++;
    signal.addEventListener('abort', () => { f.transition(2); f.observer.update(); }, { once: true });
    await first.promise;
    return { id: value.id, folder: value.destination, chartFile: 'notes.chart' };
  } });
  f.transition(1); await tick(); f.observer[method](); first.resolve(); await tick();
  assert.equal(resolutions, 1); assert.equal(f.calls.length, 0);
  assert.equal(f.observer.snapshot().phase, method === 'stop' ? 'disabled' : 'disposed');
});

test('stop before the scheduled resolver starts prevents any resolution or delivery', async () => {
  const f = fixture(); f.transition(1); f.observer.stop(); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.resolves.length, 0);
});

test('dispose prevents all future observations and updates', async () => {
  const f = fixture(); f.observer.dispose(); f.transition(1); f.observer.update(); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.observer.snapshot().phase, 'disposed');
});

test('root of download is immutable across transition and must equal selected Songs', async () => {
  const f = fixture(); f.observe([item(1, 'Downloading', { rootPath: 'E:\\Songs' }), item(2, 'Downloading', { rootPath: 'E:\\Songs' })]);
  f.observe([item(1, 'Completed'), item(2, 'Completed', { rootPath: 'E:\\Songs', destination: 'E:\\Songs\\Chart-2' })]);
  await tick(); assert.equal(f.calls.length, 0);
});

test('raw source objects and resolver inputs cannot mutate an admitted completion', async () => {
  const pending = deferred(); let captured;
  const f = fixture({ resolveCompletion: async value => { captured = value; await pending.promise;
    return { id: value.id, folder: value.destination, chartFile: 'notes.chart' }; } });
  f.observe([item(1)]); const completed = item(1, 'Completed'); f.observe([completed]);
  completed.destination = 'E:\\Foreign'; completed.id = id(2);
  await tick(); assert.equal(Object.isFrozen(captured), true); pending.resolve(); await tick();
  assert.equal(f.calls[0].folder, `${ROOT}\\Chart-1`); assert.equal(f.calls[0].id, id(1));
});

for (const [name, resolved] of [
  ['wrong UUID', { id: id(2), folder: `${ROOT}\\Chart-1`, chartFile: 'notes.chart' }],
  ['outside folder', { id: id(1), folder: 'E:\\Foreign', chartFile: 'notes.chart' }],
  ['different child', { id: id(1), folder: `${ROOT}\\Other`, chartFile: 'notes.chart' }],
  ['nested traversal', { id: id(1), folder: `${ROOT}\\..\\Foreign`, chartFile: 'notes.chart' }],
  ['arbitrary file', { id: id(1), folder: `${ROOT}\\Chart-1`, chartFile: 'audio.ogg' }],
  ['secret field', { id: id(1), folder: `${ROOT}\\Chart-1`, chartFile: 'notes.chart', token: 'PRIVATE' }]
]) test(`resolver rejects ${name} without delivering`, async () => {
  const f = fixture({ resolveCompletion: async () => resolved }); f.transition(1); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.observer.snapshot().jobs[0].state, 'failed');
});

for (const [name, overrides] of [
  ['invalid UUID', { id: 'not-an-id' }], ['nil UUID', { id: '00000000-0000-0000-0000-000000000000' }],
  ['unknown state', { state: 'ready' }], ['UNC', { destination: '\\\\server\\Songs\\Chart-1' }],
  ['alternate stream', { destination: `${ROOT}\\Chart-1:secret` }],
  ['trailing dot', { destination: `${ROOT}\\Chart-1.` }],
  ['outside root', { destination: 'E:\\Foreign' }],
  ['root itself', { destination: ROOT }], ['nested folder', { destination: `${ROOT}\\Nested\\Chart-1` }],
  ['wrong folder label', { folderName: 'Other' }]
]) test(`download notification rejects ${name}`, async () => {
  const f = fixture(); f.observe([item(1)]); f.observe([item(1, 'Completed', overrides)]); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.observer.snapshot().fault, 'INVALID_DOWNLOAD_STATUS');
});

test('oversized or duplicated item snapshots do not replace the trusted baseline', async () => {
  const f = fixture(); f.observe([item(1)]);
  f.observe([item(1), item(1, 'Completed')]);
  assert.equal(f.observer.snapshot().fault, 'INVALID_DOWNLOAD_STATUS');
  f.observe(Array.from({ length: 101 }, (_, index) => item(index + 1)));
  assert.equal(f.observer.snapshot().fault, 'INVALID_DOWNLOAD_STATUS');
  f.observe([item(1, 'Completed')]); await tick(); assert.equal(f.calls.length, 1);
});

test('resolution and client failures are isolated, sanitized and never retried automatically', async () => {
  for (const stage of ['resolve', 'client']) {
    const failure = Object.assign(Error('C:\\Private\\token=SECRET'), { code: 'UNTRUSTED_SECRET' });
    const f = fixture(stage === 'resolve' ? { resolveCompletion: async () => { throw failure; } }
      : { client: { newCompleted: async () => { throw failure; } } });
    f.transition(1); await tick(); f.observe([item(1, 'Completed')]); f.observer.update(); await tick();
    const json = JSON.stringify(f.observer.snapshot());
    assert.equal(json.includes('SECRET'), false); assert.equal(json.includes('Private'), false);
    assert.equal(f.observer.snapshot().jobs[0].state, 'failed');
    assert.equal(f.observer.snapshot().jobs[0].mayHaveReachedMod, stage === 'client');
  }
});

test('throwing context and onChange callbacks never escape into the successful download pipeline', async () => {
  const observer = createQuickImportDownloadObserver({ context: () => { throw Error('PRIVATE'); },
    resolveCompletion: () => assert.fail(), client: { newCompleted: () => assert.fail() },
    onChange: () => { throw Error('PRIVATE'); } });
  assert.doesNotThrow(() => { observer.observe({ items: [] }); observer.update(); observer.stop(); observer.dispose(); });
  const f = fixture({ onChange: () => { throw Error('PRIVATE'); } }); f.transition(1); await tick();
  assert.equal(f.calls.length, 1);
});

test('opt-out from a synchronous progress callback fences the unsent delivery', async () => {
  let f;
  f = fixture({ onChange: status => { if (status.jobs.some(job => job.state === 'submitting')) f.set({ enabled: false }); } });
  f.transition(1); await tick(); assert.equal(f.calls.length, 0);
});

test('public progress and returned snapshots contain no local paths, source metadata or transport secrets', async () => {
  const f = fixture(); f.observe([item(1)]);
  f.observe([item(1, 'Completed', { token: 'PRIVATE', pipeName: 'PRIVATE', title: 'PRIVATE', endpoint: 'PRIVATE' })]);
  await tick();
  const json = JSON.stringify({ snapshot: f.observer.snapshot(), changes: f.changes });
  for (const privateText of ['PRIVATE', 'Songs', 'destination', 'rootPath', 'chartFile', 'pipeName', 'token']) assert.equal(json.includes(privateText), false);
  f.observer.snapshot().jobs[0].state = 'fake'; assert.equal(f.observer.snapshot().jobs[0].state, 'submitted');
  assert.deepEqual(Object.keys(f.resolves[0].item).sort(), ['destination', 'folderName', 'id', 'rootPath', 'state']);
});

test('bounded session deduplication fails closed at 128, without evicting admitted IDs', async () => {
  const f = fixture();
  for (let number = 1; number <= 130; number++) { f.transition(number); await tick(); }
  assert.equal(f.calls.length, 128); assert.equal(f.observer.snapshot().fault, 'OBSERVER_SESSION_LIMIT');
  assert.equal(f.observer.snapshot().jobs.length, MAX_RECORDS);
  f.transition(1); await tick(); assert.equal(f.calls.length, 128);
});

test('invalid lifecycle or Songs context disables safely rather than starting imports', async () => {
  for (const bad of [{ lifecycle: {} }, { lifecycle: -1 }, { root: '\\\\server\\Songs' }, { root: 'relative' }]) {
    const f = fixture(); f.set(bad); f.transition(1); await tick();
    assert.equal(f.calls.length, 0); assert.equal(f.observer.snapshot().phase, 'disabled');
  }
});
