'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { createGameModPreflight, REVIEWED_GAME_MOD_PINS } = require('../companion/game-mod-preflight.cjs');
const { createQuickImportService } = require('../companion/quick-import-service.cjs');
const BASE = path.resolve(__dirname, '../../../outputs/gm-preflight-tests');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function enteredBeforeCompletion(entered, pending) {
  await Promise.race([entered.promise, pending.then(() => assert.fail('Synthetic stage was not reached before the diagnostic completed'))]);
}
async function fixture(t, options = {}) {
  await fs.mkdir(BASE, { recursive: true });
  const directory = await fs.mkdtemp(path.join(BASE, 'case-')), root = path.join(directory, 'game'), pkg = path.join(directory, 'pkg'), runtime = path.join(directory, 'runtime');
  await Promise.all([fs.mkdir(root), fs.mkdir(pkg), fs.mkdir(path.join(runtime, '6.0.99'), { recursive: true })]);
  const exe = Buffer.alloc(256); exe.writeUInt16LE(0x5a4d); exe.writeUInt32LE(64, 60); exe.writeUInt32LE(0x4550, 64); exe.writeUInt16LE(0x8664, 68); exe.writeUInt16LE(0x20b, 88);
  const assembly = Buffer.from('synthetic assembly, never loaded'), metadata = Buffer.from('synthetic metadata'), module = Buffer.from('synthetic module, never loaded');
  const loader = Array.from({ length: 164 }, (_, i) => { const bytes = Buffer.from(`synthetic loader ${i}`); return { relative: i === 0 ? 'version.dll' : `MelonLoader/net6/fixture-${i}.dll`, bytes: bytes.length, sha256: sha(bytes) }; });
  const manifest = { schema: 1, loader: 'MelonLoader', version: '0.7.3', archiveSha256: '5b2b2f3d1cd42b59ec886c5bdc2663edae87a0097a4f4a8f58c0965a99dda416', files: loader };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const pins = { loaderManifestSha256: sha(manifestBytes), moduleSha256: sha(module), executableSha256: sha(exe), gameAssemblySha256: sha(assembly), metadataSha256: sha(metadata) };
  await fs.mkdir(path.join(root, 'Clone Hero_Data/il2cpp_data/Metadata'), { recursive: true });
  await fs.writeFile(path.join(root, 'Clone Hero.exe'), exe); await fs.writeFile(path.join(root, 'GameAssembly.dll'), assembly);
  await fs.writeFile(path.join(root, 'Clone Hero_Data/il2cpp_data/Metadata/global-metadata.dat'), metadata);
  await fs.writeFile(path.join(pkg, 'LOADER-FILES.json'), manifestBytes);
  await fs.writeFile(path.join(pkg, 'MODULE.json'), JSON.stringify({ schema: 1, kind: 'optional-game-widgets', build: 'CH-1.1.0.6142-win-x64-12bc21e5a88a2fc9', moduleSha256: pins.moduleSha256,
    version: '0.2.2', moduleFile: 'ChartsHub.CloneHero.Telemetry.dll', defaultEnabled: false, features: ['accuracy', 'song-clock-for-lyrics'], gameBinaryIncluded: false, loaderArchiveIncluded: false,
    loaderVersion: '0.7.3', gameAssemblySha256: pins.gameAssemblySha256, metadataSha256: pins.metadataSha256 }));
  let context = { active: true, lifecycle: 1 }, selected = root, probes = 0, changes = [];
  const io = { ...fs, statfs: async () => ({ bavail: 1024n * 1024n, bsize: 4096n }), ...options.fileSystem };
  const { fileSystem: ignoredFileSystem, ...overrides } = options;
  const service = createGameModPreflight({ platform: 'win32', moduleDirectory: pkg, runtimeDirectory: runtime, pins,
    getGameRoot: () => selected, getContext: () => context, processProbe: async () => { probes++; return false; }, onChange: value => { changes.push(value); options.onChange?.(value); }, fileSystem: io, ...overrides });
  t.after(async () => { service.dispose(); if (path.dirname(directory) !== BASE) throw Error('Fixture cleanup escaped'); await fs.rm(directory, { recursive: true, force: true }); });
  async function installLoader() { await fs.mkdir(path.join(root, 'MelonLoader/net6'), { recursive: true }); for (let i = 0; i < loader.length; i++) await fs.writeFile(path.join(root, loader[i].relative), `synthetic loader ${i}`); }
  return { directory, root, pkg, runtime, pins, loader, manifest, exe, module, io, service, changes, installLoader,
    setContext: value => { context = value; }, select: value => { selected = value; }, get probes() { return probes; }, refresh: () => service.refresh({ revision: service.status().revision }) };
}
const check = (value, code) => value.checks.find(item => item.code === code);

test('construction and status never probe files, processes or runtime', () => {
  let calls = 0; const forbidden = () => { calls++; throw Error('No probing'); };
  const service = createGameModPreflight({ getGameRoot: () => null, getContext: () => ({ active: true, lifecycle: 1 }), fileSystem: new Proxy({}, { get: () => forbidden }), processProbe: forbidden });
  assert.equal(calls, 0); assert.equal(service.status().checked, false); assert.equal(service.status().selected, false); assert.equal(calls, 0); service.dispose();
});
test('reviewed pins match the shipped fixed manifest and module description', async () => {
  const root = path.join(__dirname, '../game-widgets-mod');
  assert.equal(sha(await fs.readFile(path.join(root, 'LOADER-FILES.json'))), REVIEWED_GAME_MOD_PINS.loaderManifestSha256);
  const module = JSON.parse(await fs.readFile(path.join(root, 'MODULE.json'), 'utf8'));
  assert.equal(module.moduleSha256, REVIEWED_GAME_MOD_PINS.moduleSha256);
});
test('complete matching loader and exact x64 build return a bounded read-only install hint without paths', async t => {
  const f = await fixture(t); await f.installLoader(); const s = await f.refresh();
  assert.equal(s.compatible, true); assert.equal(s.loader.state, 'matching'); assert.equal(s.loader.checked, 164); assert.equal(s.module.state, 'missing'); assert.equal(s.canInstall, true); assert.equal(s.process, 'closed');
  assert.equal(s.revision, f.service.status().revision); assert.equal(f.probes, 1); assert.equal(s.busy, false); assert(check(s, 'WRITE_ACCESS_NOT_PROVEN')); assert(check(s, 'DOTNET6_DESKTOP_PRESENT'));
  assert(!JSON.stringify(s).includes(f.directory)); assert(JSON.stringify(s).length < 4096); assert(s.checks.length <= 12);
});
test('absent and partial loader files are distinguished without assuming antivirus caused them', async t => {
  const f = await fixture(t); let s = await f.refresh(); assert.equal(s.loader.state, 'missing'); assert.equal(s.loader.missing, 164); assert.equal(s.canInstall, false);
  await fs.writeFile(path.join(f.root, 'version.dll'), 'synthetic loader 0'); s = await f.refresh(); assert.equal(s.loader.state, 'partial'); assert.equal(s.loader.checked, 1); assert.equal(s.loader.missing, 163); assert(check(s, 'SHARED_LOADER_MISSING'));
  assert(!JSON.stringify(s).includes('quarantined')); assert(!JSON.stringify(s).includes('antivirus'));
});
test('foreign loader and existing foreign module are reported and never replaced', async t => {
  const f = await fixture(t); await f.installLoader(); const foreign = Buffer.from('foreign contents'); await fs.writeFile(path.join(f.root, 'version.dll'), foreign);
  await fs.mkdir(path.join(f.root, 'Mods')); await fs.writeFile(path.join(f.root, 'Mods/ChartsHub.CloneHero.Telemetry.dll'), foreign);
  const s = await f.refresh(); assert.equal(s.loader.state, 'different'); assert.equal(s.module.state, 'different'); assert(check(s, 'SHARED_LOADER_DIFFERENT')); assert(check(s, 'MODULE_ALREADY_EXISTS')); assert.equal(s.canInstall, false);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'version.dll')), foreign); assert.deepEqual(await fs.readFile(path.join(f.root, 'Mods/ChartsHub.CloneHero.Telemetry.dll')), foreign);
});
test('matching module is identified as already present rather than offered for overwrite', async t => {
  const f = await fixture(t); await f.installLoader(); await fs.mkdir(path.join(f.root, 'Mods')); await fs.writeFile(path.join(f.root, 'Mods/ChartsHub.CloneHero.Telemetry.dll'), f.module);
  const s = await f.refresh(); assert.equal(s.module.state, 'matching'); assert(check(s, 'MODULE_VERIFIED')); assert(check(s, 'INSTALLATION_RECEIPT_MISSING')); assert.equal(s.canInstall, false);
});
test('a previous receipt blocks a missing-module repair without reading private receipt contents', async t => {
  const f = await fixture(t); await f.installLoader(); const receipt = path.join(f.root, 'UserData/ChartsHubGameWidgets/install-receipt.json');
  await fs.mkdir(path.dirname(receipt), { recursive: true }); await fs.writeFile(receipt, 'private-path-and-token-not-json');
  const open = f.io.open; f.io.open = async (value, ...args) => { assert.notEqual(value, receipt, 'Receipt contents are outside this diagnostic'); return open(value, ...args); };
  const s = await f.refresh(); assert(check(s, 'RECEIPT_ALREADY_EXISTS')); assert.equal(s.canInstall, false); assert.equal(s.module.state, 'missing'); assert(!JSON.stringify(s).includes('private-path'));
});
test('game or launcher presence and unknown process probe both block installation advice', async t => {
  for (const result of [true, null]) { const f = await fixture(t, { processProbe: async () => result }); await f.installLoader(); const s = await f.refresh(); assert.equal(s.canInstall, false); assert(check(s, result === true ? 'GAME_RUNNING' : 'PROCESS_CHECK_FAILED')); }
});
test('exact binary mismatch is unsupported and stops before loader/runtime/process probes', async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.root, 'GameAssembly.dll'), 'changed'); const s = await f.refresh(); assert.equal(s.compatible, false); assert(check(s, 'UNSUPPORTED_GAME_BUILD')); assert.equal(f.probes, 0);
});
test('a non-x64 executable is rejected by PE headers even if its digest is trusted by the fixture', async t => {
  const f = await fixture(t); f.exe.writeUInt16LE(0x14c, 68); await fs.writeFile(path.join(f.root, 'Clone Hero.exe'), f.exe); const s = await f.refresh(); assert.equal(s.error, 'GAME_NOT_X64'); assert.equal(f.probes, 0);
});
test('tampered manifest is rejected before its file names can target another directory', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.pkg, 'LOADER-FILES.json'), JSON.stringify({ ...f.manifest, files: [{ relative: '../private-token' }] })); const s = await f.refresh(); assert.equal(s.error, 'PACKAGE_INVALID'); assert.equal(s.canInstall, false);
});
test('permission errors are bounded and do not disclose the selected path or raw OS text', async t => {
  const f = await fixture(t, { fileSystem: { lstat: async () => { throw Object.assign(Error('C:/private/users/token'), { code: 'EACCES' }); } } }); const s = await f.refresh(); assert.equal(s.error, 'READ_PERMISSION_DENIED'); assert(!JSON.stringify(s).includes('private')); assert.equal(f.probes, 0);
});
test('hard-linked game files are refused before hash/transport use', async t => {
  const f = await fixture(t); await fs.link(path.join(f.root, 'GameAssembly.dll'), path.join(f.directory, 'linked.bin')); const s = await f.refresh(); assert.equal(s.error, 'HARDLINK_FILE'); assert.equal(f.probes, 0);
});
test('reparse and realpath changes are refused without following a second game tree', async t => {
  const f = await fixture(t); const original = f.io.realpath; f.io.realpath = async value => value === f.root ? path.join(f.directory, 'different') : original(value); const s = await f.refresh(); assert.equal(s.error, 'LINKED_PATH'); assert.equal(f.probes, 0);
});
test('symbolic-link attribute is refused before opening that file', async t => {
  const f = await fixture(t); const original = f.io.lstat; f.io.lstat = async value => { const stat = await original(value); if (value === path.join(f.root, 'GameAssembly.dll')) stat.isSymbolicLink = () => true; return stat; }; const s = await f.refresh(); assert.equal(s.error, 'LINKED_PATH');
});
test('files changed while being read are rejected', async t => {
  const f = await fixture(t); const original = f.io.open; f.io.open = async (value, flags) => { const handle = await original(value, flags); if (value !== path.join(f.root, 'GameAssembly.dll')) return handle; let reads = 0; return { stat: () => handle.stat(), close: () => handle.close(), read: async (...args) => { const result = await handle.read(...args); if (++reads === 1) await fs.appendFile(value, 'mutation'); return result; } }; }; const s = await f.refresh(); assert.equal(s.error, 'FILE_CHANGED');
});
test('missing runtime, low disk and read-only permission hints remain honest warnings', async t => {
  const f = await fixture(t, { fileSystem: { statfs: async () => ({ bavail: 0n, bsize: 4096n }), access: async () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); } } }); await f.installLoader(); await fs.rm(f.runtime, { recursive: true }); const s = await f.refresh(); assert(check(s, 'DOTNET6_DESKTOP_NOT_FOUND')); assert(check(s, 'LOW_DISK_SPACE')); assert(check(s, 'WRITE_PERMISSION_MAY_BE_DENIED')); assert.equal(s.state, 'warning');
});
test('unavailable runtime and disk APIs are unknown rather than reported as successful', async t => {
  const f = await fixture(t, { fileSystem: { readdir: async () => { throw Error('unavailable'); }, statfs: async () => { throw Error('unavailable'); } } }); await f.installLoader(); const s = await f.refresh(); assert(check(s, 'DOTNET6_DESKTOP_UNKNOWN')); assert(check(s, 'DISK_SPACE_UNKNOWN'));
});
test('strict revision and payload checks reject stale commands before any probing', async t => {
  const f = await fixture(t); for (const value of [{}, { revision: 0, path: 'private' }, { revision: -1 }]) await assert.rejects(f.service.refresh(value), { code: 'GAME_MOD_CHECK_INVALID' }); await f.refresh(); await assert.rejects(f.service.refresh({ revision: 0 }), { code: 'GAME_MOD_CHECK_STALE' }); assert.equal(f.probes, 1);
});
test('inactive and unsupported sessions never probe selected game or machine', async t => {
  const f = await fixture(t); f.setContext({ active: false, lifecycle: 1 }); await assert.rejects(f.refresh(), { code: 'GAME_MOD_CHECK_INACTIVE' }); assert.equal(f.probes, 0);
  const g = await fixture(t, { platform: 'linux' }); await assert.rejects(g.refresh(), { code: 'GAME_MOD_CHECK_UNAVAILABLE' }); assert.equal(g.probes, 0);
});
test('lifecycle/root changes fence pending results and reset old reports without automatic retries', async t => {
  for (const mode of ['lifecycle', 'root', 'stop', 'dispose']) {
    const gate = deferred(), entered = deferred(), f = await fixture(t, { processProbe: () => { entered.resolve(); return gate.promise; } }); const pending = f.refresh(); await enteredBeforeCompletion(entered, pending);
    if (mode === 'lifecycle') f.setContext({ active: true, lifecycle: 2 }); else if (mode === 'root') f.select(path.join(f.directory, 'another')); else f.service[mode]();
    assert.equal(f.service.status().checked, false); gate.resolve(false); await assert.rejects(pending, { code: 'GAME_MOD_CHECK_CANCELLED' }); assert.equal(f.service.status().checked, false); assert.equal(f.service.status().busy, false);
  }
});
test('bounded timeout revokes late I/O and never republishes the completed old report', async t => {
  // Hold the FIRST asynchronous filesystem operation, before disk scheduling
  // can consume the entire 50 ms budget. Waiting for processProbe used to hang
  // forever when concurrent suites made earlier game-file reads exceed 50 ms:
  // refresh had already timed out, so that later probe was never entered.
  const gate = deferred(), entered = deferred(); let reads = 0;
  const f = await fixture(t, { timeoutMs: 50, fileSystem: { lstat: async () => {
    reads++; entered.resolve(); await gate.promise;
    return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
  } } });
  const pending = f.refresh(); await enteredBeforeCompletion(entered, pending);
  const s = await pending; assert.equal(s.error, 'CHECK_TIMED_OUT'); assert.equal(f.probes, 0);
  gate.resolve(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reads, 1, 'Revoked I/O cannot advance to another ancestor or file');
  assert.equal(f.service.status().error, 'CHECK_TIMED_OUT'); assert.equal(f.service.status().busy, false);
});
test('observer revocation during refresh prevents the first filesystem read', async t => {
  let f, reads = 0; f = await fixture(t, { onChange: value => { if (value.busy) f.service.stop(); }, fileSystem: { lstat: async () => { reads++; throw Error('must not read'); } } }); await assert.rejects(f.refresh(), { code: 'GAME_MOD_CHECK_CANCELLED' }); assert.equal(reads, 0);
});
test('overlong or network roots are blocked without process probes or raw path disclosure', async t => {
  const f = await fixture(t); for (const value of ['\\\\server\\private', path.join(f.directory, 'a'.repeat(241))]) { f.select(value); const s = await f.refresh(); assert.equal(s.error, 'GAME_FOLDER_INVALID'); assert.equal(f.probes, 0); assert(!JSON.stringify(s).includes(value)); }
});
test('Quick Import exposes the saved selection only through a main-only getter, never its DTO', async () => {
  const selected = path.resolve(BASE, 'saved-game'); let reads = 0;
  const service = createQuickImportService({ getContext: () => ({ active: true, lifecycle: 1, root: null }), chooseGame: async () => null,
    preferences: { async load() { reads++; return { gameRoot: selected, canWrite: true }; }, status: () => ({ canWrite: true }), flush: async () => {} } });
  assert.equal(service.selectedGameRoot(), null); assert.equal(reads, 0); await service.load(); assert.equal(service.selectedGameRoot(), selected); assert(!JSON.stringify(service.status()).includes(selected)); await service.dispose(); assert.equal(service.selectedGameRoot(), null);
});
