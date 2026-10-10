'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { createBackgroundLibraryService } = require('../companion/library-background.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Cleanup worker fixture timed out'); await delay(5); }
}
function fakeFixture(t, { recycle = async () => {}, hold = ['recycleDuplicates', 'query', 'prepareCleanup'] } = {}) {
  const workers = [];
  const service = createBackgroundLibraryService({ dataDirectory: os.tmpdir(), recycle, workerFactory: () => {
    const worker = new EventEmitter(); worker.sent = []; worker.answered = new Set(); worker.terminated = false;
    worker.ref = () => {}; worker.unref = () => {};
    worker.terminate = async () => { worker.terminated = true; return 0; };
    worker.reply = (request, options = {}) => {
      worker.answered.add(request.id);
      worker.emit('message', { type: 'reply', id: request.id, ok: true, result: {}, state: { status: service.status() }, ...options });
    };
    worker.postMessage = message => {
      worker.sent.push(message);
      if (message.method && !hold.includes(message.method)) queueMicrotask(() => worker.reply(message));
    };
    worker.request = method => worker.sent.findLast(message => message.method === method);
    worker.relay = (requestId, id, target = path.join(os.tmpdir(), 'fixture-never-recycled')) => worker.emit('message', { type: 'recycle', requestId, id, target });
    workers.push(worker); return worker;
  } });
  t.after(async () => {
    for (const worker of workers) for (const request of worker.sent.filter(message => message.method && !worker.answered.has(message.id))) worker.reply(request);
    await service.stop();
  });
  return { service, workers, get worker() { return workers[workers.length - 1]; } };
}

test('native relay is authorized only by the current recycle RPC and rejects malformed, reused and concurrent callbacks', async t => {
  const gate = deferred(), entered = deferred(), calls = [];
  const f = fakeFixture(t, { recycle: async target => { calls.push(target); entered.resolve(); await gate.promise; } });
  try {
    await f.service.load();
    const query = f.service.query(), prepare = f.service.prepareCleanup({}), running = f.service.recycleDuplicates({});
    const w = f.worker, request = w.request('recycleDuplicates');
    w.relay(99999, 1); w.relay(w.request('query').id, 2); w.relay(w.request('prepareCleanup').id, 3);
    for (const id of [0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER + 1]) w.relay(request.id, id);
    w.relay(request.id, 5, 'relative/path'); w.relay(request.id, 6, path.join(os.tmpdir(), 'bad\0target'));
    await tick(); assert.deepEqual(calls, []);
    w.relay(request.id, 7); await entered.promise;
    w.relay(request.id, 7); w.relay(request.id, 8); await tick(); assert.equal(calls.length, 1);
    gate.resolve(); await tick();
    assert.ok(w.sent.some(message => message.type === 'recycle-result' && message.id === 7 && message.ok === true));
    w.relay(request.id, 7); await tick(); assert.equal(calls.length, 1, 'a completed callback ID is still single use');
    for (const method of ['query', 'prepareCleanup', 'recycleDuplicates']) w.reply(w.request(method));
    await Promise.all([query, prepare, running]);
    w.relay(request.id, 9); await tick(); assert.equal(calls.length, 1, 'completed parent RPC cannot authorize another callback');
    await f.service.stop(); await f.service.load();
    w.relay(request.id, 10); await tick(); assert.equal(calls.length, 1, 'stale worker generation cannot authorize callbacks');
  } finally { gate.resolve(); }
});

test('a recycle RPC completed before the native callback microtask cannot authorize that callback', async t => {
  const calls = [], f = fakeFixture(t, { recycle: async target => { calls.push(target); } });
  await f.service.load(); const running = f.service.recycleDuplicates({}), request = f.worker.request('recycleDuplicates');
  f.worker.relay(request.id, 1);
  f.worker.reply(request);
  await running; await tick();
  assert.deepEqual(calls, []);
  assert.ok(f.worker.sent.some(message => message.type === 'recycle-result' && message.id === 1 && message.ok === false));
});

test('stop denies scheduled and later callbacks before they cross the native boundary', async t => {
  const calls = [], f = fakeFixture(t, { recycle: async target => { calls.push(target); } });
  await f.service.load(); const running = f.service.recycleDuplicates({}), request = f.worker.request('recycleDuplicates');
  f.worker.relay(request.id, 1);
  const stopped = f.service.stop(); f.worker.relay(request.id, 2);
  f.worker.reply(request); await Promise.all([running, stopped]);
  f.worker.relay(request.id, 3); await tick(); assert.deepEqual(calls, []);
  assert.equal(f.worker.terminated, true);
});

test('stop waits for an active native callback when the worker crashes during shutdown', async t => {
  const gate = deferred(), entered = deferred(); let calls = 0;
  const f = fakeFixture(t, { recycle: async () => { calls++; entered.resolve(); await gate.promise; } });
  try {
    await f.service.load(); const running = f.service.recycleDuplicates({}), rejected = assert.rejects(running, /indisponible/);
    const request = f.worker.request('recycleDuplicates'); f.worker.relay(request.id, 1); await entered.promise;
    let finished = false; const stopped = f.service.stop().then(() => { finished = true; });
    f.worker.relay(request.id, 2); f.worker.emit('error', Error('private crash path'));
    await rejected; await tick(); assert.equal(finished, false); assert.equal(calls, 1);
    gate.resolve(); await stopped; assert.equal(finished, true); assert.equal(f.worker.terminated, true);
  } finally { gate.resolve(); }
});

test('stop after a worker crash blocks reopening until the active native callback has drained', async t => {
  const gate = deferred(), entered = deferred(); let calls = 0;
  const f = fakeFixture(t, { recycle: async () => { calls++; entered.resolve(); await gate.promise; } });
  try {
    await f.service.load(); const running = f.service.recycleDuplicates({}), rejected = assert.rejects(running, /indisponible/);
    const old = f.worker, request = old.request('recycleDuplicates'); old.relay(request.id, 1); await entered.promise;
    old.emit('error', Error('private worker crash')); await rejected;
    let finished = false, reopened = false;
    const stopped = f.service.stop().then(() => { finished = true; });
    const reload = f.service.load().then(() => { reopened = true; });
    await tick(); assert.equal(finished, false); assert.equal(reopened, false); assert.equal(f.workers.length, 1);
    old.relay(request.id, 2); await tick(); assert.equal(calls, 1);
    gate.resolve(); await Promise.all([stopped, reload]); assert.equal(f.workers.length, 2);
  } finally { gate.resolve(); }
});

test('a native callback rejection sends a failure reply without leaking native error text', async t => {
  const f = fakeFixture(t, { recycle: async () => { throw Error('Private C:/songs/secret native failure'); } });
  await f.service.load(); const running = f.service.recycleDuplicates({}), request = f.worker.request('recycleDuplicates');
  f.worker.relay(request.id, 1); await tick();
  const replies = f.worker.sent.filter(message => message.type === 'recycle-result');
  assert.deepEqual(replies, [{ type: 'recycle-result', id: 1, ok: false }]);
  f.worker.reply(request, { ok: false, error: 'Nettoyage non vérifié.', code: 'LIBRARY_CLEANUP_SAFE' });
  await assert.rejects(running, failure => failure.code === 'LIBRARY_CLEANUP_SAFE' && !failure.message.includes('Private'));
});

async function realFixture(t, recycle = async () => {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-cleanup-worker-'));
  const root = path.join(base, 'songs'), dataDirectory = path.join(base, 'profile');
  await fs.mkdir(root); await fs.mkdir(dataDirectory);
  for (const folder of ['A', 'B', 'C']) {
    const directory = path.join(root, folder); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'notes.chart'), '[Song]\n{\n Resolution = 192\n}\n[ExpertSingle]\n{\n 0 = N 0 192\n}\n');
    await fs.writeFile(path.join(directory, 'song.ini'), '[song]\nname=Same Song\nartist=Fixture Artist\ncharter=Fixture Charter\n');
    await fs.writeFile(path.join(directory, 'song.ogg'), 'fixture audio bytes');
  }
  const workers = [], sent = [], received = [], calls = [];
  const service = createBackgroundLibraryService({ dataDirectory, recycle: async (target, proof) => { calls.push(target); await recycle(target, proof); }, workerFactory: (filename, options) => {
    const worker = new Worker(filename, options), post = worker.postMessage.bind(worker);
    worker.postMessage = message => { sent.push(message); return post(message); };
    worker.on('message', message => received.push(message)); workers.push(worker); return worker;
  } });
  t.after(async () => {
    await service.stop();
    if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-cleanup-worker-')) throw Error('Unsafe cleanup worker fixture');
    await fs.rm(base, { recursive: true, force: true });
  });
  await service.load(); await service.selectRoot(root); await until(() => service.status().status === 'ready');
  const revision = service.status().revision, query = await service.query(), keep = query.items.find(item => item.relativePath === 'A/notes.chart');
  const compared = await service.compareDuplicates({ id: keep.id, revision });
  const chosen = await service.chooseDuplicate({ contextId: compared.contextId, revision, id: keep.id }); assert.equal(chosen.preferredId, keep.id);
  const plan = await service.prepareCleanup({ contextId: compared.contextId, revision, keepId: keep.id });
  assert.equal(plan.candidates.length, 2); assert.ok(plan.candidates.every(item => item.eligible));
  return { base, root, dataDirectory, service, workers, calls, plan, sent, received,
    selection: (candidates = plan.candidates) => ({ planId: plan.planId, revision: plan.revision, ids: candidates.map(item => item.id) }) };
}

test('real worker prepares, reviews and executes only selected bundles through the injected native relay', async t => {
  const f = await realFixture(t), candidate = f.plan.candidates.find(item => item.targetRelativePath === 'B'), selection = f.selection([candidate]);
  assert.deepEqual(f.calls, []); assert.ok(!JSON.stringify(f.plan).includes(f.root));
  const reviewed = await f.service.cleanupReview(selection); assert.deepEqual(reviewed.candidates.map(item => item.id), [candidate.id]);
  assert.equal((await f.service.cleanupHistory({ offset: 0, limit: 10 })).total, 0, 'review creates no cleanup record');
  assert.deepEqual(f.calls, []);
  const result = await f.service.recycleDuplicates(selection);
  assert.deepEqual(result, { recycledIds: [candidate.id], failed: [], cancelled: false, refreshRequested: true });
  assert.deepEqual(f.calls, [path.join(f.root, 'B')]);
  const history = await f.service.cleanupHistory({ offset: 0, limit: 10 });
  assert.equal(history.total, 1); assert.equal(history.entries[0].keep.id, f.plan.keepId);
  assert.deepEqual(history.entries[0].candidates.map(item => [item.id, item.status]), [[candidate.id, 'recycled']]);
  assert.ok(!JSON.stringify(history).includes(f.root));
  const relay = f.received.filter(message => message.type === 'recycle'); assert.equal(relay.length, 1);
  assert.equal(relay[0].proof.rootPath, f.root);
  assert.equal(relay[0].proof.keeper.relativePath, 'A/notes.chart');
  assert.equal(relay[0].proof.target.relativePath, 'B/notes.chart');
  assert.equal(relay[0].proof.target.expected.status, 'verified');
  assert.ok(!JSON.stringify(reviewed).includes('identity'), 'identity receipts stay private to worker and native host');
  assert.equal(f.sent.find(message => message.id === relay[0].requestId && message.method)?.method, 'recycleDuplicates');
  assert.ok(f.sent.some(message => message.type === 'recycle-result' && message.id === relay[0].id && message.ok));
  for (const name of ['A', 'B', 'C']) assert.equal((await fs.stat(path.join(f.root, name))).isDirectory(), true, 'fake callback never deletes fixture bundles');
  await until(() => f.service.status().status === 'ready');
  await assert.rejects(f.service.recycleDuplicates(selection), failure => failure.code === 'LIBRARY_CLEANUP_SAFE');
  assert.equal(f.calls.length, 1);
});

test('real worker records failed and unattempted copies, survives reload, and scopes history to current Songs', async t => {
  const f = await realFixture(t, async () => { throw Error('Fixture native failure'); });
  const result = await f.service.recycleDuplicates(f.selection());
  assert.equal(result.recycledIds.length, 0); assert.equal(result.failed.length, 1);
  const history = await f.service.cleanupHistory({ offset: 0, limit: 10 });
  assert.deepEqual(history.entries[0].candidates.map(item => item.status), ['failed', 'not-attempted']);
  await f.service.stop(); await f.service.load();
  assert.deepEqual(await f.service.cleanupHistory({ offset: 0, limit: 10 }), history);
  const other = path.join(f.base, 'other-songs'); await fs.mkdir(other); await f.service.selectRoot(other);
  await until(() => f.service.status().status === 'ready');
  assert.equal((await f.service.cleanupHistory({ offset: 0, limit: 10 })).total, 0);
  await f.service.selectRoot(f.root); await until(() => f.service.status().status === 'ready');
  assert.equal((await f.service.cleanupHistory({ offset: 0, limit: 10 })).total, 1);
});

test('native identity gate rejects a copy replaced after the real worker validation', async t => {
  const { verifyNativeCleanup } = require('../companion/native-cleanup.cjs');
  let nativeCalls = 0;
  const f = await realFixture(t, async (target, proof) => {
    const moved = path.join(f.base, 'original-copy');
    await fs.rename(target, moved);
    await fs.cp(moved, target, { recursive: true, preserveTimestamps: true });
    await verifyNativeCleanup({ root: f.root, keep: path.join(f.root, 'A'), target, proof });
    nativeCalls++;
  });
  const result = await f.service.recycleDuplicates(f.selection([f.plan.candidates[0]]));
  assert.equal(nativeCalls, 0);
  assert.deepEqual(result.recycledIds, []);
  assert.equal(result.failed.length, 1);
  for (const folder of ['A', 'B', 'C']) assert.ok((await fs.stat(path.join(f.root, folder))).isDirectory());
});

test('real worker returns native failures safely and stops before the next selected candidate', async t => {
  const f = await realFixture(t, async () => { throw Error('Private C:/secret/native failure'); });
  const result = await f.service.recycleDuplicates(f.selection());
  assert.deepEqual(result.recycledIds, []); assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, f.plan.candidates[0].id); assert.ok(!JSON.stringify(result).includes('Private'));
  assert.equal(f.calls.length, 1); assert.equal(result.refreshRequested, true);
  assert.ok(f.sent.some(message => message.type === 'recycle-result' && message.ok === false));
});

test('global duplicate verification crosses the real worker without authorizing any recycle', async t => {
  const f = await realFixture(t);
  const result = await f.service.verifyAllDuplicates();
  assert.deepEqual(result, { revision: f.plan.revision, totalGroups: 1, readyGroups: 1, needsKeeperGroups: 0, blockedGroups: 0, eligibleCopies: 2, processedGroups: 1, cancelled: false });
  const page = await f.service.query({ duplicates: 'possible' });
  assert.ok(page.items.every(item => item.duplicateVerification === 'ready' && item.verifiedEligibleCopies === 2));
  assert.equal(f.calls.length, 0);
  assert.equal(f.received.filter(message => message.type === 'recycle').length, 0);
  assert.ok(f.sent.some(message => message.method === 'verifyAllDuplicates'));
  await assert.rejects(f.service.recycleDuplicates(f.selection()), failure => failure.code === 'LIBRARY_CLEANUP_SAFE');
});

test('real worker shutdown drains the started native operation and cancels the remaining selected bundle', async t => {
  const gate = deferred(), entered = deferred();
  const f = await realFixture(t, async () => { entered.resolve(); await gate.promise; });
  try {
    const running = f.service.recycleDuplicates(f.selection()); await entered.promise;
    let finished = false; const stopped = f.service.stop().then(() => { finished = true; });
    await tick(); assert.equal(finished, false); assert.equal(f.calls.length, 1);
    gate.resolve(); const result = await running; await stopped;
    assert.equal(result.cancelled, true); assert.equal(result.recycledIds.length, 1); assert.equal(f.calls.length, 1);
    assert.equal(f.workers[0].threadId, -1);
  } finally { gate.resolve(); }
});
