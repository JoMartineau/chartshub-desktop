const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Module, createRequire } = require('node:module');
const { createCloneHeroSource } = require('../companion/clonehero-source.cjs');
const SETTINGS = '[streamer]\nsong_export = 1\ncustom_song_export = %s%n%a%n%c\n';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate, timeout = 4000) { const start = Date.now(); while (!await predicate()) { if (Date.now() - start > timeout) throw Error('Clone Hero source condition timed out'); await delay(5); } }
function createMock() {
  const listeners = new Set(); let connected = false, state = 'menu';
  const song = { title: 'Everlong', artist: 'Foo Fighters', charter: 'ExampleCharter', instrument: 'Guitar', difficulty: 'Expert' };
  const mock = {
    connects: 0, disconnects: 0, listeners,
    async connect() { connected = true; mock.connects++; },
    async disconnect() { connected = false; mock.disconnects++; },
    async getCurrentSong() { return { ...song }; },
    async getGameplayState() { return { state: connected ? state : 'idle', isChartActive: connected && ['playing', 'paused'].includes(state) }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    transition(value) { state = value; if (connected) for (const listener of listeners) { listener({ type: 'gameplay', gameplay: { state, isChartActive: ['playing', 'paused'].includes(state) } }); listener({ type: 'song', song: { ...song } }); } },
    step() { mock.transition(state === 'menu' ? 'loading' : 'playing'); },
    reset() { mock.transition('menu'); }
  };
  return mock;
}
async function injected(overrides) {
  const filename = require.resolve('../companion/clonehero-source.cjs'), local = new Module(filename, module), normal = createRequire(filename);
  local.filename = filename; local.paths = Module._nodeModulePaths(path.dirname(filename)); local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(filename, 'utf8'), filename); return local.exports.createCloneHeroSource;
}
async function fixture(t, factory = createCloneHeroSource) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-clonehero-')), game = path.join(base, 'game'), data = path.join(base, 'profile');
  await fs.mkdir(game); await fs.mkdir(data); const sources = [];
  const f = { base, game, data, file: path.join(game, 'currentsong.txt'), settings: path.join(game, 'settings.ini'), config: path.join(data, 'clonehero.json'), mock: createMock(), sources };
  f.files = async (value = '', settings = SETTINGS) => { await fs.writeFile(f.file, value); if (settings !== null) await fs.writeFile(f.settings, settings); };
  f.create = async (options = {}) => { const source = await factory({ mock: f.mock, dataDirectory: data, candidates: [f.file], pollIntervalMs: 15, ...options }); sources.push(source); return source; };
  t.after(async () => { for (const source of sources) await source.disconnect(); if (path.dirname(base) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('chartshub-clonehero-')) throw Error('Unexpected fixture directory'); await fs.rm(base, { recursive: true, force: true }); });
  return f;
}

test('changing the exported song or leaving it aborts obsolete local metadata lookups', async t => {
  const f = await fixture(t); await f.files('');
  const pending = [];
  const source = await f.create({ resolveCharter: (_song, _file, { signal }) => new Promise(resolve => pending.push({ signal, resolve })) });
  await source.connect();
  await fs.writeFile(f.file, 'First\nArtist\nCreator');
  await until(() => pending.length === 1);
  assert.equal(pending[0].signal.aborted, false);
  await fs.writeFile(f.file, 'Second\nArtist\nCreator');
  await until(() => pending.length === 2);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].signal.aborted, false);
  pending[0].resolve([{ text: 'Creator', color: '#ff0000' }]);
  await fs.writeFile(f.file, '');
  await until(() => pending[1].signal.aborted);
  pending[1].resolve([{ text: 'Creator', color: '#00ff00' }]);
  await delay(40);
  assert.equal(await source.getCurrentSong(), null);
  assert.equal((await source.getGameplayState()).isChartActive, false);
});

test('missing export defaults to mock and delegates synchronous controls with idempotent lifecycle', async t => {
  const f = await fixture(t), source = await f.create(); assert.equal(source.status().mode, 'mock'); assert.equal(source.status().status, 'mock');
  assert.equal(await source.getCurrentSong(), null); await Promise.all([source.connect(), source.connect()]); assert.equal(f.mock.connects, 1); assert.equal(f.mock.listeners.size, 1);
  const events = []; const unsubscribe = source.subscribe(event => events.push(event));
  source.transition('playing'); assert.equal(events[0].gameplay.state, 'playing'); assert.equal((await source.getGameplayState()).state, 'playing'); assert.equal((await source.getCurrentSong()).instrument, 'Guitar');
  source.reset(); assert.equal((await source.getGameplayState()).state, 'menu'); source.step(); assert.equal((await source.getGameplayState()).state, 'loading');
  unsubscribe(); const count = events.length; source.step(); assert.equal(events.length, count);
  await Promise.all([source.disconnect(), source.disconnect()]); assert.equal(f.mock.disconnects, 1); assert.equal(f.mock.listeners.size, 0); assert.equal((await source.getGameplayState()).state, 'idle');
  await source.connect(); assert.equal(f.mock.connects, 2); await assert.rejects(fs.stat(f.config), { code: 'ENOENT' });
});

test('existing nonempty native exports remain hidden until a fresh write and two stable observations', async t => {
  const f = await fixture(t); await f.files('Old title\nOld artist\nOld charter'); const source = await f.create();
  assert.equal(source.status().mode, 'live'); await source.connect(); await delay(90); assert.equal(await source.getCurrentSong(), null); assert.equal(source.status().status, 'waiting');
  const events = []; source.subscribe(event => events.push(event)); await fs.writeFile(f.file, 'Fresh title\nNew artist\nNew charter');
  await until(() => source.status().message.includes('stabilité')); assert.equal(await source.getCurrentSong(), null);
  await until(() => source.status().status === 'active'); assert.deepEqual(await source.getCurrentSong(), { title: 'Fresh title', artist: 'New artist', charter: 'New charter' });
  assert.deepEqual(await source.getGameplayState(), { state: 'playing', isChartActive: true });
  assert.deepEqual(source.status().capabilities, { title: true, artist: true, charter: true, instrument: false, difficulty: false, exactGameplay: false });
  assert.match(source.status().message, /pause restent inconnus/); assert.ok(events.some(event => event.type === 'gameplay' && event.gameplay.state === 'playing'));
  const count = events.length; await delay(150); assert.equal(events.length, count, 'unchanged export emits no duplicate events or song timeout');
  assert.throws(() => source.step(), { code: 'CLONEHERO_SAFE' }); assert.throws(() => source.transition('paused'), { code: 'CLONEHERO_SAFE' });
});

test('UTF8 BOM/CRLF and whitespace are normalized; unavailable instrument/difficulty are omitted', async t => {
  const f = await fixture(t); await f.files(''); const source = await f.create(); await source.connect();
  await fs.writeFile(f.file, '\uFEFF  <color=#ff0000>Été</color>   Live \r\n Foo\t Fighters \r\n Example   Charter \r\n');
  await until(() => source.status().status === 'active'); assert.deepEqual(await source.getCurrentSong(), { title: 'Été Live', artist: 'Foo Fighters', charter: 'Example Charter' });
  const copy = await source.getCurrentSong(); copy.title = 'external mutation'; assert.equal((await source.getCurrentSong()).title, 'Été Live');
  await fs.writeFile(f.file, 'Title only\n\n'); await until(async () => (await source.getCurrentSong())?.title === 'Title only'); assert.deepEqual(await source.getCurrentSong(), { title: 'Title only' });
});

test('partial writes never publish incomplete metadata, and empty/missing exports clear immediately at observation', async t => {
  const f = await fixture(t); await f.files(''); const source = await f.create(); await source.connect();
  await fs.writeFile(f.file, 'Partial title\nArtist'); await delay(65); assert.equal(await source.getCurrentSong(), null); assert.equal((await source.getGameplayState()).state, 'idle');
  await fs.appendFile(f.file, '\nCharter'); await until(() => source.status().status === 'active');
  await fs.writeFile(f.file, ''); await until(() => source.status().status === 'waiting' && source.status().message.includes('Aucun titre')); assert.equal(await source.getCurrentSong(), null); assert.equal((await source.getGameplayState()).state, 'idle');
  await fs.writeFile(f.file, 'Again\nArtist\nCharter'); await until(() => source.status().status === 'active'); await fs.unlink(f.file);
  await until(() => source.status().status === 'missing'); assert.equal(await source.getCurrentSong(), null); assert.equal((await source.getGameplayState()).isChartActive, false);
});

test('reconnecting never reuses a retained active title, including rewrites with identical song text', async t => {
  const f = await fixture(t); await f.files(''); const source = await f.create(); await source.connect(); await fs.writeFile(f.file, 'Song\nArtist\nCharter'); await until(() => source.status().status === 'active');
  await source.disconnect(); await source.connect(); await delay(75); assert.equal(await source.getCurrentSong(), null);
  await fs.writeFile(f.file, 'Song\nArtist\nCharter'); await until(() => source.status().status === 'active'); assert.equal((await source.getCurrentSong()).title, 'Song');
});

test('disabled or custom settings clear metadata and need a new export after configuration is repaired', async t => {
  const f = await fixture(t); await f.files(''); const source = await f.create(); await source.connect(); await fs.writeFile(f.file, 'Song\nArtist\nCharter'); await until(() => source.status().status === 'active');
  await fs.writeFile(f.settings, SETTINGS.replace('song_export = 1', 'song_export = 0')); await until(() => source.status().status === 'disabled'); assert.equal(await source.getCurrentSong(), null);
  await fs.writeFile(f.settings, SETTINGS.replace('%s%n%a%n%c', '%a%n%s%n%c')); await until(() => source.status().status === 'unsupported'); assert.equal(await source.getCurrentSong(), null);
  await fs.writeFile(f.settings, SETTINGS); await delay(65); assert.equal(await source.getCurrentSong(), null);
  await fs.writeFile(f.file, 'Correct title\nCorrect artist\nCorrect charter'); await until(() => source.status().status === 'active');
  await fs.writeFile(f.settings, '[streamer]\ncustom_song_export=%s%n%a%n%c\n'); await until(() => source.status().status === 'unsupported');
  await fs.writeFile(f.settings, SETTINGS + 'custom_song_export=%s%n%a%n%c\n'); await until(() => source.status().message.includes('ambigus')); assert.equal(await source.getCurrentSong(), null);
});

test('absent settings allow the native three-line shape, while malformed, oversized and binary exports stay hidden', async t => {
  const f = await fixture(t); await f.files('', null); const source = await f.create(); await source.connect();
  await fs.writeFile(f.file, 'Title\nArtist\nCharter\nExtra'); await until(() => source.status().status === 'unsupported'); assert.equal(await source.getCurrentSong(), null);
  await fs.writeFile(f.file, Buffer.alloc(65537, 65)); await until(() => source.status().status === 'error'); assert.equal(await source.getCurrentSong(), null);
  // Recover first so the next error must come from the binary export itself,
  // then wait for the actual observation rather than a fixed timer under load.
  await fs.writeFile(f.file, 'Recovered\nArtist\nCharter'); await until(() => source.status().status === 'active');
  await fs.writeFile(f.file, Buffer.from([0xff, 0xfe, 0x41, 0x00])); await until(() => source.status().status === 'error'); assert.equal(await source.getCurrentSong(), null);
  await fs.writeFile(f.file, 'Valid\nArtist\nCharter'); await until(() => source.status().status === 'active'); assert.equal((await source.getCurrentSong()).title, 'Valid');
});

test('explicit live/mock switching updates subscribers immediately and persists only source configuration', async t => {
  const f = await fixture(t); const source = await f.create(); await source.connect(); source.transition('playing'); assert.equal((await source.getCurrentSong()).title, 'Everlong');
  await f.files('Old export\nArtist\nCharter'); const unchanged = await fs.readFile(f.file, 'utf8'), before = await fs.stat(f.file); const events = []; source.subscribe(event => events.push(event));
  await source.selectFile(f.file); assert.equal(source.status().mode, 'live'); assert.equal(await source.getCurrentSong(), null); assert.equal((await source.getGameplayState()).state, 'idle'); assert.ok(events.some(event => event.type === 'song' && event.song === null)); assert.equal(f.mock.listeners.size, 0);
  await source.setMode('live'); await delay(45); assert.equal(await source.getCurrentSong(), null);
  await source.setMode('mock'); source.transition('playing'); assert.equal((await source.getCurrentSong()).title, 'Everlong'); assert.equal(f.mock.listeners.size, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.config, 'utf8')), { version: 1, mode: 'mock', filePath: f.file });
  assert.equal(await fs.readFile(f.file, 'utf8'), unchanged); assert.equal((await fs.stat(f.file)).mtimeMs, before.mtimeMs); assert.equal(await fs.readFile(f.settings, 'utf8'), SETTINGS);
  const restored = await f.create({ mock: createMock() }); assert.equal(restored.status().mode, 'mock'); assert.equal(restored.status().filePath, f.file);
  assert.deepEqual((await fs.readdir(f.data)).sort(), ['clonehero.json', 'clonehero.json.bak']);
});

test('candidate detection skips unusable exports and can adopt a file created after startup', async t => {
  const f = await fixture(t); const bad = path.join(f.base, 'custom'); await fs.mkdir(bad); const badFile = path.join(bad, 'currentsong.txt'); await fs.writeFile(badFile, 'Artist\nTitle\nCharter'); await fs.writeFile(path.join(bad, 'settings.ini'), SETTINGS.replace('%s%n%a%n%c', '%a%n%s%n%c'));
  const source = await f.create({ candidates: [badFile, f.file] }); assert.equal(source.status().mode, 'mock'); await source.connect(); await f.files('Initial\nArtist\nCharter');
  await source.detect(); assert.equal(source.status().mode, 'live'); assert.equal(source.status().filePath, f.file); await delay(50); assert.equal(await source.getCurrentSong(), null);
  await fs.writeFile(f.file, 'New\nArtist\nCharter'); await until(() => source.status().status === 'active');
});

test('reads are serialized and an old pending observation cannot republish after switching to mock', async t => {
  let hold = false, entered, gate, reading = 0, maximum = 0;
  const factory = await injected({ 'node:fs/promises': { ...fs, open: async (...args) => {
    const handle = await fs.open(...args); if (!String(args[0]).endsWith('currentsong.txt')) return handle;
    reading++; maximum = Math.max(maximum, reading); const originalRead = handle.read.bind(handle), originalClose = handle.close.bind(handle);
    handle.read = async (...values) => { if (hold) { hold = false; entered.resolve(); await gate.promise; } return originalRead(...values); };
    handle.close = async () => { reading--; return originalClose(); }; return handle;
  } } });
  const f = await fixture(t, factory); await f.files(''); const source = await f.create(); await source.connect(); entered = deferred(); gate = deferred(); hold = true;
  await entered.promise; await fs.writeFile(f.file, 'Late export\nArtist\nCharter'); await source.setMode('mock'); source.transition('playing'); gate.resolve(); await delay(65);
  assert.equal(maximum, 1); assert.equal(source.status().mode, 'mock'); assert.equal((await source.getCurrentSong()).title, 'Everlong'); assert.equal((await source.getGameplayState()).state, 'playing');
});

test('disconnect fences pending reads and a file selection still being saved cannot reconnect afterward', async t => {
  let hold = false; const entered = deferred(), gate = deferred();
  const factory = await injected({ 'node:fs/promises': { ...fs, rename: async (...args) => { if (hold) { entered.resolve(); await gate.promise; } return fs.rename(...args); } } });
  const f = await fixture(t, factory), source = await f.create(); await source.connect(); source.transition('playing'); await f.files('Old export\nArtist\nCharter'); hold = true;
  const selecting = source.selectFile(f.file); await entered.promise; const stopping = source.disconnect(); gate.resolve(); await Promise.all([selecting, stopping]);
  assert.equal(source.status().status, 'disconnected'); assert.equal(await source.getCurrentSong(), null); assert.equal((await source.getGameplayState()).state, 'idle'); assert.equal(f.mock.listeners.size, 0);
  await fs.writeFile(f.file, 'Late export\nArtist\nCharter'); await delay(70); assert.equal(source.status().status, 'disconnected'); assert.equal(await source.getCurrentSong(), null);
});

test('future/corrupt configuration is preserved and special source files are refused safely', async t => {
  const f = await fixture(t); await f.files('');
  for (const raw of ['{"version":8,"future":"keep"}', '{broken']) {
    await fs.writeFile(f.config, raw); const source = await f.create({ mock: createMock() }); assert.equal(source.status().status, 'error');
    await assert.rejects(source.selectFile(f.file), { code: 'CLONEHERO_SAFE' }); await source.disconnect(); assert.equal(await fs.readFile(f.config, 'utf8'), raw);
  }
  const fresh = await f.create({ dataDirectory: path.join(f.base, 'new-profile'), candidates: [] });
  await assert.rejects(fresh.selectFile(f.game), { code: 'CLONEHERO_SAFE' }); await assert.rejects(fresh.selectFile('relative.txt'), { code: 'CLONEHERO_SAFE' });
  const outside = path.join(f.base, 'outside.txt'); await fs.writeFile(outside, 'Secret\nOutside\nMetadata'); const link = path.join(f.game, 'link.txt');
  try { await fs.symlink(outside, link, 'file'); }
  catch (problem) { if (['EPERM', 'EACCES'].includes(problem.code)) { t.diagnostic('File symlink creation is unavailable on this Windows account; regular-file checks are exercised with a directory.'); return; } throw problem; }
  await assert.rejects(fresh.selectFile(link), { code: 'CLONEHERO_SAFE' });
});

test('native charter colors preserve adjacent letters, skip enrichment and isolate segment arrays between listeners', async t => {
  const f = await fixture(t); await f.files(''); let calls = 0;
  const source = await f.create({ resolveCharter: async () => { calls++; return undefined; } }); await source.connect();
  const received = [];
  source.subscribe(event => { if (event.type === 'song' && event.song?.charterSegments) event.song.charterSegments[0].text = 'listener mutation'; });
  source.subscribe(event => { if (event.type === 'song' && event.song?.charterSegments) received.push(event.song); });
  await fs.writeFile(f.file, 'Track\nArtist\n<color=red>J</color><color="blue">o');
  await until(() => source.status().status === 'active');
  const value = await source.getCurrentSong(); assert.equal(value.charter, 'Jo'); assert.deepEqual(value.charterSegments, [{ text: 'J', color: '#ff0000' }, { text: 'o', color: '#0000ff' }]);
  assert.equal(received[0].charterSegments[0].text, 'J'); value.charterSegments[0].color = '#ffffff'; assert.equal((await source.getCurrentSong()).charterSegments[0].color, '#ff0000');
  await delay(60); assert.equal(calls, 0); await fs.writeFile(f.file, ''); await until(async () => await source.getCurrentSong() === null);
});

test('charter enrichment is generic and cached per fresh export, with invalid or absent segments rejected', async t => {
  const f = await fixture(t); await f.files(''); const calls = [];
  const source = await f.create({ resolveCharter: async (song, filePath) => {
    calls.push({ song, filePath });
    if (song.title === 'First') return undefined;
    if (song.title === 'Second') return [{ text: 'Wrong charter', color: '#ff0000' }];
    return [{ text: song.charter, color: '#00aaff' }];
  } }); await source.connect();
  await fs.writeFile(f.file, 'First\nArtist\nShared Charter'); await until(() => calls.length === 1); await delay(90); assert.equal(calls.length, 1); assert.equal((await source.getCurrentSong()).charterSegments, undefined);
  await fs.writeFile(f.file, 'Second\nArtist\nShared Charter'); await until(() => calls.length === 2); await delay(65); assert.equal(calls.length, 2); assert.equal((await source.getCurrentSong()).charterSegments, undefined);
  await fs.writeFile(f.file, 'Third\nOther Artist\nDifferent Charter'); await until(async () => (await source.getCurrentSong())?.charterSegments?.length === 1);
  assert.deepEqual((await source.getCurrentSong()).charterSegments, [{ text: 'Different Charter', color: '#00aaff' }]); assert.equal(calls.length, 3); assert.equal(calls[2].filePath, f.file);
  assert.deepEqual(calls[2].song, { title: 'Third', artist: 'Other Artist', charter: 'Different Charter' });
});

test('pending charter enrichment never blocks clearing or colors another song after a change/disconnect', async t => {
  const f = await fixture(t); await f.files(''); const gates = new Map();
  const source = await f.create({ resolveCharter: song => { const gate = deferred(); gates.set(song.title, gate); return gate.promise; } }); await source.connect();
  await fs.writeFile(f.file, 'First\nArtist\nCharter'); await until(() => gates.has('First')); assert.equal((await source.getCurrentSong()).title, 'First');
  await fs.writeFile(f.file, 'Second\nArtist\nCharter'); await until(() => gates.has('Second'));
  gates.get('First').resolve([{ text: 'Charter', color: '#ff0000' }]); await delay(30); assert.equal((await source.getCurrentSong()).title, 'Second'); assert.equal((await source.getCurrentSong()).charterSegments, undefined);
  gates.get('Second').resolve([{ text: 'Charter', color: '#0000ff' }]); await until(async () => (await source.getCurrentSong())?.charterSegments?.[0]?.color === '#0000ff');
  await fs.writeFile(f.file, 'Third\nArtist\nCharter'); await until(() => gates.has('Third')); await fs.writeFile(f.file, ''); await until(async () => await source.getCurrentSong() === null);
  await source.disconnect(); gates.get('Third').resolve([{ text: 'Charter', color: '#00ff00' }]); await delay(40); assert.equal(await source.getCurrentSong(), null); assert.equal((await source.getGameplayState()).state, 'idle');
});

test('opening and reopening mid-song adopts a session-owned export after two observations without rewriting it', async t => {
  const f = await fixture(t); await f.files('Current song\nArtist\nCharter');
  const before = await fs.stat(f.file), bytes = await fs.readFile(f.file);
  const source = await f.create({ probeGame: async () => ({ running: true, sessions: [{ pid: 123, startedAtMs: before.mtimeMs - 10000 }] }) });
  await source.connect(); assert.equal(await source.getCurrentSong(), null); assert.match(source.status().message, /stabilité/);
  await until(() => source.status().status === 'active'); assert.equal((await source.getCurrentSong()).title, 'Current song');
  const events = []; source.subscribe(event => events.push(event)); await delay(90);
  assert.deepEqual(events, [], 'a long song or pause does not time out or emit repeated metadata');
  assert.equal(source.status().capabilities.exactGameplay, false); assert.match(source.status().message, /pause restent inconnus/);
  await source.disconnect(); await source.connect(); assert.equal(await source.getCurrentSong(), null); await until(() => source.status().status === 'active');
  assert.deepEqual(await fs.readFile(f.file), bytes); assert.equal((await fs.stat(f.file)).mtimeMs, before.mtimeMs);
  await fs.writeFile(f.file, 'Next song\nArtist\nCharter'); await until(async () => (await source.getCurrentSong())?.title === 'Next song');
  await fs.writeFile(f.file, ''); await until(async () => await source.getCurrentSong() === null);
});

test('mid-song startup retains delayed charter colors across polls and clears them when the export returns to the menu', async t => {
  const f = await fixture(t); await f.files('Sleepwalker\nPRESIDENT\nJoMartineau');
  const { mtimeMs } = await fs.stat(f.file), gate = deferred(); let calls = 0;
  const colors = [{ text: 'Jo', color: '#ff0000' }, { text: 'Martineau', color: '#00ff00' }];
  const source = await f.create({
    probeGame: async () => ({ running: true, sessions: [{ pid: 123, startedAtMs: mtimeMs - 10000 }] }),
    resolveCharter: async () => { calls++; return gate.promise; }
  });
  await source.connect(); assert.equal(await source.getCurrentSong(), null);
  await until(() => calls === 1); assert.equal((await source.getCurrentSong()).title, 'Sleepwalker');
  assert.equal((await source.getCurrentSong()).charterSegments, undefined, 'plain metadata remains available during the local lookup');
  await delay(90); assert.equal(calls, 1, 'polls reuse the pending lookup');
  gate.resolve(colors); await until(async () => (await source.getCurrentSong())?.charterSegments?.length === 2);
  await delay(90); assert.equal(calls, 1); assert.deepEqual((await source.getCurrentSong()).charterSegments, colors);
  await fs.writeFile(f.file, ''); await until(async () => await source.getCurrentSong() === null);
  await delay(45); assert.equal(await source.getCurrentSong(), null); assert.deepEqual(await source.getGameplayState(), { state: 'idle', isChartActive: false });
  assert.equal(calls, 1);
});

test('confirmed game closure clears retained exports and a new process cannot reuse the previous session song', async t => {
  const f = await fixture(t); await f.files('Previous session\nArtist\nCharter');
  const oldTime = new Date(Date.now() - 20000); await fs.utimes(f.file, oldTime, oldTime);
  let process = { running: false, sessions: [] };
  const source = await f.create({ probeGame: async () => process }); await source.connect(); await delay(55);
  assert.equal(await source.getCurrentSong(), null); assert.match(source.status().message, /Clone Hero est fermé/);
  process = { running: true, sessions: [{ pid: 1, startedAtMs: Date.now() - 10000 }] };
  await until(() => source.status().message.includes('nouvelle écriture')); await delay(45); assert.equal(await source.getCurrentSong(), null);
  await fs.writeFile(f.file, 'Current session\nArtist\nCharter'); await until(() => source.status().status === 'active');
  process = { running: false, sessions: [] }; await until(() => source.status().message.includes('Clone Hero est fermé'));
  assert.equal(await source.getCurrentSong(), null); assert.deepEqual(await source.getGameplayState(), { state: 'idle', isChartActive: false });
  await fs.writeFile(f.file, 'Written while closed\nArtist\nCharter'); await delay(60); assert.equal(await source.getCurrentSong(), null);
  const currentTime = new Date(Date.now() - 5000); await fs.utimes(f.file, currentTime, currentTime);
  process = { running: true, sessions: [{ pid: 2, startedAtMs: Date.now() - 1000 }] };
  await until(() => source.status().message.includes('nouvelle écriture')); assert.equal(await source.getCurrentSong(), null);
  await fs.writeFile(f.file, 'New launch\nArtist\nCharter'); await until(async () => (await source.getCurrentSong())?.title === 'New launch');
});

test('session changes invalidate an active retained title and adoption uses any current session with only 5ms tolerance', async t => {
  const f = await fixture(t); await f.files('Retained\nArtist\nCharter');
  const time = new Date(Date.now() - 10000); await fs.utimes(f.file, time, time); const { mtimeMs } = await fs.stat(f.file);
  let process = { running: true, sessions: [{ pid: 3, startedAtMs: mtimeMs + 1000 }, { pid: 4, startedAtMs: mtimeMs - 1000 }] };
  const source = await f.create({ probeGame: async () => process }); await source.connect(); await until(() => source.status().status === 'active');
  process = { running: true, sessions: [{ pid: 3, startedAtMs: mtimeMs + 1000 }] };
  await until(async () => await source.getCurrentSong() === null); await delay(45); assert.equal(source.status().status, 'waiting');
  await source.disconnect(); process = { running: true, sessions: [{ pid: 5, startedAtMs: mtimeMs + 6 }] };
  await source.connect(); await delay(55); assert.equal(await source.getCurrentSong(), null);
  await source.disconnect(); process = { running: true, sessions: [{ pid: 5, startedAtMs: mtimeMs + 4 }] };
  await source.connect(); assert.equal(await source.getCurrentSong(), null); await until(() => source.status().status === 'active');
});

test('unknown, failed or malformed process probes retain fresh-write fallback without treating uncertainty as closure', async t => {
  const f = await fixture(t); await f.files('Old\nArtist\nCharter'); let result = { running: null, sessions: [] }, fail = true;
  const source = await f.create({ probeGame: async () => { if (fail) throw Error('Unavailable process API'); return result; } });
  await source.connect(); await delay(45); assert.equal(await source.getCurrentSong(), null);
  fail = false; result = { running: true, sessions: [{ pid: 9, startedAtMs: null }] };
  await delay(45); assert.equal(await source.getCurrentSong(), null);
  result = { running: null, sessions: [] }; await fs.writeFile(f.file, 'Fresh\nArtist\nCharter'); await until(() => source.status().status === 'active');
  fail = true; await delay(75); assert.equal((await source.getCurrentSong()).title, 'Fresh');
  await assert.rejects(f.create({ probeGame: true }), { code: 'CLONEHERO_SAFE' });
});

test('a delayed process probe cannot publish after disconnect or replace the mock after switching modes', async t => {
  const f = await fixture(t); await f.files('Song\nArtist\nCharter'); const { mtimeMs } = await fs.stat(f.file);
  let entered = deferred(), gate = deferred(), hold = true;
  const source = await f.create({ probeGame: async () => { if (hold) { entered.resolve(); await gate.promise; } return { running: true, sessions: [{ pid: 1, startedAtMs: mtimeMs - 1000 }] }; } });
  const connecting = source.connect(); await entered.promise; const stopping = source.disconnect();
  assert.equal(source.status().status, 'disconnected'); gate.resolve(); await Promise.all([connecting, stopping]); await delay(35);
  assert.equal(await source.getCurrentSong(), null); assert.equal(source.status().status, 'disconnected');
  hold = false; await source.connect(); await until(() => source.status().status === 'active');
  entered = deferred(); gate = deferred(); hold = true; await entered.promise;
  await source.setMode('mock'); source.transition('playing'); gate.resolve(); await delay(45);
  assert.equal(source.status().mode, 'mock'); assert.equal((await source.getCurrentSong()).title, 'Everlong');
});

test('session confirmation does not bypass disabled or custom-format exports after an initial adoption', async t => {
  const f = await fixture(t); await f.files('Song\nArtist\nCharter'); const { mtimeMs } = await fs.stat(f.file);
  const source = await f.create({ probeGame: async () => ({ running: true, sessions: [{ pid: 1, startedAtMs: mtimeMs - 1000 }] }) });
  await source.connect(); await until(() => source.status().status === 'active');
  await fs.writeFile(f.settings, SETTINGS.replace('%s%n%a%n%c', '%a%n%s%n%c')); await until(() => source.status().status === 'unsupported');
  assert.equal(await source.getCurrentSong(), null); await fs.writeFile(f.settings, SETTINGS); await delay(65); assert.equal(await source.getCurrentSong(), null);
  await fs.writeFile(f.file, 'Fresh title\nArtist\nCharter'); await until(async () => (await source.getCurrentSong())?.title === 'Fresh title');
});
