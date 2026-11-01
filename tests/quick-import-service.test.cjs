'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createQuickImportService, validQuickImportCommand } = require('../companion/quick-import-service.cjs');

const BASE = path.join(__dirname, '../outputs/quick-import-service-tests');
const BUILD = '1.1.0.6142-synthetic-validated-build';
const id = value => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('Synthetic condition was not reached'); };
const rejected = (promise, code) => assert.rejects(promise, value => value.code === code && value.message === code);

async function fixture(t, options = {}) {
  await fs.mkdir(BASE, { recursive: true });
  const root = await fs.mkdtemp(path.join(BASE, 'case-'));
  const gameRoot = path.join(root, 'game'), songsRoot = path.join(root, 'Songs'), dataDirectory = path.join(root, 'private');
  await fs.mkdir(gameRoot); await fs.mkdir(songsRoot);
  const executable = path.join(gameRoot, 'Clone Hero.exe');
  await fs.writeFile(executable, 'Synthetic marker only; never an executable.');
  const calls = [], clients = [], changes = [];
  let current = { active: true, root: songsRoot, lifecycle: 1 };
  let selected = executable;
  const defaultFactory = config => {
    const client = {
      config, phase: 'disabled', jobs: [], disposed: false,
      async enable(value) { calls.push(['enable', value]); this.phase = 'available'; },
      disable() { calls.push(['disable']); this.phase = 'disabled'; this.jobs = this.jobs.map(value => ({ ...value, confirmed: false })); },
      dispose() { calls.push(['dispose']); this.disposed = true; },
      snapshot() { return { phase: this.phase, jobs: this.jobs.map(value => ({ ...value })) }; },
      async newCompleted(value) {
        calls.push(['completion', value]);
        const job = { id: value.id, state: 'queued', code: null, confirmed: true, deduplicated: false, waitingForSafeMenu: true };
        this.jobs.push(job); return { ...job };
      },
      async refreshStatus(value) { calls.push(['refresh', value]); }
    };
    clients.push(client); return client;
  };
  const service = createQuickImportService({ dataDirectory, platform: 'win32', expectedBuild: BUILD,
    getContext: () => current, chooseGame: async () => selected,
    clientFactory: defaultFactory, onChange: () => changes.push(service.status()), ...options });
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  async function chart(number, names = ['notes.chart']) {
    const folderName = `chart-${number}`, destination = path.join(songsRoot, folderName);
    await fs.mkdir(destination, { recursive: true });
    for (const name of names) await fs.writeFile(path.join(destination, name), 'Synthetic notes');
    return { id: id(number), state: 'Completed', rootPath: songsRoot, destination, folderName };
  }
  return { service, root, gameRoot, songsRoot, dataDirectory, executable, calls, clients, changes, chart,
    select: value => { selected = value; }, set: value => { current = { ...current, ...value }; },
    async choose() { await service.load(); return service.command('quickImport.chooseGame', {}); },
    async connect() { await this.choose(); return service.command('quickImport.connect', {}); },
    async complete(number, names) {
      const completed = await chart(number, names);
      service.observeDownloads({ items: [{ id: completed.id, state: 'Downloading', rootPath: songsRoot }] });
      service.observeDownloads({ items: [completed] });
      return completed;
    }
  };
}

test('service construction and status do not load preferences, read game or construct client', () => {
  let calls = 0;
  const unused = () => { calls++; throw Error('No construction I/O'); };
  const service = createQuickImportService({ getContext: unused, chooseGame: unused, clientFactory: unused,
    preferences: { load: unused, status: () => ({ canWrite: true }), flush: async () => {} } });
  assert.deepEqual(service.status(), { supported: process.platform === 'win32', selected: false, gameName: null,
    busy: false, connected: false, enabled: false, error: null, jobs: [], savedCanWrite: true });
  assert.equal(calls, 0);
});

test('only the four commands with empty plain payloads are valid', () => {
  for (const name of ['chooseGame', 'connect', 'disable', 'refresh']) assert.equal(validQuickImportCommand(`quickImport.${name}`, {}), true);
  for (const value of [null, undefined, [], { path: 'private' }, { consent: true }, Object.create(null)]) assert.equal(validQuickImportCommand('quickImport.connect', value), false);
  assert.equal(validQuickImportCommand('quickImport.installMod', {}), false);
});

test('load reads private choice only and never auto-connects after restarting', async t => {
  const f = await fixture(t); await f.choose();
  const before = await fs.readFile(path.join(f.dataDirectory, 'quick-import-settings.json'), 'utf8');
  assert.deepEqual(JSON.parse(before), { version: 1, gameRoot: f.gameRoot });
  let factories = 0;
  const second = createQuickImportService({ dataDirectory: f.dataDirectory, platform: 'win32', clientFactory: () => { factories++; throw Error(); } });
  await second.load();
  assert.equal(second.status().selected, true); assert.equal(second.status().enabled, false); assert.equal(second.status().connected, false);
  assert.equal(factories, 0); await second.dispose();
});

test('expectedBuild null refuses connect before constructing a client', async t => {
  const f = await fixture(t, { expectedBuild: null }); await f.choose();
  await rejected(f.service.command('quickImport.connect', {}), 'QUICK_IMPORT_NOT_VALIDATED');
  assert.equal(f.clients.length, 0); assert.equal(f.service.status().enabled, false);
  assert.equal(f.service.status().error, 'QUICK_IMPORT_NOT_VALIDATED');
});

test('picker cancel preserves the selected path and does not write preferences again', async t => {
  const f = await fixture(t); await f.choose();
  const file = path.join(f.dataDirectory, 'quick-import-settings.json'), before = await fs.readFile(file);
  f.select(null); await f.service.command('quickImport.chooseGame', {});
  assert.equal(f.service.status().selected, true); assert.deepEqual(await fs.readFile(file), before); assert.equal(f.clients.length, 0);
});

test('picker result must be the real local unlinked Clone Hero.exe, not renderer input', async t => {
  const f = await fixture(t); const other = path.join(f.gameRoot, 'Other.exe'); await fs.writeFile(other, 'Not executable'); f.select(other);
  await rejected(f.choose(), 'QUICK_IMPORT_GAME_INVALID'); assert.equal(f.service.status().selected, false);
  await rejected(f.service.command('quickImport.chooseGame', { path: f.executable }), 'QUICK_IMPORT_COMMAND');
  f.select('\\\\server\\Clone Hero.exe'); await rejected(f.service.command('quickImport.chooseGame', {}), 'QUICK_IMPORT_GAME_INVALID');
});

test('symlink or junction in selected game ancestry is refused', async t => {
  const f = await fixture(t), linked = path.join(f.root, 'linked');
  try { await fs.symlink(f.gameRoot, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (problem) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(problem.code)) return t.skip('Host does not permit link fixtures'); throw problem; }
  f.select(path.join(linked, 'Clone Hero.exe')); await rejected(f.choose(), 'QUICK_IMPORT_GAME_INVALID'); assert.equal(f.clients.length, 0);
});

test('unsupported platforms and inactive Companion refuse connection or picker', async t => {
  const f = await fixture(t, { platform: 'linux' }); await rejected(f.choose(), 'QUICK_IMPORT_WINDOWS_REQUIRED'); assert.equal(f.clients.length, 0);
  const active = await fixture(t); active.set({ active: false }); await rejected(active.choose(), 'QUICK_IMPORT_UNAVAILABLE');
});

test('connection requires chosen Songs and a chosen game', async t => {
  const f = await fixture(t); await f.service.load();
  await rejected(f.service.command('quickImport.connect', {}), 'QUICK_IMPORT_GAME_REQUIRED');
  await f.choose(); f.set({ root: null });
  await rejected(f.service.command('quickImport.connect', {}), 'QUICK_IMPORT_SONGS_REQUIRED'); assert.equal(f.clients.length, 0);
});

test('explicit connect passes trusted paths and consent to a single client', async t => {
  const f = await fixture(t); await f.connect();
  assert.equal(f.clients.length, 1); assert.deepEqual(f.clients[0].config, { gameRoot: f.gameRoot, songsRoot: f.songsRoot, expectedBuild: BUILD, platform: 'win32' });
  assert.deepEqual(f.calls[0], ['enable', { consent: true }]);
  assert.equal(f.service.status().enabled, true); assert.equal(f.service.status().connected, true);
});

test('historic and unknown completed downloads remain ignored by the connected service', async t => {
  const f = await fixture(t), history = await f.chart(1), unknown = await f.chart(2);
  f.service.observeDownloads({ items: [history] }); await f.connect(); f.service.observeDownloads({ items: [history, unknown] }); await tick();
  assert.equal(f.calls.filter(value => value[0] === 'completion').length, 0);
});

test('trusted Web completion and Companion snapshots retain independent histories', async t => {
  const f = await fixture(t); await f.connect(); const web = await f.chart(1);
  f.service.observeCompletedDownload({ id: web.id, destination: web.destination });
  await f.complete(2);
  // Companion snapshots do not contain the Web UUID and must not erase its ledger.
  f.service.observeCompletedDownload({ id: web.id, destination: web.destination });
  await waitFor(() => f.calls.filter(value => value[0] === 'completion').length === 2);
  assert.deepEqual(f.calls.filter(value => value[0] === 'completion').map(value => value[1].id).sort(), [id(1), id(2)]);
  assert.equal(f.service.status().jobs.length, 2);
});

test('Web and Companion delivery share one physical client/hash lane', async t => {
  const f = await fixture(t); await f.connect();
  const gate = deferred(), first = f.clients[0].newCompleted.bind(f.clients[0]);
  let active = 0, maximum = 0, entered = 0;
  f.clients[0].newCompleted = async value => {
    active++; maximum = Math.max(maximum, active);
    if (++entered === 1) await gate.promise;
    try { return await first(value); } finally { active--; }
  };
  const web = await f.chart(1); f.service.observeCompletedDownload({ id: web.id, destination: web.destination });
  await f.complete(2); await waitFor(() => entered === 1); await tick();
  assert.equal(entered, 1); gate.resolve(); await waitFor(() => entered === 2);
  assert.equal(maximum, 1);
});

test('Web completion is main-only, bounded, and never reads its payload while disabled', async t => {
  const f = await fixture(t); let reads = 0;
  const value = { get id() { reads++; throw Error('No disabled payload reads'); },
    get destination() { reads++; throw Error('No disabled payload reads'); } };
  f.service.observeCompletedDownload(value); assert.equal(reads, 0); assert.equal(f.clients.length, 0);
  assert.equal(validQuickImportCommand('quickImport.observeCompletedDownload', {}), false);
  await f.connect(); f.set({ active: false }); f.service.observeCompletedDownload(value);
  assert.equal(reads, 0); assert.equal(f.service.status().enabled, false);
});

test('Web completion rejects foreign destinations and extra fields without touching the download', async t => {
  const f = await fixture(t); await f.connect(); const web = await f.chart(1);
  for (const value of [{ id: web.id, destination: f.gameRoot },
    { id: web.id, destination: web.destination, token: 'PRIVATE' },
    { id: 'not-a-uuid', destination: web.destination }]) {
    assert.doesNotThrow(() => f.service.observeCompletedDownload(value));
    assert.equal(f.service.status().error, 'INVALID_COMPLETION');
  }
  await tick(); assert.equal(f.calls.filter(value => value[0] === 'completion').length, 0);
  assert.equal(web.state, 'Completed'); assert.equal((await fs.stat(web.destination)).isDirectory(), true);
});

test('Web duplicate UUID is not replayed after both stream snapshots and later notifications', async t => {
  const f = await fixture(t); await f.connect(); const web = await f.chart(1);
  for (let i = 0; i < 3; i++) f.service.observeCompletedDownload({ id: web.id, destination: web.destination });
  await waitFor(() => f.calls.some(value => value[0] === 'completion'));
  f.service.observeDownloads({ items: [] });
  f.service.observeCompletedDownload({ id: web.id, destination: web.destination }); await tick();
  assert.equal(f.calls.filter(value => value[0] === 'completion').length, 1);
});

test('Web late result after Songs lease change remains unconfirmed and cannot revive the connection', async t => {
  const f = await fixture(t); await f.connect(); const gate = deferred(); let entered = false;
  f.clients[0].newCompleted = async () => { entered = true; await gate.promise; return { state: 'ready', confirmed: true }; };
  const web = await f.chart(1); f.service.observeCompletedDownload({ id: web.id, destination: web.destination });
  await waitFor(() => entered); f.set({ lifecycle: 2 }); f.service.update();
  const prior = f.service.status().jobs.find(value => value.id === web.id);
  assert.equal(prior.state, 'unconfirmed'); assert.equal(prior.mayHaveReachedMod, true); assert.equal(prior.confirmed, false);
  gate.resolve(); await tick();
  assert.deepEqual(f.service.status().jobs.find(value => value.id === web.id), prior);
  assert.equal(f.service.status().enabled, false); assert.equal(f.service.status().connected, false);
});

for (const chartFile of ['notes.chart', 'notes.mid']) test(`new completed download resolves only its fixed ${chartFile} and sends once`, async t => {
  const f = await fixture(t); await f.connect(); const completed = await f.complete(1, [chartFile]);
  await waitFor(() => f.calls.some(value => value[0] === 'completion'));
  assert.deepEqual(f.calls.find(value => value[0] === 'completion')[1], { id: completed.id, folder: completed.destination, chartFile });
  f.service.observeDownloads({ items: [completed] }); await tick();
  assert.equal(f.calls.filter(value => value[0] === 'completion').length, 1);
  const job = f.service.status().jobs[0]; assert.equal(job.state, 'queued'); assert.equal(job.waitingForSafeMenu, true);
});

for (const names of [[], ['notes.chart', 'notes.mid']]) test(`new folder with ${names.length} candidate charts is refused without fallback or download failure`, async t => {
  const f = await fixture(t); await f.connect(); const completed = await f.complete(1, names);
  await waitFor(() => f.service.status().jobs.some(value => value.state === 'failed'));
  assert.equal(f.calls.filter(value => value[0] === 'completion').length, 0);
  assert.equal(completed.state, 'Completed'); assert.equal(await fs.stat(completed.destination).then(value => value.isDirectory()), true);
});

test('linked completed folder is refused before the client hashes or sends', async t => {
  const f = await fixture(t); await f.connect();
  const actual = await f.chart(1), linked = path.join(f.songsRoot, 'linked-chart');
  try { await fs.symlink(actual.destination, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (problem) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(problem.code)) return t.skip('Host does not permit link fixtures'); throw problem; }
  f.service.observeDownloads({ items: [{ id: id(2), state: 'Downloading', rootPath: f.songsRoot }] });
  f.service.observeDownloads({ items: [{ id: id(2), state: 'Completed', rootPath: f.songsRoot, destination: linked, folderName: 'linked-chart' }] });
  await waitFor(() => f.service.status().jobs.some(value => value.state === 'failed'));
  assert.equal(f.calls.filter(value => value[0] === 'completion').length, 0);
});

test('disable revokes client before dropping the observer and retains honest remote jobs', async t => {
  const f = await fixture(t); await f.connect(); await f.complete(1);
  await waitFor(() => f.service.status().jobs.some(value => value.state === 'queued'));
  await f.service.command('quickImport.disable', {});
  assert.equal(f.calls.at(-2)[0], 'disable'); assert.equal(f.calls.at(-1)[0], 'dispose');
  const state = f.service.status();
  assert.equal(state.enabled, false); assert.equal(state.connected, false);
  assert.equal(state.jobs[0].state, 'queued'); assert.equal(state.jobs[0].confirmed, false); assert.equal(state.jobs[0].mayHaveReachedMod, true);
});

test('Songs root and lifecycle changes disconnect; later notifications do not replay', async t => {
  const f = await fixture(t); await f.connect();
  f.set({ lifecycle: 2 }); f.service.update(); assert.equal(f.service.status().enabled, false);
  const completed = await f.chart(1); f.service.observeDownloads({ items: [completed] });
  await f.service.command('quickImport.connect', {}); f.service.observeDownloads({ items: [completed] }); await tick();
  assert.equal(f.calls.filter(value => value[0] === 'completion').length, 0);
  const otherRoot = path.join(f.root, 'OtherSongs'); await fs.mkdir(otherRoot); f.set({ root: otherRoot }); f.service.update();
  assert.equal(f.service.status().enabled, false); assert.equal(f.clients.at(-1).disposed, true);
});

test('refresh is explicit and uses known job IDs only', async t => {
  const f = await fixture(t); await f.connect(); await f.complete(1);
  await waitFor(() => f.service.status().jobs.some(value => value.state === 'queued'));
  assert.equal(f.calls.filter(value => value[0] === 'refresh').length, 0);
  await rejected(f.service.command('quickImport.refresh', { id: id(99) }), 'QUICK_IMPORT_COMMAND');
  await f.service.command('quickImport.refresh', {});
  assert.deepEqual(f.calls.filter(value => value[0] === 'refresh'), [['refresh', id(1)]]);
});

test('disable during picker fences its late result and prevents saving or constructing a client', async t => {
  const picker = deferred(); const f = await fixture(t, { chooseGame: () => picker.promise });
  await f.service.load(); const picking = f.service.command('quickImport.chooseGame', {});
  await waitFor(() => f.service.status().busy); await f.service.command('quickImport.disable', {});
  picker.resolve(f.executable); await rejected(picking, 'QUICK_IMPORT_CANCELLED');
  assert.equal(f.service.status().selected, false); assert.equal(f.service.status().error, null); assert.equal(f.clients.length, 0);
  await assert.rejects(fs.stat(path.join(f.dataDirectory, 'quick-import-settings.json')), value => value.code === 'ENOENT');
});

test('synchronous progress cancellation prevents opening the picker', async t => {
  let f, pickers = 0;
  f = await fixture(t, { chooseGame: async () => { pickers++; return f.executable; },
    onChange: () => { if (f?.service.status().busy) f.service.stop(); } });
  await rejected(f.choose(), 'QUICK_IMPORT_CANCELLED'); assert.equal(pickers, 0); assert.equal(f.clients.length, 0);
});

test('synchronous progress cancellation prevents constructing a connecting client', async t => {
  let f, cancel = false;
  f = await fixture(t, { onChange: () => { if (cancel && f?.service.status().busy) f.service.stop(); } });
  await f.choose(); cancel = true;
  await rejected(f.service.command('quickImport.connect', {}), 'QUICK_IMPORT_CANCELLED');
  assert.equal(f.clients.length, 0); assert.equal(f.service.status().enabled, false);
});

for (const delayed of [false, true]) test(`stop fences a command awaiting ${delayed ? 'pending' : 'already resolved'} private load`, async () => {
  const gate = deferred(); let pickers = 0;
  const saved = { version: 1, gameRoot: null, canWrite: true };
  const service = createQuickImportService({ platform: 'win32',
    getContext: () => ({ active: true, root: null, lifecycle: 1 }),
    chooseGame: async () => { pickers++; return null; },
    preferences: { load: () => delayed ? gate.promise : Promise.resolve(saved), status: () => saved, flush: async () => {} }
  });
  if (!delayed) await service.load();
  const picking = service.command('quickImport.chooseGame', {}); service.stop();
  gate.resolve(saved); await rejected(picking, 'QUICK_IMPORT_CANCELLED');
  assert.equal(pickers, 0); assert.equal(service.status().enabled, false); await service.dispose();
});

test('late successful handshake after disable never enables or sends and cannot replace the new error', async t => {
  const gate = deferred(); let client;
  const f = await fixture(t, { clientFactory: () => (client = { phase: 'disabled',
    enable: async () => { await gate.promise; client.phase = 'available'; },
    disable: () => { client.phase = 'disabled'; }, dispose: () => {}, snapshot: () => ({ phase: client.phase, jobs: [] }),
    newCompleted: () => assert.fail('No late sends'), refreshStatus: () => assert.fail() }) });
  await f.choose(); const connecting = f.service.command('quickImport.connect', {});
  await waitFor(() => client !== undefined); await f.service.command('quickImport.disable', {});
  gate.resolve(); await rejected(connecting, 'QUICK_IMPORT_CANCELLED');
  assert.equal(f.service.status().enabled, false); assert.equal(f.service.status().connected, false); assert.equal(f.service.status().error, null);
});

test('late rejected handshake cannot overwrite disable or a newer command error', async t => {
  for (const newerError of [false, true]) {
    const gate = deferred(); let client;
    const f = await fixture(t, { clientFactory: () => (client = { phase: 'disabled',
      enable: () => gate.promise, disable: () => { client.phase = 'disabled'; }, dispose: () => {},
      snapshot: () => ({ phase: client.phase, jobs: [] }), newCompleted: () => assert.fail(), refreshStatus: () => assert.fail() }) });
    await f.choose(); const connecting = f.service.command('quickImport.connect', {});
    await waitFor(() => client !== undefined); await f.service.command('quickImport.disable', {});
    if (newerError) await rejected(f.service.command('quickImport.refresh', {}), 'NOT_ENABLED');
    gate.reject(Object.assign(Error('CONNECTION_UNAVAILABLE'), { code: 'CONNECTION_UNAVAILABLE' }));
    await rejected(connecting, 'CONNECTION_UNAVAILABLE');
    assert.equal(f.service.status().error, newerError ? 'NOT_ENABLED' : null);
    assert.equal(f.service.status().enabled, false);
  }
});

test('late rejected known-job refresh cannot restore an error after disable', async t => {
  const gate = deferred(), f = await fixture(t); await f.connect(); await f.complete(1);
  await waitFor(() => f.service.status().jobs.some(value => value.state === 'queued'));
  f.clients[0].refreshStatus = () => gate.promise;
  const refreshing = f.service.command('quickImport.refresh', {});
  await waitFor(() => f.service.status().busy); await f.service.command('quickImport.disable', {});
  gate.reject(Object.assign(Error('CONNECTION_UNAVAILABLE'), { code: 'CONNECTION_UNAVAILABLE' }));
  await rejected(refreshing, 'CONNECTION_UNAVAILABLE');
  assert.equal(f.service.status().error, null); assert.equal(f.service.status().connected, false);
});

test('provider and notification errors never leak private data', async t => {
  const f = await fixture(t, { onChange: () => { throw Error('PRIVATE'); }, clientFactory: () => ({
    enable: async () => { throw Object.assign(Error('C:\\Private\\token=SECRET'), { code: 'SECRET' }); },
    disable: () => {}, dispose: () => {}, snapshot: () => ({ phase: 'disabled', jobs: [] }),
    newCompleted: () => assert.fail(), refreshStatus: () => assert.fail()
  }) });
  await f.choose(); await rejected(f.service.command('quickImport.connect', {}), 'QUICK_IMPORT_FAILED');
  const json = JSON.stringify(f.service.status()); assert.equal(json.includes('PRIVATE'), false); assert.equal(json.includes('SECRET'), false);
  for (const key of ['gameRoot', 'songsRoot', 'path', 'token', 'pipeName']) assert.equal(json.includes(key), false);
});

test('malformed and future preference files are preserved and block overwriting', async t => {
  for (const bytes of ['{broken', JSON.stringify({ version: 9, gameRoot: null }), JSON.stringify({ version: 1, gameRoot: null, enabled: true })]) {
    const f = await fixture(t); await fs.mkdir(f.dataDirectory);
    const file = path.join(f.dataDirectory, 'quick-import-settings.json'); await fs.writeFile(file, bytes);
    await f.service.load(); assert.equal(f.service.status().savedCanWrite, false);
    await rejected(f.service.command('quickImport.chooseGame', {}), 'QUICK_IMPORT_PREFERENCES');
    assert.equal(await fs.readFile(file, 'utf8'), bytes); assert.equal(f.clients.length, 0);
  }
});

test('external preference changes are preserved instead of overwritten by a second choice', async t => {
  const f = await fixture(t); await f.choose();
  const file = path.join(f.dataDirectory, 'quick-import-settings.json'), foreign = JSON.stringify({ version: 1, gameRoot: f.songsRoot });
  await fs.writeFile(file, foreign);
  await rejected(f.service.command('quickImport.chooseGame', {}), 'QUICK_IMPORT_PREFERENCES');
  assert.equal(await fs.readFile(file, 'utf8'), foreign); assert.equal(f.service.status().savedCanWrite, false);
});

test('an existing empty private directory replaced after load is protected before first save', async t => {
  const f = await fixture(t); await fs.mkdir(f.dataDirectory); await f.service.load();
  const held = path.join(f.root, 'previous-private');
  await fs.rename(f.dataDirectory, held); await fs.mkdir(f.dataDirectory);
  await rejected(f.service.command('quickImport.chooseGame', {}), 'QUICK_IMPORT_PREFERENCES');
  assert.deepEqual(await fs.readdir(f.dataDirectory), []);
  assert.deepEqual(await fs.readdir(held), []);
});

test('private preference hardlinks are refused and the original remains intact', async t => {
  const f = await fixture(t); await fs.mkdir(f.dataDirectory);
  const original = path.join(f.root, 'foreign.json'), bytes = JSON.stringify({ version: 1, gameRoot: f.gameRoot });
  await fs.writeFile(original, bytes); await fs.link(original, path.join(f.dataDirectory, 'quick-import-settings.json'));
  await f.service.load(); assert.equal(f.service.status().savedCanWrite, false);
  await rejected(f.service.command('quickImport.chooseGame', {}), 'QUICK_IMPORT_PREFERENCES');
  assert.equal(await fs.readFile(original, 'utf8'), bytes);
});

test('private directory junctions are refused without creating a settings file in the target', async t => {
  const f = await fixture(t), target = path.join(f.root, 'foreign-directory'); await fs.mkdir(target);
  try { await fs.symlink(target, f.dataDirectory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (problem) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(problem.code)) return t.skip('Host does not permit link fixtures'); throw problem; }
  await f.service.load(); assert.equal(f.service.status().savedCanWrite, false);
  await rejected(f.service.command('quickImport.chooseGame', {}), 'QUICK_IMPORT_PREFERENCES');
  assert.deepEqual(await fs.readdir(target), []);
});

test('dispose during picker prevents game choice and subsequent load or connect', async t => {
  const picker = deferred(), f = await fixture(t, { chooseGame: () => picker.promise });
  const choosing = f.choose(); await waitFor(() => f.service.status().busy); await f.service.dispose();
  picker.resolve(f.executable); await rejected(choosing, 'QUICK_IMPORT_CANCELLED');
  await rejected(f.service.command('quickImport.connect', {}), 'QUICK_IMPORT_UNAVAILABLE');
  assert.equal(f.clients.length, 0); assert.equal(f.service.status().selected, false);
});
