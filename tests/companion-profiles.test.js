const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Module, createRequire } = require('node:module');
const { createOverlayProfiles } = require('../companion/overlay-profiles.cjs');

async function fixture(t, factory = createOverlayProfiles) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chartshub-profiles-'));
  t.after(async () => { if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('chartshub-profiles-')) throw Error('Unexpected fixture directory'); await fs.rm(directory, { recursive: true, force: true }); });
  const [{ validateSettings }, { createDefaultWidgets }, { createDefaultTheme }, { createDefaultStream }] = await Promise.all([
    import('../companion/dist/storage/SettingsRepository.js'), import('../companion/dist/widgets/core/index.js'), import('../companion/dist/themes/ThemeService.js'), import('../companion/dist/overlay/stream/StreamConfig.js')
  ]);
  const widgets = createDefaultWidgets(), document = validateSettings({ version: 3, widgets, theme: createDefaultTheme(), stream: createDefaultStream(widgets) });
  const options = { dataDirectory: directory, validateSettings };
  return { directory, file: path.join(directory, 'overlay-profiles.json'), document, validateSettings, options, service: factory(options) };
}
async function injected(overrides) {
  const filename = require.resolve('../companion/overlay-profiles.cjs'), local = new Module(filename, module), normal = createRequire(filename);
  local.filename = filename; local.paths = Module._nodeModulePaths(path.dirname(filename));
  local.require = name => Object.hasOwn(overrides, name) ? overrides[name] : normal(name);
  local._compile(await fs.readFile(filename, 'utf8'), filename); return local.exports.createOverlayProfiles;
}
const editable = document => ({ widgets: document.widgets, theme: document.theme, stream: { canvas: document.stream.canvas, layout: document.stream.layout } });

test('empty profile service loads idempotently without writing and saves, renames, overwrites, reloads and removes profiles', async t => {
  const f = await fixture(t); await Promise.all([f.service.load(), f.service.load()]);
  assert.deepEqual(f.service.status(f.document), { revision: 0, items: [], activeId: null, error: null, canWrite: true }); assert.deepEqual(await fs.readdir(f.directory), []);
  const first = await f.service.save({ revision: 0, name: '  Jeu  ', document: f.document });
  assert.match(first.id, /^[a-f0-9-]{36}$/); assert.equal(first.activeId, first.id); assert.equal(first.items[0].name, 'Jeu');
  const changed = structuredClone(f.document); changed.widgets[0].enabled = false; changed.widgets[2].locked = true; changed.stream.canvas = { width: 1920, height: 1080, fps: 30 };
  const saved = await f.service.save({ revision: first.revision, id: first.id, name: 'Stream', document: changed });
  assert.equal(saved.id, first.id); assert.equal(saved.items.length, 1); assert.equal(saved.items[0].name, 'Stream'); assert.equal(saved.revision, 2);
  const reloaded = createOverlayProfiles(f.options); await reloaded.load();
  assert.deepEqual(await reloaded.get({ revision: 2, id: first.id }), editable(f.validateSettings(changed)));
  assert.equal(reloaded.status(changed).activeId, first.id); assert.equal(reloaded.status(f.document).activeId, null);
  const backup = JSON.parse(await fs.readFile(f.file + '.bak', 'utf8')); assert.equal(backup.revision, 1); assert.equal(backup.items[0].name, 'Jeu');
  await reloaded.remove({ revision: 2, id: first.id }); assert.deepEqual(reloaded.status(changed).items, []); assert.equal(reloaded.status().revision, 3);
  await assert.rejects(reloaded.get({ revision: 3, id: first.id }), { code: 'PROFILE_SAFE' });
});

test('profiles project only overlay settings and exclude OBS ports, URLs, activation, game data and paths', async t => {
  const f = await fixture(t); f.document.stream.port = 55555; f.document.stream.url = 'http://secret-url'; f.document.stream.key = 'secret-key'; f.document.stream.enabled = true;
  f.document.nowPlaying = { title: 'secret-current-song' }; f.document.gameplay = { state: 'playing' }; f.document.rootPath = 'C:\\private-library';
  const saved = await f.service.save({ revision: 0, name: 'Clean', document: f.document });
  const projected = await f.service.get({ revision: saved.revision, id: saved.id });
  assert.deepEqual(Object.keys(projected).sort(), ['stream', 'theme', 'widgets']); assert.deepEqual(Object.keys(projected.stream).sort(), ['canvas', 'layout']);
  const disk = await fs.readFile(f.file, 'utf8'); assert.doesNotMatch(disk, /55555|secret-url|secret-key|secret-current-song|private-library|rootPath|"gameplay"|nowPlaying|"port"/);
  const current = structuredClone(f.document); current.stream.port = 60000;
  assert.equal(f.service.status(current).activeId, saved.id, 'the current OBS port does not affect profile identity');
});

test('snapshots are isolated from callers before queued saves and after status/get returns', async t => {
  const f = await fixture(t), input = { revision: 0, name: 'Snapshot', document: structuredClone(f.document) };
  const pending = f.service.save(input); input.name = 'Mutated'; input.document.widgets[0].position.x = 900;
  const saved = await pending; assert.equal(saved.items[0].name, 'Snapshot');
  const first = await f.service.get({ revision: saved.revision, id: saved.id }); first.widgets[0].position.x = 800; first.theme.colors.text = '#ff0000';
  saved.items[0].name = 'External';
  const second = await f.service.get({ revision: saved.revision, id: saved.id });
  assert.equal(second.widgets[0].position.x, f.document.widgets[0].position.x); assert.equal(second.theme.colors.text, f.document.theme.colors.text);
  assert.equal(f.service.status().items[0].name, 'Snapshot');
});

test('active profile uses validated canonical values and honors a preferred identical profile only while it matches', async t => {
  const f = await fixture(t); f.document.widgets[0].config = { second: 2, first: 1 }; f.document.widgets[0].style.color = '#f00';
  const first = await f.service.save({ revision: 0, name: 'Game', document: f.document });
  const second = await f.service.save({ revision: first.revision, name: 'OBS', document: f.document });
  const reordered = structuredClone(f.document); reordered.widgets[0].config = { first: 1, second: 2 }; reordered.widgets[0].style.color = 'rgb(255 0 0)'; reordered.stream.layout.reverse();
  assert.equal(f.service.status(reordered).activeId, second.id);
  assert.equal(f.service.status(reordered, first.id).activeId, first.id);
  reordered.widgets[0].locked = true; assert.equal(f.service.status(reordered, first.id).activeId, null);
  reordered.widgets[0].locked = false; assert.equal(f.service.status(reordered, first.id).activeId, first.id, 'unlocking returns to the original semantic settings');
  assert.equal((await f.service.get({ revision: second.revision, id: first.id })).widgets[0].locked, undefined, 'matching does not modify saved optional fields');
  assert.equal(f.service.status({ malformed: true }).activeId, null);
});

test('revision validation runs inside the serialized queue for concurrent saves, reads and deletes', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.service.save({ revision: 0, name: 'First', document: f.document }),
    f.service.save({ revision: 0, name: 'Second', document: f.document })
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'STALE_PROFILES');
  const id = results[0].value.id;
  await assert.rejects(f.service.get({ revision: 0, id }), { code: 'STALE_PROFILES' });
  const update = f.service.save({ revision: 1, id, name: 'Renamed', document: f.document });
  const removing = f.service.remove({ revision: 1, id });
  await update; await assert.rejects(removing, { code: 'STALE_PROFILES' });
  assert.equal(f.service.status().items[0].name, 'Renamed'); assert.equal(f.service.status().revision, 2);
});

test('profile names are NFC-trimmed, unique without case, bounded and free of control characters', async t => {
  const f = await fixture(t); const saved = await f.service.save({ revision: 0, name: ' E\u0301te\u0301 ', document: f.document });
  assert.equal(saved.items[0].name, 'Été');
  for (const name of ['été', '', '   ', 'x'.repeat(41), 'Bad\nname', 'Bad\u0085name']) {
    await assert.rejects(f.service.save({ revision: 1, name, document: f.document }), { code: 'PROFILE_SAFE' });
  }
  assert.equal(f.service.status().revision, 1);
  await f.service.save({ revision: 1, id: saved.id, name: 'ÉTÉ', document: f.document }); assert.equal(f.service.status().items[0].name, 'ÉTÉ');
});

test('the twenty-profile limit permits overwriting an existing profile and adding after removal', async t => {
  const f = await fixture(t); let last;
  for (let index = 0; index < 20; index++) last = await f.service.save({ revision: index, name: `Profile ${index}`, document: f.document });
  await assert.rejects(f.service.save({ revision: 20, name: 'Overflow', document: f.document }), { code: 'PROFILE_SAFE' });
  await f.service.save({ revision: 20, id: last.id, name: 'Replacement', document: f.document });
  await f.service.remove({ revision: 21, id: last.id });
  await f.service.save({ revision: 22, name: 'Available slot', document: f.document }); assert.equal(f.service.status().items.length, 20);
});

test('corrupt and future profile files stay protected byte-for-byte without backups or overwrites', async t => {
  const f = await fixture(t);
  for (const original of ['{broken', '{"version":5,"future":"preserve"}']) {
    await fs.writeFile(f.file, original); const service = createOverlayProfiles(f.options); await service.load();
    assert.equal(service.status().canWrite, false); assert.ok(service.status().error); assert.deepEqual(service.status().items, []);
    await assert.rejects(service.save({ revision: 0, name: 'New', document: f.document }), { code: 'PROFILE_SAFE' });
    await assert.rejects(service.remove({ revision: 0, id: 'invalid' }), { code: 'PROFILE_SAFE' });
    assert.equal(await fs.readFile(f.file, 'utf8'), original); assert.deepEqual(await fs.readdir(f.directory), ['overlay-profiles.json']);
  }
});

test('invalid saved schema including forbidden stream port is rejected atomically rather than partially loaded', async t => {
  const f = await fixture(t); await f.service.save({ revision: 0, name: 'Valid', document: f.document });
  const original = JSON.parse(await fs.readFile(f.file, 'utf8')); original.items[0].document.stream.port = 40000;
  await fs.writeFile(f.file, JSON.stringify(original)); const service = createOverlayProfiles(f.options); await service.load();
  assert.equal(service.status().canWrite, false); assert.deepEqual(service.status().items, []);
  await assert.rejects(service.get({ revision: 0, id: original.items[0].id }), { code: 'PROFILE_SAFE' });
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).items[0].document.stream.port, 40000);
});

test('failed atomic replacement keeps committed memory and disk intact and can be retried', async t => {
  let fail = false;
  const factory = await injected({ 'node:fs/promises': { ...fs, rename: async (...args) => {
    if (fail && path.basename(args[1]) === 'overlay-profiles.json') throw Object.assign(Error('secret disk details'), { code: 'EACCES' }); return fs.rename(...args);
  } } });
  const f = await fixture(t, factory); const saved = await f.service.save({ revision: 0, name: 'Before', document: f.document }), original = await fs.readFile(f.file, 'utf8');
  fail = true;
  await assert.rejects(f.service.save({ revision: 1, id: saved.id, name: 'After', document: f.document }), error => error.code === 'PROFILE_SAFE' && !error.message.includes('secret'));
  assert.equal(f.service.status().revision, 1); assert.equal(f.service.status().items[0].name, 'Before'); assert.equal(f.service.status(f.document).activeId, saved.id);
  assert.equal(await fs.readFile(f.file, 'utf8'), original); assert.deepEqual((await fs.readdir(f.directory)).sort(), ['overlay-profiles.json', 'overlay-profiles.json.bak']);
  fail = false; await f.service.save({ revision: 1, id: saved.id, name: 'After', document: f.document }); assert.equal(f.service.status().error, null);
});

test('external file replacement after load is protected rather than overwritten with stale memory', async t => {
  const f = await fixture(t); await f.service.load(); const future = '{"version":9,"future":"preserve"}'; await fs.writeFile(f.file, future);
  await assert.rejects(f.service.save({ revision: 0, name: 'New', document: f.document }), { code: 'PROFILE_SAFE' });
  assert.equal(f.service.status().canWrite, false); assert.equal(await fs.readFile(f.file, 'utf8'), future);
});

test('a successful rename commits truthfully even if subsequent file metadata becomes unavailable', async t => {
  let committed = false;
  const factory = await injected({ 'node:fs/promises': { ...fs,
    rename: async (...args) => { const result = await fs.rename(...args); if (path.basename(args[1]) === 'overlay-profiles.json') committed = true; return result; },
    lstat: async (...args) => { if (committed && path.basename(args[0]) === 'overlay-profiles.json') throw Object.assign(Error('Temporary metadata failure'), { code: 'EACCES' }); return fs.lstat(...args); }
  } });
  const f = await fixture(t, factory), saved = await f.service.save({ revision: 0, name: 'Committed', document: f.document });
  assert.equal(saved.revision, 1); assert.equal(saved.error, null); assert.equal(saved.activeId, saved.id);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).items[0].id, saved.id);
  assert.equal((await f.service.get({ revision: 1, id: saved.id })).widgets.length, 5);
});

test('malformed, non-JSON, oversized and invalid-layout documents cannot change saved profiles', async t => {
  const f = await fixture(t);
  const invalid = [];
  const locked = structuredClone(f.document); locked.widgets[0].locked = 'yes'; invalid.push(locked);
  const layout = structuredClone(f.document); layout.stream.layout.pop(); invalid.push(layout);
  const cycle = structuredClone(f.document); cycle.widgets[0].config.loop = cycle.widgets[0].config; invalid.push(cycle);
  const huge = structuredClone(f.document); huge.widgets[0].config.content = 'x'.repeat(5 * 1024 * 1024); invalid.push(huge);
  invalid.push({ version: 2 }, null);
  for (const document of invalid) await assert.rejects(f.service.save({ revision: 0, name: 'Invalid', document }), { code: 'PROFILE_SAFE' });
  assert.equal(f.service.status().revision, 0); assert.deepEqual(await fs.readdir(f.directory), []);
});
