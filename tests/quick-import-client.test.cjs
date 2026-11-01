'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createQuickImportClient, parseBounded, MAX_BYTES } = require('../companion/quick-import-client.cjs');

const BASE = path.join(__dirname, '../outputs/quick-import-client-tests');
const TOKEN = 'abcdef0123456789'.repeat(4);
const PIPE = 'ChartsHub.QuickImport.v1.' + 'a'.repeat(32);
const BUILD = '1.1.0.6142-test-validated';
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Synthetic test condition was not reached');
};
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code && error.message === code);
const hello = () => ({ schema: 1, importValidated: true, build: BUILD, phase: 'available', fullScanFallback: false });
const job = (id, state = 'queued', code = null, deduplicated = false) => ({ Id: id, State: state, Code: code, Deduplicated: deduplicated });

class FakeSocket extends EventEmitter {
  constructor(owner) { super(); this.owner = owner; this.destroyed = false; }
  write(bytes) {
    const request = JSON.parse(bytes.toString('utf8'));
    this.owner.calls.push(request);
    Promise.resolve().then(() => this.owner.reply(request, this)).then(value => {
      if (value === undefined) return;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify({ schema: 1, ok: true, result: value }) + '\n');
      // A deliberately late synthetic response still exercises the lease guard.
      this.emit('data', bytes);
    }, () => this.emit('error', new Error('Synthetic socket failure')));
    return true;
  }
  destroy() { this.destroyed = true; this.emit('close'); }
}

async function fixture(t, overrides = {}) {
  await fs.mkdir(BASE, { recursive: true });
  const root = await fs.mkdtemp(path.join(BASE, 'case-'));
  const gameRoot = path.join(root, 'game');
  const songsRoot = path.join(root, 'Songs');
  const folder = path.join(songsRoot, 'new-chart');
  const descriptorPath = path.join(gameRoot, 'UserData', 'ChartsHubQuickImport', 'connection.json');
  await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'notes.chart'), '[Song]\n{\n Name = "Synthetic chart"\n}\n');
  const descriptor = { schema: 1, provider: 'chartshub.quick-import', version: '0.1.0', pid: 123,
    pipeName: PIPE, token: TOKEN, importValidated: true, fullScanFallback: false };
  await fs.writeFile(descriptorPath, JSON.stringify(descriptor));
  const owner = { calls: [], sockets: [], connections: [], reads: [], reply(request) {
    return request.command === 'hello' ? hello() : job(request.id);
  } };
  const io = new Proxy(fs, { get(target, key) {
    if (key === 'readdir' || key === 'writeFile' || key === 'mkdir' || key === 'unlink' || key === 'rename') {
      return () => { throw Error('The client must never scan or write'); };
    }
    if (typeof target[key] === 'function') return (...args) => {
      owner.reads.push({ operation: key, file: args[0] });
      return target[key](...args);
    };
    return target[key];
  } });
  const connect = pipePath => {
    owner.connections.push(pipePath);
    assert.equal(pipePath, '\\\\.\\pipe\\' + PIPE);
    const socket = new FakeSocket(owner); owner.sockets.push(socket);
    setImmediate(() => socket.emit('connect'));
    return socket;
  };
  const options = { gameRoot, songsRoot, expectedBuild: BUILD, platform: 'win32', pathApi: path, fs: io, connect, timeoutMs: 1000, ...overrides };
  const client = createQuickImportClient(options);
  t.after(async () => {
    client.dispose();
    assert(root.startsWith(BASE + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, gameRoot, songsRoot, folder, descriptorPath, descriptor, owner, client, options,
    completion: (extra = {}) => ({ id: crypto.randomUUID(), folder, chartFile: 'notes.chart', ...extra }),
    writeDescriptor: async change => fs.writeFile(descriptorPath, JSON.stringify({ ...descriptor, ...change })) };
}

test('construction and snapshots perform no I/O and expose no local identity', () => {
  let calls = 0;
  const io = new Proxy({}, { get() { calls++; throw Error('I/O during construction'); } });
  const client = createQuickImportClient({ gameRoot: 'C:\\Game', songsRoot: 'D:\\Songs', expectedBuild: BUILD,
    platform: 'win32', fs: io, connect() { calls++; throw Error('Connected during construction'); } });
  assert.equal(client.snapshot().phase, 'disabled');
  client.disable(); client.dispose();
  assert.equal(calls, 0);
});

test('explicit opt-in is required before descriptor, chart or pipe access', async t => {
  const f = await fixture(t);
  await rejected(f.client.enable({ consent: false }), 'EXPLICIT_OPT_IN_REQUIRED');
  await rejected(f.client.enable({}), 'EXPLICIT_OPT_IN_REQUIRED');
  await rejected(f.client.newCompleted(f.completion()), 'NOT_ENABLED');
  assert.deepEqual(f.owner.reads, []); assert.deepEqual(f.owner.calls, []);
});

test('hello is the sole initial request; only exact verified capability enables imports', async t => {
  const f = await fixture(t);
  const status = await f.client.enable({ consent: true });
  assert.equal(status.phase, 'available'); assert.equal(status.build, BUILD);
  assert.deepEqual(f.owner.calls.map(x => x.command), ['hello']);
  assert(f.owner.calls.every(x => x.token === TOKEN));
  assert(f.owner.reads.every(x => !String(x.file).endsWith('notes.chart')));
  assert(!JSON.stringify(status).includes(TOKEN)); assert(!JSON.stringify(status).includes(PIPE));
  assert(!JSON.stringify(status).includes(f.gameRoot));
});

for (const change of [{ importValidated: false }, { fullScanFallback: true }, { build: 'unknown' }, { phase: 'diagnostic-only' }, { schema: 2 }]) {
  test('hello refuses unsafe capability ' + Object.keys(change)[0] + '=' + String(Object.values(change)[0]), async t => {
    const f = await fixture(t); f.owner.reply = () => ({ ...hello(), ...change });
    await rejected(f.client.enable({ consent: true }), 'UNVERIFIED_BUILD');
    assert.equal(f.client.snapshot().enabled, false);
    assert(!f.owner.reads.some(x => String(x.file).endsWith('notes.chart')));
  });
}

test('diagnostic descriptor is refused without contacting a pipe', async t => {
  const f = await fixture(t); await f.writeDescriptor({ importValidated: false });
  await rejected(f.client.enable({ consent: true }), 'IMPORT_NOT_VALIDATED');
  assert.equal(f.owner.connections.length, 0);
});

for (const change of [{ pipeName: '\\\\remote\\pipe\\foreign' }, { pipeName: PREFIX_FOR_TEST() + '../other' },
  { provider: 'other' }, { token: 'a'.repeat(63) }, { pid: -1 }, { fullScanFallback: true }, { extra: true }]) {
  test('descriptor rejects unsupported identity ' + Object.keys(change)[0], async t => {
    const f = await fixture(t); await f.writeDescriptor(change);
    await rejected(f.client.enable({ consent: true }), 'INVALID_DESCRIPTOR');
    assert.equal(f.owner.connections.length, 0);
  });
}
function PREFIX_FOR_TEST() { return 'ChartsHub.QuickImport.v1.'; }

test('descriptor bounds and duplicate JSON names fail closed', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.descriptorPath, ' '.repeat(MAX_BYTES + 1));
  await rejected(f.client.enable({ consent: true }), 'INVALID_DESCRIPTOR');
  await fs.writeFile(f.descriptorPath, JSON.stringify(f.descriptor).replace('"schema":1', '"schema":1,"schema":1'));
  await rejected(f.client.enable({ consent: true }), 'PROTOCOL');
  assert.equal(f.owner.connections.length, 0);
});

test('descriptor symlink is rejected before its content is opened', async t => {
  const f = await fixture(t); const actual = path.join(f.root, 'actual.json');
  await fs.rename(f.descriptorPath, actual);
  try { await fs.symlink(actual, f.descriptorPath, 'file'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Windows file symlink privilege unavailable'); throw error; }
  await rejected(f.client.enable({ consent: true }), 'LINKED_PATH');
  assert(!f.owner.reads.some(x => x.operation === 'open'));
});

test('linked descriptor ancestor is rejected with a deterministic filesystem fixture', async t => {
  const f = await fixture(t);
  const linked = path.dirname(f.descriptorPath);
  const io = new Proxy(f.options.fs, { get(target, key) {
    if (key !== 'lstat') return target[key];
    return async file => {
      const stat = await target.lstat(file);
      return file === linked ? new Proxy(stat, { get(s, name) {
        return name === 'isSymbolicLink' ? () => true : (typeof s[name] === 'function' ? s[name].bind(s) : s[name]);
      } }) : stat;
    };
  } });
  const client = createQuickImportClient({ ...f.options, fs: io }); t.after(() => client.dispose());
  await rejected(client.enable({ consent: true }), 'LINKED_PATH');
  assert.equal(f.owner.connections.length, 0); assert(!f.owner.reads.some(x => x.operation === 'open'));
});

test('local canonical target must match its checked path even without an obvious symlink', async t => {
  const f = await fixture(t);
  const io = new Proxy(f.options.fs, { get(target, key) {
    if (key !== 'realpath') return target[key];
    return file => file === f.descriptorPath ? Promise.resolve(path.join(f.root, 'foreign.json')) : target.realpath(file);
  } });
  const client = createQuickImportClient({ ...f.options, fs: io }); t.after(() => client.dispose());
  await rejected(client.enable({ consent: true }), 'LINKED_PATH');
  assert.equal(f.owner.connections.length, 0);
});

test('new completed chart hashes one target, enqueues once and reports queued honestly', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  const completion = f.completion();
  const [a, b] = await Promise.all([f.client.newCompleted(completion), f.client.newCompleted(completion)]);
  assert.deepEqual(a, b); assert.equal(a.state, 'queued'); assert.equal(a.waitingForSafeMenu, true);
  const requests = f.owner.calls.filter(x => x.command === 'enqueue');
  assert.equal(requests.length, 1);
  const expected = crypto.createHash('sha256').update(await fs.readFile(path.join(f.folder, 'notes.chart'))).digest('hex');
  assert.equal(requests[0].chartSha256, expected);
  assert.equal(f.owner.reads.filter(x => x.operation === 'open' && String(x.file).endsWith('notes.chart')).length, 1);
  assert.equal(f.client.snapshot().gamePhase, 'unknown');
  assert(!JSON.stringify(f.client.snapshot()).includes(f.folder));
});

test('notes.mid is supported while all history/bulk/partial-file variants are refused before hashing', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  for (const extra of [{ fromHistory: true }, { history: [] }, { chartFile: 'notes.chart.part' }, { chartFile: '../notes.chart' }]) {
    await rejected(f.client.newCompleted(f.completion(extra)), 'INVALID_COMPLETION');
  }
  assert(!f.owner.reads.some(x => String(x.file).endsWith('notes.chart')));
  await fs.writeFile(path.join(f.folder, 'notes.mid'), Buffer.from('4d54686400000006', 'hex'));
  await f.client.newCompleted(f.completion({ chartFile: 'notes.mid' }));
  assert.equal(f.owner.calls.at(-1).chartFile, 'notes.mid');
});

test('completion payload is copied before awaits so caller mutation cannot change the hashed file', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  const completion = f.completion(), operation = f.client.newCompleted(completion);
  completion.chartFile = '../../private'; completion.folder = f.root; completion.id = crypto.randomUUID();
  await operation;
  assert.equal(f.owner.calls.at(-1).chartFile, 'notes.chart');
  assert.equal(f.owner.calls.at(-1).folder, f.folder);
  assert(!f.owner.reads.some(x => String(x.file).includes('private')));
});

test('empty and oversized chart files are refused before the hash reader opens them', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  const file = path.join(f.folder, 'notes.chart'); await fs.truncate(file, 0);
  await rejected(f.client.newCompleted(f.completion()), 'CHART_MISSING_OR_TOO_LARGE');
  await fs.truncate(file, 134217729);
  await rejected(f.client.newCompleted(f.completion()), 'CHART_MISSING_OR_TOO_LARGE');
  assert.equal(f.owner.reads.filter(x => x.operation === 'open' && x.file === file).length, 0);
});

test('root itself, traversal and neighbouring directory cannot be imported', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  for (const folder of [f.songsRoot, path.join(f.songsRoot, '..', 'outside'), f.songsRoot + '-outside']) {
    await rejected(f.client.newCompleted(f.completion({ folder })), 'OUTSIDE_SONGS_ROOT');
  }
  assert.equal(f.owner.calls.length, 1);
});

test('linked chart directory and linked parent are refused without opening the chart', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'notes.chart'), 'private synthetic text');
  const link = path.join(f.songsRoot, 'linked');
  try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Directory link privilege unavailable'); throw error; }
  await rejected(f.client.newCompleted(f.completion({ folder: link })), 'LINKED_PATH');
  assert(!f.owner.reads.some(x => x.operation === 'open' && String(x.file).endsWith('notes.chart')));
});

test('changed descriptor revokes capability before hashing or enqueue', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  await f.writeDescriptor({ token: 'b'.repeat(64) });
  await rejected(f.client.newCompleted(f.completion()), 'CONNECTION_CHANGED');
  assert.equal(f.client.snapshot().phase, 'unavailable');
  assert(!f.owner.reads.some(x => String(x.file).endsWith('notes.chart')));
  assert.equal(f.owner.calls.length, 1);
});

test('chart mutation during the read is rejected instead of sending a stale digest', async t => {
  const f = await fixture(t); const baseOpen = f.options.fs.open;
  const changingIo = new Proxy(f.options.fs, { get(target, key) {
    if (key !== 'open') return target[key];
    return async (...args) => {
      const handle = await baseOpen(...args);
      if (!String(args[0]).endsWith('notes.chart')) return handle;
      return new Proxy(handle, { get(file, method) {
        if (method === 'read') return async (...readArgs) => {
          const result = await file.read(...readArgs);
          await fs.appendFile(args[0], '\nchanged'); return result;
        };
        return typeof file[method] === 'function' ? file[method].bind(file) : file[method];
      } });
    };
  } });
  const client = createQuickImportClient({ ...f.options, fs: changingIo }); t.after(() => client.dispose());
  await client.enable({ consent: true });
  await rejected(client.newCompleted(f.completion()), 'CHART_CHANGED');
  assert.equal(f.owner.calls.filter(x => x.command === 'enqueue').length, 0);
});

test('one completion ID cannot be reused for a different folder', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  const completion = f.completion(); await f.client.newCompleted(completion);
  await rejected(f.client.newCompleted({ ...completion, folder: path.join(f.songsRoot, 'other') }), 'REQUEST_ID_CONFLICT');
  assert.equal(f.owner.calls.filter(x => x.command === 'enqueue').length, 1);
});

test('status requires a known ID and never hashes the chart again', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  await rejected(f.client.refreshStatus(crypto.randomUUID()), 'UNKNOWN_JOB');
  const completion = f.completion(); await f.client.newCompleted(completion);
  const chartReads = f.owner.reads.filter(x => String(x.file).endsWith('notes.chart')).length;
  f.owner.reply = request => job(request.id, 'ready');
  const status = await f.client.refreshStatus(completion.id);
  assert.equal(status.state, 'ready'); assert.equal(status.waitingForSafeMenu, false);
  assert.equal(f.owner.reads.filter(x => String(x.file).endsWith('notes.chart')).length, chartReads);
});

test('provider duplicate ID is accepted only with its explicit deduplicated flag', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true }); const canonical = crypto.randomUUID();
  f.owner.reply = () => job(canonical, 'ready', null, true);
  const result = await f.client.newCompleted(f.completion()); assert.equal(result.id, canonical);
  f.owner.reply = () => job(crypto.randomUUID(), 'queued', null, false);
  await rejected(f.client.newCompleted(f.completion()), 'PROTOCOL');
});

test('disable closes pending sockets; stale hello cannot re-enable a new session', async t => {
  const f = await fixture(t); let release;
  f.owner.reply = () => new Promise(resolve => { release = resolve; });
  const opening = f.client.enable({ consent: true });
  await waitFor(() => release);
  f.client.disable(); await rejected(opening, 'CANCELLED');
  assert(f.owner.sockets.every(x => x.destroyed));
  f.owner.reply = () => hello(); await f.client.enable({ consent: true });
  release(hello()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.client.snapshot().phase, 'available');
});

test('disable does not claim remote queued work was cancelled and never replays history', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  const completion = f.completion(); await f.client.newCompleted(completion);
  f.client.disable();
  assert.equal(f.client.snapshot().jobs[0].state, 'queued');
  assert.equal(f.client.snapshot().jobs[0].confirmed, false);
  await f.client.enable({ consent: true });
  assert.equal((await f.client.newCompleted(completion)).confirmed, false);
  assert.equal(f.owner.calls.filter(x => x.command === 'enqueue').length, 1);
});

test('provider lost status never remains marked confirmed', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  const completion = f.completion(); await f.client.newCompleted(completion);
  f.owner.reply = () => Buffer.from('{"schema":1,"ok":false,"code":"UNKNOWN_JOB"}\n');
  await rejected(f.client.refreshStatus(completion.id), 'UNKNOWN_JOB');
  assert.equal(f.client.snapshot().jobs[0].confirmed, false);
});

test('timeout fails closed without retry, scan or process launch', async t => {
  const f = await fixture(t, { timeoutMs: 15 }); f.owner.reply = () => undefined;
  await rejected(f.client.enable({ consent: true }), 'TIMEOUT');
  assert.equal(f.client.snapshot().phase, 'unavailable'); assert.equal(f.owner.calls.length, 1);
  assert(f.owner.sockets.every(x => x.destroyed));
});

test('oversized or malformed provider data closes the pipe and never exposes payload text', async t => {
  const f = await fixture(t);
  f.owner.reply = () => Buffer.from('x'.repeat(MAX_BYTES + 2));
  await rejected(f.client.enable({ consent: true }), 'PROTOCOL');
  assert.equal(f.client.snapshot().fault, 'PROTOCOL');
  assert(f.owner.sockets.every(x => x.destroyed));
});

test('native refusal codes are bounded and provider secrets cannot become messages', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  f.owner.reply = () => Buffer.from(JSON.stringify({ schema: 1, ok: false, code: TOKEN + f.folder }) + '\n');
  await rejected(f.client.newCompleted(f.completion()), 'PROVIDER_REFUSED');
  assert(!JSON.stringify(f.client.snapshot()).includes(TOKEN));
});

test('incoming queue is bounded before hashing many concurrent completions', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  const pending = [];
  f.owner.reply = () => new Promise(() => {});
  // Read leases are registered synchronously even before their descriptor read.
  for (let i = 0; i < 32; i++) pending.push(f.client.newCompleted(f.completion()).catch(error => error.code));
  await rejected(f.client.newCompleted(f.completion()), 'CLIENT_QUEUE_FULL');
  f.client.disable(); const results = await Promise.all(pending);
  assert(results.every(result => result === 'CANCELLED'));
});

test('32 simultaneous completions serialize on the single-instance pipe without dropping the fifth', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  let inFlight = 0, maximum = 0;
  f.owner.reply = async request => {
    inFlight++; maximum = Math.max(maximum, inFlight);
    await new Promise(resolve => setTimeout(resolve, 3)); inFlight--;
    return job(request.id);
  };
  const results = await Promise.all(Array.from({ length: 32 }, () => f.client.newCompleted(f.completion())));
  assert.equal(results.length, 32); assert(results.every(result => result.state === 'queued'));
  assert.equal(maximum, 1); assert.equal(f.owner.calls.filter(x => x.command === 'enqueue').length, 32);
  await rejected(f.client.newCompleted(f.completion()), 'CLIENT_QUEUE_FULL');
});

test('old unconfirmed queues do not block a new provider session or the bounded status list', async t => {
  const f = await fixture(t);
  for (let session = 0; session < 3; session++) {
    f.owner.reply = request => request.command === 'hello' ? hello() : job(request.id);
    await f.client.enable({ consent: true });
    await Promise.all(Array.from({ length: 32 }, () => f.client.newCompleted(f.completion())));
    assert(f.client.snapshot().jobs.length <= 64);
    assert.equal(f.client.snapshot().jobs.filter(x => x.confirmed).length, 32);
    f.client.disable();
  }
  assert.equal(f.owner.calls.filter(x => x.command === 'enqueue').length, 96);
});

test('completion retention never evicts a pending hash while finished rejections are pruned', async t => {
  const f = await fixture(t); let release, blockedOpens = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const io = new Proxy(f.options.fs, { get(target, key) {
    if (key !== 'open') return target[key];
    return async (...args) => {
      if (String(args[0]).endsWith('notes.chart')) { blockedOpens++; await gate; }
      return target.open(...args);
    };
  } });
  const client = createQuickImportClient({ ...f.options, fs: io });
  t.after(() => { release(); client.dispose(); });
  await client.enable({ consent: true });
  const completion = f.completion(), first = client.newCompleted(completion);
  await waitFor(() => blockedOpens === 1);
  for (let i = 0; i < 130; i++) {
    await rejected(client.newCompleted(f.completion({ folder: path.join(f.songsRoot, 'missing') })), 'LOCAL_UNAVAILABLE');
  }
  const repeated = client.newCompleted(completion);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(blockedOpens, 1);
  release(); await Promise.all([first, repeated]);
  assert.equal(f.owner.calls.filter(x => x.command === 'enqueue').length, 1);
});

test('old filesystem status completion cannot invalidate the confirmed state of a newer session', async t => {
  const f = await fixture(t); let hold = false, blocked = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const io = new Proxy(f.options.fs, { get(target, key) {
    if (key !== 'open') return target[key];
    return async (...args) => {
      if (hold && args[0] === f.descriptorPath) { hold = false; blocked = true; await gate; }
      return target.open(...args);
    };
  } });
  const client = createQuickImportClient({ ...f.options, fs: io });
  t.after(() => { release(); client.dispose(); });
  await client.enable({ consent: true }); const completion = f.completion();
  await client.newCompleted(completion);
  hold = true; const oldStatus = client.refreshStatus(completion.id);
  await waitFor(() => blocked); client.disable();
  await client.enable({ consent: true });
  f.owner.reply = request => job(request.id, 'ready');
  await client.refreshStatus(completion.id);
  assert.equal(client.snapshot().jobs[0].confirmed, true);
  release(); await rejected(oldStatus, 'CANCELLED');
  assert.equal(client.snapshot().jobs[0].state, 'ready');
  assert.equal(client.snapshot().jobs[0].confirmed, true);
});

test('deleting a descriptor revokes the connected capability without exposing filesystem text', async t => {
  const f = await fixture(t); await f.client.enable({ consent: true });
  await fs.unlink(f.descriptorPath);
  await rejected(f.client.newCompleted(f.completion()), 'CONNECTION_CHANGED');
  assert.equal(f.client.snapshot().phase, 'unavailable');
});

test('strict JSON rejects duplicate names, invalid UTF8, deep or trailing payloads', () => {
  for (const text of ['{"ok":true,"ok":false}', '{"a":{"x":1,"x":2}}', '{"a":{"b":{"c":{"d":{"e":0}}}}}', '{}{}', '{"a":01}']) {
    assert.throws(() => parseBounded(Buffer.from(text)), error => error.code === 'PROTOCOL');
  }
  assert.throws(() => parseBounded(Buffer.from([0xc3, 0x28])), error => error.code === 'PROTOCOL');
  assert.deepEqual(parseBounded(Buffer.from('{"a":"x\\\"y","b":[1,true,null]}')), { a: 'x"y', b: [1, true, null] });
});

test('Windows network, device and alternate stream paths are refused without I/O', () => {
  for (const root of ['\\\\server\\share', '\\\\?\\C:\\Game', 'C:\\Game:stream', 'C:\\Game.\\other']) {
    assert.throws(() => createQuickImportClient({ gameRoot: root, songsRoot: 'C:\\Songs', expectedBuild: BUILD,
      platform: 'win32', pathApi: path.win32 }), error => error.code === 'INVALID_PATH');
  }
});
